"""build_sets.py on synthetic sessions: the v8 check (val and test on disjoint worlds, test worlds not train worlds), the
fold of the v7 pair into val, the e2 sources as the test set, the whole `freeze-v8` run on a hand-made reference run (no
runtime), its dry run, the command line.

    python3 -m unittest test_build_sets -v      # from experiments/toolchat/native/eval

The sessions, worlds, ids and runs here are made up. The worlds A and B are the public train worlds T05 and T06 under those
names, seeded into a temporary directory (pubworld.py; copied again under the names Q and R, so gold keys resolve), and the
held-out files are not read: they are not in a public checkout (R-1088-16).
"""

from __future__ import annotations

import contextlib
import gzip
import hashlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import build_sets
import lib
import pubworld
import regen

pubworld.seed_public("T05", "A")
pubworld.seed_public("T06", "B")
REAL_WORLDS = pubworld.worlds_dir()
KEYS = {w: lib.load_keys(w) for w in ("A", "B")}


def task_keys(world: str) -> list[str]:
    """Keys of tasks of a real world (A or B), in the order of its keys file."""
    return [k for k, v in KEYS[world].items() if v["kind"] == "task"]


def turn(world: str = "A", n: int = 0, user: str = "what's on the list") -> dict:
    return {"user": user, "gold": [{"type": "rows", "rows": [task_keys(world)[n]]}],
            "ref": [{"tool": "answer", "args": {"kind": "task"}}], "tags": []}


def session(sid: str, world: str, set_: str, turns: int = 2, key_world: str | None = None) -> dict:
    kw = key_world or world
    return {"id": sid, "set": set_, "world": world, "today": "2026-10-14T08:40", "me": "Priya Raman", "tags": [],
            "turns": [turn(kw, n) for n in range(turns)]}


def plain(sid: str, world: str, set_: str, turns: int = 1) -> dict:
    """A session whose gold names no row (a decline): its world need not have the keys of any row."""
    return {"id": sid, "set": set_, "world": world, "today": "2026-10-14T08:40", "me": "Priya Raman", "tags": [],
            "turns": [{"user": "u", "gold": [{"type": "decline", "reasons": ["out_of_scope"]}],
                       "ref": [{"tool": "decline", "args": {"reason": "out_of_scope"}}], "tags": []}
                      for _ in range(turns)]}


def read(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").split("\n") if line]


def dumps(sessions: list[dict]) -> str:
    return "".join(json.dumps(s, ensure_ascii=False) + "\n" for s in sessions)


def write_sets(root: Path, val: list[dict], test: list[dict], assign: dict, **meta) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "val.jsonl").write_text(dumps(val), encoding="utf-8")
    (root / "test.jsonl").write_text(dumps(test), encoding="utf-8")
    (root / "split.json").write_text(json.dumps({"seed": 0, "strata": "world x min(len,5)", **meta, "assign": assign},
                                                indent=0), encoding="utf-8")
    return root


def quiet(fn, *args, **kwargs):
    """(result, stdout, stderr) of a call that prints."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        result = fn(*args, **kwargs)
    return result, out.getvalue(), err.getvalue()


class Base(unittest.TestCase):
    """A scratch directory with the worlds A, B, and copies of them under the names Q and R (the held-out worlds of a
    made-up e2), the pair of v7 (val: A-E001 A-E002... on A and B), and the patches that point build_sets at it."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="test_build_sets-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.worlds = self.tmp / "worlds"
        self.worlds.mkdir()
        for src, dst in (("A", "A"), ("B", "B"), ("A", "Q"), ("B", "R")):
            for suffix in (".json", ".keys.json"):
                shutil.copy(REAL_WORLDS / f"{src}{suffix}", self.worlds / f"{dst}{suffix}")
        self.sets = self.tmp / "sets"
        self.v7 = self.tmp / "v7"
        self.e2 = self.tmp / "e2"
        patches = [mock.patch.object(lib, "WORLDS", self.worlds), mock.patch.object(build_sets, "SETS", self.sets),
                   mock.patch.object(build_sets, "TRAIN", self.tmp / "train.jsonl.gz"),
                   mock.patch.object(build_sets.split, "train_worlds", lambda: ["T01", "T02"])]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        build_sets.keys_of.cache_clear()
        self.addCleanup(build_sets.keys_of.cache_clear)
        # the pair of v7: both halves on A and B
        self.v7_val = [session("A-E001", "A", "val"), session("B-E001", "B", "val")]
        self.v7_test = [session("A-E002", "A", "test"), session("B-E002", "B", "test", turns=3)]
        self.v7_assign = {"A-E001": {"set": "val", "origin": "e1"}, "B-E001": {"set": "val", "origin": "e1"},
                          "A-E002": {"set": "test", "origin": "e1"}, "B-E002": {"set": "test", "origin": "test-v3.1"}}
        write_sets(self.v7, self.v7_val, self.v7_test, self.v7_assign)

    def e2_source(self, world: str, ids: list[str], key_world: str, user: str = "what's on the list") -> None:
        self.e2.mkdir(exist_ok=True)
        body = ["from gold import *", "", f'world("{world}", "2026-10-14T08:40", "Priya Raman", "eval")', ""]
        keys = task_keys(key_world)
        for i, sid in enumerate(ids):
            body += [f'S("{sid}", "read",',
                     f'  T("{user}", rows("{keys[i]}"), ref=[ans(kind="task")]),',
                     f'  T("and again", rows("{keys[i + 1]}"), ref=[ans(kind="task")]))', ""]
        (self.e2 / f"{world}.py").write_text("\n".join(body), encoding="utf-8")

    def make_e2(self) -> None:
        self.e2_source("Q", ["Q-E001", "Q-E002"], "A")
        self.e2_source("R", ["R-E001"], "B")

    def origins(self, **extra) -> dict:
        return {"e1": ("e1 sources", lambda: ["A-E001", "B-E001", "A-E002"]),
                "test-v3.1": ("hand-written sources", lambda: ["B-E002"]),
                "e2": ("e2 sources", lambda: ["Q-E001", "Q-E002", "R-E001"]), **extra}


