"""The seeded synthetic world the evaluation suite is scored against.

One SQLite database, built in memory, holding the eight apps' rows plus the
join tables that make cross-app questions answerable. Everything is
deterministic: ids are spelled out, dates are literals, and nothing reads the
wall clock. ``TODAY`` is the injected "now" every relative date phrase resolves
against.

Vocabulary note: this is a synthetic *world*, not a vault. It mirrors the real
vault's nouns (party, event, attendee, task, note, asset, album, document,
locker item, tally expense) so the operation catalogue is realistic, but it is
a stand-in fixture and shares no schema with ``packages/vault``.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta

# The injected today. Never `date.today()`: a suite that moves under the model
# cannot be scored twice.
TODAY = date(2026, 9, 19)  # a Saturday

SCHEMA = """
CREATE TABLE person (
    id           TEXT PRIMARY KEY,
    full_name    TEXT NOT NULL,
    first_name   TEXT NOT NULL,
    nickname     TEXT,
    company      TEXT,
    email        TEXT,
    phone        TEXT,
    starred      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE person_note (
    id        TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES person(id),
    body      TEXT NOT NULL,
    created   TEXT NOT NULL
);
CREATE TABLE interaction (
    id        TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES person(id),
    channel   TEXT NOT NULL,
    happened  TEXT NOT NULL
);

CREATE TABLE event (
    id       TEXT PRIMARY KEY,
    title    TEXT NOT NULL,
    starts   TEXT NOT NULL,
    ends     TEXT NOT NULL,
    calendar TEXT NOT NULL,
    notes    TEXT NOT NULL DEFAULT '',
    place    TEXT,
    status   TEXT NOT NULL DEFAULT 'confirmed'
);
CREATE TABLE attendee (
    event_id  TEXT NOT NULL REFERENCES event(id),
    person_id TEXT NOT NULL REFERENCES person(id),
    response  TEXT NOT NULL DEFAULT 'accepted',
    PRIMARY KEY (event_id, person_id)
);

CREATE TABLE project (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE task (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    due        TEXT,
    status     TEXT NOT NULL DEFAULT 'open',
    project_id TEXT REFERENCES project(id)
);
CREATE TABLE task_assignee (
    task_id   TEXT NOT NULL REFERENCES task(id),
    person_id TEXT NOT NULL REFERENCES person(id),
    PRIMARY KEY (task_id, person_id)
);

CREATE TABLE notebook (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE note (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    notebook_id TEXT REFERENCES notebook(id),
    created     TEXT NOT NULL
);
CREATE TABLE note_person (
    note_id   TEXT NOT NULL REFERENCES note(id),
    person_id TEXT NOT NULL REFERENCES person(id),
    PRIMARY KEY (note_id, person_id)
);

CREATE TABLE album (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE photo (
    id     TEXT PRIMARY KEY,
    taken  TEXT NOT NULL,
    place  TEXT,
    tag    TEXT
);
CREATE TABLE photo_person (
    photo_id  TEXT NOT NULL REFERENCES photo(id),
    person_id TEXT NOT NULL REFERENCES person(id),
    PRIMARY KEY (photo_id, person_id)
);
CREATE TABLE photo_album (
    photo_id TEXT NOT NULL REFERENCES photo(id),
    album_id TEXT NOT NULL REFERENCES album(id),
    PRIMARY KEY (photo_id, album_id)
);

CREATE TABLE folder (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE document (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    folder_id  TEXT REFERENCES folder(id),
    touched    TEXT NOT NULL,
    text       TEXT NOT NULL DEFAULT '',
    starred    INTEGER NOT NULL DEFAULT 0,
    trashed    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE locker_item (
    id       TEXT PRIMARY KEY,
    service  TEXT NOT NULL,
    kind     TEXT NOT NULL,
    username TEXT,
    health   TEXT,
    starred  INTEGER NOT NULL DEFAULT 0,
    trashed  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tally_group (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE tally_entry (
    id          TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    amount      REAL NOT NULL,
    person_id   TEXT NOT NULL REFERENCES person(id),
    group_id    TEXT REFERENCES tally_group(id),
    happened    TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'expense',
    settled     INTEGER NOT NULL DEFAULT 0
);
"""

# ------------------------------------------------------------------ people
# Shared first names are deliberate: two Nehas at different companies and two
# people called Marcus force the resolver's Ambiguous path.
PEOPLE: list[tuple[str, str, str, str | None, str | None, str | None, str | None, int]] = [
    ("p01", "Neha Kulkarni", "Neha", None, "Initech", "neha.k@initech.example", "+91-90000-00001", 1),
    ("p02", "Neha Bhatt", "Neha", None, "Hooli", "neha.b@hooli.example", "+91-90000-00002", 0),
    ("p03", "Marcus Reed", "Marcus", "Marc", "Initech", "marcus@initech.example", "+91-90000-00003", 1),
    ("p04", "Marcus Oyelaran", "Marcus", None, "Acme", "m.oye@acme.example", None, 0),
    ("p05", "Priya Raman", "Priya", "Pri", "Initech", "priya@initech.example", "+91-90000-00005", 0),
    ("p06", "Dev Sharma", "Dev", None, "Hooli", "dev@hooli.example", None, 0),
    ("p07", "Rhea Fernandes", "Rhea", None, "Acme", "rhea@acme.example", "+91-90000-00007", 0),
    ("p08", "Tomas Vidal", "Tomas", "Tom", "Initech", "tomas@initech.example", None, 0),
    ("p09", "Lena Ostrowski", "Lena", None, None, "lena@personal.example", "+91-90000-00009", 1),
    ("p10", "Arjun Menon", "Arjun", None, "Acme", "arjun@acme.example", None, 0),
    ("p11", "Sofia Duarte", "Sofia", "Sof", "Hooli", "sofia@hooli.example", None, 0),
    ("p12", "Ibrahim Qadir", "Ibrahim", "Ibbi", None, "ibrahim@personal.example", None, 0),
    ("p13", "Grace Whitfield", "Grace", None, "Initech", "grace@initech.example", "+91-90000-00013", 0),
    ("p14", "Kenji Sato", "Kenji", None, "Hooli", "kenji@hooli.example", None, 0),
    ("p15", "Anya Petrova", "Anya", None, None, "anya@personal.example", "+91-90000-00015", 0),
]

PERSON_NOTES: list[tuple[str, str, str, str]] = [
    ("pn1", "p01", "Allergic to shellfish.", "2026-08-04"),
    ("pn2", "p03", "Prefers morning meetings.", "2026-08-21"),
    ("pn3", "p09", "Moving flats in October.", "2026-09-02"),
]

INTERACTIONS: list[tuple[str, str, str, str]] = [
    ("i1", "p01", "call", "2026-09-11"),
    ("i2", "p03", "met", "2026-09-04"),
    ("i3", "p05", "email", "2026-08-28"),
    ("i4", "p09", "message", "2026-09-17"),
]

# ------------------------------------------------------------------ agenda
EVENTS: list[tuple[str, str, str, str, str, str, str | None]] = [
    ("e01", "Design review", "2026-09-17T10:00", "2026-09-17T11:00", "work", "Review the onboarding redesign.", "Bangalore office"),
    ("e02", "Sprint planning", "2026-09-21T09:30", "2026-09-21T10:30", "work", "Plan the migration sprint.", "Bangalore office"),
    ("e03", "1:1 with Neha", "2026-09-22T15:00", "2026-09-22T15:30", "work", "", "Bangalore office"),
    ("e04", "Initech offsite", "2026-09-24T09:00", "2026-09-25T18:00", "work", "Two-day offsite in Goa.", "Goa"),
    ("e05", "Dentist", "2026-09-25T08:30", "2026-09-25T09:15", "personal", "", "Indiranagar"),
    ("e06", "Retro", "2026-09-29T16:00", "2026-09-29T17:00", "work", "Sprint retro for the migration.", "Bangalore office"),
    ("e07", "Lena's birthday dinner", "2026-10-03T19:30", "2026-10-03T22:00", "family", "", "Koramangala"),
    ("e08", "Onboarding workshop", "2026-10-08T11:00", "2026-10-08T13:00", "work", "Rework the onboarding flow.", "Bangalore office"),
    ("e09", "Quarterly review", "2026-10-15T14:00", "2026-10-15T16:00", "work", "Q3 numbers.", "Bangalore office"),
    ("e10", "Flat viewing", "2026-08-29T17:00", "2026-08-29T18:00", "personal", "", "Koramangala"),
    ("e11", "Acme intro call", "2026-08-14T11:00", "2026-08-14T11:45", "work", "First call with Acme.", None),
    ("e12", "Standup", "2026-09-20T09:00", "2026-09-20T09:15", "work", "", None),
]

ATTENDEES: list[tuple[str, str, str]] = [
    ("e01", "p01", "accepted"),
    ("e01", "p03", "accepted"),
    ("e01", "p05", "accepted"),
    ("e01", "p13", "declined"),
    ("e02", "p03", "accepted"),
    ("e02", "p05", "accepted"),
    ("e02", "p08", "pending"),
    ("e03", "p01", "accepted"),
    ("e04", "p01", "accepted"),
    ("e04", "p03", "accepted"),
    ("e04", "p05", "accepted"),
    ("e04", "p08", "accepted"),
    ("e04", "p13", "accepted"),
    ("e06", "p03", "accepted"),
    ("e06", "p08", "accepted"),
    ("e07", "p09", "accepted"),
    ("e07", "p12", "accepted"),
    ("e07", "p15", "pending"),
    ("e08", "p01", "accepted"),
    ("e08", "p05", "pending"),
    ("e09", "p03", "accepted"),
    ("e09", "p13", "accepted"),
    ("e11", "p07", "accepted"),
    ("e11", "p10", "accepted"),
    ("e12", "p03", "accepted"),
]

# ------------------------------------------------------------------- tasks
PROJECTS: list[tuple[str, str]] = [
    ("pr1", "Website refresh"),
    ("pr2", "Migration"),
    ("pr3", "Home"),
    ("pr4", "Q4 planning"),
]

TASKS: list[tuple[str, str, str | None, str, str | None]] = [
    ("t01", "Renew the domain", "2026-09-25", "open", "pr1"),
    ("t02", "File the Initech invoice", "2026-09-21", "open", None),
    ("t03", "Draft the migration plan", "2026-09-22", "open", "pr2"),
    ("t04", "Book offsite flights", "2026-09-20", "open", None),
    ("t05", "Review onboarding copy", "2026-09-24", "open", "pr1"),
    ("t06", "Renew the passport", "2026-10-12", "open", "pr3"),
    ("t07", "Apply for the visa", "2026-10-02", "open", "pr3"),
    ("t08", "Pay the electricity bill", "2026-09-18", "open", "pr3"),
    ("t09", "Migrate the staging database", "2026-09-29", "open", "pr2"),
    ("t10", "Write the Q4 brief", "2026-10-06", "open", "pr4"),
    ("t11", "Collect Q4 headcount numbers", "2026-10-09", "open", "pr4"),
    ("t12", "Fix the invoices export", "2026-09-26", "open", "pr1"),
    ("t13", "Send the Acme contract", "2026-09-19", "open", None),
    ("t14", "Chase the Hooli invoice", "2026-10-01", "open", None),
    ("t15", "Cancel the old gym membership", None, "open", "pr3"),
    ("t16", "Back up the photo library", None, "open", "pr3"),
    ("t17", "Migration dry run", "2026-10-05", "open", "pr2"),
    ("t18", "Onboarding checklist", "2026-09-23", "open", "pr1"),
    ("t19", "Book the venue", "2026-09-30", "open", None),
    ("t20", "Order the new laptop", "2026-09-15", "done", None),
    ("t21", "Submit the expense report", "2026-09-12", "done", None),
    ("t22", "Refresh the design tokens", "2026-09-10", "done", "pr1"),
    ("t23", "Plan the retro agenda", "2026-09-28", "open", "pr2"),
    ("t24", "Confirm the dentist appointment", "2026-09-24", "open", "pr3"),
    ("t25", "Share the migration notes", "2026-10-03", "open", "pr2"),
]

TASK_ASSIGNEES: list[tuple[str, str]] = [
    ("t02", "p01"),
    ("t03", "p03"),
    ("t05", "p01"),
    ("t09", "p03"),
    ("t12", "p05"),
    ("t13", "p07"),
    ("t14", "p06"),
    ("t17", "p08"),
    ("t18", "p05"),
    ("t23", "p03"),
    ("t25", "p01"),
]

# ------------------------------------------------------------------- notes
NOTEBOOKS: list[tuple[str, str]] = [
    ("nb1", "Work"),
    ("nb2", "Journal"),
    ("nb3", "Ideas"),
]

NOTES: list[tuple[str, str, str, str | None, str]] = [
    ("n01", "Migration plan sketch", "Cut over the staging database first.", "nb1", "2026-09-08"),
    ("n02", "Design review takeaways", "Onboarding copy is too long.", "nb1", "2026-09-17"),
    ("n03", "Offsite ideas", "Book the venue; plan a walk.", "nb3", "2026-09-12"),
    ("n04", "Initech contacts", "Neha runs design; Marcus runs platform.", "nb1", "2026-08-19"),
    ("n05", "Saturday", "Slow morning, long walk.", "nb2", "2026-09-12"),
    ("n06", "Invoices mess", "The invoices export drops the tax line.", "nb1", "2026-09-05"),
    ("n07", "Onboarding rework", "Three screens, not seven.", "nb1", "2026-09-18"),
    ("n08", "Flat hunt", "Koramangala, two bedrooms.", "nb2", "2026-08-30"),
    ("n09", "Visa checklist", "Photos, bank statement, letter.", "nb3", "2026-09-14"),
    ("n10", "Q4 themes", "Consolidate, then ship.", "nb1", "2026-09-16"),
    ("n11", "Goa notes", "Cab fare split across the group.", "nb2", "2026-09-15"),
    ("n12", "Retro prompts", "What slowed the migration down.", "nb1", "2026-09-13"),
    ("n13", "Acme call", "They want a pilot by November.", "nb1", "2026-08-14"),
    ("n14", "Reading list", "Three books on interfaces.", "nb3", "2026-08-22"),
    ("n15", "Dinner plan", "Lena's birthday: book a table for six.", "nb2", "2026-09-18"),
]

NOTE_PEOPLE: list[tuple[str, str]] = [
    ("n02", "p01"),
    ("n02", "p03"),
    ("n02", "p05"),
    ("n04", "p01"),
    ("n04", "p03"),
    ("n11", "p01"),
    ("n11", "p08"),
    ("n13", "p07"),
    ("n13", "p10"),
    ("n15", "p09"),
]

# ------------------------------------------------------------------ photos
ALBUMS: list[tuple[str, str]] = [
    ("a1", "Goa"),
    ("a2", "Offsite 2026"),
    ("a3", "Family"),
]

PHOTOS: list[tuple[str, str, str | None, str | None]] = [
    ("ph01", "2026-09-17", "Bangalore office", None),
    ("ph02", "2026-09-17", "Bangalore office", None),
    ("ph03", "2026-09-14", "Koramangala", None),
    ("ph04", "2026-09-13", "Koramangala", "keepers"),
    ("ph05", "2026-09-12", "Goa", None),
    ("ph06", "2026-09-12", "Goa", "keepers"),
    ("ph07", "2026-09-11", "Goa", None),
    ("ph08", "2026-09-06", "Bangalore office", None),
    ("ph09", "2026-09-05", "Indiranagar", None),
    ("ph10", "2026-09-02", "Indiranagar", None),
    ("ph11", "2026-08-30", "Koramangala", None),
    ("ph12", "2026-08-29", "Koramangala", None),
    ("ph13", "2026-08-24", "Goa", None),
    ("ph14", "2026-08-22", "Goa", None),
    ("ph15", "2026-08-18", "Bangalore office", None),
    ("ph16", "2026-08-15", "Indiranagar", None),
    ("ph17", "2026-09-18", "Koramangala", None),
    ("ph18", "2026-09-16", "Bangalore office", None),
    ("ph19", "2026-09-10", "Goa", None),
    ("ph20", "2026-09-08", "Indiranagar", None),
]

PHOTO_PEOPLE: list[tuple[str, str]] = [
    ("ph01", "p01"),
    ("ph01", "p03"),
    ("ph02", "p05"),
    ("ph03", "p09"),
    ("ph04", "p09"),
    ("ph04", "p12"),
    ("ph05", "p01"),
    ("ph05", "p08"),
    ("ph06", "p03"),
    ("ph07", "p01"),
    ("ph08", "p05"),
    ("ph09", "p09"),
    ("ph11", "p09"),
    ("ph13", "p03"),
    ("ph17", "p09"),
    ("ph18", "p01"),
    ("ph19", "p08"),
]

PHOTO_ALBUMS: list[tuple[str, str]] = [
    ("ph05", "a1"),
    ("ph06", "a1"),
    ("ph07", "a1"),
    ("ph13", "a1"),
    ("ph14", "a1"),
    ("ph19", "a1"),
    ("ph01", "a2"),
    ("ph02", "a2"),
    ("ph03", "a3"),
    ("ph04", "a3"),
    ("ph17", "a3"),
]

# -------------------------------------------------------------------- docs
FOLDERS: list[tuple[str, str]] = [
    ("f1", "Contracts"),
    ("f2", "Receipts"),
    ("f3", "Personal"),
]

DOCUMENTS: list[tuple[str, str, str, str | None, str, str, int]] = [
    ("d1", "Initech MSA 2026.pdf", "pdf", "f1", "2026-09-16", "Master services agreement with Initech.", 0),
    ("d2", "Acme pilot contract.pdf", "pdf", "f1", "2026-09-12", "Pilot agreement with Acme, November start.", 0),
    ("d3", "Flat lease Koramangala.pdf", "pdf", "f3", "2026-08-30", "Rental lease for the Koramangala flat.", 0),
    ("d4", "Q3 invoices.sheet", "sheet", "f2", "2026-09-18", "Invoice ledger for Q3, including Initech.", 0),
    ("d5", "Offsite budget.sheet", "sheet", "f2", "2026-09-10", "Goa offsite budget and cab fare.", 0),
    ("d6", "Onboarding audit.doc", "doc", None, "2026-09-15", "Audit of the onboarding flow.", 1),
    ("d7", "Passport scan.image", "image", "f3", "2026-08-11", "Scanned passport for the visa application.", 0),
    ("d8", "Migration runbook.doc", "doc", None, "2026-09-17", "Step by step migration runbook.", 0),
]

# ------------------------------------------------------------------ locker
LOCKER_ITEMS: list[tuple[str, str, str, str | None, str | None]] = [
    ("l1", "Initech VPN", "login", "srikanth", "reused"),
    ("l2", "Hooli mail", "login", "srikanth@hooli.example", None),
    ("l3", "Bank card", "card", None, None),
    ("l4", "Safe code", "note", None, None),
    ("l5", "Old router", "login", "admin", "weak"),
    ("l6", "Passport details", "identity", None, None),
]

# ------------------------------------------------------------------- tally
TALLY_GROUPS: list[tuple[str, str]] = [
    ("g1", "Goa trip"),
    ("g2", "Flatmates"),
]

# amount > 0: they owe me. amount < 0: I owe them.
TALLY_ENTRIES: list[tuple[str, str, float, str, str | None, str, str, int]] = [
    ("x01", "Cab fare", 1200.0, "p01", "g1", "2026-09-12", "expense", 0),
    ("x02", "Cab fare", 1200.0, "p08", "g1", "2026-09-12", "expense", 0),
    ("x03", "Beach shack dinner", -800.0, "p03", "g1", "2026-09-12", "expense", 0),
    ("x04", "Hotel deposit", 3400.0, "p05", "g1", "2026-09-11", "expense", 0),
    ("x05", "Hotel deposit", 3400.0, "p13", "g1", "2026-09-11", "expense", 0),
    ("x06", "Groceries", -650.0, "p09", "g2", "2026-09-15", "expense", 0),
    ("x07", "Internet bill", 900.0, "p12", "g2", "2026-09-05", "expense", 0),
    ("x08", "Electricity", -450.0, "p09", "g2", "2026-09-02", "expense", 0),
    ("x09", "Lunch", 320.0, "p01", None, "2026-09-16", "expense", 0),
    ("x10", "Coffee", -180.0, "p03", None, "2026-09-14", "expense", 0),
    ("x11", "Concert tickets", 2500.0, "p15", None, "2026-08-28", "expense", 0),
    ("x12", "Book", -420.0, "p06", None, "2026-08-25", "expense", 0),
    ("x13", "Taxi to airport", 760.0, "p05", None, "2026-09-09", "expense", 0),
    ("x14", "Shared subscription", -300.0, "p11", None, "2026-09-03", "expense", 0),
    ("x15", "Birthday gift pool", 1500.0, "p12", None, "2026-09-18", "expense", 0),
    ("x16", "Dinner", -1100.0, "p07", None, "2026-08-20", "expense", 0),
    ("x17", "Cleaning service", 480.0, "p09", "g2", "2026-08-31", "expense", 0),
    ("x18", "Petrol", 640.0, "p08", None, "2026-09-07", "expense", 0),
    ("x19", "Old settlement", 2000.0, "p10", None, "2026-08-10", "expense", 1),
    ("x20", "Flight share", -2200.0, "p14", None, "2026-09-01", "expense", 0),
]


def build_world() -> sqlite3.Connection:
    """A fresh in-memory world, fully seeded.

    Foreign keys are on so a bad write command fails loudly rather than
    silently corrupting the fixture the suite is scored against.
    """
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    conn.executemany("INSERT INTO person VALUES (?,?,?,?,?,?,?,?)", PEOPLE)
    conn.executemany("INSERT INTO person_note VALUES (?,?,?,?)", PERSON_NOTES)
    conn.executemany("INSERT INTO interaction VALUES (?,?,?,?)", INTERACTIONS)
    conn.executemany(
        "INSERT INTO event (id,title,starts,ends,calendar,notes,place) VALUES (?,?,?,?,?,?,?)",
        EVENTS,
    )
    conn.executemany("INSERT INTO attendee VALUES (?,?,?)", ATTENDEES)
    conn.executemany("INSERT INTO project VALUES (?,?)", PROJECTS)
    conn.executemany("INSERT INTO task VALUES (?,?,?,?,?)", TASKS)
    conn.executemany("INSERT INTO task_assignee VALUES (?,?)", TASK_ASSIGNEES)
    conn.executemany("INSERT INTO notebook VALUES (?,?)", NOTEBOOKS)
    conn.executemany("INSERT INTO note VALUES (?,?,?,?,?)", NOTES)
    conn.executemany("INSERT INTO note_person VALUES (?,?)", NOTE_PEOPLE)
    conn.executemany("INSERT INTO album VALUES (?,?)", ALBUMS)
    conn.executemany("INSERT INTO photo VALUES (?,?,?,?)", PHOTOS)
    conn.executemany("INSERT INTO photo_person VALUES (?,?)", PHOTO_PEOPLE)
    conn.executemany("INSERT INTO photo_album VALUES (?,?)", PHOTO_ALBUMS)
    conn.executemany("INSERT INTO folder VALUES (?,?)", FOLDERS)
    conn.executemany(
        "INSERT INTO document (id,name,kind,folder_id,touched,text,starred) VALUES (?,?,?,?,?,?,?)",
        DOCUMENTS,
    )
    conn.executemany(
        "INSERT INTO locker_item (id,service,kind,username,health) VALUES (?,?,?,?,?)",
        LOCKER_ITEMS,
    )
    conn.executemany("INSERT INTO tally_group VALUES (?,?)", TALLY_GROUPS)
    conn.executemany("INSERT INTO tally_entry VALUES (?,?,?,?,?,?,?,?)", TALLY_ENTRIES)
    conn.commit()
    return conn


def reset() -> sqlite3.Connection:
    """A fresh world. Each scored case starts from one, so writes never leak."""
    return build_world()


def days(delta: int) -> date:
    """A date offset from the injected today."""
    return TODAY + timedelta(days=delta)
