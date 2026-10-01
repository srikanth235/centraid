"""v7 trajectory generator: scripted tool-use sessions on TRAINING worlds.

    python3 trajgen.py --worlds v7/worlds --per-world 60 --out v7/traj.jsonl

Each session is played for real against `tool-loop serve --world spec:<w>`:
a cell picks a target row from the world (via `peek`, which numbers nothing),
then makes the calls a good assistant would, reading each result to find the
`#n` it needs. Observations are the server's own text. A cell whose calls
error is dropped, never repaired.

A turn records a HINT (what the person wants, for the paraphrase step), SAY
(words that must appear verbatim in the person's message: every string the
calls copy from the request, and every relative day) and TYPE (lookup, route,
link, follow, write, edge -- for the distribution report only). The user
messages themselves are written afterwards (prompt in PROMPT_V7.md); the names
in them are swapped for fresh ones at build time (build7.py, subnames.py).

A read turn ends on `answer <set|value>`, never on a final `show` + `done`;
`done` only stops (after `ambiguous: …`, it hands the question to the person).
Read cells LOOK first some of the time (`search`, `show`, `get`), in the mix
EXPLORE sets: answer straight away, look once, or look twice / `get` a row.

A session is one first cell, then (up to its drawn length) follow-ups that
refine what the last turn answered, or a change of subject (another first
cell, its hint marked "(new topic)").
"""
import argparse
import collections
import json
import os
import random
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
BIN = os.path.join(REPO, "target", "release", "tool-loop")

ROW = re.compile(r'^#(\d+) ([a-z ]+?) "([^"]*)"(.*)$', re.M)
VALUE = re.compile(r"^(count|sum|min|max|balance) |^[a-z_]+ of ")
STOP = set("the a an my our at of for to in on about with and is it that this what from new old up out off by or as vs "
           "again before after next last week weeks month into over under very more".split())
DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
WINDOWS = ["today", "tomorrow", "this week", "next week", "this weekend", "last week",
           "last weekend", "yesterday"]
# answer straight away / look once / look twice or `get` a row, on read turns
EXPLORE = (0.38, 0.36, 0.26)
# session length (turns) and its weights
LENGTHS = ([1, 2, 3, 4, 5, 6], [26, 23, 21, 13, 10, 7])
P_FOLLOW = 0.85  # a later turn is a follow-up (when one applies), else a new topic


class Fail(Exception):
    pass


class Server:
    def __init__(self, world):
        self.p = subprocess.Popen([BIN, "serve", "--world", "spec:" + world],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                                  bufsize=1)
        # Does this runtime know `answer`? A probe on a throwaway session;
        # the next `open` deals a fresh world.
        self.ask({"op": "open"})
        self.ask({"op": "turn", "request": "probe"})
        r = self.ask({"op": "call", "line": "answer count of (tasks)"})
        self.native_answer = "error" not in r and not r.get("obs", "").startswith("error:")

    def ask(self, msg):
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise SystemExit("tool-loop serve exited")
        return json.loads(line)

    def close(self):
        # `quit` has no reply: the server just exits.
        try:
            self.p.stdin.write(json.dumps({"op": "quit"}) + "\n")
            self.p.stdin.close()
        except OSError:
            pass
        self.p.wait()


class Session:
    def __init__(self, srv):
        self.srv = srv
        self.today = srv.ask({"op": "open"})["today"]
        self.date = self.today.split()[-1]
        self.turns = []
        self.rows = []        # every (n, kind, label) shown, in order
        self.last = []        # rows of the last result shown
        self.last_full = True  # the last result printed every row
        self.open_turn = False
        self.ctx = {}         # what the conversation is on, for follow-ups

    # -- turns -------------------------------------------------------------
    def turn(self, hint, say=(), t="lookup"):
        if self.open_turn:
            raise Fail("turn left open")
        if getattr(self, "new_topic", False):
            hint = "(new topic) " + hint
            self.new_topic = False
        self.srv.ask({"op": "turn", "request": hint})
        self.turns.append({"hint": hint, "say": list(say), "type": t, "steps": []})
        self.open_turn = True

    def _send(self, line):
        r = self.srv.ask({"op": "call", "line": line})
        if "error" in r:
            raise Fail(r["error"])
        obs = r.get("obs", "")
        if obs.startswith("error:"):
            raise Fail("%s -> %s" % (line, obs))
        return obs, r.get("end")

    def _record(self, line, obs, end):
        self.turns[-1]["steps"].append({"call": line, "obs": obs})
        shown = [(int(n), k, lab) for n, k, lab, _ in ROW.findall(obs)]
        if shown or obs == "no rows":
            self.last = shown
            self.last_full = "rows in all" not in obs
            for s in shown:
                if s not in self.rows:
                    self.rows.append(s)
        if end:
            self.turns[-1]["end"] = end
            self.open_turn = False
            if end.startswith("declined") and not any(
                    ok in end for ok in ("none", "refuse", "clarify")):
                raise Fail("%s -> %s" % (line, end))

    def call(self, line):
        obs, end = self._send(line)
        self._record(line, obs, end)
        return obs

    def look(self, line):
        """a `search` / `show` / `get` that must find something"""
        obs = self.call(line)
        if obs.startswith("ambiguous") or obs == "no rows":
            raise Fail("look found nothing: %s" % line)
        return obs

    def answer(self, expr):
        """End a read turn: `expr` (a set or a value) IS the answer."""
        value = bool(VALUE.match(expr))
        line = "answer " + expr
        if self.srv.native_answer:
            obs, end = self._send(line)
        else:
            obs, _ = self._send(expr if value else "show " + expr)
            end = None
            if not obs.startswith("ambiguous"):
                _, end = self._send("done")
        if not end:
            raise Fail("%s left the turn open: %s" % (line, obs[:60]))
        self._record(line, obs, end)
        if not value and not ROW.search(obs):
            raise Fail("empty answer")
        if not value:
            prev = self.ctx.get("set")
            if re.search(r"\bthem\b", expr):
                # keep a peekable spelling of the set the conversation is on
                self.ctx["set"] = re.sub(r"\bthem\b", "(%s)" % prev, expr) if prev else None
            elif expr.startswith("#"):
                self.ctx["set"] = None
            else:
                self.ctx["set"] = expr
        return obs

    def done(self):
        """Stop without answering: after `ambiguous: …`, the runtime asks."""
        self.call("done")

    def peek(self, line):
        r = self.srv.ask({"op": "peek", "line": line})
        if "error" in r:
            raise Fail("peek %s: %s" % (line, r["error"]))
        return r.get("rows", r.get("value"))

    def handle(self, label=None, kind=None, rows=None):
        for n, k, lab in (rows if rows is not None else self.last):
            if (label is None or lab == label) and (kind is None or k == kind):
                return n
        raise Fail("no #n for %r %r" % (label, kind))

    def record(self):
        return {"today": self.today, "turns": self.turns}


# -- helpers -------------------------------------------------------------------

def words(label):
    return [w for w in re.findall(r"[A-Za-z][A-Za-z'-]+", label)
            if w.lower() not in STOP and len(w) >= 4 and "'" not in w]


def keyword(rng, label):
    ws = words(label)
    if not ws:
        raise Fail("no keyword in %r" % label)
    return rng.choice(ws)


def phrase(rng, label, two=0.3):
    """one content word of a label, or (sometimes) two adjacent ones"""
    toks = re.findall(r"[A-Za-z][A-Za-z'-]*", label)
    ok = set(words(label))
    pairs = [(a, b) for a, b in zip(toks, toks[1:]) if a in ok and b in ok]
    if pairs and rng.random() < two:
        return "%s %s" % rng.choice(pairs)
    return keyword(rng, label)


def first(label):
    return label.split()[0]


def ordinal(k):
    return ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth",
            "tenth", "eleventh", "twelfth"][k]


def live(rows):
    return [r for r in rows if r.get("live", True) and r.get("label")]


def extra(row):
    return row.get("extra") or {}


def hs(ns):
    return ", ".join("#%d" % n for n in ns)


def q(s):
    return s.replace('"', "")


def n_looks(rng):
    r = rng.random()
    return 0 if r < EXPLORE[0] else (1 if r < EXPLORE[0] + EXPLORE[1] else 2)


def explore(S, rng, looks, n=None):
    """look 0, 1 or 2 times before answering: `looks` are candidate first
    looks; the second is a `get` of a row just shown (or another look)."""
    n = n_looks(rng) if n is None else n
    looks = [x for x in looks if x]
    if not n or not looks:
        return 0
    S.look(rng.choice(looks))
    if n >= 2:
        if S.last and (rng.random() < 0.7 or len(looks) == 1):
            S.look("get #%d" % rng.choice(S.last[:4])[0])
        else:
            S.look(rng.choice([x for x in looks if x != S.turns[-1]["steps"][-1]["call"]] or looks))
    return n


def maybe_get(S, rng, n, p=0.3):
    """after a look that found the row: sometimes `get` it before answering"""
    if rng.random() < p:
        S.look("get #%d" % n)


def peek_ok(S, line):
    """rows of a peek, or none when the runtime declines it"""
    try:
        return S.peek(line)
    except Fail:
        return []


def pick_hint(rng, forms, *args):
    return rng.choice(forms) % args


def unique_label(S, rng, kind, rows, tries=10, two=0.3):
    """(row, phrase) with `(kind called "phrase")` naming exactly that row"""
    for _ in range(tries):
        r = rng.choice(rows)
        try:
            kw = phrase(rng, r["label"], two)
        except Fail:
            continue
        got = S.peek('show (%s called "%s")' % (kind, q(kw)))
        if len(got) == 1 and got[0]["label"] == r["label"]:
            return r, kw
    raise Fail("no uniquely named %s" % kind)


def date_of(row):
    d = row.get("date")
    return d[:10] if d else None


KIND_ENT = {"notes": "note", "documents": "document", "tasks": "task", "events": "event", "photos": "photo",
            "locker items": "locker item", "expenses": "expense", "albums": "album", "places": "place",
            "parties": "party", "groups": "group"}
KIND_SAY = {"notes": "notes", "documents": "documents", "tasks": "to-dos", "events": "calendar events",
            "photos": "photos", "locker items": "locker entries", "expenses": "expenses", "albums": "albums"}


# == first turns ==============================================================
# Each takes (S, rng) and plays one or more turns, leaving S.ctx (what the
# conversation is on) for a follow-up.

# -- name lookup ---------------------------------------------------------------

def c_search_about(S, rng):
    rows = live(S.peek("show (things)"))
    kw = phrase(rng, rng.choice(rows)["label"], 0.25)
    S.turn(pick_hint(rng, ["asks what they have about %s", "asks for everything mentioning %s",
                           "asks to find anything to do with %s", "asks what's in the vault about %s"], kw),
           [kw], "lookup")
    expr = '(things called "%s")' % q(kw)
    if explore(S, rng, ['search "%s"' % q(kw)]) and S.last_full and rng.random() < 0.3 \
            and S.turns[-1]["steps"][-1]["call"].startswith("search"):
        S.answer(hs(n for n, _, _ in S.last))
    else:
        S.answer(expr)
    S.ctx.update(kind="things", kw=kw)


def c_kind_called(S, rng):
    kind = rng.choice(["notes", "documents", "tasks", "events", "photos", "locker items", "expenses", "notes",
                       "documents"])
    ent = KIND_ENT[kind]
    rows = live(S.peek("show (%s)" % kind))
    if not rows:
        raise Fail("no %s" % kind)
    kw = phrase(rng, rng.choice(rows)["label"])
    S.turn(pick_hint(rng, ["asks for their %s about %s", "asks which %s mention %s", "asks to find the %s on %s",
                           "asks if they have any %s about %s"], KIND_SAY[kind], kw), [kw], "lookup")
    expr = '(%s called "%s")' % (kind, q(kw))
    n = n_looks(rng)
    if n:
        S.look('search "%s"' % q(kw))
        picked = [m for m, k, _ in S.last if k == ent]
        if not picked:
            raise Fail("search found no %s" % ent)
        if n == 2:
            S.look("get #%d" % picked[0])
        if S.last_full and rng.random() < 0.5 and n == 1:
            S.answer(hs(picked))
        else:
            S.answer(expr)
    else:
        S.answer(expr)
    S.ctx.update(kind=kind, kw=kw)


