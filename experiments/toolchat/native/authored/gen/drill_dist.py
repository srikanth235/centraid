"""Convention distributions of training records, natural and drill (phase 7, round 2 of the drills, #1044).

    python3 authored/gen/drill_dist.py [LABEL=]FILE_OR_GLOB ... [--md OUT.md] [--json OUT.json] [--worlds DIR]

Each argument is a record file (jsonl or jsonl.gz, one session per line as `data/train.jsonl.gz` and the per-world
builds and drills write them) or a glob of them, with an optional label. The records of a group are split into the
two populations a table compares, `natural` and `drill` (a drill is a record with a `pair:<id>` tag, or an id that
ends `-D####a` / `-D####b`; the word "drill" in a natural record's tags, a fire drill, does not make it one), so one
file of the assembled train set gives both columns and a natural build and a drill build give one each.

What it prints, per population (items 1 to 5 are the conventions the drills were measured against, 6 the cells):

 1. text-field operators: for every field of a `where` condition of an `act`, `find`, `answer` or `compute` call, how
    many conditions say `=`, `contains` or something else (`!=`, `in`, `is set`, `is empty`, a comparison), the share
    that is `contains`, and for a text field the relation of the value to the world's own values (the whole value of
    a row, a part of one, or none);
 2. the role filter of a person write, with and without a `name`;
 3. a duration in the message: of the writes whose message mentions one (minutes, hours, half an hour, ...), how
    many carry a duration or effort field (`duration:` / `effort:` in the args or a condition of the `where`), how
    many a `when` span (`from`..`to`), how many shift the row (`anchor: row`) and how many are none of these;
 4. `linked_to`: the share of calls that carry it, by tool and by turn (the first turn, or a follow-up: turn > 1);
 5. the selector form of an `act`: `#n` rows, `@n` rows, a name, a `where`, the combinations;
 6. per drill cell: sessions, pairs, turns and calls by tool.

It reads records only; it never runs the runtime. `--worlds` is the directory of `<W>.json` worlds (default
authored/worlds), read for the value relation of table 1; `--md` writes the tables to a file, `--json` the counts
behind them (one object per population).
"""
from __future__ import annotations

import argparse
import collections
import glob
import gzip
import json
import os
import re
import sys
from pathlib import Path

NATIVE = Path(__file__).resolve().parents[2]
SELECTOR_TOOLS = ("act", "find", "answer", "compute")
TEXT_FIELDS = ("role", "met", "nickname", "description", "body", "username", "url", "notes", "area")
# the kind each text field belongs to in a world JSON, and the world key and field name that hold it
WORLD_FIELDS = {"role": [("people", "role")], "met": [("people", "met")], "nickname": [("people", "nickname")],
                "description": [("events", "description"), ("tasks", "description")], "body": [("notes", "body")],
                "username": [("locker", "username")], "url": [("locker", "url")], "notes": [("locker", "notes")],
                "area": [("lists", "area")]}
PAIR_ID = re.compile(r"-D\d+[ab]$")
DURATION = re.compile(
    r"\b(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|half an?|a couple of|couple of)\s*-?\s*"
    r"(?:min(?:ute)?s?|hrs?|hours?)\b", re.I)


# =============================================================================================================
# reading
# =============================================================================================================


def open_text(path: str):
    return gzip.open(path, "rt") if path.endswith(".gz") else open(path)


def expand(spec: str) -> tuple[str, list[str]]:
    label, eq, rest = spec.partition("=")
    if not eq or "/" in label or "*" in label:
        label, rest = "", spec
    paths = sorted(glob.glob(os.path.expanduser(rest))) or ([rest] if os.path.exists(rest) else [])
    if not paths:
        raise SystemExit(f"no file matches {rest!r}")
    return label or rest, paths


def read_records(paths: list[str]):
    for p in paths:
        with open_text(p) as f:
            for line in f:
                if line.strip():
                    yield json.loads(line)


def is_drill(rec: dict) -> bool:
    return any(str(t).startswith("pair:") for t in rec.get("tags", [])) or bool(PAIR_ID.search(rec.get("id", "")))


