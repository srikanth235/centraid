"""Show a world as text for authoring and reviewing gold (keys, names, fields, links).

    python3 view_world.py A [--kind tasks] [--grep word] [--today 2026-10-14T08:40]

An eval world carries its `today`; an authored world (T01..T28) does not, because the day is a
property of the session, not of the household. The day is then read from the sessions that name
the world (the frozen sets first, then the session sources); `--today` overrides it.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from collections import defaultdict

from lib import HERE, load_world

SOURCE_TODAY = r'world\(\s*"{name}"\s*,\s*"(\d{{4}}-\d\d-\d\dT\d\d:\d\d)"'


def lookup_today(name: str) -> str | None:
    """The day the sessions on world `name` run on: the frozen sets, then the session sources."""
    for path in sorted((HERE / "sets").glob("*.jsonl")):
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                if f'"world": "{name}"' not in line:
                    continue
                today = json.loads(line).get("today")
                if today:
                    return today
    pattern = re.compile(SOURCE_TODAY.format(name=re.escape(name)))
    sources = [*sorted((HERE.parent / "authored" / "sessions").glob("*.py")), *sorted((HERE / "sessions").rglob("*.py"))]
    for path in sources:
        found = pattern.search(path.read_text(encoding="utf-8"))
        if found:
            return found.group(1)
    return None


def show(world: dict, kind: str | None, grep: str | None, today: str | None = None) -> str:
    """The world as text. `today` is the fallback day for a world whose json carries none."""
    out = []
    today = world.get("today") or today
    if today:
        out.append(f"me: {world['me']}  today: {today} ({dt.date.fromisoformat(today[:10]).strftime('%A')})")
    else:
        out.append(f"me: {world['me']}  today: (none recorded for this world; pass --today)")
    links = defaultdict(list)
    for l in world.get("links", []):
        links[l["from"]].append(l["to"])
    for section in ("people", "lists", "events", "tasks", "notebooks", "notes", "folders",
                    "documents", "albums", "photos", "locker"):
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
    return "\n".join(out)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("world")
    parser.add_argument("--kind")
    parser.add_argument("--grep")
    parser.add_argument("--today", help="YYYY-MM-DDTHH:MM; default: the world's own, else the one its sessions use")
    args = parser.parse_args()
    world = load_world(args.world)
    # an explicit --today wins over everything; the world json's own comes next, then the lookup
    today = args.today or world.get("today") or lookup_today(args.world)
    print(show({**world, "today": today} if today else world, args.kind, args.grep))


if __name__ == "__main__":
    main()
