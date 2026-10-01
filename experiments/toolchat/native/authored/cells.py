"""The scenario-cell universe of GOALS.md §2 (tables A-G), and its rotation over worlds.

    python3 authored/cells.py                      # cell counts per table, reachable / unreachable
    python3 authored/cells.py --unreachable        # ... plus every unreachable cell and its reason
    python3 authored/cells.py --sheet 0 --of 28    # the markdown sheet of the cells world 0 owns

The universe is derived from a fresh `nativetools export` (kind_card.txt: kinds, fields, enums,
verbs; call.lark: tools, params, decline reasons, compute ops; where.lark: every where field and
its operators) plus the runtime rules in BRIEF.md "Runtime rules". A cell whose reachability is
uncertain is kept reachable: the report over-states gaps rather than hiding one.

Cells are tuples of strings; the first element is always the table letter, so a cell is
self-describing in json and markdown (`cell_str`).
"""
from __future__ import annotations

import argparse
import functools
import os
import re
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
NT = os.environ.get("NATIVETOOLS", str(NATIVE.parents[2] / "target" / "debug" / "nativetools"))

# THE DATE-SHAPE UNIVERSE: every point shape, and every span whose ends are a date, a relative
# period, a weekday or a named month (either end may be open). The runtime takes more, but these
# are the shapes people's requests map to. (date+time as a span end is observed in authored
# sessions, e.g. an event's own start..end, so it is part of the universe.)
POINTS = ["date", "date+time", "rel+unit", "rel+unit+weekday", "rel+time+unit+weekday", "rel+time+unit",
          "name+rel+unit", "anchor+rel+unit", "anchor+rel+time+unit"]
ENDS = ["date", "date+time", "rel+unit", "rel+unit+weekday", "name+rel+unit"]
SPANS = [f"from..to[{a} | {b}]" for a in ENDS + ["?"] for b in ENDS + ["?"] if (a, b) != ("?", "?")]

SELECTORS = ["named", "where", "prev", "new", "multi"]
WHERE_OPS = ["=", "!=", "<", "<=", ">", ">=", "contains", "in", "is empty", "is set"]
VALUE_FORMS = ["literal", "reldate", "enum", "unit", "linkcount"]
# the two unit forms the runtime refuses on `where` (BRIEF: "1 hour" is refused): repair cells
REFUSED_UNITS = ["refused:1 hour", "refused:2 weeks"]
# undo is judged per class of the write it undoes
VERB_CLASS = {"create": "create", "delete": "delete", "restore": "restore",
              "edit": "field", "reschedule": "field", "complete": "field", "reopen": "field",
              "cancel": "field", "star": "field", "unstar": "field",
              "add_to": "link", "remove_from": "link",
              "log": "ledger", "settle_up": "ledger", "settle_debt": "ledger", "reveal": "read"}
BEHAVIOURS = ["ambiguous", "empty result", "trashed row", "restore window", "refused delete",
              "knock-on diff", "linked_to all", "photo undo", "event overlap"]
PHRASINGS = [(m, v) for m in ("command", "question", "indirect") for v in ("verbatim", "non-verbatim")]


# --- the export -------------------------------------------------------------------------------