def pair_of(rec: dict) -> str:
    """`T01-D0007` of `train-T01-D0007a` (the `pair:` tag when the record has one)."""
    tag = next((str(t)[5:] for t in rec.get("tags", []) if str(t).startswith("pair:")), None)
    return tag or re.sub(r"^(?:train-)?(.*?)[ab]$", r"\1", rec["id"])


def cell_of(rec: dict) -> str:
    tags = rec.get("tags", [])
    return str(tags[tags.index("drill") + 1]).upper() if "drill" in tags and tags.index("drill") + 1 < len(tags) else "?"


class Call:
    __slots__ = ("rec", "turn", "user", "tool", "args", "think")

    def __init__(self, rec, turn, user, tool, args, think):
        self.rec, self.turn, self.user, self.tool, self.args, self.think = rec, turn, user, tool, args, think


def calls(rec: dict):
    """Every assistant call of a record with its turn number (1 for the first user message) and the person's words."""
    turn, user = 0, ""
    for m in rec["messages"]:
        if m["role"] == "user":
            turn += 1
            user = m["content"].split("\n\n")[-1]
        elif m["role"] == "assistant":
            yield Call(rec, turn, user, m.get("tool"), m.get("args") or {}, m.get("think", ""))


# =============================================================================================================
# where conditions
# =============================================================================================================


def split_and(text: str) -> list[str]:
    """`a = 1 and b contains "x and y"` -> two conditions (an `and` inside quotes or brackets is not a joint)."""
    out, depth, quote, cur, i = [], 0, False, [], 0
    while i < len(text):
        ch = text[i]
        if quote:
            cur.append(ch)
            if ch == "\\" and i + 1 < len(text):
                cur.append(text[i + 1])
                i += 1
            elif ch == '"':
                quote = False
        elif ch == '"':
            quote = True
            cur.append(ch)
        elif ch in "([":
            depth += 1
            cur.append(ch)
        elif ch in ")]":
            depth -= 1
            cur.append(ch)
        elif depth == 0 and text.startswith(" and ", i):
            out.append("".join(cur).strip())
            cur = []
            i += 4
        else:
            cur.append(ch)
        i += 1
    if "".join(cur).strip():
        out.append("".join(cur).strip())
    return out


COND = [
    (re.compile(r"^(?P<f>[a-z][a-z ]*?)\s+contains\s+(?P<v>.+)$"), "contains"),
    (re.compile(r"^(?P<f>[a-z][a-z ]*?)\s+in\s+\((?P<v>.*)\)$"), "in"),
    (re.compile(r"^(?P<f>[a-z][a-z ]*?)\s+is\s+(?P<v>empty|set)$"), "is"),
    (re.compile(r"^(?P<f>[a-z][a-z ]*?)\s*(?P<o>>=|<=|!=|=|<|>)\s*(?P<v>.+)$"), "cmp"),
]


def parse_where(text) -> list[tuple[str, str, str]]:
    """`role contains "plumber" and status = open` -> [(field, op, value)]; op `is set` / `is empty` keep the two words."""
    out = []
    if not isinstance(text, str):
        return out
    for c in split_and(text):
        for rx, kind in COND:
            m = rx.match(c)
            if not m:
                continue
            f, v = m.group("f").strip(), m.group("v").strip()
            op = {"contains": "contains", "in": "in", "is": f"is {v}", "cmp": m.groupdict().get("o")}[kind]
            if kind != "in" and v.startswith('"') and v.endswith('"') and len(v) >= 2:
                v = v[1:-1]
            out.append((f, op, "" if kind == "is" else v))
            break
    return out


def has_span(when) -> bool:
    """Whether a `when` expression (JSON text) is a span: both ends, `from` and `to`."""
    return isinstance(when, str) and '"from"' in when and '"to"' in when


def op_class(op: str) -> str:
    return op if op in ("=", "contains") else "other"


# =============================================================================================================
# the world's own values, for the relation of a text constraint to the field it reads
# =============================================================================================================


def fold(text: str) -> str:
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", str(text).lower()) if unicodedata.category(c) != "Mn")


