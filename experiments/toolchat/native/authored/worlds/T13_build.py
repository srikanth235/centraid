"""World T13: Amara Nwosu, PhD student in materials science in Manchester (GBP vault).

    python3 authored/worlds/T13_build.py      # writes authored/worlds/T13.json (deterministic)

Today in the sessions is Thursday 2026-09-03 22:10 (a late night after the lab). From Enugu, in a
house-share of four in Fallowfield; perovskite thin films in Helen Carter's group; on the
Nigerian society (NigSoc) committee; keeps the house bills kitty. Built-in ambiguity: two Toms
(housemate Tom Hargreaves, labmate Tom Bennett), two Ngozis (Aunty Ngozi Okonkwo, treasurer Ngozi
Eze), nicknames (Obi, Chichi, Kasia, TJ, Raj), a misspelled-looking name (Oluwaseun), two XRD
sessions, two supervisor meetings, two "Book XRD slot" tasks, monthly "Pay rent" and timesheet
tasks, two lab notebooks, cancelled events, completed tasks, trashed rows inside and past the
30-day restore window, an empty group, an empty folder and an empty album.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        # family, Enugu
        {"key": "mum", "name": "Grace Nwosu", "role": "mum", "nickname": "Mummy", "cadence": 7, "starred": True,
         "met": "Enugu", "last_contacted": "2026-08-30T17:00", "last_contacted_kind": "call"},
        {"key": "dad", "name": "Ikenna Nwosu", "role": "dad", "cadence": 14, "met": "Enugu",
         "last_contacted": "2026-08-16T17:30", "last_contacted_kind": "call"},
        {"key": "obinna", "name": "Obinna Nwosu", "role": "brother", "nickname": "Obi", "cadence": 14,
         "last_contacted": "2026-08-27T21:00", "last_contacted_kind": "message"},
        {"key": "chiamaka", "name": "Chiamaka Nwosu", "role": "sister", "nickname": "Chichi", "cadence": 7,
         "starred": True, "last_contacted": "2026-09-01T20:15", "last_contacted_kind": "message"},
        {"key": "aunty_ngozi", "name": "Ngozi Okonkwo", "role": "aunt, London", "nickname": "Aunty Ngozi",
         "cadence": 30, "last_contacted": "2026-07-26T15:00", "last_contacted_kind": "call"},
        {"key": "nkechi", "name": "Nkechi Uzor", "role": "school friend", "met": "UNN Nsukka", "cadence": 30,
         "last_contacted": "2026-06-20T12:00", "last_contacted_kind": "message"},
        # house
        {"key": "tom_h", "name": "Tom Hargreaves", "role": "housemate", "met": "Fallowfield",
         "last_contacted": "2026-09-02T19:00", "last_contacted_kind": "visit"},
        {"key": "priya", "name": "Priya Menon", "role": "housemate", "met": "Fallowfield",
         "last_contacted": "2026-09-03T08:10", "last_contacted_kind": "coffee"},
        {"key": "kasia", "name": "Katarzyna Nowak", "role": "housemate", "nickname": "Kasia", "met": "Fallowfield",
         "last_contacted": "2026-08-31T21:00", "last_contacted_kind": "message"},
        {"key": "gary", "name": "Gary Whitfield", "role": "landlord",
         "last_contacted": "2026-08-12T10:00", "last_contacted_kind": "call"},
        # lab
        {"key": "helen", "name": "Helen Carter", "role": "supervisor", "starred": True, "cadence": 14,
         "met": "PhD interview 2024", "last_contacted": "2026-08-26T11:00", "last_contacted_kind": "visit"},
        {"key": "wei", "name": "Wei Zhang", "role": "postdoc", "cadence": 7,
         "last_contacted": "2026-09-03T15:00", "last_contacted_kind": "coffee"},
        {"key": "tom_b", "name": "Tom Bennett", "role": "PhD student", "cadence": 14,
         "last_contacted": "2026-09-01T13:00", "last_contacted_kind": "coffee"},
        {"key": "fatima", "name": "Fatima Al-Sayed", "role": "PhD student", "cadence": 14,
         "last_contacted": "2026-09-02T16:30", "last_contacted_kind": "message"},
        {"key": "lukas", "name": "Lukas Brandt", "role": "PhD student", "met": "Lab induction 2024"},
        {"key": "sandra", "name": "Sandra Leigh", "role": "lab technician"},
        {"key": "raj", "name": "Rajesh Iyer", "role": "XRD facility manager", "nickname": "Raj",
         "last_contacted": "2026-08-20T10:00", "last_contacted_kind": "message"},
        # NigSoc
        {"key": "chinedu", "name": "Chinedu Okafor", "role": "NigSoc president", "cadence": 14,
         "last_contacted": "2026-08-28T18:00", "last_contacted_kind": "call"},
        {"key": "ngozi_e", "name": "Ngozi Eze", "role": "NigSoc treasurer", "cadence": 14,
         "last_contacted": "2026-08-20T19:00", "last_contacted_kind": "message"},
        {"key": "emeka", "name": "Emeka Obi", "role": "NigSoc secretary",
         "last_contacted": "2026-09-01T12:00", "last_contacted_kind": "message"},
        {"key": "tunde", "name": "Babatunde Bakare", "role": "NigSoc sports rep", "nickname": "TJ",
         "last_contacted": "2026-08-28T19:30", "last_contacted_kind": "visit"},
        {"key": "seun", "name": "Oluwaseun Adeyemi", "role": "NigSoc member", "nickname": "Seun", "met": "Freshers 2024",
         "cadence": 30, "last_contacted": "2026-07-30T14:00", "last_contacted_kind": "coffee"},
        {"key": "daniel", "name": "Daniel Mensah", "role": "friend", "met": "Peak District walk", "cadence": 30,
         "last_contacted": "2026-07-12T10:00", "last_contacted_kind": "visit"},
        # services
        {"key": "dr_shah", "name": "Anjali Shah", "role": "dentist"},
        {"key": "dr_doyle", "name": "Mark Doyle", "role": "GP"},
        {"key": "hassan", "name": "Hassan Qureshi", "role": "barber", "met": "Wilmslow Road"},
        # trashed
        {"key": "kevin", "name": "Kevin Marsh", "role": "letting agent", "trashed": "2026-08-20T10:00"},
        {"key": "jess", "name": "Jess Taylor", "role": "old flatmate", "trashed": "2026-06-10T10:00"},
    ]


GROUPS = [
    {"key": "house", "name": "House bills kitty", "currency": "GBP", "members": ["tom_h", "priya", "kasia"],
     "created": "2025-09-01T12:00"},
    {"key": "coffee", "name": "Lab coffee fund", "currency": "GBP", "members": ["wei", "tom_b", "fatima", "lukas", "sandra"],
     "created": "2025-10-01T12:00"},
    {"key": "nigsoc", "name": "NigSoc committee", "currency": "GBP",
     "members": ["chinedu", "ngozi_e", "emeka", "tunde", "seun"], "created": "2026-05-01T18:00"},
    {"key": "family", "name": "Enugu family fund", "currency": "NGN", "members": ["obinna", "chiamaka", "dad"],
     "created": "2026-01-10T10:00"},
    {"key": "lisbon", "name": "Lisbon conference", "currency": "EUR", "members": ["wei", "fatima"],
     "created": "2026-07-05T10:00"},
    {"key": "walkers", "name": "Peak District walkers", "currency": "GBP", "members": ["priya", "daniel"],
     "created": "2026-06-01T10:00"},
]

EXPENSES = [
    {"group": "house", "name": "Electricity August", "amount": 180, "paid_by": "me",
     "split": ["me", "tom_h", "priya", "kasia"], "date": "2026-08-29"},
    {"group": "house", "name": "Broadband", "amount": 32, "paid_by": "kasia",
     "split": ["me", "tom_h", "priya", "kasia"], "date": "2026-08-15"},
    {"group": "house", "name": "Cleaning supplies", "amount": 24, "paid_by": "priya",
     "split": ["me", "tom_h", "priya", "kasia"], "date": "2026-08-22"},
    {"group": "house", "name": "Water bill", "amount": 56, "paid_by": "tom_h",
     "split": ["me", "tom_h", "priya", "kasia"], "date": "2026-08-10"},
    {"group": "coffee", "name": "Coffee beans", "amount": 28, "paid_by": "wei",
     "split": ["me", "wei", "tom_b", "fatima"], "date": "2026-08-24"},
    {"group": "coffee", "name": "Milk", "amount": 6.4, "paid_by": "me", "split": ["me", "wei"], "date": "2026-09-01"},
    {"group": "coffee", "name": "New kettle", "amount": 25, "paid_by": "tom_b",
     "split": ["me", "wei", "tom_b", "fatima", "lukas"], "date": "2026-07-14"},
    {"group": "nigsoc", "name": "Hall deposit", "amount": 150, "paid_by": "me",
     "split": ["me", "chinedu", "ngozi_e"], "date": "2026-08-18"},
    {"group": "nigsoc", "name": "Drinks for movie night", "amount": 64, "paid_by": "chinedu",
     "split": ["me", "chinedu", "emeka", "tunde"], "date": "2026-08-21"},
    {"group": "family", "name": "Mum's birthday cake", "amount": 45000, "paid_by": "obinna",
     "split": ["me", "obinna", "chiamaka"], "date": "2026-07-18"},
    {"group": "family", "name": "Generator repair", "amount": 120000, "paid_by": "dad",
     "split": ["me", "obinna", "chiamaka", "dad"], "date": "2026-08-09"},
    {"group": "lisbon", "name": "Airbnb in Alfama", "amount": 540, "paid_by": "wei",
     "split": ["me", "wei", "fatima"], "date": "2026-07-20"},
    {"group": "lisbon", "name": "Conference dinner booking", "amount": 96, "paid_by": "me",
     "split": ["me", "wei", "fatima"], "date": "2026-08-30"},
]

LISTS = [
    {"key": "thesis_l", "name": "Thesis", "area": "research"},
    {"key": "lab_l", "name": "Lab", "area": "research"},
    {"key": "house_l", "name": "House", "area": "home"},
    {"key": "nigsoc_l", "name": "NigSoc", "area": "society"},
    {"key": "personal_l", "name": "Personal", "area": "personal"},
    {"key": "shopping_l", "name": "Shopping"},
]


def events():
    out = []
    # lab group meeting, Mondays 10:00 (away the week of the conference; bank holiday cancelled)
    d = date(2026, 7, 6)
    while d <= date(2026, 10, 26):
        if d != date(2026, 9, 21):
            ev = {"key": f"group_{d.strftime('%m%d')}", "name": "Lab group meeting", "start": f"{d}T10:00",
                  "end": f"{d}T11:00", "attendees": ["helen", "wei", "tom_b", "fatima", "lukas"],
                  "description": "Room C14, Materials Science Centre"}
            if d == date(2026, 8, 31):
                ev["cancelled"] = "2026-08-27T09:00"
            out.append(ev)
        d += timedelta(weeks=1)
    # badminton, Fridays 18:00 (not the Friday flying back from Lisbon)
    d = date(2026, 8, 7)
    while d <= date(2026, 10, 2):
        if d != date(2026, 9, 25):
            out.append({"key": f"badminton_{d.strftime('%m%d')}", "name": "Badminton at the Armitage",
                        "start": f"{d}T18:00", "end": f"{d}T19:30", "attendees": ["tunde", "seun"]})
        d += timedelta(weeks=1)
    # Sunday call with Mum
    d = date(2026, 8, 2)
    while d <= date(2026, 9, 27):
        out.append({"key": f"mumcall_{d.strftime('%m%d')}", "name": "Sunday call with Mum",
                    "start": f"{d}T17:00", "end": f"{d}T17:45", "attendees": ["mum"]})
        d += timedelta(weeks=1)
    out += [
        # lab
        {"key": "sem", "name": "SEM training", "start": "2026-09-04T09:30", "end": "2026-09-04T12:00",
         "attendees": ["sandra"], "description": "bring your own samples, max three"},
        {"key": "wei_xrd", "name": "Meeting with Wei about XRD data", "start": "2026-09-04T14:00",
         "end": "2026-09-04T15:00", "attendees": ["wei"]},
        {"key": "xrd_0908", "name": "XRD session", "start": "2026-09-08T14:00", "end": "2026-09-08T16:00",
         "attendees": ["raj"]},
        {"key": "xrd_0915", "name": "XRD session", "start": "2026-09-15T14:00", "end": "2026-09-15T16:00",
         "attendees": ["raj", "lukas"]},
        {"key": "helen_0826", "name": "Supervisor meeting with Helen", "start": "2026-08-26T11:00",
         "end": "2026-08-26T11:45", "attendees": ["helen"]},
        {"key": "helen_0909", "name": "Supervisor meeting with Helen", "start": "2026-09-09T11:00",
         "end": "2026-09-09T11:45", "attendees": ["helen"]},
        {"key": "jc_0909", "name": "Journal club", "start": "2026-09-09T16:00", "end": "2026-09-09T17:00",
         "attendees": ["fatima", "tom_b"], "description": "Amara presenting"},
        {"key": "jc_0930", "name": "Journal club", "start": "2026-09-30T16:00", "end": "2026-09-30T17:00",
         "attendees": ["fatima"]},
        {"key": "lukas_viva", "name": "Lukas's viva", "start": "2026-09-17T10:00", "end": "2026-09-17T13:00",
         "attendees": ["lukas", "helen"]},
        {"key": "thesis_review", "name": "Thesis progress review", "start": "2026-10-14T14:00",
         "end": "2026-10-14T15:30", "attendees": ["helen"]},
        {"key": "demo", "name": "Demonstrating first-year lab", "start": "2026-10-06T13:00", "end": "2026-10-06T17:00"},
        {"key": "diamond", "name": "Beam time at Diamond", "start": "2026-09-29T09:00", "end": "2026-09-29T21:00",
         "attendees": ["wei"], "cancelled": "2026-08-28T12:00"},
        {"key": "induction", "name": "Lab safety induction", "start": "2026-08-18T09:00", "end": "2026-08-18T10:30",
         "attendees": ["sandra"]},
        # conference
        {"key": "lisbon_out", "name": "Flight to Lisbon", "start": "2026-09-20T07:15", "end": "2026-09-20T10:00",
         "description": "TAP TP1331 from MAN"},
        {"key": "emrs", "name": "E-MRS Fall Meeting", "start": "2026-09-21", "end": "2026-09-24",
         "attendees": ["wei", "fatima"], "description": "Lisbon, poster on Tuesday"},
        {"key": "lisbon_back", "name": "Flight back from Lisbon", "start": "2026-09-25T18:00", "end": "2026-09-25T20:40"},
        # house
        {"key": "house_meeting", "name": "House meeting", "start": "2026-09-06T19:30", "end": "2026-09-06T20:30",
         "attendees": ["tom_h", "priya", "kasia"], "description": "bills and the cleaning rota"},
        {"key": "landlord", "name": "Landlord inspection", "start": "2026-09-11T10:00", "end": "2026-09-11T11:00",
         "attendees": ["gary"]},
        {"key": "bbq", "name": "House BBQ", "start": "2026-08-29T17:00", "end": "2026-08-29T21:00",
         "attendees": ["tom_h", "priya", "kasia", "daniel"]},
        # health
        {"key": "dentist", "name": "Dentist appointment", "start": "2026-09-14T08:30", "end": "2026-09-14T09:15",
         "attendees": ["dr_shah"]},
        {"key": "gp", "name": "GP appointment", "start": "2026-09-02T15:00", "end": "2026-09-02T15:20",
         "attendees": ["dr_doyle"], "cancelled": "2026-09-01T09:00"},
        {"key": "gym", "name": "Gym induction", "start": "2026-09-07T07:30", "end": "2026-09-07T08:30"},
        # NigSoc
        {"key": "committee", "name": "NigSoc committee meeting", "start": "2026-09-10T18:30", "end": "2026-09-10T20:00",
         "attendees": ["chinedu", "ngozi_e", "emeka"]},
        {"key": "freshers", "name": "NigSoc freshers welcome", "start": "2026-09-26T15:00", "end": "2026-09-26T18:00",
         "attendees": ["chinedu", "emeka", "seun"], "description": "Students' Union, room 2"},
        {"key": "indep", "name": "Independence Day party", "start": "2026-10-03T19:00", "end": "2026-10-03T23:30",
         "attendees": ["chinedu", "ngozi_e", "emeka", "tunde", "seun"], "description": "jollof, suya, owambe dress code"},
        {"key": "movie", "name": "NigSoc movie night", "start": "2026-08-21T20:00", "end": "2026-08-21T23:00",
         "attendees": ["chinedu", "tunde"]},
        {"key": "seun_coffee", "name": "Coffee with Seun", "start": "2026-09-05T11:00", "end": "2026-09-05T12:00",
         "attendees": ["seun"]},
        # family and friends
        {"key": "chichi_bday", "name": "Chiamaka's birthday", "start": "2026-09-16"},
        {"key": "aunty_visit", "name": "Visit Aunty Ngozi in London", "start": "2026-10-10"},
        {"key": "lagos_flight", "name": "Flight to Lagos", "start": "2026-12-16T21:30", "end": "2026-12-17T05:30"},
        {"key": "wedding", "name": "Obinna's traditional wedding", "start": "2026-12-19", "attendees": ["obinna"]},
        {"key": "pub_quiz", "name": "Pub quiz at the Ducie", "start": "2026-09-08T20:00", "end": "2026-09-08T22:00",
         "attendees": ["tom_h", "priya"], "trashed": "2026-08-30T10:00"},
        {"key": "theatre", "name": "Royal Exchange play with Priya", "start": "2026-08-15T19:30",
         "end": "2026-08-15T22:00", "attendees": ["priya"], "trashed": "2026-07-20T10:00"},
        {"key": "walk", "name": "Kinder Scout walk", "start": "2026-09-12T09:00", "end": "2026-09-12T16:00",
         "attendees": ["daniel", "priya"]},
    ]
    return out


def tasks():
    t = [
        # thesis
        {"key": "litrev", "name": "Draft literature review chapter", "due": "2026-09-30", "effort": 600, "priority": 1,
         "status": "in_progress", "list": "thesis_l"},
        {"key": "summarise", "name": "Summarise perovskite papers", "parent": "litrev", "due": "2026-09-15", "effort": 240},
        {"key": "zotero", "name": "Fix citations in Zotero", "parent": "litrev", "due": "2026-09-12", "effort": 90},
        {"key": "send_helen", "name": "Send draft to Helen", "parent": "litrev", "due": "2026-09-30", "effort": 10},
        {"key": "methods", "name": "Write methods chapter", "due": "2026-11-30", "priority": 2, "list": "thesis_l"},
        {"key": "solgel", "name": "Describe sol-gel synthesis", "parent": "methods", "effort": 180},
        {"key": "xrd_table", "name": "Add XRD parameters table", "parent": "methods", "effort": 60},
        {"key": "figures", "name": "Make figures for annual review", "due": "2026-10-07", "effort": 300, "priority": 2,
         "list": "thesis_l"},
        {"key": "review_form", "name": "Submit annual review form", "due": "2026-10-09", "effort": 45, "priority": 1,
         "list": "thesis_l"},
        # lab
        {"key": "xrd_analyse", "name": "Analyse XRD data from August", "due": "2026-09-06", "effort": 240,
         "status": "in_progress", "list": "lab_l"},
        {"key": "xrd_book", "name": "Book XRD slot", "due": "2026-09-04", "effort": 10, "list": "lab_l"},
        {"key": "xrd_book_lukas", "name": "Book XRD slot for Lukas", "due": "2026-09-10", "effort": 10, "list": "lab_l"},
        {"key": "precursors", "name": "Order precursor chemicals", "due": "2026-09-07", "effort": 30, "priority": 1,
         "list": "lab_l"},
        {"key": "glovebox", "name": "Clean the glovebox", "due": "2026-09-11", "effort": 60, "list": "lab_l"},
        {"key": "furnace", "name": "Calibrate the furnace", "due": "2026-08-28", "completed": "2026-08-28T16:00",
         "list": "lab_l"},
        {"key": "induct_task", "name": "Renew lab induction", "due": "2026-08-18", "completed": "2026-08-18T10:30",
         "list": "lab_l"},
        {"key": "jc_slides", "name": "Prepare journal club slides", "due": "2026-09-09", "effort": 120, "list": "lab_l"},
        {"key": "abstract", "name": "Review Fatima's abstract", "due": "2026-09-05", "effort": 30},
        {"key": "register", "name": "Register for E-MRS", "due": "2026-07-15", "completed": "2026-07-10T11:00"},
        {"key": "poster_pdf", "name": "Submit poster PDF to E-MRS", "due": "2026-09-14T17:00", "effort": 20, "priority": 1},
        {"key": "poster_print", "name": "Print the poster", "due": "2026-09-17", "effort": 30},
        {"key": "hotel", "name": "Book hotel in Lisbon", "due": "2026-08-10", "completed": "2026-08-05T21:10"},
        {"key": "claim", "name": "Claim conference expenses", "due": "2026-10-09", "effort": 40},
        {"key": "ts_jul", "name": "Submit demonstrator timesheet", "due": "2026-07-31", "completed": "2026-07-30T12:00"},
        {"key": "ts_aug", "name": "Submit demonstrator timesheet", "due": "2026-08-31", "effort": 15},
        {"key": "ts_sep", "name": "Submit demonstrator timesheet", "due": "2026-09-30", "effort": 15},
        # house
        {"key": "loo_roll", "name": "Buy toilet roll for the house", "due": "2026-09-04", "effort": 15, "list": "house_l"},
        {"key": "broadband", "name": "Sort out the broadband switch", "due": "2026-09-12", "effort": 45, "list": "house_l"},
        {"key": "bins", "name": "Put the bins out", "due": "2026-09-06T20:00", "effort": 5, "list": "house_l"},
        {"key": "latch", "name": "Fix bedroom window latch", "list": "house_l", "trashed": "2026-08-25T10:00"},
        {"key": "kitchen", "name": "Deep clean the kitchen", "status": "cancelled", "due": "2026-08-30", "list": "house_l"},
        {"key": "deposit_form", "name": "Return the deposit form to Gary", "due": "2026-08-20",
         "completed": "2026-08-19T18:00", "list": "house_l"},
        {"key": "rota", "name": "Write the new cleaning rota", "due": "2026-09-06", "effort": 20, "list": "house_l"},
        # NigSoc
        {"key": "hall", "name": "Book hall for Independence Day party", "due": "2026-09-10", "priority": 1,
         "effort": 30, "list": "nigsoc_l"},
        {"key": "jollof", "name": "Order jollof rice trays", "due": "2026-09-28", "effort": 60, "list": "nigsoc_l"},
        {"key": "flyer", "name": "Design freshers flyer", "due": "2026-09-12", "effort": 120, "list": "nigsoc_l"},
        {"key": "logo", "name": "Get NigSoc logo from Emeka", "parent": "flyer", "due": "2026-09-07", "effort": 5},
        {"key": "print_flyers", "name": "Print 200 flyers", "parent": "flyer", "due": "2026-09-14", "effort": 30},
        {"key": "mailing", "name": "Update society mailing list", "status": "in_progress", "effort": 60, "list": "nigsoc_l"},
        {"key": "fees", "name": "Collect membership fees", "due": "2026-10-02", "effort": 90, "list": "nigsoc_l"},
        {"key": "minutes_task", "name": "Type up committee minutes", "due": "2026-08-25", "completed": "2026-08-24T22:00",
         "list": "nigsoc_l"},
        # personal
        {"key": "brp", "name": "Renew BRP", "due": "2026-11-30", "priority": 1, "effort": 120, "list": "personal_l"},
        {"key": "send_mum", "name": "Send money to Mum", "due": "2026-09-05", "effort": 15, "priority": 1,
         "list": "personal_l"},
        {"key": "chichi_gift", "name": "Buy gift for Chiamaka", "due": "2026-09-12", "effort": 45, "list": "personal_l"},
        {"key": "flights", "name": "Book flights for Obinna's wedding", "due": "2026-09-30", "priority": 2, "effort": 60,
         "list": "personal_l"},
        {"key": "bank_card", "name": "Call the bank about my card", "due": "2026-08-20", "completed": "2026-08-20T09:40",
         "list": "personal_l"},
        {"key": "aso_ebi", "name": "Get aso ebi fabric measured", "due": "2026-10-15", "effort": 60, "list": "personal_l"},
        {"key": "portuguese", "name": "Learn Portuguese basics", "list": "personal_l", "trashed": "2026-07-15T10:00"},
        {"key": "spotify", "name": "Cancel Spotify family plan", "status": "cancelled", "list": "personal_l"},
        {"key": "haircut", "name": "Book braids appointment", "due": "2026-09-18", "effort": 10, "list": "personal_l"},
        # shopping
        {"key": "garri", "name": "Buy garri and ogbono", "due": "2026-09-05", "effort": 30, "list": "shopping_l"},
        {"key": "adapter", "name": "Buy EU plug adapter", "due": "2026-09-18", "effort": 10, "list": "shopping_l"},
        {"key": "notebook_buy", "name": "Buy a new lab notebook", "list": "shopping_l",
         "completed": "2026-08-14T12:00"},
        # unlisted
        {"key": "reply_aunty", "name": "Reply to Aunty Ngozi", "due": "2026-09-04", "effort": 10},
        {"key": "tour_video", "name": "Watch the Lisbon walking tour video", "effort": 25},
        {"key": "thank_raj", "name": "Thank Raj for the extra beam hours", "due": "2026-08-21", "effort": 5,
         "trashed": "2026-08-01T10:00"},
    ]
    # rent, monthly on the 1st: history plus October open
    for m in range(6, 10):
        t.append({"key": f"rent_{m:02d}", "name": "Pay rent", "due": f"2026-{m:02d}-01",
                  "completed": f"2026-{m:02d}-01T09:00", "list": "house_l"})
    t.append({"key": "rent_10", "name": "Pay rent", "due": "2026-10-01", "list": "house_l"})
    return t


NOTEBOOKS = [
    {"key": "lab25", "name": "Lab notebook 2025"},
    {"key": "lab26", "name": "Lab notebook 2026"},
    {"key": "thesis_nb", "name": "Thesis ideas"},
    {"key": "recipes_nb", "name": "Mum's recipes"},
    {"key": "minutes_nb", "name": "NigSoc minutes"},
    {"key": "reading_nb", "name": "Reading list"},
]

NOTES = [
    {"key": "anneal", "name": "Annealing run 14", "body": "150C for 10 min, pinholes gone, PCE 17.2%",
     "notebook": "lab26", "created": "2026-08-27T18:20", "pinned": True},
    {"key": "spin", "name": "Spin coating settings", "body": "4000 rpm, 30 s, antisolvent drip at 10 s",
     "notebook": "lab26", "created": "2026-08-12T15:00"},
    {"key": "xrd_notes", "name": "XRD peaks August", "body": "PbI2 peak at 12.7 degrees, needs a longer anneal",
     "notebook": "lab26", "created": "2026-09-01T17:45"},
    {"key": "glovebox_log", "name": "Glovebox log", "body": "oxygen 0.4 ppm, regen due mid September",
     "notebook": "lab26", "created": "2026-09-02T12:30"},
    {"key": "first_films", "name": "First films", "body": "all cracked, humidity too high",
     "notebook": "lab25", "created": "2025-10-20T16:00"},
    {"key": "solgel_note", "name": "Sol-gel recipe v1", "body": "TTIP in ethanol, acid catalyst, age 24 h",
     "notebook": "lab25", "created": "2025-11-14T14:00"},
    {"key": "tolerance", "name": "Tolerance factor idea", "body": "map tolerance factor against stability for the chapter",
     "notebook": "thesis_nb", "created": "2026-08-20T23:10"},
    {"key": "outline", "name": "Chapter 2 outline", "body": "history, halide perovskites, degradation, gap",
     "notebook": "thesis_nb", "created": "2026-08-05T10:00", "pinned": True},
    {"key": "helen_fb", "name": "Helen's feedback", "body": "tighten the degradation section, cite Snaith",
     "notebook": "thesis_nb", "created": "2026-08-26T12:00"},
    {"key": "egusi", "name": "Egusi soup", "body": "palm oil, ground egusi, stockfish, ugu leaves",
     "notebook": "recipes_nb", "created": "2026-03-02T19:00"},
    {"key": "jollof_note", "name": "Party jollof", "body": "smoky bottom, bay leaves, tomato paste fried well",
     "notebook": "recipes_nb", "created": "2026-04-11T18:30", "pinned": True},
    {"key": "akara", "name": "Akara", "body": "peeled beans, blend with pepper and onion",
     "notebook": "recipes_nb", "created": "2026-05-20T09:00"},
    {"key": "min_aug", "name": "Committee minutes August", "body": "hall deposit paid, freshers plan agreed",
     "notebook": "minutes_nb", "created": "2026-08-24T21:30"},
    {"key": "min_jul", "name": "Committee minutes July", "body": "elections done, Chinedu president",
     "notebook": "minutes_nb", "created": "2026-07-20T21:00"},
    {"key": "house_rules", "name": "House rules draft", "body": "quiet after 11, bins on Sunday",
     "created": "2026-08-30T20:00"},
    {"key": "wifi_note", "name": "Router notes", "body": "Virgin hub, restart from the plug behind the sofa",
     "created": "2026-08-16T11:00"},
    {"key": "gift_ideas", "name": "Gift ideas", "body": "Chichi: gold hoops; Mum: a phone case",
     "created": "2026-08-22T22:00"},
    {"key": "lisbon_tips", "name": "Lisbon tips", "body": "tram 28 early, pasteis in Belem, Wei knows a fado bar",
     "created": "2026-08-31T21:40"},
    {"key": "conf_ideas", "name": "Poster talking points", "body": "stability under humidity, 17% PCE",
     "created": "2026-09-02T22:05"},
    {"key": "wedding_note", "name": "Wedding plans", "body": "aso ebi colour is emerald, flights via Lagos",
     "created": "2026-08-08T20:00"},
    {"key": "freshers_note", "name": "Freshers stall plan", "body": "chin chin, flyers, sign-up sheet",
     "created": "2026-08-28T18:45"},
    {"key": "call_note", "name": "Call with Mum", "body": "Dad's knee better, Obi's wedding date fixed",
     "created": "2026-08-30T18:00"},
    {"key": "seminar_note", "name": "Seminar notes", "body": "tbc", "created": "2026-09-01T09:00"},
    {"key": "grant_note", "name": "Travel grant idea", "body": "tbc", "notebook": "thesis_nb",
     "created": "2026-08-18T22:00"},
    {"key": "abstract_note", "name": "Poster abstract", "body": "draft", "created": "2026-07-01T20:00"},
    {"key": "old_rota", "name": "Old cleaning rota", "body": "Tom kitchen, Priya bathroom, Kasia hall",
     "created": "2026-01-10T10:00", "trashed": "2026-08-29T20:00"},
    {"key": "old_ideas", "name": "Masters project ideas", "body": "graphene inks", "created": "2024-03-01T10:00",
     "trashed": "2026-06-01T10:00"},
]

FOLDERS = [
    {"key": "visa_f", "name": "Visa and BRP"},
    {"key": "tenancy_f", "name": "Tenancy"},
    {"key": "funding_f", "name": "Funding"},
    {"key": "conf_f", "name": "Conference"},
    {"key": "thesis_f", "name": "Thesis drafts"},
    {"key": "payslips_f", "name": "Demonstrator payslips"},
    {"key": "coursework_f", "name": "Old coursework"},
]

DOCUMENTS = [
    {"key": "brp_scan", "name": "BRP card scan", "folder": "visa_f", "starred": True, "created": "2025-09-20T10:00"},
    {"key": "cas", "name": "CAS letter", "folder": "visa_f", "created": "2024-07-15T10:00"},
    {"key": "visa_letter", "name": "Visa decision letter", "folder": "visa_f", "created": "2024-08-20T10:00"},
    {"key": "tenancy26", "name": "Tenancy agreement 2026", "folder": "tenancy_f", "starred": True,
     "created": "2026-06-28T14:00"},
    {"key": "deposit_cert", "name": "Deposit protection certificate", "folder": "tenancy_f", "created": "2026-07-10T09:00"},
    {"key": "inventory", "name": "Inventory report", "folder": "tenancy_f", "created": "2026-07-01T16:00"},
    {"key": "studentship", "name": "EPSRC studentship letter", "folder": "funding_f", "starred": True,
     "created": "2024-06-01T10:00"},
    {"key": "stipend_aug", "name": "Stipend statement August", "folder": "funding_f", "created": "2026-08-28T09:00"},
    {"key": "stipend_jul", "name": "Stipend statement July", "folder": "funding_f", "created": "2026-07-28T09:00"},
    {"key": "acceptance", "name": "E-MRS abstract acceptance", "folder": "conf_f", "created": "2026-07-02T13:00"},
    {"key": "hotel_booking", "name": "Lisbon hotel booking", "folder": "conf_f", "created": "2026-08-05T21:14"},
    {"key": "poster_v2", "name": "Poster draft v2", "folder": "conf_f", "created": "2026-09-02T16:40"},
    {"key": "litrev_d3", "name": "Literature review draft 3", "folder": "thesis_f", "created": "2026-08-31T23:00"},
    {"key": "methods_outline", "name": "Methods outline", "folder": "thesis_f", "created": "2026-08-12T11:00"},
    {"key": "payslip_jul", "name": "Payslip July", "folder": "payslips_f", "created": "2026-07-31T08:00"},
    {"key": "payslip_aug", "name": "Payslip August", "folder": "payslips_f", "created": "2026-08-31T08:00"},
    {"key": "passport_scan", "name": "Nigerian passport scan", "created": "2026-06-01T10:00"},
    {"key": "boarding", "name": "Boarding pass MAN-LIS", "created": "2026-09-03T21:30"},
    {"key": "tenancy25", "name": "Tenancy agreement 2025", "created": "2025-06-30T10:00", "trashed": "2026-08-22T10:00"},
    {"key": "old_cv", "name": "Old CV 2024", "created": "2024-02-01T10:00", "trashed": "2026-05-10T10:00"},
]

ALBUMS = [
    {"key": "enugu_al", "name": "Enugu summer 2026"},
    {"key": "lab_al", "name": "Lab life"},
    {"key": "nigsoc_al", "name": "NigSoc events"},
    {"key": "house_al", "name": "House"},
    {"key": "lisbon_al", "name": "Lisbon 2026"},
    {"key": "walks_al", "name": "Peak District"},
]

PHOTOS = [
    {"key": "p_mum_kitchen", "name": "Mum in the kitchen", "taken": "2026-07-12T13:00", "albums": ["enugu_al"],
     "people": ["mum"], "starred": True},
    {"key": "p_family", "name": "Family at Obinna's", "taken": "2026-07-18T18:30", "albums": ["enugu_al"],
     "people": ["mum", "dad", "obinna", "chiamaka"], "starred": True},
    {"key": "p_cake", "name": "Mum's birthday cake", "taken": "2026-07-18T19:10", "albums": ["enugu_al"],
     "people": ["mum"]},
    {"key": "p_market", "name": "Ogbete market", "taken": "2026-07-14T11:00", "albums": ["enugu_al"]},
    {"key": "p_chichi", "name": "Chichi at the salon", "taken": "2026-07-20T15:00", "albums": ["enugu_al"],
     "people": ["chiamaka"]},
    {"key": "p_airport", "name": "Enugu airport goodbye", "taken": "2026-07-26T09:00", "albums": ["enugu_al"],
     "people": ["dad", "chiamaka"]},
    {"key": "p_films", "name": "Films under UV", "taken": "2026-08-27T18:00", "albums": ["lab_al"], "starred": True},
    {"key": "p_glovebox", "name": "Glovebox selfie", "taken": "2026-08-12T15:30", "albums": ["lab_al"]},
    {"key": "p_lab_team", "name": "Lab team at the summer social", "taken": "2026-07-03T17:00", "albums": ["lab_al"],
     "people": ["helen", "wei", "tom_b", "fatima", "lukas"]},
    {"key": "p_sem", "name": "SEM image of grain boundaries", "taken": "2026-09-01T11:20", "albums": ["lab_al"]},
    {"key": "p_xrd", "name": "XRD machine", "taken": "2026-08-20T10:30"},
    {"key": "p_movie", "name": "Movie night crowd", "taken": "2026-08-21T21:00", "albums": ["nigsoc_al"],
     "people": ["chinedu", "tunde"]},
    {"key": "p_committee", "name": "New committee photo", "taken": "2026-07-20T20:00", "albums": ["nigsoc_al"],
     "people": ["chinedu", "ngozi_e", "emeka", "tunde", "seun"], "starred": True},
    {"key": "p_suya", "name": "Suya at the social", "taken": "2026-08-21T22:00", "albums": ["nigsoc_al"]},
    {"key": "p_bbq", "name": "House BBQ", "taken": "2026-08-29T18:30", "albums": ["house_al"],
     "people": ["tom_h", "priya", "kasia", "daniel"]},
    {"key": "p_garden", "name": "Back garden tomatoes", "taken": "2026-08-23T10:00", "albums": ["house_al"]},
    {"key": "p_leak", "name": "Bathroom ceiling leak", "taken": "2026-08-11T08:00", "albums": ["house_al"]},
    {"key": "p_meter", "name": "Electric meter reading", "taken": "2026-08-29T09:15"},
    {"key": "p_kinder", "name": "Kinder Scout summit", "taken": "2026-07-12T12:30", "albums": ["walks_al"],
     "people": ["daniel", "priya"], "starred": True},
    {"key": "p_mam_tor", "name": "Mam Tor ridge", "taken": "2026-06-14T14:00", "albums": ["walks_al"],
     "people": ["daniel"]},
    {"key": "p_graduation", "name": "Masters graduation", "taken": "2024-12-12T14:00", "people": ["mum", "dad"],
     "starred": True},
    {"key": "p_ticket", "name": "Screenshot of the TAP ticket", "taken": "2026-09-03T21:35"},
    {"key": "p_poster", "name": "Poster draft photo", "taken": "2026-09-02T16:45"},
    {"key": "p_whiteboard", "name": "Whiteboard after group meeting", "taken": "2026-08-24T11:05"},
    {"key": "p_chichi_call", "name": "Video call with Chichi", "taken": "2026-09-01T20:20", "people": ["chiamaka"]},
    {"key": "p_fatima_cake", "name": "Fatima's birthday cake", "taken": "2026-08-14T15:00", "people": ["fatima", "wei"]},
    {"key": "p_jollof", "name": "Jollof for the house", "taken": "2026-08-16T19:30", "people": ["tom_h", "kasia"]},
    {"key": "p_seun", "name": "Seun and TJ at badminton", "taken": "2026-08-28T19:00", "people": ["seun", "tunde"]},
    {"key": "p_receipt", "name": "Hall deposit receipt", "taken": "2026-08-18T12:00"},
    {"key": "p_blurry", "name": "Blurry night bus", "taken": "2026-08-22T01:30", "trashed": "2026-08-25T10:00"},
    {"key": "p_duplicate", "name": "Duplicate of the committee photo", "taken": "2026-07-20T20:01",
     "albums": ["nigsoc_al"], "people": ["chinedu", "emeka"], "trashed": "2026-08-15T10:00"},
    {"key": "p_old_room", "name": "Old room in Rusholme", "taken": "2025-08-30T12:00", "trashed": "2026-06-20T10:00"},
    {"key": "p_screenshot", "name": "Old bus timetable screenshot", "taken": "2026-05-02T08:00",
     "trashed": "2026-07-10T10:00"},
]

DEBTS = [
    {"key": "d_tom_h", "person": "tom_h", "direction": "owes_me", "amount": 18.5, "name": "Takeaway",
     "date": "2026-08-28"},
    {"key": "d_priya", "person": "priya", "direction": "i_owe", "amount": 12, "name": "Cinema tickets",
     "date": "2026-08-15"},
    {"key": "d_kasia", "person": "kasia", "direction": "owes_me", "amount": 45, "name": "New router",
     "date": "2026-08-03"},
    {"key": "d_wei", "person": "wei", "direction": "i_owe", "amount": 30, "name": "Conference dinner deposit",
     "date": "2026-08-25"},
    {"key": "d_tom_b", "person": "tom_b", "direction": "owes_me", "amount": 8, "name": "Lunch at Kro",
     "date": "2026-09-01"},
    {"key": "d_chinedu", "person": "chinedu", "direction": "owes_me", "amount": 60, "name": "Speaker gift",
     "date": "2026-07-20"},
    {"key": "d_seun", "person": "seun", "direction": "owes_me", "amount": 25, "name": "Party ticket float",
     "date": "2026-08-10", "settled": "2026-08-20T12:00"},
    {"key": "d_obinna", "person": "obinna", "direction": "i_owe", "amount": 50, "name": "Share of Mum's phone",
     "date": "2026-07-02"},
    {"key": "d_fatima", "person": "fatima", "direction": "owes_me", "amount": 15, "name": "Taxi from the lab",
     "date": "2026-09-02"},
    {"key": "d_emeka", "person": "emeka", "direction": "i_owe", "amount": 20, "name": "Printing flyers",
     "date": "2026-09-01"},
    {"key": "d_lukas", "person": "lukas", "direction": "owes_me", "amount": 10, "name": "Pizza",
     "date": "2026-08-27", "settled": "2026-08-29T12:00"},
    {"key": "d_nkechi", "person": "nkechi", "direction": "owes_me", "amount": 35, "name": "Books from Enugu",
     "date": "2026-06-12"},
    {"key": "d_tunde", "person": "tunde", "direction": "owes_me", "amount": 22, "name": "Society jersey",
     "date": "2026-08-31"},
]

LOCKER = [
    {"key": "uni_login", "name": "University login", "type": "login", "username": "a.nwosu@manchester.ac.uk",
     "url": "https://my.manchester.ac.uk", "password": "Perovskite-17!", "starred": True},
    {"key": "zotero_login", "name": "Zotero", "type": "login", "username": "amara_n", "url": "https://zotero.org",
     "password": "halide-films-4"},
    {"key": "monzo", "name": "Monzo card", "type": "card", "card_number": "5375 4411 2233 9087", "cvv": "412",
     "starred": True},
    {"key": "gtbank", "name": "GTBank Naira card", "type": "card", "card_number": "5061 2200 7788 1122", "cvv": "905"},
    {"key": "door_code", "name": "House door code", "type": "note", "notes": "back gate 4417"},
    {"key": "brp_id", "name": "BRP number", "type": "identity", "password": "ZX1234567"},
    {"key": "wifi", "name": "House wifi", "type": "wifi", "password": "fallowfield-4-life"},
    {"key": "lab_pc", "name": "Lab PC password", "type": "password", "password": "Glovebox-O2-low"},
    {"key": "cluster_key", "name": "CSF cluster key", "type": "ssh_key",
     "notes": "Computational Shared Facility", "password": "ssh-ed25519 AAAAC3-csf"},
    {"key": "mp_api", "name": "Materials Project API key", "type": "api_credential", "notes": "for DFT lookups",
     "code": "mp-7Hq2-amara"},
    {"key": "passport_l", "name": "Nigerian passport", "type": "passport", "notes": "expires March 2029"},
    {"key": "monzo_acct", "name": "Monzo current account", "type": "bank_account", "notes": "stipend goes here"},
    {"key": "licence", "name": "Nigerian driving licence", "type": "driving_licence", "notes": "FRSC, valid to 2027"},
    {"key": "origin", "name": "OriginPro licence", "type": "software_licence", "code": "ORG-2026-AN-8841"},
    {"key": "crypto", "name": "Binance wallet", "type": "crypto_wallet", "notes": "small USDT from Obinna"},
    {"key": "gym_card", "name": "Sugden gym membership", "type": "membership", "notes": "member 55120", "starred": True},
    {"key": "rsc", "name": "RSC student membership", "type": "membership",
     "notes": "renews January"},
    {"key": "iom3", "name": "IOM3 student membership", "type": "membership", "notes": "renews January"},
    {"key": "tenancy_copy", "name": "Signed tenancy copy", "type": "document", "notes": "same as the PDF"},
    {"key": "old_netflix", "name": "Netflix", "type": "login", "username": "amara.nwosu@gmail.com",
     "password": "nollywood-nights", "trashed": "2026-08-18T10:00"},
]

LINKS = [
    {"from": "abstract", "to": "fatima"},
    {"from": "xrd_book", "to": "raj"},
    {"from": "xrd_book_lukas", "to": "lukas"},
    {"from": "xrd_book_lukas", "to": "raj"},
    {"from": "send_helen", "to": "helen"},
    {"from": "precursors", "to": "sandra"},
    {"from": "glovebox", "to": "sandra"},
    {"from": "broadband", "to": "kasia"},
    {"from": "rota", "to": "priya"},
    {"from": "deposit_form", "to": "gary"},
    {"from": "hall", "to": "chinedu"},
    {"from": "jollof", "to": "chinedu"},
    {"from": "jollof", "to": "ngozi_e"},
    {"from": "logo", "to": "emeka"},
    {"from": "fees", "to": "ngozi_e"},
    {"from": "send_mum", "to": "mum"},
    {"from": "chichi_gift", "to": "chiamaka"},
    {"from": "flights", "to": "obinna"},
    {"from": "aso_ebi", "to": "chiamaka"},
    {"from": "reply_aunty", "to": "aunty_ngozi"},
    {"from": "helen_fb", "to": "helen"},
    {"from": "xrd_notes", "to": "raj"},
    {"from": "xrd_notes", "to": "wei"},
    {"from": "anneal", "to": "wei"},
    {"from": "lisbon_tips", "to": "wei"},
    {"from": "min_aug", "to": "chinedu"},
    {"from": "min_aug", "to": "ngozi_e"},
    {"from": "min_aug", "to": "emeka"},
    {"from": "min_jul", "to": "chinedu"},
    {"from": "gift_ideas", "to": "chiamaka"},
    {"from": "gift_ideas", "to": "mum"},
    {"from": "call_note", "to": "mum"},
    {"from": "wedding_note", "to": "obinna"},
    {"from": "house_rules", "to": "tom_h"},
    {"from": "freshers_note", "to": "seun"},
    {"from": "egusi", "to": "mum"},
]


def world():
    return {
        "me": "Amara Nwosu",
        "epoch": "2024-01-05T09:00",
        "seed": "T13",
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
        if e.get("trashed"):
            continue
        s = datetime.fromisoformat(e["start"])
        f = datetime.fromisoformat(e["end"]) if e.get("end") else (
            s + timedelta(hours=1) if "T" in e["start"] else s + timedelta(days=1))
        if "T" not in e["start"] and e.get("end") and "T" not in e["end"]:
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
    allkeys = [r["key"] for sec in ("people", "groups", "lists", "events", "tasks", "notebooks", "notes", "folders",
                                    "documents", "albums", "photos", "debts", "locker") for r in w[sec]]
    dup = {k for k in allkeys if allkeys.count(k) > 1}
    assert not dup, dup
    out = HERE / "T13.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