def c_when_event(S, rng):
    e, kw = unique_label(S, rng, "events", live(S.peek("show (events)")))
    S.turn(pick_hint(rng, ["asks when the %s is", "asks what time the %s is", "asks what day the %s is on",
                           "asks when they have the %s"], kw), [kw], "lookup")
    expr = '(events called "%s")' % q(kw)
    n = n_looks(rng)
    if n:
        S.look('search "%s"' % q(kw))
        h = S.handle(e["label"], "event")
        if n == 2:
            S.look("get #%d" % h)
        S.answer("#%d" % h if rng.random() < 0.5 else expr)
    else:
        S.answer(expr)
    S.ctx.update(kind="events", kw=kw, focus=S.last[0][0], day=date_of(e), row=e)


def c_find_person(S, rng):
    people = [p for p in live(S.peek("show (parties)")) if p["label"] != "Owner" and " " in p["label"]]
    p = rng.choice(people)
    name = p["label"]
    if rng.random() < 0.4 and len(S.peek('show (parties called "%s")' % first(name))) == 1:
        name = first(name)
    S.turn(pick_hint(rng, ["asks to find %s in their contacts", "asks to pull up %s",
                           "asks for %s's contact card", "asks who %s is"], name), [name], "lookup")
    n = n_looks(rng)
    if n:
        S.look('search "%s"' % q(name))
        h = S.handle(p["label"], "party")
        if n == 2:
            S.look("get #%d" % h)
        S.answer("#%d" % h)
    else:
        S.answer('(parties called "%s")' % q(name))
    S.ctx.update(kind="parties", kw=name, focus=S.last[0][0], person=p)


def c_login(S, rng):
    items = [i for i in live(S.peek("show (locker items)")) if extra(i).get("type") == "login"]
    if not items:
        raise Fail("no logins")
    it, kw = unique_label(S, rng, "locker items", items, two=0.2)
    S.turn(pick_hint(rng, ["asks what the login for %s is (not the password)",
                           "asks which username they use for %s", "asks to see the %s login entry"], kw),
           [kw], "lookup")
    if rng.random() < 0.5:
        S.look('search "%s"' % q(kw))
        h = S.handle(it["label"], "locker item")
        maybe_get(S, rng, h, 0.3)
        S.answer("#%d" % h)
    else:
        S.answer('(locker items called "%s")' % q(kw))
    S.ctx.update(kind="locker items", kw=kw, focus=S.last[0][0])


# -- kind / field routing --------------------------------------------------------

def c_birthday(S, rng):
    dates = live(S.peek("show (important dates)"))
    by = collections.defaultdict(list)
    for d in dates:
        if " — " in d["label"]:
            by[d["label"].split(" — ", 1)[1]].append(d)
    cands = [(nm, ds[0]) for nm, ds in by.items() if len(ds) == 1 and ds[0]["label"].startswith("Birthday")]
    if not cands:
        raise Fail("no birthdays")
    nm, d = rng.choice(cands)
    name = nm
    if rng.random() < 0.3 and len(S.peek('show (parties called "%s")' % first(nm))) == 1:
        name = first(nm)
    S.turn(pick_hint(rng, ["asks when %s's birthday is", "asks what date %s's birthday falls on",
                           "asks whether %s's birthday is coming up", "asks when they need to remember %s's birthday"],
                     name), [name], "route")
    r = rng.random()
    if r < 0.5:
        explore(S, rng, ['search "%s"' % q(name)], n=0 if rng.random() < 0.8 else 1)
        S.answer('(important dates called "%s")' % q(name))
    elif r < 0.75:
        S.look('search "%s"' % q(name))
        S.answer("(important dates of (#%d))" % S.handle(nm, "party"))
    else:
        S.answer('(important dates of (parties called "%s"))' % q(name))
    S.ctx.update(kind="important dates", kw=name)


def c_dates_window(S, rng):
    for _ in range(6):
        w = rng.choice(["this month", "next month", "next 2 weeks", "this week", "next week"])
        if S.peek("show (important dates during %s)" % w):
            break
    else:
        raise Fail("no dates soon")
    S.turn(pick_hint(rng, ["asks whose birthdays are coming up %s", "asks what birthdays or anniversaries there are %s",
                           "asks which important dates fall %s"], w), [w], "route")
    explore(S, rng, ["show (important dates)"], n=0 if rng.random() < 0.8 else 1)
    S.answer("(important dates during %s)" % w)
    S.ctx.update(kind="important dates", window=w)


def c_last_spoke(S, rng):
    acts = live(S.peek("show (activities)"))
    names = sorted({a["label"].split(" — ", 1)[1] for a in acts if " — " in a["label"]})
    names = [n for n in names if len(S.peek('show (parties called "%s")' % n)) == 1]
    if not names:
        raise Fail("no activities")
    nm = rng.choice(names)
    name = nm if rng.random() < 0.7 or len(S.peek('show (parties called "%s")' % first(nm))) != 1 else first(nm)
    S.turn(pick_hint(rng, ["asks when they last spoke to %s", "asks when they last heard from %s",
                           "asks when they last caught up with %s", "asks what they last talked about with %s",
                           "asks when they were last in touch with %s"], name), [name], "route")
    if rng.random() < 0.55:
        S.look('search "%s"' % q(name))
        h = S.handle(nm, "party")
        maybe_get(S, rng, h, 0.25)
        S.answer("(activities of (#%d))" % h)
    else:
        S.answer('(activities of (parties called "%s"))' % q(name))
    S.ctx.update(kind="activities", kw=name)


def c_locker_lookup(S, rng):
    tails = ["wifi", "PIN", "code", "portal", "account", "password", "backup codes", "app", "login"]
    items = []
    for i in live(S.peek("show (locker items)")):
        for t in tails:
            if i["label"].endswith(" " + t) and len(i["label"]) > len(t) + 1:
                items.append((i, i["label"][:-len(t) - 1], t))
                break
    if not items:
        raise Fail("no locker items with a tail")
    rng.shuffle(items)
    for it, name, tail in items:
        name_w = words(name)
        if not name_w:
            continue
        kw = name if len(name.split()) <= 2 else " ".join(name.split()[:2])
        got = S.peek('show (locker items called "%s %s")' % (q(kw), tail))
        if len(got) == 1:
            break
    else:
        raise Fail("no unique locker item")
    hint = {"wifi": ["asks what the wifi is at the %s", "asks for the %s wifi details"],
            "PIN": ["asks what the %s PIN is", "asks for the PIN for the %s"],
            "code": ["asks what the %s code is", "asks for the code for the %s"],
            }.get(tail, ["asks for the %s " + tail + " entry", "asks where the %s " + tail + " details are"])
    S.turn(pick_hint(rng, hint, kw), [kw], "route")
    expr = '(locker items called "%s %s")' % (q(kw), tail)
    n = n_looks(rng)
    if n:
        S.look('search "%s"' % q(kw))
        h = S.handle(it["label"], "locker item")
        if n == 2:
            S.look("get #%d" % h)
        S.answer("#%d" % h if rng.random() < 0.5 else expr)
    else:
        S.answer(expr)
    S.ctx.update(kind="locker items", kw=kw, focus=S.last[0][0])


def c_no_deadline(S, rng):
    expr = '(tasks that (due_at is null and status != "completed"))'
    if not S.peek("show " + expr):
        raise Fail("no undated tasks")
    S.turn(rng.choice(["asks which to-dos have no deadline", "asks what tasks have no due date",
                       "asks what's on their list with no date set", "asks for the someday tasks with no deadline",
                       "asks which open tasks aren't scheduled for any date"]), [], "route")
    explore(S, rng, ['show (tasks that (status != "completed"))', "show (tasks)"])
    S.answer(expr)
    S.ctx.update(kind="tasks")


def c_ticked_off(S, rng):
    if rng.random() < 0.8:
        w = rng.choice(["today", "this week", "recently"])
        S.turn(pick_hint(rng, ["asks what they ticked off %s", "asks what they got done %s",
                               "asks which tasks they finished %s", "asks what they have completed %s",
                               "asks which to-dos they checked off %s"], w), [w], "route")
        explore(S, rng, ['show (tasks that (status = "completed"))'])
        S.answer("(tasks that (completed_at during %s))" % w)
    else:
        S.turn(rng.choice(["asks which tasks they have finished", "asks what they have already done on their list",
                           "asks for their completed to-dos"]), [], "route")
        S.answer('(tasks that (status = "completed"))')
    S.ctx.update(kind="tasks")


def c_due(S, rng):
    for _ in range(8):
        w = rng.choice(DAYS + ["today", "tomorrow", "this week", "next week", "this weekend"])
        expr = '(tasks that (due_at during %s and status != "completed"))' % w
        if S.peek("show " + expr):
            break
    else:
        raise Fail("nothing due")
    S.turn(pick_hint(rng, ["asks what is due %s", "asks which to-dos are due %s", "asks what tasks are due %s",
                           "asks what they have to get done %s"], w), [w], "route")
    explore(S, rng, ['show (tasks that (status != "completed"))', "show (tasks during %s)" % w])
    S.answer(expr)
    S.ctx.update(kind="tasks", window=w)


def c_open_tasks(S, rng):
    if rng.random() < 0.6:
        S.turn(rng.choice(["asks which tasks are still open", "asks what's still on their list",
                           "asks what they still have to do", "asks what's left on their to-do list",
                           "asks what they haven't done yet"]), [], "route")
        explore(S, rng, ["show (tasks)"])
        S.answer('(tasks that (status != "completed"))')
    else:
        S.turn(rng.choice(["asks what is overdue", "asks what they're behind on",
                           "asks which to-dos are past their due date and not done"]), [], "route")
        explore(S, rng, ['show (tasks that (status != "completed"))'])
        S.answer('(tasks that (due_at during before now and status != "completed"))')
    S.ctx.update(kind="tasks")


def c_favourites(S, rng):
    if rng.random() < 0.6:
        S.turn(rng.choice(["asks for their favourite photos", "asks for the pictures they marked as favourites",
                           "asks which photos they hearted", "asks to see their favourited pics"]), [], "route")
        explore(S, rng, ["show (photos)"])
        S.answer("(photos that (favorite = true))")
        S.ctx.update(kind="photos")
    else:
        S.turn(rng.choice(["asks which documents they starred", "asks for their starred files",
                           "asks to see the documents they marked with a star"]), [], "route")
        explore(S, rng, ["show (documents)"])
        S.answer("(documents that (starred = true))")
        S.ctx.update(kind="documents")


def c_folder(S, rng):
    docs = live(S.peek("show (documents)"))
    folders = sorted({extra(d).get("folder") for d in docs} - {None, ""})
    if not folders:
        raise Fail("no folders")
    f = rng.choice(folders)
    S.turn(pick_hint(rng, ["asks what is in their %s folder", "asks what they have filed under %s",
                           "asks for the documents in the %s folder", "asks what paperwork is kept in %s"], f),
           [f], "route")
    explore(S, rng, ["show (documents)"])
    S.answer('(documents that (folder = "%s"))' % f)
    S.ctx.update(kind="documents", folder=f)


def c_notebook(S, rng):
    notes = live(S.peek("show (notes)"))
    nbs = sorted({x for d in notes for x in (extra(d).get("notebooks") or "").split(", ")} - {""})
    if not nbs:
        raise Fail("no notebooks")
    nb = rng.choice(nbs)
    S.turn(pick_hint(rng, ["asks for the notes in their %s notebook", "asks what's in the %s notebook",
                           "asks what they've written in the %s notebook"], nb), [nb], "route")
    explore(S, rng, ["show (notes)", "show (notebooks)"])
    S.answer('(notes that (notebooks contains "%s"))' % nb)
    S.ctx.update(kind="notes")


def c_journal(S, rng):
    if rng.random() < 0.75:
        for _ in range(6):
            w = rng.choice(["last weekend", "this week", "last week", "yesterday", "recently", "this month"])
            if S.peek("show (journal notes) during %s" % w):
                break
        else:
            raise Fail("no journal in window")
        S.turn(pick_hint(rng, ["asks what they wrote in their journal %s", "asks for their journal entries from %s",
                               "asks to see the diary entries they made %s"], w), [w], "route")
        explore(S, rng, ["show (journal notes)"])
        S.answer("(journal notes) during %s" % w)
    else:
        if not S.peek("show (journal notes)"):
            raise Fail("no journal")
        S.turn(rng.choice(["asks what the last thing they wrote in their journal was",
                           "asks for their most recent journal entry"]), [], "route")
        explore(S, rng, ["show (journal notes)"], n=0 if rng.random() < 0.7 else 1)
        S.answer("first 1 of ((journal notes) ordered by dtstart desc)")
    S.ctx.update(kind="journal notes")


