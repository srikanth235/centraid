#!/usr/bin/env python3
"""v5 canonical sessions for the under-covered executor cells (COVERAGE.md).

Writes selected5.jsonl (one row per session skeleton: turns, refs, versions) and
batches/b5_NNN.json for run.sh. Literals naming stored rows are chosen per
SPEC section 5: mode span/loose/full -> the canonical carries the vault label
(it will be among the candidates); mode miss -> the canonical carries the
user's words and the synthetic vault holds no such row.
No evaluation file is opened by this script or anything it imports.
"""
import collections, datetime, json, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "v4"))
import sessgen as S  # noqa: E402
import pools5 as P5  # noqa: E402
import cells as CELLS  # noqa: E402
import vault as V  # noqa: E402

check = S.check
G = S.G
WD = S.WD
q, cap, ordn = S.q, S.cap, S.ordn
KINDWORDS = {"photo", "note", "task", "event", "doc", "document", "album", "place", "group", "expense", "login",
             "file", "pic", "picture"}
FIELD_VKIND = {"album_titles", "notebooks", "folder", "role"}


VERBISH = {w.lower() for v in V.VERBS for w in v.split()} | {"fix", "call", "book", "pay", "buy", "get", "sort", "clean",
                                                          "change", "order", "reply", "chase", "submit", "file", "wash",
                                                          "hang", "plan", "prune", "defrost", "update", "renew", "return",
                                                          "measure", "collect", "cancel", "repaint", "reserve", "descale",
                                                          "swap", "sign", "top", "post", "send", "plant", "frame", "tidy",
                                                          "move", "bleed", "register", "replace", "sharpen", "recycle"}


def kw_of(label, r, kind):
    if kind == "parties":
        return label.split()[0]
    if kind in FIELD_VKIND and len(label.split()) <= 2:
        return label
    for _ in range(12):
        s = S.span(label, r)
        toks = [t for t in re.findall(r"[a-z]+", s.lower())]
        if toks and not any(t in KINDWORDS or t.rstrip("s") in KINDWORDS or t in VERBISH for t in toks) and len(s) > 2 \
                and not s.isdigit():
            return s
    return label


class Sess:
    def __init__(self, r, today, U):
        self.r, self.today, self.U = r, today, U
        self.w = S.W(r, today)
        self.refs = []
        self.used = set()

    def label(self, kind):
        r = self.r
        for _ in range(40):
            if kind == "parties":
                x = "%s %s" % (r.choice(P5.FIRST), r.choice(P5.LAST))
            elif r.random() < 0.7 or kind not in self.U.U:
                x = cap(r.choice(P5.POOL[kind]))
            else:
                x = r.choice(self.U.U[kind])
                if re.search(r"\(\d\d\)$|^IMG_", x):
                    continue
            first = x.split()[0].lower()
            if first not in self.used:
                self.used.add(first)
                return x
        return x

    def R(self, kind, modes=None, turn=0, label=None):
        """a stored row named in the canonical -> the quoted literal"""
        r = self.r
        lab = label or self.label(kind)
        kw = kw_of(lab, r, kind)
        if modes is None:
            modes = {"span": 45, "loose": 30, "miss": 20, "full": 5}
        m = r.choices(list(modes), weights=list(modes.values()))[0]
        if kind == "parties" and m == "loose":
            m = "span"
        if kw == lab and m in ("span", "loose"):
            m = "full"
        if m == "miss":
            lit = kw
        else:
            lit = lab
        self.refs.append({"kind": kind, "label": lab, "kw": kw, "mode": m, "lit": lit, "turn": turn})
        return q(lit)

    def things(self, turn=0):
        """things called: the user's words (no single right row)"""
        lab = self.label(self.r.choice(["tasks", "events", "notes", "documents"]))
        kw = kw_of(lab, self.r, "tasks")
        self.refs.append({"kind": "things", "label": lab, "kw": kw, "mode": "things", "lit": kw, "turn": turn})
        return q(kw)

    def said(self, i=-1):
        x = self.refs[i]
        return x["kw"] if x["mode"] != "full" else x["label"]

    rel = property(lambda s: s.w.relday())
    win = property(lambda s: s.w.window())
    amt = property(lambda s: s.w.amount())


PAST = ["last week", "last month", "this week", "this month", "yesterday", "last weekend", "today"]
FUT = ["next week", "this week", "tomorrow", "this weekend", "next month", "this month"]


def t_(cell, fn, w=1):
    return (cell, fn, w)


