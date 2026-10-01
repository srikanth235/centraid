#!/usr/bin/env python3
"""Per-skill scoring of a tool-loop run over the dev-90 sessions.

    python3 v8/skillscore.py --turns <turns.jsonl> [--turns2 <other.jsonl>]
        [--steps <steps-or-traj.jsonl>] [--steps2 …] [--labels A B] [--markdown]
    python3 v8/skillscore.py --md v8/SKILLS.md     # render the inventory
    python3 v8/skillscore.py --check               # validate dev_skills.json

<turns.jsonl> is what `tool-loop score --turns` writes: one row per turn with
`session`, `turn`, `passed`, `complaint`, and optionally `tier`.

Attribution is COARSE: a turn needs 2-4 skills (v8/dev_skills.json) and its
pass/fail is charged to every one of them. A skill's accuracy is therefore a
ceiling on what that skill alone would score, and a low number means "turns
that need this skill fail", not "this skill is the cause".

Tiers (asked / wrong): taken from a row's `tier` when the jsonl has one
(pass|passed|correct → pass; ask|asked|clarify|safe → asked; anything else →
wrong). Without `tier`, a failed turn counts as asked when its complaint says
the run declined to "clarify", or — with --steps — when the turn's last call
was `done` (the runtime asks back). `safe` = pass + asked; asking is only an
acceptable outcome on judgement skills (marked J), so read `safe%` there.
"""
import argparse, json, os, re, sys
from collections import OrderedDict, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))