def c_places(S, rng):
    if rng.random() < 0.6:
        if not S.peek("show places"):
            raise Fail("no places")
        S.turn(rng.choice(["asks what places they have in their photos", "asks which places their photos were taken at",
                           "asks for the list of places in their photo library"]), [], "route")
        explore(S, rng, ["show (photos)"], n=0 if rng.random() < 0.8 else 1)
        S.answer("places")
    else:
        k = rng.choice([1, 2, 2, 3])
        expr = "(places that (count of photos = %d))" % k
        if not S.peek("show " + expr):
            raise Fail("no place with %d photos" % k)
        S.turn("asks which places they have exactly %s photo%s from" % (["", "one", "two", "three"][k],
                                                                      "" if k == 1 else "s"),
               [["", "one", "two", "three"][k]], "route")
        explore(S, rng, ["show (places)"])
        S.answer(expr)
    S.ctx.update(kind="places")


def c_effort(S, rng):
    tasks = live(S.peek("show (tasks)"))
    vals = sorted({extra(t).get("effort_min") for t in tasks} - {None})
    if not vals:
        raise Fail("no effort")
    v = rng.choice(vals)
    S.turn(pick_hint(rng, ["asks which tasks take about %s minutes", "asks for the %s-minute jobs on their list",
                           "asks which to-dos are estimated at %s minutes"], v), [v], "route")
    explore(S, rng, ["show (tasks)"])
    S.answer("(tasks that (effort_min = %s))" % v)
    S.ctx.update(kind="tasks")


def c_agenda(S, rng):
    for _ in range(6):
        w = rng.choice(DAYS + WINDOWS + ["next friday", "next monday"])
        if S.peek("show (things during %s)" % w):
            break
    else:
        raise Fail("empty agenda")
    r = rng.random()
    if r < 0.35 and S.peek("show (events during %s)" % w):
        S.turn(pick_hint(rng, ["asks what is on their calendar %s", "asks which events they have %s",
                               "asks what appointments they have %s"], w), [w], "route")
        explore(S, rng, ["show (things during %s)" % w], n=0 if rng.random() < 0.7 else 1)
        S.answer("(events during %s)" % w)
        S.ctx.update(kind="events")
    elif r < 0.7:
        S.turn(pick_hint(rng, ["asks what they have on %s (calendar, to-dos, birthdays)",
                               "asks what's happening %s", "asks if anything is going on %s"], w), [w], "route")
        explore(S, rng, ["show (events during %s)" % w], n=0 if rng.random() < 0.7 else 1)
        S.answer("(things during %s)" % w)
        S.ctx.update(kind="things")
    else:
        S.turn(pick_hint(rng, ["asks for their schedule %s in order", "asks to run through their day %s in time order",
                               "asks what their plan for %s looks like, earliest first"], w), [w], "route")
        S.answer("(things during %s) ordered by dtstart asc" % w)
        S.ctx.update(kind="things")
    S.ctx["window"] = w


def c_day_of_month(S, rng):
    y, m, d = (int(x) for x in S.date.split("-"))
    for _ in range(6):
        dd = rng.randint(d + 1, min(d + 12, 28)) if d < 27 else rng.randint(1, 20)
        suf = "th" if 10 <= dd % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(dd % 10, "th")
        w = "the %d%s" % (dd, suf)
        if S.peek("show (things during %s)" % w):
            break
    else:
        raise Fail("empty day of month")
    S.turn(pick_hint(rng, ["asks if anything is happening on %s", "asks what they have on %s"], w), [w], "route")
    S.answer("(things during %s) ordered by dtstart asc" % w if rng.random() < 0.5 else "(things during %s)" % w)
    S.ctx.update(kind="things", window=w)


def c_owed(S, rng):
    if rng.random() < 0.5:
        expr = "(parties that (owed_to_me_minor > 0))"
        hint = rng.choice(["asks who owes them money", "asks who still has to pay them back"])
    else:
        expr = "(parties that (owed_to_them_minor > 0))"
        hint = rng.choice(["asks who they owe money to", "asks who they still have to pay back"])
    if not S.peek("show " + expr):
        raise Fail("no debts")
    S.turn(hint, [], "route")
    S.answer(expr)
    S.ctx.update(kind="parties")


def c_contact(S, rng):
    kind = rng.choice(["phone", "email"])
    people = [p for p in live(S.peek("show (parties)")) if p["label"] != "Owner"]
    for _ in range(10):
        p = rng.choice(people)
        if peek_ok(S, 'show (contact channels of (parties called "%s") that (kind = "%s"))' % (q(p["label"]), kind)) \
                and len(S.peek('show (parties called "%s")' % q(p["label"]))) == 1:
            break
    else:
        raise Fail("no %s numbers" % kind)
    name = p["label"]
    if " " in name and rng.random() < 0.4 and len(S.peek('show (parties called "%s")' % q(first(name)))) == 1:
        name = first(name)
    word = {"phone": ["phone number", "number", "mobile number"], "email": ["email address", "email"]}[kind]
    S.turn(pick_hint(rng, ["asks for %s's " + rng.choice(word), "asks what %s's " + rng.choice(word) + " is"], name),
           [name], "link" if rng.random() < 0.5 else "route")
    if rng.random() < 0.6:
        S.look('search "%s"' % q(name))
        h = S.handle(p["label"], "party")
        maybe_get(S, rng, h, 0.2)
        S.answer('(contact channels of (#%d)) that (kind = "%s")' % (h, kind))
    else:
        S.answer('(contact channels of (parties called "%s")) that (kind = "%s")' % (q(name), kind))
    S.ctx.update(kind="contact channels")


def c_expenses_over(S, rng):
    for _ in range(6):
        amt = rng.choice([20, 25, 30, 40, 50, 75, 100, 150])
        expr = "(expenses that (amount_minor > %d))" % (amt * 100)
        got = S.peek("show " + expr)
        if 0 < len(got) <= 12:
            break
    else:
        raise Fail("no expense band")
    S.turn("asks which expenses were over %d (money)" % amt, [str(amt)], "route")
    explore(S, rng, ["show (expenses)"])
    S.answer(expr)
    S.ctx.update(kind="expenses")


def c_count(S, rng):
    opts = [("asks how many open tasks they have", 'count of (tasks that (status != "completed"))', []),
            ("asks how many photos they have marked as favourites", "count of (photos that (favorite = true))", []),
            ("asks how many notes they have", "count of (notes)", [])]
    for w in ["this week", "next week", "tomorrow", "this weekend"]:
        opts.append(("asks how many events they have %s" % w, "count of (events during %s)" % w, [w]))
    h, expr, say = rng.choice(opts)
    S.turn(h, say, "route")
    S.answer(expr)


# -- link walks --------------------------------------------------------------------

def c_event_people(S, rng):
    events = [e for e in live(S.peek("show (events)")) if extra(e).get("attendee_party_ids")]
    if not events:
        raise Fail("no event with attendees")
    e, kw = unique_label(S, rng, "events", events)
    S.turn(pick_hint(rng, ["asks who is coming to the %s", "asks who'll be at the %s", "asks who they're seeing at the %s"],
                     kw), [kw], "link")
    if rng.random() < 0.3:
        S.answer('(parties of (events called "%s"))' % q(kw))
        S.ctx.update(kind="parties")
        return
    S.look('search "%s"' % q(kw) if rng.random() < 0.7 else 'show (events called "%s")' % q(kw))
    n = S.handle(e["label"], "event")
    maybe_get(S, rng, n, 0.25)
    S.answer("(parties of (#%d))" % n)
    S.ctx.update(kind="parties", event=n)


def c_album_photos(S, rng):
    albums = live(S.peek("show (albums)"))
    if not albums:
        raise Fail("no albums")
    a, kw = unique_label(S, rng, "albums", albums, two=0.4)
    if not S.peek('show (photos of (albums called "%s"))' % q(kw)):
        raise Fail("empty album")
    S.turn(pick_hint(rng, ["asks for the photos in the %s album", "asks to see the %s album",
                           "asks what pictures are in the %s album"], kw), [kw], "link")
    if rng.random() < 0.35:
        S.answer('(photos of (albums called "%s"))' % q(kw))
    else:
        S.look('search "%s"' % q(kw) if rng.random() < 0.6 else 'show (albums called "%s")' % q(kw))
        n = S.handle(a["label"], "album")
        maybe_get(S, rng, n, 0.2)
        S.answer("(photos of (#%d))" % n)
        S.ctx["album"] = n
    S.ctx.update(kind="photos")


def c_place_photos(S, rng):
    places = [p for p in live(S.peek("show (places)"))
              if S.peek('show (photos of (places called "%s"))' % q(p["label"]))]
    if not places:
        raise Fail("no place with photos")
    p, kw = unique_label(S, rng, "places", places, two=0.5)
    S.turn(pick_hint(rng, ["asks for photos taken at %s", "asks for their pictures from %s",
                           "asks what photos they have from %s"], kw), [kw], "link")
    if rng.random() < 0.35:
        S.answer('(photos of (places called "%s"))' % q(kw))
    else:
        S.look('search "%s"' % q(kw) if rng.random() < 0.6 else 'show (places called "%s")' % q(kw))
        n = S.handle(p["label"], "place")
        maybe_get(S, rng, n, 0.15)
        S.answer("(photos of (#%d))" % n)
    S.ctx.update(kind="photos")


def _photos_with(S, link):
    out = []
    for p in live(S.peek("show (photos)")):
        if link == "albums" and extra(p).get("album_titles"):
            out.append(p)
    if link == "places":
        for pl in live(S.peek("show (places)")):
            out += live(S.peek('show (photos of (places called "%s"))' % q(pl["label"])))
    return out


def c_photo_link(S, rng):
    link = rng.choice(["places", "albums"])
    photos = _photos_with(S, link)
    if not photos:
        raise Fail("no photo with %s" % link)
    ph, kw = unique_label(S, rng, "photos", photos, two=0.4)
    S.turn(pick_hint(rng, {"places": ["asks where the %s photo was taken", "asks where they took the %s picture"],
                           "albums": ["asks which album the %s photo is in", "asks what album has the %s picture"]}[link],
                     kw), [kw], "link")
    S.look('search "%s"' % q(kw) if rng.random() < 0.6 else 'show (photos called "%s")' % q(kw))
    n = S.handle(ph["label"], "photo")
    maybe_get(S, rng, n, 0.3)
    S.answer("(%s of (#%d))" % (link, n))
    S.ctx.update(kind=link, photo=n)
    if link == "albums":
        S.ctx["album"] = S.last[0][0]


def c_subtasks(S, rng):
    tasks = live(S.peek("show (tasks)"))
    by_id = {t["id"]: t for t in tasks}
    kids = collections.defaultdict(list)
    for t in tasks:
        pid = extra(t).get("parent_task_id")
        if pid in by_id:
            kids[pid].append(t)
    parents = [(by_id[pid], subs) for pid, subs in kids.items()
               if "(" not in by_id[pid]["label"]
               and len(S.peek('show (tasks called "%s")' % q(by_id[pid]["label"]))) == 1]
    if not parents:
        raise Fail("no parent task")
    t, subs = rng.choice(parents)
    kw = t["label"]
    open_ = [s for s in subs if extra(s).get("status") != "completed"]
    if open_ and rng.random() < 0.6:
        S.turn(pick_hint(rng, ["asks what's left to do on the '%s' task", "asks which steps of '%s' are still open"], kw),
               [kw], "link")
        tail = ' that (status != "completed")'
    else:
        S.turn(pick_hint(rng, ["asks what the steps under '%s' are", "asks for the subtasks of '%s'"], kw), [kw], "link")
        tail = ""
    S.look('search "%s"' % q(kw) if rng.random() < 0.5 else 'show (tasks called "%s")' % q(kw))
    S.answer("(tasks of (#%d))%s" % (S.handle(t["label"], "task"), tail))
    S.ctx.update(kind="tasks")


def c_group_total(S, rng):
    groups = live(S.peek("show (groups)"))
    g, kw = unique_label(S, rng, "groups", groups, two=0.4)
    S.turn(pick_hint(rng, ["asks how much has been spent in the %s group", "asks what the %s group's spending comes to"],
                     kw), [kw], "link")
    S.look('search "%s"' % q(kw))
    n = S.handle(g["label"], "group")
    S.answer("sum amount_minor of (expenses of (#%d))" % n)
    S.ctx.update(kind="groups", group=n)
    return n


