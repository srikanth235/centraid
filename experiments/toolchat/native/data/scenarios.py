"""Scenario builders: world model + session state -> an abstract request (Req) and its slots.

A builder chooses targets from the world model so the message's words select what the scenario
intends; the policy executor (policy.py) then drives the real runtime. Builders never produce
observations.
"""
from __future__ import annotations

import random
import re

import dates as D
from meta import FIELDS, VERBS_BY_KIND
from policy import STOP, Action, Ref, Req, Target, words
from worlds import CITIES, Model, Row

KW = {  # kind words as people type them
    "task": ["task", "to-do", "task"], "event": ["event", "appointment", "meeting"], "note": ["note"],
    "document": ["document", "doc", "file"], "photo": ["photo", "picture", "pic"], "person": ["contact"],
    "locker item": ["entry", "login"], "debt": ["debt", "IOU"], "group": ["group"], "album": ["album"],
    "notebook": ["notebook"], "folder": ["folder"], "list": ["list"],
}
KWS = {"task": ["tasks", "to-dos"], "event": ["events", "appointments"], "note": ["notes"],
       "document": ["documents", "docs", "files"], "photo": ["photos", "pictures", "pics"],
       "person": ["contacts", "people"], "debt": ["debts", "IOUs"], "locker item": ["locker entries", "saved logins"],
       "group": ["groups"], "album": ["albums"], "notebook": ["notebooks"], "folder": ["folders"], "list": ["lists"]}
NUMWORD = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}


class Skip(Exception):
    """This builder cannot make a scenario in this world/state."""


class Ctx:
    def __init__(self, model: Model, st, rng: random.Random, oracle: D.Oracle, hist: list):
        self.m = model
        self.st = st
        self.rng = rng
        self.oracle = oracle
        self.hist = hist   # [(req, steps)] earlier turns of this session

    @property
    def today(self):
        return self.m.today


# ------------------------------------------------------------------ helpers
def typed(rng, s: str) -> str:
    """How a person types a name: as stored, or lower-cased."""
    return s.lower() if rng.random() < 0.45 else s


def sel_words(ctx: Ctx, row: Row, allow_full=True, trashed=False) -> tuple[str, list[str]]:
    """Words from the row's name that select exactly this row among (live|trashed) rows of its kind."""
    rng = ctx.rng
    ws = WORDS.findall(row.name)
    content = [w for w in ws if w.lower() not in STOP and not w.isdigit() or re.match(r"\d{4}$", w)]
    if row.kind == "task" and len(content) >= 2:
        content = content[1:]          # people name a task by its object, not its leading verb
    opts = []
    if content:
        for w in content:
            opts.append([w])
        for i in range(len(content) - 1):
            opts.append(content[i:i + 2])
    if allow_full:
        opts.append(ws)
    rng.shuffle(opts)
    if allow_full and rng.random() < 0.35:
        opts.insert(0, ws)
    for o in opts:
        if len(o) == 0:
            continue
        m = ctx.m.match(row.kind, [x.lower() for x in o], trashed=trashed)
        if m == [row]:
            phrase = row.name if o == ws else " ".join(o)
            phrase = typed(rng, phrase)
            return phrase, clean_words(phrase)
    raise Skip("no unique words")


WORDS = re.compile(r"[^\s()\[\],.!?\"]+")   # the units a person types (hyphen / apostrophe kept)


def clean_words(phrase: str) -> list[str]:
    return [u.strip("'-") for u in WORDS.findall(phrase) if u.strip("'-")]


def live(ctx: Ctx, kind: str, pred=None) -> list[Row]:
    rows = [r for r in ctx.m.live(kind) if r.id and r.name]
    if pred:
        rows = [r for r in rows if pred(r)]
    return rows


def choose(ctx: Ctx, rows: list):
    if not rows:
        raise Skip("no rows")
    return ctx.rng.choice(rows)


def person_ref(ctx: Ctx, row: Row) -> Ref:
    """How the person names someone: first name if unique among live people, else full name."""
    first = row.name.split(" ")[0]
    same = [r for r in ctx.m.live("person") if r.name.split(" ")[0] == first]
    if len(same) == 1 and ctx.rng.random() < 0.7:
        phrase = typed(ctx.rng, first)
    else:
        phrase = typed(ctx.rng, row.name)
    return Ref("person", phrase, clean_words(phrase), row.key)


def container_ref(ctx: Ctx, row: Row) -> Ref:
    phrase = typed(ctx.rng, row.name)
    return Ref(row.kind, phrase, clean_words(phrase), row.key)


def target_name(ctx: Ctx, row: Row, trashed=False) -> Target:
    phrase, ws = sel_words(ctx, row, trashed=trashed)
    return Target("name", phrase, ws, [row.key])


def date_hits(ctx: Ctx, kind: str, dp: D.DatePhrase, pred=None) -> list[Row]:
    lo, hi = ctx.oracle.range(dp.expr)
    out = []
    for r in live(ctx, kind, pred):
        d = r.fields.get("date")
        if d is None:
            continue
        iso = d if isinstance(d, str) else d.strftime("%Y-%m-%dT%H:%M")
        iso = iso[:16]
        if lo <= iso <= hi:
            out.append(r)
    return out


def pick_date(ctx: Ctx, kind: str, pred=None, want_hits=True, fam=None, tries=12) -> tuple[D.DatePhrase, list[Row]]:
    best = None
    for _ in range(tries):
        dp = D.read_phrase(ctx.rng, ctx.today, fam)
        hits = date_hits(ctx, kind, dp, pred)
        if (len(hits) > 0) == want_hits:
            return dp, hits
        best = (dp, hits)
    if best and not want_hits:
        return best
    raise Skip("no date with hits")


def cur_scale(ctx: Ctx) -> int:
    return {"JPY": 150, "KRW": 1300, "INR": 80, "NGN": 1500}.get(getattr(ctx.m, "currency", "USD"), 1)


def money(ctx: Ctx, amt: float, cur: str | None = None) -> str:
    cur = cur or getattr(ctx.m, "currency", "USD")
    sym = {"USD": "$", "EUR": "€", "GBP": "£", "INR": "₹", "JPY": "¥"}.get(cur)
    a = f"{amt:g}" if amt != int(amt) else str(int(amt))
    r = ctx.rng.random()
    if sym and r < 0.5:
        return f"{sym}{a}"
    if cur == "USD" and r < 0.75:
        return f"{a} dollars" if r < 0.65 else f"{a} bucks"
    return f"{a} {cur}"


# ------------------------------------------------------------------ THING: kind noun + conditions
def thing(ctx: Ctx, kind: str, ncond: int, allow_date=True, force: str | None = None) -> tuple[str, dict, list[str], set]:
    rng = ctx.rng
    noun = rng.choice(KWS[kind])
    pre, post, where, notes, named, tags = [], [], [], [], [], set()
    act: dict = {"kind": kind}
    opts = cond_options(ctx, kind, allow_date)
    rng.shuffle(opts)
    if force:
        opts.sort(key=lambda o: o[0] != force)     # the forced condition first
        if not opts or opts[0][0] != force:
            raise Skip("no such condition")
    used = set()
    for name, fn in opts:
        if len(used) >= ncond:
            break
        if name in used:
            continue
        try:
            r = fn()
        except Skip:
            continue
        used.add(name)
        tags.add(f"{kind}.{name}")
        if r.get("pre"):
            pre.append(r["pre"])
        if r.get("post"):
            post.append(r["post"])
        if r.get("where"):
            where.append(r["where"])
            if r.get("note"):
                notes.append(r["note"])
        if r.get("when"):
            act["when"] = r["when"]
        if r.get("ref"):
            act.setdefault("refs", {})["linked_to"] = r["ref"]
            named.append(r["ref"].phrase)
    if not used or (force and force not in used):
        raise Skip("no conditions")
    phrase = " ".join(pre + [noun] + post)
    if where:
        act["where"] = " and ".join(where)
        act["where_note"] = "; ".join(notes) if notes else None
    return phrase, act, named, tags


