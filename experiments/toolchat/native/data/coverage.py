"""Coverage table over generated examples: every §8 rule, kind x verb/field, date shapes, patterns.

usage: python coverage.py OUT_DIR [--glob 'train-*.jsonl.gz'] > coverage.md
"""
from __future__ import annotations

import argparse
import collections
import glob
import gzip
import json
import re
from pathlib import Path

import dates as D
from meta import FIELDS, KIND, VERBS_BY_KIND

THIN = 10


def kinds_of_step(st: dict) -> list[str]:
    a = st["args"]
    if a.get("kind"):
        return [k.strip() for k in a["kind"].split(",")]
    eff = st.get("effect") or {}
    ks = [r["kind"] for r in (eff.get("diff") or {}).get("rows", [])] + [r["kind"] for r in eff.get("already", []) or []]
    if not ks and a.get("args", "").startswith("kind: "):
        ks = [a["args"].split("\n")[0][6:]]
    return sorted(set(ks))


def exprs_of(a: dict) -> list[dict]:
    out = []
    if isinstance(a.get("when"), dict):
        out.append(a["when"])
    for line in str(a.get("args", "")).split("\n"):
        if ": {" in line:
            try:
                out.append(json.loads(line.split(": ", 1)[1]))
            except json.JSONDecodeError:
                pass
    return out