# each fn(s) -> (canonical, hint); the hint uses s.said() for what the user calls a row
TEMPLATES = [
    # --- bare boards (+ count) -------------------------------------------------
    t_("bare events", lambda s: ("show (events)", "list everything in my calendar")),
    t_("bare notes", lambda s: ("show (notes)", "show all my notes")),
    t_("bare documents", lambda s: ("show (documents)", "list all my documents/files")),
    t_("bare albums", lambda s: ("show (albums)", "what photo albums do I have")),
    t_("bare expenses", lambda s: ("show (expenses)", "list all my expenses")),
    t_("bare groups", lambda s: ("show (groups)", "which shared-expense groups am I in")),
    t_("bare locker items", lambda s: ("show (locker items)", "what's saved in my locker / password manager")),
    t_("bare settlements", lambda s: ("show (settlements)", "show all the settle-ups / payments recorded in my groups")),
    t_("bare important dates", lambda s: ("show (important dates)", "list all the important dates (birthdays, anniversaries) I've saved")),
    t_("bare obligations", lambda s: ("show (obligations)", "list all the debts between me and people (IOUs)")),
    t_("count events", lambda s: ("count of (events during %s)" % s.r.choice(FUT), "how many things in the calendar in that window")),
    t_("count events", lambda s: ("count of (events)", "how many events are in my calendar in total")),
    t_("count notes", lambda s: ("count of (notes)", "how many notes do I have")),
    t_("count notes", lambda s: ("count of (notes that (notebooks contains %s))" % s.R("notebooks"), "how many notes in the %s notebook" % s.said())),
    t_("count documents", lambda s: ("count of (documents)", "how many documents do I have")),
    t_("count documents", lambda s: ("count of (documents that (folder = %s))" % s.R("folder", {"span": 60, "full": 40}), "how many docs in the %s folder" % s.said())),
    t_("count parties", lambda s: ("count of (parties)", "how many contacts do I have")),
    t_("count parties", lambda s: ("count of (parties that (role = %s))" % s.R("role", {"span": 50, "full": 50}), "how many %ss have I got in my contacts" % s.said().lower())),
    t_("count photos", lambda s: ("count of (photos during %s)" % s.r.choice(PAST), "how many photos did I take in that window")),
    t_("count photos", lambda s: ("count of (photos that (album_titles contains %s))" % s.R("album_titles"), "how many photos in the %s album" % s.said())),
    t_("count albums", lambda s: ("count of (albums)", "how many photo albums have I got")),
    t_("count places", lambda s: ("count of (places)", "how many places are saved in my photos")),
    t_("count expenses", lambda s: ("count of (expenses that (spent_on during %s))" % s.r.choice(PAST), "how many expenses did I log in that window")),
    t_("count expenses", lambda s: ("count of (expenses of (groups called %s))" % s.R("groups"), "how many expenses in the %s group" % s.said())),
    t_("count groups", lambda s: ("count of (groups)", "how many shared-expense groups am I in")),
    t_("count locker items", lambda s: ("count of (locker items)", "how many things are saved in my locker")),
    t_("count locker items", lambda s: ("count of (locker items that (type = \"%s\"))" % s.r.choice(["login", "card", "wifi", "note", "passport", "membership"]), "how many of that type are in my locker")),
    t_("count obligations", lambda s: ("count of (obligations that (settled_at is null))", "how many debts are still outstanding")),
    t_("count contact channels", lambda s: ("count of (contact channels of (parties called %s))" % s.R("parties"), "how many numbers/emails do I have for %s" % s.said())),
    t_("count activities", lambda s: ("count of (activities of (parties called %s))" % s.R("parties"), "how many times have I logged seeing/talking to %s" % s.said())),
    t_("count activities", lambda s: ("count of (activities that (started_at during %s))" % s.r.choice(PAST), "how many calls/visits/coffees did I log in that window")),
    t_("count important dates", lambda s: ("count of (important dates that (next_occurrence during %s))" % s.r.choice(["this month", "next month", "next week"]), "how many birthdays/anniversaries coming up in that window")),
    t_("count members", lambda s: ("count of (members of (groups called %s))" % s.R("groups"), "how many people are in the %s group" % s.said())),
    # --- called ----------------------------------------------------------------
    t_("called journal notes", lambda s: ("show (journal notes called %s)" % s.R("journal notes"), "find my journal entry about %s" % s.said())),
    t_("called albums", lambda s: ("show (albums called %s)" % s.R("album_titles"), "find the %s album" % s.said())),
    t_("called places", lambda s: ("show (places called %s)" % s.R("places"), "find the place %s in my photos' places" % s.said())),
    t_("called things", lambda s: ("show (things called %s)" % s.things(), "what do I have about %s (anything: diary, to-dos, notes...)" % s.said()), 3),
    t_("walk photos of places", lambda s: ("show (photos of (places called %s))" % s.R("places"), "photos from / taken at %s" % s.said()), 2),
    t_("walk photos of places", lambda s: ("count of (photos of (places called %s))" % s.R("places"), "how many photos did I take at %s" % s.said())),
    # --- walks -----------------------------------------------------------------
    t_("walk groups of expenses", lambda s: ("show (groups of (expenses called %s))" % s.R("expenses"), "which group was the %s expense in" % s.said())),
    t_("walk settlements of groups", lambda s: ("show (settlements of (groups called %s))" % s.R("groups"), "show the settle-ups/payments made in the %s group" % s.said())),
    t_("walk settlements of groups", lambda s: ("sum amount_minor of (settlements of (groups called %s))" % s.R("groups"), "how much has been settled up in the %s group in total" % s.said())),
    t_("walk parties of obligations", lambda s: ("show (parties of (obligations that (settled_at is null and from_party = me)))", "who are the people I still owe money to (via the debts)")),
    t_("walk parties of obligations", lambda s: ("show (parties of (obligations that (amount_minor > %d)))" % s.r.choice([2000, 5000, 10000]), "who are the debts over that amount with")),
    t_("walk parties of events", lambda s: ("show (parties of (events called %s))" % s.R("events"), "who's coming to / invited to the %s" % s.said())),
    t_("walk events of parties", lambda s: ("show (events of (parties called %s))" % s.R("parties"), "what's in my calendar with %s" % s.said())),
    t_("walk events of parties", lambda s: ("show (events of (parties called %s) during %s)" % (s.R("parties"), s.r.choice(FUT)), "when am I seeing %s in that window" % s.said())),
    t_("walk photos of albums", lambda s: ("show (photos of (albums called %s))" % s.R("album_titles"), "show the photos in the %s album" % s.said())),
    t_("walk albums of photos", lambda s: ("show (albums of (photos called %s))" % s.R("photos"), "which album is the %s photo in" % s.said())),
    t_("walk tasks of tasks", lambda s: ("show (tasks of (tasks called %s))" % s.R("tasks"), "the subtasks of the %s task" % s.said())),
    t_("walk tasks of tasks", lambda s: ("show (tasks of (tasks called %s) that (status != \"completed\"))" % s.R("tasks"), "which subtasks of %s are still open" % s.said())),
    t_("walk parties of events", lambda s: ("count of (parties of (events called %s))" % s.R("events"), "how many people are coming to the %s" % s.said())),
    # --- filters ---------------------------------------------------------------
    t_("filter tasks: deleted_at is not null", lambda s: ("show (tasks that (deleted_at is not null))", "which tasks have I deleted / are in the bin")),
    t_("filter tasks: deleted_at is not null", lambda s: ("show (tasks called %s that (deleted_at is not null))" % s.R("tasks"), "did I delete the %s task" % s.said())),
    t_("filter tasks: priority", lambda s: ("show (tasks that (priority = 1 and status != \"completed\"))", "open tasks with priority one")),
    t_("filter tasks: priority", lambda s: ("show (tasks that (priority <= %d))" % s.r.choice([2, 3]), "tasks with priority that number or higher-priority (lower number)")),
    t_("filter events: status", lambda s: ("show (events that (status = \"%s\"))" % s.r.choice(["cancelled", "tentative"]), "which events are cancelled / tentative")),
    t_("filter events: status", lambda s: ("show (events that (status = \"cancelled\") during %s)" % s.r.choice(PAST + FUT), "cancelled events in that window")),
    t_("filter events: deleted_at is not null", lambda s: ("show (events that (deleted_at is not null))", "which events have I deleted")),
    t_("filter events: deleted_at is not null", lambda s: ("show (events called %s that (deleted_at is not null))" % s.R("events"), "did I delete the %s event" % s.said())),
    t_("filter events: dtstart", lambda s: ("show (events that (dtstart < %s))" % s.w.relday(), "events before that day")),
    t_("filter events: dtstart", lambda s: ("show (events that (dtstart > %s) ordered by dtstart asc)" % s.w.relday(), "events after that day, soonest first")),
    t_("filter notes: pinned = true", lambda s: ("show (notes that (pinned = true))", "my pinned notes"), 2),
    t_("filter notes: deleted_at is not null", lambda s: ("show (notes that (deleted_at is not null))", "notes I've deleted / in the bin")),
    t_("filter notes: deleted_at is not null", lambda s: ("show (notes called %s that (deleted_at is not null))" % s.R("notes"), "did I delete the %s note" % s.said())),
    t_("filter notes: updated_at", lambda s: ("show (notes that (updated_at during %s))" % s.r.choice(PAST), "notes I edited in that window")),
    t_("filter documents: starred = true", lambda s: ("show (documents that (starred = true))", "my starred documents"), 2),
    t_("filter documents: deleted_at is not null", lambda s: ("show (documents that (deleted_at is not null))", "documents I binned")),
    t_("filter documents: updated_at", lambda s: ("show (documents that (updated_at during %s))" % s.r.choice(PAST), "docs changed in that window")),
    t_("filter photos: favorite = true", lambda s: ("show (photos that (favorite = true))", "my favourite photos"), 3),
    t_("filter photos: favorite = true", lambda s: ("show (photos that (favorite = true) during %s)" % s.r.choice(PAST), "favourite photos from that window")),
    t_("filter photos: favorite = true", lambda s: ("count of (photos that (favorite = true))", "how many favourites have I got")),
    t_("filter photos: deleted_at is not null", lambda s: ("show (photos that (deleted_at is not null))", "photos I deleted")),
    t_("filter photos: place", lambda s: ("show (photos that (place = %s))" % s.R("places", {"span": 60, "full": 40}), "photos whose place is %s" % s.said())),
    t_("filter parties: owed_to_me is not null", lambda s: ("show (parties that (owed_to_me is not null))", "who owes me money")),
    t_("filter parties: owed_to_them is not null", lambda s: ("show (parties that (owed_to_them is not null))", "who do I owe money to")),
    t_("filter parties: deleted_at is not null", lambda s: ("show (parties that (deleted_at is not null))", "contacts I've deleted")),
    t_("filter parties: deleted_at is not null", lambda s: ("show (parties called %s that (deleted_at is not null))" % s.R("parties"), "did I delete %s from my contacts" % s.said())),
    t_("filter parties: kind", lambda s: ("show (parties that (kind = \"%s\"))" % s.r.choice(["org", "animal", "person"]), "contacts that are organisations/companies (org), pets (animal) or people")),
    t_("filter obligations: from_party = me", lambda s: ("show (obligations that (from_party = me and settled_at is null))", "the debts I still owe")),
    t_("filter obligations: from_party = me", lambda s: ("sum amount_minor of (obligations that (from_party = me and settled_at is null))", "how much do I owe in total")),
    t_("filter obligations: to_party = me", lambda s: ("show (obligations that (to_party = me and settled_at is null))", "money people still owe me (the debts)")),
    t_("filter obligations: to_party = me", lambda s: ("sum amount_minor of (obligations that (to_party = me and settled_at is null))", "how much am I owed in total")),
    t_("filter contact channels: label", lambda s: ("show (contact channels of (parties called %s) that (label = \"%s\"))" % (s.R("parties"), s.r.choice(["work", "home", "mobile"])), "%s's number/email with that label (work/home/mobile)" % s.said()), 2),
    t_("filter important dates: next_occurrence", lambda s: ("show (important dates that (next_occurrence during %s))" % s.r.choice(["this month", "next month", "next week", "this week"]), "which birthdays/anniversaries are coming up in that window")),
    t_("filter locker items: type", lambda s: ("show (locker items that (type = \"%s\"))" % s.r.choice(["card", "wifi", "note", "passport", "membership", "login", "identity"]), "which locker entries are of that type")),
    t_("filter locker items: compromised = true", lambda s: ("show (locker items that (compromised = true))", "which of my passwords/logins are compromised"), 2),
    t_("filter expenses: category", lambda s: ("show (expenses that (category = \"%s\"))" % s.r.choice(["food", "groceries", "transport", "fun", "travel", "shopping", "utilities", "rent"]), "expenses in that category")),
    t_("filter expenses: category", lambda s: ("sum amount_minor of (expenses that (category = \"%s\" and spent_on during %s))" % (s.r.choice(["food", "groceries", "transport", "travel"]), s.r.choice(PAST)), "how much did I spend on that category in that window")),
    t_("filter expenses: amount_minor", lambda s: ("show (expenses that (amount_minor > %d))" % s.r.choice([2000, 5000, 10000, 20000]), "expenses over that amount")),
    t_("filter expenses: amount_minor", lambda s: ("show (expenses that (amount_minor < %d and spent_on during %s))" % (s.r.choice([1000, 2000, 500]), s.r.choice(PAST)), "small expenses under that amount in that window")),
    t_("members excluding me", lambda s: ("show (members of (groups called %s) that (party_id is not me))" % s.R("groups"), "who else is in the %s group apart from me" % s.said()), 3),
    t_("members excluding me", lambda s: ("count of (members of (groups called %s) that (party_id is not me))" % s.R("groups"), "how many other people besides me are in the %s group" % s.said())),
    t_("filter places: kind", lambda s: ("show (places that (kind = \"%s\"))" % s.r.choice(["home", "work", "venue", "city"]), "places of that kind")),
    t_("filter activities: started_at", lambda s: ("show (activities that (started_at during %s))" % s.r.choice(PAST), "who did I call/see/have coffee with in that window")),
    # --- order -----------------------------------------------------------------
    t_("order events", lambda s: ("show (events during %s ordered by dtstart asc)" % s.r.choice(FUT), "calendar for that window in order")),
    t_("order events", lambda s: ("show (first 1 of (events of (parties called %s) ordered by dtstart desc))" % s.R("parties"), "the latest event with %s" % s.said())),
    t_("order expenses", lambda s: ("show (first 1 of (expenses ordered by amount_minor desc))", "my biggest expense ever")),
    t_("order expenses", lambda s: ("show (expenses that (spent_on during %s) ordered by amount_minor desc)" % s.r.choice(PAST), "expenses in that window, biggest first")),
    t_("order photos", lambda s: ("show (first %d of (photos ordered by captured_at desc))" % s.r.choice([1, 3, 5, 10]), "my latest N photos")),
    t_("order photos", lambda s: ("show (photos of (places called %s) ordered by captured_at asc)" % s.R("places"), "photos from %s oldest first" % s.said())),
    t_("order documents", lambda s: ("show (documents ordered by updated_at desc)", "documents, most recently changed first")),
    t_("order documents", lambda s: ("show (first %d of (documents ordered by created_at desc))" % s.r.choice([1, 3, 5]), "the newest N documents")),
    t_("order notes", lambda s: ("show (notes ordered by updated_at desc)", "notes, most recently edited first")),
    t_("order notes", lambda s: ("show (first 1 of (notes ordered by created_at desc))", "my newest note")),
    t_("order parties", lambda s: ("show (parties that (owed_to_me is not null) ordered by owed_to_me desc)", "who owes me, biggest first")),
    t_("order obligations", lambda s: ("show (obligations that (settled_at is null) ordered by amount_minor desc)", "outstanding debts, biggest first")),
    t_("order obligations", lambda s: ("show (obligations of (parties called %s) ordered by incurred_on desc)" % s.R("parties"), "debts with %s, newest first" % s.said())),
    # --- values ----------------------------------------------------------------
    t_("max amount_minor expenses", lambda s: ("max amount_minor of (expenses that (spent_on during %s))" % s.r.choice(PAST), "biggest single expense in that window")),
    t_("max amount_minor expenses", lambda s: ("max amount_minor of (expenses of (groups called %s))" % s.R("groups"), "the biggest expense in the %s group" % s.said())),
    t_("min amount_minor expenses", lambda s: ("min amount_minor of (expenses that (spent_on during %s))" % s.r.choice(PAST), "smallest expense in that window")),
    t_("min amount_minor expenses", lambda s: ("min amount_minor of (expenses of (groups called %s))" % s.R("groups"), "the cheapest expense in the %s group" % s.said())),
    t_("min due_at tasks", lambda s: ("min due_at of (tasks that (status != \"completed\"))", "when is my next deadline (earliest due date of open tasks)")),
    t_("max dtstart events", lambda s: ("max dtstart of (events called %s)" % s.R("events"), "when is the last %s (latest date)" % s.said())),
    t_("max dtstart events", lambda s: ("max dtstart of (events of (parties called %s))" % s.R("parties"), "the last date in my calendar with %s" % s.said())),
    t_("field-of due_at tasks", lambda s: ("due_at of (tasks called %s)" % s.R("tasks"), "when is the %s task due" % s.said()), 2),
    t_("field-of amount_minor expenses", lambda s: ("amount_minor of (expenses called %s)" % s.R("expenses"), "how much was the %s expense" % s.said()), 2),
    t_("field-of spent_on expenses", lambda s: ("spent_on of (expenses called %s)" % s.R("expenses"), "when did I pay for the %s" % s.said())),
    t_("field-of next_occurrence important dates", lambda s: ("next_occurrence of (important dates of (parties called %s) that (label contains \"Birthday\"))" % s.R("parties"), "when is %s's next birthday (date)" % s.said()), 2),
    t_("field-of value contact channels", lambda s: ("value of (contact channels of (parties called %s) that (kind = \"%s\"))" % (s.R("parties"), s.r.choice(["phone", "email", "phone"])), "what's %s's number/email (the value)" % s.said()), 2),
    # --- writes ----------------------------------------------------------------
    t_("cmd schedule.cancel_event", lambda s: ("schedule.cancel_event{} on (events called %s)" % s.R("events"), "cancel the %s" % s.said()), 2),
    t_("cmd schedule.restore_task", lambda s: ("schedule.restore_task{} on (tasks called %s that (deleted_at is not null))" % s.R("tasks"), "bring back the deleted %s task" % s.said()), 2),
    t_("cmd core.restore_document", lambda s: ("core.restore_document{} on (documents called %s that (deleted_at is not null))" % s.R("documents"), "restore the binned %s document" % s.said()), 2),
    t_("cmd media.restore_asset", lambda s: ("media.restore_asset{} on (photos called %s that (deleted_at is not null))" % s.R("photos"), "restore the deleted %s photo" % s.said()), 2),
    t_("cmd people.trash_person", lambda s: ("people.trash_person{} on (parties called %s)" % s.R("parties"), "delete %s from my contacts" % s.said())),
    t_("cmd tally.settle_up", lambda s: ("tally.settle_up{ group_id: (groups called %s), from_party: me, amount_minor: %d }" % (s.R("groups"), s.amt), "record that I paid/settled that amount in the group %s" % s.said()), 2),
    t_("cmd tally.settle_up", lambda s: ("tally.settle_up{ group_id: (groups called %s), from_party: (parties called %s), amount_minor: %d }" % (s.R("groups"), s.R("parties"), s.amt), "record that %s paid me that amount in the group" % s.said()), 2),
    t_("cmd media.add_to_album album_id:(set)", lambda s: ("media.add_to_album{ album_id: (albums called %s) } on (photos called %s)" % (s.R("album_titles"), s.R("photos")), "add the %s photo to the album" % s.said()), 2),
    t_("cmd media.add_to_album album_id:(set)", lambda s: ("media.add_to_album{ album_id: (albums called %s) } on (photos during %s)" % (s.R("album_titles"), s.r.choice(PAST)), "put the photos from that window into the %s album" % s.said()), 2),
    t_("cmd media.add_to_album album_id:(set)", lambda s: ("media.add_to_album{ album_id: (albums called %s) } on (photos of (places called %s))" % (s.R("album_titles"), s.R("places")), "add the photos from %s to the album" % s.said())),
    t_("cmd locker.add_item type=note", lambda s: _code(s), 5),
    t_("cmd locker.add_item", lambda s: _login(s), 2),
    t_("cmd schedule.cancel_event", lambda s: ("schedule.cancel_event{} on (events of (parties called %s) during %s)" % (s.R("parties"), s.r.choice(["tomorrow", "this week", "next week"])), "cancel whatever I have with %s in that window" % s.said())),
]


