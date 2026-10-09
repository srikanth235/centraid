"""World T26: Ahmed Bello, oil-rig electrician on a 28/28 rotation, Port Harcourt (NGN vault).

    python3 authored/worlds/T26_build.py      # writes authored/worlds/T26.json (deterministic)

Today in the sessions is Tuesday 2026-11-24 05:30. Ahmed flew home from the Bonga FPSO on
12 November and goes back offshore on 10 December. He is married to Ngozi with five children
(Tobi 15, Kemi 13, Dayo 10, Femi 7, Bisi 3); his mother (Mama) lives in Ibadan and turns 70 on
6 December. He is building a house in Rumuokoro with a builder (Olumide) and runs a monthly
savings circle (ajo) with his cousins. Built-in ambiguity: two Kunles (cousin Kunle Bello, HSE
officer Kunle Adeyemi), two Emekas (instrument tech, crane operator), two dentist appointments,
two handover calls with Segun, five crew change flights, recurring site visits and ajo meetings,
near-duplicate tasks (diesel runs, monthly electricity and ajo payments, two school-fee tasks),
nicknames (Mama, TB, Iffy), a misspelled-looking name (Ifeanyi Ezeh), cancelled events,
completed tasks, rows trashed inside and past the 30-day restore window, an empty group, a group
with members but no expenses (GBP), an empty folder, an empty notebook, an empty album and two
USD groups.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        # family
        {"key": "ngozi", "name": "Ngozi Bello", "role": "wife", "starred": True, "met": "Uniport, Port Harcourt",
         "last_contacted": "2026-11-23T19:30", "last_contacted_kind": "visit"},
        {"key": "tobi", "name": "Tobi Bello", "role": "son, 15"},
        {"key": "kemi", "name": "Kemi Bello", "role": "daughter, 13"},
        {"key": "dayo", "name": "Dayo Bello", "role": "son, 10"},
        {"key": "femi", "name": "Femi Bello", "role": "son, 7"},
        {"key": "bisi", "name": "Bisi Bello", "role": "daughter, 3"},
        {"key": "mama", "name": "Rashidat Bello", "role": "mother, Ibadan", "nickname": "Mama", "cadence": 3,
         "starred": True, "last_contacted": "2026-11-23T21:00", "last_contacted_kind": "call"},
        {"key": "aisha", "name": "Aisha Okon", "role": "sister, Uyo", "cadence": 14,
         "last_contacted": "2026-11-22T20:00", "last_contacted_kind": "call"},
        # cousins (ajo)
        {"key": "kunle_b", "name": "Kunle Bello", "role": "cousin, ajo coordinator", "cadence": 30, "met": "Ibadan",
         "last_contacted": "2026-11-17T18:00", "last_contacted_kind": "call"},
        {"key": "bayo", "name": "Bayo Bello", "role": "cousin", "met": "Ibadan",
         "last_contacted": "2026-10-25T17:00", "last_contacted_kind": "message"},
        {"key": "funmi", "name": "Funmi Ajayi", "role": "cousin", "met": "Ibadan"},
        {"key": "sade", "name": "Sade Ogun", "role": "cousin", "met": "Lagos"},
        {"key": "ibrahim", "name": "Ibrahim Bello", "role": "cousin", "met": "Kano", "cadence": 60,
         "last_contacted": "2026-09-27T16:00", "last_contacted_kind": "visit"},
        # Bonga crew
        {"key": "chidi", "name": "Chidi Okafor", "role": "senior electrician", "met": "Bonga FPSO", "starred": True,
         "cadence": 7, "last_contacted": "2026-11-18T20:00", "last_contacted_kind": "call"},
        {"key": "emeka_n", "name": "Emeka Nwosu", "role": "instrument tech", "met": "Bonga FPSO"},
        {"key": "emeka_o", "name": "Emeka Obi", "role": "crane operator", "met": "Bonga FPSO"},
        {"key": "musa", "name": "Musa Danjuma", "role": "toolpusher", "met": "Bonga FPSO", "cadence": 14,
         "last_contacted": "2026-11-11T09:00", "last_contacted_kind": "meeting"},
        {"key": "victor", "name": "Victor Etim", "role": "rig medic", "met": "Bonga FPSO"},
        {"key": "tunde", "name": "Tunde Bakare", "role": "roustabout", "nickname": "TB", "met": "Onne base"},
        {"key": "john", "name": "John Pritchard", "role": "offshore installation manager", "met": "Aberdeen",
         "cadence": 30, "last_contacted": "2026-11-10T08:00", "last_contacted_kind": "meeting"},
        {"key": "segun", "name": "Segun Adeyemi", "role": "back-to-back electrician", "cadence": 14,
         "last_contacted": "2026-11-20T18:00", "last_contacted_kind": "call"},
        {"key": "kunle_a", "name": "Kunle Adeyemi", "role": "HSE officer", "met": "Bonga FPSO"},
        {"key": "ifeanyi", "name": "Ifeanyi Ezeh", "role": "motorman", "nickname": "Iffy", "met": "Onne base"},
        # house build
        {"key": "olumide", "name": "Olumide Sanni", "role": "builder", "starred": True, "cadence": 7,
         "last_contacted": "2026-11-21T12:00", "last_contacted_kind": "visit"},
        {"key": "garba", "name": "Garba Lawal", "role": "site foreman"},
        {"key": "okonkwo", "name": "Chinedu Okonkwo", "role": "block supplier"},
        {"key": "yemisi", "name": "Yemisi Fashola", "role": "architect", "cadence": 30,
         "last_contacted": "2026-11-02T11:00", "last_contacted_kind": "call"},
        # others
        {"key": "dr_uche", "name": "Uche Okoro", "role": "family doctor"},
        {"key": "ebere", "name": "Ebere Chukwu", "role": "dentist"},
        {"key": "adaeze", "name": "Adaeze Nnaji", "role": "school principal"},
        {"key": "sunday", "name": "Sunday Etuk", "role": "mechanic"},
        {"key": "blessing", "name": "Blessing Akpan", "role": "heliport logistics"},
        # trashed: one inside the 30-day window, one past it
        {"key": "paul", "name": "Paul Amadi", "role": "old landlord", "trashed": "2026-11-08T10:00"},
        {"key": "gbenga", "name": "Gbenga Oni", "role": "ex-colleague", "trashed": "2026-09-10T10:00"},
    ]


GROUPS = [
    {"key": "rig_g", "name": "Bonga crew kitty", "members": ["chidi", "emeka_n", "emeka_o", "musa", "victor", "tunde"],
     "created": "2025-03-01T10:00"},
    {"key": "house_g", "name": "Rumuokoro house build", "members": ["olumide", "ngozi"],
     "created": "2026-02-01T10:00"},
    {"key": "ajo_g", "name": "Cousins ajo", "members": ["kunle_b", "bayo", "funmi", "sade", "ibrahim"],
     "created": "2025-01-05T10:00"},
    {"key": "family_g", "name": "Bello family", "members": ["ngozi", "mama", "aisha"],
     "created": "2024-06-01T10:00"},
    {"key": "aberdeen_g", "name": "Aberdeen BOSIET trip", "currency": "USD", "members": ["chidi", "segun", "john"],
     "created": "2026-10-01T10:00"},
    {"key": "welfare_g", "name": "Offshore welfare fund", "currency": "USD", "members": ["musa", "victor", "kunle_a"],
     "created": "2026-05-01T10:00"},
    {"key": "fivea_g", "name": "Onne five-a-side", "currency": "GBP", "members": ["tunde", "ifeanyi"],
     "created": "2026-08-01T10:00"},
    {"key": "xmas_g", "name": "Christmas party 2026", "members": [], "created": "2026-11-20T10:00"},
]

EXPENSES = [
    {"group": "rig_g", "name": "Suya night on the base", "amount": 42000, "paid_by": "me",
     "split": ["me", "chidi", "emeka_n", "musa"], "date": "2026-11-11"},
    {"group": "rig_g", "name": "Crew barbecue drinks", "amount": 60000, "paid_by": "chidi",
     "split": ["me", "chidi", "emeka_o", "victor", "tunde", "musa"], "date": "2026-11-07"},
    {"group": "rig_g", "name": "Farewell gift for Musa's wife", "amount": 30000, "paid_by": "victor",
     "split": ["me", "victor", "chidi"], "date": "2026-10-20"},
    {"group": "house_g", "name": "Cement 200 bags", "amount": 1900000, "paid_by": "me",
     "split": ["me", "ngozi"], "date": "2026-11-14"},
    {"group": "house_g", "name": "Builder labour November", "amount": 850000, "paid_by": "me",
     "split": ["me", "ngozi"], "date": "2026-11-21"},
    {"group": "house_g", "name": "Sand and gravel", "amount": 420000, "paid_by": "ngozi",
     "split": ["me", "ngozi"], "date": "2026-10-05"},
    {"group": "ajo_g", "name": "November contributions", "amount": 500000, "paid_by": "kunle_b",
     "split": ["me", "kunle_b", "bayo", "funmi", "sade"], "date": "2026-11-01"},
    {"group": "ajo_g", "name": "Hall rent for meeting", "amount": 25000, "paid_by": "me",
     "split": ["me", "bayo", "ibrahim"], "date": "2026-10-25"},
    {"group": "family_g", "name": "Mama's hospital bill", "amount": 180000, "paid_by": "me",
     "split": ["me", "aisha"], "date": "2026-10-02"},
    {"group": "family_g", "name": "Mama's birthday cake deposit", "amount": 45000, "paid_by": "aisha",
     "split": ["me", "aisha", "ngozi"], "date": "2026-11-19"},
    {"group": "aberdeen_g", "name": "Hotel deposit", "amount": 600, "paid_by": "chidi",
     "split": ["me", "chidi", "segun"], "date": "2026-10-10", "currency": "USD"},
    {"group": "aberdeen_g", "name": "Course fee top-up", "amount": 300, "paid_by": "me",
     "split": ["me", "chidi", "segun", "john"], "date": "2026-10-12", "currency": "USD"},
    {"group": "welfare_g", "name": "Gym equipment", "amount": 450, "paid_by": "musa",
     "split": ["me", "musa", "victor", "kunle_a"], "date": "2026-06-03", "currency": "USD"},
]

LISTS = [
    {"key": "home_l", "name": "Home", "area": "family"},
    {"key": "house_l", "name": "House build", "area": "house"},
    {"key": "rig_l", "name": "Offshore", "area": "work"},
    {"key": "kids_l", "name": "Kids school", "area": "family"},
    {"key": "shop_l", "name": "Shopping"},
    {"key": "ajo_l", "name": "Ajo", "area": "money"},
]


def events():
    out = []
    # site visits with the builder, Saturday mornings while home
    for d in (date(2026, 9, 19), date(2026, 9, 26), date(2026, 10, 3), date(2026, 10, 10),
              date(2026, 11, 14), date(2026, 11, 21), date(2026, 11, 28), date(2026, 12, 5)):
        out.append({"key": f"site_{d.strftime('%m%d')}", "name": "Site visit with Olumide",
                    "start": f"{d}T10:00", "end": f"{d}T12:00", "attendees": ["olumide", "garba"],
                    "description": "Rumuokoro plot"})
    # crew change flights from the heliport
    for d, desc in ((date(2026, 9, 17), "home"), (date(2026, 10, 15), "out to Bonga"),
                    (date(2026, 11, 12), "home"), (date(2026, 12, 10), "out to Bonga"),
                    (date(2027, 1, 7), "home")):
        out.append({"key": f"flight_{d.strftime('%y%m%d')}", "name": "Crew change flight",
                    "start": f"{d}T07:00", "end": f"{d}T08:30", "description": f"Port Harcourt heliport, {desc}"})
    # ajo meeting, last Sunday of the month
    for d in (date(2026, 8, 30), date(2026, 9, 27), date(2026, 10, 25), date(2026, 11, 29), date(2026, 12, 27)):
        out.append({"key": f"ajo_{d.strftime('%m%d')}", "name": "Ajo meeting", "start": f"{d}T16:00",
                    "end": f"{d}T18:00", "attendees": ["kunle_b", "bayo", "funmi", "sade"],
                    "description": "Kunle's house, Rumuola"})
    # offshore safety drill, Wednesdays on the rig
    for d in (date(2026, 10, 21), date(2026, 10, 28), date(2026, 11, 4), date(2026, 11, 11)):
        out.append({"key": f"drill_{d.strftime('%m%d')}", "name": "Offshore safety drill", "start": f"{d}T10:00",
                    "end": f"{d}T11:00", "attendees": ["kunle_a"], "description": "muster station B"})
    # boys' football, Saturday afternoons while home
    for d in (date(2026, 11, 14), date(2026, 11, 21), date(2026, 11, 28), date(2026, 12, 5)):
        out.append({"key": f"football_{d.strftime('%m%d')}", "name": "Football for Dayo and Femi",
                    "start": f"{d}T16:00", "end": f"{d}T17:30", "attendees": ["dayo", "femi"]})
    out += [
        # family
        {"key": "dentist_femi", "name": "Dentist for Femi", "start": "2026-11-26T09:00", "end": "2026-11-26T09:30",
         "attendees": ["femi", "ebere"], "description": "Smile Dental, GRA"},
        {"key": "dentist_kemi", "name": "Dentist for Kemi", "start": "2026-12-03T09:00", "end": "2026-12-03T09:30",
         "attendees": ["kemi", "ebere"], "description": "Smile Dental, GRA"},
        {"key": "pta", "name": "PTA meeting", "start": "2026-11-27T14:00", "end": "2026-11-27T15:30",
         "attendees": ["adaeze"], "description": "Kemi and Tobi's school hall"},
        {"key": "parents_day", "name": "Parents day at Kemi's school", "start": "2026-12-04T10:00",
         "end": "2026-12-04T13:00", "attendees": ["kemi", "ngozi", "adaeze"]},
        {"key": "mama70", "name": "Mama's 70th birthday", "start": "2026-12-06T12:00", "end": "2026-12-06T20:00",
         "attendees": ["mama", "aisha", "ngozi", "tobi", "kemi", "dayo", "femi", "bisi"],
         "description": "Ibadan, family house in Bodija"},
        {"key": "kemi_bday", "name": "Kemi's birthday party", "start": "2026-11-15T14:00", "end": "2026-11-15T18:00",
         "attendees": ["kemi", "ngozi", "tobi", "dayo", "femi", "bisi"]},
        {"key": "anniversary", "name": "Anniversary dinner with Ngozi", "start": "2026-11-20T19:00",
         "end": "2026-11-20T22:00", "attendees": ["ngozi"], "description": "Genesis restaurant"},
        {"key": "xmas_call", "name": "Christmas video call with family", "start": "2026-12-25T18:00",
         "end": "2026-12-25T19:00", "attendees": ["ngozi", "tobi", "kemi", "dayo", "femi", "bisi"]},
        {"key": "aisha_visit", "name": "Aisha visiting", "start": "2026-11-28T19:00", "end": "2026-11-28T22:00",
         "attendees": ["aisha"]},
        {"key": "haircut", "name": "Haircut for the boys", "start": "2026-11-22T10:00", "end": "2026-11-22T11:00",
         "attendees": ["dayo", "femi"]},
        {"key": "results", "name": "Pick up Tobi's exam results", "start": "2026-12-08T12:00",
         "end": "2026-12-08T13:00", "attendees": ["tobi"]},
        {"key": "vaccination", "name": "Bisi's vaccination", "start": "2026-12-01T11:00", "end": "2026-12-01T11:30",
         "attendees": ["bisi", "dr_uche"]},
        # house
        {"key": "blocks", "name": "Block delivery at site", "start": "2026-11-24T09:00", "end": "2026-11-24T10:00",
         "attendees": ["okonkwo", "garba"]},
        {"key": "roof_insp", "name": "Roofing inspection with Yemisi", "start": "2026-11-25T11:00",
         "end": "2026-11-25T12:00", "attendees": ["yemisi", "olumide"]},
        {"key": "roof_meet", "name": "Meeting with Olumide about roofing", "start": "2026-11-30T15:00",
         "end": "2026-11-30T16:00", "attendees": ["olumide"]},
        {"key": "plaster", "name": "Plastering starts", "start": "2026-12-01T08:00", "end": "2026-12-01T09:00",
         "attendees": ["garba"]},
        {"key": "mortgage", "name": "Bank meeting about the mortgage", "start": "2026-11-27T10:00",
         "end": "2026-11-27T11:00", "description": "Zenith, Trans-Amadi"},
        {"key": "car_service", "name": "Car service at Sunday's", "start": "2026-11-26T13:00",
         "end": "2026-11-26T15:00", "attendees": ["sunday"]},
        # work
        {"key": "handover_1", "name": "Handover call with Segun", "start": "2026-11-13T18:00",
         "end": "2026-11-13T18:30", "attendees": ["segun"]},
        {"key": "handover_2", "name": "Handover call with Segun", "start": "2026-12-09T18:00",
         "end": "2026-12-09T18:30", "attendees": ["segun"]},
        {"key": "medical", "name": "Offshore medical renewal", "start": "2026-12-02T08:00", "end": "2026-12-02T10:00",
         "attendees": ["dr_uche"], "description": "OGUK medical, bring old certificate"},
        {"key": "shutdown", "name": "Shutdown planning meeting", "start": "2026-10-20T14:00",
         "end": "2026-10-20T16:00", "attendees": ["musa", "john", "chidi", "emeka_n"],
         "description": "turbine B maintenance window"},
        {"key": "crane", "name": "Crane inspection", "start": "2026-10-28T14:00", "end": "2026-10-28T15:00",
         "attendees": ["emeka_o"]},
        {"key": "deck_bbq", "name": "Crew barbecue on deck", "start": "2026-11-07T18:00", "end": "2026-11-07T20:00",
         "attendees": ["chidi", "emeka_o", "victor", "tunde", "musa"]},
        {"key": "bosiet", "name": "BOSIET refresher in Aberdeen", "start": "2027-01-18T08:00",
         "end": "2027-01-18T17:00", "attendees": ["chidi", "segun"], "description": "Survival centre, Dyce"},
        {"key": "chidi_dinner", "name": "Dinner with Chidi", "start": "2026-11-19T19:00", "end": "2026-11-19T21:00",
         "attendees": ["chidi"], "cancelled": "2026-11-18T12:00"},
        {"key": "beach", "name": "Beach trip to Bonny", "start": "2026-11-29T08:00", "end": "2026-11-29T13:00",
         "attendees": ["ngozi", "tobi", "kemi"], "cancelled": "2026-11-20T09:00"},
        {"key": "tunde_wedding", "name": "Tunde's wedding", "start": "2026-10-10T14:00", "end": "2026-10-10T20:00",
         "attendees": ["tunde"], "cancelled": "2026-10-01T09:00"},
        {"key": "surveyor", "name": "Meeting with the surveyor", "start": "2026-11-13T14:00", "end": "2026-11-13T15:00",
         "trashed": "2026-11-14T09:00"},
        {"key": "cinema", "name": "Kids cinema outing", "start": "2026-11-16T16:00", "end": "2026-11-16T18:00",
         "attendees": ["tobi", "kemi", "dayo"], "trashed": "2026-11-17T09:00"},
        {"key": "golf", "name": "Golf with John", "start": "2026-09-20T09:00", "end": "2026-09-20T12:00",
         "attendees": ["john"], "trashed": "2026-09-22T09:00"},
    ]
    return out


def tasks():
    t = [
        # home
        {"key": "gate", "name": "Fix the gate motor", "due": "2026-11-27", "priority": 2, "effort": 120,
         "list": "home_l", "description": "remote works, motor hums, check the capacitor"},
        {"key": "inverter", "name": "Replace inverter batteries", "due": "2026-12-05", "priority": 1, "effort": 90,
         "list": "home_l", "description": "two 200Ah tubular"},
        {"key": "diesel_1", "name": "Buy diesel for generator", "due": "2026-11-15", "completed": "2026-11-15T10:00",
         "effort": 30, "list": "home_l"},
        {"key": "diesel_2", "name": "Buy diesel for generator", "due": "2026-11-26", "effort": 30, "list": "home_l"},
        {"key": "gen_service", "name": "Service the generator", "due": "2026-11-29", "effort": 60, "list": "home_l"},
        {"key": "car_ins", "name": "Renew car insurance", "due": "2026-12-08", "priority": 3, "effort": 20},
        {"key": "tank", "name": "Clean the overhead water tank", "due": "2026-11-18", "completed": "2026-11-18T09:00",
         "list": "home_l"},
        # house build
        {"key": "roofing", "name": "Order roofing sheets", "due": "2026-11-27", "priority": 1, "effort": 60,
         "list": "house_l", "description": "long span aluminium, 0.55mm"},
        {"key": "instalment", "name": "Pay builder second instalment", "due": "2026-11-30", "priority": 1, "effort": 15,
         "list": "house_l"},
        {"key": "tiles", "name": "Choose tiles with Ngozi", "due": "2026-12-06", "effort": 120, "list": "house_l"},
        {"key": "drawings", "name": "Get electrical drawings approved", "status": "in_progress", "priority": 2,
         "effort": 180, "list": "house_l"},
        {"key": "wiring", "name": "Wire the new house", "status": "in_progress", "priority": 2, "effort": 2400,
         "list": "house_l", "description": "do it myself over the next two rotations"},
        {"key": "cables", "name": "Buy cables", "parent": "wiring", "due": "2026-12-02", "effort": 90},
        {"key": "db_board", "name": "Buy distribution board", "parent": "wiring", "due": "2026-12-02", "effort": 45},
        {"key": "sockets", "name": "Mark socket positions", "parent": "wiring", "due": "2026-11-28", "effort": 60},
        {"key": "blocks_count", "name": "Check the block count", "due": "2026-11-24", "completed": "2026-11-23T17:00",
         "list": "house_l"},
        {"key": "sand", "name": "Pay for sand delivery", "due": "2026-10-05", "completed": "2026-10-05T12:00",
         "list": "house_l"},
        {"key": "bq", "name": "Build the boys' quarters", "status": "cancelled", "effort": 600, "list": "house_l"},
        {"key": "c_of_o", "name": "Chase the C of O at Lands", "due": "2026-12-04", "priority": 2, "effort": 180},
        # offshore
        {"key": "bosiet_t", "name": "Book BOSIET refresher", "due": "2026-12-01", "priority": 2, "effort": 30,
         "list": "rig_l"},
        {"key": "timesheet", "name": "Submit timesheet", "due": "2026-11-13", "completed": "2026-11-13T09:00",
         "list": "rig_l"},
        {"key": "pack", "name": "Pack kit for rotation", "due": "2026-12-09", "effort": 60, "list": "rig_l"},
        {"key": "handover_t", "name": "Send handover notes to Segun", "due": "2026-12-09", "priority": 2, "effort": 45,
         "list": "rig_l"},
        {"key": "multimeter", "name": "Order a new multimeter", "effort": 15, "list": "rig_l"},
        {"key": "coveralls", "name": "Buy new coveralls", "effort": 30, "list": "rig_l"},
        {"key": "permit", "name": "Review permit to work log", "due": "2026-11-11", "completed": "2026-11-11T16:00",
         "list": "rig_l"},
        # kids
        {"key": "fees_tobi", "name": "Pay Tobi's school fees", "due": "2026-11-30", "priority": 1, "effort": 20,
         "list": "kids_l"},
        {"key": "fees_kemi", "name": "Pay Kemi's school fees", "due": "2026-11-30", "priority": 1, "effort": 20,
         "list": "kids_l"},
        {"key": "sandals", "name": "Buy Femi's school sandals", "due": "2026-11-28", "effort": 45, "list": "kids_l"},
        {"key": "report", "name": "Sign Dayo's report card", "due": "2026-11-16", "completed": "2026-11-16T20:00",
         "list": "kids_l"},
        {"key": "waec", "name": "Register Tobi for WAEC lessons", "due": "2026-12-07", "priority": 3, "effort": 60,
         "list": "kids_l"},
        {"key": "phone", "name": "Fix Kemi's phone screen", "due": "2026-11-25", "effort": 40},
        # shopping
        {"key": "gift", "name": "Buy Mama's birthday gift", "due": "2026-12-04", "priority": 2, "effort": 90,
         "list": "shop_l", "description": "gold earrings, ask Aisha"},
        {"key": "rice", "name": "Buy rice for Christmas", "due": "2026-12-08", "effort": 60, "list": "shop_l"},
        {"key": "chargers", "name": "Buy phone chargers", "effort": 15, "list": "shop_l"},
        {"key": "school_bags", "name": "Buy school bags", "due": "2026-11-10", "completed": "2026-11-14T15:00",
         "list": "shop_l"},
        # party
        {"key": "party", "name": "Plan Mama's 70th", "due": "2026-12-06", "priority": 1, "status": "in_progress"},
        {"key": "canopy", "name": "Book canopies and chairs", "parent": "party", "due": "2026-11-30", "effort": 30},
        {"key": "aso_ebi", "name": "Collect aso ebi for the kids", "parent": "party", "due": "2026-12-03",
         "effort": 60},
        {"key": "caterer", "name": "Confirm the caterer", "parent": "party", "due": "2026-11-28", "effort": 20},
        # misc
        {"key": "dubai", "name": "Plan Dubai trip", "status": "cancelled", "priority": 4},
        {"key": "pension", "name": "Update pension beneficiary", "due": "2026-12-07", "priority": 3, "effort": 30},
        {"key": "tax", "name": "File tax clearance", "due": "2026-12-15", "priority": 2, "effort": 120},
        {"key": "victor_money", "name": "Send Victor the welfare money", "due": "2026-11-20",
         "completed": "2026-11-19T11:00"},
        {"key": "old_gen", "name": "Sell old generator", "list": "home_l", "trashed": "2026-11-10T10:00"},
        {"key": "gym", "name": "Renew gym membership", "trashed": "2026-09-30T10:00"},
    ]
    # electricity bill, monthly on the 25th
    for m in (8, 9, 10):
        t.append({"key": f"power_{m:02d}", "name": "Pay electricity bill", "due": f"2026-{m:02d}-25",
                  "completed": f"2026-{m:02d}-24T19:00", "list": "home_l", "effort": 10})
    t.append({"key": "power_11", "name": "Pay electricity bill", "due": "2026-11-25", "list": "home_l", "effort": 10})
    # ajo contribution, monthly on the 28th
    for m in (8, 9, 10):
        t.append({"key": f"ajo_pay_{m:02d}", "name": "Pay ajo contribution", "due": f"2026-{m:02d}-28",
                  "completed": f"2026-{m:02d}-27T18:00", "list": "ajo_l", "effort": 10})
    t.append({"key": "ajo_pay_11", "name": "Pay ajo contribution", "due": "2026-11-28", "list": "ajo_l", "effort": 10})
    t.append({"key": "payout", "name": "Collect ajo payout", "due": "2026-12-27", "priority": 2, "list": "ajo_l"})
    return t


NOTEBOOKS = [
    {"key": "offshore_nb", "name": "Offshore log"},
    {"key": "house_nb", "name": "House build"},
    {"key": "kids_nb", "name": "Kids"},
    {"key": "ajo_nb", "name": "Ajo records"},
    {"key": "biz_nb", "name": "Business ideas"},
    {"key": "poultry_nb", "name": "Poultry farm plan"},
]

NOTES = [
    {"key": "turbine", "name": "Turbine B findings", "body": "breaker trips at 80 percent load, check the relay",
     "notebook": "offshore_nb", "created": "2026-11-04T21:00", "pinned": True},
    {"key": "handover_n", "name": "Handover for Segun", "body": "MCC room fan faulty, spare breakers in store 3",
     "notebook": "offshore_nb", "created": "2026-11-11T20:30"},
    {"key": "crane_n", "name": "Crane limit switch", "body": "Emeka O says the limit switch sticks in rain",
     "notebook": "offshore_nb", "created": "2026-10-28T16:00"},
    {"key": "permit_n", "name": "Permit lessons", "body": "isolate twice, test before touch",
     "notebook": "offshore_nb", "created": "2026-10-22T20:00"},
    {"key": "rotation_n", "name": "Rotation dates 2027", "body": "Jan 7 home, Feb 4 out, Mar 4 home",
     "notebook": "offshore_nb", "created": "2026-11-10T19:00"},
    {"key": "block_count", "name": "Block count", "body": "4200 blocks on site, 800 more due today",
     "notebook": "house_nb", "created": "2026-11-23T17:10", "pinned": True},
    {"key": "roof_quotes", "name": "Roofing quotes", "body": "Olumide 3.2m, Emene supplier 2.9m",
     "notebook": "house_nb", "created": "2026-11-21T13:00"},
    {"key": "socket_plan", "name": "Socket plan", "body": "four sockets per bedroom, two in the parlour wall",
     "notebook": "house_nb", "created": "2026-11-22T21:00"},
    {"key": "site_n", "name": "Site visit notes", "body": "lintel level reached, window openings too narrow",
     "notebook": "house_nb", "created": "2026-11-14T13:00"},
    {"key": "archi_n", "name": "Architect comments", "body": "move the soakaway, bigger kitchen window",
     "notebook": "house_nb", "created": "2026-09-28T11:00"},
    {"key": "kemi_school", "name": "Kemi's school fees breakdown", "body": "tuition 450k, bus 60k, uniform 25k",
     "notebook": "kids_nb", "created": "2026-11-16T20:00"},
    {"key": "tobi_waec", "name": "Tobi WAEC subjects", "body": "physics, chemistry, further maths",
     "notebook": "kids_nb", "created": "2026-11-22T18:00"},
    {"key": "bisi_health", "name": "Bisi clinic card", "body": "next jab in December, weight 14kg",
     "notebook": "kids_nb", "created": "2026-10-12T10:00"},
    {"key": "ajo_rota", "name": "Ajo payout rota", "body": "Kunle Nov, me Dec, Funmi Jan, Bayo Feb",
     "notebook": "ajo_nb", "created": "2026-09-27T18:30", "pinned": True},
    {"key": "ajo_oct", "name": "October ajo minutes", "body": "Sade late again, fine of 5k agreed",
     "notebook": "ajo_nb", "created": "2026-10-25T18:20"},
    {"key": "ajo_rules", "name": "Ajo rules", "body": "100k each monthly, payout on the last Sunday",
     "notebook": "ajo_nb", "created": "2026-08-30T18:00"},
    {"key": "fish_farm", "name": "Catfish pond idea", "body": "two tarpaulin ponds behind the new house",
     "notebook": "biz_nb", "created": "2026-10-08T21:00"},
    {"key": "solar_biz", "name": "Solar installs on the side", "body": "Garba knows installers in Eleme",
     "notebook": "biz_nb", "created": "2026-11-19T22:00"},
    {"key": "gift_ideas", "name": "Gift ideas for Mama", "body": "gold earrings, new wrapper, a trip to Mecca fund",
     "created": "2026-11-17T21:00"},
    {"key": "party_menu", "name": "Party menu", "body": "jollof, pounded yam, egusi, small chops",
     "created": "2026-11-22T20:00"},
    {"key": "guest_list", "name": "Guest list for Mama's 70th", "body": "about 150, church people and Bodija neighbours",
     "created": "2026-11-20T21:30"},
    {"key": "car_n", "name": "Car notes", "body": "Camry due service at 90000 km, front pads worn",
     "created": "2026-11-12T19:00"},
    {"key": "anniv_n", "name": "Anniversary", "body": "16 years, Genesis again next year",
     "created": "2026-11-20T23:00"},
    {"key": "chidi_n", "name": "Chidi's visa tips", "body": "UK visa takes 3 weeks, use the Lagos centre",
     "created": "2026-10-18T20:00"},
    {"key": "mortgage_n", "name": "Mortgage questions", "body": "rate, tenor, equity contribution",
     "created": "2026-11-23T08:00"},
    {"key": "old_budget", "name": "Old house budget", "body": "first estimate 28m", "created": "2026-03-01T10:00",
     "trashed": "2026-11-15T10:00"},
    {"key": "old_rota", "name": "2025 rotation", "body": "old dates", "created": "2025-12-01T10:00",
     "trashed": "2026-10-01T10:00"},
]

FOLDERS = [
    {"key": "house_f", "name": "House build"},
    {"key": "rig_f", "name": "Offshore work"},
    {"key": "kids_f", "name": "Kids school"},
    {"key": "id_f", "name": "IDs and certificates"},
    {"key": "bank_f", "name": "Bank"},
    {"key": "tenancy_f", "name": "Old tenancy"},
]

DOCUMENTS = [
    {"key": "survey", "name": "Survey plan", "folder": "house_f", "created": "2026-02-01T10:00", "starred": True},
    {"key": "building_permit", "name": "Building permit", "folder": "house_f", "created": "2026-03-10T11:00"},
    {"key": "builder_contract", "name": "Builder contract", "folder": "house_f", "created": "2026-02-15T12:00"},
    {"key": "elec_drawings", "name": "Electrical drawings", "folder": "house_f", "created": "2026-11-16T21:15"},
    {"key": "contract", "name": "Employment contract", "folder": "rig_f", "created": "2023-05-01T10:00",
     "starred": True},
    {"key": "payslip_oct", "name": "Payslip October", "folder": "rig_f", "created": "2026-10-31T08:00"},
    {"key": "payslip_sep", "name": "Payslip September", "folder": "rig_f", "created": "2026-09-30T08:00"},
    {"key": "roster", "name": "Rotation roster 2027", "folder": "rig_f", "created": "2026-11-10T19:10"},
    {"key": "bosiet_cert", "name": "BOSIET certificate", "folder": "id_f", "created": "2023-01-20T10:00"},
    {"key": "passport_scan", "name": "Passport scan", "folder": "id_f", "created": "2025-06-01T10:00",
     "starred": True},
    {"key": "fees_letter", "name": "School fees letter", "folder": "kids_f", "created": "2026-11-13T15:30"},
    {"key": "kemi_report", "name": "Kemi's report card", "folder": "kids_f", "created": "2026-11-16T19:45"},
    {"key": "statement", "name": "Bank statement October", "folder": "bank_f", "created": "2026-11-02T09:00"},
    {"key": "mortgage_offer", "name": "Mortgage offer letter", "folder": "bank_f", "created": "2026-11-20T16:40"},
    {"key": "scan_a", "name": "Scan 1121", "created": "2026-11-21T14:05"},
    {"key": "scan_b", "name": "Scan 1122", "created": "2026-11-22T14:10"},
    {"key": "receipt_cement", "name": "Cement receipt", "created": "2026-11-14T16:20"},
    {"key": "medical_form", "name": "Offshore medical form", "created": "2026-10-05T09:30"},
    {"key": "old_payslip", "name": "Payslip August", "folder": "rig_f", "created": "2026-08-31T08:00",
     "trashed": "2026-11-05T09:00"},
    {"key": "old_quote", "name": "Old roofing quote", "folder": "house_f", "created": "2026-06-01T10:00",
     "trashed": "2026-11-18T09:00"},
    {"key": "old_lease", "name": "Tenancy agreement 2022", "created": "2022-01-01T10:00",
     "trashed": "2026-09-01T09:00"},
]

ALBUMS = [
    {"key": "kids_al", "name": "Kids"},
    {"key": "house_al", "name": "House progress"},
    {"key": "rig_al", "name": "Bonga crew"},
    {"key": "kemi13_al", "name": "Kemi's 13th"},
    {"key": "family_al", "name": "Family"},
    {"key": "football_al", "name": "Football"},
    {"key": "dubai_al", "name": "Dubai 2025"},
]

PHOTOS = [
    # last Saturday (2026-11-21): site visit and football
    {"key": "p_lintel", "name": "Lintel level reached", "taken": "2026-11-21T10:40", "albums": ["house_al"],
     "people": ["olumide", "garba"], "starred": True},
    {"key": "p_windows", "name": "Window openings", "taken": "2026-11-21T11:05", "albums": ["house_al"]},
    {"key": "p_goal", "name": "Femi's first goal", "taken": "2026-11-21T16:35", "albums": ["football_al", "kids_al"],
     "people": ["femi"], "starred": True},
    {"key": "p_team", "name": "Under-11 team photo", "taken": "2026-11-21T17:25", "albums": ["football_al"],
     "people": ["dayo", "femi"]},
    # Sunday 2026-11-22
    {"key": "p_haircut", "name": "Boys after the barber", "taken": "2026-11-22T11:10", "albums": ["kids_al"],
     "people": ["dayo", "femi"]},
    {"key": "p_sunday", "name": "Sunday rice", "taken": "2026-11-22T14:30", "people": ["ngozi"]},
    {"key": "p_sunset", "name": "Sunset from the balcony", "taken": "2026-11-22T18:40"},
    # 2026-11-14 site visit and football
    {"key": "p_blocks", "name": "Block stack", "taken": "2026-11-14T10:30", "albums": ["house_al"]},
    {"key": "p_cement", "name": "Cement delivery", "taken": "2026-11-14T11:15", "albums": ["house_al"],
     "people": ["garba"]},
    {"key": "p_dayo_kick", "name": "Dayo taking a free kick", "taken": "2026-11-14T16:50", "albums": ["football_al"],
     "people": ["dayo"]},
    # Kemi's 13th, 2026-11-15
    {"key": "p_cake", "name": "Kemi blowing the candles", "taken": "2026-11-15T15:20", "albums": ["kemi13_al", "kids_al"],
     "people": ["kemi"], "starred": True},
    {"key": "p_kemi_friends", "name": "Kemi and her friends", "taken": "2026-11-15T16:00", "albums": ["kemi13_al"],
     "people": ["kemi"]},
    {"key": "p_bday_family", "name": "Birthday family photo", "taken": "2026-11-15T17:30",
     "albums": ["kemi13_al", "family_al"], "people": ["ngozi", "tobi", "kemi", "dayo", "femi", "bisi"]},
    # anniversary 2026-11-20
    {"key": "p_anniv", "name": "Anniversary dinner", "taken": "2026-11-20T20:15", "albums": ["family_al"],
     "people": ["ngozi"], "starred": True},
    # rig
    {"key": "p_deck", "name": "Crew barbecue on deck", "taken": "2026-11-07T18:45", "albums": ["rig_al"],
     "people": ["chidi", "emeka_o", "victor", "tunde"]},
    {"key": "p_turbine", "name": "Turbine B panel", "taken": "2026-11-04T15:00", "albums": ["rig_al"]},
    {"key": "p_heli", "name": "Helideck at dawn", "taken": "2026-11-12T06:40", "albums": ["rig_al"]},
    {"key": "p_crane", "name": "Crane at sunset", "taken": "2026-10-28T18:10", "albums": ["rig_al"],
     "people": ["emeka_o"]},
    {"key": "p_muster", "name": "Muster drill", "taken": "2026-11-04T10:20", "albums": ["rig_al"],
     "people": ["kunle_a"]},
    {"key": "p_fpso", "name": "Bonga FPSO from the chopper", "taken": "2026-10-15T08:10", "albums": ["rig_al"],
     "starred": True},
    # family
    {"key": "p_mama", "name": "Mama in her garden", "taken": "2026-09-27T12:00", "albums": ["family_al"],
     "people": ["mama"]},
    {"key": "p_bisi", "name": "Bisi in her new dress", "taken": "2026-11-17T09:00", "albums": ["kids_al"],
     "people": ["bisi"]},
    {"key": "p_tobi", "name": "Tobi with his science project", "taken": "2026-11-18T19:00", "albums": ["kids_al"],
     "people": ["tobi"]},
    {"key": "p_ajo", "name": "Cousins at the ajo meeting", "taken": "2026-10-25T17:10",
     "people": ["kunle_b", "bayo", "funmi", "sade"]},
    {"key": "p_aisha", "name": "Aisha and Mama", "taken": "2026-09-27T13:00", "people": ["aisha", "mama"]},
    {"key": "p_dubai", "name": "Burj Khalifa at night", "taken": "2025-04-10T21:00"},
    # loose shots
    {"key": "p_meter", "name": "Prepaid meter reading", "taken": "2026-11-23T08:15"},
    {"key": "p_receipt", "name": "Diesel receipt", "taken": "2026-11-15T10:20"},
    {"key": "p_socket", "name": "Socket layout sketch", "taken": "2026-11-22T21:05"},
    {"key": "p_car", "name": "Camry front pads", "taken": "2026-11-12T17:30"},
    {"key": "p_school", "name": "School gate", "taken": "2026-11-16T07:30"},
    {"key": "p_gate", "name": "Gate motor wiring", "taken": "2026-11-19T16:00"},
    # trashed
    {"key": "p_blurry", "name": "Blurry lintel shot", "taken": "2026-11-21T10:41", "albums": ["house_al"],
     "trashed": "2026-11-21T20:00"},
    {"key": "p_dup_goal", "name": "Duplicate goal shot", "taken": "2026-11-21T16:36", "trashed": "2026-11-22T08:00"},
    {"key": "p_old_rig", "name": "Old rig selfie", "taken": "2025-11-01T12:00", "trashed": "2026-09-15T09:00"},
]

DEBTS = [
    {"key": "d_chidi", "person": "chidi", "direction": "owes_me", "amount": 45000, "name": "Suya and drinks",
     "date": "2026-11-11"},
    {"key": "d_tunde", "person": "tunde", "direction": "owes_me", "amount": 20000, "name": "Taxi from Onne",
     "date": "2026-11-12"},
    {"key": "d_bayo", "person": "bayo", "direction": "owes_me", "amount": 150000, "name": "Loan for shop rent",
     "date": "2026-09-05"},
    {"key": "d_funmi", "person": "funmi", "direction": "owes_me", "amount": 60000, "name": "Ajo cover for October",
     "date": "2026-10-25"},
    {"key": "d_victor", "person": "victor", "direction": "i_owe", "amount": 35000, "name": "Welfare top-up",
     "date": "2026-11-03"},
    {"key": "d_olumide", "person": "olumide", "direction": "i_owe", "amount": 250000, "name": "Extra labour",
     "date": "2026-11-21"},
    {"key": "d_garba", "person": "garba", "direction": "owes_me", "amount": 15000, "name": "Transport advance",
     "date": "2026-11-18"},
    {"key": "d_aisha", "person": "aisha", "direction": "i_owe", "amount": 80000, "name": "Aso ebi fabric",
     "date": "2026-11-19"},
    {"key": "d_sunday", "person": "sunday", "direction": "i_owe", "amount": 40000, "name": "Brake pads",
     "date": "2026-08-20"},
    {"key": "d_ibrahim", "person": "ibrahim", "direction": "owes_me", "amount": 100000, "name": "School fees help",
     "date": "2026-07-15"},
    {"key": "d_emeka", "person": "emeka_n", "direction": "owes_me", "amount": 12000, "name": "Phone recharge",
     "date": "2026-10-30", "settled": "2026-11-12T10:00"},
    {"key": "d_kunle", "person": "kunle_b", "direction": "i_owe", "amount": 50000, "name": "Hall deposit",
     "date": "2026-08-28", "settled": "2026-09-27T18:00"},
    {"key": "d_segun", "person": "segun", "direction": "owes_me", "amount": 25000, "name": "Spare tools",
     "date": "2026-11-13"},
]

LOCKER = [
    {"key": "gtbank", "name": "GTBank app", "type": "login", "username": "ahmed.bello", "url": "https://www.gtbank.com",
     "password": "Bonga-Spark-2026", "starred": True, "notes": "salary account"},
    {"key": "portal", "name": "Crew portal", "type": "login", "username": "abello7", "url": "https://crew.bonga.example",
     "password": "Muster-B-41", "notes": "work"},
    {"key": "nepa_app", "name": "PHED prepaid app", "type": "login", "username": "ahmedb", "password": "Meter-0441"},
    {"key": "visa_card", "name": "Zenith Visa", "type": "card", "card_number": "4187 5500 2231 7719", "cvv": "552",
     "starred": True},
    {"key": "gate_code", "name": "Site gate padlock", "type": "note", "notes": "code 3-1-9-4, key with Garba"},
    {"key": "nin", "name": "NIN slip", "type": "identity", "password": "71023456781"},
    {"key": "wifi", "name": "Home wifi", "type": "wifi", "password": "bello-five-kids"},
    {"key": "wifi_site", "name": "Site hotspot", "type": "wifi", "password": "rumuokoro-2026"},
    {"key": "atm_pin", "name": "ATM PIN", "type": "password", "password": "4471"},
    {"key": "nas", "name": "Home NAS key", "type": "ssh_key", "notes": "family photo backup"},
    {"key": "weather_api", "name": "Marine weather API", "type": "api_credential"},
    {"key": "passport", "name": "Nigerian passport", "type": "passport", "notes": "expires March 2029"},
    {"key": "savings", "name": "Zenith savings account", "type": "bank_account", "notes": "house fund"},
    {"key": "licence", "name": "Driver's licence", "type": "driving_licence"},
    {"key": "office", "name": "Office 365", "type": "software_licence", "notes": "renews in January"},
    {"key": "usdt", "name": "USDT wallet", "type": "crypto_wallet"},
    {"key": "gym_card", "name": "Club membership", "type": "membership", "notes": "Port Harcourt Club"},
    {"key": "ogsp", "name": "OGSP card", "type": "document", "notes": "offshore safety permit"},
    {"key": "old_mtn", "name": "Old MTN login", "type": "login", "username": "ahmedb82", "password": "Onne-82",
     "trashed": "2026-11-09T09:00"},
    {"key": "old_netflix", "name": "Netflix", "type": "login", "username": "bello.family", "password": "Kids-Movie-5",
     "trashed": "2026-09-20T09:00"},
]

LINKS = [
    {"from": "roofing", "to": "olumide"},
    {"from": "instalment", "to": "olumide"},
    {"from": "tiles", "to": "ngozi"},
    {"from": "drawings", "to": "yemisi"},
    {"from": "drawings", "to": "olumide"},
    {"from": "sockets", "to": "garba"},
    {"from": "handover_t", "to": "segun"},
    {"from": "bosiet_t", "to": "chidi"},
    {"from": "fees_tobi", "to": "tobi"},
    {"from": "fees_kemi", "to": "kemi"},
    {"from": "sandals", "to": "femi"},
    {"from": "waec", "to": "tobi"},
    {"from": "phone", "to": "kemi"},
    {"from": "gift", "to": "mama"},
    {"from": "gift", "to": "aisha"},
    {"from": "party", "to": "mama"},
    {"from": "caterer", "to": "aisha"},
    {"from": "gate", "to": "ngozi"},
    {"from": "payout", "to": "kunle_b"},
    {"from": "gen_service", "to": "sunday"},
    {"from": "turbine", "to": "chidi"},
    {"from": "turbine", "to": "emeka_n"},
    {"from": "handover_n", "to": "segun"},
    {"from": "crane_n", "to": "emeka_o"},
    {"from": "permit_n", "to": "kunle_a"},
    {"from": "block_count", "to": "garba"},
    {"from": "block_count", "to": "okonkwo"},
    {"from": "roof_quotes", "to": "olumide"},
    {"from": "site_n", "to": "olumide"},
    {"from": "site_n", "to": "garba"},
    {"from": "archi_n", "to": "yemisi"},
    {"from": "kemi_school", "to": "kemi"},
    {"from": "tobi_waec", "to": "tobi"},
    {"from": "bisi_health", "to": "bisi"},
    {"from": "bisi_health", "to": "dr_uche"},
    {"from": "ajo_rota", "to": "kunle_b"},
    {"from": "ajo_rota", "to": "funmi"},
    {"from": "ajo_rota", "to": "bayo"},
    {"from": "ajo_oct", "to": "sade"},
    {"from": "solar_biz", "to": "garba"},
    {"from": "gift_ideas", "to": "mama"},
    {"from": "party_menu", "to": "aisha"},
    {"from": "guest_list", "to": "mama"},
    {"from": "guest_list", "to": "aisha"},
    {"from": "anniv_n", "to": "ngozi"},
    {"from": "chidi_n", "to": "chidi"},
    {"from": "car_n", "to": "sunday"},
]


def world():
    return {
        "me": "Ahmed Bello",
        "epoch": "2023-01-01T09:00",
        "seed": "T26",
        "currency": "NGN",
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
    out = HERE / "T26.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
