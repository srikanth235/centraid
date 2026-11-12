"""The run record: what a run was, written to `<outputs>/run.json` so an adapter can be traced to its inputs and judged against them.

It holds the git commit the image was built from, the hash of the job file, the base model's revision, the hash and size of every data file
as it was read, the package versions, the seed, and where the run resumed from. It holds no wall-clock time, host name or absolute path
(the same run is the same record). The commit comes from `CENTRAID_GIT_COMMIT` (the image build sets it) or `git rev-parse HEAD`; with neither,
the record says `unknown`, and a launcher refuses to submit such an image.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
from importlib import metadata
from pathlib import Path

SCHEMA = 1
PACKAGES = ("torch", "transformers", "peft", "safetensors", "tokenizers", "zstandard", "numpy", "boto3", "google-cloud-storage")


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def package_versions() -> dict:
    out = {}
    for name in PACKAGES:
        try:
            out[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            out[name] = None
    return out


def git_commit(repo=None) -> str:
    env = os.environ.get("CENTRAID_GIT_COMMIT", "").strip()
    if env:
        return env
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo or Path(__file__).resolve().parent, capture_output=True, text=True, check=True)
        return out.stdout.strip() or "unknown"
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def data_entry(uri: str, path) -> dict:
    return {"uri": uri, "sha256": sha256_file(path), "bytes": Path(path).stat().st_size}


def build(job, *, data: dict, resumed_from: int | None, device: str, repo=None, data_source: dict | None = None) -> dict:
    """The record at the start of a run. `data` maps `train` (and `val`) to `data_entry` results; `data_source` is `hf.fetch_version`'s
    `source` (repo, revision, the manifest and its hash) when the data came from the Hugging Face dataset."""
    return {
        "schema": SCHEMA,
        "name": job.name,
        "git_commit": git_commit(repo),
        "job_sha256": job.digest(),
        "base": {"model": job.base_model, "revision": job.base_revision, "weights": job.base_weights, "gguf": job.base_gguf},
        "lora": {"rank": job.lora.rank, "alpha": job.lora.alpha, "dropout": job.lora.dropout, "targets": list(job.lora.targets)},
        "data": data,
        "data_source": data_source,
        "seed": job.schedule.seed,
        "device": device,
        "python": platform.python_version(),
        "packages": package_versions(),
        "resumed_from_step": resumed_from,
    }


def finish(record: dict, *, steps: int, metrics: dict, adapter_files: dict) -> dict:
    """The record at the end: the steps done, the held-out numbers, and the hash of each file the run wrote."""
    return {**record, "steps_done": steps, "metrics": metrics, "adapter_files": adapter_files}


def dumps(record: dict) -> str:
    return json.dumps(record, indent=1, sort_keys=True) + "\n"
