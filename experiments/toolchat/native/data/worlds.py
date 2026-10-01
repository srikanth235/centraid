"""World synthesis: varied households seeded only through `nativetools seed`.

A world is (json for the seeder, a Python-side Model used to choose scenarios). The model
never produces observations; it only helps the generator pick targets whose names select
what the scenario intends. Every observation comes from the runtime.
"""
from __future__ import annotations

import datetime as dt
import random
import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------- name pools
PEOPLE = {
    "indian": (["Neha", "Arjun", "Priya", "Rohan", "Kavya", "Vikram", "Ananya", "Siddharth", "Meera", "Rahul",
                "Divya", "Aditya", "Ishaan", "Lakshmi", "Suresh", "Pooja", "Karthik", "Deepa"],
               ["Rao", "Kulkarni", "Sharma", "Iyer", "Patel", "Menon", "Reddy", "Gupta", "Nair", "Joshi", "Bhat"]),
    "chinese": (["Wei", "Li Na", "Jun", "Mei", "Hao", "Xiu", "Lan", "Chen", "Yan", "Tao"],
                ["Wang", "Zhang", "Liu", "Chen", "Huang", "Zhao", "Lin", "Xu"]),
    "japanese": (["Haruto", "Yui", "Sota", "Aoi", "Ren", "Hina", "Kenji", "Sakura", "Takumi", "Emi"],
                 ["Sato", "Suzuki", "Takahashi", "Tanaka", "Watanabe", "Ito", "Nakamura", "Kobayashi"]),
    "korean": (["Minjun", "Seoyeon", "Jiwoo", "Hyun", "Soojin", "Jae", "Eunji", "Dong"],
               ["Kim", "Lee", "Park", "Choi", "Jung", "Kang", "Yoon"]),
    "hispanic": (["Mateo", "Lucia", "Sofia", "Diego", "Valentina", "Javier", "Camila", "Andres", "Ines", "Pablo"],
                 ["Garcia", "Rodriguez", "Martinez", "Lopez", "Ochoa", "Duarte", "Morales", "Vargas", "Castillo"]),
    "arabic": (["Omar", "Layla", "Yusuf", "Fatima", "Karim", "Noor", "Hassan", "Amira", "Tariq", "Zainab"],
               ["Haddad", "Khalil", "Mansour", "Nasser", "Saleh", "Farouk", "Aziz"]),
    "nigerian": (["Chidi", "Ngozi", "Emeka", "Adaeze", "Tunde", "Funmi", "Ifeoma", "Segun", "Bola"],
                 ["Okafor", "Adeyemi", "Balogun", "Eze", "Okonkwo", "Adebayo", "Nwosu"]),
    "german": (["Benedikt", "Lena", "Jonas", "Anna", "Lukas", "Greta", "Felix", "Klara", "Matthias", "Jana"],
               ["Weiss", "Müller", "Schmidt", "Fischer", "Wagner", "Becker", "Hoffmann", "Krause"]),
    "nordic": (["Astrid", "Lars", "Ingrid", "Erik", "Sigrid", "Nils", "Freya", "Magnus"],
               ["Lindqvist", "Hansen", "Johansson", "Nilsen", "Berg", "Dahl"]),
    "slavic": (["Olga", "Dmitri", "Katya", "Pavel", "Irina", "Tomasz", "Agnieszka", "Milan"],
               ["Novak", "Ivanova", "Kowalski", "Petrov", "Horvat", "Sokolov"]),
    "anglo": (["Sam", "Ray", "Emma", "Jack", "Olivia", "Harry", "Chloe", "Tom", "Grace", "Ben", "Kate", "Mike"],
              ["Park", "Smith", "Jones", "Taylor", "Brown", "Walker", "Hughes", "Carter", "Reed"]),
    "french": (["Camille", "Louis", "Manon", "Hugo", "Chloé", "Théo", "Élodie", "Julien"],
               ["Martin", "Bernard", "Dubois", "Moreau", "Laurent", "Lefèvre"]),
    "turkish": (["Emre", "Elif", "Mehmet", "Zeynep", "Can", "Ayşe"], ["Yılmaz", "Kaya", "Demir", "Şahin", "Çelik"]),
    "vietnamese": (["Minh", "Linh", "Anh", "Duc", "Thao", "Quang"], ["Nguyen", "Tran", "Le", "Pham", "Vu"]),
    "brazilian": (["João", "Ana", "Gabriel", "Beatriz", "Rafael", "Larissa"], ["Silva", "Santos", "Oliveira", "Souza", "Costa"]),
}
CITIES = ["Lisbon", "Kyoto", "Tahoe", "Mallaig", "Oaxaca", "Goa", "Marrakesh", "Reykjavik", "Hanoi", "Seoul",
          "Berlin", "Lagos", "Cusco", "Istanbul", "Prague", "Bali", "Nairobi", "Oslo", "Porto", "Chennai",
          "Havana", "Tbilisi", "Zanzibar", "Hokkaido", "Sicily", "Patagonia", "Cardiff", "Jaipur", "Busan"]
