"""The zero-training prompt: grammar summary + exemplars, from TRAINING data.

The exemplars are drawn from `data/train.jsonl`, never from
`crates/evalsuite/grammar/map.json` -- map.json's `request`/`canonical` are
read only to FORM an inference input and to score, which is the boundary the
brief sets and `data/build.py` already respects.

Selection is deterministic: the rows are sorted, one row is taken per
`family` in frequency order, and a row is only eligible if its target parses
and is short enough to read as an exemplar.
"""

from __future__ import annotations

import collections
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN = os.path.join(HERE, "data", "train.jsonl")

RULES = """You translate a member's words into CANONICAL ENGLISH for a personal vault.
Output the canonical turn and nothing else: no explanation, no SQL, no quotes around the whole turn.

GRAMMAR
Turn := show Set | same? Set Set | Value | Cmd | Cmd (then Cmd)+ | nothing
      | refuse : Reason | clarify : Reason
Value := count of Set | (sum|min|max) Field of Set | Field of Set
       | balance of Set in Set
Cmd  := Verb { Name: ArgVal ... } [ on Set ]
ArgVal := "literal" | Date | null | true | false | me | Duration | ( Set ) | Value
Set  := Kind | Kind of Set | Set called "literal" | Set that ( Pred )
      | Set during Window | Set ordered by Field (asc|desc) | Set and Set
      | Set except Set | first N of Set | Ref
Pred := Pred (and|or) Pred | not Pred | ( Pred ) | Field Cmp Value
      | Field contains "lit" | Field in ("a","b") | Field during Window
      | Field around N | count of Kind Cmp N | Field is [not] (null|me)
      | member of Set
Cmp  := = | != | < | <= | > | >=
Window := today | tomorrow | yesterday | before now | this week | last week
        | next week | this weekend | last weekend | this month | last month
        | next N (days|weeks|months) | 2026-06-19 | 2026-06 | 2026-06-04..2026-06-06
        | from ( Value ) to ( Value )
Ref  := it | them | that one | the N'th one | the other one | the earlier one
      | the last thing I added

KINDS: events, tasks, notes, journal notes, documents, parties, members,
profiles, important dates, contact channels, activities, obligations, photos,
albums, notebooks, places, expenses, groups, circles, settlements, accounts,
transactions, projects, locker items, things.

RULES
- A nested Set operand is parenthesised; a Pred is always parenthesised.
- `and` and `except` bind looser than the postfix operators.
- Every turn is a REWRITE of the previous canonical when the member is
  following up: `it`/`them`/`that one` refer into the previous turn.
- If the member withdrew, the turn is `nothing`.
- If the request is outside the vault entirely, it is `refuse : <reason>`.
- If the request is ambiguous, it is `clarify : <reason>`.

The input is `<previous canonical or NONE> ||| <what the member said>`."""


def exemplars(count=20, seed=0):
    rows = []
    with open(TRAIN, encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            if 12 <= len(row["target"]) <= 72:
                rows.append(row)
    rows.sort(key=lambda r: (r.get("family", ""), r["input"]))
    by_family = collections.defaultdict(list)
    for row in rows:
        by_family[row.get("family", "")].append(row)
    families = sorted(by_family, key=lambda f: (-len(by_family[f]), f))
    picked = []
    for family in families:
        bucket = by_family[family]
        picked.append(bucket[seed % len(bucket)])
        if len(picked) == count:
            break
    return picked


def system_prompt(count=20):
    lines = [RULES, "", "EXAMPLES"]
    for row in exemplars(count):
        lines.append("%s\n-> %s" % (row["input"], row["target"]))
    return "\n".join(lines)


def user_prompt(prev, request):
    return "%s ||| %s" % (prev or "NONE", request)


if __name__ == "__main__":
    print(system_prompt())
