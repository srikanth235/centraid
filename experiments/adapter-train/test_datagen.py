"""The datagen record reader: records are read as they are (no re-rendering), too-long ones are dropped and counted, and a record that breaks the
contract stops the run."""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from adapter_train import datagen

VOCAB = 64


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


if __name__ == "__main__":
    unittest.main()