def _code(s):
    r = s.r
    what = r.choice(["garage code", "alarm code", "gate code", "bike lock code", "door code", "safe code", "locker code",
                     "PIN for the shed", "wifi password for the cabin", "combination for the padlock", "key safe code"])
    code = r.choice(["4417", "0613", "2291", "7730", "1582", "9046", "3318", "5524", "8801", "1203"])
    title = cap(what)
    return ('locker.add_item{ type: "note", title: %s, content: "%s" }' % (q(title), code),
            "save the %s %s in my locker (title = the words the person uses for it, content = the code)" % (what, code))


def _login(s):
    r = s.r
    svc = r.choice(["Kayak club", "Library", "Pharmacy app", "Parking app", "Water supplier", "School portal",
                    "Dentist portal", "Photo backup", "Energy account", "Broadband"])
    pw = r.choice(P5.P.SECRETS)
    return ('locker.add_item{ type: "login", title: %s, content: "%s" }' % (q(svc), pw),
            "save a login for %s with password %s" % (svc, pw))


# --- two-turn specials (the undo / held-set cells) -----------------------------
def two_turn(s, kind):
    r = s.r
    if kind == "undo_expense":
        a = "tally.delete_expense{} on (expenses called %s)" % s.R("expenses")
        return [(a, "delete the %s expense" % s.said(), "first"),
                ("tally.undo_expense{} on (it)", "oh no, put it back / undo that", "undo")]
    if kind == "undo_person":
        a = "people.trash_person{} on (parties called %s)" % s.R("parties")
        return [(a, "delete %s from my contacts" % s.said(), "first"),
                ("people.undo_person{} on (it)", "wait, put them back / undo that", "undo")]
    if kind == "album_held":
        f = r.choice([("show (photos during %s)" % r.choice(PAST), "photos from that window"),
                      ("show (photos that (favorite = true))", "my favourite photos"),
                      ("show (photos of (places called %s))" % s.R("places"), None)])
        if f[1] is None:
            f = (f[0], "photos taken at %s" % s.said())
        return [(f[0], f[1], "first"),
                ("media.add_to_album{ album_id: (albums called %s) } on (them)" % s.R("album_titles", turn=1),
                 "add those to the %s album" % s.said(), "act")]
    if kind == "nothing":
        c = r.choice(TEMPLATES_WRITE_OR_SHOW)
        a, h = c[1](s)
        return [(a, h, "first"), ("nothing", "actually forget it / never mind (takes the request back)", "undo")]
    if kind == "delete_restore_class":
        return [("show (things during %s)" % s.win, "what's on in that window", "first"),
                ("delete{} on (the %s one)" % ordn(r.choice([1, 2, 3])), "get rid of one of them by position", "act"),
                ("restore{} on (it)", "oops, bring it back", "undo")]
    raise ValueError(kind)