def cond_options(ctx: Ctx, kind: str, allow_date=True):
    rng, m = ctx.rng, ctx.m
    o = []

    def date_cond(prefix: str):
        def f():
            dp, _ = pick_date(ctx, kind, want_hits=rng.random() < 0.75)     # honest empties are answers too
            pre = "" if prefix.strip() in ("from", "created", "added") and re.match(r"(since|from|between|on|up to) ", dp.text) else prefix
            return {"post": f"{pre}{dp.text}".strip(), "when": dp}
        return f

    if kind == "task":
        def status():
            st, words_ = rng.choice([("open", ["open", "unfinished", "pending", "outstanding"]),
                                     ("completed", ["completed", "finished", "done"]),
                                     ("in_progress", ["in-progress", "started"]),
                                     ("cancelled", ["cancelled"])])
            w = rng.choice(words_)
            if w == "done":
                return {"post": "that are done", "where": f"status = {st}", "note": f'"done" = {st}'}
            return {"pre": w, "where": f"status = {st}", "note": f'"{w}" = {st}'}
        o.append(("status", status))
        if allow_date:
            o.append(("when", date_cond("due ")))
        # priority: 1 highest .. 9 lowest, 0 none (kind card)
        o.append(("priority", lambda: (lambda n: rng.choice([
            {"post": f"with priority {n} or higher", "where": f"priority >= 1 and priority <= {n}",
             "note": f'"priority {n} or higher" = 1..{n}; 1 is highest'},
            {"pre": "high-priority", "post": "", "where": "priority >= 1 and priority <= 3",
             "note": '"high-priority" = 1..3; 1 is highest'},
            {"post": "with no priority set", "where": "priority = 0", "note": "0 = none"}]))(rng.randint(2, 5))))
        o.append(("effort", lambda: (lambda n: {"post": f"that take less than {n} minutes", "where": f"effort < {n}"})(rng.choice([15, 20, 30, 45, 60]))))

        def tdesc():
            row = choose(ctx, [r for r in live(ctx, "task") if r.fields.get("description")])
            w = choose(ctx, [x for x in re.findall(r"[a-z]+", row.fields["description"]) if len(x) > 3])
            return {"post": f'with "{w}" in the description', "where": f'description contains "{w}"'}
        o.append(("description", tdesc))

        def on_list():
            row = choose(ctx, live(ctx, "list"))
            ref = container_ref(ctx, row)
            return {"post": f"on my {ref.phrase} list", "ref": ref}
        o.append(("list", on_list))
    elif kind == "event":
        if allow_date:
            o.append(("when", date_cond("")))
        o.append(("status", lambda: {"pre": "cancelled", "where": "status = cancelled"}))

        def edesc():
            row = choose(ctx, [r for r in live(ctx, "event") if r.fields.get("description")])
            w = choose(ctx, [x for x in re.findall(r"[a-z]+", row.fields["description"]) if len(x) > 3])
            return {"post": f'whose notes mention "{w}"', "where": f'description contains "{w}"'}
        o.append(("description", edesc))
        o.append(("duration", lambda: (lambda n: {"post": f"longer than {n} minutes", "where": f"duration > {n}"})(rng.choice([30, 45, 60, 90]))))

        def with_p():
            row = choose(ctx, [r for r in live(ctx, "person") if any(e.kind == "event" and not e.trashed and r.key in e.links for e in m.rows.values())] or live(ctx, "person"))
            ref = person_ref(ctx, row)
            return {"post": f"with {ref.phrase}", "ref": ref}
        o.append(("person", with_p))
    elif kind == "note":
        o.append(("pinned", lambda: {"pre": "pinned", "where": "pinned = yes"}))
        if allow_date:
            o.append(("when", date_cond(rng.choice(["from ", "written ", "created "]))))

        def in_nb():
            row = choose(ctx, live(ctx, "notebook"))
            ref = container_ref(ctx, row)
            return {"post": f"in {ref.phrase}", "ref": ref}
        o.append(("notebook", in_nb))

        def body():
            row = choose(ctx, [r for r in live(ctx, "note") if r.fields.get("body")])
            w = choose(ctx, [x for x in re.findall(r"[a-z]+", row.fields["body"]) if len(x) > 3])
            return {"post": f'that mention "{w}"', "where": f'body contains "{w}"'}
        o.append(("body", body))
    elif kind == "document":
        o.append(("starred", lambda: {"pre": rng.choice(["starred", "favourite"]), "where": "starred = yes"}))
        if allow_date:
            o.append(("when", date_cond(rng.choice(["added ", "from "]))))

        def in_f():
            row = choose(ctx, live(ctx, "folder"))
            ref = container_ref(ctx, row)
            return {"post": f"in the {ref.phrase} folder", "ref": ref}
        o.append(("folder", in_f))
    elif kind == "photo":
        o.append(("starred", lambda: {"pre": rng.choice(["starred", "favourite"]), "where": "starred = yes"}))
        if allow_date:
            o.append(("when", date_cond(rng.choice(["from ", "taken "]))))

        def of_p():
            row = choose(ctx, [r for r in live(ctx, "person") if any(p.kind == "photo" and not p.trashed and r.key in p.links for p in m.rows.values())])
            ref = person_ref(ctx, row)
            return {"post": f"of {ref.phrase}", "ref": ref}
        o.append(("person", of_p))

        def in_a():
            row = choose(ctx, live(ctx, "album"))
            ref = container_ref(ctx, row)
            return {"post": f"in the {ref.phrase} album", "ref": ref}
        o.append(("album", in_a))
    elif kind == "person":
        o.append(("starred", lambda: {"pre": "starred", "where": "starred = yes"}))

        def role():
            row = choose(ctx, [r for r in live(ctx, "person") if r.fields.get("role")])
            return {"post": f"who are my {row.fields['role']}s" if rng.random() < 0.5 else f"with role {row.fields['role']}",
                    "where": f'role = "{row.fields["role"]}"'}
        o.append(("role", role))
        if allow_date:
            o.append(("when", date_cond("I last contacted ")))

        def in_g():
            row = choose(ctx, live(ctx, "group"))
            ref = container_ref(ctx, row)
            return {"post": f"in {ref.phrase}", "ref": ref}
        o.append(("group", in_g))

        def nick():
            row = choose(ctx, [r for r in live(ctx, "person") if r.fields.get("nickname")])
            nk = row.fields["nickname"]
            return rng.choice([{"post": f'who go by "{nk}"', "where": f'nickname = "{nk}"'},
                               {"post": "with a nickname", "where": "nickname is set"}])
        o.append(("nickname", nick))

        def met():
            row = choose(ctx, [r for r in live(ctx, "person") if r.fields.get("met")])
            w = choose(ctx, [x for x in re.findall(r"[A-Za-z0-9]+", row.fields["met"]) if x.lower() not in STOP and len(x) > 2])
            return {"post": f'I met through "{w}"' if rng.random() < 0.5 else f'whose where-we-met mentions "{w}"',
                    "where": f'met contains "{w}"'}
        o.append(("met", met))

        def cadence():
            n = rng.choice([7, 14, 21, 30, 60])
            return rng.choice([{"post": f"I check in with at least every {n} days", "where": f"cadence <= {n}",
                                "note": "cadence = days between check-ins"},
                               {"post": "with a check-in cadence set", "where": "cadence is set"}])
        o.append(("cadence", cadence))
    elif kind == "debt":
        o.append(("direction", lambda: rng.choice([{"post": "owed to me", "where": "direction = owes_me"},
                                                   {"post": "I owe", "where": "direction = i_owe"}])))
        o.append(("status", lambda: rng.choice([{"pre": rng.choice(["unpaid", "open"]), "where": "status = open"},
                                                {"pre": "settled", "where": "status = settled"}])))
        o.append(("amount", lambda: (lambda n: {"post": f"over {money(ctx, n)}", "where": f"amount > {n}"})(
            rng.choice([10, 20, 25, 50, 100]) * cur_scale(ctx))))
        if allow_date:
            o.append(("when", date_cond("from ")))

        def with_p():
            row = choose(ctx, [r for r in live(ctx, "person") if any(d.kind == "debt" and r.key in d.links for d in m.rows.values())])
            ref = person_ref(ctx, row)
            return {"post": f"with {ref.phrase}", "ref": ref}
        o.append(("person", with_p))
    elif kind == "locker item":
        def typ():
            row = choose(ctx, live(ctx, "locker item"))
            t = row.fields.get("type", "login")
            label = {"wifi": "wifi entries", "login": "logins", "card": "cards", "password": "passwords"}.get(t, f"{t.replace('_', ' ')} entries")
            return {"post": f"that are {label}", "where": f"type = {t}"}
        o.append(("type", typ))
        o.append(("starred", lambda: {"pre": "starred", "where": "starred = yes"}))

        def user():
            row = choose(ctx, [r for r in live(ctx, "locker item") if r.fields.get("username")])
            return {"post": f'with username "{row.fields["username"]}"', "where": f'username = "{row.fields["username"]}"'}
        o.append(("username", user))

        def url():
            row = choose(ctx, [r for r in live(ctx, "locker item") if r.fields.get("url")])
            host = re.sub(r"^https?://", "", row.fields["url"]).split(".")[0]
            return {"post": f'for a site with "{host}" in the address', "where": f'url contains "{host}"'}
        o.append(("url", url))

        def lnotes():
            row = choose(ctx, [r for r in live(ctx, "locker item") if r.fields.get("notes") and r.fields.get("type") != "note"])
            w = choose(ctx, [x for x in re.findall(r"[a-z]+", row.fields["notes"]) if len(x) > 3])
            return {"post": f'whose notes mention "{w}"', "where": f'notes contains "{w}"'}
        o.append(("notes", lnotes))
    elif kind == "list":
        def area():
            row = choose(ctx, [r for r in live(ctx, "list") if r.fields.get("area")])
            return {"post": f'in the {row.fields["area"]} area', "where": f'area = "{row.fields["area"]}"'}
        o.append(("area", area))
    elif kind == "group":
        def cur():
            row = choose(ctx, live(ctx, "group"))
            c = row.fields.get("currency", "USD")
            return {"post": f"in {c}", "where": f'currency = "{c}"'}
        o.append(("currency", cur))
    return o


def action_from(act: dict, tool="answer", **kw) -> Action:
    a = Action(tool=tool, kind=act["kind"], where=act.get("where"), where_note=act.get("where_note"),
               when=act.get("when"), refs=dict(act.get("refs", {})))
    for k, v in kw.items():
        setattr(a, k, v)
    return a


# ------------------------------------------------------------------ builders
BUILDERS: dict = {}


def builder(name: str, weight: float, pattern: str = "first"):
    def deco(fn):
        BUILDERS[name] = (fn, weight, pattern)
        return fn
    return deco


def req(fam: str, intent: str, actions=None, slots=None, named=None, **kw) -> Req:
    return Req(family=fam, intent=intent, reading="", actions=actions or [], slots=slots or {}, named=named or [], **kw)


NAMED_KINDS = ["task", "event", "note", "document", "photo", "person", "locker item", "debt", "group"]


@builder("rows.name", 6)
def b_rows_name(ctx: Ctx) -> Req:
    kind = ctx.rng.choice(NAMED_KINDS)
    row = choose(ctx, live(ctx, kind))
    if kind == "person":
        ref = person_ref(ctx, row)
        if len(ctx.m.match("person", [w.lower() for w in ref.words])) != 1:
            raise Skip("person words")
        tgt = Target("name", ref.phrase, ref.words, [row.key])
    else:
        tgt = target_name(ctx, row)
    fid = "rows.name." + ("locker" if kind == "locker item" else kind)
    return req(fid, "rows", [Action("answer", kind, tgt)], {"NAME": tgt.phrase}, [tgt.phrase], tags={f"rows.name.{kind}"})


@builder("rows.frame", 10)
def b_rows_frame(ctx: Ctx) -> Req:
    kind = ctx.rng.choice(["task", "task", "event", "event", "note", "document", "photo", "person", "debt", "locker item", "group"])
    phrase, act, named, tags = thing(ctx, kind, ctx.rng.choice([1, 1, 2]))
    fid = ctx.rng.choice(["rows.frame.show", "rows.frame.show", "rows.frame.any"])
    return req(fid, "rows", [action_from(act)], {"THING": phrase}, named, tags=tags)


