# scripts/export-von/fast.py
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "von-sdk @ git+https://github.com/wfzyx/von@ca5d608fa79820d4e5388c9cb4c6a9b47a44a98c",
#   "torch>=2.4", "transformers>=5.0", "onnx>=1.17", "onnxruntime>=1.20",
#   "onnx-ir", "huggingface_hub>=0.30", "numpy",
# ]
# ///
"""The fast graph: ModernBERT re-expressed so the math ORT ran on the CPU —
RoPE angles and the two option masks — arrives as inputs, and attention is one
fused node per layer (com.microsoft MultiHeadAttention, which the native
WebGPU EP runs as FlashAttention). Measured 2026-09-30: 540 of the 1,909 nodes
of the plain export fell to ORT's CPU fallback with a sync inside every layer,
and a pass ran at ~1.1 TFLOP/s on a GPU with ten times that (eval README; the
research reports under docs/superpowers/research/).

The forward is exactly ModernBERT's (transformers 5.17 modeling_modernbert.py):
embeddings → LayerNorm; per layer: attn_norm (identity on layer 0) → Wqkv →
RoPE in fp32 (rotate-half; cos/sin = cat(freqs, freqs)) → attention scaled by
1/√64 with an additive mask → Wo, residual; mlp_norm → Wi → gelu(input)·gate
→ Wo, residual; final_norm; marker gather; the option-marker scorer. No biases
anywhere (attention_bias, mlp_bias and norm_bias are all false in Von's config).

Run as a script it is its own test: on the exporter's probe suite the fast
forward must match Von's own forward (< 1e-3 in logits) and padding to a
bucket must change nothing (< 1e-4).

    uv run scripts/export-von/fast.py --checkpoint <dir>
"""
import os
import sys

import numpy as np
import torch
import torch.nn as nn

NEG = -30000.0
HEAD_DIM = 64
BUCKETS = [256, 512, 768, 1024, 1536, 2048, 3072, 4096]
FAST_INPUT_NAMES = ["input_ids", "cos_full", "sin_full", "cos_sliding", "sin_sliding", "bias_full", "bias_sliding", "marker_positions"]


def bucket_for(T):
    for b in BUCKETS:
        if T <= b:
            return b
    raise ValueError(f"packed input is {T} tokens (max {BUCKETS[-1]})")


def rope_table(position_ids, theta, head_dim=HEAD_DIM):
    """cos/sin per TOKEN ROW from its (reset) position id: ModernBertRotaryEmbedding in fp32, cat(freqs, freqs)."""
    pos = np.asarray(position_ids, dtype=np.float32)
    inv = (1.0 / (theta ** (np.arange(0, head_dim, 2, dtype=np.float32) / head_dim))).astype(np.float32)
    freqs = pos[:, None] * inv[None, :]
    emb = np.concatenate([freqs, freqs], axis=1)
    return np.cos(emb).astype(np.float32), np.sin(emb).astype(np.float32)


def fast_inputs(ids, option_ids, position_ids, window, T_pad, pad_id, theta_full=160000.0, theta_sliding=10000.0):
    """The Python twin of src/system1/von.ts buildFastInputs: padded ids, four RoPE tables, two additive biases.

    A pad token has option id −2 and position 0: it is never a key for a real
    row (not prefix-class, never the same option) and keeps its own diagonal so
    no softmax row is empty.
    """
    T = len(ids)
    assert T_pad >= T, (T_pad, T)
    pad = T_pad - T
    ids_p = list(ids) + [pad_id] * pad
    oi = np.array(list(option_ids) + [-2] * pad)
    pi = np.array(list(position_ids) + [0] * pad)
    qp = (oi == -1)[:, None]
    kp = (oi == -1)[None, :]
    same = oi[:, None] == oi[None, :]
    allowed = (qp & kp) | (~qp & (kp | same))
    eye = np.eye(T_pad, dtype=bool)
    full = allowed | eye
    sliding = (allowed & (np.abs(pi[:, None] - pi[None, :]) <= window)) | eye

    def bias(ok):
        return np.where(ok, 0.0, NEG).astype(np.float32)[None, None]

    cos_f, sin_f = rope_table(pi, theta_full)
    cos_s, sin_s = rope_table(pi, theta_sliding)
    return {
        "input_ids": np.array([ids_p], dtype=np.int64),
        "cos_full": cos_f, "sin_full": sin_f, "cos_sliding": cos_s, "sin_sliding": sin_s,
        "bias_full": bias(full), "bias_sliding": bias(sliding),
    }


