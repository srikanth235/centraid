"""A public household for the tests that need a seeded world (R-1088-16).

The held-out worlds (A to G, T03, T12, T23) are not in a public checkout, so a test that needs a household takes a public
train world from `authored/worlds/`, copies it under the name the test uses, seeds the copy with the runtime and writes its keys
beside it, all in one temporary directory that is removed at exit. `lib.WORLDS` and `lib.VAULTS` point there afterwards, so
`lib.load_keys`, `score.Ids`, `lib.Runtime` and `seed_worlds.seed` find the household like any other. No tracked file is written:
a keys file is a by-product of seeding and none is kept in the tree.

    import pubworld
    pubworld.seed_public("T05", "A")        # world A for this process: the public world T05 under the name A
"""

from __future__ import annotations

import atexit
import contextlib
import io
import json
import shutil
import tempfile
from pathlib import Path

import lib
import seed_worlds

AUTHORED_WORLDS = Path(__file__).resolve().parents[1] / "authored" / "worlds"
_SCRATCH: Path | None = None


def scratch() -> Path:
    """The process's temporary directory for seeded households (worlds/, vaults/), created on first use."""
    global _SCRATCH
    if _SCRATCH is None:
        _SCRATCH = Path(tempfile.mkdtemp(prefix="pubworld-"))
        (_SCRATCH / "worlds").mkdir()
        (_SCRATCH / "vaults").mkdir()
        atexit.register(shutil.rmtree, _SCRATCH, True)
    return _SCRATCH


def worlds_dir() -> Path:
    return scratch() / "worlds"


def seed_public(source: str = "T05", as_name: str = "A") -> dict:
    """Seed the public world `source` as `as_name`; the world's `me` and its keys. Points lib.WORLDS and lib.VAULTS at the
    temporary directory (the world JSON and the keys sit in worlds/, the vault in vaults/<as_name>/vault)."""
    origin = AUTHORED_WORLDS / f"{source}.json"
    if not origin.is_file():
        raise FileNotFoundError(f"{origin}: a public train world is rebuilt by `python3 artefacts.py fetch --public-only`")
    shutil.copyfile(origin, worlds_dir() / f"{as_name}.json")
    lib.WORLDS, lib.VAULTS = worlds_dir(), scratch() / "vaults"
    with contextlib.redirect_stdout(io.StringIO()):
        seed_worlds.seed(as_name, lib.VAULTS)
    return {"me": json.loads(origin.read_text(encoding="utf-8"))["me"], "keys": lib.load_keys(as_name)}
