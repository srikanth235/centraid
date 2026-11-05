#!/usr/bin/env python3
"""The held-out data-v7 of the native tool task, and the publishing of its models (#1088, R-1088-14, R-1088-16; #1171).

    python3 artefacts.py check [-v] [--public-only]        # every manifest file is present and matches its sha256
    python3 artefacts.py fetch [--dry-run] [--public-only] [--force] [--only NAME_OR_PATH_PREFIX ...]
    python3 artefacts.py verify-rebuild [--public-only]    # rebuild every regenerable file in a scratch copy, compare bytes
    python3 artefacts.py verify-version                    # fetch every version file at the pin, compare sha256
    python3 artefacts.py model-card --model DIR --data-version TAG --name NAME [--score LINE]... --out FILE
    python3 artefacts.py publish-model DIR --repo OWNER/NAME --tag NAME [--card FILE] [--dry-run]   # a promoted model, tagged
    python3 artefacts.py publish-gguf GGUF --repo OWNER/NAME --tag NAME [--sidecar FILE] [--dry-run]   # its GGUF, to a PUBLIC repository
    python3 artefacts.py rehash [--only NAME_OR_PATH_PREFIX ...]   # rewrite sha256 and size of the files in place
    python3 artefacts.py paths [--class rebuild|version|heldout|public]
    python3 artefacts.py gitignore                         # the .gitignore block for the manifest paths
    python3 artefacts.py format [--check] FILE ...         # the committed layout of a JSON file (what `save` writes)

DATA-V7 is the version S2 was trained and judged on: one tag (`data-v7`) of the private Hugging Face dataset repository. It is no
longer rebuilt (the Python data tooling that made it is retired, #1171) and stays fetchable for reference. Its layout:

    version.json
    train/r1/train.jsonl.gz, train/r1/train-val.jsonl.gz     the training build as trained, with the trainer's own validation slice
    eval/val.jsonl, eval/test.jsonl, eval/split.json         the frozen sets (data/v7/FROZEN.md)
    screen/roll-screen.jsonl                                 the RFT screen set
    worlds/<id>.json                                         the worlds the sets run in (A to G, T03, T12, T23)

A NEW DATA VERSION is not made here: `cargo run -p centraid-datagen -- build --version vN` is the only way (crates/datagen/README.md).
This tool neither assembles nor publishes data versions.

`artefacts.json` is the manifest: the pin (`data`: repository, version, and the commit the tag points at) and one entry per file the tree
materialises: its logical name, its path in the tree (all under `data/v7/`, where `crates/assist-eval` reads the val set and the worlds
by default), its path in the version, its sha256 and size, where it comes from, and how it comes back. A file either rebuilds
(`"rebuild"`: a shell command, run here, that writes it at its path) or comes from the version (every file today). `"heldout": true` marks
a file that is not distributed with the tree. The tool writes every file at the path the rest of the code reads and verifies the sha256
of every byte it materialises: a copy that differs fails and reports the file.

`fetch` reads the version from a SOURCE: the directory named by ARTEFACTS_SOURCE (a local directory laid out as a version, any
provider's copy of it, no network and no token), else the Hub at the pinned commit (`huggingface_hub`, a token read from the environment
variable HF_TOKEN only: it is never written to disk, logged or passed on a command line). `check` and every `--dry-run` need neither
the token nor the library.

`format_json` is the layout `oxfmt` gives the JSON the manifest is written in (Prettier rules, print width 80: an object keeps the break
after its `{` if the source had one, an array or object that fits on its line stays on it).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
MANIFEST = HERE / "artefacts.json"
HF_ENV = "HF_TOKEN"
SOURCE_ENV = "ARTEFACTS_SOURCE"
VERSION_JSON = "version.json"
IGNORE_BEGIN = "# artefacts.json: begin (artefacts.py gitignore)"
IGNORE_END = "# artefacts.json: end"
SHA = re.compile(r"[0-9a-f]{64}")
COMMIT = re.compile(r"[0-9a-f]{40}")
TAG = re.compile(r"data-v[0-9]+")
# What a scratch copy of this directory leaves out: the data and docs are not needed to rebuild.
COPY_IGNORE = shutil.ignore_patterns("__pycache__", "data", "*.pyc")
# A repository's own bookkeeping file, never deleted by a publish: it decides which files the Hub stores as LFS.
KEEP_ON_PUBLISH = (".gitattributes",)


class Refusal(Exception):
    """A rule of the tool, not a failure of the machine: the message is what the operator reads."""


# ---------------------------------------------------------------------------------------------
# The manifest
# ---------------------------------------------------------------------------------------------


def load(path: Path = MANIFEST) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save(manifest: dict, path: Path = MANIFEST) -> None:
    path.write_text(format_json(json.dumps(manifest, ensure_ascii=False, indent=2)), encoding="utf-8")


def entries(manifest: dict) -> list[dict]:
    return manifest["files"]


def kind(entry: dict) -> str:
    return "rebuild" if "rebuild" in entry else "version"


def is_heldout(entry: dict) -> bool:
    return bool(entry.get("heldout"))


def is_public(entry: dict) -> bool:
    """A file anybody can have: rebuilt from public sources, so neither the version nor a token is needed."""
    return kind(entry) == "rebuild" and not is_heldout(entry)


def classes(entry: dict) -> set[str]:
    return {kind(entry), "public" if is_public(entry) else "other", *(["heldout"] if is_heldout(entry) else [])}


def problems_in(manifest: dict) -> list[str]:
    """What is wrong with the manifest itself (not with the files it describes)."""
    out: list[str] = []
    pin = manifest.get("data")
    if not isinstance(pin, dict) or not isinstance(pin.get("repo"), str) or "/" not in pin.get("repo", ""):
        out.append("data: needs repo (OWNER/NAME)")
    else:
        if not TAG.fullmatch(str(pin.get("version", ""))):
            out.append(f"data: version {pin.get('version')!r} is not a data tag (data-vN)")
        if pin.get("revision") is not None and not COMMIT.fullmatch(str(pin["revision"])):
            out.append("data: revision is null (not published yet) or the 40 hex digits of a commit")
    seen_names: set[str] = set()
    seen_paths: set[str] = set()
    seen_version: set[str] = set()
    for e in entries(manifest):
        label = e.get("name", "?")
        for key in ("name", "path", "version_path", "sha256", "size", "from"):
            if key not in e:
                out.append(f"{label}: no {key!r}")
        if e.get("name") in seen_names:
            out.append(f"{label}: name used twice")
        if e.get("path") in seen_paths:
            out.append(f"{label}: path {e.get('path')} used twice")
        seen_names.add(e.get("name", ""))
        seen_paths.add(e.get("path", ""))
        if not SHA.fullmatch(str(e.get("sha256", ""))):
            out.append(f"{label}: sha256 is not 64 lowercase hex digits")
        for key in ("path", "version_path"):
            path = e.get(key)
            if path is None and key == "version_path" and "rebuild" in e:
                continue  # a file the tree only rebuilds (a keys file) has no copy in the version
            if not isinstance(path, str) or path.startswith("/") or ".." in Path(path).parts:
                out.append(f"{label}: {key} {path!r} is not a relative path inside its tree")
        version_path = e.get("version_path")
        if isinstance(version_path, str):
            if version_path in seen_version:
                out.append(f"{label}: version_path {version_path} used twice")
            seen_version.add(version_path)
            if version_path == VERSION_JSON:
                out.append(f"{label}: version_path is {VERSION_JSON}, which the version writes itself")
        if "rebuild" in e and not (isinstance(e["rebuild"], str) and e["rebuild"].strip()):
            out.append(f"{label}: rebuild is not a command")
        if "heldout" in e and not isinstance(e["heldout"], bool):
            out.append(f"{label}: heldout is true or false")
        if "rebuild" not in e and not isinstance(version_path, str):
            out.append(f"{label}: a file that does not rebuild comes from the version and needs a version_path")
    return out


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def status(entry: dict, root: Path) -> str:
    """ok, missing, or a sentence on how the file differs."""
    path = root / entry["path"]
    if not path.is_file():
        return "missing"
    if path.stat().st_size != entry["size"]:
        return f"size {path.stat().st_size}, the manifest says {entry['size']}"
    if sha256_of(path) != entry["sha256"]:
        return "sha256 differs from the manifest"
    return "ok"


def mb(n: int) -> str:
    return f"{n / 1e6:.2f} MB"


def pick(manifest: dict, only: list[str] | None) -> list[dict]:
    if not only:
        return entries(manifest)
    chosen = [e for e in entries(manifest) if any(e["name"].startswith(o) or e["path"].startswith(o) for o in only)]
    if not chosen:
        raise SystemExit(f"--only {only}: nothing in the manifest starts with that name or path")
    return chosen


# ---------------------------------------------------------------------------------------------
# check, paths, gitignore, rehash
# ---------------------------------------------------------------------------------------------


def cmd_check(args: argparse.Namespace) -> int:
    manifest = load(args.manifest)
    bad = problems_in(manifest)
    chosen = [e for e in entries(manifest) if is_public(e) or not args.public_only]
    ok = missing = 0
    for e in chosen:
        st = status(e, args.root)
        if st == "ok":
            ok += 1
            if args.verbose:
                print(f"ok       {e['path']}")
            continue
        missing += st == "missing"
        bad.append(f"{e['path']}: {st}")
    for line in bad:
        print(f"FAIL {line}")
    print(f"artefacts: {ok} of {len(chosen)} files match the manifest" + (f"; {len(bad)} problem(s)" if bad else ""))
    if missing:
        print("  materialise the missing files with: python3 artefacts.py fetch" + (" --public-only" if args.public_only else ""))
    return 1 if bad else 0


def cmd_paths(args: argparse.Namespace) -> int:
    for e in entries(load(args.manifest)):
        if args.klass is None or args.klass in classes(e):
            print(e["path"])
    return 0


def gitignore_block(manifest: dict) -> str:
    lines = sorted("/" + e["path"] for e in entries(manifest))
    return "\n".join([IGNORE_BEGIN, *lines, IGNORE_END]) + "\n"


def cmd_gitignore(args: argparse.Namespace) -> int:
    sys.stdout.write(gitignore_block(load(args.manifest)))
    return 0


def cmd_rehash(args: argparse.Namespace) -> int:
    """Rewrite sha256 and size of the manifest files that are in place: the step after a file of a new version changes."""
    manifest = load(args.manifest)
    changed = 0
    for e in pick(manifest, args.only):
        path = args.root / e["path"]
        if not path.is_file():
            print(f"skip   {e['path']}: not in place")
            continue
        sha, size = sha256_of(path), path.stat().st_size
        if (sha, size) != (e["sha256"], e["size"]):
            print(f"rehash {e['path']}: {e['sha256'][:12]} -> {sha[:12]}, {e['size']} -> {size} bytes")
            e["sha256"], e["size"] = sha, size
            changed += 1
    if changed:
        save(manifest, args.manifest)
    print(f"rehash: {changed} file(s) changed in the manifest")
    return 0


# ---------------------------------------------------------------------------------------------
# The Hub: the only place the library is touched, so a test replaces `hub_client` and nothing else
# ---------------------------------------------------------------------------------------------


class HubClient:
    """The calls the tool makes, over huggingface_hub; the token comes from the caller (the environment). `repo_type` is
    "dataset" for a data version and "model" for a promoted model."""

    def __init__(self, token: str):
        from huggingface_hub import HfApi

        self.token = token
        self.api = HfApi(token=token)

    def repo_private(self, repo: str, repo_type: str) -> bool | None:
        """True or False for a repository that exists, None when there is none."""
        from huggingface_hub.errors import RepositoryNotFoundError

        try:
            return bool(self.api.repo_info(repo, repo_type=repo_type).private)
        except RepositoryNotFoundError:
            return None

    def create_private(self, repo: str, repo_type: str) -> None:
        self.api.create_repo(repo, repo_type=repo_type, private=True, exist_ok=False)

    def create_public(self, repo: str, repo_type: str) -> None:
        self.api.create_repo(repo, repo_type=repo_type, private=False, exist_ok=False)

    def tags(self, repo: str, repo_type: str) -> list[str]:
        return [t.name for t in self.api.list_repo_refs(repo, repo_type=repo_type).tags]

    def list_files(self, repo: str, repo_type: str) -> list[str]:
        return list(self.api.list_repo_files(repo, repo_type=repo_type))

    def commit(self, repo: str, repo_type: str, files: dict[str, Path], delete: list[str], message: str) -> str:
        """Every file added and every path in `delete` removed, in one commit on the main branch; the commit's id."""
        from huggingface_hub import CommitOperationAdd, CommitOperationDelete

        ops = [CommitOperationAdd(path_in_repo=dest, path_or_fileobj=str(src)) for dest, src in sorted(files.items())]
        ops += [CommitOperationDelete(path_in_repo=path) for path in sorted(delete)]
        return self.api.create_commit(repo_id=repo, repo_type=repo_type, operations=ops, commit_message=message).oid

    def tag(self, repo: str, repo_type: str, tag: str, revision: str) -> None:
        self.api.create_tag(repo, tag=tag, revision=revision, repo_type=repo_type, exist_ok=False)

    def download(self, repo: str, revision: str, path_in_repo: str, into: Path, repo_type: str = "dataset") -> Path:
        from huggingface_hub import hf_hub_download

        return Path(
            hf_hub_download(repo_id=repo, repo_type=repo_type, revision=revision, filename=path_in_repo,
                            local_dir=str(into), token=self.token)
        )


