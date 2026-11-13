"""The phone's own base weights, read back into Hugging Face form: `base.weights: q4_0_dequantised`.

The adapter is applied over the Q4_0 GGUF at run time, so it is fitted against what that file holds, not the bf16 weights it was made from.
This module reads the GGUF (gguf-py, the pip `gguf` package), dequantises each tensor, undoes the converter's rewrites, and overwrites the
language-model parameters of a Hugging Face model of the same architecture. The vision tower is not in the language GGUF and is left alone.

DEQUANTISING (ggml's reference): a Q4_0 block is 32 values in 18 bytes: a float16 scale `d`, then 16 bytes. Value j < 16 is the LOW nibble
of byte j, value j >= 16 the HIGH nibble of byte j-16, and each is `(nibble - 8) * d`. Q8_0 is a float16 scale and 32 int8s: `q * d`.
F32, F16 and BF16 are read as they are. Any other type is refused by name (a file that quantises something else needs that type added here).

THE CONVERTER'S REWRITES, UNDONE (llama.cpp `Qwen3NextModel.modify_tensors` at the pinned commit; the 0.8B has 16 key and 16 value heads in
its linear-attention layers, so the converter's V-head reorder does not run and there is nothing to undo for it):
  ssm_a            = -exp(A_log)          -> A_log = log(-ssm_a)
  ssm_conv1d       = conv1d.squeeze()     -> conv1d = unsqueeze(1)
  every *norm.weight except linear_attn.norm.weight is stored +1 -> subtract 1
`token_embd` is the (tied) embedding, Q8_0 in the phone's file; there is no separate output matrix.

WHAT IS PROVEN OFFLINE: the block arithmetic, by exact equality on hand-built blocks; the name map and the inverse rewrites, on a model of the
real architecture. WHAT IS NOT: that a real file's dequantised weights make the trainer's logits equal llama.cpp's. `check_against` prints the
distance to the bf16 weights of the same model (a sanity check that the mapping is right: it must be small, not zero), and the parity step
(`parity.py`) is the end-to-end proof.
"""
from __future__ import annotations

import re

# GGUF tensor-type ids (ggml_type) this module can read.
F32, F16, Q4_0, Q8_0, BF16 = 0, 1, 2, 8, 30
BLOCK = 32
Q4_0_BYTES = 18
Q8_0_BYTES = 34


class Unsupported(ValueError):
    pass


def dequantize_q4_0(raw, np):
    """`raw`: uint8, any shape whose size is a whole number of 18-byte blocks. Returns float32 of shape (blocks, 32)."""
    blocks = np.ascontiguousarray(raw, dtype=np.uint8).reshape(-1, Q4_0_BYTES)
    d = np.ascontiguousarray(blocks[:, :2]).view(np.float16).astype(np.float32)  # (n, 1)
    qs = blocks[:, 2:]
    low = (qs & 0x0F).astype(np.int16) - 8
    high = (qs >> 4).astype(np.int16) - 8
    return np.concatenate([low, high], axis=1).astype(np.float32) * d


def dequantize_q8_0(raw, np):
    blocks = np.ascontiguousarray(raw, dtype=np.uint8).reshape(-1, Q8_0_BYTES)
    d = np.ascontiguousarray(blocks[:, :2]).view(np.float16).astype(np.float32)
    return np.ascontiguousarray(blocks[:, 2:]).view(np.int8).astype(np.float32) * d


def dequantize(raw, qtype: int, shape, np):
    """A tensor of GGUF type `qtype` to float32 of numpy shape `shape` (the reverse of GGUF's `ne` order)."""
    n = 1
    for s in shape:
        n *= int(s)
    if qtype == Q4_0:
        flat = dequantize_q4_0(raw, np)
    elif qtype == Q8_0:
        flat = dequantize_q8_0(raw, np)
    elif qtype == F32:
        flat = np.ascontiguousarray(raw).view(np.float32)
    elif qtype == F16:
        flat = np.ascontiguousarray(raw).view(np.float16).astype(np.float32)
    elif qtype == BF16:
        flat = (np.ascontiguousarray(raw).view(np.uint16).astype(np.uint32) << 16).view(np.float32)
    else:
        raise Unsupported("GGUF tensor type %d is not read here (Q4_0, Q8_0, F32, F16, BF16 are)" % qtype)
    if flat.size != n:
        raise Unsupported("a tensor of shape %s holds %d values, the file has %d" % (tuple(shape), n, flat.size))
    return flat.reshape(tuple(int(s) for s in shape))


# ---- names --------------------------------------------------------------------------------------------------------------------------

