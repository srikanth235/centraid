"""artefacts.py, offline: the manifest, check, fetch, the data-v7 pin, the model card, the GGUF's publish and the JSON layout
(#1088, R-1088-14, R-1088-16; #1171).

    python3 -m unittest test_artefacts -v      # from experiments/toolchat/native

Nothing here touches the network, a held-out file or the files of this directory that the manifest describes: the trees are
built in temporary directories, a version source is a local directory (ARTEFACTS_SOURCE), and the Hub is a fake that replaces
`artefacts.hub_client`. A test that the real calls exist reads the signatures of the pinned `huggingface_hub`, which the
runner's environment has (transformers needs it). The shipped manifest is read as it is, and so are the documents that record
its hashes, but no file it names is opened.
"""

from __future__ import annotations

import contextlib
import gzip
import hashlib
import inspect
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import artefacts as art

TOKEN = "hf_not_a_real_token_0123456789"
REVISION = "0123456789abcdef0123456789abcdef01234567"


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
    """The Hub in a dict, for datasets and models alike: what the tool asked of it is in `state`."""

    def __init__(self, token: str, state: "HubState"):
        self.state = state
        state.tokens.append(token)

    def repo_private(self, repo, repo_type):
        found = self.state.repos.get((repo_type, repo))
        return None if found is None else found["private"]

    def create_private(self, repo, repo_type):
        self.state.repos[(repo_type, repo)] = {"private": True, "commits": {}, "main": None, "tags": {},
                                               "files": {".gitattributes": b"*.gz filter=lfs\n"}}
        self.state.created.append((repo_type, repo))

    def create_public(self, repo, repo_type):
        self.create_private(repo, repo_type)
        self.state.repos[(repo_type, repo)]["private"] = False

    def tags(self, repo, repo_type):
        return sorted(self.state.repos[(repo_type, repo)]["tags"])

    def list_files(self, repo, repo_type):
        return sorted(self.state.repos[(repo_type, repo)]["files"])

    def commit(self, repo, repo_type, files, delete, message):
        found = self.state.repos[(repo_type, repo)]
        content = {dest: src.read_bytes() for dest, src in files.items()}
        revision = sha(json.dumps(sorted((k, sha(v)) for k, v in content.items()) + [message]).encode())[:40]
        found["files"] = {**{k: v for k, v in found["files"].items() if k not in delete}, **content}
        found["commits"][revision] = dict(found["files"])
        found["main"] = revision
        self.state.commits.append((repo_type, repo, sorted(files), sorted(delete), message))
        return revision

    def tag(self, repo, repo_type, tag, revision):
        self.state.repos[(repo_type, repo)]["tags"][tag] = revision
        self.state.tagged.append((repo_type, repo, tag, revision))

    def download(self, repo, revision, path_in_repo, into, repo_type="dataset"):
        if self.state.boom:
            raise RuntimeError(f"401 for token {self.state.boom}")
        data = self.state.repos[(repo_type, repo)]["commits"][revision][path_in_repo]
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
        self.tagged: list = []
        self.boom: str | None = None