@builder("rows.when", 7)
def b_rows_when(ctx: Ctx) -> Req:
    kind = ctx.rng.choice(["event", "event", "task", "task", "photo", "note", "document", "person"])
    dp, hits = pick_date(ctx, kind, want_hits=ctx.rng.random() < 0.8)
    fid = f"rows.when.{kind}"
    tags = {f"{kind}.when", "date." + dp.family}
    if kind == "event" and ctx.rng.random() < 0.4:
        fid = "rows.when.diary"
        tags.add("convention.diary")
    return req(fid, "rows", [Action("answer", kind, when=dp)], {"DATE": dp.text}, [], tags=tags)


@builder("rows.linked", 7)
def b_rows_linked(ctx: Ctx) -> Req:
    m, rng = ctx.m, ctx.rng
    choice = rng.choice(["photo_person", "members", "notebook", "folder", "list", "album", "event_person", "task_person",
                         "debt_person", "groups_of"])
    if choice in ("photo_person", "event_person", "task_person", "debt_person", "groups_of"):
        kind = {"photo_person": "photo", "event_person": "event", "task_person": "task", "debt_person": "debt",
                "groups_of": "group"}[choice]
        if kind == "group":
            cands = [r for r in live(ctx, "person") if r.containers]
        else:
            cands = [r for r in live(ctx, "person") if any(x.kind == kind and not x.trashed and r.key in x.links for x in m.rows.values())]
        row = choose(ctx, cands)
        ref = person_ref(ctx, row)
        return req(f"rows.linked.{choice}", "rows", [Action("answer", kind, refs={"linked_to": ref})],
                   {"PERSON": ref.phrase}, [ref.phrase], tags={f"{kind}.linked_person"})
    ckind, kind, slot = {"members": ("group", "person", "GROUP"), "notebook": ("notebook", "note", "NOTEBOOK"),
                         "folder": ("folder", "document", "FOLDER"), "list": ("list", "task", "LIST"),
                         "album": ("album", "photo", "ALBUM")}[choice]
    row = choose(ctx, live(ctx, ckind))
    ref = container_ref(ctx, row)
    return req(f"rows.linked.{choice}", "rows", [Action("answer", kind, refs={"linked_to": ref})],
               {slot: ref.phrase}, [ref.phrase], tags={f"{kind}.linked_{ckind}"})


ORDER_OPTS = [
    ("photo", "date desc", ["latest {n} photos", "most recent {n} photos"], {}),
    ("note", "date desc", ["my {n} newest notes", "last {n} notes I wrote"], {}),
    ("task", "priority asc", ["my top {n} tasks by priority", "{n} highest-priority tasks"],
     {"where": "priority >= 1", "where_note": "0 = no priority"}),
    ("debt", "amount desc", ["the {n} biggest debts", "{n} largest IOUs"], {}),
    ("document", "date asc", ["my {n} oldest documents", "first {n} docs I added"], {}),
    ("event", "duration desc", ["my {n} longest events", "{n} longest appointments"], {}),
    ("task", "effort asc", ["the {n} quickest tasks", "{n} tasks with the least effort"], {}),
    # the rest cover every orderable field (coverage pass)
    ("event", "date asc", ["my next {n} events", "the next {n} things in my calendar"], {"when": "from_now"}),
    ("task", "date asc", ["the next {n} tasks due", "my {n} most pressing deadlines"],
     {"when": "from_now", "where": "status = open", "where_note": "still open"}),
    ("task", "completed desc", ["the {n} tasks I finished most recently", "my last {n} completed to-dos"],
     {"where": "completed is set", "where_note": "finished ones only"}),
    ("debt", "date desc", ["my {n} most recent debts", "the latest {n} IOUs"], {}),
    ("person", "date desc", ["the {n} people I spoke to most recently", "{n} contacts I was last in touch with"],
     {"when": "until_now"}),
    ("person", "cadence asc", ["the {n} people I check in with most often", "{n} contacts with the shortest check-in cadence"],
     {"where": "cadence is set", "where_note": "cadence = days between check-ins"}),
]


@builder("rows.order", 3)
def b_rows_order(ctx: Ctx, only: str | None = None) -> Req:
    rng = ctx.rng
    opts = [o for o in ORDER_OPTS if not only or f"{o[0]}.{o[1].split()[0]}" == only]
    kind, order, phr, extra = rng.choice(opts)
    n = rng.randint(1, 5)
    if len(live(ctx, kind)) < n + 1:
        raise Skip("few rows")
    p = rng.choice(phr).format(n=NUMWORD[n] if rng.random() < 0.5 else n)
    if n == 1:
        for a, b in (("1 ", ""), ("one ", ""), ("photos", "photo"), ("notes", "note"), ("tasks", "task"), ("debts", "debt"),
                     ("documents", "document"), ("docs", "doc"), ("events", "event"), ("appointments", "appointment"),
                     ("IOUs", "IOU"), ("to-dos", "to-do"), ("deadlines", "deadline"), ("people", "person"),
                     ("contacts", "contact"), ("things", "thing")):
            p = p.replace(a, b)
    f, d = order.split()
    a = Action("answer", kind, order=order, limit=n, lines=[f'order: "{p}" → {f} {d}, limit {n}'])
    if extra.get("where"):
        a.where, a.where_note = extra["where"], extra.get("where_note")
    if extra.get("when") == "from_now":
        a.when = D.DatePhrase(p, {"from": {"unit": "day", "rel": 0}}, "open", "open span", "upcoming only")
    elif extra.get("when") == "until_now":
        a.when = D.DatePhrase(p, {"to": {"unit": "day", "rel": 0}}, "open", "open span", "only people with a last contact")
    return req("rows.order", "rows", [a], {"THING": p}, [], tags={f"{kind}.order.{f}"})


@builder("rows.multi", 2)
def b_rows_multi(ctx: Ctx) -> Req:
    firsts = {}
    for r in live(ctx, "task") + live(ctx, "event"):
        for w in WORDS.findall(r.name):
            if w[0].isupper() and w.lower() not in STOP and len(w) > 2:
                firsts.setdefault(w, set()).add(r.kind)
    both = [w for w, ks in firsts.items() if ks == {"task", "event"}]
    w = choose(ctx, both)
    phrase = typed(ctx.rng, w)
    return req("rows.multi", "rows", [Action("answer", "task,event", Target("name", phrase, [phrase], []))],
               {"NAME": phrase}, [phrase], tags={"multi_kind"})


@builder("rows.trashed", 4)
def b_rows_trashed(ctx: Ctx) -> Req:
    kind = ctx.rng.choice(["task", "note", "document", "photo", "person", "event", "locker item"])
    tr = [r for r in ctx.m.trashed(kind) if r.id]
    if tr and ctx.rng.random() < 0.6:
        row = choose(ctx, tr)
        tgt = target_name(ctx, row, trashed=True)
        kw = ctx.rng.choice(KW[kind])
        return req("rows.trashed.is", "rows", [Action("answer", kind, tgt, trashed=True)], {"NAME": tgt.phrase, "KW": kw},
                   [tgt.phrase], tags={"read_like_write", "trashed"})
    return req("rows.trashed.list", "rows", [Action("answer", kind, trashed=True)], {"KWS": ctx.rng.choice(KWS[kind])},
               [], tags={"trashed"})


@builder("rows.open", 2)
def b_open(ctx: Ctx) -> Req:
    kind = ctx.rng.choice(["person", "person", "task", "event", "document", "note", "group"])
    row, tgt = write_target(ctx, kind, lambda r: r.key != "me")
    return req("rows.open", "rows", [Action("open", kind, tgt)], {"NAME": tgt.phrase, "KW": ctx.rng.choice(KW[kind])},
               [tgt.phrase], tags={f"open.{kind}"})


@builder("rows.wifi", 1.5)
def b_wifi(ctx: Ctx) -> Req:
    rows = [r for r in live(ctx, "locker item") if "wifi" in words(r.name)]
    if len(rows) != 1:
        raise Skip("wifi")
    return req("rows.wifi", "rows", [Action("answer", "locker item", Target("name", "wifi", ["wifi"], [rows[0].key]))],
               {}, ["wifi"], tags={"convention.wifi"})


@builder("value.count", 5)
def b_count(ctx: Ctx) -> Req:
    kind = ctx.rng.choice(["task", "task", "event", "note", "document", "photo", "person", "debt", "locker item"])
    phrase, act, named, tags = thing(ctx, kind, ctx.rng.choice([1, 1, 2]))
    a = action_from(act, op="count")
    return req("value.count", "value", [a], {"THING": phrase}, named, tags=tags | {"op.count"})


@builder("value.sum", 3)
def b_sum(ctx: Ctx) -> Req:
    if not live(ctx, "debt"):
        raise Skip("no debts")
    c = ctx.rng.random()
    if c < 0.4:
        a = Action("answer", "debt", where="direction = owes_me and status = open", op="sum", field_="amount")
        return req("value.sum.owed_me", "value", [a], {}, [], tags={"op.sum"})
    if c < 0.75:
        a = Action("answer", "debt", where="direction = i_owe and status = open", op="sum", field_="amount")
        return req("value.sum.i_owe", "value", [a], {}, [], tags={"op.sum"})
    dp, _ = pick_date(ctx, "debt")
    a = Action("answer", "debt", when=dp, op="sum", field_="amount")
    return req("value.sum.debts_when", "value", [a], {"DATE": dp.text}, [], tags={"op.sum", "date." + dp.family})


@builder("value.minmax", 2)
def b_minmax(ctx: Ctx) -> Req:
    c = ctx.rng.choice(["max.debt", "max.duration", "min.effort"])
    if c == "max.debt":
        if not live(ctx, "debt", lambda r: r.fields.get("direction") == "owes_me"):
            raise Skip("debts")
        a = Action("answer", "debt", where="direction = owes_me and status = open", op="max", field_="amount")
        return req("value.max.debt", "value", [a], {}, [], tags={"op.max"})
    if c == "max.duration":
        dp, _ = pick_date(ctx, "event")
        a = Action("answer", "event", when=dp, op="max", field_="duration")
        return req("value.max.duration", "value", [a], {"DATE": dp.text}, [], tags={"op.max", "date." + dp.family})
    if not live(ctx, "task", lambda r: r.fields.get("effort") and r.fields.get("status") == "open"):
        raise Skip("effort")
    a = Action("answer", "task", where="status = open", op="min", field_="effort")
    return req("value.min.effort", "value", [a], {}, [], tags={"op.min"})


