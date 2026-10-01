"""Build the four eval worlds as world JSON (seeded only through `nativetools seed`).

Each world is a different household. The core of every world (people, groups, the named
events/tasks/notes/documents/photos/debts/locker items) is written by hand below; recurring
history (weekly classes, monthly bills, photo rolls) is expanded deterministically from
hand-written patterns so the worlds have realistic volume.

    python3 build_worlds.py            # writes A.json B.json C.json D.json next to this file

World  household                               today                size      currencies
A      Priya Raman, Austin TX (dev)             Wed 2026-10-14 08:40  ordinary  USD
B      Kwame Asante, Chicago IL (test)          Sat 2026-11-28 10:15  ordinary  USD + CAD group
C      Hana Sato, Seattle WA (test)             Mon 2027-02-01 07:50  ordinary  USD + EUR/JPY/GBP groups
D      Marisol Reyes-Kapoor, Montclair NJ       Sun 2026-12-20 19:40  large     USD + MXN group
       (dev + test, disjoint sessions)

Every household keeps its own books in USD (the world's `currency`, the vault default) and
holds foreign currencies only through tally groups, so bare amounts stay unambiguous.
"""

from __future__ import annotations

import datetime as dt
import json
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent


def d(s: str) -> dt.date:
    return dt.date.fromisoformat(s)


def weekly(start: str, end: str, weekday: int, time: str) -> list[str]:
    """Every `weekday` (0=Mon) between start and end, as YYYY-MM-DDTHH:MM."""
    out = []
    day = d(start)
    while day.weekday() != weekday:
        day += dt.timedelta(days=1)
    while day <= d(end):
        out.append(f"{day.isoformat()}T{time}")
        day += dt.timedelta(days=7)
    return out


def monthly(start: str, count: int, day: int = 1) -> list[str]:
    first = d(start)
    out = []
    y, m = first.year, first.month
    for _ in range(count):
        out.append(dt.date(y, m, day).isoformat())
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


class W:
    """A small builder that keeps keys unique across the world."""

    def __init__(self, me: str, epoch: str, seed: str, today: str):
        self.world: dict = {"me": me, "currency": "USD", "epoch": epoch, "seed": seed}
        self.today = today
        self.keys: set[str] = {"me"}
        self.auto_events: list[dict] = []

    def _add(self, section: str, row: dict) -> dict:
        key = row.get("key")
        if key is not None:
            assert key not in self.keys, key
            self.keys.add(key)
        self.world.setdefault(section, []).append(row)
        return row

    def person(self, key, name, **kw):
        return self._add("people", {"key": key, "name": name, **kw})

    def group(self, key, name, members, currency="USD", **kw):
        return self._add("groups", {"key": key, "name": name, "currency": currency, "members": members, **kw})

    def expense(self, group, name, amount, paid_by, split, date, **kw):
        return self._add("expenses", {"group": group, "name": name, "amount": amount, "paid_by": paid_by,
                                      "split": split, "date": date, **kw})

    def lst(self, key, name, **kw):
        return self._add("lists", {"key": key, "name": name, **kw})

    def event(self, key, name, start, auto=False, **kw):
        """`auto` marks generated occurrences (recurring classes, background history): the vault
        refuses overlapping events, so an auto occurrence that collides with a hand-written event
        (or an earlier auto one) is skipped, as a real calendar skips a class during a trip."""
        row = {"key": key, "name": name, "start": start, **kw}
        if auto:
            self.auto_events.append(row)
            self.keys.add(key)
            return row
        return self._add("events", row)

    def task(self, key, name, **kw):
        return self._add("tasks", {"key": key, "name": name, **kw})

    def notebook(self, key, name, **kw):
        return self._add("notebooks", {"key": key, "name": name, **kw})

    def note(self, key, name, body, **kw):
        return self._add("notes", {"key": key, "name": name, "body": body, **kw})

    def folder(self, key, name, **kw):
        return self._add("folders", {"key": key, "name": name, **kw})

    def doc(self, key, name, text, **kw):
        return self._add("documents", {"key": key, "name": name, "text": text, **kw})

    def album(self, key, name, **kw):
        return self._add("albums", {"key": key, "name": name, **kw})

    def photo(self, key, name, taken, **kw):
        return self._add("photos", {"key": key, "name": name, "taken": taken, **kw})

    def debt(self, key, person, direction, amount, name, date, **kw):
        return self._add("debts", {"key": key, "person": person, "direction": direction, "amount": amount,
                                   "name": name, "date": date, **kw})

    def locker(self, key, name, type_, **kw):
        return self._add("locker", {"key": key, "name": name, "type": type_, **kw})

    def link(self, a, b):
        self.world.setdefault("links", []).append({"from": a, "to": b})

    def done(self) -> dict:
        def span(row):
            start = dt.datetime.fromisoformat(row["start"])
            end = dt.datetime.fromisoformat(row["end"]) if "end" in row else start + dt.timedelta(minutes=60)
            return start, end

        taken: list[tuple[dt.datetime, dt.datetime, str]] = []
        for row in self.world.get("events", []):
            s, e = span(row)
            for s2, e2, other in taken:
                assert not (s < e2 and s2 < e), f"hand-written events overlap: {row['key']} / {other}"
            taken.append((s, e, row["key"]))
        kept_keys = set()
        for row in self.auto_events:
            s, e = span(row)
            if any(s < e2 and s2 < e for s2, e2, _ in taken):
                self.keys.discard(row["key"])
                continue
            taken.append((s, e, row["key"]))
            self.world.setdefault("events", []).append(row)
            kept_keys.add(row["key"])
        self.world["events"].sort(key=lambda r: r["start"])
        self.world["today"] = self.today
        return self.world


# --------------------------------------------------------------------------------------------
# World A — Priya Raman, product manager in Austin, engaged to Tomás; dog Biscuit.
# --------------------------------------------------------------------------------------------


