"""Seed the eval worlds through `nativetools seed` into a vault directory outside the repo.

    python3 seed_worlds.py [--vaults DIR] [WORLD ...]

Default: the union of the worlds in sets/val.jsonl and sets/test.jsonl: A B C D (eval/worlds) and T03 T12 T23
(authored/worlds). Name train worlds to seed them too (the worlds of sets/trainfit.jsonl). Writes <DIR>/<W>/vault
(checkpointed, so a copy per session is small) and <W>.keys.json next to the world file (world key -> vault id and
kind; seeding is deterministic). The keys file is written only when its content changed, in the formatting it is
committed in (indent 2, sorted keys), so a seeding leaves the tracked files alone. A world is eval/worlds/<W>.json or
authored/worlds/<W>.json (lib.world_dir), all seeded into the same DIR, so `run.py --set sets/val.jsonl` finds them.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
sys.path.insert(0, str(HERE))
NT = os.environ.get("NATIVETOOLS", str(REPO / "target" / "debug" / "nativetools"))
DEFAULT_VAULTS = os.environ.get("EVAL_VAULTS", "/tmp/nativetools-eval/vaults")


def checkpoint(vault: Path) -> None:
    """`seed` leaves every write in the WAL (hundreds of MB for the large world); fold it in."""
    con = sqlite3.connect(vault)
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    con.execute("VACUUM")
    con.close()


def write_keys(path: Path, keys: dict) -> bool:
    """Write the keys file when its content differs from what is there; True if it was written."""
    try:
        if json.loads(path.read_text()) == keys:
            return False
    except (OSError, ValueError):
        pass
    path.write_text(json.dumps(keys, indent=2, sort_keys=True) + "\n")
    return True


def set_worlds() -> list[str]:
    """The worlds of sets/val.jsonl and sets/test.jsonl, in name order."""
    from lib import read_jsonl

    return sorted({s["world"] for name in ("val", "test") for s in read_jsonl(HERE / "sets" / f"{name}.jsonl")})


def seed(name: str, vaults: Path) -> None:
    from lib import world_dir

    wdir = world_dir(name)
    world = wdir / f"{name}.json"
    out = vaults / name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    vault = out / "vault"
    proc = subprocess.run([NT, "seed", str(world), str(vault)], capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise SystemExit(f"seed {name} failed: {proc.stderr}")
    report = json.loads(proc.stdout)
    keys = report["keys"]
    for drop in report.get("dropped", []):  # world values the vault cannot hold: gold must not rely on them
        print(f"{name}: dropped {json.dumps(drop, ensure_ascii=False)}")
    checkpoint(vault)
    changed = write_keys(wdir / f"{name}.keys.json", keys)
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"{name}: {len(keys)} keys ({'CHANGED, re-run build_sets.py check' if changed else 'unchanged'}), "
          f"vault {size / 1e6:.1f} MB at {vault}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vaults", default=DEFAULT_VAULTS)
    parser.add_argument("worlds", nargs="*")
    args = parser.parse_args()
    for name in args.worlds or set_worlds():
        seed(name, Path(args.vaults))


if __name__ == "__main__":
    main()