TEMPLATES_WRITE_OR_SHOW = [t for t in TEMPLATES if t[0].startswith(("cmd schedule.cancel", "cmd people.trash", "cmd media.add",
                                                                     "cmd tally.settle", "filter", "order"))]
SPECIAL2 = {"cmd tally.undo_expense": "undo_expense", "cmd people.undo_person": "undo_person",
            "cmd media.add_to_album album_id:(set)": "album_held", "nothing": "nothing",
            "cmd restore on ref": "delete_restore_class"}

# --- follow-ups on held rows (part b) -------------------------------------------
FOLLOW = {
    "tasks": ['schedule.set_task_status{ status: "completed" } on (the %(n)s one)', "reschedule{ to: %(rel)s } on (the %(n)s one)",
              "count of (them)", "schedule.delete_task{} on (the %(n)s one)"],
    "events": ["schedule.cancel_event{} on (the %(n)s one)", "reschedule{ by: +1h } on (the %(n)s one)", "count of (them)",
               "show (parties of (the %(n)s one))"],
    "expenses": ["sum amount_minor of (them)", "tally.delete_expense{} on (the %(n)s one)", "show (them that (amount_minor > 3000))",
                 "show (groups of (the %(n)s one))"],
    "photos": ["media.delete_asset{} on (the %(n)s one)", "count of (them)", "show (places of (the %(n)s one))",
               "media.add_to_album{ album_id: (albums called %(album)s) } on (them)", "show (albums of (the %(n)s one))"],
    "documents": ["core.star_document{} on (the %(n)s one)", "core.trash_document{} on (the %(n)s one)", "count of (them)"],
    "notes": ["knowledge.delete_note{} on (the %(n)s one)", "count of (them)"],
    "obligations": ["sum amount_minor of (them)", "people.settle_debt{} on (the %(n)s one)", "show (parties of (the %(n)s one))"],
    "parties": ['show (contact channels of (the %(n)s one) that (kind = "phone"))',
                "show (first 1 of (activities of (the %(n)s one) ordered by started_at desc))",
                "show (obligations of (the %(n)s one) that (settled_at is null))", "people.trash_person{} on (the %(n)s one)"],
    "members": ["balance of (the %(n)s one) in (groups called %(group)s)", 'show (contact channels of (the %(n)s one) that (kind = "phone"))'],
    "locker items": ['locker.reveal_receipt{ columns: "password" } on (the %(n)s one)', "locker.trash_item{} on (the %(n)s one)",
                     "count of (them)"],
    "things": ["count of (them)", "delete{} on (the %(n)s one)", "reschedule{ to: %(rel)s } on (the %(n)s one)"],
    "important dates": ["count of (them)", "show (parties of (the %(n)s one))"],
    "activities": ["count of (them)", "show (parties of (the %(n)s one))"],
    "places": ["show (photos of (the %(n)s one))", "count of (them)"],
    "albums": ["show (photos of (the %(n)s one))", "count of (them)"],
    "groups": ["show (expenses of (the %(n)s one))", "show (members of (the %(n)s one))"],
    "settlements": ["sum amount_minor of (them)", "count of (them)"],
}
AFTER1 = {  # after a write on one ordinal row: act on it
    "schedule.delete_task": "schedule.restore_task{} on (it)", "media.delete_asset": "media.restore_asset{} on (it)",
    "core.trash_document": "core.restore_document{} on (it)", "tally.delete_expense": "tally.undo_expense{} on (it)",
    "people.trash_person": "people.undo_person{} on (it)", "core.star_document": "core.trash_document{} on (it)",
}


