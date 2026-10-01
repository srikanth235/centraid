"""The authoring vocabulary for eval sessions (sessions/*.py) and the compiler to sets/*.jsonl.

Gold is an EFFECT (SPEC §10), written in world keys:
    rows("dentist", "vet")                    answer rows (exact set; order=True when order matters)
    val(70) / val((70, "USD"), (1200, "MXN")) answer value(s); count has no unit
    diff(upd("faucet", status="completed", completed=ANY), new("task", name=has("plumber")), ...)
    ask("meera_i", "meera_s")                 the turn ends in ask; options must cover these rows
    decline("not_found")                      the decline reason (several = any of them)
Several gold arguments on one turn = every acceptable reading. `rows(..., also=diff(...))` is a
write then a read in one turn ("mark it done and tell me what's left").

`ref=[...]` is the reference call sequence: running it through the runtime and scoring it
against the gold is how every item is verified (run.py --model ref). Refs name rows as `$key`.
"""

from __future__ import annotations

import json

ANY = {"any": True}


def has(*words):
    return {"has": list(words)}


def prefix(text):
    return {"prefix": text}


def oneof(*values):
    return {"oneof": list(values)}


# --- gold effects ------------------------------------------------------------------------------


def rows(*keys, order=False, also=None):
    out = {"type": "rows", "rows": list(keys)}
    if order:
        out["order"] = True
    if also:
        out["diff"] = also["diff"]
    return out


def val(*values, also=None):
    out = {"type": "value", "values": []}
    for v in values:
        if isinstance(v, tuple):
            out["values"].append({"amount": v[0], "unit": v[1]})
        else:
            out["values"].append({"amount": v, "unit": None})
    if also:
        out["diff"] = also["diff"]
    return out


def vgroups(groups: dict):
    return {"type": "value", "groups": {k: [{"amount": v, "unit": None}] if not isinstance(v, tuple)
                                        else [{"amount": v[0], "unit": v[1]}] for k, v in groups.items()}}


def upd(key, **fields):
    return {"row": {"key": key, "change": "updated", "fields": fields}}


def trash(key):
    return {"row": {"key": key, "change": "trashed"}}


def restore(key):
    return {"row": {"key": key, "change": "restored"}}


def new(kind, **fields):
    return {"row": {"new": kind, "fields": fields}}


def gone(key):
    """A container deleted for good (notebook, album, folder, group): no trash, row removed."""
    return {"row": {"key": key, "change": "removed"}}


def link(a, b):
    return {"link": {"change": "added", "from": a, "to": b}}


def unlink(a, b):
    return {"link": {"change": "removed", "from": a, "to": b}}


def diff(*changes, already=(), reveal=(), settle=()):
    out = {"type": "diff", "diff": {"rows": [c["row"] for c in changes if "row" in c],
                                    "links": [c["link"] for c in changes if "link" in c]}}
    if already:
        out["already"] = list(already)
    if reveal:
        out["reveal"] = [{"key": k, "contains": s} for k, s in reveal]
    if settle:
        out["settle"] = [dict(zip(("name", "amount"), s)) if isinstance(s, tuple) else {"name": s} for s in settle]
    return out


def ask(*keys):
    return {"type": "ask", "candidates": list(keys)}


def decline(*reasons):
    return {"type": "decline", "reasons": list(reasons)}


# --- reference calls ---------------------------------------------------------------------------


def C(tool, **args):
    return {"tool": tool, "args": {k: v for k, v in args.items() if v is not None}}


def search(text, kind=None):
    return C("search", text=text, kind=kind)


def find(**a):
    return C("find", **a)


def ans(**a):
    return C("answer", **a)


def comp(**a):
    return C("compute", **a)


def opn(row):
    return C("open", row=row)


def act(verb, more=None, **a):
    if verb == "create" and "kind" not in a:
        # SPEC §4: create takes the kind as the top-level `kind` param and only fields in args;
        # the session files write it as the first args line, which moves up here
        head, _, rest = (a.get("args") or "").partition("\n")
        if head.startswith("kind: "):
            a = {**a, "kind": head[len("kind: "):], "args": rest}
    return C("act", verb=verb, more=more, **a)


def bad(call):
    """Training data only: marks a reference call the runtime is expected to reject (a repair
    trajectory). It stays in the history the next step sees, but carries no loss, so the model
    trains only on the call that follows and fixes it, never on the mistake itself. The `<think>`
    line before every call is derived mechanically from the call's own fields by
    authored/build.py -- never authored as prose, so no model's reasoning is put in Qwen's mouth."""
    return {**call, "bad": True}


def askc(question, options=None):
    return C("ask", question=question, options=options)


def dec(reason):
    return C("decline", reason=reason)


def lines(**fields):
    """act args as `field: value` lines; dicts (date expressions) as JSON."""
    out = []
    for k, v in fields.items():
        k = k.rstrip("_")
        if isinstance(v, dict):
            v = json.dumps(v, separators=(",", ":"))
        out.append(f"{k}: {v}")
    return "\n".join(out)


# --- date expressions --------------------------------------------------------------------------


def D(date, time=None):
    out = {"date": date}
    if time:
        out["time"] = time
    return out


def U(unit, rel, **kw):
    return {"unit": unit, "rel": rel, **kw}


def span(a, b):
    return {"from": a, "to": b}


# --- sessions ----------------------------------------------------------------------------------

_SESSIONS: list[dict] = []
_WORLD: dict = {}


def world(name, today, me, split):
    _WORLD.clear()
    _WORLD.update(world=name, today=today, me=me, split=split)


def T(user, *gold, ref, tags=()):
    assert gold, user
    return {"user": user, "gold": list(gold), "ref": ref, "tags": list(tags)}


def S(sid, tags, *turns, split=None, today=None, blocked=None):
    """`blocked` names a runtime issue (runtime_issues.md) that makes the correct effect
    unreachable today; the gold stays correct and the report counts these separately."""
    assert turns
    session = {"id": sid, "set": split or _WORLD["split"], "world": _WORLD["world"],
               "today": today or _WORLD["today"], "me": _WORLD["me"],
               "tags": tags.split() if isinstance(tags, str) else list(tags), "turns": list(turns)}
    if blocked:
        session["blocked"] = blocked
    _SESSIONS.append(session)


def X(sid, *turns):
    """Append follow-up turns to a session defined earlier (they run after its turns)."""
    for session in _SESSIONS:
        if session["id"] == sid:
            session["turns"] += list(turns)
            return
    raise KeyError(sid)


def sessions() -> list[dict]:
    return _SESSIONS
