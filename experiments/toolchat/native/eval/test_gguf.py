"""The `gguf` backend of the eval driver against a stub `assist-step` (no model, no llama.cpp, no network).

    python3 -m unittest test_gguf          (needs target/debug/nativetools for the end-to-end test: it seeds a public world itself)

The stub is a few lines of Python speaking the protocol of `crates/assist-llama/src/wire.rs` (a `ready` line, then one reply line per
request line), so what is checked is this side of it: what is sent (the prompt as the `hf` backend renders it, its `dates:` line, the
limits), how a reply becomes a step, how a failure is handled, what a run record says it scored, and that `--jobs N` is N processes.
The decode itself is Rust's and is tested there (`crates/assist/src/native/step.rs`, `wire.rs`).
"""

from __future__ import annotations

import concurrent.futures as cf
import hashlib
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run
from lib import Transcript, format_call
from run import GGUFBackend, GGUFError, StepOut, run_session
from test_loop import session

STUB = """#!{python}
import json, os, sys
args = sys.argv[1:]
log = open(os.environ["STUB_LOG"], "a")
print(json.dumps({{"ready": True, "model": args[1], "threads": int(args[3]), "context": 8192}}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    log.write(json.dumps({{"pid": os.getpid(), "args": args, "request": request}}) + "\\n")
    log.flush()
    prompt = request["prompt"]
    if "BOOM" in prompt:
        print(json.dumps({{"error": "the model failed: boom"}}), flush=True)
        continue
    if "DIE" in prompt:
        os._exit(3)
    print(json.dumps({{"text": "<think>\\nintent: stub\\n</think>\\n\\n" + os.environ.get("STUB_CALL", "x"),
                      "think_cut": "CUT" in prompt, "rendered_call": True, "stopped": True, "new_tokens": 11,
                      "think_tokens": 5, "prompt_tokens": 100, "ms": 7}}), flush=True)
"""

RENDERED = "<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nhi\n\ndates: today = 2026-03-16<|im_end|>\n<|im_start|>assistant\n<think>\n"


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="test-gguf-"))
        self.addCleanup(self.cleanup)
        self.stub = self.tmp / "assist-step"
        self.stub.write_text(STUB.format(python=sys.executable))
        self.stub.chmod(self.stub.stat().st_mode | stat.S_IXUSR)
        self.model = self.tmp / "m-Q4_0.gguf"
        self.model.write_bytes(b"GGUF not really")
        self.log = self.tmp / "stub.log"
        env = mock.patch.dict(os.environ, {"STUB_LOG": str(self.log)})
        env.start()
        self.addCleanup(env.stop)
        for name in ("NATIVE_SAMPLE", "NATIVE_THINK_LIMIT", "NATIVE_MAX_NEW", run.STEP_THREADS_ENV, run.GGUF_ENV, run.STEP_BIN_ENV):
            os.environ.pop(name, None)
        for key in run.GGUF_STATS:
            run.GGUF_STATS[key] = 0

    def cleanup(self):
        run.close_step_processes()
        run._by_key().clear()
        run._IDENTITY.clear()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def backend(self, **kw) -> GGUFBackend:
        backend = GGUFBackend(str(self.model), binary=str(self.stub), **kw)
        backend.render = lambda transcript: RENDERED + ("DIE" if "DIE" in transcript.system_rendered else "") + (
            "BOOM" if "BOOM" in transcript.system_rendered else "") + ("CUT" if "CUT" in transcript.system_rendered else "")
        backend.dates_of = lambda prompt: "dates: today = 2026-03-16"
        return backend

    def requests(self) -> list[dict]:
        return [json.loads(line) for line in self.log.read_text().splitlines()]


def transcript(marker: str = "") -> Transcript:
    return Transcript("<|im_start|>system\nS" + marker + "<|im_end|>\n")