ROLES = ["designer", "plumber", "dentist", "accountant", "teacher", "landlord", "neighbour", "doctor", "coach",
         "lawyer", "colleague", "manager", "tutor", "electrician", "mentor", "cousin", "photographer"]
MET = ["Berlin 2019", "college", "the book club", "work", "yoga class", "the wedding", "school", "a conference",
       "the climbing gym", "our old flat"]
TASK_NAMES = [
    "Book the cabin", "Renew passport", "Call the plumber", "Pay rent", "File taxes", "Buy groceries", "Fix the bike",
    "Return library books", "Renew the car insurance", "Email the landlord", "Clean the gutters", "Order new tyres",
    "Cancel the gym membership", "Book a dentist visit", "Write the report", "Plan the quarterly budget",
    "Buy a birthday gift", "Clean the kitchen", "Print photos", "Submit the visa form", "Paint the fence",
    "Water the plants", "Wash the duvet", "Submit expense claim", "Prepare slides", "Collect the parcel",
    "Pick up dry cleaning", "Book boiler service", "Replace smoke alarm battery", "Send wedding RSVP",
    "Pay council tax", "Sign school forms", "Sell the sofa", "Book flight tickets", "Top up train pass",
    "Replace the fridge filter", "Book a haircut", "Take the cat to the vet", "Write thank-you cards",
    "Renew the lease", "Find a babysitter", "Mow the lawn", "Buy printer ink", "Defrost the freezer",
    "Back up the laptop", "Update my CV", "Cancel the old phone plan", "Service the car", "Pay the water bill",
    "Order new glasses", "Fix the leaking tap", "Tidy the garage", "Book the MOT", "Pay the credit card",
    "Sort the recycling", "Buy stamps", "Call the bank", "Reply to the school", "Clean the windows",
    "Organise the garage sale", "Book a table for the anniversary", "Get the bike serviced", "Hang the shelves",
]
EVENT_NAMES = ["Dentist", "Yoga class", "Team offsite", "Parent-teacher meeting", "Haircut", "Tabla class",
               "Physio", "Book club", "Standup", "Pottery workshop", "Choir practice", "Vet appointment",
               "Car service", "Swim lesson", "Board meeting", "Farmers market", "Piano recital", "Eye test",
               "Flu jab", "Quiz night", "Climbing session", "Chess club", "Salsa class", "Guitar lesson",
               "Interview", "Therapy", "Tax advisor call", "Bank appointment", "Open house", "Cricket match"]
EVENT_PATTERNS = ["Dinner with {first}", "Coffee with {first}", "{first}'s birthday", "Flight to {city}",
                  "Ferry to {city}", "Lunch with {first}", "Call with {first}", "{city} weekend", "Drinks with {first}"]
NOTE_NAMES = ["Dal recipe", "Packing list", "Book ideas", "Gift ideas", "Meeting notes", "Garden plan",
              "Wine list", "Workout plan", "Podcast notes", "Travel checklist", "Budget thoughts", "Poem draft",
              "Diary entry", "Journal", "Quotes", "Movie list", "Shopping ideas", "Sourdough starter",
              "Interview prep", "Name ideas", "Paint colours", "Renovation notes", "Chai recipe", "Birthday plans"]
