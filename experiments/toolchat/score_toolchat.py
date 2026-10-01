"""Score a two-tool run by OUTCOME -- the rows it returned, not how it asked.

    python3 score_toolchat.py out/sonnet-15.jsonl

The corpus already states outcomes per turn (`crates/evalsuite/suite.json`):
`ids` with the expected handles, `value` with the number, `no_action` with the
reason.  A handle (`people/priya-owes-me`) is DEFINED in the same file's
`handles` map as {entity, app, label}, and that triple is matched against
`target/eval-world/inventory.json` to get the row id.  The handle string is
not the label: `people/priya-owes-me` names the row labelled "Lunch, twice".

Two different queries that return the same rows both pass.  The frame scorer
could not do that -- it compared one canonical string to another and failed
`max started_at of (...)` against `first 1 of (... ordered by desc)`, which
are the same question.

WRITE turns are NOT scored here.  Executing a command needs the Rust handlers
in `crates/vault/src/commands/`, which this reads-only probe does not have, so
the model's intended write is recorded and reported and never counted as a
pass or a failure.  Sessions containing one cannot be scored strictly and are
reported separately rather than silently failed.
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
EVAL = os.path.join(REPO, "crates", "evalsuite")
INVENTORY = os.path.join(REPO, "target", "eval-world", "inventory.json")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
                  r"[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def slug(text):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-",
                                     (text or "").lower())).strip("-")


def handle_map(corpus):
    """handle -> {row ids}, from the corpus's OWN handle definitions.

    A handle is NOT `app/slug(label)`. `people/priya-owes-me` names a row
    whose label is "Lunch, twice", and slugifying resolved 19 of the 20
    handles in dev-15 by luck, then silently failed a correct answer on the
    twentieth -- the model returned exactly that obligation and was marked
    wrong. `suite.json` carries `handles` as {entity, app, label}, which is
    the authority; match it against the world inventory on all three.
    """
    with open(INVENTORY, encoding="utf-8") as fh:
        entities = json.load(fh)["entities"]
    by_key = {}
    for e in entities:
        by_key.setdefault((e.get("app"), e.get("entity"), e.get("label")),
                          set()).add(e["id"])
    out = {}
    for handle, spec in (corpus.get("handles") or {}).items():
        ids = by_key.get((spec.get("app"), spec.get("entity"),
                          spec.get("label")))
        if ids:
            out[handle] = set(ids)
    return out


def ids_in(rows):
    """Every id anywhere in the returned rows.

    Reading only the first column failed a correct answer: asked what was in
    an album, the model joined `core_collection_entry` to `media_asset` and
    put the entry id first and the photo id third. The photos were returned;
    the column order is not the outcome. Row COUNT is what keeps this from
    passing a query that drags the right row along inside a thousand others.
    """
    found = set()
    for row in (rows or []):
        for v in row.values():
            if isinstance(v, str) and UUID.match(v):
                found.add(v.lower())
    return found


def main():
    path = sys.argv[1]
    corpus_name = sys.argv[2] if len(sys.argv) > 2 else "suite"
    with open(os.path.join(EVAL, "%s.json" % corpus_name), encoding="utf-8") as fh:
        corpus = json.load(fh)
    expected = {}
    for s in corpus["sessions"]:
        for i, t in enumerate(s["turns"]):
            expected[(s["id"], str(i))] = t.get("expected") or {}

    handles = handle_map(corpus)
    got = {}
    for line in open(path, encoding="utf-8"):
        if line.strip():
            r = json.loads(line)
            got[(r["session"], r["turn"])] = r

    per_session, unresolved = {}, set()
    for key, row in sorted(got.items()):
        exp = expected.get(key, {})
        kind = exp.get("type", "?")
        verdict = (row.get("verdict") or "").upper()
        ok, note = None, ""
        if kind == "ids":
            want, gap = set(), False
            for h in exp.get("ids", []):
                if h in handles:
                    want |= handles[h]
                else:
                    unresolved.add(h)
                    gap = True
            got_rows = row.get("rows") or []
            found = ids_in(got_rows)
            if gap:
                # An expectation we cannot resolve is OUR gap. Scoring it as a
                # failure marks the model down for our bookkeeping.
                ok, note = None, "unresolvable expectation -- not scored"
            else:
                ok = bool(want) and want <= found and len(got_rows) == len(want)
                if not ok:
                    note = "wanted %d row(s), got %d, %d of the wanted ids" % (
                        len(want), len(got_rows), len(want & found))
        elif kind == "value":
            # The number may be in the ROWS or in the sentence: a model that
            # already has the rows from the previous turn answers "$520.87"
            # without running another query, which is correct behaviour and
            # which an extractor that only reads SQL results scores as a miss.
            want = float(exp.get("value"))
            nums = []
            for r in (row.get("rows") or []):
                for v in r.values():
                    try:
                        nums.append(float(v))
                    except (TypeError, ValueError):
                        pass
            for text in re.findall(r"-?[\d,]+\.?\d*", row.get("said") or ""):
                try:
                    nums.append(float(text.replace(",", "")))
                except ValueError:
                    pass
            # `usd_minor` is cents; a model answering in dollars is right.
            targets = [want] + ([want / 100.0] if "minor" in
                                (exp.get("unit") or "") else [])
            ok = any(abs(n - t) < 0.01 for n in nums for t in targets)
            note = "" if ok else "wanted %s, saw %s" % (targets, nums[:5])
        elif kind == "no_action":
            # The protocol this run published says ASK to clarify, NOTHING to
            # drop it, and ANSWER to refuse. Scoring a refusal as a miss for
            # not saying NOTHING marks the model down for obeying the prompt.
            # What `no_action` means is that the VAULT was not touched.
            want_ask = exp.get("reason") == "clarify"
            touched = bool(row.get("sql")) or bool(row.get("writes"))
            if want_ask:
                ok = verdict == "ASK"
                note = "" if ok else "wanted ASK, said %s" % (verdict or "-")
            else:
                ok = verdict in ("NOTHING", "ANSWER", "ASK") and not touched
                note = "" if ok else "wanted no action, said %s%s" % (
                    verdict or "-", " and queried" if touched else "")
        else:
            note = "write turn -- recorded, not scored: %s" % (
                (row.get("writes") or ["(none)"])[0][:80])
        per_session.setdefault(key[0], []).append((key[1], kind, ok, note, row))

    scorable, passed, turns_ok, turns_n = [], [], 0, 0
    print("%-6s %-5s %-11s %-6s %s" % ("sess", "turn", "expected", "ok", "note"))
    for sid in sorted(per_session):
        rows = per_session[sid]
        for tid, kind, ok, note, row in rows:
            mark = "-" if ok is None else ("PASS" if ok else "FAIL")
            if ok is not None:
                turns_n += 1
                turns_ok += bool(ok)
            print("%-6s %-5s %-11s %-6s %s" % (sid, tid, kind, mark, note))
        if all(ok is not None for _, _, ok, _, _ in rows):
            scorable.append(sid)
            if all(ok for _, _, ok, _, _ in rows):
                passed.append(sid)

    # Forcing an answer when the query budget runs out could make ASK a free
    # pass: a model that finds nothing in three queries and shrugs would clear
    # every clarify turn without earning it. Report it rather than trust it.
    forced = [(sid, tid, ok, row) for sid, rows in per_session.items()
              for tid, _k, ok, _n, row in rows if row.get("forced")]
    if forced:
        asked = [f for f in forced if (f[3].get("verdict") or "") == "ASK"]
        print()
        print("BUDGET SPENT on %d turn(s); of those %d said ASK, %d of which "
              "the corpus wanted" % (len(forced), len(asked),
                                     sum(1 for f in asked if f[2])))
        for sid, tid, ok, row in forced:
            print("   %s t%s  %-7s %s" % (sid, tid, row.get("verdict") or "-",
                                          "PASS" if ok else
                                          ("FAIL" if ok is False else "-")))

    print()
    print("SESSIONS fully read-scoreable : %d of %d" % (len(scorable),
                                                        len(per_session)))
    print("SESSIONS PASSED               : %d of %d   %.0f%%"
          % (len(passed), len(scorable),
             100.0 * len(passed) / max(1, len(scorable))))
    print("TURNS PASSED (scoreable only) : %d of %d   %.0f%%"
          % (turns_ok, turns_n, 100.0 * turns_ok / max(1, turns_n)))
    print("passed: %s" % ", ".join(passed))
    if unresolved:
        print("UNRESOLVED handles (scoring gap, not a model failure): %s"
              % ", ".join(sorted(unresolved)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
