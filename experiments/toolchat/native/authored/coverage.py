"""Scenario-cell coverage (tables A-H of cells.py) of built gold sessions, plus the observed
runtime-behaviour rates and the corpus shape.

    python3 authored/coverage.py OUT/*.gold.jsonl [--worlds DIR] [--json F] [--md F]
    python3 authored/coverage.py OUT/W.gold.jsonl --assign 28 --world 3 [--md F]
    python3 authored/coverage.py OUT/*.gold.jsonl --h-only [--md F]       # table H alone (message-side decisions)

Input is build.py's `*.gold.jsonl` (each session carries `replay`: per turn ambiguous, recovery,
rejected, act_kinds). The cell universe and the world rotation come from cells.py (a fresh
`nativetools export` plus the runtime rules), so "missing" and "impossible" never mix.

Corpus mode (default): every reachable cell must have >= 3 uses from >= 2 worlds, and every
runtime-behaviour and corpus-shape bound must hold. World mode (`--assign N --world I`): every
cell on world I's sheet must have >= 2 uses in different sessions. Exit status 1 when the mode's
requirement fails.

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

# BOUNDS3: runtime behaviour observed in the replay; BOUNDS4: corpus shape. (lo, hi) as fractions, None = open
BOUNDS3 = {"turns: runtime said ambiguous": (0.03, 0.07), "turns: empty-result recovery": (0.03, None),
           "turns: touch a trashed row": (0.05, None), "sessions: contain a repair": (0.08, 0.16)}
BOUNDS4 = {"turns: end in ask": (0.05, 0.10), "messages: name a row verbatim": (0.30, None),
           "messages: refer by description/pronoun/ordinal": (0.30, None)}


# --- helpers: date shapes, where conditions, call kinds ---------------------------------------


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
    def __init__(self, d: Path | None, name: str, raw: dict | None = None, keys: dict | None = None):
        if raw is None or keys is None:
            kp, wp = d / f"{name}.keys.json", d / f"{name}.json"
            keys = json.loads(kp.read_text()) if kp.exists() else {}
            raw = json.loads(wp.read_text()) if wp.exists() else {}
        self.keys, self.raw = keys, raw
        self.names, self.trashed, self.rows_per_kind = {}, set(), collections.Counter()
        self.kinds, self.text = {}, {}  # row key -> kind / name + description + body (lower case)
        for sec, kind in SECTION_KIND.items():
            for r in self.raw.get(sec, []) or []:
                if isinstance(r, dict) and r.get("key"):
                    self.names[r["key"]] = str(r.get("name", ""))
                    self.kinds[r["key"]] = kind
                    self.text[r["key"]] = " ".join(str(r.get(f) or "") for f in ("name", "description", "body")).lower()
                    self.rows_per_kind[kind] += 1
                    if r.get("trashed"):
                        self.trashed.add(r["key"])
        self._h7 = self._nw = None

    def h_name_words(self) -> dict[str, set[str]]:
        if self._nw is None:
            self._nw = {k: set(h_words(n, C.H3_GENERIC)) for k, n in self.names.items()}
        return self._nw

    @classmethod
    def from_raw(cls, raw: dict, keys: dict | None = None) -> "World":
        """A world from its parsed json (tests, tooling); `keys` is the optional {key: {kind}} map."""
        return cls(None, "", raw=raw, keys=keys or {})

    def kind_of(self, ref: str) -> str:
        m = re.match(r"\$([A-Za-z0-9_]+)$", ref or "")
        if not m:
            return "?"
        return (self.keys.get(m.group(1)) or {}).get("kind") or self.kinds.get(m.group(1), "?")


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
    """-> (uses: cell -> list of (world, session id)), per-turn/session facts for BOUNDS3 and BOUNDS4."""
    x = C.export()
    worlds: dict[str, World] = {}
    uses = collections.defaultdict(list)
    facts = collections.Counter()
    outcome = collections.Counter()
    lengths = collections.Counter()
    undo_worlds = collections.Counter()
    feat = collections.Counter()  # per-turn feature tallies (the "Other per-turn features" report)
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

            # runtime-behaviour facts (BOUNDS3)
            facts["turns"] += 1
            facts["turns: runtime said ambiguous"] += bool(r.get("ambiguous"))
            facts["turns: empty-result recovery"] += bool(r.get("recovery"))
            touched = diff_keys | gold_rows | {k for c in refs for k in row_keys(c)}
            trashed_turn = bool(touched & w.trashed) or any(
                (c.get("args") or {}).get("trashed") in (True, "true") or (c.get("args") or {}).get("verb") == "restore"
                for c in refs)
            facts["turns: touch a trashed row"] += trashed_turn

            # outcome of the turn (corpus shape, BOUNDS4)
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

            # per-turn feature tallies
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


# --- table H: message-side decisions ------------------------------------------------------------
# Tables A-G read the reference CALL. H reads the MESSAGE next to the call: the idiom, the inert clause, the
# same-word lookalike, the stop signal, the role noun, the date phrase, the container word. The phrase lists
# are the H_* constants of cells.py; each detector below is a pure function of (message, reference calls, gold,
# world) so a test can hand it a three-line session.

H_RX = {}  # compiled-regex cache, keyed by pattern


def _rx(p: str, flags=re.I):
    r = H_RX.get((p, flags))
    if r is None:
        r = H_RX[(p, flags)] = re.compile(p, flags)
    return r


def h_message(t: dict) -> str:
    """The message the detectors read: the noise-free text when the turn has one (typos hide idioms)."""
    return str(((t.get("noise") or {}).get("clean") or t["user"])).strip().lower()


def h_words(text: str, drop=()) -> list[str]:
    """Content words of a text: four letters or more, not a stop word, not a date word."""
    return [w for w in re.findall(r"[a-z][a-z'\-]{3,}", text.lower())
            if w not in C.H_STOP and w not in C.H2_DATE_WORDS and w not in drop]


def h_sides(c: dict) -> list[str]:
    """The reference sides of one call, as H1 names them: verb (+ create:<kind>), tool, decline:<reason>."""
    a = c.get("args") or {}
    if c["tool"] == "act":
        v = a.get("verb", "?")
        return [v] + ([f"create:{a['kind']}"] if v == "create" and a.get("kind") else [])
    if c["tool"] == "decline":
        return [f"decline:{a.get('reason', '?')}"]
    return [c["tool"]] + (["read"] if c["tool"] in ("answer", "find", "search", "open") else [])


def h_kinds(c: dict, w: World, keys: set[str]) -> list[str]:
    ks = call_kinds(c, w, None)
    if ks == ["?"]:  # no kind param, no $key: the kinds of the rows the gold touches
        ks = sorted({w.kinds.get(k, "?") for k in keys} - {"?"}) or ["?"]
    return ks


def h_gold_keys(t: dict) -> tuple[set[str], set[str]]:
    """(keys the gold wrote, keys the gold answered with)."""
    diff = {r.get("key") for g in t["gold"] for r in (g.get("diff") or {}).get("rows", []) if r.get("key")}
    rows = {k for g in t["gold"] if g["type"] == "rows" for k in g.get("rows", [])}
    return diff, rows


def h_when(a: dict):
    w = a.get("when")
    if isinstance(w, str):
        try:
            w = json.loads(w)
        except json.JSONDecodeError:
            return None
    return w if isinstance(w, dict) else None


def h_when_form(a: dict) -> str | None:
    """closed / open-to / open-from / point for a call's `when`."""
    w = h_when(a)
    if not w:
        return None
    lo, hi = w.get("from"), w.get("to")
    return "closed" if lo and hi else "open-to" if hi else "open-from" if lo else "point"