def c_balance(S, rng):
    groups = live(S.peek("show (groups)"))
    g, kw = unique_label(S, rng, "groups", groups, two=0.4)
    S.turn(pick_hint(rng, ["asks for the members of the %s group", "asks who is in the %s group"], kw), [kw], "link")
    S.look('search "%s"' % q(kw))
    n = S.handle(g["label"], "group")
    S.answer("(members of (#%d)) that (party_id is not me)" % n)
    others = list(S.last)
    S.ctx.update(kind="members", group=n)
    if not others or rng.random() < 0.4:
        return
    m, _, lab = rng.choice(others)
    S.turn("asks how much %s owes them in that group" % first(lab), [first(lab)], "follow")
    S.answer("balance of (#%d) in (#%d)" % (m, n))


def c_debts_person(S, rng):
    rows = live(S.peek("show (parties that (owed_to_me_minor > 0 or owed_to_them_minor > 0))"))
    rows = [r for r in rows if len(S.peek('show (parties called "%s")' % q(r["label"]))) == 1]
    if not rows:
        raise Fail("no debts")
    p = rng.choice(rows)
    name = p["label"]
    S.turn(rng.choice(["asks whether they owe %s anything", "asks whether %s owes them anything",
                       "asks what debts there are between them and %s"]) % name, [name], "link")
    if rng.random() < 0.3:
        S.answer('(obligations of (parties called "%s"))' % q(name))
    else:
        S.look('search "%s"' % q(name))
        S.answer("(obligations of (#%d))" % S.handle(name, "party"))
    S.ctx.update(kind="obligations")


def c_phone(S, rng):
    return c_contact(S, rng)


# -- writes ------------------------------------------------------------------------

def c_add_task(S, rng):
    verbs = ["Call", "Book", "Renew", "Order", "Return", "Fix", "Pay", "Email", "Collect", "Cancel", "Check", "Buy"]
    things = ["the plumber", "the car service", "the library books", "the gym pass", "new batteries",
              "the council tax", "the vet appointment", "the parcel", "the window cleaner",
              "the boiler check", "the insurance renewal", "school shoes", "the ferry tickets", "the lawnmower",
              "the dentist", "the chimney sweep", "the passport forms", "the birthday cake"]
    title = "%s %s" % (rng.choice(verbs), rng.choice(things))
    if rng.random() < 0.6:
        d = rng.choice(DAYS + ["tomorrow", "next friday", "next monday"])
        if rng.random() < 0.3:
            t = rng.choice(["09:00", "14:00", "17:30", "11:00"])
            S.turn("asks to add a task '%s' for %s at %s" % (title, d, t), [title, d], "write")
            S.call('schedule.add_task{title: "%s", due_at: %s at %s}' % (title, d, t))
        else:
            S.turn("asks to add a task '%s' for %s" % (title, d), [title, d], "write")
            S.call('schedule.add_task{title: "%s", due_at: %s}' % (title, d))
    else:
        S.turn("asks to add a task '%s'" % title, [title], "write")
        S.call('schedule.add_task{title: "%s"}' % title)


def c_reschedule(S, rng):
    kind, ent = rng.choice([("tasks", "task"), ("events", "event")])
    rows = live(S.peek("show (%s)" % kind))
    if kind == "tasks":
        rows = [r for r in rows if extra(r).get("status") != "completed"]
    r, kw = unique_label(S, rng, kind, rows, two=0.2)
    d = rng.choice(DAYS + ["tomorrow", "next friday"])
    S.turn("asks to move the %s %s to %s" % (kw, "task" if ent == "task" else "appointment", d), [kw, d], "write")
    S.look('search "%s"' % q(kw) if rng.random() < 0.7 else 'show (%s called "%s")' % (kind, q(kw)))
    n = S.handle(r["label"], ent)
    S.call("reschedule{to: %s} on #%d" % (d, n))
    return n, ent


def c_complete(S, rng):
    rows = [r for r in live(S.peek("show (tasks)")) if extra(r).get("status") != "completed"]
    r, kw = unique_label(S, rng, "tasks", rows, two=0.2)
    S.turn(pick_hint(rng, ["says the %s task is done", "asks to tick off the %s task"], kw), [kw], "write")
    S.look('search "%s"' % q(kw))
    n = S.handle(r["label"], "task")
    S.call("complete{} on #%d" % n)


def c_log(S, rng):
    people = [p for p in live(S.peek("show (parties)")) if p["label"] != "Owner"]
    p = rng.choice(people)
    kind = rng.choice(["call", "coffee", "visit", "message"])
    name = first(p["label"])
    S.turn("asks to log that they had a %s with %s" % (kind, name), [name], "write")
    S.look('search "%s"' % name)
    cands = [n for n, k, lab in S.last if k == "party" and lab.split()[0] == name]
    if len(cands) != 1:
        raise Fail("ambiguous or missing person")
    S.call('people.log_interaction{kind: "%s"} on #%d' % (kind, cands[0]))


def c_add_expense(S, rng):
    g, kw = unique_label(S, rng, "groups", live(S.peek("show (groups)")), two=0.3)
    what = rng.choice(["Petrol", "Groceries", "Dinner", "Taxi", "Parking", "Tickets", "Firewood",
                       "Coffee", "Ferry", "Snacks", "Pizza", "Museum", "Bike hire"])
    amount = rng.choice([12, 18, 25, 30, 42, 55, 60, 75, 90, 120])
    S.turn("asks to add %d (money) for %s to the %s group, paid by them" % (amount, what.lower(), kw),
           [kw, what.lower()], "write")
    S.look('search "%s"' % q(kw))
    n = S.handle(g["label"], "group")
    S.call('tally.add_expense{description: "%s", amount_minor: %d, paid_by: me, group_id: (#%d)}'
           % (what.lower(), amount * 100, n))


def c_doc_write(S, rng):
    d, kw = unique_label(S, rng, "documents", live(S.peek("show (documents)")), two=0.3)
    verb, call = rng.choice([("bin", "core.trash_document{}"), ("star", "core.star_document{}")])
    S.turn("asks to %s the %s document" % (verb, kw), [kw], "write")
    S.look('search "%s"' % q(kw))
    n = S.handle(d["label"], "document")
    S.call("%s on #%d" % (call, n))


def c_locker_add(S, rng):
    what = rng.choice(["gate code", "alarm code", "bike lock code", "garage code", "wifi at the shed",
                       "locker combination", "safe code", "studio door code", "boat shed PIN"])
    code = "%d" % rng.randint(1000, 99999)
    title = what[0].upper() + what[1:]
    S.turn("asks to save the %s %s in the locker" % (what, code), [what, code], "write")
    S.call('locker.add_item{type: "note", title: "%s", content: "%s"}' % (title, code))


def c_propose_event(S, rng):
    what = rng.choice(["Haircut", "Dentist check-up", "Coffee with the neighbours", "Car MOT", "Yoga class",
                       "Parents evening", "Piano lesson", "Boiler service", "Team lunch", "Swimming lesson",
                       "Pottery taster", "Eye test", "Book club", "Vet visit"])
    d = rng.choice(DAYS + ["tomorrow", "next friday"])
    t = rng.choice(["09:00", "10:30", "13:00", "14:00", "16:30", "18:00"])
    S.turn("asks to put '%s' in the calendar %s at %s" % (what, d, t), [what, d], "write")
    S.call('schedule.propose_event{summary: "%s", dtstart: %s at %s}' % (what, d, t))


def c_create_note(S, rng):
    title = rng.choice(["Ideas for the garden party", "Questions for the builder", "Books to read this summer",
                        "Things to pack for the ferry", "Recipes to try", "Gift ideas for the twins",
                        "Plan for the loft clear-out", "Films to watch", "Names for the puppy",
                        "Walks near the coast"])
    S.turn("asks to make a note called '%s'" % title, [title], "write")
    S.call('knowledge.create_note{title: "%s"}' % title)


def c_delete_many(S, rng):
    notes = live(S.peek("show (notes)"))
    fams = {}
    for n in notes:
        m = re.match(r"^(.*) \(wk \d+\)$", n["label"])
        if m:
            fams.setdefault(m.group(1), []).append(n)
    fams = {f: ns for f, ns in fams.items() if len(ns) >= 2}
    if not fams:
        raise Fail("no note family")
    fam = rng.choice(sorted(fams))
    S.turn("asks to delete all their %s notes" % fam.lower(), [fam.lower()], "write")
    S.look('search "%s"' % fam)
    picked = [n for n, k, lab in S.last if k == "note" and lab.startswith(fam + " (wk")]
    if len(picked) < 2:
        raise Fail("family not shown")
    S.call("delete{} on %s" % hs(picked))


def c_bulk_reschedule(S, rng):
    w = rng.choice(["today", "tomorrow"] + DAYS)
    rows = live(S.peek('show (tasks that (due_at during %s and status != "completed"))' % w))
    if not 2 <= len(rows) <= 5:
        raise Fail("no bulk")
    d = rng.choice([x for x in DAYS + ["next monday"] if x != w])
    S.turn("asks to move all their open tasks due %s to %s" % (w, d), [w, d], "write")
    S.look('show (tasks that (due_at during %s and status != "completed"))' % w)
    S.call("reschedule{to: %s} on %s" % (d, hs(n for n, _, _ in S.last)))


# -- ambiguity / trash / nothing / refuse ----------------------------------------------

def c_refuse(S, rng):
    hint, reason = rng.choice([
        ("asks what the weather will be tomorrow", "out_of_ontology"),
        ("asks to book a table at a restaurant", "out_of_ontology"),
        ("asks for the latest football scores", "out_of_ontology"),
        ("asks to order more printer ink online", "out_of_ontology"),
        ("asks for train times to the city", "out_of_ontology"),
        ("asks to delete everything in the vault", "unbounded_destruction"),
        ("asks to wipe all their photos and notes at once", "unbounded_destruction"),
        ("asks to make up a new password for a website", "fabricated_secret"),
        ("asks to email their bank password to a friend", "sealed_egress"),
        ("asks to text the alarm code to the neighbour", "sealed_egress"),
    ])
    S.turn(hint, [], "edge")
    S.call("refuse: %s" % reason)


def trashed(S, kind):
    return [r for r in S.peek("show (%s that (deleted_at is not null))" % kind) if r.get("label")]


def only_trashed_keyword(S, rng, kind, row):
    """A word of a trashed row's title that no LIVE row of the kind answers to."""
    ws = words(row["label"])
    rng.shuffle(ws)
    for w in ws:
        if not S.peek('show (%s called "%s")' % (kind, w)):
            return w
    raise Fail("every word of %r names a live row too" % row["label"])


def c_trash_write(S, rng):
    kind, word = rng.choice([("notes", "note"), ("documents", "document")])
    rows = trashed(S, kind)
    if not rows:
        raise Fail("no trashed %s" % kind)
    kw = only_trashed_keyword(S, rng, kind, rng.choice(rows))
    S.turn("asks to delete the %s %s" % (kw, word), [kw], "edge")
    obs = S.call('delete{} on (%s called "%s")' % (kind, kw))
    if not obs.startswith("no live rows"):
        raise Fail("trash write did not find the trash: %s" % obs[:60])
    S.call("nothing")


def c_restore(S, rng):
    kind, word, ent = rng.choice([("notes", "note", "note"), ("documents", "document", "document")])
    rows = trashed(S, kind)
    if not rows:
        raise Fail("no trashed %s" % kind)
    row = rng.choice(rows)
    kw = only_trashed_keyword(S, rng, kind, row)
    S.turn("asks to put back the %s %s they deleted" % (kw, word), [kw], "edge")
    S.call('show (%s called "%s") that (deleted_at is not null)' % (kind, kw))
    S.call("restore{} on #%d" % S.handle(row["label"], ent))


def c_trashed_check(S, rng):
    kind, word, ent = rng.choice([("notes", "note", "note"), ("documents", "document", "document")])
    rows = trashed(S, kind)
    if not rows:
        raise Fail("no trashed %s" % kind)
    row = rng.choice(rows)
    kw = only_trashed_keyword(S, rng, kind, row)
    S.turn(pick_hint(rng, ["asks whether they binned the %s " + word, "asks if the %s " + word + " is in the trash"], kw),
           [kw], "edge")
    S.look('show (%s called "%s") that (deleted_at is not null)' % (kind, kw))
    S.answer("#%d" % S.handle(row["label"], ent))


def shared_first(S, rng):
    people = [p for p in live(S.peek("show (parties)")) if p["label"] != "Owner" and " " in p["label"]]
    firsts = {}
    for p in people:
        firsts.setdefault(first(p["label"]), []).append(p)
    shared = [ps for ps in firsts.values() if len(ps) > 1]
    if not shared:
        raise Fail("no shared first name")
    return rng.choice(shared)


