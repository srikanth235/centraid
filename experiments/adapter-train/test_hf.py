import io
import json
import os
import shutil
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from adapter_train import config, hf
from test_config import job

REF = "hf://datasets/srikanth235/centraid-assist-data@v0.2"


def layout(root: Path, manifest=None):
    (root / "data").mkdir(parents=True)
    for name in ("train", "val", "test", "noise"):
        (root / "data" / ("%s.jsonl.zst" % name)).write_bytes(("rows of %s\n" % name).encode())
    (root / "manifest.json").write_text(json.dumps(manifest or {"version": "v0.2", "files": {"data/train.jsonl.zst": {"blake3": "ab"}}}))
    return root


class SecretTokenTest(unittest.TestCase):
    class Secrets:
        def __init__(self, value=None, fail=False):
            self.value, self.fail, self.asked = value, fail, []

        def get_secret_value(self, SecretId):
            self.asked.append(SecretId)
            if self.fail:
                raise RuntimeError("request had Authorization: Bearer hf_leaky")
            return {"SecretString": self.value}

    def test_the_environment_token_wins_and_no_secret_is_asked(self):
        c = self.Secrets("from-secret")
        self.assertEqual(hf.token({"HF_TOKEN": " t1 ", "HF_TOKEN_SECRET_ID": "s"}, c), "t1")
        self.assertEqual(c.asked, [])

    def test_a_secret_id_is_read_with_the_jobs_role_and_a_json_secret_is_unwrapped(self):
        self.assertEqual(hf.token({"HF_TOKEN_SECRET_ID": "arn:s"}, self.Secrets("plain\n")), "plain")
        self.assertEqual(hf.token({"HF_TOKEN_SECRET_ID": "arn:s"}, self.Secrets('{"HF_TOKEN": "inner"}')), "inner")

    def test_no_token_is_the_empty_string_and_a_failed_read_never_quotes_the_sdk(self):
        self.assertEqual(hf.token({}, None), "")
        with self.assertRaises(OSError) as cm:
            hf.token({"HF_TOKEN_SECRET_ID": "arn:s"}, self.Secrets(fail=True))
        self.assertIn("arn:s", str(cm.exception))
        self.assertIn("RuntimeError", str(cm.exception))
        self.assertNotIn("hf_leaky", str(cm.exception))