def h_length_form(a: dict) -> str | None:
    """where-duration (an event's duration) / where-effort (a task's effort) for a length condition."""
    where = str(a.get("where") or "")
    return "where-duration" if re.search(r"\bduration\b", where) else "where-effort" if re.search(r"\beffort\b", where) else None


def h_tense(low: str) -> str | None:
    past, fut = _rx(C.H6_PAST).search(low), _rx(C.H6_FUTURE).search(low)
    return "past" if past and not fut else "future" if fut and not past else None


def h1(low, refs):
    out = []
    for fam, (rx, _sides) in C.H1_IDIOMS.items():
        if _rx(rx).search(low):
            out += [("H", "H1 idiom", fam, side) for c in refs for side in h_sides(c)]
    return out


def h2(low, refs, t, w):
    """A trailing purpose / reason / aside after the request, and whether the reference call carries a word of it."""
    tools = {c["tool"] for c in refs}
    if tools & {"ask", "decline"} or not tools & {"act", "answer", "find", "search", "open", "compute"}:
        return []
    verbs = {(c.get("args") or {}).get("verb") for c in refs if c["tool"] == "act"}
    if "act" in tools and verbs <= {"undo"}:
        return []
    found = []
    for cls, rx in C.H2_CLAUSES.items():
        for m in _rx(rx).finditer(low):
            if m.start() < 8:
                continue
            words = h_words(low[m.start():])
            if words:
                found.append((m.start(), cls, words))
                break
    if not found:
        return []
    _, cls, words = min(found)
    diff, rows = h_gold_keys(t)
    named = {k for c in refs for k in row_keys(c)} | diff | rows
    text = " ".join(str(v) for c in refs for v in (c.get("args") or {}).values()).lower()
    text += " " + " ".join(w.names.get(k, "") for k in named).lower()
    carried = any(x in text or x[:5] in text for x in words)
    return [("H", "H2 inert clause", cls, "write" if "act" in tools else "read", "carried" if carried else "inert")]


