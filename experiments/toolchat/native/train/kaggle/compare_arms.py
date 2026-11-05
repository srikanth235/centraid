"""Compare the arms' val reports (M6 of #1171): print the table and apply the chosen-arm rule.

    python3 compare_arms.py arm-A.val.json arm-B.val.json arm-C.val.json [arm-S2.val.json]

Each file is an `arm_report.py` output. The S2 baseline is optional (it is deferred); its fail rate by constraint count is always shown from
the issue (13 / 22 / 37 / 67 % at 1 / 2 / 3 / 4+), and from its own report when one is given. S2 is a reference row and never a candidate.

THE RULE (a proposal, written here so that the choice is reproducible; the owner can change it). Candidates are the arms A, B and C.
  1. The arm with the highest val session pass wins ...
  2. ... unless another arm is statistically tied with it: its session pass is not below the winner's lower 95% Wilson bound. Among the tied
     arms the one with the higher turn pass wins; if those tie as well (same bound test on turn pass), the one with the lower fail rate at
     4+ constraints; then the lowest arm letter (the simplest recipe).
  3. An arm that had engine errors is not a candidate (its numbers are not a clean run).
The reason is printed with the choice, and `--json` writes the table and the choice as JSON. Test is not read here, only val.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

S2_FAIL = {"1": 0.13, "2": 0.22, "3": 0.37, "4+": 0.67}  # the issue's census of S2 by constraint count
BUCKETS = ("1", "2", "3", "4+")


def load(paths) -> dict:
    arms = {}
    for p in paths:
        r = json.loads(Path(p).read_text())
        if r["arm"] in arms:
            raise SystemExit("two reports for arm %s" % r["arm"])
        arms[r["arm"]] = r
    return arms


def tied(a: dict, best: dict) -> bool:
    """`a` is not below the lower 95% bound of `best` (both Rate dicts)."""
    return a["rate"] >= best["ci95"][0]


def choose(arms: dict) -> dict:
    """{arm, reason} among A, B, C by the rule in the module docstring; arm None when there is no candidate."""
    cands = {k: v for k, v in arms.items() if k in ("A", "B", "C") and v.get("engine_errors", 0) == 0}
    dropped = sorted(k for k in arms if k in ("A", "B", "C") and k not in cands)
    if not cands:
        return {"arm": None, "reason": "no candidate arm (missing, or with engine errors: %s)" % (", ".join(dropped) or "none")}
    best = max(cands.values(), key=lambda r: (r["session_pass"]["rate"], r["arm"] == min(cands)))
    pool = {k: v for k, v in cands.items() if tied(v["session_pass"], best["session_pass"])}
    steps = ["highest val session pass: %s %.1f%%" % (best["arm"], 100 * best["session_pass"]["rate"])]
    if len(pool) > 1:
        steps.append("statistically tied on session pass with %s (95%% Wilson)" % ", ".join(sorted(set(pool) - {best["arm"]})))
        top = max(pool.values(), key=lambda r: r["turn_pass"]["rate"])
        pool2 = {k: v for k, v in pool.items() if tied(v["turn_pass"], top["turn_pass"])}
        if len(pool2) > 1:
            steps.append("tied on turn pass too (%s); lowest 4+ constraint fail rate" % ", ".join(sorted(pool2)))
            pick = min(pool2.values(), key=lambda r: (r["fail_by_constraints"]["4+"]["fail_rate"], r["arm"]))
        else:
            steps.append("higher turn pass: %s %.1f%%" % (top["arm"], 100 * top["turn_pass"]["rate"]))
            pick = top
    else:
        pick = best
    if dropped:
        steps.append("not candidates (engine errors): %s" % ", ".join(dropped))
    return {"arm": pick["arm"], "reason": "; ".join(steps)}


def pct(x: float) -> str:
    return "%5.1f%%" % (100 * x)


def cell(r: dict) -> str:
    return "%s (%d/%d)" % (pct(r["rate"]), r["k"], r["n"])


def table(arms: dict) -> str:
    order = [k for k in ("A", "B", "C", "S2") if k in arms] + sorted(k for k in arms if k not in ("A", "B", "C", "S2"))
    out = []
    head = ["arm", "tools", "sessions", "session pass", "turn pass", "clean turn pass"]
    out.append(" | ".join(head))
    for k in order:
        r = arms[k]
        out.append(" | ".join([k, r["tools"], str(r["sessions"]), cell(r["session_pass"]), cell(r["turn_pass"]), cell(r["clean_turn_pass"])]))
    out.append("")
    out.append("per-argument accuracy (right / scored)")
    out.append(" | ".join(["arm", "rows", "date", "filters", "amount"]))
    for k in order:
        a = arms[k]["arguments"]
        out.append(" | ".join([k] + ["%s (%d/%d)" % (pct(a[n]["rate"]), a[n]["right"], a[n]["scored"]) for n in ("rows", "date", "filters", "amount")]))
    out.append("")
    out.append("fail rate by constraint count (turns failed / turns)")
    out.append(" | ".join(["arm"] + list(BUCKETS)))
    out.append(" | ".join(["S2 (issue)"] + [pct(S2_FAIL[b]) for b in BUCKETS]))
    for k in order:
        f = arms[k]["fail_by_constraints"]
        out.append(" | ".join([k] + ["%s (%d/%d)" % (pct(f[b]["fail_rate"]), f[b]["failed"], f[b]["turns"]) for b in BUCKETS]))
    for name in ("money", "health"):
        out.append("")
        out.append("%s slice (S2 never trained on it)" % name.capitalize())
        out.append(" | ".join(["arm", "turns", "turn pass", "single-app session pass", "rows", "date", "filters", "amount"]))
        for k in order:
            s = arms[k]["slices"].get(name)
            if not s:
                out.append(" | ".join([k, "no turns in this slice"]))
                continue
            a = s["arguments"]
            out.append(" | ".join([k, str(s["turns"]), cell(s["turn_pass"]), cell(s["session_pass_single_app"])]
                                  + [pct(a[n]["rate"]) for n in ("rows", "date", "filters", "amount")]))
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("reports", nargs="+", type=Path)
    ap.add_argument("--json", type=Path, help="also write {arms, choice} here")
    a = ap.parse_args(argv)
    arms = load(a.reports)
    choice = choose(arms)
    print(table(arms))
    print()
    print("chosen arm: %s" % (choice["arm"] or "none"))
    print("reason: %s" % choice["reason"])
    if a.json:
        a.json.write_text(json.dumps({"arms": arms, "choice": choice}, indent=1) + "\n")
    return 0 if choice["arm"] else 1


if __name__ == "__main__":
    sys.exit(main())
