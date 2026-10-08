#!/usr/bin/env python3
"""The built and frozen artefacts of the native tool task, and how they come back (#1088, R-1088-14).

    python3 artefacts.py check [-v]                        # every manifest file is present and matches its sha256
    python3 artefacts.py fetch [--dry-run] [--rebuild-only] [--force] [--only NAME_OR_PATH_PREFIX ...]
    python3 artefacts.py upload --repo OWNER/NAME [--dry-run]
    python3 artefacts.py verify-rebuild                    # rebuild every regenerable file in a scratch copy, compare bytes
    python3 artefacts.py verify-hub [--dry-run]            # download every Hub file at its revision, compare sha256
    python3 artefacts.py paths [--class rebuild|hub]       # manifest paths, one per line
    python3 artefacts.py gitignore                         # the .gitignore block for the manifest paths
    python3 artefacts.py format [--check] FILE ...         # the committed layout of the world JSON (see below)

`artefacts.json` is the record: one entry per file, its logical name, its path under this directory, its sha256 and size, where
it comes from, and how it comes back. A file either rebuilds (`"rebuild"`: a shell command, run here, that writes the file at
its path) or lives on the Hub (`"hub"`: the private dataset repository, the revision it was uploaded at, the path in it).
The tool writes every file at the path the rest of the code already reads, and verifies the sha256 of every byte it
materialises: a rebuild whose bytes differ, or a download that does, fails and reports the file. A rebuild command runs in a
shell from this directory, so the manifest is reviewed like any script; one command that writes several files runs once.

The Hub is reached with `huggingface_hub` (already pinned by hash in requirements-ci.txt) and a token read from the
environment variable HF_TOKEN only: it is never written to disk, logged or passed on a command line. `check`, `format`,
the rebuilds and every `--dry-run` need neither the token nor the library.

Rebuilds that need a program besides Python: `nativetools` for the keys files (`seed_worlds.py` runs it: set NATIVETOOLS, or
build it at target/debug/nativetools). Rebuild entries come before the entries that depend on them (a keys file seeds from
its world JSON).

`format` is the layout `oxfmt` gives the world JSON the builders write, in Python so that a rebuild needs no JavaScript
toolchain. The builders write `json.dumps` text; the committed files are that text after the repository formatter (Prettier
rules, print width 80: an object keeps the break after its `{` if the source had one, an array or object that fits on its
line stays on it). It is checked byte for byte against every world file by `verify-rebuild`.
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
PLACEHOLDER = "<set at upload>"
HF_ENV = "HF_TOKEN"
IGNORE_BEGIN = "# artefacts.json: begin (artefacts.py gitignore)"
IGNORE_END = "# artefacts.json: end"
SHA = re.compile(r"[0-9a-f]{64}")
# What a scratch copy of this directory leaves out: the authored sources and docs are not needed to rebuild.
COPY_IGNORE = shutil.ignore_patterns("__pycache__", "sessions", "sets", "data", "*.pyc")


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
    return "rebuild" if "rebuild" in entry else "hub"


def problems_in(manifest: dict) -> list[str]:
    """What is wrong with the manifest itself (not with the files it describes)."""
    out: list[str] = []
    seen_names: set[str] = set()
    seen_paths: set[str] = set()
    for e in entries(manifest):
        label = e.get("name", "?")
        for key in ("name", "path", "sha256", "size", "from"):
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
        path = str(e.get("path", ""))
        if path.startswith("/") or ".." in Path(path).parts:
            out.append(f"{label}: path {path} is not relative to this directory")
        if ("rebuild" in e) == ("hub" in e):
            out.append(f"{label}: exactly one of 'rebuild' and 'hub'")
        elif "hub" in e and not {"repo", "revision", "path"} <= e["hub"].keys():
            out.append(f"{label}: hub needs repo, revision and path")
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
# check, paths, gitignore
# ---------------------------------------------------------------------------------------------


def cmd_check(args: argparse.Namespace) -> int:
    manifest = load(args.manifest)
    bad = problems_in(manifest)
    ok = missing = 0
    for e in entries(manifest):
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
    print(f"artefacts: {ok} of {len(entries(manifest))} files match the manifest" + (f"; {len(bad)} problem(s)" if bad else ""))
    if missing:
        print("  materialise the missing files with: python3 artefacts.py fetch")
    return 1 if bad else 0


def cmd_paths(args: argparse.Namespace) -> int:
    for e in entries(load(args.manifest)):
        if args.klass in (None, kind(e)):
            print(e["path"])
    return 0


def gitignore_block(manifest: dict) -> str:
    lines = sorted("/" + e["path"] for e in entries(manifest))
    return "\n".join([IGNORE_BEGIN, *lines, IGNORE_END]) + "\n"


def cmd_gitignore(args: argparse.Namespace) -> int:
    sys.stdout.write(gitignore_block(load(args.manifest)))
    return 0


# ---------------------------------------------------------------------------------------------
# The Hub: the only place the library is touched, so a test replaces `hub_client` and nothing else
# ---------------------------------------------------------------------------------------------


class HubClient:
    """The five calls the tool makes, over huggingface_hub; the token comes from the caller (the environment)."""

    def __init__(self, token: str):
        from huggingface_hub import HfApi

        self.token = token
        self.api = HfApi(token=token)

    def repo_private(self, repo: str) -> bool | None:
        """True or False for a dataset repository that exists, None when there is none."""
        from huggingface_hub.errors import RepositoryNotFoundError

        try:
            return bool(self.api.repo_info(repo, repo_type="dataset").private)
        except RepositoryNotFoundError:
            return None

    def create_private(self, repo: str) -> None:
        self.api.create_repo(repo, repo_type="dataset", private=True, exist_ok=False)

    def commit(self, repo: str, files: dict[str, Path], message: str) -> str:
        """Every file in one commit; the commit's id."""
        from huggingface_hub import CommitOperationAdd

        ops = [CommitOperationAdd(path_in_repo=dest, path_or_fileobj=str(src)) for dest, src in sorted(files.items())]
        return self.api.create_commit(repo_id=repo, repo_type="dataset", operations=ops, commit_message=message).oid

    def download(self, repo: str, revision: str, path_in_repo: str, into: Path) -> Path:
        from huggingface_hub import hf_hub_download

        return Path(
            hf_hub_download(repo_id=repo, repo_type="dataset", revision=revision, filename=path_in_repo,
                            local_dir=str(into), token=self.token)
        )