def h3(low, refs, t, w, rep):
    """The row the call targets shares a distinctive name word (that the message uses) with another row."""
    msg_words = set(h_words(low, C.H3_GENERIC))
    if not msg_words:
        return []
    name_words = w.h_name_words()
    live = [k for k in name_words if k not in w.trashed]

    def relation(a_key, b_key):
        return "trashed" if b_key in w.trashed else "same-kind" if w.kinds[a_key] == w.kinds[b_key] else "other-kind"

    asks = [c for c in refs if c["tool"] == "ask"]
    if asks:
        if not (any((c.get("args") or {}).get("options") for c in asks) or rep.get("ambiguous")):
            return []
        for word in sorted(msg_words):
            hit = [k for k in live if word in name_words[k]]
            if len(hit) >= 2:
                whole = any(w.names[k].lower() in low for k in hit)
                return [("H", "H3 lookalike", "same-kind" if len({w.kinds[k] for k in hit}) == 1 else "other-kind",
                         "whole" if whole else "partial", "ask")]
        return []
    diff, rows = h_gold_keys(t)
    targets = {k for c in refs for h in handles((c.get("args") or {}).get("rows") or (c.get("args") or {}).get("row"))
               for k in ([h[1:]] if h.startswith("$") else [])} | diff | (rows if len(rows) <= 4 else set())
    targets &= set(w.names)
    forms = set()
    for c in refs:
        a = c.get("args") or {}
        if c["tool"] not in ("act", "answer", "find", "open"):
            continue
        hs = handles(a.get("rows"))
        qual = any(a.get(k) for k in ("where", "linked_to", "when", "within"))
        if any(h[0] in "@#" for h in hs):
            forms.add("#n")
        elif any(h.startswith("$") for h in hs) or a.get("name"):
            forms.add("name+qualifier" if qual else "name")
        elif qual:
            forms.add("where")
    rels = set()
    for k in targets:
        said = msg_words & name_words[k]  # what the message says of the target's name
        if said:  # a lookalike carries every one of those words: the message alone does not tell the two apart
            ext = "whole" if name_words[k] <= msg_words else "partial"
            rels |= {(relation(k, j), ext) for j in w.names if j != k and j not in targets and said <= name_words[j]}
    return [("H", "H3 lookalike", r, e, f) for r, e in sorted(rels) for f in sorted(forms)]


def h_name_fits(name: str, row_name: str, nickname: str = "") -> bool:
    """The runtime's read of a name (ground.rs ground_name): every word of the name, an article and a possessive 's aside, is a
    word of the row's name or nickname, or (three letters or more) begins one."""
    words = [x for x in re.findall(r"[^\W_]+", re.sub(r"'s\b", "", name.lower())) if x not in ("the", "a", "an")]
    have = re.findall(r"[^\W_]+", f"{row_name} {nickname}".lower())
    return bool(words) and all(any(h == x or (len(x) >= 3 and h.startswith(x)) for h in have) for x in words)


