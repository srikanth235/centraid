"""artefacts.py, offline: the manifest, check, fetch, upload and the JSON layout (#1088, R-1088-14).

    python3 -m unittest test_artefacts -v      # from experiments/toolchat/native

Nothing here touches the network or the files of this directory that the manifest describes: the trees are built in temporary
directories, and the Hub is a fake that replaces `artefacts.hub_client`. A test that the real calls exist reads the
signatures of the pinned `huggingface_hub`, which the runner's environment has (transformers needs it).
"""

from __future__ import annotations

import contextlib
import hashlib
import inspect
import io
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import artefacts as art

TOKEN = "hf_not_a_real_token_0123456789"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


BUILDER = (
    "import pathlib, sys\n"
    "pathlib.Path('builds.log').open('a').write(sys.argv[1] + '\\n')\n"
    "out = pathlib.Path(sys.argv[1])\n"
    "out.parent.mkdir(parents=True, exist_ok=True)\n"
    "out.write_text(sys.argv[2].replace('\\\\n', '\\n'))\n"  # a backslash-n in the argument is a newline
)


class FakeHub:
    """The Hub in a dict: what the tool asked of it is in `state`."""

    def __init__(self, token: str, state: "HubState"):
        self.state = state
        state.tokens.append(token)

    def repo_private(self, repo):
        found = self.state.repos.get(repo)
        return None if found is None else found["private"]

    def create_private(self, repo):
        self.state.repos[repo] = {"private": True, "commits": {}}
        self.state.created.append(repo)

    def commit(self, repo, files, message):
        content = {dest: src.read_bytes() for dest, src in files.items()}
        revision = sha(json.dumps(sorted((k, sha(v)) for k, v in content.items())).encode())[:40]
        self.state.repos[repo]["commits"][revision] = content
        self.state.commits.append((repo, sorted(files), message))
        return revision

    def download(self, repo, revision, path_in_repo, into):
        if self.state.boom:
            raise RuntimeError(f"401 for token {self.state.boom}")
        data = self.state.repos[repo]["commits"][revision][path_in_repo]
        if self.state.tamper:
            data = data + b"!"
        target = into / path_in_repo
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target


class HubState:
    def __init__(self):
        self.repos: dict = {}
        self.tokens: list = []
        self.created: list = []
        self.commits: list = []
        self.boom: str | None = None
        self.tamper = False