# ---------------------------------------------------------------------------------------------
# The fold
# ---------------------------------------------------------------------------------------------


class Fold(Base):
    def plan(self, sets_dir: Path | None = None) -> build_sets.V8Plan:
        plan = build_sets.V8Plan()
        build_sets.fold_v7(sets_dir or self.v7, plan)
        return plan

    def test_val_is_the_v7_val_then_the_v7_test_and_only_the_set_field_changes(self):
        plan = self.plan()
        self.assertEqual(plan.problems, [])
        val_lines = (self.v7 / "val.jsonl").read_text(encoding="utf-8").split("\n")[:-1]
        test_lines = (self.v7 / "test.jsonl").read_text(encoding="utf-8").split("\n")[:-1]
        self.assertEqual(plan.val_lines[:2], val_lines)  # the v7 val sessions: not a byte differs
        for old, new in zip(test_lines, plan.val_lines[2:]):
            self.assertEqual(new, old.replace('"set": "test"', '"set": "val"', 1))
            self.assertEqual(json.loads(new), {**json.loads(old), "set": "val"})
        self.assertEqual([json.loads(line)["id"] for line in plan.val_lines], ["A-E001", "B-E001", "A-E002", "B-E002"])

    def test_every_folded_session_records_where_it_came_from_and_what_it_was(self):
        plan = self.plan()
        self.assertEqual(plan.assign, {
            "A-E001": {"set": "val", "origin": "e1", "v7": "val"},
            "B-E001": {"set": "val", "origin": "e1", "v7": "val"},
            "A-E002": {"set": "val", "origin": "e1", "v7": "test"},
            "B-E002": {"set": "val", "origin": "test-v3.1", "v7": "test"}})

    def test_the_gold_of_a_folded_session_is_the_gold_of_v7_exactly(self):
        edited = dict(self.v7_test[0], turns=[dict(turn("A"), gold=[{"type": "rows", "rows": [task_keys("A")[3]]},
                                                                    {"type": "value", "values": [{"amount": 872.6,
                                                                                                  "unit": "USD"}]}],
                                                   rewritten="G0: was 'x'")])
        write_sets(self.v7, self.v7_val, [edited, self.v7_test[1]], self.v7_assign)
        plan = self.plan()
        self.assertEqual(json.loads(plan.val_lines[2])["turns"], edited["turns"])

    def test_a_line_that_does_not_open_with_id_and_set_is_folded_by_parsing(self):
        line = json.dumps({"world": "A", "set": "test", "id": "A-E002"})
        self.assertEqual(json.loads(build_sets.fold_line(line)), {"world": "A", "set": "val", "id": "A-E002"})
        self.assertEqual(build_sets.fold_line(json.dumps(self.v7_test[0], ensure_ascii=False)),
                         json.dumps(dict(self.v7_test[0], set="val"), ensure_ascii=False))

    def test_the_pair_must_be_v7s_the_halves_on_the_same_worlds(self):
        write_sets(self.v7, self.v7_val, [session("Q-E001", "Q", "test", key_world="A")],
                   {**self.v7_assign, "Q-E001": {"set": "test", "origin": "e2"}})
        plan = self.plan()
        self.assertTrue(any("not a pair of v7" in p for p in plan.problems), plan.problems)
        self.assertEqual(plan.val_lines, [])

    def test_a_v8_split_json_is_refused_the_fold_is_applied_once(self):
        write_sets(self.v7, self.v7_val, self.v7_test, self.v7_assign, version=8)
        self.assertTrue(any("v8" in p for p in self.plan().problems))
        write_sets(self.v7, self.v7_val, self.v7_test,
                   {**self.v7_assign, "A-E002": {"set": "test", "origin": "e2"}})
        self.assertTrue(any("v8" in p for p in self.plan().problems))

    def test_a_pair_that_disagrees_with_itself_is_refused(self):
        write_sets(self.v7, self.v7_val, [dict(self.v7_test[0], id="A-E001"), self.v7_test[1]], self.v7_assign)
        self.assertTrue(any("occurs 2 times" in p for p in self.plan().problems))
        write_sets(self.v7, self.v7_val, [dict(self.v7_test[0], set="val"), self.v7_test[1]], self.v7_assign)
        self.assertTrue(any("has set 'val'" in p for p in self.plan().problems))
        write_sets(self.v7, self.v7_val, self.v7_test, {k: v for k, v in self.v7_assign.items() if k != "A-E002"})
        self.assertTrue(any("misses 1" in p for p in self.plan().problems))

    def test_a_refreeze_output_has_no_split_json_and_sets_split_json_stands_in(self):
        write_sets(self.sets, self.v7_val, self.v7_test, self.v7_assign)
        refreeze_out = self.tmp / "refreeze"
        refreeze_out.mkdir()
        for name in ("val.jsonl", "test.jsonl"):
            shutil.copy(self.v7 / name, refreeze_out / name)
        plan = self.plan(refreeze_out)
        self.assertEqual(plan.problems, [])
        self.assertEqual(len(plan.val_lines), 4)
        shutil.rmtree(self.sets)
        self.assertTrue(any("no split.json" in p for p in self.plan(refreeze_out).problems))