@builder("value.balance", 3)
def b_balance(ctx: Ctx) -> Req:
    m = ctx.m
    if ctx.rng.random() < 0.55:
        cands = [r for r in live(ctx, "person") if r.containers or any(d.kind == "debt" and r.key in d.links for d in m.rows.values())]
        row = choose(ctx, cands)
        ref = person_ref(ctx, row)
        tgt = Target("name", ref.phrase, ref.words, [row.key])
        a = Action("answer", "person", tgt, op="balance")
        return req("value.balance.person", "value", [a], {"PERSON": ref.phrase}, [ref.phrase], tags={"op.balance.person"})
    g = choose(ctx, [r for r in live(ctx, "group") if r.links])
    p = ctx.m.rows[ctx.rng.choice(sorted(g.links))]
    if p.trashed:
        raise Skip("trashed member")
    gt = target_name(ctx, g)
    pref = person_ref(ctx, p)
    a = Action("answer", "group", gt, refs={"linked_to": pref}, op="balance")
    return req("value.balance.group", "value", [a], {"PERSON": pref.phrase, "GROUP": gt.phrase}, [pref.phrase, gt.phrase],
               tags={"op.balance.group"})


@builder("group.count", 2)
def b_group_count(ctx: Ctx) -> Req:
    kind, fld, fw = ctx.rng.choice([("task", "status", "status"), ("locker item", "type", "type"),
                                    ("debt", "direction", "direction"), ("event", "status", "status"),
                                    ("debt", "status", "status")])
    if not live(ctx, kind):
        raise Skip("rows")
    a = Action("compute", kind, op="count", group=fld)
    return req("group.count", "group", [a], {"KWS": ctx.rng.choice(KWS[kind]), "FIELD": fw}, [], tags={f"group.{kind}.{fld}"})


# ---- writes
NEW_TASKS = ["buy printer paper", "call the bank", "renew the car tax", "book a table at Nando's", "send the invoice",
             "fix the leaking tap", "order new glasses", "back up the laptop", "pay the water bill", "email the landlord",
             "pick up the dry cleaning", "return the library book", "sign the permission slip", "water the tomatoes",
             "update my CV", "buy a birthday card", "cancel the old phone plan", "clean the gutters", "get the bike serviced"]
NEW_EVENTS = ["Dentist checkup", "Lunch with Omar", "Parents evening", "Yoga", "Car MOT", "Team retro",
              "Haircut", "Piano lesson", "Coffee with Lena", "Doctor", "Viewing at the flat", "Kids' football",
              "Call with the accountant", "Date night", "Visa appointment", "Wine tasting", "Sprint planning"]
NEW_NOTES = [("Gift ideas", "a scarf for mum"), ("Garage code", "ask the landlord"), ("Book list", "Piranesi, Kindred"),
             ("Meeting notes", "budget is approved"), ("Packing", "adapters and sunscreen"), ("Soup recipe", "leeks, potato, stock"),
             ("Dream", "flying over the harbour"), ("Quotes", "be kind, be curious"), ("Car", "tyres at 32 psi")]
NEW_PEOPLE = ["Ines Duarte", "Kwame Mensah", "Priya Nair", "Tomás Ruiz", "Aiko Mori", "Farah Siddiqui", "Lukas Brandt",
              "Mei Lin", "Olu Adeyemi", "Sven Olsen", "Rosa Marín", "Dev Malhotra", "Hana Kim", "Yosef Levi"]


@builder("create", 8)
def b_create(ctx: Ctx) -> Req:
    rng = ctx.rng
    c = rng.choice(["task", "task_date", "task_effort", "event", "event", "event_dur", "note", "person", "person_role",
                    "debt", "locker", "group", "container", "document"])
    if c.startswith("task"):
        nm = rng.choice(NEW_TASKS)
        args = [("kind", "task"), ("name", nm)]
        slots = {"NEWNAME": nm}
        if c == "task_date":
            dp = D.instant_phrase(rng, ctx.today, rng.choice(["day_only", "weekday_only", "day_time", "date_nth"]))
            args.append(("date", dp))
            slots["DATE"] = dp.text
        if c == "task_effort":
            mn = rng.choice([10, 15, 20, 30, 45, 60, 90])
            args.append(("effort", str(mn)))
            slots["MIN"] = str(mn)
        return req(f"create.{c}", "write", [Action("act", None, verb="create", args=args)], slots, [nm], tags={"create.task"})
    if c.startswith("event"):
        nm = rng.choice(NEW_EVENTS)
        dp = D.instant_phrase(rng, ctx.today, rng.choice(["day_time", "weekday_time", "next_wd_time", "date_md_time"]))
        args = [("kind", "event"), ("name", nm), ("date", dp)]
        slots = {"NEWNAME": nm, "DATE": dp.text}
        if c == "event_dur":
            mn = rng.choice([30, 45, 90, 120])
            args.append(("duration", str(mn)))
            slots["MIN"] = str(mn)
        return req(f"create.{c}", "write", [Action("act", None, verb="create", args=args)], slots, [nm],
                   tags={"create.event", "date." + dp.family})
    if c == "note":
        nm, body = rng.choice(NEW_NOTES)
        return req("create.note", "write", [Action("act", None, verb="create", args=[("kind", "note"), ("name", nm), ("body", body)])],
                   {"NEWNAME": nm, "BODY": body}, [nm], tags={"create.note"})
    if c.startswith("person"):
        nm = rng.choice(NEW_PEOPLE)
        if ctx.m.match("person", words(nm)):
            raise Skip("exists")
        args = [("kind", "person"), ("name", nm)]
        slots = {"NEWNAME": nm}
        if c == "person_role":
            role = rng.choice(["plumber", "accountant", "yoga teacher", "landlord", "neighbour", "vet"])
            args.append(("role", role))
            slots["ROLE"] = role
        return req(f"create.{c}", "write", [Action("act", None, verb="create", args=args)], slots, [nm], tags={"create.person"})
    if c == "debt":
        p = choose(ctx, live(ctx, "person", lambda r: r.key != "me"))
        ref = person_ref(ctx, p)
        amt = rng.choice([7, 12, 15, 18.5, 20, 25, 40, 60, 85])
        if cur_scale(ctx) > 1:
            amt = int(amt * cur_scale(ctx))
        reason = rng.choice(["pizza", "cinema tickets", "the cab", "groceries", "concert", "brunch", "a book"])
        direction = rng.choice(["owes_me", "i_owe"])
        args = [("kind", "debt"), ("name", reason), ("amount", f"{amt:g}"), ("direction", direction), ("person", ref)]
        return req(f"create.debt_{direction}", "write", [Action("act", None, verb="create", args=args, refs={"person": ref})],
                   {"PERSON": ref.phrase, "AMOUNT": money(ctx, amt), "REASON": reason}, [ref.phrase], tags={"create.debt"})
    if c == "locker":
        nm, typ = rng.choice([("Gym locker", "password"), ("Office wifi", "wifi"), ("Disney+", "login"), ("Mastercard", "card"),
                              ("Garage code", "password"), ("GitHub token", "api_credential"), ("NHS number", "identity")])
        if ctx.m.match("locker item", words(nm)):
            raise Skip("exists")
        tw = typ.replace("_", " ")
        return req("create.locker", "write", [Action("act", None, verb="create", args=[("kind", "locker item"), ("name", nm), ("type", typ)])],
                   {"NEWNAME": nm, "TYPE": tw}, [nm], tags={"create.locker"})
    if c == "group":
        nm = f"{rng.choice(CITIES)} {rng.choice(['trip', 'getaway', 'weekend'])}"
        cur = rng.choice(["EUR", "USD", "GBP", "JPY", "INR"])
        return req("create.group", "write", [Action("act", None, verb="create", args=[("kind", "group"), ("name", nm), ("currency", cur)])],
                   {"NEWNAME": nm, "CUR": cur}, [nm], tags={"create.group"})
    if c == "container":
        kind = rng.choice(["album", "notebook", "folder", "list"])
        nm = rng.choice({"album": ["Lisbon 2026", "Garden", "Graduation", "Snow day"], "notebook": ["Poetry", "Work log", "Dreams"],
                         "folder": ["Visa", "Receipts", "Pension"], "list": ["Groceries", "Renovation", "Wedding prep"]}[kind])
        if ctx.m.match(kind, words(nm)):
            raise Skip("exists")
        return req("create.container", "write", [Action("act", None, verb="create", args=[("kind", kind), ("name", nm)])],
                   {"NEWNAME": nm, "KW": kind}, [nm], tags={f"create.{kind}"})
    nm = rng.choice(["Tenancy deposit receipt", "Boarding pass", "Blood test results", "Home insurance 2026"])
    return req("create.document", "write", [Action("act", None, verb="create", args=[("kind", "document"), ("name", nm)])],
               {"NEWNAME": nm}, [nm], tags={"create.document"})


def write_target(ctx: Ctx, kind: str, pred=None) -> tuple[Row, Target]:
    row = choose(ctx, live(ctx, kind, pred))
    if kind == "person":
        ref = person_ref(ctx, row)
        if ctx.m.match("person", [w.lower() for w in ref.words]) != [row]:
            raise Skip("person words")
        return row, Target("name", ref.phrase, ref.words, [row.key])
    return row, target_name(ctx, row)


