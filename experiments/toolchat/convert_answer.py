"""Rewrite recorded tool trajectories into ANSWER form.

    python3 convert_answer.py traj-r6.jsonl traj-r6a.jsonl

The old loop committed "the last rows or number shown" on `done`. In answer
form a read turn ends on `answer <set|value>` and `done` only stops. Per turn:

- a turn whose last call is a write, `nothing` or `refuse`: unchanged (it
  ends the turn itself); a write mid-turn that did not end it (a disclosure
  receipt) is looked past;
- otherwise the answering call is the LAST `show` / `search` / value call
  before `done` (a `get` only looks). Right before `done`, it becomes the
  answer (`show X` -> `answer X`, `search "w"` -> `answer (things called "w")`,
  which is what `search` runs). With `get`s in between, `done` becomes the same
  answer again: re-running it reads what the old `done` committed, since a
  `get` changes nothing it refers to;
- no answering call: `done` stays, and still means "stop";
- calls after `done` never ran and are dropped.

An answer that hits `ambiguous: …` leaves the turn open; the replay agent then
says `done`, exactly as the recorded turn did.
"""
import json
import re
import sys

WRITE = re.compile(r"^[a-z_.]+\s*\{")
VALUE = re.compile(r"^(count|sum|min|max|balance) |^[a-z_]+ of ")


def kind(call):
    c = call.strip()
    if c == "done":
        return "done"
    if c == "nothing" or c.startswith("refuse") or WRITE.match(c):
        return "ends"
    if c.startswith("show "):
        return "show"
    if c.startswith("search "):
        return "search"
    if c.startswith("get "):
        return "get"
    if VALUE.match(c):
        return "value"
    return "other"


def answer_of(call):
    c = call.strip()
    k = kind(c)
    if k == "show":
        return "answer " + c[len("show "):]
    if k == "search":
        return "answer (things called %s)" % c[len("search "):].strip()
    return "answer " + c


def convert_turn(calls):
    kinds = [kind(c) for c in calls]
    end = kinds.index("done") if "done" in kinds else len(calls)
    body = list(calls[:end])
    if body and kinds[end - 1] == "ends":
        return list(calls)
    # A write mid-turn may not have ended it (a disclosure receipt answers with
    # rows), so the answer is looked for only AFTER the last one.
    after = max((i + 1 for i, k in enumerate(kinds[:end]) if k == "ends"), default=0)
    at = max((i for i, k in enumerate(kinds[:end])
              if i >= after and k in ("show", "search", "value")), default=None)
    if at is None:
        return body + (["done"] if end < len(calls) else [])
    if at == len(body) - 1:
        return body[:-1] + [answer_of(body[-1])]
    return body + [answer_of(body[at])]


def main(src, dst):
    n = changed = 0
    with open(dst, "w", encoding="utf-8") as out:
        for line in open(src, encoding="utf-8"):
            if not line.strip():
                continue
            r = json.loads(line)
            turns = [convert_turn(t) for t in r["turns"]]
            n += len(turns)
            changed += sum(a != b for a, b in zip(turns, r["turns"]))
            out.write(json.dumps({"session": r["session"], "turns": turns}) + "\n")
    print("%d turns, %d rewritten" % (n, changed))


if __name__ == "__main__":
    main(*sys.argv[1:3])