def world_a() -> dict:
    w = W("Priya Raman", "2025-11-01T09:00", "evalA", "2026-10-14T08:40")
    P = w.person
    P("tomas", "Tomás Herrera", role="fiancé", nickname="Tomi", starred=True, last_contacted="2026-10-13T21:00")
    P("amma", "Lakshmi Raman", role="mom", nickname="Amma", cadence=7, starred=True,
      last_contacted="2026-10-11T19:00", last_contacted_kind="call")
    P("arjun", "Arjun Raman", role="brother", cadence=14, last_contacted="2026-09-20T18:00")
    P("meera_i", "Meera Iyer", role="college friend", met="UT Austin 2014", cadence=21,
      last_contacted="2026-09-02T12:00")
    P("meera_s", "Meera Shah", role="yoga friend", met="yoga studio", last_contacted="2026-10-06T19:30")
    P("jordan_b", "Jordan Blake", role="friend", last_contacted="2026-09-28T20:00")
    P("jordan_l", "Jordan Lee", role="Tomás's coworker")
    P("kenji", "Kenji Watanabe", role="climbing buddy", cadence=14, last_contacted="2026-08-30T10:00")
    P("chloe", "Chloe Dubois", role="friend", nickname="Clo", last_contacted="2026-10-03T22:00")
    P("rachel_k", "Rachel Kim", role="book club", last_contacted="2026-09-24T20:00")
    P("rachel_g", "Rachel Goldberg", role="wedding planner", last_contacted="2026-10-09T15:00")
    P("dana", "Dana Whitfield", role="manager", cadence=7, last_contacted="2026-10-08T10:30")
    P("luis", "Luis Ortega", role="engineer", last_contacted="2026-10-12T16:00")
    P("farah", "Farah Haddad", role="designer", starred=True, last_contacted="2026-10-07T13:00")
    P("cho", "Elaine Cho", role="dentist")
    P("marco", "Marco Bellini", role="plumber")
    P("greg", "Greg Patterson", role="landlord", last_contacted="2026-08-15T09:00")
    P("ananya", "Ananya Desai", role="yoga teacher")
    P("bev", "Bev Lawson", role="neighbor", nickname="Miss Bev", last_contacted="2026-10-10T08:00")
    P("sofia", "Sofía Herrera", role="Tomás's sister", cadence=30, last_contacted="2026-10-04T21:00")
    P("ramon", "Ramón Herrera", role="Tomás's dad")
    P("nikhil", "Nikhil Menon", role="cousin", cadence=30, last_contacted="2026-07-19T11:00")
    P("hannah", "Hannah Brooks", role="vet")
    P("olivia", "Olivia Park", role="college friend", met="UT Austin 2013")
    P("ben", "Ben Adeyemi", role="run club", last_contacted="2026-10-10T07:45")
    P("tasha", "Tasha Morgan", role="hairdresser")
    P("wei", "Wei Zhang", role="accountant", cadence=90, last_contacted="2026-09-30T17:00")
    P("isabel", "Isabel Cruz", role="neighbor")
    P("craig", "Craig Nolan", role="ex-colleague", trashed="2026-06-01T09:00")
    P("derek", "Derek Hall", role="old landlord", trashed="2026-03-12T10:00")
    P("gayatri", "Gayatri Raman", role="aunt", nickname="Gayu chithi")
    P("pooja", "Pooja Venkat", role="bridesmaid", starred=True, last_contacted="2026-10-12T21:30")

    w.group("casa", "Casa Bills", ["tomas"])
    w.group("bigbend", "Big Bend Trip", ["tomas", "jordan_b", "chloe", "kenji"])
    w.group("bookclub", "Book Club", ["meera_i", "rachel_k", "farah", "olivia"])
    w.group("potluck", "Diwali Potluck", ["meera_s", "nikhil", "arjun", "tomas"])
    w.group("lunch", "Office Lunch Pool", ["dana", "luis", "farah"])
    everyone_bb = ["me", "tomas", "jordan_b", "chloe", "kenji"]
    for name, amt, payer, date in [
        ("Rent September", 2400, "me", "2026-09-01"), ("HEB groceries", 142.35, "tomas", "2026-09-06"),
        ("Internet", 70, "me", "2026-09-10"), ("Electric bill", 118.20, "tomas", "2026-09-18"),
        ("Rent October", 2400, "tomas", "2026-10-01"), ("Costco run", 213.77, "me", "2026-10-04"),
        ("HEB groceries", 96.10, "me", "2026-10-11"),
    ]:
        w.expense("casa", name, amt, payer, ["me", "tomas"], date)
    for name, amt, payer, date in [
        ("Terlingua cabin", 640, "me", "2026-09-11"), ("Gas", 88, "jordan_b", "2026-09-11"),
        ("Groceries", 154.20, "chloe", "2026-09-11"), ("Park entry", 150, "kenji", "2026-09-12"),
        ("Starlight Theatre dinner", 210.50, "tomas", "2026-09-13"),
    ]:
        w.expense("bigbend", name, amt, payer, everyone_bb, date)
    w.expense("bookclub", "Wine", 45, "rachel_k", ["me", "meera_i", "rachel_k", "farah", "olivia"], "2026-09-24")
    w.expense("bookclub", "Snacks", 30, "me", ["me", "meera_i", "rachel_k", "farah", "olivia"], "2026-09-24")
    w.expense("potluck", "Diyas and decorations", 60, "me", ["me", "meera_s", "nikhil", "arjun", "tomas"], "2026-10-09")
    w.expense("potluck", "Sweets from the mithai shop", 85, "nikhil", ["me", "meera_s", "nikhil", "arjun", "tomas"], "2026-10-12")
    w.expense("lunch", "Pizza Friday", 64, "dana", ["me", "dana", "luis", "farah"], "2026-10-02")
    w.expense("lunch", "Tacos", 48, "me", ["me", "dana", "luis", "farah"], "2026-10-09")

    w.lst("home", "Home", area="household")
    w.lst("work", "Work", area="job")
    w.lst("wedding", "Wedding", area="wedding")
    w.lst("errands", "Errands")

    E = w.event
    for i, start in enumerate(weekly("2026-08-04", "2026-11-24", 1, "18:30")):
        E(f"yoga{i}", "Yoga with Ananya", start, end=start[:11] + "19:30", attendees=["ananya"], auto=True)
    for i, start in enumerate(weekly("2026-08-06", "2026-11-26", 3, "10:00")):
        E(f"oneonone{i}", "1:1 with Dana", start, end=start[:11] + "10:30", attendees=["dana"], auto=True)
    E("dentist", "Dentist – Dr. Cho", "2026-10-20T15:00", end="2026-10-20T15:45", attendees=["cho"])
    E("vet", "Biscuit vet checkup", "2026-10-16T09:30", end="2026-10-16T10:00", attendees=["hannah"])
    E("bookclub_ev", "Book club: Tomorrow, and Tomorrow, and Tomorrow", "2026-10-22T19:00",
      end="2026-10-22T21:00", attendees=["meera_i", "rachel_k", "farah", "olivia"])
    E("diwali", "Diwali potluck", "2026-11-08T18:00", end="2026-11-08T22:00",
      attendees=["meera_s", "nikhil", "arjun", "tomas"], description="at our place; everyone brings one dish")
    E("flight_out", "Flight to Chennai", "2026-12-18T22:40", description="AA 2461 via DFW")
    E("flight_back", "Flight home from Chennai", "2027-01-03T02:10")
    E("bday", "Tomás birthday dinner", "2026-10-24T19:30", end="2026-10-24T22:00", attendees=["tomas"],
      description="Uchi, reservation under Raman")
    E("venue", "Wedding venue tour", "2026-10-17T11:00", end="2026-10-17T12:30", attendees=["tomas", "rachel_g"])
    E("cake", "Cake tasting", "2026-11-01T14:00", end="2026-11-01T15:00", attendees=["tomas", "rachel_g"])
    E("acl", "ACL Fest", "2026-10-02T12:00", end="2026-10-02T23:00", attendees=["jordan_b", "chloe"])
    E("pottery", "Pottery class", "2026-10-15T18:00", end="2026-10-15T20:00", cancelled=True)
    E("haircut", "Haircut with Tasha", "2026-10-14T17:30", end="2026-10-14T18:15", attendees=["tasha"])
    E("plumber", "Plumber visit", "2026-10-14T13:00", end="2026-10-14T14:00", attendees=["marco"])
    E("climb", "Climbing at Crux", "2026-10-18T09:00", end="2026-10-18T11:00", attendees=["kenji"])
    E("runclub", "Town Lake run club", "2026-10-17T07:00", end="2026-10-17T08:00", attendees=["ben"])
    E("arjuncall", "Call with Arjun", "2026-10-19T20:00", end="2026-10-19T20:30", attendees=["arjun"])
    E("offsite", "Q4 planning offsite", "2026-10-27T09:00", end="2026-10-27T17:00",
      attendees=["dana", "luis", "farah"])
    E("taxmeet", "Tax meeting with Wei", "2026-09-30T16:00", end="2026-09-30T17:00", attendees=["wei"])
    E("bigbend_ev", "Big Bend trip", "2026-09-11T08:00", end="2026-09-14T18:00",
      attendees=["tomas", "jordan_b", "chloe", "kenji"])
    E("leasedl", "Lease renewal deadline", "2026-11-30T09:00")
    E("brunch", "Brunch with Meera", "2026-10-25T11:00", end="2026-10-25T12:30", attendees=["meera_s"])
    E("halloween", "Halloween party at Chloe's", "2026-10-31T20:00", attendees=["chloe"])
    E("friendsgiving", "Friendsgiving", "2026-11-26T16:00", attendees=["jordan_b", "chloe", "kenji", "meera_i"])
    E("sofia_dinner", "Dinner with Sofía", "2026-10-04T19:00", attendees=["sofia"])
    E("market", "Farmers market", "2026-10-10T09:00")
    E("physical", "Annual physical", "2026-08-21T10:00")
    E("movie", "Movie night", "2026-10-09T20:00", attendees=["tomas"])
    E("kayak", "Kayak rental", "2026-09-26T10:00", cancelled=True)
    E("mehndi", "Mehndi planning call", "2026-10-21T19:00", attendees=["pooja", "rachel_g"])
    E("amma_call", "Weekly call with Amma", "2026-10-18T08:00", attendees=["amma"])
    E("carservice", "Car service at Toyota", "2026-10-23T08:00")
    E("parents_zoom", "Zoom with Tomás's parents", "2026-10-26T18:00", attendees=["ramon", "tomas"])

    T = w.task
    for i, due in enumerate(monthly("2025-12-01", 12)):
        done = due < "2026-10-14"
        T(f"rent{i}", "Pay rent", due=due, list="home", priority=1,
          **({"status": "completed", "completed": due + "T08:15"} if done else {}))
    T("faucet", "Fix leaky kitchen faucet", due="2026-10-14", list="home", effort=60)
    T("dogfood", "Buy dog food for Biscuit", due="2026-10-15", list="errands", effort=20)
    T("garage", "Clean out garage", due="2026-10-25", list="home", effort=180, priority=5)
    T("acfilter", "Change AC filter", due="2026-10-01", list="home", status="completed", completed="2026-10-01T18:00")
    T("plants", "Water the plants", due="2026-10-12", list="home", status="completed", completed="2026-10-12T09:00")
    T("lights", "Hang the Diwali lights", due="2026-11-05", list="home", effort=45)
    T("fridge", "Deep clean fridge", list="home", status="in_progress", effort=40)
    T("amazon", "Return Amazon package", due="2026-10-16", list="errands", effort=15)
    T("carreg", "Renew car registration", due="2026-10-31", list="errands", priority=1)
    T("furnace", "Schedule furnace inspection", list="home")
    T("roadmap", "Write Q4 roadmap draft", due="2026-10-16T17:00", list="work", priority=1, effort=240,
      status="in_progress")
    T("review_luis", "Review Luis's design doc", due="2026-10-15", list="work", effort=45)
    T("slides", "Prepare slides for offsite", due="2026-10-26", list="work", effort=120)
    T("expense", "Submit expense report", due="2026-10-09", list="work", effort=30)
    T("feedback", "Send feedback to Farah", due="2026-10-08", list="work", status="completed",
      completed="2026-10-08T16:30")
    T("offroom", "Book offsite room", due="2026-09-30", list="work", status="completed", completed="2026-09-29T11:00")
    T("okr", "Update OKR tracker", due="2026-10-20", list="work", effort=30)
    T("shortlist", "Shortlist venues", due="2026-09-25", list="wedding", status="completed",
      completed="2026-09-24T21:00")
    T("deposit", "Pay wedding venue deposit", due="2026-10-20", list="wedding", priority=1)
    T("guests", "Guest list", due="2026-11-15", list="wedding")
    T("guests_r", "Guest list – Raman side", parent="guests", list="wedding")
    T("guests_h", "Guest list – Herrera side", parent="guests", list="wedding")
    T("photog", "Ask Rachel about photographers", list="wedding")
    T("invites", "Order invitation samples", due="2026-11-02", list="wedding", effort=30)
    T("caterer", "Pick a caterer", list="wedding", priority=2)
    T("drycleaning", "Pick up dry cleaning", due="2026-10-15", list="errands")
    T("passport", "Renew passport", due="2026-11-15", priority=1)
    T("passphotos", "Get passport photos", due="2026-10-21", list="errands", parent="passport")
    T("library", "Drop off library books", list="errands", trashed="2026-10-05T10:00")
    T("gift", "Buy birthday gift for Tomás", due="2026-10-22", list="errands", priority=2)
    T("ammapkg", "Mail Amma's package", due="2026-10-18", list="errands", effort=30)
    T("pharmacy", "Pharmacy pickup", due="2026-10-10", list="errands", status="completed",
      completed="2026-10-10T12:20")
    T("callamma", "Call Amma about December trip", due="2026-10-18")
    T("bbplan", "Plan Big Bend trip", due="2026-09-05", status="completed", completed="2026-09-05T20:00")
    T("bbcabin", "Book Terlingua cabin", parent="bbplan", status="completed", completed="2026-08-20T12:00")
    T("bbpass", "Buy park pass", parent="bbplan", status="completed", completed="2026-09-01T12:00")
    T("esttax", "File quarterly estimated taxes", due="2027-01-15", priority=2)
    T("flights", "Book Chennai flights", status="completed", completed="2026-09-15T22:00")
    T("weiinv", "Pay Wei's invoice", due="2026-10-30")
    T("readbook", "Finish Tomorrow, and Tomorrow, and Tomorrow", due="2026-10-22", status="in_progress")
    T("halfmarathon", "Sign up for Austin half marathon", effort=15)
    T("gym", "Cancel old gym membership", status="cancelled")
    T("biketire", "Fix bike tire", trashed="2026-10-08T09:00")
    T("ammaalbum", "Make photo album for Amma", due="2026-12-10", effort=120)
    T("thankyou", "Write thank-you notes", effort=60)
    T("sweets", "Order Diwali sweets", due="2026-11-06")
    T("insurance", "Compare renter's insurance quotes", due="2026-11-20", effort=60)
    T("vetbill", "Pay vet bill", due="2026-10-16", list="errands")
    w.link("review_luis", "luis")
    w.link("feedback", "farah")
    w.link("callamma", "amma")
    w.link("ammapkg", "amma")
    w.link("ammaalbum", "amma")
    w.link("gift", "tomas")
    w.link("photog", "rachel_g")
    w.link("faucet", "marco")
    w.link("weiinv", "wei")

    w.notebook("journal", "Journal")
    w.notebook("recipes", "Recipes")
    w.notebook("worknotes", "Work notes")
    w.notebook("weddingideas", "Wedding ideas")
    N = w.note
    N("j1", "Big Bend – day 1", "Drove 7 hours, cabin smells like cedar. Jordan got us lost twice.",
      notebook="journal", created="2026-09-11T22:00")
    N("j2", "Big Bend – day 3", "Santa Elena Canyon at sunrise. Kenji fell in the river.", notebook="journal",
      created="2026-09-13T21:30")
    N("j3", "Rough day at work", "Roadmap review went sideways. Dana was kind about it.", notebook="journal",
      created="2026-10-01T22:15")
    N("j4", "Sunday reflections", "Slow morning, pancakes, long walk with Biscuit.", notebook="journal",
      created="2026-10-11T20:00")
    N("j5", "After the call with Amma", "She wants the wedding in Chennai too. Two weddings?", notebook="journal",
      created="2026-10-11T21:10")
    N("j6", "Engagement anniversary", "One year since Tomás asked at Mount Bonnell.", notebook="journal",
      created="2026-08-02T23:00")
    N("r1", "Amma's sambar", "toor dal, tamarind, sambar powder, drumsticks, curry leaves", notebook="recipes",
      created="2026-01-18T12:00")
    N("r2", "Tomás's chilaquiles", "tortilla chips, salsa verde, crema, queso fresco, fried egg",
      notebook="recipes", created="2026-03-08T11:00")
    N("r3", "Masala chai", "ginger, cardamom, black tea, whole milk, jaggery", notebook="recipes",
      created="2026-02-02T08:00", pinned=True)
    N("r4", "Green chutney", "cilantro, mint, green chili, lemon, salt", notebook="recipes",
      created="2026-05-14T18:00")
    N("r5", "Banana bread", "3 ripe bananas, walnuts, brown sugar, cinnamon; 60 min at 350F",
      notebook="recipes", created="2026-04-20T15:00")
    N("w1", "Offsite agenda ideas", "roadmap bets, hiring plan, team health survey", notebook="worknotes",
      created="2026-10-05T14:00")
    N("w2", "1:1 notes – Dana", "promo packet in January; mentor Luis", notebook="worknotes",
      created="2026-10-08T11:00")
    N("w3", "Roadmap risks", "payments migration slips if vendor contract stalls", notebook="worknotes",
      created="2026-10-02T09:30")
    N("w4", "Hiring loop feedback", "strong yes on the senior PM candidate", notebook="worknotes",
      created="2026-09-17T17:00")
    N("wd1", "Venue shortlist", "Laguna Gloria, Barr Mansion, Pecan Springs", notebook="weddingideas",
      created="2026-09-20T20:00")
    N("wd2", "Color palette", "marigold, deep teal, ivory", notebook="weddingideas", created="2026-09-22T21:00")
    N("wd3", "Mehndi night ideas", "Pooja's playlist, henna artist from Houston", notebook="weddingideas",
      created="2026-10-03T22:00")
    N("wd4", "Wedding budget", "venue 12k, food 9k, photo 4k, attire 5k", notebook="weddingideas",
      created="2026-09-28T19:00", pinned=True)
    N("giftideas", "Gift ideas for Tomás", "vintage film camera, Spurs tickets, pour-over kettle", pinned=True,
      created="2026-09-30T22:00")
    N("books", "Books to read", "Demon Copperhead, The Covenant of Water, Piranesi", created="2026-06-10T21:00")
    N("garagesale", "Garage sale inventory", "old bike, bookshelf, two lamps, camping stove",
      created="2026-10-06T10:00")
    N("wifitips", "Wifi troubleshooting", "restart the router, then the mesh node in the office",
      created="2026-07-01T20:00")
    N("packing", "Packing list Chennai", "gifts for cousins, sarees, adapters, meds", pinned=True,
      created="2026-10-09T21:00")
    N("oldgrocery", "Old grocery list", "eggs, milk, coffee", trashed="2026-10-02T09:00", created="2026-08-01T09:00")
    N("biscuitnotes", "Biscuit's vet notes", "allergic to chicken; next rabies shot due November",
      created="2026-08-21T12:00")
    N("meera_bday", "Meera birthday ideas", "pottery class voucher, cookbook", created="2026-09-05T20:00")
    w.link("j5", "amma")
    w.link("w2", "dana")
    w.link("meera_bday", "meera_i")
    w.link("wd3", "pooja")

    w.folder("taxes", "Taxes")
    w.folder("house", "House")
    w.folder("medical", "Medical")
    w.folder("travel", "Travel")
    w.folder("workdocs", "Work")
    D = w.doc
    D("w2form", "W-2 2025", "Employer wages 2025", folder="taxes", starred=True, created="2026-02-03T10:00")
    D("int1099", "1099-INT Chase 2025", "interest income", folder="taxes", created="2026-02-10T10:00")
    D("return", "2025 tax return", "federal return as filed", folder="taxes", starred=True,
      created="2026-04-10T21:00")
    D("lease", "Lease agreement 2026", "12 month lease, 2208 Kinney Ave", folder="house", starred=True,
      created="2025-12-01T10:00")
    D("renters", "Renter's insurance policy", "Lemonade policy", folder="house", created="2026-01-05T10:00")
    D("xray", "Dental x-ray report", "no cavities", folder="medical", created="2026-04-02T10:00")
    D("vaccines", "Vaccination record", "covid, flu, tdap", folder="medical", created="2026-03-15T10:00")
    D("biscuitvax", "Biscuit vaccination certificate", "rabies, DHPP", folder="medical",
      created="2026-08-21T12:30")
    D("passportscan", "Passport scan", "scan of passport data page", folder="travel", starred=True,
      created="2026-05-01T10:00")
    D("itinerary", "Chennai flight itinerary", "AA 2461 DFW-DOH-MAA", folder="travel",
      created="2026-09-15T22:10")
    D("parkpass", "Big Bend park pass", "annual pass receipt", folder="travel", created="2026-09-01T12:05")
    D("offer", "Offer letter", "product manager offer", folder="workdocs", created="2025-11-02T10:00")
    D("perfreview", "Q3 performance review", "exceeds expectations", folder="workdocs",
      created="2026-10-06T10:00")
    D("handbook", "Employee handbook", "PTO policy", folder="workdocs", created="2025-11-03T10:00")
    D("cartitle", "Car title", "2019 Toyota RAV4", folder="house", created="2026-01-20T10:00")
    D("venuecontract", "Wedding venue contract draft", "Barr Mansion draft contract",
      created="2026-10-10T16:00")
    D("utility", "Utility bill September", "Austin Energy", folder="house", created="2026-09-18T10:00")
    D("oldlease", "Old lease 2024", "previous apartment", trashed="2026-01-10T10:00", created="2025-11-05T10:00")
    D("marriagelic", "Marriage license checklist", "Travis County clerk requirements",
      created="2026-10-12T20:00")

    w.album("bigbend_al", "Big Bend 2026")
    w.album("biscuit_al", "Biscuit")
    w.album("chennai_al", "Chennai 2025")
    w.album("engagement_al", "Engagement")
    Ph = w.photo
    bb = [("Santa Elena Canyon", "2026-09-13T07:10", []), ("Sunrise at Chisos", "2026-09-12T06:55", []),
          ("Hot springs", "2026-09-12T16:00", ["tomas"]), ("Campfire", "2026-09-11T21:30", ["jordan_b", "chloe"]),
          ("Group photo on Lost Mine trail", "2026-09-12T10:20", ["tomas", "jordan_b", "chloe", "kenji"]),
          ("Kenji in the river", "2026-09-13T08:00", ["kenji"]), ("Terlingua ghost town", "2026-09-14T11:00", []),
          ("Starlight Theatre", "2026-09-13T20:00", ["tomas"]), ("Roadrunner", "2026-09-12T14:30", []),
          ("Desert wildflowers", "2026-09-14T09:10", [])]
    for i, (name, taken, people) in enumerate(bb):
        Ph(f"bb{i}", name, taken, albums=["bigbend_al"], people=people, starred=(i in (0, 4)))
    bis = [("Biscuit at Zilker", "2026-03-14T10:00"), ("Biscuit sleeping", "2026-05-02T22:00"),
           ("Biscuit's birthday cake", "2026-06-18T18:00"), ("Biscuit in the lake", "2026-07-04T11:00"),
           ("Biscuit and Miss Bev", "2026-08-09T09:00"), ("Biscuit with the cone", "2026-08-22T19:00"),
           ("Biscuit Halloween costume", "2025-10-31T18:00"), ("Biscuit on the couch", "2026-10-12T20:10")]
    for i, (name, taken) in enumerate(bis):
        Ph(f"bis{i}", name, taken, albums=["biscuit_al"], people=(["bev"] if "Bev" in name else []),
           starred=(i == 2))
    ch = [("Marina Beach", "2025-12-22T17:00", []), ("Amma's kolam", "2025-12-24T07:30", ["amma"]),
          ("Kapaleeshwarar temple", "2025-12-23T10:00", []), ("Family dinner", "2025-12-25T20:00",
                                                                ["amma", "arjun", "gayatri"]),
          ("Filter coffee", "2025-12-26T08:00", []), ("Arjun's new scooter", "2025-12-27T12:00", ["arjun"]),
          ("Mylapore market", "2025-12-28T11:00", []), ("Airport goodbye", "2025-12-30T01:00", ["amma"])]
    for i, (name, taken, people) in enumerate(ch):
        Ph(f"ch{i}", name, taken, albums=["chennai_al"], people=people, starred=(i == 3))
    en = [("The proposal", "2025-08-02T19:40", ["tomas"]), ("Ring close-up", "2025-08-02T19:45", []),
          ("Engagement party", "2025-09-20T21:00", ["tomas", "pooja", "meera_i", "chloe"]),
          ("Sofía and Tomás", "2025-09-20T22:00", ["sofia", "tomas"]),
          ("Mount Bonnell sunset", "2026-08-02T19:30", ["tomas"])]
    for i, (name, taken, people) in enumerate(en):
        Ph(f"en{i}", name, taken, albums=["engagement_al"], people=people, starred=(i == 0))
    loose = [("Farmers market haul", "2026-10-10T10:00", []), ("ACL Fest crowd", "2026-10-02T20:00",
                                                                ["jordan_b", "chloe"]),
             ("Pottery bowl", "2026-09-17T20:00", []), ("Screenshot 2026-10-01", "2026-10-01T12:00", []),
             ("Whiteboard notes", "2026-10-05T15:00", []), ("Meera's birthday", "2026-09-06T21:00", ["meera_i"]),
             ("Blurry photo", "2026-10-09T20:05", []), ("Receipt for dry cleaning", "2026-10-08T12:00", []),
             ("Diwali rangoli 2025", "2025-11-01T19:00", ["meera_s"]), ("Pooja's dress fitting", "2026-10-12T15:00",
                                                                     ["pooja"])]
    for i, (name, taken, people) in enumerate(loose):
        Ph(f"lo{i}", name, taken, people=people,
           **({"trashed": "2026-10-09T21:00"} if name == "Blurry photo" else {}))

    Db = w.debt
    Db("acltix", "jordan_b", "owes_me", 85, "ACL ticket", "2026-10-02")
    Db("uber", "chloe", "i_owe", 32.40, "Uber from the airport", "2026-09-14")
    Db("lunchluis", "luis", "owes_me", 18, "lunch at Veracruz", "2026-09-20", settled="2026-09-25T12:00")
    Db("magazine", "meera_i", "i_owe", 12, "bridal magazines", "2026-09-06")
    Db("concert", "kenji", "owes_me", 60, "Khruangbin concert ticket", "2026-08-15")
    Db("mehndi_dep", "pooja", "i_owe", 150, "henna artist deposit", "2026-10-12")
    Db("sofia_loan", "sofia", "owes_me", 200, "flight change fee", "2026-07-02", settled="2026-08-01T10:00")
    Db("bev_plants", "bev", "i_owe", 25, "plant sitting", "2026-09-15")
    Db("arjun_gift", "arjun", "owes_me", 40, "half of Amma's gift", "2026-10-11")
    Db("nikhil_cab", "nikhil", "i_owe", 22.50, "cab share", "2026-07-19", settled="2026-07-25T09:00")
    Db("jordan_gas", "jordan_b", "i_owe", 15, "gas money", "2026-09-28")
    Db("farah_book", "farah", "owes_me", 27.99, "book club book", "2026-09-24")

    L = w.locker
    L("wifi", "Home wifi", "wifi", password="biscuit-2208", starred=True)
    L("officewifi", "Office wifi", "wifi", password="Welcome2026!")
    L("netflix", "Netflix", "login", username="priya.raman@example.com", url="https://netflix.com",
      password="tacos&dosa")
    L("chase", "Chase bank", "login", username="praman", url="https://chase.com", password="R4man!Chase")
    L("amex", "Amex Gold card", "card", starred=True)
    L("passportlk", "Passport", "passport", notes="expires 2027-02-01")
    L("license", "Driver's license", "driving_licence", notes="Texas, expires 2029")
    L("garagecode", "Garage door code", "note", notes="side door keypad")
    L("spotify", "Spotify", "login", username="priyar", url="https://spotify.com", password="sambar4life")
    L("aws", "AWS root account", "api_credential")
    L("healthins", "Health insurance card", "membership", notes="BCBS PPO")
    L("costco", "Costco membership", "membership", notes="executive, renews March")
    L("router", "Router admin", "login", username="admin", url="http://192.168.1.1", password="n3tgear-admin")
    L("oldgym", "Old gym login", "login", username="priya", trashed="2026-09-20T09:00")
    return w.done()


