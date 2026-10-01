"""Coverage of the eval sets: kinds x verbs (from the reference writes), reads per kind, outcome
types, slice tags, policy rules and §14 rulings.

    python3 coverage.py [--sets test val] [--out coverage.md]
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from lib import load_keys, read_jsonl

HERE = Path(__file__).resolve().parent
META = None


def metadata() -> dict:
    """kinds and their verbs, as the runtime exports them (`nativetools export`)."""
    import subprocess
    import tempfile

    from lib import NT

    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([NT, "export", tmp], check=True, capture_output=True)
        return json.loads((Path(tmp) / "metadata.json").read_text())


def act_kinds(call: dict, keys: dict) -> list[str]:
    args = call.get("args", {})
    if args.get("verb") == "undo":
        return ["(undo)"]
    if args.get("verb") == "create":
        return [args["kind"]] if args.get("kind") else ["?"]
    if args.get("kind"):
        return [k.strip() for k in args["kind"].split(",")]
    kinds = []
    for key in re.findall(r"\$([A-Za-z0-9_]+)", args.get("rows", "")):
        if key in keys:
            kinds.append(keys[key]["kind"])
    return sorted(set(kinds)) or ["(result)"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sets", nargs="+", default=["test", "val"])
    parser.add_argument("--out")
    args = parser.parse_args()
    meta = metadata()
    kind_verbs = {k["name"]: k["verbs"] for k in meta["kinds"]}
    lines = ["# Eval coverage", ""]
    for name in args.sets:
        sessions = read_jsonl(HERE / "sets" / f"{name}.jsonl")
        grid: dict[tuple, int] = Counter()
        reads: Counter = Counter()
        gold_types: Counter = Counter()
        tags: Counter = Counter()
        for s in sessions:
            keys = load_keys(s["world"])
            for turn in s["turns"]:
                gold_types[turn["gold"][0]["type"]] += 1
                for tag in turn.get("tags", []):
                    tags[tag] += 1
                for call in turn["ref"]:
                    if call["tool"] == "act":
                        for kind in act_kinds(call, keys):
                            grid[(kind, call["args"]["verb"])] += 1
                    elif call["tool"] in ("answer", "find") and call["args"].get("kind"):
                        for kind in call["args"]["kind"].split(","):
                            reads[kind.strip()] += 1
        turns = sum(len(s["turns"]) for s in sessions)
        lines += [f"## {name}: {len(sessions)} sessions, {turns} turns", "",
                  "### Writes: kind x verb (reference calls; `-` = verb not defined for the kind)", ""]
        verbs = [v["verb"] for v in meta["verbs"] if v["verb"] != "undo"]
        lines.append("| kind | " + " | ".join(verbs) + " | reads |")
        lines.append("|---|" + "---|" * (len(verbs) + 1))
        missing = []
        for kind, allowed in kind_verbs.items():
            cells = []
            for verb in verbs:
                if verb not in allowed:
                    cells.append("-")
                    continue
                count = grid.get((kind, verb), 0)
                cells.append(str(count))
                if count == 0:
                    missing.append(f"{kind}.{verb}")
            lines.append(f"| {kind} | " + " | ".join(cells) + f" | {reads.get(kind, 0)} |")
        lines += ["", f"undo: {grid.get(('(undo)', 'undo'), 0)} · writes on a result handle: "
                      f"{sum(v for (k, _), v in grid.items() if k == '(result)')}",
                  f"missing kind.verb pairs: {', '.join(missing) or 'none'}", "",
                  "### Gold outcome types (first acceptable reading)", "",
                  " · ".join(f"{k} {v}" for k, v in sorted(gold_types.items())), "",
                  "### Slices, policy rules, rulings, date shapes (turn tags)", ""]
        groups = defaultdict(list)
        for tag, count in sorted(tags.items()):
            head = tag.split(":")[0] if ":" in tag else "slice"
            groups[head].append(f"{tag} {count}")
        for head in ("slice", "policy", "ruling", "convention", "date", "value"):
            if groups.get(head):
                lines.append(f"- **{head}**: " + " · ".join(groups[head]))
        lines.append("")
    text = "\n".join(lines) + "\n"
    if args.out:
        Path(args.out).write_text(text)
    print(text)


if __name__ == "__main__":
    main()