def h_name_misses(c: dict, w: World) -> bool:
    """A call by `name` whose name reaches no live row of its kind(s) (trashed rows too when it asks for them), and that no
    row of another kind carries in full: the by-name miss the runtime composes the ending of (SPEC 4.8)."""
    a = c.get("args") or {}
    name = str(a.get("name") or "").strip()
    if not name or c["tool"] not in ("act", "answer", "find", "compute", "open") or handles(a.get("rows")):
        return False
    kinds = {k for k in call_kinds(c, w, None) if k != "?"}
    nick = {p.get("key"): str(p.get("nickname") or "") for p in w.raw.get("people", []) or []}
    for k, n in w.names.items():
        if k in w.trashed and not (a.get("trashed") or a.get("verb") == "restore"):
            continue
        if kinds and w.kinds.get(k) not in kinds:
            if n.strip().lower() == name.lower():
                return False  # another kind has the name in full: the runtime's other-kind answer, not a miss
            continue
        if h_name_fits(name, n, nick.get(k, "")):
            return False
    return True


def h_not_found(t: dict, refs: list, w: World) -> bool:
    """Did the turn end in a miss? Read from the GOLD, since the model never writes `decline not_found` (SPEC 8.5, 4.8): a gold
    decline not_found; or a by-name call whose name reaches no row and whose gold is the composed ending (an empty or
    near-spelling `rows` answer, or an ask over the near spellings). Conditions alone that leave nothing are an answer."""
    gold = t.get("gold") or []
    if any(g["type"] == "decline" and "not_found" in g.get("reasons", []) for g in gold):
        return True
    # the reference ENDS at the by-name call that reached nothing (a `find` miss is a lookup the turn goes on from, so it
    # is never that call; a name repaired by a later search or a later call by handle is no miss)
    last = refs[-1] if refs else None
    ends_at_miss = (last is not None and last["tool"] in ("act", "answer", "compute", "open") and h_name_misses(last, w))
    return ends_at_miss and any(g["type"] in ("rows", "ask") for g in gold)


def h4(low, refs, ti, s, w, rep, t):
    out = []
    tools = [c["tool"] for c in refs]
    reasons = [(c.get("args") or {}).get("reason") for c in refs if c["tool"] == "decline"]
    verbs = [(c.get("args") or {}).get("verb") for c in refs if c["tool"] == "act"]
    n_words = len(low.split())
    # not_found: the miss that ends in a decline, by what was tried first, and whether a near-hit row exists
    missed = h_not_found(t, refs, w)
    if missed:
        # what the turn tried first, in call order (a rejected attempt, `bad`, still counts: it is what was tried)
        first = next((c["tool"] for c in t["ref"] if c["tool"] in ("search", "find", "answer", "compute", "open", "act")), None)
        out.append(("H", "H4 stop signal", "not_found",
                    {"search": "search-miss", "find": "find-miss", "act": "write-by-name-miss"}.get(first, "read-by-name-miss")))
        near = set(h_words(low, C.H3_GENERIC)) & {x for k, n in w.names.items() if k not in w.trashed
                                                  for x in h_words(n, C.H3_GENERIC)}
        out.append(("H", "H4 stop signal", "not_found", "with-near-hit-row" if near else "no-near-hit-row"))
    # retraction: where it sits x what the reference did
    m = _rx(C.H4_RETRACT).search(low)
    if m:
        idx = len(low[:m.start()].split())
        pos = "start" if idx <= 1 else "end" if idx + len(m.group(0).split()) >= n_words - 2 else "middle"
        outcome = ("decline:never_mind" if "never_mind" in reasons else "undo" if "undo" in verbs
                   else "act" if set(verbs) - {"undo"} else None)
        if outcome:
            out.append(("H", "H4 stop signal", "retraction", f"{pos}>{outcome}"))
        if missed:
            out.append(("H", "H4 stop signal", "retraction", "any>decline:not_found"))
    # FYI-only: a statement that asks for nothing
    prev_ask = ti > 0 and any(c["tool"] == "ask" for c in s["turns"][ti - 1]["ref"])
    if (n_words >= 4 and not prev_ask and not low.endswith("?") and not _rx(C.H4_COMMAND).search(low)
            and _rx(C.H4_FYI).search(low)):
        out.append(("H", "H4 stop signal", "fyi-only", "ask" if "ask" in tools else "decline" if "decline" in tools
                    else "act" if "act" in tools else "read"))
    # all-but-one: a quantifier, then an exception
    qm = _rx(C.H4_ALL).search(low)
    if qm and _rx(C.H4_EXCEPT).search(low, qm.end()):
        kill = {"delete", "remove_from"} & set(verbs)
        out.append(("H", "H4 stop signal", "all-but-one",
                    "decline:unbounded_destruction" if "unbounded_destruction" in reasons else
                    "delete-by-find" if kill else "act-other" if set(verbs) - {"undo"} else "read"
                    if not {"decline", "ask"} & set(tools) else "decline:" + str(reasons[0] if reasons else "ask")))
    # off-topic
    if "out_of_scope" in reasons:
        out.append(("H", "H4 stop signal", "off-topic", "first-turn" if ti == 0 else "later-turn"))
        if set(h_words(low, C.H3_GENERIC)) & {x for n in w.names.values() for x in h_words(n, C.H3_GENERIC)}:
            out.append(("H", "H4 stop signal", "off-topic", "vault-word-decoy"))
    return out


