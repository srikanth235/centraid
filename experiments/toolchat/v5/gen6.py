#!/usr/bin/env python3
"""v6 delta: canonical sessions that teach the conventions v5 got confidently
wrong (v5 dev-90 diagnostics, described generically; no evaluation file is
opened by this script or anything it imports).

Writes selected6.jsonl in selected5's format (turns, refs, nver) for
make_batches6 -> run6.sh (Sonnet) -> build6.py.

Conventions taught:
- a topic word names rows by `called` ("notes about X" -> notes called "X");
  a notebook/folder filter only when the person says notebook/folder
- "<role> tasks" are tasks called "<role>" even when a role value is shown;
  role filters are for PEOPLE ("who's my dentist")
- value follow-ups sum ("what's that come to") and follow the right link
- open / overdue / left-to-do tasks carry status != "completed"
- amounts said in words are digits; events vs tasks; no invented due date
- follow-ups on held rows: photos of (them), label contains, parties of (it)
- "and X?" substitutes a name into the previous request
"""
import collections, datetime, json, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "v4"))
import gen5 as G5  # noqa: E402
import pools5 as P5  # noqa: E402
import vault as V  # noqa: E402

S, q, cap, ordn = G5.S, G5.q, G5.cap, G5.ordn
PAST, FUT = G5.PAST, G5.FUT
ROLES = ["Dentist", "Plumber", "Vet", "Tutor", "Accountant", "Mechanic", "Builder", "Coach", "Physio",
         "Optician", "Cleaner", "Electrician", "Gardener", "Landlord", "Solicitor", "Babysitter"]


class Sess(G5.Sess):
    def topic(self, kind, turn=0):
        """the person's own word for a subject; `called` it (no single right row)"""
        lab = self.label(kind)
        kw = G5.kw_of(lab, self.r, kind)
        self.refs.append({"kind": "things", "label": lab, "kw": kw, "mode": "things", "lit": kw, "turn": turn})
        return q(kw), kw

    def role(self, turn=0, shown=True):
        """a role word the person says; its field value is SHOWN as a candidate"""
        lab = self.r.choice(ROLES)
        if shown:
            self.refs.append({"kind": "role", "label": lab, "kw": lab.lower(), "mode": "span", "lit": lab, "turn": turn})
        return lab

    def first(self):
        return self.r.choice(P5.FIRST)


def T(c, h, m="first"):
    return (c, h, m)


NUMW = {5: "five", 8: "eight", 12: "twelve", 15: "fifteen", 18: "eighteen", 20: "twenty", 25: "twenty five",
        30: "thirty", 35: "thirty five", 40: "forty", 42: "forty two", 45: "forty five", 50: "fifty",
        60: "sixty", 64: "sixty four", 75: "seventy five", 80: "eighty", 90: "ninety", 120: "a hundred and twenty",
        150: "a hundred and fifty", 13: "thirteen", 17: "seventeen", 24: "twenty four", 36: "thirty six",
        27: "twenty seven", 99: "ninety nine"}
TIMES = [("14:00", "two", "15:00"), ("10:00", "ten", "11:00"), ("15:30", "half three", "16:30"),
         ("09:00", "nine", "10:00"), ("11:00", "eleven", "12:00"), ("16:00", "four", "17:00"),
         ("13:00", "one", "14:00"), ("18:30", "half six", "19:30")]
EVENTY = ["Haircut", "Dentist check-up", "Coffee with {f}", "Car service", "Yoga class", "Vet appointment",
          "Parents evening", "Physio", "Lunch with {f}", "Eye test", "Piano lesson", "Boiler service"]
TASKY = ["call the plumber", "renew the parking permit", "email {f} the photos", "book the MOT",
         "order a new filter", "pay the window cleaner", "send {f} the forms", "print the tickets",
         "check the smoke alarms", "return the library books", "chase the refund", "water the tomatoes"]
EXP = ["gas", "petrol", "lunch", "tickets", "parking", "groceries", "the taxi", "coffee", "snacks", "firewood"]


def c_notes_about(s):
    lit, kw = s.topic("notes")
    return [T("show (notes called %s)" % lit, "find my notes about %s / what did I write down about %s "
              "(any note whose title mentions it; NOT a notebook)" % (kw, kw))]


def c_notes_then_notebook(s):
    lit, kw = s.topic("notes")
    nb = s.R("notebooks", {"span": 60, "full": 40}, turn=1)
    return [T("show (notes called %s)" % lit, "what notes have I got about %s" % kw),
            T("show (notes that (notebooks contains %s))" % nb, "correction: no, I meant the %s NOTEBOOK "
              "(the person says the word notebook)" % s.said(), "act")]