EDITABLE = {"task": [("priority", "priority", lambda r: str(r.randint(1, 9))), ("effort", "effort",
                     lambda r: str(r.choice([10, 20, 30, 45, 60]))), ("description", "description", lambda r: r.choice(["use the blue pen", "ask Dana first", "before lunch"]))],
            "event": [("duration", "duration", lambda r: str(r.choice([30, 45, 90, 120]))), ("description", "notes",
                      lambda r: r.choice(["bring the forms", "room 4", "parking at the back"]))],
            "note": [("body", "text", lambda r: r.choice(["updated: call first", "all done", "see the other note"]))],
            "person": [("role", "role", lambda r: r.choice(["plumber", "tutor", "mentor", "neighbour"])),
                       ("nickname", "nickname", lambda r: r.choice(["Bobby", "Mo", "Tash", "Kiki"])),
                       ("cadence", "check-in cadence in days", lambda r: str(r.choice([7, 14, 30, 60]))),
                       ("met", "where-we-met", lambda r: r.choice(["the gym", "university", "a wedding"]))],
            "locker item": [("username", "username", lambda r: r.choice(["sam.work", "s.park", "me2026"])),
                            ("url", "url", lambda r: r.choice(["https://login.example", "https://portal.example"])),
                            ("notes", "notes", lambda r: r.choice(["rotate in March", "shared with family"]))],
            "list": [("area", "area", lambda r: r.choice(["home", "work", "family"]))]}


@builder("edit", 6)
def b_edit(ctx: Ctx) -> Req:
    rng = ctx.rng
    c = rng.random()
    if c < 0.3:
        kind = rng.choice(["task", "event", "note", "document", "photo", "person", "album", "notebook", "folder", "list", "group", "locker item"])
        row, tgt = write_target(ctx, kind)
        new = rng.choice({"person": ["Neha R.", "Benny", "Aunt Maya"]}.get(kind, ["Final version", "Old stuff", "Archive",
                                                                                   "Holiday 2026", "Keep", "Misc"]))
        return req("edit.rename", "write", [Action("act", kind, tgt, verb="edit", args=[("name", new)])],
                   {"NAME": tgt.phrase, "NEWNAME": new, "KW": rng.choice(KW[kind])}, [tgt.phrase, new], tags={f"edit.{kind}.name"})
    if c < 0.4:
        row, tgt = write_target(ctx, "task", lambda r: r.fields.get("status") == "open")
        return req("edit.status_progress", "write", [Action("act", "task", tgt, verb="edit", args=[("status", "in_progress")])],
                   {"NAME": tgt.phrase}, [tgt.phrase], tags={"edit.task.status"})
    if c < 0.47:
        row, tgt = write_target(ctx, "note", lambda r: not r.fields.get("pinned"))
        return req("edit.pin", "write", [Action("act", "note", tgt, verb="edit", args=[("pinned", "yes")])],
                   {"NAME": tgt.phrase}, [tgt.phrase], tags={"edit.note.pinned"})
    kind = rng.choice(sorted(EDITABLE))
    fld, fw, gen = rng.choice(EDITABLE[kind])
    if kind == "locker item":      # the vault keeps username/url on logins only, notes on some types
        from worlds import LOCKER_NOTES
        ok = {"username": {"login"}, "url": {"login"}, "notes": LOCKER_NOTES - {"note"}}[fld]   # a note item's notes are sealed
        row, tgt = write_target(ctx, kind, lambda r: r.fields.get("type") in ok)
    else:
        row, tgt = write_target(ctx, kind)
    val = gen(rng)
    return req("edit.field", "write", [Action("act", kind, tgt, verb="edit", args=[(fld, val)])],
               {"NAME": tgt.phrase, "FIELDWORD": fw, "VALUE": val, "KW": rng.choice(KW[kind])}, [tgt.phrase],
               tags={f"edit.{kind}.{fld}"})


@builder("reschedule", 5)
def b_reschedule(ctx: Ctx) -> Req:
    rng = ctx.rng
    kind = rng.choice(["task", "event", "event"])
    row, tgt = write_target(ctx, kind, lambda r: r.fields.get("date") is not None and r.fields.get("status") not in ("cancelled", "completed"))
    if rng.random() < 0.4:
        dp = D.shift_phrase(rng)
        fid = "reschedule.shift"
    else:
        dp = D.instant_phrase(rng, ctx.today, rng.choice(["day_time", "weekday_time", "next_wd_time", "date_md_time", "day_only", "weekday_only"]))
        fid = "reschedule.abs"
    return req(fid, "write", [Action("act", kind, tgt, verb="reschedule", args=[("to", dp)])],
               {"NAME": tgt.phrase, "DATE": dp.text, "KW": rng.choice(KW[kind])}, [tgt.phrase],
               tags={f"reschedule.{kind}", "date." + dp.family})


@builder("status_verbs", 8)
def b_status(ctx: Ctx) -> Req:
    rng = ctx.rng
    c = rng.choice(["complete", "complete", "reopen", "cancel", "settle_debt"])
    already = rng.random() < 0.2
    if c == "complete":
        pred = (lambda r: r.fields.get("status") == "completed") if already else (lambda r: r.fields.get("status") in ("open", "in_progress"))
        row, tgt = write_target(ctx, "task", pred)
        return req("complete", "write", [Action("act", "task", tgt, verb="complete")], {"NAME": tgt.phrase}, [tgt.phrase],
                   tags={"verb.complete"} | ({"already"} if already else set()), expect="already" if already else "changed")
    if c == "reopen":
        pred = (lambda r: r.fields.get("status") == "open") if already else (lambda r: r.fields.get("status") == "completed")
        row, tgt = write_target(ctx, "task", pred)
        return req("reopen", "write", [Action("act", "task", tgt, verb="reopen")], {"NAME": tgt.phrase}, [tgt.phrase],
                   tags={"verb.reopen"} | ({"already"} if already else set()))
    if c == "cancel":
        pred = (lambda r: r.fields.get("status") == "cancelled") if already else (lambda r: r.fields.get("status") != "cancelled")
        row, tgt = write_target(ctx, "event", pred)
        return req("cancel", "write", [Action("act", "event", tgt, verb="cancel")], {"NAME": tgt.phrase}, [tgt.phrase],
                   tags={"verb.cancel"} | ({"already"} if already else set()))
    pred = (lambda r: r.fields.get("status") == "settled") if already else (lambda r: r.fields.get("status") == "open")
    row, tgt = write_target(ctx, "debt", pred)
    return req("settle_debt", "write", [Action("act", "debt", tgt, verb="settle_debt")], {"NAME": tgt.phrase}, [tgt.phrase],
               tags={"verb.settle_debt"} | ({"already"} if already else set()))


@builder("delete_restore", 5)
def b_delete(ctx: Ctx) -> Req:
    rng = ctx.rng
    if rng.random() < 0.45:
        kind = rng.choice(["task", "note", "document", "photo", "person", "event", "locker item"])
        tr = [r for r in ctx.m.trashed(kind) if r.id]
        row = choose(ctx, tr)
        tgt = target_name(ctx, row, trashed=True)
        return req("restore", "write", [Action("act", kind, tgt, verb="restore", trashed=True)],
                   {"NAME": tgt.phrase, "KW": rng.choice(KW[kind])}, [tgt.phrase], tags={f"restore.{kind}"})
    kind = rng.choice(["task", "note", "document", "photo", "person", "event", "locker item", "album", "notebook", "folder"])
    row, tgt = write_target(ctx, kind, lambda r: r.key != "me")
    return req("delete", "write", [Action("act", kind, tgt, verb="delete")], {"NAME": tgt.phrase, "KW": rng.choice(KW[kind])},
               [tgt.phrase], tags={f"delete.{kind}"})


@builder("star", 4)
def b_star(ctx: Ctx) -> Req:
    rng = ctx.rng
    kind = rng.choice(["person", "document", "photo", "locker item"])
    verb = rng.choice(["star", "star", "unstar"])
    already = rng.random() < 0.2
    want = (verb == "star") == already
    row, tgt = write_target(ctx, kind, lambda r: bool(r.fields.get("starred")) == want and r.key != "me")
    return req(verb, "write", [Action("act", kind, tgt, verb=verb)], {"NAME": tgt.phrase, "KW": rng.choice(KW[kind])},
               [tgt.phrase], tags={f"{verb}.{kind}"} | ({"already"} if already else set()))


@builder("add_remove", 5)
def b_add_remove(ctx: Ctx) -> Req:
    rng = ctx.rng
    kind, ckind = rng.choice([("photo", "album"), ("note", "notebook"), ("document", "folder"), ("person", "group"), ("task", "list")])
    remove = rng.random() < 0.3 and kind != "person"   # the vault refuses removing a member with a balance
    if remove:
        if kind in ("photo", "person"):
            row, tgt = write_target(ctx, kind, lambda r: any(ctx.m.rows[c].kind == ckind for c in r.containers) and r.key != "me")
            cont = ctx.m.rows[rng.choice(sorted(c for c in row.containers if ctx.m.rows[c].kind == ckind))]
        else:
            row, tgt = write_target(ctx, kind, lambda r: r.container is not None)
            cont = ctx.m.rows[row.container]
    else:
        conts = live(ctx, ckind)
        row, tgt = write_target(ctx, kind, lambda r: r.key != "me")
        conts = [c for c in conts if c.key not in row.containers and c.key != row.container]
        cont = choose(ctx, conts)
    if cont.trashed or not cont.name or not cont.id:
        raise Skip("trashed container")
    ref = container_ref(ctx, cont)
    role = "from" if remove else "to"
    verb = "remove_from" if remove else "add_to"
    a = Action("act", kind, tgt, verb=verb, args=[(role, ref)], refs={role: ref})
    return req(verb, "write", [a], {"NAME": tgt.phrase, "KW": rng.choice(KW[kind]), "CONTAINER": ref.phrase, "CKW": ckind},
               [tgt.phrase, ref.phrase], tags={f"{verb}.{kind}"})


@builder("log", 2)
def b_log(ctx: Ctx) -> Req:
    row, tgt = write_target(ctx, "person", lambda r: r.key != "me")
    lk = ctx.rng.choice(["call", "message", "visit", "coffee"])
    return req("log", "write", [Action("act", "person", tgt, verb="log", args=[("kind", lk)])],
               {"PERSON": tgt.phrase, "LOGKIND": lk}, [tgt.phrase], tags={f"log.{lk}"})