def h5(low, refs, t, w):
    """A kinship / trade / world-role noun, and how the reference call answers it: role filter, one row, whole set."""
    det = r"(?:my|the|our|his|her|their|a|an)"
    kin = bool(_rx(rf"\b(?:{det} (?:\w+ )?)?(?:{'|'.join(map(re.escape, sorted(C.H5_KIN)))})s?\b").search(low))
    trade = bool(_rx(rf"\b{det} (?:\w+ )?(?:{'|'.join(map(re.escape, sorted(C.H5_TRADE)))})s?\b").search(low))
    roles = sorted({str(p.get("role") or "").lower().strip() for p in w.raw.get("people", []) or []} - C.H5_KIN - C.H5_TRADE)
    roles = [r for r in roles if 4 <= len(r) <= 30 and r.count(" ") <= 2]
    world_role = bool(roles) and bool(_rx(rf"\b{det} (?:{'|'.join(map(re.escape, roles))})s?\b").search(low))
    cls = "kinship" if kin else "trade" if trade else "world-role" if world_role else None
    if not cls:
        return []
    diff, rows = h_gold_keys(t)
    keys = diff | rows
    forms, prev_kinds = set(), ["?"]
    for c in refs:
        a = c.get("args") or {}
        if c["tool"] not in ("act", "answer", "find", "search", "open") or a.get("verb") == "create":
            continue
        hs = handles(a.get("rows"))
        kinds = h_kinds(c, w, keys if not any(h[0] in "@#" for h in hs) else set())
        if kinds == ["?"] and any(h[0] in "@#" for h in hs):
            kinds = prev_kinds  # @n / #n picks from the call before
        prev_kinds = kinds if kinds != ["?"] else prev_kinds
        if "person" not in kinds:
            continue
        if re.search(r"\brole\b", str(a.get("where") or "")):
            forms.add("role-filter")
        elif a.get("name") or (len(hs) == 1 and hs[0].startswith("$")):
            forms.add("name-or-key")
        elif (len(hs) == 1 and hs[0][0] in "@#") or str(a.get("limit")) == "1":
            forms.add("pick")
        elif c["tool"] in ("answer", "find", "search"):
            forms.add("whole-set")
    return [("H", "H5 role noun", cls, f) for f in sorted(forms)]


def h6(low, refs):
    tense = h_tense(low)
    if not tense:
        return []
    calls = [c.get("args") or {} for c in refs if c["tool"] != "ask"]
    when_forms = {f for a in calls for f in [h_when_form(a)] if f}
    length_forms = {f for a in calls for f in [h_length_form(a)] if f}
    out = []
    for ph, (rx, _forms) in C.H6_PHRASES.items():
        if _rx(rx).search(low):  # a length phrase is a where condition, every other phrase is a `when`
            out += [("H", "H6 date phrase", ph, f, tense) for f in sorted(length_forms if ph == "longer-than-N-hours" else when_forms)]
    return out


