#!/usr/bin/env python3
"""v4 session sampler: session-shaped canonical sequences (SPEC.md).

Each session is built from THREADS (a first turn plus follow-ups that are
GRAMMAR.md §3 moves, refs used per §3/§5: C2, C10, C12, C13, C14, R-X2), with
optional topic switches and backtracks and `new` turns drawn from the v3
typed walker (v3/gen.py `Gen.scenario`).  Every write is checked with
v3/gen.py `validate` (gbnf + check.parse + the arms typing), extended in
memory only by `social.send_message{body}` (egress, the executor declines it)
and `since` on people.log_interaction (SPEC §4 H).

    python3 sessgen.py   # writes canon_sessions.jsonl
No evaluation file is opened by this script or anything it imports.
"""
import collections, datetime, json, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "v3"))
import gen as G  # noqa: E402
import pools as P  # noqa: E402
import check  # noqa: E402

# -- in-memory arms extension (SPEC §4 H; egress verb) ----------------------
G.ARMS["people.log_interaction"] = sorted(set(G.ARMS["people.log_interaction"]) | {"since"})
G.ARMS["social.send_message"] = ["body"]
G.CMDS["social.send_message"] = ("contact channels", [("body",)])
G.REQUIRED["social.send_message"] = {"body"}
G.REQUIRED["people.log_interaction"] = {"since"}

WD = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
DAY0, DAY1 = datetime.date(2025, 3, 1), datetime.date(2028, 11, 30)


def ordn(n):
    return "%d%s" % (n, "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th"))


def q(x):
    return '"%s"' % x.replace('"', "'")


def cap(s):
    return s[:1].upper() + s[1:]


class T:
    """one assistant turn"""
    def __init__(self, canon, move, tags=(), kind=None, note=""):
        self.canon, self.move, self.tags, self.kind, self.note = canon, move, list(tags), kind, note


STOP = {"the", "a", "an", "my", "for", "of", "to", "at", "on", "in", "and", "with", "from", "by"}


def span(title, rng):
    """the distinctive words a user would say for a stored title"""
    ws = [w for w in re.findall(r"[A-Za-z0-9']+", title) if "'" not in w]
    content = [i for i, w in enumerate(ws) if w.lower() not in STOP and len(w) > 2]
    if not content:
        return title
    i = rng.choice(content)
    n = rng.choice([1, 1, 2])
    out = ws[i:i + n]
    if len(out) == 2 and out[1].lower() in STOP:
        out = out[:1]
    s = " ".join(out)
    return s if s[:1].isupper() and i > 0 else s.lower()


