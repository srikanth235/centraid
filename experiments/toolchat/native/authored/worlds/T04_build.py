"""World T04: Aisha Rahman, junior doctor on rotating shifts in Leeds (GBP vault).

    python3 authored/worlds/T04_build.py      # writes authored/worlds/T04.json (deterministic)

Today in the sessions is Wednesday 2026-10-14 19:40 (a day off between long days).
Built-in ambiguity: two Fatimas (Fatima Khan, Fatima Hussain), a nickname-only aunt (Auntie
Nasreen), Mum/Dad as Ammi/Abbu, a hard-to-spell name (Aoife), two dress fittings, several
Sunday lunches, look-alike tasks (two washing-up-liquid tasks, two rent tasks, a year of car loan
payments), cancelled events, completed tasks, and a few trashed rows.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        {"key": "mum", "name": "Rukhsana Rahman", "role": "mum", "nickname": "Ammi", "cadence": 7, "starred": True,
         "last_contacted": "2026-10-11T18:00", "last_contacted_kind": "call", "met": "Bradford"},
        {"key": "dad", "name": "Tariq Rahman", "role": "dad", "nickname": "Abbu", "cadence": 14,
         "last_contacted": "2026-10-04T14:00", "last_contacted_kind": "visit", "met": "Bradford"},
        {"key": "zainab", "name": "Zainab Rahman", "role": "sister", "starred": True, "cadence": 3,
         "last_contacted": "2026-10-13T21:30", "last_contacted_kind": "message"},
        {"key": "imran", "name": "Imran Rahman", "role": "brother", "cadence": 14,
         "last_contacted": "2026-09-27T15:00", "last_contacted_kind": "visit"},
        {"key": "nasreen", "name": "Nasreen Akhtar", "role": "aunt", "nickname": "Auntie Nasreen", "cadence": 30,
         "last_contacted": "2026-08-30T13:00", "last_contacted_kind": "visit"},
        {"key": "fatima_k", "name": "Fatima Khan", "role": "cousin", "met": "Manningham", "cadence": 30,
         "last_contacted": "2026-09-12T17:00", "last_contacted_kind": "coffee"},
        {"key": "fatima_h", "name": "Fatima Hussain", "role": "cousin, bridesmaid", "cadence": 14,
         "last_contacted": "2026-10-10T20:00", "last_contacted_kind": "message"},
        {"key": "bilal", "name": "Bilal Akhtar", "role": "cousin"},
        {"key": "sana", "name": "Sana Akhtar", "role": "cousin", "cadence": 21,
         "last_contacted": "2026-10-02T19:00", "last_contacted_kind": "message"},
        {"key": "hamza", "name": "Hamza Qureshi", "role": "Zainab's fiance", "met": "engagement, March 2026"},
        {"key": "chloe", "name": "Chloe Barnes", "role": "housemate", "cadence": 7,
         "last_contacted": "2026-10-14T08:00", "last_contacted_kind": "message"},
        {"key": "tom", "name": "Tom Whitfield", "role": "housemate", "nickname": "Whitters",
         "last_contacted": "2026-10-12T22:00", "last_contacted_kind": "message"},
        {"key": "priya", "name": "Priya Menon", "role": "medical registrar, AMU", "starred": True,
         "last_contacted": "2026-10-13T19:00", "last_contacted_kind": "call"},
        {"key": "james", "name": "James O'Connor", "role": "F2 doctor, AMU"},
        {"key": "ellie", "name": "Ellie Clarke", "role": "F1 doctor, AMU", "met": "induction, August 2026",
         "last_contacted": "2026-10-09T13:00", "last_contacted_kind": "message"},
        {"key": "dan", "name": "Daniel Osei", "role": "F2 doctor, AMU", "nickname": "Dan"},
        {"key": "hughes", "name": "Mark Hughes", "role": "consultant, educational supervisor",
         "last_contacted": "2026-09-30T11:00", "last_contacted_kind": "meeting"},
        {"key": "grace", "name": "Grace Adeyemi", "role": "ward sister, AMU"},
        {"key": "leah", "name": "Leah Morgan", "role": "friend", "met": "Leeds med school, 2016", "cadence": 21,
         "last_contacted": "2026-09-20T19:00", "last_contacted_kind": "coffee"},
        {"key": "aoife", "name": "Aoife Brennan", "role": "friend, GP trainee", "met": "Leeds med school, 2017",
         "cadence": 30, "last_contacted": "2026-08-15T12:00", "last_contacted_kind": "coffee"},
        {"key": "ravi", "name": "Ravi Patel", "role": "friend"},
        {"key": "pete", "name": "Pete Sutcliffe", "role": "food bank coordinator",
         "last_contacted": "2026-10-10T12:30", "last_contacted_kind": "visit"},
        {"key": "margaret", "name": "Margaret Firth", "role": "food bank volunteer"},
        {"key": "owen", "name": "Owen Price", "role": "darkroom club", "met": "Leeds Photo Co-op",
         "cadence": 14, "last_contacted": "2026-09-29T21:00", "last_contacted_kind": "visit"},
        {"key": "kev", "name": "Kevin Barker", "role": "mechanic, Barker Motors", "nickname": "Kev"},
        {"key": "sharma", "name": "Anil Sharma", "role": "dentist"},
        {"key": "gary", "name": "Gary Lister", "role": "landlord"},
        {"key": "rebecca", "name": "Rebecca Lowe", "role": "events coordinator, Oakwood Hall"},
        {"key": "kashif", "name": "Kashif Mahmood", "role": "caterer, Mahmood Catering"},
        {"key": "shazia", "name": "Shazia Begum", "role": "mehndi artist"},
        {"key": "craig", "name": "Craig Benson", "role": "personal trainer", "trashed": "2026-10-01T10:00"},
    ]


GROUPS = [
    {"key": "house", "name": "House bills", "members": ["chloe", "tom"], "created": "2025-09-01T10:00"},
    {"key": "wedding", "name": "Wedding fund", "members": ["zainab", "imran", "fatima_h", "hamza"],
     "created": "2026-04-02T20:00"},
    {"key": "hen", "name": "Istanbul hen do", "currency": "TRY", "members": ["zainab", "fatima_h", "sana", "aoife"],
     "created": "2026-07-18T21:00"},
    {"key": "rota", "name": "Rota swap pool", "members": ["ellie", "james", "dan"], "created": "2026-08-05T13:00"},
    {"key": "darkroom", "name": "Darkroom club", "members": ["owen", "ravi"], "created": "2026-03-10T19:00"},
    {"key": "santa", "name": "Secret Santa 2026", "members": ["chloe", "tom", "leah"], "created": "2026-10-06T21:00"},
    # no expenses yet: deletable, and "the house group" collides with House bills
    {"key": "house_party", "name": "House party", "members": ["chloe", "tom", "leah", "ravi"], "created": "2026-10-10T22:00"},
    {"key": "relay", "name": "Leeds 10k relay", "members": ["priya", "ellie"], "created": "2026-09-18T20:00"},
]

EXPENSES = [
    {"group": "house", "name": "Electric bill August", "amount": 126.30, "paid_by": "me", "split": ["me", "chloe", "tom"], "date": "2026-08-28"},
    {"group": "house", "name": "Broadband September", "amount": 36, "paid_by": "tom", "split": ["me", "chloe", "tom"], "date": "2026-09-03"},
    {"group": "house", "name": "Big Aldi shop", "amount": 88.20, "paid_by": "chloe", "split": ["me", "chloe", "tom"], "date": "2026-09-19"},
    {"group": "house", "name": "Gas bill September", "amount": 94.50, "paid_by": "me", "split": ["me", "chloe", "tom"], "date": "2026-09-29"},
    {"group": "house", "name": "Toilet roll and bin bags", "amount": 17.40, "paid_by": "tom", "split": ["me", "chloe", "tom"], "date": "2026-10-07"},
    {"group": "wedding", "name": "Oakwood Hall deposit", "amount": 2000, "paid_by": "me", "split": ["me", "zainab", "imran", "hamza"], "date": "2026-05-10"},
    {"group": "wedding", "name": "Mehndi artist deposit", "amount": 150, "paid_by": "fatima_h", "split": ["me", "zainab", "fatima_h"], "date": "2026-08-02"},
    {"group": "wedding", "name": "Caterer deposit", "amount": 1200, "paid_by": "imran", "split": ["me", "zainab", "imran", "hamza"], "date": "2026-09-01"},
    {"group": "wedding", "name": "Invitations printing", "amount": 240, "paid_by": "zainab", "split": ["me", "zainab"], "date": "2026-09-14"},
    {"group": "wedding", "name": "Stage flowers deposit", "amount": 300, "paid_by": "me", "split": ["me", "zainab", "imran", "hamza"], "date": "2026-10-03"},
    {"group": "hen", "name": "Hotel in Sultanahmet", "amount": 24000, "paid_by": "me", "split": ["me", "zainab", "fatima_h", "sana", "aoife"], "date": "2026-07-20"},
    {"group": "hen", "name": "Bosphorus cruise booking", "amount": 7500, "paid_by": "sana", "split": ["me", "zainab", "fatima_h", "sana", "aoife"], "date": "2026-09-05"},
    {"group": "hen", "name": "Hammam vouchers", "amount": 6000, "paid_by": "fatima_h", "split": ["me", "fatima_h", "sana", "aoife"], "date": "2026-09-25"},
    {"group": "rota", "name": "Night shift pizzas", "amount": 42, "paid_by": "james", "split": ["me", "ellie", "james", "dan"], "date": "2026-09-26"},
    {"group": "rota", "name": "Coffee run", "amount": 16, "paid_by": "me", "split": ["me", "ellie", "james", "dan"], "date": "2026-10-06"},
    {"group": "darkroom", "name": "Ilford chemicals", "amount": 54, "paid_by": "owen", "split": ["me", "owen", "ravi"], "date": "2026-09-15"},
    {"group": "darkroom", "name": "Paper pack", "amount": 27, "paid_by": "me", "split": ["me", "owen", "ravi"], "date": "2026-09-29"},
]

LISTS = [
    {"key": "wedlist", "name": "Wedding prep", "area": "family"},
    {"key": "houselist", "name": "House", "area": "home"},
    {"key": "fblist", "name": "Food bank", "area": "volunteering"},
    {"key": "worklist", "name": "Work admin", "area": "work"},
    {"key": "istlist", "name": "Istanbul", "area": "travel"},
]


def shift(kind, day):
    d = date.fromisoformat(day)
    if kind == "long":
        return {"key": f"ld_{d.strftime('%m%d')}", "name": "Long day AMU", "start": f"{d}T08:00", "end": f"{d}T20:30",
                "attendees": ["priya"]}
    nxt = d + timedelta(days=1)
    return {"key": f"night_{d.strftime('%m%d')}", "name": "Night shift AMU", "start": f"{d}T20:00",
            "end": f"{nxt}T08:30", "attendees": ["james"]}


LONG_DAYS = ["2026-09-30", "2026-10-01", "2026-10-11", "2026-10-12", "2026-10-13",
             "2026-10-16", "2026-10-27", "2026-10-28", "2026-11-09", "2026-11-10", "2026-11-11"]
NIGHTS = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-19",
          "2026-10-20", "2026-11-05", "2026-11-06", "2026-11-07"]


def events():
    out = [shift("long", x) for x in LONG_DAYS] + [shift("night", x) for x in NIGHTS]
    # food bank, Saturday mornings
    day = date(2026, 9, 19)
    while day <= date(2026, 11, 28):
        if day != date(2026, 11, 21):
            ev = {"key": f"fb_{day.strftime('%m%d')}", "name": "Food bank shift", "start": f"{day}T09:30",
                  "end": f"{day}T12:30", "attendees": ["pete", "margaret"], "description": "St Aidan's church hall"}
            if day == date(2026, 10, 3):
                ev["cancelled"] = "2026-10-01T18:00"
            out.append(ev)
        day += timedelta(weeks=1)
    # darkroom nights, Thursdays fortnightly
    for x in ["2026-09-03", "2026-09-17", "2026-10-15", "2026-10-29", "2026-11-12"]:
        d = date.fromisoformat(x)
        out.append({"key": f"dark_{d.strftime('%m%d')}", "name": "Darkroom night", "start": f"{d}T18:30",
                    "end": f"{d}T21:00", "attendees": ["owen"], "description": "Leeds Photo Co-op"})
    out += [
        # family
        {"key": "lunch_0927", "name": "Sunday lunch at Mum and Dad's", "start": "2026-09-27T13:00", "end": "2026-09-27T16:00",
         "attendees": ["mum", "dad", "imran"]},
        {"key": "lunch_1018", "name": "Sunday lunch at Mum and Dad's", "start": "2026-10-18T13:00", "end": "2026-10-18T16:00",
         "attendees": ["mum", "dad"]},
        {"key": "lunch_1115", "name": "Sunday lunch at Mum and Dad's", "start": "2026-11-15T13:00", "end": "2026-11-15T16:00",
         "attendees": ["mum", "dad", "zainab"]},
        {"key": "lunch_nasreen", "name": "Sunday lunch with Auntie Nasreen", "start": "2026-10-25T13:00", "end": "2026-10-25T15:30",
         "attendees": ["nasreen", "mum"]},
        {"key": "imran_bday", "name": "Imran's birthday dinner", "start": "2026-11-08T18:00", "end": "2026-11-08T21:00",
         "attendees": ["imran", "mum", "dad", "zainab"], "description": "Akbar's, Bradford"},
        # wedding
        {"key": "venue_visit", "name": "Oakwood Hall venue visit", "start": "2026-09-20T11:00", "end": "2026-09-20T12:30",
         "attendees": ["zainab", "rebecca"]},
        {"key": "fitting_1", "name": "Dress fitting with Zainab", "start": "2026-10-17T14:00", "end": "2026-10-17T16:00",
         "attendees": ["zainab"]},
        {"key": "fitting_2", "name": "Dress fitting with Zainab", "start": "2026-11-14T14:00", "end": "2026-11-14T16:00",
         "attendees": ["zainab", "fatima_h"]},
        {"key": "cake", "name": "Cake tasting", "start": "2026-10-24T14:00", "end": "2026-10-24T15:30",
         "attendees": ["zainab", "hamza"]},
        {"key": "wcall_1008", "name": "Wedding planning call", "start": "2026-10-08T19:00", "end": "2026-10-08T20:00",
         "attendees": ["zainab", "fatima_h"]},
        {"key": "wcall_1022", "name": "Wedding planning call", "start": "2026-10-22T19:00", "end": "2026-10-22T20:00",
         "attendees": ["zainab", "fatima_h"]},
        {"key": "wcall_1104", "name": "Wedding planning call", "start": "2026-11-04T19:00", "end": "2026-11-04T20:00",
         "attendees": ["zainab", "fatima_h"]},
        {"key": "menu", "name": "Menu tasting at Mahmood Catering", "start": "2026-11-01T17:00", "end": "2026-11-01T18:30",
         "attendees": ["kashif", "zainab", "mum"]},
        {"key": "mehndi_fit", "name": "Mehndi outfit fitting", "start": "2026-10-31T15:00", "end": "2026-10-31T16:00"},
        {"key": "mehndi", "name": "Mehndi night", "start": "2026-12-10T18:00", "end": "2026-12-10T23:00",
         "attendees": ["zainab", "shazia", "fatima_h", "fatima_k"]},
        {"key": "wedding_day", "name": "Zainab and Hamza's wedding", "start": "2026-12-12T11:00", "end": "2026-12-12T22:00",
         "attendees": ["zainab", "hamza", "mum", "dad", "imran"], "description": "Oakwood Hall, ceremony at 12"},
        {"key": "walima", "name": "Walima", "start": "2026-12-13T13:00", "end": "2026-12-13T18:00",
         "attendees": ["zainab", "hamza"]},
        # hen do
        {"key": "flight_out", "name": "Flight LBA to Istanbul", "start": "2026-11-20T06:15", "end": "2026-11-20T12:40",
         "attendees": ["zainab", "fatima_h", "sana", "aoife"], "description": "Jet2 LS893"},
        {"key": "cruise", "name": "Bosphorus dinner cruise", "start": "2026-11-21T19:00", "end": "2026-11-21T22:30",
         "attendees": ["zainab", "fatima_h", "sana", "aoife"]},
        {"key": "hammam", "name": "Hammam at Cemberlitas", "start": "2026-11-22T11:00", "end": "2026-11-22T13:00",
         "attendees": ["zainab", "fatima_h", "sana", "aoife"]},
        {"key": "flight_back", "name": "Flight Istanbul to LBA", "start": "2026-11-23T15:05", "end": "2026-11-23T17:30",
         "attendees": ["zainab", "fatima_h", "sana", "aoife"]},
        # work
        {"key": "rota_meet", "name": "Rota meeting", "start": "2026-10-15T12:00", "end": "2026-10-15T13:00",
         "attendees": ["ellie", "james", "dan"]},
        {"key": "grand_round", "name": "Grand round", "start": "2026-10-21T12:30", "end": "2026-10-21T13:30"},
        {"key": "teaching", "name": "Sepsis teaching for F1s", "start": "2026-10-30T13:00", "end": "2026-10-30T14:00",
         "attendees": ["ellie"], "description": "15 min case + qSOFA quiz"},
        {"key": "als_1", "name": "ALS course day 1", "start": "2026-11-02T08:30", "end": "2026-11-02T17:00"},
        {"key": "als_2", "name": "ALS course day 2", "start": "2026-11-03T08:30", "end": "2026-11-03T17:00"},
        {"key": "arcp", "name": "ARCP review with Dr Hughes", "start": "2026-11-18T10:00", "end": "2026-11-18T11:00",
         "attendees": ["hughes"]},
        {"key": "supervisor", "name": "Supervisor meeting", "start": "2026-09-29T08:00", "end": "2026-09-29T08:30",
         "attendees": ["hughes"], "cancelled": "2026-09-28T09:00"},
        # personal
        {"key": "leah_dinner", "name": "Dinner with Leah", "start": "2026-10-14T21:30", "end": "2026-10-14T23:00",
         "attendees": ["leah"], "description": "Bundobust"},
        {"key": "aoife_coffee", "name": "Coffee with Aoife", "start": "2026-10-23T11:00", "end": "2026-10-23T12:00",
         "attendees": ["aoife"]},
        {"key": "car_service", "name": "Car service at Barker Motors", "start": "2026-10-22T09:00", "end": "2026-10-22T10:00",
         "attendees": ["kev"]},
        {"key": "dentist", "name": "Dentist check-up", "start": "2026-10-29T16:00", "end": "2026-10-29T16:30",
         "attendees": ["sharma"]},
        {"key": "yoga_1010", "name": "Yoga with Chloe", "start": "2026-10-10T17:00", "end": "2026-10-10T18:00",
         "attendees": ["chloe"], "cancelled": "2026-10-09T20:00"},
        {"key": "yoga_1024", "name": "Yoga with Chloe", "start": "2026-10-24T17:00", "end": "2026-10-24T18:00",
         "attendees": ["chloe"]},
        {"key": "pub_quiz", "name": "Pub quiz at the Skyrack", "start": "2026-10-09T20:00", "end": "2026-10-09T22:00",
         "attendees": ["chloe", "tom"], "cancelled": "2026-10-08T12:00"},
        {"key": "film_swap", "name": "Film swap meet", "start": "2026-11-01T11:00", "end": "2026-11-01T13:00",
         "attendees": ["owen", "ravi"]},
        {"key": "gym", "name": "Gym induction", "start": "2026-10-19T10:00", "end": "2026-10-19T11:00",
         "attendees": ["craig"], "trashed": "2026-10-05T09:00"},
        {"key": "whitby", "name": "Whitby day trip", "start": "2026-09-13T08:00", "end": "2026-09-13T19:00",
         "attendees": ["ravi", "owen"]},
    ]
    return out


def tasks():
    t = [
        # wedding
        {"key": "speech", "name": "Write maid of honour speech", "due": "2026-12-05", "status": "in_progress", "priority": 2,
         "effort": 180, "list": "wedlist", "description": "funny but not the Blackpool story"},
        {"key": "speech_draft", "name": "First draft of speech", "parent": "speech", "completed": "2026-10-04T22:00"},
        {"key": "speech_photos", "name": "Dig out childhood photos for speech", "parent": "speech", "due": "2026-10-31"},
        {"key": "speech_practise", "name": "Practise speech with Imran", "parent": "speech", "due": "2026-11-29"},
        {"key": "favours", "name": "Order wedding favours", "due": "2026-10-30", "list": "wedlist", "priority": 3,
         "description": "mini jars of Bombay mix, 180 guests"},
        {"key": "caterer_nums", "name": "Confirm caterer numbers", "due": "2026-11-20", "list": "wedlist", "priority": 1},
        {"key": "save_dates", "name": "Send save the dates", "due": "2026-07-01", "completed": "2026-06-28T20:00", "list": "wedlist"},
        {"key": "mehndi_book", "name": "Book mehndi artist", "completed": "2026-08-02T12:00", "list": "wedlist"},
        {"key": "rsvps", "name": "Chase RSVPs from dad's side", "due": "2026-10-25", "list": "wedlist", "effort": 60},
        {"key": "mehndi_outfit", "name": "Buy outfit for mehndi", "due": "2026-10-31", "status": "in_progress", "list": "wedlist"},
        {"key": "playlist", "name": "Make mehndi playlist", "list": "wedlist", "effort": 45},
        {"key": "seating", "name": "Seating plan draft", "due": "2026-11-15", "list": "wedlist", "effort": 120},
        # hen do
        {"key": "lira", "name": "Buy Turkish lira", "due": "2026-11-18", "list": "istlist"},
        {"key": "passport_check", "name": "Check passport expiry", "completed": "2026-07-19T10:00", "list": "istlist"},
        {"key": "sashes", "name": "Order hen do sashes", "due": "2026-10-20", "list": "istlist", "priority": 3},
        {"key": "evisa", "name": "Check if we need an e-visa", "completed": "2026-07-21T09:00", "list": "istlist"},
        {"key": "airport_parking", "name": "Book airport parking", "due": "2026-11-06", "list": "istlist"},
        # work
        {"key": "audit", "name": "Finish sepsis audit", "due": "2026-10-23", "priority": 1, "effort": 240, "status": "in_progress",
         "list": "worklist", "description": "30 notes from AMU, compare against the trust pathway"},
        {"key": "audit_data", "name": "Collect audit data", "parent": "audit", "completed": "2026-10-09T17:00"},
        {"key": "audit_slides", "name": "Make audit slides", "parent": "audit", "due": "2026-10-22"},
        {"key": "reflections", "name": "Write two ePortfolio reflections", "due": "2026-11-13", "list": "worklist", "effort": 90},
        {"key": "cbd", "name": "Get a CBD signed off", "due": "2026-11-13", "list": "worklist", "priority": 2},
        {"key": "rota_swap", "name": "Submit rota swap request", "due": "2026-10-16", "list": "worklist", "priority": 2,
         "description": "swap 5-7 Nov nights with Ellie"},
        {"key": "als_prep", "name": "ALS pre-course e-learning", "due": "2026-11-01", "list": "worklist", "effort": 150},
        {"key": "gmc_fee", "name": "Pay GMC annual fee", "due": "2026-11-30", "list": "worklist"},
        {"key": "indemnity", "name": "Renew MDU indemnity", "completed": "2026-08-01T09:00", "list": "worklist"},
        {"key": "teaching_prep", "name": "Prep sepsis teaching", "due": "2026-10-29", "list": "worklist", "effort": 60},
        # house
        {"key": "rent_oct", "name": "Pay rent", "due": "2026-10-01", "completed": "2026-09-30T20:00", "list": "houselist"},
        {"key": "rent_nov", "name": "Pay rent", "due": "2026-11-01", "list": "houselist", "priority": 2},
        {"key": "boiler", "name": "Email Gary about the boiler", "due": "2026-10-15", "list": "houselist"},
        {"key": "wul_1", "name": "Buy washing up liquid", "due": "2026-10-16", "list": "houselist"},
        {"key": "wul_2", "name": "Buy washing up liquid", "completed": "2026-09-18T18:00", "list": "houselist"},
        {"key": "freezer", "name": "Defrost the freezer", "completed": "2026-10-04T15:00", "list": "houselist"},
        {"key": "bins", "name": "Put the bins out", "due": "2026-10-15", "list": "houselist", "effort": 5},
        {"key": "council_tax", "name": "Sort council tax discount", "status": "cancelled", "list": "houselist"},
        # food bank
        {"key": "tins", "name": "Sort tinned donations", "due": "2026-10-17", "list": "fblist", "effort": 90},
        {"key": "tesco", "name": "Collect Tesco donation", "due": "2026-10-23", "list": "fblist"},
        {"key": "hampers", "name": "Make Christmas hamper list", "due": "2026-11-27", "list": "fblist", "effort": 60},
        {"key": "fb_rota", "name": "Send Pete my November availability", "due": "2026-10-18", "list": "fblist"},
        {"key": "fb_poster", "name": "Design food bank appeal poster", "completed": "2026-09-25T21:00", "list": "fblist"},
        # photography
        {"key": "develop", "name": "Develop the Whitby rolls", "due": "2026-10-15", "effort": 120},
        {"key": "hp5", "name": "Buy HP5 film", "due": "2026-10-29"},
        {"key": "scan", "name": "Scan Whitby negatives", "status": "in_progress", "effort": 180},
        {"key": "light_seal", "name": "Fix Pentax light seals", "effort": 45},
        # car and personal
        {"key": "car_ins", "name": "Renew car insurance", "due": "2026-11-03", "priority": 2},
        {"key": "book_service", "name": "Book car service", "completed": "2026-10-02T12:00"},
        {"key": "imran_gift", "name": "Birthday present for Imran", "due": "2026-11-07"},
        {"key": "call_nasreen", "name": "Call Auntie Nasreen about the guest list", "due": "2026-10-17"},
        {"key": "flu_jab", "name": "Get flu jab at occ health", "completed": "2026-10-06T10:00"},
        {"key": "eid_cards", "name": "Post Eid cards", "status": "cancelled", "due": "2026-06-10"},
        {"key": "gym_sign", "name": "Sign up for PureGym", "trashed": "2026-10-05T09:00"},
        {"key": "return_parcel", "name": "Return the ASOS parcel", "trashed": "2026-10-10T09:00"},
    ]
    # car loan, monthly on the 28th: history plus the open one
    for m in range(1, 10):
        t.append({"key": f"loan_{m:02d}", "name": "Car loan payment", "due": f"2026-{m:02d}-28",
                  "completed": f"2026-{m:02d}-27T20:00"})
    t.append({"key": "loan_10", "name": "Car loan payment", "due": "2026-10-28", "priority": 2})
    return t


NOTEBOOKS = [
    {"key": "wed_nb", "name": "Wedding"},
    {"key": "med_nb", "name": "Medicine"},
    {"key": "film_nb", "name": "Film photography"},
    {"key": "fb_nb", "name": "Food bank"},
    {"key": "ist_nb", "name": "Istanbul"},
    {"key": "old_nb", "name": "Revision"},
]

NOTES = [
    {"key": "speech_ideas", "name": "Speech ideas", "body": "the goat at Tong Park, Zainab's first driving lesson, how she met Hamza at the library",
     "notebook": "wed_nb", "created": "2026-09-02T23:10", "pinned": True},
    {"key": "guest_list", "name": "Guest list notes", "body": "dad's side 95, mum's side 60, friends 25; Auntie Nasreen wants to add 6",
     "notebook": "wed_nb", "created": "2026-08-20T21:00"},
    {"key": "venue_notes", "name": "Oakwood Hall notes", "body": "stage by the bay window, no open flames, last music 11pm",
     "notebook": "wed_nb", "created": "2026-09-20T13:00"},
    {"key": "menu_notes", "name": "Menu ideas", "body": "lamb karahi, chicken biryani, gulab jamun, no prawns (Hamza allergic)",
     "notebook": "wed_nb", "created": "2026-09-08T20:30"},
    {"key": "mehndi_songs", "name": "Mehndi songs", "body": "Mehndi laga ke rakhna, London thumakda, Nachde ne saare",
     "notebook": "wed_nb", "created": "2026-10-01T22:00"},
    {"key": "sepsis", "name": "Sepsis six", "body": "oxygen, cultures, antibiotics, fluids, lactate, urine output within the hour",
     "notebook": "med_nb", "created": "2026-08-10T21:00", "pinned": True},
    {"key": "dka", "name": "DKA protocol", "body": "fixed rate insulin 0.1 units/kg/hr, check ketones hourly, K+ in the second bag",
     "notebook": "med_nb", "created": "2026-08-22T03:10"},
    {"key": "handover", "name": "Night handover tips", "body": "sickest first, write jobs on the board, escalate early to the reg",
     "notebook": "med_nb", "created": "2026-09-26T07:50"},
    {"key": "hyperkal", "name": "Hyperkalaemia", "body": "calcium gluconate 10ml 10%, insulin dextrose, salbutamol nebs",
     "notebook": "med_nb", "created": "2026-09-05T02:30"},
    {"key": "audit_notes", "name": "Audit method", "body": "30 consecutive AMU admissions with NEWS >= 5, time to antibiotics",
     "notebook": "med_nb", "created": "2026-09-15T20:00"},
    {"key": "portra", "name": "Portra 400 settings", "body": "overexpose a stop, meter for the shadows, C-41 at the lab",
     "notebook": "film_nb", "created": "2026-07-02T21:00"},
    {"key": "hp5_dev", "name": "HP5 push to 1600", "body": "Ilfosol 3 1+9, 11 mins at 20C, agitate first 10s each minute",
     "notebook": "film_nb", "created": "2026-09-17T22:00"},
    {"key": "whitby_notes", "name": "Whitby roll notes", "body": "abbey at golden hour, 199 steps, Ravi on the pier",
     "notebook": "film_nb", "created": "2026-09-13T20:00"},
    {"key": "cameras", "name": "Camera wishlist", "body": "Olympus XA, Mamiya 645, a better light meter",
     "notebook": "film_nb", "created": "2026-06-11T22:00"},
    {"key": "fb_rules", "name": "Food bank allergens", "body": "label anything with nuts, check dates on tins, no home-made food",
     "notebook": "fb_nb", "created": "2026-09-05T13:00"},
    {"key": "fb_hampers", "name": "Hamper ideas", "body": "tea, biscuits, tinned fish, rice, a card from the kids' club",
     "notebook": "fb_nb", "created": "2026-10-10T13:00"},
    {"key": "ist_food", "name": "Istanbul food list", "body": "simit, balik ekmek at Eminonu, kunefe, Turkish breakfast at Van Kahvalti",
     "notebook": "ist_nb", "created": "2026-09-01T22:00"},
    {"key": "ist_plan", "name": "Hen do plan", "body": "Friday arrive and rest, Saturday Grand Bazaar then cruise, Sunday hammam",
     "notebook": "ist_nb", "created": "2026-09-10T21:00"},
    {"key": "ist_packing", "name": "Istanbul packing", "body": "scarf for the mosques, comfy trainers, adaptor, sashes",
     "notebook": "ist_nb", "created": "2026-10-05T21:00"},
    {"key": "loan_note", "name": "Car loan maths", "body": "2400 left at 6.9%, overpay 100 a month and done by next August",
     "created": "2026-09-28T22:00"},
    {"key": "budget", "name": "October budget", "body": "rent 520, car 210, wedding 150, food 180, film 30",
     "created": "2026-10-01T09:00", "pinned": True},
    {"key": "journal", "name": "Post nights journal", "body": "slept 14 hours, felt human by dinner; the arrest on Tuesday stuck with me",
     "created": "2026-10-08T18:00"},
    {"key": "gift_ideas", "name": "Gift ideas for Imran", "body": "Leeds United shirt, Kindle, a proper coffee grinder",
     "created": "2026-10-03T21:00"},
    {"key": "old_revision", "name": "Finals revision timetable", "body": "cardio Mon, resp Tue, renal Wed",
     "created": "2025-03-01T09:00", "trashed": "2026-10-02T10:00"},
    {"key": "old_nights", "name": "Night shift snacks", "body": "flapjack, nuts, no energy drinks after 3am",
     "created": "2026-02-10T22:00", "trashed": "2026-08-25T09:00"},
]

FOLDERS = [
    {"key": "wed_f", "name": "Wedding"},
    {"key": "car_f", "name": "Car"},
    {"key": "work_f", "name": "Work"},
    {"key": "house_f", "name": "House"},
    {"key": "ist_f", "name": "Istanbul"},
    {"key": "scans_f", "name": "Scans"},
    {"key": "receipts_f", "name": "Receipts"},
]

DOCUMENTS = [
    {"key": "venue_contract", "name": "Oakwood Hall contract", "folder": "wed_f", "starred": True, "created": "2026-05-10T12:00"},
    {"key": "caterer_quote", "name": "Mahmood Catering quote", "folder": "wed_f", "created": "2026-08-28T12:00"},
    {"key": "guest_sheet", "name": "Guest list spreadsheet", "folder": "wed_f", "created": "2026-08-20T21:30"},
    {"key": "invite_proof", "name": "Invitation proof", "folder": "wed_f", "created": "2026-09-10T18:00"},
    {"key": "loan_agreement", "name": "Car loan agreement", "folder": "car_f", "created": "2025-10-28T10:00"},
    {"key": "ins_cert", "name": "Car insurance certificate", "folder": "car_f", "created": "2025-11-03T10:00"},
    {"key": "mot", "name": "MOT certificate 2026", "folder": "car_f", "created": "2026-03-14T11:00"},
    {"key": "rota_doc", "name": "AMU rota Oct to Dec", "folder": "work_f", "starred": True, "created": "2026-09-01T09:00"},
    {"key": "contract", "name": "FY2 employment contract", "folder": "work_f", "created": "2026-07-20T09:00"},
    {"key": "als_cert", "name": "ILS certificate", "folder": "work_f", "created": "2025-11-20T09:00"},
    {"key": "audit_doc", "name": "Sepsis audit proforma", "folder": "work_f", "created": "2026-09-16T21:00"},
    {"key": "tenancy", "name": "Tenancy agreement 2026", "folder": "house_f", "created": "2026-08-25T10:00"},
    {"key": "council_bill", "name": "Council tax bill", "folder": "house_f", "created": "2026-04-02T10:00"},
    {"key": "flights_doc", "name": "Jet2 booking confirmation", "folder": "ist_f", "starred": True, "created": "2026-07-18T21:30"},
    {"key": "hotel_doc", "name": "Hotel booking Sultanahmet", "folder": "ist_f", "created": "2026-07-20T20:00"},
    {"key": "payslip", "name": "Payslip September", "created": "2026-09-30T09:00"},
    {"key": "old_cv", "name": "CV 2024", "created": "2024-02-01T09:00", "trashed": "2026-09-28T10:00"},
    {"key": "gym_contract", "name": "PureGym contract", "created": "2026-01-12T18:00", "trashed": "2026-10-06T09:00"},
    {"key": "old_tenancy", "name": "Tenancy agreement 2025", "folder": "house_f", "created": "2025-08-20T10:00",
     "trashed": "2026-08-30T10:00"},
]

ALBUMS = [
    {"key": "whitby_album", "name": "Whitby on Portra"},
    {"key": "wed_album", "name": "Wedding prep"},
    {"key": "fam_album", "name": "Family"},
    {"key": "fb_album", "name": "Food bank"},
    {"key": "dark_album", "name": "Darkroom prints"},
    {"key": "ist_album", "name": "Istanbul hen do"},
]

PHOTOS = [
    {"key": "abbey", "name": "Whitby Abbey at golden hour", "taken": "2026-09-13T18:10", "albums": ["whitby_album"], "starred": True},
    {"key": "steps", "name": "199 steps", "taken": "2026-09-13T10:30", "albums": ["whitby_album"]},
    {"key": "pier", "name": "Ravi on the pier", "taken": "2026-09-13T12:15", "albums": ["whitby_album"], "people": ["ravi"]},
    {"key": "harbour", "name": "Whitby harbour boats", "taken": "2026-09-13T11:00", "albums": ["whitby_album"]},
    {"key": "fish_chips", "name": "Fish and chips at the Magpie", "taken": "2026-09-13T13:30", "albums": ["whitby_album"],
     "people": ["ravi", "owen"]},
    {"key": "owen_cam", "name": "Owen with the Mamiya", "taken": "2026-09-13T15:00", "albums": ["whitby_album"], "people": ["owen"]},
    {"key": "gulls", "name": "Gulls over the harbour", "taken": "2026-09-13T16:40", "albums": ["whitby_album"]},
    {"key": "whalebone", "name": "Whalebone arch", "taken": "2026-09-13T17:20", "albums": ["whitby_album"]},
    {"key": "venue_hall", "name": "Oakwood Hall ballroom", "taken": "2026-09-20T11:30", "albums": ["wed_album"], "people": ["zainab"]},
    {"key": "fabric", "name": "Lehenga fabric swatches", "taken": "2026-09-06T15:00", "albums": ["wed_album"], "people": ["zainab"]},
    {"key": "ring", "name": "Zainab's ring", "taken": "2026-03-21T20:00", "albums": ["wed_album", "fam_album"], "people": ["zainab"],
     "starred": True},
    {"key": "invite_pic", "name": "Invitation mock-up", "taken": "2026-09-10T18:05", "albums": ["wed_album"]},
    {"key": "flowers", "name": "Stage flowers sample", "taken": "2026-10-03T12:00", "albums": ["wed_album"]},
    {"key": "engagement", "name": "Engagement party", "taken": "2026-03-21T21:30", "albums": ["fam_album"],
     "people": ["zainab", "hamza", "mum", "dad"], "starred": True},
    {"key": "mum_kitchen", "name": "Ammi making samosas", "taken": "2026-04-05T16:00", "albums": ["fam_album"], "people": ["mum"]},
    {"key": "dad_garden", "name": "Abbu's tomatoes", "taken": "2026-08-09T14:00", "albums": ["fam_album"], "people": ["dad"]},
    {"key": "eid", "name": "Eid at Auntie Nasreen's", "taken": "2026-05-27T15:00", "albums": ["fam_album"],
     "people": ["nasreen", "fatima_k", "bilal", "sana"]},
    {"key": "imran_grad", "name": "Imran's graduation", "taken": "2026-07-15T12:00", "albums": ["fam_album"],
     "people": ["imran", "mum", "dad"]},
    {"key": "cousins", "name": "Cousins at the park", "taken": "2026-08-30T17:00", "albums": ["fam_album"],
     "people": ["fatima_k", "fatima_h", "sana", "bilal"]},
    {"key": "fb_shelves", "name": "Stocked shelves", "taken": "2026-09-12T12:00", "albums": ["fb_album"], "people": ["pete"]},
    {"key": "fb_team", "name": "Saturday team", "taken": "2026-09-26T12:20", "albums": ["fb_album"], "people": ["pete", "margaret"]},
    {"key": "fb_van", "name": "Tesco donation van", "taken": "2026-10-10T10:00", "albums": ["fb_album"]},
    {"key": "print_abbey", "name": "Abbey print, 8x10", "taken": "2026-10-01T20:30", "albums": ["dark_album"]},
    {"key": "print_pier", "name": "Pier print, split grade", "taken": "2026-10-01T20:50", "albums": ["dark_album"], "people": ["ravi"]},
    {"key": "test_strip", "name": "Test strip", "taken": "2026-09-17T19:40", "albums": ["dark_album"]},
    {"key": "enlarger", "name": "The Durst enlarger", "taken": "2026-09-03T19:00", "albums": ["dark_album"], "people": ["owen"]},
    {"key": "house_dinner", "name": "House roast dinner", "taken": "2026-09-27T19:00", "people": ["chloe", "tom"]},
    {"key": "ward_cake", "name": "Leaving cake on AMU", "taken": "2026-09-30T15:00", "people": ["grace", "priya"]},
    {"key": "sunrise", "name": "Sunrise after nights", "taken": "2026-10-08T07:20", "starred": True},
    {"key": "leah_selfie", "name": "Selfie with Leah", "taken": "2026-09-20T20:00", "people": ["leah"]},
    {"key": "car_pic", "name": "The Corsa after the wash", "taken": "2026-10-02T13:00"},
    {"key": "blurry", "name": "Blurry darkroom shot", "taken": "2026-10-01T21:10", "trashed": "2026-10-02T08:00"},
    {"key": "screenshot", "name": "Rota screenshot", "taken": "2026-09-01T09:05", "trashed": "2026-08-20T09:00"},
]

DEBTS = [
    {"key": "d_chloe", "person": "chloe", "direction": "owes_me", "amount": 14.50, "name": "Friday takeaway", "date": "2026-10-09"},
    {"key": "d_tom", "person": "tom", "direction": "i_owe", "amount": 40, "name": "Boiler engineer callout", "date": "2026-10-05"},
    {"key": "d_zainab", "person": "zainab", "direction": "owes_me", "amount": 85, "name": "Lehenga fabric deposit", "date": "2026-09-06"},
    {"key": "d_imran", "person": "imran", "direction": "i_owe", "amount": 23.40, "name": "Train tickets to Bradford", "date": "2026-09-27",
     "settled": "2026-10-01T10:00"},
    {"key": "d_leah", "person": "leah", "direction": "owes_me", "amount": 32, "name": "Gig tickets", "date": "2026-09-20"},
    {"key": "d_james", "person": "james", "direction": "i_owe", "amount": 9, "name": "Vending machine dinner", "date": "2026-10-06"},
    {"key": "d_ellie", "person": "ellie", "direction": "owes_me", "amount": 6, "name": "Hospital parking", "date": "2026-09-22",
     "settled": "2026-09-25T10:00"},
    {"key": "d_dad", "person": "dad", "direction": "i_owe", "amount": 500, "name": "Help with car deposit", "date": "2025-10-20"},
    {"key": "d_fatima_k", "person": "fatima_k", "direction": "owes_me", "amount": 20, "name": "Eid gift share", "date": "2026-05-26"},
    {"key": "d_fatima_h", "person": "fatima_h", "direction": "i_owe", "amount": 35, "name": "Hen do decorations", "date": "2026-10-02"},
    {"key": "d_owen", "person": "owen", "direction": "i_owe", "amount": 18, "name": "Film chemicals", "date": "2026-08-20",
     "settled": "2026-09-03T21:00"},
    {"key": "d_aoife", "person": "aoife", "direction": "owes_me", "amount": 12.80, "name": "Lunch at Laynes", "date": "2026-08-15"},
    {"key": "d_sana", "person": "sana", "direction": "owes_me", "amount": 142, "name": "Istanbul flight", "date": "2026-07-18"},
]

LOCKER = [
    {"key": "nhsmail", "name": "NHSmail login", "type": "login", "username": "aisha.rahman3@nhs.net", "url": "https://email.nhs.net",
     "password": "Amu-Nights-26!", "starred": True},
    {"key": "horus", "name": "Horus ePortfolio login", "type": "login", "username": "arahman", "url": "https://horus.hee.nhs.uk",
     "password": "reflect4ever", "code": "KZXW6YTBOI"},
    {"key": "monzo", "name": "Monzo debit card", "type": "card", "card_number": "5355 7700 1234 8841", "cvv": "209", "starred": True},
    {"key": "amex", "name": "Amex credit card", "type": "card", "card_number": "3714 496353 98431", "cvv": "7781"},
    {"key": "wifi", "name": "House wifi", "type": "wifi", "password": "headingley-hotpot-9"},
    {"key": "work_locker", "name": "Work locker combination", "type": "note", "notes": "3179, locker 42 in the AMU changing room"},
    {"key": "smartcard", "name": "NHS smartcard", "type": "identity", "password": "4417"},
    {"key": "pc_pass", "name": "Hospital PC password", "type": "password", "password": "Sepsis6-in-1hr"},
    {"key": "pi_ssh", "name": "Scanner Pi SSH key", "type": "ssh_key", "notes": "raspberry pi on the negative scanner", "password": "ssh-ed25519 AAAAC3Nz-pi-scan"},
    {"key": "flickr", "name": "Flickr API key", "type": "api_credential", "notes": "account aisha_shoots_film", "code": "f1ickr-9a8b7c"},
    {"key": "passport", "name": "Passport", "type": "passport", "notes": "expires March 2031"},
    {"key": "halifax", "name": "Halifax current account", "type": "bank_account", "notes": "sort code 11-22-33, salary goes here"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence", "notes": "expires 2033, 3 points cleared"},
    {"key": "lightroom", "name": "Lightroom subscription", "type": "software_licence", "code": "LR-77QX-2026", "notes": "photography plan, renews January"},
    {"key": "coinbase", "name": "Old Coinbase wallet", "type": "crypto_wallet", "notes": "0.02 ETH from 2021, seed phrase on paper"},
    {"key": "puregym", "name": "PureGym membership", "type": "membership", "notes": "Headingley, cancelled pending"},
    {"key": "bma", "name": "BMA membership", "type": "membership", "notes": "member 1188420", "starred": True},
    {"key": "gmc", "name": "GMC certificate", "type": "document", "notes": "GMC number 7654321"},
    {"key": "santander", "name": "Old Santander login", "type": "login", "username": "arahman92", "password": "oldbank1",
     "trashed": "2026-10-02T09:00"},
    {"key": "netflix", "name": "Old Netflix login", "type": "login", "username": "aisha.r92@gmail.com",
     "url": "https://netflix.com", "password": "bingewatch92", "trashed": "2026-10-09T20:00"},
]

LINKS = [
    {"from": "speech", "to": "zainab"},
    {"from": "speech_practise", "to": "imran"},
    {"from": "caterer_nums", "to": "kashif"},
    {"from": "rsvps", "to": "dad"},
    {"from": "call_nasreen", "to": "nasreen"},
    {"from": "sashes", "to": "fatima_h"},
    {"from": "audit", "to": "hughes"},
    {"from": "cbd", "to": "hughes"},
    {"from": "rota_swap", "to": "ellie"},
    {"from": "boiler", "to": "gary"},
    {"from": "fb_rota", "to": "pete"},
    {"from": "tesco", "to": "pete"},
    {"from": "imran_gift", "to": "imran"},
    {"from": "develop", "to": "owen"},
    {"from": "speech_ideas", "to": "zainab"},
    {"from": "guest_list", "to": "nasreen"},
    {"from": "menu_notes", "to": "hamza"},
    {"from": "whitby_notes", "to": "ravi"},
    {"from": "hp5_dev", "to": "owen"},
    {"from": "gift_ideas", "to": "imran"},
    {"from": "ist_plan", "to": "sana"},
    {"from": "ist_plan", "to": "fatima_h"},
]


def world():
    return {
        "me": "Aisha Rahman",
        "epoch": "2025-01-05T09:00",
        "seed": "T04",
        "currency": "GBP",
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
        s = datetime.fromisoformat(e["start"])
        f = datetime.fromisoformat(e["end"])
        spans.append((s, f, e["key"]))
    spans.sort()
    end, last = None, None
    for s1, f1, k1 in spans:
        assert end is None or end <= s1, f"overlap {last} / {k1}"
        if end is None or f1 > end:
            end, last = f1, k1
    keys = [e["key"] for e in evs]
    assert len(keys) == len(set(keys))


if __name__ == "__main__":
    w = world()
    check_overlaps(w["events"])
    out = HERE / "T04.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