# --------------------------------------------------------------------------------------------
# World B — Kwame Asante, high-school chemistry teacher in Chicago; wife Efua, kids Ama and Kofi.
# --------------------------------------------------------------------------------------------


def world_b() -> dict:
    w = W("Kwame Asante", "2025-12-01T09:00", "evalB", "2026-11-28T10:15")
    P = w.person
    P("efua", "Efua Asante", role="wife", starred=True, last_contacted="2026-11-27T22:00")
    P("ama", "Ama Asante", role="daughter", nickname="Ams")
    P("kofi", "Kofi Asante", role="son")
    P("maame", "Grace Owusu", role="mother-in-law", nickname="Maame", cadence=7,
      last_contacted="2026-11-22T17:00", last_contacted_kind="call")
    P("yaw", "Yaw Asante", role="brother", cadence=14, last_contacted="2026-11-01T15:00", met="Kumasi")
    P("kojo", "Kojo Mensah", role="best friend", starred=True, cadence=14, last_contacted="2026-11-20T21:00")
    P("dan_o", "Dan O'Brien", role="colleague, physics", last_contacted="2026-11-25T15:30")
    P("dan_k", "Dan Kowalski", role="neighbor", nickname="Big Dan", last_contacted="2026-11-26T08:00")
    P("principal", "Monica Reyes", role="principal", last_contacted="2026-11-18T14:00")
    P("sarah_l", "Sarah Lindqvist", role="colleague, biology")
    P("sarah_n", "Sarah Nakamura", role="Ama's piano teacher")
    P("coach", "Terrence Bell", role="Kofi's soccer coach", nickname="Coach T")
    P("pastor", "Pastor Emmanuel Boateng", role="pastor")
    P("adwoa", "Adwoa Boateng", role="church choir", last_contacted="2026-11-15T12:00")
    P("drpatel", "Rakesh Patel", role="pediatrician")
    P("mechanic", "Luis Romero", role="mechanic")
    P("akosua", "Akosua Frimpong", role="cousin in Toronto", cadence=30, last_contacted="2026-10-05T19:00")
    P("kwabena", "Kwabena Frimpong", role="cousin in Toronto")
    P("nana", "Nana Yeboah", role="old friend from Accra", cadence=60, last_contacted="2026-06-10T09:00")
    P("mike", "Mike Sullivan", role="fantasy football league")
    P("jen", "Jen Sullivan", role="Mike's wife")
    P("tutor", "Priya Nair", role="Kofi's math tutor")
    P("banker", "Olivia Grant", role="mortgage officer")
    P("barber", "Andre Wallace", role="barber", last_contacted="2026-11-14T11:00")
    P("fiifi", "Fiifi Ansah", role="choir director")
    P("ex_student", "Jaylen Brooks", role="former student", trashed="2026-08-01T09:00")
    P("oldneighbor", "Frank Miller", role="old neighbor", trashed="2026-05-01T09:00")
    P("dentist", "Hye-jin Park", role="dentist")
    P("efua_sis", "Esi Owusu", role="Efua's sister", cadence=21, last_contacted="2026-11-09T16:00")
    P("kojo_wife", "Abena Mensah", role="Kojo's wife")

    w.group("house", "House Account", ["efua"])
    w.group("toronto", "Toronto Christmas", ["efua", "akosua", "kwabena", "yaw"], currency="CAD")
    w.group("fantasy", "Fantasy League", ["mike", "dan_o", "kojo", "dan_k"])
    w.group("choir", "Choir Fundraiser", ["adwoa", "fiifi", "efua"])
    w.group("carpool", "Soccer Carpool", ["dan_k", "coach"])
    for name, amt, payer, date in [
        ("Mortgage November", 2150, "me", "2026-11-01"), ("Jewel-Osco groceries", 187.42, "efua", "2026-11-07"),
        ("ComEd electric", 96.30, "me", "2026-11-12"), ("Peoples Gas", 132.75, "efua", "2026-11-14"),
        ("Costco", 264.18, "me", "2026-11-21"), ("Kids' winter boots", 118, "efua", "2026-11-22"),
    ]:
        w.expense("house", name, amt, payer, ["me", "efua"], date)
    tor = ["me", "efua", "akosua", "kwabena", "yaw"]
    w.expense("toronto", "Airbnb in Scarborough", 1450, "akosua", tor, "2026-11-10")
    w.expense("toronto", "Christmas dinner groceries", 380, "me", tor, "2026-11-20")
    w.expense("toronto", "Raptors tickets", 425, "kwabena", tor, "2026-11-18")
    fan = ["me", "mike", "dan_o", "kojo", "dan_k"]
    w.expense("fantasy", "League dues", 250, "mike", fan, "2026-09-01")
    w.expense("fantasy", "Draft night wings", 95, "me", fan, "2026-09-03")
    w.expense("choir", "Bake sale supplies", 72, "me", ["me", "adwoa", "fiifi", "efua"], "2026-11-08")
    w.expense("choir", "Printing flyers", 40, "adwoa", ["me", "adwoa", "fiifi", "efua"], "2026-11-02")
    w.expense("carpool", "Gas for tournament", 54, "dan_k", ["me", "dan_k", "coach"], "2026-11-15")

    w.lst("school", "School", area="teaching")
    w.lst("home", "Home")
    w.lst("kids", "Kids")
    w.lst("church", "Church")

    E = w.event
    for i, start in enumerate(weekly("2026-09-01", "2027-01-26", 1, "16:30")):
        E(f"piano{i}", "Ama piano lesson", start, end=start[:11] + "17:15", attendees=["ama", "sarah_n"], auto=True)
    for i, start in enumerate(weekly("2026-09-05", "2026-11-21", 5, "09:00")):
        E(f"soccer{i}", "Kofi soccer game", start, end=start[:11] + "10:30", attendees=["kofi", "coach"], auto=True)
    for i, start in enumerate(weekly("2026-09-03", "2027-01-28", 3, "19:00")):
        E(f"choirprac{i}", "Choir practice", start, end=start[:11] + "20:30", attendees=["efua", "fiifi"], auto=True)
    E("ptc", "Parent-teacher conferences", "2026-12-03T15:00", end="2026-12-03T19:00")
    E("pediatric", "Kofi checkup with Dr. Patel", "2026-12-02T08:30", end="2026-12-02T09:00",
      attendees=["kofi", "drpatel"])
    E("dentist_ev", "Dentist", "2026-12-09T07:30", end="2026-12-09T08:15", attendees=["dentist"])
    E("recital", "Ama's winter piano recital", "2026-12-13T14:00", attendees=["ama", "sarah_n", "efua"])
    E("drive_tor", "Drive to Toronto", "2026-12-22T06:00", description="8 hours; stop in Detroit")
    E("xmas_tor", "Christmas dinner in Toronto", "2026-12-25T17:00", attendees=["akosua", "kwabena", "yaw"])
    E("drive_home", "Drive back from Toronto", "2026-12-29T07:00")
    E("science_fair", "Science fair judging", "2026-12-05T09:00", end="2026-12-05T13:00",
      attendees=["dan_o", "sarah_l"])
    E("staff", "Staff meeting", "2026-12-01T15:15", attendees=["principal"])
    E("fundraiser", "Choir fundraiser bake sale", "2026-12-06T11:00", attendees=["adwoa", "fiifi", "efua"])
    E("anniv", "Anniversary dinner", "2026-12-12T19:00", attendees=["efua"],
      description="Alinea, 2 people")
    E("haircut", "Haircut with Andre", "2026-11-28T13:00", attendees=["barber"])
    E("oilchange", "Oil change", "2026-11-30T08:00", attendees=["mechanic"])
    E("mortgage_mtg", "Refinance call with Olivia", "2026-12-04T12:30", attendees=["banker"])
    E("thanksgiving", "Thanksgiving at Kojo's", "2026-11-26T15:00", attendees=["kojo", "kojo_wife"])
    E("fantasy_draft", "Fantasy draft night", "2026-09-03T19:00", attendees=["mike", "dan_o", "kojo", "dan_k"])
    E("bears", "Bears game with Mike", "2026-12-06T12:00", attendees=["mike"])
    E("tutoring1", "Kofi math tutoring", "2026-12-01T17:00", attendees=["kofi", "tutor"])
    E("tutoring2", "Kofi math tutoring", "2026-12-08T17:00", attendees=["kofi", "tutor"])
    E("finals", "Finals proctoring", "2026-12-14T08:00", end="2026-12-14T15:00")
    E("yaw_call", "Call with Yaw", "2026-11-29T15:00", attendees=["yaw"])
    E("gala", "District teachers gala", "2026-11-21T18:00", cancelled=True)
    E("ama_bday", "Ama's 10th birthday party", "2027-01-16T13:00", attendees=["ama"])
    E("labsafety", "Lab safety training", "2026-11-17T15:30")
    E("maame_visit", "Pick up Maame at O'Hare", "2027-01-05T12:00", attendees=["maame"])

    T = w.task
    for i, due in enumerate(monthly("2026-01-01", 12)):
        done = due < "2026-11-28"
        T(f"mortgage{i}", "Pay mortgage", due=due, list="home", priority=1,
          **({"status": "completed", "completed": due + "T07:30"} if done else {}))
    T("grade_lab", "Grade titration lab reports", due="2026-11-30", list="school", effort=180, priority=1,
      status="in_progress")
    T("unit_test", "Write stoichiometry unit test", due="2026-12-02", list="school", effort=120)
    T("fair_rubric", "Print science fair rubrics", due="2026-12-04", list="school", effort=20)
    T("lab_order", "Order lab supplies", due="2026-11-20", list="school", effort=30)
    T("rec_letter", "Recommendation letter for Maya", due="2026-12-01", list="school", effort=60, priority=2)
    T("gradebook", "Update gradebook", due="2026-11-25", list="school", status="completed",
      completed="2026-11-25T21:00")
    T("sub_plans", "Sub plans for Toronto trip", due="2026-12-18", list="school", effort=90)
    T("gutters", "Clean the gutters", due="2026-11-29", list="home", effort=120)
    T("snowblower", "Tune up snowblower", due="2026-12-01", list="home", effort=45)
    T("furnace", "Replace furnace filter", due="2026-11-15", list="home", status="completed",
      completed="2026-11-15T10:00")
    T("xmas_lights", "Put up Christmas lights", due="2026-12-05", list="home", effort=90)
    T("refi_docs", "Send refinance documents to Olivia", due="2026-12-03", list="home", priority=1)
    T("winter_tires", "Swap to winter tires", due="2026-11-20", list="home", status="completed",
      completed="2026-11-19T17:00")
    T("passports", "Check kids' passports for Canada", due="2026-12-01", list="kids", priority=1)
    T("recital_dress", "Buy Ama's recital dress", due="2026-12-06", list="kids")
    T("soccer_fee", "Pay spring soccer registration", due="2026-12-15", list="kids")
    T("field_trip", "Sign Kofi's field trip form", due="2026-11-24", list="kids", status="completed",
      completed="2026-11-23T20:00")
    T("bday_party", "Plan Ama's birthday party", due="2027-01-10", list="kids")
    T("bday_invites", "Send birthday invitations", parent="bday_party", list="kids", due="2026-12-20")
    T("bday_cake", "Order birthday cake", parent="bday_party", list="kids", due="2027-01-09")
    T("bday_venue", "Book the bounce house", parent="bday_party", list="kids", status="completed",
      completed="2026-11-10T20:00")
    T("choir_music", "Photocopy choir music", due="2026-12-03", list="church")
    T("bake", "Bake kelewele for the bake sale", due="2026-12-06", list="church", effort=60)
    T("offering", "Count Sunday offering", due="2026-11-22", list="church", status="completed",
      completed="2026-11-22T13:00")
    T("gifts", "Buy Christmas gifts", due="2026-12-15", priority=2)
    T("gift_efua", "Anniversary gift for Efua", due="2026-12-11", priority=1)
    T("call_maame", "Call Maame about January visit", due="2026-11-30")
    T("send_money", "Send money to Yaw for Mom's clinic", due="2026-12-01", priority=1)
    T("taxes_q4", "Estimated tax payment Q4", due="2027-01-15")
    T("cancel_hulu", "Cancel Hulu", status="cancelled")
    T("return_drill", "Return Big Dan's drill", due="2026-11-29")
    T("oldtask", "Fix garage door opener", trashed="2026-10-20T09:00")
    T("fantasy_lineup", "Set fantasy lineup", due="2026-11-29T11:00")
    T("read_book", "Finish Homegoing", status="in_progress")
    T("photobook", "Make family photo book", due="2026-12-20", effort=180)
    w.link("rec_letter", "principal")
    w.link("refi_docs", "banker")
    w.link("call_maame", "maame")
    w.link("send_money", "yaw")
    w.link("return_drill", "dan_k")
    w.link("gift_efua", "efua")
    w.link("recital_dress", "ama")
    w.link("field_trip", "kofi")

    w.notebook("lessons", "Lesson ideas")
    w.notebook("recipes", "Recipes")
    w.notebook("journal", "Journal")
    N = w.note
    N("les1", "Elephant toothpaste demo", "hydrogen peroxide 30%, potassium iodide, dish soap", notebook="lessons",
      created="2026-10-02T20:00")
    N("les2", "Titration lab tweaks", "use phenolphthalein, 0.1M NaOH", notebook="lessons",
      created="2026-11-03T21:00")
    N("les3", "Mole day activities", "mole-themed baking, Avogadro trivia", notebook="lessons",
      created="2026-10-20T19:00")
    N("les4", "Flame test colors", "lithium red, sodium orange, copper green", notebook="lessons",
      created="2026-09-15T20:00")
    N("rec1", "Jollof rice", "long grain rice, tomato paste, scotch bonnet, thyme, bay leaf", notebook="recipes",
      created="2026-02-14T18:00", pinned=True)
    N("rec2", "Kelewele", "ripe plantain, ginger, cayenne, cloves", notebook="recipes", created="2026-03-01T18:00")
    N("rec3", "Groundnut soup", "peanut butter, chicken, tomatoes, onion", notebook="recipes",
      created="2026-01-11T18:00")
    N("rec4", "Efua's shito", "dried shrimp, herring, chili, ginger", notebook="recipes",
      created="2026-05-02T18:00")
    N("jr1", "Kofi scored his first goal", "Nov 7th, left foot, he wouldn't stop grinning", notebook="journal",
      created="2026-11-07T21:00")
    N("jr2", "Thanksgiving thoughts", "grateful for Kojo and Abena's table", notebook="journal",
      created="2026-11-26T23:00")
    N("jr3", "Tough week", "grading pile, Maame's health worries", notebook="journal",
      created="2026-11-13T22:30")
    N("jr4", "Anniversary memories", "12 years; Accra wedding, rain all day", notebook="journal",
      created="2026-11-01T22:00")
    N("gift_list", "Christmas gift list", "Ama: keyboard stand; Kofi: cleats; Efua: kente scarf; Maame: shawl",
      pinned=True, created="2026-11-10T21:00")
    N("refi", "Refinance numbers", "current 6.4%, offer 5.6%, closing costs ~3,100", created="2026-11-19T21:00")
    N("wifi_guest", "Guest wifi instructions", "use the guest network on the fridge magnet",
      created="2026-06-01T10:00")
    N("car_notes", "Car maintenance log", "oil at 48k, tires rotated at 50k", created="2026-08-11T10:00")
    N("toronto_plan", "Toronto trip plan", "leave 22nd 6am, Airbnb in Scarborough, Raptors on 27th",
      created="2026-11-11T21:00")
    N("fantasy_notes", "Fantasy trade ideas", "trade Kelce for a WR2", created="2026-10-28T22:00")
    N("oldnote", "Summer camp options", "YMCA vs park district", trashed="2026-08-20T09:00",
      created="2026-04-01T09:00")
    N("student_notes", "Students to check in with", "Maya (rec letter), DeShawn (missing labs)",
      created="2026-11-16T20:00")
    w.link("jr1", "kofi")
    w.link("refi", "banker")

    w.folder("mortgage", "Mortgage")
    w.folder("kidsdocs", "Kids")
    w.folder("taxes", "Taxes")
    w.folder("schooldocs", "School")
    D = w.doc
    D("deed", "House deed", "4417 N Keeler Ave", folder="mortgage", starred=True, created="2025-12-05T10:00")
    D("mort_stmt", "Mortgage statement October", "balance 311,240", folder="mortgage", created="2026-10-15T10:00")
    D("refi_offer", "Refinance offer letter", "5.6% 30-year", folder="mortgage", created="2026-11-19T12:00")
    D("ama_birth", "Ama birth certificate", "Cook County", folder="kidsdocs", starred=True,
      created="2025-12-10T10:00")
    D("kofi_birth", "Kofi birth certificate", "Cook County", folder="kidsdocs", created="2025-12-10T10:05")
    D("kofi_iep", "Kofi report card Q1", "math B+, reading A", folder="kidsdocs", created="2026-11-06T10:00")
    D("w2", "W-2 2025", "CPS wages", folder="taxes", created="2026-01-30T10:00")
    D("return", "2025 tax return", "joint return", folder="taxes", starred=True, created="2026-04-12T10:00")
    D("syllabus", "Chemistry syllabus 2026-27", "AP Chem", folder="schooldocs", created="2026-08-20T10:00")
    D("contract", "Teaching contract", "CPS 2026-2027", folder="schooldocs", created="2026-08-15T10:00")
    D("lab_msds", "Lab safety data sheets", "MSDS binder", folder="schooldocs", created="2026-09-02T10:00")
    D("insurance", "Car insurance card", "State Farm", starred=True, created="2026-07-01T10:00")
    D("passport_ama", "Ama passport scan", "expires 2027", folder="kidsdocs", created="2026-11-20T10:00")
    D("old_doc", "Old apartment lease", "Rogers Park", trashed="2026-02-01T10:00", created="2025-12-02T10:00")
    D("warranty", "Furnace warranty", "Carrier, 10 years", created="2026-03-03T10:00")

    w.album("family", "Family")
    w.album("soccer_al", "Kofi soccer")
    w.album("recital_al", "Recitals")
    w.album("accra", "Accra 2025")
    Ph = w.photo
    fam = [("Thanksgiving table", "2026-11-26T16:30", ["kojo", "kojo_wife", "efua"]),
           ("Kids raking leaves", "2026-11-08T11:00", ["ama", "kofi"]),
           ("Halloween costumes", "2026-10-31T18:00", ["ama", "kofi"]),
           ("Efua at the lakefront", "2026-09-20T17:00", ["efua"]),
           ("First snow", "2026-11-19T08:00", ["kofi"]), ("Maame on video call", "2026-11-22T17:10", ["maame"])]
    for i, (name, taken, people) in enumerate(fam):
        Ph(f"fam{i}", name, taken, albums=["family"], people=people, starred=(i == 0))
    for i, date in enumerate(weekly("2026-09-05", "2026-11-21", 5, "09:40")):
        Ph(f"soc{i}", f"Kofi soccer {date[5:10]}", date, albums=["soccer_al"], people=["kofi"],
           starred=(date.startswith("2026-11-07")))
    rec = [("Spring recital bow", "2026-05-17T15:00"), ("Ama at the piano", "2026-05-17T14:20"),
           ("Recital flowers", "2026-05-17T15:30")]
    for i, (name, taken) in enumerate(rec):
        Ph(f"rcp{i}", name, taken, albums=["recital_al"], people=["ama"])
    acc = [("Labadi Beach", "2025-12-27T16:00", []), ("Grandma's house in Kumasi", "2025-12-29T12:00", ["maame"]),
           ("Kente weavers", "2025-12-30T10:00", []), ("Yaw and the kids", "2025-12-31T20:00",
                                                        ["yaw", "ama", "kofi"]),
           ("Independence Arch", "2026-01-02T11:00", [])]
    for i, (name, taken, people) in enumerate(acc):
        Ph(f"acc{i}", name, taken, albums=["accra"], people=people)
    Ph("lab_setup", "Titration lab setup", "2026-11-03T08:00")
    Ph("whiteboard", "Whiteboard stoichiometry", "2026-11-12T14:00")
    Ph("receipt", "Receipt Costco", "2026-11-21T12:00")
    Ph("blurry", "Blurry photo", "2026-11-26T19:00", trashed="2026-11-27T09:00")
    Ph("car_dent", "Car dent", "2026-10-14T08:00")

    Db = w.debt
    Db("kojo_tix", "kojo", "owes_me", 120, "Bulls tickets", "2026-11-05")
    Db("mike_dues", "mike", "i_owe", 50, "fantasy dues", "2026-09-01", settled="2026-09-10T09:00")
    Db("dank_snow", "dan_k", "i_owe", 40, "snowblower repair share", "2026-11-18")
    Db("yaw_loan", "yaw", "owes_me", 300, "loan for Mom's clinic visit", "2026-10-01")
    Db("dano_lunch", "dan_o", "owes_me", 14.50, "lunch", "2026-11-19")
    Db("adwoa_flyers", "adwoa", "i_owe", 20, "flyer printing", "2026-11-02")
    Db("esi_gift", "efua_sis", "owes_me", 35, "Maame's birthday gift share", "2026-10-15",
       settled="2026-10-30T12:00")
    Db("tutor_pay", "tutor", "i_owe", 90, "two tutoring sessions", "2026-11-24")

    L = w.locker
    L("wifi", "Home wifi", "wifi", password="Jollof4Life!", starred=True)
    L("school_wifi", "School wifi", "wifi", password="CPSstaff#2026")
    L("guest_wifi", "Guest wifi", "wifi", password="welcome-guest")
    L("bank", "Chase checking", "login", username="kasante", url="https://chase.com", password="K0fi&Ama!")
    L("cps", "CPS staff portal", "login", username="kasante2", url="https://cps.edu", password="Titrate!9")
    L("visa", "Visa card", "card")
    L("passport", "Kwame passport", "passport", notes="Ghana passport, expires 2029")
    L("netflix", "Netflix", "login", username="asante.family@example.com", password="kente-cloth")
    L("espn", "ESPN fantasy", "login", username="kwamechem", password="TD-4-kwame")
    L("alarm", "House alarm code", "note", notes="disarm before 6am")
    L("insurance_lk", "Health insurance", "membership", notes="Blue Cross PPO")
    L("ssh", "School server SSH key", "ssh_key", notes="lab computers")
    return w.done()