def c_write_ambiguous(S, rng):
    ps = shared_first(S, rng)
    name = first(ps[0]["label"])
    kind = rng.choice(["call", "coffee", "visit", "message"])
    S.turn("asks to log a %s with %s (several people are called %s)" % (kind, name, name), [name], "edge")
    obs = S.call('people.log_interaction{kind: "%s"} on (parties called "%s")' % (kind, name))
    if not obs.startswith("ambiguous"):
        raise Fail("write on a shared name was not ambiguous: %s" % obs[:60])
    S.done()
    if rng.random() < 0.6:
        p = rng.choice(ps)
        surname = p["label"].split()[-1]
        S.turn("says it was %s (the %s one)" % (p["label"], surname), [surname], "write")
        S.look('search "%s"' % p["label"])
        S.call('people.log_interaction{kind: "%s"} on #%d' % (kind, S.handle(p["label"], "party")))


def c_read_shared_name(S, rng):
    """a read over a shared first name answers every one of them (the runtime asks if it must)"""
    ps = shared_first(S, rng)
    name = first(ps[0]["label"])
    S.turn(pick_hint(rng, ["asks to find %s in their contacts (several people are called %s)",
                           "asks who %s is (several people are called %s)"], name, name), [name], "edge")
    S.answer('(parties called "%s")' % name)
    S.ctx.update(kind="parties", kw=name)


FIRST = [
    # name lookup
    (c_search_about, 9), (c_kind_called, 15), (c_when_event, 6), (c_find_person, 6), (c_login, 2.5),
    # routing
    (c_birthday, 2.5), (c_dates_window, 1.5), (c_last_spoke, 2.5), (c_locker_lookup, 2.5), (c_no_deadline, 2),
    (c_ticked_off, 2), (c_due, 2.5), (c_open_tasks, 2.5), (c_favourites, 2), (c_folder, 2.5), (c_notebook, 1.5),
    (c_journal, 2), (c_places, 1.5), (c_effort, 1), (c_agenda, 2.5), (c_day_of_month, 1), (c_owed, 1.5),
    (c_contact, 2.5), (c_expenses_over, 1.5), (c_count, 0.8),
    # link walks
    (c_event_people, 3), (c_album_photos, 2), (c_place_photos, 2), (c_photo_link, 2.5), (c_subtasks, 1.5),
    (c_group_total, 1), (c_balance, 1.2), (c_debts_person, 1.5),
    # writes
    (c_add_task, 2), (c_reschedule, 2), (c_complete, 1.5), (c_log, 1.5), (c_add_expense, 1.5),
    (c_doc_write, 1.5), (c_locker_add, 0.7), (c_propose_event, 1.5), (c_create_note, 0.8), (c_delete_many, 0.8),
    (c_bulk_reschedule, 0.8),
    # edges
    (c_refuse, 3), (c_trash_write, 1.2), (c_restore, 1.2), (c_trashed_check, 1), (c_write_ambiguous, 1.5),
    (c_read_shared_name, 0.8),
]


# == follow-ups: act on what the last turn showed ================================
# Each checks that it applies (peeks only) BEFORE opening its turn.

def _them_ok(S):
    if not S.turns or not S.turns[-1]["steps"] or not S.turns[-1]["steps"][-1]["call"].startswith("answer"):
        raise Fail("last turn did not answer")
    if len(S.last) < 2:
        raise Fail("few rows")


def f_narrow_window(S, rng):
    _them_ok(S)
    cur = S.ctx.get("set")
    if not cur or S.ctx.get("kind") not in ("events", "things", "tasks", "journal notes", "important dates"):
        raise Fail("not dated")
    allw = ["this weekend", "today", "tomorrow", "this week", "next week"] + DAYS
    rng.shuffle(allw)
    base = S.peek("show %s" % cur)
    for w in allw:
        if w == S.ctx.get("window"):
            continue
        got = S.peek("show ((%s) during %s)" % (cur, w))
        if got and len(got) < len(base):
            break
    else:
        raise Fail("no narrower window")
    words_ = {"this weekend": "the weekend ones", "today": "just today's", "tomorrow": "the ones tomorrow",
              "this week": "the ones this week", "next week": "the ones next week"}
    S.turn("asks for just %s (%s)" % (words_.get(w, "the ones on " + w), w),
           [w if w.startswith("next") else w.replace("this ", "")], "follow")
    S.answer("(them during %s)" % w)
    S.ctx["window"] = w


def f_filter_field(S, rng):
    _them_ok(S)
    cur = S.ctx.get("set")
    kind = S.ctx.get("kind")
    opts = []
    if kind in ("tasks", "things"):
        opts += [('(them) that (due_at during %s)', "asks for just the ones due %s", w) for w in
                 ["this week", "next week", "today", "tomorrow"]]
        opts += [('(them that (status != "completed"))', "asks which of those are still to do", None)]
    if kind == "tasks":
        opts += [('(them that (status = "completed"))', "asks which of those are already done", None)]
    if kind == "photos":
        opts += [("(them that (favorite = true))", "asks for just the favourites among them", None)]
    if kind == "documents":
        opts += [("(them that (starred = true))", "asks which of those are starred", None)]
    if kind == "expenses":
        opts += [("(them that (amount_minor > %d))" % (a * 100), "asks for just the ones over %d (money)" % a, str(a))
                 for a in (20, 50, 100)]
    if not opts:
        raise Fail("no field filter")
    rng.shuffle(opts)
    base = len(S.peek("show %s" % cur)) if cur else 99
    for expr, hint, w in opts:
        e = expr % w if "%s" in expr else expr
        probe = e.replace("them", cur, 1) if cur else None
        if not probe:
            continue
        got = S.peek("show (%s)" % probe)
        if got and len(got) < base:
            break
    else:
        raise Fail("no field filter narrows")
    S.turn(hint % w if "%s" in hint else hint, [w] if w else [], "follow")
    S.answer(e)


def f_narrow_name(S, rng):
    _them_ok(S)
    cur = S.ctx.get("set")
    if not cur:
        raise Fail("no set")
    labs = [lab for _, _, lab in S.last]
    cnt = collections.Counter(w.lower() for lab in labs for w in set(words(lab)))
    cands = [w for w, c in cnt.items() if 1 <= c < len(labs) and w != (S.ctx.get("kw") or "").lower()]
    if not cands:
        raise Fail("no narrowing word")
    w = rng.choice(cands)
    if not S.peek('show ((%s) called "%s")' % (cur, w)):
        raise Fail("narrowing word finds nothing")
    S.turn(pick_hint(rng, ["asks for just the %s ones among those", "asks which of those are about %s"], w), [w],
           "follow")
    S.answer('(them) called "%s"' % w)


def f_switch_kind(S, rng):
    """same name, another kind: 'is there a document for it too?'"""
    kw = S.ctx.get("kw")
    kind = S.ctx.get("kind")
    if not kw or kind not in ("notes", "documents", "tasks", "events", "photos", "things", "expenses"):
        raise Fail("no name to carry")
    others = [k for k in ("notes", "documents", "tasks", "events", "photos", "expenses") if k != kind]
    rng.shuffle(others)
    for k in others:
        if S.peek('show (%s called "%s")' % (k, q(kw))):
            break
    else:
        raise Fail("name in no other kind")
    S.turn(pick_hint(rng, ["asks whether there are any %s about it too", "asks what about in their %s",
                           "asks if it's in their %s as well"], KIND_SAY[k]), [], "follow")
    explore(S, rng, ['search "%s"' % q(kw), "show (%s)" % k])
    S.answer('(%s called "%s")' % (k, q(kw)))
    S.ctx.update(kind=k)


def f_what_about(S, rng):
    """same question, another name: 'what about X?'"""
    kw = S.ctx.get("kw")
    kind = S.ctx.get("kind")
    if not kw or kind not in ("notes", "documents", "tasks", "events", "photos", "things", "expenses",
                              "locker items"):
        raise Fail("no name question")
    rows = live(S.peek("show (%s)" % kind))
    for _ in range(6):
        kw2 = phrase(rng, rng.choice(rows)["label"], 0.3)
        if kw2.lower() != kw.lower() and S.peek('show (%s called "%s")' % (kind, q(kw2))):
            break
    else:
        raise Fail("no other name")
    S.turn("asks the same about %s instead ('what about %s?')" % (kw2, kw2), [kw2], "follow")
    explore(S, rng, ['search "%s"' % q(kw2)])
    S.answer('(%s called "%s")' % (kind, q(kw2)))
    S.ctx.update(kw=kw2)


def f_what_else(S, rng):
    """the set the conversation is on, minus the row just discussed"""
    _them_ok(S)
    if len(S.last) > 12 or not S.last_full:
        raise Fail("list size")
    pos = rng.randrange(min(len(S.last), 3))
    n = S.last[pos][0]
    snap_last = list(S.last)
    S.turn("asks what else there is apart from the %s one" % ordinal(pos), [], "follow")
    if rng.random() < 0.3:
        S.look("get #%d" % n)
        S.last, S.last_full = snap_last, True
    if rng.random() < 0.6:
        S.answer("(them) except (#%d)" % n)
    else:
        S.answer(hs(m for i, (m, _, _) in enumerate(S.last) if i != pos))


def f_rest_of_container(S, rng):
    """'what else is in that album / folder / on that day' after one row"""
    if S.ctx.get("album") and S.ctx.get("photo"):
        a, p = S.ctx["album"], S.ctx["photo"]
        if len(S.peek("show (photos of (albums called \"%s\"))" % q(
                [lab for n, _, lab in S.rows if n == a][0]))) < 2:
            raise Fail("album of one")
        S.turn("asks what else is in that album", [], "follow")
        S.answer("(photos of (#%d)) except (#%d)" % (a, p))
        S.ctx.update(kind="photos")
        return
    row = S.ctx.get("row")
    if S.ctx.get("kind") == "events" and row and S.ctx.get("focus"):
        d = date_of(row)
        if not d or len(S.peek("show (things during %s)" % d)) < 2:
            raise Fail("lonely day")
        S.turn(rng.choice(["asks what else they have that day", "asks what else is on that day"]), [], "follow")
        S.answer("(things during %s)" % d if rng.random() < 0.5 else "(things during %s) ordered by dtstart asc" % d)
        S.ctx.update(kind="things", window=d)
        return
    if S.ctx.get("kind") == "documents" and len(S.last) == 1:
        n, _, lab = S.last[0]
        docs = [d for d in live(S.peek("show (documents)")) if d["label"] == lab]
        f = extra(docs[0]).get("folder") if docs else None
        if not f or len(S.peek('show (documents that (folder = "%s"))' % f)) < 2:
            raise Fail("no folder")
        S.turn("asks what else is in the same folder", [], "follow")
        explore(S, rng, ["get #%d" % n], n=0 if rng.random() < 0.6 else 1)
        S.answer('(documents that (folder = "%s")) except (#%d)' % (f, n))
        S.ctx.update(kind="documents", folder=f)
        return
    raise Fail("no container")