# (suffix after `layers.<n>.` in the Hugging Face model) -> (GGUF name after `blk.<n>.`, rewrite to undo)
LAYER = {
    "input_layernorm.weight": ("attn_norm.weight", "norm"),
    "post_attention_layernorm.weight": ("post_attention_norm.weight", "norm"),
    "self_attn.q_proj.weight": ("attn_q.weight", None),
    "self_attn.k_proj.weight": ("attn_k.weight", None),
    "self_attn.v_proj.weight": ("attn_v.weight", None),
    "self_attn.o_proj.weight": ("attn_output.weight", None),
    "self_attn.q_norm.weight": ("attn_q_norm.weight", "norm"),
    "self_attn.k_norm.weight": ("attn_k_norm.weight", "norm"),
    "linear_attn.in_proj_qkv.weight": ("attn_qkv.weight", None),
    "linear_attn.in_proj_z.weight": ("attn_gate.weight", None),
    "linear_attn.in_proj_a.weight": ("ssm_alpha.weight", None),
    "linear_attn.in_proj_b.weight": ("ssm_beta.weight", None),
    "linear_attn.out_proj.weight": ("ssm_out.weight", None),
    "linear_attn.norm.weight": ("ssm_norm.weight", None),
    "linear_attn.A_log": ("ssm_a", "a_log"),
    "linear_attn.dt_bias": ("ssm_dt.bias", None),
    "linear_attn.conv1d.weight": ("ssm_conv1d.weight", "conv"),
    "mlp.gate_proj.weight": ("ffn_gate.weight", None),
    "mlp.up_proj.weight": ("ffn_up.weight", None),
    "mlp.down_proj.weight": ("ffn_down.weight", None),
}



def gguf_name(hf_name: str):
    """`(gguf tensor name, rewrite)` for a language-model parameter of the Hugging Face model, or None when the GGUF does not hold it
    (the vision tower, anything else)."""
    if "visual" in hf_name or "vision" in hf_name:
        return None
    m = re.search(r"\blayers\.(\d+)\.(.+)$", hf_name)
    if m:
        entry = LAYER.get(m.group(2))
        return ("blk.%s.%s" % (m.group(1), entry[0]), entry[1]) if entry else None
    if hf_name.endswith("embed_tokens.weight"):
        return "token_embd.weight", None
    if hf_name.endswith("model.norm.weight") or hf_name.endswith("language_model.norm.weight") or hf_name == "norm.weight":
        return "output_norm.weight", "norm"
    return None


def undo(rewrite, array, np):
    """The Hugging Face value of a tensor the converter rewrote."""
    if rewrite == "norm":
        return array - 1.0
    if rewrite == "a_log":
        if (array >= 0).any():
            raise Unsupported("ssm_a holds a non-negative value; it is -exp(A_log), so every value must be negative")
        return np.log(-array)
    if rewrite == "conv":
        return array.reshape(array.shape[0], 1, array.shape[-1]) if array.ndim == 2 else array
    return array


# ---- the file -----------------------------------------------------------------------------------------------------------------------

def read_tensors(path):
    """`{gguf name: float32 numpy array}` of every tensor of the file at `path`, dequantised."""
    import numpy as np
    from gguf import GGUFReader  # noqa: PLC0415 - the pip `gguf` package; only a q4_0_dequantised job needs it

    out = {}
    for t in GGUFReader(str(path)).tensors:
        shape = tuple(int(x) for x in reversed(t.shape))
        out[t.name] = dequantize(t.data, int(t.tensor_type), shape, np)
    return out


def load_into(model, tensors: dict, *, torch) -> dict:
    """Overwrite the language-model parameters of `model` with `tensors` (from `read_tensors`). Every parameter the GGUF is expected to hold
    must be found with the right shape; a parameter or tensor left over is an error, not a silent skip. Returns `{hf name: max |new-old|}`
    so the caller can see how far Q4_0 sits from the weights the model came with."""
    import numpy as np

    moved, used = {}, set()
    params = dict(model.named_parameters())
    for name, param in params.items():
        mapped = gguf_name(name)
        if mapped is None:
            continue
        gname, rewrite = mapped
        if gname not in tensors:
            raise Unsupported("the GGUF has no tensor %s for %s" % (gname, name))
        value = undo(rewrite, tensors[gname], np)
        if tuple(value.shape) != tuple(param.shape):
            raise Unsupported("%s is %s in the model and %s in the GGUF (%s)" % (name, tuple(param.shape), tuple(value.shape), gname))
        new = torch.from_numpy(np.ascontiguousarray(value)).to(param.dtype)
        moved[name] = float((new.float() - param.detach().float().cpu()).abs().max())
        with torch.no_grad():
            param.copy_(new.to(param.device))
        used.add(gname)
    left = sorted(set(tensors) - used)
    # a tied head is not a parameter of its own; nothing else should be left over
    left = [n for n in left if n != "output.weight"]
    if left:
        raise Unsupported("the GGUF holds tensors the model has no parameter for: %s" % ", ".join(left[:5]))
    if not moved:
        raise Unsupported("no parameter of the model was matched to a GGUF tensor")
    return moved
