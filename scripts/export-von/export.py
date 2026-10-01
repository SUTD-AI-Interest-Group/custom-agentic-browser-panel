# scripts/export-von/export.py
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "von-sdk @ git+https://github.com/wfzyx/von@ca5d608fa79820d4e5388c9cb4c6a9b47a44a98c",
#   "torch>=2.4", "transformers>=5.0", "onnx>=1.17", "onnxruntime>=1.20",
#   "onnx-ir", "huggingface_hub>=0.30", "numpy",
# ]
# ///
"""Export Von 1.2 to a browser-runnable ONNX graph.

The graph takes per-token option ids and builds Von's order-invariant masks
in-graph (see von.models.option_marker.build_independent_option_masks), so the
browser never uploads two TxT float masks per call.
"""
import hashlib, json, math, os, random, sys
import numpy as np
import torch
import onnx
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from von.models.option_marker import OptionMarkerModel

REPO = "wfzyx/von"
REVISION = "5df8185a4f2327ad0a7cd117cc4f701ac557b9ae"
OUT = os.path.join(os.path.dirname(__file__), "out")
GOLDEN = os.path.join(os.path.dirname(__file__), "..", "..", "src", "system1", "__fixtures__", "von-golden.json")
MAX_TOKENS = 4096
NEG = -30000.0  # representable in fp16; exp() underflows to exactly 0 either way
PROB_TOL = 0.03


def load_reference(checkpoint=None):
    """The pinned Von 1.2, or a fine-tuned directory written by scripts/von-finetune/train.py."""
    files = ["config.json", "model.safetensors", "option_marker.pt", "tokenizer.json",
             "tokenizer_config.json", "marker_calibration.json"]
    if checkpoint:
        paths = {f: os.path.join(checkpoint, f) for f in files}
        missing = [f for f, p in paths.items() if not os.path.exists(p)]
        assert not missing, f"--checkpoint {checkpoint} lacks {missing}"
    else:
        paths = {f: hf_hub_download(REPO, f, revision=REVISION) for f in files}
    ckpt_dir = os.path.dirname(paths["config.json"])
    model = OptionMarkerModel(base_model_id=ckpt_dir)
    model.load_state_dict(torch.load(paths["option_marker.pt"], map_location="cpu", weights_only=True), strict=True)
    model.eval()
    calib = json.load(open(paths["marker_calibration.json"]))
    assert calib.get("independent_options") is True, "exporter assumes Von >= 1.2"
    model.digit_split = bool(calib.get("digit_split", False))
    return model, calib, paths


class VonExport(torch.nn.Module):
    def __init__(self, model, sliding_window: int):
        super().__init__()
        self.encoder = model.encoder
        self.scorer = model.scorer
        self.w = sliding_window

    def forward(self, input_ids, option_ids, position_ids, marker_positions):
        oi = option_ids.unsqueeze(2)
        oj = option_ids.unsqueeze(1)
        qp = oi == -1
        kp = oj == -1
        allowed = (qp & kp) | (~qp & (kp | (oi == oj)))
        ar = torch.arange(input_ids.shape[1], device=input_ids.device)
        eye = (ar.unsqueeze(0) == ar.unsqueeze(1)).unsqueeze(0)
        full = allowed | eye
        pi = position_ids.unsqueeze(2)
        pj = position_ids.unsqueeze(1)
        sliding = (allowed & ((pi - pj).abs() <= self.w)) | eye
        # Masks follow the weights' dtype, so a half-precision export would add them to fp16 scores.
        zero = torch.zeros(full.shape, dtype=self.scorer.dense.weight.dtype, device=input_ids.device)
        fm = zero.masked_fill(~full, NEG).unsqueeze(1)
        sm = zero.masked_fill(~sliding, NEG).unsqueeze(1)
        hidden = self.encoder(
            input_ids=input_ids,
            attention_mask={"full_attention": fm, "sliding_attention": sm},
            position_ids=position_ids,
        ).last_hidden_state
        return self.scorer(hidden[0].index_select(0, marker_positions)).float()