# --------------------------------------------------------------------------------------------
# World C — Hana Sato, UX researcher in Seattle; lived in Berlin, travels a lot. Multi-currency.
# --------------------------------------------------------------------------------------------


def world_c() -> dict:
    w = W("Hana Sato", "2026-01-01T09:00", "evalC", "2027-02-01T07:50")
    P = w.person
    P("lukas", "Lukas Brandt", role="partner", starred=True, last_contacted="2027-01-31T22:00")
    P("okaasan", "Yumiko Sato", role="mother", nickname="Okaasan", cadence=7, last_contacted="2027-01-25T06:00",
      last_contacted_kind="call")
    P("kenta", "Kenta Sato", role="brother", cadence=30, last_contacted="2026-12-31T23:50")
    P("mia", "Mia Hoffmann", role="Berlin flatmate", met="Berlin 2023", cadence=30,
      last_contacted="2027-01-10T20:00")
    P("jonas", "Jonas Keller", role="Berlin flatmate", met="Berlin 2023")
    P("priya", "Priya Natarajan", role="coworker", last_contacted="2027-01-29T16:00")
    P("alex_c", "Alex Chen", role="coworker")
    P("alex_m", "Alex Moreno", role="climbing gym")
    P("tom", "Tom Whitaker", role="best friend from uni", met="Edinburgh 2015", cadence=30,
      last_contacted="2026-11-20T21:00")
    P("emily", "Emily Whitaker", role="Tom's wife")
    P("yuki", "Yuki Tanaka", role="childhood friend", met="Kyoto", cadence=60, last_contacted="2026-12-28T12:00")
    P("sensei", "Hiroshi Mori", role="pottery teacher")
    P("drlee", "Grace Lee", role="doctor")
    P("therapist", "Nora Bishop", role="therapist")
    P("landlady", "Ruth Olsen", role="landlady")
    P("vet", "Sam Ferreira", role="vet")
    P("manager", "Diane Foster", role="manager", last_contacted="2027-01-28T11:00")
    P("recruiter", "Kyle Brennan", role="recruiter", trashed="2026-12-01T09:00")
    P("anna", "Anna Schmidt", role="German tutor", cadence=7, last_contacted="2027-01-27T18:00")
    P("oma", "Helga Brandt", role="Lukas's grandmother", nickname="Oma")
    P("lukas_mum", "Petra Brandt", role="Lukas's mother")
    P("marcus", "Marcus Webb", role="neighbor")
    P("sophie", "Sophie Laurent", role="friend", nickname="Soph", starred=True,
      last_contacted="2027-01-30T19:00")
    P("dev", "Dev Malhotra", role="climbing gym", last_contacted="2027-01-26T20:00")
    P("chris", "Chris Park", role="bandmate", trashed="2026-10-01T09:00")

    w.group("berlin", "Berlin Flat", ["mia", "jonas"], currency="EUR")
    w.group("kyoto", "Kyoto New Year", ["okaasan", "kenta", "lukas"], currency="JPY")
    w.group("wedding", "Tom & Emily's wedding", ["tom", "sophie", "lukas"], currency="GBP")
    w.group("home", "Home", ["lukas"], currency="USD")
    w.group("climbing", "Climbing crew", ["dev", "alex_m", "sophie"], currency="USD")
    for name, amt, payer, date in [
        ("Heating bill", 240, "mia", "2026-10-01"), ("Internet Q4", 90, "me", "2026-10-05"),
        ("Broken washing machine", 360, "jonas", "2026-11-02"), ("Farewell dinner", 150, "me", "2026-11-28"),
    ]:
        w.expense("berlin", name, amt, payer, ["me", "mia", "jonas"], date)
    ky = ["me", "okaasan", "kenta", "lukas"]
    w.expense("kyoto", "Ryokan in Arashiyama", 96000, "me", ky, "2026-12-29")
    w.expense("kyoto", "Osechi box", 32000, "okaasan", ky, "2026-12-31")
    w.expense("kyoto", "Shinkansen tickets", 56000, "kenta", ky, "2026-12-28")
    w.expense("kyoto", "Kaiseki dinner", 48000, "lukas", ky, "2027-01-02")
    wd = ["me", "tom", "sophie", "lukas"]
    w.expense("wedding", "Cottage in the Cotswolds", 880, "sophie", wd, "2026-08-20")
    w.expense("wedding", "Group gift", 200, "me", wd, "2026-08-22")
    w.expense("wedding", "Train to Oxford", 96, "lukas", wd, "2026-08-21")
    for name, amt, payer, date in [
        ("Rent January", 3100, "me", "2027-01-01"), ("PCC groceries", 164.50, "lukas", "2027-01-09"),
        ("Seattle City Light", 88.40, "me", "2027-01-15"), ("PCC groceries", 121.30, "me", "2027-01-23"),
        ("Couch", 1400, "lukas", "2027-01-12"),
    ]:
        w.expense("home", name, amt, payer, ["me", "lukas"], date)
    w.expense("climbing", "Gym day passes", 88, "dev", ["me", "dev", "alex_m", "sophie"], "2027-01-19")
    w.expense("climbing", "Post-climb pho", 64, "me", ["me", "dev", "alex_m", "sophie"], "2027-01-19")

    w.lst("work", "Work", area="research")
    w.lst("homel", "Home")
    w.lst("german", "German practice")

    E = w.event
    for i, start in enumerate(weekly("2026-11-02", "2027-03-29", 0, "18:00")):
        E(f"german{i}", "German lesson with Anna", start, end=start[:11] + "19:00", attendees=["anna"], auto=True)
    for i, start in enumerate(weekly("2026-11-04", "2027-03-31", 2, "19:30")):
        E(f"climb{i}", "Climbing at Vertical World", start, end=start[:11] + "21:30", attendees=["dev", "alex_m"], auto=True)
    for i, start in enumerate(weekly("2026-12-03", "2027-02-25", 3, "17:00")):
        E(f"therapy{i}", "Therapy", start, end=start[:11] + "17:50", attendees=["therapist"], auto=True)
    E("studyreadout", "Usability study readout", "2027-02-03T14:00", end="2027-02-03T15:00",
      attendees=["priya", "alex_c", "manager"])
    E("interviews", "Participant interviews", "2027-02-04T09:00", end="2027-02-04T16:00")
    E("pottery", "Pottery with Mori-sensei", "2027-02-06T10:00", attendees=["sensei"])
    E("doctor", "Annual physical with Dr. Lee", "2027-02-10T08:30", attendees=["drlee"])
    E("vet_ev", "Mochi vet appointment", "2027-02-02T12:00", attendees=["vet"],
      description="Mochi the cat, dental cleaning")
    E("valentines", "Valentine's dinner", "2027-02-14T19:30", attendees=["lukas"])
    E("berlin_trip", "Flight to Berlin", "2027-03-12T13:25", description="LH 491 SEA-FRA")
    E("oma_bday", "Oma's 90th birthday", "2027-03-14T15:00", attendees=["oma", "lukas", "lukas_mum"])
    E("return_flight", "Flight back to Seattle", "2027-03-20T11:00")
    E("kyoto_ny", "New Year in Kyoto", "2026-12-28T10:00", end="2027-01-04T10:00",
      attendees=["okaasan", "kenta", "lukas"])
    E("tom_call", "Call with Tom", "2027-02-07T11:00", attendees=["tom"])
    E("sophie_brunch", "Brunch with Sophie", "2027-01-31T11:00", attendees=["sophie"])
    E("lease_sign", "Lease renewal signing", "2027-02-15T10:00", attendees=["landlady"])
    E("allhands", "All-hands", "2027-02-05T10:00")
    E("perf", "Performance review with Diane", "2027-02-09T13:00", attendees=["manager"])
    E("concert", "Japanese Breakfast concert", "2027-02-20T20:00", attendees=["sophie"])
    E("yoga", "Yoga retreat", "2027-01-16T09:00", cancelled=True)
    E("dentist_c", "Dentist", "2027-01-20T09:00")
    E("okaasan_call", "Call Okaasan", "2027-02-01T18:00", attendees=["okaasan"])
    E("wedding_ev", "Tom & Emily's wedding", "2026-08-22T14:00", attendees=["tom", "emily", "sophie", "lukas"])

    T = w.task
    for i, due in enumerate(monthly("2026-02-01", 14)):
        done = due < "2027-02-01"
        T(f"rent{i}", "Pay rent", due=due, list="homel", priority=1,
          **({"status": "completed", "completed": due + "T09:00"} if done else {}))
    T("readout_deck", "Finish readout deck", due="2027-02-02T17:00", list="work", priority=1, effort=180,
      status="in_progress")
    T("recruit", "Recruit 6 participants", due="2027-01-29", list="work", status="completed",
      completed="2027-01-28T15:00")
    T("consent", "Print consent forms", due="2027-02-03", list="work", effort=15)
    T("synth", "Synthesize interview notes", due="2027-02-08", list="work", effort=240)
    T("selfreview", "Write self-review", due="2027-02-05", list="work", effort=90, priority=2)
    T("expenses_c", "File travel expenses", due="2027-01-20", list="work", effort=30)
    T("gift_oma", "Buy gift for Oma's 90th", due="2027-03-01", priority=2)
    T("visa", "Check ESTA/visa for Lukas", status="cancelled")
    T("mochi_food", "Order Mochi's food", due="2027-02-02", list="homel", effort=10)
    T("taxes", "Gather tax documents", due="2027-02-28", list="homel", effort=60)
    T("fbar", "File FBAR for German account", due="2027-04-15", priority=1)
    T("close_acct", "Close Berlin bank account", due="2027-03-16")
    T("anmeldung", "Deregister Berlin address", status="completed", completed="2026-12-02T10:00")
    T("vocab", "Learn 50 new German words", list="german", status="in_progress", effort=300)
    T("dativ", "Dativ exercises chapter 7", due="2027-02-01", list="german", effort=45)
    T("podcast", "Listen to Easy German podcast", list="german")
    T("couch", "Sell the old couch", due="2027-01-31", list="homel", status="completed",
      completed="2027-01-30T16:00")
    T("plants", "Repot the monstera", due="2027-02-07", list="homel", effort=30)
    T("lease", "Review lease renewal terms", due="2027-02-12", list="homel", priority=2)
    T("thank_tom", "Send Tom wedding photos", due="2026-09-15", status="completed", completed="2026-09-10T20:00")
    T("kyoto_photos", "Share Kyoto photos with Kenta", due="2027-01-15")
    T("pottery_glaze", "Pick up glazed bowls", due="2027-02-06")
    T("trashed_t", "Book yoga retreat", trashed="2027-01-05T09:00")
    T("oma_card", "Write card for Oma", parent="gift_oma", due="2027-03-01")
    T("oma_frame", "Frame the family photo", parent="gift_oma", due="2027-02-25")
    w.link("thank_tom", "tom")
    w.link("kyoto_photos", "kenta")
    w.link("gift_oma", "oma")

    w.notebook("research", "Research")
    w.notebook("german_nb", "Deutsch")
    w.notebook("recipes", "Recipes")
    w.notebook("diary", "Journal")
    N = w.note
    N("rs1", "Onboarding study plan", "6 participants, 45 min, think-aloud", notebook="research",
      created="2027-01-12T10:00")
    N("rs2", "Interview guide", "warm-up, tasks, debrief", notebook="research", created="2027-01-18T10:00")
    N("rs3", "Pilot session notes", "task 3 too long; rephrase", notebook="research", created="2027-01-26T16:00")
    N("de1", "Dativ prepositions", "aus, bei, mit, nach, seit, von, zu", notebook="german_nb",
      created="2026-11-10T19:00", pinned=True)
    N("de2", "Useful phrases for Oma", "Herzlichen Glückwunsch zum Geburtstag", notebook="german_nb",
      created="2027-01-20T19:00")
    N("re1", "Okaasan's nikujaga", "beef, potatoes, onion, dashi, mirin, soy", notebook="recipes",
      created="2026-12-30T20:00")
    N("re2", "Lukas's Käsespätzle", "flour, eggs, Emmentaler, fried onions", notebook="recipes",
      created="2026-11-15T20:00")
    N("re3", "Miso soup", "dashi, white miso, tofu, wakame", notebook="recipes", created="2026-10-01T20:00")
    N("dy1", "Last night in Kyoto", "Temple bells at midnight, Okaasan cried a little", notebook="diary",
      created="2027-01-03T23:30")
    N("dy2", "Moving out of Berlin", "Mia made a playlist; Jonas fixed nothing", notebook="diary",
      created="2026-11-29T23:00")
    N("dy3", "January blues", "grey for 20 days straight", notebook="diary", created="2027-01-22T22:00")
    N("packing", "Berlin packing list", "adapter, gift for Oma, warm boots", pinned=True, created="2027-01-28T21:00")
    N("gift_ideas", "Gift ideas for Oma", "photo book, Japanese tea set, cashmere scarf", created="2027-01-15T21:00")
    N("wifi_note", "Router setup", "mesh in hallway", created="2026-06-01T10:00")
    N("oldnote_c", "Moving boxes", "count: 23", trashed="2026-12-10T09:00", created="2026-11-20T09:00")
    w.link("de2", "oma")
    w.link("gift_ideas", "oma")
    w.link("re1", "okaasan")

    w.folder("immigration", "Immigration")
    w.folder("taxes_c", "Taxes")
    w.folder("apartment", "Apartment")
    D = w.doc
    D("greencard", "Green card copy", "permanent resident card", folder="immigration", starred=True,
      created="2026-01-05T10:00")
    D("anmeldung_doc", "Abmeldebestätigung", "Berlin deregistration", folder="immigration",
      created="2026-12-02T12:00")
    D("w2_c", "W-2 2026", "wages", folder="taxes_c", created="2027-01-28T10:00")
    D("german_tax", "German tax statement 2026", "Lohnsteuerbescheinigung", folder="taxes_c",
      created="2027-01-20T10:00")
    D("lease_c", "Lease 2026", "Capitol Hill apt 4C", folder="apartment", starred=True, created="2026-02-01T10:00")
    D("renewal", "Lease renewal offer", "rent +4%", folder="apartment", created="2027-01-14T10:00")
    D("mochi_vax", "Mochi vaccination record", "FVRCP", created="2026-06-12T10:00")
    D("ryokan", "Ryokan booking confirmation", "Arashiyama, 2 nights", created="2026-11-01T10:00")
    D("berlin_flight", "Berlin flight booking", "LH 491", created="2027-01-18T10:00")
    D("old_c", "Old Berlin lease", "Neukölln", trashed="2026-12-05T10:00", created="2026-01-10T10:00")

    w.album("kyoto_al", "Kyoto 2026")
    w.album("berlin_al", "Berlin")
    w.album("mochi_al", "Mochi")
    w.album("wedding_al", "Tom & Emily")
    Ph = w.photo
    for i, (name, taken, people) in enumerate([
        ("Fushimi Inari gates", "2026-12-29T09:00", ["lukas"]), ("Arashiyama bamboo", "2026-12-30T08:30", []),
        ("Okaasan making mochi", "2026-12-31T11:00", ["okaasan"]), ("Joya no kane", "2026-12-31T23:55", ["kenta"]),
        ("Hatsumode at Yasaka", "2027-01-01T10:00", ["okaasan", "kenta", "lukas"]),
        ("Kaiseki dinner", "2027-01-02T19:00", ["lukas"]), ("Kamo river", "2027-01-03T16:00", [])]):
        Ph(f"ky{i}", name, taken, albums=["kyoto_al"], people=people, starred=(i == 4))
    for i, (name, taken, people) in enumerate([
        ("Tempelhofer Feld", "2026-06-14T18:00", ["mia"]), ("Flat party", "2026-09-19T23:00", ["mia", "jonas"]),
        ("Last Späti beer", "2026-11-28T22:00", ["jonas"]), ("Christmas market", "2025-12-10T19:00", ["lukas"])]):
        Ph(f"be{i}", name, taken, albums=["berlin_al"], people=people)
    for i, (name, taken) in enumerate([("Mochi in the box", "2026-02-10T20:00"), ("Mochi at the window", "2026-07-01T08:00"),
                                        ("Mochi and Lukas", "2027-01-24T21:00")]):
        Ph(f"mo{i}", name, taken, albums=["mochi_al"], people=(["lukas"] if "Lukas" in name else []),
           starred=(i == 1))
    for i, (name, taken, people) in enumerate([
        ("First dance", "2026-08-22T20:00", ["tom", "emily"]), ("Cotswolds cottage", "2026-08-21T12:00", []),
        ("Us at the wedding", "2026-08-22T18:00", ["lukas"])]):
        Ph(f"we{i}", name, taken, albums=["wedding_al"], people=people)
    Ph("whiteboard_c", "Affinity map", "2027-01-27T15:00")
    Ph("snow", "Snow on Capitol Hill", "2027-01-13T08:00", starred=True)
    Ph("bowl", "Pottery bowl", "2027-01-23T12:00")
    Ph("trash_ph", "Accidental screenshot", "2027-01-19T10:00", trashed="2027-01-19T10:05")

    Db = w.debt
    Db("sophie_tix", "sophie", "owes_me", 75, "concert tickets", "2027-01-15")
    Db("dev_rope", "dev", "i_owe", 45, "half a rope", "2027-01-05")
    Db("priya_lunch", "priya", "owes_me", 16.75, "lunch", "2027-01-29")
    Db("kenta_loan", "kenta", "owes_me", 250, "flight top-up", "2026-12-20", settled="2027-01-10T10:00")
    Db("alexm_shoes", "alex_m", "owes_me", 30, "used climbing shoes", "2027-01-19")
    Db("anna_lessons", "anna", "i_owe", 120, "four German lessons", "2027-01-26")

    L = w.locker
    L("wifi_c", "Home wifi", "wifi", password="mochi-neko-42", starred=True)
    L("office_wifi", "Office wifi", "wifi", password="ResearchOps!")
    L("n26", "N26 Berlin account", "bank_account", notes="closing in March")
    L("chase_c", "Chase checking", "login", username="hsato", url="https://chase.com", password="Kyoto#2026")
    L("passport_jp", "Japanese passport", "passport", notes="expires 2030")
    L("greencard_lk", "Green card", "identity")
    L("figma", "Figma", "login", username="hana@work.example", password="Prototype!7")
    L("visa_c", "Visa card", "card")
    L("miles", "Lufthansa Miles & More", "membership", notes="number in notes app")
    L("door", "Building door code", "note", notes="front door 4C")
    return w.done()


