"""Partition the failed turns of a score.py report.json into error classes (one slice file each).

    python3 slices.py REPORT.json --gold GOLD.jsonl --out DIR

Writes DIR/slice-<class-slug>.jsonl (one line per failed turn) and DIR/slices.json (counts). Every
failed turn lands in exactly one slice (asserted). A line:
    id, turn (1-based), user (the turn's user text from the gold set), gold_type, got, problems,
    class, first_failure_in_session (this is the session's earliest failed turn),
    downstream (a failed turn after the session's first failure; the rule of score.py's clean turns:
    a turn is downstream when an earlier turn of its session already failed), and derived flags:
    has_anaphor        user text has those / that / it / the one / other one / what else
    date_field_mismatch  a problem names the date field or an ISO date value (write turns mostly)
    dropped_arg        heuristic: gold writes, got == act, a problem says a change/create is missing
                       or a wanted field is unchanged, and NO problem names an unwanted change. The
                       call did the right kind of write but left an argument out; a write on the
                       wrong row (missing + unwanted) is not flagged.
`classify` is the error taxonomy: every failed turn gets exactly one class.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

ANAPHOR_RE = re.compile(r"\b(those|that|it|the one|other one|what else)\b", re.I)
DATE_PROBLEM_RE = re.compile(r"'date': '20\d\d|\bdate\b.*20\d\d-\d\d|\.date = |\['date'\]|field date unchanged")
DROPPED_RE = re.compile(r"^(missing (change|create)|.*: field \w+ unchanged)")


def classify(x: dict) -> str:
    """Error class of one failed-turn entry {gold_type, got, problems}."""
    g, o, p = x["gold_type"], x["got"], " ; ".join(x["problems"])
    if o in ("loop", "cap"):
        return "no answer: loop/cap"
    if g != o and not (g == "diff" and o == "act"):
        if g == "diff" and o == "ask":
            return "wrong type: asked, gold writes"
        if g == "diff" and o in ("rows", "value"):
            return "wrong type: read, gold writes"
        if g == "ask" and o in ("act", "rows", "value"):
            return "wrong type: acted, gold asks"
        if o == "decline":
            return "wrong type: declined, gold acts/answers"
        if g == "decline":
            return "wrong type: acted/answered, gold declines"
        return "wrong type: other"
    if g == "rows":
        ex = re.search(r"extra \[(.*?)\] missing \[(.*?)\]", p)
        if ex:
            e, m = bool(ex.group(1).strip()), bool(ex.group(2).strip())
            return ("rows: over-inclusive (extra only)" if e and not m else
                    "rows: under-inclusive (missing only)" if m and not e else "rows: extra and missing")
        return "rows: other"
    if g == "value":
        return "value: wrong number/unit"
    if g == "ask":
        return "ask: options wrong"
    if g == "decline":
        return "decline: wrong reason/kind"
    if g == "diff":
        if "created" in p and "wrong fields" in p:
            return "write: create with wrong fields"
        if re.search(r"missing (create|link)", p):
            return "write: missing create/link"
        if "unwanted" in p and "missing" not in p:
            return "write: extra/unwanted change"
        if "unwanted" in p:
            return "write: missing + unwanted"
        if "missing change" in p:
            return "write: missing change"
        if re.search(r"unexpected field|\.\w+ = |want", p):
            return "write: right row, wrong field value"
        return "write: other"
    return "other"


def slug(cls: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", cls.lower()).strip("-")


def flags(x: dict, user: str) -> dict:
    probs = x["problems"]
    return {"has_anaphor": bool(ANAPHOR_RE.search(user or "")),
            "date_field_mismatch": any(DATE_PROBLEM_RE.search(p) for p in probs),
            "dropped_arg": (x["gold_type"] == "diff" and x["got"] == "act"
                            and any(DROPPED_RE.search(p) for p in probs)
                            and not any(p.startswith("unwanted") for p in probs))}


def slice_failed(failed: list[dict], gold: list[dict]) -> list[dict]:
    """Annotated records, in the order of `failed`."""
    users = {g["id"]: [t["user"] for t in g["turns"]] for g in gold}
    first: dict[str, int] = {}  # session -> its first failed turn; later turns are downstream (score.clean_turns)
    for x in failed:
        first[x["id"]] = min(first.get(x["id"], x["turn"]), x["turn"])
    out = []
    for x in failed:
        user = users.get(x["id"], [])[x["turn"] - 1] if x["id"] in users and x["turn"] <= len(users[x["id"]]) else ""
        out.append({"id": x["id"], "turn": x["turn"], "user": user, "gold_type": x["gold_type"], "got": x["got"],
                    "problems": x["problems"], "class": classify(x),
                    "first_failure_in_session": x["turn"] == first[x["id"]],
                    "downstream": x["turn"] > first[x["id"]], **flags(x, user)})
    return out


def write_slices(records: list[dict], out: str | Path) -> dict[str, int]:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("slice-*.jsonl"):
        old.unlink()
    by: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by[r["class"]].append(r)
    for cls, rows in by.items():
        with open(out / f"slice-{slug(cls)}.jsonl", "w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    counts = {c: len(r) for c, r in sorted(by.items(), key=lambda kv: -len(kv[1]))}
    assert sum(counts.values()) == len(records)
    (out / "slices.json").write_text(json.dumps(
        {"failed": len(records), "by_class": counts, "files": {c: f"slice-{slug(c)}.jsonl" for c in counts},
         "first_failure": sum(r["first_failure_in_session"] for r in records),
         "downstream": sum(r["downstream"] for r in records),
         "has_anaphor": sum(r["has_anaphor"] for r in records),
         "date_field_mismatch": sum(r["date_field_mismatch"] for r in records),
         "dropped_arg": sum(r["dropped_arg"] for r in records)}, indent=1))
    return counts


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("report")
    ap.add_argument("--gold", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    failed = json.load(open(args.report))["failed"]
    gold = [json.loads(l) for l in open(args.gold, encoding="utf-8") if l.strip()]
    records = slice_failed(failed, gold)
    counts = write_slices(records, args.out)
    for c, n in counts.items():
        print(f"{n:5d}  {c}")
    print(f"{sum(counts.values()):5d}  total (failed turns: {len(failed)}); flags: "
          + ", ".join(f"{k} {sum(r[k] for r in records)}" for k in
                      ("first_failure_in_session", "downstream", "has_anaphor", "date_field_mismatch", "dropped_arg")))


if __name__ == "__main__":
    main()
