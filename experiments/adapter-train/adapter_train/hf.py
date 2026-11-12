"""A data version on the private Hugging Face dataset repo, pinned to a revision: `hf://datasets/<owner>/<repo>@<revision>`.

    hf://datasets/srikanth235/centraid-native-data@v0.2

One revision per data version (`cargo run -p centraid-datagen -- build --version vN`, published by its own command). The layout is the
datagen one: `manifest.json` and `data/{train,val,test,noise}.jsonl.zst`. **ONLY `train` AND `val` ARE EVER REQUESTED.** The test split is
never fetched, however the job file is written (`FILES` has no other keys, and a test asserts the fetcher is never asked for it).

The revision is pinned: a moving branch (`main`, `master`, `HEAD`) is refused. The token is read from `HF_TOKEN` (the platform's secret
mechanism) inside `https_fetch` and nowhere else; it is never in the job file, a log line, an exception message or the run record.

`fetch_version` is the one function that knows the layout: when Part H settles it, this is what changes. It takes a `fetch` callable so
the tests (and any offline run) read a local directory in the same layout.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .config import ConfigError

REF = re.compile(r"^hf://datasets/([A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*)@([A-Za-z0-9][\w./-]*)$")
MOVING = {"main", "master", "HEAD", "refs/heads/main"}
MANIFEST = "manifest.json"
FILES = {"train": "data/train.jsonl.zst", "val": "data/val.jsonl.zst"}  # the test split is not here, on purpose
TOKEN_ENV = "HF_TOKEN"
MAX_MANIFEST_KEPT = 1 << 16  # a manifest bigger than this is hashed, not copied into the run record


def parse(ref: str) -> tuple[str, str]:
    """`(repo, revision)` of a reference; ConfigError when it is not one or its revision moves."""
    m = REF.match(ref or "")
    if not m:
        raise ConfigError("data.hf must look like hf://datasets/<owner>/<repo>@<revision>, got %r" % (ref,))
    repo, revision = m.groups()
    if revision in MOVING:
        raise ConfigError("data.hf: revision %r moves; pin a data version's tag or commit" % revision)
    return repo, revision


def https_fetch(repo: str, revision: str, path: str, dest) -> None:
    """Download one file of a dataset repo at a revision. The token goes in a header and nowhere else."""
    url = "https://huggingface.co/datasets/%s/resolve/%s/%s" % (repo, urllib.parse.quote(revision, safe=""), path)
    request = urllib.request.Request(url)
    token = os.environ.get(TOKEN_ENV, "").strip()
    if token:
        request.add_header("Authorization", "Bearer " + token)
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(request, timeout=120) as response, open(dest, "wb") as out:  # noqa: S310 - https, fixed host
            for chunk in iter(lambda: response.read(1 << 20), b""):
                out.write(chunk)
    except urllib.error.HTTPError as e:
        # The status and the file, never the request: its headers hold the token.
        raise OSError("huggingface.co answered %d for %s@%s:%s%s" % (e.code, repo, revision, path,
                                                                 "" if token else " (no %s is set)" % TOKEN_ENV)) from None


def local_fetch(root):
    """A `fetch` over a directory in the repo's layout: the same code path, offline."""
    root = Path(root)

    def fetch(repo, revision, path, dest):
        src = root / path
        if not src.is_file():
            raise OSError("no %s in %s" % (path, root))
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        Path(dest).write_bytes(src.read_bytes())

    return fetch


def fetch_version(ref: str, dest, *, with_val: bool = True, fetch=https_fetch) -> dict:
    """Fetch the manifest and the train (and val) file of the version `ref` names into `dest`.

    Returns `{"paths": {"train": Path, "val": Path}, "source": {...}}`; `source` is what the run record keeps: the repo, the revision, the
    manifest's own sha256 and the manifest itself (its hashes are the version's), and the path each file was read from."""
    repo, revision = parse(ref)
    dest = Path(dest)
    manifest_path = dest / MANIFEST
    fetch(repo, revision, MANIFEST, manifest_path)
    raw = manifest_path.read_bytes()
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ConfigError("%s@%s: manifest.json is not JSON: %s" % (repo, revision, e)) from e
    paths = {}
    for key in ("train", "val") if with_val else ("train",):
        paths[key] = dest / FILES[key]
        fetch(repo, revision, FILES[key], paths[key])
    source = {"repo": repo, "revision": revision, "manifest_sha256": hashlib.sha256(raw).hexdigest(),
              "manifest": manifest if len(raw) <= MAX_MANIFEST_KEPT else None, "files": {k: FILES[k] for k in paths}}
    return {"paths": paths, "source": source}
