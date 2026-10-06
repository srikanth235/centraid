"""Tests for the scoring options `score_ckpt.sh --fast-kernels` and `--dtype` (CPU only, no GCP, no GPU).

    HF_HUB_OFFLINE=1 python -m unittest train/test_score_opts.py

The options travel as instance metadata (score_fast_kernels, score_dtype) -> env SCORE_FAST_KERNELS / SCORE_DTYPE in run_job.sh's score
mode -> job.json (`fast_kernels`, `eval_env.NATIVE_DTYPE`) -> kernel.py. Defaults (no option) leave job.json as bundled: fast_kernels false,
no dtype. The pieces are cut out of the shell / Python sources and run as they are: the job.json preparation heredocs, the
`score_kernels_supported` shell function, the `write_score_summary` heredoc and kernel.py's `probe_args`.
"""
from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN_JOB = (HERE / "vm" / "run_job.sh").read_text()
KERNEL = (HERE / "kernel.py").read_text()


def heredoc_after(marker: str) -> str:
    """The body of the `<<'PY'` heredoc of the first line containing `marker`."""
    lines = RUN_JOB.split("\n")
    i = next(k for k, l in enumerate(lines) if marker in l and "<<'PY'" in l)
    j = next(k for k in range(i + 1, len(lines)) if lines[k] == "PY")
    return "\n".join(lines[i + 1:j])


def shell_function(name: str) -> str:
    m = re.search(r"^%s\(\) \{.*?^\}" % name, RUN_JOB, re.S | re.M)
    assert m, name
    return m.group(0)


