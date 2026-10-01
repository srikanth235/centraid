"""v8 trajectory generator: skill-tagged, composed tool-use sessions on the v8 training worlds.

    python3 v8/trajgen.py --worlds v8/worlds --out v8/traj.jsonl [--seed S] [--scale F] [--only-world wNN]

Every session is PLAYED for real against `tool-loop serve --world spec:<w>`: a cell picks its target
rows from the world (`peek`, which numbers nothing), opens a turn, then makes the calls a good
assistant would, reading each observation for the `#n` it needs. Observations are the runtime's own
text. A cell whose calls error is dropped (`Fail`), never repaired -- except the deliberate RECOVERY
misses (`Session.miss`), a plausible first look that the runtime answers `no rows`,
`ambiguous: no link ...` or `error: ... unknown field ...`, followed by the call that recovers.

Record (one JSON line per session):

    {"id", "world", "split": "train"|"val", "today",
     "turns": [{"hint", "say", "skills": [...], "steps": [{"call", "obs"}], "end",
                "cell", "kind": "read"|"write"|"judge", ["recovery": "none"|"nolink"|"field"], ["pair": "<id>/a|b"]}]}

- hint prefixes (for the paraphraser): "follow-up: " refines or acts on what was just shown;
  "(new topic) " changes subject; "(detour) hang on — " is an aside, and the turn after it opens
  "back to <topic> — " and resumes the rows from before the detour (by #n, or the set spelled out).

- `hint` is a plain description of the person's message, for the paraphraser (v8/build8.py);
  `say` lists the exact words the message must contain: every name, title, keyword, number or day a
  call copies from the message (checked at the end of each session: a quoted string a call copies
  that is not in `say` drops the session).
- `skills` are the v8/skills.json ids the turn exercises: the cell's own tags plus tags read off the
  calls themselves (`auto_tags`: link walks, filters, number answers, write verbs, handles).
- Sessions are composed by a transition graph over cells: a FIRST cell, then follow-ups (FOLLOW)
  that act on what was just shown (narrow, except, switch kind, swap subject, walk a link, count/sum,
  pick by ordinal and write, correct or undo a write, never mind), a change of subject, or a DETOUR
  (a first cell marked "hang on") followed by a BACK-TO turn that resumes the earlier rows.
- MINIMAL PAIRS are two one-turn sessions with near-identical requests and different answers.
- Cells are drawn by the deficit of their skills against the per-skill targets (v8/BASELINE.md),
  divided by 2.5 (build8 multiplies each session ~2.5x), spread over the training worlds.
  w37-w40 are the validation worlds (`split: val`).
"""
import argparse
import collections
import json
import math
import os
import random
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
BIN = os.path.join(REPO, "target", "release", "tool-loop")

ROW = re.compile(r'^#(\d+) ([a-z ]+?) "([^"]*)"(.*)$', re.M)
VALUE = re.compile(r"^(count|sum|min|max|balance) |^(amount_minor|owed_to_me_minor|owed_to_them_minor|dtstart|effort_min|"
                   r"due_at|spent_on|captured_at|started_at) of ")
STOP = set("the a an my our at of for to in on about with and is it that this what from new old up out off by or as vs "
           "again before after next last week weeks month into over under very more close near when then than".split())
DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
VAL_WORLDS = {"w37", "w38", "w39", "w40"}
AUGMENT = 2.5          # build8 multiplies each generated turn ~2.5x
LOOK_MIX = (0.55, 0.30, 0.15)   # read turns: answer straight away / look once / look twice
MISS_RATE = 0.10       # read turns that open on a plausible miss and recover
PAIR_RATE = 0.10       # turns that belong to a minimal pair
LEN_MIX = ([1, 2, 3, 4, 5, 6], [26, 23, 21, 12, 10, 8])

KIND_ENT = {"notes": "note", "documents": "document", "tasks": "task", "events": "event", "photos": "photo",
            "locker items": "locker item", "expenses": "expense", "albums": "album", "places": "place",
            "parties": "party", "groups": "group", "important dates": "important date",
            "journal notes": "journal note", "obligations": "obligation", "contact channels": "contact channel",
            "activities": "activity", "members": "party"}
KIND_SAY = {"notes": "notes", "documents": "documents", "tasks": "to-dos", "events": "calendar events",
            "photos": "photos", "locker items": "locker entries", "expenses": "expenses", "albums": "albums",
            "places": "places", "important dates": "important dates", "journal notes": "journal entries"}
ROUTE_OF = {"notes": "route.library", "documents": "route.library", "journal notes": "route.library",
            "tasks": "route.schedule", "events": "route.schedule", "important dates": "route.schedule",
            "photos": "route.media", "albums": "route.media", "places": "route.media",
            "expenses": "route.money", "locker items": "route.locker", "parties": "route.people"}
CURRENCY = {"GBP": "pounds", "USD": "dollars", "AUD": "dollars", "CAD": "dollars", "NZD": "dollars",
            "SGD": "dollars", "EUR": "euros", "SEK": "kronor", "NOK": "kroner", "DKK": "kroner", "CHF": "francs",
            "PLN": "zloty", "MXN": "pesos", "NGN": "naira", "ZAR": "rand", "KES": "shillings", "INR": "rupees",
            "BRL": "reais"}
ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
        "seventeen eighteen nineteen").split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
ORD = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"]


class Fail(Exception):
    pass


# == the runtime ==============================================================================

class Server:
    def __init__(self, world):
        self.p = subprocess.Popen([BIN, "serve", "--world", "spec:" + world], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, text=True, bufsize=1)

    def ask(self, msg):
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise SystemExit("tool-loop serve exited")
        return json.loads(line)

    def close(self):
        try:
            self.p.stdin.write(json.dumps({"op": "quit"}) + "\n")
            self.p.stdin.close()
        except OSError:
            pass
        self.p.wait()


class Session:
    def __init__(self, srv, W, rng):
        self.srv = srv
        self.W = W                      # the world: meta + name inventory
        self.rng = rng
        self.today = srv.ask({"op": "open"})["today"]
        self.date = self.today.split()[-1]
        self.turns = []
        self.first_seen = {}            # #n -> turn index it was first shown in
        self.rows = []                  # every (n, kind, label) shown, in order
        self.last = []                  # rows of the last result shown
        self.last_full = True           # the last result printed every row
        self.open_turn = False
        self.ctx = {}                   # what the conversation is on, for follow-ups
        self.back = None                # in a back-to turn: the anchor's set, for `them`
        self.prefix = ""                # hint prefix for the next turn ("hang on", "back to ...")
        self.cache = {}

    # -- turns ---------------------------------------------------------------------------------
    def turn(self, hint, say=(), skills=(), t="read"):
        if self.open_turn:
            raise Fail("turn left open")
        if self.prefix:
            hint = self.prefix + hint
            self.prefix = ""
        self.srv.ask({"op": "turn", "request": hint})
        self.turns.append({"hint": hint, "say": [s for s in say if s], "skills": list(skills), "t": t,
                           "steps": []})
        self.open_turn = True

    def _send(self, line):
        r = self.srv.ask({"op": "call", "line": line})
        if "error" in r:
            raise Fail(r["error"])
        obs = r.get("obs", "")
        if obs.startswith("error:"):
            raise Fail("%s -> %s" % (line, obs))
        return obs, r.get("end")

    def _record(self, line, obs, end, miss=False):
        step = {"call": line, "obs": obs}
        if miss:
            step["miss"] = True
        self.turns[-1]["steps"].append(step)
        shown = [(int(n), k, lab) for n, k, lab, _ in ROW.findall(obs)]
        if (shown or obs == "no rows") and not line.startswith("get "):
            self.last = shown
            self.last_full = "rows in all" not in obs
        for s in shown:
            self.first_seen.setdefault(s[0], len(self.turns) - 1)
            if s not in self.rows:
                self.rows.append(s)
        if end:
            self.turns[-1]["end"] = end
            self.open_turn = False
            if end.startswith("declined") and not any(ok in end for ok in ("none", "refuse", "clarify")):
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

    def miss(self, line, expect):
        """a plausible first look that misses; the runtime's answer must be the expected miss"""
        r = self.srv.ask({"op": "call", "line": line})
        if "error" in r:
            raise Fail(r["error"])
        obs = r.get("obs", "")
        ok = {"none": obs == "no rows", "nolink": obs.startswith("ambiguous: no "),
              "field": obs.startswith("error:") and "unknown field" in obs}[expect]
        if not ok or r.get("end"):
            raise Fail("miss did not miss: %s -> %s" % (line, obs[:60]))
        self._record(line, obs, None, miss=True)
        self.turns[-1]["miss"] = expect
        return obs

    def answer(self, expr, empty=False):
        """End a read turn: `expr` (a set or a value) IS the answer."""
        value = bool(VALUE.match(expr))
        line = "answer " + expr
        obs, end = self._send(line)
        if not end:
            raise Fail("%s left the turn open: %s" % (line, obs[:60]))
        self._record(line, obs, end)
        if not value and not ROW.search(obs) and not empty:
            raise Fail("empty answer: %s" % line)
        if value and not empty and obs.strip() in ("= 0", "= 0.0"):
            raise Fail("zero answer: %s" % line)
        if not value:
            self.ctx["set"], self.ctx["pset"] = self._setexpr(expr, "set"), self._setexpr(expr, "pset")
        return obs

    def _setexpr(self, expr, key):
        """the set just answered, `them` expanded; for "pset" also every #n, so a peek can read it"""
        prev = self.ctx.get(key)
        if re.search(r"\bthem\b", expr):
            if not prev:
                return None
            expr = re.sub(r"\bthem\b", "(%s)" % prev, expr)
        if re.match(r"^#\d+(, #\d+)*$", expr):
            return None
        if key == "pset":
            return self.peekable(expr)
        return expr

    def peekable(self, expr):
        if re.search(r"#\d+, #\d+", expr):
            return None
        plural = {v: k for k, v in KIND_ENT.items() if k != "members"}
        bad = []

        def sub(m):
            n = int(m.group(1))
            for m2, k, lab in self.rows:
                if m2 == n and k in plural:
                    return '%s called "%s"' % (plural[k], q(lab))
            bad.append(n)
            return m.group(0)
        out = re.sub(r"#(\d+)", sub, expr)
        return None if bad else out

    def write(self, line):
        obs, end = self._send(line)
        self._record(line, obs, end)
        if end != "wrote":
            raise Fail("write did not land: %s -> %s" % (line, obs[:60]))
        self.cache.clear()
        return obs

    def done(self):
        self.call("done")

    def ask(self, question):
        obs = self.call('ask "%s"' % question)
        if self.open_turn:
            raise Fail("ask left the turn open")
        return obs

    def peek(self, line):
        if line in self.cache:
            return self.cache[line]
        r = self.srv.ask({"op": "peek", "line": line})
        if "error" in r:
            raise Fail("peek %s: %s" % (line, r["error"]))
        out = r.get("rows", r.get("value"))
        self.cache[line] = out
        return out

    def peek_ok(self, line):
        try:
            return self.peek(line)
        except Fail:
            return []

    def handle(self, label=None, kind=None, rows=None):
        for n, k, lab in (rows if rows is not None else self.last):
            if (label is None or lab == label) and (kind is None or k == kind):
                return n
        raise Fail("no #n for %r %r" % (label, kind))

    def them(self):
        """`them` -- or, in a back-to turn, the anchor's set spelled out"""
        return self.back if self.back else "them"

    def record(self):
        return {"today": self.today, "turns": self.turns}


# == helpers ==================================================================================

def words(label):
    return [w for w in re.findall(r"[A-Za-z][A-Za-z'-]+", label)
            if w.lower() not in STOP and len(w) >= 3 and "'" not in w and not w.isupper()]


def keyword(rng, label):
    ws = words(label)
    if not ws:
        raise Fail("no keyword in %r" % label)
    return rng.choice(ws)


def phrase(rng, label, two=0.3):
    toks = re.findall(r"[A-Za-z][A-Za-z'-]*", label)
    ok = set(words(label))
    pairs = [(a, b) for a, b in zip(toks, toks[1:]) if a in ok and b in ok]
    if pairs and rng.random() < two:
        return "%s %s" % rng.choice(pairs)
    return keyword(rng, label)


def low(kw, names):
    """keywords are said in lower case unless they are proper names"""
    return kw if kw.lower() in names else kw.lower()


def first(label):
    return label.split()[0]


def hs(ns):
    return ", ".join("#%d" % n for n in ns)


def q(s):
    return s.replace('"', "")


def live(rows):
    return [r for r in (rows or []) if r.get("live", True) and r.get("label")]


def extra(row):
    return row.get("extra") or {}


def date_of(row):
    d = row.get("date")
    return d[:10] if d else None


def pick(rng, forms, *args):
    f = rng.choice(forms)
    return f % args[:f.count("%s")] if args else f


