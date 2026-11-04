"""Tests for the M6 path of train.py (#1171): datagen records, the weighted loss, the arms and arm C's protected tensors.

    python -m unittest test_datagen        # from experiments/toolchat/native/train

CPU only: a tiny random Qwen3.5 text model (20 layers, so `layers.15` and `layers.19` exist) built in the test, and a word-level tokenizer
built in the test. No download, no GPU, no wall-clock assertion.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import math
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import arms  # noqa: E402
import datagen  # noqa: E402

VOCAB = 64
LAYERS = 20
PROTECTED = ("model.layers.15.mlp.down_proj.weight", "model.layers.19.mlp.down_proj.weight")


def record(rid, n, weights=None, tags=None):
    """An assist-eval session shell with the render the trainer reads. Token ids are arbitrary (< VOCAB)."""
    ids = [(7 * i + len(rid)) % (VOCAB - 4) + 2 for i in range(n)]
    if weights is None:  # 0 on the first third (system, user), 1 on the rest, 3 on every fifth of those (deciding tokens)
        weights = [0.0 if i < n // 3 else (3.0 if i % 5 == 0 else 1.0) for i in range(n)]
    return {"id": rid, "world": "W1", "today": "2026-11-04", "me": "me", "tags": tags or [],
            "turns": [{"user": "hi", "gold": {}, "ref": [], "tags": []}],
            "render": {"input_ids": ids, "weights": weights, "text": "x"}}


def write_zst(path, records):
    import zstandard

    data = "".join(json.dumps(r) + "\n" for r in records).encode()
    Path(path).write_bytes(zstandard.ZstdCompressor().compress(data))


def tiny_config():
    from transformers import Qwen3_5TextConfig

    return Qwen3_5TextConfig(vocab_size=VOCAB, hidden_size=32, intermediate_size=64, num_hidden_layers=LAYERS, num_attention_heads=4,
                             num_key_value_heads=2, head_dim=8, linear_num_value_heads=4, linear_num_key_heads=2,
                             linear_key_head_dim=8, linear_value_head_dim=8, tie_word_embeddings=True, initializer_range=0.5)


def tiny_model(seed=0):
    import torch
    from transformers import Qwen3_5ForCausalLM

    torch.manual_seed(seed)
    return Qwen3_5ForCausalLM(tiny_config()).float()


def tiny_tokenizer(d):
    from tokenizers import Tokenizer, models, pre_tokenizers
    from transformers import PreTrainedTokenizerFast

    vocab = {"<unk>": 0, "<pad>": 1, **{"t%d" % i: i for i in range(2, VOCAB)}}
    tk = Tokenizer(models.WordLevel(vocab, unk_token="<unk>"))
    tk.pre_tokenizer = pre_tokenizers.Whitespace()
    PreTrainedTokenizerFast(tokenizer_object=tk, unk_token="<unk>", pad_token="<pad>").save_pretrained(d)


class DatagenLoadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="datagen-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_reads_zst_records_as_they_are(self):
        recs = [record("a", 30), record("b", 40, tags=["pair:p1"]), record("c", 50, weights=[0.0] * 10 + [1.0, 2.5] * 20)]
        path = os.path.join(self.tmp, "train.jsonl.zst")
        write_zst(path, recs)
        got, stats = datagen.load(path, max_len=100)
        self.assertEqual([g["id"] for g in got], ["a", "b", "c"])
        for g, r in zip(got, recs):
            self.assertEqual(g["input_ids"], r["render"]["input_ids"])  # no re-rendering, no re-tokenizing
            self.assertEqual(list(g["weights"]), r["render"]["weights"])
            self.assertIsInstance(g["weights"], datagen.TokenWeights)
            # a position carries loss exactly when its weight is above 0
            self.assertEqual(g["labels"], [t if w > 0 else datagen.IGNORE for t, w in zip(g["input_ids"], g["weights"])])
        self.assertEqual([g["pair"] for g in got], ["", "p1", ""])
        self.assertEqual((stats["read"], stats["kept"], stats["dropped_too_long"]), (3, 3, 0))
        self.assertEqual(stats["tokens"], 120)
        self.assertAlmostEqual(stats["weight_mass"], sum(sum(r["render"]["weights"][1:]) for r in recs))

    def test_too_long_is_dropped_and_counted_never_cut(self):
        path = os.path.join(self.tmp, "t.jsonl.zst")
        write_zst(path, [record("short", 20), record("long", 80), record("edge", 50)])
        got, stats = datagen.load(path, max_len=50)
        self.assertEqual([g["id"] for g in got], ["short", "edge"])
        self.assertEqual(stats["dropped_too_long"], 1)
        self.assertTrue(all(len(g["input_ids"]) <= 50 and len(g["input_ids"]) == len(g["weights"]) for g in got))
        self.assertEqual(len(got[1]["input_ids"]), 50)  # a record that fits is whole

    def test_limit_keeps_the_first_that_fit(self):
        path = os.path.join(self.tmp, "t.jsonl.zst")
        write_zst(path, [record("a", 20), record("b", 90), record("c", 20), record("d", 20)])
        got, _ = datagen.load(path, max_len=50, limit=2)
        self.assertEqual([g["id"] for g in got], ["a", "c"])

    def test_plain_and_gz_files_read_too(self):
        import gzip

        plain = os.path.join(self.tmp, "t.jsonl")
        Path(plain).write_text(json.dumps(record("a", 20)) + "\n\n")
        gz = os.path.join(self.tmp, "t.jsonl.gz")
        with gzip.open(gz, "wt") as f:
            f.write(json.dumps(record("b", 20)) + "\n")
        self.assertEqual([r["id"] for r in datagen.read_jsonl(plain)], ["a"])
        self.assertEqual([r["id"] for r in datagen.read_jsonl(gz)], ["b"])

    def test_contract_violations_stop_the_run(self):
        bad_len = record("x", 20)
        bad_len["render"]["weights"].pop()
        neg = record("y", 20)
        neg["render"]["weights"][5] = -1.0
        nan = record("n", 20)
        nan["render"]["weights"][5] = float("nan")
        silent = record("z", 20, weights=[0.0] * 20)
        no_render = {"id": "r"}
        short = record("s", 1)
        for rec in (bad_len, neg, nan, silent, no_render, short):
            with self.assertRaises(datagen.RecordError, msg=rec["id"]):
                datagen.encode(rec)

    def test_the_ignore_label_is_the_trainers(self):
        import fmt

        self.assertEqual(datagen.IGNORE, fmt.IGNORE)


class LossArithmeticTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import torch

        cls.torch = torch
        spec = importlib.util.spec_from_file_location("train_script", HERE / "train.py")
        cls.train = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.train)

    def example(self, n=12, weights=None):
        enc = datagen.encode(record("e", n, weights))
        return self.train.Example(enc["input_ids"], enc["labels"], enc["weights"], enc["pair"])

    def test_weighted_sum_over_weight_mass(self):
        torch, train = self.torch, self.train
        w = [0.0, 0.0, 0.0, 1.0, 1.0, 3.0, 1.0, 0.0, 2.0, 1.0]
        ex = self.example(len(w), w)
        logits = torch.randn(6, VOCAB)
        pos = torch.nonzero(torch.tensor(ex[1][1:]) != datagen.IGNORE).squeeze(1)  # the positions whose NEXT token is trained
        self.assertEqual(pos.tolist(), [2, 3, 4, 5, 7, 8])
        self.assertEqual(len(pos), 6)
        tgt = torch.tensor(ex[0][1:])[pos]
        loss, n, _, plain = train.loss_from_logits(logits, tgt, pos, ex[2], 99.0, torch.device("cpu"), 99.0)  # W, CW ignored
        ce = torch.nn.functional.cross_entropy(logits, tgt, reduction="none")
        want = sum(float(c) * x for c, x in zip(ce, [w[1:][p] for p in pos.tolist()]))
        self.assertAlmostEqual(float(loss), want, places=5)
        self.assertAlmostEqual(float(plain), float(ce.sum()), places=5)
        self.assertEqual(n, 6)
        # the mass: weight 0 tokens are no labels and add nothing; the first token's weight is never a target
        self.assertEqual(train.weight_mass(ex[1], ex[2], 99.0, 99.0), (6, 2, 9.0))

    def test_mass_excludes_the_first_token_and_zero_weights(self):
        ex = self.example(6, [5.0, 0.0, 1.0, 2.0, 0.0, 4.0])
        n, nd, mass = self.train.weight_mass(ex[1], ex[2], 1.0)
        self.assertEqual((n, nd), (3, 2))
        self.assertAlmostEqual(mass, 7.0)

    def test_unit_weights_are_the_plain_mean(self):
        torch, train = self.torch, self.train
        ex = self.example(10, [0.0] * 3 + [1.0] * 7)
        logits = torch.randn(7, 9)
        pos = torch.arange(2, 9)
        tgt = torch.randint(0, 9, (7,))
        loss, n, _, _ = train.loss_from_logits(logits, tgt, pos, ex[2], 1.0, torch.device("cpu"))
        mass = train.weight_mass(ex[1], ex[2], 1.0)[2]
        mean = torch.nn.functional.cross_entropy(logits, tgt)
        self.assertAlmostEqual(float(loss) / mass, float(mean), places=5)

    def test_scaling_every_weight_leaves_the_normalised_loss_unchanged(self):
        torch, train = self.torch, self.train
        base = [0.0, 0.0, 1.0, 3.0, 1.0, 2.0, 1.0, 1.0]
        a, b = self.example(8, base), self.example(8, [3 * x for x in base])
        logits, tgt, pos = torch.randn(6, 9), torch.randint(0, 9, (6,)), torch.arange(1, 7)
        la = float(train.loss_from_logits(logits, tgt, pos, a[2], 1.0, torch.device("cpu"))[0]) / train.weight_mass(a[1], a[2], 1.0)[2]
        lb = float(train.loss_from_logits(logits, tgt, pos, b[2], 1.0, torch.device("cpu"))[0]) / train.weight_mass(b[1], b[2], 1.0)[2]
        self.assertAlmostEqual(la, lb, places=5)

    def test_a_deciding_token_pulls_the_loss_toward_its_own_ce(self):
        torch, train = self.torch, self.train
        ex = self.example(5, [0.0, 1.0, 1.0, 1.0, 9.0])
        logits = torch.zeros(3, 4)  # equal CE everywhere except what we set
        logits[2, 1] = 6.0  # the last position (weight 9) is easy: its CE is small
        tgt, pos = torch.tensor([0, 0, 1]), torch.arange(1, 4)
        ce = torch.nn.functional.cross_entropy(logits, tgt, reduction="none")
        loss = float(train.loss_from_logits(logits, tgt, pos, ex[2], 1.0, torch.device("cpu"))[0]) / 12.0
        self.assertAlmostEqual(loss, float((ce * torch.tensor([1.0, 1.0, 9.0])).sum()) / 12.0, places=5)
        self.assertLess(loss, float(ce.mean()))


class ArmsTest(unittest.TestCase):
    def args(self, **kw):
        import argparse

        d = dict(arm=None, model="Qwen/Qwen3.5-0.8B", lora=0, lr=None, tokenizer=None)
        d.update(kw)
        return argparse.Namespace(**d)

    def test_arm_table(self):
        a, b, c = (arms.ARMS[k] for k in "ABC")
        self.assertEqual((a.base, a.lora_rank, a.skip_layers), ("Qwen/Qwen3.5-0.8B", 0, ()))
        self.assertEqual((b.base, b.lora_rank, b.skip_layers), ("RikiyaT/Qwen3.5-0.8B-weight-space-programming", 0, ()))
        self.assertEqual((c.base, c.skip_layers), (b.base, (15, 19)))
        self.assertGreater(c.lora_rank, 0)

    def test_apply_arm_sets_base_method_lr_and_tokenizer(self):
        for name in "ABC":
            ns = self.args(arm=name)
            arm = arms.apply_arm(ns)
            self.assertEqual((ns.model, ns.lora, ns.lr, ns.tokenizer), (arm.base, arm.lora_rank, arm.lr, arms.TOKENIZER))
        ns = self.args(arm="C", lr=1e-3)
        arms.apply_arm(ns)
        self.assertEqual(ns.lr, 1e-3)  # an explicit lr wins

    def test_contradictions_are_refused(self):
        with self.assertRaises(SystemExit):
            arms.apply_arm(self.args(arm="A", lora=8))
        with self.assertRaises(SystemExit):
            arms.apply_arm(self.args(arm="A", model="somebody/else"))

    def test_no_arm_leaves_the_args(self):
        ns = self.args(model="x/y")
        self.assertIsNone(arms.apply_arm(ns))
        self.assertEqual((ns.model, ns.lora, ns.lr, ns.tokenizer), ("x/y", 0, None, "x/y"))


class ProtectedTensorsTest(unittest.TestCase):
    """Arm C: no adapter on the edited tensors, and they are bit-identical to the base after the merge."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("train_script", HERE / "train.py")
        cls.train = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.train)

    def test_targets_skip_exactly_the_two_down_projs(self):
        model = tiny_model()
        every = [n for n, m in model.named_modules() if m.__class__.__name__ == "Linear" and ".layers." in n]
        got = arms.lora_target_names(model, arms.EDITED_LAYERS)
        self.assertEqual(sorted(set(every) - set(got)), ["model.layers.15.mlp.down_proj", "model.layers.19.mlp.down_proj"])
        self.assertIn("model.layers.14.mlp.down_proj", got)
        self.assertNotIn("lm_head", got)
        self.assertEqual(len(got), len(every) - 2)
        self.assertEqual(arms.protected_names(model, arms.EDITED_LAYERS), list(PROTECTED))

    def test_a_model_without_the_edited_tensors_is_refused(self):
        from transformers import Qwen3_5ForCausalLM

        cfg = tiny_config()
        cfg.num_hidden_layers = 4
        cfg.layer_types = cfg.layer_types[:4]
        with self.assertRaises(SystemExit):
            arms.lora_target_names(Qwen3_5ForCausalLM(cfg), arms.EDITED_LAYERS)

    def test_adapters_skip_them_and_the_merge_leaves_them_bit_identical(self):
        import torch
        from peft import get_peft_model
        from safetensors.torch import load_file

        train = self.train
        model = tiny_model()
        base = {k: v.detach().clone() for k, v in model.state_dict().items()}
        train.PROTECT["snapshot"] = arms.snapshot(model, arms.EDITED_LAYERS)
        self.addCleanup(train.PROTECT.update, {"snapshot": None})
        peft_model = get_peft_model(model, arms.lora_config(model, 4, arms.EDITED_LAYERS))
        adapted = arms.adapted_modules(peft_model)
        self.assertEqual(len(adapted), len(arms.lora_target_names(tiny_model(), arms.EDITED_LAYERS)))
        for n in PROTECTED:
            self.assertNotIn(n.rsplit(".weight", 1)[0], adapted)
        self.assertIn("model.layers.14.mlp.down_proj", adapted)
        # train a few steps with a big lr so the adapters are far from zero
        ids = datagen.encode(record("t", 24))
        ex = train.Example(ids["input_ids"], ids["labels"], ids["weights"])
        opt = torch.optim.AdamW([p for p in peft_model.parameters() if p.requires_grad], lr=1e-2)
        peft_model.train()
        for _ in range(3):
            loss, _, _, _ = train.forward_loss(peft_model, ex[0], ex[1], torch.device("cpu"), ex[2])
            (loss / train.weight_mass(ex[1], ex[2], 1.0)[2]).backward()
            opt.step()
            opt.zero_grad()
        # export: merge, verify the edited tensors, write bf16 safetensors
        out = tempfile.mkdtemp(prefix="merge-test-")
        self.addCleanup(shutil.rmtree, out, ignore_errors=True)

        class NoTok:
            def save_pretrained(self, d):
                pass

        with contextlib.redirect_stdout(io.StringIO()):
            train.save(peft_model, NoTok(), out, "ckpt", {"args": {}})  # arms.verify runs inside, after the merge
        saved = load_file(str(Path(out) / "ckpt" / "model.safetensors"))
        for n in PROTECTED:
            self.assertTrue(torch.equal(saved[n], base[n].to(torch.bfloat16)), n)  # the base as bf16 stores it
        changed = [n for n in saved if n not in PROTECTED and "mlp.down_proj" in n and not torch.equal(saved[n], base[n].to(torch.bfloat16))]
        self.assertTrue(changed, "the adapters changed nothing: the test proves nothing")
        # after save the adapters are unmerged again: the live base still holds the edited tensors
        arms.verify(train.PROTECT["snapshot"], peft_model.get_base_model())

    def test_verify_catches_a_changed_edit(self):
        import torch

        model = tiny_model()
        snap = arms.snapshot(model, arms.EDITED_LAYERS)
        arms.verify(snap, model)
        with torch.no_grad():
            model.model.layers[19].mlp.down_proj.weight[0, 0] += 1e-6
        with self.assertRaises(SystemExit):
            arms.verify(snap, model)


