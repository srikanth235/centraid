"""One storage layer over a local (or mounted) path, `s3://` and `gs://`.

The trainer reads its data from, and writes its checkpoints and outputs to, three locations the job file names; this module is the only
place that knows what a location is. Everything is built on four calls of a `Backend` (`get`, `put`, `keys`, `delete`), so the s3 and
gs backends are thin and a test drives the rest through a backend of its own.

`boto3` and `google-cloud-storage` are imported when their backend is first used, so a run against paths needs neither.
A checkpoint is a directory whose last file written is `COMPLETE` (checkpoints.py): an object store has no atomic directory rename.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path


class StorageError(RuntimeError):
    pass


def split(uri: str) -> tuple[str, str, str]:
    """`(scheme, bucket, key)`: `("", "", path)` for a path, else the parts of `s3://bucket/key` or `gs://bucket/key`."""
    if "://" not in uri:
        return "", "", uri
    scheme, rest = uri.split("://", 1)
    bucket, _, key = rest.partition("/")
    if scheme not in ("s3", "gs") or not bucket:
        raise StorageError("unsupported location %r" % uri)
    return scheme, bucket, key.strip("/")


def join(uri: str, *parts: str) -> str:
    base = uri.rstrip("/")
    tail = "/".join(p.strip("/") for p in parts if p)
    return "%s/%s" % (base, tail) if tail else base


class LocalBackend:
    def get(self, bucket, key, dest):
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copyfile(key, dest)
        except FileNotFoundError as e:
            raise StorageError("no such file: %s" % key) from e

    def put(self, src, bucket, key):
        Path(key).parent.mkdir(parents=True, exist_ok=True)
        tmp = "%s.part" % key
        shutil.copyfile(src, tmp)
        os.replace(tmp, key)

    def keys(self, bucket, prefix):
        root = Path(prefix)
        if root.is_file():
            return [prefix]
        if not root.is_dir():
            return []
        return sorted(str(p) for p in root.rglob("*") if p.is_file() and not p.name.endswith(".part"))

    def delete(self, bucket, key):
        try:
            os.remove(key)
        except FileNotFoundError:
            pass


class S3Backend:
    def __init__(self, client=None):
        self._client = client

    @property
    def client(self):
        if self._client is None:
            import boto3  # noqa: PLC0415 - only a run that reads s3 needs it

            self._client = boto3.client("s3")
        return self._client

    def get(self, bucket, key, dest):
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        self.client.download_file(bucket, key, str(dest))

    def put(self, src, bucket, key):
        self.client.upload_file(str(src), bucket, key)

    def keys(self, bucket, prefix):
        out, token = [], None
        while True:
            kw = {"Bucket": bucket, "Prefix": prefix}
            if token:
                kw["ContinuationToken"] = token
            page = self.client.list_objects_v2(**kw)
            out += [o["Key"] for o in page.get("Contents", [])]
            token = page.get("NextContinuationToken")
            if not token:
                return sorted(out)

    def delete(self, bucket, key):
        self.client.delete_object(Bucket=bucket, Key=key)


class GsBackend:
    def __init__(self, client=None):
        self._client = client

    @property
    def client(self):
        if self._client is None:
            from google.cloud import storage  # noqa: PLC0415 - only a run that reads gs needs it

            self._client = storage.Client()
        return self._client

    def get(self, bucket, key, dest):
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        self.client.bucket(bucket).blob(key).download_to_filename(str(dest))

    def put(self, src, bucket, key):
        self.client.bucket(bucket).blob(key).upload_from_filename(str(src))

    def keys(self, bucket, prefix):
        return sorted(b.name for b in self.client.list_blobs(bucket, prefix=prefix))

    def delete(self, bucket, key):
        self.client.bucket(bucket).blob(key).delete()


_BACKENDS = {"": LocalBackend(), "s3": S3Backend(), "gs": GsBackend()}


def use_backend(scheme: str, backend) -> None:
    """Replace a scheme's backend (a test's stand-in, or a client with explicit credentials)."""
    _BACKENDS[scheme] = backend


def _b(uri):
    scheme, bucket, key = split(uri)
    return _BACKENDS[scheme], bucket, key


def get_file(uri: str, dest) -> Path:
    backend, bucket, key = _b(uri)
    backend.get(bucket, key, str(dest))
    return Path(dest)


def put_file(src, uri: str) -> None:
    backend, bucket, key = _b(uri)
    backend.put(str(src), bucket, key)


def exists(uri: str) -> bool:
    backend, bucket, key = _b(uri)
    return key in backend.keys(bucket, key)


def read_text(uri: str, scratch) -> str:
    return get_file(uri, Path(scratch) / "read.tmp").read_text(encoding="utf-8")


def write_text(uri: str, text: str, scratch) -> None:
    tmp = Path(scratch) / "write.tmp"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(text, encoding="utf-8")
    put_file(tmp, uri)


def names(uri: str) -> list[str]:
    """The entries directly under the prefix `uri` (a file's name, or a directory's), sorted."""
    backend, bucket, key = _b(uri)
    prefix = key.rstrip("/") + "/" if key else ""
    seen = set()
    for k in backend.keys(bucket, prefix if bucket else key):
        rel = os.path.relpath(k, key) if not bucket else k[len(prefix):]
        if rel and rel != "." and not rel.startswith(".."):
            seen.add(rel.split("/")[0].split(os.sep)[0])
    return sorted(seen)


def files(uri: str) -> list[str]:
    """Every file under the prefix `uri`, as paths relative to it, sorted."""
    backend, bucket, key = _b(uri)
    prefix = key.rstrip("/") + "/" if key else ""
    out = []
    for k in backend.keys(bucket, prefix if bucket else key):
        rel = os.path.relpath(k, key) if not bucket else k[len(prefix):]
        if rel and rel != "." and not rel.startswith(".."):
            out.append(rel.replace(os.sep, "/"))
    return sorted(out)


def put_tree(local_dir, uri: str, last: tuple[str, ...] = ()) -> None:
    """Upload every file of `local_dir` under `uri`; the files named in `last` (relative paths) go after all the others, in order."""
    root = Path(local_dir)
    rels = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
    for rel in [r for r in rels if r not in last] + [r for r in last if r in rels]:
        put_file(root / rel, join(uri, rel))


def get_tree(uri: str, local_dir) -> Path:
    root = Path(local_dir)
    for rel in files(uri):
        get_file(join(uri, rel), root / rel)
    return root


def delete_tree(uri: str) -> None:
    backend, bucket, key = _b(uri)
    for rel in files(uri):
        backend.delete(bucket, join(key, rel) if bucket else str(Path(key) / rel))
