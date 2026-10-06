"""Tests for train.py's minimal pairs: `--pair-batches` (default) keeps the records of a pair adjacent and inside one optimizer step.

    HF_HUB_OFFLINE=1 python -m unittest train/test_pairs.py

EpochOrder is the order itself (`pair_of`, `pair_units`, `pack_units`, `epoch_order`, `split_steps`, `pair_stats`): text and lists only.
PairBatches drives train.main() on the tiny CPU model (the harness of test_resume.py) with a train file whose records carry a pair id,
as the `pair` field or as a `pair:<id>` tag, and reads the order the loop trained in off the loss calls.
"""
from __future__ import annotations

import collections
import importlib.util
import json
import os
import random
import signal
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fmt  # noqa: E402
import test_resume as tr  # noqa: E402
from test_decision import FULL, THINK, session  # noqa: E402


def load_train():
    spec = importlib.util.spec_from_file_location("train_script", HERE / "train.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def pairs_of(n_pairs, n_single, group=2, seed=0):
    """A shuffled list of pair ids: `n_pairs` groups of `group` records sharing an id, and `n_single` records with none ('')."""
    recs = []
    for i in range(n_pairs):
        recs += ["P%d" % i] * group
    recs += [""] * n_single
    random.Random(seed).shuffle(recs)
    return recs


class EpochOrder(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.train = load_train()
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no torch: %r" % (e,))

    def check_whole(self, order, recs, bs):
        """Every record once; the records of a pair next to each other and inside one step of `bs`."""
        self.assertEqual(sorted(order), list(range(len(recs))))
        where = collections.defaultdict(list)
        for pos, i in enumerate(order):
            if recs[i]:
                where[recs[i]].append(pos)
        steps = len(recs) // bs
        for pid, ps in where.items():
            if ps[0] // bs >= steps:  # left out with the partial last step: it is dropped as a unit
                continue
            self.assertEqual(ps, list(range(ps[0], ps[0] + len(ps))), (pid, ps))
            self.assertEqual(len({p // bs for p in ps}), 1, (pid, ps, bs))
        self.assertEqual(self.train.split_steps(order, recs, bs, steps), 0)

    # ---- the pair id ------------------------------------------------------------------------------------

    def test_the_pair_id_is_the_field_or_a_tag(self):
        pair_of = self.train.pair_of
        self.assertEqual(pair_of({"pair": "p1"}), "p1")
        self.assertEqual(pair_of({"pair": 7}), "7")
        self.assertEqual(pair_of({"tags": ["val", "pair:p2", "x"]}), "p2")
        self.assertEqual(pair_of({"tags": "val pair:p3"}), "p3")
        self.assertEqual(pair_of({"pair": "p1", "tags": ["pair:p2"]}), "p1")  # the field wins
        for none in ({}, {"pair": ""}, {"pair": "  "}, {"pair": True}, {"pair": None}, {"tags": []}, {"tags": ["pair:"]},
                     {"tags": ["pairs:x", "xpair:y"]}, {"tags": None}):
            self.assertEqual(pair_of(none), "", none)

    def test_an_example_is_a_plain_triple_that_remembers_its_pair(self):
        import copy
        ex = self.train.Example([1, 2], [-100, 2], [0, 1], "p7")
        ids, labels, dec = ex  # every reader unpacks it as the triple of before
        self.assertEqual((ids, labels, dec, len(ex), ex.pair), ([1, 2], [-100, 2], [0, 1], 3, "p7"))
        self.assertEqual(ex, ([1, 2], [-100, 2], [0, 1]))
        self.assertEqual(self.train.Example([1], [2], [3]).pair, "")
        for dup in (copy.copy(ex), copy.deepcopy(ex)):
            self.assertEqual((tuple(dup), dup.pair), (tuple(ex), "p7"))

    # ---- pairs in one step ------------------------------------------------------------------------------

    def test_pairs_are_adjacent_and_never_split_across_a_step(self):
        n_cases = 0
        for bs in (2, 4, 8, 16):
            for n_pairs, n_single in ((0, 20), (1, 0), (3, 1), (10, 0), (10, 7), (33, 17), (100, 3)):
                for seed, epoch in ((0, 0), (1, 0), (2, 3)):
                    recs = pairs_of(n_pairs, n_single, seed=seed)
                    if len(recs) < bs:
                        continue
                    self.check_whole(self.train.epoch_order(len(recs), seed, epoch, recs, bs), recs, bs)
                    n_cases += 1
        self.assertGreater(n_cases, 60)

    def test_the_pairs_are_shuffled_as_units_and_the_singles_alone(self):
        recs = pairs_of(30, 40, seed=3)
        order = self.train.epoch_order(len(recs), 5, 0, recs, 16)
        ids = [recs[i] for i in order]
        self.assertNotEqual(order, sorted(order))
        firsts = [ids.index("P%d" % k) for k in range(30)]
        self.assertNotEqual(firsts, sorted(firsts))  # the pairs are not in file order
        self.assertLess(ids.index(""), max(firsts))  # singles and pairs are mixed, not sorted apart
        later = self.train.epoch_order(len(recs), 5, 1, recs, 16)
        self.assertNotEqual(order, later)  # a fresh shuffle each epoch
        self.assertNotEqual(order, self.train.epoch_order(len(recs), 6, 0, recs, 16))

    def test_the_order_is_a_function_of_seed_epoch_pairs_and_step_size(self):
        recs = pairs_of(12, 9, seed=1)
        a = self.train.epoch_order(len(recs), 3, 2, recs, 8)
        self.assertEqual(a, self.train.epoch_order(len(recs), 3, 2, list(recs), 8))  # a resume recomputes it
        self.assertNotEqual(a, self.train.epoch_order(len(recs), 3, 2, recs, 4))

    def test_the_last_partial_step_is_dropped_as_before(self):
        recs = pairs_of(11, 4, seed=2)  # 26 records, 3 steps of 8, 2 records left over
        order = self.train.epoch_order(len(recs), 1, 0, recs, 8)
        self.assertEqual(len(order), 26)
        self.check_whole(order, recs, 8)
        taken = order[:24]
        left = order[24:]
        self.assertEqual(len(left), 2)
        self.assertEqual(sorted(taken + left), list(range(26)))

    def test_a_single_trades_places_with_a_pair_and_a_pair_splits_only_as_a_last_resort(self):
        pack = self.train.pack_units
        # a single, then pairs, step of 4: the single is traded out so that the step holds two whole pairs
        order, split = pack([[0], [1, 2], [3, 4]], 4, 1)
        self.assertEqual((order[:4], split), ([1, 2, 3, 4], 0))
        self.assertEqual(order[4:], [0])
        # a later single fills a gap of one
        order, split = pack([[0, 1], [2], [3, 4], [5]], 3, 2)
        self.assertEqual((order, split), ([0, 1, 2, 3, 4, 5], 0))
        # nothing fits a gap of one and no single is held: the first waiting unit is split between the steps
        order, split = pack([[0, 1], [2, 3]], 3, 1)
        self.assertEqual((order[:3], split), ([0, 1, 2], 1))
        self.assertEqual(self.train.split_steps(order, ["a", "a", "b", "b"], 3, 1), 1)  # its partner is left out of the epoch

    def test_an_odd_step_size_cannot_keep_every_pair_whole_and_the_count_says_so(self):
        recs = ["P%d" % (i // 2) for i in range(12)]
        order = self.train.epoch_order(len(recs), 0, 0, recs, 3)
        self.assertEqual(sorted(order), list(range(12)))
        self.assertGreater(self.train.split_steps(order, recs, 3, 4), 0)

    def test_a_group_larger_than_a_step_is_cut_into_steps(self):
        self.assertEqual(self.train.pair_units(["g"] * 5, 4), [[0, 1, 2, 3], [4]])
        self.assertEqual(self.train.pair_units(["a", "", "a", "b", "b", ""], 4), [[0, 2], [1], [3, 4], [5]])  # a unit at its first member
        recs = pairs_of(6, 5, group=3, seed=4)  # triples in steps of 6: whole, though not pairs
        order = self.train.epoch_order(len(recs), 0, 0, recs, 6)
        self.assertEqual(sorted(order), list(range(len(recs))))

    def test_triples_that_cannot_fit_are_reported_not_hidden(self):
        recs = pairs_of(5, 0, group=3, seed=0)  # 15 records: steps of 4 hold one triple and one stray
        order = self.train.epoch_order(len(recs), 0, 0, recs, 4)
        self.assertGreater(self.train.split_steps(order, recs, 4, len(recs) // 4), 0)

    def test_split_steps_and_pair_stats(self):
        ss = self.train.split_steps
        self.assertEqual(ss([0, 1, 2, 3], ["a", "a", "b", "b"], 2, 2), 0)
        self.assertEqual(ss([0, 2, 1, 3], ["a", "a", "b", "b"], 2, 2), 2)       # both steps hold half a pair
        self.assertEqual(ss([0, 1, 2, 3], ["a", "", "b", "b"], 2, 2), 0)        # a record whose partner is gone is not a split
        self.assertEqual(ss([0, 1, 2, 3], ["a", "a", "b", "b"], 2, 1), 0)       # a pair left out whole is not a split
        self.assertEqual(ss([0, 1, 2, 3], ["a", "b", "a", "b"], 2, 2), 2)
        self.assertEqual(self.train.pair_stats(["a", "a", "", "b", "c", "c", "c"]), (2, 5, 1))
        self.assertEqual(self.train.pair_stats([]), (0, 0, 0))

    def test_a_record_whose_partner_is_gone_is_a_single(self):
        # its partner was dropped as too long, unrenderable, or cut by --n: the id is on one record only
        recs = pairs_of(12, 3, seed=6) + ["P99"]
        random.Random(1).shuffle(recs)
        self.assertEqual(self.train.pair_stats(recs), (12, 24, 1))
        for bs in (4, 8):
            order = self.train.epoch_order(len(recs), 2, 0, recs, bs)
            self.check_whole(order, recs, bs)  # the orphan is no pair: it fills a gap, or sits out the partial step
        self.assertEqual(self.train.pair_units(["a", "b", "a", "z"], 4), [[0, 2], [1], [3]])

    # ---- without pairs, and with the flag off: the plain shuffle of before ---------------------------------

    def plain(self, n, seed, epoch):
        idx = list(range(n))
        random.Random(seed + epoch).shuffle(idx)
        return idx

    def test_without_pairs_or_without_the_flag_it_is_the_plain_shuffle(self):
        order = self.train.epoch_order
        for n, seed, epoch in ((20, 3, 0), (100, 0, 0), (100, 7, 4)):
            want = self.plain(n, seed, epoch)
            self.assertEqual(order(n, seed, epoch), want)                                    # no pairs argument: the old call
            self.assertEqual(order(n, seed, epoch, None, 16), want)                          # --no-pair-batches
            self.assertEqual(order(n, seed, epoch, [""] * n, 16), want)                      # no record has an id
            self.assertEqual(order(n, seed, epoch, ["r%d" % i for i in range(n)], 16), want)  # every id is on one record only
            self.assertEqual(order(n, seed, epoch, pairs_of(n // 2, 0), 1), want)             # a step of one sequence has no pair to keep
        x = list(range(100))
        random.Random(0).shuffle(x)
        self.assertEqual(order(100, 0, 0, [""] * 100, 16), x)  # epoch 0 is the old single-epoch order
        # with pair ids the flag off is the plain shuffle too, whatever the data holds
        recs = pairs_of(20, 10)
        self.assertEqual(order(len(recs), 3, 0, None, 8), self.plain(len(recs), 3, 0))
        self.assertNotEqual(order(len(recs), 3, 0, recs, 8), self.plain(len(recs), 3, 0))

    def test_a_large_epoch_is_ordered_in_moments(self):
        recs = pairs_of(24000, 12000, seed=5)  # 60000 records
        t0 = time.time()
        order = self.train.epoch_order(len(recs), 0, 0, recs, 16)
        self.assertLess(time.time() - t0, 20.0)
        self.assertEqual(sorted(order), list(range(len(recs))))
        self.assertEqual(self.train.split_steps(order, recs, 16, len(recs) // 16), 0)


def write_paired(path, n_pairs, with_tags=True):
    """A train file of `n_pairs` minimal pairs (2 records each, same message, other rows): the pair id is the `pair` field, and for
    every odd pair a `pair:<id>` tag. The message says `move it`, the quoted phrase of the think, so the records carry copy tokens."""
    with open(path, "w") as f:
        for k in range(n_pairs):
            for j in (0, 1):
                ex = session(FULL if j else THINK, THINK if k % 3 else FULL)
                ex["messages"][1]["content"] = "please move it %d hours and the %d th gym class" % (k, k * 7)
                ex["messages"][2]["args"] = dict(ex["messages"][2]["args"], rows="#%d" % (2 * k + j + 1))
                if with_tags and k % 2:
                    ex["tags"] = ["x", "pair:p%d" % k]
                else:
                    ex["pair"] = "p%d" % k
                f.write(json.dumps(ex) + "\n")


_tiny_setup = tr.ResumeTest.__dict__["setUpClass"].__func__


class PairBatches(unittest.TestCase):
    """train.main() with minimal pairs in the data (the tiny model of test_resume)."""

    # borrow the tiny-model harness of test_resume without re-collecting its tests
    tearDownClass = classmethod(tr.ResumeTest.__dict__["tearDownClass"].__func__)
    run_once = classmethod(tr.ResumeTest.__dict__["run_once"].__func__)
    losses = staticmethod(tr.ResumeTest.__dict__["losses"].__func__)
    out = tr.ResumeTest.out
    same_params = tr.ResumeTest.same_params

    @classmethod
    def setUpClass(cls):
        _tiny_setup(cls)
        cls.paired = os.path.join(cls.tmp, "paired.jsonl")  # 6 pairs: 12 records
        write_paired(cls.paired, 6)
        cls.paired16 = os.path.join(cls.tmp, "paired16.jsonl")  # 8 pairs: 16 records
        write_paired(cls.paired16, 8)

    def recorded(self, out, *flags, hook=None):
        """run_once, plus the ids of every sequence the loop trained on in order, and the (decision, copy) weights it trained with."""
        seen, weights = [], set()
        real = self.train.forward_loss

        def rec(*a, **k):
            seen.append(tuple(a[1]))
            weights.add((a[5], a[6]))
            return real(*a, **k)

        with mock.patch.object(self.train, "forward_loss", rec):
            r = self.run_once(out, *flags, hook=hook)
        return r, seen, weights

    def records(self, path):
        """{input ids of a record: (its index in the file, its pair id)}, as train.load reads the file."""
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(self.model_dir)
        data = self.train.load(tok, path, 1024, 0, None, 0, "t", fmt.DecisionConfig())
        return {tuple(d[0]): (i, d.pair) for i, d in enumerate(data)}

    def test_pairs_share_one_step_and_the_log_counts_them(self):
        r, seen, weights = self.recorded(self.out(), "--train", self.paired, "--bs", "4")
        info = self.records(self.paired)
        self.assertEqual(len(seen), 12)
        self.assertEqual(len(info), 12)
        got = [info[ids][1] for ids in seen]
        self.assertEqual(sorted(set(got)), ["p%d" % k for k in range(6)])  # both id forms were read: the field and the tag
        for k in range(0, 12, 4):  # every step of 4 holds two whole pairs
            self.assertEqual(sorted(collections.Counter(got[k:k + 4]).values()), [2, 2], got[k:k + 4])
        for k in range(0, 12, 2):  # and the two of a pair are next to each other
            self.assertEqual(got[k], got[k + 1])
        self.assertIn("PAIRS: 6 pairs (12 of 12 records), 0 records whose partner is gone; pair batching on; "
                      "epoch 0: 0 of 3 steps hold a split pair\n", r["log"])
        self.assertNotIn("must be 0", r["log"])
        self.assertEqual(weights, {(2.0, 0.0)})  # the defaults reach the loss: decision weight 2, copy weight 0
        self.assertEqual(r["meta"]["args"]["pair_batches"], True)
        self.assertIn("12 with a pair id", r["log"])
        order = [info[ids][0] for ids in seen]
        self.assertNotEqual(order, self.train.epoch_order(12, 3, 0))  # not the plain shuffle of the file

    def test_the_flag_restores_the_plain_shuffle(self):
        r, seen, weights = self.recorded(self.out(), "--train", self.paired, "--bs", "4", "--no-pair-batches")
        info = self.records(self.paired)
        order = [info[ids][0] for ids in seen]
        self.assertEqual(order, self.train.epoch_order(12, 3, 0))  # --seed 3 of the harness: random.Random(3).shuffle
        self.assertIn("pair batching off (--no-pair-batches)", r["log"])
        self.assertIn("6 pairs (12 of 12 records)", r["log"])  # the data is still counted

    def test_unpaired_data_trains_the_same_with_or_without_the_flag(self):
        r = self.run_once(self.out(), "--no-pair-batches")
        self.same_params(self.ref["model"], r["model"])
        self.assertEqual(r["steps"], self.ref["steps"])
        self.assertEqual(r["meta"]["val"], self.ref["meta"]["val"])
        self.assertIn("0 pairs (0 of 12 records), 0 records whose partner is gone; pair batching off", r["log"])
        self.assertIn("0 pairs (0 of 12 records), 0 records whose partner is gone; pair batching on", self.ref["log"])

    def test_resume_with_pairs_is_bit_identical_inside_the_second_epoch(self):
        flags = ["--train", self.paired16, "--bs", "4", "--epochs", "2"]  # 4 steps an epoch, 8 in all
        ref = self.run_once(self.out(), *flags)
        self.assertEqual(sorted(ref["steps"]), [2, 4, 6, 8])
        self.assertIn("EPOCH 1: 0 of 4 steps hold a split pair", ref["log"])
        out = self.out()
        first = self.run_once(out, *flags, "--resume", "--save-every", "100",
                              hook=lambda n: os.kill(os.getpid(), signal.SIGTERM) if n == 6 * 4 else None)
        self.assertIn("PREEMPTED at step 6/8", first["log"])
        second = self.run_once(out, *flags, "--resume", "--save-every", "100")
        self.assertIn("step 6/8 (epoch 1, example 8 of 16)", second["log"])
        self.assertIn("EPOCH 1: 0 of 4 steps hold a split pair", second["log"])  # the order of the epoch was recomputed
        self.same_params(ref["model"], second["model"])
        self.assertEqual({**first["steps"], **second["steps"]}, ref["steps"])
        self.assertEqual(second["meta"]["val"], ref["meta"]["val"])

    def test_a_resume_refuses_to_switch_the_order_mid_run(self):
        out = self.out()
        flags = ["--train", self.paired, "--bs", "4"]
        self.run_once(out, *flags, "--resume", "--save-every", "100",
                      hook=lambda n: os.kill(os.getpid(), signal.SIGTERM) if n == 2 * 4 else None)
        with self.assertRaises(SystemExit) as cm:
            self.run_once(out, *flags, "--no-pair-batches", "--resume", "--save-every", "100")
        self.assertIn("different run", str(cm.exception))
        self.assertIn("pair_batches", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