def hub_client(token: str):
    return HubClient(token)


def token_from_env() -> str | None:
    return os.environ.get(HF_ENV) or None


def scrub(text: str, token: str | None) -> str:
    return text.replace(token, "***") if token else text


# ---------------------------------------------------------------------------------------------
# Sources: where a version's files are read from
# ---------------------------------------------------------------------------------------------


class DirSource:
    """A local directory laid out as a version (ARTEFACTS_SOURCE): no network, no token, any provider's copy of it."""

    def __init__(self, root: Path):
        self.root = root
        self.label = str(root)

    def get(self, version_path: str, into: Path) -> Path:
        src = self.root / version_path
        if not src.is_file():
            raise FileNotFoundError(f"{version_path} is not in {self.root}")
        dest = into / version_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        return dest


class HubSource:
    """The dataset repository at the commit the manifest pins."""

    def __init__(self, client, repo: str, revision: str):
        self.client, self.repo, self.revision = client, repo, revision
        self.label = f"{repo}@{revision[:12]}"

    def get(self, version_path: str, into: Path) -> Path:
        return self.client.download(self.repo, self.revision, version_path, into, "dataset")


def open_source(manifest: dict) -> tuple[object | None, str | None, str | None]:
    """(source, token, None) or (None, None, why not): ARTEFACTS_SOURCE first, else the pinned commit on the Hub."""
    env = os.environ.get(SOURCE_ENV)
    if env:
        if not Path(env).is_dir():
            return None, None, f"{SOURCE_ENV}={env} is not a directory"
        return DirSource(Path(env)), None, None
    pin = manifest["data"]
    if not pin.get("revision"):
        return None, None, (f"the manifest pins no commit of {pin['repo']} {pin['version']}: publish the version and run "
                            f"`artefacts.py pin REVISION` (or set {SOURCE_ENV} to a directory laid out as a version)")
    token = token_from_env()
    if not token:
        return None, None, f"{HF_ENV} is not set (the Hub repository is private), or set {SOURCE_ENV} to a local copy of the version"
    try:
        client = hub_client(token)
    except ImportError:
        return None, None, "huggingface_hub is not installed (it is pinned in requirements-ci.txt)"
    return HubSource(client, pin["repo"], pin["revision"]), token, None


