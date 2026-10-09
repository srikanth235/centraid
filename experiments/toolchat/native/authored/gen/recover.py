"""Recovery turns: a faulty call the runtime rejects, then the repair (phase 5, #1044).

    python3 authored/gen/recover.py --out DIR [--dry] [--verify] [--worlds T01,T02 | --worlds train]
                                    [--sessions-dir DIR] [--per-family 40] [--cap 80] [--seed 1044] [--jobs 4]
                                    [--exclude IDS.json]

For every error family of the runtime (`common.FAMILIES`) this inserts, in a COPY of the session sources, one
`bad(...)` step in front of a reference call that a faulty variant of it plausibly precedes: a wrong parameter name,
a field of another kind, a balance without a person, an act without rows or a selector, a verb that does not apply or
does not exist, a repeated identical call, a number written as words, a date expression the runtime cannot read, a
status value it does not know, a name put in `where`, a missing `field` for sum, a create with the kind inside args,
a row number never shown, and `undo` with nothing to undo (the 19 families of `MUTATORS` and `TURN_FAMILIES`). The next step of the turn is the unchanged reference
call, which is the repair. At most one insertion per session; each family is aimed at `--per-family` sessions (and
never over `--cap`), chosen by a seeded hash so a rerun picks the same ones. Sessions whose turns already carry a
`bad` step are not used for that turn.

  --exclude  a JSON list of session ids not to touch.
  --errors   the runtime's errors.json (`nativetools export DIR` writes it): with --verify the report also counts which
             of its families the verified insertions hit (`table_families_hit`).
  --skip-families  families not planned (default verb_not_apply: the runtime now ends such a turn in its own refusal).
  --dry      print the candidate counts per family and exit (no files written).
  --out DIR  write the copy (every `<W>.py` and `<W>_*.py` of the chosen worlds, edited) and DIR/recover.plan.json.
  --verify   run authored/build.py --gold-from-ref on the touched sessions of the copy (NATIVETOOLS and EVAL_VAULTS
             as there), keep an insertion only when the runtime answered the inserted call with its family's error and
             the session still verified, re-write the copy without the others and DIR/recover.report.json (families
             by insertions planned and verified, sessions touched, the verification rate).

The sources are never edited in place; the caller decides what the copy replaces. Idempotent: the output of a run,
used as --sessions-dir, takes the same decisions on the sessions it did not touch and skips the turns it did.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from common import AUTHORED, Edit, classify, rank, render_bad  # noqa: E402

# the fields each kind keeps (the system prompt's kinds block); what a where clause or an edit may name
KIND_FIELDS = {
    "person": {"name", "date", "role", "nickname", "met", "cadence", "starred"},
    "group": {"name", "currency"},
    "event": {"name", "date", "status", "duration", "description"},
    "task": {"name", "date", "status", "effort", "priority", "completed", "description"},
    "note": {"name", "date", "body", "pinned"},
    "document": {"name", "date", "starred"},
    "photo": {"name", "date", "starred"},
    "album": {"name"},
    "debt": {"name", "date", "amount", "direction", "status"},
    "locker item": {"name", "type", "username", "url", "notes", "starred"},
}
FIELD_SWAP = {"effort": "duration", "duration": "effort", "body": "description", "description": "body",
              "starred": "pinned", "pinned": "starred"}
STATUS_FAULT = {"open": ["pending", "todo"], "completed": ["done", "complete"], "cancelled": ["canceled", "dropped"],
                "in_progress": ["in progress", "started"], "confirmed": ["booked"], "tentative": ["maybe"],
                "settled": ["paid", "closed"], "owes_me": ["owes me"], "i_owe": ["i owe"]}
VERB_FAULT = {"complete": ["done", "finish"], "cancel": ["call_off", "drop"], "delete": ["remove", "trash"],
              "create": ["add", "new"], "reschedule": ["move", "postpone"], "edit": ["update", "change"],
              "star": ["favourite", "like"], "unstar": ["unfavourite"], "add_to": ["put_in", "link"],
              "remove_from": ["unlink", "take_out"], "restore": ["recover", "undelete"], "reopen": ["uncomplete", "reset"],
              "settle_debt": ["pay", "settle"], "log": ["record"]}
VERB_CUE = {"done": "done", "finish": "finish", "move": "move", "postpone": "postpone", "add": "add", "remove": "remove",
            "update": "update", "change": "change", "trash": "trash", "like": "like", "pay": "pay", "record": "record"}
NO_ARGS_VERBS = {"complete": "status: completed", "cancel": "status: cancelled", "reopen": "status: open"}
SELECTOR = ("kind", "name", "where", "when", "linked_to", "within", "exclude", "order", "limit", "trashed", "rows", "row")
WORDS = {"day": {0: "today", 1: "tomorrow", -1: "yesterday"}}
WEEKDAYS = ["", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
READS = ("search", "find", "compute", "open")


def kinds_of(call: dict, keys: dict) -> set[str]:
    a = call["args"]
    if a.get("kind"):
        return {k.strip() for k in a["kind"].split(",")}
    found = set()
    for k in re.findall(r"\$([A-Za-z0-9_]+)", a.get("rows", "") or a.get("row", "")):
        if k in keys:
            found.add(keys[k]["kind"])
    return found


def one_kind(call: dict, keys: dict) -> str | None:
    ks = kinds_of(call, keys)
    return next(iter(ks)) if len(ks) == 1 else None


def conds(where: str) -> list[str]:
    return [c.strip() for c in re.split(r"\s+and\s+(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", where or "") if c.strip()]


def arg_lines(args: str) -> list[tuple[str, str]]:
    return [(a.strip(), b.strip()) for a, _, b in (ln.partition(":") for ln in (args or "").split("\n")) if a.strip()]


def with_args(call: dict, **changes) -> dict:
    """A copy of the call with the given args replaced (None removes one); order of the keys is kept."""
    a = {k: v for k, v in call["args"].items() if k not in changes}
    out = {}
    for k in call["args"]:
        if k in changes:
            if changes[k] is not None:
                out[k] = changes[k]
        else:
            out[k] = call["args"][k]
    for k, v in changes.items():
        if k not in out and v is not None:
            out[k] = v
    return {"tool": call["tool"], "args": out}


def rename_arg(call: dict, old: str, new: str) -> dict:
    return {"tool": call["tool"], "args": {(new if k == old else k): v for k, v in call["args"].items()}}


def plain_date(expr: str) -> str | None:
    try:
        e = json.loads(expr)
    except (ValueError, TypeError):
        return None
    if not isinstance(e, dict) or "unit" not in e or "rel" not in e:
        return None
    if e["unit"] == "day" and e["rel"] in WORDS["day"] and len(e) == 2:
        return WORDS["day"][e["rel"]]
    if e["unit"] == "week" and isinstance(e.get("weekday"), int) and 1 <= e["weekday"] <= 7 and e["rel"] in (0, 1):
        return ("next " if e["rel"] else "") + WEEKDAYS[e["weekday"]]
    if e["unit"] in ("week", "month") and e["rel"] in (0, 1) and len(e) == 2:
        return ("next " if e["rel"] else "this ") + e["unit"]
    return None


def broken_date(expr: str) -> list[str]:
    """Readings of a date expression the runtime refuses: unit dropped, rel dropped, plain words."""
    try:
        e = json.loads(expr)
    except (ValueError, TypeError):
        return []
    if not isinstance(e, dict):
        return []
    out = []
    if "unit" in e and "date" not in e and len(e) > 1:
        out.append(json.dumps({k: v for k, v in e.items() if k != "unit"}, separators=(",", ":")))
    if "unit" in e and "rel" in e and "date" not in e and "name" not in e and len(e) == 2:
        out.append(json.dumps({"unit": e["unit"]}, separators=(",", ":")))
    p = plain_date(expr)
    if p:
        out.append(p)
    return out


# --- the mutators: each returns the faulty variants of one reference call -----------------------------------------


def m_param(call, cx):
    t, a = call["tool"], call["args"]
    out = []
    if t in ("find", "answer") and "name" in a:
        out.append(rename_arg(call, "name", "text"))
    if t == "search" and "text" in a:
        out.append(rename_arg(call, "text", "name"))
    if t == "find" and "kind" in a and "rows" not in a and "within" in a:
        out.append(rename_arg(call, "within", "rows"))
    return out


def m_args(call, cx):
    a = call["args"]
    if call["tool"] == "act" and a.get("verb") in NO_ARGS_VERBS and "args" not in a:
        return [with_args(call, args=NO_ARGS_VERBS[a["verb"]])]
    return []


def m_field(call, cx):
    a, out = call["args"], []
    kind = one_kind(call, cx["keys"])
    if kind not in KIND_FIELDS:
        return out
    valid = KIND_FIELDS[kind]
    if a.get("where"):
        cs = conds(a["where"])
        for i, c in enumerate(cs):
            m = re.match(r"(\w+)\s*(?:=|!=|<=|>=|<|>|\bcontains\b|\bin\b|\bis\b)", c)
            if m and m.group(1) in FIELD_SWAP and FIELD_SWAP[m.group(1)] not in valid:
                cs2 = cs[:i] + [FIELD_SWAP[m.group(1)] + c[len(m.group(1)):]] + cs[i + 1:]
                out.append(with_args(call, where=" and ".join(cs2)))
                break
    if call["tool"] == "act" and a.get("verb") in ("edit", "create") and a.get("args"):
        lines = arg_lines(a["args"])
        for i, (f, v) in enumerate(lines):
            if f in FIELD_SWAP and FIELD_SWAP[f] not in valid and f in valid:
                lines2 = lines[:i] + [(FIELD_SWAP[f], v)] + lines[i + 1:]
                out.append(with_args(call, args="\n".join(f"{x}: {y}" for x, y in lines2)))
                break
    return out


def m_balance(call, cx):
    a = call["args"]
    if call["tool"] not in ("answer", "compute") or a.get("op") != "balance":
        return []
    if a.get("kind") == "group" and a.get("linked_to"):
        return [with_args(call, linked_to=None)]
    if a.get("kind") in (None, "person") and (a.get("rows") or a.get("name")) and "within" not in a:
        return [{"tool": call["tool"], "args": {"op": "balance", "kind": "person"}}]
    return []


def m_rows_needed(call, cx):
    a = call["args"]
    if call["tool"] != "act" or a.get("verb") in ("create", "undo", "log", "settle_up") or not (
            a.get("rows") or a.get("kind")):
        return []
    keep = {k: v for k, v in a.items() if k not in SELECTOR}
    return [{"tool": "act", "args": keep}]


def m_verb_apply(call, cx):
    a = call["args"]
    if call["tool"] != "act":
        return []
    v, kind = a.get("verb"), one_kind(call, cx["keys"])
    if v == "complete" and kind == "task":
        return [with_args(call, verb="cancel")]
    if v == "cancel" and kind == "event":
        return [with_args(call, verb="complete")]
    if v == "edit" and kind == "note" and re.search(r"\bpinned\s*:", a.get("args", "")):
        return [{"tool": "act", "args": {k: v2 for k, v2 in with_args(call, verb="star", args=None)["args"].items()}}]
    return []


def m_verb_unknown(call, cx):
    a = call["args"]
    if call["tool"] != "act" or a.get("verb") not in VERB_FAULT:
        return []
    cands = VERB_FAULT[a["verb"]]
    msg = cx["user"].lower()
    cued = [c for c in cands if VERB_CUE.get(c, c) in msg]
    pick = (cued or cands)[0]  # the verb the message says, else the most natural synonym (not a random one)
    return [with_args(call, verb=pick)]


def number_words(field: str, n: float) -> str | None:
    if field in ("effort", "duration") and n >= 60 and n % 60 == 0:
        h = int(n // 60)
        return f"{h} hour" + ("s" if h > 1 else "")
    if field in ("effort", "duration") and n in (30, 90):
        return "half an hour" if n == 30 else "an hour and a half"
    if field == "cadence" and n >= 7 and n % 7 == 0:
        w = int(n // 7)
        return f"{w} week" + ("s" if w > 1 else "")
    if field == "priority" and n in (1, 2):
        return "high"
    if field == "priority" and n >= 6:
        return "low"
    return None


def m_number(call, cx):
    a = call["args"]
    if call["tool"] != "act" or a.get("verb") not in ("edit", "create") or not a.get("args"):
        return []
    lines = arg_lines(a["args"])
    for i, (f, v) in enumerate(lines):
        if f in ("effort", "duration", "cadence", "priority") and re.fullmatch(r"\d+", v):
            w = number_words(f, int(v))
            if w:
                lines2 = lines[:i] + [(f, w)] + lines[i + 1:]
                return [with_args(call, args="\n".join(f"{x}: {y}" for x, y in lines2))]
    return []


def m_date(call, cx):
    a, out = call["args"], []
    if a.get("when"):
        out += [with_args(call, when=b) for b in broken_date(a["when"])[:2]]
    if call["tool"] == "act" and a.get("args") and a.get("verb") in ("reschedule", "create", "edit"):
        lines = arg_lines(a["args"])
        for i, (f, v) in enumerate(lines):
            if f in ("to", "date", "due", "start") and v.startswith("{"):
                for b in broken_date(v)[:2]:
                    lines2 = lines[:i] + [(f, b)] + lines[i + 1:]
                    out.append(with_args(call, args="\n".join(f"{x}: {y}" for x, y in lines2)))
                break
    return out


def m_date_via_edit(call, cx):
    a = call["args"]
    if call["tool"] == "act" and a.get("verb") == "reschedule" and a.get("args", "").startswith("to:"):
        return [with_args(call, verb="edit", args="date:" + a["args"][3:])]
    return []


def m_create_kind(call, cx):
    a = call["args"]
    if call["tool"] == "act" and a.get("verb") == "create" and a.get("kind") and a.get("args"):
        out = with_args(call, kind=None, args=f"kind: {a['kind']}\n{a['args']}")
        return [out]
    return []


def m_unshown(call, cx):
    a = call["args"]
    if call["tool"] in ("answer", "act", "compute") and re.fullmatch(r"\$\w+", a.get("rows", "")) \
            and a.get("verb") not in ("undo",):
        return [with_args(call, rows=f"#{70 + int(rank(cx['seed'], cx['sid'], str(cx['t']), 'us'), 16) % 30}")]
    return []


def m_value(call, cx):
    a, out = call["args"], []
    where = a.get("where", "")
    m = re.search(r'\bstatus\s*(=|!=)\s*"?(\w+)"?', where)
    if m and m.group(2) in STATUS_FAULT:
        bad = STATUS_FAULT[m.group(2)][0]
        out.append(with_args(call, where=where[:m.start(2)] + bad + where[m.end(2):]
                             if '"' not in where[m.start() : m.end()] else where.replace(m.group(2), bad, 1)))
    if call["tool"] == "act" and a.get("verb") in ("edit", "create") and a.get("args"):
        lines = arg_lines(a["args"])
        for i, (f, v) in enumerate(lines):
            if f in ("status", "direction") and v in STATUS_FAULT:
                lines2 = lines[:i] + [(f, STATUS_FAULT[v][0])] + lines[i + 1:]
                out.append(with_args(call, args="\n".join(f"{x}: {y}" for x, y in lines2)))
                break
    return out


def m_opfield(call, cx):
    a = call["args"]
    if call["tool"] in ("answer", "compute") and a.get("op") in ("sum", "min", "max") and a.get("field"):
        return [with_args(call, field=None)]
    return []


def m_where_name(call, cx):
    a = call["args"]
    if call["tool"] in ("find", "answer", "act", "compute") and a.get("name") and a.get("kind") and '"' not in a["name"]:
        cond = f'name = "{a["name"]}"'
        return [with_args(call, name=None, where=cond + (" and " + a["where"] if a.get("where") else ""))]
    return []


def m_where_syntax(call, cx):
    a = call["args"]
    if a.get("where"):
        cs = conds(a["where"])
        for i, c in enumerate(cs):
            m = re.match(r"(\w+)\s*(<=|>=|<|>)\s*(\S+)$", c)
            if m and m.group(1) not in ("status",):
                words = {"<=": "under", ">=": "over", "<": "less than", ">": "more than"}
                cs2 = cs[:i] + [f"{m.group(1)} {words[m.group(2)]} {m.group(3)}"] + cs[i + 1:]
                return [with_args(call, where=" and ".join(cs2))]
    return []


def m_addslot(call, cx):
    a = call["args"]
    if call["tool"] == "act" and a.get("verb") in ("add_to", "remove_from") and a.get("args"):
        lines = arg_lines(a["args"])
        for i, (f, v) in enumerate(lines):
            m = re.fullmatch(r"\$(\w+)", v)
            if f in ("to", "from") and m and m.group(1) in cx["names"]:
                lines2 = lines[:i] + [(f, cx["names"][m.group(1)])] + lines[i + 1:]
                return [with_args(call, args="\n".join(f"{x}: {y}" for x, y in lines2))]
    return []


MUTATORS = {
    "param_not_taken": m_param, "args_not_taken": m_args, "field_wrong_kind": m_field, "balance_person": m_balance,
    "rows_needed": m_rows_needed, "verb_not_apply": m_verb_apply, "verb_unknown": m_verb_unknown,
    "number_field": m_number, "date_expr": m_date, "date_via_edit": m_date_via_edit, "create_kind": m_create_kind,
    "unshown_row": m_unshown, "bad_value": m_value, "op_needs_field": m_opfield, "where_name": m_where_name,
    "where_syntax": m_where_syntax, "add_slot": m_addslot,
}
TURN_FAMILIES = ("repeated_call", "undo_nothing")
ALL_FAMILIES = list(MUTATORS) + list(TURN_FAMILIES)


def generated(sess: dict, world_names: dict, keys: dict, seed) -> bool:
    """True when a `bad` step of the session is one of our insertions: the faulty variant of the call that follows it,
    the repeat of the call before it, or a lone undo. (A rerun then leaves the session as it is.)"""
    for ti, t in enumerate(sess["turns"]):
        ref = t["ref"]
        for j, c in enumerate(ref):
            if not c.get("bad"):
                continue
            call = {"tool": c["tool"], "args": dict(c.get("args", {}))}
            if call == {"tool": "act", "args": {"verb": "undo"}}:
                return True
            if j >= 1 and call == {"tool": ref[j - 1]["tool"], "args": dict(ref[j - 1].get("args", {}))}:
                return True
            if j + 1 < len(ref):
                nxt = {"tool": ref[j + 1]["tool"], "args": dict(ref[j + 1].get("args", {}))}
                cx = {"user": t["user"], "keys": keys, "names": world_names, "seed": seed, "sid": sess["id"], "t": ti}
                if any(call in mut(nxt, cx) for mut in MUTATORS.values()):
                    return True
                if call["tool"] == "act" and nxt["tool"] == "act" and call["args"].get("verb") in VERB_FAULT.get(
                        nxt["args"].get("verb"), ()):
                    return True
    return False


def candidates(sess: dict, world_names: dict, keys: dict, seed) -> dict[str, list[tuple[int, int, dict]]]:
    """family -> [(turn, step, faulty call)] over the session's turns that have no `bad` step yet; none for a session
    that already carries one of our insertions."""
    if generated(sess, world_names, keys, seed):
        return {}
    out: dict[str, list] = collections.defaultdict(list)
    wrote = False  # the previous turn wrote something: an undo would have something to revert
    for ti, t in enumerate(sess["turns"]):
        ref = t["ref"]
        if any(c.get("bad") for c in ref):
            wrote = any(c["tool"] == "act" for c in ref)
            continue
        base = {"user": t["user"], "keys": keys, "names": world_names, "seed": seed, "sid": sess["id"], "t": ti}
        for k, call in enumerate(ref):
            c0 = {"tool": call["tool"], "args": dict(call.get("args", {}))}
            for fam, mut in MUTATORS.items():
                for v in mut(c0, base):
                    if v != c0:
                        out[fam].append((ti, k, v))
            if k >= 1 and ref[k - 1]["tool"] in READS and not ref[k - 1].get("bad"):
                prev = {"tool": ref[k - 1]["tool"], "args": dict(ref[k - 1].get("args", {}))}
                out["repeated_call"].append((ti, k, prev))
        first = ref[0] if ref else None
        if first and first["tool"] == "decline" and first.get("args", {}).get("reason") == "never_mind" and not wrote:
            out["undo_nothing"].append((ti, 0, {"tool": "act", "args": {"verb": "undo"}}))
        wrote = any(c["tool"] == "act" and c.get("args", {}).get("verb") not in ("undo", None) for c in ref)
    return out


def world_names(w: str) -> dict:
    world = json.loads((AUTHORED / "worlds" / f"{w}.json").read_text())
    names = {}
    for section in world.values():
        if isinstance(section, list):
            for row in section:
                if isinstance(row, dict) and "key" in row and "name" in row:
                    names[row["key"]] = row["name"]
    return names


def load_keys(w: str) -> dict:
    """The keys of a train world's seeding: $EVAL_KEYS/<W>.keys.json, else authored/worlds/ (lib.keys_file)."""
    import lib

    return json.loads(lib.keys_file(w, AUTHORED / "worlds").read_text())