NOTE_BODIES = ["lentils, cumin and a lot of patience", "socks, charger, passport", "ask about the deposit",
               "call before friday", "three chapters left", "try the blue one", "quiet day", "feed daily",
               "rosemary and garlic", "remember the adapter", "agenda: budget, hiring", "cardamom, ginger, milk"]
DOC_NAMES = ["Lease agreement", "W2 2025", "Passport scan", "Insurance policy", "Car registration",
             "Tax return 2025", "Birth certificate", "Offer letter", "Payslip March", "Warranty card",
             "Rental contract", "Vaccination record", "Mortgage statement", "Utility bill", "Visa approval",
             "Degree certificate", "Pet insurance", "Medical report", "Bank statement", "Invoice 1042",
             "Travel itinerary", "Gym contract", "Phone bill", "Council letter", "Pension summary"]
PHOTO_NAMES = ["Beach day", "Hike", "Birthday cake", "Sunset", "Graduation", "Snowman", "Picnic", "Market stall",
               "Old town", "Waterfall", "Harbour", "Rooftop dinner", "Temple gate", "Street food", "Lake swim",
               "Campfire", "Tea house", "Night market", "Cherry blossom", "Surf lesson", "Mountain hut",
               "Family portrait", "Puppy", "Garden party", "Wedding toast", "Museum", "Train window"]
ALBUM_NAMES = ["Summer", "Wedding", "Family", "Pets", "Food", "Christmas", "Road trip", "Baby", "Garden",
               "Concerts", "Hikes", "Best of 2025"]
GROUP_NAMES = ["Flat 4B", "Book club", "Office lunch", "Climbing crew", "Family", "Band", "Football team",
               "Housemates", "Wedding party", "Allotment"]
NOTEBOOKS = ["Recipes", "Ideas", "Work", "Travel", "Journal", "Reading", "Garden", "Health", "Projects"]
FOLDERS = ["Taxes", "Medical", "Car", "Home", "Insurance", "Work", "Travel", "Pets", "School", "Bank"]
LISTS = [("Home", "home"), ("Work", "work"), ("Errands", "errands"), ("Garden", "home"), ("Admin", "admin"),
         ("Wedding", "family"), ("Kids", "family"), ("Side project", "work")]
LOCKER = [("Home wifi", "wifi"), ("Bank login", "login"), ("Netflix", "login"), ("Gym locker", "password"),
          ("Visa card", "card"), ("Passport", "passport"), ("Work VPN", "login"), ("AWS key", "api_credential"),
          ("Server SSH", "ssh_key"), ("Office wifi", "wifi"), ("Driving licence", "driving_licence"),
          ("Library card", "membership"), ("Photoshop licence", "software_licence"), ("Bitcoin wallet", "crypto_wallet"),
          ("Savings account", "bank_account"), ("Email login", "login"), ("Alarm code", "password"),
          ("Health insurance", "identity"), ("Recovery codes", "note"), ("Spotify", "login"), ("Amex card", "card")]
DEBT_REASONS = ["concert tickets", "lunch", "taxi", "groceries", "movie night", "petrol", "birthday gift",
                "train fare", "dinner", "hotel", "books", "coffee", "parking", "football boots", "phone repair"]
# the vault keeps username/url only on logins, notes only on these (probed from `seed`'s "dropped" list)
LOCKER_NOTES = {"login", "note", "ssh_key", "api_credential", "passport", "bank_account", "driving_licence",
                "software_licence", "crypto_wallet", "membership", "document"}
DEFAULT_CURRENCIES = ["USD"] * 5 + ["EUR", "EUR", "GBP", "GBP", "INR", "JPY", "CAD", "AUD", "MXN", "KRW", "BRL", "NGN"]
CURRENCIES = ["USD"] * 6 + ["EUR", "GBP", "INR", "JPY", "CAD", "AUD", "MXN", "KRW"]


def _fmt_d(d: dt.date) -> str:
    return d.isoformat()


