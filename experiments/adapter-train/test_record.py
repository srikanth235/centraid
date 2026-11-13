import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from adapter_train import config, record
from test_config import job


class RecordTest(unittest.TestCase):
    def test_the_record_names_its_inputs_and_has_no_clock_host_or_path(self):
        j = config.parse(job())
        tmp = Path(tempfile.mkdtemp(prefix="record-test-"))
        f = tmp / "train.jsonl"
        f.write_bytes(b"abc\n")
        with mock.patch.dict(os.environ, {"CENTRAID_GIT_COMMIT": "c" * 40}):
            rec = record.build(j, data={"train": record.data_entry("s3://b/train.jsonl.zst", f)}, resumed_from=None, device="cpu")
        self.assertEqual(rec["git_commit"], "c" * 40)
        self.assertEqual(rec["base"]["revision"], "a" * 40)
        self.assertEqual(rec["job_sha256"], j.digest())
        self.assertEqual(rec["data"]["train"]["sha256"], "edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb")
        self.assertEqual(rec["data"]["train"]["bytes"], 4)
        self.assertIn("torch", rec["packages"])
        text = record.dumps(rec)
        self.assertNotIn(str(tmp), text)
        self.assertEqual(json.loads(text), rec)
        for forbidden in ("time", "host", "date"):
            self.assertNotIn(forbidden, " ".join(rec).lower())

    def test_without_a_commit_the_record_says_unknown_rather_than_guessing(self):
        with mock.patch.dict(os.environ, {"CENTRAID_GIT_COMMIT": ""}):
            self.assertEqual(record.git_commit(Path(tempfile.mkdtemp())), "unknown")

    def test_finish_adds_the_outcome_and_keeps_the_start(self):
        done = record.finish({"a": 1}, steps=5, metrics={"val_loss": 1.5}, adapter_files={"adapter/x": "h"})
        self.assertEqual((done["a"], done["steps_done"], done["metrics"]["val_loss"]), (1, 5, 1.5))


if __name__ == "__main__":
    unittest.main()