# ---------------------------------------------------------------------------------------------
# The e2 sources as the test set
# ---------------------------------------------------------------------------------------------


class E2(Base):
    def problems(self) -> list[str]:
        self.make_e2()
        return build_sets.plan_v8(self.v7, self.e2).problems

    def test_the_sources_compile_to_sessions_cut_to_the_keys_of_the_sets_with_set_test(self):
        self.make_e2()
        plan = build_sets.plan_v8(self.v7, self.e2)
        self.assertEqual(plan.problems, [])
        self.assertEqual([s["id"] for s in plan.test], ["Q-E001", "Q-E002", "R-E001"])
        self.assertEqual({s["set"] for s in plan.test}, {"test"})
        self.assertEqual(list(plan.test[0]), build_sets.SESSION_KEYS)
        self.assertEqual(list(plan.test[0]["turns"][0]), build_sets.TURN_KEYS)
        self.assertEqual(gold_sessions_left(), 0)  # compiling leaves gold.py's registry empty

    def test_nothing_is_compiled_when_there_is_no_source(self):
        plan = build_sets.plan_v8(self.v7, self.e2)
        self.assertTrue(any("no e2 source" in p for p in plan.problems), plan.problems)

    def test_a_source_that_does_not_compile_is_a_problem_not_a_crash(self):
        self.e2.mkdir()
        (self.e2 / "Q.py").write_text("from gold import *\nraise ValueError('boom')\n", encoding="utf-8")
        plan = build_sets.plan_v8(self.v7, self.e2)
        self.assertTrue(any("do not compile" in p and "boom" in p for p in plan.problems), plan.problems)
        self.assertEqual(gold_sessions_left(), 0)

    def test_a_val_world_is_not_a_test_world(self):
        self.e2_source("A", ["A-E900"], "A")
        self.assertTrue(any("A is a val world" in p for p in build_sets.plan_v8(self.v7, self.e2).problems))

    def test_a_train_world_is_not_a_test_world(self):
        with mock.patch.object(build_sets.split, "train_worlds", lambda: ["T01", "Q"]):
            self.assertTrue(any("Q is a train world" in p for p in self.problems()))

    def test_an_id_is_the_worlds_own_e001_upward_and_not_a_val_id(self):
        self.e2_source("Q", ["Q-X001"], "A")
        self.assertTrue(any("<W>-E001 upward" in p for p in build_sets.plan_v8(self.v7, self.e2).problems))
        self.e2_source("Q", ["A-E001"], "A")
        found = build_sets.plan_v8(self.v7, self.e2).problems
        self.assertTrue(any("the id is a val id" in p for p in found), found)

    def test_an_id_defined_twice_is_a_problem(self):
        self.make_e2()
        self.e2_source("R", ["Q-E001"], "B")
        self.assertTrue(any("defined 2 times" in p for p in build_sets.plan_v8(self.v7, self.e2).problems))

    def test_a_turn_without_reference_calls_is_a_problem(self):
        self.make_e2()
        text = (self.e2 / "Q.py").read_text(encoding="utf-8").replace('ref=[ans(kind="task")]', "ref=[]", 1)
        (self.e2 / "Q.py").write_text(text, encoding="utf-8")
        self.assertTrue(any("no reference calls" in p for p in build_sets.plan_v8(self.v7, self.e2).problems))

    def test_a_gold_key_the_world_does_not_have_is_a_problem(self):
        self.make_e2()
        text = (self.e2 / "Q.py").read_text(encoding="utf-8").replace(f'rows("{task_keys("A")[0]}")',
                                                                      'rows("no_such_row")', 1)
        (self.e2 / "Q.py").write_text(text, encoding="utf-8")
        self.assertTrue(any("unknown key 'no_such_row'" in p for p in build_sets.plan_v8(self.v7, self.e2).problems))

    def test_an_unseeded_world_is_one_problem_that_says_how_to_seed_it(self):
        self.make_e2()
        (self.worlds / "R.keys.json").unlink()
        found = [p for p in build_sets.plan_v8(self.v7, self.e2).problems if "no keys file" in p]
        self.assertEqual(found, ["world R: no keys file; seed it (python3 seed_worlds.py R)"])

    def test_a_test_id_is_never_fixed_by_hand(self):
        self.make_e2()
        with mock.patch.dict(regen.FIXES, {("Q-E001", 1): {"ruling": "G0", "why": "x", "expect": "0", "add": []}}):
            self.assertTrue(any("never fixed by hand" in p for p in build_sets.plan_v8(self.v7, self.e2).problems))

    def test_the_conventions_prepare_the_test_sessions_and_the_fixes_never_do(self):
        self.e2_source("Q", ["Q-E001"], "A", user="what's due this week")
        text = (self.e2 / "Q.py").read_text(encoding="utf-8").replace('ref=[ans(kind="task")]',
                                                                      'ref=[ans(kind="task", when="{}")]', 1)
        (self.e2 / "Q.py").write_text(text, encoding="utf-8")
        plan = build_sets.plan_v8(self.v7, self.e2)
        self.assertEqual([(r["id"], r["turn"], r["convention"]) for r in plan.prepared], [("Q-E001", 1, "due-active")])
        self.assertEqual(plan.problems, [])
        session_ = plan.test[0]
        fixed = {"ruling": "G0", "why": "x", "expect": regen.digest(session_["turns"][0]["user"]),
                 "user": "something else"}
        with mock.patch.dict(regen.FIXES, {(session_["id"], 1): fixed}):
            kept = regen.prepare_session(session_, fixes=False)[0]["turns"][0]["user"]
            self.assertEqual(kept, "what's due this week")
            self.assertEqual(regen.prepare_session(session_)[0]["turns"][0]["user"], "something else")

    def test_a_dry_plan_that_would_break_the_rules_check_applies_is_refused(self):
        self.make_e2()
        write_sets(self.v7, self.v7_val, self.v7_test, self.v7_assign)
        # the world Q is also a world of val: the fold makes it one
        write_sets(self.v7, [*self.v7_val, session("Q-E100", "Q", "val", key_world="A")],
                   [*self.v7_test, session("Q-E101", "Q", "test", key_world="A")],
                   {**self.v7_assign, "Q-E100": {"set": "val", "origin": "e1"},
                    "Q-E101": {"set": "test", "origin": "e1"}})
        found = build_sets.plan_v8(self.v7, self.e2).problems
        self.assertTrue(any("Q is a val world" in p for p in found), found)