@functools.lru_cache(maxsize=1)
def export(path: str | None = None) -> dict:
    """Parse a `nativetools export` (a fresh one unless `path` names an existing directory)."""
    d = path or tempfile.mkdtemp(prefix="cells-export-")
    if not path:
        subprocess.run([NT, "export", d], check=True, capture_output=True)
    lark = Path(d, "call.lark").read_text()
    card = Path(d, "kind_card.txt").read_text()
    wl = Path(d, "where.lark").read_text()
    tools = {}
    for m in re.finditer(r"^(\w+)_param: (.*?)(?=^\w+:|\Z)", lark, re.M | re.S):
        tools[m.group(1)] = re.findall(r"<parameter=(\w+)>", m.group(2))
    verbs, fields, enums, dated, units = {}, {}, {}, set(), {}
    for line in card.splitlines():
        m = re.match(r"^([a-z ]+): (.*)$", line)
        if not m:
            continue
        kind, rest = m.group(1), m.group(2)
        vm = re.search(r"verbs: ([a-z_ ]+)", rest)
        verbs[kind] = vm.group(1).split() if vm else []
        head = rest.split(" · ")[0]
        fields[kind] = [f.split(" (")[0].strip() for f in re.split(r", (?![^()]*\))", head)]
        for f, u in re.findall(r"(\w+) \((days|min|[A-Z]{3})\)", head):
            units[f"{kind}.{f}"] = u
        if "date" in fields[kind]:
            dated.add(kind)
        for f, vals in re.findall(r"(\w+) \(([a-z_]+(?:\|[a-z_]+)+)\)", head):
            enums[f"{kind}.{f}"] = vals.split("|")
    # where.lark: per kind, per field, the operators and value types the grammar admits
    where = {}
    for m in re.finditer(r"^cond_(\w+): (.*?)(?=^\s*$|^where_|\Z)", wl, re.M | re.S):
        kind = m.group(1).replace("_", " ")
        per = where.setdefault(kind, {})
        for alt in re.split(r"\n\s*\|", m.group(2)):
            alt = alt.strip()
            fm = re.match(r'"([a-z_]+(?: count)?)', alt)
            if not fm:
                continue
            f = fm.group(1).strip()
            ops = per.setdefault(f, {})
            if f.endswith(" count"):
                for o in WHERE_OPS[:6]:
                    ops[o] = "linkcount"
            elif '" contains "' in alt:
                ops["contains"] = "literal"
            elif '" in ("' in alt:
                ops["in"] = "enum" if '("' in alt.split("in (", 1)[1][:4] or '"\\""' in alt else "literal"
            elif "is empty" in alt:
                ops["is empty"] = ops["is set"] = "—"
            elif " CMP " in alt:
                for o in WHERE_OPS[:6]:
                    ops[o] = "number"
            elif " EQ " in alt:
                val = "enum" if "STRING" not in alt else "literal"
                ops["="] = ops["!="] = val
    reasons = re.search(r'^reason: (.*)$', lark, re.M).group(1).replace('"', "").split(" | ")
    ops = re.search(r'^op: (.*)$', lark, re.M).group(1).replace('"', "").split(" | ")
    all_verbs = re.search(r'^verb: (.*)$', lark, re.M).group(1).replace('"', "").split(" | ")
    kinds = re.search(r'^kind: (.*)$', lark, re.M).group(1).replace('"', "").split(" | ")
    return {"tools": tools, "verbs": verbs, "fields": fields, "enums": enums, "dated": dated,
            "where": where, "units": units, "reasons": reasons, "ops": ops, "all_verbs": all_verbs, "kinds": kinds}


# --- the universe -----------------------------------------------------------------------------


def _table_a(x):
    reach, unr = [], []
    for kind in x["kinds"]:
        for verb in x["all_verbs"]:
            if verb == "undo":
                continue
            if verb not in x["verbs"].get(kind, []):
                unr.append((("A", verb, kind, "*"), f"kind_card: {kind} does not take {verb}"))
                continue
            if verb == "create":
                reach.append(("A", verb, kind, "—"))
                continue
            for sel in SELECTORS:
                cell = ("A", verb, kind, sel)
                if sel == "new" and "create" not in x["verbs"].get(kind, []):
                    unr.append((cell, f"no verb creates a {kind}, so no $new {kind} exists"))
                elif sel == "new" and verb == "restore":
                    # possible only as create -> delete -> restore in one session: odd but legal
                    reach.append(cell)
                else:
                    reach.append(cell)
    reach.append(("A", "undo", "any", "—"))
    return reach, unr


def _table_b(x):
    reach, unr = [], [(("B", "*", "*", "reldate"), "where has no date comparison; dates go in `when` (table C)")]
    for kind, per in x["where"].items():
        for f, ops in per.items():
            key = f"{kind}.{f}"
            forms_seen = set()
            for op in WHERE_OPS:
                if op not in ops:
                    unr.append((("B", key, op, "*"), f"where.lark: {f} on {kind} has no `{op}`"))
                    continue
                t = ops[op]
                if t == "—":
                    reach.append(("B", key, op, "—"))
                    continue
                if t == "number":
                    forms = ["literal", "unit"] if key in x["units"] else ["literal"]
                else:
                    forms = {"linkcount": ["linkcount"], "enum": ["enum"],
                             "literal": ["enum"] if key in x["enums"] else ["literal"]}[t]
                forms_seen |= set(forms)
                reach += [("B", key, op, vf) for vf in forms]
            for vf in VALUE_FORMS:
                if vf != "reldate" and vf not in forms_seen and forms_seen:
                    why = ("has no unit in kind_card" if vf == "unit" and "literal" in forms_seen
                           else f"takes {'/'.join(sorted(forms_seen))} values only")
                    unr.append((("B", key, "*", vf), f"{f} on {kind} {why}"))
    for r in REFUSED_UNITS:
        reach.append(("B", "*number*", "cmp", r))
    return reach, unr