class Request(Case):
    def test_the_prompt_the_dates_line_and_the_phones_limits_are_sent(self):
        out = self.backend().step(transcript(), {})
        self.assertIsInstance(out, StepOut)
        (seen,) = self.requests()
        self.assertEqual(seen["request"], {"prompt": RENDERED, "dates": "dates: today = 2026-03-16"})

    def test_the_limits_of_the_environment_are_forwarded_and_only_those(self):
        with mock.patch.dict(os.environ, {"NATIVE_THINK_LIMIT": "50", "NATIVE_MAX_NEW": "300"}):
            self.backend().step(transcript(), {})
        self.assertEqual(self.requests()[0]["request"]["think_limit"], 50)
        self.assertEqual(self.requests()[0]["request"]["max_new"], 300)

    def test_the_reply_is_the_step(self):
        out = self.backend().step(transcript(), {})
        self.assertEqual(out["text"], "<think>\nintent: stub\n</think>\n\nx")
        self.assertFalse(out["think_cut"])
        self.assertTrue(self.backend().step(transcript("CUT"), {})["think_cut"])
        self.assertEqual(run.GGUF_STATS["steps"], 2)
        self.assertEqual((run.GGUF_STATS["ms"], run.GGUF_STATS["prompt_tokens"], run.GGUF_STATS["new_tokens"]), (14, 200, 22))

    def test_it_cannot_sample(self):
        self.assertIsNone(self.backend().resample(transcript(), {}, "<tool_call>"))
        with mock.patch.dict(os.environ, {"NATIVE_SAMPLE": "1"}), self.assertRaises(SystemExit):
            GGUFBackend(str(self.model), binary=str(self.stub))


class Naming(Case):
    def test_the_name_says_which_file_was_scored(self):
        digest = hashlib.sha256(self.model.read_bytes()).hexdigest()
        self.assertEqual(self.backend().name, f"gguf:m-Q4_0.gguf@{digest[:12]}")
        self.model.write_bytes(b"GGUF another")
        run._IDENTITY.clear()
        self.assertNotEqual(self.backend().name.split("@")[1], digest[:12])

    def test_the_tools_block_is_the_one_the_model_was_trained_on(self):
        self.assertEqual(self.backend().tools_mode, "sig")

    def test_a_missing_model_or_binary_is_named(self):
        with self.assertRaises(SystemExit) as why:
            GGUFBackend(str(self.tmp / "nowhere.gguf"), binary=str(self.stub))
        self.assertIn("no such file", str(why.exception))
        with self.assertRaises(SystemExit) as why:
            GGUFBackend(None, binary=str(self.stub))
        self.assertIn(run.GGUF_ENV, str(why.exception))
        with mock.patch.dict(os.environ, {"CARGO_TARGET_DIR": str(self.tmp / "none")}), mock.patch.object(run, "REPO", self.tmp):
            with self.assertRaises(SystemExit) as why:
                run.step_binary()
            self.assertIn("cargo build --release", str(why.exception))
        with mock.patch.dict(os.environ, {run.STEP_BIN_ENV: "/x/assist-step"}):
            self.assertEqual(run.step_binary(), "/x/assist-step")

    def test_the_binary_is_found_in_the_cargo_target(self):
        built = self.tmp / "target" / "release"
        built.mkdir(parents=True)
        (built / "assist-step").write_text("")
        with mock.patch.dict(os.environ, {"CARGO_TARGET_DIR": str(self.tmp / "target")}):
            self.assertEqual(run.step_binary(), str(built / "assist-step"))

    def test_the_model_comes_from_the_environment_too(self):
        with mock.patch.dict(os.environ, {run.GGUF_ENV: str(self.model)}):
            self.assertTrue(GGUFBackend(None, binary=str(self.stub)).name.startswith("gguf:m-Q4_0.gguf@"))


