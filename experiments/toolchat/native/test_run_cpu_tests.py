"""Regression checks for the canonical CPU test runner."""
from __future__ import annotations

import contextlib
import io
import sys
import unittest
from unittest import mock

import run_cpu_tests


class RunnerTests(unittest.TestCase):
    def test_child_interpreters_are_isolated(self) -> None:
        completed = mock.Mock(returncode=0, stdout="ok")
        with mock.patch.object(run_cpu_tests.subprocess, "run", return_value=completed) as run:
            with contextlib.redirect_stdout(io.StringIO()):
                results = run_cpu_tests.run_all(["./test_example"], 1)
        self.assertEqual(results["./test_example"][0], 0)
        self.assertEqual(run.call_args.args[0], [
            sys.executable, "-I", run_cpu_tests.__file__, "--module", ".", "test_example",
        ])

    def test_shared_world_builders_remain_one_serial_unit(self) -> None:
        modules = ["authored/gen/test_gen", "./test_example", "authored/test_noise"]
        self.assertEqual(run_cpu_tests.jobs_of(modules), [
            ("authored/test_noise", "authored/gen/test_gen"), ("./test_example",),
        ])


if __name__ == "__main__":
    unittest.main()