class Worlds:
    def __init__(self, root: Path):
        self.root, self.cache = root, {}

    def values(self, world: str, field: str) -> set[str]:
        key = (world, field)
        if key not in self.cache:
            vals: set[str] = set()
            p = self.root / f"{world}.json"
            if p.exists() and field in WORLD_FIELDS:
                w = json.loads(p.read_text())
                for sec, name in WORLD_FIELDS[field]:
                    vals |= {fold(x[name]) for x in w.get(sec, []) if x.get(name)}
            self.cache[key] = vals
        return self.cache[key]

    def relation(self, world: str, field: str, op: str, value: str) -> str:
        vals = self.values(world, field)
        if not vals:
            return "?"
        v = fold(value)
        if v in vals:
            return "whole"
        if op == "contains" and any(v in x for x in vals):
            return "part"
        return "none"


# =============================================================================================================
# one population
# =============================================================================================================


class Pop:
    def __init__(self, name: str):
        self.name = name
        self.sessions = 0
        self.turns = 0
        self.ops = collections.Counter()          # (field, op class) over every selector call
        self.ops_act = collections.Counter()      # the same over act calls
        self.rel = collections.Counter()          # (field, op class, relation) for text fields
        self.role = collections.Counter()         # (has name, op class, relation) on a person act
        self.dur = collections.Counter()
        self.dur_create = collections.Counter()
        self.lk = collections.defaultdict(lambda: [0, 0])   # (group, turn group) -> [calls, with linked_to]
        self.cell_lk = collections.defaultdict(lambda: [0, 0])  # (cell, group, turn group) -> [calls, with linked_to]
        self.dur_read = collections.Counter()
        self.form = collections.Counter()
        self.cells = collections.defaultdict(lambda: {"sessions": 0, "turns": 0, "calls": collections.Counter(), "pairs": set()})

    # -- accumulate
    def add(self, rec: dict, worlds: Worlds) -> None:
        self.sessions += 1
        self.turns += rec.get("n_turns") or sum(1 for m in rec["messages"] if m["role"] == "user")
        drill = is_drill(rec)
        if drill:
            c = self.cells[cell_of(rec)]
            c["sessions"] += 1
            c["turns"] += rec.get("n_turns") or 0
            c["pairs"].add(pair_of(rec))
        for call in calls(rec):
            if drill:
                self.cells[cell_of(rec)]["calls"][call.tool] += 1
            self.one(call, rec, worlds)

    def one(self, call: Call, rec: dict, worlds: Worlds) -> None:
        a, tool = call.args, call.tool
        tg = "T1" if call.turn <= 1 else "T2+"
        if tool in SELECTOR_TOOLS:
            conds = parse_where(a.get("where"))
            for f, op, val in conds:
                self.ops[(f, op_class(op))] += 1
                if tool == "act":
                    self.ops_act[(f, op_class(op))] += 1
                if f in TEXT_FIELDS and op in ("=", "contains"):
                    rel = worlds.relation(rec.get("world", ""), f, op, val)
                    self.rel[(f, op, rel)] += 1
                    if f == "role" and tool == "act" and a.get("kind") in (None, "person"):
                        self.role[("name" if a.get("name") else "no name", op, rel)] += 1
            grp = {"act": "act", "answer": "read", "find": "read", "compute": "read"}[tool]
            for g in (grp, "selector " + grp) if "kind" in a else (grp,):
                self.lk[(g, tg)][0] += 1
                self.lk[(g, tg)][1] += "linked_to" in a
                if is_drill(rec):
                    cl = self.cell_lk[(cell_of(rec), g, tg)]
                    cl[0] += 1
                    cl[1] += "linked_to" in a
        if tool == "act":
            self.act(call)
        elif tool in ("answer", "find", "compute") and "kind" in a and DURATION.search(call.user or ""):
            cond = bool({f for f, _, _ in parse_where(a.get("where"))} & {"duration", "effort"})
            span = has_span(a.get("when"))
            self.dur_read["reads with a duration in the message"] += 1
            self.dur_read["duration/effort condition in where"] += cond
            self.dur_read["when span (from..to) in the selector"] += span
            self.dur_read["a condition and a when span together"] += cond and span

    def act(self, call: Call) -> None:
        a = call.args
        verb = a.get("verb")
        args_lines = {ln.split(":", 1)[0].strip(): ln.split(":", 1)[1].strip() for ln in str(a.get("args") or "").split("\n") if ":" in ln}
        span_args = any('"from"' in v and '"to"' in v for v in args_lines.values())
        # selector form
        if verb != "undo":
            rows = str(a.get("rows") or "")
            if rows:
                has_at, has_hash = "@" in rows, "#" in rows
                form = "rows #n" if has_hash and not has_at else "rows @n" if has_at and not has_hash else "rows mixed"
            elif verb == "create":
                form = "create (no selector)"
            else:
                parts = [k for k in ("name", "where", "when", "linked_to", "within") if a.get(k)]
                form = "+".join(parts) if parts else "kind only"
            self.form[form] += 1
        field = "duration" in args_lines or "effort" in args_lines
        mention = bool(DURATION.search(call.user or ""))
        # a duration in the message: where does the write put it
        if mention:
            wfield = bool({f for f, _, _ in parse_where(a.get("where"))} & {"duration", "effort"})
            span_when = has_span(a.get("when"))
            shift = any('"anchor":"row"' in v and ('"unit":"hour"' in v or '"unit":"minute"' in v) for v in args_lines.values())
            self.dur["writes with a duration in the message"] += 1
            self.dur["duration/effort field in args"] += field
            self.dur["duration/effort condition in where"] += wfield
            self.dur["when span (from..to) in the selector"] += span_when
            self.dur["from..to span in the args"] += span_args
            self.dur["row shift (anchor row, hours or minutes)"] += shift
            self.dur["a field and a when span together"] += (field or wfield) and span_when
            self.dur["none of field, span, shift"] += not (field or wfield or span_when or span_args or shift)
        if verb == "create" and a.get("kind") == "event":
            self.dur_create["event creates"] += 1
            self.dur_create["  with a duration field"] += field
            self.dur_create["  with a from..to span as the date"] += span_args
            self.dur_create["  whose message mentions a duration"] += mention
            self.dur_create["  mentioning a duration, with a duration field"] += mention and field
            self.dur_create["  mentioning a duration, with a from..to span as the date"] += mention and span_args