def _table_c(x):
    reach, unr = [], []
    for kind in x["kinds"]:
        if kind not in x["dated"]:
            unr.append((("C", kind, "*"), f"kind_card: {kind} has no date field"))
            continue
        for shape in POINTS + SPANS:
            reach.append(("C", kind, shape))
    return reach, unr


def _table_d(x):
    reach, unr = [], []
    for o in ("rows", "value", "empty"):
        reach.append(("D", "answer", o))
    for o in ("hit", "miss", "ambiguous"):  # find ambiguous: uncertain, kept reachable
        reach.append(("D", "find", o))
    for o in ("hit", "miss"):
        reach.append(("D", "search", o))
    reach.append(("D", "open", "row"))
    for o in ("changed", "already", "refused", "ambiguous"):
        reach.append(("D", "act", o))
    for o in x["ops"]:
        reach.append(("D", "compute", o))
    for o in ("with options", "without options"):
        reach.append(("D", "ask", o))
    for r in x["reasons"]:
        reach.append(("D", "decline", r))
    for c in sorted(set(VERB_CLASS.values())):
        if c == "read":
            unr.append((("D", "undo", "after read"), "reveal changes nothing, so there is nothing to undo"))
        else:
            reach.append(("D", "undo", f"after {c}"))
    return reach, unr


def _table_e(x):
    reach, unr = [], []
    restorable = {k for k, vs in x["verbs"].items() if "restore" in vs}
    linked = {k for k, fs in x["where"].items() if any(f.endswith(" count") for f in fs)}
    rules = {
        "ambiguous": (set(x["kinds"]), ""),
        "empty result": (set(x["kinds"]), ""),
        "trashed row": (restorable, "has no trash (deleted for good, or never deleted)"),
        "restore window": (restorable, "has no restore verb"),
        "refused delete": ({"group", "folder", "person"},
                           "is never refused: the runtime refuses only group/folder deletes and person remove_from"),
        "knock-on diff": (set(x["kinds"]), ""),
        "linked_to all": (linked, "has no links"),
        "photo undo": ({"photo"}, "is not a photo: undo restoring albums is photo-only"),
        "event overlap": ({"event"}, "is not an event: only events have the non-overlap rule"),
    }
    for b in BEHAVIOURS:
        ok, why = rules[b]
        for kind in x["kinds"]:
            (reach.append(("E", b, kind)) if kind in ok else unr.append((("E", b, kind), f"{kind} {why}")))
    return reach, unr


def _table_f(_x):
    reach = [("F", "referent", r) for r in ("@prev", "pronoun", "ordinal")]
    reach += [("F", "calls/turn", n) for n in ("1", "2", "3", "4+")]
    reach += [("F", "more= continuation", "—"), ("F", "repair mid-session", "—"),
              ("F", "write then read same row", "—")]
    reach += [("F", "session length", str(n) if n < 7 else "7+") for n in range(1, 8)]
    return reach, []


def _table_g(x, a, d):
    fams = sorted({("verb×kind", f"{c[1]}×{c[2]}") for c in a} | {("tool×outcome", f"{c[1]}:{c[2]}") for c in d})
    # one cell per family key; coverage.py judges it by GOALS §2: at least two of the three moods,
    # and both verbatim and non-verbatim naming wherever the turn names a row
    return [("G", fam, key) for fam, key in fams], []


# turns of these outcomes name no row, so verbatim / non-verbatim naming does not apply
NO_NAMING = ("undo:", "decline:", "ask:", "compute:")


def g_needs_naming(key: str) -> bool:
    return not key.startswith(NO_NAMING)