def load_jsonl(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def load_last_calls(path):
    """(session, turn) -> last call line, from an agent steps log
    ({session, turn, step, raw_text}) or a trajectory file ({session, turns})."""
    last = {}
    for r in load_jsonl(path):
        if "turns" in r and isinstance(r["turns"], list):
            for i, calls in enumerate(r["turns"]):
                if calls:
                    last[(r["session"], i)] = calls[-1]
        elif "raw_text" in r:
            k = (r["session"], r["turn"])
            if k not in last or r.get("step", 0) >= last[k][0]:
                last[k] = (r.get("step", 0), r["raw_text"])
    return {k: (v[1] if isinstance(v, tuple) else v) for k, v in last.items()}


def tier_of(row, last_call):
    t = row.get("tier")
    if t is not None:
        t = str(t).lower()
        if t in ("pass", "passed", "correct", "right", "ok"):
            return "pass"
        if any(w in t for w in ("ask", "clarif", "safe")):
            return "asked"
        return "wrong"
    if row.get("passed"):
        return "pass"
    if re.search(r'declined to "clarify"', row.get("complaint") or ""):
        return "asked"
    if last_call is not None and last_call.strip() == "done":
        return "asked"
    return "wrong"


class Run:
    def __init__(self, path, steps, dev):
        rows = {(r["session"], r["turn"]): r for r in load_jsonl(path)}
        last = load_last_calls(steps) if steps else {}
        self.path = path
        self.has_tier = any("tier" in r for r in rows.values()) or bool(steps)
        self.tier = {}
        self.missing = []
        for t in dev:
            k = (t["session"], t["turn"])
            if k not in rows:
                self.missing.append(k)
                continue
            self.tier[k] = tier_of(rows[k], last.get(k))
        sess = defaultdict(list)
        for (s, _), v in self.tier.items():
            sess[s].append(v)
        self.sessions = (sum(all(x == "pass" for x in v) for v in sess.values()), len(sess))
        self.safe_sessions = (sum(all(x != "wrong" for x in v) for v in sess.values()), len(sess))
        self.turns = (sum(v == "pass" for v in self.tier.values()), len(self.tier))

    def tally(self, keys):
        c = {"need": 0, "pass": 0, "asked": 0, "wrong": 0}
        for k in keys:
            if k in self.tier:
                c["need"] += 1
                c[self.tier[k]] += 1
        return c


def pct(a, b):
    return 100.0 * a / b if b else float("nan")


def fmt_pct(x):
    return "  n/a" if x != x else f"{x:5.1f}"


def table(rows, header, markdown):
    """rows: list of lists of str; first column left-aligned."""
    if markdown:
        out = ["| " + " | ".join(header) + " |",
               "|" + "|".join(["---"] + ["---:"] * (len(header) - 1)) + "|"]
        out += ["| " + " | ".join(r) + " |" for r in rows]
        return "\n".join(out)
    w = [max(len(str(x)) for x in col) for col in zip(header, *rows)]
    line = lambda r: "  ".join((str(x).ljust(w[i]) if i == 0 else str(x).rjust(w[i])) for i, x in enumerate(r))
    return "\n".join([line(header), line(["-" * n for n in w])] + [line(r) for r in rows])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--turns")
    ap.add_argument("--turns2")
    ap.add_argument("--steps", help="steps log or trajectory jsonl for --turns (derives `asked` from a final `done`)")
    ap.add_argument("--steps2", help="the same for --turns2")
    ap.add_argument("--labels", nargs="+", default=None)
    ap.add_argument("--skills", default=os.path.join(HERE, "skills.json"))
    ap.add_argument("--dev", default=os.path.join(HERE, "dev_skills.json"))
    ap.add_argument("--markdown", action="store_true", help="markdown tables")
    ap.add_argument("--md", metavar="OUT", help="render the skill inventory (SKILLS.md) and exit")
    ap.add_argument("--check", action="store_true", help="validate dev_skills.json against skills.json and exit")
    ap.add_argument("--leakcheck", action="store_true",
                    help="fail if any example phrasing in skills.json is a near-copy (token similarity >= 0.7) of an eval request")
    a = ap.parse_args()

    inv = json.load(open(a.skills))
    skills = OrderedDict((s["id"], s) for s in inv["skills"])
    dev = json.load(open(a.dev))["turns"]
    need = defaultdict(list)
    for t in dev:
        for s in t["skills"]:
            need[s].append((t["session"], t["turn"]))

    if a.check:
        bad = [(t["session"], t["turn"], s) for t in dev for s in t["skills"] if s not in skills]
        unused = [s for s in skills if s not in need]
        print(f"{len(skills)} skills, {len(dev)} dev turns, {sum(len(t['skills']) for t in dev)} tags")
        print("unknown skill tags:", bad or "none")
        print("skills no dev turn needs:", unused or "none")
        sys.exit(1 if bad else 0)

    if a.leakcheck:
        sys.exit(leakcheck(inv))

    if a.md:
        render_md(inv, skills, need, a.md)
        return

    if not a.turns:
        ap.error("--turns is required")
    r1 = Run(a.turns, a.steps, dev)
    r2 = Run(a.turns2, a.steps2, dev) if a.turns2 else None
    lab = a.labels or [os.path.basename(a.turns)] + ([os.path.basename(a.turns2)] if a.turns2 else [])
    md = a.markdown
    say = print

    say(("> " if md else "# ") + "Coarse attribution: every skill a turn needs (v8/dev_skills.json) is charged with that turn's pass/fail."
        + ("  \n> " if md else "\n# ") + "Sorted worst first. J = judgement skill (asking back is acceptable; read safe% = (pass+asked)/need).")
    for lb, r in [(lab[0], r1)] + ([(lab[1], r2)] if r2 else []):
        say(("\n" if md else "") + f"{'**' if md else ''}{lb}{'**' if md else ''}: sessions {r.sessions[0]}/{r.sessions[1]} ({fmt_pct(pct(*r.sessions)).strip()}%), "
            f"turns {r.turns[0]}/{r.turns[1]} ({fmt_pct(pct(*r.turns)).strip()}%)"
            + (f", sessions safe (no wrong turn) {r.safe_sessions[0]}/{r.safe_sessions[1]}" if r.has_tier else "")
            + (f"; MISSING {len(r.missing)} dev turns: {r.missing[:5]}" if r.missing else ""))
    say("")

    def jflag(s):
        return "J" if skills[s]["judgement"] else ""

    ids = [s for s in skills if need[s]]
    if not r2:
        rows = []
        for s in ids:
            c = r1.tally(need[s])
            rows.append((pct(c["pass"], c["need"]), -c["need"], s, c))
        rows.sort()
        hdr = ["skill", "group", "J", "need", "pass", "acc%"] + (["asked", "wrong", "safe%"] if r1.has_tier else [])
        out = []
        for acc, _, s, c in rows:
            line = [s, skills[s]["group"], jflag(s), str(c["need"]), str(c["pass"]), fmt_pct(acc)]
            if r1.has_tier:
                line += [str(c["asked"]), str(c["wrong"]), fmt_pct(pct(c["pass"] + c["asked"], c["need"]))]
            out.append(line)
        say(table(out, hdr, md))
    else:
        rows = []
        for s in ids:
            c1, c2 = r1.tally(need[s]), r2.tally(need[s])
            p1, p2 = pct(c1["pass"], c1["need"]), pct(c2["pass"], c2["need"])
            rows.append((p1, -c1["need"], s, c1, c2, p1, p2))
        rows.sort()
        hdr = ["skill", "group", "J", "need", f"{lab[0]} acc%", f"{lab[1]} acc%", "delta"]
        if r1.has_tier or r2.has_tier:
            hdr += [f"{lab[0]} asked/wrong", f"{lab[1]} asked/wrong"]
        out = []
        for _, _, s, c1, c2, p1, p2 in rows:
            line = [s, skills[s]["group"], jflag(s), str(c1["need"]), fmt_pct(p1), fmt_pct(p2), f"{p2 - p1:+6.1f}"]
            if len(hdr) > 7:
                line += [f"{c1['asked']}/{c1['wrong']}", f"{c2['asked']}/{c2['wrong']}"]
            out.append(line)
        say(table(out, hdr, md))

    # per-group totals: distinct turns needing any skill of the group
    say("")
    say(("**Per group**" if md else "# per group") + " (distinct turns needing any skill of the group; a turn counts once per group)")
    say("")
    groups = OrderedDict((g["id"], []) for g in inv["groups"])
    for s in skills:
        groups.setdefault(skills[s]["group"], []).append(s)
    gout = []
    for g, members in groups.items():
        keys = sorted({k for s in members for k in need[s]})
        if not keys:
            continue
        c1 = r1.tally(keys)
        line = [g, str(len(members)), str(c1["need"]), str(c1["pass"]), fmt_pct(pct(c1["pass"], c1["need"]))]
        if r2:
            c2 = r2.tally(keys)
            line += [str(c2["pass"]), fmt_pct(pct(c2["pass"], c2["need"])),
                     f"{pct(c2['pass'], c2['need']) - pct(c1['pass'], c1['need']):+6.1f}"]
        gout.append(line)
    ghdr = ["group", "skills", "turns", f"{lab[0]} pass", f"{lab[0]} acc%"]
    if r2:
        ghdr += [f"{lab[1]} pass", f"{lab[1]} acc%", "delta"]
    say(table(gout, ghdr, md))


def leakcheck(inv, threshold=0.7):
    """Example phrasings are training seeds; the eval corpora must not leak into them."""
    import difflib
    root = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
    norm = lambda s: re.sub(r"[^a-z0-9 ]+", " ", s.lower()).split()
    reqs = []

    def walk(x, corpus):
        if isinstance(x, dict):
            for k, v in x.items():
                if k == "request" and isinstance(v, str):
                    reqs.append((corpus, v, norm(v)))
                else:
                    walk(v, corpus)
        elif isinstance(x, list):
            for v in x:
                walk(v, corpus)

    for corpus in ("suite", "blind", "holdout", "registers"):
        walk(json.load(open(os.path.join(root, "crates", "evalsuite", corpus + ".json"))), corpus)
    bad = 0
    for s in inv["skills"]:
        for e in s["examples"]:
            for key in ("ctx", "say"):
                if not e.get(key) or e[key].startswith("("):
                    continue
                t = norm(e[key])
                q, corpus, r = max((difflib.SequenceMatcher(None, t, rt).ratio(), c, rr) for c, rr, rt in reqs)
                if q >= threshold:
                    bad += 1
                    print(f"{q:.2f} {s['id']} {e[key]!r} ~ {corpus}: {r!r}")
    print(f"{len(reqs)} eval requests; {bad} near-copies at >= {threshold}")
    return 1 if bad else 0


def render_md(inv, skills, need, out):
    L = []
    w = L.append
    w("# v8 skill inventory")
    w("")
    w("Generated from [`skills.json`](skills.json) by `python3 v8/skillscore.py --md v8/SKILLS.md` — edit the JSON, not this file.")
    w("")
    w(inv["purpose"])
    w("")
    w("- **J** marks a judgement skill: asking back (the runtime's clarify, reached with `done` or a call over an ambiguous set) is an acceptable outcome.")
    w("- **dev** is how many dev-90 turns need the skill ([`dev_skills.json`](dev_skills.json), measurement only). Calls follow [`../TOOLS.md`](../TOOLS.md).")
    w("- The example phrasings were written for this inventory in their own world (Omar, Lena, Kofi, Sofia, the Lisbon trip, House Bills); none is taken from `suite`, `blind`, `holdout` or `registers`, and each was checked against them for near-copies.")
    w("")
    by = OrderedDict((g["id"], (g["desc"], [])) for g in inv["groups"])
    for s in skills.values():
        by[s["group"]][1].append(s)
    w("| group | skills | what it covers |")
    w("|---|---:|---|")
    for g, (d, ss) in by.items():
        w(f"| [{g}](#{g}) | {len(ss)} | {d} |")
    w(f"| **total** | **{len(skills)}** | |")
    w("")
    for g, (d, ss) in by.items():
        w(f"## {g}")
        w("")
        w(d)
        w("")
        for s in ss:
            flag = " · **J**" if s["judgement"] else ""
            w(f"### `{s['id']}`{flag} · dev {len(need[s['id']])}")
            w("")
            w(s["desc"])
            w("")
            w("Calls: " + " · ".join(f"`{c}`" for c in s["calls"]))
            w("")
            for e in s["examples"]:
                ctx = f"*(after “{e['ctx']}”)* " if e.get("ctx") and not e["ctx"].startswith("(") else (f"*{e['ctx']}* " if e.get("ctx") else "")
                w(f"- {ctx}“{e['say']}” → " + " · ".join(f"`{c}`" for c in e["calls"]))
            w("")
    with open(out, "w") as f:
        f.write("\n".join(L))
    print(f"wrote {out}: {len(skills)} skills")


if __name__ == "__main__":
    main()
