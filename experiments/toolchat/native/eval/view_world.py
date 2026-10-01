"""Show a world as text for authoring and reviewing gold (keys, names, fields, links, balances).

    python3 view_world.py A [--kind tasks] [--grep word]

Balances are computed here independently of the runtime (equal splits, open debts), so a gold
value is authored from the world and then checked against the runtime by the ref run.
"""

from __future__ import annotations

import argparse
import datetime as dt
from collections import defaultdict

from lib import load_world

MINOR = {"JPY": 0}


def balances(world: dict):
    """person balance (me vs them, positive = they owe me) per currency, and group positions."""
    currency = {g["key"]: g.get("currency", "USD") for g in world.get("groups", [])}
    person = defaultdict(lambda: defaultdict(float))
    group = defaultdict(lambda: defaultdict(float))
    for e in world.get("expenses", []):
        cur = e.get("currency") or currency[e["group"]]
        split = e["split"]
        digits = MINOR.get(cur, 2)
        share = e["amount"] / len(split)
        payer = e["paid_by"]
        group[e["group"]][payer] += e["amount"]
        for member in split:
            group[e["group"]][member] -= share
        if payer == "me":
            for member in split:
                if member != "me":
                    person[member][cur] += share
        elif "me" in split:
            person[payer][cur] -= share
    for db in world.get("debts", []):
        if db.get("settled"):
            continue
        sign = 1 if db["direction"] == "owes_me" else -1
        person[db["person"]]["USD"] += sign * db["amount"]
    return person, group


def show(world: dict, kind: str | None, grep: str | None) -> str:
    out = []
    today = world["today"]
    out.append(f"me: {world['me']}  today: {today} ({dt.date.fromisoformat(today[:10]).strftime('%A')})")
    links = defaultdict(list)
    for l in world.get("links", []):
        links[l["from"]].append(l["to"])
    for section in ("people", "groups", "lists", "events", "tasks", "notebooks", "notes", "folders",
                    "documents", "albums", "photos", "debts", "locker"):
        if kind and kind != section:
            continue
        rows = world.get(section, [])
        out.append(f"\n== {section} ({len(rows)})")
        for r in rows:
            extra = {k: v for k, v in r.items() if k not in ("key", "name")}
            if links.get(r.get("key")):
                extra["about"] = links[r["key"]]
            line = f"{r.get('key')}: {r['name']} {extra}"
            if grep and grep.lower() not in line.lower():
                continue
            out.append(line)
    if not kind or kind == "balances":
        person, group = balances(world)
        out.append("\n== balances (me vs person; + = they owe me)")
        for p, cur in sorted(person.items()):
            out.append(f"{p}: " + ", ".join(f"{v:.2f} {c}" for c, v in cur.items()))
        out.append("\n== group positions (+ = group owes them)")
        for g, pos in group.items():
            out.append(f"{g}: " + ", ".join(f"{p} {v:.2f}" for p, v in pos.items()))
    return "\n".join(out)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("world")
    parser.add_argument("--kind")
    parser.add_argument("--grep")
    args = parser.parse_args()
    print(show(load_world(args.world), args.kind, args.grep))


if __name__ == "__main__":
    main()