@builder("settle_up", 1.5)
def b_settle_up(ctx: Ctx) -> Req:
    g = choose(ctx, [r for r in live(ctx, "group") if r.links])
    p = ctx.m.rows[ctx.rng.choice(sorted(g.links))]
    if p.trashed or ctx.m.match("person", words(p.name.split(" ")[0])) != [p]:
        raise Skip("person")
    tgt = Target("name", typed(ctx.rng, p.name.split(" ")[0]), [p.name.split(" ")[0]], [p.key])
    tgt.words = clean_words(tgt.phrase)
    ref = container_ref(ctx, g)
    a = Action("act", "person", tgt, verb="settle_up", args=[("group", ref)], refs={"group": ref})
    return req("settle_up", "write", [a], {"PERSON": tgt.phrase, "GROUP": ref.phrase}, [tgt.phrase, ref.phrase], tags={"verb.settle_up"})


@builder("reveal", 2)
def b_reveal(ctx: Ctx) -> Req:
    row, tgt = write_target(ctx, "locker item", lambda r: r.fields.get("type") in ("login", "wifi", "password"))
    return req("reveal", "write", [Action("act", "locker item", tgt, verb="reveal", args=[("field", "password")])],
               {"NAME": tgt.phrase, "FIELDWORD": "password"}, [tgt.phrase], tags={"verb.reveal"})


@builder("bulk", 3)
def b_bulk(ctx: Ctx) -> Req:
    rng = ctx.rng
    c = rng.choice(["complete", "star", "delete"])
    if c == "complete":
        dp, hits = pick_date(ctx, "task", lambda r: r.fields.get("status") == "open",
                             fam=rng.choice(["day_rel", "week", "weekday", None]))
        if len(hits) < 2:
            raise Skip("bulk needs several")
        a = Action("act", "task", verb="complete", when=dp, where="status = open", bulk=True, where_note="only open ones")
        return req("bulk.complete", "write", [a], {"DATE": dp.text}, [], tags={"bulk.complete", "date." + dp.family})
    if c == "star":
        cands = [r for r in live(ctx, "person") if sum(1 for p in ctx.m.live("photo") if r.key in p.links) >= 2]
        row = choose(ctx, cands)
        ref = person_ref(ctx, row)
        a = Action("act", "photo", verb="star", refs={"linked_to": ref}, bulk=True)
        return req("bulk.star", "write", [a], {"PERSON": ref.phrase}, [ref.phrase], tags={"bulk.star"})
    dp, hits = pick_date(ctx, "photo", fam=rng.choice(["day_rel", "weekend", "weekday", "day_n"]))
    if len(hits) < 2:
        raise Skip("bulk needs several")
    a = Action("act", "photo", verb="delete", when=dp, bulk=True)
    return req("bulk.delete", "write", [a], {"DATE": dp.text}, [], tags={"bulk.delete", "date." + dp.family})


# ---- multi-step
ACT_PHR = {"complete": ["mark {n} done", "tick off {n}"], "cancel": ["cancel {n}"], "star": ["star {n}"],
           "delete": ["delete {n}", "bin {n}"], "log": ["log a call with {n}"], "pin": ["pin {n}"]}


@builder("multi", 6)
def b_multi(ctx: Ctx) -> Req:
    rng = ctx.rng
    c = rng.random()
    if c < 0.35:
        # act then answer
        row, tgt = write_target(ctx, "task", lambda r: r.fields.get("status") == "open")
        dp, _ = pick_date(ctx, "task", lambda r: r.fields.get("status") == "open", fam=rng.choice(["day_rel", "week", "weekday"]))
        a1 = Action("act", "task", tgt, verb="complete")
        a2 = Action("answer", "task", where="status = open", when=dp, where_note="what's left = still open")
        return req("multi.act_answer", "multi", [a1, a2], {"NAME": tgt.phrase, "DATE": dp.text}, [tgt.phrase],
                   tags={"act_then_answer", "date." + dp.family})
    if c < 0.6:
        kind, verb, vp = rng.choice([("task", "complete", "mark done"), ("person", "star", "star"), ("photo", "star", "star"),
                                     ("event", "cancel", "cancel"), ("note", "delete", "delete"), ("document", "star", "favourite")])
        pred = {"complete": lambda r: r.fields.get("status") == "open", "star": lambda r: not r.fields.get("starred") and r.key != "me",
                "cancel": lambda r: r.fields.get("status") != "cancelled", "delete": lambda r: True}[verb]
        r1, t1 = write_target(ctx, kind, pred)
        r2, t2 = write_target(ctx, kind, lambda r: pred(r) and r.key != r1.key)
        tgt = Target("keys", "", [], [r1.key, r2.key])
        refs = {"_a": Ref(kind, t1.phrase, t1.words, r1.key), "_b": Ref(kind, t2.phrase, t2.words, r2.key)}
        a = Action("act", kind, tgt, verb=verb, refs=refs)
        return req("multi.same", "multi", [a], {"VERBPHRASE": vp, "NAME": t1.phrase, "NAME2": t2.phrase}, [t1.phrase, t2.phrase],
                   tags={"multi.same", f"{verb}.{kind}"})
    # two different writes
    specs = rng.sample([("task", "complete", lambda r: r.fields.get("status") == "open"),
                        ("event", "cancel", lambda r: r.fields.get("status") != "cancelled"),
                        ("person", "star", lambda r: not r.fields.get("starred") and r.key != "me"),
                        ("note", "delete", lambda r: True), ("person", "log", lambda r: r.key != "me"),
                        ("photo", "star", lambda r: not r.fields.get("starred"))], 2)
    acts, phr, named = [], [], []
    for kind, verb, pred in specs:
        row, tgt = write_target(ctx, kind, pred)
        args = [("kind", "call")] if verb == "log" else []
        acts.append(Action("act", kind, tgt, verb=verb, args=args))
        phr.append(rng.choice(ACT_PHR[verb]).format(n=tgt.phrase))
        named.append(tgt.phrase)
    if acts[0].kind == acts[1].kind and acts[0].verb == acts[1].verb:
        raise Skip("same")
    return req("multi.two", "multi", acts, {"ACT1": phr[0], "ACT2": phr[1]}, named, tags={"multi.two"})


# ---- field coverage: every metadata field as a condition, an order, a create value and an edit value
COVER_WHERE = [("person", "nickname"), ("person", "met"), ("person", "cadence"), ("event", "description"),
               ("task", "description"), ("locker item", "username"), ("locker item", "url"), ("locker item", "notes"),
               ("list", "area")]
COVER_ORDER = ["event.date", "task.date", "task.completed", "debt.date", "person.date", "person.cadence"]
COVER_EDIT = [("list", "area"), ("task", "description"), ("person", "met"), ("person", "cadence"), ("person", "nickname"),
              ("event", "description"), ("locker item", "url"), ("locker item", "username"), ("locker item", "notes")]
COVER_WEIGHT = float(__import__("os").environ.get("NATIVE_COVER", "0"))


def forced_edit(ctx: Ctx, kind: str, fld: str) -> Req:
    rng = ctx.rng
    fw, gen = next((fw, g) for f, fw, g in EDITABLE[kind] if f == fld)
    if kind == "locker item":
        from worlds import LOCKER_NOTES
        ok = {"username": {"login"}, "url": {"login"}, "notes": LOCKER_NOTES - {"note"}}[fld]
        row, tgt = write_target(ctx, kind, lambda r: r.fields.get("type") in ok)
    else:
        row, tgt = write_target(ctx, kind)
    val = gen(rng)
    return req("edit.field", "write", [Action("act", kind, tgt, verb="edit", args=[(fld, val)])],
               {"NAME": tgt.phrase, "FIELDWORD": fw, "VALUE": val, "KW": rng.choice(KW[kind])}, [tgt.phrase],
               tags={f"edit.{kind}.{fld}", "cover"})