def num_words(n):
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else " " + ONES[n % 10])
    if n < 1000:
        r = n % 100
        return ONES[n // 100] + " hundred" + ("" if not r else " and " + num_words(r))
    r = n % 1000
    return num_words(n // 1000) + " thousand" + ("" if not r else (" and " if r < 100 else " ") + num_words(r))


def money_say(rng, W, units, bare_ok=True):
    """how the person says an amount of money: words or digits, with or without the currency"""
    cur = CURRENCY.get(W["currency"], "dollars")
    r = rng.random()
    if r < 0.5:
        return "%s %s" % (num_words(units), cur)
    if r < 0.75:
        return "%d %s" % (units, cur)
    return num_words(units) if bare_ok else "%s %s" % (num_words(units), cur)


def round_units(x):
    for step in (1000, 500, 100, 50, 10, 5):
        if x >= step * 4:
            return int(x // step * step)
    return max(1, int(x))


def unique_label(S, rng, kind, rows, tries=12, two=0.3, want=None):
    """(row, phrase): `(kind called "phrase")` names exactly that row"""
    rows = [r for r in rows if r.get("label")]
    if not rows:
        raise Fail("no %s" % kind)
    for _ in range(tries):
        r = rng.choice(rows)
        try:
            kw = phrase(rng, r["label"], two)
        except Fail:
            continue
        got = S.peek('show (%s called "%s")' % (kind, q(kw)))
        if len(got) == 1 and got[0]["label"] == r["label"] and (want is None or want(r, kw)):
            return r, kw
    raise Fail("no uniquely named %s" % kind)


def rows_of(S, kind):
    return live(S.peek("show (%s)" % kind))


def people(S):
    return [p for p in rows_of(S, "parties") if p["label"] != "Owner" and " " in p["label"]]


def unique_first(S, p):
    return len(S.peek('show (parties called "%s")' % first(p["label"]))) == 1


def person_name(S, rng, p, p_first=0.45):
    """a name the person would say that picks out exactly `p`"""
    if rng.random() < p_first and unique_first(S, p):
        return first(p["label"])
    return p["label"]


def probe_write(S, kind, label, verb, trashed=False):
    """would `verb` on the row land? Tried in a throwaway session on the world's probe server."""
    key = (kind, label, verb, trashed)
    cache = S.W.setdefault("probe_cache", {})
    if key in cache:
        return cache[key]
    srv = S.W.get("probe")
    if srv is None:
        return True
    srv.ask({"op": "open"})
    srv.ask({"op": "turn", "request": "probe"})
    line = 'show (%s called "%s")' % (kind, q(label))
    if trashed:
        line += " that (deleted_at is not null)"
    r = srv.ask({"op": "call", "line": line})
    ok = False
    for n, k, lab, _ in ROW.findall(r.get("obs", "")):
        if lab == label:
            w = srv.ask({"op": "call", "line": "%s on #%s" % (verb, n)})
            ok = w.get("end") == "wrote"
            break
    cache[key] = ok
    return ok


# -- look / miss controllers --------------------------------------------------------------------

class Mix:
    def __init__(self):
        self.looks = collections.Counter()
        self.reads = 0
        self.misses = 0

    def n_looks(self, rng, lo=0, hi=2):
        """steer the read turns toward LOOK_MIX, within what the cell allows"""
        tot = max(1, sum(self.looks.values()))
        opts = list(range(lo, hi + 1))
        ws = [max(0.003, LOOK_MIX[min(n, 2)] - self.looks[min(n, 2)] / tot) * 10 + 0.03 for n in opts]
        return rng.choices(opts, ws)[0]

    def want_miss(self, rng):
        frac = self.misses / max(1, self.reads)
        return rng.random() < (0.55 if frac < MISS_RATE else 0.04)


MIX = Mix()


def try_miss(S, rng, line, expect):
    """sometimes open a read on a plausible miss (verified with a raw peek first)"""
    if not MIX.want_miss(rng):
        return False
    r = S.srv.ask({"op": "peek", "line": line})
    if expect == "field":
        ok = "error" in r and "unknown field" in r["error"]
    elif expect == "none":
        ok = "error" not in r and r.get("rows") == []
    elif expect == "nolink":
        ok = r.get("error") == "declined clarify"
    else:
        ok = False
    if not ok:
        return False
    S.miss(line, expect)
    return True


def explore(S, rng, looks, lo=0, hi=2):
    """look 0, 1 or 2 times before answering (`looks` are candidate first looks; the second is a
    `get` of a row just shown, or another look)"""
    looks = [x for x in looks if x]
    if not looks:
        return 0
    n = MIX.n_looks(rng, lo, hi)
    if not n:
        return 0
    S.look(rng.choice(looks))
    if n >= 2:
        if S.last and (rng.random() < 0.65 or len(looks) == 1):
            S.look("get #%d" % rng.choice(S.last[:4])[0])
        else:
            prev = S.turns[-1]["steps"][-1]["call"]
            S.look(rng.choice([x for x in looks if x != prev] or looks))
    return n


def found(S, label, kind):
    """#n of a row in the last result, when present"""
    for n, k, lab in S.last:
        if lab == label and k == kind:
            return n
    return None


def look_for(S, rng, kind, kw, label, lo=1, hi=2, search_p=0.6):
    """look a named row up (search or show), sometimes `get` it; return its #n"""
    n_ = MIX.n_looks(rng, lo, hi)
    if n_ == 0:
        return None
    ent = KIND_ENT[kind]
    S.look('search "%s"' % q(kw) if rng.random() < search_p else 'show (%s called "%s")' % (kind, q(kw)))
    h = found(S, label, ent)
    if h is None:
        S.look('show (%s called "%s")' % (kind, q(kw)))
        h = S.handle(label, ent)
    elif n_ >= 2:
        S.look("get #%d" % h)
    return h


# == cells ====================================================================================
# A cell is f(S, rng). It checks that it applies (peeks only) BEFORE opening a turn and raises
# Fail if not (the cell is skipped); a Fail after its turn opened sinks the session.

FIRST, FOLLOW, PAIRS = [], [], []


def cell(table, skills, w=1.0, detour=False):
    def deco(f):
        f.skills = skills
        f.w = w
        f.detour = detour          # a read cell that can serve as a detour ("hang on --")
        table.append(f)
        return f
    return deco


# == auto tags ================================================================================

WRITE_SKILL = [
    (r"^schedule\.add_task", "write.add_task"), (r"^schedule\.propose_event", "write.event"),
    (r"^(knowledge\.create_note|locker\.add_item)", "write.note"), (r"^reschedule", "write.reschedule"),
    (r"^(complete|core\.star_document)\{", "write.mark"),
    (r"^(delete|cancel|core\.trash_document|tally\.delete_expense|people\.trash_person|locker\.trash_item|"
     r"media\.delete_asset)\{", "write.trash"),
    (r"^(restore|core\.restore_document|media\.restore_asset|tally\.undo_expense)\{", "write.restore"),
    (r"^locker\.reveal_receipt", "write.reveal"), (r"^media\.add_to_album", "write.album_add"),
    (r"^people\.log_interaction", "write.log_interaction"),
    (r"^(people\.settle_debt|tally\.settle_up)", "write.settle"),
    (r"^(tally\.add_expense|tally\.add_group_member)", "write.tally"),
]
LINK_SKILL = [
    (r"\bparties of \(", "link.parties_of"),
    (r"\b(obligations|contact channels|important dates|activities|events) of \(", "link.of_person"),
    (r"\b(expenses|members|settlements|groups) of \(", "link.of_group"),
    (r"\b(photos|places|albums|profiles) of \(|\bmember of \(", "link.media"),
    (r"\btasks of \(", "link.subtasks"),
]
EXEMPT_Q = re.compile(r'\b(kind|type|columns|status)\s*(=|!=|:)\s*"[^"]*"')
QUOTED = re.compile(r'"([^"]*)"')
RELWIN = re.compile(r"\bduring (today|tomorrow|yesterday|this weekend|last weekend|next weekend|this week|next week|"
                    r"last week|this month|next month|last month|next \d+ (?:weeks|days|months)|recently|"
                    r"(?:next |last )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|the \d+(?:st|nd|rd|th)|"
                    r"in \d+ days)\b")
WRITE_RE = re.compile(r"^[a-z_.]+\{")


def is_write(c):
    return bool(WRITE_RE.match(c))


def handles_in(c):
    return [int(x) for x in re.findall(r"#(\d+)", c)]


def auto_tags(S, ti):
    t = S.turns[ti]
    tags = set(t["skills"])
    calls = [st["call"] for st in t["steps"] if not st.get("miss")]
    names = S.W["names"]
    shown_here = {n for st in t["steps"] for n, _, _ in [(int(a), b, c) for a, b, c, _ in ROW.findall(st["obs"])]}
    for i, c in enumerate(calls):
        for qs in re.findall(r'(?:called|search) "([^"]+)"', c):
            if (qs[:1].isupper() and qs.lower() in S.W["titles"]) or \
                    any(w[:1].isupper() and w.lower() in names for w in qs.split()):
                tags.add("copy.name")
            else:
                tags.add("copy.anchor")
        for pat, sk in LINK_SKILL:
            if re.search(pat, c):
                tags.add(sk)
        if 'status != "completed"' in c:
            tags.add("filter.open")
        if re.search(r'favorite = true|starred = true|folder = "|notebooks (=|contains) "|due_at is null|'
                     r'party_id is not me|kind = "|role (=|contains) "', c):
            tags.add("filter.field")
        if re.search(r"(amount_minor|owed_to_me_minor|owed_to_them_minor) > [1-9]|effort_min = |count of photos = ", c):
            tags.add("filter.numeric")
        if "deleted_at is not null" in c:
            tags.add("filter.trashed")
        if re.search(r"\b(completed_at|due_at|spent_on|captured_at) during", c):
            tags.add("time.field")
        if re.search(r"\bfirst \d+ of \(", c):
            tags.add("time.order")
        if RELWIN.search(c):
            tags.add("time.window")
        if re.search(r"during in \d+ days|\bby: [+-]", c):
            tags.add("time.shift")
        if c.startswith("answer "):
            a = c[7:]
            if a.startswith("count of"):
                tags.add("num.count")
            if a.startswith("sum "):
                tags.add("num.sum")
            if a.startswith("amount_minor of"):
                tags.add("num.value_of")
            if a.startswith("balance of"):
                tags.add("num.balance")
        if "dtstart of (" in c:
            tags.add("num.dtstart_of")
        if re.search(r"owed_to_(me|them)_minor( of \(| > 0)", c):
            tags.add("num.owed")
        if c.startswith("refuse:"):
            tags.add("judge.refuse_outside" if "out_of_ontology" in c else "judge.refuse_guard")
        if is_write(c):
            for pat, sk in WRITE_SKILL:
                if re.search(pat, c) or re.search(r"\bthen " + pat[1:], c):
                    tags.add(sk)
            if re.search(r"\b(due_at|dtstart|to): ", c):
                tags.add("copy.date")
            body = QUOTED.sub('""', c)
            if " then " in body:
                tags.add("compose.then")
            targets = re.findall(r"\bon ((?:#\d+(?:, )?)+)", body)
            if any(len(handles_in(x)) >= 2 for x in targets) or "(it)" in body:
                tags.add("compose.bulk")
                tags.add("handle.them")
            prior = [x for x in calls[:i] if not x.startswith("answer")]
            if prior and any(n in shown_here for n in handles_in(body)):
                tags.add("compose.lookup_write")
        if re.search(r"\bthem\b", c):
            tags.add("handle.them")
        if c.startswith("answer ") and re.match(r"^answer #\d+, #\d+", c):
            tags.add("handle.them")
    # handles: far (first shown two or more turns back), picked (shown last turn, or among several here)
    multi = set()
    for st in t["steps"][:-1]:
        got = [int(a) for a, _, _, _ in ROW.findall(st["obs"])]
        if len(got) >= 2:
            multi |= set(got)
    prev = {m for m, _, _ in S.turns_shown(ti - 1)}
    for c in calls:
        if c.startswith("get "):
            continue
        for n in handles_in(c):
            seen = S.first_seen.get(n)
            if seen is None:
                continue
            if seen <= ti - 2 and n not in prev and n not in shown_here:
                tags.add("handle.far")
            elif "handle.ordinal" not in tags and "handle.far" not in tags:
                if (n in prev and n not in shown_here) or n in multi:
                    tags.add("handle.pick")
    return sorted(tags)


def turns_shown(S, ti):
    if ti < 0:
        return []
    return [(int(a), b, c) for st in S.turns[ti]["steps"] for a, b, c, _ in ROW.findall(st["obs"])]


Session.turns_shown = turns_shown


def say_check(S, ti):
    """every string a call copies from the message is in `say`; every relative day too"""
    t = S.turns[ti]
    seen_obs = []
    for u in S.turns[:ti + 1]:
        for st in u["steps"]:
            seen_obs.append(st["obs"])
    said = " | ".join(t["say"]).lower()
    earlier = " | ".join(s for u in S.turns[:ti] for s in u["say"]).lower()
    for st in t["steps"]:
        c = st["call"]
        if c.startswith("ask ") or c.startswith("get "):
            continue
        body = EXEMPT_Q.sub("", c)
        for qs in QUOTED.findall(body):
            if qs.lower() in said or qs.lower() in earlier:
                continue
            if any(qs in o for o in seen_obs[:-1]) and re.search(r'(folder|notebooks) = "%s"' % re.escape(qs), body):
                continue
            toks = set(re.findall(r"[\w']+", said + " " + earlier))
            if not all(w in toks for w in re.findall(r"[\w']+", qs.lower())):
                if os.environ.get("TRAJGEN_DEBUG"):
                    print("SAYFAIL", json.dumps(S.turns, ensure_ascii=False)[-1500:], file=sys.stderr)
                raise Fail("say misses %r" % qs)
        for m in RELWIN.finditer(c):
            w = m.group(1).split()[-1]
            if w not in said + earlier:
                raise Fail("say misses window %r" % m.group(1))
        m = re.search(r"\b(due_at|dtstart|to): ((?:next |last )?[a-z]+day|tomorrow|today|the \d+\w\w)", c)
        if m and m.group(2).split()[-1] not in said + earlier:
            raise Fail("say misses day %r" % m.group(2))


def finalize(S):
    for ti, t in enumerate(S.turns):
        if t.get("end") is None:
            raise Fail("turn without an end")
        say_check(S, ti)
        calls = [st["call"] for st in t["steps"]]
        last = calls[-1]
        if t["t"] == "read" and not last.startswith("answer"):
            raise Fail("read turn ends on %s" % last[:20])
        t["skills"] = auto_tags(S, ti)


# == first turns: people, names, kinds ========================================================

def set_swap(S, tmpl, cands, hint, skills, kind=None, pre=None, kw=False, topic="%s"):
    """remember how to ask the same question about another subject ('what about X?')"""
    S.ctx["swap"] = {"tmpl": tmpl, "cands": cands, "hint": hint, "skills": skills, "kind": kind, "pre": pre, "kw": kw,
                     "topic": topic}


@cell(FIRST, ["route.people", "copy.name"], w=2.0, detour=True)
def c_person(S, rng):
    p = rng.choice(people(S))
    name = person_name(S, rng, p)
    if name != p["label"] and rng.random() < 0.3:
        S.turn(pick(rng, ["asks what %s's surname is", "asks for %s's full name", "asks what %s's last name is"], name),
               [name], ["route.people"])
    else:
        S.turn(pick(rng, ["asks to find %s in their contacts", "asks to pull up %s", "asks who %s is",
                          "asks for %s's contact card", "asks to look up %s"], name), [name], ["route.people"])
    h = look_for(S, rng, "parties", name, p["label"], lo=0, search_p=0.7)
    S.answer("#%d" % h if h else '(parties called "%s")' % q(name))
    S.ctx.update(kind="parties", kw=name, focus=S.last[0][0], person=p, topic=name)
    others = [x for x in people(S) if x["label"] != p["label"]]
    set_swap(S, '(parties called "%s")', [(x["label"], x["label"]) for x in rng.sample(others, min(6, len(others)))],
             "asks the same about %s ('and %s?')", ["route.people"], "parties")


@cell(FIRST, ["route.people", "filter.field"], w=1.0, detour=True)
def c_role(S, rng):
    cands = []
    for p in people(S):
        role = extra(p).get("role") or ""
        ws = [w.lower() for w in role.split() if len(w) > 3 and w.lower() not in ("friend", "from", "club", "with", "best", "old")]
        for w in ws[-1:]:
            if len(S.peek('show (parties) that (role contains "%s")' % w)) == 1:
                cands.append((p, role, w))
    if not cands:
        raise Fail("no unique role")
    p, role, w = rng.choice(cands)
    S.turn(pick(rng, ["asks which contact is their %s", "asks who their %s is", "asks to find their %s in contacts",
                      "asks for the %s's contact"], role.lower()), [role.lower()], ["route.people"])
    expr = '(parties) that (role contains "%s")' % w
    if try_miss(S, rng, 'search "%s"' % role.lower(), "none"):
        pass
    elif rng.random() < 0.35:
        S.look("show " + expr)
        S.answer("#%d" % S.handle(p["label"], "party"))
        S.ctx.update(kind="parties", focus=S.last[0][0], person=p, topic="their %s" % role.lower())
        return
    S.answer(expr)
    S.ctx.update(kind="parties", focus=S.last[0][0], person=p, topic="their %s" % role.lower())


def shared_kw(S, kind, other=True):
    """keywords of `kind` that (when `other`) also name rows of another kind"""
    out = []
    for kw, kinds in S.W["meta"].get("shared_keywords", {}).items():
        if kind in kinds and (not other or len(kinds) >= 2):
            out.append(kw)
    return out


@cell(FIRST, ["route.everything"], w=1.5, detour=True)
def c_everything(S, rng):
    kws = [k for k in shared_kw(S, "notes") + shared_kw(S, "events") + shared_kw(S, "tasks") if len(k) > 3]
    rng.shuffle(kws)
    for kw in kws[:8]:
        kw = low(kw, S.W["names"]) if kw not in S.W["names"] else kw.capitalize()
        got = S.peek('show (things called "%s")' % kw)
        if 2 <= len(got) <= 12:
            break
    else:
        raise Fail("no small multi-kind keyword")
    S.turn(pick(rng, ["asks what they have about %s", "asks for everything mentioning %s",
                      "asks what's in the vault about %s", "asks for anything to do with %s"], kw),
           [kw], ["route.everything"])
    explore(S, rng, ['search "%s"' % kw])
    S.answer('(things called "%s")' % kw)
    S.ctx.update(kind="things", kw=kw, topic="the %s stuff" % kw)


@cell(FIRST, ["route.everything"], w=1.5, detour=True)
def c_find_one(S, rng):
    kind = rng.choice(["documents", "notes", "documents", "photos", "locker items"])
    try:
        r, kw = unique_label(S, rng, "things", rows_of(S, kind), two=0.9, want=lambda r, k: " " in k)
    except Fail:
        r, kw = unique_label(S, rng, "things", rows_of(S, kind), two=0.7)
    kw = low(kw, S.W["names"])
    S.turn(pick(rng, ["asks to find the %s", "asks where their %s is", "asks to pull up the %s thing",
                      "asks where the %s went"], kw), [kw], ["route.everything"])
    h = look_for(S, rng, kind, kw, r["label"], lo=0, search_p=0.9)
    S.answer("#%d" % h if h else '(things called "%s")' % q(kw))
    S.ctx.update(kind=kind, kw=kw, focus=S.last[0][0], row=r, topic="the %s" % kw)


KIND_WORDS = {
    "notes": ["notes", "notes", "written notes"],
    "documents": ["documents", "paperwork", "files", "documents"],
    "tasks": ["to-dos", "tasks", "list items"],
    "events": ["calendar events", "appointments", "calendar entries"],
    "photos": ["photos", "pictures", "shots"],
    "expenses": ["expenses", "spending entries"],
}
SIBLING = {"notes": ["documents"], "documents": ["notes"], "tasks": ["events"], "events": ["tasks"],
           "photos": ["documents", "notes"], "expenses": ["obligations", "tasks"]}


@cell(FIRST, ["route.library", "route.schedule", "route.media", "route.money", "copy.anchor"], w=5.0, detour=True)
def c_kind_called(S, rng):
    kind = rng.choice(["notes", "documents", "tasks", "events", "photos", "expenses", "notes", "documents",
                       "photos"])
    rows = rows_of(S, kind)
    kws = shared_kw(S, kind)
    kw = None
    if kws and rng.random() < 0.7:
        for k in rng.sample(kws, min(6, len(kws))):
            kk = k.capitalize() if k in S.W["names"] else k
            if 1 <= len(S.peek('show (%s called "%s")' % (kind, kk))) <= 8:
                kw = kk
                break
    if kw is None:
        r, kw = unique_label(S, rng, kind, rows, two=0.3)
        kw = low(kw, S.W["names"])
    word = rng.choice(KIND_WORDS[kind])
    S.turn(pick(rng, ["asks for their %s about %s", "asks which %s mention %s", "asks to find the %s on %s",
                      "asks if they have any %s about %s"], word, kw), [kw, word.split()[-1]], [ROUTE_OF[kind]])
    expr = rng.choice(['(%s called "%s")', '(%s) called "%s"']) % (kind, q(kw))
    wrong = [k for k in SIBLING[kind] if not S.peek('show (%s called "%s")' % (k, q(kw)))]
    if wrong and MIX.want_miss(rng):
        S.miss('show (%s called "%s")' % (wrong[0], q(kw)), "none")
        if rng.random() < 0.5:
            S.look('search "%s"' % q(kw))
        S.answer(expr)
    else:
        n = explore(S, rng, ['search "%s"' % q(kw), 'show (%s called "%s")' % (kind, q(kw))])
        ent = KIND_ENT[kind]
        picked = [m for m, k, _ in S.last if k == ent]
        if n == 1 and S.last_full and picked and rng.random() < 0.4 and \
                len(picked) == len(S.peek('show (%s called "%s")' % (kind, q(kw)))):
            S.answer(hs(picked))
        else:
            S.answer(expr)
    S.ctx.update(kind=kind, kw=kw, topic="the %s %s" % (kw, word.split()[-1]))
    others = [x for x in shared_kw(S, kind, other=False) if x.lower() != kw.lower()]
    set_swap(S, '(%s called "%%s")' % kind,
             [(x.capitalize() if x in S.W["names"] else x,) * 2 for x in rng.sample(others, min(6, len(others)))],
             "asks the same about %s instead ('what about %s?')", [ROUTE_OF[kind]], kind, kw=True,
             topic="the %%s %s" % KIND_SAY[kind])


@cell(FIRST, ["route.schedule"], w=2.5, detour=True)
def c_when_event(S, rng):
    e, kw = unique_label(S, rng, "events", rows_of(S, "events"), two=0.5)
    kw = low(kw, S.W["names"])
    S.turn(pick(rng, ["asks when the %s is", "asks what time the %s is", "asks what day the %s is on",
                      "asks when they have the %s"], kw), [kw], ["route.schedule"])
    try_miss(S, rng, 'show (tasks called "%s")' % q(kw), "none")
    h = look_for(S, rng, "events", kw, e["label"], lo=0)
    S.answer("#%d" % h if h and rng.random() < 0.6 else '(events called "%s")' % q(kw))
    S.ctx.update(kind="events", kw=kw, focus=S.last[0][0], row=e, day=date_of(e), topic="the %s" % kw)
    others = [x for x in rows_of(S, "events") if x["label"] != e["label"]]
    cands = []
    for x in rng.sample(others, min(8, len(others))):
        try:
            k2 = low(phrase(rng, x["label"], 0.4), S.W["names"])
        except Fail:
            continue
        if len(S.peek('show (events called "%s")' % q(k2))) == 1:
            cands.append((k2, k2))
    set_swap(S, '(events called "%s")', cands, "asks the same about the %s ('and the %s?')", ["route.schedule"],
             "events", kw=True, topic="the %s")


def dates_by_person(S):
    by = collections.defaultdict(list)
    for d in rows_of(S, "important dates"):
        if " — " in d["label"]:
            by[d["label"].split(" — ", 1)[1]].append(d)
    return by


@cell(FIRST, ["route.schedule", "copy.name"], w=2.0, detour=True)
def c_birthday(S, rng):
    by = dates_by_person(S)
    cands = [(nm, ds[0]) for nm, ds in by.items() if len(ds) == 1 and ds[0]["label"].startswith("Birthday")]
    if not cands:
        raise Fail("no birthdays")
    nm, d = rng.choice(cands)
    p = {"label": nm}
    name = person_name(S, rng, p, 0.4)
    S.turn(pick(rng, ["asks when %s's birthday is", "asks what date %s's birthday falls on",
                      "asks whether %s's birthday is coming up", "asks when they need to remember %s's birthday"],
                name), [name, "birthday"], ["route.schedule"])
    try_miss(S, rng, 'show (events called "%s birthday")' % q(name), "none")
    r = rng.random()
    if r < 0.6:
        S.answer('(important dates called "%s")' % q(name))
    elif r < 0.85:
        S.look('search "%s"' % q(name))
        S.answer("(important dates of (#%d))" % S.handle(nm, "party"))
    else:
        S.answer('important dates of (parties called "%s")' % q(name))
    S.ctx.update(kind="important dates", kw=name, topic="%s's birthday" % name)
    others = [(n2, n2) for n2, ds in cands if n2 != nm]
    set_swap(S, '(important dates called "%s")', rng.sample(others, min(5, len(others))),
             "asks the same about %s ('and %s's?')", ["route.schedule"], "important dates")


@cell(FIRST, ["route.schedule", "time.window"], w=1.0, detour=True)
def c_dates_window(S, rng):
    for _ in range(6):
        w = rng.choice(["this month", "next month", "next 2 weeks", "this week", "next week", "next 2 months"])
        if S.peek("show (important dates) during %s" % w):
            break
    else:
        raise Fail("no dates soon")
    S.turn(pick(rng, ["asks whose birthdays are coming up %s", "asks what birthdays or anniversaries there are %s",
                      "asks which important dates fall %s"], w.replace("2", "two")),
           [w.replace("next 2", "next two"), w.split()[-1]], ["route.schedule"])
    explore(S, rng, ["show (important dates)"], hi=1)
    S.answer(rng.choice(["(important dates) during %s", "(important dates during %s)"]) % w)
    S.ctx.update(kind="important dates", window=w, topic="the birthdays")


# == first turns: locker, days, tasks, filters, library, media ===============================

TAILS = ["wifi", "PIN", "code", "portal", "account", "password", "backup codes", "app", "login", "card",
         "membership"]


@cell(FIRST, ["route.locker"], w=2.5, detour=True)
def c_locker(S, rng):
    items = []
    for i in rows_of(S, "locker items"):
        for t in TAILS:
            if i["label"].endswith(" " + t) and len(i["label"]) > len(t) + 1:
                items.append((i, i["label"][:-len(t) - 1], t))
                break
    rng.shuffle(items)
    for it, name, tail in items:
        ws = name.split()
        kw = " ".join(ws[-2:]) if len(ws) > 2 else name
        kw = low(kw, S.W["names"]) if not any(w.lower() in S.W["names"] for w in kw.split()) else kw
        got = S.peek('show (locker items called "%s %s")' % (q(kw), tail))
        if len(got) == 1:
            break
    else:
        raise Fail("no unique locker item")
    tl = tail if tail in ("PIN",) else tail.lower()
    hint = {"wifi": ["asks what the wifi is at the %s", "asks for the %s wifi details"],
            "PIN": ["asks what the %s PIN is", "asks for the PIN for the %s"],
            "code": ["asks what the %s code is", "asks for the code for the %s"],
            "card": ["asks for the %s card details entry", "asks to see the %s card entry"],
            }.get(tail, ["asks for the %s " + tl + " entry", "asks what the %s " + tl + " details are",
                         "asks what the login for the %s " + tl + " is (not the password)"])
    S.turn(pick(rng, hint, kw), [kw, tl], ["route.locker"])
    expr = '(locker items called "%s %s")' % (q(kw), tl)
    things = S.peek('show (things called "%s")' % q(kw))
    if MIX.want_miss(rng) and not S.peek('show (documents called "%s %s")' % (q(kw), tl)):
        S.miss('show (documents called "%s %s")' % (q(kw), tl), "none")
        S.answer(expr)
    elif MIX.n_looks(rng, 0, 1) and len(things) <= 10:
        S.look('search "%s"' % q(kw))
        h = found(S, it["label"], "locker item")
        S.answer("#%d" % h if h else expr)
    else:
        S.answer(expr)
    S.ctx.update(kind="locker items", kw=kw, focus=S.last[0][0], topic="the %s %s" % (kw, tl))


@cell(FIRST, ["route.locker"], w=1.0, detour=True)
def c_locker_misc(S, rng):
    items = rows_of(S, "locker items")
    if rng.random() < 0.35:
        S.turn(pick(rng, ["asks how many things they have saved in the locker", "asks how many locker entries they have",
                          "asks how many passwords and codes are in their locker"]), [], ["route.locker"])
        S.answer("count of (locker items)")
        return
    cnt = collections.Counter(w.lower() for i in items for w in words(i["label"]))
    cands = [w for w, c in cnt.items() if 2 <= c <= 4]
    if not cands:
        raise Fail("no locker family")
    w = rng.choice(cands)
    w = w if w not in S.W["names"] else w.capitalize()
    S.turn(pick(rng, ["asks what %s entries they have in the locker", "asks for any %s entries in their locker",
                      "asks which locker items mention %s"], w), [w, "locker"], ["route.locker"])
    S.answer('(locker items called "%s")' % w)
    S.ctx.update(kind="locker items", kw=w, topic="the locker")


def window_with(S, rng, fmt, pool, lo=1, hi=99, tries=8):
    rng.shuffle(pool)
    for w in pool[:tries]:
        got = S.peek(fmt % w)
        if lo <= len(got) <= hi:
            return w, got
    raise Fail("no window for %s" % fmt)


def ordinal_day(rng, S):
    y, m, d = (int(x) for x in S.date.split("-"))
    dd = rng.randint(d + 1, min(d + 12, 28)) if d < 26 else rng.randint(1, 25)
    suf = "th" if 10 <= dd % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(dd % 10, "th")
    return "the %d%s" % (dd, suf)


@cell(FIRST, ["route.day", "time.window"], w=2.5, detour=True)
def c_day(S, rng):
    pool = DAYS + ["today", "tomorrow", "next friday", "next monday"] + [ordinal_day(rng, S) for _ in range(3)]
    w, _ = window_with(S, rng, "show (things during %s)", pool, 2, 14)
    S.turn(pick(rng, ["asks what's on %s", "asks what they have got %s", "asks how %s looks",
                      "asks if anything is happening %s", "asks what's planned for %s"], w), [w], ["route.day"])
    expr = "(things during %s) ordered by dtstart asc" % w
    if rng.random() < 0.15:
        expr = "(things during %s)" % w
    explore(S, rng, ["show (events during %s)" % w], hi=1)
    S.answer(expr)
    S.ctx.update(kind="things", window=w, topic=w)
    set_swap(S, "(things during %s) ordered by dtstart asc", [(x, x) for x in pool if x != w],
             "asks the same for %s ('and %s?')", ["route.day"], "things")


@cell(FIRST, ["route.day", "time.shift"], w=0.7, detour=True)
def c_in_days(S, rng):
    k = rng.choice([2, 3, 4, 5, 10])
    w = "in %d days" % k
    if not S.peek("show (things during %s)" % w):
        raise Fail("empty day")
    kw = num_words(k) if rng.random() < 0.6 else str(k)
    S.turn(pick(rng, ["asks what's on in %s days", "asks what they have %s days from now"], kw), [kw, "days"],
           ["route.day", "time.shift"])
    S.answer("(things during %s) ordered by dtstart asc" % w)
    S.ctx.update(kind="things", window=w, topic="that day")


@cell(FIRST, ["route.schedule", "time.window"], w=2.0, detour=True)
def c_events_window(S, rng):
    pool = ["this week", "next week", "this weekend", "tomorrow", "today"] + DAYS
    w, _ = window_with(S, rng, "show (events during %s)", pool, 1, 15)
    S.turn(pick(rng, ["asks which appointments they have %s", "asks what's in their calendar %s",
                      "asks which events they have %s"], w), [w], ["route.schedule"])
    explore(S, rng, ["show (things during %s)" % w], hi=1)
    S.answer(rng.choice(["(events) during %s", "(events during %s)"]) % w)
    S.ctx.update(kind="events", window=w, topic="the %s calendar" % w)
    set_swap(S, "(events) during %s", [(x, x) for x in pool if x != w], "asks the same for %s ('and %s?')",
             ["route.schedule"], "events")


@cell(FIRST, ["route.schedule", "time.field"], w=2.0, detour=True)
def c_due(S, rng):
    pool = DAYS + ["today", "tomorrow", "this week", "next week", "this weekend"]
    still = rng.random() < 0.4
    fmt = '(tasks) that (due_at during %s and status != "completed")' if still else "(tasks) that (due_at during %s)"
    w, _ = window_with(S, rng, "show " + fmt, pool, 1, 12)
    S.turn(pick(rng, ["asks what is still due %s", "asks what they still have to get done %s"] if still else
                ["asks what's due %s", "asks which to-dos are due %s", "asks what tasks fall due %s"], w), [w],
           ["route.schedule"])
    if MIX.want_miss(rng):
        S.miss("show (tasks) that (due = %s)" % w if " " not in w else "show (tasks) that (due during %s)" % w, "field")
    else:
        explore(S, rng, ['show (tasks that (status != "completed"))', "show (tasks during %s)" % w], hi=1)
    S.answer(fmt % w)
    S.ctx.update(kind="tasks", window=w, topic="the tasks due %s" % w)
    set_swap(S, fmt, [(x, x) for x in pool if x != w], "asks the same for %s ('and %s?')", ["route.schedule"],
             "tasks")


@cell(FIRST, ["route.schedule", "filter.open"], w=1.5, detour=True)
def c_open(S, rng):
    if rng.random() < 0.6:
        S.turn(pick(rng, ["asks which tasks are still open", "asks what's still on their list",
                          "asks what they still have to do", "asks what's left on their to-do list",
                          "asks what they haven't done yet"]), [], ["route.schedule"])
        explore(S, rng, ["show (tasks)"], hi=1)
        S.answer('(tasks) that (status != "completed")')
        S.ctx.update(kind="tasks", topic="the open tasks")
    else:
        S.turn(pick(rng, ["asks what is overdue", "asks what they're behind on", "asks if they're late on any tasks",
                          "asks which to-dos are past their due date and not done"]), [], ["route.schedule"])
        explore(S, rng, ['show (tasks that (status != "completed"))'], hi=1)
        S.answer('(tasks) that (due_at during before now and status != "completed")')
        S.ctx.update(kind="tasks", topic="the overdue tasks")


@cell(FIRST, ["route.schedule", "filter.open"], w=1.0, detour=True)
def c_kw_open(S, rng):
    tasks = [t for t in rows_of(S, "tasks") if extra(t).get("status") != "completed"]
    cnt = collections.Counter(w.lower() for t in rows_of(S, "tasks") for w in set(words(t["label"])))
    cands = [w for w, c in cnt.items() if 2 <= c <= 6 and any(w in t["label"].lower() for t in tasks)]
    if not cands:
        raise Fail("no task family")
    w = rng.choice(cands)
    w = w.capitalize() if w in S.W["names"] else w
    expr = '(tasks called "%s") that (status != "completed")' % w
    if not S.peek("show " + expr):
        raise Fail("none open")
    S.turn(pick(rng, ["asks which %s tasks they haven't done yet", "asks which %s jobs are still open",
                      "asks what's left to do about the %s"], w), [w], ["route.schedule"])
    explore(S, rng, ['show (tasks called "%s")' % w, 'search "%s"' % w], hi=1)
    S.answer(expr)
    S.ctx.update(kind="tasks", kw=w, topic="the %s tasks" % w)


@cell(FIRST, ["route.schedule", "filter.field"], w=1.0, detour=True)
def c_no_deadline(S, rng):
    expr = '(tasks) that (due_at is null and status != "completed")'
    if not S.peek("show " + expr):
        raise Fail("no undated tasks")
    S.turn(pick(rng, ["asks which to-dos have no deadline", "asks what tasks have no due date",
                      "asks what's on their list with no date set", "asks which open tasks are undated"]), [],
           ["route.schedule"])
    explore(S, rng, ['show (tasks that (status != "completed"))'], hi=1)
    S.answer(expr)
    S.ctx.update(kind="tasks", topic="the undated tasks")


@cell(FIRST, ["time.field", "route.schedule"], w=1.5, detour=True)
def c_done(S, rng):
    w, _ = window_with(S, rng, "show (tasks that (completed_at during %s))",
                       ["last week", "yesterday", "this week", "last weekend", "today"], 1, 12)
    S.turn(pick(rng, ["asks what they ticked off %s", "asks what they got done %s", "asks which tasks they finished %s",
                      "asks what they completed %s"], w), [w], ["route.schedule"])
    if not try_miss(S, rng, "show (tasks) that (completed during %s)" % w, "field"):
        explore(S, rng, ['show (tasks) that (status = "completed")'], hi=1)
    S.answer(rng.choice(["tasks that (completed_at during %s)", "(tasks) that (completed_at during %s)"]) % w)
    S.ctx.update(kind="tasks", window=w, topic="what they finished")


@cell(FIRST, ["filter.field", "route.media", "route.library"], w=2.0, detour=True)
def c_flags(S, rng):
    if rng.random() < 0.6:
        if not S.peek("show (photos that (favorite = true))"):
            raise Fail("no favourites")
        S.turn(pick(rng, ["asks for their favourite photos", "asks for the pictures they marked as favourites",
                          "asks which photos are favourites", "asks to see their favourited pics"]), [],
               ["route.media"])
        if MIX.want_miss(rng):
            S.miss("show (photos) that (favourite = true)", "field")
        else:
            explore(S, rng, ["show (photos)"], hi=1)
        S.answer(rng.choice(["(photos) that (favorite = true)", "(photos that (favorite = true))"]))
        S.ctx.update(kind="photos", topic="the favourite photos")
    else:
        if not S.peek("show (documents that (starred = true))"):
            raise Fail("no starred")
        S.turn(pick(rng, ["asks which documents they starred", "asks for their starred files",
                          "asks to see the documents they marked with a star"]), [], ["route.library"])
        explore(S, rng, ["show (documents)"], hi=1)
        S.answer("(documents) that (starred = true)")
        S.ctx.update(kind="documents", topic="the starred documents")


def folders(S):
    return sorted({extra(d).get("folder") for d in rows_of(S, "documents")} - {None, ""})


def notebooks(S):
    return sorted({x for d in rows_of(S, "notes") for x in (extra(d).get("notebooks") or "").split(", ")} - {""})


@cell(FIRST, ["filter.field", "route.library"], w=2.0, detour=True)
def c_folder(S, rng):
    fs = [f for f in folders(S) if S.peek('show (documents that (folder = "%s"))' % f)]
    if not fs:
        raise Fail("no folders")
    f = rng.choice(fs)
    if rng.random() < 0.25:
        S.turn(pick(rng, ["asks how many documents are in the %s folder", "asks how many files they have under %s"], f),
               [f], ["route.library"])
        S.answer('count of ((documents) that (folder = "%s"))' % f)
        return
    S.turn(pick(rng, ["asks what is in their %s folder", "asks what they have filed under %s",
                      "asks for the documents in the %s folder", "asks what paperwork is kept in %s"], f), [f],
           ["route.library"])
    if not try_miss(S, rng, 'show (notes) that (folder = "%s")' % f, "none"):
        explore(S, rng, ["show (documents)"], hi=1)
    S.answer(rng.choice(['(documents) that (folder = "%s")', '(documents that (folder = "%s"))']) % f)
    S.ctx.update(kind="documents", folder=f, topic="the %s folder" % f)
    set_swap(S, '(documents) that (folder = "%s")', [(x, x) for x in fs if x != f],
             "asks the same for the %s folder ('and %s?')", ["route.library"], "documents", topic="the %s folder")


@cell(FIRST, ["filter.field", "route.library"], w=1.5, detour=True)
def c_notebook(S, rng):
    nbs = [n for n in notebooks(S)]
    if not nbs:
        raise Fail("no notebooks")
    nb = rng.choice(nbs)
    if rng.random() < 0.2:
        S.turn(pick(rng, ["asks how many notes are in the %s notebook", "asks how many notes they have in %s"], nb),
               [nb, "notebook"], ["route.library"])
        S.answer('count of ((notes) that (notebooks = "%s"))' % nb)
        return
    S.turn(pick(rng, ["asks for the notes in their %s notebook", "asks what's in the %s notebook",
                      "asks what they've written in the %s notebook"], nb), [nb, "notebook"], ["route.library"])
    if MIX.want_miss(rng):
        S.miss('show (notes) that (notebook = "%s")' % nb, "field")
    else:
        explore(S, rng, ["show (notes)"], hi=1)
    S.answer('(notes) that (notebooks = "%s")' % nb)
    S.ctx.update(kind="notes", topic="the %s notebook" % nb)
    set_swap(S, '(notes) that (notebooks = "%s")', [(x, x) for x in nbs if x != nb],
             "asks the same for the %s notebook ('and %s?')", ["route.library"], "notes", topic="the %s notebook")


@cell(FIRST, ["route.library", "time.window", "time.order"], w=1.5, detour=True)
def c_journal(S, rng):
    if rng.random() < 0.65:
        w, _ = window_with(S, rng, "show (journal notes) during %s",
                           ["last weekend", "this week", "last week", "yesterday", "recently", "this month",
                            "last month"], 1, 10)
        S.turn(pick(rng, ["asks what they wrote in their journal %s", "asks for their journal entries from %s",
                          "asks to see the diary entries they made %s"], w), [w, rng.choice(["journal", "diary"])],
               ["route.library"])
        explore(S, rng, ["show (journal notes)"], hi=1)
        S.answer("(journal notes) during %s" % w)
    else:
        if not S.peek("show (journal notes)"):
            raise Fail("no journal")
        S.turn(pick(rng, ["asks what the last thing they wrote in their journal was",
                          "asks for their most recent journal entry", "asks for their latest diary entry"]), [],
               ["route.library", "time.order"])
        explore(S, rng, ["show (journal notes)"], hi=1)
        S.answer("first 1 of ((journal notes) ordered by captured_at desc)")
    S.ctx.update(kind="journal notes", topic="the journal")


def album_rows(S):
    names = set(S.W["meta"].get("albums", []))
    return [a for a in rows_of(S, "albums") if a["label"] in names]


@cell(FIRST, ["route.media"], w=2.0, detour=True)
def c_media_list(S, rng):
    r = rng.random()
    if r < 0.4:
        if not album_rows(S):
            raise Fail("no albums")
        S.turn(pick(rng, ["asks what albums they have", "asks for their photo albums", "asks to list the albums"]), [],
               ["route.media"])
        S.answer(rng.choice(["albums", "(albums)"]))
        S.ctx.update(kind="albums", topic="the albums")
    elif r < 0.8:
        if not S.peek("show places"):
            raise Fail("no places")
        S.turn(pick(rng, ["asks what places they have in their photos", "asks which places their photos were taken at",
                          "asks for the list of places in their photo library"]), [], ["route.media"])
        explore(S, rng, ["show (photos)"], hi=1)
        S.answer("places")
        S.ctx.update(kind="places", topic="the places")
    else:
        k = rng.choice([1, 2, 2, 3, 4])
        expr = "(places that (count of photos = %d))" % k
        if not S.peek("show " + expr):
            raise Fail("no place with %d photos" % k)
        kw = num_words(k) if k > 1 or rng.random() < 0.5 else "one"
        S.turn("asks which places they have exactly %s photo%s from" % (kw, "" if k == 1 else "s"), [kw],
               ["route.media", "copy.number"])
        explore(S, rng, ["show (places)"], hi=1)
        S.answer(expr)
        S.ctx.update(kind="places", topic="those places")


MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december"]


def month_range(S, back):
    y, m, _ = (int(x) for x in S.date.split("-"))
    m -= back
    while m <= 0:
        m += 12
        y -= 1
    import calendar
    last = calendar.monthrange(y, m)[1]
    return MONTHS[m - 1], "%04d-%02d-01..%04d-%02d-%02d" % (y, m, y, m, last)


@cell(FIRST, ["route.media", "time.window", "time.field", "time.order"], w=2.0, detour=True)
def c_photos_time(S, rng):
    r = rng.random()
    if r < 0.4:
        for _ in range(5):
            mon, rg = month_range(S, rng.randint(1, 5))
            if S.peek("show (photos) that (captured_at during %s)" % rg):
                break
        else:
            raise Fail("no photo month")
        S.turn(pick(rng, ["asks for their photos from %s", "asks what pictures they took in %s",
                          "asks to see the shots from %s"], mon.capitalize()), [mon.capitalize()],
               ["route.media", "time.window"])
        S.answer("(photos) that (captured_at during %s)" % rg)
        S.ctx.update(kind="photos", topic="the %s photos" % mon.capitalize())
    elif r < 0.75:
        w, _ = window_with(S, rng, "show (photos) that (captured_at during %s)",
                           ["last weekend", "last week", "this month", "last month", "this week", "yesterday",
                            "recently"], 1, 15)
        S.turn(pick(rng, ["asks for the photos they took %s", "asks what pictures they have from %s"], w), [w],
               ["route.media"])
        if not try_miss(S, rng, "show (photos) that (taken_at during %s)" % w, "field"):
            explore(S, rng, ["show (photos)"], hi=1)
        S.answer("(photos) that (captured_at during %s)" % w)
        S.ctx.update(kind="photos", window=w, topic="the photos from %s" % w)
    else:
        if not S.peek("show (photos)"):
            raise Fail("no photos")
        S.turn(pick(rng, ["asks for their newest photo", "asks what the most recent picture they took is",
                          "asks for the last photo they took"]), [], ["route.media", "time.order"])
        S.answer("first 1 of ((photos) ordered by captured_at desc)")
        S.ctx.update(kind="photos", focus=S.last[0][0], topic="that photo")


@cell(FIRST, ["time.order", "route.day"], w=0.8, detour=True)
def c_earliest(S, rng):
    w, _ = window_with(S, rng, "show (things during %s)", ["tomorrow", "today"] + DAYS, 2, 20)
    kind, words_ = rng.choice([("things", "thing"), ("events", "appointment")])
    if not S.peek("show (%s during %s)" % (kind, w)):
        raise Fail("empty")
    S.turn(pick(rng, ["asks what their first %s is %s", "asks what their earliest %s is %s"], words_, w), [w],
           ["time.order"])
    S.answer("first 1 of ((%s during %s) ordered by dtstart asc)" % (kind, w))
    S.ctx.update(kind=kind, window=w, focus=S.last[0][0], topic=w)


@cell(FIRST, ["filter.numeric", "copy.number"], w=1.2, detour=True)
def c_effort(S, rng):
    vals = sorted({extra(t).get("effort_min") for t in rows_of(S, "tasks")
                   if extra(t).get("status") != "completed"} - {None})
    if not vals:
        raise Fail("no effort")
    v = int(rng.choice(vals))
    said = {15: ["a quarter of an hour", "fifteen minute"], 30: ["half an hour", "thirty minute"],
            60: ["an hour", "one hour"], 45: ["forty five minute"], 90: ["an hour and a half", "ninety minute"],
            120: ["two hour", "two-hour"], 10: ["ten minute"], 20: ["twenty minute"]}.get(
        v, ["%s hour" % num_words(v // 60)] if v % 60 == 0 else ["%s minute" % num_words(v)])
    s = rng.choice(said)
    S.turn(pick(rng, ["asks which task is roughly a %s job", "asks which to-dos take about %s",
                      "asks for the %s jobs on their list"], s), [s], ["filter.numeric", "copy.number"])
    if not try_miss(S, rng, "show (tasks) that (effort = %d)" % v, "field"):
        explore(S, rng, ["show (tasks) that (effort_min = %d)" % v], hi=1)
    S.answer('(tasks) that (effort_min = %d and status != "completed")' % v)
    S.ctx.update(kind="tasks", topic="those jobs")


@cell(FIRST, ["route.schedule", "copy.name"], w=1.5, detour=True)
def c_place_events(S, rng):
    """'what's on at <place>': events are not linked to places -- the name is on the event"""
    cands = []
    for p in rows_of(S, "places"):
        got = S.peek('show (events called "%s")' % q(p["label"]))
        if 1 <= len(got) <= 6:
            cands.append(p)
    if not cands:
        raise Fail("no events at places")
    p = rng.choice(cands)
    kw = p["label"]
    S.turn(pick(rng, ["asks what's on at %s", "asks what events they have at %s", "asks when they're next at %s"], kw),
           [kw], ["route.schedule"])
    if not try_miss(S, rng, 'show events of (places called "%s")' % q(kw), "nolink"):
        explore(S, rng, ['search "%s"' % q(kw)], hi=1)
    S.answer('(events called "%s")' % q(kw))
    S.ctx.update(kind="events", kw=kw, topic="the %s events" % kw)


@cell(FIRST, ["route.library", "route.money"], w=1.0, detour=True)
def c_expense_docs(S, rng):
    """'paperwork for the X bill': documents are not linked to expenses -- use the name"""
    cands = []
    for e in rows_of(S, "expenses"):
        for w in words(e["label"]):
            w2 = w if w.lower() in S.W["names"] else w.lower()
            if w2.lower() in GENERIC:
                continue
            if 1 <= len(S.peek('show (documents called "%s")' % w2)) <= 4 and \
                    len(S.peek('show (expenses called "%s")' % w2)) == 1:
                cands.append((e, w2))
    if not cands:
        raise Fail("no expense with paperwork")
    e, w = rng.choice(cands)
    S.turn(pick(rng, ["asks if they have any paperwork for the %s expense", "asks for the documents that go with the %s expense"],
                w), [w, "expense"], ["route.library"])
    if not try_miss(S, rng, 'show documents of (expenses called "%s")' % q(w), "nolink"):
        explore(S, rng, ['search "%s"' % q(w)], hi=1)
    S.answer('(documents called "%s")' % q(w))
    S.ctx.update(kind="documents", kw=w, topic="the %s paperwork" % w)


# == first turns: links from people, events, photos, groups ==================================

def person_with(S, rng, link, where="", k=8):
    ps = people(S)
    rng.shuffle(ps)
    for p in ps[:40]:
        if S.peek_ok('show (%s of (parties called "%s"))%s' % (link, q(p["label"]), where)) and \
                len(S.peek('show (parties called "%s")' % q(p["label"]))) == 1:
            return p
    raise Fail("no person with %s" % link)


def person_ref(S, rng, p, kind_hint="parties"):
    """look the person up (search / show) or not; returns the set expression naming them"""
    name = person_name(S, rng, p)
    return name


def person_answer(S, rng, p, name, tmpl, lo=0):
    """answer tmpl % <person set>: through a looked-up #n, or the called-set inline"""
    n = MIX.n_looks(rng, lo, 2)
    if n:
        S.look(rng.choice(['search "%s"' % q(name), 'show (parties called "%s")' % q(name)]))
        h = S.handle(p["label"], "party")
        if n == 2:
            S.look("get #%d" % h)
        S.answer(tmpl % ("#%d" % h))
        return h
    S.answer(tmpl % ('parties called "%s"' % q(name)))
    return None


@cell(FIRST, ["link.of_person"], w=2.0, detour=True)
def c_contact(S, rng):
    kind = rng.choice(["phone", "email"])
    p = person_with(S, rng, "contact channels", ' that (kind = "%s")' % kind)
    name = person_name(S, rng, p)
    word = {"phone": ["phone number", "number", "mobile number"], "email": ["email address", "email"]}[kind]
    S.turn(pick(rng, ["asks for %s's " + rng.choice(word), "asks what %s's " + rng.choice(word) + " is"], name),
           [name], ["link.of_person"])
    if kind == "phone":
        try_miss(S, rng, 'show (contact channels of (parties called "%s")) that (kind = "mobile")' % q(name), "none")
    person_answer(S, rng, p, name, '(contact channels of (%%s)) that (kind = "%s")' % kind)
    S.ctx.update(kind="contact channels", person=p, topic="%s's details" % name)


@cell(FIRST, ["link.of_person", "time.order"], w=1.5, detour=True)
def c_last_contact(S, rng):
    p = person_with(S, rng, "activities")
    name = person_name(S, rng, p)
    S.turn(pick(rng, ["asks when they last spoke to %s", "asks when they last heard from %s",
                      "asks what their most recent contact with %s was", "asks when they were last in touch with %s"],
                name), [name], ["link.of_person"])
    if rng.random() < 0.7:
        person_answer(S, rng, p, name, "first 1 of ((activities of (%s)) ordered by started_at desc)", lo=1)
    else:
        person_answer(S, rng, p, name, "(activities of (%s))")
    S.ctx.update(kind="activities", person=p, topic=name)


@cell(FIRST, ["link.of_person"], w=1.5, detour=True)
def c_person_events(S, rng):
    p = person_with(S, rng, "events")
    name = person_name(S, rng, p)
    S.turn(pick(rng, ["asks what events %s is coming to", "asks when they're next seeing %s",
                      "asks which calendar events %s is on"], name), [name], ["link.of_person"])
    person_answer(S, rng, p, name, "events of (%s)", lo=0)
    S.ctx.update(kind="events", person=p, topic="%s's events" % name)


def open_obligations(S, name):
    return [o for o in live(S.peek('show (obligations of (parties called "%s"))' % q(name)))]


@cell(FIRST, ["route.money", "link.of_person"], w=1.5, detour=True)
def c_person_debts(S, rng):
    rows = [r for r in live(S.peek("show (parties that (owed_to_me_minor > 0 or owed_to_them_minor > 0))"))
            if len(S.peek('show (parties called "%s")' % q(r["label"]))) == 1 and open_obligations(S, r["label"])]
    if not rows:
        raise Fail("no debts")
    p = rng.choice(rows)
    name = person_name(S, rng, p)
    S.turn(pick(rng, ["asks whether they owe %s anything", "asks whether %s owes them anything",
                      "asks what debts there are between them and %s", "asks if %s is in debt to them"], name), [name],
           ["route.money"])
    person_answer(S, rng, p, name, "obligations of (%s)", lo=0)
    S.ctx.update(kind="obligations", person=p, topic="the debts with %s" % name)
    others = [x for x in rows if x["label"] != p["label"]]
    set_swap(S, 'obligations of (parties called "%s")', [(x["label"], x["label"]) for x in others[:5]],
             "asks the same about %s ('and %s?')", ["route.money"], "obligations")


@cell(FIRST, ["num.owed"], w=1.5, detour=True)
def c_owed(S, rng):
    if rng.random() < 0.5:
        expr = "(parties that (owed_to_me_minor > 0))"
        hint = pick(rng, ["asks who owes them money", "asks who still has to pay them back", "asks if anyone owes them cash"])
    else:
        expr = "(parties that (owed_to_them_minor > 0))"
        hint = pick(rng, ["asks who they owe money to", "asks who they still have to pay back", "asks who they're in debt to"])
    if not S.peek("show " + expr):
        raise Fail("no debts")
    S.turn(hint, [], ["num.owed"])
    try_miss(S, rng, "show (obligations) that (%s)" % expr[15:-2], "none")
    S.answer(expr)
    S.ctx.update(kind="parties", set=expr, topic="the money")


@cell(FIRST, ["num.owed"], w=1.5, detour=True)
def c_owed_amount(S, rng):
    field = rng.choice(["owed_to_me_minor", "owed_to_them_minor"])
    rows = [r for r in live(S.peek("show (parties that (%s > 0))" % field))
            if len(S.peek('show (parties called "%s")' % q(r["label"]))) == 1]
    if not rows:
        raise Fail("no debts")
    p = rng.choice(rows)
    name = person_name(S, rng, p)
    S.turn(pick(rng, {"owed_to_me_minor": ["asks how much %s owes them", "asks what %s still owes them"],
                      "owed_to_them_minor": ["asks how much they owe %s", "asks what their debt to %s is"]}[field], name),
           [name], ["num.owed"])
    h = person_answer(S, rng, p, name, "%s of (%%s)" % field, lo=1)
    S.ctx.update(kind="parties", focus=h, person=p, topic=name)
    others = [x for x in rows if x["label"] != p["label"]]
    set_swap(S, '%s of (parties called "%%s")' % field, [(x["label"], x["label"]) for x in others[:5]],
             "asks the same about %s ('and %s?')", ["num.owed"], None)


def events_with_people(S):
    return [e for e in rows_of(S, "events") if extra(e).get("attendee_party_ids")]


@cell(FIRST, ["link.parties_of"], w=2.0, detour=True)
def c_event_people(S, rng):
    e, kw = unique_label(S, rng, "events", events_with_people(S), two=0.5)
    kw = low(kw, S.W["names"])
    S.turn(pick(rng, ["asks who is coming to the %s", "asks who'll be at the %s", "asks who's invited to the %s",
                      "asks who they're seeing at the %s"], kw), [kw], ["link.parties_of"])
    notme = rng.random() < 0.6
    tail = " that (party_id is not me)" if notme else ""
    if rng.random() < 0.25:
        S.answer('(parties of (events called "%s"))%s' % (q(kw), tail))
    else:
        S.look('search "%s"' % q(kw) if rng.random() < 0.5 else 'show (events called "%s")' % q(kw))
        n = S.handle(e["label"], "event")
        if MIX.n_looks(rng, 1, 2) == 2:
            S.look("get #%d" % n)
        S.answer("(parties of (#%d))%s" % (n, tail))
        S.ctx["event"] = n
    S.ctx.update(kind="parties", topic="the %s" % kw)


def photos_with_faces(S):
    out = []
    for p in rows_of(S, "photos"):
        if extra(p).get("people") or extra(p).get("profile_ids") or extra(p).get("party_ids"):
            out.append(p)
    if not out:
        for f in S.W["meta"].get("faces_intended", []):
            got = S.peek_ok('show (parties of (photos called "%s"))' % q(f["photo"]))
            if got and not isinstance(got, (int, float)):
                out += [p for p in rows_of(S, "photos") if p["label"] == f["photo"]]
    return out


@cell(FIRST, ["link.parties_of", "route.media"], w=1.5, detour=True)
def c_photo_people(S, rng):
    ph, kw = unique_label(S, rng, "photos", photos_with_faces(S), two=0.5)
    kw = low(kw, S.W["names"])
    S.turn(pick(rng, ["asks who is in the %s photo", "asks who's in the %s picture", "asks which people are in the %s shot"],
                kw), [kw], ["link.parties_of"])
    S.look('search "%s"' % q(kw) if rng.random() < 0.5 else 'show (photos called "%s")' % q(kw))
    n = S.handle(ph["label"], "photo")
    S.answer("parties of (#%d)" % n)
    S.ctx.update(kind="parties", photo=n, topic="the %s photo" % kw)


@cell(FIRST, ["link.media", "route.media"], w=2.5, detour=True)
def c_person_photos(S, rng):
    p = person_with(S, rng, "photos")
    name = person_name(S, rng, p)
    S.turn(pick(rng, ["asks if they have photos of %s", "asks for pictures with %s in them", "asks to see photos of %s"],
                name), [name], ["route.media"])
    try_miss(S, rng, 'show (photos called "%s")' % q(name), "none")
    person_answer(S, rng, p, name, "photos of (%s)", lo=1)
    S.ctx.update(kind="photos", person=p, topic="the photos of %s" % name)


@cell(FIRST, ["link.media", "route.media"], w=2.5, detour=True)
def c_album_photos(S, rng):
    albums = [a for a in album_rows(S) if S.peek('show (photos of (albums called "%s"))' % q(a["label"]))]
    a, kw = unique_label(S, rng, "albums", albums, two=0.8)
    kw = a["label"] if rng.random() < 0.6 and len(S.peek('show (albums called "%s")' % q(a["label"]))) == 1 else kw
    S.turn(pick(rng, ["asks for the photos in the %s album", "asks to open the %s album",
                      "asks what pictures are in the %s album"], kw), [kw, "album"], ["route.media"])
    if rng.random() < 0.3:
        S.answer('photos of (albums called "%s")' % q(kw))
    else:
        S.look('search "%s"' % q(kw) if rng.random() < 0.6 else 'show (albums called "%s")' % q(kw))
        n = S.handle(a["label"], "album")
        S.answer("photos of (#%d)" % n)
        S.ctx["album"] = n
    S.ctx.update(kind="photos", topic="the %s album" % kw)


@cell(FIRST, ["link.media", "route.media"], w=2.5, detour=True)
def c_place_photos(S, rng):
    places = [p for p in rows_of(S, "places") if S.peek('show (photos of (places called "%s"))' % q(p["label"]))]
    p, kw = unique_label(S, rng, "places", places, two=0.8)
    kw = p["label"] if rng.random() < 0.6 else kw
    if len(S.peek('show (places called "%s")' % q(kw))) != 1:
        raise Fail("place name")
    S.turn(pick(rng, ["asks for photos taken at %s", "asks for their pictures from %s", "asks what photos they have from %s",
                      "asks to see the shots from %s"], kw), [kw], ["route.media"])
    if try_miss(S, rng, 'show (photos called "%s")' % q(kw), "none"):
        S.look('show (places called "%s")' % q(kw))
        S.answer("photos of (#%d)" % S.handle(p["label"], "place"))
    elif rng.random() < 0.35:
        S.answer('photos of (places called "%s")' % q(kw))
    else:
        S.look('search "%s"' % q(kw) if rng.random() < 0.6 else 'show (places called "%s")' % q(kw))
        n = S.handle(p["label"], "place")
        S.answer("photos of (#%d)" % n)
        S.ctx["place"] = n
    S.ctx.update(kind="photos", kw=kw, topic="the %s photos" % kw)


def photos_linked(S, link):
    out = []
    for p in rows_of(S, "photos"):
        if link == "albums" and extra(p).get("album_titles"):
            out.append(p)
        if link == "places" and extra(p).get("place"):
            out.append(p)
    return out


@cell(FIRST, ["link.media"], w=2.0, detour=True)
def c_photo_link(S, rng):
    link = rng.choice(["places", "albums"])
    ph, kw = unique_label(S, rng, "photos", photos_linked(S, link), two=0.5)
    kw = low(kw, S.W["names"])
    S.turn(pick(rng, {"places": ["asks where the %s photo was taken", "asks where they took the %s picture"],
                      "albums": ["asks which album the %s photo is in", "asks what album has the %s picture"]}[link], kw),
           [kw], ["route.media"])
    S.look('search "%s"' % q(kw) if rng.random() < 0.6 else 'show (photos called "%s")' % q(kw))
    n = S.handle(ph["label"], "photo")
    if MIX.n_looks(rng, 1, 2) == 2:
        S.look("get #%d" % n)
    S.answer("%s of (#%d)" % (link, n))
    S.ctx.update(kind=link, photo=n, topic="the %s photo" % kw)
    if link == "albums":
        S.ctx["album"] = S.last[0][0]
    else:
        S.ctx["place"] = S.last[0][0]
        S.ctx["kind"] = "places"


def parent_tasks(S):
    tasks = rows_of(S, "tasks")
    by_id = {t["id"]: t for t in tasks}
    kids = collections.defaultdict(list)
    for t in tasks:
        pid = extra(t).get("parent_task_id")
        if pid in by_id:
            kids[pid].append(t)
    return [(by_id[pid], subs) for pid, subs in kids.items()]


@cell(FIRST, ["link.subtasks"], w=2.0, detour=True)
def c_subtasks(S, rng):
    ps = parent_tasks(S)
    if not ps:
        raise Fail("no parent task")
    t, subs = rng.choice(ps)
    try:
        _, kw = unique_label(S, rng, "tasks", [t], two=0.6)
    except Fail:
        kw = t["label"]
        if len(S.peek('show (tasks called "%s")' % q(kw))) != 1:
            raise
    kw = low(kw, S.W["names"])
    open_ = [s for s in subs if extra(s).get("status") != "completed"]
    r = rng.random()
    if open_ and r < 0.5:
        S.turn(pick(rng, ["asks what's left to do on the %s plan", "asks which steps of the %s job are still open"], kw),
               [kw], ["link.subtasks"])
        tail = ' that (status != "completed")'
    elif r < 0.65 and len(open_) < len(subs):
        S.turn(pick(rng, ["asks which bits of the %s job are done", "asks which steps of %s they've finished"], kw), [kw],
               ["link.subtasks"])
        tail = ' that (status = "completed")'
    else:
        S.turn(pick(rng, ["asks what the steps for the %s are", "asks for the subtasks of the %s task"], kw), [kw],
               ["link.subtasks"])
        tail = ""
    S.look('search "%s"' % q(kw) if rng.random() < 0.5 else 'show (tasks called "%s")' % q(kw))
    S.answer("(tasks of (#%d))%s" % (S.handle(t["label"], "task"), tail))
    S.ctx.update(kind="tasks", topic="the %s plan" % kw)


# == first turns: groups, money, numbers =====================================================

GENERIC = {"trip", "share", "house", "group", "gang", "syndicate", "club", "bills", "holiday", "flat", "team", "fund",
           "kitty", "crew", "pot", "night", "class"}


def group_kw(S, rng):
    g = rng.choice(rows_of(S, "groups"))
    kw = g["label"]
    if rng.random() < 0.35:
        ws = [w for w in words(kw) if w.lower() in S.W["names"] and len(S.peek('show (groups called "%s")' % w)) == 1]
        if ws:
            kw = rng.choice(ws)
    if not any(w.lower() in S.W["names"] for w in kw.split()):
        kw = kw[0].lower() + kw[1:] if kw[:1].isupper() and not kw.split()[0].lower() in S.W["names"] else kw
    if len(S.peek('show (groups called "%s")' % q(kw))) != 1:
        raise Fail("group name")
    return g, kw


def find_group(S, rng, g, kw, read=True):
    S.look('search "%s"' % q(kw) if rng.random() < 0.7 else 'show (groups called "%s")' % q(kw))
    h = found(S, g["label"], "group")
    if h is None:
        S.look('show (groups called "%s")' % q(kw))
        h = S.handle(g["label"], "group")
    if read and MIX.n_looks(rng, 1, 2) == 2:
        S.look("get #%d" % h)
    return h


@cell(FIRST, ["link.of_group", "route.money"], w=2.5, detour=True)
def c_group_link(S, rng):
    g, kw = group_kw(S, rng)
    r = rng.random()
    if r < 0.45:
        if not S.peek('show (expenses of (groups called "%s"))' % q(kw)):
            raise Fail("no expenses")
        S.turn(pick(rng, ["asks to see the %s expenses", "asks what's gone into %s", "asks which expenses are in the %s group"],
                    kw), [kw], ["route.money"])
        try_miss(S, rng, 'show (expenses called "%s")' % q(kw), "none")
        n = find_group(S, rng, g, kw)
        S.answer("expenses of (#%d)" % n)
        S.ctx.update(kind="expenses", group=n, topic="the %s expenses" % kw)
    elif r < 0.85:
        S.turn(pick(rng, ["asks who is in the %s group", "asks which people share %s with them",
                          "asks to list the people in the %s group"], kw), [kw], ["link.of_group"])
        n = find_group(S, rng, g, kw)
        S.answer("(members of (#%d)) that (party_id is not me)" % n)
        S.ctx.update(kind="members", group=n, topic="the %s group" % kw)
    else:
        if not S.peek_ok('show (settlements of (groups called "%s"))' % q(kw)):
            raise Fail("no settlements")
        S.turn(pick(rng, ["asks if anyone has settled up in %s", "asks for the settlements in the %s group"], kw), [kw],
               ["link.of_group"])
        n = find_group(S, rng, g, kw)
        S.answer("settlements of (#%d)" % n)
        S.ctx.update(kind="settlements", group=n, topic="the %s group" % kw)


@cell(FIRST, ["link.of_group"], w=1.0, detour=True)
def c_expense_group(S, rng):
    rows = [e for e in rows_of(S, "expenses") if extra(e).get("group_id")]
    e, kw = unique_label(S, rng, "expenses", rows, two=0.6)
    kw = low(kw, S.W["names"])
    S.turn(pick(rng, ["asks which group the %s expense is in", "asks what group the %s went into"], kw), [kw],
           ["link.of_group"])
    S.look('search "%s"' % q(kw) if rng.random() < 0.6 else 'show (expenses called "%s")' % q(kw))
    n = S.handle(e["label"], "expense")
    S.answer("groups of (#%d)" % n)
    S.ctx.update(kind="groups", group=S.last[0][0], expense=n, topic="the %s group" % kw)


@cell(FIRST, ["num.sum", "link.of_group"], w=1.5, detour=True)
def c_group_total(S, rng):
    g, kw = group_kw(S, rng)
    if not S.peek('show (expenses of (groups called "%s"))' % q(kw)):
        raise Fail("no expenses")
    S.turn(pick(rng, ["asks how much has been spent in the %s group", "asks what the %s total is so far",
                      "asks what the %s group's spending comes to"], kw), [kw], ["route.money"])
    n = find_group(S, rng, g, kw)
    S.answer("sum amount_minor of (expenses of (#%d))" % n)
    S.ctx.update(kind="groups", group=n, topic="the %s group" % kw)


def amounts(S, expr):
    return sorted(int(float(extra(e).get("amount_minor") or 0)) for e in live(S.peek("show " + expr)))


def threshold(S, rng, amts):
    """a round amount (major units) that splits `amts` (minor units)"""
    if len(amts) < 2:
        raise Fail("few amounts")
    for _ in range(8):
        i = rng.randint(1, len(amts) - 1)
        units = round_units((amts[i - 1] + amts[i]) / 200)
        t = units * 100
        n = sum(a > t for a in amts)
        if 0 < n < len(amts):
            return units
    raise Fail("no threshold")


@cell(FIRST, ["filter.numeric", "copy.number", "route.money"], w=2.0, detour=True)
def c_expenses_over(S, rng):
    if rng.random() < 0.5:
        g, kw = group_kw(S, rng)
        amts = amounts(S, '(expenses of (groups called "%s"))' % q(kw))
        units = threshold(S, rng, amts)
        m = money_say(rng, S.W, units)
        S.turn(pick(rng, ["asks which %s expenses were over %s", "asks for the %s expenses above %s"], kw, m), [kw, m],
               ["route.money", "copy.number"])
        n = find_group(S, rng, g, kw)
        S.answer("(expenses of (#%d)) that (amount_minor > %d)" % (n, units * 100))
        S.ctx.update(kind="expenses", group=n, topic="the %s expenses" % kw)
    else:
        amts = amounts(S, "(expenses)")
        units = threshold(S, rng, amts)
        m = money_say(rng, S.W, units)
        S.turn(pick(rng, ["asks which expenses were over %s", "asks for the spending above %s"], m), [m],
               ["route.money", "copy.number"])
        if MIX.want_miss(rng):
            S.miss("show (expenses that (amount > %d))" % (units * 100), "field")
        S.answer("(expenses that (amount_minor > %d))" % (units * 100))
        S.ctx.update(kind="expenses", topic="the big expenses")


@cell(FIRST, ["num.balance"], w=2.0, detour=True)
def c_balance(S, rng):
    g, kw = group_kw(S, rng)
    mem = live(S.peek('show (members of (groups called "%s")) that (party_id is not me)' % q(kw)))
    mem = [m for m in mem if sum(first(x["label"]) == first(m["label"]) for x in mem) == 1]
    if len(mem) < 1:
        raise Fail("no members")
    m = rng.choice(mem)
    who = first(m["label"]) if rng.random() < 0.6 else m["label"]
    S.turn(pick(rng, ["asks how much %s owes them in %s", "asks what %s's balance with them is in the %s group",
                      "asks where they stand with %s in %s"], who, kw), [who, kw], ["num.balance"])
    n = find_group(S, rng, g, kw)
    S.look("show (members of (#%d))%s" % (n, rng.choice(["", " that (party_id is not me)"])))
    h = S.handle(m["label"], "member")
    S.answer("balance of (#%d) in (#%d)" % (h, n), empty=True)
    shown = [(n2, lab) for n2, k, lab in S.rows if k == "member" and n2 != h and lab in {x["label"] for x in mem}]
    S.ctx.update(kind="balance", group=n, balance_next=(n, shown), topic="the %s balances" % kw)


@cell(FIRST, ["num.sum", "time.field"], w=1.5, detour=True)
def c_spend_window(S, rng):
    pool = ["last month", "this month", "last week", "this week", "yesterday", "recently"]
    w, _ = window_with(S, rng, "show (expenses that (spent_on during %s))", pool, 1, 40)
    S.turn(pick(rng, ["asks how much they spent %s", "asks what their spending came to %s",
                      "asks for the total they spent %s"], w), [w], ["route.money"])
    if not try_miss(S, rng, "show (expenses) that (spent_at during %s)" % w, "field"):
        explore(S, rng, ["show (expenses that (spent_on during %s))" % w], hi=1)
    S.answer("sum amount_minor of (expenses that (spent_on during %s))" % w)
    S.ctx.update(kind="spend", window=w, topic="the spending")
    set_swap(S, "sum amount_minor of (expenses that (spent_on during %s))",
             [(x, x) for x in pool if x != w and S.peek("show (expenses that (spent_on during %s))" % x)],
             "asks the same for %s ('and %s?')", ["route.money"], None)


@cell(FIRST, ["route.money"], w=1.2, detour=True)
def c_spend_on(S, rng):
    kws = [k for k in shared_kw(S, "expenses", other=False)]
    rng.shuffle(kws)
    for k in kws:
        kk = k.capitalize() if k in S.W["names"] else k
        if 2 <= len(S.peek('show (expenses called "%s")' % kk)) <= 8:
            break
    else:
        raise Fail("no expense family")
    if rng.random() < 0.5:
        S.turn(pick(rng, ["asks what they spent on %s (the expenses themselves)", "asks to list the %s expenses"], kk),
               [kk], ["route.money"])
        S.answer('(expenses called "%s")' % kk)
        S.ctx.update(kind="expenses", kw=kk, topic="the %s expenses" % kk)
    else:
        S.turn(pick(rng, ["asks how much they spent on %s in total", "asks what the %s expenses add up to"], kk), [kk],
               ["route.money"])
        S.answer('sum amount_minor of (expenses called "%s")' % kk)


@cell(FIRST, ["num.value_of"], w=2.0, detour=True)
def c_expense_amount(S, rng):
    e, kw = unique_label(S, rng, "expenses", rows_of(S, "expenses"), two=0.5)
    kw = low(kw, S.W["names"])
    S.turn(pick(rng, ["asks what the %s came to", "asks how much the %s was", "asks what they paid for the %s",
                      "asks how much the %s cost"], kw), [kw], ["route.money"])
    if rng.random() < 0.8:
        S.look('search "%s"' % q(kw) if rng.random() < 0.6 else 'show (expenses called "%s")' % q(kw))
        n = S.handle(e["label"], "expense")
        if MIX.n_looks(rng, 1, 2) == 2:
            S.look("get #%d" % n)
        S.answer("amount_minor of (#%d)" % n)
    else:
        S.answer('amount_minor of (expenses called "%s")' % q(kw))
    S.ctx.update(kind="expense amount", topic="the %s" % kw)


@cell(FIRST, ["num.count"], w=2.0, detour=True)
def c_count(S, rng):
    opts = [("asks how many open tasks they have", 'count of ((tasks) that (status != "completed"))', []),
            ("asks how many photos they have marked as favourites", "count of ((photos) that (favorite = true))", []),
            ("asks how many notes they have", "count of (notes)", []),
            ("asks how many photos they have", "count of (photos)", []),
            ("asks how many documents they have", "count of (documents)", []),
            ("asks how many people are in their contacts", "count of (parties)", []),
            ("asks how many tasks are overdue", 'count of ((tasks) that (due_at during before now and status != "completed"))',
             [])]
    for w in ["this week", "next week", "tomorrow", "this weekend", "friday"]:
        opts.append(("asks how many events they have %s" % w, "count of (events during %s)" % w, [w]))
        opts.append(("asks how many tasks are due %s" % w, "count of ((tasks) that (due_at during %s))" % w, [w]))
    for w in ["last month", "this month", "last weekend", "last week"]:
        opts.append(("asks how many photos they took %s" % w, "count of ((photos) that (captured_at during %s))" % w, [w]))
    rng.shuffle(opts)
    for h, expr, say in opts:
        v = S.peek("show " + expr.replace("count of ", "", 1))
        if v:
            break
    else:
        raise Fail("nothing to count")
    S.turn(h, say, [])
    S.answer(expr)
    S.ctx.update(kind="count", topic="that count")


@cell(FIRST, ["num.dtstart_of", "judge.ambiguous"], w=2.0, detour=True)
def c_dtstart(S, rng):
    kws = list(S.W["meta"].get("shared_keywords", {}).items())
    rng.shuffle(kws)
    for kw, kinds in kws:
        if len(set(kinds) & {"events", "tasks", "important dates"}) >= 2 or \
                (len(set(kinds) & {"events", "tasks", "documents", "notes"}) >= 2):
            kk = kw.capitalize() if kw in S.W["names"] else kw
            got = [r for r in S.peek('show (things called "%s")' % kk) if r.get("date")]
            if len({r["entity"] for r in got}) >= 2:
                break
    else:
        raise Fail("no multi-kind name")
    S.turn(pick(rng, ["asks when their %s thing is (no kind given)", "asks what time the %s thing is (no kind said)",
                      "asks when the %s business is"], kk), [kk], ["num.dtstart_of"], t="judge")
    obs = S.call('answer dtstart of (things called "%s")' % kk)
    if not obs.startswith("ambiguous"):
        raise Fail("dtstart was not ambiguous")
    S.done()


def trips(S):
    out = []
    for t in S.W["meta"].get("trips", []):
        d = t.get("destination")
        if d and len(S.peek('show (events called "%s")' % d)) >= 1:
            out.append(t)
    return out


@cell(FIRST, ["time.derived"], w=2.0, detour=True)
def c_trip(S, rng):
    ts = trips(S)
    if not ts:
        raise Fail("no trips")
    t = rng.choice(ts)
    d = t["destination"]
    ev = [e for e in S.peek('show (events called "%s")' % d) if e["label"] == t["title"]]
    if not ev:
        raise Fail("trip event")
    rg = "%s..%s" % (t["start"][:10], t["end"][:10])
    r = rng.random()
    if r < 0.5:
        expr = "(things during %s) ordered by dtstart asc" % rg
        if len(S.peek("show (things during %s)" % rg)) < 2:
            raise Fail("empty trip")
        S.turn(pick(rng, ["asks what else is going on while they're in %s", "asks what else is on during the %s trip",
                          "asks what they have on while they're away in %s"], d), [d], ["time.derived"])
    elif r < 0.8:
        expr = "count of (photos during %s)" % rg
        if not S.peek("show (photos during %s)" % rg):
            raise Fail("no trip photos")
        S.turn(pick(rng, ["asks how many photos they took on the %s trip", "asks to count the pictures from %s"], d), [d],
               ["time.derived"])
    else:
        expr = "(photos during %s)" % rg
        if not S.peek("show " + expr):
            raise Fail("no trip photos")
        S.turn(pick(rng, ["asks for the photos from the %s trip", "asks what pictures they took while in %s"], d), [d],
               ["time.derived", "route.media"])
    S.look(rng.choice(['search "%s"' % d, 'show (events called "%s")' % d]))
    if MIX.n_looks(rng, 1, 2) == 2:
        S.look("get #%d" % S.handle(t["title"], "event"))
    S.answer(expr)
    S.ctx.update(kind="things" if "things" in expr else "photos", topic="the %s trip" % d)


# == first turns: trash, ambiguity, nothing, refusals =========================================

def trashed(S, kind):
    return [r for r in S.peek("show (%s that (deleted_at is not null))" % kind) if r.get("label")]


def only_trashed_keyword(S, rng, kind, row):
    ws = words(row["label"])
    rng.shuffle(ws)
    for w in ws:
        w2 = w if w.lower() in S.W["names"] else w.lower()
        if not S.peek('show (%s called "%s")' % (kind, w2)):
            return w2
    raise Fail("every word of %r names a live row too" % row["label"])


TRASH_KINDS = [("notes", "note"), ("documents", "document"), ("tasks", "task"), ("photos", "photo")]


@cell(FIRST, ["filter.trashed"], w=2.0, detour=True)
def c_trashed_check(S, rng):
    kind, ent = rng.choice(TRASH_KINDS)
    rows = trashed(S, kind)
    if not rows:
        raise Fail("no trashed %s" % kind)
    row = rng.choice(rows)
    if rng.random() < 0.2:
        S.turn(pick(rng, ["asks which %ss they have thrown away", "asks what %ss are in the bin"], ent), [], [])
        S.answer("(%s) that (deleted_at is not null)" % kind)
        S.ctx.update(kind=kind, topic="the bin")
        return
    kw = only_trashed_keyword(S, rng, kind, row)
    S.turn(pick(rng, ["asks whether they binned the %s " + ent, "asks if the %s " + ent + " is in the trash",
                      "asks whether they deleted the %s " + ent], kw), [kw, ent], [])
    if rng.random() < 0.5:
        if MIX.want_miss(rng):
            S.miss('show (%s called "%s")' % (kind, kw), "none")
        S.look('show (%s called "%s") that (deleted_at is not null)' % (kind, kw))
        S.answer("#%d" % S.handle(row["label"], ent))
    else:
        S.answer('(%s called "%s") that (deleted_at is not null)' % (kind, kw))
    S.ctx.update(kind=kind, topic="the %s %s" % (kw, ent))
    if kind != "documents" and probe_write(S, kind, row["label"], "restore{}", trashed=True):
        S.ctx["trashed"] = (S.last[0][0], kind)


def clashes(S):
    out = []
    for f, full in S.W["meta"].get("first_name_clashes", {}).items():
        ps = [p for p in people(S) if p["label"] in full]
        if len(ps) >= 2:
            out.append((f, ps))
    if not out:
        raise Fail("no shared first name")
    return out


@cell(FIRST, ["judge.ambiguous", "route.people"], w=2.0, detour=True)
def c_shared_name_read(S, rng):
    f, ps = rng.choice(clashes(S))
    r = rng.random()
    if r < 0.35:
        S.turn(pick(rng, ["asks who %s is (several people are called %s)", "asks to pull up %s (two contacts share the name)"],
                    f, f), [f], ["route.people", "judge.ambiguous"])
        S.answer('(parties called "%s")' % f)
        S.ctx.update(kind="parties", kw=f, topic=f)
        return
    what = rng.choice(["number", "email", "birthday", "debts"])
    link0 = {"number": '(contact channels of (parties called "%s")) that (kind = "phone")',
             "email": '(contact channels of (parties called "%s")) that (kind = "email")',
             "birthday": 'important dates of (parties called "%s")',
             "debts": 'obligations of (parties called "%s")'}[what]
    if r >= 0.75 and sum(bool(S.peek_ok("show " + link0 % q(p["label"]))) for p in ps) < 2:
        raise Fail("only one has it")
    S.turn(pick(rng, ["asks for %s's %s (two contacts are called %s, the message doesn't say which)"], f, what, f),
           [f], ["judge.ambiguous"], t="judge")
    if r < 0.75:
        S.look(rng.choice(['search "%s"' % f, 'show (parties called "%s")' % f]))
        opts = [p["label"].split()[-1] for p in ps]
        S.ask("Which %s — %s?" % (f, " or ".join(opts)))
    else:
        link = {"number": '(contact channels of (parties called "%s")) that (kind = "phone")',
                "email": '(contact channels of (parties called "%s")) that (kind = "email")',
                "birthday": 'important dates of (parties called "%s")',
                "debts": 'obligations of (parties called "%s")'}[what] % f
        obs = S.call("answer " + link)
        if not obs.startswith("ambiguous"):
            raise Fail("read over a shared name was not ambiguous")
        S.done()


@cell(FIRST, ["judge.no_link"], w=2.0, detour=True)
def c_no_link(S, rng):
    r = rng.random()
    if r < 0.5:
        places = rows_of(S, "places")
        p, kw = unique_label(S, rng, "places", places, two=0.8)
        kw = p["label"]
        S.turn(pick(rng, ["asks if there's a calendar event at %s", "asks which events are at %s (by the place itself)",
                          "asks what documents they have linked to %s"], kw), [kw], ["judge.no_link"], t="judge")
        S.look('show (places called "%s")' % q(kw))
        n = S.handle(p["label"], "place")
        link = "documents" if "documents" in S.turns[-1]["hint"] else "events"
        obs = S.call("answer %s of (#%d)" % (link, n))
        if not obs.startswith("ambiguous: no link"):
            raise Fail("link exists")
        S.done()
    else:
        import datetime
        today = datetime.date.fromisoformat(S.date)
        cands = []
        for e in rows_of(S, "events"):
            m = re.match(r"^(Lunch|Dinner|Coffee|Drinks|Walk|Call) with ", e["label"])
            d = date_of(e)
            if not m or extra(e).get("attendee_party_ids") or not d:
                continue
            delta = (datetime.date.fromisoformat(d) - today).days
            if -6 <= delta <= 6:
                day = DAYS[datetime.date.fromisoformat(d).weekday()]
                day = "today" if delta == 0 else day if delta > 0 else "last " + day
                what = m.group(1).lower()
                expr = '(events called "%s") that (dtstart during %s)' % (what, day)
                got = S.peek("show " + expr)
                if len(got) == 1 and got[0]["label"] == e["label"]:
                    cands.append((e, what, day, expr))
        if not cands:
            raise Fail("no lone lunch this week")
        e, what, day, expr = rng.choice(cands)
        S.turn("asks who they had %s with %s" % (what, day) if day.startswith("last") else
               pick(rng, ["asks who their %s %s is with", "asks who they're having %s with %s"], what,
                    day if day == "today" else "on " + day),
               [what, day], ["judge.no_link", "link.parties_of"])
        S.look("show " + expr)
        n = S.handle(e["label"], "event")
        obs = S.call("answer parties of (#%d)" % n)
        if not obs.startswith("ambiguous"):
            raise Fail("event has attendees")
        S.answer("#%d" % n)


@cell(FIRST, ["judge.nothing_there"], w=1.5, detour=True)
def c_nothing_read(S, rng):
    tw = [x for x in S.W["meta"].get("trashed", []) if x.get("only_in_trash")]
    if not tw or rng.random() < 0.3:
        for _ in range(5):
            mon, rg = month_range(S, rng.randint(6, 11))
            if not S.peek("show (expenses that (spent_on during %s))" % rg):
                break
        else:
            raise Fail("no empty month")
        S.turn(pick(rng, ["asks how much they spent back in %s", "asks for the total spent in %s"], mon.capitalize()),
               [mon.capitalize()], ["judge.nothing_there", "time.window"])
        S.answer("sum amount_minor of (expenses that (spent_on during %s))" % rg, empty=True)
        return
    x = rng.choice(tw)
    w = x["only_in_trash"]
    kind = rng.choice([k for k in ["documents", "notes", "events", "photos", "tasks"] if k != x["kind"]])
    if S.peek('show (%s called "%s")' % (kind, w)):
        raise Fail("word live in %s" % kind)
    S.turn(pick(rng, ["asks if they have any %s about %s", "asks for their %s on %s"], KIND_SAY[kind], w),
           [w, KIND_SAY[kind].split()[-1]], [ROUTE_OF.get(kind, "route.everything"), "judge.nothing_there"])
    S.answer('(%s called "%s")' % (kind, w), empty=True)


REFUSE_OUT = ["asks what the weather will be %s", "asks to book a table at a restaurant for %s",
              "asks for the football scores from %s", "asks to order more printer ink online",
              "asks for train times to the city for %s", "asks to buy cinema tickets for %s",
              "asks to look up opening hours on the web for %s"]


@cell(FIRST, ["judge.refuse_outside"], w=1.5)
def c_refuse_outside(S, rng):
    d = rng.choice(["tomorrow", "friday", "the weekend", "tonight", "saturday"])
    r = rng.random()
    ps = people(S)
    if r < 0.35 and ps:
        p = first(rng.choice(ps)["label"])
        S.turn(pick(rng, ["asks to text %s that they're running late", "asks to send %s a message saying happy birthday",
                          "asks to email %s the address of the party"], p), [p], [], t="judge")
    elif r < 0.55:
        places = rows_of(S, "places")
        pl = rng.choice(places)["label"] if places else "the Italian place"
        S.turn(pick(rng, ["asks to reserve a table at %s for %s", "asks to book %s on their website for %s"], pl, d),
               [pl, d], [], t="judge")
    else:
        h = rng.choice(REFUSE_OUT)
        S.turn(h % d if "%s" in h else h, [d] if "%s" in h else [], [], t="judge")
    S.call("refuse: out_of_ontology")


@cell(FIRST, ["judge.refuse_guard"], w=1.5)
def c_refuse_guard(S, rng):
    items = rows_of(S, "locker items")
    ps = people(S)
    r = rng.random()
    if r < 0.35 and items and ps:
        it = rng.choice(items)["label"]
        kw = " ".join(it.split()[-2:])
        p = first(rng.choice(ps)["label"])
        S.turn(pick(rng, ["asks to text %s the %s", "asks to email %s the %s", "asks to message %s the %s"], p, kw),
               [p, kw], [], t="judge")
        S.call("refuse: sealed_egress")
    elif r < 0.5:
        S.turn(pick(rng, ["asks to export their whole locker to a plain file", "asks to dump all their passwords into a spreadsheet",
                          "asks to post their wifi password online"]), [], [], t="judge")
        S.call("refuse: sealed_egress")
    elif r < 0.75:
        S.turn(pick(rng, ["asks the assistant to make up a new router password", "asks to invent a PIN for their new card",
                          "asks to come up with a password for the gym account"]), [], [], t="judge")
        S.call("refuse: fabricated_secret")
    else:
        S.turn(pick(rng, ["asks to delete everything in the vault", "asks to wipe all their photos and notes at once",
                          "asks to clear out the whole vault", "asks to erase every contact they have"]), [], [], t="judge")
        S.call("refuse: unbounded_destruction")


# == first turns: writes =====================================================================

TIMES = [("09:00", ["at nine", "at 9am", "at 9"]), ("10:00", ["at ten", "at 10am"]), ("14:00", ["at two", "at 2pm"]),
         ("15:00", ["at three", "at 3pm"]), ("16:30", ["at half four", "at 4:30pm"]), ("09:30", ["at half nine", "at 9:30"]),
         ("13:00", ["at one", "at 1pm"]), ("18:00", ["at six", "at 6pm"]), ("11:15", ["at quarter past eleven", "at 11:15"]),
         ("19:30", ["at half seven in the evening", "at 7:30pm"])]
WRITE_DAYS = DAYS + ["tomorrow", "next friday", "next monday"]


def free_slot(S, rng, d):
    """a (time, said) with no event overlapping the hour after it on day `d`"""
    busy = []
    for e in live(S.peek("show (events during %s)" % d)):
        st = e.get("date") or ""
        en = extra(e).get("dtend") or st
        if len(st) >= 16:
            busy.append((int(st[11:13]) * 60 + int(st[14:16]), int(en[11:13]) * 60 + int(en[14:16]) if len(en) >= 16 else 0))
    opts = list(TIMES)
    rng.shuffle(opts)
    for tm, said in opts:
        a = int(tm[:2]) * 60 + int(tm[3:])
        if all(not (b0 < a + 90 and max(b1, b0 + 30) > a - 30) for b0, b1 in busy):
            return tm, said
    raise Fail("no free slot")


def say_day(rng, S):
    d = rng.choice(WRITE_DAYS + ["the %s" % ordinal_day(rng, S).split()[1]])
    return d


def task_title(S, rng):
    nouns = S.W["meta"]["vocab"]["nouns"] + S.W["meta"]["vocab"]["themes"]
    ps = [p["first"] for p in S.W["meta"]["people"] if p.get("first")]
    n = rng.choice(nouns).lower()
    p = rng.choice(ps)
    forms = ["Renew the %s insurance" % n, "Call %s back" % p, "Email %s about the %s" % (p, n),
             "Buy a new %s" % n, "Return %s's %s" % (p, n), "Book the %s service" % n, "Fix the %s" % n,
             "Pick up the %s" % n, "Sort out the %s" % n, "Pay the %s bill" % n, "Ask %s about the %s" % (p, n),
             "Order more %s" % n, "Clean the %s" % n, "Take the %s to the tip" % n, "Water the plants",
             "Collect the dry cleaning", "Send %s the photos" % p]
    return rng.choice(forms)


def lower1(s):
    return s[0].lower() + s[1:] if s[:1].isupper() and not s.split()[0] in [first(p["name"]) for p in []] else s


def said_title(t, S):
    w0 = t.split()[0]
    return t if w0.lower() in S.W["names"] else t[0].lower() + t[1:]


@cell(FIRST, ["write.add_task", "copy.title", "copy.date"], w=2.0)
def c_add_task(S, rng):
    title = task_title(S, rng)
    st = said_title(title, S)
    r = rng.random()
    if r < 0.4:
        S.turn(pick(rng, ["asks to add a task to %s", "asks to be reminded to %s", "says new task: %s",
                          "asks to put '%s' on their list"], st), [st], ["copy.title"], t="write")
        S.write('schedule.add_task{title: "%s"}' % title)
    elif r < 0.85:
        d = say_day(rng, S)
        hint = rng.choice(["asks to be reminded to %s %s" % (st, d), "asks to add a task to %s, due %s" % (st, d),
                           "says %s — add a task to %s" % (d, st), "asks to put '%s' on the list for %s" % (st, d)])
        S.turn(hint, [st, d], ["copy.title", "copy.date"], t="write")
        S.write('schedule.add_task{title: "%s", due_at: %s}' % (title, d))
    else:
        d = rng.choice(WRITE_DAYS)
        tm, said = rng.choice(TIMES)
        s = rng.choice(said)
        S.turn("asks to be reminded to %s %s %s" % (st, d, s), [st, d, s], ["copy.title", "copy.date"], t="write")
        S.write('schedule.add_task{title: "%s", due_at: %s at %s}' % (title, d, tm))
    S.ctx.update(kind="tasks", topic="the new task")


@cell(FIRST, ["write.event", "copy.date", "copy.title"], w=1.5)
def c_event_create(S, rng):
    hob = S.W["meta"]["vocab"]["hobbies"]
    ps = [p["first"] for p in S.W["meta"]["people"] if p.get("first")]
    summary = rng.choice(["Haircut", "Dentist check-up", "Coffee with %s" % rng.choice(ps), "Lunch with %s" % rng.choice(ps),
                          "Call with the bank", "%s class" % rng.choice(hob).capitalize(), "Vet appointment",
                          "Drinks with %s" % rng.choice(ps), "Eye test", "Car service", "Parents evening",
                          "%s lesson" % rng.choice(hob).capitalize()])
    d = rng.choice(WRITE_DAYS)
    tm, said = free_slot(S, rng, d)
    s = rng.choice(said)
    ss = said_title(summary, S)
    S.turn(pick(rng, ["asks to put %s in the calendar %s %s", "asks to book in %s %s %s", "says %s %s %s — add it"],
                ss, d, s), [ss, d, s], ["copy.title", "copy.date"], t="write")
    S.write('schedule.propose_event{summary: "%s", dtstart: %s at %s}' % (summary, d, tm))
    S.ctx.update(kind="events", topic="the new event")


@cell(FIRST, ["write.note", "copy.title"], w=1.5)
def c_note_create(S, rng):
    nouns = S.W["meta"]["vocab"]["nouns"]
    ps = [p["first"] for p in S.W["meta"]["people"] if p.get("first")]
    n = rng.choice(nouns).lower()
    title = rng.choice(["Check the gutters", "Ask %s about the %s" % (rng.choice(ps), n), "Measure the %s" % n,
                        "Ideas for the %s" % n, "The plumber prefers texts", "Prices for the %s" % n,
                        "%s likes the %s" % (rng.choice(ps), n), "Gift ideas for %s" % rng.choice(ps),
                        "Books to read this summer", "Things to pack for the %s trip" % rng.choice(
                            S.W["meta"]["vocab"]["destinations"] or ["beach"])])
    st = said_title(title, S)
    S.turn(pick(rng, ["asks to make a note: %s", "says note to self: %s", "asks to jot down a note that says %s",
                      "asks to note down: %s"], st), [st], ["copy.title"], t="write")
    S.write('knowledge.create_note{title: "%s"}' % title)


@cell(FIRST, ["write.note", "copy.title", "copy.number"], w=1.0)
def c_locker_add(S, rng):
    what = rng.choice(["gate code", "alarm code", "bike lock combination", "garage code", "shed PIN", "safe code",
                       "locker combination", "studio door code", "boat shed PIN", "storage unit code"])
    code = "%d" % rng.randint(1000, 99999)
    title = what[0].upper() + what[1:]
    S.turn(pick(rng, ["asks to save the %s %s in the locker", "says the %s is %s — keep it in the locker"], what, code),
           [what, code], ["copy.title", "copy.number"], t="write")
    S.write('locker.add_item{type: "note", title: "%s", content: "%s"}' % (title, code))


def movable(S, kind):
    rows = rows_of(S, kind)
    if kind == "tasks":
        rows = [r for r in rows if extra(r).get("status") not in ("completed", "cancelled")]
    return rows


@cell(FIRST, ["write.reschedule", "compose.lookup_write", "copy.date"], w=2.5)
def c_reschedule(S, rng):
    kind = rng.choice(["tasks", "events"])
    ent = KIND_ENT[kind]
    r, kw = unique_label(S, rng, kind, movable(S, kind), two=0.4)
    kw = low(kw, S.W["names"])
    d = rng.choice(WRITE_DAYS)
    to = d
    say = [kw, d]
    if kind == "events" and rng.random() < 0.35:
        tm, said = free_slot(S, rng, d)
        s = rng.choice(said)
        to = "%s at %s" % (d, tm)
        say.append(s)
    if not probe_write(S, kind, r["label"], "reschedule{to: %s}" % to):
        raise Fail("move would not land")
    S.turn(pick(rng, ["asks to move the %s %s to %s", "asks to push the %s %s to %s", "asks if the %s %s can go to %s instead"],
                kw, "task" if ent == "task" else "appointment", " ".join(say[1:])), say, [], t="write")
    S.look('search "%s"' % q(kw) if rng.random() < 0.6 else 'show (%s called "%s")' % (kind, q(kw)))
    n = S.handle(r["label"], ent)
    S.write("reschedule{to: %s} on #%d" % (to, n))
    S.ctx.update(kind=kind, wrote={"verb": "reschedule{to: %s}" % to, "n": n, "ent": ent, "kind": kind, "kw": kw},
                 topic="the %s" % kw)


@cell(FIRST, ["write.reschedule", "time.shift"], w=1.5)
def c_shift(S, rng):
    e, kw = unique_label(S, rng, "events", rows_of(S, "events"), two=0.3)
    kw = low(kw, S.W["names"])
    by, said = rng.choice([("+1h", "an hour later"), ("+2h", "two hours later"), ("-1h", "an hour earlier"),
                           ("+30m", "half an hour later"), ("-30m", "half an hour earlier"), ("+1d", "a day later"),
                           ("+1d", "back a day"), ("+15m", "fifteen minutes later")])
    S.turn(pick(rng, ["asks to move the %s %s", "asks to make the %s %s", "asks to bump the %s %s"], kw, said), [kw, said],
           ["time.shift"], t="write")
    if not probe_write(S, "events", e["label"], "reschedule{by: %s}" % by):
        raise Fail("shift would not land")
    S.look('search "%s"' % q(kw) if rng.random() < 0.6 else 'show (events called "%s")' % q(kw))
    n = S.handle(e["label"], "event")
    S.write("reschedule{by: %s} on #%d" % (by, n))
    S.ctx.update(kind="events", wrote={"verb": "reschedule{by: %s}" % by, "n": n, "ent": "event"}, topic="the %s" % kw)


@cell(FIRST, ["write.mark", "compose.lookup_write"], w=1.5)
def c_mark(S, rng):
    if rng.random() < 0.6:
        r, kw = unique_label(S, rng, "tasks", movable(S, "tasks"), two=0.4)
        kw = low(kw, S.W["names"])
        S.turn(pick(rng, ["says the %s task is done", "asks to tick off the %s task", "says they've finished the %s job",
                          "asks to mark the %s to-do complete"], kw), [kw], [], t="write")
        S.look('search "%s"' % q(kw) if rng.random() < 0.5 else 'show (tasks called "%s")' % q(kw))
        n = S.handle(r["label"], "task")
        S.write("complete{} on #%d" % n)
        S.ctx.update(kind="tasks", wrote={"verb": "complete{}", "n": n, "ent": "task"}, topic="the %s task" % kw)
    else:
        docs = [d for d in rows_of(S, "documents") if extra(d).get("starred") != "true"]
        r, kw = unique_label(S, rng, "documents", docs, two=0.4)
        kw = low(kw, S.W["names"])
        S.turn(pick(rng, ["asks to star the %s document", "asks to mark the %s paperwork with a star"], kw), [kw], [],
               t="write")
        S.look('search "%s"' % q(kw) if rng.random() < 0.5 else 'show (documents called "%s")' % q(kw))
        n = S.handle(r["label"], "document")
        S.write("core.star_document{} on #%d" % n)
        S.ctx.update(kind="documents", wrote={"verb": "core.star_document{}", "n": n, "ent": "document"},
                     topic="the %s document" % kw)


TRASH_VERB = {"notes": ("note", ["delete{}"], "restore{}"),
              "tasks": ("task", ["delete{}"], "restore{}"),
              "events": ("event", ["delete{}", "cancel{}"], "restore{}"),
              "documents": ("document", ["core.trash_document{}"], "core.restore_document{}"),
              "expenses": ("expense", ["tally.delete_expense{}"], "tally.undo_expense{}"),
              "parties": ("party", ["people.trash_person{}"], "restore{}"),
              "locker items": ("locker item", ["locker.trash_item{}"], "restore{}"),
              "photos": ("photo", ["media.delete_asset{}"], "restore{}")}
TRASH_SAY = {"notes": ["note"], "tasks": ["task", "to-do"], "events": ["appointment", "event"],
             "documents": ["document", "file"], "expenses": ["expense"], "parties": ["contact"],
             "locker items": ["locker entry"], "photos": ["photo", "picture"]}


@cell(FIRST, ["write.trash", "compose.lookup_write"], w=2.5)
def c_trash(S, rng):
    kind = rng.choice(list(TRASH_VERB) + ["notes", "documents", "photos"])
    ent, verbs, undo = TRASH_VERB[kind]
    if kind == "parties":
        p = rng.choice([x for x in people(S) if not extra(x).get("owed_to_me_minor") and not extra(x).get("owed_to_them_minor")])
        r, kw = p, p["label"]
    else:
        r, kw = unique_label(S, rng, kind, rows_of(S, kind), two=0.4)
        kw = low(kw, S.W["names"])
    verb = rng.choice(verbs)
    word = rng.choice(TRASH_SAY[kind])
    if verb == "cancel{}":
        S.turn(pick(rng, ["asks to call off the %s", "asks to cancel the %s %s"], kw, word), [kw], [], t="write")
    else:
        S.turn(pick(rng, ["asks to delete the %s %s", "asks to bin the %s %s", "asks to get rid of the %s %s",
                          "asks to trash the %s %s", "asks to remove the %s %s"], kw, word), [kw], [], t="write")
    S.look('search "%s"' % q(kw) if rng.random() < 0.5 else 'show (%s called "%s")' % (kind, q(kw)))
    n = S.handle(r["label"], ent)
    S.write("%s on #%d" % (verb, n))
    S.ctx.update(kind=kind, wrote={"verb": verb, "n": n, "ent": ent, "undo": None if verb == "cancel{}" else undo,
                                   "kind": kind}, topic="the %s" % kw)


RESTORABLE = [("notes", "note"), ("tasks", "task"), ("photos", "photo")]   # seeded trashed documents refuse restore


@cell(FIRST, ["write.restore", "filter.trashed"], w=2.0)
def c_restore(S, rng):
    kind, ent = rng.choice(RESTORABLE)
    rows = [r for r in trashed(S, kind) if probe_write(S, kind, r["label"], "restore{}", trashed=True)]
    if not rows:
        raise Fail("no restorable %s" % kind)
    row = rng.choice(rows)
    kw = only_trashed_keyword(S, rng, kind, row)
    S.turn(pick(rng, ["asks to put back the %s %s they deleted", "asks to restore the %s %s", "asks to undelete the %s %s",
                      "asks to bring the %s %s back from the bin"], kw, ent), [kw, ent], [], t="write")
    if MIX.want_miss(rng) and False:
        pass
    S.look('show (%s called "%s") that (deleted_at is not null)' % (kind, kw))
    n = S.handle(row["label"], ent)
    verb = {"documents": rng.choice(["core.restore_document{}", "restore{}"]),
            "photos": rng.choice(["media.restore_asset{}", "restore{}"])}.get(kind, "restore{}")
    S.write("%s on #%d" % (verb, n))
    S.ctx.update(kind=kind, topic="the %s %s" % (kw, ent))


@cell(FIRST, ["write.reveal", "route.locker"], w=2.0)
def c_reveal(S, rng):
    items = [i for i in rows_of(S, "locker items") if extra(i).get("type") in ("login", "password", "wifi")]
    it, kw = unique_label(S, rng, "locker items", items, two=0.6)
    kw = low(kw, S.W["names"]) if not any(w.lower() in S.W["names"] for w in kw.split()) else kw
    S.turn(pick(rng, ["asks what the actual password for the %s is", "asks to see the %s password itself",
                      "asks to reveal the password for the %s"], kw), [kw, "password"], ["route.locker"], t="write")
    S.look('show (locker items called "%s")' % q(kw) if rng.random() < 0.6 else 'search "%s"' % q(kw))
    n = S.handle(it["label"], "locker item")
    S.write('locker.reveal_receipt{columns: "password"} on #%d' % n)
    S.ctx.update(kind="locker items", focus=n, topic="the %s" % kw)


@cell(FIRST, ["write.album_add", "compose.lookup_write"], w=2.0)
def c_album_add(S, rng):
    albums = album_rows(S)
    if not albums:
        raise Fail("no albums")
    a = rng.choice(albums)
    akw = a["label"]
    if len(S.peek('show (albums called "%s")' % q(akw))) != 1:
        raise Fail("album name")
    inside = {p["label"] for p in live(S.peek_ok('show (photos of (albums called "%s"))' % q(akw)))}
    photos = [p for p in rows_of(S, "photos") if p["label"] not in inside]
    p, pkw = unique_label(S, rng, "photos", photos, two=0.5)
    pkw = low(pkw, S.W["names"])
    if pkw.lower() in akw.lower() or akw.lower() in pkw.lower():
        raise Fail("names overlap")
    S.turn(pick(rng, ["asks to put the %s photo in the %s album", "asks to add the %s picture to the %s album"], pkw, akw),
           [pkw, akw, "album"], [], t="write")
    S.look('search "%s"' % q(pkw) if rng.random() < 0.6 else 'show (photos called "%s")' % q(pkw))
    ph = S.handle(p["label"], "photo")
    S.look('search "%s"' % q(akw) if rng.random() < 0.5 else 'show (albums called "%s")' % q(akw))
    al = S.handle(a["label"], "album")
    S.write("media.add_to_album{album_id: (#%d)} on #%d" % (al, ph))
    S.ctx.update(kind="photos", album=al, photo=ph, wrote={"verb": "media.add_to_album{album_id: (#%d)}" % al, "n": ph,
                                                          "ent": "photo"}, topic="the %s album" % akw)


LOG_KIND = {"call": ["phoned", "rang", "called", "had a call with"], "coffee": ["had coffee with", "grabbed a coffee with"],
            "visit": ["visited", "went round to visit"], "message": ["messaged", "texted"]}
LOG_WORD = {"had a call with": "call", "had coffee with": "coffee", "grabbed a coffee with": "coffee",
            "went round to visit": "visit"}


def log_word(v):
    return LOG_WORD.get(v, v.split()[-1])


@cell(FIRST, ["write.log_interaction", "compose.lookup_write"], w=2.0)
def c_log(S, rng):
    p = rng.choice(people(S))
    name = person_name(S, rng, p)
    kind = rng.choice(list(LOG_KIND))
    v = rng.choice(LOG_KIND[kind])
    S.turn(pick(rng, ["says they %s %s and asks to log it", "asks to record that they %s %s", "asks to log that they %s %s today"],
                v, name), [name, log_word(v)], [], t="write")
    S.look('show (parties called "%s")' % q(name) if rng.random() < 0.6 else 'search "%s"' % q(name))
    n = S.handle(p["label"], "party")
    S.write('people.log_interaction{kind: "%s"} on #%d' % (kind, n))
    S.ctx.update(kind="parties", person=p, focus=n, wrote={"verb": 'people.log_interaction{kind: "%s"}' % kind, "n": n,
                                                          "ent": "party", "name": name}, topic=name)


def open_debts(S, h):
    """(#n, label) of the open obligations in the last result"""
    return [(n, lab) for n, k, lab in S.last if k == "obligation"]


@cell(FIRST, ["write.settle", "compose.lookup_write"], w=2.0)
def c_settle_debt(S, rng):
    rows = [r for r in live(S.peek("show (parties that (owed_to_me_minor > 0 or owed_to_them_minor > 0))"))
            if len(S.peek('show (parties called "%s")' % q(r["label"]))) == 1]
    if not rows:
        raise Fail("no debts")
    p = rng.choice(rows)
    name = person_name(S, rng, p)
    S.turn(pick(rng, ["asks to settle up their debt with %s", "says they've paid %s back, mark it settled",
                      "asks to clear what's owed between them and %s", "asks to mark the debt with %s as paid"], name),
           [name], [], t="write")
    S.look('show (parties called "%s")' % q(name) if rng.random() < 0.6 else 'search "%s"' % q(name))
    h = S.handle(p["label"], "party")
    obs = S.look("show obligations of (#%d)" % h)
    opn = [n for n, k, lab in S.last if k == "obligation" and
           not re.search(r'^#%d obligation .*settled_at=' % n, obs, re.M)]
    if not opn:
        raise Fail("no open debt shown")
    S.write("people.settle_debt{} on %s" % hs(opn))
    S.ctx.update(kind="obligations", topic="the debt with %s" % name)


def positive_members(S, gkw):
    mem = live(S.peek('show (members of (groups called "%s")) that (party_id is not me)' % q(gkw)))
    out = []
    for m in mem:
        v = S.peek_ok('balance of (parties called "%s") in (groups called "%s")' % (q(m["label"]), q(gkw)))
        if isinstance(v, (int, float)) and v >= 1:
            out.append(m)
    return mem, out


@cell(FIRST, ["write.settle", "link.of_group"], w=2.0)
def c_settle_member(S, rng):
    g, kw = group_kw(S, rng)
    mem, pos = positive_members(S, kw)
    pos = [m for m in pos if sum(first(x["label"]) == first(m["label"]) for x in mem) == 1]
    if not pos:
        raise Fail("nobody owes me in the group")
    m = rng.choice(pos)
    who = first(m["label"]) if rng.random() < 0.6 else m["label"]
    S.turn(rng.choice(["asks to settle up with %s in %s" % (who, kw), "asks to square their %s balance with %s" % (kw, who)]),
           [who, kw], [], t="write")
    n = find_group(S, rng, g, kw, read=False)
    S.look("show (members of (#%d)) that (party_id is not me)" % n)
    h = S.handle(m["label"], "member")
    S.write("tally.settle_up{to_party: me, group_id: (#%d), amount_minor: balance of (#%d) in (#%d)} on #%d" % (n, h, n, h))
    S.ctx.update(kind="parties", group=n, topic="the %s group" % kw)


def expense_units(S, rng):
    amts = amounts(S, "(expenses)")
    med = amts[len(amts) // 2] / 100 if amts else 50
    u = max(3, int(med * rng.choice([0.1, 0.2, 0.3, 0.5, 0.8])))
    return round_units(u) if u > 20 else u


@cell(FIRST, ["write.tally", "copy.number", "compose.lookup_write"], w=2.0)
def c_add_expense(S, rng):
    g, kw = group_kw(S, rng)
    what = rng.choice(["petrol", "groceries", "dinner", "taxi", "parking", "tickets", "firewood", "coffee", "ferry", "snacks",
                       "pizza", "museum", "bike hire", "gas", "wine", "breakfast"])
    units = expense_units(S, rng)
    m = money_say(rng, S.W, units, bare_ok=False)
    S.turn(pick(rng, ["asks to add %s for %s to the %s group, they paid", "says they paid %s for %s — put it in %s",
                      "asks to log %s of %s in %s, paid by them"], m, what, kw), [m, what, kw], ["copy.number"], t="write")
    n = find_group(S, rng, g, kw, read=False)
    S.write('tally.add_expense{description: "%s", amount_minor: %d, paid_by: me, group_id: (#%d)}'
            % (what.capitalize(), units * 100, n))
    S.ctx.update(kind="expenses", group=n, topic="the %s group" % kw)


@cell(FIRST, ["write.tally", "compose.lookup_write"], w=1.2)
def c_add_member(S, rng):
    g, kw = group_kw(S, rng)
    mem = {m["label"] for m in live(S.peek('show (members of (groups called "%s"))' % q(kw)))}
    cands = [p for p in people(S) if p["label"] not in mem and len(S.peek('show (parties called "%s")' % q(p["label"]))) == 1]
    if not cands:
        raise Fail("everyone is in")
    p = rng.choice(cands)
    name = person_name(S, rng, p)
    S.turn(pick(rng, ["asks to add %s to the %s group", "asks to put %s in %s"], name, kw), [name, kw], [], t="write")
    n = find_group(S, rng, g, kw, read=False)
    S.look('show (parties called "%s")' % q(name) if rng.random() < 0.6 else 'search "%s"' % q(name))
    h = S.handle(p["label"], "party")
    S.write("tally.add_group_member{group_id: (#%d)} on #%d" % (n, h))
    S.ctx.update(kind="parties", group=n, topic="the %s group" % kw)


@cell(FIRST, ["compose.bulk", "write.trash"], w=2.0)
def c_bulk_delete(S, rng):
    kind = rng.choice(["notes", "tasks", "notes", "events", "photos"])
    ent, verbs, undo = TRASH_VERB[kind]
    rows = rows_of(S, kind)
    cnt = collections.Counter(w.lower() for r in rows for w in set(words(r["label"])))
    cands = [w for w, c in cnt.items() if 2 <= c <= 5]
    rng.shuffle(cands)
    for w in cands[:6]:
        w2 = w.capitalize() if w in S.W["names"] else w
        got = S.peek('show (%s called "%s")' % (kind, w2))
        if 2 <= len(got) <= 5:
            break
    else:
        raise Fail("no small family")
    word = rng.choice(TRASH_SAY[kind])
    S.turn(pick(rng, ["asks to delete all their %s %ss", "asks to get rid of every %s %s", "asks to clear out the %s %ss"],
                w2, word), [w2, word], [], t="write")
    S.look(rng.choice(['show (%s called "%s")' % (kind, w2), 'show (%s) called "%s"' % (kind, w2)]))
    if not S.last_full:
        raise Fail("truncated")
    picked = [n for n, k, _ in S.last if k == ent]
    S.write("%s on %s" % (verbs[0], hs(picked)))
    S.ctx.update(kind=kind, wrote={"verb": verbs[0], "ns": picked, "undo": undo}, topic="the %s %ss" % (w2, word))


@cell(FIRST, ["compose.bulk", "write.settle"], w=1.2)
def c_settle_all(S, rng):
    g, kw = group_kw(S, rng)
    mem, pos = positive_members(S, kw)
    if len(pos) < 2:
        raise Fail("fewer than two owe me")
    everyone = len(pos) == len(mem)
    S.turn(pick(rng, ["asks to settle up with everyone in %s" if everyone else "asks to settle up with everyone who owes them in %s",
                      "asks to square up with the whole %s group" if everyone else "asks to square up with all the %s members who owe them"],
                kw), [kw], [], t="write")
    n = find_group(S, rng, g, kw, read=False)
    S.look("show (members of (#%d)) that (party_id is not me)" % n)
    ms = [S.handle(m["label"], "member") for m in pos]
    S.write("tally.settle_up{to_party: me, group_id: (#%d), amount_minor: balance of (it) in (#%d)} on %s" % (n, n, hs(ms)))


@cell(FIRST, ["compose.bulk", "write.reschedule"], w=1.2)
def c_move_both(S, rng):
    tasks = movable(S, "tasks")
    events = rows_of(S, "events")
    ev_words = collections.defaultdict(list)
    for e in events:
        for w in words(e["label"]):
            ev_words[w.lower()].append(e)
    pairs = []
    for t in tasks:
        for w in words(t["label"]):
            es = ev_words.get(w.lower())
            if es and len(es) == 1:
                ww = w if w.lower() in S.W["names"] else w.lower()
                if len(S.peek('show (tasks called "%s")' % ww)) == 1:
                    pairs.append((t, es[0], ww))
    if not pairs:
        raise Fail("no task+event pair")
    t, e, w = rng.choice(pairs)
    d = rng.choice(WRITE_DAYS)
    S.turn(pick(rng, ["asks to push the %s things to %s -- both the task and the calendar entry",
                      "asks to move the %s task and the %s appointment to %s"], *((w, d) if rng.random() < 0.5 else (w, w, d)))
           if False else "asks to move both %s things (the task and the calendar entry) to %s" % (w, d), [w, d], [],
           t="write")
    S.look('search "%s"' % w)
    hts = sorted([S.handle(t["label"], "task"), S.handle(e["label"], "event")])
    S.write("reschedule{to: %s} on %s" % (d, hs(hts)))


@cell(FIRST, ["compose.then"], w=2.0)
def c_then(S, rng):
    r = rng.random()
    if r < 0.45:
        a, akw = unique_label(S, rng, "tasks", movable(S, "tasks"), two=0.3)
        b, bkw = unique_label(S, rng, "events", rows_of(S, "events"), two=0.3)
        akw, bkw = low(akw, S.W["names"]), low(bkw, S.W["names"])
        if akw.lower() in bkw.lower() or bkw.lower() in akw.lower():
            raise Fail("overlap")
        d1, d2 = rng.sample(WRITE_DAYS, 2)
        S.turn("asks to move the %s task to %s and the %s to %s" % (akw, d1, bkw, d2), [akw, d1, bkw, d2], [], t="write")
        S.look('show (tasks called "%s")' % q(akw))
        ha = S.handle(a["label"], "task")
        S.look('show (events called "%s")' % q(bkw))
        hb = S.handle(b["label"], "event")
        S.write("reschedule{to: %s} on #%d then reschedule{to: %s} on #%d" % (d1, ha, d2, hb))
    elif r < 0.75:
        rows = movable(S, "tasks")
        cnt = collections.Counter(w.lower() for x in rows for w in set(words(x["label"])))
        cands = [w for w, c in cnt.items() if 2 <= c <= 4]
        if not cands:
            raise Fail("no family")
        w = rng.choice(cands)
        w = w.capitalize() if w in S.W["names"] else w
        S.turn("asks to show the %s tasks, tick off the first and delete the second" % w, [w], ["handle.ordinal"],
               t="write")
        S.look('show (tasks called "%s")' % w)
        ts = [n for n, k, _ in S.last if k == "task"]
        if len(ts) < 2:
            raise Fail("few")
        S.turn_fix = True
        S.write("complete{} on #%d then delete{} on #%d" % (ts[0], ts[1]))
    else:
        d, kw = unique_label(S, rng, "documents", rows_of(S, "documents"), two=0.3)
        kw = low(kw, S.W["names"])
        day = rng.choice(WRITE_DAYS)
        title = "Print the %s" % kw
        S.turn("asks to star the %s document and add a task to print the %s %s" % (kw, kw, day),
               [kw, "print the %s" % kw, day], ["copy.title"], t="write")
        S.look('search "%s"' % q(kw) if rng.random() < 0.5 else 'show (documents called "%s")' % q(kw))
        n = S.handle(d["label"], "document")
        S.write('core.star_document{} on #%d then schedule.add_task{title: "%s", due_at: %s}' % (n, title, day))


@cell(FIRST, ["judge.nothing_there"], w=2.0)
def c_trash_only_write(S, rng):
    kind, ent = rng.choice(TRASH_KINDS)
    rows = trashed(S, kind)
    if not rows:
        raise Fail("no trashed %s" % kind)
    kw = only_trashed_keyword(S, rng, kind, rng.choice(rows))
    verb = TRASH_VERB[kind][1][0] if rng.random() < 0.7 else {"tasks": "complete{}", "notes": "delete{}",
                                                                "documents": "core.star_document{}",
                                                                "photos": "media.delete_asset{}"}[kind]
    act = {"complete{}": "tick off", "core.star_document{}": "star"}.get(verb, "delete")
    S.turn(pick(rng, ["asks to %s the %s " + ent, "asks to %s their %s " + ent], act, kw), [kw, ent], [], t="judge")
    if rng.random() < 0.5:
        obs = S.call('%s on (%s called "%s")' % (verb, kind, kw))
        if not obs.startswith("no live rows"):
            raise Fail("trash write did not find the trash: %s" % obs[:60])
    else:
        S.miss('show (%s called "%s")' % (kind, kw), "none")
        S.look('show (%s called "%s") that (deleted_at is not null)' % (kind, kw))
    S.call("nothing")


@cell(FIRST, ["judge.ambiguous"], w=2.5)
def c_ambiguous_write(S, rng):
    r = rng.random()
    if r < 0.7:
        f, ps = rng.choice(clashes(S))
        kind = rng.choice(list(LOG_KIND))
        v = rng.choice(LOG_KIND[kind])
        S.turn("says they %s %s and asks to log it (two contacts are called %s; the message doesn't say which)" % (v, f, f),
               [f, log_word(v)], ["judge.ambiguous"], t="judge")
        if rng.random() < 0.5:
            obs = S.call('people.log_interaction{kind: "%s"} on (parties called "%s")' % (kind, f))
            if not obs.startswith("ambiguous"):
                raise Fail("not ambiguous")
            S.done()
        else:
            S.look(rng.choice(['show (parties called "%s")' % f, 'search "%s"' % f]))
            S.ask("Which %s — %s?" % (f, " or ".join(p["label"].split()[-1] for p in ps)))
        S.ctx.update(kind="parties", clash=(f, ps, kind), topic=f)
    else:
        groups = rows_of(S, "groups")
        if len(groups) < 2:
            raise Fail("one group")
        p = rng.choice(people(S))
        name = person_name(S, rng, p)
        S.turn("asks to put %s in the group (they have several shared-expense groups)" % name, [name, "group"],
               ["judge.ambiguous"], t="judge")
        if rng.random() < 0.5:
            obs = S.call('tally.add_group_member{group_id: (groups)} on (parties called "%s")' % q(name))
            if not obs.startswith("ambiguous"):
                raise Fail("not ambiguous")
            S.done()
        else:
            S.look("show (groups)")
            names_ = [g["label"] for g in groups]
            S.ask("Which group — %s?" % (", ".join(names_[:-1]) + " or " + names_[-1]))


# == follow-ups: act on what the conversation is on ============================================
# In a back-to turn (S.back set) `them` is spelled out as the anchor's set (S.them()).

def listed(S, lo=2, hi=99):
    """the conversation is on a list of rows (the last turn answered them, or the back-to anchor)"""
    if not S.back:
        if not S.turns or not S.turns[-1]["steps"]:
            raise Fail("nothing answered")
        c = S.turns[-1]["steps"][-1]["call"]
        if not c.startswith("answer ") or VALUE.match(c[7:]):
            raise Fail("last turn did not answer rows")
    if not lo <= len(S.last) <= hi:
        raise Fail("list size")
    if not S.ctx.get("set") or not S.ctx.get("pset"):
        raise Fail("no set")
    return S.ctx["pset"]


DATED = {"events", "things", "tasks", "journal notes", "important dates", "photos", "expenses"}


@cell(FOLLOW, ["follow.narrow", "time.window", "handle.them"], w=3.0)
def f_narrow_window(S, rng):
    cur = listed(S, 2)
    if S.ctx.get("kind") not in DATED:
        raise Fail("not dated")
    pool = ["this weekend", "today", "tomorrow", "this week", "next week", "last week", "last weekend",
            "this month", "last month"] + DAYS
    base = len(S.peek("show %s" % cur))
    rng.shuffle(pool)
    for w in pool:
        if w == S.ctx.get("window"):
            continue
        got = S.peek("show ((%s) during %s)" % (cur, w))
        if got and len(got) < base:
            break
    else:
        raise Fail("no narrower window")
    said = {"this weekend": "the weekend ones", "today": "just today's", "tomorrow": "the ones tomorrow",
            "this week": "the ones this week", "next week": "the ones next week", "last week": "the ones from last week",
            "last weekend": "the ones from last weekend", "this month": "the ones this month",
            "last month": "the ones from last month"}.get(w, "the ones on " + w)
    S.turn("follow-up: asks for just %s" % said, [w.replace("this ", "") if w in ("this weekend",) else w],
           ["follow.narrow"])
    S.answer(rng.choice(["(%s during %s)", "(%s) during %s"]) % (S.them(), w))
    S.ctx["window"] = w


@cell(FOLLOW, ["follow.narrow", "filter.open", "filter.field", "handle.them"], w=3.0)
def f_narrow_field(S, rng):
    cur = listed(S, 2)
    kind = S.ctx.get("kind")
    opts = []
    if kind in ("tasks", "things"):
        opts += [('that (status != "completed")', ["asks which of those are still open", "asks which of them are still to do",
                                                   "asks for just the ones not done yet"], [])]
    if kind == "tasks":
        opts += [('that (status = "completed")', ["asks which of those are already done"], []),
                 ("that (due_at is null)", ["asks which of those have no due date"], [])]
    if kind == "photos":
        opts += [("that (favorite = true)", ["asks for just the favourites among them", "asks which of those are favourites"], [])]
    if kind == "documents":
        opts += [("that (starred = true)", ["asks which of those are starred"], [])]
        for f in folders(S)[:4]:
            opts.append(('that (folder = "%s")' % f, ["asks for just the ones in the %s folder" % f], [f]))
    if kind == "notes":
        for nb in notebooks(S)[:4]:
            opts.append(('that (notebooks = "%s")' % nb, ["asks for just the ones in the %s notebook" % nb], [nb, "notebook"]))
    if not opts:
        raise Fail("no field filter")
    rng.shuffle(opts)
    base = len(S.peek("show %s" % cur))
    for tail, hints, say in opts:
        got = S.peek("show ((%s) %s)" % (cur, tail))
        if got and len(got) < base:
            break
    else:
        raise Fail("no field filter narrows")
    S.turn("follow-up: " + rng.choice(hints), say, ["follow.narrow"])
    S.answer(rng.choice(["(%s) %s", "(%s %s)"]) % (S.them(), tail))


@cell(FOLLOW, ["follow.narrow", "filter.numeric", "copy.number", "handle.them"], w=2.5)
def f_narrow_amount(S, rng):
    cur = listed(S, 2)
    kind = S.ctx.get("kind")
    if kind == "expenses":
        field = "amount_minor"
    elif kind == "parties" and "owed_to" in (cur or ""):
        field = "owed_to_me_minor" if "owed_to_me" in cur else "owed_to_them_minor"
    else:
        raise Fail("no amounts")
    rows = live(S.peek("show " + cur))
    amts = sorted(int(float(extra(r).get(field) or 0)) for r in rows)
    units = threshold(S, rng, amts)
    m = money_say(rng, S.W, units)
    S.turn(pick(rng, ["follow-up: asks for just the ones over %s", "follow-up: asks which of those are above %s",
                      "follow-up: asks for only those more than %s"], m), [m], ["follow.narrow", "copy.number"])
    S.answer(rng.choice(["(%s) that (%s > %d)", "(%s that (%s > %d))"]) % (S.them(), field, units * 100))


@cell(FOLLOW, ["follow.narrow", "handle.them"], w=2.0)
def f_narrow_name(S, rng):
    cur = listed(S, 3)
    labs = [lab for _, _, lab in S.last]
    cnt = collections.Counter(w.lower() for lab in labs for w in set(words(lab)))
    kw0 = (S.ctx.get("kw") or "").lower()
    cands = [w for w, c in cnt.items() if 1 <= c < len(labs) and w != kw0 and w not in kw0.split()]
    if not cands:
        raise Fail("no narrowing word")
    w = rng.choice(cands)
    w = w.capitalize() if w in S.W["names"] else w
    got = S.peek('show ((%s) called "%s")' % (cur, w))
    if not got or len(got) >= len(S.peek("show " + cur)):
        raise Fail("narrowing word does not narrow")
    S.turn(pick(rng, ["follow-up: asks for just the %s ones among those", "follow-up: asks which of those are about %s",
                      "follow-up: asks to narrow that to anything about %s"], w), [w], ["follow.narrow"])
    S.answer('(%s) called "%s"' % (S.them(), w))


@cell(FOLLOW, ["follow.narrow"], w=1.5)
def f_narrow_kind(S, rng):
    listed(S, 2)
    if S.ctx.get("kind") != "things":
        raise Fail("not things")
    kinds = sorted({k for _, k, _ in S.last})
    plural = {v: k for k, v in KIND_ENT.items() if k not in ("members",)}
    kinds = [k for k in kinds if k in plural and plural[k] in KIND_SAY]
    if len(kinds) < 2:
        raise Fail("one kind")
    k = plural[rng.choice(kinds)]
    if S.ctx.get("window"):
        expr = "(%s during %s)" % (k, S.ctx["window"])
        say = [S.ctx["window"].split()[-1]] if not S.back else []
    elif S.ctx.get("kw"):
        expr = '(%s called "%s")' % (k, S.ctx["kw"])
        say = [S.ctx["kw"]]
    else:
        raise Fail("no subject")
    S.turn("follow-up: asks for just the %s" % KIND_SAY[k], say + [KIND_SAY[k].split()[-1]], ["follow.narrow", ROUTE_OF[k]])
    S.answer(expr)
    S.ctx.update(kind=k)


@cell(FOLLOW, ["num.count", "handle.them"], w=1.5)
def f_count(S, rng):
    cur = listed(S, 2)
    if "things" in cur:
        raise Fail("count over mixed kinds")
    if S.ctx.get("kind") in ("tasks", "things") and rng.random() < 0.4 and \
            S.peek('show ((%s) that (status != "completed"))' % cur):
        S.turn("follow-up: asks how many of those are still open", [], [])
        S.answer('count of ((%s) that (status != "completed"))' % S.them())
        return
    S.turn(pick(rng, ["follow-up: asks how many that is", "follow-up: asks how many there are in total",
                      "follow-up: asks how many of them there are"]), [], [])
    S.answer("count of (%s)" % S.them())


@cell(FOLLOW, ["num.sum", "handle.them"], w=2.0)
def f_sum(S, rng):
    cur = listed(S, 2)
    ents = {k for _, k, _ in S.last}
    if ents == {"expense"}:
        field = "amount_minor"
    elif ents == {"party"} and "owed_to" in cur:
        field = "owed_to_me_minor" if "owed_to_me" in cur else "owed_to_them_minor"
    else:
        raise Fail("nothing to add up")
    S.turn(pick(rng, ["follow-up: asks what that comes to altogether", "follow-up: asks for the total of those",
                      "follow-up: asks what those add up to", "follow-up: asks how much that is in all"]), [], [])
    S.answer("sum %s of (%s)" % (field, S.them()))


def pick_by_word(S, rng, rows, kinds=None):
    """(n, kind, label, word): a row of `rows` a word of its label picks out among them"""
    rows = [r for r in rows if kinds is None or r[1] in kinds]
    rng.shuffle(rows)
    for n, k, lab in rows:
        for w in words(lab):
            wl = w.lower()
            if sum(wl in [x.lower() for x in words(l2)] for _, _, l2 in S.last) == 1 and wl not in (S.ctx.get("kw") or "").lower():
                return n, k, lab, (w if wl in S.W["names"] else wl)
    raise Fail("no row a word picks")


@cell(FOLLOW, ["num.value_of", "handle.pick"], w=2.0)
def f_how_much(S, rng):
    after_read(S)
    rows = [(n, k, lab) for n, k, lab in S.last if k in ("expense", "obligation")]
    if not rows:
        raise Fail("no amounts")
    if len(S.last) == 1:
        n = rows[0][0]
        S.turn(pick(rng, ["follow-up: asks how much it was", "follow-up: asks what it came to", "follow-up: asks how much"]),
               [], [])
    else:
        if not S.last_full:
            raise Fail("truncated")
        n, k, lab, w = pick_by_word(S, rng, rows)
        S.turn(pick(rng, ["follow-up: asks how much the %s one was", "follow-up: asks what the %s came to"], w), [w],
               ["handle.pick"])
    S.answer("amount_minor of (#%d)" % n)


@cell(FOLLOW, ["handle.ordinal"], w=2.0)
def f_ordinal_answer(S, rng):
    listed(S, 3, 12)
    pos = rng.randrange(min(len(S.last), 5))
    n = S.last[pos][0]
    set_before = (S.ctx.get("set"), S.ctx.get("pset"))
    S.turn(pick(rng, ["follow-up: asks to see just the %s one", "follow-up: asks what the %s one is",
                      "follow-up: asks for the %s one on that list"], ORD[pos]), [ORD[pos]], ["handle.ordinal"])
    if rng.random() < 0.3:
        S.look("get #%d" % n)
    S.answer("#%d" % n)
    S.ctx.update(focus=n, container=set_before)


@cell(FOLLOW, ["follow.except"], w=3.0)
def f_except(S, rng):
    """'what else' = the set the conversation is on, minus the row just discussed"""
    if S.back:
        raise Fail("not in back-to")
    c = S.ctx
    focus = c.get("focus")
    if c.get("album") and c.get("photo"):
        a, p = c["album"], c["photo"]
        lab = [l for n, _, l in S.rows if n == a]
        if not lab or len(S.peek('show (photos of (albums called "%s"))' % q(lab[0]))) < 2:
            raise Fail("album of one")
        S.turn(pick(rng, ["follow-up: asks what else is in that album", "follow-up: asks what other shots are in there"]),
               [], ["follow.except"])
        S.answer("(photos of (#%d)) except (#%d)" % (a, p))
        S.ctx.update(kind="photos", set=None)
        return
    if c.get("kind") == "events" and c.get("day") and focus:
        d = c["day"]
        if len(S.peek("show (things during %s)" % d)) < 2:
            raise Fail("lonely day")
        S.turn(pick(rng, ["follow-up: asks what else they have that day", "follow-up: asks what else is on that day"]), [],
               ["follow.except"])
        S.answer("(things during %s) ordered by dtstart asc" % d if rng.random() < 0.7 else "(things during %s)" % d)
        S.ctx.update(kind="things", window=d, focus=None, day=None)
        return
    if c.get("kind") == "documents" and focus and c.get("row"):
        f = extra(c["row"]).get("folder")
        if not f or len(S.peek('show (documents that (folder = "%s"))' % f)) < 2:
            raise Fail("no folder")
        S.turn(pick(rng, ["follow-up: asks what else is in the same folder", "follow-up: asks what sits alongside it in that folder"]),
               [], ["follow.except"])
        if rng.random() < 0.4:
            S.look("get #%d" % focus)
        S.answer('((documents) that (folder = "%s")) except (#%d)' % (f, focus))
        S.ctx.update(kind="documents", focus=None, row=None)
        return
    if focus and c.get("container") and c["container"][1] and len(S.peek("show " + c["container"][1])) >= 2:
        S.turn(pick(rng, ["follow-up: asks what else is on that list apart from that one", "follow-up: asks what the others are",
                          "follow-up: asks what else there is besides that one"]), [], ["follow.except"])
        S.answer("(%s) except (#%d)" % (c["container"][0], focus))
        S.ctx.update(container=None, focus=None)
        return
    if c.get("kind") == "groups" and c.get("expense") and c.get("group"):
        S.turn(pick(rng, ["follow-up: asks what else went into that group", "follow-up: asks for the other expenses in that group"]),
               [], ["follow.except"])
        S.answer("(expenses of (#%d)) except (#%d)" % (c["group"], c["expense"]))
        S.ctx.update(kind="expenses", expense=None)
        return
    if c.get("kind") == "places" and c.get("photo") and c.get("place"):
        if len(S.peek('show (photos of (places called "%s"))' % q([l for n, _, l in S.rows if n == c["place"]][0]))) < 2:
            raise Fail("one photo there")
        S.turn(pick(rng, ["follow-up: asks what else they took there", "follow-up: asks for the other photos from that place"]),
               [], ["follow.except"])
        S.answer("(photos of (#%d)) except (#%d)" % (c["place"], c["photo"]))
        S.ctx.update(kind="photos", photo=None)
        return
    if c.get("kind") == "notes" and focus and c.get("row") and extra(c["row"]).get("notebooks"):
        nb = extra(c["row"]).get("notebooks").split(", ")[0]
        if len(S.peek('show (notes that (notebooks = "%s"))' % nb)) < 2:
            raise Fail("lonely notebook")
        S.turn(pick(rng, ["follow-up: asks what else is in that notebook", "follow-up: asks for the other notes in the same notebook"]),
               [], ["follow.except"])
        S.answer('((notes) that (notebooks = "%s")) except (#%d)' % (nb, focus))
        S.ctx.update(focus=None)
        return
    if c.get("kind") == "parties" and c.get("event") and len(S.last) >= 2 and not S.back:
        n, k, lab = rng.choice(S.last[:4])
        if k != "party" or sum(first(l2) == first(lab) for _, _, l2 in S.last) > 1:
            raise Fail("no pick")
        S.turn("follow-up: asks who else is coming apart from %s" % first(lab), [first(lab)], ["follow.except"])
        S.answer("(parties of (#%d)) except (#%d)" % (c["event"], n))
        S.ctx.update(event=None)
        return
    if c.get("kind") == "locker items" and focus and c.get("kw"):
        others = S.peek('show (locker items called "%s")' % c["kw"].split()[-1])
        if len(others) < 2:
            raise Fail("no shelf")
        S.turn("follow-up: asks what else is on that shelf of the locker", [c["kw"].split()[-1]], ["follow.except"])
        S.answer('(locker items called "%s") except (#%d)' % (c["kw"].split()[-1], focus))
        return
    raise Fail("no container")


def carry_kw(S):
    kw = S.ctx.get("kw")
    if not kw:
        raise Fail("no name to carry")
    return kw


SWITCH_WORDS = {"notes": ["notes"], "documents": ["documents", "paperwork"], "tasks": ["tasks", "to-do list"],
                "events": ["calendar"], "photos": ["photos", "pictures"], "expenses": ["expenses"]}


@cell(FOLLOW, ["follow.switch_kind"], w=4.0)
def f_switch_kind(S, rng):
    kind = S.ctx.get("kind")
    if kind == "parties" and len(S.last) >= 2 and S.ctx.get("pset") and \
            S.peek_ok("show photos of (%s)" % S.ctx["pset"]) and rng.random() < 0.6:
        S.turn(pick(rng, ["follow-up: asks if they have a photo of any of them", "follow-up: asks for pictures with any of those people in"]),
               [], ["follow.switch_kind", "route.media"])
        S.answer("photos of (%s)" % S.them())
        S.ctx.update(kind="photos")
        return
    kw = carry_kw(S)
    if kind not in ("notes", "documents", "tasks", "events", "photos", "things", "expenses", "locker items"):
        raise Fail("no kind to switch from")
    others = [k for k in ("notes", "documents", "tasks", "events", "photos", "expenses") if k != kind]
    rng.shuffle(others)
    for k in others:
        if S.peek('show (%s called "%s")' % (k, q(kw))):
            break
    else:
        raise Fail("name in no other kind")
    word = rng.choice(SWITCH_WORDS[k])
    S.turn(pick(rng, ["follow-up: asks whether there's anything in their %s about it too", "follow-up: asks what about in their %s",
                      "follow-up: asks if it's in their %s as well", "follow-up: asks what their %s have on it"], word),
           [word], ["follow.switch_kind", ROUTE_OF[k]])
    if MIX.n_looks(rng, 0, 1):
        S.look(rng.choice(['search "%s"' % q(kw), 'show (%s called "%s")' % (k, q(kw))]))
    S.answer(rng.choice(['(%s called "%s")', '(%s) called "%s"']) % (k, q(kw)))
    S.ctx.update(kind=k)


@cell(FOLLOW, ["follow.swap_subject"], w=4.0)
def f_swap(S, rng):
    sw = S.ctx.get("swap")
    if not sw or S.back:
        raise Fail("nothing to swap")
    cands = list(sw["cands"])
    rng.shuffle(cands)
    for v, say in cands:
        expr = sw["tmpl"] % v
        got = S.peek(("show " if not VALUE.match(expr) else "") + expr)
        if got:
            break
    else:
        raise Fail("no other subject")
    S.turn("follow-up: " + sw["hint"].replace("%s", say, 2).replace("%s", say), [say],
           ["follow.swap_subject"] + sw["skills"])
    if sw.get("kw") and not VALUE.match(expr) and MIX.n_looks(rng, 0, 1):
        S.look('search "%s"' % say)
    S.answer(expr)
    if sw.get("kw"):
        S.ctx["kw"] = v
    S.ctx["topic"] = sw.get("topic", "%s") % say if "%s" in sw.get("topic", "%s") else sw["topic"]


@cell(FOLLOW, ["num.balance", "follow.swap_subject"], w=2.5)
def f_balance_next(S, rng):
    bn = S.ctx.get("balance_next")
    if not bn or not bn[1]:
        raise Fail("no other member")
    g, shown = bn
    h, lab = rng.choice(shown)
    who = first(lab)
    S.turn("follow-up: asks the same for %s ('and %s?')" % (who, who), [who], ["follow.swap_subject"])
    S.answer("balance of (#%d) in (#%d)" % (h, g), empty=True)
    S.ctx["balance_next"] = (g, [x for x in shown if x[0] != h])


LINK_HINT = {
    ("event", "parties"): ["asks who's coming to it", "asks who else will be there"],
    ("photo", "places"): ["asks where it was taken"], ("photo", "albums"): ["asks which album it's in"],
    ("photo", "parties"): ["asks who is in it"],
    ("place", "photos"): ["asks to see the photos from there"], ("album", "photos"): ["asks to see the photos in it"],
    ("party", "important dates"): ["asks when their birthday is"], ("party", "events"): ["asks what events they're coming to"],
    ("party", "obligations"): ["asks about the debts with them"], ("party", "activities"): ["asks when they last spoke"],
    ("party", "contact channels"): ["asks for their contact details"],
    ("group", "expenses"): ["asks for its expenses"], ("group", "members"): ["asks who's in it"],
    ("expense", "groups"): ["asks which group it's in"], ("task", "tasks"): ["asks for its steps"],
}


@cell(FOLLOW, ["link.parties_of", "link.media", "link.of_person", "link.of_group", "link.subtasks", "handle.pick"], w=4.0)
def f_link(S, rng):
    if not S.last or len(S.last) > 12:
        raise Fail("nothing shown")
    cands = []
    for i, (n, k, lab) in enumerate(S.last[:5]):
        for (ent, link), hints in LINK_HINT.items():
            if ent == k:
                cands.append((i, n, k, lab, link, hints))
    rng.shuffle(cands)
    for i, n, k, lab, link, hints in cands:
        kind = [kk for kk, v in KIND_ENT.items() if v == k and kk != "members"][0]
        try:
            got = S.peek('show (%s of (%s called "%s"))' % (link, kind, q(lab)))
        except Fail:
            continue
        if got and not isinstance(got, (int, float)) and len(S.peek('show (%s called "%s")' % (kind, q(lab)))) == 1:
            break
    else:
        raise Fail("no link to walk")
    hint = rng.choice(hints)
    skills = []
    say = []
    if len(S.last) == 1:
        hint = "follow-up: " + hint
    else:
        try:
            nn, kk, ll, w = pick_by_word(S, rng, [(n, k, lab)])
            hint = "follow-up: about the %s one, %s" % (w, hint)
            say = [w]
            skills = ["handle.pick"]
        except Fail:
            hint = "follow-up: about the %s one, %s" % (ORD[i], hint)
            say = [ORD[i]]
            skills = ["handle.ordinal"]
    S.turn(hint, say, skills)
    tail = " that (party_id is not me)" if link in ("parties", "members") and k != "photo" and rng.random() < 0.6 else ""
    if MIX.n_looks(rng, 0, 1):
        S.look("get #%d" % n)
    S.answer(("(%s of (#%d))%s" if tail else "%s of (#%d)%s") % (link, n, tail))
    S.ctx.update(kind=link if link != "members" else "parties", focus=S.last[0][0] if len(S.last) == 1 else None)
    if link == "albums":
        S.ctx.update(album=S.last[0][0], photo=n)


def after_read(S, judge_ok=False):
    """the last turn looked at rows (or we are back on an earlier list)"""
    if S.back:
        return
    if not S.turns or S.turns[-1]["t"] not in (("read", "judge") if judge_ok else ("read",)):
        raise Fail("last turn was not a read")


# == follow-ups: writes on what was shown =======================================================

ORD_VERBS = {
    "task": [("complete{}", ["asks to tick off the %s one", "says the %s one is done"], None),
             ("reschedule{to: %s}", ["asks to move the %s one to %s", "asks to push the %s one to %s"], "day"),
             ("delete{}", ["asks to delete the %s one", "asks to bin the %s one"], None)],
    "event": [("reschedule{to: %s}", ["asks to move the %s one to %s", "asks to shift the %s one to %s"], "day"),
              ("reschedule{by: +1h}", ["asks to make the %s one an hour later"], None),
              ("cancel{}", ["asks to call off the %s one"], None)],
    "document": [("core.star_document{}", ["asks to star the %s one"], None),
                 ("core.trash_document{}", ["asks to bin the %s one"], None)],
    "note": [("delete{}", ["asks to delete the %s one"], None)],
    "photo": [("media.delete_asset{}", ["asks to delete the %s one"], None)],
    "locker item": [('locker.reveal_receipt{columns: "password"}', ["asks for the password of the %s one"], None)],
    "party": [('people.log_interaction{kind: "call"}', ["says they phoned the %s one, log it"], None)],
    "obligation": [("people.settle_debt{}", ["asks to mark the %s one as paid"], None)],
    "expense": [("tally.delete_expense{}", ["asks to delete the %s one"], None)],
}
UNDO = {"delete{}": "restore{}", "core.trash_document{}": "core.restore_document{}", "media.delete_asset{}": "restore{}",
        "tally.delete_expense{}": "tally.undo_expense{}", "people.trash_person{}": "restore{}",
        "locker.trash_item{}": "restore{}"}


def ordinal_target(S, rng, by_word):
    """(pos, n, kind, label, words-said, skill) of a row in the last list to act on"""
    if not S.last or not S.last_full and len(S.last) > 12:
        raise Fail("nothing listed")
    rows = [(i, n, k, lab) for i, (n, k, lab) in enumerate(S.last[:6]) if k in ORD_VERBS]
    if not rows:
        raise Fail("nothing actionable")
    if by_word and len(S.last) >= 2:
        n, k, lab, w = pick_by_word(S, rng, [(n, k, lab) for _, n, k, lab in rows])
        i = [x[0] for x in rows if x[1] == n][0]
        return i, n, k, lab, "the %s one" % w, [w], "handle.pick"
    if len(S.last) < 2:
        raise Fail("one row")
    i, n, k, lab = rng.choice(rows)
    if i == len(S.last) - 1 and S.last_full and rng.random() < 0.4:
        return i, n, k, lab, "the last one", ["last"], "handle.ordinal"
    return i, n, k, lab, "the %s one" % ORD[i], [ORD[i]], "handle.ordinal"


def f_act(S, rng, by_word):
    after_read(S)
    i, n, k, lab, said, say, skill = ordinal_target(S, rng, by_word)
    verb, hints, arg = rng.choice(ORD_VERBS[k])
    hint = rng.choice(hints).replace("the %s one", said)
    if arg == "day":
        d = rng.choice(WRITE_DAYS)
        verb = verb % d
        hint = hint % d
        say = say + [d]
    kind = [kk for kk, v in KIND_ENT.items() if v == k and kk != "members"][0]
    if verb.startswith("reschedule") and not probe_write(S, kind, lab, verb):
        raise Fail("move would not land")
    S.turn("follow-up: " + hint, say, [skill], t="write")
    S.write("%s on #%d" % (verb, n))
    S.ctx.update(wrote={"verb": verb, "n": n, "ent": k, "undo": UNDO.get(verb), "pos": i}, focus=n)


@cell(FOLLOW, ["handle.ordinal", "write.reschedule", "write.mark", "write.trash"], w=3.5)
def f_ordinal_write(S, rng):
    f_act(S, rng, False)


@cell(FOLLOW, ["handle.pick", "write.reschedule", "write.mark", "write.trash"], w=3.5)
def f_pick_write(S, rng):
    f_act(S, rng, True)


@cell(FOLLOW, ["handle.them", "compose.bulk", "write.reschedule", "write.mark"], w=2.5)
def f_them_write(S, rng):
    after_read(S)
    listed(S, 2, 5)
    if not S.last_full:
        raise Fail("truncated")
    kinds = {k for _, k, _ in S.last}
    ns = [n for n, _, _ in S.last]
    if kinds <= {"task", "event"}:
        opts = [("reschedule{to: %s}", "asks to move %s to %s", True)]
        if kinds == {"task"}:
            opts += [("complete{}", "says %s are done, tick them off", False), ("delete{}", "asks to delete %s", False)]
    elif kinds == {"document"}:
        opts = [("core.star_document{}", "asks to star %s", False)]
    elif kinds == {"note"}:
        opts = [("delete{}", "asks to delete %s", False)]
    elif kinds == {"obligation"}:
        opts = [("people.settle_debt{}", "asks to mark %s as paid", False)]
    else:
        raise Fail("mixed kinds")
    verb, hint, day = rng.choice(opts)
    who = "both of them" if len(ns) == 2 else "all of them"
    say = []
    if day:
        d = rng.choice(WRITE_DAYS)
        verb = verb % d
        hint = hint % (who, d)
        say = [d]
    else:
        hint = hint % who
    S.turn("follow-up: " + hint, say, ["handle.them"], t="write")
    S.write("%s on %s" % (verb, hs(ns)))
    S.ctx.update(wrote={"verb": verb, "ns": ns, "undo": UNDO.get(verb)})


@cell(FOLLOW, ["compose.then", "handle.ordinal"], w=2.0)
def f_split_then(S, rng):
    after_read(S)
    items = [(i, n, k) for i, (n, k, _) in enumerate(S.last[:5]) if k in ("task", "event")]
    if len(items) < 2 or len(S.last) > 10:
        raise Fail("fewer than two")
    (i1, a, ka), (i2, b, kb) = sorted(rng.sample(items, 2))
    r = rng.random()
    if r < 0.5:
        d1, d2 = rng.sample(WRITE_DAYS, 2)
        S.turn("follow-up: asks to move the %s one to %s and the %s one to %s" % (ORD[i1], d1, ORD[i2], d2),
               [ORD[i1], d1, ORD[i2], d2], ["handle.ordinal"], t="write")
        S.write("reschedule{to: %s} on #%d then reschedule{to: %s} on #%d" % (d1, a, d2, b))
    elif ka == "task" and kb == "task":
        S.turn("follow-up: asks to tick off the %s one and delete the %s one" % (ORD[i1], ORD[i2]), [ORD[i1], ORD[i2]],
               ["handle.ordinal"], t="write")
        S.write("complete{} on #%d then delete{} on #%d" % (a, b))
    else:
        d1 = rng.choice(WRITE_DAYS)
        if kb != "event":
            raise Fail("cancel a task")
        S.turn("follow-up: asks to move the %s one to %s and cancel the %s one" % (ORD[i1], d1, ORD[i2]),
               [ORD[i1], d1, ORD[i2]], ["handle.ordinal"], t="write")
        S.write("reschedule{to: %s} on #%d then cancel{} on #%d" % (d1, a, b))


@cell(FOLLOW, ["compose.undo", "write.restore"], w=4.0)
def f_undo(S, rng):
    w = S.ctx.get("wrote")
    if not w or not w.get("undo") or S.back or not S.turns[-1]["steps"][-1]["call"].startswith(
            ("delete", "core.trash", "media.delete", "tally.delete", "people.trash", "locker.trash", "tally.add_expense")):
        raise Fail("nothing to undo")
    ns = w.get("ns") or ([w["n"]] if w.get("n") else [])
    if not ns:
        raise Fail("no row")
    S.turn(pick(rng, ["follow-up: takes it back: scratch that, put it back", "follow-up: says oops, undo that",
                      "follow-up: says they didn't mean that, bring it back", "follow-up: says no wait, undo that"]), [],
           ["compose.undo"], t="write")
    undo = w["undo"]
    if undo == "restore{}" and w.get("ent") == "photo" and rng.random() < 0.5:
        undo = "media.restore_asset{}"
    S.write("%s on %s" % (undo, hs(ns)))
    S.ctx.pop("wrote", None)


@cell(FOLLOW, ["compose.correction"], w=4.0)
def f_correct(S, rng):
    w = S.ctx.get("wrote")
    if not w or S.back or not w.get("verb") or not w.get("n"):
        raise Fail("nothing to correct")
    verb, n = w["verb"], w["n"]
    ent = w.get("ent")
    if w.get("pos") is not None:
        # an ordinal/picked write: the person meant another row of that list
        others = [(i, m, k, lab) for i, (m, k, lab) in enumerate(S.turns_shown(len(S.turns) - 2)[:6]) if m != n and k == ent]
        if not others:
            raise Fail("no other row")
        i, m, k, lab = rng.choice(others)
        S.turn("follow-up: corrects: wrong one, they meant the %s one" % ORD[i], [ORD[i]],
               ["compose.correction", "handle.ordinal"], t="write")
        S.write("%s on #%d" % (verb, m))
    elif ent == "party" and w.get("name"):
        name = w["name"]
        clash = [c for c in S.W["meta"].get("first_name_clashes", {}).items() if first(name) == c[0]]
        if clash and name != first(name):
            S.turn("follow-up: corrects: sorry, it was the other %s" % first(name), [first(name), "other"],
                   ["compose.correction"], t="write")
            S.look('show (parties called "%s")' % first(name))
            other = [m for m, k, lab in S.last if k == "party" and m != n]
            if not other:
                raise Fail("no other")
            S.write("%s on #%d" % (verb, other[0]))
        else:
            ps = [p for p in people(S) if p["label"] != name and unique_first(S, p)]
            p = rng.choice(ps)
            nm2 = first(p["label"])
            S.turn("follow-up: corrects: sorry, it was %s, not them" % nm2, [nm2], ["compose.correction"], t="write")
            S.look(rng.choice(['show (parties called "%s")' % nm2, 'search "%s"' % nm2]))
            S.write("%s on #%d" % (verb, S.handle(p["label"], "party")))
    elif ent in ("task", "event", "document", "photo"):
        kind = {"task": "tasks", "event": "events", "document": "documents", "photo": "photos"}[ent]
        rows = [r for r in rows_of(S, kind) if r["label"] not in {lab for m, _, lab in S.rows if m == n}]
        if verb.startswith("media.add_to_album"):
            al = [lab for m, k, lab in S.rows if k == "album" and "(#%d)" % m in verb]
            inside = {p["label"] for p in live(S.peek_ok('show (photos of (albums called "%s"))' % q(al[0])))} if al else set()
            rows = [r for r in rows if r["label"] not in inside]
        r, kw = unique_label(S, rng, kind, rows, two=0.4)
        kw = low(kw, S.W["names"])
        S.turn("follow-up: corrects: wrong %s, they meant the %s one" % (ent, kw), [kw], ["compose.correction"],
               t="write")
        S.look('search "%s"' % q(kw) if rng.random() < 0.5 else 'show (%s called "%s")' % (kind, q(kw)))
        S.write("%s on #%d" % (verb, S.handle(r["label"], ent)))
    else:
        raise Fail("no correction")
    S.ctx.pop("wrote", None)


@cell(FOLLOW, ["judge.never_mind"], w=1.2)
def f_never_mind(S, rng):
    after_read(S, judge_ok=True)
    if S.back or not S.turns:
        raise Fail("nothing to take back")
    S.turn(pick(rng, ["follow-up: says never mind", "follow-up: says forget it", "follow-up: says actually, don't bother",
                      "follow-up: says nah, leave it", "follow-up: says scrap that, they'll check later themselves"]), [],
           ["judge.never_mind"], t="judge")
    S.call("nothing")


@cell(FOLLOW, ["write.reveal", "handle.pick"], w=3.0)
def f_reveal(S, rng):
    after_read(S)
    items = [n for n, k, _ in S.last if k == "locker item"]
    if not items:
        raise Fail("no locker row")
    if len(items) == 1:
        n = items[0]
        S.turn(pick(rng, ["follow-up: asks to see the password", "follow-up: asks for the actual password",
                          "follow-up: asks what the password on it is"]), ["password"], [], t="write")
    else:
        n, k, lab, w = pick_by_word(S, rng, [(m, k, lab) for m, k, lab in S.last if k == "locker item"])
        S.turn("follow-up: asks for the password of the %s one" % w, [w, "password"], ["handle.pick"], t="write")
    S.write('locker.reveal_receipt{columns: "password"} on #%d' % n)


@cell(FOLLOW, ["write.settle", "handle.pick"], w=3.0)
def f_settle_after(S, rng):
    after_read(S)
    obls = [(n, lab) for n, k, lab in S.last if k == "obligation"]
    if not obls:
        raise Fail("no debts shown")
    obs = S.turns[-1]["steps"][-1]["obs"]
    opn = [n for n, _ in obls if not re.search(r'^#%d obligation [^\n]*settled_at=' % n, obs, re.M)]
    if not opn:
        raise Fail("all settled")
    S.turn(pick(rng, ["follow-up: asks to settle it", "follow-up: says they've paid it, mark it settled",
                      "follow-up: asks to mark that debt as paid", "follow-up: asks to clear it"]) if len(opn) == 1 else
           pick(rng, ["follow-up: asks to settle up with them", "follow-up: asks to mark those debts paid"]), [], [],
           t="write")
    S.write("people.settle_debt{} on %s" % hs(opn))


@cell(FOLLOW, ["write.log_interaction", "handle.pick"], w=2.5)
def f_log_after(S, rng):
    after_read(S)
    ps = [(n, lab) for n, k, lab in S.last if k == "party" and lab != "You"]
    if not ps:
        raise Fail("no person shown")
    kind = rng.choice(list(LOG_KIND))
    v = rng.choice(LOG_KIND[kind])
    if len(ps) == 1:
        n, lab = ps[0]
        S.turn("follow-up: says they %s them today, log it" % v, [log_word(v)], [], t="write")
    else:
        if sum(first(l2) == first(ps[0][1]) for _, l2 in ps) > 1:
            raise Fail("shared first name")
        n, lab = rng.choice(ps)
        if sum(first(l2) == first(lab) for _, l2 in ps) > 1:
            raise Fail("shared first")
        S.turn("follow-up: says they %s %s, log it" % (v, first(lab)), [first(lab), log_word(v)], ["handle.pick"],
               t="write")
    S.write('people.log_interaction{kind: "%s"} on #%d' % (kind, n))
    S.ctx.update(wrote={"verb": 'people.log_interaction{kind: "%s"}' % kind, "n": n, "ent": "party", "name": lab})


@cell(FOLLOW, ["write.album_add", "handle.ordinal", "compose.lookup_write"], w=3.0)
def f_album_add_after(S, rng):
    after_read(S)
    photos = [(i, n, lab) for i, (n, k, lab) in enumerate(S.last[:6]) if k == "photo"]
    if not photos or S.last_full is False and len(S.last) < 2:
        raise Fail("no photos shown")
    albums = album_rows(S)
    i, n, lab = rng.choice(photos)
    rows = live(S.peek('show (photos called "%s")' % q(lab)))
    have = set((extra(rows[0]).get("album_titles") or "").split(", ")) if rows else set()
    albums = [a for a in albums if a["label"] not in have and len(S.peek('show (albums called "%s")' % q(a["label"]))) == 1
              and lab not in {p["label"] for p in live(S.peek_ok('show (photos of (albums called "%s"))' % q(a["label"])))}]
    if not albums:
        raise Fail("no album to add to")
    a = rng.choice(albums)
    said = "it" if len(S.last) == 1 else "the %s one" % ORD[i]
    S.turn("follow-up: asks to put %s in the %s album" % (said, a["label"]), ([ORD[i]] if len(S.last) > 1 else []) +
           [a["label"], "album"], ["handle.ordinal"] if len(S.last) > 1 else ["handle.pick"], t="write")
    known = [m for m, k, l2 in S.rows if k == "album" and l2 == a["label"]]
    if known and rng.random() < 0.5:
        al = known[0]
    else:
        S.look('search "%s"' % a["label"] if rng.random() < 0.5 else 'show (albums called "%s")' % a["label"])
        al = S.handle(a["label"], "album")
    S.write("media.add_to_album{album_id: (#%d)} on #%d" % (al, n))
    S.ctx.update(wrote={"verb": "media.add_to_album{album_id: (#%d)}" % al, "n": n, "ent": "photo"}, album=al, photo=n)


@cell(FOLLOW, ["write.restore", "handle.pick"], w=3.0)
def f_restore_after(S, rng):
    tr = S.ctx.get("trashed")
    if not tr or S.back or tr[1] == "documents":
        raise Fail("nothing trashed shown")
    n, kind = tr
    S.turn(pick(rng, ["follow-up: asks to put it back", "follow-up: asks to restore it", "follow-up: says to bring it back"]),
           [], [], t="write")
    verb = {"documents": rng.choice(["core.restore_document{}", "restore{}"]),
            "photos": rng.choice(["media.restore_asset{}", "restore{}"])}.get(kind, "restore{}")
    S.write("%s on #%d" % (verb, n))
    S.ctx.pop("trashed", None)


@cell(FOLLOW, ["judge.ambiguous", "handle.pick", "write.log_interaction"], w=3.0)
def f_clash_resolve(S, rng):
    c = S.ctx.get("clash")
    if not c or S.back:
        raise Fail("no clash")
    f, ps, kind = c
    p = rng.choice(ps)
    role = (extra(p).get("role") or "").lower()
    r = rng.random()
    if r < 0.5:
        sur = p["label"].split()[-1]
        S.turn("follow-up: says it was %s %s" % (f, sur), [sur], ["handle.pick"], t="write")
    elif role and r < 0.8:
        S.turn("follow-up: says it was the %s one (%s)" % (f, role), [role.split()[-1]], ["handle.pick"], t="write")
    else:
        S.turn("follow-up: says it was %s" % p["label"], [p["label"]], ["handle.pick"], t="write")
    shown = [m for m, k, lab in S.last if lab == p["label"]]
    if not shown:
        S.look('show (parties called "%s")' % f)
    S.write('people.log_interaction{kind: "%s"} on #%d' % (kind, S.handle(p["label"], "party")))
    S.ctx.pop("clash", None)


@cell(FOLLOW, ["link.of_person", "handle.pick"], w=2.0)
def f_phone(S, rng):
    after_read(S)
    ps = [(n, lab) for n, k, lab in S.last if k == "party" and lab != "You"]
    if not ps:
        raise Fail("no people")
    rng.shuffle(ps)
    for n, lab in ps:
        kind = rng.choice(["phone", "email"])
        if S.peek_ok('show (contact channels of (parties called "%s")) that (kind = "%s")' % (q(lab), kind)) and \
                sum(first(l2) == first(lab) for _, l2 in ps) == 1:
            break
    else:
        raise Fail("no channel")
    word = {"phone": "number", "email": "email"}[kind]
    if len(ps) == 1:
        S.turn("follow-up: asks for their %s" % word, [], [])
    else:
        S.turn("follow-up: asks for %s's %s" % (first(lab), word), [first(lab)], ["handle.pick"])
    S.answer('(contact channels of (#%d)) that (kind = "%s")' % (n, kind))
    S.ctx.update(kind="contact channels")


@cell(FOLLOW, ["write.add_task", "copy.title", "handle.pick"], w=1.5)
def f_task_about(S, rng):
    after_read(S)
    rows = [(n, k, lab) for n, k, lab in S.last if k in ("note", "document", "event", "photo", "party")]
    if len(rows) != 1 and len(S.last) != 1:
        raise Fail("not one row")
    if not rows:
        raise Fail("no row")
    n, k, lab = rows[0]
    ws = words(lab)
    if not ws:
        raise Fail("no word")
    w = rng.choice(ws)
    w = w if w.lower() in S.W["names"] else w.lower()
    verb = rng.choice(["Print", "Read", "Check", "Sign", "Send", "Reply to", "Call"] if k != "party" else ["Call", "Email", "Visit"])
    title = "%s %s" % (verb, w if k == "party" else "the %s %s" % (w, {"note": "note", "document": "document",
                                                                          "event": "booking", "photo": "photo"}[k]))
    d = rng.choice(WRITE_DAYS + [None, None])
    st = said_title(title, S)
    S.turn("follow-up: asks for a task to %s%s" % (st, " %s" % d if d else ""), [st] + ([d] if d else []),
           ["copy.title"], t="write")
    S.write('schedule.add_task{title: "%s"%s}' % (title, ", due_at: %s" % d if d else ""))


# == minimal pairs ================================================================================
# Two one-turn sessions, near-identical requests, different answers. `setup` picks the shared
# subject (peeks only); `a` and `b` each play one turn in a fresh session.

def pair(setup):
    def deco(fs):
        a, b = fs
        setup.a, setup.b = a, b
        PAIRS.append(setup)
        return fs
    return deco


def ps_dtstart(S, rng):
    kws = list(S.W["meta"].get("shared_keywords", {}).items())
    rng.shuffle(kws)
    for kw, kinds in kws:
        kk = kw.capitalize() if kw in S.W["names"] else kw
        got = [r for r in S.peek('show (things called "%s")' % kk) if r.get("date")]
        if len({r["entity"] for r in got}) >= 2 and len(S.peek('show (things called "%s")' % kk)) <= 12:
            return {"kw": kk}
    raise Fail("no multi-kind name")


def pa_dtstart(S, rng, sh):
    S.turn("asks when their %s thing is (no kind given)" % sh["kw"], [sh["kw"]], ["num.dtstart_of"], t="judge")
    obs = S.call('answer dtstart of (things called "%s")' % sh["kw"])
    if not obs.startswith("ambiguous"):
        raise Fail("not ambiguous")
    S.done()


def pb_dtstart(S, rng, sh):
    S.turn("asks what %s things they have" % sh["kw"], [sh["kw"]], ["route.everything"])
    S.answer('(things called "%s")' % sh["kw"])


pair(ps_dtstart)((pa_dtstart, pb_dtstart))


def ps_count(S, rng):
    opts = [('(tasks) that (due_at during %s)', "tasks due %s", "to-dos"), ("(events) during %s", "events %s", "events"),
            ('(photos) that (captured_at during %s)', "photos taken %s", "photos")]
    rng.shuffle(opts)
    for expr, desc, word in opts:
        for w in rng.sample(["this week", "next week", "tomorrow", "last week", "this month", "last month", "friday"], 7):
            if 2 <= len(S.peek("show " + expr % w)) <= 12:
                return {"expr": expr % w, "desc": desc % w, "w": w, "word": word}
    raise Fail("nothing to count")


def pa_count(S, rng, sh):
    S.turn("asks how many %s they have" % sh["desc"], [sh["w"], "how many"], ["num.count"])
    S.answer("count of (%s)" % sh["expr"])


def pb_count(S, rng, sh):
    S.turn("asks which %s they have" % sh["desc"], [sh["w"], "which"], [])
    S.answer(sh["expr"])


pair(ps_count)((pa_count, pb_count))


def ps_settle(S, rng):
    g, kw = group_kw(S, rng)
    mem, pos = positive_members(S, kw)
    pos = [m for m in pos if sum(first(x["label"]) == first(m["label"]) for x in mem) == 1]
    if not pos:
        raise Fail("nobody owes")
    m = rng.choice(pos)
    return {"g": g, "kw": kw, "m": m, "who": first(m["label"]), "units": expense_units(S, rng),
            "what": rng.choice(["taxi", "tickets", "lunch", "petrol"])}


def pa_settle(S, rng, sh):
    S.turn("asks to settle up with %s in %s" % (sh["who"], sh["kw"]), [sh["who"], sh["kw"], "settle up"], [], t="write")
    n = find_group(S, rng, sh["g"], sh["kw"], read=False)
    S.look("show (members of (#%d)) that (party_id is not me)" % n)
    h = S.handle(sh["m"]["label"], "member")
    S.write("tally.settle_up{to_party: me, group_id: (#%d), amount_minor: balance of (#%d) in (#%d)} on #%d" % (n, h, n, h))


def pb_settle(S, rng, sh):
    m = money_say(rng, S.W, sh["units"], bare_ok=False)
    desc = "%s's %s" % (sh["who"], sh["what"])
    S.turn("asks to add %s for %s to %s, they paid" % (m, desc, sh["kw"]), [m, desc, sh["kw"]], ["copy.number", "copy.title"],
           t="write")
    n = find_group(S, rng, sh["g"], sh["kw"], read=False)
    S.write('tally.add_expense{description: "%s", amount_minor: %d, paid_by: me, group_id: (#%d)}'
            % (desc[0].upper() + desc[1:], sh["units"] * 100, n))


pair(ps_settle)((pa_settle, pb_settle))


def ps_birthday(S, rng):
    by = dates_by_person(S)
    for e in rng.sample(rows_of(S, "events"), len(rows_of(S, "events"))):
        m = re.match(r"^(Dinner|Lunch|Coffee|Drinks|Walk) with (\w+)$", e["label"])
        if not m:
            continue
        f = m.group(2)
        full = [nm for nm, ds in by.items() if nm.split()[0] == f and len(ds) == 1 and ds[0]["label"].startswith("Birthday")]
        if full and len(S.peek('show (events called "%s %s")' % (m.group(1).lower(), f))) == 1 and \
                len(S.peek('show (important dates called "%s")' % f)) == 1:
            return {"f": f, "what": m.group(1).lower()}
    raise Fail("no birthday/event pair")


def pa_birthday(S, rng, sh):
    S.turn("asks when %s's birthday is" % sh["f"], [sh["f"], "birthday"], ["route.schedule"])
    S.answer('(important dates called "%s")' % sh["f"])


def pb_birthday(S, rng, sh):
    S.turn("asks when their %s with %s is" % (sh["what"], sh["f"]), [sh["f"], sh["what"]], ["route.schedule"])
    S.answer('(events called "%s %s")' % (sh["what"], sh["f"]))


pair(ps_birthday)((pa_birthday, pb_birthday))


def ps_delete(S, rng):
    kind, ent = rng.choice(TRASH_KINDS)
    rows = trashed(S, kind)
    if not rows:
        raise Fail("no trash")
    tkw = only_trashed_keyword(S, rng, kind, rng.choice(rows))
    r, kw = unique_label(S, rng, kind, rows_of(S, kind), two=0.2)
    return {"kind": kind, "ent": ent, "tkw": tkw, "kw": low(kw, S.W["names"]), "row": r}


def pa_delete(S, rng, sh):
    S.turn("asks to delete the %s %s" % (sh["kw"], sh["ent"]), [sh["kw"], sh["ent"]], [], t="write")
    S.look('show (%s called "%s")' % (sh["kind"], q(sh["kw"])))
    S.write("%s on #%d" % (TRASH_VERB[sh["kind"]][1][0], S.handle(sh["row"]["label"], sh["ent"])))


def pb_delete(S, rng, sh):
    S.turn("asks to delete the %s %s" % (sh["tkw"], sh["ent"]), [sh["tkw"], sh["ent"]], ["judge.nothing_there"], t="judge")
    S.miss('show (%s called "%s")' % (sh["kind"], q(sh["tkw"])), "none")
    S.look('show (%s called "%s") that (deleted_at is not null)' % (sh["kind"], q(sh["tkw"])))
    S.call("nothing")


pair(ps_delete)((pa_delete, pb_delete))


def ps_clash(S, rng):
    f, ps = rng.choice(clashes(S))
    return {"f": f, "ps": ps, "p": rng.choice(ps), "kind": rng.choice(list(LOG_KIND))}


def pa_clash(S, rng, sh):
    v = LOG_KIND[sh["kind"]][0]
    S.turn("says they %s %s today, log it (two contacts are called %s)" % (v, sh["f"], sh["f"]), [sh["f"], log_word(v)],
           ["judge.ambiguous"], t="judge")
    if rng.random() < 0.5:
        obs = S.call('people.log_interaction{kind: "%s"} on (parties called "%s")' % (sh["kind"], sh["f"]))
        if not obs.startswith("ambiguous"):
            raise Fail("not ambiguous")
        S.done()
    else:
        S.look('show (parties called "%s")' % sh["f"])
        S.ask("Which %s — %s?" % (sh["f"], " or ".join(p["label"].split()[-1] for p in sh["ps"])))
    S.ctx.update(kind="parties", clash=(sh["f"], sh["ps"], sh["kind"]), topic=sh["f"])


def pb_clash(S, rng, sh):
    v = LOG_KIND[sh["kind"]][0]
    p = sh["p"]
    role = (extra(p).get("role") or "").lower()
    if role and rng.random() < 0.4:
        S.turn("says they %s %s (the %s one) today, log it" % (v, sh["f"], role), [sh["f"], role.split()[-1], log_word(v)],
               ["judge.ambiguous", "route.people"], t="write")
        S.look('show (parties called "%s")' % sh["f"])
    else:
        S.turn("says they %s %s today, log it" % (v, p["label"]), [p["label"], log_word(v)], ["judge.ambiguous"], t="write")
        S.look('show (parties called "%s")' % p["label"] if rng.random() < 0.5 else 'search "%s"' % p["label"])
    S.write('people.log_interaction{kind: "%s"} on #%d' % (sh["kind"], S.handle(p["label"], "party")))


pair(ps_clash)((pa_clash, pb_clash))


def ps_spend(S, rng):
    g, kw = group_kw(S, rng)
    if not S.peek('show (expenses of (groups called "%s"))' % q(kw)):
        raise Fail("no expenses")
    return {"g": g, "kw": kw}


def pa_spend(S, rng, sh):
    S.turn("asks how much they've spent in %s" % sh["kw"], [sh["kw"], "how much"], ["route.money"])
    S.answer("sum amount_minor of (expenses of (#%d))" % find_group(S, rng, sh["g"], sh["kw"]))


def pb_spend(S, rng, sh):
    S.turn("asks what they've spent on in %s (the expenses)" % sh["kw"], [sh["kw"]], ["route.money"])
    S.answer("expenses of (#%d)" % find_group(S, rng, sh["g"], sh["kw"]))


pair(ps_spend)((pa_spend, pb_spend))


def ps_secret(S, rng):
    items = [i for i in rows_of(S, "locker items") if extra(i).get("type") in ("login", "wifi", "password")]
    it, kw = unique_label(S, rng, "locker items", items, two=0.6)
    return {"it": it, "kw": kw if any(w.lower() in S.W["names"] for w in kw.split()) else kw.lower()}


def pa_secret(S, rng, sh):
    S.turn("asks for the %s entry in the locker (the row, not the password)" % sh["kw"], [sh["kw"]], ["route.locker"])
    S.answer('(locker items called "%s")' % q(sh["kw"]))


def pb_secret(S, rng, sh):
    S.turn("asks what the actual password for the %s is" % sh["kw"], [sh["kw"], "password"], ["route.locker"], t="write")
    S.look('show (locker items called "%s")' % q(sh["kw"]))
    S.write('locker.reveal_receipt{columns: "password"} on #%d' % S.handle(sh["it"]["label"], "locker item"))


pair(ps_secret)((pa_secret, pb_secret))


def ps_event(S, rng):
    e, kw = unique_label(S, rng, "events", events_with_people(S), two=0.5)
    return {"e": e, "kw": low(kw, S.W["names"])}


def pa_event(S, rng, sh):
    S.turn("asks who is coming to the %s" % sh["kw"], [sh["kw"], "who"], ["link.parties_of"])
    S.look('show (events called "%s")' % q(sh["kw"]))
    S.answer("(parties of (#%d)) that (party_id is not me)" % S.handle(sh["e"]["label"], "event"))


def pb_event(S, rng, sh):
    S.turn("asks when the %s is" % sh["kw"], [sh["kw"], "when"], ["route.schedule"])
    S.answer('(events called "%s")' % q(sh["kw"]))


pair(ps_event)((pa_event, pb_event))


# == what a first cell makes possible next (for the deficit weighting only) ======================

LISTY = ["follow.narrow", "handle.them", "handle.ordinal", "handle.far", "follow.back_to"]
ENABLES = {
    "c_trash": ["compose.undo"], "c_bulk_delete": ["compose.undo"],
    "c_log": ["compose.correction"], "c_reschedule": ["compose.correction"], "c_shift": ["compose.correction"],
    "c_mark": ["compose.correction"], "c_album_add": ["compose.correction"],
    "c_find_one": ["follow.except", "follow.switch_kind"], "c_when_event": ["follow.except", "follow.switch_kind",
                                                                            "follow.swap_subject"],
    "c_photo_link": ["follow.except"], "c_expense_group": ["follow.except"], "c_event_people": ["follow.except"] + LISTY,
    "c_kind_called": ["follow.switch_kind", "follow.swap_subject"] + LISTY, "c_everything": ["follow.switch_kind"] + LISTY,
    "c_ambiguous_write": ["handle.pick"], "c_trashed_check": ["write.restore"], "c_person_debts": ["write.settle",
                                                                                                  "follow.swap_subject"],
    "c_locker": ["write.reveal"], "c_person": ["link.of_person", "write.log_interaction", "follow.swap_subject"],
    "c_balance": ["follow.swap_subject"], "c_birthday": ["follow.swap_subject"], "c_owed_amount": ["follow.swap_subject"],
    "c_spend_window": ["follow.swap_subject"],
    "c_day": LISTY + ["follow.swap_subject"], "c_events_window": LISTY + ["follow.swap_subject"],
    "c_due": LISTY + ["follow.swap_subject"], "c_folder": LISTY + ["follow.swap_subject"],
    "c_notebook": LISTY + ["follow.swap_subject"], "c_open": LISTY, "c_flags": LISTY, "c_kw_open": LISTY,
    "c_photos_time": LISTY + ["write.album_add"], "c_journal": LISTY, "c_spend_on": LISTY, "c_group_link": LISTY,
    "c_person_events": LISTY, "c_owed": LISTY + ["num.sum"], "c_album_photos": LISTY + ["write.album_add"],
    "c_place_photos": LISTY + ["write.album_add"], "c_person_photos": LISTY + ["write.album_add"],
}
for _f in FIRST:
    _f.skills = list(_f.skills) + ENABLES.get(_f.__name__, [])


# == the driver ===================================================================================

def load_targets(scale):
    """skill -> generated-turn goal: the BASELINE.md row target / AUGMENT, times --scale"""
    rows = {}
    pat = re.compile(r"^\| `([a-z_]+\.[a-z_]+)` \| \w+ \| \d+ \| \d+ \| \d+ \| (\d+) \|$")
    for line in open(os.path.join(HERE, "BASELINE.md"), encoding="utf-8"):
        m = pat.match(line.strip())
        if m:
            rows[m.group(1)] = int(m.group(2))
    ids = [s["id"] for s in json.load(open(os.path.join(HERE, "skills.json")))["skills"]]
    missing = [s for s in ids if s not in rows]
    if missing:
        raise SystemExit("BASELINE.md has no target for %s" % missing)
    return {s: rows[s] / AUGMENT * scale for s in ids}, rows


class Alloc:
    """per-skill counts (train split) and the deficit weighting of cells"""

    def __init__(self, goals):
        self.goals = goals
        self.count = collections.Counter()
        self.worlds = collections.defaultdict(set)
        self.progress = 1.0
        self.world = None
        self.split = "train"

    def deficit(self, s):
        g = self.goals.get(s)
        if not g:
            return 0.0
        d = max(0.0, 1.0 - self.count[s] / max(1.0, g * self.progress))
        if len(self.worlds[s]) < 10 and self.world not in self.worlds[s] and self.split == "train":
            d = max(d, 0.6)
        return d

    def need(self, skills):
        return max([self.deficit(s) for s in skills] or [0.0])

    def weight(self, f):
        tot = sum(self.deficit(s) for s in f.skills)
        return math.sqrt(f.w) * (0.02 + tot ** 2)

    def short(self):
        return [s for s, g in self.goals.items() if self.count[s] < g]


ALLOC = None
SKIPPED = collections.Counter()
PLAYED = collections.Counter()
DROPS = collections.Counter()


def weighted(rng, table):
    ws = [ALLOC.weight(f) for f in table]
    return rng.choices(table, ws)[0]


def snapshot(S):
    return ([dict(t, steps=list(t["steps"]), say=list(t["say"]), skills=list(t["skills"])) for t in S.turns],
            list(S.last), S.last_full, list(S.rows), dict(S.ctx), dict(S.first_seen), S.prefix)


def restore(S, snap):
    S.turns, S.last, S.last_full, S.rows, S.ctx, S.first_seen, S.prefix = (
        snap[0], snap[1], snap[2], snap[3], snap[4], snap[5], snap[6])


PRIORITY = [(f_clash_resolve, "clash", 0.8), (f_restore_after, "trashed", 0.5), (f_undo, "wrote", 0.3),
            (f_correct, "wrote", 0.3), (f_balance_next, "balance_next", 0.4), (f_swap, "swap", 0.25)]
REPEATABLE = {"f_link", "f_ordinal_write", "f_pick_write", "f_swap", "f_narrow_window", "f_narrow_field"}


def try_cell(S, rng, table, tries):
    """play one cell from `table`; one that fails before opening its turn is skipped (another is
    drawn); one that fails inside its turn sinks the session"""
    for _ in range(tries):
        f = weighted(rng, table)
        if S.turns and S.turns[-1].get("cell") == f.__name__ and f.__name__ not in REPEATABLE:
            continue
        snap = snapshot(S)
        n_turns = len(S.turns)
        try:
            f(S, rng)
        except Fail as exc:
            if S.open_turn or len(S.turns) != n_turns:
                raise Fail("%s: %s" % (f.__name__, exc))
            SKIPPED[f.__name__] += 1
            restore(S, snap)
            continue
        if S.open_turn:
            raise Fail("%s left its turn open" % f.__name__)
        for t in S.turns[n_turns:]:
            t.setdefault("cell", f.__name__)
        PLAYED[f.__name__] += 1
        return True
    return False


def detour_and_back(S, rng):
    """'hang on -- <another question>', then 'back to <topic> -- <act on the earlier rows>'"""
    if not S.last or not S.turns or S.turns[-1]["t"] != "read":
        return False
    anchor = (list(S.last), S.last_full, dict(S.ctx))
    aset = S.ctx.get("set")
    if S.last_full and len(S.last) <= 6 and (not aset or rng.random() < 0.6):
        back = "(%s)" % hs(n for n, _, _ in S.last)
    elif aset:
        back = "(%s)" % aset
    else:
        return False
    topic = S.ctx.get("topic") or "that"
    S.prefix = "(detour) hang on — "
    S.ctx = {}
    ok = try_cell(S, rng, [f for f in FIRST if f.detour], 6)
    S.prefix = ""
    if not ok:
        S.last, S.last_full, S.ctx = anchor
        return False
    S.last, S.last_full, S.ctx = anchor[0], anchor[1], dict(anchor[2])
    S.ctx.pop("swap", None)
    S.back = back
    S.prefix = "back to %s — " % topic
    n = len(S.turns)
    ok = try_cell(S, rng, [f for f in FOLLOW if f not in (f_swap, f_except, f_undo, f_correct, f_never_mind,
                                                         f_restore_after, f_clash_resolve, f_balance_next)], 10)
    S.back = None
    S.prefix = ""
    if ok:
        for t in S.turns[n:]:
            t["skills"].append("follow.back_to")
            t["hint"] = t["hint"].replace("— follow-up: ", "— ")
    return True


def session(S, rng, L, first=True):
    if first and not try_cell(S, rng, FIRST, 4):
        raise Fail("first cell did not apply")
    stale = 0
    while len(S.turns) < L and stale < 4:
        r = rng.random()
        pri = [(f, p) for f, key, p in PRIORITY if S.ctx.get(key)]
        if pri:
            f, p = rng.choice(pri)
            if rng.random() < p and try_cell(S, rng, [f], 1):
                continue
        if r < 0.16 and L - len(S.turns) >= 2 and len(S.turns) >= 1:
            if detour_and_back(S, rng):
                continue
        if r < 0.86:
            if try_cell(S, rng, FOLLOW, 10):
                continue
        S.prefix = "(new topic) "
        S.ctx = {}
        ok = try_cell(S, rng, FIRST, 5)
        S.prefix = ""
        if not ok:
            stale += 1
    finalize(S)
    return S.record()


def play_pair(srv, W, rng):
    S1 = Session(srv, W, rng)
    for _ in range(5):
        setup = weighted_pair(rng)
        try:
            sh = setup(S1, rng)
            break
        except Fail:
            SKIPPED[setup.__name__] += 1
    else:
        raise Fail("no pair applies")
    recs = []
    for i, (f, S) in enumerate([(setup.a, S1), (setup.b, None)]):
        S = S or Session(srv, W, rng)
        f(S, rng, sh)
        if S.open_turn:
            raise Fail("pair turn open")
        S.turns[-1]["cell"] = f.__name__
        S.turns[-1]["pair"] = "ab"[i]
        S.ctx.setdefault("topic", "that")
        recs.append(session(S, rng, rng.choices(*LEN_MIX)[0], first=False))
    return recs, setup.__name__


def weighted_pair(rng):
    return rng.choice(PAIRS)


class Stats:
    def __init__(self):
        self.lengths = collections.Counter()
        self.turns = 0
        self.pair_turns = 0
        self.read_looks = collections.Counter()
        self.reads = 0
        self.misses = 0
        self.sessions = collections.Counter()


STATS = Stats()
NEXT_ID = collections.Counter()


def account(rec, world, split):
    for t in rec["turns"]:
        STATS.turns += 1
        if "pair" in t:
            STATS.pair_turns += 1
        calls = [st["call"] for st in t["steps"]]
        if t["t"] == "read":
            looks = len(calls) - 1
            STATS.read_looks[min(looks, 2)] += 1
            MIX.looks[min(looks, 2)] += 1
            MIX.reads += 1
            STATS.reads += 1
            if t.get("miss"):
                STATS.misses += 1
                MIX.misses += 1
        if split == "train":
            for s in t["skills"]:
                ALLOC.count[s] += 1
                ALLOC.worlds[s].add(world)
    STATS.lengths[len(rec["turns"])] += 1
    STATS.sessions[split] += 1


def clean(rec):
    """the record as written: steps are {call, obs}; the turn keeps a few flags for the report"""
    for t in rec["turns"]:
        t["steps"] = [{"call": st["call"], "obs": st["obs"]} for st in t["steps"]]
        t["kind"] = t.pop("t")
        if t.get("miss"):
            t["recovery"] = t.pop("miss")
    return rec


def world_info(path):
    spec = json.load(open(path, encoding="utf-8"))
    meta = spec["meta"]
    names, titles = set(), set()
    for p in meta.get("people", []):
        names |= {(p.get(k) or "").lower() for k in ("first", "last")} - {""}
        names |= {w.lower() for w in (p.get("name") or "").split() if w[:1].isupper()}
    v = meta.get("vocab", {})
    for key in ("place_words", "destinations", "trip_place_words", "brands", "firsts", "lasts"):
        names |= {x.lower() for x in v.get(key, [])}
    for key in ("places", "trip_places", "albums"):
        for x in meta.get(key, []):
            titles.add(x.lower())
    for g in meta.get("groups", []):
        titles.add(g["name"].lower())
    for t in meta.get("trips", []):
        titles.add(t["title"].lower())
    for w in list(names):
        if w in ("may", "june", "april", "the"):
            names.discard(w)
    return {"meta": meta, "names": names, "titles": titles, "currency": meta.get("currency", "USD")}


def gen_world(path, n_sessions, rng, out, split, pair_ok=True):
    wname = os.path.basename(path)[:-5]
    ALLOC.world, ALLOC.split = wname, split
    W = world_info(path)
    srv = Server(path)
    W["probe"] = Server(path)
    made, tries, npair = 0, 0, 0
    try:
        while made < n_sessions and tries < n_sessions * 6:
            tries += 1
            try:
                if pair_ok and PAIRS and STATS.pair_turns < PAIR_RATE * max(1, STATS.turns) and rng.random() < 0.9:
                    recs, pname = play_pair(srv, W, rng)
                    pid = "%s-p%03d" % (wname, NEXT_ID[wname + "/pair"])
                    NEXT_ID[wname + "/pair"] += 1
                    npair += 1
                    for rec in recs:
                        rec["turns"][0]["pair"] = "%s/%s" % (pid, rec["turns"][0]["pair"])
                else:
                    S = Session(srv, W, rng)
                    L = rng.choices(*LEN_MIX)[0]
                    recs = [session(S, rng, L)]
            except Fail as exc:
                if os.environ.get("TRAJGEN_DEBUG"):
                    print("DROP", wname, exc, file=sys.stderr)
                key = re.sub(r"#\d+|\d+", "N", str(exc))
                key = re.sub(r'"[^"]*"', '"…"', key)[:70]
                DROPS[key] += 1
                continue
            for rec in recs:
                NEXT_ID[wname] += 1
                rec["id"] = "%s-%04d" % (wname, NEXT_ID[wname])
                rec["world"] = wname
                rec["split"] = split
                account(rec, wname, split)
                out.write(json.dumps(clean(rec), ensure_ascii=False) + "\n")
                made += 1
    finally:
        srv.close()
        W["probe"].close()
    return made


def coverage_table(goals, rows):
    print("\n%-24s %6s %6s %8s %6s" % ("skill", "turns", "worlds", "goal", ""))
    short = 0
    for s in goals:
        c, w, g = ALLOC.count[s], len(ALLOC.worlds[s]), goals[s]
        ok = c >= g and w >= 10
        short += not ok
        print("%-24s %6d %6d %8.0f %6s" % (s, c, w, g, "OK" if ok else "SHORT"))
    print("%d/%d skills short" % (short, len(goals)))


def main():
    global ALLOC
    ap = argparse.ArgumentParser()
    ap.add_argument("--worlds", default=os.path.join(HERE, "worlds"))
    ap.add_argument("--out", default=os.path.join(HERE, "traj.jsonl"))
    ap.add_argument("--seed", type=int, default=8008)
    ap.add_argument("--scale", type=float, default=1.0, help="multiply every skill goal")
    ap.add_argument("--only-world", default="", help="comma list of worlds (wNN) to play")
    ap.add_argument("--per-world", type=int, default=0, help="sessions per training world (default: sized to the goals)")
    ap.add_argument("--topup", type=int, default=12, help="passes over the training worlds for skills still short")
    ap.add_argument("--cell", default="", help="debug: play only this first cell (comma list), one-turn sessions")
    a = ap.parse_args()
    if a.cell:
        keep = set(a.cell.split(","))
        FIRST[:] = [f for f in FIRST if f.__name__ in keep]
        FOLLOW[:] = [f for f in FOLLOW if f.__name__ in keep] or FOLLOW
        PAIRS[:] = [f for f in PAIRS if f.__name__ in keep]
        LEN_MIX[1][:] = [1, 1, 0, 0, 0, 0] if FOLLOW and any(f.__name__ in keep for f in FOLLOW) else [1, 0, 0, 0, 0, 0]
    rng = random.Random(a.seed)
    goals, rows = load_targets(a.scale)
    ALLOC = Alloc(goals)
    worlds = sorted(f[:-5] for f in os.listdir(a.worlds) if re.match(r"^w\d+\.json$", f))
    if a.only_world:
        keep = set(a.only_world.split(","))
        worlds = [w for w in worlds if w in keep]
    train = [w for w in worlds if w not in VAL_WORLDS]
    val = [w for w in worlds if w in VAL_WORLDS]
    # ~3 skills a turn, ~2.7 turns a session
    per = a.per_world or max(4, math.ceil(sum(goals.values()) / 14.0 / max(1, len(train))))
    print("sessions per training world: %d (%d train worlds, %d val)" % (per, len(train), len(val)), flush=True)
    with open(a.out, "w", encoding="utf-8") as out:
        for i, w in enumerate(train):
            ALLOC.progress = (i + 1) / len(train)
            made = gen_world(os.path.join(a.worlds, w + ".json"), per, rng, out, "train")
            print("%s: %d sessions (%d skills short)" % (w, made, len(ALLOC.short())), flush=True)
        ALLOC.progress = 1.0
        for p in range(a.topup):
            short = ALLOC.short()
            if not short or not train:
                break
            extra_ = min(12, max(2, math.ceil(sum(max(0, goals[s] - ALLOC.count[s]) for s in short) / 4.0 / len(train))))
            print("top-up %d: %d skills short, %d more sessions per world" % (p + 1, len(short), extra_), flush=True)
            saved = {f: f.w for f in FIRST + FOLLOW}
            for f in FIRST + FOLLOW:
                if not set(f.skills) & set(short):
                    f.w = saved[f] * 0.15
            for w in train:
                gen_world(os.path.join(a.worlds, w + ".json"), extra_, rng, out, "train")
            for f, wt in saved.items():
                f.w = wt
        n_train = STATS.sessions["train"]
        for w in val:
            made = gen_world(os.path.join(a.worlds, w + ".json"), max(2, round(n_train / 9.0 / max(1, len(val)))), rng,
                             out, "val")
            print("%s: %d sessions (val)" % (w, made), flush=True)
    tot = sum(STATS.sessions.values())
    print("\nsessions: %d (train %d, val %d), turns %d" % (tot, STATS.sessions["train"], STATS.sessions["val"], STATS.turns))
    ls = STATS.lengths
    n = max(1, sum(ls.values()))
    print("session length: 1 %.0f%% · 2-3 %.0f%% · 4-6 %.0f%%" % (100 * ls[1] / n, 100 * (ls[2] + ls[3]) / n,
                                                               100 * sum(ls[k] for k in ls if k >= 4) / n))
    r = max(1, STATS.reads)
    print("read turns %d: look 0 %.0f%% · 1 %.0f%% · 2+ %.0f%% · recovery %.0f%%" % (
        STATS.reads, 100 * STATS.read_looks[0] / r, 100 * STATS.read_looks[1] / r, 100 * STATS.read_looks[2] / r,
        100 * STATS.misses / r))
    print("minimal-pair turns: %.0f%%" % (100 * STATS.pair_turns / max(1, STATS.turns)))
    print("\ndrop reasons:")
    for k, v in DROPS.most_common(25):
        print("  %5d  %s" % (v, k))
    print("\ncells played (skipped as not applying):")
    for f in FIRST + FOLLOW:
        print("  %-22s %5d (%d)" % (f.__name__, PLAYED[f.__name__], SKIPPED[f.__name__]))
    coverage_table(goals, rows)


if __name__ == "__main__":
    main()