def gold_sessions_left() -> int:
    import gold

    return len(gold.sessions())


# ---------------------------------------------------------------------------------------------
# check
# ---------------------------------------------------------------------------------------------


class Check(Base):
    """The check on a directory in the shape v8 gives sets/: val on A and B, test on Q and R."""

    def setUp(self):
        super().setUp()
        self.val = [session("A-E001", "A", "val"), session("A-E002", "A", "val"), session("B-E001", "B", "val"),
                    session("B-E002", "B", "val")]
        self.test = [session("Q-E001", "Q", "test", key_world="A"), session("Q-E002", "Q", "test", key_world="A"),
                     session("R-E001", "R", "test", key_world="B")]
        self.fit = [plain(f"{w}-00{i}", w, "train") for w in ("T01", "T02") for i in (1, 2)]  # the train data's records
        self.assign = {
            "A-E001": {"set": "val", "origin": "e1", "v7": "val"},
            "A-E002": {"set": "val", "origin": "e1", "v7": "test"},
            "B-E001": {"set": "val", "origin": "e1", "v7": "val"},
            "B-E002": {"set": "val", "origin": "test-v3.1", "v7": "test"},
            "Q-E001": {"set": "test", "origin": "e2"}, "Q-E002": {"set": "test", "origin": "e2"},
            "R-E001": {"set": "test", "origin": "e2"}}
        with gzip.open(self.tmp / "train.jsonl.gz", "wt", encoding="utf-8") as handle:
            for s in self.fit:
                handle.write(json.dumps({"id": f"train-{s['id']}"}) + "\n")
        patch = mock.patch.object(build_sets, "ORIGINS", self.origins())
        patch.start()
        self.addCleanup(patch.stop)

    def write(self, root: Path | None = None, val=None, test=None, assign=None, **meta) -> Path:
        return write_sets(root or self.sets, self.val if val is None else val, self.test if test is None else test,
                          self.assign if assign is None else assign, **{"version": 8, **meta})

    def run_check(self, root: Path | None = None, recorded: bool = True, v7: bool = False) -> tuple[int, str]:
        root = root or self.sets
        hashes = {f: hashlib.sha256((root / f).read_bytes()).hexdigest() for f in build_sets.FILES
                  if (root / f).exists()} if recorded else {}
        with mock.patch.object(build_sets, "recorded_hashes", lambda: hashes):
            rc, _, err = quiet(build_sets.check, root, v7)
        return rc, err

    def test_val_and_test_on_disjoint_worlds_pass(self):
        self.write()
        self.assertEqual(self.run_check(), (0, ""))

    def test_the_pair_of_v7_passes_with_v7_and_fails_the_rules_of_v8_without_it(self):
        """The sets in the tree are the pair of v7 until v8 is frozen: val and test share every world, test has no e2 origin and
        no session records a v7 half. `verify-heldout` checks them with --v7."""
        write_sets(self.sets, self.v7_val, self.v7_test, self.v7_assign)
        sources = {"e1": ("e1 sources", lambda: ["A-E001", "B-E001", "A-E002"]), "test-v3.1": ("hand-written", lambda: ["B-E002"]),
                   "e2": ("not kept", None)}
        with mock.patch.object(build_sets, "ORIGINS", sources):
            self.assertEqual(self.run_check(v7=True), (0, ""))
            rc, err = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("val and test both have sessions of the world A", err)
        self.assertIn("do not record the v7 half they were in", err)
        self.assertIn("test sessions whose origin is not a test origin", err)

    def test_v7_still_holds_every_other_check(self):
        sources = {"e1": ("e1 sources", lambda: ["A-E001", "B-E001", "A-E002"]), "test-v3.1": ("hand-written", lambda: ["B-E002"]),
                   "e2": ("not kept", None)}
        bad = dict(self.v7_test[0], turns=[dict(turn("A"), gold=[{"type": "rows", "rows": ["no_such_row"]}])])
        with mock.patch.object(build_sets, "ORIGINS", sources):
            write_sets(self.sets, self.v7_val, [bad, self.v7_test[1]], self.v7_assign)
            self.assertIn("gold names the unknown key 'no_such_row'", self.run_check(v7=True)[1])
            write_sets(self.sets, self.v7_val, [dict(self.v7_test[0], id="A-E001"), self.v7_test[1]], self.v7_assign)
            self.assertIn("id A-E001 occurs 2 times", self.run_check(v7=True)[1])
            write_sets(self.sets, self.v7_val, self.v7_test, {**self.v7_assign, "A-E001": {"set": "test", "origin": "e1"}})
            self.assertIn("sessions that split.json puts in the other set", self.run_check(v7=True)[1])
            write_sets(self.sets, self.v7_val, self.v7_test, self.v7_assign)
            with mock.patch.object(build_sets.split, "train_worlds", lambda: ["T01", "A"]):
                self.assertIn("val has sessions of the train world A", self.run_check(v7=True)[1])
            self.assertIn("is not the file FROZEN.md records", self.run_check(recorded=False, v7=True)[1])

    def test_a_world_in_both_val_and_test_fails(self):
        shared = [*self.test, session("A-E900", "A", "test")]
        self.write(test=shared, assign={**self.assign, "A-E900": {"set": "test", "origin": "e2"}})
        rc, err = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("val and test both have sessions of the world A", err)

    def test_a_test_world_that_is_a_train_world_fails(self):
        with mock.patch.object(build_sets.split, "train_worlds", lambda: ["T01", "T02", "Q"]):
            self.write()
            rc, err = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("test has sessions of the train world Q", err)

    def test_a_val_world_that_is_a_train_world_fails(self):
        with mock.patch.object(build_sets.split, "train_worlds", lambda: ["T01", "T02", "B"]):
            self.write()
            rc, err = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("val has sessions of the train world B", err)

    def test_a_test_session_has_a_test_origin_and_no_v7_half(self):
        self.write(assign={**self.assign, "Q-E001": {"set": "test", "origin": "e1"}})
        self.assertIn("test sessions whose origin is not a test origin (e2), e.g. Q-E001", self.run_check()[1])
        self.write(assign={**self.assign, "Q-E001": {"set": "test", "origin": "e2", "v7": "test"}})
        self.assertIn("record a v7 half", self.run_check()[1])

    def test_a_val_session_records_the_v7_half_and_has_no_test_origin(self):
        self.write(assign={**self.assign, "A-E002": {"set": "val", "origin": "e1"}})
        self.assertIn("do not record the v7 half they were in", self.run_check()[1])
        self.write(assign={**self.assign, "A-E002": {"set": "val", "origin": "e2", "v7": "test"}})
        self.assertIn("val sessions with a test origin", self.run_check()[1])

    def test_split_json_must_name_exactly_the_sessions_of_the_sets_and_in_the_right_one(self):
        self.write(assign={k: v for k, v in self.assign.items() if k != "R-E001"})
        self.assertIn("misses 1", self.run_check()[1])
        self.write(assign={**self.assign, "A-E001": {"set": "test", "origin": "e2"}})
        self.assertIn("sessions that split.json puts in the other set (it says test, the file is val)",
                      self.run_check()[1])

    def test_the_sources_of_an_origin_that_has_them_must_match_split_json(self):
        self.write()
        with mock.patch.object(build_sets, "ORIGINS", self.origins(e1=("e1 sources", lambda: ["A-E001", "B-E001"]))):
            rc, err = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("origin e1: split.json has 3 sessions, its sources e1 sources define 2", err)

    def test_an_origin_whose_sources_are_not_kept_is_held_to_split_json_alone(self):
        """The hand-written, e1 and e2 sources are not in the tree (R-1088-16): split.json is the record of their ids."""
        self.write()
        kept = {"e1": ("not kept", None), "test-v3.1": ("not kept", None), "e2": ("not kept", None)}
        with mock.patch.object(build_sets, "ORIGINS", kept):
            self.assertEqual(self.run_check(), (0, ""))
        self.write(assign={**self.assign, "A-E001": {"set": "val", "origin": "mystery", "v7": "val"}})
        with mock.patch.object(build_sets, "ORIGINS", kept):
            self.assertIn("split.json has the origin 'mystery'", self.run_check()[1])


    def test_an_origin_with_neither_session_nor_source_is_nothing(self):
        self.write()
        with mock.patch.object(build_sets, "ORIGINS", self.origins(e3=("none yet", lambda: []))):
            self.assertEqual(self.run_check(), (0, ""))

    def test_an_origin_split_json_has_and_origins_does_not_is_a_problem(self):
        self.write(assign={**self.assign, "A-E001": {"set": "val", "origin": "mystery", "v7": "val"}})
        self.assertIn("split.json has the origin 'mystery'", self.run_check()[1])

    def test_an_id_in_both_val_and_test_and_a_wrong_set_field_fail(self):
        self.write(test=[*self.test, dict(self.val[0], set="test")])
        self.assertIn("id A-E001 occurs 2 times (val, test)", self.run_check()[1])
        self.write(test=[dict(self.test[0], set="val"), *self.test[1:]])
        self.assertIn("Q-E001 has set 'val', want 'test'", self.run_check()[1])

    def test_a_gold_key_the_world_does_not_have_fails(self):
        bad = dict(self.test[0], turns=[dict(turn("A"), gold=[{"type": "rows", "rows": ["no_such_row"]}])])
        self.write(test=[bad, *self.test[1:]])
        self.assertIn("gold names the unknown key 'no_such_row'", self.run_check()[1])

    def test_a_session_of_the_train_data_in_val_or_test_fails(self):
        with gzip.open(self.tmp / "train.jsonl.gz", "wt", encoding="utf-8") as handle:
            for sid in ("T01-001", "T01-002", "T02-001", "T02-002", "Q-E001"):
                handle.write(json.dumps({"id": f"train-{sid}"}) + "\n")
        self.write()
        self.assertIn("Q-E001 is in data/train.jsonl.gz and in test", self.run_check()[1])

    def test_a_record_of_the_train_data_on_a_val_or_test_world_fails_whatever_its_id(self):
        with gzip.open(self.tmp / "train.jsonl.gz", "wt", encoding="utf-8") as handle:
            for s in self.fit:
                handle.write(json.dumps({"id": f"train-{s['id']}", "world": s["world"]}) + "\n")
            handle.write(json.dumps({"id": "train-T01-777", "world": "Q"}) + "\n")
            handle.write(json.dumps({"id": "train-T01-778", "world": "A"}) + "\n")
        self.write()
        err = self.run_check()[1]
        self.assertIn("data/train.jsonl.gz has records of the world Q, a test world", err)
        self.assertIn("data/train.jsonl.gz has records of the world A, a val world", err)

    def test_sets_must_match_the_hashes_frozen_md_records(self):
        self.write()
        rc, err = self.run_check(recorded=False)
        self.assertEqual(rc, 1)
        self.assertIn("is not the file FROZEN.md records", err)

    def test_a_candidate_directory_is_not_held_to_the_hashes(self):
        candidate = self.write(self.tmp / "candidate")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = build_sets.check(candidate)
        self.assertEqual((rc, err.getvalue()), (0, ""))
        self.assertIn("sets/val.jsonl", out.getvalue())  # hashes printed to record, under the names they will have

    def test_the_sets_directory_wants_all_three_files_and_says_where_they_come_from(self):
        self.write()
        (self.sets / "test.jsonl").unlink()
        with self.assertRaises(SystemExit) as raised:
            quiet(build_sets.check, self.sets)
        self.assertIn("artefacts.py fetch", str(raised.exception))

    def test_val_and_test_must_each_have_a_session(self):
        self.write(test=[], assign={k: v for k, v in self.assign.items() if v["set"] == "val"})
        self.assertIn("test has no session", self.run_check()[1])


