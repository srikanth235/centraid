"""Q4_0 read back into Hugging Face form, offline: the block arithmetic by exact equality, the name map and the converter's inverse rewrites on
a model of the real architecture. No weights are downloaded; a GGUF file is written only when the `gguf` package is installed."""
import math
import shutil
import struct
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

from adapter_train import q4_0
from test_trainer import tiny_model


def block_q4_0(scale, codes):
    """18 bytes: float16 scale, then 16 bytes of two 4-bit codes: code j (j<16) in the low nibble of byte j, code j+16 in the high nibble."""
    assert len(codes) == 32 and all(0 <= c < 16 for c in codes)
    return struct.pack("<e", scale) + bytes(codes[j] | (codes[j + 16] << 4) for j in range(16))


def block_q8_0(scale, qs):
    return struct.pack("<e", scale) + struct.pack("<32b", *qs)


class Blocks(unittest.TestCase):
    def test_a_q4_0_block_is_32_values_low_nibbles_first_then_high(self):
        codes = list(range(16)) + list(range(15, -1, -1))
        raw = np.frombuffer(block_q4_0(0.5, codes), dtype=np.uint8)
        got = q4_0.dequantize(raw, q4_0.Q4_0, (32,), np)
        want = [(c - 8) * 0.5 for c in codes]  # an independent, value-by-value reading of ggml's reference
        self.assertEqual(got.shape, (32,))
        self.assertEqual(got.tolist(), want)  # exact equality, 32 values

    def test_many_blocks_and_a_two_dimensional_shape_keep_their_order(self):
        scales = [0.25, 2.0, 0.0078125]
        blocks = b"".join(block_q4_0(sc, [(i * 7 + k) % 16 for i in range(32)]) for k, sc in enumerate(scales))
        got = q4_0.dequantize(np.frombuffer(blocks, dtype=np.uint8), q4_0.Q4_0, (3, 32), np)
        self.assertEqual(got.shape, (3, 32))
        for k, sc in enumerate(scales):
            self.assertEqual(got[k].tolist(), [(((i * 7 + k) % 16) - 8) * sc for i in range(32)])
        self.assertEqual(got.size, 96)

    def test_the_scale_is_float16_and_rounds_like_ggml(self):
        scale = float(np.float16(0.1))  # not exactly 0.1: the block stores what float16 holds
        raw = np.frombuffer(block_q4_0(scale, [15] * 32), dtype=np.uint8)
        got = q4_0.dequantize(raw, q4_0.Q4_0, (32,), np)
        self.assertEqual(set(got.tolist()), {float(np.float32(7) * np.float32(np.float16(scale)))})

    def test_q8_0_f32_f16_and_bf16(self):
        qs = list(range(-16, 16))
        got = q4_0.dequantize(np.frombuffer(block_q8_0(0.5, qs), dtype=np.uint8), q4_0.Q8_0, (32,), np)
        self.assertEqual(got.tolist(), [q * 0.5 for q in qs])
        f32 = np.array([1.5, -2.25, 1e-3], dtype=np.float32)
        self.assertEqual(q4_0.dequantize(f32.view(np.uint8), q4_0.F32, (3,), np).tolist(), f32.tolist())
        f16 = np.array([1.5, -2.25, 0.125], dtype=np.float16)
        self.assertEqual(q4_0.dequantize(f16.view(np.uint8), q4_0.F16, (3,), np).tolist(), [1.5, -2.25, 0.125])
        bf = (np.array([1.5, -2.25, 3.0], dtype=np.float32).view(np.uint32) >> 16).astype(np.uint16)
        self.assertEqual(q4_0.dequantize(bf.view(np.uint8), q4_0.BF16, (3,), np).tolist(), [1.5, -2.25, 3.0])

    def test_a_type_it_cannot_read_and_a_wrong_size_are_errors_in_words(self):
        with self.assertRaisesRegex(q4_0.Unsupported, "type 6"):
            q4_0.dequantize(np.zeros(4, dtype=np.uint8), 6, (1,), np)
        with self.assertRaisesRegex(q4_0.Unsupported, "holds 64 values"):
            q4_0.dequantize(np.frombuffer(block_q4_0(1.0, [8] * 32), dtype=np.uint8), q4_0.Q4_0, (2, 32), np)


def as_gguf(model):
    """What the converter would have written for `model`'s language weights, as float32 arrays by GGUF name (the forward rewrites)."""
    out = {}
    for name, p in model.named_parameters():
        mapped = q4_0.gguf_name(name)
        if mapped is None:
            continue
        gname, rewrite = mapped
        v = p.detach().float().numpy().copy()
        if rewrite == "norm":
            v = v + 1.0
        elif rewrite == "a_log":
            v = -np.exp(v)
        elif rewrite == "conv":
            v = v.squeeze()
        out[gname] = v
    return out