# --------------------------------------------------------------------------------------------
# World D (large) — Marisol Reyes-Kapoor, family of four in Montclair NJ, three years of history.
# --------------------------------------------------------------------------------------------


def world_d() -> dict:
    rng = random.Random(20261220)
    w = W("Marisol Reyes-Kapoor", "2024-01-02T09:00", "evalD", "2026-12-20T19:40")
    P = w.person
    P("dev", "Dev Kapoor", role="husband", starred=True, last_contacted="2026-12-20T18:00")
    P("lucia", "Lucía Reyes-Kapoor", role="daughter", nickname="Lulu")
    P("arun", "Arun Reyes-Kapoor", role="son")
    P("mama", "Carmen Reyes", role="mother", nickname="Mamá", cadence=7, starred=True,
      last_contacted="2026-12-14T11:00", last_contacted_kind="call")
    P("papa", "Jorge Reyes", role="father", cadence=7, last_contacted="2026-12-14T11:00")
    P("sunita", "Sunita Kapoor", role="mother-in-law", cadence=14, last_contacted="2026-12-06T10:00")
    P("rajesh", "Rajesh Kapoor", role="father-in-law")
    P("gabi", "Gabriela Reyes", role="sister", nickname="Gabi", cadence=7, starred=True,
      last_contacted="2026-12-19T21:00")
    P("tio", "Ernesto Reyes", role="uncle in Guadalajara", nickname="Tío Neto", cadence=60,
      last_contacted="2026-10-02T12:00")
    first = ["Emma", "Olivia", "Ava", "Sophia", "Mia", "Liam", "Noah", "Ethan", "Mason", "Lucas", "Isabella",
             "Harper", "Amelia", "Aiden", "Elijah", "Grace", "Chloe", "Zoe", "Nora", "Leah", "Sam", "Maya",
             "Priya", "Rohan", "Anika", "Diego", "Camila", "Valeria", "Mateo", "Santiago", "Hannah", "Rachel",
             "David", "Daniel", "Sarah", "Julia", "Ben", "Kevin", "Laura", "Jessica", "Omar", "Fatima", "Yusuf",
             "Mei", "Wei", "Kenji", "Aisha", "Tariq", "Nadia", "Ines"]
    last = ["Johnson", "Williams", "Brown", "Garcia", "Martinez", "Nguyen", "Kim", "Patel", "Shah", "Cohen",
            "Rossi", "Murphy", "O'Connor", "Silva", "Lopez", "Hernandez", "Singh", "Chen", "Wong", "Ali",
            "Fischer", "Novak", "Kowalski", "Russo", "Dubois", "Park", "Mehta", "Iyer", "Costa", "Moreau"]
    roles = ["Lucía's classmate's parent", "Arun's classmate's parent", "neighbor", "coworker", "PTA",
             "soccer parent", "book club", "college friend", "gym", "church", "Dev's coworker",
             "contractor", "doctor", "teacher", "babysitter", "friend"]
    used = set()
    people_keys = []
    for i in range(170):
        while True:
            name = f"{rng.choice(first)} {rng.choice(last)}"
            if name not in used:
                break
        used.add(name)
        key = f"pp{i}"
        kw = {"role": rng.choice(roles)}
        if rng.random() < 0.4:
            day = dt.date(2026, 12, 20) - dt.timedelta(days=rng.randint(1, 400))
            kw["last_contacted"] = f"{day.isoformat()}T{rng.randint(8, 21):02d}:00"
        if rng.random() < 0.08:
            kw["starred"] = True
        if rng.random() < 0.03:
            kw["trashed"] = "2026-06-01T09:00"
        P(key, name, **kw)
        people_keys.append(key)
    # hand-written people the sessions talk about
    P("ms_ortiz", "Rebecca Ortiz", role="Lucía's teacher")
    P("coach_d", "Mike Donnelly", role="Arun's soccer coach", nickname="Coach Mike")
    P("dr_shah", "Anjali Shah", role="pediatrician")
    P("dentist_d", "Paul Russo", role="dentist")
    P("nanny", "Rosa Delgado", role="babysitter", starred=True, last_contacted="2026-12-18T17:00")
    P("boss", "Karen Liu", role="manager", last_contacted="2026-12-18T16:00")
    P("contractor", "Vinnie Esposito", role="contractor", last_contacted="2026-11-30T09:00")
    P("kavya", "Kavya Kapoor", role="Dev's cousin")
    P("kavya2", "Kavya Menon", role="PTA co-chair", last_contacted="2026-12-10T19:00")
    P("liz", "Liz Carter", role="best friend", starred=True, cadence=14, last_contacted="2026-12-05T20:00")

    groups = [("house", "House", ["dev"], "USD"),
              ("gdl", "Guadalajara Christmas", ["dev", "mama", "papa", "gabi", "tio"], "MXN"),
              ("pta", "PTA Winter Fair", ["kavya2", "pp3", "pp7", "pp11"], "USD"),
              ("beach", "LBI Beach House 2026", ["dev", "liz", "pp20", "pp21"], "USD"),
              ("soccer", "U10 Soccer Team Snacks", ["coach_d", "pp30", "pp31", "pp32"], "USD"),
              ("bookclub", "Montclair Book Club", ["liz", "pp40", "pp41", "pp42"], "USD"),
              ("gabi_bday", "Gabi's 40th", ["gabi", "liz", "dev"], "USD"),
              ("ski", "Vermont Ski Weekend", ["dev", "liz", "pp20"], "USD"),
              ("carpool", "School Carpool", ["pp50", "pp51"], "USD"),
              ("office", "Office Coffee Fund", ["boss", "pp60", "pp61"], "USD"),
              ("dinner", "Supper Club", ["liz", "pp20", "pp21", "pp40"], "USD")]
    for key, name, members, cur in groups:
        w.group(key, name, members, currency=cur)
    expense_names = {
        "house": ["ShopRite groceries", "PSE&G", "Water bill", "Verizon Fios", "Home Depot", "Target run",
                  "Whole Foods", "Costco"],
        "pta": ["Raffle prizes", "Hot cocoa supplies", "Face paint", "Printing"],
        "beach": ["Rental deposit", "Groceries", "Boat rental", "Ice cream"],
        "soccer": ["Orange slices", "Juice boxes", "Granola bars"],
        "bookclub": ["Wine", "Cheese board"],
        "gabi_bday": ["Restaurant deposit", "Cake", "Balloons"],
        "ski": ["Condo", "Lift tickets", "Gas"],
        "carpool": ["Gas", "Car wash"],
        "office": ["Coffee beans", "Oat milk"],
        "dinner": ["Paella night", "Taco night", "Curry night"],
    }
    member_of = {key: ["me"] + members for key, _, members, _ in groups}
    for key, names in expense_names.items():
        count = 140 if key == "house" else 10
        for i in range(count):
            day = dt.date(2024, 2, 1) + dt.timedelta(days=rng.randint(0, 1050))
            if day >= dt.date(2026, 12, 20):
                day = dt.date(2026, 12, 19)
            payer = rng.choice(member_of[key])
            amount = round(rng.uniform(8, 260), 2) if key != "beach" else round(rng.uniform(40, 900), 2)
            w.expense(key, rng.choice(names), amount, payer, member_of[key], day.isoformat())
    for name, amount, payer, date in [("Posada supplies", 3200, "mama", "2026-12-15"),
                                      ("Tamales order", 1850, "me", "2026-12-18"),
                                      ("Airport shuttle", 1200, "dev", "2026-12-19"),
                                      ("Mariachi deposit", 4500, "tio", "2026-12-10")]:
        w.expense("gdl", name, amount, payer, member_of["gdl"], date)

    w.lst("home_l", "Home")
    w.lst("kids_l", "Kids")
    w.lst("work_l", "Work", area="job")
    w.lst("pta_l", "PTA")
    w.lst("reno_l", "Kitchen renovation")
    w.lst("xmas_l", "Christmas")

    E = w.event
    for i, start in enumerate(weekly("2024-09-03", "2027-06-15", 1, "17:30")):
        E(f"soccer_prac{i}", "Arun soccer practice", start, end=start[:11] + "18:45", attendees=["arun", "coach_d"], auto=True)
    for i, start in enumerate(weekly("2024-09-04", "2027-06-16", 2, "16:00")):
        E(f"ballet{i}", "Lucía ballet", start, end=start[:11] + "17:00", attendees=["lucia"], auto=True)
    for i, start in enumerate(weekly("2024-01-08", "2027-03-29", 0, "09:30")):
        E(f"standup{i}", "Team standup", start, end=start[:11] + "09:45", attendees=["boss"], auto=True)
    for i, start in enumerate(weekly("2024-01-06", "2027-01-30", 5, "10:00")):
        E(f"call_mama{i}", "Call Mamá", start, end=start[:11] + "10:30", attendees=["mama"], auto=True)
    for i, start in enumerate(weekly("2025-01-09", "2026-12-17", 3, "19:00")):
        if i % 4 == 0:
            E(f"bookclub_ev{i}", "Book club", start, end=start[:11] + "21:00", attendees=["liz"], auto=True)
    one_offs = [
        ("xmas_eve", "Nochebuena dinner", "2026-12-24T20:00", ["mama", "papa", "gabi", "tio"], None),
        ("flight_gdl", "Flight to Guadalajara", "2026-12-22T07:15", [], "UA 1511 EWR-GDL"),
        ("flight_home", "Flight home from Guadalajara", "2027-01-02T13:40", [], None),
        ("posada", "Posada at Tío Neto's", "2026-12-23T19:00", ["tio", "gabi"], None),
        ("winter_fair", "PTA Winter Fair", "2026-12-12T10:00", ["kavya2"], None),
        ("recital", "Lucía's winter ballet recital", "2026-12-21T18:00", ["lucia"], None),
        ("dentist_kids", "Kids dentist cleaning", "2026-12-21T08:00", ["lucia", "arun", "dentist_d"], None),
        ("pediatric", "Arun checkup with Dr. Shah", "2027-01-08T15:30", ["arun", "dr_shah"], None),
        ("reno_meeting", "Kitchen walkthrough with Vinnie", "2027-01-05T08:00", ["contractor"], None),
        ("perf_d", "Year-end review with Karen", "2026-12-18T14:00", ["boss"], None),
        ("office_party", "Office holiday party", "2026-12-17T18:00", ["boss"], None),
        ("gabi_party", "Gabi's 40th birthday party", "2027-01-16T19:00", ["gabi", "liz"], None),
        ("ski_trip", "Vermont ski weekend", "2027-02-12T16:00", ["dev", "liz"], None),
        ("date_night", "Date night", "2026-12-27T19:00", ["dev"], None),
        ("nye", "New Year's Eve at the Carters", "2026-12-31T20:00", ["liz"], None),
        ("school_back", "School starts again", "2027-01-04T08:15", [], None),
        ("teacher_conf", "Conference with Ms. Ortiz", "2027-01-12T16:00", ["ms_ortiz"], None),
        ("cancelled_spa", "Spa day", "2026-12-19T11:00", [], "cancelled"),
        ("beach_trip", "LBI beach week", "2026-07-11T15:00", ["dev", "liz"], None),
        ("mechanic_d", "Honda 60k service", "2026-12-28T09:00", [], None),
    ]
    for key, name, start, att, extra in one_offs:
        kw = {"attendees": att}
        if extra == "cancelled":
            kw["cancelled"] = True
        elif extra:
            kw["description"] = extra
        E(key, name, start, **kw)
    misc_events = ["Dentist", "Haircut", "Pediatrician", "Parent-teacher conference", "Birthday party",
                   "Dinner with Liz", "Costco trip", "Car inspection", "Vet", "Playdate", "Orthodontist",
                   "Piano recital", "School concert", "Museum trip", "Brunch with Gabi", "Movie night",
                   "Yoga", "Farmers market", "Swim lesson", "Home Depot run", "Doctor appointment"]
    for i in range(420):
        day = dt.date(2024, 1, 5) + dt.timedelta(days=rng.randint(0, 1100))
        hour = rng.choice([8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19])
        name = rng.choice(misc_events)
        kw = {}
        if rng.random() < 0.05:
            kw["cancelled"] = True
        E(f"ev{i}", name, f"{day.isoformat()}T{hour:02d}:{rng.choice(['00', '30'])}", auto=True, **kw)

    T = w.task
    for i, due in enumerate(monthly("2024-02-01", 36)):
        done = due < "2026-12-20"
        T(f"mort{i}", "Pay mortgage", due=due, list="home_l", priority=1,
          **({"status": "completed", "completed": due + "T08:00"} if done else {}))
    task_names = ["Schedule dentist", "Buy birthday present", "Return library books", "Clean gutters",
                  "Order school supplies", "Renew car registration", "Pay water bill", "Book babysitter",
                  "Sign permission slip", "Update budget spreadsheet", "Call the insurance company",
                  "Fix squeaky door", "Buy groceries", "Plan weekend", "Send thank-you card", "Pick up prescription",
                  "Donate old clothes", "Change smoke detector batteries", "Wash the car", "Book flights",
                  "Email Ms. Ortiz", "Write quarterly report", "Review contract", "Prepare slides",
                  "Submit timesheet", "Order new filters", "Mow the lawn", "Rake leaves", "Organize garage",
                  "Buy soccer cleats", "Pay credit card", "Refill propane"]
    lists_for = {"Email Ms. Ortiz": "kids_l", "Sign permission slip": "kids_l", "Buy soccer cleats": "kids_l",
                 "Write quarterly report": "work_l", "Review contract": "work_l", "Prepare slides": "work_l",
                 "Submit timesheet": "work_l"}
    for i in range(760):
        name = rng.choice(task_names)
        due = dt.date(2024, 1, 10) + dt.timedelta(days=rng.randint(0, 1080))
        kw = {"due": due.isoformat()}
        if name in lists_for:
            kw["list"] = lists_for[name]
        elif rng.random() < 0.4:
            kw["list"] = "home_l"
        if due < dt.date(2026, 12, 20) and rng.random() < 0.93:
            kw["status"] = "completed"
            kw["completed"] = (due - dt.timedelta(days=rng.randint(0, 3))).isoformat() + "T19:00"
        if rng.random() < 0.15:
            kw["effort"] = rng.choice([10, 15, 30, 45, 60, 90, 120])
        if rng.random() < 0.1:
            kw["priority"] = rng.randint(1, 5)
        if rng.random() < 0.02:
            kw["trashed"] = "2026-12-01T09:00"
        T(f"tk{i}", name, **kw)
    hand_tasks = [
        ("pack_gdl", "Pack for Guadalajara", {"due": "2026-12-21", "list": "xmas_l", "priority": 1, "effort": 120}),
        ("gifts_kids", "Wrap the kids' presents", {"due": "2026-12-23", "list": "xmas_l", "effort": 90}),
        ("tamales", "Confirm tamales order", {"due": "2026-12-21", "list": "xmas_l"}),
        ("passports_d", "Find the kids' passports", {"due": "2026-12-21", "list": "xmas_l", "priority": 1}),
        ("cards", "Mail Christmas cards", {"due": "2026-12-15", "list": "xmas_l", "status": "completed",
                                           "completed": "2026-12-14T20:00"}),
        ("mama_gift", "Buy Mamá's gift", {"due": "2026-12-19", "list": "xmas_l", "status": "completed",
                                         "completed": "2026-12-19T15:00"}),
        ("recital_flowers", "Get flowers for Lucía's recital", {"due": "2026-12-21", "list": "kids_l"}),
        ("cabinets", "Choose kitchen cabinet color", {"due": "2027-01-05", "list": "reno_l", "priority": 2}),
        ("permit", "Pull the kitchen permit", {"due": "2027-01-10", "list": "reno_l"}),
        ("appliances", "Order appliances", {"due": "2027-01-15", "list": "reno_l", "effort": 60}),
        ("backsplash", "Pick backsplash tile", {"list": "reno_l"}),
        ("reno_budget", "Finalize renovation budget", {"due": "2026-12-22", "list": "reno_l",
                                                       "status": "in_progress"}),
        ("fair_volunteers", "Thank Winter Fair volunteers", {"due": "2026-12-19", "list": "pta_l"}),
        ("fair_money", "Deposit Winter Fair cash", {"due": "2026-12-16", "list": "pta_l", "status": "completed",
                                                   "completed": "2026-12-15T10:00"}),
        ("q4report", "Write Q4 board report", {"due": "2027-01-08", "list": "work_l", "priority": 1,
                                                "effort": 240}),
        ("oof", "Set out-of-office reply", {"due": "2026-12-21", "list": "work_l", "effort": 5}),
        ("nanny_pay", "Pay Rosa for December", {"due": "2026-12-22"}),
        ("fsa", "Use up FSA money", {"due": "2026-12-31", "priority": 2}),
        ("gabi_gift", "Plan Gabi's 40th surprise", {"due": "2027-01-10"}),
        ("gabi_video", "Collect video messages for Gabi", {"due": "2027-01-08", "parent": "gabi_gift"}),
        ("gabi_venue", "Book the restaurant for Gabi", {"due": "2026-12-30", "parent": "gabi_gift"}),
        ("ski_rental", "Reserve ski rentals", {"due": "2027-01-20"}),
        ("water_plants", "Ask Liz to water plants", {"due": "2026-12-21", "status": "completed",
                                                     "completed": "2026-12-18T20:00"}),
    ]
    for key, name, kw in hand_tasks:
        T(key, name, **kw)
    w.link("nanny_pay", "nanny")
    w.link("water_plants", "liz")
    w.link("gabi_gift", "gabi")
    w.link("recital_flowers", "lucia")

    w.notebook("journal_d", "Journal")
    w.notebook("recipes_d", "Recipes")
    w.notebook("reno_nb", "Renovation")
    w.notebook("work_nb", "Work")
    w.notebook("kids_nb", "Kids")
    w.notebook("travel_nb", "Travel")
    w.notebook("garden_nb", "Garden")
    w.notebook("health_nb", "Health")
    w.notebook("ideas_nb", "Ideas")
    w.notebook("pta_nb", "PTA")
    N = w.note
    journal_topics = ["Long day", "Kids were angels", "Tired", "Good run this morning", "Snow day",
                      "Mamá called", "Work stress", "Date night", "Sunday pancakes", "Grateful",
                      "Lucía lost a tooth", "Arun's goal", "Rainy day", "Quiet evening", "Busy week"]
    nb_topics = {"recipes_d": ["Pozole", "Chicken tikka", "Arroz con leche", "Dal makhani", "Chilaquiles",
                               "Banana bread", "Enchiladas verdes", "Aloo gobi", "Flan", "Rajma"],
                 "reno_nb": ["Cabinet quotes", "Countertop options", "Lighting plan", "Flooring samples"],
                 "work_nb": ["Meeting notes", "Project ideas", "1:1 with Karen", "Q3 retro", "Hiring notes"],
                 "kids_nb": ["Lucía's sizes", "Arun's allergies", "Summer camp options", "Chore chart"],
                 "travel_nb": ["Guadalajara packing list", "LBI house rules", "Vermont ski tips", "Passport renewals"],
                 "garden_nb": ["Tomato planting", "Hydrangea care", "Compost ratio"],
                 "health_nb": ["Blood pressure log", "Physical therapy exercises"],
                 "ideas_nb": ["Gift ideas", "Weekend ideas", "Blog post ideas"],
                 "pta_nb": ["Winter Fair plan", "Volunteer list", "Fundraising ideas"]}
    for i in range(160):
        day = dt.date(2024, 1, 10) + dt.timedelta(days=rng.randint(0, 1070))
        N(f"jn{i}", rng.choice(journal_topics), "…", notebook="journal_d", created=f"{day.isoformat()}T22:00")
    ncount = 0
    for nb, topics in nb_topics.items():
        for topic in topics:
            for rep in range(rng.randint(1, 4)):
                day = dt.date(2024, 1, 10) + dt.timedelta(days=rng.randint(0, 1070))
                name = topic if rep == 0 else f"{topic} {rep + 1}"
                N(f"nn{ncount}", name, f"notes on {topic.lower()}", notebook=nb, created=f"{day.isoformat()}T20:00")
                ncount += 1
    N("xmas_menu", "Nochebuena menu", "bacalao, romeritos, ponche, tamales from Doña Lupe", pinned=True,
      created="2026-12-10T21:00")
    N("gdl_list", "Guadalajara shopping list", "cajeta for Liz, huaraches for Arun, piñata", pinned=True,
      created="2026-12-15T21:00", notebook="travel_nb")
    N("reno_quote", "Vinnie's quote", "demo 4k, cabinets 18k, counters 7k, labor 12k", notebook="reno_nb",
      created="2026-11-30T12:00")
    N("gabi_ideas", "Gabi 40th ideas", "surprise dinner at Faubourg, slideshow, mariachi?", created="2026-12-01T22:00")
    N("wifi_d", "Wifi extender setup", "extender in the basement", created="2025-03-01T10:00")
    w.link("gabi_ideas", "gabi")

    w.folder("house_f", "House")
    w.folder("taxes_f", "Taxes")
    w.folder("kids_f", "Kids")
    w.folder("medical_f", "Medical")
    w.folder("work_f", "Work")
    w.folder("travel_f", "Travel")
    w.folder("insurance_f", "Insurance")
    w.folder("reno_f", "Renovation")
    w.folder("cars_f", "Cars")
    w.folder("school_f", "School")
    D = w.doc
    doc_patterns = {"house_f": ["Mortgage statement", "Property tax bill", "Home warranty", "HOA letter"],
                    "taxes_f": ["W-2", "1099", "Tax return", "Charity receipts"],
                    "kids_f": ["Report card", "Birth certificate", "Vaccination record"],
                    "medical_f": ["Lab results", "EOB", "Prescription"],
                    "work_f": ["Pay stub", "Offer letter", "Benefits summary"],
                    "travel_f": ["Boarding pass", "Hotel confirmation", "Itinerary"],
                    "insurance_f": ["Auto policy", "Homeowners policy", "Life insurance"],
                    "reno_f": ["Contractor estimate", "Permit application", "Floor plan"],
                    "cars_f": ["Honda registration", "Subaru registration", "Service record"],
                    "school_f": ["School calendar", "Field trip form", "Lunch menu"]}
    dcount = 0
    for folder, names in doc_patterns.items():
        for name in names:
            for year in (2024, 2025, 2026):
                if rng.random() < 0.75:
                    day = dt.date(year, rng.randint(1, 12), rng.randint(1, 28))
                    if day > dt.date(2026, 12, 19):
                        day = dt.date(2026, 12, 1)
                    D(f"dc{dcount}", f"{name} {year}", f"{name.lower()} for {year}", folder=folder,
                      created=f"{day.isoformat()}T10:00", starred=(rng.random() < 0.06))
                    dcount += 1
    D("gdl_tickets", "Guadalajara e-tickets", "UA 1511 / UA 1512, 4 passengers", folder="travel_f",
      created="2026-10-20T21:00", starred=True)
    D("reno_contract", "Kitchen renovation contract", "Esposito Builders, signed", folder="reno_f",
      created="2026-12-01T10:00", starred=True)
    D("passport_lucia", "Lucía passport scan", "expires 2029", folder="kids_f", created="2026-11-11T10:00")
    D("passport_arun", "Arun passport scan", "expires 2029", folder="kids_f", created="2026-11-11T10:05")
    D("trashed_doc", "Old car loan", "paid off", trashed="2026-05-01T10:00", created="2024-03-01T10:00")

    albums = [("al_lbi", "LBI 2026"), ("al_gdl25", "Guadalajara 2025"), ("al_kids", "Kids"),
              ("al_soccer", "Soccer"), ("al_ballet", "Ballet"), ("al_xmas25", "Christmas 2025"),
              ("al_vt", "Vermont 2026"), ("al_reno", "Kitchen before"), ("al_pets", "Churro"),
              ("al_bday", "Birthdays"), ("al_school", "School")]
    for key, name in albums:
        w.album(key, name)
    Ph = w.photo
    rolls = [("al_lbi", "LBI", "2026-07-11", 7, ["dev", "lucia", "arun", "liz"]),
             ("al_gdl25", "Guadalajara", "2025-12-20", 14, ["mama", "papa", "gabi", "tio"]),
             ("al_xmas25", "Christmas", "2025-12-24", 3, ["lucia", "arun", "mama"]),
             ("al_vt", "Vermont", "2026-02-13", 3, ["dev", "liz"]),
             ("al_reno", "Kitchen", "2026-11-28", 2, []),
             ("al_pets", "Churro", "2024-03-01", 900, []),
             ("al_soccer", "Arun soccer", "2024-09-07", 800, ["arun"]),
             ("al_ballet", "Lucía ballet", "2024-12-15", 700, ["lucia"]),
             ("al_bday", "Birthday", "2024-04-10", 900, ["lucia", "arun"])]
    pcount = 0
    for album, prefix, start, span, people in rolls:
        n = 40 if span > 20 else 30
        for i in range(n):
            day = d(start) + dt.timedelta(days=rng.randint(0, span))
            if day > dt.date(2026, 12, 20):
                day = dt.date(2026, 12, 20) - dt.timedelta(days=rng.randint(1, 60))
            who = rng.sample(people, k=min(len(people), rng.randint(0, 2))) if people else []
            Ph(f"ph{pcount}", f"{prefix} {i + 1}", f"{day.isoformat()}T{rng.randint(8, 20):02d}:{rng.randint(0, 59):02d}",
               albums=[album], people=who, starred=(rng.random() < 0.05))
            pcount += 1
    for i in range(700):
        day = dt.date(2024, 1, 5) + dt.timedelta(days=rng.randint(0, 1080))
        Ph(f"ph{pcount}", f"IMG_{4000 + i}", f"{day.isoformat()}T{rng.randint(7, 21):02d}:{rng.randint(0, 59):02d}",
           **({"trashed": "2026-10-01T09:00"} if rng.random() < 0.02 else {}))
        pcount += 1
    Ph("recital_2025", "Lucía recital bow", "2025-12-20T19:30", albums=["al_ballet"], people=["lucia"], starred=True)
    Ph("arun_goal", "Arun's first goal", "2026-10-03T10:40", albums=["al_soccer"], people=["arun", "coach_d"],
       starred=True)
    Ph("posada_25", "Posada 2025", "2025-12-23T21:00", albums=["al_gdl25"], people=["tio", "gabi", "mama"])
    Ph("churro_snow", "Churro in the snow", "2026-12-06T09:00", albums=["al_pets"], starred=True)

    Db = w.debt
    debtors = people_keys[:25] + ["liz", "gabi", "nanny", "contractor", "kavya2"]
    for i in range(70):
        who = rng.choice(debtors)
        direction = rng.choice(["owes_me", "i_owe"])
        day = dt.date(2024, 3, 1) + dt.timedelta(days=rng.randint(0, 1000))
        kw = {}
        if day < dt.date(2026, 10, 1) and rng.random() < 0.75:
            kw["settled"] = (day + dt.timedelta(days=rng.randint(3, 40))).isoformat() + "T12:00"
        Db(f"db{i}", who, direction, round(rng.uniform(5, 180), 2),
           rng.choice(["lunch", "tickets", "groceries", "gas", "birthday gift share", "dinner", "concert",
                       "school fundraiser", "babysitting", "uber"]), day.isoformat(), **kw)
    Db("gabi_flight", "gabi", "owes_me", 412, "Gabi's flight to Guadalajara", "2026-11-15")
    Db("liz_tix", "liz", "i_owe", 96, "Hamilton tickets", "2026-12-01")

    L = w.locker
    L("wifi_lk", "Home wifi", "wifi", password="Churro&Chai2026", starred=True)
    L("guest_wifi_d", "Guest wifi", "wifi", password="welcome-montclair")
    L("mom_wifi", "Mamá's wifi in Guadalajara", "wifi", password="Reyes1968")
    L("bank_d", "Wells Fargo", "login", username="mreyesk", url="https://wellsfargo.com", password="Tamal3s!")
    L("amex_d", "Amex Platinum", "card")
    L("passport_m", "Marisol passport", "passport", notes="expires 2031")
    L("passport_d", "Dev passport", "passport", notes="expires 2028")
    L("ezpass", "E-ZPass", "login", username="reyeskapoor", url="https://ezpassnj.com", password="TurnPike#9")
    L("school_portal", "School parent portal", "login", username="mreyesk", password="Lulu&Arun")
    L("alarm_d", "Alarm code", "note", notes="garage keypad")
    L("netflix_d", "Netflix", "login", username="family@example.com", password="pozole-night")
    L("hsa", "HSA account", "bank_account", notes="HealthEquity")
    L("costco_d", "Costco membership", "membership")
    L("github", "Work GitHub token", "api_credential", notes="expires March")
    L("old_login", "Old Comcast login", "login", trashed="2026-02-01T09:00")
    return w.done()


def main() -> None:
    for name, build in (("A", world_a), ("B", world_b), ("C", world_c), ("D", world_d)):
        world = build()
        path = HERE / f"{name}.json"
        path.write_text(json.dumps(world, ensure_ascii=False, indent=None, separators=(",", ":")) + "\n")
        sizes = {k: len(v) for k, v in world.items() if isinstance(v, list)}
        print(name, sum(sizes.values()), sizes)


if __name__ == "__main__":
    main()