def h7_index(w: World) -> list[tuple]:
    """[(container key, kind, name words that rows outside the container also carry)] for the world."""
    if w._h7 is not None:
        return w._h7
    links = {(l.get("from"), l.get("to")) for l in w.raw.get("links", []) or [] if isinstance(l, dict)}
    member = {}
    for ckind, (_mk, field) in C.H7_CONTAINERS.items():
        for sec, kind in SECTION_KIND.items():
            for r in w.raw.get(sec, []) or []:
                if isinstance(r, dict) and r.get("key") and field in r:
                    v = r[field]
                    member.setdefault(ckind, set()).update((r["key"], c) for c in (v if isinstance(v, list) else [v]))
    out = []
    for ckind in C.H7_CONTAINERS:
        sec = next(k for k, v in SECTION_KIND.items() if v == ckind)
        for cont in w.raw.get(sec, []) or []:
            ck = cont.get("key") if isinstance(cont, dict) else None
            if not ck:
                continue
            cw = set(h_words(str(cont.get("name", "")), C.H3_GENERIC))
            hits = set()
            for j, text in w.text.items():
                if j == ck or (j, ck) in member.get(ckind, ()) or (j, ck) in links:
                    continue
                hits |= {x for x in cw if re.search(rf"\b{re.escape(x)}", text)}
            if hits:
                out.append((ck, ckind, hits))
    w._h7 = out
    return out


def h7(low, refs, w):
    """The message names a container whose name word also lives in rows outside it: linked_to, or a name filter."""
    out = []
    for ck, ckind, words in h7_index(w):
        used = sorted(x for x in words if re.search(rf"\b{re.escape(x)}", low))
        if not used:
            continue
        naming = ("kind-word" if _rx(C.H7_KIND_WORD[ckind]).search(low)
                  else "full-name" if w.names.get(ck, "").lower() in low else "theme-word")
        linked = any(f"${ck}" in str((c.get("args") or {}).get("linked_to") or "") or
                     re.search(r"[@#]", str((c.get("args") or {}).get("linked_to") or "")) for c in refs)
        filt = any(c["tool"] in ("act", "answer", "find", "search") and ckind not in call_kinds(c, w, None)
                   and any(x in str((c.get("args") or {}).get("name") or "").lower() + " " +
                           str((c.get("args") or {}).get("where") or "").lower() for x in used) for c in refs)
        if linked:
            out.append(("H", "H7 container word", ckind, naming, "linked_to"))
        elif filt:
            out.append(("H", "H7 container word", ckind, naming, "name-filter"))
    return out


def h_turn_uses(s: dict, ti: int, w: World) -> list[tuple]:
    """Every H cell turn `ti` of session `s` exercises (deduplicated)."""
    t = s["turns"][ti]
    low = h_message(t)
    refs = [c for c in t["ref"] if not c.get("bad")]
    rp = s.get("replay") or []
    rep = rp[ti] if ti < len(rp) else {}
    out = h1(low, refs) + h2(low, refs, t, w) + h3(low, refs, t, w, rep) + h4(low, refs, ti, s, w, rep, t)
    out += h5(low, refs, t, w) + h6(low, refs) + h7(low, refs, w)
    return list(dict.fromkeys(out))


def classify_h(sessions: list[dict], worlds_dir: Path):
    """uses: H cell -> [(world, session id)], over the sessions' turns."""
    worlds, uses = {}, collections.defaultdict(list)
    for s in sessions:
        w = worlds.setdefault(s["world"], World(worlds_dir, s["world"]))
        for ti in range(len(s["turns"])):
            for cell in h_turn_uses(s, ti, w):
                uses[cell].append((s["world"], s["id"]))
    return uses