def f_switch_link(S, rng):
    """walk a link from what was just answered"""
    kind = S.ctx.get("kind")
    if not S.last:
        raise Fail("nothing shown")
    ents = {k for _, k, _ in S.last}
    if ents == {"event"} and len(S.last) == 1:
        n = S.last[0][0]
        lab = S.last[0][2]
        if not S.peek('show (parties of (events called "%s"))' % q(lab)):
            raise Fail("no attendees")
        S.turn(rng.choice(["asks who's coming to it", "asks who else will be there"]), [], "follow")
        maybe_get(S, rng, n, 0.35)
        S.answer("(parties of (#%d))" % n)
        S.ctx.update(kind="parties")
        return
    if ents == {"photo"}:
        if len(S.last) == 1:
            n, _, lab = S.last[0]
            link = rng.choice(["albums", "places"])
            if not S.peek('show (%s of (photos called "%s"))' % (link, q(lab))):
                raise Fail("photo has no %s" % link)
            S.turn({"albums": "asks what album that photo is in", "places": "asks where it was taken"}[link], [],
                   "follow")
            maybe_get(S, rng, n, 0.35)
            S.answer("(%s of (#%d))" % (link, n))
            S.ctx.update(kind=link, photo=n)
            if link == "albums":
                S.ctx["album"] = S.last[0][0]
            return
        titles = set()
        for _, _, lab in S.last:
            for p in live(S.peek('show (photos called "%s")' % q(lab))):
                titles |= set((extra(p).get("album_titles") or "").split(", ")) - {""}
        if not titles or not S.ctx.get("set"):
            raise Fail("no albums")
        S.turn("asks which albums those photos are in", [], "follow")
        S.answer("(albums of (them))")
        S.ctx.update(kind="albums")
        return
    if ents == {"place"} and len(S.last) >= 1:
        n, _, lab = S.last[0]
        if not S.peek('show (photos of (places called "%s"))' % q(lab)):
            raise Fail("place without photos")
        S.turn("asks to see the photos from %s" % ("that place" if len(S.last) == 1 else "the first one"), [],
               "follow")
        S.answer("(photos of (#%d))" % n)
        S.ctx.update(kind="photos")
        return
    if ents == {"album"} and len(S.last) == 1:
        S.turn("asks to see the photos in it", [], "follow")
        S.answer("(photos of (#%d))" % S.last[0][0])
        S.ctx.update(kind="photos")
        return
    if ents == {"party"} and 1 <= len(S.last) <= 6:
        link, hint = rng.choice([("important dates", "asks when their birthdays are"),
                                 ("events", "asks what events they are coming to"),
                                 ("obligations", "asks about the debts with them")])
        n = S.last[0][0]
        lab = S.last[0][2]
        if len(S.last) == 1:
            if not S.peek('show (%s of (parties called "%s"))' % (link, q(lab))):
                raise Fail("person without %s" % link)
            hint = hint.replace("their birthdays are", "their birthday is").replace("they are", "they're")
            S.turn(hint + " (the one person just shown)", [], "follow")
            S.answer("(%s of (#%d))" % (link, n))
        else:
            if not any(S.peek('show (%s of (parties called "%s"))' % (link, q(lb))) for _, _, lb in S.last):
                raise Fail("people without %s" % link)
            S.turn(hint + " (all of those people)", [], "follow")
            S.answer("(%s of (them))" % link)
        S.ctx.update(kind=link)
        return
    raise Fail("no link to walk")


def f_ordinal_move(S, rng):
    items = [(n, k, lab) for n, k, lab in S.last if k in ("task", "event")]
    if len(items) < 2:
        raise Fail("nothing to pick")
    at = rng.randrange(min(len(items), 4))
    n, k, lab = items[at]
    # the ordinal counts positions in the result as shown
    pos = [x[0] for x in S.last].index(n)
    d = rng.choice(DAYS)
    S.turn("asks to move the %s one to %s" % (ordinal(pos), d), [d], "write")
    S.call("reschedule{to: %s} on #%d" % (d, n))
    S.ctx["moved"] = n
    return n


def f_narrow_kind(S, rng):
    kinds = sorted({k for _, k, _ in S.last})
    if len(kinds) < 2 or not S.last_full:
        raise Fail("one kind")
    k = rng.choice(kinds)
    picked = [n for n, kk, _ in S.last if kk == k]
    S.turn("asks for just the %s ones" % k, [], "follow")
    S.answer(hs(picked))


def f_person_number(S, rng):
    people = [(n, lab) for n, k, lab in S.last if k == "party"]
    if not people:
        raise Fail("no people")
    n, lab = rng.choice(people)
    chans = peek_ok(S, 'show (contact channels of (parties called "%s") that (kind = "phone"))' % q(lab))
    if not chans:
        raise Fail("no phone")
    if len(people) == 1:
        S.turn("asks for their phone number (the one person just shown)", [], "follow")
    else:
        if sum(first(lb) == first(lab) for _, lb in people) > 1:
            raise Fail("shared first name in the list")
        S.turn("asks for %s's number" % first(lab), [first(lab)], "follow")
    S.answer('(contact channels of (#%d)) that (kind = "phone")' % n)
    S.ctx.update(kind="contact channels")


def f_count(S, rng):
    _them_ok(S)
    S.turn(rng.choice(["asks how many that is", "asks how many there are in total"]), [], "follow")
    S.answer("count of (them)")


def f_turn_into_task(S, rng):
    notes = [(n, lab) for n, k, lab in S.last if k in ("note", "document", "event")]
    if not notes:
        raise Fail("no note")
    n, lab = rng.choice(notes)
    d = rng.choice(DAYS)
    S.turn("asks to add a task for %s to deal with '%s'" % (d, lab), [d], "write")
    S.call('schedule.add_task{title: "%s", due_at: %s}' % (q(lab), d))


def f_never_mind(S, rng):
    S.turn("takes it back: never mind", [], "edge")
    S.call("nothing")


def f_correct_day(S, rng, n):
    d = rng.choice(DAYS)
    S.turn("corrects: no, make it %s" % d, [d], "write")
    S.call("reschedule{to: %s} on #%d" % (d, n))


def f_open_of_them(S, rng):
    if not any(k == "task" for _, k, _ in S.last):
        raise Fail("no tasks")
    _them_ok(S)
    S.turn("asks which of those are still to do", [], "follow")
    S.answer('(them that (status != "completed"))')



# -- write verbs: debts, groups, expenses, trash, albums -------------------------

def open_obligations(S, name):
    return [o for o in live(S.peek('show (obligations of (parties called "%s"))' % q(name)))
            if not extra(o).get("settled_at")]


def c_settle_debt(S, rng):
    rows = live(S.peek("show (parties that (owed_to_me_minor > 0 or owed_to_them_minor > 0))"))
    rows = [r for r in rows if len(S.peek('show (parties called "%s")' % q(r["label"]))) == 1
            and open_obligations(S, r["label"])]
    if not rows:
        raise Fail("no open debts")
    p = rng.choice(rows)
    name = p["label"]
    obls = open_obligations(S, name)
    if rng.random() < 0.5:
        # two turns: look at the debts, then settle them
        S.turn(rng.choice(["asks whether they owe %s anything", "asks whether %s owes them anything",
                           "asks what's outstanding with %s"]) % name, [name], "link")
        S.look('search "%s"' % q(name))
        S.answer("(obligations of (#%d))" % S.handle(name, "party"))
        hs_ = [n for n, k, lab in S.last if k == "obligation" and lab in {o["label"] for o in obls}]
        if not hs_:
            raise Fail("open debts not shown")
        S.turn(rng.choice(["asks to settle it", "asks to settle up with them (that person)", "says to pay it off",
                           "asks to mark that debt as paid"]), [], "write")
        S.call("people.settle_debt{} on %s" % hs(hs_))
    else:
        S.turn(pick_hint(rng, ["asks to settle up their debt with %s", "says they've paid %s back, mark it settled",
                               "asks to clear what's owed between them and %s"], name), [name], "write")
        S.look('search "%s"' % q(name))
        S.look("show (obligations of (#%d))" % S.handle(name, "party"))
        hs_ = [n for n, k, lab in S.last if k == "obligation" and lab in {o["label"] for o in obls}]
        if not hs_:
            raise Fail("open debts not shown")
        S.call("people.settle_debt{} on %s" % hs(hs_))


def c_settle_group(S, rng):
    g, kw = unique_label(S, rng, "groups", live(S.peek("show (groups)")), two=0.4)
    if rng.random() < 0.6:
        S.turn(pick_hint(rng, ["asks to settle up with everyone in the %s group", "asks to square up with the whole %s group",
                               "asks to settle all the balances in the %s group"], kw), [kw], "write")
        S.look('search "%s"' % q(kw) if rng.random() < 0.6 else 'show (groups called "%s")' % q(kw))
        n = S.handle(g["label"], "group")
        S.look("show (members of (#%d)) that (party_id is not me)" % n)
        ms = [m for m, k, _ in S.last if k == "member"]
        if not ms:
            raise Fail("no members")
        S.call("tally.settle_up{to_party: me, group_id: (#%d), amount_minor: balance of (it) in (#%d)} on %s"
               % (n, n, hs(ms)))
    else:
        mem = live(S.peek('show (members of (groups called "%s")) that (party_id is not me)' % q(kw)))
        if not mem:
            raise Fail("no members")
        m = rng.choice(mem)
        who = first(m["label"])
        if sum(first(x["label"]) == who for x in mem) > 1:
            raise Fail("shared first name")
        S.turn("asks to settle up with %s in the %s group" % (who, kw), [who, kw], "write")
        S.look('search "%s"' % q(kw))
        n = S.handle(g["label"], "group")
        S.look("show (members of (#%d)) that (party_id is not me)" % n)
        h = S.handle(m["label"], "member")
        S.call("tally.settle_up{to_party: me, group_id: (#%d), amount_minor: balance of (#%d) in (#%d)} on #%d"
               % (n, h, n, h))


def c_delete_expense(S, rng):
    e, kw = unique_label(S, rng, "expenses", live(S.peek("show (expenses)")), two=0.3)
    S.turn(pick_hint(rng, ["asks to bin the %s expense", "asks to delete the %s expense",
                           "asks to remove the %s entry from the shared expenses"], kw), [kw], "write")
    S.look('search "%s"' % q(kw) if rng.random() < 0.7 else 'show (expenses called "%s")' % q(kw))
    n = S.handle(e["label"], "expense")
    S.call("tally.delete_expense{} on #%d" % n)
    if rng.random() < 0.5:
        S.turn(rng.choice(["takes it back: scratch that, put it back", "says oops, undo that, put the expense back",
                           "asks to bring that expense back"]), [], "write")
        S.call("tally.undo_expense{} on #%d" % n)


def c_delete_then_restore(S, rng):
    kind, ent, verb = rng.choice([("notes", "note", "delete{}"), ("tasks", "task", "delete{}"),
                                  ("documents", "document", "core.trash_document{}")])
    r, kw = unique_label(S, rng, kind, live(S.peek("show (%s)" % kind)), two=0.3)
    S.turn(pick_hint(rng, ["asks to delete the %s " + ent, "asks to bin the %s " + ent,
                           "asks to get rid of the %s " + ent], kw), [kw], "write")
    S.look('search "%s"' % q(kw))
    n = S.handle(r["label"], ent)
    S.call("%s on #%d" % (verb, n))
    S.turn(rng.choice(["takes it back: no wait, put it back", "says undo that, they need it after all",
                       "asks to bring it back"]), [], "write")
    S.call("restore{} on #%d" % n)


def c_add_to_album(S, rng):
    albums = live(S.peek("show (albums)"))
    if not albums:
        raise Fail("no albums")
    a, akw = unique_label(S, rng, "albums", albums, two=0.5)
    photos = [p for p in live(S.peek("show (photos)"))
              if a["label"] not in (extra(p).get("album_titles") or "").split(", ")]
    if not photos:
        raise Fail("no photo outside the album")
    p, pkw = unique_label(S, rng, "photos", photos, two=0.4)
    if pkw.lower() in akw.lower() or akw.lower() in pkw.lower():
        raise Fail("names overlap")
    S.turn(pick_hint(rng, ["asks to put the %s photo in the %s album", "asks to add the %s picture to the %s album"],
                     pkw, akw), [pkw, akw], "write")
    S.look('search "%s"' % q(pkw) if rng.random() < 0.6 else 'show (photos called "%s")' % q(pkw))
    ph = S.handle(p["label"], "photo")
    S.look('search "%s"' % q(akw) if rng.random() < 0.6 else 'show (albums called "%s")' % q(akw))
    al = S.handle(a["label"], "album")
    S.call("media.add_to_album{album_id: (#%d)} on #%d" % (al, ph))
    S.ctx.update(album=al, photo=ph)


def c_shift_event(S, rng):
    events = live(S.peek("show (events)"))
    e, kw = unique_label(S, rng, "events", events, two=0.2)
    by, said = rng.choice([("+1h", "an hour later"), ("+2h", "two hours later"), ("-1h", "an hour earlier"),
                           ("+30m", "half an hour later"), ("-30m", "half an hour earlier"), ("+1d", "a day later")])
    S.turn("asks to move the %s %s" % (kw, said), [kw], "write")
    S.look('search "%s"' % q(kw) if rng.random() < 0.7 else 'show (events called "%s")' % q(kw))
    S.call("reschedule{by: %s} on #%d" % (by, S.handle(e["label"], "event")))


# -- bulk and chained writes --------------------------------------------------------

def c_move_task_and_event(S, rng):
    tasks = [t for t in live(S.peek("show (tasks)")) if extra(t).get("status") != "completed"]
    events = live(S.peek("show (events)"))
    ev_words = {w.lower(): e for e in events for w in words(e["label"])}
    pairs = []
    for t in tasks:
        for w in words(t["label"]):
            e = ev_words.get(w.lower())
            if e and len(S.peek('show (tasks called "%s")' % w)) == 1 and \
                    len(S.peek('show (events called "%s")' % w)) == 1:
                pairs.append((t, e, w))
    if not pairs:
        raise Fail("no task+event pair")
    t, e, w = rng.choice(pairs)
    d = rng.choice(DAYS + ["next monday", "tomorrow"])
    S.turn("asks to push the %s things to %s -- both the task and the calendar entry" % (w, d), [w, d], "write")
    S.look('search "%s"' % q(w))
    S.call("reschedule{to: %s} on %s" % (d, hs(sorted([S.handle(t["label"], "task"), S.handle(e["label"], "event")]))))