# =============================================================================================================
# rendering
# =============================================================================================================


def pct(n: int, d: int) -> str:
    return f"{100 * n / d:.1f}%" if d else "-"


def md_table(head: list[str], rows: list[list]) -> list[str]:
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" if i == 0 else "---:" for i in range(len(head))) + "|"]
    out += ["| " + " | ".join(str(x) for x in r) + " |" for r in rows]
    return out


def text_field_table(pops: list[Pop], counter: str, title: str) -> list[str]:
    fields = [f for f in TEXT_FIELDS if any(getattr(p, counter)[(f, c)] for p in pops for c in ("=", "contains", "other"))]
    head = ["field"]
    for p in pops:
        head += [f"{p.name}: =", "contains", "other", "% contains"]
    rows = []
    for f in fields:
        r = [f]
        for p in pops:
            eq, co, ot = (getattr(p, counter)[(f, c)] for c in ("=", "contains", "other"))
            r += [eq, co, ot, pct(co, eq + co)]
        rows.append(r)
    if not rows:
        return [f"### {title}", "", "no text-field condition", ""]
    return [f"### {title}", ""] + md_table(head, rows) + [""]


def relation_table(pops: list[Pop]) -> list[str]:
    keys = sorted({(f, op) for p in pops for (f, op, _r) in p.rel})
    head = ["field op"]
    for p in pops:
        head += [f"{p.name}: whole", "part", "none"]
    rows = []
    for f, op in sorted(keys, key=lambda k: (TEXT_FIELDS.index(k[0]), k[1])):
        r = [f"{f} {op}"]
        for p in pops:
            r += [p.rel[(f, op, x)] for x in ("whole", "part", "none")]
        rows.append(r)
    return ["### Value of a text condition against the world's own values (whole value of a row, a part of one, none)", ""] + md_table(head, rows) + [""]


def role_table(pops: list[Pop]) -> list[str]:
    head = ["person act with a role condition"]
    for p in pops:
        head += [f"{p.name}"]
    keys = sorted({k for p in pops for k in p.role})
    rows = [[" ".join(k)] + [p.role[k] for p in pops] for k in keys]
    tot = [["all"] + [sum(p.role.values()) for p in pops]]
    return ["### The role filter of a person write (a name beside it, the operator, the value against the world)", ""] + md_table(head, rows + tot) + [""]