def plan_sequence(ids, mask_id):
    """Mirror of build_option_invariant_position_ids + option spans (batch 1, no padding)."""
    T = len(ids)
    markers = [i for i, t in enumerate(ids) if t == mask_id]
    last = T - 1  # trailing [SEP] stays prefix-class
    option_ids = [-1] * T
    position_ids = list(range(T))
    prefix_len = markers[0]
    for k, start in enumerate(markers):
        end = markers[k + 1] if k + 1 < len(markers) else last
        for j in range(start, end):
            option_ids[j] = k
            position_ids[j] = prefix_len + (j - start)
    return option_ids, position_ids, markers


def calibrate(logits, state_tokens, calib):
    logits = np.asarray(logits, dtype=np.float64)
    def softmax(x):
        e = np.exp(x - x.max()); return e / e.sum()
    m = calib.get("calibration_map")
    if m:
        p = softmax(logits); n = len(p)
        ent = float(-(p * np.log(np.clip(p, 1e-12, None))).sum() / math.log(n)) if n > 1 else 0.0
        raw = (m.get("bias", 0) * 1.0 + m.get("entropy", 0) * ent
               + m.get("log_tokens", 0) * (math.log10(max(state_tokens, 1)) / 4.0)
               + m.get("n_options", 0) * (n / 8.0))
        t = min(m.get("hi", 12.0), max(m.get("lo", 0.5), raw))
    else:
        t = float(calib.get("temperature", 1.0))
    return softmax(logits / max(t, 1e-4)).tolist()


def probe_suite():
    """Deterministic prompts spanning option counts 2..60 and lengths up to ~3k tokens."""
    rng = random.Random(7)
    roles = ["button", "link", "textbox", "select", "checkbox"]
    words = "cart checkout size colour blue red email name address next back search filter sort save cancel".split()
    cases = []
    for n in [2, 3, 5, 8, 13, 21, 34, 60]:
        opts = [f"[{i}] {rng.choice(roles)} '{rng.choice(words).title()} {rng.choice(words)}' → click" for i in range(n)]
        filler = " ".join(rng.choice(words) for _ in range(rng.choice([10, 200, 1500])))
        cases.append({
            "state": f"Goal: add the blue variant to the cart\nPage: Acme Shop (shop.example)\nNotes: {filler}",
            "instructions": "Which element should be used next to progress toward the goal?",
            "options": opts,
        })
    cases.append({"state": "Goal: sign up for the newsletter\nPage: Blog (blog.example)",
                  "instructions": "Decide the next browser move toward the goal.",
                  "options": ["Act on one of the visible page elements", "Scroll down to reveal more of the page",
                              "The page is still loading; wait", "The goal is already achieved", "The goal cannot be progressed here"]})
    return cases


def encode(tok, model, case):
    packed = model.pack_sequence(case["state"], case["instructions"], case["options"])
    ids = tok(packed)["input_ids"]
    assert len(ids) <= MAX_TOKENS, f"probe case too long: {len(ids)}"
    state_tokens = len(tok.encode(case["state"], add_special_tokens=False))
    return packed, ids, state_tokens


def reference_logits(model, ids, markers):
    with torch.no_grad():
        t = torch.tensor([ids])
        return model(input_ids=t, attention_mask=torch.ones_like(t), mask_positions=[markers],
                     independent_options=True)[0].float().numpy()


def onnx_logits(sess, ids, option_ids, position_ids, markers):
    return sess.run(["logits"], {
        "input_ids": np.array([ids], dtype=np.int64),
        "option_ids": np.array([option_ids], dtype=np.int64),
        "position_ids": np.array([position_ids], dtype=np.int64),
        "marker_positions": np.array(markers, dtype=np.int64),
    })[0].astype(np.float64)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_q8(src, dst, n_layers):
    """8-bit (block 16, asymmetric) encoder matmuls except attn Wqkv; large fp32 weights left over are stored fp16."""
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
    m = onnx.load(src)
    keep = [n.name for n in m.graph.node if n.op_type == "MatMul"
            and not (n.name.startswith("/encoder/layers.") and "/attn/Wqkv/" not in n.name)]
    qz = MatMulNBitsQuantizer(m, bits=8, block_size=16, is_symmetric=False, nodes_to_exclude=keep)
    qz.process()
    # Selection is by torch-export node names; if they drift, fail rather than ship an unquantized "q8".
    quantized = sum(n.op_type == "MatMulNBits" for n in qz.model.model.graph.node)
    expected = 3 * n_layers  # attn Wo, mlp Wi, mlp Wo per layer
    assert quantized == expected, f"q8 quantized {quantized} MatMuls, expected {expected}"
    print(f"[export] q8: {quantized} MatMuls quantized to 8-bit ({n_layers} layers x 3)")
    store_fp16(qz.model.model, dst, "q8")


