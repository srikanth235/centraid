"""Tests for batching.py: the queue logic with a fake backend (no torch), the stratified sample, and
greedy equality of the batched HF path with the serial HFBackend on a tiny random Qwen3.5 (float64,
CPU, the real tokenizer and the runtime's exported grammar; skipped when those are not around).

    python -m unittest train/test_batching.py     (HF_HUB_OFFLINE=1)
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import batching  # noqa: E402
from batching import Batcher, stratified_sample  # noqa: E402


def fan(b, items, gap=0.0):
    """Submit every item from its own thread; results in item order."""
    out, errs = [None] * len(items), [None] * len(items)

    def go(i):
        try:
            out[i] = b.submit(items[i])
        except BaseException as e:  # noqa: BLE001
            errs[i] = e
    ts = [threading.Thread(target=go, args=(i,)) for i in range(len(items))]
    for t in ts:
        t.start()
        time.sleep(gap)
    for t in ts:
        t.join(10)
    return out, errs


class FakeBackend:
    """Records the batches it is given; result = (item * 10, batch size)."""

    def __init__(self, delay=0.0):
        self.batches, self.delay = [], delay

    def __call__(self, items):
        self.batches.append(list(items))
        time.sleep(self.delay)
        return [(x * 10, len(items)) for x in items]


class BatcherTest(unittest.TestCase):
    def test_results_go_to_their_callers(self):
        fb = FakeBackend()
        b = Batcher(fb, max_batch=8, max_wait=0.05)
        out, errs = fan(b, list(range(20)))
        b.close()
        self.assertEqual([e for e in errs if e], [])
        self.assertEqual([r[0] for r in out], [i * 10 for i in range(20)])
        self.assertEqual(sorted(x for bt in fb.batches for x in bt), list(range(20)))
        self.assertTrue(all(len(bt) <= 8 for bt in fb.batches))

    def test_waits_for_the_batch_to_fill(self):
        fb = FakeBackend()
        b = Batcher(fb, max_batch=4, max_wait=1.0)
        b.active = 4  # 4 clients: the batch starts when the 4th has queued, not after max_wait
        t = time.time()
        out, _ = fan(b, [1, 2, 3, 4], gap=0.02)
        took = time.time() - t
        b.close()
        self.assertEqual([r[1] for r in out], [4, 4, 4, 4])
        self.assertLess(took, 0.5)

    def test_max_wait_ends_the_wait(self):
        fb = FakeBackend()
        b = Batcher(fb, max_batch=8, max_wait=0.1)
        b.active = 8  # 7 clients never show up
        t = time.time()
        out, _ = fan(b, [1, 2, 3])
        took = time.time() - t
        b.close()
        self.assertEqual([r[1] for r in out], [3, 3, 3])
        self.assertGreaterEqual(took, 0.09)
        self.assertLess(took, 1.0)

    def test_leave_lowers_the_target(self):
        fb = FakeBackend()
        b = Batcher(fb, max_batch=8, max_wait=5.0)
        for _ in range(3):
            b.enter()
        res = []
        th = threading.Thread(target=lambda: res.append(fan(b, [1, 2])[0]))
        th.start()
        time.sleep(0.2)
        b.leave()  # the third client is gone: 2 queued = active
        th.join(3)
        b.close()
        self.assertEqual([r[1] for r in res[0]], [2, 2])

    def test_arrivals_during_a_batch_form_the_next(self):
        fb = FakeBackend(delay=0.3)
        b = Batcher(fb, max_batch=8, max_wait=0.02)
        out, _ = fan(b, list(range(6)), gap=0.1)  # one starts a batch alone, the rest pile up behind it
        b.close()
        self.assertEqual(sum(len(bt) for bt in fb.batches), 6)
        self.assertLess(len(fb.batches), 6)
        self.assertEqual([r[0] for r in out], [i * 10 for i in range(6)])

    def test_fifo_and_max_batch(self):
        fb = FakeBackend(delay=0.2)
        b = Batcher(fb, max_batch=2, max_wait=0.0)
        out, _ = fan(b, list(range(7)), gap=0.02)
        b.close()
        flat = [x for bt in fb.batches for x in bt]
        self.assertEqual(flat, sorted(flat))  # arrival order kept across batches
        self.assertTrue(all(len(bt) <= 2 for bt in fb.batches))
        self.assertEqual(len(out), 7)

    def test_cost_budget_splits_a_batch(self):
        fb = FakeBackend(delay=0.05)
        b = Batcher(fb, max_batch=8, max_wait=0.3, cost=lambda x: x, max_cost=100)
        b.active = 4
        out, _ = fan(b, [60, 30, 30, 90], gap=0.01)  # (n+1) * widest must stay <= 100
        b.close()
        for bt in fb.batches:
            self.assertTrue(len(bt) == 1 or len(bt) * max(bt) <= 100, bt)
        self.assertEqual(sorted(x for bt in fb.batches for x in bt), [30, 30, 60, 90])
        self.assertEqual([r[0] for r in out], [600, 300, 300, 900])

    def test_oversized_item_runs_alone(self):
        fb = FakeBackend()
        b = Batcher(fb, max_batch=8, max_wait=0.05, cost=lambda x: x, max_cost=10)
        out, _ = fan(b, [500])
        b.close()
        self.assertEqual(out[0], (5000, 1))

    def test_batch_failure_reaches_every_caller_and_the_worker_lives(self):
        calls = []

        def run(items):
            calls.append(items)
            if any(x < 0 for x in items):
                raise ValueError("boom")
            return [x for x in items]
        b = Batcher(run, max_batch=4, max_wait=0.05)
        out, errs = fan(b, [-1, 1])
        self.assertTrue(all(isinstance(e, ValueError) for e in errs), errs)
        self.assertEqual(b.submit(7), 7)  # still serving
        b.close()

    def test_item_error_fails_only_that_caller(self):
        def run(items):
            return [ValueError("bad") if x == 2 else x for x in items]
        b = Batcher(run, max_batch=4, max_wait=0.05)
        b.active = 3
        out, errs = fan(b, [1, 2, 3])
        b.close()
        self.assertIsInstance(errs[1], ValueError)
        self.assertEqual((out[0], out[2], errs[0], errs[2]), (1, 3, None, None))

    def test_closed_refuses(self):
        b = Batcher(lambda items: items, max_wait=0.0)
        b.close()
        with self.assertRaises(RuntimeError):
            b.submit(1)


class SampleTest(unittest.TestCase):
    def rows(self):
        return [{"id": "s-%s-%s-%02d" % (w, t, i), "world": w, "tags": [t]}
                for w in "AD" for t in ("calendar", "task", "decline") for i in range(10)]

    def test_fixed_and_stratified(self):
        rows = self.rows()
        a, b = stratified_sample(rows, 12), stratified_sample(list(reversed(rows)), 12)
        self.assertEqual(len(a), 12)
        self.assertEqual({r["id"] for r in a}, {r["id"] for r in b})  # independent of input order
        self.assertEqual(len({(r["world"], r["tags"][0]) for r in a}), 6)  # every stratum represented
        self.assertEqual([r["id"] for r in a], [r["id"] for r in rows if r["id"] in {x["id"] for x in a}])

    def test_bounds(self):
        rows = self.rows()
        self.assertEqual(len(stratified_sample(rows, 0)), len(rows))
        self.assertEqual(len(stratified_sample(rows, 999)), len(rows))
        self.assertEqual(len(stratified_sample(rows, 4)), 4)


# ---- HF equality on a tiny random model

def _build_tiny(d: str):
    import torch
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer
    cfg = AutoConfig.from_pretrained("Qwen/Qwen3.5-0.8B").text_config
    for k, v in dict(hidden_size=64, intermediate_size=128, num_hidden_layers=4,
                     layer_types=["linear_attention"] * 3 + ["full_attention"], num_attention_heads=4,
                     num_key_value_heads=2, head_dim=32, linear_key_head_dim=16, linear_value_head_dim=16,
                     linear_num_key_heads=2, linear_num_value_heads=4, mtp_num_hidden_layers=0,
                     initializer_range=0.5).items():  # a wide init: peaked logits, no numerical ties
        setattr(cfg, k, v)
    torch.manual_seed(0)
    AutoModelForCausalLM.from_config(cfg, dtype=torch.float32).save_pretrained(d)
    AutoTokenizer.from_pretrained("Qwen/Qwen3.5-0.8B").save_pretrained(d)


PROMPTS = [
    "<|im_start|>system\nVault. rows #1 #2 #3 #4 #5<|im_end|>\n<|im_start|>user\nwhat is due today<|im_end|>\n<|im_start|>assistant\n<think>\n",
    "<|im_start|>system\nVault. rows #7 #8<|im_end|>\n<|im_start|>user\nmove the dentist to friday and tell me what else "
    "is on that day, then remind me about the thing with Sam next week<|im_end|>\n<|im_start|>assistant\n<think>\n",
    "<|im_start|>system\nVault.<|im_end|>\n<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n<think>\n",
    "<|im_start|>system\nVault. rows #1 #2<|im_end|>\n<|im_start|>user\nwho is #2<|im_end|>\n<|im_start|>assistant\n"
    "<think>\nlook<|im_end|>\n<|im_start|>user\n<tool_response>\n#1 a\n@1\n</tool_response><|im_end|>\n<|im_start|>assistant\n<think>\n",
]


class HFEqualityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        try:
            import torch  # noqa: F401
            import hf_backend
            cls.lark = hf_backend.export_lark()
            cls.tmp = tempfile.TemporaryDirectory()
            _build_tiny(cls.tmp.name)
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no tiny model / tokenizer / nativetools: %r" % (e,))
        cls.hf_backend = hf_backend

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def backend(self, decoding, **kw):
        return self.hf_backend.HFBackend(self.tmp.name, self.lark, decoding=decoding, device="cpu",
                                         dtype="float64", think_limit=6, max_new_tokens=40, **kw)

    def check(self, decoding, limits):
        hf = self.backend(decoding)
        serial = []
        for p, k in zip(PROMPTS, limits):
            hf.dec.max_new_tokens = k
            serial.append((hf.complete(p), dict(hf.last_info)))
        hf.dec.max_new_tokens = 40
        bb = batching.BatchedBackend(hf, max_batch=8, max_wait=2.0, max_tokens=10**9)
        res = [None] * len(PROMPTS)

        def go(i):
            bb.enter()
            try:
                res[i] = bb.complete_info(PROMPTS[i], limits[i])
            finally:
                bb.leave()
        for _ in PROMPTS:
            bb.batcher.enter()  # all four are queued before the first batch starts
        ts = [threading.Thread(target=go, args=(i,)) for i in range(len(PROMPTS))]
        for t in ts:
            t.start()
        for _ in PROMPTS:
            bb.batcher.leave()
        for t in ts:
            t.join(120)
        bb.close()
        self.assertEqual(bb.batcher.sizes, [len(PROMPTS)], "one padded batch")
        for i, ((st, si), (bt, bi)) in enumerate(zip(serial, res)):
            self.assertEqual(bt, st, "prompt %d (%s) text" % (i, decoding))
            for k in ("think_cut", "override", "grammar_error", "prompt_tokens", "new_tokens", "think_tokens", "stopped"):
                self.assertEqual(bi[k], si[k], "prompt %d (%s) info %s" % (i, decoding, k))
        widths = {bi["padded"] for _, bi in res}
        self.assertEqual(len(widths), 1)
        self.assertGreater(max(bi["prompt_tokens"] for _, bi in res), min(bi["prompt_tokens"] for _, bi in res))
        return serial

    def test_left_padding_leaves_the_last_logits_alone(self):
        """The tiny model's greedy text hardly depends on the prompt, so also compare the logits
        (which do): a left-padded row of a batch against the same prompt alone."""
        import torch
        hf = self.backend("free")
        ids = [hf.tok(p, add_special_tokens=False)["input_ids"] for p in PROMPTS]
        width = max(map(len, ids))
        x = torch.full((len(ids), width), hf.dec.im_end)
        m = torch.zeros((len(ids), width), dtype=torch.long)
        for i, r in enumerate(ids):
            x[i, width - len(r):], m[i, width - len(r):] = torch.tensor(r), 1
        with torch.no_grad():
            both = hf.model(input_ids=x, attention_mask=m).logits[:, -1]
            for i, r in enumerate(ids):
                one = hf.model(input_ids=torch.tensor([r])).logits[0, -1]
                # not bit-equal: the gated-delta layers compute in float32 whatever the model dtype
                # (noise of 1e-7..2e-4 on logits of scale 18, unrelated to the pad width)
                self.assertLess((both[i] - one).abs().max().item(), 1e-3, "row %d" % i)
                self.assertEqual(int(both[i].argmax()), int(one.argmax()), "row %d" % i)
        self.assertGreater((both[0] - both[1]).abs().max().item(), 0.1)  # the prompts do matter

    def test_resample_excluding_a_call(self):
        """The loop breaker's draw (`sample=True, exclude=[call]`): a sampled row batched with a
        greedy one; every draw is a whole message and the redraw loop ends."""
        hf = self.backend("hard")
        greedy = hf.complete(PROMPTS[0])
        bb = batching.BatchedBackend(hf, max_batch=4, max_wait=0.05, max_tokens=10**9)
        res = {}
        ts = [threading.Thread(target=lambda: res.update(g=bb.complete_info(PROMPTS[0]))),
              threading.Thread(target=lambda: res.update(s=bb.complete_info(PROMPTS[0], sample=True, exclude=[greedy], tries=3)))]
        for t in ts:
            t.start()
        for t in ts:
            t.join(120)
        bb.close()
        self.assertEqual(res["g"][0], greedy)
        self.assertTrue(res["s"][0].startswith("<think>\n"))
        self.assertEqual(res["s"][1]["mode"], "hard")  # the same info a serial draw carries

    def test_hard_greedy(self):
        s = self.check("hard", [40, 40, 40, 40])
        self.assertTrue(any(i["think_cut"] for _, i in s), "the think guard fires in this case")

    def test_free_greedy_with_per_request_limits(self):
        s = self.check("free", [7, 40, 13, 40])
        self.assertEqual([i["new_tokens"] for _, i in s][0], 7)
        self.assertFalse(s[0][1]["stopped"])

    def test_soft_greedy(self):
        self.check("soft", [40, 25, 40, 40])


if __name__ == "__main__":
    unittest.main()
