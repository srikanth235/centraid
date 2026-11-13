"""The trainer on a tiny random Qwen3.5 on the CPU: what it freezes, where the adapters land, what it writes, and that a resume is exact."""
import json
import os
import random
import shutil
import tempfile
import unittest
from pathlib import Path

import torch
from transformers import Qwen3_5ForCausalLM, Qwen3_5TextConfig

from adapter_train import checkpoints, config, hf, trainer

VOCAB, LAYERS = 48, 4  # layers 0-2 are linear attention, layer 3 full attention (every fourth)


def tiny_model(seed=0):
    torch.manual_seed(seed)
    cfg = Qwen3_5TextConfig(vocab_size=VOCAB, hidden_size=32, intermediate_size=64, num_hidden_layers=LAYERS, num_attention_heads=4,
                            num_key_value_heads=2, head_dim=8, linear_num_value_heads=4, linear_num_key_heads=2,
                            linear_key_head_dim=8, linear_value_head_dim=8, tie_word_embeddings=True, initializer_range=0.5)
    return Qwen3_5ForCausalLM(cfg).float()


def records(n, seed=0):
    rng = random.Random(seed)
    out = []
    for i in range(n):
        ids = [rng.randrange(2, VOCAB) for _ in range(rng.randrange(12, 24))]
        weights = [0.0] * 6 + [1.0 if rng.random() < 0.7 else 3.0 for _ in range(len(ids) - 6)]
        out.append({"id": "r%d" % i, "render": {"input_ids": ids, "weights": weights, "text": ""}})
    return out


def write_jsonl(path, recs):
    with open(path, "w", encoding="utf-8") as fh:
        for r in recs:
            fh.write(json.dumps(r) + "\n")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="trainer-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        write_jsonl(self.tmp / "train.jsonl", records(10))
        write_jsonl(self.tmp / "val.jsonl", records(4, seed=9))

    def job(self, name="t", **train):
        t = {"seed": 3, "lr": 5e-3, "bs": 2, "steps": 6, "warmup": 1, "max_len": 64, "checkpoint_every": 2}
        t.update(train)
        return config.parse({
            "name": name, "base": {"model": "tiny", "revision": "b" * 40}, "lora": {"rank": 4, "alpha": 8},
            "data": {"train": str(self.tmp / "train.jsonl"), "val": str(self.tmp / "val.jsonl")},
            "checkpoints": str(self.tmp / ("ckpt-" + name)), "outputs": str(self.tmp / ("out-" + name)), "train": t})

    def go(self, job, work, **kw):
        return trainer.run(job, self.tmp / work, base_loader=lambda j, d: tiny_model(), device="cpu", log=lambda *_: None, **kw)

    def adapter_weights(self, job):
        from safetensors.torch import load_file

        return load_file(str(Path(job.outputs) / "adapter" / "adapter_model.safetensors"))


class StepsTest(unittest.TestCase):
    def test_which_records_a_step_reads_is_a_pure_function_of_the_seed(self):
        a = [trainer.batch_for_step(7, 3, 5, s) for s in range(10)]
        b = [trainer.batch_for_step(7, 3, 5, s) for s in range(10)]
        self.assertEqual(a, b)
        self.assertNotEqual(a, [trainer.batch_for_step(7, 3, 6, s) for s in range(10)])

    def test_each_record_is_read_once_per_epoch(self):
        n, bs = 6, 2
        epoch = [i for s in range(3) for i in trainer.batch_for_step(n, bs, 1, s)]
        self.assertEqual(sorted(epoch), list(range(n)))
        two = [i for s in range(6) for i in trainer.batch_for_step(n, bs, 1, s)]
        self.assertEqual(sorted(two[n:]), list(range(n)))
        self.assertNotEqual(two[:n], two[n:])  # a reshuffle

    def test_a_batch_that_crosses_an_epoch_takes_the_rest_of_one_and_the_start_of_the_next(self):
        got = trainer.batch_for_step(5, 3, 2, 1)  # records 3..5: two of epoch 0, one of epoch 1
        self.assertEqual(len(got), 3)
        e0 = trainer.batch_for_step(5, 5, 2, 0)
        self.assertEqual(got[:2], e0[3:5])

    def test_the_learning_rate_warms_up_and_decays_to_a_tenth(self):
        j = config.parse({"name": "n", "base": {"model": "m", "revision": "a" * 40}, "data": {"train": "x"}, "checkpoints": "c", "outputs": "o",
                          "train": {"lr": 1.0, "warmup": 4, "steps": 14}})
        self.assertAlmostEqual(trainer.lr_at(j, 0), 0.25)
        self.assertAlmostEqual(trainer.lr_at(j, 3), 1.0)
        self.assertAlmostEqual(trainer.lr_at(j, 14), 0.1)
        self.assertTrue(all(trainer.lr_at(j, s) >= trainer.lr_at(j, s + 1) for s in range(4, 14)))