RULES = [
    ("§8.1 intent: rows / value / write / ask / decline", lambda e, t: True),
    ("§8.2 one step when the selector says it all", lambda e, t: len(t["steps"]) == 1 and t["steps"][0]["tool"] in ("answer", "act")),
    ("§8.2 look first (find / open before the final call)", lambda e, t: any(s["tool"] in ("find", "open") for s in t["steps"])),
    ("§8.3 unfamiliar name -> search", lambda e, t: any('search first' in s["think"] or "need #n for" in s["think"] for s in t["steps"])),
    ("§8.3 familiar name -> selector or #n (vault block / directory / shown)",
     lambda e, t: any(re.search(r"\((vault block|directory|shown)\)", s["think"]) for s in t["steps"])),
    ("§8.4 constraint over pick: selector after a look", lambda e, t: any(s["think"].startswith("seen:") or "\nseen:" in s["think"] for s in t["steps"]) and "name" in t["steps"][-1]["args"]),
    ("§8.4 pick by #n with a check line", lambda e, t: any("check:" in s["think"] for s in t["steps"])),
    ("§8.5 dead end -> recover (runtime offer, other kind, near spelling)", lambda e, t: bool({"recover_kind", "pick_typo", "recover_no_link"} & set(t["outcome"]))),
    ("§8.5 dead end -> decline not_found after search", lambda e, t: "not_found" in t["outcome"]),
    ("§8.6 ambiguity -> ask naming candidates", lambda e, t: bool({"ask", "ask_after_ambiguous"} & set(t["outcome"]))),
    ("§8.6 ambiguous observation from the runtime -> ask/pick", lambda e, t: "ask_after_ambiguous" in t["outcome"] or any(s["text"].startswith("ambiguous:") for s in t["steps"])),
    ("§8.6 ambiguity settled by the conversation -> pick #n", lambda e, t: t["pattern"] == "ambiguity_settled"),
    ("§8.7 kind the question asks for (who -> people, members)", lambda e, t: t["family"] in ("rows.linked.members", "rows.when.person")),
    ("§8.8 follow-up: narrowing (within=@n)", lambda e, t: t["pattern"] == "narrow"),
    ("§8.8 follow-up: substitution", lambda e, t: t["pattern"] == "substitution"),
    ("§8.9 corrections add (no undo)", lambda e, t: t["pattern"] == "correction_adds"),
    ("§8.9 undo on \"undo that\"", lambda e, t: t["pattern"] == "undo"),
    ("§8.10 write on a trashed-only target -> decline not_found", lambda e, t: "trashed_only" in t["outcome"] or "dead_end.trashed_only" in t["tags"]),
    ("§8.10 restore asked -> act restore trashed=true", lambda e, t: any(s["args"].get("verb") == "restore" for s in t["steps"])),
    ("§8.11 read phrased like a write stays a read", lambda e, t: "read_like_write" in t["tags"]),
    ("§8.12 already-so write -> act, then answer the state", lambda e, t: "already" in t["outcome"]),
    ("§8.13 convention: bare \"wifi password\" is a read", lambda e, t: "convention.wifi" in t["tags"]),
    ("§8.13 convention: \"diary\" = calendar", lambda e, t: "convention.diary" in t["tags"]),
    ("§8.13 convention: members = people linked to a group", lambda e, t: t["family"] == "rows.linked.members"),
    ("§8.13 convention: date readings (a §14 rule quoted in the trace)", lambda e, t: any(re.search(r'date.*\((bare weekday|"at N"|"next <|"last <|"this weekend"|"the last N)', s["think"]) for s in t["steps"])),
    ("§8.13 convention: balance sign (positive = they owe me)", lambda e, t: any(s["args"].get("op") == "balance" for s in t["steps"])),
    ("§8.13 convention: amounts in the default currency", lambda e, t: any(re.search(r"amount [<>=!]+ \d", s["args"].get("where", "")) or "amount: " in s["args"].get("args", "") for s in t["steps"])),
    ("§4.2 multi-write (more=true)", lambda e, t: sum(1 for s in t["steps"] if s["tool"] == "act") >= 2 or any(s["args"].get("rows", "").count("#") >= 2 and s["tool"] == "act" for s in t["steps"])),
    ("§4.2 act then answer", lambda e, t: "act_then_answer" in t["tags"]),
    ("§4.2 bulk write on a found result (rows=@n)", lambda e, t: any(s["tool"] == "act" and "@" in s["args"].get("rows", "") for s in t["steps"])),
    ("§4.3 compute group -> answer value", lambda e, t: any(s["tool"] == "compute" for s in t["steps"])),
    ("§6.1 pre-grounding block present but not needed", lambda e, t: "preground_ignored" in t["tags"]),
    ("§6.0.4 directory hit (#n from the directory)", lambda e, t: "directory_hit" in t["tags"]),
    ("§4 decline: out_of_scope / destruction / egress / fabricated / never_mind",
     lambda e, t: t["steps"][-1]["tool"] == "decline" and t["steps"][-1]["args"]["reason"] != "not_found"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--glob", default="train-*.jsonl.gz")
    a = ap.parse_args()
    files = sorted(glob.glob(str(Path(a.out) / a.glob)))
    rule_n = collections.Counter()
    kv = collections.Counter()
    kf = collections.Counter()
    shapes = collections.Counter()
    dfam = collections.Counter()
    pat = collections.Counter()
    outc = collections.Counter()
    final = collections.Counter()
    ctx = collections.Counter()
    decl = collections.Counter()
    fams = collections.Counter()
    n = 0
    n_sessions = 0
    turns_per = collections.Counter()

    def count_turn(e, t):
            nonlocal n
            n += 1
            for name, fn in RULES:
                try:
                    if fn(e, t):
                        rule_n[name] += 1
                except Exception:
                    pass
            pat[t["pattern"]] += 1
            fams[t["family"]] += 1
            for o in t["outcome"]:
                outc[o] += 1
            final[t["steps"][-1]["tool"] + ("" if t["steps"][-1]["tool"] != "answer" else
                                            (" op" if "op" in t["steps"][-1]["args"] or "value" in t["steps"][-1]["args"] else " rows"))] += 1
            ctx[t["turn"]] += 1
            if t["steps"][-1]["tool"] == "decline":
                decl[t["steps"][-1]["args"]["reason"]] += 1
            for tag in t["tags"]:
                if tag.startswith("date."):
                    dfam[tag[5:]] += 1
            for s in t["steps"]:
                ar = s["args"]
                for x in exprs_of(ar):
                    shapes[D.shape(x)] += 1
                if s["tool"] == "act":
                    for k in kinds_of_step(s):
                        kv[(k, ar["verb"])] += 1
                    if ar["verb"] == "edit":
                        for line in ar.get("args", "").split("\n"):
                            if ":" in line:
                                for k in kinds_of_step(s):
                                    kf[(k, "edit:" + line.split(":")[0])] += 1
                if s["tool"] in ("answer", "find", "compute") and ar.get("kind"):
                    for k in ar["kind"].split(","):
                        for fld in re.findall(r"(\w+) (?:[<>=!]+|contains|in|is)", ar.get("where", "")):
                            kf[(k, "where:" + fld)] += 1
                        for p in ("name", "when", "linked_to", "order", "limit", "trashed", "op", "group"):
                            if p in ar:
                                kf[(k, p + (":" + ar["op"] if p == "op" else ""))] += 1
                if s["tool"] in ("answer",) and ar.get("within"):
                    kf[("(within)", "narrow")] += 1

    for f in files:
        for line in gzip.open(f, "rt"):
            e = json.loads(line)
            n_sessions += 1
            turns_per[len(e["turns"])] += 1
            for t in e["turns"]:
                count_turn(e, t)
    print(f"# Coverage — {', '.join(Path(f).name for f in files)}\n\n{n_sessions} sessions, {n} trained turns "
          f"(turns per session: {dict(sorted(turns_per.items()))}). Counts below are per turn.\n")
    print("## Every §8 rule (and the §4/§6 patterns the policy relies on)\n\n| rule | turns | share |\n|---|---:|---:|")
    for name, _ in RULES:
        c = rule_n[name]
        print(f"| {name} | {c} | {100 * c / max(n, 1):.1f}% |" + (" **thin**" if c < THIN else ""))
    print("\n## Final call of the target turn\n\n| final call | examples |\n|---|---:|")
    for k, v in final.most_common():
        print(f"| {k} | {v} |")
    print("\n## Conversation patterns\n\n| pattern | examples |\n|---|---:|")
    for k, v in pat.most_common():
        print(f"| {k} | {v} |")
    print("\n| outcome label | turns |\n|---|---:|")
    for k, v in outc.most_common():
        print(f"| {k} | {v} |")
    print("\n| turn position in the session (0 = first) | turns |\n|---|---:|")
    for k, v in sorted(ctx.items()):
        print(f"| {k} | {v} |")
    print("\n| decline reason | examples |\n|---|---:|")
    for k, v in decl.most_common():
        print(f"| {k} | {v} |")
    print("\n## Kind x verb (act steps)\n")
    verbs = sorted({v for vs in VERBS_BY_KIND.values() for v in vs} | {"undo"})
    kinds = sorted(KIND)
    print("| kind | " + " | ".join(verbs) + " |\n|---|" + "---:|" * len(verbs))
    thin = []
    for k in kinds:
        row = []
        for v in verbs:
            c = kv[(k, v)]
            ok = v in VERBS_BY_KIND.get(k, ())
            row.append(str(c) if ok else ("·" if not c else f"{c}!"))
            if ok and c < THIN and v not in ("undo",):
                thin.append(f"{k}×{v} ({c})")
        print(f"| {k} | " + " | ".join(row) + " |")
    print("\n(· = verb not defined for the kind; cells under %d are listed as thin below)\n" % THIN)
    print("Thin kind×verb cells: " + (", ".join(thin) if thin else "none"))
    print("\n## Kind x field / selector feature (read and edit steps)\n\n| kind | feature | steps |\n|---|---|---:|")
    thin_f = []
    for (k, fe), c in sorted(kf.items()):
        print(f"| {k} | {fe} | {c} |")
    for k in kinds:
        for fld in [f for f in FIELDS.get(k, {}) if FIELDS[k][f].get("edit")]:
            if kf[(k, "edit:" + fld)] < THIN // 2:
                thin_f.append(f"{k} edit:{fld} ({kf[(k, 'edit:' + fld)]})")
        for fld in KIND[k]["where_fields"]:
            if kf[(k, "where:" + fld)] < THIN // 2:
                thin_f.append(f"{k} where:{fld} ({kf[(k, 'where:' + fld)]})")
    print("\nThin kind×field cells (< %d): " % (THIN // 2) + (", ".join(thin_f) if thin_f else "none"))
    print("\n## Date expression shapes (every expression in a call)\n\n| shape | expressions |\n|---|---:|")
    for k, v in shapes.most_common():
        print(f"| {k} | {v} |")
    print("\n| date phrase family | turns |\n|---|---:|")
    for k, v in dfam.most_common():
        print(f"| {k} | {v} |")
    print("\n## Phrasing families\n\n| family | examples |\n|---|---:|")
    for k, v in sorted(fams.items()):
        print(f"| {k} | {v} |")


if __name__ == "__main__":
    main()