@builder("cover", COVER_WEIGHT)
def b_cover(ctx: Ctx) -> Req:
    rng = ctx.rng
    c = rng.choice(["where", "where", "order", "create", "create", "edit", "reveal"])
    if c == "where":
        kind, fld = rng.choice(COVER_WHERE)
        phrase, act, named, tags = thing(ctx, kind, rng.choice([1, 1, 2]), force=fld)
        if rng.random() < 0.3 and kind != "list":
            return req("value.count", "value", [action_from(act, op="count")], {"THING": phrase}, named,
                       tags=tags | {"op.count", "cover"})
        return req("rows.frame.show", "rows", [action_from(act)], {"THING": phrase}, named, tags=tags | {"cover"})
    if c == "order":
        return b_rows_order(ctx, only=rng.choice(COVER_ORDER))
    if c == "edit":
        return forced_edit(ctx, *rng.choice(COVER_EDIT))
    if c == "reveal":
        row, tgt = write_target(ctx, "locker item", lambda r: r.fields.get("type") == "note" and r.fields.get("notes"))
        return req("reveal", "write", [Action("act", "locker item", tgt, verb="reveal", args=[("field", "content")])],
                   {"NAME": tgt.phrase, "FIELDWORD": rng.choice(["secret note", "hidden note", "sealed contents"])},
                   [tgt.phrase], tags={"verb.reveal.content", "cover"})
    k = rng.choice(["person_nick", "person_cadence", "event_desc", "task_priority", "task_desc", "locker_login",
                    "locker_notes", "list_area"])
    if k.startswith("person"):
        nm = rng.choice(NEW_PEOPLE)
        if ctx.m.match("person", words(nm)):
            raise Skip("exists")
        if k == "person_nick":
            nk = rng.choice(["Nessa", "KJ", "Bobby", "Mo", "Tash", "Lulu"])
            return req("create.person_nick", "write", [Action("act", "person", verb="create",
                       args=[("kind", "person"), ("name", nm), ("nickname", nk)])], {"NEWNAME": nm, "NICK": nk}, [nm],
                       tags={"create.person.nickname", "cover"})
        n = rng.choice([7, 14, 21, 30, 60, 90])
        return req("create.person_cadence", "write", [Action("act", "person", verb="create",
                   args=[("kind", "person"), ("name", nm), ("cadence", str(n))])], {"NEWNAME": nm, "DAYS": str(n)}, [nm],
                   tags={"create.person.cadence", "cover"})
    if k == "event_desc":
        nm = rng.choice(NEW_EVENTS)
        dp = D.instant_phrase(rng, ctx.today, rng.choice(["day_time", "weekday_time", "next_wd_time", "date_md_time"]))
        desc = rng.choice(["bring the forms", "gate B", "second floor", "pay at the desk", "wear boots"])
        return req("create.event_desc", "write", [Action("act", "event", verb="create",
                   args=[("kind", "event"), ("name", nm), ("date", dp), ("description", desc)])],
                   {"NEWNAME": nm, "DATE": dp.text, "DESC": desc}, [nm], tags={"create.event.description", "cover",
                                                                              "date." + dp.family})
    if k.startswith("task"):
        nm = rng.choice(NEW_TASKS)
        if k == "task_priority":
            pr = str(rng.randint(1, 9))
            return req("create.task_priority", "write", [Action("act", "task", verb="create",
                       args=[("kind", "task"), ("name", nm), ("priority", pr)])], {"NEWNAME": nm, "PRIO": pr}, [nm],
                       tags={"create.task.priority", "cover"})
        desc = rng.choice(["use the old account", "ask for a receipt", "before lunch", "the blue form"])
        return req("create.task_desc", "write", [Action("act", "task", verb="create",
                   args=[("kind", "task"), ("name", nm), ("description", desc)])], {"NEWNAME": nm, "DESC": desc}, [nm],
                   tags={"create.task.description", "cover"})
    if k == "locker_login":
        nm, host = rng.choice([("Disney+", "disneyplus"), ("Work VPN", "vpn"), ("Council portal", "council"),
                               ("Pension site", "pension"), ("Library login", "library")])
        if ctx.m.match("locker item", words(nm)):
            raise Skip("exists")
        user = rng.choice(["sam.park", "me2026", "s.p", "family"])
        url = f"https://{host}.example"
        return req("create.locker_login", "write", [Action("act", "locker item", verb="create",
                   args=[("kind", "locker item"), ("name", nm), ("type", "login"), ("username", user), ("url", url)])],
                   {"NEWNAME": nm, "USER": user, "URL": url}, [nm], tags={"create.locker.username", "create.locker.url", "cover"})
    if k == "locker_notes":
        nm, typ = rng.choice([("Server key", "ssh_key"), ("Stripe API", "api_credential"), ("Old passport", "passport"),
                              ("Joint account", "bank_account"), ("Ledger wallet", "crypto_wallet")])
        if ctx.m.match("locker item", words(nm)):
            raise Skip("exists")
        notes = rng.choice(["rotate yearly", "shared with family", "expires in May", "kept in the safe"])
        return req("create.locker_notes", "write", [Action("act", "locker item", verb="create",
                   args=[("kind", "locker item"), ("name", nm), ("type", typ), ("notes", notes)])],
                   {"NEWNAME": nm, "TYPE": typ.replace("_", " "), "NOTES": notes}, [nm],
                   tags={"create.locker.notes", "cover"})
    nm = rng.choice(["Allotment", "Car stuff", "Move house", "Baby prep", "Tax season"])
    if ctx.m.match("list", words(nm)):
        raise Skip("exists")
    area = rng.choice(["home", "work", "family", "admin"])
    return req("create.list_area", "write", [Action("act", "list", verb="create",
               args=[("kind", "list"), ("name", nm), ("area", area)])], {"NEWNAME": nm, "AREA": area}, [nm],
               tags={"create.list.area", "cover"})


# ---- ambiguity (first turn): a write whose name fits two rows
@builder("ambiguous", 7, "ambiguity_ask")
def b_ambiguous(ctx: Ctx) -> Req:
    rng = ctx.rng
    kind = rng.choice(["person", "person", "task", "event", "note", "document", "photo"])
    groups: dict = {}
    for r in live(ctx, kind, lambda r: r.key != "me"):
        for w in set(WORDS.findall(r.name)):
            if w.lower() in STOP or len(w) < 3 or w.isdigit():
                continue
            groups.setdefault(w, []).append(r)
    amb = {w: rs for w, rs in groups.items() if 2 <= len(rs) <= 3}
    if not amb:
        raise Skip("no ambiguity")
    w = rng.choice(sorted(amb))
    rows = amb[w]
    phrase = typed(rng, w)
    verbs = {"person": ["star", "log", "delete"], "task": ["complete", "delete"], "event": ["cancel", "delete"],
             "note": ["delete", "pin"], "document": ["star", "delete"], "photo": ["star", "delete"]}[kind]
    verb = rng.choice(verbs)
    tgt = Target("name", phrase, [phrase], [r.key for r in rows])
    if verb == "pin":
        a = Action("act", kind, tgt, verb="edit", args=[("pinned", "yes")])
        fid = "edit.pin"
    elif verb == "log":
        a = Action("act", kind, tgt, verb="log", args=[("kind", "call")])
        fid = "log"
    else:
        a = Action("act", kind, tgt, verb=verb)
        fid = {"star": "star", "delete": "delete", "complete": "complete", "cancel": "cancel"}[verb]
    slots = {"NAME": phrase, "KW": rng.choice(KW[kind]), "PERSON": phrase, "LOGKIND": "call"}
    return req(fid, "write", [a], slots, [phrase], tags={"ambiguity", f"{verb}.{kind}"}, pattern="ambiguity_ask",
               expect="ask")


# ---- declines
OUT_OF_SCOPE = ["book me a flight to Lisbon", "what's the weather tomorrow", "write me a poem about autumn",
                "translate 'good morning' into Japanese", "order a pizza", "what's the capital of Peru",
                "play some jazz", "how do I fix a flat tyre", "set an alarm for 6am", "what's bitcoin trading at",
                "call an uber", "tell me a joke", "what's 17 times 23", "who won the match last night",
                "recommend a good sci-fi novel", "turn off the living room lights"]
DESTROY = ["delete everything in my vault", "wipe all my notes", "erase every photo I have", "clear out all my contacts",
           "delete all my documents", "nuke the whole calendar", "remove every task, all of them"]


@builder("decline", 4, "decline")
def b_decline(ctx: Ctx) -> Req:
    rng = ctx.rng
    c = rng.choice(["out_of_scope", "out_of_scope", "destroy", "egress", "fabricate"])
    if c == "out_of_scope":
        return req("decline.out_of_scope", "decline", [], {}, [], decline="out_of_scope", tags={"decline.out_of_scope"})
    if c == "destroy":
        return req("decline.destroy", "decline", [], {}, [], decline="unbounded_destruction",
                   tags={"decline.unbounded_destruction"})
    rows = live(ctx, "locker item")
    nm = typed(rng, rng.choice(rows).name) if rows else "bank login"
    if c == "egress":
        return req("decline.egress", "decline", [], {"NAME": nm}, [], decline="sealed_egress", tags={"decline.sealed_egress"})
    return req("decline.fabricate", "decline", [], {"NAME": nm}, [], decline="fabricated_secret",
               tags={"decline.fabricated_secret"})


# ---- dead ends
FAKE = ["Zorblat", "Quenby", "Marisol party", "Hovercraft", "Pemberton", "Glastonbury tickets", "Tuvalu", "Crumpet",
        "Okonkwo wedding", "Vasquez"]


@builder("deadend", 7, "dead_end")
def b_deadend(ctx: Ctx) -> Req:
    rng = ctx.rng
    c = rng.choice(["unknown", "typo", "kind_mismatch", "trashed_write"])
    if c == "unknown":
        nm = rng.choice(FAKE)
        if ctx.m.match("task", words(nm)) or any(set(words(nm)) & set(words(r.name)) for r in ctx.m.rows.values()):
            raise Skip("exists")
        kind = rng.choice(["task", "event", "note", "document", "person"])
        if rng.random() < 0.5:
            fid = "rows.name." + kind
            a = Action("answer", kind, Target("name", typed(rng, nm), clean_words(nm), []))
            return req(fid, "rows", [a], {"NAME": typed(rng, nm)}, [nm], tags={"dead_end.not_found"}, pattern="dead_end")
        verb = {"task": "complete", "event": "cancel", "note": "delete", "document": "star", "person": "star"}[kind]
        a = Action("act", kind, Target("name", typed(rng, nm), clean_words(nm), []), verb=verb)
        return req(verb, "write", [a], {"NAME": typed(rng, nm), "KW": rng.choice(KW[kind])}, [nm], tags={"dead_end.not_found"},
                   pattern="dead_end")
    if c == "typo":
        kind = rng.choice(["person", "task", "event", "note", "document"])
        row = choose(ctx, live(ctx, kind, lambda r: r.key != "me"))
        ws = [w for w in re.findall(r"[A-Za-z]+", row.name) if len(w) >= 5 and w.lower() not in STOP
              and ctx.m.match(kind, [w.lower()]) == [row]]     # the misspelt word must still name one row
        w = choose(ctx, ws)
        i = rng.randint(1, len(w) - 2)
        typo = w[:i] + w[i + 1] + w[i] + w[i + 2:] if rng.random() < 0.5 else w[:i] + w[i + 1:]
        if typo.lower() == w.lower() or any(typo.lower() in words(r.name) for r in ctx.m.rows.values()):
            raise Skip("typo collides")
        phrase = typed(rng, typo)
        tgt = Target("name", phrase, [phrase], [row.key])
        if kind == "person" or rng.random() < 0.5:
            fid = "rows.name." + kind
            return req(fid, "rows", [Action("answer", kind, tgt)], {"NAME": phrase}, [phrase], tags={"dead_end.typo"}, pattern="dead_end")
        verb = {"task": "delete", "event": "delete", "note": "delete", "document": "star"}[kind]
        return req(verb, "write", [Action("act", kind, tgt, verb=verb)], {"NAME": phrase, "KW": rng.choice(KW[kind])}, [phrase],
                   tags={"dead_end.typo"}, pattern="dead_end")
    if c == "kind_mismatch":
        # the person names the wrong kind: an event called like a task, etc.
        src, said = rng.choice([("event", "task"), ("task", "event"), ("note", "document"), ("document", "note")])
        row = choose(ctx, live(ctx, src))
        phrase, ws = sel_words(ctx, row)
        if ctx.m.match(said, [w.lower() for w in ws]):
            raise Skip("name also in said kind")
        if any(r.kind != src and r.has_words(ws) for r in ctx.m.rows.values() if not r.trashed):
            raise Skip("cross-kind collision")
        tgt = Target("name", phrase, ws, [row.key])
        verb = rng.choice(["delete", None])
        if verb:
            return req("delete", "write", [Action("act", said, tgt, verb=verb)], {"NAME": phrase, "KW": KW[said][0]}, [phrase],
                       tags={"dead_end.kind"}, pattern="dead_end")
        fid = "rows.name." + said
        return req(fid, "rows", [Action("answer", said, tgt)], {"NAME": phrase}, [phrase], tags={"dead_end.kind"}, pattern="dead_end")
    # trashed-only write (not a restore)
    kind = rng.choice(["task", "note", "document", "photo", "event"])
    row = choose(ctx, [r for r in ctx.m.trashed(kind) if r.id])
    phrase, ws = sel_words(ctx, row, trashed=True)
    if ctx.m.match(kind, [w.lower() for w in ws]):
        raise Skip("live one too")
    verb = {"task": "complete", "note": "edit", "document": "star", "photo": "star", "event": "cancel"}[kind]
    args = [("pinned", "yes")] if verb == "edit" else []
    fid = "edit.pin" if verb == "edit" else verb
    a = Action("act", kind, Target("name", phrase, ws, [row.key]), verb=verb, args=args)
    return req(fid, "write", [a], {"NAME": phrase, "KW": rng.choice(KW[kind])}, [phrase], tags={"dead_end.trashed_only"},
               pattern="dead_end")