def h_side_totals(sessions: list[dict]) -> collections.Counter:
    """How many reference calls of each H1 side (verb, create:<kind>, read, decline:<reason>, ask) the corpus has in
    ALL messages: what tables A-G see of that side, set against what an idiom's own messages show."""
    out = collections.Counter()
    for s in sessions:
        for t in s["turns"]:
            for c in t["ref"]:
                if not c.get("bad"):
                    out.update(h_sides(c))
    return out


def h_report(uses, min_uses=3, min_worlds=2, totals=None) -> str:
    """The H census as markdown: per sub-table, every cell with its uses and worlds, EMPTY / THIN flagged. With `totals`
    (h_side_totals) an H1 row also shows how often its side occurs in any message, i.e. how full tables A-G call it."""
    reach = C.universe_h()["reachable"]
    lines, empty, thin = ["# H census (message-side decisions)", ""], [], []
    for sub in dict.fromkeys(c[1] for c in reach):
        cs = [c for c in reach if c[1] == sub]
        extra = totals is not None and sub == "H1 idiom"
        lines += [f"## {sub} ({len(cs)} cells)", "",
                  "| cell | uses | worlds | status |" + (" side overall (any message) |" if extra else ""),
                  "|---|---|---|---|" + ("---|" if extra else "")]
        for c in cs:
            n, nw = len(uses.get(c, [])), len({x for x, _ in uses.get(c, [])})
            st = "EMPTY" if not n else "THIN" if n < min_uses or nw < min_worlds else "ok"
            (empty if st == "EMPTY" else thin if st == "THIN" else []).append(c)
            lines.append(f"| {' · '.join(c[2:])} | {n} | {nw} | {st} |" + (f" {totals[c[3]]} |" if extra else ""))
        lines.append("")
    stray = sorted((c for c in uses if c[0] == "H" and c not in set(reach)), key=lambda c: (-len(uses[c]), c))
    lines.insert(2, f"{len(reach)} cells: {len(reach) - len(empty) - len(thin)} ok, {len(thin)} thin "
                    f"(< {min_uses} uses or < {min_worlds} worlds), {len(empty)} empty.\n")
    lines += [f"## Observed but outside the universe ({len(stray)})", ""]
    lines += [f"- {C.cell_str(c)}: {len(uses[c])}" for c in stray[:60]]
    return "\n".join(lines) + "\n"