@functools.lru_cache(maxsize=1)
def universe() -> dict[str, dict]:
    """{table: {"reachable": [cell...], "unreachable": [(cell, reason)...]}} for tables A-G."""
    x = export()
    out = {}
    for t, fn in (("A", _table_a), ("B", _table_b), ("C", _table_c), ("D", _table_d), ("E", _table_e),
                  ("F", _table_f)):
        r, u = fn(x)
        out[t] = {"reachable": r, "unreachable": u}
    r, u = _table_g(x, out["A"]["reachable"], out["D"]["reachable"])
    out["G"] = {"reachable": r, "unreachable": u}
    return out


# Cells found unreachable by authors after the rotation was fixed. They stay in the rotation (so
# every world's sheet is stable) but coverage reports them as unreachable, not uncovered.
CONFIRMED_UNREACHABLE = {
    ("D", "find", "ambiguous"): "only an act gets an `ambiguous:` reply; a find returns the rows",
    ("A", "edit", "notebook", "multi"): "notebook names are unique and name is its only editable "
                                        "field, so a multi-row edit is always refused",
    ("G", "tool×outcome", "find:ambiguous"): "find:ambiguous is unreachable (table D)",
    ("A", "edit", "group", "multi"): "group names are unique and name is its only editable field "
                                     "(currency cannot be edited), so a multi-row edit is refused",
}


def cell_str(c: tuple) -> str:
    return f"{c[0]}: " + " · ".join(c[1:])


# --- the rotation -----------------------------------------------------------------------------


ASSIGNED = "ABCDE"  # F (structure) and G (phrasing) are corpus-wide, not owned by a world


def assign(n_worlds: int) -> dict[tuple, list[int]]:
    """Every reachable A-E cell -> two distinct worlds, deterministic and balanced: cell j goes to
    world j % n and to a second world shifted by a rotation that changes every n cells, so each
    block of n cells gives every world exactly two cells and no two worlds are always paired."""
    if n_worlds < 2:
        raise ValueError("a cell needs two worlds")
    u = universe()
    cells = [c for t in ASSIGNED for c in u[t]["reachable"]]
    out = {}
    for j, c in enumerate(cells):
        w1 = j % n_worlds
        w2 = (w1 + 1 + (j // n_worlds) % (n_worlds - 1)) % n_worlds
        out[c] = [w1, w2]
    return out


def owned(i: int, n: int) -> list[tuple]:
    return [c for c, ws in assign(n).items() if i in ws]


TABLE_TITLE = {"A": "A. Act (verb · kind · selector)", "B": "B. Where (field · operator · value form)",
               "C": "C. Dates (kind · date shape)", "D": "D. Tool outcome (tool · outcome)",
               "E": "E. Runtime behaviour (behaviour · kind)"}


def world_sheet(i: int, n: int) -> str:
    cells = owned(i, n)
    lines = [f"# Cell sheet: world {i} of {n}", "",
             f"You own {len(cells)} cells. Each needs at least 2 uses, in different sessions. "
             "Selectors: named = the row by name or $key; where = a filter (where/when/linked_to); "
             "prev = @n from an earlier result; new = $new/$c1 created this session; multi = more "
             "than one row in one call. Value forms: unit = a number with its unit or currency; "
             "linkcount = `<kind> count`; refused:* = a bad(...) where the runtime rejects the unit, "
             "then the fixed call.", ""]
    for t in ASSIGNED:
        mine = [c for c in cells if c[0] == t]
        if not mine:
            continue
        lines += [f"## {TABLE_TITLE[t]} ({len(mine)})", ""]
        lines += [f"- {' · '.join(c[1:])}" for c in mine]
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--unreachable", action="store_true")
    ap.add_argument("--sheet", type=int)
    ap.add_argument("--of", type=int, default=28)
    a = ap.parse_args()
    if a.sheet is not None:
        print(world_sheet(a.sheet, a.of))
        return
    u = universe()
    for t, v in u.items():
        print(f"{t}: {len(v['reachable'])} reachable, {len(v['unreachable'])} unreachable")
        if a.unreachable:
            for c, why in v["unreachable"]:
                print(f"  - {cell_str(c)}: {why}")
    per = collections_counter(assign(a.of))
    print(f"assign({a.of}): cells per world min {min(per.values())} max {max(per.values())}")


def collections_counter(asg):
    per = {}
    for ws in asg.values():
        for w in ws:
            per[w] = per.get(w, 0) + 1
    return per


if __name__ == "__main__":
    main()
