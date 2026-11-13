"""Checkpoints on any storage, and resume from the newest complete one.

A checkpoint is the directory `ckpt-NNNNNNNN/` under the job's `checkpoints` location. Its files are uploaded one by one and the marker
`COMPLETE` goes LAST, so a Spot reclaim in the middle of an upload leaves a directory that is not a checkpoint and resume ignores. Only
complete checkpoints count, are pruned, and are resumed from. No torch here: what a checkpoint holds is the trainer's business.
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path

from . import storage

MARKER = "COMPLETE"
_NAME = re.compile(r"^ckpt-(\d{8})$")


def name_of(step: int) -> str:
    return "ckpt-%08d" % step


def complete(checkpoints: str) -> list[tuple[int, str]]:
    """`(step, name)` of every complete checkpoint, oldest first."""
    out = []
    for entry in storage.names(checkpoints):
        m = _NAME.match(entry)
        if m and storage.exists(storage.join(checkpoints, entry, MARKER)):
            out.append((int(m.group(1)), entry))
    return sorted(out)


def newest(checkpoints: str) -> tuple[int, str] | None:
    done = complete(checkpoints)
    return done[-1] if done else None


def publish(local_dir, checkpoints: str, step: int, keep: int) -> str:
    """Upload `local_dir` as checkpoint `step` (the marker last), then drop all but the newest `keep` complete ones. Returns its name."""
    name = name_of(step)
    local = Path(local_dir)
    (local / MARKER).write_text("%d\n" % step, encoding="utf-8")
    storage.put_tree(local, storage.join(checkpoints, name), last=(MARKER,))
    for _, old in complete(checkpoints)[:-keep]:
        storage.delete_tree(storage.join(checkpoints, old))
    return name


def fetch_newest(checkpoints: str, into) -> tuple[int, Path] | None:
    """Download the newest complete checkpoint into `into/<name>`; `None` when there is none (a fresh run)."""
    found = newest(checkpoints)
    if found is None:
        return None
    step, name = found
    dest = Path(into) / name
    if dest.exists():
        shutil.rmtree(dest)
    storage.get_tree(storage.join(checkpoints, name), dest)
    return step, dest