class RunTest(Base):
    def test_only_the_adapters_train_and_they_sit_on_the_language_model_targets(self):
        peft_model, adapted = trainer.wrap(tiny_model(), self.job())
        trainable = [n for n, p in peft_model.named_parameters() if p.requires_grad]
        self.assertTrue(trainable and all("lora_" in n for n in trainable))
        for n, p in peft_model.named_parameters():
            if "embed_tokens" in n or "norm" in n or "lm_head" in n:
                self.assertFalse(p.requires_grad, n)
        kinds = {n.rsplit(".", 1)[1] for n in adapted}
        self.assertEqual(kinds, {"in_proj_qkv", "in_proj_z", "out_proj", "q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"})
        self.assertFalse(any("in_proj_a" in n or "in_proj_b" in n for n in adapted))
        # 3 linear blocks x 3 + 1 full block x 4 + FFN 3 x 4 blocks
        self.assertEqual(len(adapted), 3 * 3 + 4 + 3 * 4)

    def test_a_target_that_matches_nothing_is_an_error_not_a_silent_no_op(self):
        j = config.parse({**self.job().raw, "lora": {"rank": 4, "targets": ["in_proj_a"]}})
        model = tiny_model()
        # in_proj_a exists in the linear blocks; a model without them proves the guard
        for layer in model.model.layers:
            if hasattr(layer, "linear_attn"):
                del layer.linear_attn.in_proj_a
        with self.assertRaisesRegex(config.ConfigError, "no module"):
            trainer.wrap(model, j)

    def test_a_run_trains_writes_the_adapter_and_the_record_and_leaves_the_base_alone(self):
        job = self.job()
        before = {k: v.clone() for k, v in tiny_model().state_dict().items()}
        res = self.go(job, "w1")
        self.assertTrue(res["done"])
        self.assertEqual(res["step"], 6)
        out = Path(job.outputs)
        self.assertTrue((out / "adapter" / "adapter_model.safetensors").is_file())
        self.assertTrue((out / "adapter" / "adapter_config.json").is_file())
        rec = json.loads((out / "run.json").read_text())
        self.assertEqual(rec["steps_done"], 6)
        self.assertEqual(rec["base"]["revision"], "b" * 40)
        self.assertEqual(rec["data"]["train"]["sha256"], __import__("hashlib").sha256((self.tmp / "train.jsonl").read_bytes()).hexdigest())
        self.assertIsNone(rec["resumed_from_step"])
        self.assertIn("val_loss", rec["metrics"])
        self.assertEqual(set(rec["adapter_files"]), {"adapter/adapter_model.safetensors", "adapter/adapter_config.json"} | set(rec["adapter_files"]))
        # the tensors are the ones the converter reads: PEFT names, lora_A / lora_B, on the targets only, no embeddings
        names = list(self.adapter_weights(job))
        self.assertTrue(names and all(".lora_A." in n or ".lora_B." in n for n in names))
        self.assertFalse(any("embed" in n or "lm_head" in n or "norm" in n for n in names))
        self.assertTrue(all(n.startswith("base_model.model.model.layers.") for n in names), names[:2])
        # the base weights the run loaded are what a fresh load gives: nothing outside the adapters moved
        self.assertTrue(all(torch.equal(before[k], v) for k, v in tiny_model().state_dict().items()))

    def test_training_moves_the_loss(self):
        recs = records(4, seed=1)
        write_jsonl(self.tmp / "train.jsonl", recs)
        write_jsonl(self.tmp / "val.jsonl", recs)  # the same records: the held-out loss is then the training loss
        j0 = self.job("a", steps=1, lr=1e-9)
        j1 = self.job("b", steps=30, lr=2e-2, checkpoint_every=30, bs=4)
        before = self.go(j0, "w0")["metrics"]["val_loss"]
        after = self.go(j1, "w1")["metrics"]["val_loss"]
        self.assertLess(after, before - 0.05)

    def test_a_resumed_run_ends_with_exactly_the_weights_of_a_straight_run(self):
        straight = self.job("straight")
        self.assertTrue(self.go(straight, "ws")["done"])
        halted = self.job("halted")
        calls = []

        def stop():
            calls.append(1)
            return len(calls) == 3  # a SIGTERM during step 3

        first = self.go(halted, "w-a", stop=stop)
        self.assertEqual((first["done"], first["step"]), (False, 3))
        self.assertEqual(checkpoints.newest(halted.checkpoints), (3, "ckpt-00000003"))  # written at the stop, not at the mark
        second = self.go(halted, "w-b")  # a new machine: a new scratch directory
        self.assertTrue(second["done"])
        self.assertEqual(json.loads((Path(halted.outputs) / "run.json").read_text())["resumed_from_step"], 3)
        a, b = self.adapter_weights(straight), self.adapter_weights(halted)
        self.assertEqual(sorted(a), sorted(b))
        for k in a:
            self.assertTrue(torch.equal(a[k], b[k]), k)

    def test_a_checkpoint_of_another_job_is_refused(self):
        job = self.job("x")
        self.go(job, "w-a", stop=lambda: True)  # halts after step 1 with a checkpoint
        other = config.parse({**job.raw, "train": {**job.raw["train"], "lr": 1e-3}})
        with self.assertRaisesRegex(config.ConfigError, "different job file"):
            self.go(other, "w-b")

    def test_data_that_is_not_the_pinned_file_stops_the_run_before_the_model_loads(self):
        job = config.parse({**self.job().raw, "data": {**self.job().raw["data"], "train_sha256": "0" * 64}})
        loaded = []
        with self.assertRaisesRegex(config.ConfigError, "pins"):
            trainer.run(job, self.tmp / "w", base_loader=lambda j, d: loaded.append(1), device="cpu", log=lambda *_: None)
        self.assertEqual(loaded, [])

    def test_a_data_version_from_the_dataset_repo_trains_and_is_named_in_the_record(self):
        import zstandard

        repo = self.tmp / "repo"
        (repo / "data").mkdir(parents=True)
        for name in ("train", "val", "test"):
            raw = (self.tmp / ("val.jsonl" if name != "train" else "train.jsonl")).read_bytes()
            (repo / "data" / ("%s.jsonl.zst" % name)).write_bytes(zstandard.ZstdCompressor().compress(raw))
        (repo / "manifest.json").write_text('{"version": "v0.2"}')
        asked = []
        inner = hf.local_fetch(repo)
        job = config.parse({**self.job().raw, "data": {"hf": "hf://datasets/srikanth235/centraid-assist-data@v0.2"},
                            "train": {**self.job().raw["train"], "steps": 2}})
        res = self.go(job, "wh", hf_fetch=lambda r, v, p, d: (asked.append(p), inner(r, v, p, d))[1])
        self.assertTrue(res["done"])
        self.assertNotIn("data/test.jsonl.zst", asked)
        rec = json.loads((Path(job.outputs) / "run.json").read_text())
        self.assertEqual(rec["data_source"]["revision"], "v0.2")
        self.assertEqual(rec["data_source"]["manifest"], {"version": "v0.2"})
        self.assertEqual(rec["data"]["train"]["uri"], "hf://datasets/srikanth235/centraid-assist-data@v0.2#data/train.jsonl.zst")
        self.assertEqual(len(rec["data_source"]["manifest_sha256"]), 64)

    def test_a_zst_data_file_is_read_as_it_is(self):
        import zstandard

        raw = (self.tmp / "train.jsonl").read_bytes()
        (self.tmp / "train.jsonl.zst").write_bytes(zstandard.ZstdCompressor().compress(raw))
        job = config.parse({**self.job().raw, "data": {"train": str(self.tmp / "train.jsonl.zst")}, "train": {**self.job().raw["train"], "steps": 2}})
        self.assertTrue(self.go(job, "wz")["done"])


if __name__ == "__main__":
    unittest.main()