class W:
    """one session's literal world"""
    def __init__(self, rng, today):
        self.r, self.today = rng, today
        self.used = set()

    def pick(self, pool):
        for _ in range(20):
            x = self.r.choice(pool)
            if x not in self.used:
                self.used.add(x)
                return x
        return self.r.choice(pool)

    def person(self, full=None):
        f = self.pick(P.FIRST)
        if full is None:
            full = self.r.random() < 0.25
        return f + " " + self.r.choice(P.LAST) if full else f

    def title(self, pool):
        return span(self.pick(pool), self.r)

    # -- relative days (SPEC §1) -------------------------------------------
    def relday(self, window=False, allow_today=True):
        r = self.r.random()
        if r < 0.40:
            return self.r.choice(WD)
        if r < 0.55:
            return "next " + self.r.choice(WD)
        if r < 0.62 and not window:
            return "tomorrow" if self.r.random() < 0.8 or not allow_today else "today"
        if r < 0.80:
            return "the " + ordn(self.r.randint(1, 28))
        if r < 0.88:
            return "in %d days" % self.r.randint(2, 10)
        if window:
            return self.r.choice(["tomorrow", "today", "this weekend", "next week", "this week"])
        return self.r.choice(WD)

    def time(self):
        h = self.r.choice([8, 9, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
        m = self.r.choice([0, 0, 0, 30, 30, 15, 45])
        return "%02d:%02d" % (h, m)

    def iso(self, time=None):
        d = self.today + datetime.timedelta(days=self.r.randint(12, 120))
        return d.isoformat() + ("T" + time if time else "")

    def date_arg(self, time=False, iso_p=0.08):
        """-> (dt, end) : end is dt + 1h when a time is given"""
        t = self.time() if time else None
        if self.r.random() < iso_p:
            d = self.iso(t)
            if t:
                hh = int(t[:2]) + 1
                return d, d[:11] + "%02d:%s" % (hh, t[3:])
            return d, None
        rd = self.relday()
        if t:
            hh = int(t[:2]) + 1
            return "%s at %s" % (rd, t), "%s at %02d:%s" % (rd, hh, t[3:])
        return rd, None

    def window(self):
        r = self.r.random()
        if r < 0.5:
            return self.relday(window=True)
        return self.r.choice(["today", "tomorrow", "this weekend", "this week", "next week", "tomorrow"])

    def amount(self):
        v = self.r.choice([500, 800, 1200, 1250, 1500, 1800, 2000, 2400, 2500, 3000, 3500, 4200, 4500,
                           5000, 6000, 6750, 7500, 8000, 9900, 12000, 15000, 25000, 1999, 350, 950])
        return v


REFUSE = [
    "what the weather will be like in {place} on the weekend", "book a table at {place} for friday",
    "order a taxi to {place}", "buy train tickets to {place}", "look up the opening hours of {place} online",
    "find a plumber near {place} on the web", "check the football score", "play some music",
    "translate a paragraph into French", "post the photo to Instagram", "order more printer ink from a shop",
    "tell them tomorrow's forecast", "book a flight to {place}", "look up the news", "call an Uber",
    "check the price of petrol near {place}", "search the web for a lasagne recipe",
    "reserve tickets for the cinema at {place}", "check whether the trains to {place} are running",
    "pay their electricity bill through the supplier's website",
]


class Threads:
    def __init__(self, w):
        self.w, self.r = w, w.r

    # ===== tasks ==========================================================
    def overdue(self):
        w, r = self.w, self.r
        c = 'show (tasks that (due_at during before now and status != "completed") ordered by due_at asc)'
        if r.random() < 0.25:
            c = 'show (tasks that (due_at during before now and status != "completed"))'
        ts = [T(c, "first", ["overdue"], "tasks", "overdue (past due, not done) tasks")]
        f = r.random()
        if f < 0.25:
            ts.append(T('count of (them)', "act", ["value"], "tasks", "how many of them"))
            ts.append(T('reschedule{ to: %s } on (them)' % w.relday(), "act", ["act_held", "rx2", "reschedule"], "tasks",
                        "after the count, move all of them (R-X2: still those tasks)"))
        elif f < 0.55:
            n = r.choice([1, 2, 3])
            ts.append(T('schedule.set_task_status{ status: "completed" } on (the %s one)' % ordn(n), "act",
                        ["act_held", "mark_done"], "tasks", "mark the %s one done" % ordn(n)))
            ts.append(T('reschedule{ to: %s } on (the %s one)' % (w.relday(), ordn(n % 3 + 1)), "act",
                        ["act_held", "reschedule"], "tasks", "move another one by position"))
        elif f < 0.8:
            ts.append(T('schedule.delete_task{} on (the %s one)' % ordn(r.choice([1, 2])), "act", ["act_held", "delete_kind"],
                        "tasks", "delete one of them by position"))
            ts.append(T('schedule.restore_task{} on (it)', "act", ["act_held", "restore"], "tasks",
                        "oops, bring it back (C2: one row deleted -> it)"))
        else:
            ts.append(T('show (them that (due_at during last week))', "refine", ["refine"], "tasks",
                        "just the ones that were due last week"))
        return ts

    def open_tasks(self):
        w, r = self.w, self.r
        win = w.window()
        o = r.random()
        if o < 0.45:
            c = 'show (tasks that (status != "completed" and due_at during %s) ordered by due_at asc)' % win
            note = "what's due %s (open tasks)" % win
        elif o < 0.7:
            c = 'show (tasks that (status != "completed") ordered by due_at asc)'
            note = "what's left on the to-do list / open tasks"
            win = None
        else:
            c = 'show (tasks that (status != "completed" and due_at during %s))' % win
            note = "which tasks are still due %s" % win
        ts = [T(c, "first", ["open_tasks"], "tasks", note)]
        f = r.random()
        if f < 0.3 and win:
            w2 = w.window()
            if w2 != win:
                ts.append(T(c.replace("during %s)" % win, "during %s)" % w2), "substitute", ["substitute", "open_tasks"],
                            "tasks", "and %s? (same question, other window)" % w2))
        elif f < 0.55:
            ts.append(T('schedule.set_task_status{ status: "completed" } on (the %s one)' % ordn(r.choice([1, 2])), "act",
                        ["act_held", "mark_done"], "tasks", "tick one off by position"))
            ts.append(T('reschedule{ to: %s } on (the %s one)' % (w.relday(), ordn(3)), "act", ["act_held", "reschedule"], "tasks",
                        "push another to a day"))
        elif f < 0.75:
            ts.append(T('show (tasks that (due_at is null and status != "completed"))', "new", ["no_deadline"], "tasks",
                        "which open ones have no deadline"))
            ts.append(T('schedule.set_task_status{ status: "completed" } on (the %s one)' % ordn(1), "act", ["act_held", "mark_done"],
                        "tasks", "mark the first done"))
        else:
            ts.append(T('count of (them)', "act", ["value"], "tasks", "how many is that"))
        return ts

    def done_tasks(self):
        w, r = self.w, self.r
        win = r.choice(["this week", "last week", "today", "yesterday", "last weekend", "this month", "last month"])
        ts = [T('show (tasks that (status = "completed" and completed_at during %s))' % win, "first", ["ticked"], "tasks",
                "tasks ticked off / done %s" % win)]
        if r.random() < 0.5:
            ts.append(T('count of (them)', "act", ["value"], "tasks", "how many"))
        if r.random() < 0.4:
            w2 = r.choice(["last week", "this week", "last month"])
            if w2 != win:
                ts.append(T('show (tasks that (status = "completed" and completed_at during %s))' % w2, "substitute",
                            ["substitute", "ticked"], "tasks", "and %s?" % w2))
        return ts

    def no_deadline(self):
        ts = [T('show (tasks that (due_at is null and status != "completed"))', "first", ["no_deadline"], "tasks",
                "open tasks with no due date")]
        if self.r.random() < 0.6:
            ts.append(T('reschedule{ to: %s } on (the %s one)' % (self.w.relday(), ordn(self.r.choice([1, 2]))), "act",
                        ["act_held", "reschedule"], "tasks", "give one a date"))
        return ts

    def add_task(self):
        w, r = self.w, self.r
        t = cap(w.pick(P.TASKS))
        if r.random() < 0.7:
            d, _ = w.date_arg(time=r.random() < 0.25)
            c = 'schedule.add_task{ title: %s, due_at: %s }' % (q(t), d)
        else:
            c = 'schedule.add_task{ title: %s }' % q(t)
        ts = [T(c, "first", ["create"], "tasks", "add a task")]
        f = r.random()
        if f < 0.35:
            ts.append(T('reschedule{ to: %s } on (it)' % w.relday(), "act", ["act_held", "reschedule"], "tasks",
                        "actually make it another day (C2 it = the task just added)"))
        elif f < 0.55:
            ts.append(T('reschedule{ to: %s } on (the last thing I added)' % w.relday(), "act", ["act_held", "reschedule"], "tasks",
                        "move the thing I just added"))
        elif f < 0.7:
            ts.append(T('schedule.delete_task{} on (it)', "act", ["act_held", "delete_kind"], "tasks", "scrap that, delete it"))
        return ts

    # ===== calendar ========================================================
    def whats_on(self):
        w, r = self.w, self.r
        win = w.window()
        ts = [T('show (things during %s)' % win, "first", ["whats_on"], "things", "what's on %s" % win)]
        f = r.random()
        if f < 0.4:
            w2 = w.window()
            if w2 != win:
                ts.append(T('show (things during %s)' % w2, "substitute", ["substitute", "whats_on"], "things",
                            "and %s?" % w2))
        elif f < 0.7:
            e = w.title(P.EVENTS)
            d, _ = w.date_arg(time=r.random() < 0.5)
            ts.append(T('reschedule{ to: %s } on (events called %s)' % (d, q(e)), "act", ["reschedule"], "events",
                        "move the %s one (named) to another day" % e))
        else:
            ts.append(T('count of (them)', "act", ["value"], "things", "how many things is that"))
        return ts

    def when_is(self):
        w, r = self.w, self.r
        e = w.title(P.EVENTS)
        if r.random() < 0.6:
            c = 'dtstart of (events called %s)' % q(e)
        else:
            c = 'show (events called %s)' % q(e)
        ts = [T(c, "first", ["when_is"], "events", "when is my %s" % e)]
        f = r.random()
        if f < 0.3:
            ts.append(T('reschedule{ by: +1h } on (it)', "act", ["act_held", "hour_later", "rx2" if c.startswith("dt") else "act_held"],
                        "events", "push it an hour later"))
        elif f < 0.55:
            d, _ = w.date_arg(time=r.random() < 0.6)
            ts.append(T('reschedule{ to: %s } on (it)' % d, "act", ["act_held", "reschedule"], "events", "move it to another day"))
        elif f < 0.7:
            ts.append(T('schedule.cancel_event{} on (it)', "act", ["act_held"], "events", "cancel it"))
        elif f < 0.9:
            e2 = w.title(P.EVENTS)
            ts.append(T(c.replace(q(e), q(e2)), "substitute", ["substitute", "when_is"], "events", "and the %s?" % e2))
        return ts

    def propose(self):
        w, r = self.w, self.r
        s = cap(w.pick(P.EVENTS))
        if r.random() < 0.35:
            s = "%s with %s" % (r.choice(["Coffee", "Lunch", "Dinner", "Call", "Walk"]), w.person())
        d, end = w.date_arg(time=True)
        ts = [T('schedule.propose_event{ summary: %s, dtstart: %s, dtend: %s }' % (q(s), d, end), "first", ["create"], "events",
                "put an event in the diary (no end said -> one hour)")]
        f = r.random()
        if f < 0.35:
            ts.append(T('reschedule{ by: +1h } on (it)', "act", ["act_held", "hour_later"], "events", "make it an hour later"))
        elif f < 0.55:
            ts.append(T('reschedule{ to: %s } on (it)' % w.date_arg(time=True)[0], "act", ["act_held", "reschedule"], "events",
                        "move it"))
        return ts

    def move_named(self):
        w, r = self.w, self.r
        if r.random() < 0.55:
            k, t = "events", w.title(P.EVENTS)
        else:
            k, t = "tasks", w.title(P.TASKS)
        if r.random() < 0.25 and k == "events":
            c = 'reschedule{ by: +1h } on (events called %s)' % q(t)
            tg = ["hour_later"]
        else:
            d, _ = w.date_arg(time=r.random() < 0.4)
            c = 'reschedule{ to: %s } on (%s called %s)' % (d, k, q(t))
            tg = ["reschedule"]
        ts = [T(c, "first", tg, k, "push/move the named %s" % k[:-1])]
        if r.random() < 0.3:
            ts.append(T('nothing', "undo", ["undo"], k, "actually never mind / leave it"))
        return ts

    # ===== people ==========================================================
    def birthday(self):
        w, r = self.w, self.r
        p = w.person()
        c = 'show (important dates of (parties called %s) that (label contains "Birthday"))' % q(p)
        ts = [T(c, "first", ["birthday"], "important dates", "when is %s's birthday" % p)]
        f = r.random()
        if f < 0.45:
            p2 = w.person()
            ts.append(T(c.replace(q(p), q(p2)), "substitute", ["and_name", "birthday"], "important dates", "and %s?" % p2))
        elif f < 0.75:
            d, _ = w.date_arg()
            ts.append(T('schedule.add_task{ title: %s, due_at: %s }' % (q("Buy a present for " + p.split()[0]), d), "new",
                        ["create", "c14"], "tasks", "add a task to buy her/him a present (title uses the name the user says)"))
        return ts

    def contact(self):
        w, r = self.w, self.r
        p = w.person()
        kd = r.choice(["phone", "phone", "email"])
        c = 'show (contact channels of (parties called %s) that (kind = "%s"))' % (q(p), kd)
        ts = [T(c, "first", ["contact"], "contact channels", "what's %s's %s" % (p, "number" if kd == "phone" else "email"))]
        f = r.random()
        if f < 0.35:
            p2 = w.person()
            ts.append(T(c.replace(q(p), q(p2)), "substitute", ["and_name", "contact"], "contact channels", "and %s's?" % p2))
        elif f < 0.6 and kd == "phone":
            b = r.choice(["Running ten minutes late", "Are we still on for tonight", "Happy birthday", "Call me when you can",
                          "Thanks for dinner", "I've left the keys under the mat", "Can you grab milk on the way",
                          "See you at the station", "The parcel arrived", "Don't forget the tickets"])
            ts.append(T('social.send_message{ body: %s } on (it)' % q(b), "act", ["act_held", "message"], "contact channels",
                        "text them: %s" % b))
        elif f < 0.85:
            ts.append(T('people.log_interaction{ kind: "call", since: today } on (parties called %s)' % q(p), "act",
                        ["c14", "log"], "parties", "log that I called him/her today (pronoun -> the name, C14)"))
        return ts

    def message(self):
        w, r = self.w, self.r
        p = w.person()
        b = r.choice(["On my way", "Dinner is at eight", "Can we move to thursday", "Got the tickets",
                      "Happy anniversary", "Remember to bring the charger", "The plumber is coming at nine",
                      "Meet you outside", "Good luck today", "Is the spare room free next weekend"])
        c = 'social.send_message{ body: %s } on (contact channels of (parties called %s) that (kind = "phone"))' % (q(b), q(p))
        ts = [T(c, "first", ["message"], "contact channels", "text %s: %s" % (p, b))]
        if r.random() < 0.4:
            p2 = w.person()
            ts.append(T(c.replace(q(p), q(p2)), "substitute", ["and_name", "message"], "contact channels", "and send the same to %s" % p2))
        return ts

    def role(self):
        w, r = self.w, self.r
        if r.random() < 0.3:
            p = w.person(full=False)
            c = 'show (parties called %s that (role contains "colleague"))' % q(p)
            ts = [T(c, "first", ["colleague"], "parties", "the %s I used to work with" % p)]
        else:
            ro = w.pick(["Dentist", "Plumber", "Landlord", "Accountant", "Piano teacher", "Electrician", "Physio",
                         "Mechanic", "Vet", "Childminder", "Hairdresser", "Solicitor", "Builder", "Gardener", "Optician",
                         "Tutor", "Personal trainer", "Doctor", "Estate agent", "Window cleaner"])
            c = 'show (parties that (role = %s))' % q(ro)
            ts = [T(c, "first", ["role"], "parties", "who's my %s" % ro.lower())]
        f = r.random()
        if f < 0.4:
            ts.append(T('show (contact channels of (it) that (kind = "phone"))', "act", ["act_held", "contact"], "contact channels",
                        "what's their number"))
            if r.random() < 0.5:
                ts.append(T('social.send_message{ body: %s } on (it)' % q(r.choice(["Are you free next week", "Can you call me back",
                                                                                    "Thanks again"])),
                            "act", ["act_held", "message"], "contact channels", "text them that"))
        elif f < 0.65:
            ts.append(T('show (first 1 of (activities of (it) ordered by started_at desc))', "act", ["act_held", "last_contact"],
                        "activities", "when did I last speak to them"))
        return ts

    def last_contact(self):
        w, r = self.w, self.r
        p = w.person()
        c = 'show (first 1 of (activities of (parties called %s) ordered by started_at desc))' % q(p)
        ts = [T(c, "first", ["last_contact"], "activities", "when did I last see/speak to %s" % p)]
        f = r.random()
        if f < 0.4:
            p2 = w.person()
            ts.append(T(c.replace(q(p), q(p2)), "substitute", ["and_name", "last_contact"], "activities", "and %s?" % p2))
            p = p2
        if r.random() < 0.5:
            k = r.choice(["call", "coffee", "visit", "message"])
            s = r.choice(["today", "today", "yesterday", "last " + r.choice(WD)])
            ts.append(T('people.log_interaction{ kind: "%s", since: %s } on (parties called %s)' % (k, s, q(p)), "act",
                        ["c14", "log"], "parties", "log a %s with him/her (%s) - pronoun resolved to the name (C14)" % (k, s)))
        return ts

    def log(self):
        w, r = self.w, self.r
        p = w.person()
        k = r.choice(["call", "coffee", "visit", "message"])
        s = r.choice(["today", "yesterday", "last " + r.choice(WD), "today"])
        return [T('people.log_interaction{ kind: "%s", since: %s } on (parties called %s)' % (k, s, q(p)), "first", ["log"],
                  "parties", "log a %s with %s (%s)" % (k, p, s))]

    def journal(self):
        ts = [T('show (first 1 of (journal notes ordered by created_at desc))', "first", ["last_journal"], "journal notes",
                "my last journal entry")]
        if self.r.random() < 0.3:
            ts.append(T('knowledge.delete_note{} on (it)', "act", ["act_held", "delete_kind"], "journal notes", "delete it"))
        return ts

    def same(self):
        w = self.w
        p = w.person(full=False)
        g = w.title(P.GROUPS)
        return [T('show (members of (groups called %s))' % q(g), "first", [], "members", "who's in the %s group" % g),
                T('same? (members called %s) (parties called %s)' % (q(p), q(p + " " + w.r.choice(P.LAST))), "new",
                  ["same"], "members", "is that %s the same %s as in my contacts (full name said)" % (p, p))]

    # ===== money ===========================================================
    def owes(self):
        w, r = self.w, self.r
        d = r.choice(["owed_to_me", "owed_to_them"])
        ts = [T('show (parties that (%s is not null))' % d, "first", ["owes_me" if d == "owed_to_me" else "i_owe"], "parties",
                "who owes me money" if d == "owed_to_me" else "who do I owe money to")]
        f = r.random()
        if f < 0.5:
            ts.append(T('sum %s of (them)' % d, "act", ["value"], "parties", "how much in total"))
            if d == "owed_to_them" and r.random() < 0.7:
                ts.append(T('people.settle_debt{} on (obligations of (them) that (settled_at is null))', "act",
                            ["act_held", "rx2", "settle"], "obligations", "pay it all off (R-X2: them = those people)"))
        elif f < 0.75:
            ts.append(T('show (obligations of (the %s one) that (settled_at is null))' % ordn(1), "act", ["act_held"], "obligations",
                        "what's outstanding with the first one"))
        return ts

    def owe_x(self):
        w, r = self.w, self.r
        p = w.person()
        s = 'obligations of (parties called %s) that (settled_at is null)' % q(p)
        if r.random() < 0.5:
            ts = [T('show (%s)' % s, "first", ["owe_x"], "obligations", "do I owe %s anything / does %s owe me" % (p, p))]
            if r.random() < 0.7:
                ts.append(T('sum amount_minor of (them)', "act", ["value", "owe_x_sum"], "obligations", "how much?"))
            if r.random() < 0.6:
                ts.append(T('people.settle_debt{} on (them)', "act", ["act_held", "settle", "rx2"], "obligations",
                            "pay it off (R-X2 when after the how-much)"))
        else:
            ts = [T('sum amount_minor of (%s)' % s, "first", ["owe_x_sum"], "obligations", "how much do I owe %s" % p)]
            if r.random() < 0.4:
                p2 = w.person()
                ts.append(T(ts[0].canon.replace(q(p), q(p2)), "substitute", ["and_name", "value_sub", "owe_x_sum"], "obligations",
                            "and %s? (after a Value)" % p2))
            elif r.random() < 0.6:
                ts.append(T('people.settle_debt{} on (it)', "act", ["act_held", "settle", "rx2"], "obligations",
                            "settle it (R-X2: the rows the sum folded)"))
        return ts

    def settle(self):
        p = self.w.person()
        return [T('people.settle_debt{} on (obligations of (parties called %s) that (settled_at is null))' % q(p), "first",
                  ["settle"], "obligations", "pay off / settle what I owe %s" % p)]

    def balance(self):
        w, r = self.w, self.r
        p, g = w.person(full=False), w.title(P.GROUPS)
        c = 'balance of (members called %s) in (groups called %s)' % (q(p), q(g))
        ts = [T(c, "first", ["group_balance"], "members", "what does %s owe me for %s" % (p, g))]
        f = r.random()
        if f < 0.5:
            p2 = w.person(full=False)
            ts.append(T(c.replace(q(p), q(p2)), "substitute", ["and_name", "value_sub", "group_balance"], "members", "and %s?" % p2))
            if r.random() < 0.4:
                ts.append(T('people.log_interaction{ kind: "message", since: today } on (parties called %s)' % q(p2), "act",
                            ["c14", "log"], "parties", "log that I messaged him/her about it today (C14 name)"))
        elif f < 0.75:
            ts.append(T('show (expenses of (groups called %s))' % q(g), "new", ["trip_spend"], "expenses",
                        "show me the %s expenses" % g))
        return ts

    def trip(self):
        w, r = self.w, self.r
        g = w.title(P.GROUPS)
        if r.random() < 0.5:
            c = 'sum amount_minor of (expenses of (groups called %s))' % q(g)
            note = "how much did we spend on the %s" % g
        else:
            c = 'show (expenses of (groups called %s))' % q(g)
            note = "what did we spend on the %s" % g
        ts = [T(c, "first", ["trip_spend"], "expenses", note)]
        f = r.random()
        if f < 0.35:
            g2 = w.title(P.GROUPS)
            ts.append(T(c.replace(q(g), q(g2)), "substitute", ["substitute", "trip_spend"], "expenses", "and the %s?" % g2))
        elif f < 0.6 and c.startswith("show"):
            ts.append(T('show (them that (amount_minor > %d))' % r.choice([2000, 5000, 10000]), "refine", ["refine"], "expenses",
                        "just the ones over some amount"))
            ts.append(T('sum amount_minor of (them)', "act", ["value"], "expenses", "total of those"))
        elif f < 0.8:
            ts.append(T('show (them)', "act", ["rx2", "value_follow"], "expenses", "show me them / list those")
                      if c.startswith("sum") else T('count of (them)', "act", ["value"], "expenses", "how many"))
        return ts

    def month_spend(self):
        w, r = self.w, self.r
        win = r.choice(["last month", "this month", "last week", "this week", "last weekend"])
        c = 'sum amount_minor of (expenses that (spent_on during %s))' % win
        tg = ["month_spend"] + (["weekend_past"] if win == "last weekend" else [])
        if r.random() < 0.3:
            c = 'show (expenses that (spent_on during %s))' % win
        ts = [T(c, "first", tg, "expenses", "what did I spend %s" % win)]
        f = r.random()
        if f < 0.4:
            w2 = r.choice([x for x in ["last month", "this month", "last week"] if x != win])
            ts.append(T(c.replace("during %s" % win, "during %s" % w2), "substitute", ["substitute", "month_spend"], "expenses",
                        "and %s?" % w2))
        elif f < 0.7 and c.startswith("sum"):
            ts.append(T('show (them)', "act", ["rx2", "value_follow"], "expenses", "which ones (C11: the rows the sum folded)"))
            ts.append(T('tally.delete_expense{} on (the %s one)' % ordn(r.choice([1, 2])), "act", ["act_held", "delete_kind"],
                        "expenses", "delete one by position"))
        return ts

    def add_expense(self):
        w, r = self.w, self.r
        d = cap(w.pick(P.EXPENSES))
        a = w.amount()
        if r.random() < 0.5:
            g = w.title(P.GROUPS)
            c = 'tally.add_expense{ amount_minor: %d, description: %s, group_id: (groups called %s), paid_by: me }' % (a, q(d), q(g))
        else:
            c = 'tally.add_expense{ amount_minor: %d, description: %s }' % (a, q(d))
        ts = [T(c, "first", ["create", "amount"], "expenses", "log an expense of %s" % money(a))]
        if r.random() < 0.3:
            ts.append(T('tally.delete_expense{} on (it)', "act", ["act_held", "delete_kind"], "expenses", "actually delete that"))
        return ts

    # ===== docs / notes / photos ===========================================
    def folder(self):
        w, r = self.w, self.r
        f = w.pick(["Travel", "Taxes", "House", "Car", "Medical", "Work", "Insurance", "Kids", "Pets", "Receipts",
                    "Garden", "Finance", "School", "Warranty"])
        o = r.random()
        if o < 0.45:
            c, tg, k = 'show (documents that (folder = %s))' % q(f), ["folder"], "documents"
        elif o < 0.7:
            c, tg, k = 'show (notes that (notebooks contains %s))' % q(f), ["notebook"], "notes"
        else:
            c, tg, k = 'show (things that (folder = %s or notebooks contains %s))' % (q(f), q(f)), ["filed_under"], "things"
        ts = [T(c, "first", tg, k, "what's in my %s folder/notebook" % f)]
        x = r.random()
        if k == "documents" and x < 0.5:
            ts.append(T('core.star_document{} on (the %s one)' % ordn(r.choice([1, 2, 3])), "act", ["act_held"], "documents",
                        "star one by position"))
            if r.random() < 0.6:
                ts.append(T('core.trash_document{} on (it)', "act", ["act_held", "c12", "delete_kind"], "documents",
                            "actually bin it (C12: it = the row just starred)"))
        elif k == "notes" and x < 0.5:
            ts.append(T('knowledge.delete_note{} on (the %s one)' % ordn(r.choice([1, 2])), "act", ["act_held", "delete_kind"], "notes",
                        "delete one by position"))
        elif x < 0.7:
            ts.append(T('count of (them)', "act", ["value"], k, "how many"))
        return ts

    def album(self):
        w, r = self.w, self.r
        a = w.title(P.ALBUMS)
        ts = [T('show (photos that (album_titles contains %s))' % q(a), "first", ["album"], "photos", "photos in the %s album" % a)]
        f = r.random()
        if f < 0.45:
            ts.append(T('media.delete_asset{} on (the %s one)' % ordn(r.choice([1, 2, 3])), "act", ["act_held", "delete_kind"],
                        "photos", "delete one by position"))
            if r.random() < 0.6:
                ts.append(T('media.restore_asset{} on (it)', "act", ["act_held", "restore"], "photos", "no wait, put it back"))
        elif f < 0.7:
            ts.append(T('count of (them)', "act", ["value"], "photos", "how many"))
        elif f < 0.85:
            ts.append(T('show (them during last weekend)' if r.random() < 0.5 else 'show (them during last month)',
                        "refine", ["refine", "weekend_past"], "photos", "just the ones from over the weekend / last month"))
        return ts

    def photo_place(self):
        w, r = self.w, self.r
        ph = w.title(P.PHOTOS)
        if r.random() < 0.5:
            ts = [T('show (places of (photos called %s))' % q(ph), "first", ["photo_place"], "places", "where was the %s photo taken" % ph)]
            if r.random() < 0.5:
                ts.append(T('show ((photos of (it)) except (photos called %s))' % q(ph), "act", ["what_else", "c13"], "photos",
                            "what else did I take there (the excluded photo is the one the SENTENCE named: C13 names it)"))
            return ts
        ts = [T('show (photos called %s)' % q(ph), "first", [], "photos", "find the %s photo" % ph)]
        if r.random() < 0.5:
            ts.append(T('show (places of (it))', "act", ["photo_place", "act_held"], "places", "where was it taken"))
        else:
            ts.append(T('show (albums of (it))', "act", ["act_held"], "albums", "which album is it in"))
        ts.append(T('show ((photos of (it)) except (the earlier one))', "act", ["what_else"], "photos",
                    "what else is in it/there (minus the photo from two turns back)"))
        if r.random() < 0.4:
            ts.append(T('count of (them)', "act", ["value"], "photos", "how many is that"))
        return ts

    def weekend(self):
        w, r = self.w, self.r
        o = r.random()
        if o < 0.35:
            c, k = 'show (photos during last weekend)', "photos"
        elif o < 0.6:
            c, k = 'show (activities that (started_at during last weekend))', "activities"
        elif o < 0.8:
            c, k = 'show (tasks that (status = "completed" and completed_at during last weekend))', "tasks"
        else:
            c, k = 'show (expenses that (spent_on during last weekend))', "expenses"
        ts = [T(c, "first", ["weekend_past"], k, "what did I do/take/spend over the weekend (past tense)")]
        if r.random() < 0.4:
            ts.append(T('count of (them)', "act", ["value"], k, "how many"))
        return ts

    def deleted(self):
        w, r = self.w, self.r
        k, pool, rc = r.choice([("tasks", P.TASKS, "schedule.restore_task"), ("photos", P.PHOTOS, "media.restore_asset"),
                                ("documents", P.DOCS, "core.restore_document"), ("tasks", P.TASKS, "schedule.restore_task"),
                                ("documents", P.DOCS, "core.restore_document"), ("photos", P.PHOTOS, "media.restore_asset")])
        t = w.title(pool)
        ts = [T('show (%s called %s that (deleted_at is not null))' % (k, q(t)), "first", ["did_delete"], k,
                "did I delete / bin the %s %s" % (t, k[:-1]))]
        if r.random() < 0.8:
            ts.append(T('%s{} on (it)' % rc, "act", ["act_held", "restore"], k, "put it back"))
        return ts

    def delete_known(self):
        w, r = self.w, self.r
        k, pool, cmd = r.choice([("notes", P.NOTES, "knowledge.delete_note"), ("documents", P.DOCS, "core.trash_document"),
                                 ("tasks", P.TASKS, "schedule.delete_task"), ("photos", P.PHOTOS, "media.delete_asset"),
                                 ("expenses", P.EXPENSES, "tally.delete_expense"), ("events", P.EVENTS, "schedule.delete_event"),
                                 ("locker items", P.LOCKER, "locker.trash_item")])
        t = w.title(pool)
        ts = [T('%s{} on (%s called %s)' % (cmd, k, q(t)), "first", ["delete_kind"], k, "delete/trash the %s %s" % (t, k))]
        f = r.random()
        if f < 0.3 and k in ("tasks", "photos", "documents"):
            rc = {"tasks": "schedule.restore_task", "photos": "media.restore_asset", "documents": "core.restore_document"}[k]
            ts.append(T('%s{} on (it)' % rc, "act", ["act_held", "restore"], k, "oh no, undo that / bring it back"))
        return ts

    def delete_mixed(self):
        w, r = self.w, self.r
        win = w.window()
        return [T('show (things during %s)' % win, "first", ["whats_on"], "things", "what's on %s" % win),
                T('delete{} on (the %s one)' % ordn(r.choice([1, 2, 3])), "act", ["act_held", "delete_class"], "tasks",
                  "get rid of one of them by position (kind unknown -> class delete)")]

    def create_note(self):
        w = self.w
        t = cap(w.pick(P.NOTES))
        ts = [T('knowledge.create_note{ title: %s }' % q(t), "first", ["create"], "notes", "make a note called ...")]
        if self.r.random() < 0.3:
            ts.append(T('knowledge.delete_note{} on (it)', "act", ["act_held", "delete_kind"], "notes", "delete it again"))
        return ts

    def login(self):
        w, r = self.w, self.r
        l = w.title(P.LOCKER)
        ts = [T('show (locker items called %s)' % q(l), "first", ["login"], "locker items", "what's the login for %s" % l)]
        if r.random() < 0.7:
            ts.append(T('locker.reveal_receipt{ columns: "password" } on (it)', "act", ["act_held", "reveal"], "locker items",
                        "show me the password"))
        return ts

    def refuse(self):
        s = self.r.choice(REFUSE).format(place=self.r.choice(P.PLACES))
        return [T('refuse: out_of_ontology', "first", ["refuse"], None, "user asks to " + s + " (outside the vault)")]

    def v3new(self):
        """a single-turn canonical from the v3 typed walker (coverage of the long tail)"""
        g = self.w.g
        for _ in range(30):
            tt = self.r.choice(["s.show", "s.show", "s.value", "s.value", "s.cmd", "s.find", "s.dates", "s.linkpred"])
            g.today = self.w.today
            try:
                prev, tgt, ctx, hint = g.scenario(tt)
            except Exception:
                continue
            if not ok_v3(tgt):
                continue
            tgt = normalize(tgt)
            if tgt is None:
                continue
            k = G.base_kind(check.parse(tgt).get("set") or {}, {}) if tgt.startswith("show") else None
            return [T(tgt, "first", ["v3walker"], k, hint or "")]
        return [self.refuse()[0]]


def money(a):
    return "%d.%02d" % (a // 100, a % 100)


BAD_V3 = re.compile(r"clarify|refuse|people\.log_interaction|schedule\.add_task|propose_event|create_note|add_expense|"
                    r"locker\.add_item|\d{4}-\d\d|around|same\?")


def ok_v3(t):
    return not BAD_V3.search(t)


# -- canonical style: every nested Set parenthesised, refs included ---------
REF_RE = r"(?:it|them|that one|the other one|the earlier one|the last thing I added|the \d+(?:st|nd|rd|th) one)"


def _wrapped(s):
    if not s.startswith("("):
        return False
    d = 0
    for i, ch in enumerate(s):
        if ch == "(":
            d += 1
        elif ch == ")":
            d -= 1
            if d == 0:
                return i == len(s) - 1
    return False


def _bare(s):
    return re.fullmatch(r"[a-z]+(?: [a-z]+)?", s) is not None and s not in ("it", "them") or \
        re.fullmatch(REF_RE, s) is not None


def normalize(t):
    """show X -> show (X), ... of X -> of (X), on X -> on (X); tree must be unchanged"""
    try:
        before = check.parse(t)
    except Exception:
        return None
    out = t
    out = re.sub(r"\b(of|on|in) (%s)(?=$|\)| )" % REF_RE, lambda m: "%s (%s)" % (m.group(1), m.group(2)), out)
    m = re.match(r"^(show|count of|(?:sum|min|max) [a-z_]+ of|[a-z_]+ of) (.*)$", out)
    if m and not out.startswith(("balance", "same?")) and not _wrapped(m.group(2)) and \
            not re.fullmatch(r"[a-z]+(?: [a-z]+)?", m.group(2)) and not re.fullmatch(r"\(%s\)" % REF_RE, m.group(2)):
        out = "%s (%s)" % (m.group(1), m.group(2))
    m = re.match(r"^([a-z_.]+\{.*?\}) on (.*)$", out)
    if m and " then " not in out and not _wrapped(m.group(2)):
        out = "%s on (%s)" % (m.group(1), m.group(2))
    try:
        after = check.parse(out)
    except Exception:
        return t
    if json.dumps(after, sort_keys=True) != json.dumps(before, sort_keys=True):
        return t
    return out


# -- session assembly --------------------------------------------------------
THREADS = ["overdue", "open_tasks", "done_tasks", "no_deadline", "add_task", "whats_on", "when_is", "propose",
           "move_named", "birthday", "contact", "message", "role", "last_contact", "log", "journal", "same", "owes",
           "owe_x", "settle", "balance", "trip", "month_spend", "add_expense", "folder", "album", "photo_place",
           "weekend", "deleted", "delete_known", "delete_mixed", "create_note", "login", "v3new"]
# idiom quota keys (≥ QUOTA canonical sessions each)
IDIOMS = ["overdue", "open_tasks", "whats_on", "when_is", "birthday", "contact", "photo_place", "role", "colleague",
          "owes_me", "i_owe", "owe_x", "owe_x_sum", "settle", "group_balance", "trip_spend", "month_spend", "folder",
          "notebook", "filed_under", "album", "last_contact", "last_journal", "message", "did_delete", "delete_kind",
          "reschedule", "hour_later", "ticked", "no_deadline", "weekend_past", "same", "login", "reveal", "log"]

SWITCH_Q = ["whats_on", "when_is", "birthday", "contact", "owe_x", "login", "last_contact", "month_spend"]


def backtrack(first, w):
    """C10: come back to the first thread's topic after a one-turn switch.
    Either re-name (repeat the first turn's shape) or act on it via a ref (C10 retries
    one answer further back)."""
    c0 = first[0]
    if len(first) == 2 and w.r.random() < 0.6 and c0.canon.startswith("show (") and c0.kind in ("tasks", "expenses", "photos", "documents", "obligations", "things"):
        k = c0.kind
        acts = {"tasks": 'schedule.set_task_status{ status: "completed" } on (the 1st one)',
                "expenses": 'sum amount_minor of (them)', "photos": 'count of (them)',
                "documents": 'core.star_document{} on (the 1st one)', "obligations": 'people.settle_debt{} on (them)',
                "things": 'count of (them)'}
        return T(acts[k], "backtrack", ["backtrack", "c10"], k, "back to the earlier topic: act on those rows (C10 ref)")
    return T(c0.canon, "backtrack", ["backtrack"], c0.kind, "back to the earlier topic, re-asked (re-names it)")


def turn_count(r):
    x = r.random()
    return 1 if x < .30 else 2 if x < .55 else 3 if x < .75 else 4 if x < .88 else r.choice([5, 6])


class Builder:
    def __init__(self, seed):
        self.r = random.Random(seed)
        self.g = G.Gen(seed + 1)
        self.idc = collections.Counter()
        self.thc = collections.Counter()

    def pick_thread(self, need_len=None):
        # coverage: the thread whose idioms are least covered
        best, bs = None, None
        for th in THREADS:
            w = 0.35 if th == "v3new" else 1.0
            s = (self.thc[th] + self.r.random() * 3) / w
            if bs is None or s < bs:
                best, bs = th, s
        return best

    def session(self, n, today):
        w = W(self.r, today)
        w.g = self.g
        th = Threads(w)
        name = self.pick_thread()
        turns = getattr(th, name)()
        self.thc[name] += 1
        while len(turns) < n:
            rem = n - len(turns)
            x = self.r.random()
            if rem >= 2 and x < 0.3 and turns[0].move == "first" and not any(t.move == "switch" for t in turns):
                sw = getattr(th, self.r.choice(SWITCH_Q))()[0]
                sw.move, sw.tags = "switch", sw.tags + ["switch"]
                turns.append(sw)
                turns.append(backtrack(turns, w))
            elif x < 0.64 and self.extend(turns, w):
                continue
            elif 0.64 <= x < 0.665:
                ref = th.refuse()[0]
                ref.move = "new"
                turns.append(ref)
            elif 0.665 <= x < 0.70 and turns[-1].canon.startswith("show"):
                turns.append(T("nothing", "undo", ["undo"], turns[-1].kind, "actually never mind, forget it"))
            else:
                nm = self.pick_thread()
                more = getattr(th, nm)()
                self.thc[nm] += 1
                more[0].move = "new"
                turns.extend(more)
        return turns[:n]


EXT = {
    "tasks": [('schedule.set_task_status{ status: "completed" } on (the %s one)', "mark the Nth one done", ["mark_done"], 1),
              ('reschedule{ to: %s } on (them)', "move them all to a day", ["reschedule"], 0),
              ('count of (them)', "how many", ["value"], 0), ('schedule.delete_task{} on (the %s one)', "delete the Nth", ["delete_kind"], 1)],
    "events": [('schedule.cancel_event{} on (the %s one)', "cancel the Nth", [], 1), ('reschedule{ by: +1h } on (the %s one)', "Nth an hour later", ["hour_later"], 1),
               ('count of (them)', "how many", ["value"], 0)],
    "expenses": [('sum amount_minor of (them)', "total of those", ["value"], 0), ('tally.delete_expense{} on (the %s one)', "delete the Nth", ["delete_kind"], 1),
                 ('show (them that (amount_minor > 3000))', "only the ones over thirty", ["refine"], 0)],
    "photos": [('media.delete_asset{} on (the %s one)', "delete the Nth", ["delete_kind"], 1), ('count of (them)', "how many", ["value"], 0),
               ('show (places of (the %s one))', "where was the Nth taken", ["photo_place"], 1)],
    "documents": [('core.star_document{} on (the %s one)', "star the Nth", [], 1), ('core.trash_document{} on (the %s one)', "bin the Nth", ["delete_kind"], 1)],
    "notes": [('knowledge.delete_note{} on (the %s one)', "delete the Nth", ["delete_kind"], 1), ('count of (them)', "how many", ["value"], 0)],
    "obligations": [('sum amount_minor of (them)', "how much altogether", ["value"], 0), ('people.settle_debt{} on (them)', "settle them", ["settle"], 0)],
    "parties": [('show (contact channels of (the %s one) that (kind = "phone"))', "the Nth one's number", ["contact"], 1),
                ('show (first 1 of (activities of (the %s one) ordered by started_at desc))', "when did I last talk to the Nth one", ["last_contact"], 1)],
    "things": [('count of (them)', "how many", ["value"], 0)],
}
# after a single-row write, C12: `it` narrows to that row
C12 = {"tasks": ('reschedule{ to: %s } on (it)', "and push it to a day (C12: it = the row just written)"),
       "documents": ('core.trash_document{} on (it)', "actually bin it (C12)"),
       "events": ('reschedule{ by: +1h } on (it)', "make it an hour later (C12)"),
       "photos": ('media.restore_asset{} on (it)', "put it back (C12)")}


def _extend(self, turns, w):
    last = turns[-1]
    k = last.kind
    single = re.search(r"on \(the \d+\w\w one\)$", last.canon) and last.move == "act"
    if single and k in C12 and not last.canon.startswith(("reschedule", "core.trash", "media.restore")):
        if k == "photos" and "delete_asset" not in last.canon:
            return False
        c, note = C12[k]
        turns.append(T(c % w.relday() if "%s" in c else c, "act", ["act_held", "c12"], k, note))
        return True
    if not last.canon.startswith("show") or k not in EXT or last.canon.startswith("show (first 1"):
        return False
    c, note, tg, nth = self.r.choice(EXT[k])
    if nth:
        c = c % ordn(self.r.choice([1, 2, 3]))
    elif "%s" in c:
        c = c % w.relday()
    turns.append(T(c, "refine" if c.startswith("show (them") else "act", ["act_held"] + tg, k, note))
    return True


Builder.extend = _extend


def validate_turn(t, prev_kind):
    k = t.kind or prev_kind
    ctx = {"held": k, "earlier": k, "added": k, "written": k}
    return G.validate(t.canon, ctx)


def violates_spec(c):
    if c.startswith("clarify"):
        return "clarify"
    if "people.log_interaction" in c and "since:" not in c:
        return "log without since"
    if "schedule.propose_event" in c and "dtend" not in c:
        return "propose without dtend"
    for m in re.finditer(r"\b(title|summary|description|name|content): \"(.)", c):
        if m.group(2).islower():
            return "lowercase created title"
    return None


def main(n_train=720, n_held=90, seed=4004):
    b = Builder(seed)
    rows, fails = [], collections.Counter()
    seen = collections.Counter()
    while len(rows) < (n_train + n_held) * 3.7:
        n = turn_count(b.r)
        today = DAY0 + datetime.timedelta(days=b.r.randint(0, (DAY1 - DAY0).days))
        try:
            turns = b.session(n, today)
        except Exception as e:  # noqa: BLE001
            fails["gen:" + repr(e)[:50]] += 1
            continue
        bad = None
        pk = None
        for t in turns:
            why = validate_turn(t, pk) or violates_spec(t.canon)
            if why:
                bad = why
                break
            pk = t.kind or pk
        if bad:
            fails[bad.split(":")[0][:40]] += 1
            if fails[bad.split(":")[0][:40]] < 4:
                print("FAIL", bad, [t.canon for t in turns], file=sys.stderr)
            continue
        key = tuple(t.canon for t in turns)
        if seen[key]:
            fails["dup"] += 1
            continue
        seen[key] += 1
        skel = [json.dumps(check.skeleton(check.parse(t.canon)), sort_keys=True) for t in turns]
        rows.append({"today": today.isoformat(), "turns": [{"canon": t.canon, "move": t.move, "tags": t.tags,
                                                           "note": t.note} for t in turns],
                     "skel": skel})
    json.dump(dict(fails), sys.stderr)
    return rows


if __name__ == "__main__":
    rows = main()
    with open(os.path.join(HERE, "canon_pool.jsonl"), "w") as o:
        for r in rows:
            o.write(json.dumps(r) + "\n")
    c = collections.Counter(len(r["turns"]) for r in rows)
    print(len(rows), sorted(c.items()))