def write(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


class Case(unittest.TestCase):
    """A directory with a builder and a manifest of five files: two rebuilt public ones, a held-out set and a train build
    that come from the version, and a held-out keys file that is rebuilt. `self.source` lays them out as a version."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "tree"
        self.root.mkdir()
        (self.root / "build.py").write_text(BUILDER)
        self.hub = HubState()
        patch = mock.patch.object(art, "hub_client", lambda token: FakeHub(token, self.hub))
        patch.start()
        self.addCleanup(patch.stop)
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for name in (art.HF_ENV, art.SOURCE_ENV, "NATIVETOOLS"):
            os.environ.pop(name, None)
        self.files = {"out/a.txt": b"alpha\n", "out/b.txt": b"beta\n", "sets/val.jsonl": b'{"id": 1}\n',
                      "data/train.gz": gzip.compress(b'{"id": "train-T01-0"}\n', mtime=0), "keys/k.json": b"{}\n"}
        self.vpath = {"out/a.txt": "worlds/a.txt", "out/b.txt": "worlds/b.txt", "sets/val.jsonl": "eval/val.jsonl",
                      "data/train.gz": "train/r1/train.jsonl.gz", "keys/k.json": None}
        self.manifest_path = self.base / "artefacts.json"
        rows = [
            self.row("a", "out/a.txt", rebuild="python3 build.py out/a.txt 'alpha\\n'"),
            self.row("b", "out/b.txt", rebuild="python3 build.py out/b.txt 'beta\\n'"),
            self.row("val", "sets/val.jsonl", heldout=True),
            self.row("train", "data/train.gz"),
            self.row("k", "keys/k.json", rebuild="python3 build.py keys/k.json '{}\\n'", heldout=True),
        ]
        art.save({"schema": 2, "data": {"repo": "o/n", "version": "data-v7", "revision": None}, "files": rows}, self.manifest_path)
        self.source = self.base / "source"
        self.lay_out(self.source)

    def row(self, name, path, **how):
        data = self.files[path]
        return {"name": name, "path": path, "version_path": self.vpath[path], "sha256": sha(data), "size": len(data),
                "from": "a test", **how}

    def lay_out(self, directory: Path, version: str = "data-v7") -> Path:
        """A directory laid out as a version: version.json and every file that has a version path."""
        write(directory / "version.json", json.dumps({"version": version}).encode())
        for path, vpath in self.vpath.items():
            if vpath:
                write(directory / vpath, self.files[path])
        return directory

    def put(self, path):
        write(self.root / path, self.files[path])

    def put_all(self):
        for path in self.files:
            self.put(path)

    def run_tool(self, *argv, token=None, source=None):
        if token:
            os.environ[art.HF_ENV] = token
        if source is not None:
            os.environ[art.SOURCE_ENV] = str(source)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = art.main(["--manifest", str(self.manifest_path), "--root", str(self.root), *argv])
        return code, out.getvalue() + err.getvalue()

    def manifest(self):
        return json.loads(self.manifest_path.read_text())

    def pin(self, revision=REVISION, repo="o/n", version="data-v7"):
        """Record that the version was published, and put its files on the fake Hub at that commit."""
        manifest = self.manifest()
        manifest["data"] = {"repo": repo, "version": version, "revision": revision}
        art.save(manifest, self.manifest_path)
        content = {"version.json": json.dumps({"version": version}).encode()}
        content.update({vpath: self.files[path] for path, vpath in self.vpath.items() if vpath})
        self.hub.repos[("dataset", repo)] = {"private": True, "commits": {revision: content}, "main": revision,
                                             "tags": {version: revision}, "files": dict(content)}




class TheShippedManifest(unittest.TestCase):
    """The manifest as it is committed. No file it names is opened; the documents that record the hashes are."""

    def test_it_is_well_formed(self):
        self.assertEqual(art.problems_in(art.load()), [])

    def test_it_pins_data_v7_of_the_private_dataset_repository(self):
        pin = art.load()["data"]
        self.assertEqual(pin["repo"], "srikanth235/centraid-native-data")
        self.assertEqual(pin["version"], "data-v7")  # S2's data: no longer rebuilt, still fetchable
        self.assertRegex(pin["revision"], r"^[0-9a-f]{40}$")

    def test_every_file_comes_from_the_version_and_lands_under_data_v7(self):
        """Nothing rebuilds (the Python builders are retired); the Rust eval reads the val set and the worlds from data/v7/."""
        for e in art.entries(art.load()):
            self.assertNotIn("rebuild", e, e["name"])
            self.assertTrue(e["path"].startswith("data/v7/"), e["path"])
            self.assertTrue(e["version_path"], e["name"])
        paths = {e["name"]: e["path"] for e in art.entries(art.load())}
        self.assertEqual(paths["set/val"], "data/v7/val.jsonl")  # crates/assist-eval's default --set
        self.assertEqual(paths["world/A"], "data/v7/worlds/A.json")  # its default --worlds

    def test_the_held_out_files_are_the_sets_and_their_worlds(self):
        held = {e["name"] for e in art.entries(art.load()) if art.is_heldout(e)}
        worlds = {"world/" + w for w in ("A", "B", "C", "D", "E", "F", "G", "T03", "T12", "T23")}
        self.assertLessEqual({"set/val", "set/test", "set/split", "data/train-val"} | worlds, held)
        self.assertFalse(held & {"set/roll-screen", "data/train"})  # the screen set and the train build are not held out

    def test_its_hashes_agree_with_the_documents_that_record_them(self):
        """data/v7/FROZEN.md and data/README.md say which bytes were scored and trained on; the manifest must say the same."""
        recorded = (art.HERE / "data" / "v7" / "FROZEN.md").read_text() + (art.HERE / "data" / "README.md").read_text()
        by_name = {e["name"]: e for e in art.entries(art.load())}
        for name in ("set/val", "set/test", "set/split", "data/train", "data/train-val"):
            self.assertIn(by_name[name]["sha256"], recorded, name)

    def test_nothing_of_the_retired_python_data_tooling_is_in_it(self):
        for e in art.entries(art.load()):
            self.assertFalse(e["path"].startswith(("authored/", "eval/")), e["path"])
            self.assertFalse(e["name"].startswith(("builder/", "session/", "keys/")), e["name"])

    def test_the_layout_of_the_version(self):
        roots = {"worlds", "eval", "screen", "train"}
        for e in art.entries(art.load()):
            self.assertIn(e["version_path"].split("/")[0], roots, e["name"])

    def test_the_gitignore_block_has_one_line_per_file(self):
        block = art.gitignore_block(art.load()).splitlines()
        self.assertEqual((block[0], block[-1]), (art.IGNORE_BEGIN, art.IGNORE_END))
        self.assertEqual(len(block) - 2, len(art.entries(art.load())))
        self.assertTrue(all(line.startswith("/") for line in block[1:-1]))
        self.assertEqual("\n".join(block) + "\n", (art.HERE / ".gitignore").read_text()[(art.HERE / ".gitignore").read_text().index(art.IGNORE_BEGIN):])


class Validation(Case):
    def test_a_file_is_either_rebuilt_or_comes_from_the_version(self):
        manifest = self.manifest()
        manifest["files"][0]["version_path"] = None  # rebuilt and no copy: fine
        self.assertEqual(art.problems_in(manifest), [])
        manifest["files"][2]["version_path"] = None  # from the version and no path in it: not
        self.assertIn("needs a version_path", " ".join(art.problems_in(manifest)))

    def test_names_and_paths_are_unique_and_the_hash_is_hex(self):
        manifest = self.manifest()
        manifest["files"][1]["name"] = "a"
        manifest["files"][1]["path"] = "out/a.txt"
        manifest["files"][3]["sha256"] = "XYZ"
        text = " ".join(art.problems_in(manifest))
        self.assertIn("name used twice", text)
        self.assertIn("path out/a.txt used twice", text)
        self.assertIn("sha256 is not 64", text)

    def test_a_path_cannot_leave_its_tree(self):
        manifest = self.manifest()
        manifest["files"][0]["path"] = "../x"
        manifest["files"][1]["version_path"] = "/abs"
        text = " ".join(art.problems_in(manifest))
        self.assertIn("path '../x' is not a relative path", text)
        self.assertIn("version_path '/abs' is not a relative path", text)

    def test_two_files_cannot_share_a_version_path_or_take_version_json(self):
        manifest = self.manifest()
        manifest["files"][1]["version_path"] = "worlds/a.txt"
        manifest["files"][3]["version_path"] = "version.json"
        text = " ".join(art.problems_in(manifest))
        self.assertIn("version_path worlds/a.txt used twice", text)
        self.assertIn("which the version writes itself", text)

    def test_the_pin_needs_a_repo_a_data_tag_and_a_commit_or_nothing(self):
        for pin in ({"repo": "nope", "version": "data-v7", "revision": None}, {"repo": "o/n", "version": "v7", "revision": None},
                    {"repo": "o/n", "version": "data-v7", "revision": "abc"}):
            manifest = self.manifest()
            manifest["data"] = pin
            self.assertEqual(len(art.problems_in(manifest)), 1, pin)

    def test_heldout_is_true_or_false(self):
        manifest = self.manifest()
        manifest["files"][2]["heldout"] = "yes"
        self.assertIn("heldout is true or false", " ".join(art.problems_in(manifest)))


class Check(Case):
    def test_all_present_and_matching(self):
        self.put_all()
        code, out = self.run_tool("check")
        self.assertEqual(code, 0, out)
        self.assertIn("5 of 5 files match", out)

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

    def test_public_only_checks_the_rebuilt_public_files_and_not_the_held_out_ones(self):
        self.put("out/a.txt")
        self.put("out/b.txt")
        code, out = self.run_tool("check", "--public-only")
        self.assertEqual(code, 0, out)
        self.assertIn("2 of 2 files match", out)
        self.assertEqual(self.run_tool("check")[0], 1)


class FetchRebuild(Case):
    def builds(self):
        log = self.root / "builds.log"
        return log.read_text().split() if log.exists() else []

    def test_public_only_rebuilds_what_is_missing_and_verifies_it(self):
        code, out = self.run_tool("fetch", "--public-only")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.root / "out/a.txt").read_bytes(), self.files["out/a.txt"])
        self.assertEqual(sorted(self.builds()), ["out/a.txt", "out/b.txt"])
        self.assertIn("3 file(s) left alone", out)
        self.assertEqual(self.run_tool("check", "--public-only")[0], 0)

    def test_public_only_needs_no_source_no_token_and_no_pinned_commit(self):
        os.environ[art.SOURCE_ENV] = str(self.base / "nowhere")
        code, out = self.run_tool("fetch", "--public-only")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.hub.tokens, [])
        self.assertFalse((self.root / "sets").exists() or (self.root / "keys").exists() or (self.root / "data").exists())

    def test_a_second_run_rebuilds_nothing(self):
        self.run_tool("fetch", "--public-only")
        self.run_tool("fetch", "--public-only")
        self.assertEqual(len(self.builds()), 2)

    def test_one_command_for_several_files_runs_once(self):
        manifest = self.manifest()
        both = manifest["files"][0]["rebuild"] + " && " + manifest["files"][1]["rebuild"]
        manifest["files"][0]["rebuild"] = manifest["files"][1]["rebuild"] = both
        art.save(manifest, self.manifest_path)
        code, _ = self.run_tool("fetch", "--public-only")
        self.assertEqual(code, 0)
        self.assertEqual(self.builds().count("out/a.txt"), 1)

    def test_bytes_that_differ_fail_and_are_named(self):
        manifest = self.manifest()
        manifest["files"][0]["rebuild"] = "python3 build.py out/a.txt 'alphX\\n'"
        art.save(manifest, self.manifest_path)
        code, out = self.run_tool("fetch", "--public-only")
        self.assertEqual(code, 1)
        self.assertIn("out/a.txt: rebuilt, but sha256 differs", out)
        self.assertIn("no longer reproduces", out)

    def test_a_failing_command_shows_its_tail(self):
        manifest = self.manifest()
        manifest["files"][0]["rebuild"] = "echo no builder here >&2; exit 3"
        art.save(manifest, self.manifest_path)
        code, out = self.run_tool("fetch", "--public-only")
        self.assertEqual(code, 1)
        self.assertIn("exited 3", out)
        self.assertIn("no builder here", out)

    def test_a_file_that_differs_is_not_overwritten_without_force(self):
        self.put("out/a.txt")
        (self.root / "out/a.txt").write_bytes(b"edited\n")
        code, out = self.run_tool("fetch", "--public-only")
        self.assertEqual(code, 1)
        self.assertIn("--force replaces it", out)
        self.assertEqual((self.root / "out/a.txt").read_bytes(), b"edited\n")
        code, _ = self.run_tool("fetch", "--public-only", "--force")
        self.assertEqual(code, 0)
        self.assertEqual((self.root / "out/a.txt").read_bytes(), self.files["out/a.txt"])

    def test_only_narrows_by_name_or_path_prefix(self):
        self.run_tool("fetch", "--public-only", "--only", "a")
        self.assertEqual(self.builds(), ["out/a.txt"])
        self.run_tool("fetch", "--public-only", "--only", "out/b")
        self.assertEqual(sorted(self.builds()), ["out/a.txt", "out/b.txt"])

    def test_the_command_sees_a_scratch_directory_that_is_removed(self):
        manifest = self.manifest()
        manifest["files"][0]["rebuild"] = 'test -d "$ARTEFACTS_TMP" && echo "$ARTEFACTS_TMP" > where.txt && python3 build.py out/a.txt \'alpha\\n\''
        art.save(manifest, self.manifest_path)
        self.assertEqual(self.run_tool("fetch", "--public-only")[0], 0)
        self.assertFalse(Path((self.root / "where.txt").read_text().strip()).exists())

    def test_a_dry_run_writes_nothing(self):
        code, out = self.run_tool("fetch", "--dry-run", source=self.source)
        self.assertEqual(code, 0, out)
        self.assertIn("would rebuild  python3 build.py out/a.txt", out)
        self.assertIn("would fetch    sets/val.jsonl", out)
        self.assertIn(f"{self.source}:eval/val.jsonl", out)
        self.assertEqual([p for p in self.root.iterdir() if p.name != "build.py"], [])
        self.assertEqual(self.hub.tokens, [])


class FetchSource(Case):
    """ARTEFACTS_SOURCE: a local directory laid out as a version, the provider-neutral way to the same files."""

    def test_it_copies_the_version_files_to_their_tree_paths_then_rebuilds_and_verifies(self):
        code, out = self.run_tool("fetch", source=self.source)
        self.assertEqual(code, 0, out)
        for path in self.files:
            self.assertEqual((self.root / path).read_bytes(), self.files[path], path)
        self.assertEqual(self.run_tool("check")[0], 0)
        self.assertEqual(list(self.root.rglob("*.part")), [])
        self.assertEqual(self.hub.tokens, [])

    def test_a_rebuild_runs_after_the_version_files_arrive(self):
        manifest = self.manifest()
        manifest["files"][4]["rebuild"] = "test -f sets/val.jsonl && python3 build.py keys/k.json '{}\\n'"  # needs the held-out set
        art.save(manifest, self.manifest_path)
        code, out = self.run_tool("fetch", source=self.source)
        self.assertEqual(code, 0, out)

    def test_wrong_bytes_leave_nothing_at_the_path(self):
        write(self.source / "eval/val.jsonl", b"tampered\n")
        code, out = self.run_tool("fetch", "--only", "val", source=self.source)
        self.assertEqual(code, 1)
        self.assertIn("do not match the manifest", out)
        self.assertFalse((self.root / "sets/val.jsonl").exists())
        self.assertEqual(list(self.root.rglob("*.part")), [])

    def test_a_missing_file_is_named(self):
        (self.source / "train/r1/train.jsonl.gz").unlink()
        code, out = self.run_tool("fetch", "--only", "train", source=self.source)
        self.assertEqual(code, 1)
        self.assertIn("data/train.gz: fetch failed: FileNotFoundError", out)

    def test_it_must_be_the_version_the_manifest_pins(self):
        self.lay_out(self.base / "other", version="data-v6")
        code, out = self.run_tool("fetch", source=self.base / "other")
        self.assertEqual(code, 1)
        self.assertIn("'data-v6', the manifest pins data-v7", out)
        self.assertFalse((self.root / "sets").exists())

    def test_a_directory_that_is_not_one_is_refused(self):
        code, out = self.run_tool("fetch", source=self.base / "missing")
        self.assertEqual(code, 1)
        self.assertIn("is not a directory", out)

    def test_public_only_never_reads_it(self):
        code, _ = self.run_tool("fetch", "--public-only", source=self.source)
        self.assertEqual(code, 0)
        self.assertFalse((self.root / "sets").exists())


class FetchHub(Case):
    def test_an_unpinned_version_cannot_be_fetched_and_says_what_to_do(self):
        code, out = self.run_tool("fetch", token=TOKEN)
        self.assertEqual(code, 1)
        self.assertIn("pins no commit", out)
        self.assertIn("artefacts.py pin REVISION", out)
        self.assertEqual(self.hub.tokens, [])
        self.assertFalse((self.root / "out/a.txt").exists())

    def test_without_a_token_it_says_so_and_how_to_go_without(self):
        self.pin()
        code, out = self.run_tool("fetch")
        self.assertEqual(code, 1)
        self.assertIn("HF_TOKEN is not set", out)
        self.assertIn("ARTEFACTS_SOURCE", out)
        self.assertIn("--public-only", out)

    def test_it_downloads_at_the_pinned_commit_and_verifies(self):
        self.pin()
        code, out = self.run_tool("fetch", token=TOKEN)
        self.assertEqual(code, 0, out)
        self.assertEqual(set(self.hub.tokens), {TOKEN})
        for path in self.files:
            self.assertEqual((self.root / path).read_bytes(), self.files[path])
        self.assertEqual(self.run_tool("check")[0], 0)
        self.assertEqual(list(self.root.rglob("*.part")), [])

    def test_a_commit_that_holds_another_version_is_refused(self):
        self.pin(version="data-v6")
        manifest = self.manifest()
        manifest["data"]["version"] = "data-v7"
        art.save(manifest, self.manifest_path)
        code, out = self.run_tool("fetch", token=TOKEN)
        self.assertEqual(code, 1)
        self.assertIn("the manifest pins data-v7", out)

    def test_wrong_bytes_from_the_hub_leave_nothing_at_the_path(self):
        self.pin()
        self.hub.repos[("dataset", "o/n")]["commits"][REVISION]["eval/val.jsonl"] = b"other bytes"
        code, out = self.run_tool("fetch", "--only", "val", token=TOKEN)
        self.assertEqual(code, 1)
        self.assertIn("do not match the manifest", out)
        self.assertFalse((self.root / "sets/val.jsonl").exists())
        self.assertEqual(list(self.root.rglob("*.part")), [])

    def test_the_token_is_scrubbed_from_a_hub_error(self):
        self.pin()
        real = FakeHub.download

        def boom(hub, repo, revision, path, into, repo_type="dataset"):
            if path != "version.json":
                raise RuntimeError(f"401 for token {TOKEN}")
            return real(hub, repo, revision, path, into, repo_type)

        with mock.patch.object(FakeHub, "download", boom):
            code, out = self.run_tool("fetch", "--only", "val", token=TOKEN)
        self.assertEqual(code, 1)
        self.assertIn("fetch failed: RuntimeError", out)
        self.assertNotIn(TOKEN, out)

    def test_a_dry_run_with_a_pinned_commit_names_it(self):
        self.pin(revision="a" * 40)
        code, out = self.run_tool("fetch", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("from o/n@aaaaaaaaaaaa:eval/val.jsonl", out)
        self.assertIn("HF_TOKEN is not set", out)
        self.assertEqual(self.hub.tokens, [])


class Rehash(Case):
    def test_it_rewrites_the_hash_and_size_of_the_files_in_place(self):
        self.put_all()
        write(self.root / "sets/val.jsonl", b'{"id": 2, "more": true}\n')
        code, out = self.run_tool("rehash")
        self.assertEqual(code, 0, out)
        row = next(e for e in self.manifest()["files"] if e["name"] == "val")
        self.assertEqual((row["sha256"], row["size"]), (sha(b'{"id": 2, "more": true}\n'), 24))
        self.assertEqual(self.run_tool("check")[0], 0)

    def test_a_file_not_in_place_is_skipped_not_dropped(self):
        before = self.manifest()
        code, out = self.run_tool("rehash")
        self.assertEqual(code, 0)
        self.assertIn("skip   out/a.txt: not in place", out)
        self.assertEqual(self.manifest(), before)






class VerifyVersion(Case):
    def test_it_reads_each_file_at_the_pin_and_compares_it(self):
        self.pin()
        code, out = self.run_tool("verify-version", token=TOKEN)
        self.assertEqual(code, 0, out)
        self.assertIn("4 of 4 file(s)", out)
        self.assertFalse((self.root / "sets").exists())  # a check, not a fetch

    def test_it_fails_on_other_bytes(self):
        self.pin()
        self.hub.repos[("dataset", "o/n")]["commits"][REVISION]["eval/val.jsonl"] = b"other"
        self.assertEqual(self.run_tool("verify-version", token=TOKEN)[0], 1)

    def test_it_reads_a_local_source_too(self):
        code, out = self.run_tool("verify-version", source=self.source)
        self.assertEqual(code, 0, out)

    def test_it_stops_before_the_pin(self):
        self.assertEqual(self.run_tool("verify-version", token=TOKEN)[0], 1)




class ModelCard(Case):
    def setUp(self):
        super().setUp()
        self.model = self.base / "model"
        meta = {"args": {"model": "Qwen/Qwen3.5-0.8B", "lr": 2e-05, "epochs": 3, "bs": 16, "train": "data/train.jsonl.gz", "seed": 0},
                "steps": 3537, "examples": 18871, "tokens": 106308093, "label_tokens": 9532088, "train_seconds": 7200.0}
        write(self.model / "train_meta.json", json.dumps(meta).encode())
        write(self.model / "config.json", json.dumps({"model_type": "qwen3_5_text", "hidden_size": 1024}).encode())
        write(self.model / "model.safetensors", b"weights")
        self.card = self.base / "card" / "README.md"

    def make(self, *extra):
        argv = ["--repo-root", str(self.base), "model-card", "--model", str(self.model), "--data-version", "data-v7", "--name", "S2",
                "--git-commit", "d" * 40, "--score", "val 537/655 live (runtime nt12, val v7.x)",
                "--score", "val 542/655 by replay (runtime nt15, val v7.4)", "--out", str(self.card), *extra]
        return self.run_tool(*argv)

    def test_it_names_the_data_tag_the_commit_and_the_config(self):
        code, out = self.make("--note", "S2 is a weight soup of three members")
        self.assertEqual(code, 0, out)
        text = self.card.read_text()
        self.assertTrue(text.startswith("---\nbase_model: Qwen/Qwen3.5-0.8B\n"))
        self.assertIn("- o/n\n", text)  # the dataset repository, from the manifest
        self.assertIn("Data version: `data-v7` of the private dataset repository `o/n`", text)
        self.assertIn("Card written at commit `" + "d" * 40 + "`", text)
        self.assertIn("- val 537/655 live (runtime nt12, val v7.x)", text)
        self.assertIn("- val 542/655 by replay (runtime nt15, val v7.4)", text)
        self.assertIn("- S2 is a weight soup of three members", text)
        self.assertIn('"lr": 2e-05', text)  # the training config as it ran
        self.assertIn('"hidden_size": 1024', text)  # the model config
        self.assertIn(f"`{sha(b'weights')}`", text)  # the weights by hash
        self.assertIn("3537 steps", text)

    def test_the_card_is_not_among_its_own_files(self):
        write(self.model / "README.md", b"old card")
        self.make()
        self.assertNotIn("| `README.md` |", self.card.read_text())

    def test_a_checkpoint_without_its_train_meta_is_refused(self):
        (self.model / "train_meta.json").unlink()
        code, out = self.make()
        self.assertEqual(code, 1)
        self.assertIn("train_meta.json is missing", out)
        self.assertFalse(self.card.exists())

    def test_the_data_version_is_a_data_tag(self):
        code, out = self.run_tool("model-card", "--model", str(self.model), "--data-version", "v7", "--name", "S2", "--out", str(self.card))
        self.assertEqual(code, 1)
        self.assertIn("is not a data tag", out)

    def test_a_card_passes_the_check_publish_model_makes(self):
        self.make()
        write(self.model / "README.md", self.card.read_bytes())
        code, out = self.run_tool("publish-model", str(self.model), "--repo", "o/s2", "--tag", "S2", "--dry-run")
        self.assertEqual(code, 0, out)


class PublishModel(Case):
    def setUp(self):
        super().setUp()
        self.model = self.base / "model"
        write(self.model / "config.json", b"{}")
        write(self.model / "model.safetensors", b"weights")
        write(self.model / "README.md", b"# S2\n\n- Data version: `data-v7` of the private dataset repository `o/n`.\n")

    def publish(self, *extra, token=TOKEN):
        return self.run_tool("publish-model", str(self.model), "--repo", "o/s2", "--tag", "S2", *extra, token=token)

    def test_it_creates_a_private_model_repository_commits_once_and_tags(self):
        code, out = self.publish()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.hub.created, [("model", "o/s2")])
        self.assertEqual(self.hub.commits[0][:3], ("model", "o/s2", ["README.md", "config.json", "model.safetensors"]))
        self.assertEqual(self.hub.tagged[0][:3], ("model", "o/s2", "S2"))

    def test_a_card_written_beside_the_checkpoint_is_sent_as_its_readme(self):
        (self.model / "README.md").unlink()
        card = write(self.base / "card" / "README.md", b"# S2\n\n- Data version: `data-v7` of the private dataset repository `o/n`.\n")
        code, out = self.publish("--card", str(card))
        self.assertEqual(code, 0, out)
        self.assertEqual(self.hub.commits[0][2], ["README.md", "config.json", "model.safetensors"])
        self.assertEqual(self.hub.repos[("model", "o/s2")]["files"]["README.md"], card.read_bytes())
        self.assertFalse((self.model / "README.md").exists())  # the checkpoint directory is not written to
        code, out = self.publish("--card", str(self.base / "nowhere.md"))
        self.assertEqual(code, 1)
        self.assertIn("is not a file", out)

    def test_a_dry_run_sends_nothing(self):
        code, out = self.publish("--dry-run", token=None)
        self.assertEqual(code, 0, out)
        self.assertIn("(model, private) as S2", out)
        self.assertEqual((self.hub.tokens, self.hub.commits, self.hub.created), ([], [], []))

    def test_it_refuses_a_public_repository_and_a_moved_tag(self):
        self.hub.repos[("model", "o/s2")] = {"private": False, "commits": {}, "main": None, "tags": {}, "files": {}}
        self.assertIn("exists and is public", self.publish()[1])
        self.hub.repos[("model", "o/s2")]["private"] = True
        self.hub.repos[("model", "o/s2")]["tags"] = {"S2": "x"}
        self.assertIn("already has the tag S2", self.publish()[1])
        self.assertEqual(self.hub.commits, [])

    def test_it_wants_the_weights_the_config_and_a_card_that_names_its_data_version(self):
        (self.model / "model.safetensors").unlink()
        write(self.model / "README.md", b"# S2\n")
        code, out = self.publish()
        self.assertEqual(code, 1)
        self.assertIn("has no *.safetensors weights", out)
        self.assertIn("model-card", out)
        self.assertEqual(self.hub.commits, [])

    def test_it_needs_the_token(self):
        self.assertIn("HF_TOKEN is not set", self.publish(token=None)[1])


class PublishGguf(Case):
    """`publish-gguf`: the one publish that is public. The GGUF's sidecar is what to_gguf.py wrote; here it is made by hand."""

    def setUp(self):
        super().setUp()
        self.gguf = write(self.base / "out" / "s2-Q4_0.gguf", b"GGUF" + bytes(range(200)))
        self.side = {
            "schema": 1, "name": "s2",
            "files": {"gguf": {"file": "s2-Q4_0.gguf", "bytes": self.gguf.stat().st_size, "sha256": sha(self.gguf.read_bytes()), "quant": "Q4_0"}},
            "source": {"checkpoint": "/ckpt/s2", "repo": "owner/native-s2", "tag": "S2", "revision": REVISION, "data_version": "data-v7"},
            "llama_cpp": {"repo": "https://github.com/ggml-org/llama.cpp", "commit": "26394b4e6749a41c3633db040e0987500a5f7013",
                          "engine": "llama-cpp-sys-2 0.1.158"},
        }
        self.sidecar = self.save_sidecar()

    def save_sidecar(self):
        return write(self.base / "out" / "s2-Q4_0.gguf.json", json.dumps(self.side).encode())

    def publish(self, *extra, token=TOKEN):
        return self.run_tool("publish-gguf", str(self.gguf), "--repo", "o/s2-gguf", "--tag", "S2-q4", *extra, token=token)

    def test_a_dry_run_says_public_lists_the_files_prints_the_card_and_sends_nothing(self):
        code, out = self.publish("--plan", token=None)
        self.assertEqual(code, 0, out)
        self.assertIn("(model, PUBLIC) as S2-q4: 3 file(s)", out)
        for rel in ("README.md", "s2-Q4_0.gguf", "s2-Q4_0.gguf.json"):
            self.assertIn(rel, out)
        self.assertIn("base_model: Qwen/Qwen3.5-0.8B", out)
        self.assertEqual((self.hub.tokens, self.hub.commits, self.hub.created), ([], [], []))

    def test_it_creates_a_public_repository_commits_once_and_tags(self):
        code, out = self.publish()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.hub.created, [("model", "o/s2-gguf")])
        self.assertIs(self.hub.repos[("model", "o/s2-gguf")]["private"], False)
        self.assertEqual(self.hub.commits[0][:3], ("model", "o/s2-gguf", ["README.md", "s2-Q4_0.gguf", "s2-Q4_0.gguf.json"]))
        self.assertEqual(self.hub.tagged[0][:3], ("model", "o/s2-gguf", "S2-q4"))
        files = self.hub.repos[("model", "o/s2-gguf")]["files"]
        self.assertEqual(files["s2-Q4_0.gguf"], self.gguf.read_bytes())
        self.assertEqual(files["s2-Q4_0.gguf.json"], self.sidecar.read_bytes())

    def test_the_card_names_what_it_must(self):
        card = art.render_gguf_card(self.side, "s2-Q4_0.gguf", "s2-Q4_0.gguf.json")
        for needed in ("base_model: Qwen/Qwen3.5-0.8B", "license: apache-2.0", "Apache-2.0", "eight tools", "SPEC.md", "not a general chat model",
                       "`owner/native-s2`", "tag `S2`", f"revision `{REVISION}`", "`data-v7`", "26394b4e6749a41c3633db040e0987500a5f7013",
                       "llama-cpp-sys-2 0.1.158", "`Q4_0`", self.side["files"]["gguf"]["sha256"], f"{self.gguf.stat().st_size:,}",
                       "unsloth/Qwen3.5-0.8B-GGUF", "mmproj-F16.gguf", "6ab461498e2023f6e3c1baea90a8f0fe38ab64d0",
                       "56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453", "204,987,232"):
            self.assertIn(needed, card)
        self.assertTrue(card.startswith("---\n"))

    def test_it_refuses_a_private_repository_and_a_moved_tag(self):
        self.hub.repos[("model", "o/s2-gguf")] = {"private": True, "commits": {}, "main": None, "tags": {}, "files": {}}
        self.assertIn("exists and is private", self.publish()[1])
        self.hub.repos[("model", "o/s2-gguf")]["private"] = False
        self.hub.repos[("model", "o/s2-gguf")]["tags"] = {"S2-q4": "x"}
        self.assertIn("already has the tag S2-q4", self.publish()[1])
        self.assertEqual(self.hub.commits, [])

    def test_it_needs_the_token_from_the_environment_and_shows_the_plan_without_it(self):
        code, out = self.publish(token=None)
        self.assertEqual(code, 1)
        self.assertIn("HF_TOKEN is not set", out)
        self.assertIn("(model, PUBLIC)", out)
        self.assertEqual(self.hub.commits, [])

    def test_the_sidecar_must_describe_this_file(self):
        write(self.gguf, self.gguf.read_bytes() + b"x")  # same name and nothing else
        code, out = self.publish("--dry-run")
        self.assertEqual(code, 1)
        self.assertIn("is not the bytes the sidecar records", out)
        self.side["files"]["gguf"]["file"] = "other.gguf"
        self.save_sidecar()
        self.assertIn("describes 'other.gguf'", self.publish("--dry-run")[1])
        self.assertEqual(self.hub.commits, [])

    def test_the_sidecar_must_say_where_the_model_came_from_and_what_read_it(self):
        for path, key, why in (("source", "repo", "private source repository"), ("source", "tag", "source tag"),
                               ("source", "revision", "source revision"), ("source", "data_version", "data version"),
                               ("llama_cpp", "commit", "llama.cpp commit")):
            saved = self.side[path].pop(key)
            self.save_sidecar()
            code, out = self.publish("--dry-run")
            self.assertEqual(code, 1, key)
            self.assertIn(why, out)
            self.side[path][key] = saved
        self.side["source"]["revision"] = "main"
        self.save_sidecar()
        self.assertIn("source revision", self.publish("--dry-run")[1])

    def test_a_missing_sidecar_or_a_quant_nobody_checked_is_refused(self):
        self.sidecar.unlink()
        self.assertIn("is not a file", self.publish("--dry-run")[1])
        self.save_sidecar()
        self.side["files"]["gguf"]["quant"] = "Q2_K"
        self.save_sidecar()
        self.assertIn("quant is 'Q2_K'", self.publish("--dry-run")[1])

    def test_a_sidecar_can_be_given_by_path(self):
        elsewhere = write(self.base / "elsewhere.json", self.sidecar.read_bytes())
        self.sidecar.unlink()
        code, out = self.publish("--sidecar", str(elsewhere), "--dry-run")
        self.assertEqual(code, 0, out)

    def test_the_token_reaches_neither_the_output_nor_a_file(self):
        code, out = self.publish()
        self.assertNotIn(TOKEN, out)
        for content in self.hub.repos[("model", "o/s2-gguf")]["files"].values():
            self.assertNotIn(TOKEN.encode(), content)
        with mock.patch.object(FakeHub, "commit", side_effect=RuntimeError(f"401 for {TOKEN}")):
            self.hub.repos.clear()
            code, out = self.publish()
        self.assertEqual(code, 1)
        self.assertNotIn(TOKEN, out)

    def test_the_private_publishes_stay_private(self):
        model = self.base / "model"
        write(model / "config.json", b"{}")
        write(model / "model.safetensors", b"w")
        write(model / "README.md", b"- Data version: `data-v7`\n")
        code, out = self.run_tool("publish-model", str(model), "--repo", "o/s2", "--tag", "S2", token=TOKEN)
        self.assertEqual(code, 0, out)
        self.assertIs(self.hub.repos[("model", "o/s2")]["private"], True)


