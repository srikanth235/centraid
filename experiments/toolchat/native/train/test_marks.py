"""Tests for train.py's marks: out/marks.json and out/best.json at every checkpoint, the new defaults, and the scripts that read them.

    HF_HUB_OFFLINE=1 python -m unittest train/test_marks.py

At every mark (`--checkpoints`, default 25 / 50 / 75 / 100 %) the trainer evaluates the val file and the train sample: marks.json keeps,
per mark, the loss, accuracy and the decision / hard / copy / other breakdown of both, and best.json names the mark with the lowest val
DECISION loss (ties: the later mark). `train/vm/score_ckpt.sh --mark best` and run_job.sh's `score_mark` read best.json; ckpt-100 stays the
default scored mark. MarksFiles is the writer and the defaults (text and numbers only), ScoreScripts the shell side, MarksOnTheTinyModel
the eval loop of train.main() on the tiny CPU model of test_resume.py.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_resume as tr  # noqa: E402
from test_pairs import load_train  # noqa: E402

VM = HERE / "vm"
CHECKPOINTS = "0.25,0.5,0.75,1.0"


def entry(name, step, dloss, spe=10, train_dloss=0.5):
    """One mark as train.mark_entry builds it (the val and train sides: the keys train.evaluate returns)."""
    def side(dl):
        return {"n": 100, "loss": 1.0, "acc": 0.5, "dn": 30, "dloss": dl, "dacc": 0.6, "oloss": 0.9, "hn": 10, "hloss": 0.8,
                "hacc": 0.7, "cn": 5, "closs": 0.4, "cacc": 0.9}
    return {"mark": name, "step": step, "epoch": step / spe, "val": None if dloss is None else side(dloss), "train": side(train_dloss)}


class MarksFiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.train = load_train()
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no torch: %r" % (e,))

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="marks-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    # ---- the defaults of this change --------------------------------------------------------------------

    def test_the_defaults_are_the_new_ones_and_the_legacy_flags_name_the_old(self):
        parse = self.train.parser().parse_args
        a = parse(["--train", "t.jsonl", "--out", "o"])
        self.assertEqual((a.decision_weight, a.copy_weight, a.pair_batches, a.checkpoints),
                         (2.0, 0.0, True, "0.25,0.5,0.75,1.0"))
        self.assertEqual((self.train.DECISION_WEIGHT, self.train.COPY_WEIGHT, self.train.CHECKPOINTS), (2.0, 0.0, CHECKPOINTS))
        a = parse(["--train", "t.jsonl", "--out", "o"] + self.train.LEGACY_LOSS.split())
        self.assertEqual((a.decision_weight, a.copy_weight, a.pair_batches), (1.0, 1.0, False))
        self.assertIn("--decision-weight 1 --copy-weight 1 --no-pair-batches", self.train.LEGACY_LOSS)
        a = parse(["--train", "t.jsonl", "--out", "o", "--pair-batches", "--copy-labels", ""])
        self.assertEqual((a.pair_batches, a.copy_labels), (True, ""))

    def test_the_marks_are_fractions_of_the_steps_and_the_end_is_always_one(self):
        marks = self.train.mark_steps
        self.assertEqual(marks(100, CHECKPOINTS), {25: "ckpt-025", 50: "ckpt-050", 75: "ckpt-075", 100: "ckpt-100"})
        self.assertEqual(marks(6, CHECKPOINTS), {2: "ckpt-025", 3: "ckpt-050", 5: "ckpt-075", 6: "ckpt-100"})  # the first step at or after
        self.assertEqual(marks(10, "1.0"), {10: "ckpt-100"})
        self.assertEqual(marks(10, "0.5"), {5: "ckpt-050", 10: "ckpt-100"})
        self.assertEqual(marks(1, CHECKPOINTS), {1: "ckpt-100"})
        self.assertEqual(marks(40, "0.25,0.5,1.0"), {10: "ckpt-025", 20: "ckpt-050", 40: "ckpt-100"})  # the old default still works

    # ---- which mark is best -----------------------------------------------------------------------------

    def test_the_best_mark_has_the_lowest_val_decision_loss_and_a_tie_goes_to_the_later_mark(self):
        pick = self.train.pick_best
        marks = [entry("ckpt-025", 25, 0.30), entry("ckpt-050", 50, 0.20), entry("ckpt-075", 75, 0.25), entry("ckpt-100", 100, 0.22)]
        self.assertEqual(pick(marks)["mark"], "ckpt-050")
        self.assertEqual(pick(list(reversed(marks)))["mark"], "ckpt-050")  # by the numbers, not by the order given
        tie = [entry("ckpt-025", 25, 0.30), entry("ckpt-050", 50, 0.20), entry("ckpt-075", 75, 0.20), entry("ckpt-100", 100, 0.40)]
        self.assertEqual(pick(tie)["mark"], "ckpt-075")  # equal: the later mark
        self.assertEqual(pick(list(reversed(tie)))["mark"], "ckpt-075")
        self.assertEqual(pick([entry("ckpt-025", 25, 0.3), entry("ckpt-100", 100, 0.3)])["mark"], "ckpt-100")
        # the val DECISION loss decides, not the train side and not the all-token val loss
        a, b = entry("ckpt-050", 50, 0.2, train_dloss=9.0), entry("ckpt-100", 100, 0.3, train_dloss=0.0)
        a["val"]["loss"], b["val"]["loss"] = 5.0, 0.1
        self.assertEqual(pick([a, b])["mark"], "ckpt-050")

    def test_a_mark_without_a_usable_val_result_is_never_best(self):
        pick = self.train.pick_best
        self.assertIsNone(pick([]))
        self.assertIsNone(pick([entry("ckpt-100", 100, None)]))  # a run without --val: nothing to choose by
        self.assertEqual(pick([entry("ckpt-050", 50, 0.5), entry("ckpt-100", 100, None)])["mark"], "ckpt-050")
        self.assertEqual(pick([entry("ckpt-050", 50, float("nan")), entry("ckpt-100", 100, 0.9)])["mark"], "ckpt-100")
        self.assertIsNone(pick([entry("ckpt-100", 100, float("nan"))]))
        self.assertIsNone(pick([{**entry("ckpt-100", 100, 0.1), "val": {"dloss": float("inf")}}]))

    # ---- the files --------------------------------------------------------------------------------------

    def test_marks_and_best_are_strict_json_written_atomically_and_name_a_mark(self):
        out = Path(self.tmp)
        marks = [entry("ckpt-025", 25, 0.30), entry("ckpt-050", 50, 0.20)]
        best = self.train.write_marks(out, marks)
        self.assertEqual(best["mark"], "ckpt-050")
        m = json.loads((out / "marks.json").read_text())
        self.assertEqual(list(m["marks"]), ["ckpt-025", "ckpt-050"])
        self.assertEqual(m["marks"]["ckpt-050"]["step"], 50)
        self.assertEqual(m["marks"]["ckpt-050"]["val"]["dloss"], 0.20)
        self.assertEqual(m["marks"]["ckpt-050"]["val"]["hloss"], 0.8)
        self.assertEqual(m["marks"]["ckpt-050"]["train"]["dacc"], 0.6)
        self.assertNotIn("mark", m["marks"]["ckpt-050"])  # the name is the key
        self.assertEqual(m["criterion"], self.train.MARKS_CRITERION)
        b = json.loads((out / "best.json").read_text())
        self.assertEqual((b["mark"], b["step"], b["epoch"]), ("ckpt-050", 50, 5.0))
        self.assertEqual(b["val"], m["marks"]["ckpt-050"]["val"])
        self.assertEqual(b["val_dloss"], {"ckpt-025": 0.30, "ckpt-050": 0.20})
        self.assertEqual(sorted(p.name for p in out.iterdir()), ["best.json", "marks.json"])  # no temporary file is left
        # a later mark rewrites both
        self.train.write_marks(out, marks + [entry("ckpt-100", 100, 0.10)])
        self.assertEqual(json.loads((out / "best.json").read_text())["mark"], "ckpt-100")
        self.assertEqual(list(json.loads((out / "marks.json").read_text())["marks"]), ["ckpt-025", "ckpt-050", "ckpt-100"])

    def test_a_non_finite_number_is_written_as_null_never_as_nan(self):
        out = Path(self.tmp)
        marks = [entry("ckpt-050", 50, 0.2), entry("ckpt-100", 100, 0.3)]
        marks[1]["train"]["closs"] = float("nan")
        marks[0]["train"]["hloss"] = float("inf")
        self.train.write_marks(out, marks)

        def strict(text):
            return json.loads(text, parse_constant=lambda c: self.fail("not strict JSON: %s" % c))
        m = strict((out / "marks.json").read_text())  # jq and the shell scripts read this
        self.assertIsNone(m["marks"]["ckpt-100"]["train"]["closs"])
        self.assertIsNone(m["marks"]["ckpt-050"]["train"]["hloss"])
        strict((out / "best.json").read_text())

    def test_without_a_val_result_marks_json_is_written_and_best_json_is_not(self):
        out = Path(self.tmp)
        self.assertIsNone(self.train.write_marks(out, [entry("ckpt-100", 100, None)]))
        m = json.loads((out / "marks.json").read_text())
        self.assertIsNone(m["marks"]["ckpt-100"]["val"])
        self.assertEqual(m["marks"]["ckpt-100"]["train"]["n"], 100)
        self.assertFalse((out / "best.json").exists())  # nothing to choose by: the scripts say so instead of guessing
        self.assertIsNone(self.train.write_marks(out, []))  # nothing yet, nothing written
        self.assertEqual(sorted(p.name for p in out.iterdir()), ["marks.json"])

    def test_only_rank_zero_writes(self):
        out = Path(self.tmp)
        real = self.train.RANK
        self.train.RANK = 1
        try:
            self.assertIsNone(self.train.write_marks(out, [entry("ckpt-100", 100, 0.1)]))
        finally:
            self.train.RANK = real
        self.assertEqual(list(out.iterdir()), [])


class ScoreScripts(unittest.TestCase):
    """The shell side of `best`: score_ckpt.sh --mark and run_job.sh's score_mark read the very files train.write_marks writes."""

    @classmethod
    def setUpClass(cls):
        if shutil.which("bash") is None:
            raise unittest.SkipTest("no bash")
        try:
            cls.train = load_train()
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no torch: %r" % (e,))

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="marks-sh-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.out = self.tmp / "out"  # a training run's --out: the four marks, FINAL, and the files of the trainer
        for m in ("ckpt-025", "ckpt-050", "ckpt-075", "ckpt-100"):
            (self.out / m).mkdir(parents=True)
            (self.out / m / "config.json").write_text("{}")
        (self.out / "FINAL").write_text("ckpt-100\n")
        self.train.write_marks(self.out, [entry("ckpt-025", 25, 0.30), entry("ckpt-050", 50, 0.21), entry("ckpt-075", 75, 0.20),
                                          entry("ckpt-100", 100, 0.24)])
        self.bundles = self.tmp / "bundles"
        (self.bundles / "val").mkdir(parents=True)
        for f in ("bundle.dat", "job.json", "kernel.py"):
            (self.bundles / "val" / f).write_text("")

    def score_ckpt(self, *args):
        """score_ckpt.sh --dry-run: no gcloud call, nothing created; the plan it prints."""
        env = dict(os.environ, BUNDLES_DIR=str(self.bundles), JOB="job1", BUCKET="bkt", PROJECT="p")
        return subprocess.run(["bash", str(VM / "score_ckpt.sh"), *args, "--sets", "val", "--dry-run"],
                              capture_output=True, text=True, timeout=120, env=env)

    def test_score_ckpt_mark_best_scores_the_mark_best_json_names(self):
        r = self.score_ckpt(str(self.out), "--mark", "best")
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertIn("best mark of %s: ckpt-075 (val decision loss 0.2" % self.out, r.stdout)
        self.assertIn("checkpoint %s/ckpt-075 " % self.out, r.stdout)
        r = self.score_ckpt(str(self.out / "ckpt-100"), "--mark", "best")  # a checkpoint dir of the run stands for the run
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertIn("checkpoint %s/ckpt-075 " % self.out, r.stdout)

    def test_score_ckpt_without_mark_scores_the_checkpoint_as_given_and_a_named_mark_is_that_mark(self):
        r = self.score_ckpt(str(self.out / "ckpt-100"))
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertIn("checkpoint %s/ckpt-100 " % self.out, r.stdout)
        self.assertNotIn("best mark", r.stdout)  # ckpt-100 is the default: best is asked for, never assumed
        r = self.score_ckpt(str(self.out), "--mark", "ckpt-050")
        self.assertIn("checkpoint %s/ckpt-050 " % self.out, r.stdout)

    def test_score_ckpt_mark_best_says_so_when_there_is_no_best_json(self):
        (self.out / "best.json").unlink()
        r = self.score_ckpt(str(self.out), "--mark", "best")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("best.json is missing", r.stderr)
        self.assertIn("--mark ckpt-100", r.stderr)

    def test_score_ckpt_mark_best_on_a_bucket_run_makes_no_gcloud_call_in_a_dry_run(self):
        r = self.score_ckpt("gs://bkt/job1/out", "--mark", "best")  # a dry run makes no gcloud call: it says what it would read
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertIn("would read gs://bkt/job1/out/best.json", r.stdout)

    def test_score_ckpt_refuses_a_mark_that_is_not_a_folder_name(self):
        r = self.score_ckpt(str(self.out), "--mark", "../ckpt-100")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("a mark is a folder name", r.stderr)

    def functions(self):
        """run_job.sh's mark functions (requested_mark .. score_mark), cut out of the script: it runs a whole job when sourced."""
        text = (VM / "run_job.sh").read_text()
        m = re.search(r"^requested_mark\(\).*?^score_mark\(\) \{.*?^\}\n", text, re.S | re.M)
        self.assertIsNotNone(m, "run_job.sh: requested_mark .. score_mark not found")
        return m.group(0)

    def score_mark(self, requested="", metadata="", obj=""):
        """What run_job.sh's score_mark prints for a trainer's out dir: `requested` is the env SCORE_MARK, `metadata` the instance's
        score_mark attribute (read only when the env is empty), `obj` the content of the job's gs://.../score_mark object that
        launch.sh --score-mark writes (read last)."""
        venv = self.tmp / "venv" / "bin"
        venv.mkdir(parents=True, exist_ok=True)
        if not (venv / "python").exists():
            (venv / "python").symlink_to(sys.executable)
        script = ("set -uo pipefail\n"
                  'attr() { printf "%s" "$ATTR_SCORE_MARK"; }\n'
                  'gcs() { [ "$1" = cat ] && [ "$2" = "$GS/score_mark" ] && [ -n "$OBJ_SCORE_MARK" ] && printf "%s\\n" "$OBJ_SCORE_MARK"; }\n'
                  'say() { printf "SAY %s\\n" "$*"; }\n'
                  "OUT=" + str(self.out) + "; VENV=" + str(self.tmp / "venv") + "\n" + self.functions() + "\nscore_mark\n")
        env = {k: v for k, v in os.environ.items() if k != "SCORE_MARK"}
        env["ATTR_SCORE_MARK"] = metadata
        env["OBJ_SCORE_MARK"] = obj
        env["GS"] = "gs://bkt/job1"
        if requested:
            env["SCORE_MARK"] = requested
        return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=env, timeout=120)

    def test_the_vm_scores_final_by_default_best_when_asked_and_falls_back_loudly(self):
        r = self.score_mark()
        self.assertEqual((r.stdout.strip(), r.returncode), ("ckpt-100", 0), r.stderr)  # the default: FINAL
        self.assertEqual(self.score_mark("final").stdout.strip(), "ckpt-100")
        r = self.score_mark("best")
        self.assertEqual(r.stdout.strip(), "ckpt-075", r.stderr)
        self.assertEqual(self.score_mark("ckpt-050").stdout.strip(), "ckpt-050")
        # best.json names a checkpoint that is not on this disk: FINAL, with a WARN line
        (self.out / "best.json").write_text('{"mark": "ckpt-099"}')
        r = self.score_mark("best")
        self.assertEqual(r.stdout.strip().splitlines()[-1], "ckpt-100")
        self.assertIn("WARN: score_mark=best", r.stdout + r.stderr)
        (self.out / "best.json").unlink()
        r = self.score_mark("best")
        self.assertEqual(r.stdout.strip().splitlines()[-1], "ckpt-100")
        self.assertIn("WARN", r.stdout + r.stderr)

    def test_the_vm_reads_the_choice_when_scoring_begins_from_the_environment_the_metadata_or_the_jobs_object(self):
        self.assertEqual(self.score_mark(obj="best\n").stdout.strip(), "ckpt-075")  # launch.sh --score-mark best wrote the object
        self.assertEqual(self.score_mark(obj="ckpt-050").stdout.strip(), "ckpt-050")
        self.assertEqual(self.score_mark(obj="final").stdout.strip(), "ckpt-100")  # --score-mark final clears an earlier choice
        self.assertEqual(self.score_mark(metadata="best").stdout.strip(), "ckpt-075")
        self.assertEqual(self.score_mark(metadata="ckpt-025", obj="best").stdout.strip(), "ckpt-025")  # the metadata overrides the object
        self.assertEqual(self.score_mark(requested="ckpt-050", metadata="best", obj="best").stdout.strip(), "ckpt-050")  # the environment wins
        self.assertEqual(self.score_mark().stdout.strip(), "ckpt-100")  # nothing asked: ckpt-100


