"""Freeze the probe sets: probe/src/*.jsonl -> probe/dev.jsonl, probe/hold.jsonl, probe/sets.json.

    python3 split.py           # write the sets
    python3 split.py --check   # fail if the committed sets differ from a fresh split

An item goes to hold when the first byte of sha256(id) is odd, else to dev: decided by the id
alone, after authoring, so nobody chooses which items Astra sees. Every item is checked against
the catalog first (the same checks the scorer's `valid` makes on a call), and the split refuses
an item whose gold is not a valid call. `sets.json` records each set's sha256 and counts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import catalog as catalog_mod  # noqa: E402
import score  # noqa: E402

SRC = HERE / "probe" / "src"
OUT = HERE / "probe"


def side(item_id: str) -> str:
    return "hold" if hashlib.sha256(item_id.encode()).digest()[0] % 2 else "dev"


def load_items() -> list[dict]:
    items = []
    for path in sorted(SRC.glob("*.jsonl")):
        for line in path.read_text().splitlines():
            if line.strip():
                items.append(json.loads(line))
    ids = [it["id"] for it in items]
    dupes = [i for i, n in Counter(ids).items() if n > 1]
    if dupes:
        raise SystemExit(f"duplicate ids: {dupes}")
    return sorted(items, key=lambda it: it["id"])


def check_gold(items: list[dict], catalog: dict) -> list[str]:
    problems = []
    for it in items:
        gold = it["gold"]
        call = {"tool": gold["tool"], "name": gold["name"] or None, "args": dict(gold["args"])}
        for key, value in gold.get("optional", {}).items():
            call["args"].setdefault(key, value[0] if isinstance(value, list) else value)
        flat = {k: (v[0] if isinstance(v, list) and gold["tool"] in ("act", "load") and _any_of(catalog, gold, k) else v)
                for k, v in call["args"].items()}
        call["args"] = flat
        if gold["tool"] == "ask":
            call["args"] = {"question": "which one?"}  # gold asks carry no text; any question passes
        ok, why = score.check_valid(call, catalog)
        if not ok:
            problems.append(f"{it['id']}: {why}")
    return problems


def _any_of(catalog: dict, gold: dict, key: str) -> bool:
    entry = catalog.get(gold["name"], {})
    return entry.get("params", {}).get(key, {}).get("type") != "list"


def render(items: list[dict]) -> str:
    return "".join(json.dumps(it, sort_keys=True) + "\n" for it in items)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()

    catalog = catalog_mod.load()
    items = load_items()
    problems = check_gold(items, catalog)
    if problems:
        print("gold that is not a valid call:", *problems, sep="\n  ")
        return 1

    sets = {"dev": [it for it in items if side(it["id"]) == "dev"],
            "hold": [it for it in items if side(it["id"]) == "hold"]}
    texts = {name: render(rows) for name, rows in sets.items()}
    meta = {"catalog_sha256": hashlib.sha256((HERE / "catalog" / "schemas.json").read_bytes()).hexdigest(),
            "rule": "hold iff sha256(id)[0] is odd",
            "sets": {name: {"sha256": hashlib.sha256(texts[name].encode()).hexdigest(),
                            "n": len(rows),
                            "by_app": dict(sorted(Counter(r["app"] for r in rows).items())),
                            "by_tool": dict(sorted(Counter(r["gold"]["tool"] for r in rows).items()))}
                     for name, rows in sets.items()}}
    meta_text = json.dumps(meta, indent=1, sort_keys=True) + "\n"

    if a.check:
        stale = [n for n in ("dev", "hold") if (OUT / f"{n}.jsonl").read_text() != texts[n]]
        if (OUT / "sets.json").read_text() != meta_text:
            stale.append("sets.json")
        if stale:
            print("stale:", ", ".join(stale), "(run python3 split.py)")
            return 1
        print("probe sets are fresh")
        return 0

    for name, text in texts.items():
        (OUT / f"{name}.jsonl").write_text(text)
    (OUT / "sets.json").write_text(meta_text)
    for name, info in meta["sets"].items():
        print(f"{name}: {info['n']} items {info['sha256'][:12]} {info['by_tool']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