def duration_table(pops: list[Pop]) -> list[str]:
    keys = list(dict.fromkeys(k for p in pops for k in p.dur))
    head = ["writes whose message mentions a duration"] + [x for p in pops for x in (p.name, "%")]
    rows = []
    for k in keys:
        base = [p.dur["writes with a duration in the message"] for p in pops]
        rows.append([k] + [x for p, b in zip(pops, base) for x in (p.dur[k], "" if k.startswith("writes") else pct(p.dur[k], b))])
    out = ["### A duration in the message: field, `when` span or shift", ""] + md_table(head, rows) + [""]
    keys3 = list(dict.fromkeys(k for p in pops for k in p.dur_read))
    rows3 = []
    for k in keys3:
        base = [p.dur_read["reads with a duration in the message"] for p in pops]
        rows3.append([k] + [x for p, b in zip(pops, base) for x in (p.dur_read[k], "" if k.startswith("reads") else pct(p.dur_read[k], b))])
    out += md_table(["reads (answer, find, compute with a kind) whose message mentions a duration"] + [x for p in pops for x in (p.name, "%")], rows3) + [""]
    keys2 = list(dict.fromkeys(k for p in pops for k in p.dur_create))
    rows2 = [[k] + [p.dur_create[k] for p in pops] for k in keys2]
    return out + md_table(["event creates"] + [p.name for p in pops], rows2) + [""]


def linked_table(pops: list[Pop]) -> list[str]:
    keys = [g for g in ("act", "selector act", "read", "selector read") if any(p.lk.get((g, t)) for p in pops for t in ("T1", "T2+"))]
    head = ["calls"] + [x for p in pops for x in (f"{p.name}: T1 n", "T1 linked_to", "T2+ n", "T2+ linked_to")]
    rows = []
    for g in keys:
        r = [g]
        for p in pops:
            for t in ("T1", "T2+"):
                n, k = p.lk.get((g, t), [0, 0])
                r += [n, pct(k, n)]
        rows.append(r)
    return ["### `linked_to` on calls, first turn (T1) against follow-up turns (T2+)", "",
            "act = every write; selector act = a write that names its rows by a selector (has `kind`); read = answer, find and compute; selector read = those with a `kind`.", ""] \
        + md_table(head, rows) + [""]


def linked_cell_table(pops: list[Pop]) -> list[str]:
    out = []
    for p in pops:
        cells = sorted({k[0] for k in p.cell_lk})
        if not cells:
            continue
        head = ["cell", "act T1 n", "linked_to", "act T2+ n", "linked_to", "read T1 n", "linked_to", "read T2+ n", "linked_to"]
        rows = []
        for c in cells:
            r = [c]
            for g in ("act", "read"):
                for t in ("T1", "T2+"):
                    n, k = p.cell_lk.get((c, g, t), [0, 0])
                    r += [n, pct(k, n)]
            rows.append(r)
        out += [f"### `linked_to` by drill cell: {p.name}", ""] + md_table(head, rows) + [""]
    return out


def form_table(pops: list[Pop]) -> list[str]:
    forms = [f for f, _ in collections.Counter({k: sum(p.form[k] for p in pops) for p in pops for k in p.form}).most_common()]
    head = ["selector form of an act"] + [x for p in pops for x in (p.name, "%")]
    rows = []
    for f in forms:
        rows.append([f] + [x for p in pops for x in (p.form[f], pct(p.form[f], sum(p.form.values())))])
    summ = {"rows #n / @n": lambda k: k.startswith("rows"), "name (alone or with a filter)": lambda k: k.startswith("name"),
            "where without a name": lambda k: k.startswith("where"), "create": lambda k: k.startswith("create")}
    rows2 = []
    for label, fn in summ.items():
        rows2.append([label] + [x for p in pops for x in (sum(v for k, v in p.form.items() if fn(k)), pct(sum(v for k, v in p.form.items() if fn(k)), sum(p.form.values())))])
    other = lambda p: sum(v for k, v in p.form.items() if not any(f(k) for f in summ.values()))  # noqa: E731
    rows2.append(["other (when / linked_to / within / kind only)"] + [x for p in pops for x in (other(p), pct(other(p), sum(p.form.values())))])
    return ["### Selector form of an act", ""] + md_table(head, rows2) + ["", "detail:", ""] + md_table(head, rows) + [""]