def c_delete_all_stuff(S, rng):
    rows = live(S.peek("show (things)"))
    for _ in range(8):
        kw = keyword(rng, rng.choice(rows)["label"])
        got = S.peek('show (things called "%s")' % q(kw))
        if 2 <= len(got) <= 10:
            break
    else:
        raise Fail("no small family")
    S.turn(pick_hint(rng, ["asks to delete all their %s stuff", "asks to get rid of everything about %s"], kw), [kw],
           "write")
    S.look('search "%s"' % q(kw))
    if not S.last_full:
        raise Fail("search truncated")
    obs = S.call("delete{} on %s" % hs(n for n, _, _ in S.last))
    if obs.startswith("ambiguous"):
        S.done()


def f_move_both(S, rng):
    items = [(n, k) for n, k, _ in S.last if k in ("task", "event")]
    if len(items) != 2 or len(S.last) != 2:
        raise Fail("not two")
    d = rng.choice(DAYS + ["next monday"])
    S.turn("asks to move them both to %s" % d, [d], "write")
    S.call("reschedule{to: %s} on %s" % (d, hs(n for n, _ in items)))


def f_split_move(S, rng):
    items = [(i, n) for i, (n, k, _) in enumerate(S.last) if k in ("task", "event")]
    if len(items) < 2 or len(S.last) > 8:
        raise Fail("fewer than two")
    (i1, a), (i2, b) = rng.sample(items[:4], 2)
    d1, d2 = rng.sample(DAYS, 2)
    S.turn("asks to move the %s one to %s and the %s one to %s" % (ordinal(i1), d1, ordinal(i2), d2), [d1, d2],
           "write")
    S.call("reschedule{to: %s} on #%d then reschedule{to: %s} on #%d" % (d1, a, d2, b))


def f_correct_other(S, rng):
    """'no -- that one needs to be D1; it's the other that goes to D2' after a move"""
    moved = S.ctx.get("moved")
    others = [n for n, k, _ in S.last if k in ("task", "event") and n != moved]
    if not moved or not others:
        raise Fail("no move to correct")
    o = others[0]
    d1, d2 = rng.sample(DAYS, 2)
    S.turn("corrects: that one should be %s, and it's the other one (the first other item in the list) that goes "
           "to %s" % (d1, d2), [d1, d2], "write")
    S.call("reschedule{to: %s} on #%d then reschedule{to: %s} on #%d" % (d1, moved, d2, o))


# -- number answers ---------------------------------------------------------------

def c_spend_window(S, rng):
    for _ in range(6):
        w = rng.choice(["last month", "this month", "last week", "this week", "yesterday", "recently"])
        if S.peek("show (expenses that (spent_on during %s))" % w):
            break
    else:
        raise Fail("no spending")
    S.turn(pick_hint(rng, ["asks how much they spent %s", "asks what their spending came to %s",
                           "asks for the total they spent %s"], w), [w], "route")
    explore(S, rng, ["show (expenses that (spent_on during %s))" % w], n=0 if rng.random() < 0.65 else 1)
    S.answer("sum amount_minor of (expenses that (spent_on during %s))" % w)
    S.ctx.update(kind="spend", window=w)


def f_spend_other(S, rng):
    if S.ctx.get("kind") != "spend":
        raise Fail("not spend")
    for w in rng.sample(["last month", "this month", "last week", "this week"], 4):
        if w != S.ctx.get("window") and S.peek("show (expenses that (spent_on during %s))" % w):
            break
    else:
        raise Fail("no other window")
    S.turn("asks the same for %s ('and %s?')" % (w, w), [w], "follow")
    S.answer("sum amount_minor of (expenses that (spent_on during %s))" % w)
    S.ctx["window"] = w


def c_expense_amount(S, rng):
    e, kw = unique_label(S, rng, "expenses", live(S.peek("show (expenses)")), two=0.35)
    S.turn(pick_hint(rng, ["asks what the %s came to", "asks how much the %s was", "asks what they paid for the %s"],
                     kw), [kw], "route")
    if rng.random() < 0.7:
        S.look('search "%s"' % q(kw))
        n = S.handle(e["label"], "expense")
        maybe_get(S, rng, n, 0.2)
        S.answer("amount_minor of (#%d)" % n)
    else:
        S.answer('amount_minor of (expenses called "%s")' % q(kw))


def c_debt_amount(S, rng):
    field = rng.choice(["owed_to_me_minor", "owed_to_them_minor"])
    rows = [r for r in live(S.peek("show (parties that (%s > 0))" % field))
            if len(S.peek('show (parties called "%s")' % q(r["label"]))) == 1]
    if not rows:
        raise Fail("no debts")
    p = rng.choice(rows)
    name = p["label"]
    S.turn(pick_hint(rng, {"owed_to_me_minor": ["asks how much %s owes them", "asks what %s still owes them"],
                           "owed_to_them_minor": ["asks how much they owe %s", "asks how much they still owe %s"]}[field],
                     name), [name], "route")
    S.look('search "%s"' % q(name))
    n = S.handle(name, "party")
    maybe_get(S, rng, n, 0.25)
    S.answer("%s of (#%d)" % (field, n))
    S.ctx.update(kind="debt amount", field=field, person=n)
    others = [r for r in rows if r["label"] != name]
    if others and rng.random() < 0.45:
        o = rng.choice(others)["label"]
        S.turn("asks the same about %s ('and %s?')" % (o, o), [o], "follow")
        S.look('search "%s"' % q(o))
        S.answer("%s of (#%d)" % (field, S.handle(o, "party")))


def c_obligation_amount(S, rng):
    rows = [r for r in live(S.peek("show (parties that (owed_to_me_minor > 0 or owed_to_them_minor > 0))"))
            if len(S.peek('show (parties called "%s")' % q(r["label"]))) == 1]
    rows = [r for r in rows if len(open_obligations(S, r["label"])) == 1]
    if not rows:
        raise Fail("no single debt")
    p = rng.choice(rows)
    o = open_obligations(S, p["label"])[0]
    S.turn("asks what the outstanding balance is on the %s debt with %s" % (o["label"], p["label"]),
           [p["label"]], "route")
    S.look('search "%s"' % q(p["label"]))
    S.look("show (obligations of (#%d))" % S.handle(p["label"], "party"))
    S.answer("amount_minor of (#%d)" % S.handle(o["label"], "obligation"))


def c_group_spend_rows(S, rng):
    g, kw = unique_label(S, rng, "groups", live(S.peek("show (groups)")), two=0.4)
    if not S.peek('show (expenses of (groups called "%s"))' % q(kw)):
        raise Fail("no expenses")
    S.turn(pick_hint(rng, ["asks what they spent on in the %s group (the expenses themselves)",
                           "asks to see the %s group's expenses"], kw), [kw], "link")
    if rng.random() < 0.4:
        S.answer('(expenses of (groups called "%s"))' % q(kw))
    else:
        S.look('search "%s"' % q(kw))
        S.answer("(expenses of (#%d))" % S.handle(g["label"], "group"))
    S.ctx.update(kind="expenses")


def c_balance_person(S, rng):
    g, kw = unique_label(S, rng, "groups", live(S.peek("show (groups)")), two=0.4)
    mem = live(S.peek('show (members of (groups called "%s")) that (party_id is not me)' % q(kw)))
    if not mem:
        raise Fail("no members")
    m = rng.choice(mem)
    who = first(m["label"])
    if sum(first(x["label"]) == who for x in mem) > 1:
        raise Fail("shared first name")
    S.turn("asks how much %s owes them in the %s group" % (who, kw), [who, kw], "link")
    S.look('search "%s"' % q(kw))
    n = S.handle(g["label"], "group")
    S.look("show (members of (#%d)) that (party_id is not me)" % n)
    S.answer("balance of (#%d) in (#%d)" % (S.handle(m["label"], "member"), n))


def c_count_set(S, rng):
    opts = [("asks how many things are in their locker", "count of (locker items)", []),
            ("asks how many photos they have", "count of (photos)", []),
            ("asks how many documents they have", "count of (documents)", []),
            ("asks how many people are in their contacts", "count of (parties)", [])]
    docs = live(S.peek("show (documents)"))
    folders = sorted({extra(d).get("folder") for d in docs} - {None, ""})
    if folders:
        f = rng.choice(folders)
        opts.append(("asks how many documents are in the %s folder" % f,
                     'count of (documents that (folder = "%s"))' % f, [f]))
    for w in ["last month", "this month", "last week"]:
        opts.append(("asks how many photos they took %s" % w, "count of (photos during %s)" % w, [w]))
    for w in ["this week", "tomorrow", "friday", "next week"]:
        opts.append(("asks how many tasks are due %s" % w,
                     'count of (tasks that (due_at during %s and status != "completed"))' % w, [w]))
    h, expr, say = rng.choice(opts)
    S.turn(h, say, "route")
    S.answer(expr)


def f_sum_them(S, rng):
    _them_ok(S)
    ents = {k for _, k, _ in S.last}
    if ents == {"expense"}:
        field = "amount_minor"
    elif ents == {"party"} and S.ctx.get("set") in ("(parties that (owed_to_me_minor > 0))",
                                                     "(parties that (owed_to_them_minor > 0))"):
        field = "owed_to_me_minor" if "owed_to_me" in S.ctx["set"] else "owed_to_them_minor"
    else:
        raise Fail("nothing to add up")
    S.turn(rng.choice(["asks what that comes to altogether", "asks for the total of those",
                       "asks what's that come to in all"]), [], "follow")
    S.answer("sum %s of (them)" % field)


def f_how_much(S, rng):
    if len(S.last) != 1 or S.last[0][1] not in ("expense", "obligation"):
        raise Fail("not one amount row")
    S.turn(rng.choice(["asks how much", "asks how much it was", "asks what it came to"]), [], "follow")
    S.answer("amount_minor of (#%d)" % S.last[0][0])


def c_when_ambiguous(S, rng):
    rows = live(S.peek("show (things)"))
    for _ in range(10):
        kw = keyword(rng, rng.choice(rows)["label"])
        got = [r for r in S.peek('show (things called "%s")' % q(kw)) if r.get("date")]
        if len({r["entity"] for r in got}) >= 2:
            break
    else:
        raise Fail("no multi-kind name")
    S.turn(pick_hint(rng, ["asks when their %s thing is (no kind given)", "asks what time the %s thing is (no kind said)"],
                     kw), [kw], "edge")
    obs = S.call('answer dtstart of (things called "%s")' % q(kw))
    if not obs.startswith("ambiguous"):
        raise Fail("dtstart was not ambiguous")
    S.done()


# -- refusals with a follow-up -----------------------------------------------------------

def c_refuse_named(S, rng):
    people = [p for p in live(S.peek("show (parties)")) if p["label"] != "Owner" and " " in p["label"]]
    p = first(rng.choice(people)["label"])
    r = rng.random()
    if r < 0.3:
        items = live(S.peek("show (locker items)"))
        it = keyword(rng, rng.choice(items)["label"])
        S.turn("asks to text %s the %s password" % (p, it), [p, it], "edge")
        S.call("refuse: sealed_egress")
    elif r < 0.55:
        S.turn(rng.choice(["asks to text %s and say they're running late", "asks to message %s to say happy birthday",
                           "asks to email %s the address of the party"]) % p, [p], "edge")
        S.call("refuse: out_of_ontology")
    elif r < 0.7:
        S.turn(rng.choice(["asks to export their whole locker to a plain file", "asks to dump all their passwords into an email"]),
               [], "edge")
        S.call("refuse: sealed_egress")
    else:
        rows = live(S.peek("show (events)")) + live(S.peek("show (places)"))
        thing = keyword(rng, rng.choice(rows)["label"]).lower()
        d = rng.choice(DAYS + ["tomorrow", "next friday"])
        S.turn("asks to book the %s on their website for %s" % (thing, d), [thing, d], "edge")
        S.call("refuse: out_of_ontology")
        if rng.random() < 0.6:
            S.turn("says fine, just add a task to do it themselves (book the %s, %s)" % (thing, d), [], "write")
            S.call('schedule.add_task{title: "Book the %s", due_at: %s}' % (thing, d))