class FusedAttention(torch.autograd.Function):
    """Plain attention in PyTorch; one com.microsoft MultiHeadAttention node in ONNX."""

    @staticmethod
    def forward(ctx, q, k, v, bias, num_heads):
        B, S, HD = q.shape
        D = HD // num_heads
        qh = q.view(B, S, num_heads, D).transpose(1, 2)
        kh = k.view(B, S, num_heads, D).transpose(1, 2)
        vh = v.view(B, S, num_heads, D).transpose(1, 2)
        w = torch.matmul(qh, kh.transpose(2, 3)) * (D ** -0.5) + bias
        p = torch.softmax(w, dim=-1, dtype=torch.float32).to(q.dtype)
        return torch.matmul(p, vh).transpose(1, 2).reshape(B, S, HD)

    @staticmethod
    def symbolic(g, q, k, v, bias, num_heads):
        none = g.op("prim::Constant")
        none.setType(torch._C.OptionalType.ofTensor())
        return g.op("com.microsoft::MultiHeadAttention", q, k, v, none, none, bias, num_heads_i=num_heads, scale_f=HEAD_DIM ** -0.5)


class Rope(nn.Module):
    """RoPE in fp32 from input tables; its nodes are named /rope*/ so the fp16 converter can keep them fp32."""

    def forward(self, x, cos, sin):  # x (B,S,H,D); cos/sin (S,D)
        x = x.float()
        half = x.shape[-1] // 2
        rot = torch.cat((-x[..., half:], x[..., :half]), dim=-1)
        return x * cos[None, :, None, :] + rot * sin[None, :, None, :]


class VonFast(nn.Module):
    def __init__(self, model, n_layers=None):
        super().__init__()
        enc = model.encoder
        self.emb = enc.embeddings
        self.layers = enc.layers if n_layers is None else enc.layers[:n_layers]
        self.types = list(enc.config.layer_types)
        self.heads = int(enc.config.num_attention_heads)
        self.final_norm = enc.final_norm
        self.scorer = model.scorer
        self.rope = Rope()

    def forward(self, input_ids, cos_full, sin_full, cos_sliding, sin_sliding, bias_full, bias_sliding, marker_positions):
        x = self.emb.norm(self.emb.tok_embeddings(input_ids))
        for i, layer in enumerate(self.layers):
            full = self.types[i] == "full_attention"
            cos, sin, bias = (cos_full, sin_full, bias_full) if full else (cos_sliding, sin_sliding, bias_sliding)
            h = layer.attn_norm(x)
            qkv = layer.attn.Wqkv(h)
            B, S, _ = qkv.shape
            qkv = qkv.view(B, S, 3, self.heads, HEAD_DIM)
            q = self.rope(qkv[:, :, 0], cos, sin).to(qkv.dtype).reshape(B, S, -1)
            k = self.rope(qkv[:, :, 1], cos, sin).to(qkv.dtype).reshape(B, S, -1)
            v = qkv[:, :, 2].reshape(B, S, -1)
            x = x + layer.attn.Wo(FusedAttention.apply(q, k, v, bias, self.heads))
            x = x + layer.mlp(layer.mlp_norm(x))
        x = self.final_norm(x)
        return self.scorer(x[0].index_select(0, marker_positions)).float()


def tensors(inputs, markers):
    t = {k: torch.from_numpy(v) for k, v in inputs.items()}
    t["marker_positions"] = torch.tensor(markers)
    return t


def main():
    import argparse
    import time
    from export import load_reference, probe_suite, encode, plan_sequence, reference_logits
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default=None)
    args = ap.parse_args()
    model, calib, paths = load_reference(args.checkpoint)
    w = int(model.encoder.config.sliding_window)
    pad = int(model.encoder.config.pad_token_id)
    fast = VonFast(model).eval()
    worst, worst_pad = 0.0, 0.0
    t0 = time.time()
    for case in probe_suite():
        packed, ids, st = encode(model.tokenizer, model, case)
        oid, pid, mk = plan_sequence(ids, model.mask_token_id)
        ref = reference_logits(model, ids, mk)
        with torch.no_grad():
            mine = fast(**tensors(fast_inputs(ids, oid, pid, w, len(ids), pad), mk)).numpy()
            padded = fast(**tensors(fast_inputs(ids, oid, pid, w, bucket_for(len(ids)), pad), mk)).numpy()
        d, dp = float(np.abs(ref - mine).max()), float(np.abs(mine - padded).max())
        worst, worst_pad = max(worst, d), max(worst_pad, dp)
        print(f"[fast] K={len(mk)} T={len(ids)}→{bucket_for(len(ids))}: |Δlogit| vs reference {d:.2e}, padding {dp:.2e}")
    print(f"[fast] max|Δlogit| vs Von's forward {worst:.2e} · padding to a bucket {worst_pad:.2e} ({time.time() - t0:.0f}s)")
    assert worst < 1e-3, "VonFast diverges from Von's forward"
    assert worst_pad < 1e-4, "a pad token influenced a real row"
    print("[fast] OK")


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