def c_about_other_kinds(s):
    k, word = s.r.choice([("documents", "paperwork / documents / files"), ("locker items", "locker / saved logins"),
                          ("events", "calendar"), ("photos", "photos"), ("tasks", "to-do list")])
    lit, kw = s.topic(k)
    return [T("show (%s called %s)" % (k, lit), "have I got anything in my %s for/about %s" % (word, kw))]


def c_things_about(s):
    lit, kw = s.topic(s.r.choice(["tasks", "events", "notes", "documents"]))
    return [T("show (things called %s)" % lit, "what do I have about %s (anything at all, no app named)" % kw)]


def c_role_tasks(s):
    lab = s.role()
    c = s.r.choice(["show (tasks called %s)", "show (tasks called %s that (status != \"completed\"))",
                    "count of (tasks called %s)"]) % q(lab.lower())
    h = {"show (tasks called": "what %s tasks / to-dos do I have" % lab.lower(),
         "show (tasks called %s that" % q(lab.lower())[:0]: ""}
    hint = ("which %s to-dos are still open" % lab.lower() if "status" in c else
            "how many %s tasks have I got" % lab.lower() if c.startswith("count") else
            "what %s tasks / to-dos do I have" % lab.lower())
    return [T(c, hint + " (the %s is a word in the task titles, not a person)" % lab.lower())]


def c_role_people(s):
    lab = s.role()
    c = s.r.choice(["show (parties that (role = %s))" % q(lab),
                    "show (contact channels of (parties that (role = %s)) that (kind = \"phone\"))" % q(lab),
                    "sum amount_minor of (obligations of (parties that (role = %s)) that (settled_at is null))" % q(lab)])
    hint = ("who's my %s (the person with that role)" % lab.lower() if c.startswith("show (parties") else
            "what's my %s's number" % lab.lower() if "contact" in c else
            "how much do I still owe the %s" % lab.lower())
    return [T(c, hint)]


def c_sum_after_list(s):
    r = s.r
    first = r.choice([
        lambda: ("show (expenses of (groups called %s))" % s.R("groups"), "list the expenses in the %s group" % s.said()),
        lambda: ("show (expenses called %s)" % s.R("expenses"), "show the %s expenses" % s.said()),
        lambda: ("show (expenses that (spent_on during %s))" % r.choice(PAST), "what did I spend on in that window"),
        lambda: ("show (obligations that (settled_at is null and from_party = me))", "what debts do I still owe"),
    ])()
    return [T(*first),
            T("sum amount_minor of (them)", "what's that come to / how much is that altogether / total? "
              "(short follow-up, no names)", "act")]


def c_sum_single(s):
    r = s.r
    c = r.choice([lambda: ("sum amount_minor of (expenses called %s)" % s.R("expenses"),
                           "what did the %s come to / cost" % s.said()),
                  lambda: ("sum amount_minor of (expenses of (groups called %s))" % s.R("groups"),
                           "how much have I spent in the %s group" % s.said())])()
    return [T(*c)]


def c_person_money(s):
    p = s.R("parties", {"span": 60, "full": 40})
    return [T("show (parties called %s)" % p, "look up %s" % s.said()),
            T("sum amount_minor of (obligations of (it) that (settled_at is null))",
              "how much is outstanding with them / what do they still owe (pronoun, no name)", "act"),
            T("people.settle_debt{} on (obligations of (it))", "pay it off / settle up with them (pronoun)", "act")]


def c_debts_then_settle(s):
    p = s.R("parties", {"span": 60, "full": 40})
    return [T("show (obligations of (parties called %s) that (settled_at is null))" % p,
              "do I owe %s anything / does %s owe me anything" % (s.said(), s.said())),
            T("sum amount_minor of (them)", "how much? (one or two words)", "act"),
            T("people.settle_debt{} on (them)", "ok settle that / pay it off", "act")]


def c_parties_money(s):
    return [T("show (parties that (%s is not null))" % s.r.choice(["owed_to_me", "owed_to_them"]),
              "who owes me money / who do I owe money to"),
            T("sum amount_minor of (obligations of (them) that (settled_at is null))",
              "what's that altogether / how much in total (no names)", "act")]


def c_open_tasks(s):
    c = s.r.choice([
        ("show (tasks that (due_at during before now and status != \"completed\"))", "anything overdue / what's late"),
        ("show (tasks that (status != \"completed\"))", "what's still on my list / what's left to do / what haven't I done yet"),
        ("count of (tasks that (due_at during before now and status != \"completed\"))", "how many things are overdue"),
    ])
    return [T(*c)]