class SubsetTest(unittest.TestCase):
    def test_a_named_subset_replaces_the_train_file_and_nothing_else(self):
        self.assertEqual(hf.train_path(), "data/train.jsonl.zst")
        self.assertEqual(hf.train_path("train-1000"), "data/subsets/train-1000.jsonl.zst")

    def test_the_test_split_and_odd_names_are_never_a_subset(self):
        for bad in ("test", "noise", "val", "train", "../test", "a/b", "", "x" * 80, "-x"):
            with self.assertRaises(config.ConfigError, msg=bad):
                hf.train_path(bad)

    def test_the_subset_is_fetched_and_recorded_and_val_still_comes_from_val(self):
        tmp = Path(tempfile.mkdtemp(prefix="hf-sub-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        repo = layout(tmp / "repo")
        (repo / "data" / "subsets").mkdir()
        (repo / "data" / "subsets" / "train-1000.jsonl.zst").write_bytes(b"rows of 1000\n")
        asked = []
        inner = hf.local_fetch(repo)

        def fetch(r, rev, path, dest):
            asked.append(path)
            inner(r, rev, path, dest)

        got = hf.fetch_version(REF, tmp / "d", subset="train-1000", fetch=fetch)
        self.assertEqual(asked, ["manifest.json", "data/subsets/train-1000.jsonl.zst", "data/val.jsonl.zst"])
        self.assertEqual(got["source"]["files"], {"train": "data/subsets/train-1000.jsonl.zst", "val": "data/val.jsonl.zst"})
        self.assertEqual(got["paths"]["train"].read_bytes(), b"rows of 1000\n")

    def test_a_subset_goes_in_the_job_file_with_hf_only(self):
        base = {"name": "t", "base": {"model": "m", "revision": "b" * 40}, "checkpoints": "/c", "outputs": "/o"}
        job = config.parse({**base, "data": {"hf": REF, "subset": "train-2500"}})
        self.assertEqual(job.subset, "train-2500")
        with self.assertRaises(config.ConfigError):
            config.parse({**base, "data": {"train": "/t", "subset": "train-2500"}})
        with self.assertRaises(config.ConfigError):
            config.parse({**base, "data": {"hf": REF, "subset": "test"}})


class HfTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hf-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = layout(self.tmp / "repo")

    def asked(self, **kw):
        asked = []
        inner = hf.local_fetch(self.repo)

        def fetch(repo, revision, path, dest):
            asked.append((repo, revision, path))
            inner(repo, revision, path, dest)

        got = hf.fetch_version(REF, self.tmp / "dest", fetch=fetch, **kw)
        return got, asked

    def test_a_reference_is_a_repo_at_a_pinned_revision(self):
        self.assertEqual(hf.parse(REF), ("srikanth235/centraid-assist-data", "v0.2"))
        self.assertEqual(hf.parse("hf://datasets/o/r@" + "a" * 40)[1], "a" * 40)

    def test_a_moving_branch_or_a_malformed_reference_is_refused(self):
        for bad in ("hf://datasets/o/r@main", "hf://datasets/o/r@master", "hf://datasets/o/r", "hf://models/o/r@v1", "https://huggingface.co/x",
                    "hf://datasets/o/r@", "hf://datasets/o@v1", ""):
            with self.assertRaises(config.ConfigError, msg=bad):
                hf.parse(bad)

    def test_train_and_val_are_fetched_and_the_test_split_never_is(self):
        got, asked = self.asked()
        self.assertEqual(sorted(p for _, _, p in asked), ["data/train.jsonl.zst", "data/val.jsonl.zst", "manifest.json"])
        self.assertNotIn("test", " ".join(p for _, _, p in asked))
        self.assertNotIn("noise", " ".join(p for _, _, p in asked))
        self.assertEqual(got["paths"]["train"].read_bytes(), b"rows of train\n")
        self.assertEqual(set(hf.FILES), {"train", "val"})
        self.assertFalse((self.tmp / "dest" / "data" / "test.jsonl.zst").exists())

    def test_without_val_only_train_is_asked_for(self):
        got, asked = self.asked(with_val=False)
        self.assertEqual(set(got["paths"]), {"train"})
        self.assertNotIn("data/val.jsonl.zst", [p for _, _, p in asked])

    def test_the_source_keeps_the_repo_revision_and_the_manifest_with_its_hash(self):
        got, _ = self.asked()
        src = got["source"]
        self.assertEqual((src["repo"], src["revision"]), ("srikanth235/centraid-assist-data", "v0.2"))
        self.assertEqual(src["manifest"]["files"]["data/train.jsonl.zst"]["blake3"], "ab")
        self.assertEqual(src["manifest_sha256"], __import__("hashlib").sha256((self.repo / "manifest.json").read_bytes()).hexdigest())
        json.dumps(src)  # it goes into the run record

    def test_a_missing_file_or_a_manifest_that_is_not_json_is_an_error(self):
        (self.repo / "manifest.json").write_text("{nope")
        with self.assertRaisesRegex(config.ConfigError, "not JSON"):
            hf.fetch_version(REF, self.tmp / "d1", fetch=hf.local_fetch(self.repo))
        (self.repo / "manifest.json").write_text("{}")
        (self.repo / "data" / "val.jsonl.zst").unlink()
        with self.assertRaises(OSError):
            hf.fetch_version(REF, self.tmp / "d2", fetch=hf.local_fetch(self.repo))


class TokenTest(unittest.TestCase):
    """The token is a header, from the environment, and never in a message. urlopen is replaced: no network is touched."""

    def test_the_token_is_sent_as_a_bearer_header_and_only_there(self):
        seen = []

        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def urlopen(request, timeout=0):
            seen.append(request)
            return Resp(b"data")

        d = Path(tempfile.mkdtemp(prefix="hf-token-"))
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        with mock.patch.dict(os.environ, {"HF_TOKEN": "hf_secret_value"}), mock.patch("urllib.request.urlopen", urlopen):
            hf.https_fetch("o/r", "v1", "manifest.json", d / "m.json")
        self.assertEqual(seen[0].get_header("Authorization"), "Bearer hf_secret_value")
        self.assertEqual(seen[0].full_url, "https://huggingface.co/datasets/o/r/resolve/v1/manifest.json")
        self.assertEqual((d / "m.json").read_bytes(), b"data")

    def test_a_refusal_names_the_file_and_not_the_token(self):
        def urlopen(request, timeout=0):
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {"Authorization": "Bearer hf_secret_value"}, None)

        d = Path(tempfile.mkdtemp(prefix="hf-token-"))
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        with mock.patch.dict(os.environ, {"HF_TOKEN": "hf_secret_value"}), mock.patch("urllib.request.urlopen", urlopen):
            with self.assertRaises(OSError) as ctx:
                hf.https_fetch("o/r", "v1", "data/train.jsonl.zst", d / "t")
        self.assertIn("401", str(ctx.exception))
        self.assertIn("o/r@v1", str(ctx.exception))
        self.assertNotIn("hf_secret_value", str(ctx.exception))
        self.assertNotIn("hf_secret_value", repr(ctx.exception.__cause__))

    def test_no_token_is_said_in_words_and_the_job_file_has_no_place_for_one(self):
        def urlopen(request, timeout=0):
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)

        d = Path(tempfile.mkdtemp(prefix="hf-token-"))
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        env = {k: v for k, v in os.environ.items() if k != "HF_TOKEN"}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch("urllib.request.urlopen", urlopen):
            with self.assertRaisesRegex(OSError, "no HF_TOKEN or HF_TOKEN_SECRET_ID is set"):
                hf.https_fetch("o/r", "v1", "manifest.json", d / "m")
        for key in ("token", "hf_token", "HF_TOKEN"):
            with self.assertRaises(config.ConfigError):
                config.parse(job(data={"hf": REF, key: "x"}))


class ConfigHfTest(unittest.TestCase):
    def test_a_job_may_name_a_data_version_instead_of_two_locations(self):
        j = config.parse(job(data={"hf": REF}))
        self.assertEqual((j.hf, j.train, j.val, j.with_val), (REF, None, None, True))

    def test_the_two_forms_do_not_mix_and_a_branch_is_refused(self):
        for data in ({"hf": REF, "train": "x"}, {"hf": REF, "val": "x"}, {"hf": "hf://datasets/o/r@main"}, {"train": "x", "with_val": False}):
            with self.assertRaises(config.ConfigError, msg=str(data)):
                config.parse(job(data=data))

    def test_eval_every_needs_a_val_set_from_either_form(self):
        config.parse(job(data={"hf": REF}, train={"eval_every": 5}))
        with self.assertRaises(config.ConfigError):
            config.parse(job(data={"hf": REF, "with_val": False}, train={"eval_every": 5}))


if __name__ == "__main__":
    unittest.main()