# --- contamination ----------------------------------------------------------------------------


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
            if len(t["user"].split()) < 6:  # short generic messages collide by nature
                continue
            g = ngrams(t["user"])
            cand = collections.Counter(j for x in g for j in idx.get(x, ()))
            for j, c in cand.most_common(3):
                jac = c / len(g | grams[j])
                if jac >= thr or t["user"].strip().lower() == ev[j].strip().lower():
                    hits.append({"authored": t["user"], "eval_len": len(ev[j]), "jaccard": round(jac, 2), "session": s["id"]})  # no eval text: authors read this
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
    ap.add_argument("--h-only", action="store_true",
                    help="only table H (message-side decisions): print/save its census, no nativetools export, exit 0")
    ap.add_argument("--min-uses", type=int, default=3)
    ap.add_argument("--min-worlds", type=int, default=2)
    a = ap.parse_args()
    if (a.assign is None) != (a.world is None):
        ap.error("--assign and --world go together")
    ses = [json.loads(l) for f in a.gold for l in open(f) if l.strip()]
    if a.assign is None:
        ses = split.drop_val(ses)  # corpus mode is the training corpus; a world's own sheet (world mode) may be a val world
    if a.h_only:
        text = h_report(classify_h(ses, Path(a.worlds)), a.min_uses, a.min_worlds, h_side_totals(ses))
        if a.md:
            Path(a.md).write_text(text)
        print(text)
        sys.exit(0)
    uses, rates, outcome, lengths, undo_worlds, worlds, feat_rates = classify(ses, Path(a.worlds))
    for cell, us in classify_h(ses, Path(a.worlds)).items():  # table H reads the message, so it has its own pass
        uses[cell].extend(us)
    U = C.universe()
    fail = []
    out = {"size": {"sessions": len(ses), "turns": sum(len(s["turns"]) for s in ses), "worlds": sorted(worlds)},
           "tables": {}, "rates": rates, "features": feat_rates}
    lines = [f"# Coverage: {len(ses)} sessions, {out['size']['turns']} turns, worlds {', '.join(sorted(worlds))}", ""]

    # tables
    lines.append("## Scenario cells (tables A-H)\n")
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

    # runtime behaviour
    lines.append("\n## Observed runtime behaviour\n")
    for k, (lo, hi) in BOUNDS3.items():
        ok = bound_ok(rates[k], lo, hi)
        lines.append(f"- {k}: {rates[k]:.1%} (spec {fmt_bound(lo, hi)}) {'pass' if ok else 'FAIL'}")
        if not ok and a.assign is None:
            fail.append(f"runtime {k}")
    no_undo = [w for w in sorted(worlds) if not undo_worlds[w]]
    lines.append(f"- worlds without an undo: {', '.join(no_undo) or 'none'} {'pass' if not no_undo else 'FAIL'}")
    if no_undo and a.assign is None:
        fail.append("runtime undo per world")

    # corpus shape
    lines.append("\n## Corpus shape\n")
    nS, nT = len(ses), max(out["size"]["turns"], 1)
    lshare = {n: lengths[n] / max(nS, 1) for n in range(1, 8)}
    missing_len = [n for n in range(1, 8) if not lengths[n]]
    ok = max(lshare.values()) <= 0.40 and not missing_len
    lines.append("- session length: " + ", ".join(f"{n if n < 7 else '7+'}: {lshare[n]:.0%}" for n in range(1, 8))
                 + f" (spec: every length 1–7, none above 40%) {'pass' if ok else 'FAIL'}")
    if not ok and a.assign is None:
        fail.append("shape session length")
    oshare = {k: v / nT for k, v in outcome.items()}
    need = ["answer-rows", "answer-value", "write", "write+read", "ask", "decline", "find-only"]
    ok = all(outcome[k] for k in need) and max(oshare.values()) <= 0.45
    lines.append("- turn outcomes: " + ", ".join(f"{k}: {oshare.get(k, 0):.0%}" for k in need)
                 + f" (spec: all present, none above 45%) {'pass' if ok else 'FAIL'}")
    if not ok and a.assign is None:
        fail.append("shape turn outcomes")
    for k, (lo, hi) in BOUNDS4.items():
        ok = bound_ok(rates[k], lo, hi)
        lines.append(f"- {k}: {rates[k]:.1%} (spec {fmt_bound(lo, hi)}) {'pass' if ok else 'FAIL'}")
        if not ok and a.assign is None:
            fail.append(f"shape {k}")
    types = C.export()["enums"].get(LOCKER_TYPES_KEY, [])
    for wn, w in sorted(worlds.items()):
        lk = [r for r in w.raw.get("locker", []) or [] if isinstance(r, dict)]
        miss_t = sorted(set(types) - {r.get("type") for r in lk})
        thin_k = sorted(k for k in C.export()["kinds"] if w.rows_per_kind[k] < 3)
        ok = 15 <= len(lk) <= 20 and not miss_t and not thin_k
        lines.append(f"- world {wn}: {len(lk)} locker items, missing types {miss_t or 'none'}, kinds under 3 rows "
                     f"{thin_k or 'none'} (spec: 15–20 items, every type, enough rows for 0/1/many) {'pass' if ok else 'FAIL'}")
        if not ok and a.assign is None:
            fail.append(f"shape world {wn}")
    out["shape"] = {"lengths": lshare, "outcomes": oshare}

    lines.append("\n## Other per-turn features\n")
    lines += [f"- {k}: {v:.0%}" for k, v in sorted(feat_rates.items())]

    lines += detail

    ev_dir = NATIVE / "eval" / "sets"
    evs = [json.loads(l) for f in ("val.jsonl", "test.jsonl") if (ev_dir / f).exists() for l in open(ev_dir / f)]
    out["contamination"] = overlap(ses, evs)
    lines.append(f"\n## Overlap with val/test text ({len(out['contamination'])} messages at 4-gram Jaccard >= 0.5)\n")
    # The eval text itself is never printed: authors read this report and must not see val/test messages.
    lines += [f"- {h['session']}: {h['authored']!r} ~ an eval message ({h['jaccard']}); reword it" for h in out["contamination"]]
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