class Processes(Case):
    def test_one_process_serves_many_steps(self):
        backend = self.backend()
        for _ in range(3):
            backend.step(transcript(), {})
        self.assertEqual(len({r["pid"] for r in self.requests()}), 1)
        self.assertEqual(run.GGUF_STATS["processes"], 1)

    def test_threads_default_to_the_cores_divided_by_the_jobs(self):
        cores = len(os.sched_getaffinity(0))
        self.assertEqual(self.backend(jobs=1).threads, cores)
        self.assertEqual(self.backend(jobs=cores * 2).threads, 1)
        with mock.patch.dict(os.environ, {run.STEP_THREADS_ENV: "3"}):
            self.assertEqual(self.backend(jobs=cores * 2).threads, 3)
        self.backend(threads=2).step(transcript(), {})
        self.assertEqual(self.requests()[0]["args"], ["--model", str(self.model), "--threads", "2"])

    def test_each_worker_thread_gets_its_own_process(self):
        barrier = __import__("threading").Barrier(2)

        def work(_):
            backend = self.backend(jobs=2)
            backend.step(transcript(), {})
            barrier.wait(timeout=20)  # both are inside the pool at once, so neither can have taken the other's thread
            backend.step(transcript(), {})

        with cf.ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(work, range(2)))
        self.assertEqual(len({r["pid"] for r in self.requests()}), 2)
        self.assertEqual(run.GGUF_STATS["processes"], 2)

    def test_an_error_reply_fails_the_step_and_the_process_carries_on(self):
        backend = self.backend()
        backend.step(transcript(), {})
        with self.assertRaises(GGUFError) as why:
            backend.step(transcript("BOOM"), {})
        self.assertIn("boom", str(why.exception))
        backend.step(transcript(), {})  # a fresh process: the failure dropped the old one
        self.assertEqual(len({r["pid"] for r in self.requests()}), 2)

    def test_a_process_that_dies_is_reported_and_replaced(self):
        backend = self.backend()
        with self.assertRaises(GGUFError) as why:
            backend.step(transcript("DIE"), {})
        self.assertIn("exit 3", str(why.exception))
        self.assertEqual(backend.step(transcript(), {})["think_cut"], False)

    def test_a_binary_that_does_not_start_is_an_error_not_a_hang(self):
        broken = self.tmp / "broken"
        broken.write_text(f"#!{sys.executable}\nimport sys\nprint('{{\"error\": \"the model would not load\"}}')\nsys.exit(1)\n")
        broken.chmod(broken.stat().st_mode | stat.S_IXUSR)
        backend = self.backend()
        backend.binary = str(broken)
        with self.assertRaises(GGUFError) as why:
            backend.step(transcript(), {})
        self.assertIn("would not load", str(why.exception))


class ThroughTheDriver(Case):
    """The whole loop, with the `hf` backend's real renderer (`nativetools think`) in front of the stub."""

    def test_a_session_runs_and_the_record_names_the_file(self):
        import hf_backend

        rendered = []

        def spy(transcript):
            rendered.append(hf_backend.prompt_from_transcript(transcript))
            return rendered[-1]

        os.environ["STUB_CALL"] = format_call("answer", {"kind": "task"})
        with mock.patch.object(hf_backend, "prompt_from_transcript", spy):
            backend = GGUFBackend(str(self.model), binary=str(self.stub))
        record = run_session(session(), backend)
        self.assertEqual(record["model"], backend.name)
        self.assertEqual(record["tools_mode"], "sig")
        steps = record["turns"][0]["steps"]
        self.assertTrue(steps[-1]["response"]["ends_turn"])
        self.assertEqual(steps[0]["model"], "<think>\nintent: stub\n</think>\n\n" + os.environ["STUB_CALL"])
        # what the process was sent is what the hf backend renders, step for step
        self.assertEqual([r["request"]["prompt"] for r in self.requests()], rendered)
        # a prompt the phone's decode accepts: it ends where the model begins, and the turn's message is in it
        self.assertTrue(rendered[0].endswith("<|im_start|>assistant\n<think>\n"), rendered[0][-80:])
        self.assertIn("what tasks do i have", rendered[0])
        self.assertEqual(len(rendered), len(steps))


if __name__ == "__main__":
    unittest.main()