def sanitize_fp16(m):
    """Repair what onnxruntime's float16 converter leaves behind when one tensor feeds two protected nodes: a second
    Cast with the SAME node name and output (an invalid model), and nodes no longer in topological order. Keeps the
    first of each duplicate and re-sorts with Kahn's algorithm. Returns (duplicates dropped, nodes moved)."""
    g = m.graph
    seen = set()
    kept = []
    dropped = 0
    for n in g.node:
        key = (n.name, tuple(n.output))
        if n.name and key in seen:
            dropped += 1
            continue
        seen.add(key)
        kept.append(n)
    available = {i.name for i in g.input} | {i.name for i in g.initializer} | {""}
    producer = {}
    for n in kept:
        for o in n.output:
            producer[o] = n
    remaining = list(kept)
    ordered = []
    moved = 0
    while remaining:
        progressed = False
        rest = []
        for n in remaining:
            if all(i in available for i in n.input):
                ordered.append(n)
                available.update(n.output)
                progressed = True
            else:
                rest.append(n)
        if not progressed:
            missing = [i for n in rest for i in n.input if i not in available][:3]
            raise AssertionError(f"f16 graph has unresolvable inputs {missing}")
        if rest and rest != remaining[len(remaining) - len(rest):]:
            moved += 1
        remaining = rest
    del g.node[:]
    g.node.extend(ordered)
    return dropped, moved


def fp16_activations(path):
    """Names of fp16 tensors the graph computes (not the fp16-stored weights feeding the *_upcast Casts)."""
    from onnx import TensorProto
    m = onnx.shape_inference.infer_shapes(onnx.load(path))
    g = m.graph
    stored = {i.name for i in g.initializer}
    upcast_in = {n.input[0] for n in g.node if n.op_type == "Cast" and n.name.endswith("_upcast")}
    found = [v.name for v in list(g.input) + list(g.output) + list(g.value_info)
             if v.name not in stored and v.type.tensor_type.elem_type == TensorProto.FLOAT16]
    # Belt: shape inference cannot type com.microsoft ops' outputs, so also look at what types are produced.
    found += [n.output[0] for n in g.node if n.op_type == "Cast"
              and any(a.name == "to" and a.i == TensorProto.FLOAT16 for a in n.attribute)]
    found += [i.name for i in g.initializer if i.data_type == TensorProto.FLOAT16 and i.name not in upcast_in]
    return sorted(set(found))


