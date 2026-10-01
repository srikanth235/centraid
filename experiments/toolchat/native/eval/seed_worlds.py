"""Seed the eval worlds through `nativetools seed` into a vault directory outside the repo.

    python3 seed_worlds.py [--vaults DIR] [WORLD ...]

Default: the test worlds A B C D and the val worlds of authored/split.json. Writes
<DIR>/<W>/vault (checkpointed, so a copy per session is small) and <W>.keys.json next to the world
file (world key -> vault id and kind; seeding is deterministic). A test world is eval/worlds/<W>.json;
a val world is authored/worlds/<W>.json (lib.world_dir), seeded into the same DIR, so
`run.py --set sets/val.jsonl` finds it the way it finds A to D.
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
sys.path.insert(0, str(HERE.parent / "authored"))
NT = os.environ.get("NATIVETOOLS", str(REPO / "target" / "debug" / "nativetools"))
DEFAULT_VAULTS = os.environ.get("EVAL_VAULTS", "/tmp/nativetools-eval/vaults")


def checkpoint(vault: Path) -> None:
    """`seed` leaves every write in the WAL (hundreds of MB for the large world); fold it in."""
    con = sqlite3.connect(vault)
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    con.execute("VACUUM")
    con.close()


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
    (wdir / f"{name}.keys.json").write_text(json.dumps(keys, indent=0, sort_keys=True) + "\n")
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"{name}: {len(keys)} keys, vault {size / 1e6:.1f} MB at {vault}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vaults", default=DEFAULT_VAULTS)
    parser.add_argument("worlds", nargs="*")
    args = parser.parse_args()
    from split import val_worlds

    for name in args.worlds or ["A", "B", "C", "D", *val_worlds()]:
        seed(name, Path(args.vaults))


if __name__ == "__main__":
    main()