def _fmt_t(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M")


WORD = re.compile(r"\w+", re.UNICODE)


def words(s: str) -> list[str]:
    """Whole words as the runtime's name match sees them (hyphens and apostrophes split)."""
    return [w.lower() for w in WORD.findall(s)]


@dataclass
class Row:
    key: str
    kind: str
    name: str
    fields: dict = field(default_factory=dict)
    trashed: bool = False
    links: set = field(default_factory=set)  # keys linked (undirected, model-side)
    container: str | None = None  # key of notebook/folder/list for single-container kinds
    containers: set = field(default_factory=set)  # albums / groups
    id: str | None = None

    def has_words(self, ws: list[str]) -> bool:
        own = set(words(self.name))
        return all(t in own for w in ws for t in words(w))


@dataclass
class Model:
    me: str
    today: dt.datetime
    rows: dict = field(default_factory=dict)
    currency_groups: dict = field(default_factory=dict)

    def live(self, kind: str) -> list[Row]:
        return [r for r in self.rows.values() if r.kind == kind and not r.trashed]

    def trashed(self, kind: str) -> list[Row]:
        return [r for r in self.rows.values() if r.kind == kind and r.trashed]

    def by_id(self, rid: str) -> Row | None:
        for r in self.rows.values():
            if r.id == rid:
                return r
        return None

    def match(self, kind: str, ws: list[str], trashed: bool = False) -> list[Row]:
        pool = self.trashed(kind) if trashed else self.live(kind)
        return [r for r in pool if r.has_words(ws)]


class WorldBuilder:
    def __init__(self, rng: random.Random, today: dt.datetime, size: str, cultures: list[str]):
        self.rng = rng
        self.today = today
        self.size = size
        self.cultures = cultures
        self.world: dict = {}
        self.model: Model | None = None
        self.used_keys: set[str] = set()
        self.n = 0

    def key(self, base: str) -> str:
        self.n += 1
        k = re.sub(r"\W+", "_", base.lower()).strip("_")[:18] + f"_{self.n}"
        return k

    def day(self, lo: int, hi: int) -> dt.date:
        return (self.today + dt.timedelta(days=self.rng.randint(lo, hi))).date()

    def when(self, lo: int, hi: int, timed_p: float = 0.6) -> tuple[str, dt.datetime, bool]:
        d = self.day(lo, hi)
        if self.rng.random() < timed_p:
            t = dt.datetime.combine(d, dt.time(self.rng.choice([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
                                                self.rng.choice([0, 0, 0, 15, 30, 45])))
            return _fmt_t(t), t, True
        return _fmt_d(d), dt.datetime.combine(d, dt.time(0, 0)), False

    def person_name(self) -> tuple[str, str]:
        c = self.rng.choice(self.cultures)
        firsts, lasts = PEOPLE[c]
        return self.rng.choice(firsts), self.rng.choice(lasts)


SIZES = {
    #          people groups events tasks notes docs photos albums debts locker nb folders lists
    "tiny":   (3, 1, 4, 5, 3, 2, 3, 1, 2, 2, 1, 1, 1),
    "small":  (8, 2, 12, 15, 8, 6, 12, 2, 5, 5, 2, 2, 2),
    "medium": (30, 4, 50, 70, 35, 25, 90, 5, 15, 12, 4, 4, 4),
    "large":  (90, 6, 220, 330, 120, 80, 520, 9, 35, 18, 6, 7, 5),
}


def build_world(seed: int, size: str | None = None) -> tuple[dict, Model]:
    rng = random.Random(seed)
    drawn = rng.choices(["tiny", "small", "medium", "large"], weights=[15, 40, 35, 10])[0]
    size = size or drawn          # the draw is always made, so a forced size leaves the rest of the world alike
    # today: any day of 2026-2027, a fixed-ish morning/afternoon time
    base = dt.datetime(2026, 1, 1, 0, 0) + dt.timedelta(days=rng.randint(0, 700))
    today = base.replace(hour=rng.choice([8, 9, 10, 11, 14, 16, 19]), minute=rng.choice([0, 15, 30]))
    ncult = rng.choice([1, 2, 2, 3, 4])
    cultures = rng.sample(sorted(PEOPLE), ncult)
    b = WorldBuilder(rng, today, size, cultures)
    counts = SIZES[size]
    jitter = lambda n: max(1 if n else 0, int(n * rng.uniform(0.6, 1.3)))  # noqa: E731
    (n_people, n_groups, n_events, n_tasks, n_notes, n_docs, n_photos, n_albums, n_debts, n_locker, n_nb,
     n_folders, n_lists) = [jitter(c) for c in counts]

    mf, ml = b.person_name()
    me = f"{mf} {ml}"
    default_cur = rng.choice(DEFAULT_CURRENCIES)
    epoch = today - dt.timedelta(days=rng.randint(420, 800))
    model = Model(me=me, today=today)
    model.rows["me"] = Row("me", "person", me)
    model.currency = default_cur  # type: ignore[attr-defined]
    w: dict = {"me": me, "epoch": _fmt_t(epoch), "seed": f"data{seed}", "currency": default_cur, "people": [], "groups": [], "expenses": [],
               "lists": [], "events": [], "tasks": [], "notebooks": [], "notes": [], "folders": [], "documents": [],
               "albums": [], "photos": [], "debts": [], "locker": [], "links": []}

    def add(kind: str, rowj: dict, fields: dict | None = None) -> Row:
        r = Row(rowj["key"], kind, rowj["name"], fields or {})
        if rowj.get("trashed"):
            r.trashed = True
        model.rows[r.key] = r
        return r

    def maybe_trash(rowj: dict, p: float) -> None:
        if rng.random() < p:
            rowj["trashed"] = _fmt_t(today - dt.timedelta(days=rng.randint(1, 20), hours=rng.randint(0, 5)))

    def created(rowj: dict, lo: int, hi: int) -> dt.datetime:
        d = today + dt.timedelta(days=rng.randint(lo, hi), hours=rng.randint(-3, 3))
        d = max(d, epoch + dt.timedelta(days=1))
        rowj["created"] = _fmt_t(d)
        return d

    # ---- people (deliberate shared first names / surnames for ambiguity)
    names_seen: set[str] = {me}
    people_keys: list[str] = []
    dup_first_p = 0.25 if size in ("small", "medium", "large") else 0.1
    for _ in range(n_people):
        for _try in range(30):
            f, l = b.person_name()
            if people_keys and rng.random() < dup_first_p:
                f = model.rows[rng.choice(people_keys)].name.split(" ")[0]
            nm = f"{f} {l}"
            if nm not in names_seen:
                break
        else:
            continue
        names_seen.add(nm)
        pj = {"key": b.key(nm), "name": nm}
        flds = {}
        if rng.random() < 0.35:
            pj["role"] = flds["role"] = rng.choice(ROLES)
        if rng.random() < 0.15:
            pj["nickname"] = flds["nickname"] = nm.split(" ")[0][:2].upper() if rng.random() < 0.5 else nm.split(" ")[0][:3]
        if rng.random() < 0.2:
            pj["met"] = flds["met"] = rng.choice(MET)
        if rng.random() < 0.3:
            pj["cadence"] = flds["cadence"] = rng.choice([7, 14, 21, 30, 60, 90])
        if rng.random() < 0.2:
            pj["starred"] = flds["starred"] = True
        if rng.random() < 0.45:
            s, t, _ = b.when(-120, -1, 1.0)
            pj["last_contacted"] = s
            flds["date"] = t
            pj["last_contacted_kind"] = rng.choice(["call", "message", "visit", "coffee"])
        maybe_trash(pj, 0.05)
        w["people"].append(pj)
        add("person", pj, flds)
        people_keys.append(pj["key"])
    live_people = [k for k in people_keys if not model.rows[k].trashed]

    # ---- groups + expenses
    group_names = rng.sample(GROUP_NAMES + [f"{c} trip" if rng.random() < 0.5 else f"{c} Trip" for c in rng.sample(CITIES, 6)],
                             min(n_groups, 16))
    for gname in group_names:
        cur = default_cur if rng.random() < 0.6 else rng.choice(CURRENCIES)
        members = rng.sample(live_people, min(len(live_people), rng.randint(1, 5))) if live_people else []
        gj = {"key": b.key(gname), "name": gname, "currency": cur, "members": members}
        created(gj, -300, -10)
        w["groups"].append(gj)
        g = add("group", gj, {"currency": cur})
        g.links.update(members)
        for m in members:
            model.rows[m].containers.add(gj["key"])
        # expenses in this group (payer and split among me + members)
        for _ in range(rng.randint(0, 4) if members else 0):
            payer = rng.choice(["me"] + members)
            split = ["me"] + rng.sample(members, rng.randint(1, len(members)))
            amt = rng.choice([12, 18.5, 24, 40, 60, 75.25, 90, 120, 300, 450])
            if cur in ("JPY", "KRW"):
                amt = int(amt * 100)
            ej = {"group": gj["key"], "name": rng.choice(["Cabin", "Groceries", "Dinner", "Taxi", "Tickets", "Fuel",
                                                          "Rent", "Snacks", "Museum", "Boat hire"]),
                  "amount": amt, "paid_by": payer, "split": sorted(set(split), key=split.index),
                  "date": _fmt_d(b.day(-200, -1))}
            w["expenses"].append(ej)

    # ---- lists
    for lname, area in rng.sample(LISTS, min(n_lists, len(LISTS))):
        lj = {"key": b.key(lname), "name": lname, "area": area}
        created(lj, -300, -30)
        w["lists"].append(lj)
        add("list", lj, {"area": area})
    list_keys = [l["key"] for l in w["lists"]]

    # ---- events (the calendar refuses overlapping events)
    busy: list = []
    for i in range(n_events):
        if rng.random() < 0.45 and live_people:
            pk = rng.choice(live_people)
            first = model.rows[pk].name.split(" ")[0]
            nm = rng.choice(EVENT_PATTERNS).format(first=first, city=rng.choice(CITIES))
            att = [pk] if "{first}" in nm or first in nm else []
        else:
            nm = rng.choice(EVENT_NAMES)
            att = rng.sample(live_people, rng.randint(0, min(2, len(live_people)))) if live_people and rng.random() < 0.3 else []
        if size == "large" and rng.random() < 0.3:
            nm = f"{nm} {rng.choice(['#2', 'follow-up', 'II', 'prep'])}"
        # dates concentrated near today
        span = rng.choice([(-10, 14), (-40, 60), (-200, 200)])
        dur = rng.choice([30, 45, 60, 90, 120]) if rng.random() < 0.5 else 60
        for _try in range(40):
            s, start, timed = b.when(*span, timed_p=1.0)
            end = start + dt.timedelta(minutes=dur)
            if all(end <= a or start >= z for a, z in busy):
                break
        else:
            continue
        busy.append((start, end))
        ej = {"key": b.key(nm), "name": nm, "start": s}
        flds = {"date": start, "status": "tentative", "duration": dur}
        if dur != 60:
            ej["end"] = _fmt_t(end)
        if rng.random() < 0.15:
            ej["description"] = flds["description"] = rng.choice(["bring the forms", "second floor", "pay at the desk",
                                                                  "ask about the refund", "gate B"])
        if att:
            ej["attendees"] = att
        if rng.random() < 0.08:
            ej["cancelled"] = True
            flds["status"] = "cancelled"
        maybe_trash(ej, 0.04)
        w["events"].append(ej)
        r = add("event", ej, flds)
        r.links.update(att)

    # ---- tasks
    task_keys = []
    for i in range(n_tasks):
        if rng.random() < 0.2 and live_people:
            pk = rng.choice(live_people)
            first = model.rows[pk].name.split(" ")[0]
            nm = rng.choice([f"Call {first}", f"Email {first}", f"Birthday gift for {first}", f"Return {first}'s book",
                             f"Mend reed for {first}", f"Send photos to {first}"])
            about = pk
        else:
            nm = rng.choice(TASK_NAMES)
            about = None
        if size == "large" and rng.random() < 0.25:
            nm = f"{nm} ({rng.choice(['Q1', 'Q2', 'Q3', 'again', 'v2', 'spring', 'autumn'])})"
        tj = {"key": b.key(nm), "name": nm}
        flds: dict = {"status": "open"}
        if rng.random() < 0.8:
            s, due, _ = b.when(*rng.choice([(-15, 20), (-60, 90), (-5, 10)]), timed_p=0.3)
            tj["due"] = s
            flds["date"] = due
        st = rng.choices(["open", "completed", "in_progress", "cancelled"], weights=[60, 25, 10, 5])[0]
        if st != "open":
            tj["status"] = st
            flds["status"] = st
        if st == "completed":
            ct = today - dt.timedelta(days=rng.randint(0, 30), hours=rng.randint(1, 8))
            tj["completed"] = _fmt_t(ct)
            flds["completed"] = ct
        if rng.random() < 0.4:
            tj["effort"] = flds["effort"] = rng.choice([5, 10, 15, 20, 30, 45, 60, 90, 120])
        if rng.random() < 0.3:
            tj["priority"] = flds["priority"] = rng.randint(0, 9)
        if rng.random() < 0.12:
            tj["description"] = flds["description"] = rng.choice(["before the deadline", "ask for a receipt",
                                                                  "the blue form", "use the old account", "call first"])
        if list_keys and rng.random() < 0.45:
            tj["list"] = rng.choice(list_keys)
        tops = [k for k in task_keys if model.rows[k].fields.get("status") == "open" and not model.rows[k].trashed
                and not getattr(model.rows[k], "is_sub", False)]
        if tops and st == "open" and rng.random() < 0.08:
            tj["parent"] = rng.choice(tops)
        maybe_trash(tj, 0.05)
        w["tasks"].append(tj)
        r = add("task", tj, flds)
        r.container = tj.get("list")
        if about:
            w["links"].append({"from": tj["key"], "to": about})
            r.links.add(about)
        if tj.get("parent"):
            model.rows[tj["parent"]].links.add(tj["key"])
            r.is_sub = True  # type: ignore[attr-defined]
        task_keys.append(tj["key"])

    # ---- notebooks + notes
    for nb in rng.sample(NOTEBOOKS, min(n_nb, len(NOTEBOOKS))):
        nj = {"key": b.key(nb), "name": nb}
        created(nj, -400, -30)
        w["notebooks"].append(nj)
        add("notebook", nj)
    nb_keys = [n["key"] for n in w["notebooks"]]
    for i in range(n_notes):
        nm = rng.choice(NOTE_NAMES)
        if rng.random() < 0.25:
            nm = f"{nm} {rng.choice(CITIES) if rng.random() < 0.5 else rng.choice(['2025', 'March', 'v2', 'draft'])}"
        nj = {"key": b.key(nm), "name": nm, "body": rng.choice(NOTE_BODIES)}
        c = created(nj, -200, 0)
        flds = {"date": c, "body": nj["body"], "pinned": False}
        if nb_keys and rng.random() < 0.6:
            nj["notebook"] = rng.choice(nb_keys)
        if rng.random() < 0.12:
            nj["pinned"] = True
            flds["pinned"] = True
        maybe_trash(nj, 0.06)
        w["notes"].append(nj)
        r = add("note", nj, flds)
        r.container = nj.get("notebook")

    # ---- folders + documents
    for fo in rng.sample(FOLDERS, min(n_folders, len(FOLDERS))):
        fj = {"key": b.key(fo), "name": fo}
        created(fj, -400, -30)
        w["folders"].append(fj)
        add("folder", fj)
    f_keys = [f["key"] for f in w["folders"]]
    for i in range(n_docs):
        nm = rng.choice(DOC_NAMES)
        if size in ("medium", "large") and rng.random() < 0.3:
            nm = f"{nm} {rng.choice(['copy', '2024', 'signed', 'draft', 'v2'])}"
        dj = {"key": b.key(nm), "name": nm, "text": "…"}
        c = created(dj, -300, 0)
        flds = {"date": c, "starred": False}
        if f_keys and rng.random() < 0.6:
            dj["folder"] = rng.choice(f_keys)
        if rng.random() < 0.15:
            dj["starred"] = flds["starred"] = True
        maybe_trash(dj, 0.06)
        w["documents"].append(dj)
        r = add("document", dj, flds)
        r.container = dj.get("folder")

    # ---- albums + photos
    for al in rng.sample(ALBUM_NAMES + [f"{c} {rng.choice(['trip', '2025', 'holiday'])}" for c in rng.sample(CITIES, 4)],
                         min(n_albums, 16)):
        aj = {"key": b.key(al), "name": al}
        created(aj, -400, -30)
        w["albums"].append(aj)
        add("album", aj)
    a_keys = [a["key"] for a in w["albums"]]
    for i in range(n_photos):
        nm = rng.choice(PHOTO_NAMES) if rng.random() < 0.75 else f"{rng.choice(CITIES)} {rng.choice(['skyline', 'street', 'sunset', 'harbour'])}"
        if size == "large" and rng.random() < 0.5:
            nm = f"IMG_{rng.randint(1000, 9999)}"
        s, t, _ = b.when(-400, 0, 1.0)
        pj = {"key": b.key(nm), "name": nm, "taken": s}
        flds = {"date": t, "starred": False}
        if a_keys and rng.random() < 0.5:
            pj["albums"] = rng.sample(a_keys, rng.randint(1, min(2, len(a_keys))))
        if live_people and rng.random() < 0.3:
            pj["people"] = rng.sample(live_people, rng.randint(1, min(2, len(live_people))))
        if rng.random() < 0.12:
            pj["starred"] = flds["starred"] = True
        maybe_trash(pj, 0.05)
        w["photos"].append(pj)
        r = add("photo", pj, flds)
        r.containers.update(pj.get("albums", []))
        r.links.update(pj.get("people", []))

    # ---- debts
    for i in range(n_debts if live_people else 0):
        pk = rng.choice(live_people)
        direction = rng.choice(["owes_me", "i_owe"])
        amt = rng.choice([5, 8.5, 12, 15, 20, 25.5, 30, 42, 50, 65, 80, 120, 200])
        if default_cur in ("JPY", "KRW", "INR", "NGN"):
            amt = int(amt * {"JPY": 150, "KRW": 1300, "INR": 80, "NGN": 1500}[default_cur])
        s, t, _ = b.when(-200, 0, 0.0)
        reason = rng.choice(DEBT_REASONS)
        dj = {"key": b.key(reason), "person": pk, "direction": direction, "amount": amt, "name": reason, "date": s}
        flds = {"date": t, "amount": amt, "direction": direction, "status": "open"}
        if rng.random() < 0.3:
            dj["settled"] = _fmt_t(t + dt.timedelta(days=rng.randint(1, 20)))
            flds["status"] = "settled"
        w["debts"].append(dj)
        r = add("debt", dj, flds)
        r.links.add(pk)

    # ---- locker
    for nm, typ in rng.sample(LOCKER, min(n_locker, len(LOCKER))):
        lj = {"key": b.key(nm), "name": nm, "type": typ}
        flds = {"type": typ, "starred": False}
        if typ in ("login", "wifi", "password"):
            lj["password"] = rng.choice(["hunter2", "correct-horse", "s3cret!", "Tr0ub4dor", "blue-kettle-42"])
        if typ == "login":
            lj["username"] = flds["username"] = me.split(" ")[0].lower() + rng.choice(["", "42", ".work"])
            if rng.random() < 0.5:
                lj["url"] = flds["url"] = "https://" + re.sub(r"\W", "", nm.lower()) + ".example"
        if typ in LOCKER_NOTES and rng.random() < 0.2:   # the vault keeps notes only on some types (sealed)
            lj["notes"] = flds["notes"] = rng.choice(["rotate yearly", "shared with family", "old one"])
        if rng.random() < 0.2:
            lj["starred"] = flds["starred"] = True
        maybe_trash(lj, 0.05)
        w["locker"].append(lj)
        add("locker item", lj, flds)

    for k, v in list(w.items()):
        if isinstance(v, list) and not v:
            del w[k]
    model.size = size  # type: ignore[attr-defined]
    return w, model


def attach_ids(model: Model, seeded: dict) -> None:
    for k, v in seeded.get("keys", {}).items():
        if k in model.rows:
            model.rows[k].id = v["id"]
