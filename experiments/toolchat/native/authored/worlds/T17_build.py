"""World T17: Elena Petrova, piano teacher and accompanist in Sofia (BGN vault).

    python3 authored/worlds/T17_build.py      # writes authored/worlds/T17.json (deterministic)

Today in the sessions is Friday 2026-01-30 13:35.
Elena is divorced; her son Viktor (15) lives half the week with his father Stefan. She teaches a
roster of piano students, sings alto in and accompanies a chamber choir, accompanies a violinist
for her conservatory exam, and is in the middle of a bathroom renovation with a contractor
(Dimitar "Mitko" Zhelev). Built-in ambiguity: two Marias (child student Maria Dimitrova, adult
student Maria Koleva), two Kolevas (Maria, choir soprano Desislava "Desi"), two Ivans (student
Ivan Todorov, building manager Ivan Dimov), nicknames (Mitko, Desi, Vesi, Niki, Mama, Krasi), a
misspelled-looking name (Tsvetan), two dentist appointments, two "Choir concert" events, two
"Buy sheet music" tasks, monthly electricity bills, two recital albums, cancelled events,
completed tasks, people and events trashed inside and past the 30-day restore window, an empty
group, an empty folder, and groups with and without a currency.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        # family
        {"key": "viktor", "name": "Viktor Petrov", "role": "son", "nickname": "Vitya", "starred": True,
         "cadence": 2, "last_contacted": "2026-01-29T21:00", "last_contacted_kind": "call"},
        {"key": "stefan", "name": "Stefan Petrov", "role": "ex-husband, Viktor's father", "cadence": 7,
         "last_contacted": "2026-01-26T19:00", "last_contacted_kind": "message"},
        {"key": "radka", "name": "Radka Ivanova", "role": "mother", "nickname": "Mama", "starred": True,
         "cadence": 3, "met": "Plovdiv", "last_contacted": "2026-01-28T18:30", "last_contacted_kind": "call"},
        {"key": "mila", "name": "Mila Georgieva", "role": "sister", "starred": True, "cadence": 7, "met": "Plovdiv",
         "last_contacted": "2026-01-24T12:00", "last_contacted_kind": "visit"},
        # students
        {"key": "maria_d", "name": "Maria Dimitrova", "role": "student, age 10", "cadence": 7,
         "last_contacted": "2026-01-28T17:00", "last_contacted_kind": "visit"},
        {"key": "maria_k", "name": "Maria Koleva", "role": "adult student", "cadence": 14,
         "last_contacted": "2026-01-15T18:00", "last_contacted_kind": "visit"},
        {"key": "ivan_t", "name": "Ivan Todorov", "role": "student, age 12", "cadence": 7,
         "last_contacted": "2026-01-26T17:45", "last_contacted_kind": "visit"},
        {"key": "niki", "name": "Nikola Stoyanov", "role": "student, conservatory prep", "nickname": "Niki",
         "cadence": 7, "last_contacted": "2026-01-22T16:00", "last_contacted_kind": "visit"},
        {"key": "kalina", "name": "Kalina Petkova", "role": "student, age 14", "cadence": 14,
         "last_contacted": "2026-01-20T16:30", "last_contacted_kind": "visit"},
        {"key": "boris", "name": "Boris Nikolov", "role": "student, age 9",
         "last_contacted": "2026-01-09T15:00", "last_contacted_kind": "message"},
        {"key": "sofia_a", "name": "Sofia Angelova", "role": "student, age 16", "starred": True,
         "last_contacted": "2026-01-27T16:00", "last_contacted_kind": "visit"},
        {"key": "daniela", "name": "Daniela Vasileva", "role": "Boris's mother", "cadence": 30,
         "last_contacted": "2025-12-18T10:00", "last_contacted_kind": "call"},
        # choir
        {"key": "petar", "name": "Petar Iliev", "role": "choir conductor", "starred": True, "cadence": 7,
         "last_contacted": "2026-01-30T12:00", "last_contacted_kind": "coffee"},
        {"key": "desi", "name": "Desislava Koleva", "role": "choir soprano", "nickname": "Desi", "cadence": 14,
         "last_contacted": "2026-01-13T21:00", "last_contacted_kind": "coffee"},
        {"key": "tsvetan", "name": "Tsvetan Popov", "role": "choir bass"},
        {"key": "ani", "name": "Ani Stefanova", "role": "choir alto", "cadence": 30,
         "last_contacted": "2025-12-20T22:00", "last_contacted_kind": "visit"},
        {"key": "hristo", "name": "Hristo Kirov", "role": "choir tenor"},
        # music
        {"key": "vesi", "name": "Veselina Marinova", "role": "violinist", "nickname": "Vesi", "cadence": 7,
         "met": "conservatory", "last_contacted": "2026-01-29T19:30", "last_contacted_kind": "call"},
        {"key": "lyubo", "name": "Lyubomir Georgiev", "role": "piano tuner", "cadence": 90,
         "last_contacted": "2025-10-14T11:00", "last_contacted_kind": "call"},
        {"key": "stoyanova", "name": "Elka Stoyanova", "role": "professor, conservatory", "met": "conservatory"},
        # renovation
        {"key": "mitko", "name": "Dimitar Zhelev", "role": "contractor", "nickname": "Mitko", "cadence": 3,
         "last_contacted": "2026-01-29T09:15", "last_contacted_kind": "call"},
        {"key": "plamen", "name": "Plamen Genchev", "role": "electrician",
         "last_contacted": "2026-01-21T08:00", "last_contacted_kind": "message"},
        {"key": "todor", "name": "Todor Vasilev", "role": "tiler"},
        {"key": "krasi", "name": "Krasimir Dobrev", "role": "plumber", "nickname": "Krasi",
         "last_contacted": "2026-01-15T10:00", "last_contacted_kind": "visit"},
        # others
        {"key": "ivan_d", "name": "Ivan Dimov", "role": "building manager", "cadence": 30,
         "last_contacted": "2026-01-05T09:00", "last_contacted_kind": "message"},
        {"key": "yordanka", "name": "Yordanka Hadzhieva", "role": "Viktor's class teacher",
         "last_contacted": "2026-01-16T13:00", "last_contacted_kind": "message"},
        {"key": "neli", "name": "Neli Todorova"},
        {"key": "georgi", "name": "Georgi Marinov"},
        # trashed: two inside the 30-day window, one past it
        {"key": "emil", "name": "Emil Todorov", "role": "former student", "trashed": "2026-01-20T10:00"},
        {"key": "rositsa", "name": "Rositsa Bakalova", "role": "ex choir member", "trashed": "2026-01-12T09:00"},
        {"key": "ognyan", "name": "Ognyan Kirilov", "role": "old piano tuner", "trashed": "2025-11-10T10:00"},
    ]


GROUPS = [
    {"key": "viktor_costs", "name": "Viktor's costs", "currency": "BGN", "members": ["stefan"],
     "created": "2025-09-01T10:00"},
    {"key": "vienna", "name": "Choir tour Vienna", "currency": "EUR", "members": ["petar", "desi", "ani", "hristo"],
     "created": "2025-11-15T20:00"},
    {"key": "choir_fund", "name": "Chamber choir fund", "members": ["petar", "desi", "tsvetan", "ani", "hristo"],
     "created": "2025-09-10T20:00"},
    {"key": "studio", "name": "Studio rent", "members": ["vesi"], "created": "2025-10-01T10:00"},
    {"key": "bathroom_g", "name": "Bathroom works", "currency": "BGN", "members": ["mila", "radka"],
     "created": "2026-01-05T10:00"},
    {"key": "bansko", "name": "Bansko ski weekend", "members": ["mila", "viktor"], "created": "2026-01-10T10:00"},
]

EXPENSES = [
    {"group": "viktor_costs", "name": "Basketball fee January", "amount": 80, "paid_by": "me",
     "split": ["me", "stefan"], "date": "2026-01-05"},
    {"group": "viktor_costs", "name": "School trip to Rila", "amount": 120, "paid_by": "stefan",
     "split": ["me", "stefan"], "date": "2026-01-18"},
    {"group": "viktor_costs", "name": "Winter jacket", "amount": 160, "paid_by": "me",
     "split": ["me", "stefan"], "date": "2025-12-06"},
    {"group": "vienna", "name": "Bus deposit", "amount": 200, "paid_by": "petar",
     "split": ["me", "petar", "desi", "ani"], "date": "2026-01-14"},
    {"group": "vienna", "name": "Hostel booking", "amount": 360, "paid_by": "me",
     "split": ["me", "desi", "ani", "hristo"], "date": "2026-01-20"},
    {"group": "choir_fund", "name": "Sheet music copies", "amount": 45, "paid_by": "me",
     "split": ["me", "petar", "desi"], "date": "2026-01-08"},
    {"group": "choir_fund", "name": "Christmas concert flowers", "amount": 60, "paid_by": "desi",
     "split": ["me", "desi", "tsvetan"], "date": "2025-12-20"},
    {"group": "studio", "name": "Studio rent January", "amount": 300, "paid_by": "vesi",
     "split": ["me", "vesi"], "date": "2026-01-02"},
    {"group": "bathroom_g", "name": "Tiles", "amount": 900, "paid_by": "me",
     "split": ["me", "mila", "radka"], "date": "2026-01-21"},
    {"group": "bathroom_g", "name": "Demolition deposit", "amount": 600, "paid_by": "radka",
     "split": ["me", "radka"], "date": "2026-01-12"},
]

LISTS = [
    {"key": "teaching_l", "name": "Teaching", "area": "work"},
    {"key": "choir_l", "name": "Choir"},
    {"key": "reno_l", "name": "Renovation", "area": "home"},
    {"key": "home_l", "name": "Home", "area": "home"},
    {"key": "viktor_l", "name": "Viktor", "area": "family"},
    {"key": "shopping_l", "name": "Shopping"},
]


def events():
    out = []
    # choir rehearsal, Tuesday evenings
    d = date(2025, 12, 2)
    while d <= date(2026, 3, 10):
        ev = {"key": f"choir_{d.strftime('%m%d')}", "name": "Choir rehearsal", "start": f"{d}T19:00",
              "end": f"{d}T21:00", "attendees": ["petar", "desi"], "description": "St. Sofia church hall"}
        if d == date(2026, 1, 6):
            ev["cancelled"] = "2026-01-02T10:00"
        out.append(ev)
        d += timedelta(weeks=1)
    # Ivan's lesson, Monday afternoons
    d = date(2026, 1, 5)
    while d <= date(2026, 2, 23):
        out.append({"key": f"ivan_{d.strftime('%m%d')}", "name": "Ivan's lesson", "start": f"{d}T17:00",
                    "end": f"{d}T17:45", "attendees": ["ivan_t"]})
        d += timedelta(weeks=1)
    # Maria's lesson, Wednesday afternoons
    d = date(2026, 1, 7)
    while d <= date(2026, 2, 25):
        ev = {"key": f"maria_{d.strftime('%m%d')}", "name": "Maria's lesson", "start": f"{d}T16:00",
              "end": f"{d}T17:00", "attendees": ["maria_d"]}
        if d == date(2026, 1, 14):
            ev["cancelled"] = "2026-01-13T20:00"
        out.append(ev)
        d += timedelta(weeks=1)
    out += [
        # family
        {"key": "dentist_v", "name": "Viktor's dentist", "start": "2026-02-04T15:00", "end": "2026-02-04T15:30",
         "attendees": ["viktor"], "description": "Dr. Nikolova, Lozenets"},
        {"key": "dentist_me", "name": "Dentist", "start": "2026-02-10T09:00", "end": "2026-02-10T09:45",
         "description": "Dr. Nikolova, Lozenets"},
        {"key": "ptm", "name": "Parent-teacher meeting", "start": "2026-02-03T17:00", "end": "2026-02-03T18:00",
         "attendees": ["yordanka"], "description": "Viktor's class, room 21"},
        {"key": "basket_feb", "name": "Viktor's basketball game", "start": "2026-02-07T11:00",
         "end": "2026-02-07T12:30", "attendees": ["viktor", "stefan"]},
        {"key": "basket_jan", "name": "Viktor's basketball game", "start": "2026-01-24T11:00",
         "end": "2026-01-24T12:30", "attendees": ["viktor"]},
        {"key": "handover_0125", "name": "Stefan picks up Viktor", "start": "2026-01-25T18:00",
         "end": "2026-01-25T18:15", "attendees": ["stefan", "viktor"]},
        {"key": "handover_0201", "name": "Stefan picks up Viktor", "start": "2026-02-01T18:00",
         "end": "2026-02-01T18:15", "attendees": ["stefan", "viktor"]},
        {"key": "handover_0208", "name": "Stefan picks up Viktor", "start": "2026-02-08T18:00",
         "end": "2026-02-08T18:15", "attendees": ["stefan", "viktor"]},
        {"key": "mediation", "name": "Mediation with Stefan", "start": "2026-01-19T14:00", "end": "2026-01-19T15:00",
         "attendees": ["stefan"], "description": "summer schedule"},
        {"key": "mama_bday", "name": "Mama's birthday dinner", "start": "2026-02-15T19:00", "end": "2026-02-15T22:00",
         "attendees": ["radka", "mila", "viktor"], "description": "Restaurant Chevermeto"},
        {"key": "coffee_mila", "name": "Coffee with Mila", "start": "2026-01-31T11:00", "end": "2026-01-31T12:00",
         "attendees": ["mila"]},
        {"key": "opera", "name": "Opera with Mila", "start": "2026-02-19T19:00", "end": "2026-02-19T22:00",
         "attendees": ["mila"], "description": "Sofia Opera, Tosca"},
        {"key": "school_concert", "name": "Viktor's school concert", "start": "2026-02-11T18:00",
         "end": "2026-02-11T19:30", "attendees": ["viktor"]},
        {"key": "bansko_ev", "name": "Bansko ski weekend", "start": "2026-02-13T16:00", "end": "2026-02-13T20:00",
         "attendees": ["mila", "viktor"], "cancelled": "2026-01-27T21:00"},
        # teaching and music
        {"key": "recital", "name": "Student recital", "start": "2026-02-21T11:00", "end": "2026-02-21T13:00",
         "attendees": ["maria_d", "ivan_t", "kalina", "boris", "sofia_a"], "description": "Music school hall"},
        {"key": "dress_reh", "name": "Recital dress rehearsal", "start": "2026-02-20T17:00", "end": "2026-02-20T19:00",
         "attendees": ["maria_d", "ivan_t", "kalina", "boris", "sofia_a"], "description": "Music school hall"},
        {"key": "vesi_exam", "name": "Veselina's violin exam", "start": "2026-02-05T10:00", "end": "2026-02-05T11:30",
         "attendees": ["vesi"], "description": "accompanying, Brahms sonata no. 1"},
        {"key": "vesi_reh", "name": "Rehearsal with Veselina", "start": "2026-02-02T18:00", "end": "2026-02-02T19:30",
         "attendees": ["vesi"], "description": "studio"},
        {"key": "vesi_reh_jan", "name": "Rehearsal with Veselina", "start": "2026-01-29T18:00",
         "end": "2026-01-29T19:30", "attendees": ["vesi"], "description": "studio"},
        {"key": "sofia_run", "name": "Sofia's exam run-through", "start": "2026-01-30T17:30",
         "end": "2026-01-30T18:30", "attendees": ["sofia_a"]},
        {"key": "lunch_petar", "name": "Lunch with Petar", "start": "2026-01-30T12:00", "end": "2026-01-30T13:00",
         "attendees": ["petar"]},
        {"key": "masterclass", "name": "Masterclass with Prof. Stoyanova", "start": "2026-02-28T10:00",
         "end": "2026-02-28T16:00", "attendees": ["stoyanova", "niki"], "description": "conservatory, room 3"},
        {"key": "tuner", "name": "Piano tuner", "start": "2026-02-12T10:00", "end": "2026-02-12T11:00",
         "attendees": ["lyubo"]},
        {"key": "niki_lesson", "name": "Niki's lesson", "start": "2026-01-29T16:00", "end": "2026-01-29T17:00",
         "attendees": ["niki"]},
        {"key": "kalina_lesson", "name": "Kalina's lesson", "start": "2026-02-06T16:30", "end": "2026-02-06T17:15",
         "attendees": ["kalina"]},
        {"key": "maria_k_lesson", "name": "Lesson with Maria Koleva", "start": "2026-02-05T18:00",
         "end": "2026-02-05T19:00", "attendees": ["maria_k"]},
        {"key": "concert_dec", "name": "Choir concert", "start": "2025-12-20T18:00", "end": "2025-12-20T20:00",
         "attendees": ["petar", "desi", "ani"], "description": "St. Sofia church"},
        {"key": "concert_mar", "name": "Choir concert", "start": "2026-03-14T19:00", "end": "2026-03-14T21:00",
         "attendees": ["petar", "desi", "ani", "hristo"], "description": "Bulgaria Hall"},
        {"key": "sectional", "name": "Alto sectional", "start": "2026-02-04T19:00", "end": "2026-02-04T20:00",
         "attendees": ["ani"], "description": "St. Sofia church hall"},
        {"key": "vienna_trip", "name": "Choir trip to Vienna", "start": "2026-04-17T06:00", "end": "2026-04-17T18:00",
         "attendees": ["petar", "desi", "ani", "hristo"], "description": "bus from the Palace of Culture"},
        # renovation
        {"key": "walkthrough", "name": "Walkthrough with Mitko", "start": "2026-02-02T09:00", "end": "2026-02-02T10:00",
         "attendees": ["mitko"], "description": "bathroom, bring the tile samples"},
        {"key": "tiles_delivery", "name": "Tiles delivery", "start": "2026-02-06T08:00", "end": "2026-02-06T09:00",
         "attendees": ["todor"]},
        {"key": "electrician", "name": "Electrician visit", "start": "2026-02-09T08:30", "end": "2026-02-09T10:30",
         "attendees": ["plamen"]},
        {"key": "plumber", "name": "Plumber", "start": "2026-01-15T08:00", "end": "2026-01-15T10:00",
         "attendees": ["krasi"]},
        {"key": "kitchen_measure", "name": "Kitchen measurement", "start": "2026-01-22T10:00",
         "end": "2026-01-22T11:00", "attendees": ["mitko"]},
        {"key": "demolition", "name": "Bathroom demolition", "start": "2026-02-16T08:00", "end": "2026-02-16T16:00",
         "attendees": ["mitko", "todor"], "description": "no water from 8 to 4"},
        {"key": "tiling_start", "name": "Tiling starts", "start": "2026-01-26T08:00", "end": "2026-01-26T12:00",
         "attendees": ["todor"], "cancelled": "2026-01-23T18:00"},
        {"key": "building_meeting", "name": "Building meeting", "start": "2026-02-11T20:00", "end": "2026-02-11T21:00",
         "attendees": ["ivan_d"], "description": "entrance B, lift repair"},
        # trashed: one inside the window, one past it
        {"key": "coffee_desi", "name": "Coffee with Desi", "start": "2026-01-27T10:00", "end": "2026-01-27T11:00",
         "attendees": ["desi"], "trashed": "2026-01-26T20:00"},
        {"key": "choir_party", "name": "Christmas choir party", "start": "2025-12-19T19:00",
         "end": "2025-12-19T23:00", "attendees": ["petar", "desi", "tsvetan"], "trashed": "2025-12-22T10:00"},
    ]
    return out


def tasks():
    t = [
        # teaching
        {"key": "programme", "name": "Prepare recital programme", "due": "2026-02-10", "priority": 1,
         "status": "in_progress", "effort": 120, "list": "teaching_l", "description": "recital prep"},
        {"key": "certificates", "name": "Print certificates for recital", "due": "2026-02-19", "effort": 30,
         "list": "teaching_l", "description": "recital prep"},
        {"key": "hall", "name": "Book the music school hall", "due": "2026-01-15", "completed": "2026-01-12T11:00",
         "list": "teaching_l"},
        {"key": "invoice_feb", "name": "Invoice February lessons", "due": "2026-02-01", "effort": 45,
         "list": "teaching_l"},
        {"key": "sheet_1", "name": "Buy sheet music", "due": "2026-02-06", "effort": 40, "list": "teaching_l",
         "description": "Czerny op. 599 for Boris"},
        {"key": "sheet_2", "name": "Buy sheet music", "due": "2026-01-09", "completed": "2026-01-09T13:00",
         "list": "teaching_l"},
        {"key": "piece_kalina", "name": "Choose a piece for Kalina", "due": "2026-02-03", "effort": 30,
         "list": "teaching_l", "description": "exam prep"},
        {"key": "piece_boris", "name": "Choose a piece for Boris", "due": "2026-02-05", "effort": 30,
         "list": "teaching_l", "description": "exam prep"},
        {"key": "roster", "name": "Update the student roster", "effort": 60, "list": "teaching_l", "priority": 3},
        {"key": "theory", "name": "Mark theory tests", "due": "2026-01-28", "effort": 90, "list": "teaching_l"},
        {"key": "brahms", "name": "Practise the Brahms sonata", "due": "2026-02-04", "effort": 300, "priority": 1,
         "status": "in_progress", "description": "exam prep"},
        {"key": "niki_letter", "name": "Write Niki's recommendation letter", "due": "2026-02-12", "effort": 60,
         "priority": 2, "list": "teaching_l"},
        # choir
        {"key": "alto_line", "name": "Learn the alto line for Rachmaninov", "status": "in_progress", "effort": 240,
         "list": "choir_l"},
        {"key": "photocopy", "name": "Photocopy choir scores", "due": "2026-02-03", "effort": 20, "list": "choir_l"},
        {"key": "choir_fees", "name": "Collect choir fees", "due": "2026-01-31", "effort": 15, "list": "choir_l"},
        {"key": "bus_plovdiv", "name": "Book the bus to Plovdiv", "due": "2025-11-20",
         "completed": "2025-11-18T12:00", "list": "choir_l"},
        {"key": "vienna_passports", "name": "Collect passport copies for Vienna", "due": "2026-02-20", "effort": 30,
         "list": "choir_l", "priority": 2},
        # renovation
        {"key": "bathroom", "name": "Bathroom renovation", "status": "in_progress", "priority": 1, "effort": 600,
         "list": "reno_l", "description": "Mitko's crew, about three weeks"},
        {"key": "tiles", "name": "Choose tiles", "parent": "bathroom", "due": "2026-01-20",
         "completed": "2026-01-19T17:00", "effort": 120},
        {"key": "shower", "name": "Pick a shower cabin", "parent": "bathroom", "due": "2026-02-04", "effort": 60},
        {"key": "tiler_deposit", "name": "Pay the tiler deposit", "parent": "bathroom", "due": "2026-02-06",
         "effort": 10},
        {"key": "kitchen_quote", "name": "Get a quote for the kitchen", "due": "2026-02-13", "list": "reno_l",
         "effort": 45},
        {"key": "sockets", "name": "Ask Plamen about the sockets", "due": "2026-02-08", "effort": 15, "list": "reno_l",
         "description": "ask Mitko first"},
        {"key": "paint", "name": "Order paint", "due": "2026-02-10", "list": "reno_l", "effort": 20},
        {"key": "cover_piano", "name": "Cover the piano before demolition", "due": "2026-02-15", "priority": 1,
         "effort": 30, "list": "reno_l"},
        {"key": "clear_bath", "name": "Clear out the bathroom", "due": "2026-02-14", "effort": 120, "list": "reno_l"},
        {"key": "permit", "name": "Tell the building manager about the works", "due": "2026-01-10",
         "completed": "2026-01-05T09:10", "list": "reno_l"},
        # home
        {"key": "building_fee", "name": "Pay the building fee", "due": "2026-02-05", "effort": 10, "list": "home_l"},
        {"key": "car_insurance", "name": "Renew car insurance", "due": "2026-02-20", "priority": 2, "list": "home_l",
         "effort": 30},
        {"key": "hall_lamp", "name": "Fix the hallway lamp", "list": "home_l", "trashed": "2026-01-18T20:00"},
        {"key": "tyres", "name": "Change to winter tyres", "due": "2025-11-15", "completed": "2025-11-10T10:00",
         "list": "home_l"},
        {"key": "upright", "name": "Sell the old upright piano", "trashed": "2025-12-01T10:00"},
        {"key": "call_mama", "name": "Call Mama about Sunday", "due": "2026-01-30", "effort": 15},
        {"key": "backup", "name": "Back up lesson videos", "status": "cancelled", "effort": 60},
        {"key": "tax", "name": "File the tax return", "due": "2026-04-30", "priority": 2, "effort": 180},
        # viktor
        {"key": "trip_form", "name": "Sign Viktor's school trip form", "due": "2026-02-02", "effort": 5,
         "list": "viktor_l"},
        {"key": "basket_fee", "name": "Pay Viktor's basketball fee", "due": "2026-02-01", "effort": 10,
         "list": "viktor_l"},
        {"key": "trainers", "name": "Buy Viktor new trainers", "due": "2026-02-14", "list": "viktor_l",
         "description": "size 44, the black ones"},
        {"key": "v_passport", "name": "Renew Viktor's passport", "status": "in_progress", "list": "viktor_l",
         "description": "needs Stefan's consent at the notary", "effort": 90},
        {"key": "summer_email", "name": "Email Stefan about the summer schedule", "due": "2026-02-06", "effort": 20,
         "list": "viktor_l"},
        {"key": "maths_tutor", "name": "Find a maths tutor for Viktor", "due": "2026-01-25",
         "completed": "2026-01-23T20:00", "list": "viktor_l"},
        # shopping
        {"key": "batteries", "name": "Buy metronome batteries", "due": "2026-01-31", "effort": 10,
         "list": "shopping_l"},
        {"key": "mama_gift", "name": "Buy a birthday gift for Mama", "due": "2026-02-13", "effort": 60,
         "list": "shopping_l", "priority": 2},
        {"key": "ink", "name": "Buy printer ink", "due": "2026-01-20", "completed": "2026-01-19T12:00",
         "list": "shopping_l"},
        {"key": "rosin", "name": "Buy rosin for Vesi", "list": "shopping_l", "status": "cancelled"},
    ]
    # electricity bill, monthly on the 28th
    for y, m in ((2025, 10), (2025, 11), (2025, 12)):
        t.append({"key": f"elec_{m:02d}", "name": "Pay the electricity bill", "due": f"{y}-{m:02d}-28",
                  "completed": f"{y}-{m:02d}-27T20:00", "list": "home_l", "effort": 5})
    t.append({"key": "elec_01", "name": "Pay the electricity bill", "due": "2026-01-28", "list": "home_l", "effort": 5})
    t.append({"key": "elec_02", "name": "Pay the electricity bill", "due": "2026-02-28", "list": "home_l", "effort": 5})
    return t


NOTEBOOKS = [
    {"key": "lessons_nb", "name": "Lesson notes"},
    {"key": "choir_nb", "name": "Choir"},
    {"key": "reno_nb", "name": "Renovation"},
    {"key": "recipes_nb", "name": "Recipes"},
    {"key": "diary_nb", "name": "Diary 2019"},
    {"key": "ideas_nb", "name": "Teaching ideas"},
]

NOTES = [
    {"key": "maria_notes", "name": "Maria D. progress", "body": "left hand still weak, scales in G and D",
     "notebook": "lessons_nb", "created": "2026-01-28T17:10", "pinned": True},
    {"key": "ivan_notes", "name": "Ivan progress", "body": "sight reading better, rushes the Clementi",
     "notebook": "lessons_nb", "created": "2026-01-26T18:00"},
    {"key": "niki_notes", "name": "Niki audition plan", "body": "Bach prelude, Chopin nocturne, Bulgarian piece",
     "notebook": "lessons_nb", "created": "2026-01-22T17:00", "pinned": True},
    {"key": "kalina_notes", "name": "Kalina repertoire", "body": "Burgmuller, maybe Grieg for the exam",
     "notebook": "lessons_nb", "created": "2026-01-20T17:30"},
    {"key": "fees_note", "name": "Lesson fees 2026", "body": "40 per hour kids, 50 adults, recital fee 20",
     "notebook": "lessons_nb", "created": "2026-01-03T10:00", "pinned": True},
    {"key": "recital_order", "name": "Recital running order", "body": "Boris, Maria, Ivan, Kalina, Sofia last",
     "notebook": "lessons_nb", "created": "2026-01-27T21:00"},
    {"key": "rach_notes", "name": "Rachmaninov vespers", "body": "alto divisi in no. 6, breathe after bar 12",
     "notebook": "choir_nb", "created": "2026-01-20T21:30"},
    {"key": "vienna_plan", "name": "Vienna tour plan", "body": "two concerts, Stephansdom mass on Sunday",
     "notebook": "choir_nb", "created": "2026-01-14T22:00"},
    {"key": "seating", "name": "Choir seating", "body": "altos left of Petar, Desi front row",
     "notebook": "choir_nb", "created": "2025-12-02T21:00"},
    {"key": "reno_budget", "name": "Bathroom budget", "body": "tiles 900, labour 3200, cabin 700, spare 500",
     "notebook": "reno_nb", "created": "2026-01-06T20:00", "pinned": True},
    {"key": "mitko_calls", "name": "Calls with Mitko", "body": "he wants the tiles on site by the 6th",
     "notebook": "reno_nb", "created": "2026-01-29T09:30"},
    {"key": "measurements", "name": "Bathroom measurements", "body": "2.1 by 1.7, ceiling 2.5",
     "notebook": "reno_nb", "created": "2026-01-09T18:00"},
    {"key": "banitsa", "name": "Mama's banitsa", "body": "filo, sirene, eggs, yoghurt with soda",
     "notebook": "recipes_nb", "created": "2025-11-02T12:00"},
    {"key": "tarator", "name": "Tarator", "body": "cucumber, yoghurt, walnuts, dill", "notebook": "recipes_nb",
     "created": "2025-08-15T13:00"},
    {"key": "diary_june", "name": "June 2019", "body": "Viktor started piano, gave up after a month",
     "notebook": "diary_nb", "created": "2019-06-30T22:00"},
    {"key": "ideas_games", "name": "Rhythm games", "body": "clap names, ta-ti cards, body percussion",
     "notebook": "ideas_nb", "created": "2025-10-10T19:00"},
    {"key": "stefan_call", "name": "Call with Stefan", "body": "he takes Viktor two weeks in July, I take August",
     "created": "2026-01-26T19:30"},
    {"key": "viktor_school", "name": "Viktor school stuff", "body": "maths grade slipping, tutor on Thursdays",
     "created": "2026-01-16T14:00"},
    {"key": "vesi_tempi", "name": "Brahms tempi", "body": "first movement slower than she wants, rit. at 214",
     "created": "2026-01-29T20:00"},
    {"key": "gift_ideas", "name": "Gift ideas", "body": "Mama: a warm scarf; Mila: opera tickets",
     "created": "2026-01-12T22:00"},
    {"key": "wifi_note", "name": "Router notes", "body": "Vivacom box behind the piano, restart twice",
     "created": "2025-09-01T10:00"},
    {"key": "reading", "name": "Books to read", "body": "Neuhaus, The Art of Piano Playing", "created": "2026-01-01T11:00"},
    {"key": "old_schedule", "name": "Autumn lesson schedule", "body": "Mon Ivan, Wed Maria, Thu Niki",
     "created": "2025-09-05T10:00", "trashed": "2026-01-10T10:00"},
    {"key": "old_choir", "name": "Choir list 2024", "body": "32 singers", "created": "2024-09-01T10:00",
     "trashed": "2025-11-20T10:00"},
]

FOLDERS = [
    {"key": "reno_f", "name": "Renovation"},
    {"key": "viktor_f", "name": "Viktor"},
    {"key": "students_f", "name": "Students"},
    {"key": "tax_f", "name": "Taxes"},
    {"key": "choir_f", "name": "Choir"},
    {"key": "scans_f", "name": "Scans"},
]

DOCUMENTS = [
    {"key": "contract", "name": "Contract with Mitko", "folder": "reno_f", "starred": True,
     "created": "2026-01-04T12:00"},
    {"key": "quote_bath", "name": "Bathroom quote", "folder": "reno_f", "created": "2025-12-15T10:00"},
    {"key": "tiles_invoice", "name": "Tiles invoice", "folder": "reno_f", "created": "2026-01-21T15:00"},
    {"key": "floor_plan", "name": "Flat floor plan", "folder": "reno_f", "created": "2025-12-10T09:00"},
    {"key": "custody", "name": "Custody agreement", "folder": "viktor_f", "starred": True,
     "created": "2023-05-12T10:00"},
    {"key": "report_card", "name": "Viktor's report card", "folder": "viktor_f", "created": "2026-01-23T16:00"},
    {"key": "trip_consent", "name": "School trip consent", "folder": "viktor_f", "created": "2026-01-27T08:30"},
    {"key": "roster_doc", "name": "Student roster 2026", "folder": "students_f", "created": "2026-01-02T10:00"},
    {"key": "recital_prog", "name": "Recital programme draft", "folder": "students_f",
     "created": "2026-01-27T21:15"},
    {"key": "niki_cv", "name": "Niki's audition form", "folder": "students_f", "created": "2026-01-22T17:20"},
    {"key": "tax_2024", "name": "Tax return 2024", "folder": "tax_f", "created": "2025-04-20T10:00"},
    {"key": "income_2025", "name": "Lesson income 2025", "folder": "tax_f", "created": "2026-01-10T11:00"},
    {"key": "rach_score", "name": "Rachmaninov score", "folder": "choir_f", "created": "2025-12-01T20:00"},
    {"key": "vienna_list", "name": "Vienna rooming list", "folder": "choir_f", "created": "2026-01-20T22:00"},
    {"key": "brahms_score", "name": "Brahms sonata piano part", "starred": True, "created": "2025-11-28T10:00"},
    {"key": "warranty", "name": "Piano warranty", "created": "2019-03-01T10:00"},
    {"key": "scan_71", "name": "Scan 0071", "created": "2026-01-29T22:10"},
    {"key": "scan_72", "name": "Scan 0072", "created": "2026-01-29T22:11"},
    {"key": "old_contract", "name": "Old studio contract", "folder": "students_f", "created": "2024-09-01T10:00",
     "trashed": "2026-01-15T10:00"},
]

ALBUMS = [
    {"key": "recital24", "name": "Recital 2024"},
    {"key": "recital25", "name": "Recital 2025"},
    {"key": "reno_album", "name": "Bathroom progress"},
    {"key": "viktor_album", "name": "Viktor"},
    {"key": "choir_album", "name": "Choir"},
    {"key": "plovdiv_album", "name": "Plovdiv trip"},
    {"key": "vienna_album", "name": "Vienna 2026"},
]

PHOTOS = [
    {"key": "r24_bow", "name": "Final bow", "taken": "2024-06-15T12:30", "albums": ["recital24"],
     "people": ["maria_d", "ivan_t"], "starred": True},
    {"key": "r24_stage", "name": "Stage before the doors opened", "taken": "2024-06-15T10:40", "albums": ["recital24"]},
    {"key": "r25_group", "name": "Recital group photo", "taken": "2025-06-14T13:00",
     "albums": ["recital25", "choir_album"], "people": ["maria_d", "ivan_t", "kalina", "sofia_a"], "starred": True},
    {"key": "r25_sofia", "name": "Sofia at the Steinway", "taken": "2025-06-14T12:10", "albums": ["recital25"],
     "people": ["sofia_a"]},
    {"key": "r25_boris", "name": "Boris's first recital", "taken": "2025-06-14T11:20", "albums": ["recital25"],
     "people": ["boris"]},
    {"key": "r25_flowers", "name": "Flowers from the parents", "taken": "2025-06-14T13:30", "albums": ["recital25"]},
    {"key": "bath_before", "name": "Bathroom before", "taken": "2026-01-05T10:00", "albums": ["reno_album"],
     "starred": True},
    {"key": "bath_tiles", "name": "Tile samples", "taken": "2026-01-19T16:30", "albums": ["reno_album"]},
    {"key": "bath_pipes", "name": "Old pipes behind the wall", "taken": "2026-01-15T09:20", "albums": ["reno_album"],
     "people": ["krasi"]},
    {"key": "bath_measure", "name": "Mitko measuring", "taken": "2026-01-22T10:20",
     "albums": ["reno_album"], "people": ["mitko"]},
    {"key": "v_basket", "name": "Viktor's three-pointer", "taken": "2026-01-24T11:40", "albums": ["viktor_album"],
     "people": ["viktor"], "starred": True},
    {"key": "v_birthday", "name": "Viktor's 15th birthday", "taken": "2025-10-08T19:00", "albums": ["viktor_album"],
     "people": ["viktor", "radka", "mila"], "starred": True},
    {"key": "v_snow", "name": "Snow on Vitosha", "taken": "2026-01-11T12:00", "albums": ["viktor_album"],
     "people": ["viktor"]},
    {"key": "v_school", "name": "First day of school", "taken": "2025-09-15T08:00", "albums": ["viktor_album"],
     "people": ["viktor"]},
    {"key": "choir_xmas", "name": "Christmas concert", "taken": "2025-12-20T19:10",
     "albums": ["choir_album"], "people": ["petar", "desi", "ani"], "starred": True},
    {"key": "choir_warmup", "name": "Warm-up in the hall", "taken": "2026-01-20T19:05", "albums": ["choir_album"],
     "people": ["petar"]},
    {"key": "choir_altos", "name": "The alto row", "taken": "2025-12-20T17:40",
     "albums": ["choir_album"], "people": ["ani"]},
    {"key": "plovdiv_old", "name": "Old town Plovdiv", "taken": "2025-11-22T14:00",
     "albums": ["plovdiv_album", "choir_album"], "people": ["desi", "ani"]},
    {"key": "plovdiv_theatre", "name": "Roman theatre", "taken": "2025-11-22T16:00", "albums": ["plovdiv_album"],
     "starred": True},
    {"key": "plovdiv_mama", "name": "Mama in Kapana", "taken": "2025-11-23T11:00", "albums": ["plovdiv_album"],
     "people": ["radka"]},
    {"key": "vienna_poster", "name": "Vienna tour poster", "taken": "2026-01-14T22:10", "albums": ["vienna_album"]},
    {"key": "mama_mila", "name": "Mama and Mila at lunch", "taken": "2026-01-24T13:30", "people": ["radka", "mila"]},
    {"key": "piano_keys", "name": "Chipped key", "taken": "2026-01-26T15:00"},
    {"key": "whiteboard", "name": "Lesson plan whiteboard", "taken": "2026-01-28T16:05"},
    {"key": "vesi_duo", "name": "Vesi and me after rehearsal", "taken": "2026-01-29T19:40", "people": ["vesi"]},
    {"key": "lunch_p", "name": "Lunch with Petar", "taken": "2026-01-30T12:40", "people": ["petar"]},
    {"key": "snow_street", "name": "Snowy Oborishte street", "taken": "2026-01-11T09:00"},
    {"key": "receipt_tiles", "name": "Receipt for tiles", "taken": "2026-01-21T15:10"},
    {"key": "sunset", "name": "Sunset from the balcony", "taken": "2026-01-18T17:20", "starred": True},
    {"key": "niki_hands", "name": "Niki's hand position", "taken": "2026-01-22T16:30", "people": ["niki"]},
    {"key": "tree", "name": "Christmas tree", "taken": "2025-12-24T20:00", "people": ["viktor"]},
    {"key": "blurry_1", "name": "Blurry recital shot", "taken": "2025-06-14T12:00", "trashed": "2026-01-25T09:00"},
    {"key": "blurry_2", "name": "Blurry snow", "taken": "2026-01-11T12:01", "trashed": "2026-01-12T09:00"},
    {"key": "blurry_3", "name": "Blurry bus window", "taken": "2025-11-22T09:00", "trashed": "2025-12-01T09:00"},
]

DEBTS = [
    {"key": "d_maria_k", "person": "maria_k", "direction": "owes_me", "amount": 100, "name": "January lessons",
     "date": "2026-01-15"},
    {"key": "d_kalina", "person": "kalina", "direction": "owes_me", "amount": 80, "name": "Two lessons in January",
     "date": "2026-01-20"},
    {"key": "d_daniela", "person": "daniela", "direction": "owes_me", "amount": 160, "name": "Boris's December lessons",
     "date": "2025-12-18"},
    {"key": "d_niki", "person": "niki", "direction": "owes_me", "amount": 120, "name": "Audition coaching",
     "date": "2026-01-22"},
    {"key": "d_ivan_t", "person": "ivan_t", "direction": "owes_me", "amount": 40, "name": "Recital fee",
     "date": "2026-01-26", "settled": "2026-01-26T18:00"},
    {"key": "d_mitko", "person": "mitko", "direction": "i_owe", "amount": 1500, "name": "Second installment for the bathroom",
     "date": "2026-01-28"},
    {"key": "d_todor", "person": "todor", "direction": "i_owe", "amount": 300, "name": "Tiler deposit",
     "date": "2026-01-29"},
    {"key": "d_mila", "person": "mila", "direction": "i_owe", "amount": 500, "name": "Loan for the tiles",
     "date": "2025-12-28"},
    {"key": "d_stefan", "person": "stefan", "direction": "owes_me", "amount": 75, "name": "Half of Viktor's glasses",
     "date": "2025-11-12"},
    {"key": "d_vesi", "person": "vesi", "direction": "i_owe", "amount": 25, "name": "Rosin and strings",
     "date": "2026-01-27"},
    {"key": "d_petar", "person": "petar", "direction": "i_owe", "amount": 30, "name": "Concert tickets",
     "date": "2025-12-11", "settled": "2025-12-20T21:00"},
    {"key": "d_plamen", "person": "plamen", "direction": "i_owe", "amount": 120, "name": "Socket survey",
     "date": "2026-01-21"},
    {"key": "d_sofia", "person": "sofia_a", "direction": "owes_me", "amount": 50, "name": "Exam accompaniment",
     "date": "2025-11-28"},
]

LOCKER = [
    {"key": "gmail", "name": "Gmail", "type": "login", "username": "elena.petrova.piano@gmail.com",
     "url": "https://mail.google.com", "password": "Chopin-Op9-2", "starred": True},
    {"key": "zoom", "name": "Zoom", "type": "login", "username": "elena.petrova.piano@gmail.com",
     "url": "https://zoom.us", "password": "OnlineLessons26", "notes": "for online lessons"},
    {"key": "dsk", "name": "DSK online banking", "type": "login", "username": "epetrova",
     "url": "https://dskdirect.bg", "password": "Vitosha-1979"},
    {"key": "imslp", "name": "IMSLP", "type": "login", "username": "epetrova", "url": "https://imslp.org",
     "password": "scores4free"},
    {"key": "visa", "name": "DSK Visa card", "type": "card", "card_number": "4532 7788 1122 3344", "cvv": "518",
     "starred": True},
    {"key": "alarm", "name": "Studio alarm code", "type": "note", "notes": "7-3-9-1, then the star key"},
    {"key": "id_card", "name": "Identity card", "type": "identity", "password": "EGN 7904120000"},
    {"key": "wifi", "name": "Home wifi", "type": "wifi", "password": "steinway-b-211"},
    {"key": "school_pc", "name": "Music school PC", "type": "password", "password": "Solfege#12"},
    {"key": "ssh", "name": "Choir website server", "type": "ssh_key", "notes": "Hristo set it up",
     "password": "ssh-ed25519 AAAAC3-choir-site"},
    {"key": "sheet_api", "name": "Sheet music shop API", "type": "api_credential", "password": "smx-4471", "notes": "for the studio order form"},
    {"key": "passport", "name": "Bulgarian passport", "type": "passport", "notes": "expires May 2029"},
    {"key": "savings", "name": "Fibank savings", "type": "bank_account", "notes": "Viktor's university fund"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence"},
    {"key": "sibelius", "name": "Sibelius licence", "type": "software_licence", "notes": "key in the purchase email"},
    {"key": "crypto", "name": "Old crypto wallet", "type": "crypto_wallet", "notes": "Stefan's idea, 0.02 BTC"},
    {"key": "union", "name": "Musicians' union card", "type": "membership", "notes": "member no. 4471"},
    {"key": "deed", "name": "Flat title deed", "type": "document", "notes": "original with the notary in Lozenets"},
    {"key": "old_skype", "name": "Old Skype", "type": "login", "username": "elena_piano", "url": "https://skype.com",
     "password": "lessons2015", "trashed": "2026-01-14T10:00"},
]

LINKS = [
    {"from": "piece_kalina", "to": "kalina"},
    {"from": "piece_boris", "to": "boris"},
    {"from": "sheet_1", "to": "boris"},
    {"from": "niki_letter", "to": "niki"},
    {"from": "brahms", "to": "vesi"},
    {"from": "choir_fees", "to": "petar"},
    {"from": "vienna_passports", "to": "petar"},
    {"from": "bathroom", "to": "mitko"},
    {"from": "shower", "to": "mitko"},
    {"from": "tiler_deposit", "to": "todor"},
    {"from": "sockets", "to": "plamen"},
    {"from": "sockets", "to": "mitko"},
    {"from": "kitchen_quote", "to": "mitko"},
    {"from": "permit", "to": "ivan_d"},
    {"from": "building_fee", "to": "ivan_d"},
    {"from": "call_mama", "to": "radka"},
    {"from": "mama_gift", "to": "radka"},
    {"from": "trip_form", "to": "viktor"},
    {"from": "basket_fee", "to": "viktor"},
    {"from": "trainers", "to": "viktor"},
    {"from": "v_passport", "to": "viktor"},
    {"from": "v_passport", "to": "stefan"},
    {"from": "summer_email", "to": "stefan"},
    {"from": "maths_tutor", "to": "viktor"},
    {"from": "rosin", "to": "vesi"},
    {"from": "maria_notes", "to": "maria_d"},
    {"from": "ivan_notes", "to": "ivan_t"},
    {"from": "niki_notes", "to": "niki"},
    {"from": "kalina_notes", "to": "kalina"},
    {"from": "vienna_plan", "to": "petar"},
    {"from": "seating", "to": "petar"},
    {"from": "seating", "to": "desi"},
    {"from": "mitko_calls", "to": "mitko"},
    {"from": "stefan_call", "to": "stefan"},
    {"from": "viktor_school", "to": "viktor"},
    {"from": "viktor_school", "to": "yordanka"},
    {"from": "vesi_tempi", "to": "vesi"},
    {"from": "gift_ideas", "to": "radka"},
    {"from": "gift_ideas", "to": "mila"},
    {"from": "banitsa", "to": "radka"},
]


def world():
    return {
        "me": "Elena Petrova",
        "epoch": "2023-01-01T09:00",
        "seed": "T17",
        "currency": "BGN",
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
    out = HERE / "T17.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