# -- titles from the person's words ------------------------------------------------------

def c_task_from_words(S, rng):
    rows = live(S.peek("show (places)")) + live(S.peek("show (parties)")) + live(S.peek("show (things)"))
    kw = keyword(rng, rng.choice(rows)["label"])
    verb, tail = rng.choice([("Call", " place"), ("Check", ""), ("Print", " note"), ("Email", ""), ("Pay", " bill"),
                             ("Book", ""), ("Fix", ""), ("Ring", " about the invoice")])
    title = "%s the %s%s" % (verb, kw, tail)
    if rng.random() < 0.5:
        S.turn("asks to add a task to %s" % title[0].lower() + title[1:], [title[title.index(" ") + 1:]], "write")
        S.call('schedule.add_task{title: "%s"}' % title)
    else:
        d = rng.choice(DAYS + ["tomorrow"])
        S.turn("asks to add a task to %s by %s" % (title[0].lower() + title[1:], d),
               [title[title.index(" ") + 1:], d], "write")
        S.call('schedule.add_task{title: "%s", due_at: %s}' % (title, d))


def c_note_from_words(S, rng):
    rows = live(S.peek("show (things)"))
    kw = keyword(rng, rng.choice(rows)["label"]).lower()
    title = rng.choice(["Check the %s", "Ask about the %s", "Measure the %s", "Ideas for the %s", "Prices for the %s"]) % kw
    S.turn("asks to make a note to %s" % (title[0].lower() + title[1:]) if not title.startswith(("Ideas", "Prices"))
           else "asks to make a note called '%s'" % title, [title[title.index(" ") + 1:]], "write")
    S.call('knowledge.create_note{title: "%s"}' % title)


def f_task_about(S, rng):
    rows = [(n, k, lab) for n, k, lab in S.last if k in ("note", "document", "event")]
    if len(rows) != 1:
        raise Fail("not one row")
    n, k, lab = rows[0]
    verb = rng.choice(["Print", "Read", "Check", "Sign", "Send"])
    title = "%s the %s" % (verb, lab)
    d = rng.choice(DAYS + ["tomorrow", None, None])
    S.turn("asks to add a task to %s that %s%s" % (verb.lower(), k, " by %s" % d if d else ""),
           [verb.lower()] + ([d] if d else []), "write")
    S.call('schedule.add_task{title: "%s"%s}' % (q(title), ", due_at: %s" % d if d else ""))


# -- follow-up writes on what was shown ---------------------------------------------------

def f_log_about(S, rng):
    people = [(n, lab) for n, k, lab in S.rows if k == "party"]
    if not people:
        raise Fail("no person shown")
    n, lab = people[-1]
    kind = rng.choice(["call", "coffee", "visit", "message"])
    S.turn("asks to log that they had a %s with them (%s, shown earlier) about it today" % (kind, "that person"),
           [], "write")
    S.call('people.log_interaction{kind: "%s"} on #%d' % (kind, n))


def f_put_back(S, rng):
    if S.turns[-1].get("cell") != "c_trashed_check" or len(S.last) != 1:
        raise Fail("nothing trashed shown")
    S.turn(rng.choice(["asks to put it back", "asks to restore it", "says to bring it back"]), [], "write")
    S.call("restore{} on #%d" % S.last[0][0])


def f_reveal(S, rng):
    items = [n for n, k, _ in S.rows if k == "locker item"]
    if not items or S.ctx.get("kind") != "locker items":
        raise Fail("no locker row")
    n = S.ctx.get("focus") or items[-1]
    S.turn(rng.choice(["asks to see the password", "asks for the actual password"]), [], "write")
    S.call('locker.reveal_receipt{columns: "password"} on #%d' % n)


def f_doc_action(S, rng):
    docs = [(i, n, lab) for i, (n, k, lab) in enumerate(S.last) if k == "document"]
    if not docs:
        raise Fail("no documents")
    i, n, lab = rng.choice(docs[:4])
    verb, call = rng.choice([("star", "core.star_document{}"), ("bin", "core.trash_document{}")])
    if len(S.last) == 1:
        S.turn("asks to %s that one" % verb, [], "write")
    else:
        S.turn("asks to %s the %s one" % (verb, ordinal(i)), [], "write")
    S.call("%s on #%d" % (call, n))


def f_back_ref(S, rng):
    """refer back to a row from an EARLIER turn (not the last result)"""
    last = {n for n, _, _ in S.last}
    if len(S.turns) < 2:
        raise Fail("no earlier turn")
    early = [(n, k, lab) for n, k, lab in S.rows if n not in last and k in ("document", "locker item", "album",
                                                                               "task", "event", "photo", "party")]
    if not early:
        raise Fail("nothing earlier")
    n, k, lab = rng.choice(early)
    kw = keyword(rng, lab) if words(lab) else None
    tag = "(back to the earlier %s '%s')" % (k, lab)
    if k == "document":
        verb, call = rng.choice([("star", "core.star_document{}"), ("bin", "core.trash_document{}")])
        S.turn("%s asks to %s it" % (tag, verb), [kw] if kw else [], "write")
        S.call("%s on #%d" % (call, n))
    elif k == "locker item":
        S.turn("%s asks to see its password" % tag, [kw] if kw else [], "write")
        S.call('locker.reveal_receipt{columns: "password"} on #%d' % n)
    elif k == "album":
        S.turn("%s asks what's in it now" % tag, [kw] if kw else [], "follow")
        S.answer("(photos of (#%d))" % n)
    elif k in ("task", "event"):
        d = rng.choice(DAYS)
        S.turn("%s asks to move it to %s" % (tag, d), ([kw] if kw else []) + [d], "write")
        S.call("reschedule{to: %s} on #%d" % (d, n))
    elif k == "photo":
        link = rng.choice(["albums", "places"])
        if not S.peek('show (%s of (photos called "%s"))' % (link, q(lab))):
            raise Fail("photo without %s" % link)
        S.turn("%s asks %s" % (tag, "which album it is in" if link == "albums" else "where it was taken"),
               [kw] if kw else [], "follow")
        S.answer("(%s of (#%d))" % (link, n))
    else:
        if not peek_ok(S, 'show (contact channels of (parties called "%s") that (kind = "phone"))' % q(lab)):
            raise Fail("no phone")
        S.turn("%s asks for their phone number" % tag, [kw] if kw else [], "follow")
        S.answer('(contact channels of (#%d)) that (kind = "phone")' % n)

FIRST += [
    # write verbs
    (c_settle_debt, 2), (c_settle_group, 1.5), (c_delete_expense, 1.5), (c_delete_then_restore, 1.2),
    (c_add_to_album, 1.2), (c_shift_event, 1.2),
    # bulk / chained
    (c_move_task_and_event, 1), (c_delete_all_stuff, 1),
    # number answers
    (c_spend_window, 1), (c_expense_amount, 1), (c_debt_amount, 1), (c_obligation_amount, 0.5),
    (c_group_spend_rows, 1.2), (c_balance_person, 0.7), (c_count_set, 1), (c_when_ambiguous, 1),
    # refusals, titles
    (c_refuse_named, 1.5), (c_task_from_words, 1.5), (c_note_from_words, 0.8),
]

FOLLOW = [(f_narrow_window, 3), (f_filter_field, 3), (f_narrow_name, 2.5), (f_switch_kind, 3), (f_what_about, 2.5),
          (f_what_else, 2), (f_rest_of_container, 3), (f_switch_link, 3), (f_ordinal_move, 1.5),
          (f_narrow_kind, 1), (f_person_number, 1.5), (f_count, 1), (f_turn_into_task, 0.7), (f_never_mind, 0.25),
          (f_open_of_them, 1),
          (f_move_both, 2), (f_split_move, 1), (f_correct_other, 1.5), (f_spend_other, 3), (f_sum_them, 2),
          (f_how_much, 2), (f_task_about, 1), (f_log_about, 1), (f_put_back, 4), (f_reveal, 2), (f_doc_action, 1.5),
          (f_back_ref, 2)]


LISTY = {"c_agenda", "c_open_tasks", "c_due", "c_ticked_off", "c_favourites", "c_expenses_over", "c_folder",
         "c_journal", "c_dates_window", "c_no_deadline", "c_effort", "c_place_photos", "c_album_photos",
         "f_narrow_window", "f_filter_field", "c_search_about", "c_kind_called"}


def weighted(rng, table):
    fs, ws = zip(*table)
    return rng.choices(fs, ws)[0]


def snapshot(S):
    return (list(S.turns), list(S.last), S.last_full, list(S.rows), dict(S.ctx))


def restore(S, snap):
    S.turns, S.last, S.last_full, S.rows, S.ctx = snap[0], snap[1], snap[2], snap[3], snap[4]


def try_cell(S, rng, table, tries):
    """play one cell from `table`; a cell that fails before opening its turn
    is skipped (and another drawn); one that fails inside its turn sinks the
    session."""
    for _ in range(tries):
        f = weighted(rng, table)
        snap = snapshot(S)
        n_turns = len(S.turns)
        try:
            out = f(S, rng)
        except Fail as exc:
            if S.open_turn or len(S.turns) != n_turns:
                raise Fail("%s: %s" % (f.__name__, exc))
            SKIPPED[f.__name__] += 1
            restore(S, snap)
            continue
        for t in S.turns[n_turns:]:
            t.setdefault("cell", f.__name__)
        PLAYED[f.__name__] += 1
        return True, out
    return False, None


SKIPPED = collections.Counter()   # cells that did not apply (before opening a turn)
PLAYED = collections.Counter()


def session(srv, rng, max_turns):
    S = Session(srv)
    L = min(rng.choices(*LENGTHS)[0], max_turns)
    ok, out = try_cell(S, rng, FIRST, 3)
    if not ok:
        raise Fail("first cell did not apply")
    stale = 0
    while len(S.turns) < L and stale < 4:
        if isinstance(out, tuple) and rng.random() < 0.4:
            f_correct_day(S, rng, out[0])
            S.turns[-1]["cell"] = "f_correct_day"
            out = None
            continue
        if rng.random() < P_FOLLOW:
            table = FOLLOW
            if S.turns and S.turns[-1].get("cell") in LISTY:
                # a list was just answered: refining it is the likeliest next ask
                table = [(f, w * (6 if f in (f_narrow_window, f_filter_field) else 1)) for f, w in FOLLOW]
            ok, out = try_cell(S, rng, table, 10)
            if ok:
                continue
        S.new_topic = True
        S.ctx = {}
        ok, out = try_cell(S, rng, FIRST, 5)
        S.new_topic = False
        if not ok:
            stale += 1
    return S.record()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--worlds", default=os.path.join(HERE, "worlds"))
    ap.add_argument("--only", default="", help="comma list of world files to play (default: all)")
    ap.add_argument("--per-world", type=int, default=60)
    ap.add_argument("--max-turns", type=int, default=6)
    ap.add_argument("--seed", type=int, default=7007)
    ap.add_argument("--out", default=os.path.join(HERE, "traj.jsonl"))
    a = ap.parse_args()
    rng = random.Random(a.seed)
    worlds = sorted(f for f in os.listdir(a.worlds) if re.match(r"^w\d+\.json$", f))
    if a.only:
        worlds = [w for w in worlds if w in a.only.split(",")]
    kept, dropped, why = 0, 0, {}
    with open(a.out, "w", encoding="utf-8") as fh:
        for w in worlds:
            srv = Server(os.path.join(a.worlds, w))
            try:
                made = 0
                tries = 0
                while made < a.per_world and tries < a.per_world * 4:
                    tries += 1
                    try:
                        rec = session(srv, rng, a.max_turns)
                    except Fail as exc:
                        dropped += 1
                        key = re.sub(r"#\d+|\d+", "N", str(exc))[:60]
                        why[key] = why.get(key, 0) + 1
                        continue
                    rec["world"] = w
                    rec["id"] = "%s-%03d" % (w[:-5], made)
                    fh.write(json.dumps(rec) + "\n")
                    made += 1
                    kept += 1
            finally:
                srv.close()
            print("%s: %d sessions" % (w, made), flush=True)
    print("kept %d, dropped %d" % (kept, dropped))
    for k, v in sorted(why.items(), key=lambda x: -x[1])[:20]:
        print("  %4d  %s" % (v, k))
    print("cells played (skipped as not applying):")
    for f, _ in FIRST + FOLLOW:
        print("  %-22s %5d (%d)" % (f.__name__, PLAYED[f.__name__], SKIPPED[f.__name__]))


if __name__ == "__main__":
    main()