_tiny_setup = tr.ResumeTest.__dict__["setUpClass"].__func__


class MarksOnTheTinyModel(unittest.TestCase):
    """The eval loop of train.main(): four marks on the tiny model (6 steps of 2 sequences: marks at steps 2, 3, 5 and 6)."""

    # borrow the tiny-model harness of test_resume without re-collecting its tests
    setUpClass = classmethod(_tiny_setup)
    tearDownClass = classmethod(tr.ResumeTest.__dict__["tearDownClass"].__func__)
    run_once = classmethod(tr.ResumeTest.__dict__["run_once"].__func__)
    losses = staticmethod(tr.ResumeTest.__dict__["losses"].__func__)
    out = tr.ResumeTest.out
    same_params = tr.ResumeTest.same_params

    FLAGS = ["--checkpoints", CHECKPOINTS]
    NAMES = ["ckpt-025", "ckpt-050", "ckpt-075", "ckpt-100"]
    STEPS_AT = [2, 3, 5, 6]

    @classmethod
    def four(cls):
        if not hasattr(cls, "_four"):
            cls._four = cls.run_once(os.path.join(cls.tmp, "four"), *cls.FLAGS)
        return cls._four

    @staticmethod
    def read(path):
        return json.loads(Path(path).read_text(), parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))

    def test_every_mark_is_evaluated_and_written_and_best_names_the_lowest_val_decision_loss(self):
        r = self.four()
        out = r["out"]
        marks = self.read(out / "marks.json")["marks"]
        self.assertEqual(list(marks), self.NAMES)
        self.assertEqual([m["step"] for m in marks.values()], self.STEPS_AT)
        self.assertEqual([m["epoch"] for m in marks.values()], [s / 6 for s in self.STEPS_AT])
        keys = {"n", "loss", "acc", "dn", "dloss", "dacc", "oloss", "hn", "hloss", "hacc", "cn", "closs", "cacc"}
        for name, m in marks.items():
            for side in ("val", "train"):
                self.assertEqual(set(m[side]), keys, (name, side))
                self.assertTrue(all(math.isfinite(v) for v in m[side].values()), (name, side))
        # the numbers are the ones the loop evaluated at that step (the history train_meta.json keeps)
        for side in ("val", "train"):
            hist = {e["step"]: {k: v for k, v in e.items() if k != "step"} for e in r["meta"][side]}
            self.assertEqual(sorted(hist), [0] + self.STEPS_AT)
            for m in marks.values():
                self.assertEqual(m[side], hist[m["step"]])
        best = self.read(out / "best.json")
        dl = {n: m["val"]["dloss"] for n, m in marks.items()}
        want = min(dl, key=lambda n: (dl[n], -marks[n]["step"]))  # the lowest; a tie goes to the later mark
        self.assertEqual(best["mark"], want)
        self.assertEqual(best["step"], marks[want]["step"])
        self.assertEqual(best["val_dloss"], dl)
        self.assertEqual(best["val"], marks[want]["val"])
        self.assertTrue((out / want / "config.json").exists())  # best.json never names a checkpoint that is not there
        self.assertEqual(r["log"].count("BEST so far:"), 4)
        self.assertIn("BEST so far: %s (val decision loss %.4f at step %d of 6)" % (want, dl[want], marks[want]["step"]), r["log"])
        self.assertEqual((out / "FINAL").read_text().strip(), "ckpt-100")  # the default scored mark stays ckpt-100
        self.assertEqual(sorted(p.name for p in out.glob("ckpt-*")), self.NAMES)

    def test_each_checkpoint_carries_the_marks_so_far(self):
        out = self.four()["out"]
        for k, name in enumerate(self.NAMES):
            meta = self.read(out / name / "train_meta.json")
            self.assertEqual([m["mark"] for m in meta["marks"]], self.NAMES[:k + 1], name)

    def test_marks_do_not_change_the_run(self):
        r, ref = self.four(), self.ref
        self.same_params(ref["model"], r["model"])  # the evals at the extra marks are eval-mode and leave no trace
        self.assertEqual(r["steps"], ref["steps"])

    def test_a_run_without_val_writes_marks_but_no_best(self):
        r = self.run_once(self.out(), *self.FLAGS, "--val", "")
        out = r["out"]
        marks = self.read(out / "marks.json")["marks"]
        self.assertEqual(list(marks), self.NAMES)
        self.assertTrue(all(m["val"] is None and m["train"]["n"] > 0 for m in marks.values()))
        self.assertFalse((out / "best.json").exists())
        self.assertNotIn("BEST so far", r["log"])
        self.assertEqual((out / "FINAL").read_text().strip(), "ckpt-100")

    def test_resume_restores_both_files_and_the_run_ends_with_the_same_ones(self):
        ref = self.four()
        out = Path(self.out())
        first = self.run_once(out, *self.FLAGS, "--resume", "--save-every", "100",
                              hook=lambda n: os.kill(os.getpid(), signal.SIGTERM) if n == 4 * tr.BS else None)
        self.assertIn("PREEMPTED at step 4/6", first["log"])
        self.assertEqual(list(self.read(out / "marks.json")["marks"]), self.NAMES[:2])  # steps 2 and 3
        (out / "marks.json").unlink()  # a fresh disk: the files follow the restored history, not what happens to be there
        (out / "best.json").unlink()
        seen = {}

        def peek(n):
            if n == 1:  # the first forward after the restore
                seen["marks"] = list(self.read(out / "marks.json")["marks"])
                seen["best"] = self.read(out / "best.json")["mark"]
        second = self.run_once(out, *self.FLAGS, "--resume", "--save-every", "100", hook=peek)
        self.assertIn("RESUMED from", second["log"])
        self.assertEqual(seen["marks"], self.NAMES[:2])
        self.assertIn(seen["best"], self.NAMES[:2])
        for f in ("marks.json", "best.json"):  # the interrupted-and-resumed run is the uninterrupted one, to the last digit
            self.assertEqual(self.read(out / f), self.read(ref["out"] / f), f)
        self.same_params(ref["model"], second["model"])


if __name__ == "__main__":
    unittest.main()