def base_kind_of(c):
    t = check.parse(c)
    if t["node"] in ("show",):
        return CELLS.base_kind(t["set"])
    return None


def follow_ups(s, first_canon, n):
    k = base_kind_of(first_canon)
    out = []
    if k not in FOLLOW:
        return out
    group = re.search(r'groups called ("[^"]*")', first_canon)
    last = first_canon
    for i in range(n):
        m = re.match(r"^([a-z_.]+)\{\} on \(the \d\w\w one\)$", last)
        if m and m.group(1) in AFTER1 and s.r.random() < 0.7:
            c = AFTER1[m.group(1)]
            out.append((c, "undo/act on the row just written (it)", "act"))
            last = c
            continue
        if s.r.random() < 0.12 and i > 0:
            out.append(("nothing", "actually never mind / forget it", "undo"))
            break
        opts = FOLLOW[k]
        c = s.r.choice(opts)
        if "%(group)s" in c and not group:
            continue
        vals = {"n": ordn(s.r.choice([1, 2, 3])), "rel": s.w.relday(), "group": group.group(1) if group else "",
                "album": None}
        if "%(album)s" in c:
            vals["album"] = s.R("album_titles", turn=len(out) + 1)
        c = c % vals
        if c == last:
            continue
        out.append((c, "act on the rows just answered (%s)" % c.split("{")[0].split(" (")[0], "refine" if c.startswith("show (them") else "act"))
        last = c
        if c.startswith(("count of", "sum ")) and s.r.random() < 0.5:
            continue
    return out


