"""World T18: Jordan Ellis, game developer in Melbourne (AUD vault).

    python3 authored/worlds/T18_build.py      # writes authored/worlds/T18.json (deterministic)

Today in the sessions is Sunday 2026-03-01 11:20. Jordan (they/them) lives alone in Brunswick
with Biscuit, a kelpie cross. They are a member of the Tinfoil Owl games co-op (pitching a
vertical slice to a publisher this week), play in a Thursday D&D group run by Bex, and are
co-hosting their sister Tess's baby shower on Sat 21 March with Tess's friend Chloe.
Built-in ambiguity: two Sams (co-op artist, D&D player), two Alexes (dog walker, cake baker),
nicknames (Mum, Dad, Nana, Bex, Jules, Ollie, Mei, Aunty Ro, Danno, Dr Farah), an accented
name (Zoë, Tomás), two "Pizza" debts, two "Playtest night" and three "Biscuit's vet check-up"-ish
events, near-duplicate tasks ("Buy dog food", "Pay rent", "Bring snacks for D&D"), cancelled
events, completed tasks, rows trashed inside and past the 30-day restore window, an empty
group, an empty folder, an empty notebook and an empty album, and a USD trip group.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        # family
        {"key": "tess", "name": "Tess Ellis", "role": "sister, due in April", "starred": True, "cadence": 7,
         "met": "family", "last_contacted": "2026-02-28T19:00", "last_contacted_kind": "call"},
        {"key": "dan_w", "name": "Daniel Whitford", "role": "brother-in-law, Tess's husband", "nickname": "Danno",
         "cadence": 30, "last_contacted": "2026-02-07T10:00", "last_contacted_kind": "visit"},
        {"key": "mum", "name": "Linda Ellis", "role": "mum", "nickname": "Mum", "starred": True, "cadence": 7,
         "last_contacted": "2026-02-22T10:00", "last_contacted_kind": "visit"},
        {"key": "dad", "name": "Graham Ellis", "role": "dad, Geelong", "nickname": "Dad", "cadence": 14,
         "last_contacted": "2026-02-08T12:00", "last_contacted_kind": "call"},
        {"key": "nana", "name": "Joan Price", "role": "grandmother", "nickname": "Nana", "cadence": 30,
         "last_contacted": "2026-01-18T14:00", "last_contacted_kind": "visit"},
        {"key": "aunt_rose", "name": "Rosemary Ellis", "role": "aunt", "nickname": "Aunty Ro", "cadence": 90,
         "last_contacted": "2025-12-25T13:00", "last_contacted_kind": "visit"},
        # co-op
        {"key": "priya", "name": "Priya Raman", "role": "co-op lead programmer", "cadence": 7, "met": "Global Game Jam",
         "last_contacted": "2026-02-27T15:00", "last_contacted_kind": "call"},
        {"key": "sam_o", "name": "Sam Okafor", "role": "co-op artist", "met": "RMIT",
         "last_contacted": "2026-02-27T15:00", "last_contacted_kind": "call"},
        {"key": "mei", "name": "Mei Lin Zhao", "role": "co-op producer", "nickname": "Mei", "cadence": 14,
         "met": "RMIT", "last_contacted": "2026-02-27T15:30", "last_contacted_kind": "call"},
        {"key": "oliver", "name": "Oliver Grant", "role": "co-op audio designer", "nickname": "Ollie",
         "last_contacted": "2026-02-20T21:00", "last_contacted_kind": "visit"},
        {"key": "rhys", "name": "Rhys Kavanagh", "role": "publisher, Hollow Pine", "met": "PAX Aus", "cadence": 30,
         "last_contacted": "2026-02-10T11:00", "last_contacted_kind": "call"},
        {"key": "ana", "name": "Ana Souza", "role": "QA contractor", "met": "PAX Aus"},
        {"key": "kieran", "name": "Kieran Doyle", "role": "accountant", "cadence": 90,
         "last_contacted": "2026-01-20T10:00", "last_contacted_kind": "call"},
        # D&D
        {"key": "bex", "name": "Rebecca Hollis", "role": "DM, Thursday D&D", "nickname": "Bex", "starred": True,
         "cadence": 7, "last_contacted": "2026-02-26T19:00", "last_contacted_kind": "visit"},
        {"key": "marcus", "name": "Marcus Webb", "role": "D&D player, plays the paladin",
         "last_contacted": "2026-02-19T19:00", "last_contacted_kind": "visit"},
        {"key": "jules", "name": "Juliette Park", "role": "D&D player", "nickname": "Jules",
         "last_contacted": "2026-02-26T19:00", "last_contacted_kind": "visit"},
        {"key": "tomas", "name": "Tomás Herrera", "role": "D&D player"},
        {"key": "sam_t", "name": "Sam Tran", "role": "D&D player, sometimes"},
        # shower
        {"key": "chloe", "name": "Chloe Nguyen", "role": "Tess's best friend, shower co-host", "cadence": 14,
         "last_contacted": "2026-02-24T20:00", "last_contacted_kind": "message"},
        {"key": "alex_m", "name": "Alexandra Moore", "role": "cake baker, Crumb & Co"},
        # others
        {"key": "alex_b", "name": "Alex Bui", "role": "dog walker"},
        {"key": "farah", "name": "Farah Siddiqui", "role": "vet, Northcote", "nickname": "Dr Farah"},
        {"key": "nadia", "name": "Nadia Kowalski", "role": "neighbour, minds Biscuit", "cadence": 14,
         "last_contacted": "2026-02-16T08:00", "last_contacted_kind": "message"},
        {"key": "liam", "name": "Liam Fraser", "role": "property manager"},
        {"key": "brooke", "name": "Brooke Tanner", "role": "climbing buddy", "met": "Northside Boulders",
         "last_contacted": "2026-02-23T18:00", "last_contacted_kind": "visit"},
        {"key": "zoe", "name": "Zoë Marsh", "role": "ex-colleague, Kestrel Interactive", "cadence": 30,
         "met": "Kestrel Interactive", "last_contacted": "2026-02-25T19:00", "last_contacted_kind": "coffee"},
        {"key": "hugo", "name": "Hugo Lambert", "role": "barber", "cadence": 42},
        # trashed: two inside the 30-day window, one past it
        {"key": "ethan", "name": "Ethan Cole", "role": "ex-flatmate", "trashed": "2026-02-20T10:00"},
        {"key": "pete", "name": "Pete Sandoval", "role": "removalist", "trashed": "2026-02-10T09:00"},
        {"key": "grace", "name": "Grace Liu", "role": "recruiter", "trashed": "2025-12-10T09:00"},
    ]


GROUPS = [
    {"key": "coop", "name": "Tinfoil Owl co-op", "currency": "AUD",
     "members": ["priya", "sam_o", "mei", "oliver"], "created": "2025-05-01T10:00"},
    {"key": "dnd", "name": "Thursday D&D", "members": ["bex", "marcus", "jules", "tomas", "sam_t"],
     "created": "2025-09-04T19:00"},
    {"key": "shower", "name": "Tess's baby shower", "members": ["chloe", "aunt_rose", "mum"],
     "created": "2026-02-05T20:00"},
    {"key": "gdc", "name": "GDC 2025 trip", "currency": "USD", "members": ["priya", "mei"],
     "created": "2025-03-01T10:00"},
    {"key": "ski", "name": "Ski weekend 2025", "members": ["brooke", "zoe"], "created": "2025-06-10T10:00"},
]

EXPENSES = [
    {"group": "coop", "name": "PAX booth deposit", "amount": 1200, "paid_by": "me",
     "split": ["me", "priya", "sam_o", "mei", "oliver"], "date": "2025-08-01"},
    {"group": "coop", "name": "Pizza for playtest", "amount": 150, "paid_by": "priya",
     "split": ["me", "priya", "sam_o"], "date": "2026-02-20"},
    {"group": "coop", "name": "Steam Direct fee", "amount": 160, "paid_by": "mei",
     "split": ["me", "priya", "sam_o", "mei", "oliver"], "date": "2025-11-03"},
    {"group": "dnd", "name": "Starter module", "amount": 90, "paid_by": "bex",
     "split": ["me", "bex", "marcus", "jules", "tomas", "sam_t"], "date": "2026-01-08"},
    {"group": "dnd", "name": "Pizza night", "amount": 120, "paid_by": "me",
     "split": ["me", "marcus", "jules", "tomas"], "date": "2026-02-19"},
    {"group": "shower", "name": "Cake deposit", "amount": 160, "paid_by": "me",
     "split": ["me", "chloe"], "date": "2026-02-23"},
    {"group": "shower", "name": "Decorations", "amount": 90, "paid_by": "chloe",
     "split": ["me", "chloe", "aunt_rose"], "date": "2026-02-24"},
    {"group": "gdc", "name": "Airbnb in SF", "amount": 1800, "paid_by": "mei",
     "split": ["me", "priya", "mei"], "date": "2025-03-15", "currency": "USD"},
]

LISTS = [
    {"key": "dev_l", "name": "Co-op dev", "area": "work"},
    {"key": "shower_l", "name": "Baby shower", "area": "family"},
    {"key": "dog_l", "name": "Biscuit", "area": "pets"},
    {"key": "dnd_l", "name": "D&D", "area": "hobby"},
    {"key": "home_l", "name": "Home"},
    {"key": "admin_l", "name": "Admin"},
]


def events():
    out = []
    # Thursday D&D, 7-11pm
    d = date(2026, 1, 8)
    while d <= date(2026, 4, 2):
        ev = {"key": f"dnd_{d.strftime('%m%d')}", "name": "D&D session", "start": f"{d}T19:00",
              "end": f"{d}T23:00", "attendees": ["bex", "marcus", "jules", "tomas"],
              "description": "Bex's place, Brunswick East"}
        if d == date(2026, 2, 12):
            ev["cancelled"] = "2026-02-10T12:00"
        out.append(ev)
        d += timedelta(weeks=1)
    # co-op sprint review, Fridays 3-4pm
    d = date(2026, 1, 9)
    while d <= date(2026, 3, 27):
        ev = {"key": f"sprint_{d.strftime('%m%d')}", "name": "Co-op sprint review", "start": f"{d}T15:00",
              "end": f"{d}T16:00", "attendees": ["priya", "sam_o", "mei", "oliver"], "description": "Discord call"}
        if d == date(2026, 3, 6):
            ev["end"] = f"{d}T15:30"  # short one, playtest that night
        out.append(ev)
        d += timedelta(weeks=1)
    # Biscuit's training class, Saturday mornings
    d = date(2026, 2, 7)
    while d <= date(2026, 3, 14):
        out.append({"key": f"dogclass_{d.strftime('%m%d')}", "name": "Dog training class", "start": f"{d}T09:00",
                    "end": f"{d}T10:00", "description": "Coburg Dog Club, bring treats"})
        d += timedelta(weeks=1)
    out += [
        # dog
        {"key": "vet_feb", "name": "Biscuit's vet check-up", "start": "2026-02-11T10:00", "end": "2026-02-11T10:30",
         "attendees": ["farah"], "description": "Northcote Vet"},
        {"key": "vet_apr", "name": "Biscuit's vet check-up", "start": "2026-04-15T10:00", "end": "2026-04-15T10:30",
         "attendees": ["farah"], "description": "Northcote Vet"},
        {"key": "vax", "name": "Biscuit's vaccination", "start": "2026-03-04T16:00", "end": "2026-03-04T16:30",
         "attendees": ["farah"], "description": "Northcote Vet, bring the vaccination card"},
        # shower + family
        {"key": "shower_ev", "name": "Tess's baby shower", "start": "2026-03-21T13:00", "end": "2026-03-21T16:00",
         "attendees": ["tess", "chloe", "mum", "aunt_rose"], "description": "Chloe's backyard, Coburg"},
        {"key": "shower_call", "name": "Shower planning call with Chloe", "start": "2026-03-03T19:30",
         "end": "2026-03-03T20:00", "attendees": ["chloe"]},
        {"key": "cake_tasting", "name": "Cake tasting", "start": "2026-03-10T17:30", "end": "2026-03-10T18:30",
         "attendees": ["alex_m", "tess"], "description": "Crumb & Co, Sydney Rd"},
        {"key": "mum_lunch", "name": "Lunch with Mum", "start": "2026-03-08T12:30", "end": "2026-03-08T14:00",
         "attendees": ["mum"]},
        {"key": "nana_lunch", "name": "Nana's 85th birthday lunch", "start": "2026-04-12T12:00",
         "end": "2026-04-12T15:00", "attendees": ["nana", "mum", "dad", "tess", "aunt_rose"],
         "description": "The Railway Hotel, Geelong"},
        {"key": "tess_scan", "name": "Tess's 34 week scan", "start": "2026-03-12T09:00", "end": "2026-03-12T10:00",
         "attendees": ["tess"], "description": "driving her, Dan's in Sydney"},
        # co-op
        {"key": "pitch", "name": "Publisher pitch with Hollow Pine", "start": "2026-03-05T11:00",
         "end": "2026-03-05T12:00", "attendees": ["rhys", "priya", "mei"], "description": "Zoom, show the vertical slice"},
        {"key": "playtest_feb", "name": "Playtest night", "start": "2026-02-20T18:00", "end": "2026-02-20T21:00",
         "attendees": ["priya", "sam_o", "ana"], "description": "co-op office, Collingwood"},
        {"key": "playtest_mar", "name": "Playtest night", "start": "2026-03-06T18:00", "end": "2026-03-06T21:00",
         "attendees": ["priya", "sam_o", "ana"], "description": "co-op office, Collingwood"},
        {"key": "agm", "name": "Co-op AGM", "start": "2026-03-25T18:00", "end": "2026-03-25T20:00",
         "attendees": ["priya", "sam_o", "mei", "oliver"], "description": "vote on the revenue split"},
        {"key": "tax_meet", "name": "Tax meeting with Kieran", "start": "2026-03-11T14:00", "end": "2026-03-11T15:00",
         "attendees": ["kieran"], "description": "bring receipts and the PAYG summary"},
        {"key": "jam", "name": "Global Game Jam", "start": "2026-01-30T17:00", "end": "2026-02-01T17:00",
         "attendees": ["priya", "oliver"], "description": "RMIT, building 80"},
        # me
        {"key": "climb_feb", "name": "Climbing with Brooke", "start": "2026-02-23T18:00", "end": "2026-02-23T19:30",
         "attendees": ["brooke"], "description": "Northside Boulders"},
        {"key": "climb_mar", "name": "Climbing with Brooke", "start": "2026-03-02T18:00", "end": "2026-03-02T19:30",
         "attendees": ["brooke"], "description": "Northside Boulders"},
        {"key": "haircut", "name": "Haircut", "start": "2026-03-09T17:00", "end": "2026-03-09T17:30",
         "attendees": ["hugo"]},
        {"key": "dentist", "name": "Dentist", "start": "2026-03-17T08:30", "end": "2026-03-17T09:15"},
        {"key": "inspection", "name": "Rental inspection", "start": "2026-03-18T10:00", "end": "2026-03-18T10:30",
         "attendees": ["liam"], "description": "Biscuit to Nadia's for the morning"},
        {"key": "zoe_dinner", "name": "Dinner with Zoë", "start": "2026-02-25T19:00", "end": "2026-02-25T21:00",
         "attendees": ["zoe"], "description": "Rumi, Lygon St"},
        {"key": "movie", "name": "Movie night with Nadia", "start": "2026-02-27T20:00", "end": "2026-02-27T22:30",
         "attendees": ["nadia"], "cancelled": "2026-02-27T12:00"},
        {"key": "trivia", "name": "Pub trivia", "start": "2026-03-10T19:30", "end": "2026-03-10T21:30",
         "attendees": ["zoe", "brooke"], "description": "The Retreat"},
        {"key": "band", "name": "Band practice", "start": "2026-02-24T19:00", "end": "2026-02-24T21:00",
         "trashed": "2026-02-22T09:00"},
        {"key": "market", "name": "Farmers market", "start": "2026-03-07T11:00", "end": "2026-03-07T12:00",
         "description": "Coburg, with Biscuit"},
    ]
    return out


def tasks():
    t = [
        # co-op dev
        {"key": "slice", "name": "Finish vertical slice build", "due": "2026-03-04", "priority": 1, "effort": 480,
         "status": "in_progress", "list": "dev_l", "description": "for the Hollow Pine pitch"},
        {"key": "cart", "name": "Fix cart physics", "due": "2026-03-03", "priority": 2, "effort": 120,
         "list": "dev_l", "description": "floaty on slopes"},
        {"key": "trailer", "name": "Cut the pitch trailer", "due": "2026-03-04", "priority": 1, "effort": 240,
         "list": "dev_l"},
        {"key": "tutorial", "name": "Shorten the tutorial", "due": "2026-03-06", "effort": 90, "list": "dev_l"},
        {"key": "capsule", "name": "Update Steam capsule art", "due": "2026-03-13", "effort": 60, "list": "dev_l"},
        {"key": "triage", "name": "Triage playtest bugs", "due": "2026-02-27", "completed": "2026-02-27T17:00",
         "effort": 60, "list": "dev_l"},
        {"key": "save_bug", "name": "Fix save corruption bug", "due": "2026-02-20", "completed": "2026-02-21T11:00",
         "effort": 180, "list": "dev_l"},
        {"key": "grant_report", "name": "Grant acquittal report", "due": "2026-03-31", "priority": 2, "effort": 120,
         "list": "dev_l"},
        {"key": "loc", "name": "Send strings for localisation", "list": "dev_l"},
        {"key": "ci", "name": "Fix the CI build", "due": "2026-03-02", "effort": 45, "list": "dev_l",
         "description": "runner out of disk"},
        {"key": "press_kit", "name": "Make a press kit", "list": "dev_l"},
        # shower
        {"key": "cake_dep", "name": "Pay cake deposit", "due": "2026-02-23", "completed": "2026-02-23T12:00",
         "list": "shower_l"},
        {"key": "invites", "name": "Send shower invites", "due": "2026-03-03", "priority": 1, "effort": 30,
         "list": "shower_l", "description": "digital, Tess approves the wording"},
        {"key": "inv_draft", "name": "Draft invite wording", "parent": "invites", "due": "2026-03-02", "effort": 20},
        {"key": "inv_ok", "name": "Get Tess to sign off the invite", "parent": "invites", "due": "2026-03-03"},
        {"key": "balloons", "name": "Order balloon arch", "due": "2026-03-10", "effort": 20, "list": "shower_l"},
        {"key": "baby_gift", "name": "Buy baby gift", "due": "2026-03-19", "effort": 60, "list": "shower_l"},
        {"key": "playlist", "name": "Make shower playlist", "list": "shower_l"},
        {"key": "print_games", "name": "Print shower games", "due": "2026-03-20", "effort": 30, "list": "shower_l"},
        {"key": "rsvps", "name": "Chase RSVPs", "due": "2026-03-14", "effort": 30, "list": "shower_l"},
        {"key": "chairs", "name": "Borrow folding chairs", "due": "2026-03-20", "list": "shower_l"},
        # dog
        {"key": "dog_food", "name": "Buy dog food", "due": "2026-03-02", "effort": 30, "list": "dog_l"},
        {"key": "dog_food_old", "name": "Buy dog food", "due": "2026-02-15", "completed": "2026-02-15T10:00",
         "list": "dog_l"},
        {"key": "vax_book", "name": "Book Biscuit's vaccination", "completed": "2026-02-12T09:00", "list": "dog_l"},
        {"key": "flea", "name": "Give Biscuit flea treatment", "due": "2026-03-05", "effort": 5, "list": "dog_l"},
        {"key": "pet_ins_t", "name": "Renew pet insurance", "due": "2026-03-28", "effort": 15, "list": "dog_l"},
        {"key": "nails", "name": "Trim Biscuit's nails", "due": "2026-02-28", "effort": 15, "list": "dog_l"},
        # D&D
        {"key": "minis", "name": "Paint the new minis", "status": "in_progress", "effort": 180, "list": "dnd_l"},
        {"key": "backstory", "name": "Update Wren's backstory", "due": "2026-03-05", "effort": 30, "list": "dnd_l"},
        {"key": "snacks", "name": "Bring snacks for D&D", "due": "2026-03-05", "effort": 15, "list": "dnd_l"},
        {"key": "snacks_old", "name": "Bring snacks for D&D", "due": "2026-02-26", "completed": "2026-02-26T18:30",
         "list": "dnd_l"},
        {"key": "escape", "name": "Book the escape room", "status": "cancelled", "list": "dnd_l"},
        # home
        {"key": "rent_jan", "name": "Pay rent", "due": "2026-01-01", "completed": "2025-12-31T20:00", "list": "home_l"},
        {"key": "rent_feb", "name": "Pay rent", "due": "2026-02-01", "completed": "2026-01-31T20:00", "list": "home_l"},
        {"key": "rent_mar", "name": "Pay rent", "due": "2026-03-01", "effort": 5, "list": "home_l"},
        {"key": "rent_apr", "name": "Pay rent", "due": "2026-04-01", "list": "home_l"},
        {"key": "tap", "name": "Fix dripping tap", "due": "2026-03-07", "list": "home_l",
         "description": "ask Liam before calling a plumber"},
        {"key": "bins", "name": "Put the bins out", "due": "2026-03-02", "effort": 5, "list": "home_l"},
        {"key": "groceries", "name": "Groceries", "due": "2026-03-01", "effort": 45, "list": "home_l"},
        {"key": "monstera", "name": "Repot the monstera", "list": "home_l"},
        {"key": "bike", "name": "Service the bike", "status": "cancelled", "list": "home_l"},
        {"key": "smoke", "name": "Test smoke alarm", "due": "2026-02-26", "completed": "2026-02-26T09:00",
         "effort": 5, "list": "home_l"},
        # admin
        {"key": "tax", "name": "Lodge tax return", "due": "2026-03-31", "priority": 1, "effort": 120,
         "list": "admin_l", "description": "through Kieran, co-op drawings included"},
        {"key": "super", "name": "Consolidate super", "priority": 3, "list": "admin_l"},
        {"key": "medicare", "name": "Update Medicare address", "completed": "2026-01-15T10:00", "list": "admin_l"},
        {"key": "licence_t", "name": "Renew driver licence", "due": "2026-05-12", "effort": 30, "list": "admin_l"},
        {"key": "phone_plan", "name": "Switch phone plan", "due": "2026-03-09", "effort": 30, "list": "admin_l"},
        {"key": "dentist_t", "name": "Book dentist", "completed": "2026-02-10T10:00", "list": "admin_l"},
        {"key": "call_nana", "name": "Call Nana", "due": "2026-03-01", "effort": 20},
        {"key": "nana_card", "name": "Nana's birthday card", "due": "2026-04-08", "effort": 15},
        {"key": "zoe_book", "name": "Return Zoë's book", "due": "2026-03-10"},
        {"key": "dice", "name": "Order a new dice set", "due": "2026-02-27", "effort": 10,
         "description": "metal ones, for Sam"},
        # trashed: one inside the restore window, one past it
        {"key": "library", "name": "Return library books", "due": "2026-02-18", "trashed": "2026-02-20T10:00"},
        {"key": "gym_cancel", "name": "Cancel old gym membership", "due": "2025-12-20",
         "trashed": "2026-01-05T10:00"},
        {"key": "jam_prep", "name": "Prep jam starter project", "due": "2026-01-29", "trashed": "2026-01-10T10:00"},
    ]
    return t


NOTEBOOKS = [
    {"key": "camp_nb", "name": "Campaign notes"},
    {"key": "design_nb", "name": "Game design"},
    {"key": "shower_nb", "name": "Shower planning"},
    {"key": "recipes_nb", "name": "Recipes"},
    {"key": "jam_nb", "name": "Jam ideas 2024"},
]

NOTES = [
    {"key": "recap", "name": "Session 12 recap", "body": "party split at the crypt, Wren lost the amulet",
     "notebook": "camp_nb", "created": "2026-02-26T23:30"},
    {"key": "npcs", "name": "NPC names", "body": "Mother Oaken, Captain Vesk, the Grey Pilgrim",
     "notebook": "camp_nb", "created": "2026-01-10T20:00", "pinned": True},
    {"key": "loot", "name": "Party loot", "body": "340 gold, bag of holding, cursed ring",
     "notebook": "camp_nb", "created": "2026-02-19T23:15"},
    {"key": "wren", "name": "Wren backstory", "body": "half-elf ranger, raised by smugglers on the coast",
     "notebook": "camp_nb", "created": "2025-12-20T21:00"},
    {"key": "core_loop", "name": "Core loop", "body": "dig, sort, trade, upgrade the cart",
     "notebook": "design_nb", "created": "2026-01-15T11:00", "pinned": True},
    {"key": "levels", "name": "Level ideas", "body": "flooded mine, night market, glass orchard",
     "notebook": "design_nb", "created": "2026-02-17T14:30"},
    {"key": "pt_feedback", "name": "Playtest feedback", "body": "tutorial too long, cart controls floaty",
     "notebook": "design_nb", "created": "2026-02-20T21:30"},
    {"key": "pitch_notes", "name": "Pitch notes for Rhys", "body": "lead with the trailer, ask about console ports",
     "notebook": "design_nb", "created": "2026-02-24T15:00"},
    {"key": "theme", "name": "Shower theme", "body": "woodland animals, sage and cream",
     "notebook": "shower_nb", "created": "2026-02-08T20:00"},
    {"key": "games_note", "name": "Shower games", "body": "guess the bump, nappy raffle",
     "notebook": "shower_nb", "created": "2026-02-12T21:00"},
    {"key": "food", "name": "Shower food", "body": "sandwiches, fruit platter, lemon slice",
     "notebook": "shower_nb", "created": "2026-02-15T19:30"},
    {"key": "dal", "name": "Red lentil dal", "body": "cumin, turmeric, finish with lemon",
     "notebook": "recipes_nb", "created": "2025-08-02T18:00"},
    {"key": "treats", "name": "Peanut butter dog treats", "body": "oat flour, peanut butter, one egg",
     "notebook": "recipes_nb", "created": "2025-11-20T15:00"},
    {"key": "banana", "name": "Banana bread", "body": "three brown bananas, walnuts",
     "notebook": "recipes_nb", "created": "2026-02-07T09:00"},
    {"key": "gift_ideas", "name": "Gift ideas for the baby", "body": "merino wrap, board books",
     "created": "2026-02-22T20:00"},
    {"key": "tax_q", "name": "Questions for Kieran", "body": "home office percentage, co-op drawings",
     "created": "2026-02-25T09:15"},
    {"key": "misc_ideas", "name": "Random ideas", "body": "a cozy game about lighthouse keepers",
     "created": "2026-01-02T23:00"},
    {"key": "vet_notes", "name": "Vet notes", "body": "Biscuit 21kg, vaccination due in March",
     "created": "2026-02-11T11:00"},
    {"key": "climb_log", "name": "Climbing log", "body": "sent the yellow V4 in the cave",
     "created": "2026-02-23T20:30"},
    {"key": "flat", "name": "Flat maintenance", "body": "tap drips, back door sticks",
     "created": "2026-02-01T10:00"},
    {"key": "old_todo", "name": "Old todo list", "body": "move out, bond, redirect mail",
     "created": "2025-10-01T10:00", "trashed": "2026-02-25T10:00"},
    {"key": "jam_brain", "name": "Jam brainstorm", "body": "theme guesses for 2025",
     "created": "2025-01-20T10:00", "trashed": "2025-11-02T10:00"},
]

FOLDERS = [
    {"key": "coop_f", "name": "Co-op admin"},
    {"key": "tax_f", "name": "Tax 2025"},
    {"key": "lease_f", "name": "Lease"},
    {"key": "dog_f", "name": "Biscuit"},
    {"key": "shower_f", "name": "Shower"},
    {"key": "old_f", "name": "Old contracts"},
]

DOCUMENTS = [
    {"key": "agreement", "name": "Co-op members agreement", "folder": "coop_f", "starred": True,
     "created": "2025-06-01T10:00"},
    {"key": "rev_split", "name": "Revenue split sheet", "folder": "coop_f", "created": "2026-02-16T14:00"},
    {"key": "deck", "name": "Hollow Pine pitch deck", "folder": "coop_f", "starred": True,
     "created": "2026-02-24T16:30"},
    {"key": "steam_contract", "name": "Steam distribution agreement", "folder": "coop_f",
     "created": "2025-11-03T09:00"},
    {"key": "grant", "name": "Creative Victoria grant application", "folder": "coop_f",
     "created": "2026-01-20T11:00"},
    {"key": "payg", "name": "PAYG summary 2025", "folder": "tax_f", "created": "2025-07-14T09:00"},
    {"key": "receipts", "name": "Work receipts 2025", "folder": "tax_f", "created": "2025-12-31T17:00"},
    {"key": "abn", "name": "ABN registration", "folder": "tax_f", "created": "2024-08-01T10:00"},
    {"key": "lease", "name": "Lease agreement 2025", "folder": "lease_f", "starred": True,
     "created": "2025-04-01T10:00"},
    {"key": "bond", "name": "Bond lodgement", "folder": "lease_f", "created": "2025-04-02T11:00"},
    {"key": "condition", "name": "Condition report", "folder": "lease_f", "created": "2025-04-05T15:00"},
    {"key": "vax_card", "name": "Biscuit vaccination card", "folder": "dog_f", "created": "2025-03-10T12:00"},
    {"key": "microchip", "name": "Microchip certificate", "folder": "dog_f", "created": "2024-05-20T12:00"},
    {"key": "pet_ins", "name": "Pet insurance policy", "folder": "dog_f", "created": "2026-02-02T09:30"},
    {"key": "budget", "name": "Shower budget", "folder": "shower_f", "created": "2026-02-09T21:00"},
    {"key": "guests", "name": "Shower guest list", "folder": "shower_f", "created": "2026-02-18T20:30"},
    {"key": "invite_doc", "name": "Invitation draft", "created": "2026-02-26T22:15"},
    {"key": "scan", "name": "Scan 27 Feb", "created": "2026-02-27T10:00"},
    {"key": "char_sheet", "name": "Character sheet Wren", "created": "2026-01-08T18:00"},
    {"key": "resume", "name": "Resume 2023", "created": "2023-05-01T10:00", "trashed": "2026-02-18T10:00"},
]

ALBUMS = [
    {"key": "biscuit_al", "name": "Biscuit"},
    {"key": "pax_al", "name": "PAX Aus 2025"},
    {"key": "minis_al", "name": "D&D minis"},
    {"key": "shower_al", "name": "Shower ideas"},
    {"key": "melb_al", "name": "Melbourne walks"},
    {"key": "tassie_al", "name": "Tassie trip"},
]

PHOTOS = [
    {"key": "b_beach", "name": "Biscuit at Brighton beach", "taken": "2026-01-18T10:15", "albums": ["biscuit_al"],
     "starred": True},
    {"key": "b_couch", "name": "Biscuit on the couch", "taken": "2026-02-22T21:00", "albums": ["biscuit_al"]},
    {"key": "b_puppy", "name": "Biscuit as a puppy", "taken": "2024-05-02T12:00", "albums": ["biscuit_al"],
     "starred": True},
    {"key": "b_class", "name": "Biscuit at training class", "taken": "2026-02-21T09:30", "albums": ["biscuit_al"]},
    {"key": "b_bday", "name": "Biscuit's second birthday", "taken": "2026-02-14T18:00", "albums": ["biscuit_al"],
     "people": ["nadia", "tess"], "starred": True},
    {"key": "b_creek", "name": "Biscuit at Merri Creek", "taken": "2026-02-28T08:10",
     "albums": ["biscuit_al", "melb_al"]},
    {"key": "b_vet", "name": "Biscuit at the vet", "taken": "2026-02-11T10:20", "albums": ["biscuit_al"],
     "people": ["farah"]},
    {"key": "b_snow", "name": "Biscuit in the snow", "taken": "2025-07-12T11:00", "albums": ["biscuit_al"]},
    {"key": "pax_booth", "name": "Our PAX booth", "taken": "2025-10-10T11:00", "albums": ["pax_al"],
     "people": ["priya", "sam_o", "mei"], "starred": True},
    {"key": "pax_crowd", "name": "Crowd at the booth", "taken": "2025-10-11T14:00", "albums": ["pax_al"]},
    {"key": "pax_rhys", "name": "Coffee with Rhys", "taken": "2025-10-11T16:30", "albums": ["pax_al"],
     "people": ["rhys"]},
    {"key": "pax_team", "name": "Co-op team photo", "taken": "2025-10-12T17:00", "albums": ["pax_al"],
     "people": ["priya", "sam_o", "mei", "oliver"], "starred": True},
    {"key": "pax_ana", "name": "Ana playtesting", "taken": "2025-10-12T13:00", "albums": ["pax_al"],
     "people": ["ana"]},
    {"key": "m_dragon", "name": "Painted dragon mini", "taken": "2026-02-15T16:00", "albums": ["minis_al"],
     "starred": True},
    {"key": "m_party", "name": "Party minis lineup", "taken": "2026-02-19T22:30", "albums": ["minis_al"],
     "people": ["bex", "marcus", "jules", "tomas"]},
    {"key": "m_map", "name": "Battle map", "taken": "2026-02-26T21:45", "albums": ["minis_al"], "people": ["bex"]},
    {"key": "m_tpk", "name": "The TPK night", "taken": "2026-01-29T23:00", "albums": ["minis_al"],
     "people": ["bex", "marcus", "sam_t"], "starred": True},
    {"key": "s_cake", "name": "Cake inspo", "taken": "2026-02-10T20:00", "albums": ["shower_al"], "starred": True},
    {"key": "s_arch", "name": "Balloon arch idea", "taken": "2026-02-12T20:05", "albums": ["shower_al"],
     "starred": True},
    {"key": "s_tess", "name": "Tess at 30 weeks", "taken": "2026-02-15T12:00", "albums": ["shower_al"],
     "people": ["tess"], "starred": True},
    {"key": "tram", "name": "Tram at dusk", "taken": "2026-01-22T20:10", "albums": ["melb_al"]},
    {"key": "laneway", "name": "Hosier Lane", "taken": "2026-01-24T13:00", "albums": ["melb_al"]},
    {"key": "yarra", "name": "Yarra sunrise", "taken": "2026-02-01T06:30", "albums": ["melb_al"], "starred": True},
    {"key": "xmas", "name": "Christmas at Mum's", "taken": "2025-12-25T13:00",
     "people": ["mum", "dad", "tess", "dan_w", "nana"], "starred": True},
    {"key": "markets", "name": "Tess and Mum at the markets", "taken": "2026-02-07T10:00", "people": ["tess", "mum"]},
    {"key": "baking", "name": "Tess and Mum baking", "taken": "2025-11-16T15:00", "people": ["tess", "mum"]},
    {"key": "nana_cake", "name": "Nana with the cake", "taken": "2025-04-13T13:00", "people": ["nana", "mum"]},
    {"key": "v4", "name": "Top of the V4", "taken": "2026-02-23T19:00", "people": ["brooke"]},
    {"key": "whiteboard", "name": "Sprint whiteboard", "taken": "2026-02-27T15:30"},
    {"key": "receipt_p", "name": "Pizza receipt", "taken": "2026-02-19T22:00"},
    {"key": "screenshot", "name": "Build screenshot", "taken": "2026-02-26T17:00"},
    {"key": "zoe_rumi", "name": "Dinner at Rumi", "taken": "2026-02-25T20:15", "people": ["zoe"]},
    {"key": "blurry", "name": "Blurry Biscuit", "taken": "2026-02-28T08:11", "trashed": "2026-02-28T09:00"},
    {"key": "tram_copy", "name": "Tram at dusk copy", "taken": "2026-01-22T20:10", "trashed": "2026-01-23T09:00"},
]

DEBTS = [
    {"key": "d_marcus_pizza", "person": "marcus", "direction": "owes_me", "amount": 24, "name": "Pizza",
     "date": "2026-02-19"},
    {"key": "d_jules_pizza", "person": "jules", "direction": "i_owe", "amount": 18, "name": "Pizza",
     "date": "2026-02-26"},
    {"key": "d_sam_dice", "person": "sam_t", "direction": "owes_me", "amount": 35, "name": "Dice set",
     "date": "2026-02-05"},
    {"key": "d_tess_cake", "person": "tess", "direction": "owes_me", "amount": 80, "name": "Cake deposit share",
     "date": "2026-02-23"},
    {"key": "d_chloe", "person": "chloe", "direction": "i_owe", "amount": 45, "name": "Balloons",
     "date": "2026-02-24"},
    {"key": "d_nadia", "person": "nadia", "direction": "i_owe", "amount": 60, "name": "Dog sitting",
     "date": "2026-02-16"},
    {"key": "d_priya", "person": "priya", "direction": "i_owe", "amount": 22, "name": "Lunch at Kaiju",
     "date": "2026-02-27"},
    {"key": "d_ollie", "person": "oliver", "direction": "owes_me", "amount": 150, "name": "Microphone",
     "date": "2026-01-12"},
    {"key": "d_zoe", "person": "zoe", "direction": "owes_me", "amount": 95, "name": "Concert tickets",
     "date": "2025-12-05"},
    {"key": "d_dad", "person": "dad", "direction": "i_owe", "amount": 40, "name": "Petrol money",
     "date": "2026-02-08", "settled": "2026-02-10T18:00"},
    {"key": "d_brooke", "person": "brooke", "direction": "owes_me", "amount": 70, "name": "Climbing shoes",
     "date": "2026-01-25", "settled": "2026-02-23T19:40"},
    {"key": "d_alex", "person": "alex_b", "direction": "i_owe", "amount": 120, "name": "Dog walks",
     "date": "2026-02-28"},
    {"key": "d_bex", "person": "bex", "direction": "owes_me", "amount": 55, "name": "Module book",
     "date": "2026-02-26"},
]

LOCKER = [
    {"key": "steamworks", "name": "Steamworks", "type": "login", "username": "jordan@tinfoilowl.games",
     "url": "https://partner.steamgames.com", "password": "Owl-Cart-2026!", "notes": "co-op account", "starred": True},
    {"key": "itch", "name": "itch.io", "type": "login", "username": "jordanellis", "url": "https://itch.io/login",
     "password": "wren-ranger-88"},
    {"key": "github", "name": "GitHub", "type": "login", "username": "jellis-dev", "url": "https://github.com/login",
     "password": "merri-creek-41", "code": "JBSW-Y3DP-EHPK"},
    {"key": "mygov", "name": "myGov", "type": "login", "username": "jordan.ellis@fastmail.com",
     "url": "https://my.gov.au", "password": "Brunswick#2056", "notes": "tax and medicare"},
    {"key": "visa", "name": "Visa debit", "type": "card", "card_number": "4111 2222 3333 4444", "cvv": "719",
     "starred": True},
    {"key": "studio_door", "name": "Studio door code", "type": "note", "notes": "4417#, changes every quarter"},
    {"key": "medicare_l", "name": "Medicare card", "type": "identity"},
    {"key": "wifi", "name": "Home wifi", "type": "wifi", "password": "biscuit-kelpie-5"},
    {"key": "laptop", "name": "Laptop login", "type": "password", "password": "Glass-Orchard-7"},
    {"key": "ssh", "name": "Build server key", "type": "ssh_key", "notes": "co-op CI box"},
    {"key": "discord_bot", "name": "Discord bot token", "type": "api_credential", "notes": "playtest bot"},
    {"key": "passport", "name": "Australian passport", "type": "passport", "notes": "expires 2031"},
    {"key": "ing", "name": "ING savings", "type": "bank_account", "notes": "shower fund lives here"},
    {"key": "licence", "name": "Victorian driver licence", "type": "driving_licence"},
    {"key": "unity", "name": "Unity Pro licence", "type": "software_licence", "notes": "seat 2 of 3"},
    {"key": "eth", "name": "Old ETH wallet", "type": "crypto_wallet", "notes": "jam prize from 2021"},
    {"key": "gym", "name": "Northside Boulders membership", "type": "membership", "notes": "renews in June"},
    {"key": "birth_cert", "name": "Birth certificate scan", "type": "document"},
    {"key": "epic", "name": "Old Epic account", "type": "login", "username": "jellis", "url": "https://epicgames.com",
     "password": "fortnite-no-9", "trashed": "2026-02-20T10:00"},
]

LINKS = [
    {"from": "slice", "to": "priya"},
    {"from": "trailer", "to": "oliver"},
    {"from": "capsule", "to": "sam_o"},
    {"from": "ci", "to": "priya"},
    {"from": "grant_report", "to": "mei"},
    {"from": "triage", "to": "ana"},
    {"from": "cake_dep", "to": "alex_m"},
    {"from": "invites", "to": "chloe"},
    {"from": "invites", "to": "tess"},
    {"from": "inv_ok", "to": "tess"},
    {"from": "balloons", "to": "chloe"},
    {"from": "rsvps", "to": "chloe"},
    {"from": "rsvps", "to": "aunt_rose"},
    {"from": "chairs", "to": "nadia"},
    {"from": "backstory", "to": "bex"},
    {"from": "tap", "to": "liam"},
    {"from": "tax", "to": "kieran"},
    {"from": "call_nana", "to": "nana"},
    {"from": "nana_card", "to": "nana"},
    {"from": "zoe_book", "to": "zoe"},
    {"from": "dice", "to": "sam_t"},
    {"from": "recap", "to": "bex"},
    {"from": "loot", "to": "marcus"},
    {"from": "loot", "to": "jules"},
    {"from": "pt_feedback", "to": "ana"},
    {"from": "pt_feedback", "to": "priya"},
    {"from": "pitch_notes", "to": "rhys"},
    {"from": "theme", "to": "chloe"},
    {"from": "theme", "to": "tess"},
    {"from": "food", "to": "chloe"},
    {"from": "gift_ideas", "to": "tess"},
    {"from": "tax_q", "to": "kieran"},
    {"from": "vet_notes", "to": "farah"},
    {"from": "climb_log", "to": "brooke"},
    {"from": "flat", "to": "liam"},
]


def world():
    return {
        "me": "Jordan Ellis",
        "epoch": "2023-01-01T09:00",
        "seed": "T18",
        "currency": "AUD",
        "people": people(),
        "groups": GROUPS,
        "expenses": EXPENSES,
        "lists": LISTS,
        "events": events(),
        "tasks": tasks(),
        "notebooks": NOTEBOOKS,
        "notes": NOTES,
        "folders": FOLDERS,
        "documents": DOCUMENTS,
        "albums": ALBUMS,
        "photos": PHOTOS,
        "debts": DEBTS,
        "locker": LOCKER,
        "links": LINKS,
    }


def check_overlaps(evs):
    spans = []
    for e in evs:
        if e.get("trashed"):
            continue
        s = datetime.fromisoformat(e["start"])
        f = datetime.fromisoformat(e["end"])
        spans.append((s, f, e["key"]))
    spans.sort()
    end, last = None, None
    for s1, f1, k1 in spans:
        assert end is None or end <= s1, f"overlap {last} / {k1}"
        if end is None or f1 > end:
            end, last = f1, k1


def check_keys(w):
    keys = []
    for v in w.values():
        if isinstance(v, list):
            keys += [r["key"] for r in v if isinstance(r, dict) and "key" in r]
    dup = {k for k in keys if keys.count(k) > 1}
    assert not dup, dup


if __name__ == "__main__":
    w = world()
    check_overlaps(w["events"])
    check_keys(w)
    out = HERE / "T18.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
