"""One arm's numbers that `run-model` does not print.

    python3 summary.py out/qwen2b-zero

Parse rate, abstentions and whether they were right, failure reasons, and the
latency split.  `run-model` owns the score; this owns everything around it.
"""

from __future__ import annotations

import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AFM = os.path.normpath(os.path.join(HERE, "..", "afm-spike"))
for path in (HERE, AFM):
    if path not in sys.path:
        sys.path.insert(0, path)

import frame   # noqa: E402
import check   # noqa: E402
import mkschema  # noqa: E402

ABSTAIN = ("nothing", "refuse")


def gold_heads():
    out = {}
    for row in frame.gold_turns():
        flat = frame.to_flat(frame.encode(check.parse(row["canonical"])))
        out[(row["corpus"], row["session"], row["turn"])] = flat["head"]
    return out


def pct(part, whole):
    return 100.0 * part / max(1, whole)


def main():
    prefix = sys.argv[1]
    gold = gold_heads()
    rows, reasons = [], []
    for corpus in ("suite", "blind", "holdout"):
        raw = "%s-%s.jsonl" % (prefix, corpus)
        if not os.path.exists(raw):
            continue
        rows += [json.loads(line) for line in open(raw, encoding="utf-8") if line.strip()]
        side = "%s-%s.rendered.jsonl.reasons.jsonl" % (prefix, corpus)
        if os.path.exists(side):
            reasons += [json.loads(line) for line in open(side, encoding="utf-8")
                        if line.strip()]
    total = len(rows)
    parsed = sum(1 for r in reasons if r.get("canonical"))
    print("turns                     %d" % total)
    print("parse rate                %d/%d  %.1f%%" % (parsed, total,
                                                       pct(parsed, total)))
    errors = [r for r in rows if r.get("error")]
    empty = [r for r in rows if not r.get("error") and not r.get("stageB")]
    print("transport/empty failures  %d error, %d empty" % (len(errors), len(empty)))

    by_reason = {}
    for r in reasons:
        why = (r.get("reason") or "").split(":")[0]
        if why:
            by_reason[why] = by_reason.get(why, 0) + 1
    for why, n in sorted(by_reason.items(), key=lambda kv: -kv[1]):
        print("   %-26s %d" % (why, n))

    said_abstain = right = wrong_abstain = missed = 0
    for r in rows:
        key = (r["corpus"], r["session"], r["turn"])
        want = gold.get(key)
        try:
            head = json.loads(r["stageB"])["head"] if r.get("stageB") else None
        except Exception:
            head = None
        if head in ABSTAIN:
            said_abstain += 1
            if want == head:
                right += 1
            else:
                wrong_abstain += 1
        elif want in ABSTAIN:
            missed += 1
    print("abstentions (nothing/refuse)  %d  of which correct %d, wrong %d"
          % (said_abstain, right, wrong_abstain))
    print("gold abstentions the model did NOT take  %d (gold has %d)"
          % (missed, sum(1 for v in gold.values() if v in ABSTAIN)))

    ms = sorted(r["ms"] for r in rows)
    pre = sorted(r["ms_a"] for r in rows)
    dec = sorted(r["ms_b"] for r in rows)

    def p(vals, q):
        return vals[min(len(vals) - 1, int(q * len(vals)))] if vals else 0

    print("latency per turn   p50 %.0f ms   p95 %.0f ms   max %.0f ms"
          % (p(ms, .5), p(ms, .95), ms[-1] if ms else 0))
    print("   prefill          p50 %.0f ms   p95 %.0f ms" % (p(pre, .5), p(pre, .95)))
    print("   decode           p50 %.0f ms   p95 %.0f ms" % (p(dec, .5), p(dec, .95)))
    pn = [r["prompt_n"] for r in rows]
    dn = [r["predicted_n"] for r in rows]
    print("   prompt tokens    p50 %d (uncached part)   predicted p50 %d"
          % (statistics.median(pn) if pn else 0, statistics.median(dn) if dn else 0))
    dt = sum(r["ms_b"] for r in rows) / 1000.0
    print("   decode tok/s     %.2f (%d tokens / %.0f s, 4 slots concurrent)"
          % (sum(dn) / max(dt, 1e-9), sum(dn), dt))
    wall = sum(r["ms"] for r in rows) / 1000.0
    print("   wall             %.0f s of request time over %d turns" % (wall, total))
    heads = {}
    for r in rows:
        try:
            heads[json.loads(r["stageB"])["head"]] = \
                heads.get(json.loads(r["stageB"])["head"], 0) + 1
        except Exception:
            heads["<unparseable>"] = heads.get("<unparseable>", 0) + 1
    print("heads chosen: %s" % ", ".join("%s=%d" % kv for kv in
                                         sorted(heads.items(), key=lambda kv: -kv[1])))
    want = {}
    for v in gold.values():
        want[v] = want.get(v, 0) + 1
    print("gold heads:   %s" % ", ".join("%s=%d" % kv for kv in
                                         sorted(want.items(), key=lambda kv: -kv[1])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