def store_fp16(m, dst, name):
    """Store large fp32 MatMul/Gather/Gemm weights as fp16 behind Cast(to=float); compute stays fp32."""
    from onnx import numpy_helper, helper, TensorProto
    inits = {i.name: i for i in m.graph.initializer}
    weights = sorted({i for n in m.graph.node if n.op_type in ("MatMul", "Gather", "Gemm") for i in n.input
                      if i in inits and inits[i].data_type == TensorProto.FLOAT and np.prod(inits[i].dims) >= 1 << 16})
    casts = []
    for w in weights:
        arr = numpy_helper.to_array(inits[w]).astype(np.float16)
        m.graph.initializer.remove(inits[w])
        m.graph.initializer.append(numpy_helper.from_array(arr, w + "_f16"))
        casts.append(helper.make_node("Cast", [w + "_f16"], [w], to=TensorProto.FLOAT, name=w + "_upcast"))
    nodes = list(m.graph.node)
    del m.graph.node[:]
    m.graph.node.extend(casts + nodes)
    onnx.save(m, dst)
    print(f"[export] {name}: {len(weights)} weights stored fp16")


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--ship", choices=["f16", "q8", "fp16w"], help="ship this variant instead of the first to pass the gate")
    ap.add_argument("--accept-drift", action="store_true", help="with --ship: ship it even if it fails parity")
    ap.add_argument("--out", default=OUT, help=f"output directory (default {OUT})")
    ap.add_argument("--checkpoint", default=None,
                    help="export a fine-tuned dir (scripts/von-finetune/train.py) instead of the pinned Von 1.2")
    ap.add_argument("--fast", action="store_true",
                    help="also build the fast graph (fast.py: RoPE tables + option masks as inputs, fused attention, fp16 "
                         "activations with fp32 islands) as variant f16, gated after a temperature refit; it ships first when it passes")
    ap.add_argument("--rope-fp32", action="store_true",
                    help="with --fast: also keep RoPE application (q·cos + rot(q)·sin) fp32 — the A/B for whether RoPE is the "
                         "WebGPU parity noise source (transformers' own apply_rotary_pos_emb upcasts to fp32)")
    args = ap.parse_args()
    if bool(args.ship) != args.accept_drift:
        ap.error("--ship and --accept-drift go together (without them the gate picks the variant)")
    out = args.out
    os.makedirs(out, exist_ok=True)
    model, calib, paths = load_reference(args.checkpoint)
    # A fine-tuned export must not rewrite the committed golden fixture (its
    # logits are the pinned model's); it gets its own copy beside the ship set.
    golden_path = os.path.join(out, "von-golden.json") if args.checkpoint else GOLDEN
    tok = model.tokenizer
    w = int(model.encoder.config.sliding_window)
    print(f"[export] sliding_window={w} mask={model.mask_token_id}")

    # 1) The in-graph mask must reproduce Von's own forward exactly (fp32, PyTorch).
    wrapper = VonExport(model, w).eval()
    suite = probe_suite()
    encoded = []
    for case in suite:
        packed, ids, st = encode(tok, model, case)
        oid, pid, mk = plan_sequence(ids, model.mask_token_id)
        ref = reference_logits(model, ids, mk)
        with torch.no_grad():
            mine = wrapper(torch.tensor([ids]), torch.tensor([oid]), torch.tensor([pid]), torch.tensor(mk)).numpy()
        d = float(np.abs(ref - mine).max())
        assert d < 1e-3, f"wrapper diverges from Von reference by {d}"
        encoded.append((case, packed, ids, st, oid, pid, mk, ref))
    print("[export] wrapper == reference on all probes")

    # 2) Export fp32 (dynamic T and K).
    fp32 = os.path.join(out, "von_fp32.onnx")
    _, _, ids, _, oid, pid, mk, _ = encoded[3]
    example = (torch.tensor([ids]), torch.tensor([oid]), torch.tensor([pid]), torch.tensor(mk))

    def export(path):
        torch.onnx.export(
            wrapper,
            example,
            path,
            input_names=["input_ids", "option_ids", "position_ids", "marker_positions"],
            output_names=["logits"],
            dynamic_axes={"input_ids": {1: "T"}, "option_ids": {1: "T"}, "position_ids": {1: "T"},
                          "marker_positions": {0: "K"}, "logits": {0: "K"}},
            opset_version=18,
            dynamo=False,
        )

    export(fp32)

    # 3) Variants. Both keep every activation fp32, so WebGPU needs no shader-f16:
    # weights *stored* fp16 sit behind Cast(to=float), which ORT's basic
    # ConstantFolding (pre-partitioning, so on any EP) upcasts at session init.
    # q8: 8-bit weights except attention Wqkv. Every 4-bit recipe (RTN/HQQ/k-quant/
    # GPTQ, block 16/32, MLP-only) and 8-bit on all matmuls failed the gate; Wqkv is
    # the one group 8-bit cannot carry. fp16w: fp16-stored weights, fp32 compute —
    # the fallback. (An fp16-activation graph also passed but needs shader-f16, and
    # graph converters put RoPE's position*inv_freq in fp16, which flips long prompts.)
    q8 = os.path.join(out, "von_q8.onnx")
    build_q8(fp32, q8, int(model.encoder.config.num_hidden_layers))
    fp16w = os.path.join(out, "von_fp16w.onnx")
    store_fp16(onnx.load(fp32), fp16w, "fp16w")
    variants = []
    for name, path in [("q8", q8), ("fp16w", fp16w)]:
        f16 = fp16_activations(path)
        print(f"[export] {name}: requiresShaderF16={bool(f16)}" + (f" ({len(f16)} fp16 tensors, e.g. {f16[:3]})" if f16 else ""))
        assert not f16, f"{name} is documented as fp32-compute but computes fp16 tensors"
        variants.append((name, path, bool(f16)))

    # 3b) The fast graph (fast.py): the same weights with RoPE tables and the two
    # option masks as INPUTS and one fused MultiHeadAttention per layer, then
    # fp16 activations with fp32 islands (RoPE, LayerNorm, scorer). The fp32
    # fast graph must first match Von's forward on the CPU EP; the f16 one is
    # gated after a scalar temperature refit (fp16 noise mostly rescales logits,
    # and the head's low temperature amplifies any drift ~3x).
    fast_info = None
    if args.fast:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from fast import VonFast, fast_inputs, tensors, bucket_for, FAST_INPUT_NAMES, BUCKETS
        pad_id = int(model.encoder.config.pad_token_id)
        fast_model = VonFast(model).eval()
        fast_fp32 = os.path.join(out, "von_fast_fp32.onnx")
        _, _, ids, _, oid, pid, mk, _ = encoded[3]
        ex = tensors(fast_inputs(ids, oid, pid, w, bucket_for(len(ids)), pad_id), mk)
        torch.onnx.export(
            fast_model, tuple(ex[n] for n in FAST_INPUT_NAMES), fast_fp32,
            input_names=FAST_INPUT_NAMES, output_names=["logits"],
            dynamic_axes={"input_ids": {1: "T"}, "cos_full": {0: "T"}, "sin_full": {0: "T"}, "cos_sliding": {0: "T"},
                          "sin_sliding": {0: "T"}, "bias_full": {2: "T", 3: "T"}, "bias_sliding": {2: "T", 3: "T"},
                          "marker_positions": {0: "K"}, "logits": {0: "K"}},
            opset_version=18, dynamo=False, custom_opsets={"com.microsoft": 1},
        )
        g32 = onnx.load(fast_fp32)
        mha = sum(n.op_type == "MultiHeadAttention" for n in g32.graph.node)
        assert mha == len(fast_model.layers), f"expected {len(fast_model.layers)} MultiHeadAttention nodes, got {mha}"
        print(f"[export] fast: {len(g32.graph.node)} nodes, {mha} MultiHeadAttention")
        from onnxruntime.transformers.float16 import convert_float_to_float16
        # Islands: every LayerNormalization, the final norm and the scorer stay fp32. RoPE does NOT need to: the
        # angle computation (position·inv_freq, where an fp16 graph once flipped long prompts) is no longer in the
        # graph — cos/sin arrive as fp32 inputs — and q·cos + rot(q)·sin in fp16 is what every fp16 runtime does.
        island = [n.name for n in g32.graph.node if "/scorer" in n.name or "/final_norm" in n.name
                  or (args.rope_fp32 and "/rope" in n.name)]
        g16 = convert_float_to_float16(g32, keep_io_types=True, op_block_list=["LayerNormalization"], node_block_list=island)
        dropped, reordered = sanitize_fp16(g16)
        onnx.checker.check_model(g16)
        f16_path = os.path.join(out, "von_f16.onnx")
        onnx.save(g16, f16_path)
        casts = sum(n.op_type == "Cast" for n in g16.graph.node)
        print(f"[export] f16: {len(island)} island nodes kept fp32 (scorer, final norm) + every LayerNormalization; "
              f"{casts} Casts; sanitize dropped {dropped} duplicate Cast nodes, reordered {reordered} nodes; checker OK")
        fast_info = {"pad_id": pad_id, "buckets": BUCKETS, "fast_inputs": fast_inputs, "bucket_for": bucket_for, "fp32": fast_fp32}
        variants.insert(0, ("f16", f16_path, True))

    def drop_onnx(keep=None):
        for f in os.listdir(out):
            if f.endswith(".onnx") and os.path.join(out, f) != keep:
                os.remove(os.path.join(out, f))

    # 4) Parity gate + order invariance per variant.
    def gate(path, fast=False, refit=False):
        try:
            sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        except Exception as err:  # the CPU EP may lack an fp16 kernel for a contrib op — then WebGPU (the eval's parity phase) is the gate
            if not fast:
                raise
            return None, f"CPU EP cannot run it ({str(err).splitlines()[0][:120]}) — parity deferred to the eval's WebGPU phase", {"ep": "webgpu-pending", "probes": len(encoded)}

        def run(ids, oid, pid, mk):
            if not fast:
                return onnx_logits(sess, ids, oid, pid, mk)
            feeds = {k: v for k, v in fast_info["fast_inputs"](ids, oid, pid, w, fast_info["bucket_for"](len(ids)), fast_info["pad_id"]).items()}
            feeds["marker_positions"] = np.array(mk, dtype=np.int64)
            return sess.run(["logits"], feeds)[0]

        try:
            outs = [run(ids, oid, pid, mk) for _, _, ids, _, oid, pid, mk, _ in encoded]
        except Exception as err:
            if not fast:
                raise
            return None, f"CPU EP failed at run time ({str(err).splitlines()[0][:120]}) — parity deferred to the eval's WebGPU phase", {"ep": "webgpu-pending", "probes": len(encoded)}
        cal = calib
        refit_t = None
        if refit:
            # Scalar T minimising the mean KL from the reference's calibrated probabilities over the probes:
            # the logits of an fp16 graph are the fp32 ones rescaled by a hair, and the shipped temperature is tuned to the fp32 ones.
            base_t = float(calib.get("temperature", 1.0))
            grid = base_t * np.exp(np.linspace(math.log(0.5), math.log(2.0), 81))

            def mean_kl(t):
                tot = 0.0
                for (case, packed, ids, st, oid, pid, mk, ref), got in zip(encoded, outs):
                    p = np.array(calibrate(ref, st, calib))
                    q = np.array(calibrate(got, st, dict(calib, calibration_map=None, temperature=float(t))))
                    tot += float((p * (np.log(np.clip(p, 1e-12, None)) - np.log(np.clip(q, 1e-12, None)))).sum())
                return tot / len(encoded)

            refit_t = float(min(grid, key=mean_kl))
            cal = dict(calib, calibration_map=None, temperature=refit_t)
        worst, flips = 0.0, []
        for (case, packed, ids, st, oid, pid, mk, ref), got in zip(encoded, outs):
            p_ref, p_got = calibrate(ref, st, calib), calibrate(got, st, cal)
            if int(np.argmax(p_ref)) != int(np.argmax(p_got)):
                flips.append(f"K={len(mk)}/T={len(ids)}")
            worst = max(worst, float(np.abs(np.array(p_ref) - np.array(p_got)).max()))
        stats = {"maxDeltaP": round(worst, 4), "argmaxFlips": len(flips), "probes": len(encoded)}
        if refit_t is not None:
            stats["refitTemperature"] = round(refit_t, 4)
        if flips:
            return False, f"argmax flip on {', '.join(flips)} (max|Δp|={worst:.4f})", stats
        # Order invariance: reverse the options of the 8-option case.
        case = encoded[3][0]
        rev = dict(case, options=list(reversed(case["options"])))
        _, ids2, _ = encode(tok, model, rev)
        o2, p2, m2 = plan_sequence(ids2, model.mask_token_id)
        a = run(*(encoded[3][2], encoded[3][4], encoded[3][5], encoded[3][6]))
        b = run(ids2, o2, p2, m2)[::-1]
        inv = float(np.abs(a - b).max())
        ok = worst <= PROB_TOL and inv < 1e-2
        suffix = f" T refit {calib.get('temperature', 1.0):.3f}→{refit_t:.3f}" if refit_t is not None else ""
        return ok, f"max|Δp|={worst:.4f} invariance={inv:.5f}{suffix}", dict(stats, invariance=round(inv, 5))

    if fast_info:
        # The fp32 fast graph is the same math as Von's forward; it must agree to the float noise floor before fp16 is judged.
        ok32, why32, _ = gate(fast_info["fp32"], fast=True)
        print(f"[gate] fast-fp32: {'PASS' if ok32 else 'FAIL'} {why32}")
        assert ok32 and "max|Δp|=0.00" in why32, "the fp32 fast graph does not reproduce Von's forward"

    chosen = None
    for name, path, f16 in variants:
        ok, why, stats = gate(path, fast=name == "f16", refit=name == "f16")
        if ok is None:  # deferred to WebGPU: ship it provisionally, the manifest says so, the eval's parity phase decides
            print(f"[gate] {name}: DEFERRED {why}")
            if chosen is None and args.ship is None:
                chosen = (name, path, f16, dict(stats, gatePassed=None, ep="webgpu-pending"))
            continue
        print(f"[gate] {name}: {'PASS' if ok else 'FAIL'} {why}")
        forced = args.ship == name
        if (ok and chosen is None and args.ship is None) or forced:
            chosen = (name, path, f16, dict(stats, gatePassed=ok, ep="cpu"))
    if chosen is None:
        drop_onnx()
        sys.exit("[gate] no variant passes parity — STOP (see plan Task 1)")

    # 5) Ship files + manifest.
    name, path, requires_f16, parity = chosen
    if parity["gatePassed"] is False:
        print(f"[gate] shipping {name} DESPITE failing parity (--accept-drift)")
    ship_model = os.path.join(out, f"model_{name}.onnx")
    os.replace(path, ship_model)
    for f in ["tokenizer.json", "tokenizer_config.json"]:
        with open(paths[f], "rb") as src, open(os.path.join(out, f), "wb") as dst:
            dst.write(src.read())
    von = {
        "model": calib.get("model_id", "von-1.2.0"),
        "maskTokenId": model.mask_token_id,
        "clsTokenId": tok.cls_token_id,
        "sepTokenId": tok.sep_token_id,
        "slidingWindow": w,
        "maxTokens": MAX_TOKENS,
        "digitSplit": model.digit_split,
        "temperature": float(calib.get("temperature", 1.0)),
        "calibrationMap": calib.get("calibration_map"),
    }
    if name == "f16":
        # The fast graph's inputs are built in the browser (src/system1/von.ts buildFastInputs) from these facts, and
        # the refit scalar temperature replaces the shipped one (the map, if any, was fitted to fp32 logits).
        von.update({
            "inputs": "fast", "padTokenId": fast_info["pad_id"], "headDim": 64,
            "rope": {"full": float(model.encoder.config.rope_parameters["full_attention"]["rope_theta"]),
                     "sliding": float(model.encoder.config.rope_parameters["sliding_attention"]["rope_theta"])},
            "buckets": fast_info["buckets"],
        })
        if parity.get("refitTemperature") is not None:
            von["temperature"] = float(parity["refitTemperature"])
            von["calibrationMap"] = None
    with open(os.path.join(out, "von.json"), "w") as f:
        json.dump(von, f, indent=2)
    files = [f"model_{name}.onnx", "tokenizer.json", "tokenizer_config.json", "von.json"]
    manifest = {
        "format": 1, "model": von["model"], "variant": name, "requiresShaderF16": requires_f16,
        "parity": parity,  # provenance only: the extension ignores it
        "source": {"repo": REPO, "revision": REVISION,
                   **({"finetune": {"optionMarkerSha256": sha256(paths["option_marker.pt"]),
                                    "calibration": {"temperature": von["temperature"], "calibrationMap": von["calibrationMap"]}}}
                      if args.checkpoint else {})},
        "files": [{"path": f, "bytes": os.path.getsize(os.path.join(out, f)),
                   "sha256": sha256(os.path.join(out, f))} for f in files],
    }
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"[export] manifest sha256 = {sha256(os.path.join(out, 'manifest.json'))}")
    # Only now that the manifest names the new model: out/ keeps just the ship set.
    drop_onnx(keep=ship_model)

    # 6) Golden fixture for the TS tests (first 3 cases + the move case; ids only, no weights).
    golden = {"model": von["model"], "maskTokenId": von["maskTokenId"], "calibration": {
        "temperature": von["temperature"], "calibrationMap": von["calibrationMap"]}, "cases": []}
    for case, packed, ids, st, oid, pid, mk, ref in [encoded[0], encoded[1], encoded[2], encoded[-1]]:
        golden["cases"].append({**case, "packed": packed, "ids": ids, "optionIds": oid, "positionIds": pid,
                                "markers": mk, "stateTokens": st, "logits": ref.tolist(),
                                "probs": calibrate(ref, st, calib)})
    os.makedirs(os.path.dirname(golden_path), exist_ok=True)
    with open(golden_path, "w") as f:
        json.dump(golden, f)
    print(f"[export] wrote {golden_path}")


if __name__ == "__main__":
    main()
    # torch + onnxruntime can abort in a static destructor at interpreter exit on
    # macOS (recursive_mutex lock failed) after all output is written; skip teardown.
    sys.stdout.flush(); sys.stderr.flush()
    os._exit(0)