def c_open_followups(s):
    lit, kw = s.topic("tasks")
    w = s.r.choice(FUT)
    first = s.r.choice([("show (tasks called %s)" % lit, "show my %s tasks" % kw),
                        ("show (tasks that (due_at during %s))" % w, "what tasks are due in that window")])
    second = s.r.choice([("show (them that (status != \"completed\"))", "which of those are still open / what's left of them"),
                         ("show (them that (title contains %s))" % lit, "just the %s ones (narrow those by a word)" % kw)])
    if second[0] == "show (them that (title contains %s))" % lit and first[0].startswith("show (tasks called"):
        second = ("show (them that (status != \"completed\"))", "which of those are still open / what's left of them")
    return [T(*first), T(second[0], second[1], "refine")]


def c_amount_words(s):
    r = s.r
    units = r.choice(sorted(NUMW))
    what = r.choice(EXP)
    desc = cap(what.replace("the ", ""))
    g = s.R("groups", {"span": 70, "full": 30})
    payer = r.choice(["me", None])
    args = 'description: %s, amount_minor: %d, paid_by: me, group_id: (groups called %s)' % (q(desc), units * 100, g)
    return [T("tally.add_expense{ %s }" % args,
              "add %s (SAY THE AMOUNT IN WORDS: '%s' dollars/pounds/quid) of %s to the %s group, I paid "
              "(description = that word)" % (NUMW[units], NUMW[units], what, s.said()))]


def c_event_write(s):
    r = s.r
    t24, said, end = r.choice(TIMES)
    day = r.choice(S.WD + ["tomorrow", "next " + r.choice(S.WD)])
    summ = r.choice(EVENTY).format(f=s.first())
    return [T('schedule.propose_event{ summary: %s, dtstart: %s at %s, dtend: %s at %s }' % (q(summ), day, t24, day, end),
              "put a %s in the diary/calendar %s at %s (a one-hour appointment; say the time like '%s')"
              % (summ, day, said, said))]


def c_task_write(s):
    r = s.r
    what = r.choice(TASKY).format(f=s.first())
    if r.random() < 0.5:
        return [T("schedule.add_task{ title: %s }" % q(cap(what)), "add a task / remind me to %s (NO date given)" % what)]
    day = r.choice(S.WD + ["tomorrow"])
    return [T("schedule.add_task{ title: %s, due_at: %s }" % (q(cap(what)), day), "add a to-do to %s by %s" % (what, day))]


def c_refuse_vs_task(s):
    r = s.r
    thing = r.choice(["the cabin", "a table at the Italian place", "the campsite", "the hotel", "a court",
                      "the ferry", "the museum tickets", "a hire car"])
    if r.random() < 0.5:
        return [T("refuse: out_of_ontology", "book %s on their website / online for me (the app cannot browse or book)" % thing)]
    return [T("schedule.add_task{ title: %s }" % q("Book " + thing), "add a task to book %s (a reminder for me)" % thing)]


def c_photos_followups(s):
    r = s.r
    who = s.first()
    first = r.choice([("show (photos during %s)" % r.choice(PAST), "photos from that window"),
                      ("show (photos of (places called %s))" % s.R("places"), None),
                      ("show (photos that (favorite = true))", "my favourite photos")])
    if first[1] is None:
        first = (first[0], "photos taken at %s" % s.said())
    alb = s.R("album_titles", {"span": 60, "full": 40}, turn=1)
    return [T(*first),
            T("media.add_to_album{ album_id: (albums called %s) } on (them that (label contains %s))" % (alb, q(who)),
              "put the one with %s in it into the %s album" % (who, s.said()), "act")]


def c_show_those_photos(s):
    first = s.r.choice([("show (albums called %s)" % s.R("album_titles"), None),
                        ("show (places called %s)" % s.R("places"), None)])
    return [T(first[0], "find the %s %s" % (s.said(), "album" if "albums" in first[0] else "place")),
            T("show (photos of (them))", "show me those photos / the pictures in it", "act")]


def c_parties_of_event(s):
    e = s.R("events")
    first = s.r.choice([("show (events called %s)" % e, "when's the %s" % s.said()),
                        ("show (events called %s during %s)" % (e, s.r.choice(FUT)), "is the %s on in that window" % s.said())])
    return [T(*first), T("show (parties of (it))", "who is that with / which person is that (pronoun)", "act")]


def c_members(s):
    g = s.R("groups", {"span": 60, "full": 40})
    return [T("show (members of (groups called %s) that (party_id is not me))" % g,
              "who's in the %s group (plain question)" % s.said())]


