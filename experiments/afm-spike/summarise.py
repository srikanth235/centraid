"""Summarise a harness run: parse rate, exact match, latency, failures.

    python3 summarise.py --raw out/afm.teacher.raw.jsonl \
                         --rendered out/afm.teacher.jsonl \
                         --out out/summary.teacher.md

EXACT MATCH AGAINST GOLD IS A LEAKAGE DETECTOR, NOT A SCORE.  The scoreboard
is `run-model`, which executes the canonical against the vault; a string that
matches gold byte for byte is interesting only because an on-device model that
reproduced the corpus's spelling would have seen the corpus.  It is reported
for that reason and for no other, and gold is read here and NOWHERE in the
prompt path.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import frame  # noqa: E402
import render as unparse  # noqa: E402
import check  # noqa: E402


def read(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def percentile(values, at):
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round((len(ordered) - 1) * at)))
    return ordered[index]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--rendered", required=True)
    ap.add_argument("--out")
    args = ap.parse_args()

    raw = read(args.raw)
    rendered = read(args.rendered)
    reasons = {}
    sidecar = args.rendered + ".reasons.jsonl"
    if os.path.exists(sidecar):
        for row in read(sidecar):
            reasons[(row["corpus"], row["session"], row["turn"])] = row

    gold = {(r["corpus"], r["session"], r["turn"]): r
            for r in frame.gold_turns()}

    lines = []
    out = lines.append
    header = raw[0] if raw else {}
    out("# Apple Foundation Models spike — %s run" % header.get("mode", "?"))
    out("")
    out("| | |")
    out("| --- | --- |")
    out("| model | %s |" % header.get("model", "?"))
    out("| OS | %s |" % header.get("os", "?"))
    out("| availability | %s |" % header.get("availability", "?"))
    out("| turns | %d |" % len(rendered))
    out("")

    # ---- parse rate and exact match, overall and per corpus
    by_corpus = {}
    exact_total = 0
    for row in rendered:
        key = (row["corpus"], row["session"], row["turn"])
        bucket = by_corpus.setdefault(row["corpus"], {"n": 0, "ok": 0, "exact": 0})
        bucket["n"] += 1
        if row["canonical"]:
            bucket["ok"] += 1
            reference = gold.get(key)
            if reference:
                try:
                    same = check.parse(row["canonical"]) == check.parse(
                        reference["canonical"])
                except Exception:
                    same = False
                if same:
                    bucket["exact"] += 1
                    exact_total += 1
    out("## Parse rate and exact match")
    out("")
    out("| corpus | turns | rendered | rate | tree-exact vs gold |")
    out("| --- | --- | --- | --- | --- |")
    for corpus in sorted(by_corpus):
        b = by_corpus[corpus]
        out("| %s | %d | %d | %.1f%% | %d (%.1f%%) |"
            % (corpus, b["n"], b["ok"], 100.0 * b["ok"] / max(1, b["n"]),
               b["exact"], 100.0 * b["exact"] / max(1, b["n"])))
    total = len(rendered)
    ok = sum(b["ok"] for b in by_corpus.values())
    out("| **all** | %d | %d | %.1f%% | %d (%.1f%%) |"
        % (total, ok, 100.0 * ok / max(1, total), exact_total,
           100.0 * exact_total / max(1, total)))
    out("")
    out("Exact match is a LEAKAGE DETECTOR. A high number here on a model "
        "that never saw this corpus would be the finding, not the score; the "
        "score is `run-model`.")
    out("")

    # ---- latency
    a = [r.get("ms_a", 0) for r in raw]
    b = [r.get("ms_b", 0) for r in raw if r.get("ms_b", 0) > 0]
    both = [r.get("ms_a", 0) + r.get("ms_b", 0) for r in raw]
    out("## Latency")
    out("")
    out("| stage | n | p50 ms | p95 ms | max ms |")
    out("| --- | --- | --- | --- | --- |")
    for name, values in (("A (intent)", a), ("B (frame)", b), ("turn", both)):
        out("| %s | %d | %d | %d | %d |"
            % (name, len(values), percentile(values, 0.5),
               percentile(values, 0.95), max(values) if values else 0))
    out("")

    # ---- failures
    counts, by_kind = {}, {}
    for row in rendered:
        key = (row["corpus"], row["session"], row["turn"])
        record = reasons.get(key, {})
        reason = record.get("reason", "")
        if not reason:
            continue
        head = reason.split(":")[0]
        counts[head] = counts.get(head, 0) + 1
        stage_a = record.get("stageA") or "{}"
        try:
            kind = json.loads(stage_a).get("kind", "?")
        except Exception:
            kind = "?"
        by_kind.setdefault(head, {}).setdefault(kind, 0)
        by_kind[head][kind] += 1
    out("## Failures (no canonical)")
    out("")
    if not counts:
        out("None.")
    else:
        out("| reason | turns | by kind |")
        out("| --- | --- | --- |")
        for reason, count in sorted(counts.items(), key=lambda kv: -kv[1]):
            spread = ", ".join("%s %d" % (k, v) for k, v in
                               sorted(by_kind[reason].items(),
                                      key=lambda kv: -kv[1])[:6])
            out("| `%s` | %d | %s |" % (reason, count, spread))
    out("")

    # ---- twenty wrong outputs, quoted
    out("## Twenty wrong outputs")
    out("")
    shown = 0
    for row in rendered:
        if shown >= 20:
            break
        key = (row["corpus"], row["session"], row["turn"])
        reference = gold.get(key)
        if reference is None:
            continue
        got = row["canonical"]
        if got:
            try:
                if check.parse(got) == check.parse(reference["canonical"]):
                    continue
            except Exception:
                pass
        record = reasons.get(key, {})
        out("**%s/%s turn %s** — %s" % (row["corpus"], row["session"],
                                        row["turn"],
                                        "`%s`" % record.get("reason")
                                        if record.get("reason") else "wrong"))
        out("")
        out("- request: `%s`" % row["request"].replace("`", "'"))
        out("- prev used: `%s`" % row.get("prev_used", "NONE"))
        out("- gold: `%s`" % reference["canonical"])
        out("- got: `%s`" % (got or "(empty)"))
        out("")
        shown += 1
    if shown == 0:
        out("None — every rendered turn is tree-equal to gold. Check the "
            "leakage number above before celebrating.")
        out("")

    text = "\n".join(lines) + "\n"
    if args.out:
        open(args.out, "w", encoding="utf-8").write(text)
        print("wrote %s" % args.out)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