# ---------------------------------------------------------------------------------------------
# freeze-v8: the dry run and the whole run
# ---------------------------------------------------------------------------------------------


def ref_step(world: str, key_list: list[str], args: dict, ordered: bool = False) -> dict:
    keys = KEYS["A" if world == "Q" else "B"]
    rows = [{"id": keys[k]["id"], "kind": keys[k]["kind"], "n": 30} for k in key_list]
    return {"model": "", "response": {"call": {"tool": "answer", "args": args},
                                      "effect": {"tool": "answer", "answer": {"rows": rows, "ordered": ordered,
                                                                              "result": "@1"}},
                                      "ends_turn": True, "text": ""}}


class Freeze(Base):
    def setUp(self):
        super().setUp()
        self.make_e2()
        for p in (mock.patch.object(build_sets, "ORIGINS", self.origins()),):
            p.start()
            self.addCleanup(p.stop)
        with gzip.open(self.tmp / "train.jsonl.gz", "wt", encoding="utf-8") as handle:
            handle.write(json.dumps({"id": "train-T01-001"}) + "\n")
        self.ref_out = self.tmp / "ref"
        self.ref_out.mkdir()
        a, b = task_keys("A"), task_keys("B")
        self.runs = [
            {"id": "Q-E001", "turns": [{"steps": [ref_step("Q", [a[0]], {"kind": "task"})]},
                                       {"steps": [ref_step("Q", [a[1]], {"kind": "task"})]}]},
            {"id": "Q-E002", "turns": [{"steps": [ref_step("Q", [a[1]], {"kind": "task"})]},
                                       {"steps": [ref_step("Q", [a[2]], {"kind": "task"})]}]},
            {"id": "R-E001", "turns": [{"steps": [ref_step("R", [b[0]], {"kind": "task"})]},
                                       {"steps": [ref_step("R", [b[1]], {"kind": "task"})]}]}]

    def write_runs(self, runs=None) -> None:
        (self.ref_out / "test.run.jsonl").write_text(dumps(runs or self.runs), encoding="utf-8")

    def freeze(self, out: Path | None = None, dry: bool = False, **kw) -> tuple[int, str, str]:
        return quiet(build_sets.freeze_v8, out, kw.pop("sets_dir", self.v7), kw.pop("e2_dir", self.e2),
                     kw.pop("ref_out", self.ref_out), 2, dry, **kw)

    def test_a_dry_run_prints_the_plan_and_writes_nothing(self):
        before = sorted(p.name for p in self.tmp.iterdir())
        rc, out, err = self.freeze(dry=True)
        self.assertEqual((rc, err), (0, ""))
        self.assertIn("val          4 sessions", out)
        self.assertIn("(v7 val 2 + v7 test 2", out)
        self.assertIn("test         3 sessions", out)
        self.assertIn("worlds {'Q': 2, 'R': 1}", out)
        self.assertIn("nothing written", out)
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir()), before)

    def test_a_dry_run_needs_no_runtime_and_no_out(self):
        with mock.patch.object(build_sets, "refreeze", side_effect=AssertionError("ran the reference")):
            rc, _, _ = self.freeze(dry=True)
        self.assertEqual(rc, 0)

    def test_a_dry_run_exits_1_on_a_problem(self):
        shutil.rmtree(self.e2)
        rc, _, err = self.freeze(dry=True)
        self.assertEqual(rc, 1)
        self.assertIn("no e2 source", err)

    def test_the_whole_run_writes_val_test_and_split_json_and_passes_its_own_check(self):
        self.write_runs()
        out = self.tmp / "out"
        rc, text, err = self.freeze(out)
        self.assertEqual((rc, err), (0, ""), text)
        final = out / "sets"
        self.assertEqual(sorted(p.name for p in final.iterdir()), ["split.json", "test.jsonl", "val.jsonl"])
        val = [json.loads(line) for line in (final / "val.jsonl").read_text(encoding="utf-8").split("\n") if line]
        test = [json.loads(line) for line in (final / "test.jsonl").read_text(encoding="utf-8").split("\n") if line]
        self.assertEqual([s["id"] for s in val], ["A-E001", "B-E001", "A-E002", "B-E002"])
        self.assertEqual({s["set"] for s in val}, {"val"})
        self.assertEqual([(s["id"], s["set"], s["world"]) for s in test],
                         [("Q-E001", "test", "Q"), ("Q-E002", "test", "Q"), ("R-E001", "test", "R")])
        meta = json.loads((final / "split.json").read_text(encoding="utf-8"))
        self.assertEqual((meta["version"], meta["folded"]), (8, {"from": "test", "into": "val", "sessions": 2}))
        self.assertEqual({k: (a["set"], a["origin"], a.get("v7")) for k, a in meta["assign"].items()}, {
            "A-E001": ("val", "e1", "val"), "B-E001": ("val", "e1", "val"), "A-E002": ("val", "e1", "test"),
            "B-E002": ("val", "test-v3.1", "test"), "Q-E001": ("test", "e2", None), "Q-E002": ("test", "e2", None),
            "R-E001": ("test", "e2", None)})
        self.assertTrue((out / "prepared.md").exists() and (out / "refreeze" / "changes.md").exists())
        self.assertIn("sets/val.jsonl", (out / "check.txt").read_text(encoding="utf-8"))  # the hashes to record
        self.assertIn(f"cp {final / 'val.jsonl'} {final / 'test.jsonl'} {final / 'split.json'} {self.sets}/", text)
        self.assertIn("python3 build_sets.py ref --sets-dir", text)
        self.assertIn("--sets test", text)  # the gate of the test set is in the sequence the run prints
        self.assertIn("ok: ", text)

    def test_the_test_gold_comes_from_the_reference_run_through_the_conventions(self):
        a = task_keys("A")
        longest_task = max((t for t in json.loads((REAL_WORLDS / "A.json").read_text(encoding="utf-8"))["tasks"]
                            if t.get("effort") and t["key"] in KEYS["A"]), key=lambda t: t["effort"])
        longest = {"kind": "task", "order": "effort desc", "limit": 1}
        text = (self.e2 / "Q.py").read_text(encoding="utf-8")
        text = text.replace('T("and again", rows("%s"), ref=[ans(kind="task")])' % a[1],
                            'T("the longest job", rows("%s", order=True), '
                            'ref=[ans(kind="task", order="effort desc", limit=1)])' % longest_task["key"], 1)
        (self.e2 / "Q.py").write_text(text, encoding="utf-8")
        self.runs[0]["turns"][1] = {"steps": [ref_step("Q", [longest_task["key"]], longest, ordered=True)]}
        self.write_runs()
        out = self.tmp / "out"
        rc, text, err = self.freeze(out)
        self.assertEqual((rc, err), (0, ""), text)
        test = read(out / "sets" / "test.jsonl")
        self.assertEqual(test[0]["turns"][1]["gold"], [{"type": "rows", "rows": [longest_task["key"]], "order": True},
                                                       {"type": "value", "values": [{"amount": longest_task["effort"], "unit": None}]}])
        self.assertIn("superlative 1", text)

    def test_an_unexplained_turn_exits_1_and_nothing_is_written_to_sets(self):
        b = task_keys("B")
        self.runs[2]["turns"][1] = {"steps": [ref_step("R", [b[5]], {"kind": "task"})]}  # not what the gold says
        self.write_runs()
        out = self.tmp / "out"
        rc, text, err = self.freeze(out)
        self.assertEqual(rc, 1)
        self.assertIn("UNEXPLAINED 1", text)
        self.assertIn("nothing is written", err)
        self.assertFalse((out / "sets").exists())
        self.assertIn("UNEXPLAINED", (out / "refreeze" / "changes.md").read_text(encoding="utf-8"))

    def test_the_conventions_prepare_the_test_sessions_before_the_run(self):
        self.e2_source("Q", ["Q-E001", "Q-E002"], "A", user="what's due this week")
        text = (self.e2 / "Q.py").read_text(encoding="utf-8").replace(
            'ref=[ans(kind="task")]),\n  T("and again"', 'ref=[ans(kind="task", when="{}")]),\n  T("and again"')
        (self.e2 / "Q.py").write_text(text, encoding="utf-8")
        self.write_runs()
        out = self.tmp / "out"
        rc, text, _ = self.freeze(out)
        self.assertIn("due-active 2", text)  # the prepared turns, one per session
        prepared = (out / "e2" / "pre" / "test.jsonl").read_text(encoding="utf-8")
        self.assertIn("status = open", prepared)
        self.assertNotIn("status = open", (out / "e2" / "test.jsonl").read_text(encoding="utf-8"))

    def test_a_run_of_the_wrong_sessions_is_refused(self):
        self.write_runs(self.runs[:2])
        with self.assertRaises(SystemExit):
            self.freeze(self.tmp / "out")

    def test_out_is_never_sets_and_never_a_directory_in_use(self):
        with self.assertRaises(SystemExit):
            self.freeze(self.sets)
        used = self.tmp / "used"
        used.mkdir()
        (used / "x").write_text("x")
        with self.assertRaises(SystemExit):
            self.freeze(used)
        with self.assertRaises(SystemExit):
            self.freeze(None)

