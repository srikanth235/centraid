import argparse
import ast
import io
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from launchers import common, gcp, sagemaker

HERE = Path(__file__).resolve().parent
ECR = "123456789012.dkr.ecr.us-east-1.amazonaws.com/adapter-train:abc123"
ROLE = "arn:aws:iam::123456789012:role/sagemaker-train"


def run_cli(module, argv):
    """Parse like the launcher's command line does; nothing is ever submitted from a test."""
    def boom(*a):
        raise AssertionError("a launcher test must never submit")

    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = common.cli(module.request, boom, argv, extra=module.extras())
    return code, out.getvalue(), err.getvalue()


class LaunchersTest(unittest.TestCase):
    def test_sagemaker_asks_for_managed_spot_on_one_a10g_and_runs_the_one_command(self):
        code, out, err = run_cli(sagemaker, ["--config", "s3://bkt/run/job.json", "--image", ECR, "--role", ROLE])
        self.assertEqual(code, 0)
        self.assertIn("not submitted", err)
        import json

        req = json.loads(out)
        self.assertTrue(req["EnableManagedSpotTraining"])
        self.assertEqual(req["ResourceConfig"]["InstanceType"], "ml.g5.xlarge")
        self.assertEqual(req["AlgorithmSpecification"]["ContainerEntrypoint"], ["python", "-m", "adapter_train"])
        self.assertEqual(req["AlgorithmSpecification"]["ContainerArguments"], ["train", "--config", "s3://bkt/run/job.json"])
        self.assertGreater(req["StoppingCondition"]["MaxWaitTimeInSeconds"], req["StoppingCondition"]["MaxRuntimeInSeconds"])
        self.assertNotIn("CheckpointConfig", req)  # the container resumes from the job file's checkpoints itself
        self.assertEqual(sagemaker.REGION, "us-east-1")

    def test_sagemaker_refuses_what_it_cannot_run(self):
        for argv in (["--config", "gs://b/j.json", "--image", ECR, "--role", ROLE],
                     ["--config", "s3://b/j.json", "--image", "docker.io/x/y", "--role", ROLE],
                     ["--config", "s3://b/j.json", "--image", ECR, "--role", "nobody"]):
            with self.assertRaises(SystemExit):
                run_cli(sagemaker, argv)

    def test_gcp_asks_for_spot_with_restart_and_the_same_command(self):
        import json

        _, out, _ = run_cli(gcp, ["--config", "gs://bkt/job.json", "--image", "us-docker.pkg.dev/p/r/adapter-train:abc", "--project", "p"])
        spec = json.loads(out)["jobSpec"]
        self.assertEqual(spec["scheduling"]["strategy"], "SPOT")
        self.assertTrue(spec["scheduling"]["restartJobOnWorkerRestart"])
        c = spec["workerPoolSpecs"][0]["containerSpec"]
        self.assertEqual(c["args"], ["train", "--config", "gs://bkt/job.json"])
        with self.assertRaises(SystemExit):
            run_cli(gcp, ["--config", "s3://bkt/job.json", "--image", "i", "--project", "p"])

    def test_job_names_fit_the_platforms(self):
        self.assertEqual(common.job_name("adapter_v1.2"), "adapter-v1-2")
        self.assertLessEqual(len(common.job_name("x" * 200, "r1")), 63)
        self.assertTrue(common.job_name("x" * 200, "r1").endswith("-r1"))
        self.assertEqual(common.job_name("---"), "adapter-train")

    def test_the_modal_file_is_thin_and_asks_for_an_a10g(self):
        src = (HERE / "launchers" / "modal_app.py").read_text()
        ast.parse(src)
        self.assertIn('gpu="A10G"', src)
        self.assertIn("adapter_train", src)
        self.assertLess(len(src.splitlines()), 40)  # the launcher stays a thin file

    def test_no_launcher_submits_at_import_or_without_the_flag(self):
        for name in ("sagemaker", "gcp", "modal_app"):
            tree = ast.parse((HERE / "launchers" / ("%s.py" % name)).read_text())
            top = [n for n in tree.body if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)]
            self.assertEqual(top, [], name)  # nothing runs at import: only definitions and the __main__ guard


if __name__ == "__main__":
    unittest.main()