class EndToEndTest(unittest.TestCase):
    """train.main() on datagen records, one optimizer step per arm."""

    @classmethod
    def setUpClass(cls):
        import torch

        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        cls.torch = torch
        spec = importlib.util.spec_from_file_location("train_script", HERE / "train.py")
        cls.train = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.train)
        cls.tmp = tempfile.mkdtemp(prefix="datagen-e2e-")
        cls.model_dir = os.path.join(cls.tmp, "model")
        tiny_model().save_pretrained(cls.model_dir)
        tiny_tokenizer(cls.model_dir)
        cls.data = os.path.join(cls.tmp, "train.jsonl.zst")
        write_zst(cls.data, [record("r%d" % i, 24 + i) for i in range(4)] + [record("too-long", 300)])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_main(self, *flags):
        out = tempfile.mkdtemp(prefix="out-", dir=self.tmp)
        argv = ["train.py", "--train", self.data, "--val", self.data, "--out", out, "--data-format", "datagen", "--bs", "2",
                "--max-len", "128", "--checkpoints", "1.0", "--log-every", "1", "--no-grad-ckpt", "--val-n", "2",
                "--train-eval-n", "2", "--seed", "3", *flags]
        buf = io.StringIO()
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(buf):
            self.train.main()
        return Path(out), buf.getvalue()

    def check_run(self, out, text):
        self.assertIn("1 over max-len 128 dropped", text)  # counted, not cut
        self.assertIn("4 examples", text)
        self.assertTrue((out / "DONE").exists())
        steps = [ln for ln in text.splitlines() if " step " in ln and "/2 loss" in ln]
        self.assertEqual(len(steps), 2)  # 4 records, bs 2
        for ln in steps:
            self.assertTrue(math.isfinite(float(ln.split(" loss ")[1].split()[0])))
        return json.loads((out / "train_meta.json").read_text())

    def test_full_sft_step(self):
        out, text = self.run_main("--model", self.model_dir, "--tokenizer", self.model_dir, "--lr", "1e-3")
        meta = self.check_run(out, text)
        self.assertEqual(meta["args"]["data_format"], "datagen")

    def test_arm_c_step_leaves_the_edited_tensors_alone(self):
        from safetensors.torch import load_file

        edited = arms.Arm("C", self.model_dir, 4, 1e-2, arms.EDITED_LAYERS)
        with mock.patch.dict(arms.ARMS, {"C": edited}):
            out, text = self.run_main("--arm", "C", "--tokenizer", self.model_dir)
        meta = self.check_run(out, text)
        self.assertEqual((meta["args"]["arm"], meta["args"]["lora"]), ("C", 4))
        base = load_file(str(Path(self.model_dir) / "model.safetensors"))
        saved = load_file(str(out / "ckpt-100" / "model.safetensors"))
        torch = self.torch
        for n in PROTECTED:
            self.assertTrue(torch.equal(saved[n], base[n].to(torch.bfloat16)), n)
        self.assertFalse(torch.equal(saved["model.layers.14.mlp.down_proj.weight"],
                                     base["model.layers.14.mlp.down_proj.weight"].to(torch.bfloat16)))

    def test_dry_run_reports_the_weighted_loss(self):
        buf = io.StringIO()
        argv = ["train.py", "--train", self.data, "--model", self.model_dir, "--tokenizer", self.model_dir, "--data-format", "datagen",
                "--max-len", "128", "--dry-run", "3"]
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(buf):
            self.train.main()
        self.assertIn("DRY-RUN datagen: 3 records", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
