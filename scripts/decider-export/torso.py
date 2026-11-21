"""The strands-decider E2B v2 torso as one exportable module.

One pass over [state | q1 | q2 | ...]:
  - state tokens attend to the state only (both ways),
  - question k's tokens attend to the state and to question k (both ways), never another question.
That is the decider's prefix_bidir, with several questions packed into one sequence instead of
batched over a cached state. Every question's positions start at len(state), as in the
decider's own question pass.

Layers >= first_kv_shared_layer_idx (15 of 35 on E2B) reuse the K/V of earlier layers and write
none, so after layer 14 only the rows the readout reads (each question's last token) are carried.

Embedding lookups (main + per-layer) stay OUTSIDE the graph: the browser does them from a table.
"""

from __future__ import annotations

import os

import torch
import transformers
from safetensors.torch import load_file
from transformers import AttentionInterface
from transformers.models.gemma4.modeling_gemma4 import KVSharingDict

ATTN = "lychee_bias_attention"


def _attention(module, query, key, value, attention_mask, scaling=None, dropout=0.0, **_):
    """Plain attention with an additive bias; never causal. K/V have 1 head (MQA): broadcast."""
    if key.shape[1] != query.shape[1] and key.shape[1] != 1:
        g = query.shape[1] // key.shape[1]
        key = key.repeat_interleave(g, dim=1)
        value = value.repeat_interleave(g, dim=1)
    scores = torch.matmul(query, key.transpose(-1, -2))
    if scaling is not None and scaling != 1.0:
        scores = scores * scaling
    if attention_mask is not None:
        scores = scores + attention_mask
    probs = torch.softmax(scores, dim=-1)
    out = torch.matmul(probs, value)
    return out.transpose(1, 2).contiguous(), None


AttentionInterface.register(ATTN, _attention)


def load(ckpt: str, dtype=torch.float32):
    """(text decoder, readout [255, 1536]) from a checkpoint snapshot directory."""
    config = transformers.AutoConfig.from_pretrained(ckpt)
    config.audio_config = None
    config.vision_config = None
    model = transformers.Gemma4ForConditionalGeneration.from_pretrained(
        ckpt, config=config, dtype=dtype, attn_implementation="sdpa"
    )
    model.set_attn_implementation({"text_config": ATTN})
    text = model.model.language_model
    readout = load_file(os.path.join(ckpt, "readout.safetensors"))["weight"].to(dtype)
    return text.eval(), readout


def embed(text, ids: torch.Tensor):
    """(inputs_embeds [1,T,H], per_layer_raw [1,T,L,P]) for ids [1,T] — the browser-side lookup."""
    e = text.embed_tokens(ids)
    p = text.get_per_layer_inputs(ids, e)
    return e, p


class Torso(torch.nn.Module):
    def __init__(self, text, readout):
        super().__init__()
        self.text = text
        self.register_buffer("readout", readout.contiguous())
        self.first_shared = text.first_kv_shared_layer_idx
        self.layer_types = list(text.config.layer_types)

    def forward(self, inputs_embeds, per_layer_raw, position_ids, segment_ids, gather_idx):
        t = self.text
        dtype = inputs_embeds.dtype
        ple = t.project_per_layer_inputs(inputs_embeds, per_layer_raw)
        # prefix_bidir over packed questions: key j visible to query i iff j is state or same question.
        seg_q = segment_ids.view(-1, 1)
        seg_k = segment_ids.view(1, -1)
        allowed = (seg_k == 0) | (seg_k == seg_q)
        bias = torch.where(
            allowed,
            torch.zeros((), dtype=dtype),
            torch.full((), torch.finfo(dtype).min, dtype=dtype),
        )[None, None]
        h = inputs_embeds
        pos_emb = {lt: t.rotary_emb(h, position_ids, lt) for lt in sorted(set(self.layer_types))}
        shared = KVSharingDict()
        for i, layer in enumerate(t.layers):
            if i == self.first_shared:
                h = h[:, gather_idx]
                ple = ple[:, gather_idx]
                pos_emb = {k: (c[:, gather_idx], s[:, gather_idx]) for k, (c, s) in pos_emb.items()}
                bias = bias[:, :, gather_idx]
            h = layer(
                h,
                ple[:, :, i, :],
                shared_kv_states=shared,
                position_embeddings=pos_emb[self.layer_types[i]],
                attention_mask=bias,
                position_ids=position_ids,
                cache=None,
            )
        h = t.norm(h)[0]  # [Q, H] — final-norm hidden at each question's last token
        return h @ self.readout.t()  # logits [Q, 255]


def pack(state_ids: list[int], questions: list[list[int]]):
    """ids, position_ids, segment_ids, gather_idx for one packed pass."""
    s = len(state_ids)
    ids, pos, seg, gidx = list(state_ids), list(range(s)), [0] * s, []
    for k, q in enumerate(questions, start=1):
        ids += q
        pos += list(range(s, s + len(q)))
        seg += [k] * len(q)
        gidx.append(len(ids) - 1)
    T = torch.tensor
    return (
        T([ids], dtype=torch.long),
        T([pos], dtype=torch.long),
        T(seg, dtype=torch.long),
        T(gidx, dtype=torch.long),
    )
