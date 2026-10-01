"""Scenario-cell coverage (GOALS.md §2 tables A-G) of built gold sessions, plus the observed
runtime-behaviour rates (§3) and the corpus shape (§4).

    python3 authored/coverage.py OUT/*.gold.jsonl [--worlds DIR] [--json F] [--md F]
    python3 authored/coverage.py OUT/W.gold.jsonl --assign 28 --world 3 [--md F]

Input is build.py's `*.gold.jsonl` (each session carries `replay`: per turn ambiguous, recovery,
rejected, act_kinds). The cell universe and the world rotation come from cells.py (a fresh
`nativetools export` plus the runtime rules), so "missing" and "impossible" never mix.

Corpus mode (default): every reachable cell must have >= 3 uses from >= 2 worlds, and every §3/§4
bound must hold. World mode (`--assign N --world I`): every cell on world I's sheet must have >= 2
uses in different sessions. Exit status 1 when the mode's requirement fails.

The per-call attribution of runtime replies is heuristic where build.py's replay summary is per
turn (ambiguous, empty recovery): the reply is pinned to the turn's first call that names a row.
Also flags authored user messages that overlap val/test text (contamination). Corpus mode counts the train
worlds only: authored/split.py drops the val worlds from the input first.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import collections
import json
import re
import sys
from pathlib import Path

import cells as C
import split

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
POINTS, SPANS = C.POINTS, C.SPANS

ANA = re.compile(r"\b(it|its|that|this|them|they|those|these|her|his|him|he|she|both|the one|same|the other|there|either)\b")
ORDINAL = re.compile(r"\b(first|second|third|last|latter|former|other one|next one)\b")
QUESTION = re.compile(r"^(what|whats|what's|when|whens|when's|who|whos|who's|how|hows|how's|where|wheres|which|why|"
                      r"is|are|am|do|does|did|was|were|have|has|any|anything|anyone)\b")
INDIRECT = re.compile(r"\b(can you|could you|can u|could u|would you|will you|pls|plz|please|i need|i want|"
                      r"i'd like|id like|need you|help me|remind me|mind)\b")
HANDLE = re.compile(r"[$@#+][A-Za-z0-9_]+")
SECTION_KIND = {"people": "person", "groups": "group", "lists": "list", "events": "event", "tasks": "task",
                "notebooks": "notebook", "notes": "note", "folders": "folder", "documents": "document",
                "albums": "album", "photos": "photo", "debts": "debt", "locker": "locker item"}
LOCKER_TYPES_KEY = "locker item.type"

# §3 and §4 bounds: (lo, hi) as fractions, None = open
BOUNDS3 = {"turns: runtime said ambiguous": (0.03, 0.07), "turns: empty-result recovery": (0.03, None),
           "turns: touch a trashed row": (0.05, None), "sessions: contain a repair": (0.08, 0.16)}
BOUNDS4 = {"turns: end in ask": (0.05, 0.10), "messages: name a row verbatim": (0.30, None),
           "messages: refer by description/pronoun/ordinal": (0.30, None)}


# --- helpers kept from the per-production tally -----------------------------------------------


def date_shapes(args: dict) -> list[str]:
    out = []
    blobs = []
    w = args.get("when")
    if isinstance(w, dict):  # gold.py's D()/U()/span() builders
        w = json.dumps(w)
    if isinstance(w, str):
        blobs.append(w)
    for line in str(args.get("args") or "").splitlines():
        k, _, v = line.partition(": ")
        if v.startswith("{"):
            blobs.append(v)
    for b in blobs:
        try:
            e = json.loads(b)
        except json.JSONDecodeError:
            out.append("unparsed")
            continue

        def sig(x):
            return "+".join(sorted(k for k in x if x.get(k) is not None)) if isinstance(x, dict) else "?"
        out.append("from..to[" + sig(e.get("from")) + " | " + sig(e.get("to")) + "]" if ("from" in e or "to" in e) else sig(e))
    return out


COND = re.compile(r"^([a-z_]+(?: count)?)\s+(!=|<=|>=|=|<|>|contains|in|is empty|is set)\s*(.*)$")


def where_conds(where: str) -> list[tuple[str, str, str]]:
    """[(field, op, value text)] per condition."""
    out = []
    for cond in re.split(r" and (?![^(]*\))", where):
        m = COND.match(cond.strip())
        out.append((m.group(1), m.group(2), m.group(3).strip()) if m else (cond.strip()[:20], "?", ""))
    return out


def where_sigs(kinds: str | None, where: str) -> list[str]:
    out = []
    for f, op, _ in where_conds(where):
        opc = {"=": "eq", "!=": "eq", "<": "cmp", ">": "cmp", "<=": "cmp", ">=": "cmp"}.get(op, op)
        out.append(f"{kinds or '?'}.{f} {opc}")
    return out


def value_form(kind: str, field: str, op: str, val: str, x: dict) -> str:
    if op in ("is empty", "is set"):
        return "—"
    if field.endswith(" count"):
        return "linkcount"
    if f"{kind}.{field}" in x["enums"]:
        return "enum"
    if re.match(r"^-?[0-9.]+\s+\S", val):
        return "unit"
    return "literal"


def handles(v) -> list[str]:
    return [h.strip() for h in str(v or "").split(",") if h.strip()]


# --- classification ---------------------------------------------------------------------------


class World:
    def __init__(self, d: Path, name: str):
        kp, wp = d / f"{name}.keys.json", d / f"{name}.json"
        self.keys = json.loads(kp.read_text()) if kp.exists() else {}
        self.raw = json.loads(wp.read_text()) if wp.exists() else {}
        self.names, self.trashed, self.rows_per_kind = {}, set(), collections.Counter()
        for sec, kind in SECTION_KIND.items():
            for r in self.raw.get(sec, []) or []:
                if isinstance(r, dict) and r.get("key"):
                    self.names[r["key"]] = str(r.get("name", ""))
                    self.rows_per_kind[kind] += 1
                    if r.get("trashed"):
                        self.trashed.add(r["key"])

    def kind_of(self, ref: str) -> str:
        m = re.match(r"\$([A-Za-z0-9_]+)$", ref or "")
        return (self.keys.get(m.group(1)) or {}).get("kind", "?") if m else "?"


def call_kinds(c: dict, w: World, replay_kinds: list | None) -> list[str]:
    a = c.get("args") or {}
    if a.get("kind"):
        return [k.strip() for k in a["kind"].split(",")]
    ks = [w.kind_of(r) for r in handles(a.get("rows") or a.get("row"))]
    if (not ks or "?" in ks) and replay_kinds:
        ks = list(replay_kinds)
    return sorted(set(ks)) or ["?"]


def selectors(c: dict, turn: dict) -> list[str]:
    a = c.get("args") or {}
    hs = handles(a.get("rows"))
    out = []
    if len(hs) > 1:
        out.append("multi")
    if hs:
        if any(re.match(r"^\$(new|c\d+)$", h) or h.startswith("+") for h in hs):
            out.append("new")
        elif any(h[0] in "@#" for h in hs):
            out.append("prev")
        else:
            out.append("named")
    elif a.get("name"):
        out.append("named")
    elif any(a.get(k) for k in ("where", "when", "linked_to", "within", "exclude", "trashed")):
        out.append("where")
    n_acts = sum(1 for c2 in turn["ref"] if c2["tool"] == "act" and not c2.get("bad"))
    if ("where" in out or "prev" in out) and "multi" not in out and n_acts == 1:
        # one write, several rows changed: a filter or an @n result that hit more than one row
        n = max((sum(1 for r in (g.get("diff") or {}).get("rows", []) if r.get("key") or r.get("new"))
                 for g in turn["gold"]), default=0)
        if n > 1:
            out.append("multi")
    return out or ["named"]


def mood(u: str) -> str:
    s = u.strip().lower()
    if INDIRECT.search(s):
        return "indirect"
    if s.endswith("?") or QUESTION.match(s):
        return "question"
    return "command"


def row_keys(c: dict) -> list[str]:
    a = c.get("args") or {}
    out = []
    for p in ("rows", "row", "linked_to", "options"):
        out += [h[1:] for h in handles(a.get(p)) if h.startswith("$")]
    for line in str(a.get("args") or "").splitlines():
        out += re.findall(r"\$([A-Za-z0-9_]+)", line)
    return out


def verbatim(u: str, calls: list[dict], w: World) -> bool | None:
    """True if the message names a row the calls use verbatim; None if the turn names no row."""
    low = u.lower()
    cands = []
    for c in calls:
        a = c.get("args") or {}
        cands += [w.names.get(k, "") for k in row_keys(c)]
        cands += [a[k] for k in ("name", "text") if isinstance(a.get(k), str)]
    cands = [x.lower() for x in cands if x and len(x) >= 2]
    if not cands:
        return None
    return any(x in low for x in cands)


def classify(sessions: list[dict], worlds_dir: Path):
    """-> (uses: cell -> list of (world, session id)), per-turn/session facts for §3/§4."""
    x = C.export()
    worlds: dict[str, World] = {}
    uses = collections.defaultdict(list)
    facts = collections.Counter()
    outcome = collections.Counter()
    lengths = collections.Counter()
    undo_worlds = collections.Counter()
    feat = collections.Counter()  # the older per-turn feature tallies, kept for continuity
    n_turns = n_later = n_replayed = 0

    for s in sessions:
        wn = s["world"]
        w = worlds.setdefault(wn, World(worlds_dir, wn))
        sid = s["id"]
        rp = s.get("replay") or []

        def use(cell, _s=sid, _w=wn):
            uses[cell].append((_w, _s))

        nt = len(s["turns"])
        lengths[min(nt, 7)] += 1
        use(("F", "session length", str(nt) if nt < 7 else "7+"))
        facts["sessions"] += 1
        facts["sessions: contain a repair"] += any(c.get("bad") for t in s["turns"] for c in t["ref"])
        last_act = None  # (verb, kinds) of the last accepted write this session
        written: set[str] = set()
        for ti, t in enumerate(s["turns"]):
            n_turns += 1
            u, refs = t["user"], t["ref"]
            low = u.lower()
            later = ti > 0
            n_later += later
            r = rp[ti] if ti < len(rp) else {}
            n_replayed += bool(r)
            gtypes = [g["type"] for g in t["gold"]]
            g0 = t["gold"][0]
            good = [c for c in refs if not c.get("bad")]
            gdiff = [d for g in t["gold"] for d in [(g.get("diff") or {})] if d]
            diff_keys = {row.get("key") for d in gdiff for row in d.get("rows", []) if row.get("key")}
            already = {k for g in t["gold"] for k in g.get("already", [])}
            gold_rows = {k for g in t["gold"] if g["type"] == "rows" for k in g.get("rows", [])}

            # F: structure
            n_calls = len(good)
            use(("F", "calls/turn", str(n_calls) if n_calls < 4 else "4+"))
            if later and any("@" in str(v) for c in refs for v in (c.get("args") or {}).values()):
                use(("F", "referent", "@prev"))
            if later and ANA.search(low):
                use(("F", "referent", "pronoun"))
            if later and ORDINAL.search(low):
                use(("F", "referent", "ordinal"))
            if any(str((c.get("args") or {}).get("more")).lower() == "true" for c in refs):
                use(("F", "more= continuation", "—"))
            if later and any(c.get("bad") for c in refs):
                use(("F", "repair mid-session", "—"))
            read_keys = gold_rows | {k for c in good if c["tool"] in ("answer", "open", "find") for k in row_keys(c)}
            if (gold_rows and gdiff and any(g["type"] in ("rows", "value") and g.get("diff") for g in t["gold"])) \
                    or (read_keys & written):
                use(("F", "write then read same row", "—"))

            # §3 facts
            facts["turns"] += 1
            facts["turns: runtime said ambiguous"] += bool(r.get("ambiguous"))
            facts["turns: empty-result recovery"] += bool(r.get("recovery"))
            touched = diff_keys | gold_rows | {k for c in refs for k in row_keys(c)}
            trashed_turn = bool(touched & w.trashed) or any(
                (c.get("args") or {}).get("trashed") in (True, "true") or (c.get("args") or {}).get("verb") == "restore"
                for c in refs)
            facts["turns: touch a trashed row"] += trashed_turn

            # §4 outcome of the turn
            if "ask" in gtypes:
                oc = "ask"
            elif "decline" in gtypes:
                oc = "decline"
            elif g0["type"] in ("rows", "value") and g0.get("diff"):
                oc = "write+read"
            elif g0["type"] == "diff":
                oc = "write"
            elif g0["type"] == "value":
                oc = "answer-value"
            elif any(c["tool"] in ("find", "search") for c in good[:-1]) and good and \
                    str((good[-1].get("args") or {}).get("rows", "")).startswith("@"):
                oc = "find-only"
            else:
                oc = "answer-rows"
            outcome[oc] += 1
            vb = verbatim(u, good, w)
            facts["messages: name a row verbatim"] += bool(vb)
            facts["messages: refer by description/pronoun/ordinal"] += (vb is False) or (
                not vb and bool(ANA.search(low) or ORDINAL.search(low)))
            md = mood(u)
            vtag = "verbatim" if vb else "non-verbatim"

            # older feature tallies
            feat["starts lowercase"] += u[:1].islower()
            feat["polite"] += bool(re.search(r"\b(please|kindly|could you|would you)\b", u, re.I))
            feat["ends . ? !"] += u.rstrip()[-1:] in ".?!"
            feat["multi-call turn"] += n_calls > 1
            feat["gold value"] += "value" in gtypes
            feat["gold decline"] += "decline" in gtypes
            feat["already-so write"] += bool(already)
            feat["repair turns (per turn)"] += any(c.get("bad") for c in refs)

            # attribute the turn's ambiguous / empty reply to its first row-naming call
            amb_i = emp_i = None
            if r.get("ambiguous"):
                amb_i = next((i for i, c in enumerate(refs) if (c.get("args") or {}).get("name") or
                              (c.get("args") or {}).get("rows")), 0)
            if r.get("recovery"):
                emp_i = next((i for i, c in enumerate(refs) if c["tool"] in ("find", "search", "answer", "act")), 0)

            families = set()
            turn_refused = False
            for ci, c in enumerate(refs):
                a = c.get("args") or {}
                tool = c["tool"]
                rk = r.get("act_kinds", [])
                kinds = call_kinds(c, w, rk[ci] if ci < len(rk) else None)
                if kinds == ["?"]:  # no kind param, no $key: the kinds of the rows the gold names
                    kinds = sorted({w.kind_of("$" + k) for k in gold_rows | diff_keys} - {"?"}) or ["?"]
                bad = c.get("bad", False)
                err = (r.get("errors") or [""] * len(refs))[ci] if ci < len(r.get("errors") or []) else ""
                refused = "was refused" in err
                nxt = refs[ci + 1] if ci + 1 < len(refs) else None

                # A: act
                if tool == "act" and not bad:
                    v = a.get("verb", "?")
                    if v == "undo":
                        use(("A", "undo", "any", "—"))
                        families.add(("verb×kind", "undo×any"))
                        if last_act:
                            use(("D", "undo", f"after {C.VERB_CLASS.get(last_act[0], 'field')}"))
                            families.add(("tool×outcome", f"undo:after {C.VERB_CLASS.get(last_act[0], 'field')}"))
                            if last_act[0] == "delete" and "photo" in last_act[1]:
                                use(("E", "photo undo", "photo"))
                    else:
                        for kd in kinds:
                            for sel in (["—"] if v == "create" else selectors(c, t)):
                                use(("A", v, kd, sel))
                            families.add(("verb×kind", f"{v}×{kd}"))
                        last_act = (v, kinds)
                    written |= diff_keys

                # B: where
                if a.get("where"):
                    for kd in kinds:
                        for f, op, val in where_conds(a["where"]):
                            if op == "?":
                                continue
                            if bad and op in ("<", "<=", ">", ">=", "=", "!=") and re.search(r"\bhours?\b", val):
                                use(("B", "*number*", "cmp", "refused:1 hour"))
                            elif bad and re.search(r"\bweeks?\b", val):
                                use(("B", "*number*", "cmp", "refused:2 weeks"))
                            elif not bad:
                                use(("B", f"{kd}.{f}", op, value_form(kd, f, op, val, x)))

                # C: dates (bad calls do not count)
                if not bad:
                    for shape in date_shapes(a):
                        for kd in kinds:
                            use(("C", kd, shape))

                # D: tool outcome
                if not bad:
                    if tool == "answer":
                        o = "value" if (a.get("op") or a.get("value")) else \
                            "empty" if any(g["type"] == "rows" and not g.get("rows") for g in t["gold"]) else "rows"
                        use(("D", "answer", o))
                    elif tool == "find":
                        o = "ambiguous" if ci == amb_i else "miss" if ci == emp_i else "hit"
                        use(("D", "find", o))
                    elif tool == "search":
                        use(("D", "search", "miss" if ci == emp_i else "hit"))
                    elif tool == "open":
                        use(("D", "open", "row"))
                    elif tool == "compute":
                        use(("D", "compute", a.get("op", "?")))
                    elif tool == "ask":
                        use(("D", "ask", "with options" if a.get("options") else "without options"))
                    elif tool == "decline":
                        use(("D", "decline", a.get("reason", "?")))
                    elif tool == "act" and a.get("verb") != "undo":
                        named = {h[1:] for h in handles(a.get("rows")) if h.startswith("$")}
                        o = "ambiguous" if ci == amb_i else "already" if (already and (not named or named & set(already))) \
                            else "changed"
                        use(("D", "act", o))
                elif tool == "act" and refused:
                    use(("D", "act", "refused"))  # the vault refused it (not a malformed call)
                    turn_refused = True

                # E: behaviour × kind
                for kd in kinds:
                    if ci == amb_i:
                        use(("E", "ambiguous", kd))
                    if ci == emp_i:
                        use(("E", "empty result", kd))
                    if trashed_turn and (a.get("trashed") in (True, "true") or a.get("verb") == "restore"
                                         or set(row_keys(c)) & w.trashed):
                        use(("E", "trashed row", kd))
                    if refused and a.get("verb") == "restore" and "restore window" in err:
                        use(("E", "restore window", kd))
                    if refused and a.get("verb") in ("delete", "remove_from"):
                        use(("E", "refused delete", "person" if a.get("verb") == "remove_from" else kd))
                    if refused and kd == "event" and a.get("verb") in ("reschedule", "create"):
                        use(("E", "event overlap", "event"))
                    prev_limit1 = ci > 0 and str((refs[ci - 1].get("args") or {}).get("limit")) == "1"
                    if a.get("linked_to") and not bad and (len(handles(a["linked_to"])) > 1 or
                                                           ("@" in str(a["linked_to"]) and not prev_limit1)):
                        use(("E", "linked_to all", kd))
                if tool == "act" and not bad and a.get("verb") not in ("add_to", "remove_from"):
                    d_links = [l for d in gdiff for l in d.get("links", [])
                               if a.get("verb") != "create" or "me" in (l.get("from"), l.get("to"))]  # a create's own links are asked for
                    d_fields = {f for d in gdiff for row in d.get("rows", []) for f in (row.get("fields") or {})}
                    n_acts = sum(1 for g in good if g["tool"] == "act")
                    extra_rows = len(diff_keys) > max(n_acts, len(handles(a.get("rows"))))
                    if d_links or ("completed" in d_fields and a.get("verb") == "reopen") \
                            or (extra_rows and "multi" not in selectors(c, t)):
                        for kd in kinds:
                            use(("E", "knock-on diff", kd))

            # G: phrasing per family, from this turn's A/D uses
            fam = set()
            for c in good:
                a = c.get("args") or {}
                if c["tool"] == "act" and a.get("verb") != "undo":
                    for kd in call_kinds(c, w, None):
                        if kd != "?":
                            fam.add(("verb×kind", f"{a.get('verb')}×{kd}"))
            fam |= {f for f in families if f[0] == "verb×kind"}
            for cell in turn_d_cells(t, refs, amb_i, emp_i, already, last_act):
                fam.add(("tool×outcome", f"{cell[1]}:{cell[2]}"))
            if turn_refused:
                fam.add(("tool×outcome", "act:refused"))
            for fa, key in fam:
                use(("G", fa, key, md, vtag))
        for wkey in [wn] if any((c.get("args") or {}).get("verb") == "undo" for t in s["turns"] for c in t["ref"]) else []:
            undo_worlds[wkey] += 1

    facts["turns: end in ask"] = outcome["ask"]
    rates = {}
    for k in BOUNDS3:
        rates[k] = facts[k] / max(facts["sessions" if k.startswith("sessions") else "turns"], 1)
    for k in BOUNDS4:
        rates[k] = facts[k] / max(facts["turns"], 1)
    feat_rates = {k: v / max(n_turns, 1) for k, v in feat.items()}
    return uses, rates, outcome, lengths, undo_worlds, worlds, feat_rates


def turn_d_cells(t, refs, amb_i, emp_i, already, last_act):
    """The tool×outcome families a turn exercised (for G), recomputed cheaply."""
    out = []
    for ci, c in enumerate(refs):
        if c.get("bad"):
            continue
        a = c.get("args") or {}
        tool = c["tool"]
        if tool == "answer":
            o = "value" if (a.get("op") or a.get("value")) else \
                "empty" if any(g["type"] == "rows" and not g.get("rows") for g in t["gold"]) else "rows"
        elif tool == "find":
            o = "ambiguous" if ci == amb_i else "miss" if ci == emp_i else "hit"
        elif tool == "search":
            o = "miss" if ci == emp_i else "hit"
        elif tool == "open":
            o = "row"
        elif tool == "compute":
            o = a.get("op", "?")
        elif tool == "ask":
            o = "with options" if a.get("options") else "without options"
        elif tool == "decline":
            o = a.get("reason", "?")
        elif tool == "act" and a.get("verb") == "undo":
            tool, o = "undo", f"after {C.VERB_CLASS.get(last_act[0], 'field')}" if last_act else "after ?"
        else:
            o = "ambiguous" if ci == amb_i else "already" if already else "changed"
        out.append(("D", tool, o))
    return out


# --- contamination (kept) ---------------------------------------------------------------------


def ngrams(s, n=4):
    w = re.findall(r"[a-z0-9']+", s.lower())
    return {tuple(w[i:i + n]) for i in range(len(w) - n + 1)} or {tuple(w)}


def overlap(authored: list[dict], evals: list[dict], thr=0.5):
    idx = collections.defaultdict(set)
    ev = []
    for s in evals:
        for t in s["turns"]:
            ev.append(t["user"])
    grams = [ngrams(x) for x in ev]
    for i, g in enumerate(grams):
        for x in g:
            idx[x].add(i)
    hits = []
    for s in authored:
        for t in s["turns"]:
            if len(t["user"].split()) < 6:  # GOALS §7: short generic messages collide by nature
                continue
            g = ngrams(t["user"])
            cand = collections.Counter(j for x in g for j in idx.get(x, ()))
            for j, c in cand.most_common(3):
                jac = c / len(g | grams[j])
                if jac >= thr or t["user"].strip().lower() == ev[j].strip().lower():
                    hits.append({"authored": t["user"], "eval": ev[j], "jaccard": round(jac, 2), "session": s["id"]})
    return hits


# --- report -----------------------------------------------------------------------------------


def bound_ok(v, lo, hi):
    return (lo is None or v >= lo) and (hi is None or v <= hi)


def fmt_bound(lo, hi):
    return f"{lo:.0%}–{hi:.0%}" if lo is not None and hi is not None else f">= {lo:.0%}" if lo is not None else f"<= {hi:.0%}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("gold", nargs="+")
    ap.add_argument("--worlds", default=str(HERE / "worlds"))
    ap.add_argument("--json")
    ap.add_argument("--md")
    ap.add_argument("--assign", type=int, help="number of worlds in the rotation (world mode)")
    ap.add_argument("--world", type=int, help="this world's index in the rotation (world mode)")
    ap.add_argument("--min-uses", type=int, default=3)
    ap.add_argument("--min-worlds", type=int, default=2)
    a = ap.parse_args()
    if (a.assign is None) != (a.world is None):
        ap.error("--assign and --world go together")
    ses = [json.loads(l) for f in a.gold for l in open(f) if l.strip()]
    if a.assign is None:
        ses = split.drop_val(ses)  # corpus mode is the training corpus; a world's own sheet (world mode) may be a val world
    uses, rates, outcome, lengths, undo_worlds, worlds, feat_rates = classify(ses, Path(a.worlds))
    U = C.universe()
    fail = []
    out = {"size": {"sessions": len(ses), "turns": sum(len(s["turns"]) for s in ses), "worlds": sorted(worlds)},
           "tables": {}, "rates": rates, "features": feat_rates}
    lines = [f"# Coverage: {len(ses)} sessions, {out['size']['turns']} turns, worlds {', '.join(sorted(worlds))}", ""]

    # tables
    lines.append("## Scenario cells (GOALS §2)\n")
    lines.append("| table | reachable | unreachable | covered | uncovered | < %d uses | < %d worlds |" % (a.min_uses, a.min_worlds))
    lines.append("|---|---|---|---|---|---|---|")
    detail = []
    for t, v in U.items():
        reach = [c for c in v["reachable"] if c not in C.CONFIRMED_UNREACHABLE]
        v = {"reachable": reach, "unreachable": v["unreachable"] + [(c, w) for c, w in C.CONFIRMED_UNREACHABLE.items() if c[0] == t]}
        if t == "G":
            # a G cell is a family key; its uses are the (mood, naming) uses recorded per turn
            moods, names = defaultdict(set), defaultdict(set)
            for c, us in list(uses.items()):
                if c[0] == "G" and len(c) == 5:
                    k = c[:3]
                    uses.setdefault(k, [])
                    uses[k] = uses[k] + us
                    moods[k].add(c[3])
                    names[k].add(c[4])
            ok = lambda c: len(moods[c]) >= 2 and (not C.g_needs_naming(c[2]) or len(names[c]) >= 2)
            cov = [c for c in reach if uses.get(c) and ok(c)]
            unc = [c for c in reach if not (uses.get(c) and ok(c))]
            g_detail = {C.cell_str(c): f"moods {sorted(moods[c]) or '-'}, naming {sorted(names[c]) or '-'}" for c in unc}
        else:
            cov = [c for c in reach if uses.get(c)]
            unc = [c for c in reach if not uses.get(c)]
        thin = [c for c in cov if len(uses[c]) < a.min_uses]
        few = [c for c in cov if len({w for w, _ in uses[c]}) < a.min_worlds]
        stray = sorted({c for c in uses if c[0] == t and c not in set(reach) and not (t == "G" and len(c) == 5)})
        out["tables"][t] = {"reachable": len(reach), "unreachable": [[list(c), why] for c, why in v["unreachable"]],
                            "covered": len(cov), "uncovered": [list(c) for c in unc],
                            "thin": {C.cell_str(c): len(uses[c]) for c in thin},
                            "few_worlds": [list(c) for c in few],
                            "outside_universe": {C.cell_str(c): len(uses[c]) for c in stray},
                            "uses": {C.cell_str(c): len(uses[c]) for c in cov}}
        lines.append(f"| {t} | {len(reach)} | {len(v['unreachable'])} | {len(cov)} | {len(unc)} | {len(thin)} | {len(few)} |")
        if a.assign is None and (unc or thin or few):
            fail.append(f"table {t}: {len(unc)} uncovered, {len(thin)} under {a.min_uses} uses, {len(few)} under {a.min_worlds} worlds")
        detail.append(f"\n### {t}: uncovered ({len(unc)})\n")
        detail += [f"- {C.cell_str(c)}" + (f": {g_detail[C.cell_str(c)]}" if t == "G" else "") for c in unc]
        detail.append(f"\n### {t}: thin, under {a.min_uses} uses corpus-wide ({len(thin)})\n")
        detail += [f"- {C.cell_str(c)}: {len(uses[c])}" for c in thin]
        detail.append(f"\n### {t}: covered by fewer than {a.min_worlds} worlds ({len(few)})\n")
        detail += [f"- {C.cell_str(c)}" for c in few]
        if stray:
            detail.append(f"\n### {t}: observed but outside the reachable universe ({len(stray)})\n")
            detail += [f"- {C.cell_str(c)}: {len(uses[c])}" for c in stray]

    # world mode
    if a.assign is not None:
        mine = [c for c in C.owned(a.world, a.assign) if c not in C.CONFIRMED_UNREACHABLE]
        short = []
        for c in mine:
            n = len({sid for _, sid in uses.get(c, [])})
            if n < 2:
                short.append((c, n))
        out["world_mode"] = {"assign": a.assign, "world": a.world, "owned": len(mine),
                             "short": [[list(c), n] for c, n in short]}
        lines.append(f"\n## World {a.world} of {a.assign}: {len(mine) - len(short)}/{len(mine)} owned cells at >= 2 sessions\n")
        lines += [f"- {C.cell_str(c)}: {n} session(s)" for c, n in short]
        if short:
            fail.append(f"world {a.world}: {len(short)} owned cells under 2 sessions")

    # §3
    lines.append("\n## Observed runtime behaviour (GOALS §3)\n")
    for k, (lo, hi) in BOUNDS3.items():
        ok = bound_ok(rates[k], lo, hi)
        lines.append(f"- {k}: {rates[k]:.1%} (spec {fmt_bound(lo, hi)}) {'pass' if ok else 'FAIL'}")
        if not ok and a.assign is None:
            fail.append(f"§3 {k}")
    no_undo = [w for w in sorted(worlds) if not undo_worlds[w]]
    lines.append(f"- worlds without an undo: {', '.join(no_undo) or 'none'} {'pass' if not no_undo else 'FAIL'}")
    if no_undo and a.assign is None:
        fail.append("§3 undo per world")

    # §4
    lines.append("\n## Corpus shape (GOALS §4)\n")
    nS, nT = len(ses), max(out["size"]["turns"], 1)
    lshare = {n: lengths[n] / max(nS, 1) for n in range(1, 8)}
    missing_len = [n for n in range(1, 8) if not lengths[n]]
    ok = max(lshare.values()) <= 0.40 and not missing_len
    lines.append("- session length: " + ", ".join(f"{n if n < 7 else '7+'}: {lshare[n]:.0%}" for n in range(1, 8))
                 + f" (spec: every length 1–7, none above 40%) {'pass' if ok else 'FAIL'}")
    if not ok and a.assign is None:
        fail.append("§4 session length")
    oshare = {k: v / nT for k, v in outcome.items()}
    need = ["answer-rows", "answer-value", "write", "write+read", "ask", "decline", "find-only"]
    ok = all(outcome[k] for k in need) and max(oshare.values()) <= 0.45
    lines.append("- turn outcomes: " + ", ".join(f"{k}: {oshare.get(k, 0):.0%}" for k in need)
                 + f" (spec: all present, none above 45%) {'pass' if ok else 'FAIL'}")
    if not ok and a.assign is None:
        fail.append("§4 turn outcomes")
    for k, (lo, hi) in BOUNDS4.items():
        ok = bound_ok(rates[k], lo, hi)
        lines.append(f"- {k}: {rates[k]:.1%} (spec {fmt_bound(lo, hi)}) {'pass' if ok else 'FAIL'}")
        if not ok and a.assign is None:
            fail.append(f"§4 {k}")
    types = C.export()["enums"].get(LOCKER_TYPES_KEY, [])
    for wn, w in sorted(worlds.items()):
        lk = [r for r in w.raw.get("locker", []) or [] if isinstance(r, dict)]
        miss_t = sorted(set(types) - {r.get("type") for r in lk})
        thin_k = sorted(k for k in C.export()["kinds"] if w.rows_per_kind[k] < 3)
        ok = 15 <= len(lk) <= 20 and not miss_t and not thin_k
        lines.append(f"- world {wn}: {len(lk)} locker items, missing types {miss_t or 'none'}, kinds under 3 rows "
                     f"{thin_k or 'none'} (spec: 15–20 items, every type, enough rows for 0/1/many) {'pass' if ok else 'FAIL'}")
        if not ok and a.assign is None:
            fail.append(f"§4 world {wn}")
    out["shape"] = {"lengths": lshare, "outcomes": oshare}

    lines.append("\n## Other per-turn features\n")
    lines += [f"- {k}: {v:.0%}" for k, v in sorted(feat_rates.items())]

    lines += detail

    ev_dir = NATIVE / "eval" / "sets"
    evs = [json.loads(l) for f in ("val.jsonl", "test.jsonl") if (ev_dir / f).exists() for l in open(ev_dir / f)]
    out["contamination"] = overlap(ses, evs)
    lines.append(f"\n## Overlap with val/test text ({len(out['contamination'])} messages at 4-gram Jaccard >= 0.5)\n")
    lines += [f"- {h['session']}: {h['authored']!r} ~ eval {h['eval']!r} ({h['jaccard']})" for h in out["contamination"]]
    if out["contamination"]:
        fail.append("contamination")

    out["fail"] = fail
    lines.insert(1, f"\n**{'FAIL' if fail else 'PASS'}**" + (": " + "; ".join(fail) if fail else "") + "\n")
    text = "\n".join(lines) + "\n"
    if a.md:
        Path(a.md).write_text(text)
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(text if not a.md else text[:4000])
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