# Families the current runtime no longer raises as an error: a verb that does not apply to a kind ends the turn in the
# runtime's own refusal (`refused: ... declined: out_of_scope`), so there is no step to repair (0/70 verified, phase 7).
DEFAULT_SKIP = ("verb_not_apply",)


def plan(worlds: list[str], sessions_dir: Path, seed, per_family: int, cap: int,
         exclude: set[str] = frozenset(), skip: tuple[str, ...] = DEFAULT_SKIP) -> tuple[list[dict], dict, dict]:
    """The insertions: list of dicts; also the candidate counts (family -> [candidates, sessions])."""
    cands: dict[str, dict[str, list]] = collections.defaultdict(dict)  # family -> sid -> [(w, t, k, call)]
    sess_of: dict[str, tuple[str, dict]] = {}
    for w in worlds:
        sessions = common.load_sessions(w, sessions_dir)
        usable = common.usable_sites(w, sessions, sessions_dir)
        names, keys = world_names(w), load_keys(w)
        for s in sessions:
            if s["id"] in exclude:
                continue
            sess_of[s["id"]] = (w, s)
            for fam, lst in candidates(s, names, keys, seed).items():
                lst = [(t, k, c) for t, k, c in lst
                       if s["turns"][t]["_site"][0] in usable and usable[s["turns"][t]["_site"][0]][s["turns"][t]["_site"][1]] is not None]
                if lst:
                    cands[fam][s["id"]] = lst
    counts = {f: [sum(len(v) for v in cands[f].values()), len(cands[f])] for f in ALL_FAMILIES}
    used: set[str] = set()
    chosen = []
    cap = min(cap, 10**9)
    for fam in sorted((f for f in ALL_FAMILIES if f not in skip), key=lambda f: (counts[f][1], f)):
        sids = sorted(cands[fam], key=lambda sid: rank(seed, fam, sid))
        n = 0
        for sid in sids:
            if n >= min(per_family, cap):
                break
            if sid in used:
                continue
            lst = sorted(cands[fam][sid], key=lambda c: rank(seed, fam, sid, str(c[0]), str(c[1]), json.dumps(c[2], sort_keys=True)))
            t, k, call = lst[0]
            w, s = sess_of[sid]
            site = s["turns"][t]["_site"]
            chosen.append({"sid": sid, "world": w, "family": fam, "turn": t, "step": k, "call": call,
                           "file": site[0], "t_index": site[1]})
            used.add(sid)
            n += 1
    return chosen, counts, sess_of