class Paths(Case):
    def test_the_class_filter(self):
        self.assertEqual(self.run_tool("paths")[1].split(), ["out/a.txt", "out/b.txt", "sets/val.jsonl", "data/train.gz", "keys/k.json"])
        self.assertEqual(self.run_tool("paths", "--class", "public")[1].split(), ["out/a.txt", "out/b.txt"])
        self.assertEqual(self.run_tool("paths", "--class", "heldout")[1].split(), ["sets/val.jsonl", "keys/k.json"])
        self.assertEqual(self.run_tool("paths", "--class", "version")[1].split(), ["sets/val.jsonl", "data/train.gz"])
        self.assertEqual(self.run_tool("paths", "--class", "rebuild")[1].split(), ["out/a.txt", "out/b.txt", "keys/k.json"])


class VerifyRebuild(Case):
    def test_the_public_rebuilds_agree_with_the_files_in_place(self):
        self.put("out/a.txt")
        self.put("out/b.txt")
        code, out = self.run_tool("verify-rebuild", "--public-only")
        self.assertEqual(code, 0, out)
        self.assertIn("2 of 2 regenerable file(s)", out)

    def test_a_file_that_no_longer_rebuilds_to_the_bytes_in_place_is_named(self):
        self.put("out/a.txt")
        self.put("out/b.txt")
        write(self.root / "out/b.txt", b"edited\n")
        code, out = self.run_tool("verify-rebuild", "--public-only")
        self.assertEqual(code, 1)
        self.assertIn("out/b.txt: the rebuild differs from the file in place", out)


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
        self.assertLessEqual({"repo_id", "repo_type"}, names(hub.HfApi.list_repo_refs))
        self.assertLessEqual({"repo_id", "repo_type"}, names(hub.HfApi.list_repo_files))
        self.assertLessEqual({"repo_id", "tag", "revision", "repo_type", "exist_ok"}, names(hub.HfApi.create_tag))
        self.assertLessEqual({"repo_id", "repo_type", "revision", "filename", "local_dir", "token"}, names(hub.hf_hub_download))
        self.assertLessEqual({"path_in_repo", "path_or_fileobj"}, set(hub.CommitOperationAdd.__dataclass_fields__))
        self.assertLessEqual({"path_in_repo"}, set(hub.CommitOperationDelete.__dataclass_fields__))
        self.assertIn("oid", hub.CommitInfo.__dataclass_fields__)
        self.assertIn("tags", hub.GitRefs.__dataclass_fields__)
        self.assertIn("name", hub.GitRefInfo.__dataclass_fields__)
        self.assertTrue(issubclass(hub.errors.RepositoryNotFoundError, Exception))


if __name__ == "__main__":
    unittest.main()
