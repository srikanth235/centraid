"""World T19: Fatima Al-Sayed, pharmacist in Casablanca (MAD vault).

    python3 authored/worlds/T19_build.py      # writes authored/worlds/T19.json (deterministic)

Today in the sessions is Tuesday 2026-04-14 20:40. Fatima runs a neighbourhood pharmacy in
Maarif, is married to Youssef, has two young kids (Adam, 7, and Lina, 4), and looks after her
father Hassan ("Baba"), who has type 2 diabetes. She shares Baba's costs with her brother Omar and
sister Salma, keeps the pharmacy coffee fund, and splits the school run with three other parents.
Built-in ambiguity: two Youssefs (husband, wholesaler rep), two Samiras (school run parents),
nicknames (Baba, Hajja, Simo, Lilou, Dada), a misspelled-looking name (Mouhcine), two
endocrinologist appointments for Baba, two dentist appointments, two nurse visits, a recurring
wholesaler order and monthly bills (near-duplicate tasks), two "Fuel for the school run" debts,
two wifi locker items, cancelled events, completed tasks, rows trashed inside and past the 30-day
restore window, an empty group, an empty folder, an empty notebook and an empty list.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        # family
        {"key": "youssef_a", "name": "Youssef El Amrani", "role": "husband", "starred": True, "cadence": 1,
         "met": "university in Rabat", "last_contacted": "2026-04-14T19:00", "last_contacted_kind": "visit"},
        {"key": "adam", "name": "Adam El Amrani", "role": "son, 7, CE1"},
        {"key": "lina", "name": "Lina El Amrani", "role": "daughter, 4", "nickname": "Lilou"},
        {"key": "baba", "name": "Hassan Al-Sayed", "role": "father, type 2 diabetes", "nickname": "Baba",
         "starred": True, "cadence": 2, "last_contacted": "2026-04-13T18:30", "last_contacted_kind": "visit"},
        {"key": "omar", "name": "Omar Al-Sayed", "role": "brother, Rabat", "cadence": 7,
         "last_contacted": "2026-04-10T21:00", "last_contacted_kind": "call"},
        {"key": "salma", "name": "Salma Al-Sayed", "role": "sister, Tangier", "cadence": 14, "starred": True,
         "last_contacted": "2026-04-11T12:00", "last_contacted_kind": "visit"},
        {"key": "zineb", "name": "Zineb El Amrani", "role": "mother-in-law", "nickname": "Hajja", "cadence": 7,
         "last_contacted": "2026-04-05T17:00", "last_contacted_kind": "visit"},
        {"key": "simo", "name": "Mohamed Tahiri", "role": "cousin", "nickname": "Simo", "cadence": 30,
         "last_contacted": "2026-03-20T15:00", "last_contacted_kind": "visit"},
        {"key": "dada", "name": "Fatiha Ait Taleb", "role": "nanny", "nickname": "Dada", "cadence": 1,
         "last_contacted": "2026-04-14T18:00", "last_contacted_kind": "visit"},
        # pharmacy
        {"key": "nadia", "name": "Nadia Tazi", "role": "assistant pharmacist", "cadence": 3,
         "last_contacted": "2026-04-14T13:00", "last_contacted_kind": "meeting"},
        {"key": "rachid", "name": "Rachid Benjelloun", "role": "pharmacy technician", "cadence": 7,
         "last_contacted": "2026-04-13T17:00", "last_contacted_kind": "meeting"},
        {"key": "imane", "name": "Imane Chraibi", "role": "cashier"},
        {"key": "hamza", "name": "Hamza Idrissi", "role": "delivery driver", "last_contacted": "2026-04-09T10:00",
         "last_contacted_kind": "call"},
        {"key": "kenza", "name": "Kenza Alami", "role": "night duty pharmacist", "cadence": 14,
         "last_contacted": "2026-04-04T20:00", "last_contacted_kind": "meeting"},
        {"key": "youssef_b", "name": "Youssef Berrada", "role": "wholesaler rep", "cadence": 14,
         "last_contacted": "2026-04-08T11:00", "last_contacted_kind": "call"},
        {"key": "mouhcine", "name": "Mouhcine Zerouali", "role": "accountant", "cadence": 30,
         "last_contacted": "2026-03-16T10:00", "last_contacted_kind": "call"},
        {"key": "abdelilah", "name": "Abdelilah Moussaoui", "role": "landlord of the pharmacy"},
        # doctors
        {"key": "dr_fassi", "name": "Leila Fassi", "role": "endocrinologist, Baba's doctor",
         "last_contacted": "2026-03-10T10:45", "last_contacted_kind": "meeting"},
        {"key": "dr_kettani", "name": "Mehdi Kettani", "role": "paediatrician"},
        {"key": "dr_bennis", "name": "Amina Bennis", "role": "dentist"},
        # school run and school
        {"key": "samira_b", "name": "Samira Bennani", "role": "school run parent, Rayan's mum", "cadence": 7,
         "last_contacted": "2026-04-14T08:10", "last_contacted_kind": "message"},
        {"key": "samira_a", "name": "Samira Alaoui", "role": "school run parent, Ines's mum",
         "last_contacted": "2026-04-07T08:10", "last_contacted_kind": "message"},
        {"key": "driss", "name": "Driss Lahlou", "role": "school run parent", "cadence": 7,
         "last_contacted": "2026-04-02T08:00", "last_contacted_kind": "message"},
        {"key": "meriem", "name": "Meriem Ouazzani", "role": "class mum, Lina's kindergarten"},
        {"key": "hakima", "name": "Hakima Sefrioui", "role": "Adam's teacher"},
        # others
        {"key": "khalid", "name": "Khalid Mansouri", "role": "plumber", "last_contacted": "2026-04-13T08:30",
         "last_contacted_kind": "call"},
        {"key": "aicha", "name": "Aicha Bouzid", "role": "Baba's neighbour", "cadence": 7,
         "last_contacted": "2026-04-12T19:00", "last_contacted_kind": "call"},
        {"key": "rkia", "name": "Rkia Naciri", "role": "home nurse"},
        # trashed: two inside the 30-day window, one past it
        {"key": "tarik", "name": "Tarik Filali", "role": "old wholesaler rep", "trashed": "2026-04-02T10:00"},
        {"key": "sanae", "name": "Sanae Kabbaj", "role": "ex intern", "trashed": "2026-03-28T09:00"},
        {"key": "jamal", "name": "Jamal Ziani", "role": "old landlord", "trashed": "2026-02-10T10:00"},
    ]


GROUPS = [
    {"key": "coffee", "name": "Pharmacy coffee fund", "members": ["nadia", "rachid", "imane", "kenza"],
     "created": "2025-09-01T09:00"},
    {"key": "baba_care", "name": "Baba's care", "members": ["omar", "salma"], "created": "2025-06-01T10:00"},
    {"key": "school_run", "name": "School run fuel", "members": ["samira_b", "samira_a", "driss"],
     "created": "2025-09-10T08:00"},
    {"key": "ifrane", "name": "Ifrane weekend", "members": ["omar", "simo", "youssef_a"],
     "created": "2026-03-30T21:00"},
    {"key": "madrid", "name": "Madrid with Salma", "currency": "EUR", "members": ["salma"],
     "created": "2026-01-20T20:00"},
    {"key": "eid_sheep", "name": "Eid sheep", "members": ["omar", "simo"], "created": "2026-04-12T20:00"},
]

EXPENSES = [
    {"group": "coffee", "name": "Coffee capsules", "amount": 240, "paid_by": "me",
     "split": ["me", "nadia", "rachid", "imane"], "date": "2026-04-01"},
    {"group": "coffee", "name": "Sugar and mint tea", "amount": 100, "paid_by": "nadia",
     "split": ["me", "nadia", "rachid", "imane", "kenza"], "date": "2026-04-08"},
    {"group": "baba_care", "name": "Insulin pens April", "amount": 900, "paid_by": "me",
     "split": ["me", "omar", "salma"], "date": "2026-04-03"},
    {"group": "baba_care", "name": "Glucose strips", "amount": 330, "paid_by": "omar",
     "split": ["me", "omar", "salma"], "date": "2026-04-09"},
    {"group": "baba_care", "name": "Nurse home visits March", "amount": 1200, "paid_by": "salma",
     "split": ["me", "omar", "salma"], "date": "2026-03-31"},
    {"group": "school_run", "name": "Fuel March", "amount": 600, "paid_by": "driss",
     "split": ["me", "samira_b", "samira_a", "driss"], "date": "2026-03-31"},
    {"group": "ifrane", "name": "Chalet deposit", "amount": 1500, "paid_by": "simo",
     "split": ["me", "omar", "simo"], "date": "2026-04-05"},
    {"group": "madrid", "name": "Hotel in Madrid", "amount": 300, "paid_by": "salma",
     "split": ["me", "salma"], "date": "2026-02-20", "currency": "EUR"},
]

LISTS = [
    {"key": "pharm_l", "name": "Pharmacy", "area": "work"},
    {"key": "baba_l", "name": "Baba", "area": "health"},
    {"key": "kids_l", "name": "Kids", "area": "family"},
    {"key": "home_l", "name": "Home", "area": "family"},
    {"key": "shop_l", "name": "Shopping"},
    {"key": "summer_l", "name": "Summer holiday", "area": "family"},
]


def events():
    out = []
    # my turns on the school run: Tuesdays and Thursdays
    d = date(2026, 3, 17)
    while d <= date(2026, 5, 14):
        if d.weekday() in (1, 3):
            ev = {"key": f"run_{d.strftime('%m%d')}", "name": "School run", "start": f"{d}T07:40",
                  "end": f"{d}T08:10", "attendees": ["adam"], "description": "Ecole Al Wafa"}
            if d == date(2026, 4, 2):
                ev["cancelled"] = "2026-03-30T20:00"
            out.append(ev)
        d += timedelta(days=1)
    # night duty every other Saturday
    d = date(2026, 3, 7)
    while d <= date(2026, 5, 30):
        ev = {"key": f"garde_{d.strftime('%m%d')}", "name": "Night duty at the pharmacy", "start": f"{d}T20:00",
              "end": f"{d + timedelta(days=1)}T08:00", "attendees": ["kenza"], "description": "pharmacy"}
        out.append(ev)
        d += timedelta(weeks=2)
    # Adam's swimming, Wednesdays
    d = date(2026, 3, 25)
    while d <= date(2026, 5, 13):
        out.append({"key": f"swim_{d.strftime('%m%d')}", "name": "Adam's swimming lesson", "start": f"{d}T18:00",
                    "end": f"{d}T18:45", "attendees": ["adam"], "description": "Piscine Anfa"})
        d += timedelta(weeks=1)
    # staff meeting, first Monday
    for d in ("2026-03-02", "2026-04-06", "2026-05-04"):
        out.append({"key": f"staff_{d[5:7]}", "name": "Pharmacy staff meeting", "start": f"{d}T13:30",
                    "end": f"{d}T14:00", "attendees": ["nadia", "rachid", "imane"], "description": "pharmacy"})
    out += [
        # Baba
        {"key": "endo_mar", "name": "Endocrinologist for Baba", "start": "2026-03-10T10:00", "end": "2026-03-10T10:45",
         "attendees": ["baba", "dr_fassi"], "description": "Clinique Badr"},
        {"key": "endo_may", "name": "Endocrinologist for Baba", "start": "2026-05-12T10:00", "end": "2026-05-12T10:45",
         "attendees": ["baba", "dr_fassi"], "description": "Clinique Badr"},
        {"key": "hba1c", "name": "Baba's HbA1c blood test", "start": "2026-04-21T08:30", "end": "2026-04-21T09:00",
         "attendees": ["baba"], "description": "Labo Anfa"},
        {"key": "eye_exam", "name": "Baba's eye exam", "start": "2026-04-28T15:00", "end": "2026-04-28T16:00",
         "attendees": ["baba"], "description": "Clinique Badr"},
        {"key": "podiatrist", "name": "Podiatrist for Baba", "start": "2026-04-17T17:00", "end": "2026-04-17T17:30",
         "attendees": ["baba"], "description": "Maarif"},
        {"key": "nurse_1", "name": "Nurse visit for Baba", "start": "2026-04-20T18:00", "end": "2026-04-20T18:30",
         "attendees": ["baba", "rkia"]},
        {"key": "nurse_2", "name": "Nurse visit for Baba", "start": "2026-04-27T18:00", "end": "2026-04-27T18:30",
         "attendees": ["baba", "rkia"]},
        # kids
        {"key": "lina_vacc", "name": "Lina's vaccine", "start": "2026-04-15T16:00", "end": "2026-04-15T16:20",
         "attendees": ["lina", "dr_kettani"], "description": "Dr Kettani's clinic"},
        {"key": "adam_checkup", "name": "Adam's check-up with Dr Kettani", "start": "2026-04-22T17:30",
         "end": "2026-04-22T18:00", "attendees": ["adam", "dr_kettani"], "description": "Dr Kettani's clinic"},
        {"key": "dentist_adam", "name": "Dentist for Adam", "start": "2026-04-24T18:00", "end": "2026-04-24T18:30",
         "attendees": ["adam", "dr_bennis"]},
        {"key": "dentist_me", "name": "Dentist for me", "start": "2026-05-07T18:30", "end": "2026-05-07T19:15",
         "attendees": ["dr_bennis"]},
        {"key": "ptm", "name": "Parent-teacher meeting", "start": "2026-04-16T17:00", "end": "2026-04-16T17:45",
         "attendees": ["hakima", "youssef_a"], "description": "Ecole Al Wafa"},
        {"key": "school_show", "name": "Adam's school show", "start": "2026-05-29T15:00", "end": "2026-05-29T16:30",
         "attendees": ["adam", "youssef_a"], "description": "Ecole Al Wafa"},
        {"key": "lina_party", "name": "Lina's birthday party", "start": "2026-04-26T16:00", "end": "2026-04-26T19:00",
         "attendees": ["lina", "adam", "youssef_a", "zineb", "meriem"]},
        {"key": "swim_gala", "name": "Adam's swimming gala", "start": "2026-03-28T10:00", "end": "2026-03-28T11:30",
         "attendees": ["adam"], "description": "Piscine Anfa"},
        # pharmacy
        {"key": "berrada_meet", "name": "Meeting with Youssef Berrada", "start": "2026-04-15T11:00",
         "end": "2026-04-15T11:30", "attendees": ["youssef_b"], "description": "new diabetes range, samples"},
        {"key": "stock_count", "name": "Quarterly stock count", "start": "2026-04-18T13:00", "end": "2026-04-18T17:00",
         "attendees": ["nadia", "rachid"], "description": "pharmacy"},
        {"key": "council", "name": "Pharmacists' council meeting", "start": "2026-04-23T19:00",
         "end": "2026-04-23T21:00", "description": "Ordre des pharmaciens, Casablanca"},
        {"key": "vacc_training", "name": "Vaccination training", "start": "2026-05-09T09:00", "end": "2026-05-09T12:00",
         "attendees": ["nadia"]},
        {"key": "accountant", "name": "Taxes with Mouhcine", "start": "2026-04-20T12:30", "end": "2026-04-20T13:30",
         "attendees": ["mouhcine"]},
        {"key": "plumber_pharm", "name": "Plumber at the pharmacy", "start": "2026-04-13T08:00",
         "end": "2026-04-13T09:00", "attendees": ["khalid"], "description": "pharmacy"},
        # family
        {"key": "dinner_hajja", "name": "Dinner at Hajja's", "start": "2026-04-17T20:00", "end": "2026-04-17T22:30",
         "attendees": ["zineb", "youssef_a"]},
        {"key": "omar_visit", "name": "Omar visiting from Rabat", "start": "2026-04-25T12:00",
         "end": "2026-04-25T18:00", "attendees": ["omar", "baba"]},
        {"key": "ifrane_ev", "name": "Ifrane weekend", "start": "2026-05-22T09:00", "end": "2026-05-22T18:00",
         "attendees": ["omar", "simo", "youssef_a"], "description": "chalet near the lake"},
        {"key": "eid_adha", "name": "Eid al-Adha at Baba's", "start": "2026-05-27T10:00", "end": "2026-05-27T20:00",
         "attendees": ["baba", "omar", "salma"]},
        {"key": "anniversary", "name": "Anniversary dinner", "start": "2026-04-10T20:30", "end": "2026-04-10T23:00",
         "attendees": ["youssef_a"]},
        {"key": "hammam", "name": "Hammam with Salma", "start": "2026-04-11T10:00", "end": "2026-04-11T12:00",
         "attendees": ["salma"]},
        {"key": "eid_fitr", "name": "Eid al-Fitr lunch", "start": "2026-03-20T13:00", "end": "2026-03-20T16:00",
         "attendees": ["baba", "omar", "salma", "simo"]},
        {"key": "yoga", "name": "Yoga class", "start": "2026-04-16T19:00", "end": "2026-04-16T20:00",
         "cancelled": "2026-04-13T12:00"},
        {"key": "kenza_lunch", "name": "Lunch with Kenza", "start": "2026-04-08T13:00", "end": "2026-04-08T14:00",
         "attendees": ["kenza"], "cancelled": "2026-04-07T18:00"},
        {"key": "car_service", "name": "Car service", "start": "2026-04-09T09:00", "end": "2026-04-09T11:00",
         "trashed": "2026-04-07T09:00"},
    ]
    return out


def tasks():
    t = [
        # Baba
        {"key": "insulin", "name": "Pick up Baba's insulin pens", "due": "2026-04-16", "priority": 1, "effort": 20,
         "list": "baba_l"},
        {"key": "strips", "name": "Order glucose test strips", "due": "2026-04-15", "effort": 10, "list": "baba_l"},
        {"key": "battery", "name": "Replace Baba's glucometer battery", "due": "2026-04-05",
         "completed": "2026-04-05T19:00", "list": "baba_l"},
        {"key": "glucose_log_t", "name": "Update Baba's glucose log", "status": "in_progress", "list": "baba_l",
         "description": "readings since the 1st, for Dr Fassi"},
        {"key": "shoes", "name": "Buy diabetic shoes for Baba", "due": "2026-04-30", "priority": 3, "effort": 60,
         "list": "baba_l"},
        {"key": "reimburse", "name": "File Baba's CNSS reimbursement", "due": "2026-04-20", "priority": 2,
         "effort": 45, "list": "baba_l", "description": "prescriptions from March"},
        {"key": "photocopy", "name": "Photocopy the prescriptions", "parent": "reimburse", "due": "2026-04-17",
         "effort": 15},
        {"key": "stamp", "name": "Get Dr Fassi's stamp", "parent": "reimburse", "due": "2026-04-19"},
        {"key": "meal_plan", "name": "Print low-sugar meal plan", "due": "2026-03-15", "completed": "2026-03-14T21:00",
         "list": "baba_l"},
        # pharmacy
        {"key": "expiry", "name": "Check expiry dates on shelf B", "due": "2026-04-18", "effort": 60,
         "list": "pharm_l", "description": "syrups and eye drops"},
        {"key": "rota", "name": "Make the May staff rota", "due": "2026-04-25", "priority": 2, "effort": 45,
         "list": "pharm_l"},
        {"key": "count_sheets", "name": "Prepare stock count sheets", "due": "2026-04-17T12:00", "effort": 90,
         "list": "pharm_l"},
        {"key": "cnss_claims", "name": "Send CNSS claims batch", "due": "2026-04-15T17:00", "priority": 1, "effort": 60,
         "list": "pharm_l"},
        {"key": "fridge_log", "name": "Log vaccine fridge temperature", "status": "in_progress", "list": "pharm_l",
         "description": "twice a day, sheet on the fridge door"},
        {"key": "terminal", "name": "Fix the card terminal", "due": "2026-04-08", "completed": "2026-04-08T15:00",
         "list": "pharm_l"},
        {"key": "insurance_ph", "name": "Renew pharmacy insurance", "due": "2026-05-15", "priority": 2,
         "list": "pharm_l"},
        {"key": "scooter", "name": "Service the delivery scooter", "due": "2026-04-22", "effort": 45, "list": "pharm_l"},
        {"key": "invoices", "name": "Send invoices to Mouhcine", "due": "2026-04-18", "effort": 30, "list": "pharm_l"},
        {"key": "leave", "name": "Approve Nadia's leave", "due": "2026-04-16", "effort": 5},
        {"key": "samples", "name": "Return expired samples to the wholesaler", "status": "cancelled",
         "list": "pharm_l"},
        # kids
        {"key": "goggles", "name": "Buy Adam's swimming goggles", "due": "2026-04-15", "effort": 15, "list": "shop_l"},
        {"key": "party_plan", "name": "Plan Lina's birthday party", "due": "2026-04-26", "status": "in_progress",
         "priority": 2, "list": "kids_l", "description": "cake from Amoud, balloons, 12 kids"},
        {"key": "cake", "name": "Order the cake", "parent": "party_plan", "due": "2026-04-24", "effort": 20},
        {"key": "invites", "name": "Invite the class", "parent": "party_plan", "due": "2026-04-19", "effort": 30},
        {"key": "homework", "name": "Sign Adam's homework book", "due": "2026-04-15", "effort": 5, "list": "kids_l"},
        {"key": "fees", "name": "Pay school fees for term 3", "due": "2026-04-20", "priority": 1, "list": "kids_l"},
        {"key": "trip_pay", "name": "Pay for Adam's school trip", "due": "2026-04-03",
         "completed": "2026-04-02T20:00", "list": "kids_l"},
        {"key": "lina_forms", "name": "Fill Lina's kindergarten forms", "due": "2026-05-05", "effort": 30,
         "list": "kids_l"},
        {"key": "rota_mail", "name": "Send the school run rota for May", "due": "2026-04-24T20:00", "effort": 15,
         "list": "kids_l"},
        # home
        {"key": "sink", "name": "Call the plumber about the kitchen sink", "due": "2026-04-14", "list": "home_l"},
        {"key": "gas", "name": "Swap the gas bottle", "due": "2026-04-16", "effort": 10, "list": "home_l"},
        {"key": "car_ins", "name": "Car insurance renewal", "due": "2026-05-02", "priority": 2, "list": "home_l"},
        {"key": "passport", "name": "Renew my passport", "due": "2026-06-30", "priority": 3, "effort": 120},
        {"key": "hajja_gift", "name": "Buy a gift for Hajja", "due": "2026-04-17", "list": "shop_l"},
        {"key": "sheep", "name": "Reserve the Eid sheep", "due": "2026-05-10", "priority": 2},
        {"key": "riad", "name": "Book the Marrakech riad", "status": "cancelled"},
        {"key": "balcony", "name": "Fix the balcony door", "list": "home_l", "trashed": "2026-04-05T10:00"},
        {"key": "mop", "name": "Buy a new mop", "list": "shop_l", "trashed": "2026-02-01T10:00"},
    ]
    # the weekly wholesaler order, Thursdays
    for d in ("2026-03-19", "2026-03-26", "2026-04-02", "2026-04-09"):
        t.append({"key": f"order_{d[5:7]}{d[8:]}", "name": "Weekly wholesaler order", "due": d,
                  "completed": f"{d}T12:00", "effort": 20, "list": "pharm_l"})
    t.append({"key": "order_0416", "name": "Weekly wholesaler order", "due": "2026-04-16", "effort": 20,
              "list": "pharm_l"})
    # pharmacy rent, on the 1st
    for m in (1, 2, 3, 4):
        t.append({"key": f"rent_{m:02d}", "name": "Pay the pharmacy rent", "due": f"2026-{m:02d}-01",
                  "completed": f"2026-{m:02d}-01T10:00", "list": "pharm_l"})
    t.append({"key": "rent_05", "name": "Pay the pharmacy rent", "due": "2026-05-01", "list": "pharm_l"})
    # electricity and water, on the 10th
    for m in (1, 2, 3, 4):
        t.append({"key": f"lydec_{m:02d}", "name": "Pay the Lydec bill", "due": f"2026-{m:02d}-10",
                  "completed": f"2026-{m:02d}-09T21:00", "list": "home_l"})
    t.append({"key": "lydec_05", "name": "Pay the Lydec bill", "due": "2026-05-10", "list": "home_l"})
    return t


NOTEBOOKS = [
    {"key": "nb_baba", "name": "Baba's health"},
    {"key": "nb_pharm", "name": "Pharmacy"},
    {"key": "nb_recipes", "name": "Recipes"},
    {"key": "nb_school", "name": "School"},
    {"key": "nb_ramadan", "name": "Ramadan 2025"},
    {"key": "nb_old", "name": "Old ideas"},
]

NOTES = [
    {"key": "readings", "name": "Glucose readings April", "body": "fasting 1.32, 1.28, 1.45 after couscous on Friday",
     "notebook": "nb_baba", "created": "2026-04-01T08:00", "pinned": True},
    {"key": "meds", "name": "Baba's medication", "body": "Metformin 850 twice a day, Lantus 18 units at night",
     "notebook": "nb_baba", "created": "2026-03-10T11:30", "pinned": True},
    {"key": "fassi_advice", "name": "Dr Fassi's advice", "body": "less bread at dinner, walk 30 min after lunch",
     "notebook": "nb_baba", "created": "2026-03-10T11:00"},
    {"key": "hypo", "name": "Hypo signs", "body": "sweating, shaking: 3 sugar cubes, recheck after 15 min",
     "notebook": "nb_baba", "created": "2026-02-20T21:00"},
    {"key": "prices", "name": "Wholesaler prices", "body": "strips 165 a box, lancets 40, pen needles 90",
     "notebook": "nb_pharm", "created": "2026-04-08T14:00"},
    {"key": "garde_check", "name": "Night duty checklist", "body": "cash float, fridge check, guard's number",
     "notebook": "nb_pharm", "created": "2026-03-01T19:00", "pinned": True},
    {"key": "staff_apr", "name": "Staff meeting April", "body": "Imane on mornings, Rachid learns the new software",
     "notebook": "nb_pharm", "created": "2026-04-06T14:00"},
    {"key": "generics", "name": "Generics to push", "body": "metformin, amlodipine, omeprazole",
     "notebook": "nb_pharm", "created": "2026-04-13T18:00"},
    {"key": "fridge_note", "name": "Vaccine fridge log", "body": "4.2 at 9am, 4.8 at 6pm", "notebook": "nb_pharm",
     "created": "2026-04-14T09:00"},
    {"key": "harira", "name": "Harira", "body": "lentils, chickpeas, tomato, a spoon of flour at the end",
     "notebook": "nb_recipes", "created": "2025-03-02T17:00"},
    {"key": "msemen", "name": "Msemen", "body": "semolina and flour, fold four times", "notebook": "nb_recipes",
     "created": "2025-11-15T10:00"},
    {"key": "low_sugar", "name": "Low-sugar desserts for Baba", "body": "baked apple with cinnamon, yoghurt and nuts",
     "notebook": "nb_recipes", "created": "2026-04-12T21:00"},
    {"key": "rota_note", "name": "School run rota", "body": "me Tue and Thu, Samira B Mon, Driss Wed, Samira A Fri",
     "notebook": "nb_school", "created": "2026-03-15T20:00"},
    {"key": "teacher_notes", "name": "Notes from Mme Sefrioui", "body": "Adam reads well, needs work on subtraction",
     "notebook": "nb_school", "created": "2026-04-09T18:30"},
    {"key": "old_idea", "name": "Home delivery app idea", "body": "whatsapp orders for regulars",
     "notebook": "nb_old", "created": "2025-06-01T22:00"},
    {"key": "lina_words", "name": "Lina's funny words", "body": "'bibiotek' for library, 'mamaleh' for grandma",
     "created": "2026-04-05T20:00"},
    {"key": "gift_ideas", "name": "Gift ideas", "body": "Youssef: a watch; Hajja: a prayer rug",
     "created": "2026-04-11T22:00"},
    {"key": "ifrane_plan", "name": "Ifrane plan", "body": "leave Friday 7am, chalet by the lake, bring chains",
     "created": "2026-04-07T21:00"},
    {"key": "books", "name": "Books to read", "body": "Leila Slimani, Tahar Ben Jelloun", "created": "2025-11-01T21:00"},
    {"key": "car_note", "name": "Car service notes", "body": "oil change at 60000 km, front tyres worn",
     "created": "2026-03-25T12:30"},
    {"key": "old_garde", "name": "Old night duty schedule", "body": "2025 rota with Tarik", "notebook": "nb_pharm",
     "created": "2025-09-01T10:00", "trashed": "2026-04-03T10:00"},
    {"key": "ramadan_menu", "name": "Ramadan menu", "body": "chebakia, sellou, harira every night",
     "created": "2025-03-01T10:00", "trashed": "2026-02-15T10:00"},
    {"key": "old_rota", "name": "Old school rota 2025", "body": "with Driss and Meriem", "created": "2025-09-05T10:00",
     "trashed": "2026-01-20T10:00"},
]

FOLDERS = [
    {"key": "f_pharm", "name": "Pharmacy papers"},
    {"key": "f_baba", "name": "Baba medical"},
    {"key": "f_kids", "name": "Kids school"},
    {"key": "f_home", "name": "Home papers"},
    {"key": "f_car", "name": "Car"},
    {"key": "f_tax", "name": "Taxes 2025"},
]

DOCUMENTS = [
    {"key": "licence_doc", "name": "Pharmacy licence", "folder": "f_pharm", "starred": True,
     "created": "2019-06-01T10:00"},
    {"key": "lease", "name": "Pharmacy lease", "folder": "f_pharm", "created": "2022-01-10T10:00"},
    {"key": "cnss_mar", "name": "CNSS statement March", "folder": "f_pharm", "created": "2026-04-02T10:00"},
    {"key": "cnss_feb", "name": "CNSS statement February", "folder": "f_pharm", "created": "2026-03-03T10:00"},
    {"key": "invoice_apr", "name": "Wholesaler invoice April", "folder": "f_pharm", "created": "2026-04-10T16:00"},
    {"key": "prescription", "name": "Baba's prescription", "folder": "f_baba", "starred": True,
     "created": "2026-03-10T12:00"},
    {"key": "labs", "name": "Baba's lab results March", "folder": "f_baba", "created": "2026-03-12T09:00"},
    {"key": "cnss_card", "name": "Baba's CNSS card", "folder": "f_baba", "created": "2025-09-01T10:00"},
    {"key": "report_card", "name": "Adam's report card", "folder": "f_kids", "created": "2026-03-27T17:00"},
    {"key": "vacc_card", "name": "Lina's vaccination card", "folder": "f_kids", "created": "2025-10-01T10:00"},
    {"key": "fees_invoice", "name": "School fees invoice term 3", "folder": "f_kids", "created": "2026-04-13T12:00"},
    {"key": "marriage", "name": "Marriage certificate", "folder": "f_home", "starred": True,
     "created": "2017-07-15T10:00"},
    {"key": "rental", "name": "Home rental contract", "folder": "f_home", "created": "2024-09-01T10:00"},
    {"key": "car_ins_doc", "name": "Car insurance 2025", "folder": "f_car", "created": "2025-05-02T10:00"},
    {"key": "carte_grise", "name": "Car registration", "folder": "f_car", "created": "2023-03-01T10:00"},
    {"key": "scan_41", "name": "Scan 0041", "created": "2026-04-14T13:05"},
    {"key": "scan_42", "name": "Scan 0042", "created": "2026-04-11T10:00"},
    {"key": "bus_tickets", "name": "CTM bus tickets", "created": "2026-04-09T20:00"},
    {"key": "lease_draft", "name": "Old lease draft", "folder": "f_pharm", "created": "2021-11-01T10:00",
     "trashed": "2026-04-01T10:00"},
]

ALBUMS = [
    {"key": "a_kids", "name": "Kids"},
    {"key": "a_family", "name": "Family"},
    {"key": "a_pharm", "name": "Pharmacy"},
    {"key": "a_eid", "name": "Eid al-Fitr 2026"},
    {"key": "a_beach", "name": "Ain Diab beach"},
]

PHOTOS = [
    {"key": "eid_table", "name": "Eid lunch table", "taken": "2026-03-20T13:30", "albums": ["a_eid", "a_family"],
     "people": ["baba", "omar", "salma"]},
    {"key": "eid_kids", "name": "Kids in Eid clothes", "taken": "2026-03-20T11:00", "albums": ["a_eid", "a_kids"],
     "people": ["adam", "lina"], "starred": True},
    {"key": "eid_baba", "name": "Baba with the kids", "taken": "2026-03-20T15:00", "albums": ["a_eid", "a_family"],
     "people": ["baba", "adam", "lina"], "starred": True},
    {"key": "eid_selfie", "name": "Eid selfie", "taken": "2026-03-20T16:00", "albums": ["a_eid"],
     "people": ["youssef_a", "salma"]},
    {"key": "sunset", "name": "Ain Diab sunset", "taken": "2026-04-05T19:30", "albums": ["a_beach"], "starred": True},
    {"key": "sandcastle", "name": "Adam building a sandcastle", "taken": "2026-04-05T17:00",
     "albums": ["a_beach", "a_kids"], "people": ["adam"]},
    {"key": "corniche", "name": "Lina on the corniche", "taken": "2026-04-05T18:00", "albums": ["a_beach", "a_kids"],
     "people": ["lina"]},
    {"key": "medal", "name": "Swimming gala medal", "taken": "2026-03-28T11:30", "albums": ["a_kids"],
     "people": ["adam"]},
    {"key": "drawing", "name": "Lina's drawing", "taken": "2026-04-12T10:00", "albums": ["a_kids"]},
    {"key": "tooth", "name": "Adam's lost tooth", "taken": "2026-04-08T20:00", "albums": ["a_kids"],
     "people": ["adam"]},
    {"key": "sign", "name": "New pharmacy sign", "taken": "2026-02-10T10:00", "albums": ["a_pharm"], "starred": True},
    {"key": "team", "name": "Team at the pharmacy", "taken": "2026-03-02T14:00", "albums": ["a_pharm"],
     "people": ["nadia", "rachid", "imane", "kenza"]},
    {"key": "shelf_before", "name": "Shelf B before the reorg", "taken": "2026-04-11T09:00", "albums": ["a_pharm"]},
    {"key": "shelf_after", "name": "Shelf B after the reorg", "taken": "2026-04-11T16:00", "albums": ["a_pharm"]},
    {"key": "fridge_p", "name": "Vaccine fridge", "taken": "2026-04-14T09:05", "albums": ["a_pharm"]},
    {"key": "anniv_p", "name": "Anniversary dinner", "taken": "2026-04-10T21:00", "albums": ["a_family"],
     "people": ["youssef_a"], "starred": True},
    {"key": "tangier", "name": "Salma in Tangier", "taken": "2026-01-15T12:00", "people": ["salma"]},
    {"key": "garden", "name": "Hajja's garden", "taken": "2026-04-03T17:00", "albums": ["a_family"],
     "people": ["zineb"]},
    {"key": "baba_walk", "name": "Baba's walk in the park", "taken": "2026-04-12T18:00", "albums": ["a_family"],
     "people": ["baba"]},
    {"key": "meter", "name": "Glucometer reading", "taken": "2026-04-13T07:30", "people": ["baba"]},
    {"key": "receipt", "name": "Receipt from the wholesaler", "taken": "2026-04-10T16:30"},
    {"key": "rx_photo", "name": "Photo of Baba's prescription", "taken": "2026-03-10T12:10"},
    {"key": "whiteboard", "name": "Staff rota whiteboard", "taken": "2026-04-06T13:45"},
    {"key": "menu", "name": "School canteen menu", "taken": "2026-04-13T08:00"},
    {"key": "rain", "name": "Rain on the boulevard", "taken": "2026-04-09T19:00"},
    {"key": "dent", "name": "Dent on the car", "taken": "2026-03-25T12:00"},
    {"key": "bike", "name": "Adam's new bike", "taken": "2026-02-15T11:00", "albums": ["a_kids"], "people": ["adam"]},
    {"key": "cake_2025", "name": "Lina's cake last year", "taken": "2025-04-26T17:00", "albums": ["a_kids"],
     "people": ["lina"]},
    {"key": "snow", "name": "Ifrane in the snow", "taken": "2025-12-28T12:00", "albums": ["a_family"],
     "people": ["youssef_a", "adam", "lina"]},
    {"key": "blurry", "name": "Blurry sunset", "taken": "2026-04-05T19:31", "trashed": "2026-04-06T09:00"},
    {"key": "dup_receipt", "name": "Duplicate receipt", "taken": "2026-04-10T16:31", "trashed": "2026-04-11T09:00"},
    {"key": "screenshot", "name": "Old screenshot", "taken": "2025-12-01T10:00", "trashed": "2026-01-05T10:00"},
]

DEBTS = [
    {"key": "d_omar", "person": "omar", "direction": "owes_me", "amount": 1200, "name": "Baba's new glucometer",
     "date": "2026-04-02"},
    {"key": "d_salma", "person": "salma", "direction": "owes_me", "amount": 800, "name": "Share of the insulin",
     "date": "2026-04-10"},
    {"key": "d_simo", "person": "simo", "direction": "i_owe", "amount": 500, "name": "Taxi money in Ifrane",
     "date": "2025-12-29", "settled": "2026-01-15T10:00"},
    {"key": "d_nadia", "person": "nadia", "direction": "i_owe", "amount": 150, "name": "Lunch from the snack bar",
     "date": "2026-04-13"},
    {"key": "d_kenza", "person": "kenza", "direction": "owes_me", "amount": 300, "name": "Night duty dinner",
     "date": "2026-04-04"},
    {"key": "d_samira", "person": "samira_b", "direction": "i_owe", "amount": 200, "name": "Fuel for the school run",
     "date": "2026-04-07"},
    {"key": "d_driss", "person": "driss", "direction": "owes_me", "amount": 200, "name": "Fuel for the school run",
     "date": "2026-03-31"},
    {"key": "d_hamza", "person": "hamza", "direction": "owes_me", "amount": 400, "name": "Advance on salary",
     "date": "2026-04-01"},
    {"key": "d_youssef", "person": "youssef_a", "direction": "i_owe", "amount": 1000,
     "name": "Cash for the pharmacy till", "date": "2026-04-11"},
    {"key": "d_aicha", "person": "aicha", "direction": "i_owe", "amount": 100, "name": "Bread and milk for Baba",
     "date": "2026-04-12"},
    {"key": "d_zineb", "person": "zineb", "direction": "i_owe", "amount": 2500, "name": "Loan for the car repair",
     "date": "2026-03-26", "settled": "2026-04-09T18:00"},
    {"key": "d_rachid", "person": "rachid", "direction": "owes_me", "amount": 250, "name": "Phone credit",
     "date": "2026-04-14"},
    {"key": "d_khalid", "person": "khalid", "direction": "i_owe", "amount": 350, "name": "Sink repair",
     "date": "2026-04-09"},
]

LOCKER = [
    {"key": "gmail", "name": "Gmail", "type": "login", "username": "fatima.alsayed@gmail.com",
     "url": "https://mail.google.com", "password": "Maarif-2026!", "starred": True},
    {"key": "portal", "name": "Wholesaler portal", "type": "login", "username": "pharmacie.maarif",
     "url": "https://commandes.grossiste.ma", "password": "Strips-165-box", "notes": "orders before noon"},
    {"key": "cnss_online", "name": "CNSS online", "type": "login", "username": "F.ALSAYED",
     "url": "https://www.cnss.ma", "password": "Baba-Care-850", "starred": True},
    {"key": "visa", "name": "Visa debit card", "type": "card", "card_number": "4539 1122 3344 5566", "cvv": "731",
     "starred": True},
    {"key": "safe", "name": "Pharmacy safe combination", "type": "note", "notes": "22-08-17, turn left twice"},
    {"key": "cin", "name": "CIN national ID", "type": "identity", "password": "BE482913"},
    {"key": "wifi_home", "name": "Home wifi", "type": "wifi", "password": "lina-adam-2019"},
    {"key": "wifi_pharm", "name": "Pharmacy wifi", "type": "wifi", "password": "Maarif-Pharma-5G"},
    {"key": "pc_pass", "name": "Pharmacy PC password", "type": "password", "password": "Shelf-B-2026"},
    {"key": "ssh", "name": "Stock server SSH key", "type": "ssh_key", "notes": "the technician set it up",
     "password": "ssh-ed25519 AAAAC3-stock-maarif"},
    {"key": "sms_api", "name": "SMS reminder API", "type": "api_credential", "notes": "refill reminders to patients",
     "code": "sms-live-5521"},
    {"key": "passport_l", "name": "Moroccan passport", "type": "passport", "notes": "expires July 2026"},
    {"key": "bank_acc", "name": "Pharmacy bank account", "type": "bank_account", "notes": "salaries and rent"},
    {"key": "licence_l", "name": "Driving licence", "type": "driving_licence", "notes": "category B"},
    {"key": "software", "name": "Pharmacy software licence", "type": "software_licence", "code": "PHX-7781-MAAR"},
    {"key": "crypto", "name": "Omar's crypto wallet", "type": "crypto_wallet", "notes": "Omar asked me to keep the seed",
     "code": "seed words in the safe"},
    {"key": "ordre_card", "name": "Pharmacists' order card", "type": "membership", "notes": "card number on the back",
     "starred": True},
    {"key": "baba_cnss_l", "name": "Baba's CNSS number", "type": "document", "notes": "for the reimbursement forms",
     "code": "CNSS-11983342"},
    {"key": "yahoo", "name": "Old Yahoo mail", "type": "login", "username": "fatima_s88",
     "url": "https://mail.yahoo.com", "password": "harira88", "trashed": "2026-04-02T09:00"},
]

LINKS = [
    {"from": "insulin", "to": "baba"},
    {"from": "strips", "to": "baba"},
    {"from": "shoes", "to": "baba"},
    {"from": "reimburse", "to": "baba"},
    {"from": "reimburse", "to": "dr_fassi"},
    {"from": "stamp", "to": "dr_fassi"},
    {"from": "glucose_log_t", "to": "baba"},
    {"from": "rota", "to": "nadia"},
    {"from": "rota", "to": "kenza"},
    {"from": "rota", "to": "rachid"},
    {"from": "scooter", "to": "hamza"},
    {"from": "invoices", "to": "mouhcine"},
    {"from": "leave", "to": "nadia"},
    {"from": "samples", "to": "youssef_b"},
    {"from": "party_plan", "to": "lina"},
    {"from": "homework", "to": "adam"},
    {"from": "fees", "to": "adam"},
    {"from": "lina_forms", "to": "lina"},
    {"from": "rota_mail", "to": "samira_b"},
    {"from": "rota_mail", "to": "samira_a"},
    {"from": "rota_mail", "to": "driss"},
    {"from": "sink", "to": "khalid"},
    {"from": "hajja_gift", "to": "zineb"},
    {"from": "sheep", "to": "omar"},
    {"from": "sheep", "to": "simo"},
    {"from": "goggles", "to": "adam"},
    {"from": "readings", "to": "baba"},
    {"from": "meds", "to": "baba"},
    {"from": "meds", "to": "dr_fassi"},
    {"from": "fassi_advice", "to": "dr_fassi"},
    {"from": "fassi_advice", "to": "baba"},
    {"from": "prices", "to": "youssef_b"},
    {"from": "staff_apr", "to": "nadia"},
    {"from": "staff_apr", "to": "rachid"},
    {"from": "staff_apr", "to": "imane"},
    {"from": "low_sugar", "to": "baba"},
    {"from": "rota_note", "to": "samira_b"},
    {"from": "rota_note", "to": "samira_a"},
    {"from": "rota_note", "to": "driss"},
    {"from": "teacher_notes", "to": "hakima"},
    {"from": "teacher_notes", "to": "adam"},
    {"from": "lina_words", "to": "lina"},
    {"from": "gift_ideas", "to": "youssef_a"},
    {"from": "gift_ideas", "to": "zineb"},
    {"from": "ifrane_plan", "to": "omar"},
    {"from": "ifrane_plan", "to": "simo"},
]


def world():
    return {
        "me": "Fatima Al-Sayed",
        "epoch": "2017-01-01T09:00",
        "seed": "T19",
        "currency": "MAD",
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
    out = HERE / "T19.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