def validate(c, prev_kind=None):
    import gbnf
    if not REC.full(c):
        return "gbnf"
    try:
        check.parse(c)
    except Exception as e:  # noqa: BLE001
        return "parse %s" % e
    return S.violates_spec(c)


REC = None


def main(seed=5050):
    global REC
    import gbnf
    REC = gbnf.Recognizer(gbnf.rules())
    r = random.Random(seed)
    U = V.Universe()
    DAY0, DAY1 = S.DAY0, S.DAY1
    rows, fails = [], collections.Counter()
    seen = collections.Counter()
    # (a) singles: >= 12 canonicals per under-covered cell (x5 phrasings)
    by_cell = collections.defaultdict(list)
    for t in TEMPLATES:
        by_cell[t[0]].append(t)
    per_cell = collections.Counter()
    want = {c: 14 for c in by_cell}
    for c in ("called things", "walk photos of places", "filter photos: favorite = true", "count locker items",
              "cmd locker.add_item type=note", "members excluding me", "cmd media.add_to_album album_id:(set)"):
        want[c] = 20
    sid = 0

    def today():
        return DAY0 + datetime.timedelta(days=r.randint(0, (DAY1 - DAY0).days))

    for cell, ts in sorted(by_cell.items()):
        tries = 0
        while per_cell[cell] < want[cell] and tries < 400:
            tries += 1
            t = r.choices(ts, weights=[x[2] for x in ts])[0]
            s = Sess(r, today(), U)
            c, h = t[1](s)
            why = validate(c)
            if why:
                fails[why[:30]] += 1
                continue
            if seen[c] >= (4 if not s.refs else 1):
                continue
            seen[c] += 1
            per_cell[cell] += 1
            rows.append({"id": "a%04d" % sid, "part": "a", "today": s.today.isoformat(), "cell": cell,
                         "turns": [{"canon": c, "move": "first", "hint": h}], "refs": s.refs, "nver": 5})
            sid += 1
    for cell, kind in SPECIAL2.items():
        for i in range(16):
            s = Sess(r, today(), U)
            turns = two_turn(s, kind)
            bad = [validate(c) for c, _, _ in turns if validate(c)]
            if bad:
                fails["special " + bad[0][:20]] += 1
                continue
            rows.append({"id": "a%04d" % sid, "part": "a", "today": s.today.isoformat(), "cell": cell,
                         "turns": [{"canon": c, "move": m, "hint": h} for c, h, m in turns], "refs": s.refs, "nver": 5})
            sid += 1
    # (b) multi-turn: first turn from a list-answering template, follow-ups on the held rows
    show_ts = [t for t in TEMPLATES if True]
    bid = 0
    tries = 0
    while bid < 210 and tries < 20000:
        tries += 1
        t = r.choice(show_ts)
        s = Sess(r, today(), U)
        c, h = t[1](s)
        if not c.startswith("show") or validate(c):
            continue
        n = r.choice([1, 1, 2, 2, 3, 4])
        fu = follow_ups(s, c, n)
        if not fu:
            continue
        turns = [(c, h, "first")] + fu
        if any(validate(x[0]) for x in turns):
            fails["follow invalid"] += 1
            continue
        rows.append({"id": "b%04d" % bid, "part": "b", "today": s.today.isoformat(), "cell": t[0],
                     "turns": [{"canon": x, "move": m, "hint": hh} for x, hh, m in turns], "refs": s.refs, "nver": 2})
        bid += 1
    with open(os.path.join(HERE, "selected5.jsonl"), "w") as o:
        for x in rows:
            o.write(json.dumps(x) + "\n")
    print(len(rows), collections.Counter(x["part"] for x in rows), dict(fails))
    return rows


if __name__ == "__main__":
    main()