def source_problem(source, manifest: dict, token: str | None) -> str | None:
    """Why the source is not the version the manifest pins, None when it is."""
    with tempfile.TemporaryDirectory(prefix="artefacts-version-") as scratch:
        try:
            got = source.get(VERSION_JSON, Path(scratch))
            meta = json.loads(got.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001  (the library's own error types are many; the message is what the operator needs)
            return f"{VERSION_JSON} cannot be read from {source.label}: {type(exc).__name__}: {scrub(str(exc), token)}"
    if meta.get("version") != manifest["data"]["version"]:
        return f"{source.label} is {meta.get('version')!r}, the manifest pins {manifest['data']['version']}"
    return None


# ---------------------------------------------------------------------------------------------
# fetch
# ---------------------------------------------------------------------------------------------


def run_env(root: Path, scratch: Path) -> dict:
    env = dict(os.environ)
    env["ARTEFACTS_TMP"] = str(scratch)
    return env


def rebuild(todo: list[dict], root: Path) -> list[str]:
    """Run each distinct rebuild command once, in order, from `root`; the problems found in what it wrote."""
    bad: list[str] = []
    done: dict[str, bool] = {}
    with tempfile.TemporaryDirectory(prefix="artefacts-") as scratch:
        env = run_env(root, Path(scratch))
        for e in todo:
            cmd = e["rebuild"]
            if cmd not in done:
                print(f"rebuild  {cmd}")
                proc = subprocess.run(cmd, shell=True, cwd=root, env=env, capture_output=True, text=True, check=False)
                done[cmd] = proc.returncode == 0
                if proc.returncode != 0:
                    tail = "\n".join((proc.stdout + proc.stderr).strip().splitlines()[-12:])
                    bad.append(f"{e['path']}: `{cmd}` exited {proc.returncode}\n{tail}")
            if not done[cmd]:
                continue
            st = status(e, root)
            if st != "ok":
                bad.append(f"{e['path']}: rebuilt, but {st}: the rebuild no longer reproduces the pinned bytes")
    return bad


def materialise(todo: list[dict], root: Path, source, token: str | None) -> list[str]:
    """Read each file from the source into a temporary directory, verify, then move it to its path."""
    bad: list[str] = []
    with tempfile.TemporaryDirectory(prefix="artefacts-fetch-") as scratch:
        for e in todo:
            try:
                got = source.get(e["version_path"], Path(scratch) / e["name"].replace("/", "_"))
            except Exception as exc:  # noqa: BLE001
                bad.append(f"{e['path']}: fetch failed: {type(exc).__name__}: {scrub(str(exc), token)}")
                continue
            if got.stat().st_size != e["size"] or sha256_of(got) != e["sha256"]:
                bad.append(f"{e['path']}: the bytes of {e['version_path']} in {source.label} do not match the manifest")
                continue
            dest = root / e["path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            part = dest.with_name(dest.name + ".part")
            shutil.copyfile(got, part)
            os.replace(part, dest)
            print(f"fetch    {e['path']}  ({mb(e['size'])})")
    return bad


def cmd_fetch(args: argparse.Namespace) -> int:
    manifest = load(args.manifest)
    bad = problems_in(manifest)
    if bad:
        for line in bad:
            print(f"FAIL {line}")
        return 1
    root: Path = args.root
    to_rebuild: list[dict] = []
    to_fetch: list[dict] = []
    left: list[dict] = []
    present = 0
    for e in pick(manifest, args.only):
        st = status(e, root)
        if st == "ok":
            present += 1
            continue
        if args.public_only and not is_public(e):
            left.append(e)
            continue
        if st != "missing" and not args.force:
            bad.append(f"{e['path']}: {st}; --force replaces it")
            continue
        (to_rebuild if kind(e) == "rebuild" else to_fetch).append(e)
    for line in bad:
        print(f"FAIL {line}")
    print(f"artefacts: {present} present and matching, {len(to_rebuild)} to rebuild, {len(to_fetch)} to fetch from the version")
    if left:
        print(f"  --public-only: {len(left)} file(s) left alone (held out, or from the version)")

    if args.dry_run:
        for cmd in dict.fromkeys(e["rebuild"] for e in to_rebuild):
            print(f"  would rebuild  {cmd}   ({sum(1 for e in to_rebuild if e['rebuild'] == cmd)} file(s))")
        pin = manifest["data"]
        where = f"{os.environ[SOURCE_ENV]}" if os.environ.get(SOURCE_ENV) else f"{pin['repo']}@{(pin['revision'] or 'unpinned')[:12]}"
        for e in to_fetch:
            print(f"  would fetch    {e['path']}  ({mb(e['size'])})  from {where}:{e['version_path']}")
        if to_fetch and not os.environ.get(SOURCE_ENV):
            if not pin["revision"]:
                print("  note: the manifest pins no commit yet; a real fetch needs `artefacts.py pin REVISION` or " + SOURCE_ENV)
            if not token_from_env():
                print(f"  note: {HF_ENV} is not set; a real fetch from the Hub needs it")
        return 1 if bad else 0

    source = token = None
    if to_fetch:
        source, token, why = open_source(manifest)
        if source is None:
            print(f"FAIL {len(to_fetch)} file(s) come from the version: {why} (or use --public-only)")
            return 1
        why = source_problem(source, manifest, token)
        if why:
            print(f"FAIL {why}")
            return 1
    for e in to_rebuild + to_fetch:
        if args.force and (root / e["path"]).exists():
            (root / e["path"]).unlink()
    if to_fetch:
        bad += materialise(to_fetch, root, source, token)
    bad += rebuild(to_rebuild, root)
    for line in bad:
        print(f"FAIL {line}")
    return 1 if bad else 0


# ---------------------------------------------------------------------------------------------
# verify-rebuild, verify-version
# ---------------------------------------------------------------------------------------------


def cmd_verify_rebuild(args: argparse.Namespace) -> int:
    """Rebuild every regenerable file in a scratch copy of this directory and compare it with the one in place."""
    manifest = load(args.manifest)
    chosen = [e for e in entries(manifest) if kind(e) == "rebuild" and (is_public(e) or not args.public_only)]
    with tempfile.TemporaryDirectory(prefix="artefacts-copy-") as scratch:
        copy = Path(scratch) / HERE.name
        shutil.copytree(args.root, copy, ignore=COPY_IGNORE)
        for e in chosen:
            (copy / e["path"]).unlink(missing_ok=True)
        bad = rebuild(chosen, copy)
        same = 0
        for e in chosen:
            made, kept = copy / e["path"], args.root / e["path"]
            if not made.is_file():
                continue
            if kept.is_file() and made.read_bytes() != kept.read_bytes():
                bad.append(f"{e['path']}: the rebuild differs from the file in place")
            else:
                same += 1
    for line in bad:
        print(f"FAIL {line}")
    print(f"verify-rebuild: {same} of {len(chosen)} regenerable file(s) rebuild byte for byte")
    return 1 if bad else 0


def cmd_verify_version(args: argparse.Namespace) -> int:
    """Read every file the manifest maps into the version from the source, at the pin, and compare it with the manifest."""
    manifest = load(args.manifest)
    chosen = [e for e in entries(manifest) if e.get("version_path")]
    source, token, why = open_source(manifest)
    if source is None:
        print(f"FAIL {why}")
        return 1
    why = source_problem(source, manifest, token)
    if why:
        print(f"FAIL {why}")
        return 1
    with tempfile.TemporaryDirectory(prefix="artefacts-verify-") as scratch:
        bad = materialise(chosen, Path(scratch), source, token)
    for line in bad:
        print(f"FAIL {line}")
    print(f"verify-version: {len(chosen) - len(bad)} of {len(chosen)} file(s) of {source.label} match the manifest")
    return 1 if bad else 0




# ---------------------------------------------------------------------------------------------
# version: assemble a data-version tree
# ---------------------------------------------------------------------------------------------










def git_commit(repo_root: Path) -> str | None:
    proc = subprocess.run(["git", "-C", str(repo_root), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    out = proc.stdout.strip()
    return out if proc.returncode == 0 and COMMIT.fullmatch(out) else None












# ---------------------------------------------------------------------------------------------
# publish, pin, model-card, publish-model
# ---------------------------------------------------------------------------------------------


def tree_files(directory: Path) -> dict[str, Path]:
    """Every file under `directory`, by its path relative to it."""
    return {p.relative_to(directory).as_posix(): p for p in sorted(directory.rglob("*")) if p.is_file()}


def publish_tree(client, repo: str, repo_type: str, files: dict[str, Path], tag: str, message: str, public: bool = False) -> str:
    """The files to the repository's main branch in one commit (paths not in `files` deleted), then `tag` on that commit. The
    repository is created private when missing and refused when public; an existing tag is never moved. The commit's id.

    `public=True` is the other rule, for the one thing that is published openly (a GGUF of the model, `publish-gguf`): the repository
    is created public when missing and refused when it exists private, so a public publish never lands somewhere that looks
    published and is not, and a private one never lands somewhere open."""
    what = {"dataset": "the held-out sets", "model": "a model trained on them"}[repo_type]
    want, name = (False, "public") if public else (True, "private")
    state = client.repo_private(repo, repo_type)
    if state is not None and state is not want:
        if public:
            raise Refusal(f"{repo} exists and is private: refusing to publish there (make it public on the Hub, or name another repository)")
        raise Refusal(f"{repo} exists and is public: refusing to put {what} there")
    if state is None:
        (client.create_public if public else client.create_private)(repo, repo_type)
        print(f"created {repo} ({repo_type}, {name})")
        state = client.repo_private(repo, repo_type)
    if state is not want:
        raise Refusal(f"{repo} is not confirmed {name} after creation: refusing to upload")
    if tag in client.tags(repo, repo_type):
        raise Refusal(f"{repo} already has the tag {tag}: a published version is never rewritten (publish the next one)")
    stale = [p for p in client.list_files(repo, repo_type) if p not in files and p not in KEEP_ON_PUBLISH]
    revision = client.commit(repo, repo_type, files, stale, message)
    client.tag(repo, repo_type, tag, revision)
    if client.repo_private(repo, repo_type) is not want:
        raise Refusal(f"{repo} is not {name} after the upload; check its visibility now")
    return revision


def publish_plan(repo: str, repo_type: str, files: dict[str, Path], tag: str, public: bool = False) -> None:
    total = sum(p.stat().st_size for p in files.values())
    print(f"publish to {repo} ({repo_type}, {'PUBLIC' if public else 'private'}) as {tag}: {len(files)} file(s), {mb(total)}, one commit on main, then the tag")
    for rel, path in sorted(files.items()):
        print(f"  {path.stat().st_size:>12,}  {rel}")








def model_files(directory: Path) -> dict[str, Path]:
    return {rel: p for rel, p in tree_files(directory).items() if rel != "README.md"}


def render_card(meta: dict, config: dict, name: str, data_version: str, data_repo: str, commit: str | None,
                scores: list[str], notes: list[str], files: dict[str, dict]) -> str:
    """The Hub model card: the data tag and the code that made the model, its training config and model config as they were."""
    args = meta.get("args", {})
    base = args.get("model") or "Qwen/Qwen3.5-0.8B"
    lines = ["---", f"base_model: {base}", "library_name: transformers", "pipeline_tag: text-generation",
             "datasets:", f"- {data_repo}", "tags:", "- centraid", "- native-tool-task", f"- {data_version}", "---", "",
             f"# {name}", "",
             f"A fine-tune of {base} for the native tool task ([#1044](https://github.com/srikanth235/centraid/issues/1044)): "
             "one model that drives the vault through eight tools, scored on held-out households.", "",
             "## Provenance", "",
             f"- Data version: `{data_version}` of the private dataset repository `{data_repo}`. The version holds the training "
             "build(s) as trained, val and test as its `version.json` records them (refrozen on that version's runtime, or kept as frozen), and the worlds.",
             f"- Card written at commit `{commit or 'unrecorded'}` of `srikanth235/centraid`. The commit the weights were trained at is the job bundle's.",
             f"- Trained (the `train_meta.json` in this directory): {meta.get('steps', '?')} steps, {meta.get('examples', '?')} examples, "
             f"{meta.get('tokens', '?')} tokens ({meta.get('label_tokens', '?')} with loss), "
             f"{round(meta.get('train_seconds', 0) / 3600, 2)} h."]
    if notes:
        lines += ["", "## Notes", ""] + [f"- {note}" for note in notes]
    lines += ["", "## Scores", ""]
    lines += [f"- {score}" for score in scores] if scores else ["- none recorded"]
    lines += ["", "## Training config", "",
              "`args` of the `train_meta.json` in this directory, as the trainer ran:", "", "```json", json.dumps(args, indent=1, sort_keys=True), "```",
              "", "## Model config", "", "`config.json`:", "", "```json", json.dumps(config, indent=1, sort_keys=True), "```",
              "", "## Files", "", "| file | bytes | sha256 |", "| --- | --- | --- |"]
    lines += [f"| `{rel}` | {f['size']:,} | `{f['sha256']}` |" for rel, f in sorted(files.items())]
    return "\n".join(lines) + "\n"


def cmd_model_card(args: argparse.Namespace) -> int:
    model: Path = args.model
    for needed in ("train_meta.json", "config.json"):
        if not (model / needed).is_file():
            print(f"FAIL {model / needed} is missing: the card is written from the checkpoint's own train_meta.json and config.json")
            return 1
    if not TAG.fullmatch(args.data_version):
        print(f"FAIL --data-version {args.data_version!r} is not a data tag (data-vN)")
        return 1
    meta = json.loads((model / "train_meta.json").read_text(encoding="utf-8"))
    config = json.loads((model / "config.json").read_text(encoding="utf-8"))
    files = {rel: {"size": p.stat().st_size, "sha256": sha256_of(p)} for rel, p in model_files(model).items()}
    repo_root: Path = args.repo_root
    commit = args.git_commit or git_commit(repo_root)
    data_repo = args.data_repo or load(args.manifest)["data"]["repo"]
    card = render_card(meta, config, args.name, args.data_version, data_repo, commit, args.score, args.note, files)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(card, encoding="utf-8")
    print(f"model card for {args.name} ({args.data_version}, commit {(commit or 'unrecorded')[:12]}) written to {args.out}")
    return 0


def cmd_publish_model(args: argparse.Namespace) -> int:
    files = tree_files(args.dir)
    if args.card:  # the card written beside the checkpoint, not in it: sent as its README.md
        if not args.card.is_file():
            print(f"FAIL --card {args.card} is not a file")
            return 1
        files["README.md"] = args.card
    bad = [f"{args.dir / needed} is missing" for needed in ("config.json",) if needed not in files]
    bad += [] if "README.md" in files else [f"{args.dir / 'README.md'} is missing: give the card with --card or write it into the directory"]
    bad += [] if any(rel.endswith(".safetensors") for rel in files) else [f"{args.dir} has no *.safetensors weights"]
    card = files["README.md"].read_text(encoding="utf-8") if "README.md" in files else ""
    if "Data version: `data-v" not in card:
        bad.append("README.md is not a card that names its data version: write it with `artefacts.py model-card`")
    if bad:
        for line in bad:
            print(f"FAIL {line}")
        return 1
    publish_plan(args.repo, "model", files, args.tag)
    if args.dry_run:
        print("dry run: nothing created, nothing sent")
        return 0
    token = token_from_env()
    if not token:
        print(f"FAIL {HF_ENV} is not set")
        return 1
    try:
        revision = publish_tree(hub_client(token), args.repo, "model", files, args.tag, f"Model {args.tag} of the native tool task (#1088)")
    except Refusal as why:
        print(f"FAIL {why}")
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL {type(exc).__name__}: {scrub(str(exc), token)}")
        return 1
    print(f"published {len(files)} file(s) to {args.repo}: tag {args.tag} is commit {revision}")
    return 0


# ---------------------------------------------------------------------------------------------
# publish-gguf: the one thing that is published openly
# ---------------------------------------------------------------------------------------------

BASE_MODEL = "Qwen/Qwen3.5-0.8B"
# The vision projector the phone pairs with the weights (crates/assist-llama/tests/real_vision.rs): the base model's, since
# fine-tuning leaves the vision tower alone and `train/to_gguf.py` converts the text weights only.
MMPROJ = {"repo": "unsloth/Qwen3.5-0.8B-GGUF", "file": "mmproj-F16.gguf", "revision": "6ab461498e2023f6e3c1baea90a8f0fe38ab64d0",
          "bytes": 204987232, "sha256": "56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453"}
GGUF_QUANTS = ("Q4_0", "Q8_0", "F16")
SIDECAR_SCHEMA = 1


def gguf_problems(gguf: Path, sidecar: dict) -> list[str]:
    """What stops a GGUF from being published: the sidecar `train/to_gguf.py` wrote must describe THIS file, and must say where
    the model came from (the private repository, tag and commit, the data version) and which llama.cpp read it."""
    bad: list[str] = []
    if sidecar.get("schema") != SIDECAR_SCHEMA:
        bad.append(f"the sidecar's schema is {sidecar.get('schema')!r}, not {SIDECAR_SCHEMA}")
    entry = (sidecar.get("files") or {}).get("gguf") or {}
    if entry.get("file") != gguf.name:
        bad.append(f"the sidecar describes {entry.get('file')!r}, not {gguf.name}")
    elif entry.get("bytes") != gguf.stat().st_size or entry.get("sha256") != sha256_of(gguf):
        bad.append(f"{gguf.name} is not the bytes the sidecar records: convert it again, or give the sidecar of this file")
    if entry.get("quant") not in GGUF_QUANTS:
        bad.append(f"the sidecar's quant is {entry.get('quant')!r}, one of {', '.join(GGUF_QUANTS)}")
    source = sidecar.get("source") or {}
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", str(source.get("repo") or "")):
        bad.append("the sidecar does not name the private source repository (to_gguf.py --source-repo OWNER/NAME)")
    if not source.get("tag"):
        bad.append("the sidecar does not name the source tag (to_gguf.py --source-tag)")
    if not COMMIT.fullmatch(str(source.get("revision") or "")):
        bad.append("the sidecar does not carry the source revision, 40 hex digits (to_gguf.py --source-revision)")
    if not TAG.fullmatch(str(source.get("data_version") or "")):
        bad.append("the sidecar does not name the data version, data-vN (the checkpoint's train_meta.json, or to_gguf.py --data-version)")
    if not COMMIT.fullmatch(str((sidecar.get("llama_cpp") or {}).get("commit") or "")):
        bad.append("the sidecar does not name the llama.cpp commit")
    return bad


def render_gguf_card(sidecar: dict, gguf: str, sidecar_file: str) -> str:
    """The Hub card of a published GGUF: what it is and is not, where it came from, what read it, and the bytes."""
    entry = sidecar["files"]["gguf"]
    source, cpp = sidecar["source"], sidecar["llama_cpp"]
    name = sidecar.get("name") or gguf
    lines = ["---", f"base_model: {BASE_MODEL}", "license: apache-2.0", "library_name: gguf", "pipeline_tag: text-generation",
             "tags:", "- centraid", "- native-tool-task", "- gguf", f"- {entry['quant']}", f"- {source['data_version']}", "---", "",
             f"# {name} ({entry['quant']})", "",
             f"A GGUF of a fine-tune of [{BASE_MODEL}](https://huggingface.co/{BASE_MODEL}) (Apache-2.0) for the native tool task "
             "([#1044](https://github.com/srikanth235/centraid/issues/1044)) of [Centraid](https://github.com/srikanth235/centraid): "
             "a personal, local-first superapp whose assistant runs on the phone. The model drives a personal vault through eight tools "
             "([`SPEC.md`](https://github.com/srikanth235/centraid/blob/main/experiments/toolchat/native/SPEC.md)): each step it writes a short "
             "*think* in a fixed slot format, and the app's runtime reads the think and writes the call.", "",
             "**This is not a general chat model.** It was trained to continue the exact prompt the Centraid runtime renders (the tool list, "
             "the vault block, the history) and to write the think the runtime compiles; outside that runtime it has no use. "
             "It is published so the on-device model can be fetched, checked against its hash and reproduced.", "",
             "## Provenance", "",
             f"- Base model: `{BASE_MODEL}`.",
             f"- Fine-tuned model: the private repository `{source['repo']}`, tag `{source['tag']}`, revision `{source['revision']}`.",
             f"- Data version: `{source['data_version']}` of the native tool task's private dataset repository (authored, synthetic households; "
             "no personal data).",
             f"- Converted with llama.cpp `{cpp['commit']}` (<{cpp['repo']}>), the commit that `{cpp['engine']}` (the engine the app links) vendors: "
             f"`convert_hf_to_gguf.py` to F16, then `llama-quantize` to `{entry['quant']}`. `{sidecar_file}` records the checkpoint's file hashes, "
             "the converter and quantizer hashes and the tool versions; `train/to_gguf.py` in the repository rebuilds this file byte for byte.", "",
             "## Vision", "",
             "A photograph is read by a separate projector the app loads beside these weights; fine-tuning left the vision tower as it was, so the "
             f"projector is the base model's: `{MMPROJ['file']}` of [`{MMPROJ['repo']}`](https://huggingface.co/{MMPROJ['repo']}) at revision "
             f"`{MMPROJ['revision']}` ({MMPROJ['bytes']:,} bytes, sha256 `{MMPROJ['sha256']}`). It is not part of this repository.", "",
             "## Files", "", "| file | bytes | sha256 |", "| --- | --- | --- |",
             f"| `{gguf}` | {entry['bytes']:,} | `{entry['sha256']}` |", ""]
    return "\n".join(lines)


def cmd_publish_gguf(args: argparse.Namespace) -> int:
    gguf: Path = args.gguf
    sidecar_path: Path = args.sidecar or gguf.with_name(gguf.name + ".json")
    for needed in (gguf, sidecar_path):
        if not needed.is_file():
            print(f"FAIL {needed} is not a file{' (train/to_gguf.py writes it beside the GGUF)' if needed == sidecar_path else ''}")
            return 1
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    bad = gguf_problems(gguf, sidecar)
    if bad:
        for line in bad:
            print(f"FAIL {line}")
        return 1
    with tempfile.TemporaryDirectory(prefix="publish-gguf-") as scratch:
        card = Path(scratch) / "README.md"
        card.write_text(render_gguf_card(sidecar, gguf.name, gguf.name + ".json"), encoding="utf-8")
        files = {"README.md": card, gguf.name: gguf, gguf.name + ".json": sidecar_path}
        publish_plan(args.repo, "model", files, args.tag, public=True)
        if args.dry_run:
            print("\n--- README.md ---\n" + card.read_text(encoding="utf-8") + "--- end ---")
            print("dry run: nothing created, nothing sent")
            return 0
        token = token_from_env()
        if not token:
            print(f"FAIL {HF_ENV} is not set (the plan above is what would be sent; --dry-run prints the card too)")
            return 1
        try:
            revision = publish_tree(hub_client(token), args.repo, "model", files, args.tag,
                                    f"GGUF {args.tag} of the native tool task (#1088)", public=True)
        except Refusal as why:
            print(f"FAIL {why}")
            return 1
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL {type(exc).__name__}: {scrub(str(exc), token)}")
            return 1
    print(f"published {len(files)} file(s) to {args.repo} (public): tag {args.tag} is commit {revision}")
    return 0


# ---------------------------------------------------------------------------------------------
# format: the committed layout of the world JSON
# ---------------------------------------------------------------------------------------------

WIDTH = 80
_TOKEN = re.compile(r'(\s*)(?:([{}\[\],:])|("(?:[^"\\]|\\.)*")|([^\s{}\[\],:"]+))')


class _Node:
    __slots__ = ("kind", "raw", "items", "broken")

    def __init__(self, kind: str, raw: str = "", items: list | None = None, broken: bool = False):
        self.kind, self.raw, self.items, self.broken = kind, raw, items or [], broken


def _parse(text: str) -> _Node:
    toks: list[tuple[str, str, str]] = []  # (whitespace before, kind, raw): kind is p(unctuation), s(tring) or v(alue)
    pos, end = 0, len(text.rstrip())
    while pos < end:
        m = _TOKEN.match(text, pos)
        if not m:
            raise ValueError(f"JSON: unexpected text at offset {pos}")
        pos = m.end()
        toks.append((m.group(1), "p" if m.group(2) else "s" if m.group(3) else "v", m.group(2) or m.group(3) or m.group(4)))
    at = 0

    def value() -> _Node:
        nonlocal at
        _, k, raw = toks[at]
        at += 1
        if raw == "{" and k == "p":
            node = _Node("obj", broken="\n" in toks[at][0])
            while toks[at][2] != "}":
                key = toks[at][2]
                at += 2  # the key and its colon
                node.items.append((key, value()))
                if toks[at][2] == ",":
                    at += 1
            at += 1
            return node
        if raw == "[" and k == "p":
            node = _Node("arr")
            while toks[at][2] != "]":
                node.items.append(value())
                if toks[at][2] == ",":
                    at += 1
            at += 1
            return node
        return _Node("lit", raw=raw)

    root = value()
    if at != len(toks):
        raise ValueError("JSON: more than one value")
    return root


def _width(text: str) -> int:
    return sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def _children(n: _Node) -> list[_Node]:
    return [v for _, v in n.items] if n.kind == "obj" else n.items


def _flat(n: _Node) -> str:
    if n.kind == "lit":
        return n.raw
    if n.kind == "arr":
        return "[" + ", ".join(_flat(c) for c in n.items) + "]"
    return "{ " + ", ".join(f"{k}: {_flat(v)}" for k, v in n.items) + " }" if n.items else "{}"


def _forced(n: _Node) -> bool:
    """A group Prettier cannot keep on one line: an object the source broke, and an array of several objects or arrays."""
    if n.kind == "obj" and n.items and n.broken:
        return True
    if n.kind == "arr" and len(n.items) > 1 and all(c.kind in ("arr", "obj") and len(_children(c)) > 1 for c in n.items) \
            and len({c.kind for c in n.items}) == 1:
        return True
    return any(_forced(c) for c in _children(n))


def _numeric(n: _Node) -> bool:
    return n.kind == "lit" and re.fullmatch(r"[+-]?[0-9.][0-9a-zA-Z.+-]*", n.raw) is not None


def _render(n: _Node, ind: int, prefix: int, trail: str, out: list[str]) -> None:
    pad = " " * ind
    if n.kind == "lit":
        out.append(n.raw + trail)
        return
    if not _children(n):
        out.append(("{}" if n.kind == "obj" else "[]") + trail)
        return
    if not _forced(n):
        flat = _flat(n)
        if ind + prefix + _width(flat) + len(trail) <= WIDTH:
            out.append(flat + trail)
            return
    close = "}" if n.kind == "obj" else "]"
    out.append("{\n" if n.kind == "obj" else "[\n")
    if n.kind == "obj":
        for i, (key, child) in enumerate(n.items):
            out.append(f"{pad}  {key}: ")
            _render(child, ind + 2, _width(key) + 2, "," if i < len(n.items) - 1 else "", out)
            out.append("\n")
    elif len(n.items) > 1 and all(_numeric(c) for c in n.items):  # numbers fill the line
        col = 0
        for i, c in enumerate(n.items):
            piece = c.raw + ("," if i < len(n.items) - 1 else "")
            if i == 0:
                out.append(pad + "  " + piece)
                col = ind + 2 + len(piece)
            elif col + 1 + len(piece) <= WIDTH:
                out.append(" " + piece)
                col += 1 + len(piece)
            else:
                out.append("\n" + pad + "  " + piece)
                col = ind + 2 + len(piece)
        out.append("\n")
    else:
        for i, c in enumerate(n.items):
            out.append(pad + "  ")
            _render(c, ind + 2, 0, "," if i < len(n.items) - 1 else "", out)
            out.append("\n")
    out.append(pad + close + trail)


def format_json(text: str) -> str:
    """The text of one JSON value in the repository formatter's layout, with a final newline."""
    out: list[str] = []
    _render(_parse(text), 0, 0, "", out)
    result = "".join(out) + "\n"
    if json.loads(result) != json.loads(text):
        raise ValueError("format_json changed the value")
    return result


def cmd_format(args: argparse.Namespace) -> int:
    bad = 0
    for name in args.files:
        path = Path(name)
        text = path.read_text(encoding="utf-8")
        out = format_json(text)
        if out == text:
            continue
        if args.check:
            print(f"differs: {name}")
            bad += 1
        else:
            path.write_text(out, encoding="utf-8")
    return 1 if bad else 0


# ---------------------------------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", type=Path, default=MANIFEST, help="the manifest (default: artefacts.json beside this file)")
    parser.add_argument("--root", type=Path, default=HERE, help="the directory the manifest paths are relative to")
    parser.add_argument("--repo-root", type=Path, default=REPO, help="the repository (migrations, runtime export, git commit)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("check")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--public-only", action="store_true", help="only the files a public checkout rebuilds")
    p = sub.add_parser("fetch")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--public-only", action="store_true", help="only what is rebuilt from public sources: no version, no token")
    p.add_argument("--force", action="store_true", help="replace files that exist but differ from the manifest")
    p.add_argument("--only", nargs="+", metavar="NAME_OR_PATH_PREFIX")
    sub.add_parser("verify-rebuild").add_argument("--public-only", action="store_true")
    sub.add_parser("verify-version")
    p = sub.add_parser("model-card", help="write the Hub model card of a checkpoint")
    p.add_argument("--model", type=Path, required=True, help="the checkpoint directory (config.json, train_meta.json, weights)")
    p.add_argument("--data-version", required=True, metavar="data-vN")
    p.add_argument("--name", required=True)
    p.add_argument("--score", action="append", default=[], metavar="LINE", help="a score line for the card (repeatable)")
    p.add_argument("--note", action="append", default=[], metavar="TEXT", help="a note for the card (repeatable)")
    p.add_argument("--data-repo", metavar="OWNER/NAME", help="default: the manifest's")
    p.add_argument("--git-commit", help="the commit the model's code is at (default HEAD of --repo-root)")
    p.add_argument("--out", type=Path, required=True)
    p = sub.add_parser("publish-model", help="a checkpoint with its card to a private model repository, tagged")
    p.add_argument("dir", type=Path)
    p.add_argument("--repo", required=True, metavar="OWNER/NAME")
    p.add_argument("--tag", required=True, metavar="NAME")
    p.add_argument("--card", type=Path, metavar="FILE", help="the model card (artefacts.py model-card), sent as README.md: the "
                   "checkpoint directory is not written to")
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("publish-gguf", help="a GGUF with its sidecar and a card to a PUBLIC model repository, tagged")
    p.add_argument("gguf", type=Path)
    p.add_argument("--repo", required=True, metavar="OWNER/NAME")
    p.add_argument("--tag", required=True, metavar="NAME")
    p.add_argument("--sidecar", type=Path, metavar="FILE", help="the sidecar train/to_gguf.py wrote (default: GGUF.json beside it)")
    p.add_argument("--dry-run", "--plan", action="store_true", dest="dry_run", help="print what would be sent, and the card; send nothing")
    p = sub.add_parser("rehash")
    p.add_argument("--only", nargs="+", metavar="NAME_OR_PATH_PREFIX")
    sub.add_parser("paths").add_argument("--class", dest="klass", choices=["rebuild", "version", "heldout", "public"])
    sub.add_parser("gitignore")
    p = sub.add_parser("format")
    p.add_argument("--check", action="store_true")
    p.add_argument("files", nargs="+")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    handlers = {"check": cmd_check, "fetch": cmd_fetch, "verify-rebuild": cmd_verify_rebuild, "verify-version": cmd_verify_version,
                "model-card": cmd_model_card, "publish-model": cmd_publish_model, "publish-gguf": cmd_publish_gguf, "rehash": cmd_rehash, "paths": cmd_paths,
                "gitignore": cmd_gitignore, "format": cmd_format}
    try:
        return handlers[args.cmd](args)
    except Refusal as why:
        print(f"FAIL {why}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