def write_copy(src: Path, out: Path, worlds: list[str], chosen: list[dict]) -> None:
    common.apply_edits(src, out, worlds, [Edit(c["file"], c["t_index"], c["step"], render_bad(c["call"])) for c in chosen])


def verify(chosen: list[dict], worlds: list[str], out: Path, jobs: int, src: Path | None = None) -> dict[tuple[str, int, int], dict]:
    """Build the touched sessions of the copy with the runtime; per insertion: ok / the family it produced. With
    `src` (the sessions the copy was made from), a session that also fails without the insertion is marked
    `baseline` (the tree's failure, not the insertion's)."""
    bdir = out / "_build"
    by_w: dict[str, list[str]] = collections.defaultdict(list)
    for c in chosen:
        by_w[c["world"]].append(c["sid"])
    common.build_many([(w, sorted(s)) for w, s in by_w.items()], out, bdir, n_jobs=jobs)
    verdict = {}
    for w, sids in by_w.items():
        recs, rep = common.read_records(bdir, w), common.read_report(bdir, w)
        for c in chosen:
            if c["world"] != w:
                continue
            key = (c["sid"], c["turn"], c["step"])
            entry = rep.get(c["sid"])
            if not entry or not entry["pass"]:
                why = "no build entry" if not entry else common.why_dropped_text(entry)
                verdict[key] = {"ok": False, "why": why, "session_failed": True}
                continue
            turns = common.turn_steps(recs[c["sid"]])
            try:
                msg, reply = turns[c["turn"]][c["step"]]
            except IndexError:
                verdict[key] = {"ok": False, "why": "step missing in the record"}
                continue
            got = classify(reply)
            ok = msg.get("loss") is False and got == c["family"]
            verdict[key] = {"ok": ok, "got": got, "why": "" if ok else f"produced {got or 'no error'}", "reply": reply[:400]}
    if src is not None:
        failed: dict[str, list[str]] = collections.defaultdict(list)
        for c in chosen:
            v = verdict[(c["sid"], c["turn"], c["step"])]
            if v.get("session_failed"):
                failed[c["world"]].append(c["sid"])
        base = common.baseline_failures(failed, src, out, jobs)
        for c in chosen:
            if c["sid"] in base:
                verdict[(c["sid"], c["turn"], c["step"])] = {"ok": False, "baseline": True, "why": "baseline: fails without the insertion"}
    return verdict


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--worlds", default="train")
    ap.add_argument("--sessions-dir", type=Path, default=AUTHORED / "sessions")
    ap.add_argument("--per-family", type=int, default=40)
    ap.add_argument("--cap", type=int, default=80)
    ap.add_argument("--seed", default="1044")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--exclude", type=Path, help="a JSON list of session ids not to touch")
    ap.add_argument("--skip-families", default=",".join(DEFAULT_SKIP),
                    help="families not planned (default: those the runtime no longer raises as an error); '' plans all")
    ap.add_argument("--errors", type=Path, help="the runtime's errors.json: the report also counts the table's families hit")
    a = ap.parse_args()
    worlds = common.TRAIN_WORLDS if a.worlds == "train" else a.worlds.split(",")
    excl = set(json.loads(a.exclude.read_text())) if a.exclude else set()
    chosen, counts, _ = plan(worlds, a.sessions_dir, a.seed, a.per_family, a.cap, excl,
                                 tuple(x for x in a.skip_families.split(",") if x))
    print(f"{'family':18} {'candidates':>10} {'sessions':>9} {'planned':>8}")
    planned = collections.Counter(c["family"] for c in chosen)
    for f in ALL_FAMILIES:
        print(f"{f:18} {counts[f][0]:>10} {counts[f][1]:>9} {planned[f]:>8}")
    print(f"{'total':18} {sum(v[0] for v in counts.values()):>10} {'':>9} {len(chosen):>8}  ({len({c['sid'] for c in chosen})} sessions)")
    if a.dry or not a.out:
        return
    write_copy(a.sessions_dir, a.out, worlds, chosen)
    report = {"planned": dict(planned), "sessions_touched": len(chosen)}
    if a.verify:
        verdict = verify(chosen, worlds, a.out, a.jobs, a.sessions_dir)
        kept = [c for c in chosen if verdict[(c["sid"], c["turn"], c["step"])]["ok"]]
        write_copy(a.sessions_dir, a.out, worlds, kept)
        ok = collections.Counter(c["family"] for c in kept)
        bad = collections.defaultdict(collections.Counter)
        for c in chosen:
            v = verdict[(c["sid"], c["turn"], c["step"])]
            if not v["ok"]:
                bad[c["family"]][v["why"][:80]] += 1
        base_n = sum(1 for v in verdict.values() if v.get("baseline"))
        net = round(len(kept) / max(1, len(chosen) - base_n), 3)
        report.update(verified=dict(ok), verification_rate=round(len(kept) / max(1, len(chosen)), 3),
                      rate_without_baseline_failures=net, baseline_failures=base_n,
                      sessions_touched=len(kept), failures={f: dict(c) for f, c in bad.items()})
        print(f"verified {len(kept)}/{len(chosen)} ({report['verification_rate']:.1%}); {base_n} sessions fail without "
              f"the insertion too, so {net:.1%} of the others")
        for f in ALL_FAMILIES:
            print(f"  {f:18} {ok[f]:>4}/{planned[f]:<4} {dict(bad[f]) if bad[f] else ''}")
        if a.errors:
            tc = common.table_classifier(a.errors)
            hits = collections.Counter(tc(verdict[(c["sid"], c["turn"], c["step"])]["reply"]) for c in kept)
            report["table_families_hit"] = {k: v for k, v in sorted(hits.items()) if k}
            print(f"errors.json families hit by a verified insertion: {len(report['table_families_hit'])}")
        chosen = kept
    (a.out / "recover.plan.json").write_text(json.dumps(chosen, indent=1, ensure_ascii=False))
    (a.out / "recover.report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