class Mapping(unittest.TestCase):
    def test_every_language_parameter_has_a_gguf_name_and_the_names_are_distinct(self):
        names = [n for n, _ in tiny_model().named_parameters()]
        mapped = [q4_0.gguf_name(n) for n in names]
        self.assertFalse([n for n, m in zip(names, mapped) if m is None], "a parameter the map does not know")
        self.assertEqual(len({m[0] for m in mapped}), len(mapped))
        self.assertIn("token_embd.weight", {m[0] for m in mapped})
        self.assertIn("output_norm.weight", {m[0] for m in mapped})
        self.assertIn("blk.0.ssm_a", {m[0] for m in mapped})
        self.assertIn("blk.3.attn_q.weight", {m[0] for m in mapped})  # layer 3 is the full-attention layer

    def test_the_vision_tower_is_not_in_the_language_gguf(self):
        self.assertIsNone(q4_0.gguf_name("model.visual.blocks.0.attn.qkv.weight"))

    def test_loading_the_converted_weights_puts_back_exactly_what_the_converter_took(self):
        source, target = tiny_model(seed=1), tiny_model(seed=2)
        self.assertGreater(max(float((a - b).detach().abs().max()) for a, b in zip(source.parameters(), target.parameters())), 0.1)
        moved = q4_0.load_into(target, as_gguf(source), torch=torch)
        self.assertEqual(len(moved), len(list(target.parameters())))
        for (n, a), (_, b) in zip(source.named_parameters(), target.named_parameters()):
            self.assertTrue(torch.allclose(a, b, rtol=1e-6, atol=1e-6), n)

    def test_a_missing_extra_or_misshapen_tensor_is_an_error_not_a_skip(self):
        source = tiny_model(seed=1)
        full = as_gguf(source)
        short = {k: v for k, v in full.items() if k != "blk.1.ffn_up.weight"}
        with self.assertRaisesRegex(q4_0.Unsupported, "no tensor blk.1.ffn_up.weight"):
            q4_0.load_into(tiny_model(seed=2), short, torch=torch)
        with self.assertRaisesRegex(q4_0.Unsupported, "no parameter for: blk.9.surprise"):
            q4_0.load_into(tiny_model(seed=2), {**full, "blk.9.surprise": np.zeros(2, dtype=np.float32)}, torch=torch)
        bad = {**full, "blk.1.ffn_up.weight": np.zeros((3, 3), dtype=np.float32)}
        with self.assertRaisesRegex(q4_0.Unsupported, "ffn_up"):
            q4_0.load_into(tiny_model(seed=2), bad, torch=torch)

    def test_a_non_negative_ssm_a_is_refused(self):
        with self.assertRaisesRegex(q4_0.Unsupported, "negative"):
            q4_0.undo("a_log", np.array([0.5], dtype=np.float32), np)


class File(unittest.TestCase):
    def test_a_written_gguf_reads_back_through_the_reader(self):
        import gguf
        tmp = Path(tempfile.mkdtemp(prefix="q4-file-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        codes = [(i * 5) % 16 for i in range(64)]
        raw = np.frombuffer(block_q4_0(0.5, codes[:32]) + block_q4_0(0.25, codes[32:]), dtype=np.uint8).reshape(2, 18)
        path = tmp / "t.gguf"
        w = gguf.GGUFWriter(str(path), "qwen35")
        w.add_tensor("blk.0.ffn_up.weight", raw.copy(), raw_shape=raw.shape, raw_dtype=gguf.GGMLQuantizationType.Q4_0)
        w.add_tensor("blk.0.ssm_a", np.array([-1.0, -2.0], dtype=np.float32))
        w.write_header_to_file()
        w.write_kv_data_to_file()
        w.write_tensors_to_file()
        w.close()
        got = q4_0.read_tensors(path)
        want = [(c - 8) * 0.5 for c in codes[:32]] + [(c - 8) * 0.25 for c in codes[32:]]
        self.assertEqual(got["blk.0.ffn_up.weight"].shape, (2, 32))
        self.assertEqual(got["blk.0.ffn_up.weight"].reshape(-1).tolist(), want)
        self.assertEqual(got["blk.0.ssm_a"].tolist(), [-1.0, -2.0])
        self.assertTrue(math.isfinite(float(got["blk.0.ssm_a"][0])))


if __name__ == "__main__":
    unittest.main()