def cell_table(pops: list[Pop]) -> list[str]:
    out = []
    for p in pops:
        if not p.cells:
            continue
        head = ["cell", "sessions", "pairs", "turns", "calls", "act", "answer", "compute", "find", "ask", "decline"]
        rows = []
        for name, c in sorted(p.cells.items(), key=lambda kv: -kv[1]["sessions"]):
            tot = sum(c["calls"].values())
            rows.append([name, c["sessions"], len(c["pairs"]), c["turns"], tot] + [c["calls"][t] for t in ("act", "answer", "compute", "find", "ask", "decline")])
        rows.append(["all", sum(c["sessions"] for c in p.cells.values()), sum(len(c["pairs"]) for c in p.cells.values()), sum(c["turns"] for c in p.cells.values()),
                     sum(sum(c["calls"].values()) for c in p.cells.values())] + [sum(c["calls"][t] for c in p.cells.values()) for t in ("act", "answer", "compute", "find", "ask", "decline")])
        out += [f"### Per drill cell: {p.name}", ""] + md_table(head, rows) + [""]
    return out


def render(pops: list[Pop]) -> str:
    L = ["## Populations", ""]
    L += md_table(["population", "sessions", "turns"], [[p.name, p.sessions, p.turns] for p in pops]) + [""]
    L += ["## 1. Text-field operators in `where` conditions", ""]
    L += text_field_table(pops, "ops", "act, find, answer and compute calls")
    L += text_field_table(pops, "ops_act", "act calls only (the writes)")
    L += relation_table(pops)
    L += ["## 2. The role filter of a person write", ""] + role_table(pops)
    L += ["## 3. Durations", ""] + duration_table(pops)
    L += ["## 4. `linked_to`", ""] + linked_table(pops) + linked_cell_table(pops)
    L += ["## 5. Selector form on acts", ""] + form_table(pops)
    L += ["## 6. Cells", ""] + cell_table(pops)
    return "\n".join(L)


def as_json(pops: list[Pop]) -> dict:
    return {p.name: {"sessions": p.sessions, "turns": p.turns,
                     "ops": {f"{f}|{o}": n for (f, o), n in p.ops.items()}, "ops_act": {f"{f}|{o}": n for (f, o), n in p.ops_act.items()},
                     "rel": {"|".join(k): n for k, n in p.rel.items()}, "role": {"|".join(k): n for k, n in p.role.items()},
                     "dur": dict(p.dur), "dur_read": dict(p.dur_read), "dur_create": dict(p.dur_create),
                     "cell_linked": {"|".join(k): v for k, v in p.cell_lk.items()}, "linked": {"|".join(k): v for k, v in p.lk.items()},
                     "form": dict(p.form),
                     "cells": {k: {"sessions": c["sessions"], "pairs": len(c["pairs"]), "turns": c["turns"], "calls": dict(c["calls"])} for k, c in p.cells.items()}}
            for p in pops}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("specs", nargs="+", help="[LABEL=]FILE_OR_GLOB: record files, jsonl or jsonl.gz")
    ap.add_argument("--md", help="write the tables to this file as well")
    ap.add_argument("--json", help="write the counts to this file")
    ap.add_argument("--worlds", default=str(NATIVE / "authored" / "worlds"))
    a = ap.parse_args()
    worlds = Worlds(Path(a.worlds))
    pops: list[Pop] = []
    for spec in a.specs:
        label, paths = expand(spec)
        by = {"natural": Pop(f"{label}/natural"), "drill": Pop(f"{label}/drill")}
        for rec in read_records(paths):
            by["drill" if is_drill(rec) else "natural"].add(rec, worlds)
        live = [p for p in by.values() if p.sessions]
        if len(live) == 1:
            live[0].name = label
        pops += live
    text = render(pops)
    print(text)
    if a.md:
        Path(a.md).write_text(text + "\n")
    if a.json:
        Path(a.json).write_text(json.dumps(as_json(pops), indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