class Case(unittest.TestCase):
    """A directory with a builder and a manifest of two rebuilt files and two Hub files."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "tree"
        self.root.mkdir()
        (self.root / "build.py").write_text(BUILDER)
        self.hub = HubState()
        patch = mock.patch.object(art, "hub_client", lambda token: FakeHub(token, self.hub))
        patch.start()
        self.addCleanup(patch.stop)
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(art.HF_ENV, None)
        self.files = {"out/a.txt": b"alpha\n", "out/b.txt": b"beta\n", "sets/val.jsonl": b'{"id": 1}\n', "keys/k.json": b"{}\n"}
        self.manifest_path = Path(self.tmp.name) / "artefacts.json"
        rows = [
            self.row("a", "out/a.txt", rebuild="python3 build.py out/a.txt 'alpha\\n'"),
            self.row("b", "out/b.txt", rebuild="python3 build.py out/b.txt 'beta\\n'"),
            self.row("val", "sets/val.jsonl", hub=self.hubref("sets/val.jsonl")),
            self.row("k", "keys/k.json", hub=self.hubref("keys/k.json")),
        ]
        art.save({"schema": 1, "files": rows}, self.manifest_path)

    def row(self, name, path, **how):
        data = self.files[path]
        return {"name": name, "path": path, "sha256": sha(data), "size": len(data), "from": "a test", **how}

    @staticmethod
    def hubref(path, repo=art.PLACEHOLDER, revision=art.PLACEHOLDER):
        return {"repo": repo, "revision": revision, "path": path}

    def put(self, path):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.files[path])

    def put_all(self):
        for path in self.files:
            self.put(path)

    def run_tool(self, *argv, token=None):
        if token:
            os.environ[art.HF_ENV] = token
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = art.main(["--manifest", str(self.manifest_path), "--root", str(self.root), *argv])
        return code, out.getvalue() + err.getvalue()

    def manifest(self):
        return json.loads(self.manifest_path.read_text())

    def pin_hub(self, revision="r1", repo="o/n"):
        """Record that the Hub files were uploaded, and put them on the fake Hub."""
        manifest = self.manifest()
        for e in manifest["files"]:
            if "hub" in e:
                e["hub"] = self.hubref(e["path"], repo, revision)
        art.save(manifest, self.manifest_path)
        self.hub.repos[repo] = {"private": True, "commits": {revision: {p: self.files[p] for p in ("sets/val.jsonl", "keys/k.json")}}}


class TheShippedManifest(unittest.TestCase):
    def test_it_is_well_formed(self):
        self.assertEqual(art.problems_in(art.load()), [])

    def test_a_keys_file_comes_after_its_world(self):
        """A rebuild runs in manifest order, and `seed_worlds.py` seeds from the world JSON."""
        order = [e["name"] for e in art.entries(art.load())]
        for name in order:
            if name.startswith("keys/") and "rebuild" in next(e for e in art.entries(art.load()) if e["name"] == name):
                self.assertLess(order.index("world/" + name[5:]), order.index(name), name)

    def test_its_hashes_agree_with_the_documents_that_record_them(self):
        """eval/FROZEN.md and data/README.md say which bytes were scored and trained on; the manifest must say the same."""
        recorded = (art.HERE / "eval" / "FROZEN.md").read_text() + (art.HERE / "data" / "README.md").read_text()
        for e in art.entries(art.load()):
            if e["name"] in ("set/val", "set/test", "set/trainfit", "set/split", "data/train", "data/train-val"):
                self.assertIn(e["sha256"], recorded, e["name"])

    def test_every_regenerable_file_names_a_builder_that_exists(self):
        for e in art.entries(art.load()):
            if "rebuild" in e:
                script = re.match(r"python3 (\S+\.py)", e["rebuild"]).group(1)
                self.assertTrue((art.HERE / script).is_file(), f"{e['name']}: {script}")

    def test_the_hub_files_are_the_frozen_ones(self):
        hub = {e["name"].split("/")[0] for e in art.entries(art.load()) if "hub" in e}
        self.assertEqual(hub, {"set", "data", "keys"})

    def test_the_gitignore_block_has_one_line_per_file(self):
        block = art.gitignore_block(art.load()).splitlines()
        self.assertEqual((block[0], block[-1]), (art.IGNORE_BEGIN, art.IGNORE_END))
        self.assertEqual(len(block) - 2, len(art.entries(art.load())))
        self.assertTrue(all(line.startswith("/") for line in block[1:-1]))


class Validation(Case):
    def test_a_file_is_either_rebuilt_or_on_the_hub(self):
        manifest = self.manifest()
        manifest["files"][0]["hub"] = self.hubref("out/a.txt")
        del manifest["files"][2]["hub"]
        self.assertEqual(len(art.problems_in(manifest)), 2)

    def test_names_and_paths_are_unique_and_the_hash_is_hex(self):
        manifest = self.manifest()
        manifest["files"][1]["name"] = "a"
        manifest["files"][1]["path"] = "out/a.txt"
        manifest["files"][3]["sha256"] = "XYZ"
        text = " ".join(art.problems_in(manifest))
        self.assertIn("name used twice", text)
        self.assertIn("path out/a.txt used twice", text)
        self.assertIn("sha256 is not 64", text)

    def test_a_path_cannot_leave_the_directory(self):
        manifest = self.manifest()
        manifest["files"][0]["path"] = "../x"
        self.assertIn("not relative", " ".join(art.problems_in(manifest)))


class Check(Case):
    def test_all_present_and_matching(self):
        self.put_all()
        code, out = self.run_tool("check")
        self.assertEqual(code, 0, out)
        self.assertIn("4 of 4 files match", out)

    def test_a_missing_file_fails_and_names_the_remedy(self):
        self.put_all()
        (self.root / "out/a.txt").unlink()
        code, out = self.run_tool("check")
        self.assertEqual(code, 1)
        self.assertIn("FAIL out/a.txt: missing", out)
        self.assertIn("artefacts.py fetch", out)

    def test_a_changed_byte_fails_even_at_the_same_size(self):
        self.put_all()
        (self.root / "out/a.txt").write_bytes(b"alphA\n")
        code, out = self.run_tool("check")
        self.assertEqual(code, 1)
        self.assertIn("sha256 differs", out)

    def test_a_changed_size_fails(self):
        self.put_all()
        (self.root / "sets/val.jsonl").write_bytes(b"{}")
        self.assertIn("size 2", self.run_tool("check")[1])


class FetchRebuild(Case):
    def builds(self):
        log = self.root / "builds.log"
        return log.read_text().split() if log.exists() else []

    def test_it_rebuilds_what_is_missing_and_verifies_it(self):
        code, out = self.run_tool("fetch", "--rebuild-only")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.root / "out/a.txt").read_bytes(), self.files["out/a.txt"])
        self.assertEqual(sorted(self.builds()), ["out/a.txt", "out/b.txt"])
        self.assertIn("2 Hub file(s) left alone", out)

    def test_a_second_run_rebuilds_nothing(self):
        self.run_tool("fetch", "--rebuild-only")
        self.run_tool("fetch", "--rebuild-only")
        self.assertEqual(len(self.builds()), 2)

    def test_one_command_for_several_files_runs_once(self):
        manifest = self.manifest()
        both = manifest["files"][0]["rebuild"] + " && " + manifest["files"][1]["rebuild"]
        manifest["files"][0]["rebuild"] = manifest["files"][1]["rebuild"] = both
        art.save(manifest, self.manifest_path)
        code, _ = self.run_tool("fetch", "--rebuild-only")
        self.assertEqual(code, 0)
        self.assertEqual(self.builds().count("out/a.txt"), 1)

    def test_bytes_that_differ_fail_and_are_named(self):
        manifest = self.manifest()
        manifest["files"][0]["rebuild"] = "python3 build.py out/a.txt 'alphX\\n'"
        art.save(manifest, self.manifest_path)
        code, out = self.run_tool("fetch", "--rebuild-only")
        self.assertEqual(code, 1)
        self.assertIn("out/a.txt: rebuilt, but sha256 differs", out)
        self.assertIn("no longer reproduces", out)

    def test_a_failing_command_shows_its_tail(self):
        manifest = self.manifest()
        manifest["files"][0]["rebuild"] = "echo no builder here >&2; exit 3"
        art.save(manifest, self.manifest_path)
        code, out = self.run_tool("fetch", "--rebuild-only")
        self.assertEqual(code, 1)
        self.assertIn("exited 3", out)
        self.assertIn("no builder here", out)

    def test_a_file_that_differs_is_not_overwritten_without_force(self):
        self.put("out/a.txt")
        (self.root / "out/a.txt").write_bytes(b"edited\n")
        code, out = self.run_tool("fetch", "--rebuild-only")
        self.assertEqual(code, 1)
        self.assertIn("--force replaces it", out)
        self.assertEqual((self.root / "out/a.txt").read_bytes(), b"edited\n")
        code, _ = self.run_tool("fetch", "--rebuild-only", "--force")
        self.assertEqual(code, 0)
        self.assertEqual((self.root / "out/a.txt").read_bytes(), self.files["out/a.txt"])

    def test_only_narrows_by_name_or_path_prefix(self):
        self.run_tool("fetch", "--rebuild-only", "--only", "a")
        self.assertEqual(self.builds(), ["out/a.txt"])
        self.run_tool("fetch", "--rebuild-only", "--only", "out/b")
        self.assertEqual(sorted(self.builds()), ["out/a.txt", "out/b.txt"])

    def test_the_command_sees_a_scratch_directory_that_is_removed(self):
        manifest = self.manifest()
        manifest["files"][0]["rebuild"] = 'test -d "$ARTEFACTS_TMP" && echo "$ARTEFACTS_TMP" > where.txt && python3 build.py out/a.txt \'alpha\\n\''
        art.save(manifest, self.manifest_path)
        self.assertEqual(self.run_tool("fetch", "--rebuild-only")[0], 0)
        self.assertFalse(Path((self.root / "where.txt").read_text().strip()).exists())

    def test_a_dry_run_writes_nothing(self):
        code, out = self.run_tool("fetch", "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn("would rebuild  python3 build.py out/a.txt", out)
        self.assertIn("would download sets/val.jsonl", out)
        self.assertIn("the upload has not run", out)
        self.assertFalse(list(self.root.glob("out*")) or list(self.root.glob("sets*")))
        self.assertEqual(self.hub.tokens, [])


class FetchHub(Case):
    def test_before_the_upload_a_real_fetch_stops(self):
        code, out = self.run_tool("fetch", token=TOKEN)
        self.assertEqual(code, 1)
        self.assertIn("upload has not run", out)
        self.assertEqual(self.hub.tokens, [])
        self.assertFalse((self.root / "out/a.txt").exists())

    def test_without_a_token_it_says_so_and_how_to_go_without(self):
        self.pin_hub()
        code, out = self.run_tool("fetch")
        self.assertEqual(code, 1)
        self.assertIn("HF_TOKEN is not set", out)
        self.assertIn("--rebuild-only", out)

    def test_it_downloads_at_the_recorded_revision_and_verifies(self):
        self.pin_hub()
        code, out = self.run_tool("fetch", token=TOKEN)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.hub.tokens, [TOKEN])
        for path in self.files:
            self.assertEqual((self.root / path).read_bytes(), self.files[path])
        self.assertEqual(self.run_tool("check")[0], 0)
        self.assertEqual(list(self.root.rglob("*.part")), [])

    def test_wrong_bytes_from_the_hub_leave_nothing_at_the_path(self):
        self.pin_hub()
        self.hub.tamper = True
        code, out = self.run_tool("fetch", "--only", "val", token=TOKEN)
        self.assertEqual(code, 1)
        self.assertIn("do not match the manifest", out)
        self.assertFalse((self.root / "sets/val.jsonl").exists())
        self.assertEqual(list(self.root.rglob("*.part")), [])

    def test_the_token_is_scrubbed_from_a_hub_error(self):
        self.pin_hub()
        self.hub.boom = TOKEN
        code, out = self.run_tool("fetch", "--only", "val", token=TOKEN)
        self.assertEqual(code, 1)
        self.assertIn("download failed: RuntimeError", out)
        self.assertNotIn(TOKEN, out)

    def test_a_dry_run_with_a_recorded_revision_names_it(self):
        self.pin_hub(revision="abc123")
        code, out = self.run_tool("fetch", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("from o/n@abc123", out)
        self.assertNotIn("the upload has not run", out)
        self.assertEqual(self.hub.tokens, [])


class Upload(Case):
    def test_a_dry_run_lists_the_hub_files_with_sizes_and_sends_nothing(self):
        self.put_all()
        code, out = self.run_tool("upload", "--repo", "o/n", "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn("2 file(s)", out)
        self.assertIn("sets/val.jsonl", out)
        self.assertIn("keys/k.json", out)
        self.assertNotIn("out/a.txt", out)
        self.assertEqual((self.hub.tokens, self.hub.commits, self.hub.created), ([], [], []))

    def test_it_creates_a_private_repository_commits_once_and_records_the_revision(self):
        self.put_all()
        code, out = self.run_tool("upload", "--repo", "o/n", token=TOKEN)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.hub.created, ["o/n"])
        self.assertEqual(len(self.hub.commits), 1)
        self.assertEqual(self.hub.commits[0][:2], ("o/n", ["keys/k.json", "sets/val.jsonl"]))
        revision = next(iter(self.hub.repos["o/n"]["commits"]))
        by_name = {e["name"]: e for e in self.manifest()["files"]}
        self.assertEqual(by_name["val"]["hub"], {"repo": "o/n", "revision": revision, "path": "sets/val.jsonl"})
        self.assertEqual(by_name["k"]["hub"]["revision"], revision)
        self.assertNotIn("hub", by_name["a"])
        self.assertIn(revision, out)

    def test_an_upload_then_a_fetch_round_trips(self):
        self.put_all()
        self.assertEqual(self.run_tool("upload", "--repo", "o/n", token=TOKEN)[0], 0)
        for path in ("out/a.txt", "out/b.txt", "sets/val.jsonl", "keys/k.json"):
            (self.root / path).unlink()
        code, out = self.run_tool("fetch", token=TOKEN)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.run_tool("check")[0], 0)

    def test_it_refuses_a_public_repository(self):
        self.put_all()
        self.hub.repos["o/n"] = {"private": False, "commits": {}}
        code, out = self.run_tool("upload", "--repo", "o/n", token=TOKEN)
        self.assertEqual(code, 1)
        self.assertIn("exists and is public", out)
        self.assertEqual(self.hub.commits, [])
        self.assertEqual(self.manifest()["files"][2]["hub"]["revision"], art.PLACEHOLDER)

    def test_it_uses_an_existing_private_repository(self):
        self.put_all()
        self.hub.repos["o/n"] = {"private": True, "commits": {}}
        self.assertEqual(self.run_tool("upload", "--repo", "o/n", token=TOKEN)[0], 0)
        self.assertEqual(self.hub.created, [])

    def test_it_needs_the_token_and_only_from_the_environment(self):
        self.put_all()
        code, out = self.run_tool("upload", "--repo", "o/n")
        self.assertEqual(code, 1)
        self.assertIn("HF_TOKEN is not set", out)

    def test_it_sends_the_pinned_bytes_or_nothing(self):
        self.put_all()
        (self.root / "sets/val.jsonl").write_bytes(b'{"id": 2}\n')
        code, out = self.run_tool("upload", "--repo", "o/n", token=TOKEN)
        self.assertEqual(code, 1)
        self.assertIn("sets/val.jsonl: sha256 differs", out)
        self.assertEqual(self.hub.commits, [])

    def test_a_missing_file_is_not_uploaded_around(self):
        self.put_all()
        (self.root / "keys/k.json").unlink()
        code, out = self.run_tool("upload", "--repo", "o/n", token=TOKEN)
        self.assertEqual(code, 1)
        self.assertIn("keys/k.json: missing", out)

    def test_the_token_reaches_neither_the_output_nor_any_file(self):
        self.put_all()
        _, out = self.run_tool("upload", "--repo", "o/n", token=TOKEN)
        self.assertNotIn(TOKEN, out)
        for path in Path(self.tmp.name).rglob("*"):
            if path.is_file():
                self.assertNotIn(TOKEN.encode(), path.read_bytes(), str(path))


class VerifyHub(Case):
    def test_it_downloads_each_file_at_its_revision(self):
        self.pin_hub()
        code, out = self.run_tool("verify-hub", token=TOKEN)
        self.assertEqual(code, 0, out)
        self.assertIn("2 of 2 Hub file(s) match", out)
        self.assertFalse((self.root / "sets").exists())  # a check, not a fetch

    def test_it_fails_on_other_bytes(self):
        self.pin_hub()
        self.hub.tamper = True
        self.assertEqual(self.run_tool("verify-hub", token=TOKEN)[0], 1)

    def test_it_stops_before_the_upload(self):
        self.assertEqual(self.run_tool("verify-hub", token=TOKEN)[0], 1)


class Paths(Case):
    def test_the_class_filter(self):
        self.assertEqual(self.run_tool("paths")[1].split(), ["out/a.txt", "out/b.txt", "sets/val.jsonl", "keys/k.json"])
        self.assertEqual(self.run_tool("paths", "--class", "hub")[1].split(), ["sets/val.jsonl", "keys/k.json"])


class JsonLayout(unittest.TestCase):
    """The repository formatter's layout of the JSON the world builders write."""

    def test_a_compact_source_collapses_what_fits(self):
        self.assertEqual(art.format_json('{"a":[1,2,3],"b":{"c":"d"}}'), '{ "a": [1, 2, 3], "b": { "c": "d" } }\n')

    def test_an_object_the_source_broke_stays_broken_and_one_it_did_not_collapses(self):
        out = art.format_json('{\n "a": [1, 2],\n "b": {"c": "d"}\n}')
        self.assertEqual(out, '{\n  "a": [1, 2],\n  "b": { "c": "d" }\n}\n')

    def test_what_does_not_fit_in_80_columns_breaks_one_element_to_a_line(self):
        item = '"' + "x" * 20 + '"'
        out = art.format_json(json.dumps({"k": ["x" * 20] * 4}, indent=1))
        self.assertEqual(out, '{\n  "k": [\n' + "".join(f"    {item},\n" for _ in range(3)) + f"    {item}\n  ]\n}}\n")

    def test_the_width_counts_wide_characters_twice(self):
        ascii_text = json.dumps({"k": ["a" * 10] * 5}, indent=1)
        hangul = json.dumps({"k": ["한" * 10] * 5}, indent=1, ensure_ascii=False)
        self.assertIn('"k": ["', art.format_json(ascii_text))  # 77 columns
        self.assertIn('"k": [\n', art.format_json(hangul))  # the same count of characters, twice the width

    def test_an_array_of_several_arrays_or_objects_always_breaks(self):
        self.assertEqual(art.format_json('{"m":[[1,2],[3,4]]}'), '{\n  "m": [\n    [1, 2],\n    [3, 4]\n  ]\n}\n')

    def test_numbers_fill_the_line(self):
        out = art.format_json(json.dumps({"n": list(range(100, 140))}, indent=1))
        lines = out.splitlines()
        self.assertTrue(all(len(line) <= art.WIDTH for line in lines))
        self.assertTrue(any(line.count(",") > 3 for line in lines))
        self.assertEqual(json.loads(out), {"n": list(range(100, 140))})

    def test_empty_containers_and_scalars(self):
        self.assertEqual(art.format_json('{\n "a": [], "b": {}, "c": null, "d": 1.5, "e": "q\\"x"\n}'),
                         '{\n  "a": [],\n  "b": {},\n  "c": null,\n  "d": 1.5,\n  "e": "q\\"x"\n}\n')

    def test_it_is_idempotent(self):
        for src in ('{"a":[1,2,3],"b":{"c":"d"}}', '{\n "a": [1, 2],\n "b": {"c": "d"}\n}', '{"m":[[1,2],[3,4]],"z":[{"x":1},{"x":2}]}'):
            once = art.format_json(src)
            self.assertEqual(art.format_json(once), once, src)

    def test_the_format_command_checks_and_rewrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "w.json"
            path.write_text('{"a":[1,2]}')
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(art.main(["format", "--check", str(path)]), 1)
                self.assertEqual(art.main(["format", str(path)]), 0)
                self.assertEqual(art.main(["format", "--check", str(path)]), 0)
            self.assertEqual(path.read_text(), '{ "a": [1, 2] }\n')


class TheHubCalls(unittest.TestCase):
    """HubClient names the parameters of the pinned huggingface_hub, which no test here can call."""

    def test_the_parameters_exist(self):
        import huggingface_hub as hub

        names = lambda fn: set(inspect.signature(fn).parameters)  # noqa: E731
        self.assertLessEqual({"repo_id", "repo_type"}, names(hub.HfApi.repo_info))
        self.assertLessEqual({"repo_id", "repo_type", "private", "exist_ok"}, names(hub.HfApi.create_repo))
        self.assertLessEqual({"repo_id", "repo_type", "operations", "commit_message"}, names(hub.HfApi.create_commit))
        self.assertLessEqual({"repo_id", "repo_type", "revision", "filename", "local_dir", "token"}, names(hub.hf_hub_download))
        self.assertLessEqual({"path_in_repo", "path_or_fileobj"}, set(hub.CommitOperationAdd.__dataclass_fields__))
        self.assertIn("oid", hub.CommitInfo.__dataclass_fields__)
        self.assertTrue(issubclass(hub.errors.RepositoryNotFoundError, Exception))


if __name__ == "__main__":
    unittest.main()