def c_delete_stuff(s):
    lit, kw = s.topic(s.r.choice(["tasks", "events", "notes"]))
    return [T("delete{} on (things called %s)" % lit, "delete / get rid of all my %s stuff" % kw)]


def c_colleague(s):
    f = s.first()
    c = s.r.choice(["show (parties called %s that (role contains \"colleague\"))" % q(f),
                    "show (contact channels of (parties called %s that (role contains \"colleague\")) that (kind = \"email\"))" % q(f)])
    return [T(c, "the %s I work with / from work / used to work with — %s" %
              (f, "what's their full name" if c.startswith("show (parties") else "what's their email"))]


def c_login(s):
    lit, kw = s.topic("locker items")
    return [T("show (locker items called %s that (type = \"login\"))" % lit, "have I got a login for %s" % kw)]


SUBST = [
    lambda s, a: ("sum amount_minor of (obligations of (parties called %s) that (settled_at is null))" % a,
                  "how much does %s owe me / do I owe %s"),
    lambda s, a: ("show (contact channels of (parties called %s) that (kind = \"phone\"))" % a, "what's %s's number"),
    lambda s, a: ("show (events of (parties called %s) during %s)" % (a, s.r.choice(FUT)), "when am I seeing %s in that window"),
    lambda s, a: ("show (first 1 of (activities of (parties called %s) ordered by started_at desc))" % a,
                  "when did I last speak to %s"),
]


def c_substitute(s):
    f = s.r.choice(SUBST)
    a = s.R("parties", {"span": 60, "full": 40})
    na = s.said()
    b = s.R("parties", {"span": 60, "full": 40}, turn=1)
    nb = s.said()
    c1, h = f(s, a)
    c2 = c1.replace(a, b, 1)
    return [T(c1, h.replace("%s", na)), T(c2, "and %s? / what about %s? (just the new name)" % (nb, nb), "act")]


CELLS6 = {
    "notes about": (c_notes_about, 18), "notes then notebook": (c_notes_then_notebook, 8),
    "about other kinds": (c_about_other_kinds, 14), "things about": (c_things_about, 10),
    "role tasks": (c_role_tasks, 16), "role people": (c_role_people, 12),
    "sum after list": (c_sum_after_list, 16), "sum single": (c_sum_single, 10),
    "person money": (c_person_money, 12), "debts then settle": (c_debts_then_settle, 10),
    "parties money": (c_parties_money, 8), "open tasks": (c_open_tasks, 14), "open follow-ups": (c_open_followups, 12),
    "amount words": (c_amount_words, 14), "event write": (c_event_write, 14), "task write": (c_task_write, 12),
    "refuse vs task": (c_refuse_vs_task, 8), "photos follow-ups": (c_photos_followups, 10),
    "show those photos": (c_show_those_photos, 8), "parties of event": (c_parties_of_event, 10),
    "members": (c_members, 8), "delete stuff": (c_delete_stuff, 8), "colleague": (c_colleague, 8),
    "login": (c_login, 8), "substitute": (c_substitute, 16),
}


def main(seed=6060):
    import gbnf
    G5.REC = gbnf.Recognizer(gbnf.rules())
    r = random.Random(seed)
    U = V.Universe()

    def today():
        return S.DAY0 + datetime.timedelta(days=r.randint(0, (S.DAY1 - S.DAY0).days))

    rows, fails, seen = [], collections.Counter(), collections.Counter()
    for cell, (fn, n) in CELLS6.items():
        got, tries = 0, 0
        while got < n and tries < 500:
            tries += 1
            s = Sess(r, today(), U)
            turns = fn(s)
            bad = [G5.validate(c) for c, _, _ in turns if G5.validate(c)]
            if bad:
                fails["%s: %s" % (cell, bad[0][:40])] += 1
                continue
            key = tuple(c for c, _, _ in turns)
            if seen[key] >= (1 if s.refs else 5):
                continue
            seen[key] += 1
            rows.append({"id": "c%04d" % len(rows), "part": "c", "today": s.today.isoformat(), "cell": cell,
                         "turns": [{"canon": c, "move": m, "hint": h} for c, h, m in turns],
                         "refs": s.refs, "nver": 5})
            got += 1
        if got < n:
            fails["%s short by %d" % (cell, n - got)] += 1
    with open(os.path.join(HERE, "selected6.jsonl"), "w") as o:
        for x in rows:
            o.write(json.dumps(x) + "\n")
    print(len(rows), "sessions,", sum(len(x["turns"]) for x in rows), "turns;", dict(fails))


if __name__ == "__main__":
    main()
