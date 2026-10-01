"""Which gold turns depend on a SPEC §14 convention the model is never told in the prompt.

`build_sets.py` tags each such turn with `convention` and `convention:<which>`, so the report can
show a pass rate with those turns left out (a zero-shot model like Sonnet cannot know them). The
detection is a phrase match on the turn's own request, checked by hand; `OVERRIDES` records every
hand decision the match gets wrong.

    python3 conventions.py test     # list the tagged turns for review
"""

from __future__ import annotations

import re

WEEKDAY = r"(?:mon|tues|wednes|thurs|fri|satur|sun)day"
MONTH = (r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|"
         r"oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)")
# a weekday followed or preceded by an explicit date is not a convention ("friday dec 25", "sat the 12th")
EXPLICIT_NEAR = re.compile(rf"{WEEKDAY}\s*,?\s*(?:{MONTH}\b|the\s+\d|\d{{1,2}}/)|\b{MONTH}\s+\d+\S*\s*,?\s*(?:a\s+)?{WEEKDAY}", re.I)

RULES: list[tuple[str, re.Pattern]] = [
    ("next_weekday", re.compile(rf"\bnext\s+{WEEKDAY}\b", re.I)),
    ("weekend", re.compile(r"\b(?:this|next|coming|the)\s+weekend\b", re.I)),
    ("week", re.compile(r"\b(?:this|next|last)\s+week\b|\bweek before\b|\bthe week\b", re.I)),
    # §14 at-N: context decides first (dinner, drinks, party, movie, "tonight" -> evening; breakfast,
    # "morning" -> morning), otherwise 1..7 = pm and 8..12 as written
    ("at_n", re.compile(r"\b(?:at|to)\s+(?:[1-9]|1[0-2])\b(?!\s*(?::|\.\d|am|pm|a\.m|p\.m|th\b|st\b|nd\b|rd\b|"
                           r"h\b|hours?|mins?|minutes|people|%))", re.I)),
    ("last_month_name", re.compile(rf"\blast\s+{MONTH}\b", re.I)),
    ("bare_weekday", re.compile(rf"(?<!next )\b{WEEKDAY}\b", re.I)),
    ("diary", re.compile(r"\bdiary\b", re.I)),
    ("wifi", re.compile(r"\bwi-?fi\s+(?:password|pw|code)\b", re.I)),
]

# (session id, turn index from 1) -> list of conventions to use instead of the match ([] = none)
OVERRIDES: dict[tuple[str, int], list[str]] = {
    ("dev-A-064", 2): [],               # "journal on sunday night": a past reading, not the §14 next-occurrence rule
    ("dev-A-036", 3): [],               # gold asks (which amma task); the weekday doesn't decide the turn
    ("dev-D-040", 1): [],               # gold asks / declines; the weekday doesn't decide the turn
    ("dev-D-040", 2): ["bare_weekday"],  # "the ballet one" completes t1's "to saturday"
    ("dev-A-001", 2): [],               # "to 8" on a morning run: as written, nothing to choose
    ("dev-A-006", 2): [],               # "to 11" on a 10:00 meeting: as written, nothing to choose
    ("dev-A-103", 1): ["bare_weekday"],  # "at 12": as written; the weekday is the convention
    # dinners moved "to 8"/"to 9": the at-N context rule reads them as evening
    ("dev-A-064", 3): ["at_n"], ("dev-A-109", 3): ["at_n"], ("test-C-019", 3): ["at_n"], ("test-D-040", 2): ["at_n"],
}


def balance_sign(turn: dict) -> bool:
    """A balance value whose sign the gold fixes (not accepted with either sign)."""
    if not any(c["tool"] in ("answer", "compute") and c["args"].get("op") == "balance" for c in turn["ref"]):
        return False
    amounts = set()
    for accept in turn["gold"]:
        if accept["type"] != "value":
            continue
        for v in accept.get("values") or []:
            if isinstance(v.get("amount"), (int, float)):
                amounts.add(v["amount"])
        for vs in (accept.get("groups") or {}).values():
            for v in vs:
                if isinstance(v.get("amount"), (int, float)):
                    amounts.add(v["amount"])
    signed = {a for a in amounts if a != 0}
    return bool(signed) and not any(-a in signed for a in signed)


def detect(turn: dict) -> list[str]:
    text = turn["user"]
    found = []
    for name, pattern in RULES:
        if name == "bare_weekday":
            stripped = EXPLICIT_NEAR.sub(" ", text)
            if "next_weekday" in found:
                stripped = re.sub(rf"\bnext\s+{WEEKDAY}\b", " ", stripped, flags=re.I)
            if pattern.search(stripped):
                found.append(name)
        elif pattern.search(text):
            found.append(name)
    if balance_sign(turn):
        found.append("balance")
    return found


def tag(session: dict) -> None:
    for i, turn in enumerate(session["turns"], 1):
        which = OVERRIDES.get((session["id"], i), detect(turn))
        turn["tags"] = [t for t in turn["tags"] if t != "convention" and not t.startswith("convention:")]
        if which:
            turn["tags"] += ["convention"] + [f"convention:{w}" for w in which]


if __name__ == "__main__":
    import json
    import sys

    for line in open(f"sets/{sys.argv[1]}.jsonl", encoding="utf-8"):
        s = json.loads(line)
        for i, t in enumerate(s["turns"], 1):
            which = OVERRIDES.get((s["id"], i), detect(t))
            if which or any(x.startswith(("date:", "ruling:")) for x in t["tags"]):
                print(f"{s['id']} t{i} {which} {[x for x in t['tags'] if x.startswith(('date:', 'ruling:', 'value:bal'))]} :: {t['user']}")