def run_py(src: str, args: list[str], env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", src, *args], env=dict(os.environ, **env), capture_output=True, text=True)


class JobJson(unittest.TestCase):
    """The per-set (score_one) and the combined input both stamp the options into job.json."""

    def prepare_one(self, env: dict[str, str], bundled: dict) -> dict:
        with tempfile.TemporaryDirectory(dir="/dev/shm" if os.path.isdir("/dev/shm") else None) as t:
            ck, sd = Path(t, "ck"), Path(t, "sd")
            ck.mkdir()
            sd.mkdir()
            (ck / "config.json").write_text("{}")
            Path(t, "job.json").write_text(json.dumps(bundled))
            r = run_py(heredoc_after('"$x/job.json" "$sd" "$SCKPT"'), [str(Path(t, "job.json")), str(sd), str(ck)], env)
            self.assertEqual(r.returncode, 0, r.stderr)
            return json.loads((sd / "job.json").read_text())

    BUNDLED = {"model": "m", "arms": ["free"], "train": "t.jsonl", "val": "v.jsonl", "fast_kernels": True,
               "eval_env": {"PYTORCH_CUDA_ALLOC_CONF": "x"}}

    def test_default_unchanged(self):
        j = self.prepare_one({"SCORE_FAST_KERNELS": "", "SCORE_DTYPE": ""}, self.BUNDLED)
        self.assertIs(j["fast_kernels"], False)
        self.assertEqual(j["eval_env"], {"PYTORCH_CUDA_ALLOC_CONF": "x"})
        self.assertIsNone(j["train"])
        self.assertIsNone(j["val"])

    def test_options_reach_job_json(self):
        j = self.prepare_one({"SCORE_FAST_KERNELS": "1", "SCORE_DTYPE": "bfloat16"}, self.BUNDLED)
        self.assertIs(j["fast_kernels"], True)
        self.assertEqual(j["eval_env"], {"PYTORCH_CUDA_ALLOC_CONF": "x", "NATIVE_DTYPE": "bfloat16"})
        self.assertIsNone(j["train"])  # a scoring job: the probe has no data file, kernel.py falls back to the fixed passage

    def test_dtype_without_an_eval_env(self):
        j = self.prepare_one({"SCORE_DTYPE": "float16"}, {k: v for k, v in self.BUNDLED.items() if k != "eval_env"})
        self.assertEqual(j["eval_env"], {"NATIVE_DTYPE": "float16"})
        self.assertIs(j["fast_kernels"], False)

    def test_combined_build_uses_the_same_stamps(self):
        src = RUN_JOB
        self.assertIn('fast_kernels=os.environ.get("SCORE_FAST_KERNELS") == "1")', src)
        self.assertIn('job["eval_env"] = dict(job.get("eval_env") or {}, NATIVE_DTYPE=os.environ["SCORE_DTYPE"])', src)
        # the training VM's own scoring (run_scoring, score_extra) stays as it was
        self.assertEqual(src.count("fast_kernels=False"), 2)


class KernelSupportCheck(unittest.TestCase):
    def check(self, kernel_text: str, fast: str) -> int:
        with tempfile.TemporaryDirectory() as t:
            k = Path(t, "kernel.py")
            k.write_text(kernel_text)
            script = "say() { echo \"$*\"; }\n%s\nscore_kernels_supported %s\n" % (shell_function("score_kernels_supported"), k)
            return subprocess.run(["bash", "-c", script], env=dict(os.environ, SCORE_FAST_KERNELS=fast), capture_output=True).returncode

    def test_old_kernel_refused_only_when_asked(self):
        self.assertEqual(self.check("# old kernel.py\n", "1"), 1)
        self.assertEqual(self.check("# old kernel.py\n", "0"), 0)
        self.assertEqual(self.check(KERNEL, "1"), 0)


class ScoreSummary(unittest.TestCase):
    def summary(self, env: dict[str, str], job_env: dict | None, kernels: list | None) -> dict:
        with tempfile.TemporaryDirectory(dir="/dev/shm" if os.path.isdir("/dev/shm") else None) as t:
            st = Path(t, "state")
            st.mkdir()
            jd = Path(t, "job")
            jd.mkdir()
            (jd / "job.json").write_text(json.dumps({"eval_env": job_env} if job_env is not None else {}))
            if kernels is not None:
                (st / "sc-n.kernels.json").write_text(json.dumps(kernels[0]))
            r = run_py(_summary_heredoc(), ["n", "gs://b/c", str(st), "val"],
                       dict(env, JOBDIR=str(jd)))
            self.assertEqual(r.returncode, 0, r.stderr)
            return json.loads(r.stdout)

    def test_default_is_float32_without_kernels(self):
        d = self.summary({"SCORE_FAST_KERNELS": "", "SCORE_DTYPE": ""}, None, None)
        self.assertEqual(d["dtype"], "float32")
        self.assertEqual(d["fast_kernels"], {"requested": False, "kept": None})

    def test_bundle_dtype_is_reported_when_no_flag(self):
        d = self.summary({"SCORE_DTYPE": ""}, {"NATIVE_DTYPE": "float16"}, None)
        self.assertEqual(d["dtype"], "float16")

    def test_flags_are_recorded(self):
        d = self.summary({"SCORE_FAST_KERNELS": "1", "SCORE_DTYPE": "bfloat16"}, {}, [{"flash-linear-attention": True, "causal-conv1d": False}])
        self.assertEqual(d["dtype"], "bfloat16")
        self.assertEqual(d["fast_kernels"], {"requested": True, "kept": {"flash-linear-attention": True, "causal-conv1d": False}})

    def test_stale_verdicts_are_not_reported_without_the_flag(self):
        d = self.summary({"SCORE_FAST_KERNELS": "0"}, {}, [{"flash-linear-attention": True}])
        self.assertEqual(d["fast_kernels"], {"requested": False, "kept": None})


def _summary_heredoc() -> str:
    m = re.search(r'^write_score_summary\(\) \{.*?<<\'PY\'\n(.*?)^PY$', RUN_JOB, re.S | re.M)
    assert m
    return m.group(1)


class ProbeArgs(unittest.TestCase):
    """kernel.py's probe_args / PROBE_TEXT, cut out of the module (importing it runs the job)."""

    @classmethod
    def setUpClass(cls):
        tree = ast.parse(KERNEL)
        keep = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name == "probe_args")
                or (isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") in ("PROBE_TEXT", "PROBE"))]
        cls.ns = {"os": os}
        exec(compile(ast.Module(keep, []), "kernel.py", "exec"), cls.ns)

    def test_training_job_probes_its_val_then_train_file(self):
        f = self.ns["probe_args"]
        self.assertEqual(f({"val": "v.jsonl", "train": "t.jsonl"}, "/c"), ["/c/v.jsonl"])
        self.assertEqual(f({"val": None, "train": "t.jsonl"}, "/c"), ["/c/t.jsonl"])

    def test_scoring_job_probes_the_fixed_passage(self):
        a = self.ns["probe_args"]({"val": None, "train": None}, "/c")
        self.assertEqual(a, ["-", self.ns["PROBE_TEXT"]])
        self.assertGreater(len(self.ns["PROBE_TEXT"].split()), 150)  # a few hundred tokens: a real forward pass

    def test_probe_script_compiles_and_has_both_branches(self):
        src = self.ns["PROBE"]
        compile(src, "probe", "exec")
        self.assertIn('sys.argv[2] == "-"', src)
        self.assertIn("fmt.read_examples(sys.argv[2])", src)  # the training probe's call, unchanged


if __name__ == "__main__":
    unittest.main()