# ---------------------------------------------------------------------------------------------
# ref --sets, the command line
# ---------------------------------------------------------------------------------------------


class Cli(Base):
    def main(self, *argv: str) -> tuple[int | None, dict]:
        """(exit code, the arguments the command was called with) of build_sets.main for each command it dispatches."""
        seen: dict = {}
        fakes = {name: mock.Mock(side_effect=lambda *a, _n=name, **k: seen.setdefault(_n, (a, k)) and 0)
                 for name in ("check", "ref", "refreeze", "freeze_v8", "pool")}
        with mock.patch.multiple(build_sets, **fakes), mock.patch.object(sys, "argv", ["build_sets.py", *argv]), \
                contextlib.redirect_stderr(io.StringIO()):  # argparse prints its usage there
            try:
                build_sets.main()
            except SystemExit as exit_:
                return exit_.code, seen
        return None, seen

    def test_check_takes_a_candidate_directory(self):
        code, seen = self.main("check", "--sets-dir", "/x/sets")
        self.assertEqual(seen["check"][0], (Path("/x/sets"), False))
        code, seen = self.main()
        self.assertEqual(seen["check"][0], (build_sets.SETS, False))
        code, seen = self.main("check", "--v7")
        self.assertEqual(seen["check"][0], (build_sets.SETS, True))

    def test_ref_takes_the_sets_to_check(self):
        _, seen = self.main("ref", "--sets-dir", "/x/sets", "--sets", "test")
        self.assertEqual(seen["ref"][0], (None, 8, Path("/x/sets"), ("test",)))
        _, seen = self.main("ref")
        self.assertEqual(seen["ref"][0][3], ("val", "test"))
        code, _ = self.main("ref", "--sets", "other")
        self.assertIn("names val and test only", str(code))

    def test_ref_runs_only_the_named_sets(self):
        steps = []
        with mock.patch.object(build_sets, "step", lambda cmd, log: steps.append(
                (Path(cmd[1]).name, cmd[3] if cmd[1].endswith("run.py") else cmd[2]))):
            work = self.tmp / "work"
            work.mkdir()
            report = {"session_pass": 1, "sessions": 1, "turn_pass": 2, "turns": 2}
            (work / "test.report.json").write_text(json.dumps(report), encoding="utf-8")
            rc, out, _ = quiet(build_sets.ref, work, 2, self.tmp, ("test",))
        self.assertEqual(rc, 0)
        self.assertEqual(steps, [("run.py", str(self.tmp / "test.jsonl")), ("score.py", str(work / "test.run.jsonl"))])
        self.assertIn("test: sessions 1/1, turns 2/2", out)
        self.assertNotIn("val:", out)

    def test_freeze_v8_takes_the_dry_run_and_the_directories(self):
        _, seen = self.main("freeze-v8", "--out", "/o", "--dry-run", "--sets-dir", "/s", "--e2-dir", "/e",
                            "--ref-out", "/r", "--jobs", "3")
        self.assertEqual(seen["freeze_v8"][0], (Path("/o"), Path("/s"), Path("/e"), Path("/r"), 3, True))
        _, seen = self.main("freeze-v8", "--dry-run", "--e2-dir", "/e")
        self.assertEqual(seen["freeze_v8"][0], (None, build_sets.SETS, Path("/e"), None, 8, True))

    def test_the_e2_sources_are_the_owners_input_and_have_no_default_place_in_the_tree(self):
        code, seen = self.main("freeze-v8", "--dry-run")
        self.assertEqual((code, seen), (2, {}))

    def test_there_is_no_trainfit_command(self):
        code, _ = self.main("trainfit", "--train-gold", "g/*.gold.jsonl")
        self.assertEqual(code, 2)


class Docs(unittest.TestCase):
    def test_the_shipped_registry_keeps_only_the_val_world_sources(self):
        self.assertEqual({o: src is None for o, (_, src) in build_sets.ORIGINS.items()},
                         {"val-v3.1": False, "test-v3.1": True, "e1": True, "e2": True})

    def test_the_origins_registry_knows_e2_by_name_and_keeps_no_sources_for_it(self):
        self.assertIn("e2", build_sets.ORIGINS)
        self.assertIsNone(build_sets.ORIGINS["e2"][1])
        self.assertEqual(build_sets.TEST_ORIGINS, ("e2",))
        self.assertTrue(set(build_sets.TEST_ORIGINS) <= set(build_sets.ORIGINS))
        self.assertFalse(hasattr(build_sets, "E2"))

    def test_the_check_wants_val_and_test_world_disjoint_in_its_own_words(self):
        text = build_sets.__doc__
        self.assertIn("val and test worlds DISJOINT", text)
        self.assertIn("freeze-v8", text)


if __name__ == "__main__":
    unittest.main()