def hub_client(token: str):
    return HubClient(token)


def token_from_env() -> str | None:
    return os.environ.get(HF_ENV) or None


def scrub(text: str, token: str | None) -> str:
    return text.replace(token, "***") if token else text


# ---------------------------------------------------------------------------------------------
# fetch
# ---------------------------------------------------------------------------------------------


def run_env(root: Path, scratch: Path) -> dict:
    env = dict(os.environ)
    env["ARTEFACTS_TMP"] = str(scratch)
    if "NATIVETOOLS" not in env and (REPO / "target" / "debug" / "nativetools").exists():
        env["NATIVETOOLS"] = str(REPO / "target" / "debug" / "nativetools")
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
                bad.append(f"{e['path']}: rebuilt, but {st}: the rebuild no longer reproduces the frozen bytes")
    return bad


def download(todo: list[dict], root: Path, token: str) -> list[str]:
    """Fetch each file at its recorded revision into a temporary directory, verify, then move it to its path."""
    try:
        client = hub_client(token)
    except ImportError:
        return ["huggingface_hub is not installed (it is pinned in requirements-ci.txt)"]
    bad: list[str] = []
    with tempfile.TemporaryDirectory(prefix="artefacts-hub-") as scratch:
        for e in todo:
            hub = e["hub"]
            try:
                got = client.download(hub["repo"], hub["revision"], hub["path"], Path(scratch) / e["name"].replace("/", "_"))
            except Exception as exc:  # the library's own error types are many; the message is what the operator needs
                bad.append(f"{e['path']}: download failed: {type(exc).__name__}: {scrub(str(exc), token)}")
                continue
            if got.stat().st_size != e["size"] or sha256_of(got) != e["sha256"]:
                bad.append(f"{e['path']}: the Hub's bytes at {hub['repo']}@{hub['revision'][:12]} do not match the manifest")
                continue
            dest = root / e["path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            part = dest.with_name(dest.name + ".part")
            shutil.copyfile(got, part)
            os.replace(part, dest)
            print(f"download {e['path']}  ({mb(e['size'])})")
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
    to_download: list[dict] = []
    present = 0
    for e in pick(manifest, args.only):
        st = status(e, root)
        if st == "ok":
            present += 1
            continue
        if st != "missing" and not args.force:
            bad.append(f"{e['path']}: {st}; --force replaces it")
            continue
        (to_rebuild if kind(e) == "rebuild" else to_download).append(e)
    for line in bad:
        print(f"FAIL {line}")
    print(f"artefacts: {present} present and matching, {len(to_rebuild)} to rebuild, {len(to_download)} to download")
    skipped: list[dict] = []
    if args.rebuild_only and to_download:
        skipped, to_download = to_download, []
        print(f"  --rebuild-only: {len(skipped)} Hub file(s) left alone ({mb(sum(e['size'] for e in skipped))})")

    unset = [e for e in to_download if PLACEHOLDER in (e["hub"]["repo"], e["hub"]["revision"])]
    if args.dry_run:
        for cmd in dict.fromkeys(e["rebuild"] for e in to_rebuild):
            print(f"  would rebuild  {cmd}   ({sum(1 for e in to_rebuild if e['rebuild'] == cmd)} file(s))")
        for e in to_download:
            hub = e["hub"]
            print(f"  would download {e['path']}  ({mb(e['size'])})  from {hub['repo']}@{hub['revision']}")
        if unset:
            print("  note: the upload has not run, so the manifest names no Hub revision yet")
        if to_download and not token_from_env():
            print(f"  note: {HF_ENV} is not set; a real fetch needs it")
        return 1 if bad else 0

    if unset:
        print(f"FAIL the manifest has no Hub revision for {len(unset)} file(s): the upload has not run (artefacts.py upload)")
        return 1
    token = token_from_env()
    if to_download and not token:
        print(f"FAIL {len(to_download)} file(s) live on the Hub and {HF_ENV} is not set (or use --rebuild-only)")
        return 1
    for e in to_rebuild + to_download:
        if args.force and (root / e["path"]).exists():
            (root / e["path"]).unlink()
    bad += rebuild(to_rebuild, root)
    if to_download:
        bad += download(to_download, root, token or "")
    for line in bad:
        print(f"FAIL {line}")
    return 1 if bad else 0


# ---------------------------------------------------------------------------------------------
# upload, verify-hub, verify-rebuild
# ---------------------------------------------------------------------------------------------


def hub_entries(manifest: dict, root: Path) -> tuple[list[dict], list[str]]:
    chosen = [e for e in entries(manifest) if kind(e) == "hub"]
    return chosen, [f"{e['path']}: {status(e, root)}" for e in chosen if status(e, root) != "ok"]


def cmd_upload(args: argparse.Namespace) -> int:
    manifest = load(args.manifest)
    bad = problems_in(manifest)
    chosen, wrong = hub_entries(manifest, args.root)
    bad += [f"{line} (the upload sends the bytes the manifest pins)" for line in wrong]
    if bad:
        for line in bad:
            print(f"FAIL {line}")
        return 1
    total = sum(e["size"] for e in chosen)
    print(f"upload to {args.repo} (dataset, private): {len(chosen)} file(s), {mb(total)}, one commit")
    for e in chosen:
        print(f"  {e['size']:>10,}  {e['sha256'][:12]}  {e['path']}")
    if args.dry_run:
        print("dry run: nothing created, nothing sent")
        return 0
    token = token_from_env()
    if not token:
        print(f"FAIL {HF_ENV} is not set")
        return 1
    try:
        client = hub_client(token)
        state = client.repo_private(args.repo)
        if state is False:
            print(f"FAIL {args.repo} exists and is public: refusing to put the frozen sets there")
            return 1
        if state is None:
            client.create_private(args.repo)
            print(f"created {args.repo} (private)")
            state = client.repo_private(args.repo)
        if state is not True:
            print(f"FAIL {args.repo} is not confirmed private after creation: refusing to upload")
            return 1
        revision = client.commit(args.repo, {e["path"]: args.root / e["path"] for e in chosen},
                                 f"Frozen artefacts of the native tool task: {len(chosen)} files (#1088)")
        if client.repo_private(args.repo) is not True:
            print(f"FAIL {args.repo} is not private after the upload; check its visibility now")
            return 1
    except Exception as exc:
        print(f"FAIL {type(exc).__name__}: {scrub(str(exc), token)}")
        return 1
    for e in chosen:
        e["hub"] = {"repo": args.repo, "revision": revision, "path": e["path"]}
    save(manifest, args.manifest)
    print(f"uploaded {len(chosen)} file(s) to {args.repo} at revision {revision}")
    print("the manifest records it: commit artefacts.json, then run move_out.sh")
    return 0


def cmd_verify_hub(args: argparse.Namespace) -> int:
    manifest = load(args.manifest)
    chosen = [e for e in entries(manifest) if kind(e) == "hub"]
    unset = [e for e in chosen if PLACEHOLDER in (e["hub"]["repo"], e["hub"]["revision"])]
    if unset:
        print(f"FAIL {len(unset)} file(s) have no Hub revision: the upload has not run")
        return 1
    if args.dry_run:
        for e in chosen:
            print(f"  would download {e['path']}  from {e['hub']['repo']}@{e['hub']['revision'][:12]}")
        return 0
    token = token_from_env()
    if not token:
        print(f"FAIL {HF_ENV} is not set")
        return 1
    with tempfile.TemporaryDirectory(prefix="artefacts-verify-") as scratch:
        bad = download(chosen, Path(scratch), token)
    for line in bad:
        print(f"FAIL {line}")
    print(f"verify-hub: {len(chosen) - len(bad)} of {len(chosen)} Hub file(s) match the manifest")
    return 1 if bad else 0


def cmd_verify_rebuild(args: argparse.Namespace) -> int:
    """Rebuild every regenerable file in a scratch copy of this directory and compare it with the one in place."""
    manifest = load(args.manifest)
    chosen = [e for e in entries(manifest) if kind(e) == "rebuild"]
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", type=Path, default=MANIFEST, help="the manifest (default: artefacts.json beside this file)")
    parser.add_argument("--root", type=Path, default=HERE, help="the directory the manifest paths are relative to")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check").add_argument("-v", "--verbose", action="store_true")
    p = sub.add_parser("fetch")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--rebuild-only", action="store_true", help="leave the Hub files alone (no token needed)")
    p.add_argument("--force", action="store_true", help="replace files that exist but differ from the manifest")
    p.add_argument("--only", nargs="+", metavar="NAME_OR_PATH_PREFIX")
    p = sub.add_parser("upload")
    p.add_argument("--repo", required=True, metavar="OWNER/NAME")
    p.add_argument("--dry-run", action="store_true")
    sub.add_parser("verify-rebuild")
    sub.add_parser("verify-hub").add_argument("--dry-run", action="store_true")
    sub.add_parser("paths").add_argument("--class", dest="klass", choices=["rebuild", "hub"])
    sub.add_parser("gitignore")
    p = sub.add_parser("format")
    p.add_argument("--check", action="store_true")
    p.add_argument("files", nargs="+")
    args = parser.parse_args(argv)
    handlers = {"check": cmd_check, "fetch": cmd_fetch, "upload": cmd_upload, "verify-rebuild": cmd_verify_rebuild,
                "verify-hub": cmd_verify_hub, "paths": cmd_paths, "gitignore": cmd_gitignore, "format": cmd_format}
    return handlers[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