# ------------------------------------------------------------------ follow-up builders (need history)
def last_turn(ctx: Ctx):
    if not ctx.hist:
        raise Skip("no history")
    return ctx.hist[-1]


@builder("follow.narrow", 6, "narrow")
def f_narrow(ctx: Ctx) -> Req:
    prev, steps = last_turn(ctx)
    if prev.intent != "rows" or not steps or steps[-1].tool != "answer":
        raise Skip("prev not rows")
    ans = (steps[-1].effect or {}).get("answer") or {}
    handle = ans.get("result")
    if not handle or len(ans.get("rows", [])) < 3:
        raise Skip("need several rows")
    kinds = {r["kind"] for r in ans["rows"]}
    if len(kinds) != 1:
        raise Skip("mixed kinds")
    kind = kinds.pop()
    a0 = prev.actions[0]
    for _ in range(8):
        try:
            phrase, act, named, tags = thing(ctx, kind, 1, allow_date=a0.when is None)
        except Skip:
            continue
        if act.get("refs") or (act.get("where") and a0.where and act["where"].split()[0] in a0.where):
            continue
        break
    else:
        raise Skip("no narrowing")
    noun = next((n for n in KWS[kind] if re.search(rf"\b{re.escape(n)}\b", phrase)), None)
    pre, _, post = phrase.partition(noun) if noun else ("", "", phrase)
    pre, post = pre.strip(), post.strip()
    cond = post if post else ("that are " + pre)
    if pre and post:
        raise Skip("two parts")
    a = action_from(act, within=handle)
    a.kind = kind if a.where else None
    return req("follow.narrow", "rows", [a], {"COND": cond}, named, follow=f"narrow {handle}: {cond}", pattern="narrow",
               tags=tags | {"follow.narrow"})


@builder("follow.subst", 5, "substitution")
def f_subst(ctx: Ctx) -> Req:
    import copy
    prev, steps = last_turn(ctx)
    if prev.intent not in ("rows", "value") or len(prev.actions) != 1 or prev.family.startswith("follow"):
        raise Skip("prev")
    a0 = prev.actions[0]
    a = copy.deepcopy(a0)
    if "linked_to" in a0.refs and a0.refs["linked_to"].kind == "person":
        old = a0.refs["linked_to"]
        cands = [r for r in live(ctx, "person") if r.key not in (old.key, "me")]
        if a0.kind == "group":
            cands = [r for r in cands if a0.target and a0.target.keys and a0.target.keys[0] in r.containers]
        else:
            cands = [r for r in cands if any(x.kind == a0.kind and r.key in x.links for x in ctx.m.rows.values())]
        row = choose(ctx, cands)
        ref = person_ref(ctx, row)
        a.refs["linked_to"] = ref
        return _subst(prev, a, ref.phrase, f"person {old.phrase} → {ref.phrase}")
    if a0.target and a0.target.mode == "name" and a0.op == "balance" and a0.kind == "person":
        row = choose(ctx, [r for r in live(ctx, "person") if r.key not in a0.target.keys and r.key != "me"])
        ref = person_ref(ctx, row)
        if ctx.m.match("person", [w.lower() for w in ref.words]) != [row]:
            raise Skip("words")
        a.target = Target("name", ref.phrase, ref.words, [row.key])
        return _subst(prev, a, ref.phrase, f"name {a0.target.phrase} → {ref.phrase}")
    if a0.when is not None:
        dp = None
        for _ in range(8):
            cand = D.read_phrase(ctx.rng, ctx.today, a0.when.family if ctx.rng.random() < 0.5 else None)
            if cand.text != a0.when.text and cand.expr != a0.when.expr:
                dp = cand
                break
        if dp is None:
            raise Skip("date")
        a.when = dp
        return _subst(prev, a, dp.text, f'date "{a0.when.text}" → "{dp.text}"')
    if a0.target and a0.target.mode == "name" and a0.kind in ("task", "event", "note", "document", "photo") and not a0.trashed:
        row = choose(ctx, [r for r in live(ctx, a0.kind) if r.key not in a0.target.keys])
        t = target_name(ctx, row)
        a.target = t
        return _subst(prev, a, t.phrase, f"name {a0.target.phrase} → {t.phrase}")
    raise Skip("nothing to substitute")


def _subst(prev: Req, a: Action, newval: str, what: str) -> Req:
    import copy
    if a.when is not None and a.when.text != newval:
        a.when = copy.copy(a.when)
        a.when.kept = True
    r = req("follow.subst", prev.intent, [a], {"NEWVAL": newval}, [newval], follow=f"same as the last question with {what}",
            pattern="substitution", tags={"follow.subst"})
    r.sub_reading = prev.reading  # type: ignore[attr-defined]
    return r


@builder("follow.also", 3, "correction_adds")
def f_also(ctx: Ctx) -> Req:
    prev, steps = last_turn(ctx)
    if prev.intent != "write" or len(prev.actions) != 1 or not steps or steps[-1].tool != "act":
        raise Skip("prev")
    eff = steps[-1].effect or {}
    if not (eff.get("diff") or {}).get("rows") or eff.get("already"):
        raise Skip("prev changed nothing")
    a0 = prev.actions[0]
    if a0.verb not in ("complete", "star", "unstar", "cancel", "delete", "log", "settle_debt") or not a0.target:
        raise Skip("verb")
    import copy
    a = copy.deepcopy(a0)
    kind = a0.kind
    pred = {"complete": lambda r: r.fields.get("status") == "open", "star": lambda r: not r.fields.get("starred"),
            "unstar": lambda r: r.fields.get("starred"), "cancel": lambda r: r.fields.get("status") != "cancelled",
            "delete": lambda r: True, "log": lambda r: True, "settle_debt": lambda r: r.fields.get("status") == "open"}[a0.verb]
    row, tgt = write_target(ctx, kind, lambda r: pred(r) and r.key not in a0.target.keys and r.key != "me")
    a.target = tgt
    return req("follow.also", "write", [a], {"NAME": tgt.phrase}, [tgt.phrase],
               follow=f"same {a0.verb} as the last turn, now on {tgt.phrase} (a correction adds; no undo)",
               pattern="correction_adds", tags={"follow.also", f"{a0.verb}.{kind}"})


@builder("follow.undo", 1.5, "undo")
def f_undo(ctx: Ctx) -> Req:
    prev, steps = last_turn(ctx)
    if not steps or not any(s.tool == "act" and ((s.effect or {}).get("diff") or {}).get("rows") for s in steps):
        raise Skip("no write")
    if any(s.args.get("verb") in ("settle_up", "reveal", "undo", "cancel", "log") for s in steps):
        raise Skip("verb")
    return req("undo", "undo", [], {}, [], pattern="undo", tags={"verb.undo"})


@builder("follow.settle", 6, "ambiguity_settled")
def f_settle(ctx: Ctx) -> Req:
    prev, steps = last_turn(ctx)
    if not steps or steps[-1].tool != "ask" or not prev.actions:
        raise Skip("prev not ask")
    opts = (steps[-1].effect or {}).get("ask", {}).get("options", [])
    if len(opts) < 2:
        raise Skip("opts")
    pick = ctx.rng.choice(opts)
    row = ctx.m.by_id(pick["id"])
    if not row:
        raise Skip("row")
    if len({(ctx.m.by_id(o["id"]).name if ctx.m.by_id(o["id"]) else "") for o in opts}) < len(opts):
        raise Skip("options share a name; a name cannot settle it")
    others = [ctx.m.by_id(o["id"]) for o in opts if o["id"] != pick["id"]]
    mine = [w for w in WORDS.findall(row.name) if not any(w in WORDS.findall(o.name) for o in others if o)]
    choice = typed(ctx.rng, row.name if ctx.rng.random() < 0.5 or not mine else ctx.rng.choice(mine))
    import copy
    a = copy.deepcopy(prev.actions[0])
    a.target = Target("rows_kept", choice, [], [row.key], pick_why=f'"{choice}"')
    r = req("settle.pick", prev.intent, [a], {"CHOICE": choice}, [choice],
            follow=f"reply to my question; same {a.verb or a.tool} as before on the chosen row", pattern="ambiguity_settled",
            tags={"ambiguity.settled"})
    r.sub_reading = prev.reading  # type: ignore[attr-defined]
    return r


@builder("follow.never_mind", 2, "never_mind")
def f_never(ctx: Ctx) -> Req:
    prev, steps = last_turn(ctx)
    if not steps or steps[-1].tool != "ask":
        raise Skip("prev not ask")
    return req("never_mind", "decline", [], {}, [], decline="never_mind", pattern="never_mind", tags={"decline.never_mind"})


FOLLOW = {"follow.narrow", "follow.subst", "follow.also", "follow.undo", "follow.settle", "follow.never_mind"}
FIRST = [k for k in BUILDERS if k not in FOLLOW]
