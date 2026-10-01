"""World T23: Nadia Rahimi, dentist in Tashkent (UZS vault).

    python3 authored/worlds/T23_build.py      # writes authored/worlds/T23.json (deterministic)

Today in the sessions is Wednesday 2026-08-05 07:55 (clinic opens at nine).
Nadia runs a small dental clinic in Yunusabad with her manager Farrukh. She is married to Rustam;
his mother Dilbar (Oyijon) lives with them, with their children Samir (9) and Laylo (turning 6).
The Nazarov cousins meet for plov every Sunday at Aziz's, and cousin Kamola marries Otabek in
September: the cousins run a wedding gift fund. Built-in ambiguity: two Malikas (clinic nurse,
cousin), two Sardors (cousin, plumber), nicknames (Rus, Oyijon, Kami, Bek), a misspelled-looking
name (Shakhnoza), two "Dress fitting with Kamola" events, two "Parent meeting" events, two
"Call with Javlon" events, two "Samir english lesson" events, two "Oyijon cardiologist" events,
near-duplicate tasks ("Order composite resin", "Buy gift for Kamola", monthly "Pay electricity"),
cancelled events, completed tasks, rows trashed inside and past the 30-day restore window, an
empty group, an empty folder, an empty album, an empty notebook and an empty list.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        # family
        {"key": "rustam", "name": "Rustam Rahimov", "role": "husband", "nickname": "Rus", "starred": True,
         "last_contacted": "2026-08-04T13:10", "last_contacted_kind": "call"},
        {"key": "dilbar", "name": "Dilbar Rahimova", "role": "mother-in-law", "nickname": "Oyijon", "starred": True,
         "last_contacted": "2026-08-01T08:00", "last_contacted_kind": "visit"},
        {"key": "samir", "name": "Samir Rahimov", "role": "son"},
        {"key": "laylo", "name": "Laylo Rahimova", "role": "daughter"},
        {"key": "farida", "name": "Farida Nazarova", "role": "mother, in Samarkand", "starred": True, "cadence": 3,
         "last_contacted": "2026-08-03T20:00", "last_contacted_kind": "call", "met": "Samarkand"},
        {"key": "javlon", "name": "Javlon Nazarov", "role": "brother in Moscow", "cadence": 14,
         "last_contacted": "2026-07-26T20:00", "last_contacted_kind": "call"},
        # cousins, plov Sundays
        {"key": "aziz", "name": "Aziz Nazarov", "role": "cousin", "starred": True, "cadence": 7,
         "last_contacted": "2026-08-02T15:00", "last_contacted_kind": "visit"},
        {"key": "kamola", "name": "Kamola Yusupova", "role": "cousin, bride", "nickname": "Kami", "cadence": 7,
         "last_contacted": "2026-08-04T21:00", "last_contacted_kind": "message"},
        {"key": "sardor_c", "name": "Sardor Nazarov", "role": "cousin", "cadence": 30,
         "last_contacted": "2026-07-12T15:00", "last_contacted_kind": "visit"},
        {"key": "zarina", "name": "Zarina Alimova", "role": "cousin", "starred": True, "cadence": 14,
         "last_contacted": "2026-07-29T18:00", "last_contacted_kind": "call"},
        {"key": "malika_t", "name": "Malika Tosheva", "role": "cousin", "cadence": 30,
         "last_contacted": "2026-08-02T14:30", "last_contacted_kind": "visit"},
        {"key": "otabek", "name": "Otabek Ergashev", "role": "Kamola's fiance",
         "last_contacted": "2026-07-19T12:00", "last_contacted_kind": "meeting"},
        # clinic
        {"key": "malika_y", "name": "Malika Yusupova", "role": "nurse", "cadence": 7,
         "last_contacted": "2026-08-04T17:00", "last_contacted_kind": "meeting"},
        {"key": "gulnora", "name": "Gulnora Saidova", "role": "receptionist", "starred": True,
         "last_contacted": "2026-08-04T09:00", "last_contacted_kind": "meeting"},
        {"key": "shakhnoza", "name": "Shakhnoza Aliyeva", "role": "hygienist", "cadence": 14,
         "last_contacted": "2026-07-22T17:00", "last_contacted_kind": "meeting"},
        {"key": "bekzod", "name": "Bekzod Umarov", "role": "junior dentist", "nickname": "Bek", "cadence": 7,
         "last_contacted": "2026-07-31T18:00", "last_contacted_kind": "meeting"},
        {"key": "farrukh", "name": "Farrukh Kasimov", "role": "clinic manager", "starred": True, "cadence": 3,
         "last_contacted": "2026-08-03T08:30", "last_contacted_kind": "meeting"},
        {"key": "oybek", "name": "Oybek Tursunov", "role": "dental lab technician", "cadence": 30,
         "last_contacted": "2026-07-28T11:00", "last_contacted_kind": "call"},
        {"key": "islom", "name": "Dr. Islom Hakimov", "role": "orthodontist", "cadence": 60,
         "last_contacted": "2026-06-18T19:00", "last_contacted_kind": "coffee"},
        # others
        {"key": "sardor_p", "name": "Sardor Mirzaev", "role": "plumber",
         "last_contacted": "2026-08-04T18:00", "last_contacted_kind": "visit"},
        {"key": "nigora", "name": "Nigora Khodjaeva", "role": "neighbour",
         "last_contacted": "2026-07-30T19:00", "last_contacted_kind": "visit"},
        {"key": "lola", "name": "Lola Ismoilova", "role": "kindergarten teacher"},
        {"key": "anvar", "name": "Anvar Rashidov", "role": "taxi driver",
         "last_contacted": "2026-07-27T07:40", "last_contacted_kind": "call"},
        {"key": "dilnoza", "name": "Dilnoza Ahmedova", "role": "english tutor", "cadence": 7,
         "last_contacted": "2026-07-30T17:00", "last_contacted_kind": "message"},
        {"key": "ravshan", "name": "Ravshan Sultanov", "role": "accountant", "cadence": 30,
         "last_contacted": "2026-07-27T09:00", "last_contacted_kind": "call"},
        {"key": "shahlo", "name": "Shahlo Nurmatova", "role": "friend from university", "starred": True,
         "cadence": 14, "last_contacted": "2026-07-18T12:00", "last_contacted_kind": "coffee", "met": "medical institute"},
        # trashed: one inside the 30-day window, one past it
        {"key": "hasan", "name": "Hasan Qodirov", "role": "old supplier", "trashed": "2026-07-20T10:00"},
        {"key": "timur", "name": "Timur Valiev", "role": "former landlord", "trashed": "2026-05-10T09:00"},
    ]


GROUPS = [
    {"key": "plov", "name": "Sunday plov", "currency": "UZS",
     "members": ["aziz", "kamola", "sardor_c", "zarina", "malika_t", "rustam"], "created": "2025-03-02T16:00"},
    {"key": "gift_fund", "name": "Kamola wedding gift", "currency": "UZS",
     "members": ["aziz", "sardor_c", "zarina", "malika_t", "farida"], "created": "2026-07-12T17:00"},
    {"key": "lunch_fund", "name": "Clinic lunch fund", "currency": "UZS",
     "members": ["malika_y", "gulnora", "shakhnoza", "bekzod", "farrukh"], "created": "2025-10-01T13:00"},
    {"key": "istanbul", "name": "Istanbul course", "currency": "USD",
     "members": ["bekzod", "islom"], "created": "2026-07-06T09:30"},
    {"key": "samarkand_g", "name": "Samarkand weekend", "currency": "UZS",
     "members": ["rustam", "dilbar"], "created": "2026-07-28T21:00"},
    {"key": "umrah", "name": "Umrah savings", "currency": "UZS", "created": "2026-06-01T20:00"},
]

EXPENSES = [
    {"group": "plov", "name": "Lamb and rice", "amount": 600000, "paid_by": "me",
     "split": ["me", "aziz", "zarina", "malika_t"], "date": "2026-07-26"},
    {"group": "plov", "name": "Watermelons", "amount": 120000, "paid_by": "aziz",
     "split": ["me", "aziz", "sardor_c", "zarina"], "date": "2026-08-02"},
    {"group": "plov", "name": "Kazan repair", "amount": 210000, "paid_by": "sardor_c",
     "split": ["me", "aziz", "kamola", "sardor_c", "zarina", "malika_t", "rustam"], "date": "2026-07-12"},
    {"group": "gift_fund", "name": "Gold earrings deposit", "amount": 3000000, "paid_by": "me",
     "split": ["me", "aziz", "sardor_c", "zarina", "malika_t", "farida"], "date": "2026-07-20"},
    {"group": "lunch_fund", "name": "Friday lunch", "amount": 450000, "paid_by": "gulnora",
     "split": ["me", "malika_y", "gulnora", "shakhnoza", "bekzod", "farrukh"], "date": "2026-07-31"},
    {"group": "lunch_fund", "name": "Cake for Farrukh", "amount": 180000, "paid_by": "me",
     "split": ["me", "gulnora", "malika_y"], "date": "2026-07-15"},
    {"group": "istanbul", "name": "Course registration", "amount": 600, "paid_by": "bekzod",
     "split": ["me", "bekzod", "islom"], "date": "2026-07-06"},
]

LISTS = [
    {"key": "clinic_l", "name": "Clinic", "area": "work"},
    {"key": "home_l", "name": "Home", "area": "family"},
    {"key": "kids_l", "name": "Kids", "area": "family"},
    {"key": "wedding_l", "name": "Wedding"},
    {"key": "shop_l", "name": "Shopping"},
    {"key": "dacha_l", "name": "Dacha", "area": "family"},
]


def events():
    out = []
    # Sunday plov at Aziz's
    d = date(2026, 6, 7)
    while d <= date(2026, 8, 30):
        ev = {"key": f"plov_{d.strftime('%m%d')}", "name": "Sunday plov", "start": f"{d}T13:00",
              "end": f"{d}T16:00", "attendees": ["aziz", "rustam"], "description": "at Aziz's, Yunusabad"}
        if d == date(2026, 7, 5):
            ev["cancelled"] = "2026-07-03T18:00"
        out.append(ev)
        d += timedelta(weeks=1)
    # clinic staff meeting, Monday mornings
    d = date(2026, 7, 6)
    while d <= date(2026, 8, 31):
        out.append({"key": f"staff_{d.strftime('%m%d')}", "name": "Staff meeting", "start": f"{d}T08:00",
                    "end": f"{d}T08:30", "attendees": ["farrukh", "gulnora"], "description": "clinic kitchen"})
        d += timedelta(weeks=1)
    # Samir's swimming, Saturday mornings
    d = date(2026, 7, 4)
    while d <= date(2026, 8, 29):
        out.append({"key": f"swim_{d.strftime('%m%d')}", "name": "Samir swimming", "start": f"{d}T10:00",
                    "end": f"{d}T11:00", "attendees": ["samir"], "description": "Olympic pool"})
        d += timedelta(weeks=1)
    out += [
        # wedding
        {"key": "wedding", "name": "Kamola's wedding", "start": "2026-09-19T17:00", "end": "2026-09-19T23:00",
         "attendees": ["kamola", "otabek", "aziz"], "description": "Navruz wedding hall"},
        {"key": "fotiha", "name": "Fotiha for Kamola", "start": "2026-07-11T18:00", "end": "2026-07-11T21:00",
         "attendees": ["kamola", "otabek", "farida"]},
        {"key": "fitting_1", "name": "Dress fitting with Kamola", "start": "2026-08-08T15:00",
         "end": "2026-08-08T16:30", "attendees": ["kamola"], "description": "atelier on Amir Temur"},
        {"key": "fitting_2", "name": "Dress fitting with Kamola", "start": "2026-08-22T15:00",
         "end": "2026-08-22T16:30", "attendees": ["kamola"], "description": "atelier on Amir Temur"},
        {"key": "hall_visit", "name": "Wedding hall visit", "start": "2026-07-19T11:00", "end": "2026-07-19T12:00",
         "attendees": ["kamola", "aziz", "otabek"]},
        {"key": "gift_shop", "name": "Gift shopping at Samarqand Darvoza", "start": "2026-08-16T11:00",
         "end": "2026-08-16T12:30", "attendees": ["zarina", "malika_t"]},
        # clinic
        {"key": "congress", "name": "Dental congress", "start": "2026-09-10T09:00", "end": "2026-09-10T18:00",
         "description": "Tashkent City expo"},
        {"key": "istanbul_course", "name": "Istanbul implant course", "start": "2026-10-02T09:00",
         "end": "2026-10-02T17:00", "attendees": ["bekzod", "islom"]},
        {"key": "oybek_pickup", "name": "Pick up crowns from Oybek", "start": "2026-08-06T09:00",
         "end": "2026-08-06T09:30", "attendees": ["oybek"]},
        {"key": "supplier", "name": "Supplier meeting", "start": "2026-08-06T13:00", "end": "2026-08-06T14:00",
         "attendees": ["farrukh"], "description": "new composite prices"},
        {"key": "xray_service", "name": "X-ray machine service", "start": "2026-08-07T08:00",
         "end": "2026-08-07T10:00", "attendees": ["farrukh"]},
        {"key": "inspection", "name": "Clinic inspection", "start": "2026-08-19T10:00", "end": "2026-08-19T12:00",
         "attendees": ["farrukh", "gulnora", "malika_y"], "description": "sanitary inspection"},
        {"key": "hygiene_training", "name": "Hygiene training", "start": "2026-07-22T14:00",
         "end": "2026-07-22T17:00", "attendees": ["shakhnoza", "malika_y"]},
        {"key": "team_dinner", "name": "Clinic team dinner", "start": "2026-08-14T19:00", "end": "2026-08-14T22:00",
         "attendees": ["farrukh", "gulnora", "malika_y", "shakhnoza", "bekzod"], "description": "Caravan restaurant"},
        {"key": "study_club", "name": "Ortho study club", "start": "2026-08-26T18:00", "end": "2026-08-26T20:00",
         "attendees": ["islom", "bekzod"]},
        # family
        {"key": "parents_kg", "name": "Parent meeting", "start": "2026-08-28T17:00", "end": "2026-08-28T18:00",
         "attendees": ["lola"], "description": "kindergarten, Laylo's group"},
        {"key": "parents_school", "name": "Parent meeting", "start": "2026-09-04T18:00", "end": "2026-09-04T19:00",
         "description": "school 110, class 4B"},
        {"key": "school_start", "name": "Samir first day of school", "start": "2026-09-01T08:00",
         "end": "2026-09-01T12:00", "attendees": ["samir", "rustam"]},
        {"key": "laylo_bday", "name": "Laylo's birthday party", "start": "2026-08-15T16:00",
         "end": "2026-08-15T19:00", "attendees": ["laylo", "dilbar", "rustam", "zarina"]},
        {"key": "farida_arrives", "name": "Mum arrives from Samarkand", "start": "2026-08-12T14:00",
         "end": "2026-08-12T15:00", "attendees": ["farida"], "description": "Afrosiyob, Tashkent station"},
        {"key": "samarkand_trip", "name": "Samarkand weekend", "start": "2026-09-05T08:00",
         "end": "2026-09-06T20:00", "attendees": ["rustam", "dilbar"]},
        {"key": "javlon_call_1", "name": "Call with Javlon", "start": "2026-07-26T20:00", "end": "2026-07-26T20:30",
         "attendees": ["javlon"]},
        {"key": "javlon_call_2", "name": "Call with Javlon", "start": "2026-08-09T20:00", "end": "2026-08-09T20:30",
         "attendees": ["javlon"]},
        {"key": "tutor_1", "name": "Samir english lesson", "start": "2026-08-06T16:00", "end": "2026-08-06T17:00",
         "attendees": ["samir", "dilnoza"]},
        {"key": "tutor_2", "name": "Samir english lesson", "start": "2026-08-13T16:00", "end": "2026-08-13T17:00",
         "attendees": ["samir", "dilnoza"]},
        {"key": "cardio", "name": "Oyijon cardiologist", "start": "2026-08-11T10:00", "end": "2026-08-11T10:45",
         "attendees": ["dilbar"], "description": "Republican cardiology centre"},
        {"key": "cardio_old", "name": "Oyijon cardiologist", "start": "2026-06-16T10:00", "end": "2026-06-16T10:45",
         "attendees": ["dilbar"], "description": "Republican cardiology centre"},
        {"key": "ortho_samir", "name": "Samir's orthodontist", "start": "2026-08-20T16:00",
         "end": "2026-08-20T16:30", "attendees": ["samir", "islom"]},
        {"key": "vaccination", "name": "Laylo vaccination", "start": "2026-07-15T09:00", "end": "2026-07-15T09:30",
         "attendees": ["laylo"]},
        {"key": "anniversary", "name": "Anniversary dinner", "start": "2026-07-30T19:30", "end": "2026-07-30T22:00",
         "attendees": ["rustam"], "description": "Afsona"},
        {"key": "chorsu", "name": "Chorsu bazaar run", "start": "2026-08-01T08:00", "end": "2026-08-01T09:30",
         "attendees": ["dilbar"]},
        {"key": "plumber_visit", "name": "Plumber visit", "start": "2026-08-04T18:00", "end": "2026-08-04T19:00",
         "attendees": ["sardor_p"]},
        {"key": "car_service", "name": "Car service", "start": "2026-08-10T17:30", "end": "2026-08-10T18:30"},
        {"key": "coffee_shahlo", "name": "Coffee with Shahlo", "start": "2026-08-08T11:30",
         "end": "2026-08-08T12:30", "attendees": ["shahlo"]},
        {"key": "tax_review", "name": "Tax review with Ravshan", "start": "2026-08-18T15:00",
         "end": "2026-08-18T16:00", "attendees": ["ravshan"]},
        {"key": "housewarming", "name": "Nigora's housewarming", "start": "2026-08-21T18:30",
         "end": "2026-08-21T21:00", "attendees": ["nigora"]},
        {"key": "charvak", "name": "Charvak day trip", "start": "2026-07-29T09:00", "end": "2026-07-29T19:00",
         "attendees": ["rustam", "samir", "laylo"], "cancelled": "2026-07-24T20:00"},
        {"key": "dacha_weekend", "name": "Dacha weekend", "start": "2026-08-23T09:00", "end": "2026-08-23T12:00",
         "attendees": ["rustam"], "cancelled": "2026-08-02T21:00"},
        # trashed: one inside the window, one past it
        {"key": "gym_trial", "name": "Gym trial", "start": "2026-07-28T07:00", "end": "2026-07-28T08:00",
         "trashed": "2026-07-27T10:00"},
        {"key": "yoga", "name": "Yoga class", "start": "2026-05-20T07:00", "end": "2026-05-20T08:00",
         "trashed": "2026-05-18T09:00"},
    ]
    return out


def tasks():
    t = [
        # clinic
        {"key": "resin", "name": "Order composite resin", "due": "2026-08-07", "priority": 1, "effort": 20,
         "list": "clinic_l", "description": "A2 and A3 shades"},
        {"key": "resin_old", "name": "Order composite resin", "due": "2026-07-03", "completed": "2026-07-03T12:00",
         "list": "clinic_l"},
        {"key": "autoclave", "name": "Fix the autoclave", "due": "2026-08-06", "priority": 1, "effort": 60,
         "list": "clinic_l", "status": "in_progress"},
        {"key": "tech_call", "name": "Call the technician", "parent": "autoclave", "due": "2026-08-04",
         "completed": "2026-08-04T10:00", "effort": 10},
        {"key": "gasket", "name": "Buy new gasket", "parent": "autoclave", "due": "2026-08-06", "effort": 30},
        {"key": "insp_prep", "name": "Prepare for clinic inspection", "due": "2026-08-18", "priority": 2,
         "effort": 240, "list": "clinic_l", "status": "in_progress"},
        {"key": "steril_log", "name": "Update sterilization log", "parent": "insp_prep", "due": "2026-08-12",
         "effort": 60},
        {"key": "waste", "name": "Renew waste disposal contract", "parent": "insp_prep", "due": "2026-08-14",
         "effort": 45, "priority": 3},
        {"key": "extinguishers", "name": "Check fire extinguishers", "parent": "insp_prep", "due": "2026-08-17",
         "effort": 15},
        {"key": "recalls", "name": "Send patient recall messages", "due": "2026-08-07", "effort": 45, "priority": 3,
         "list": "clinic_l"},
        {"key": "xray_lic", "name": "Renew X-ray licence", "due": "2026-08-31", "priority": 2, "effort": 90,
         "list": "clinic_l"},
        {"key": "rota", "name": "Make September rota", "due": "2026-08-25", "effort": 60, "list": "clinic_l"},
        {"key": "bek_review", "name": "Review Bekzod's cases", "due": "2026-08-10", "effort": 90, "priority": 3,
         "list": "clinic_l"},
        {"key": "ceramic", "name": "Send ceramic case to Oybek", "due": "2026-08-03",
         "completed": "2026-08-03T16:00", "list": "clinic_l"},
        {"key": "gloves", "name": "Order gloves", "due": "2026-08-12", "effort": 10, "priority": 4,
         "list": "clinic_l"},
        # home
        {"key": "gas", "name": "Pay gas bill", "due": "2026-08-08", "effort": 10, "list": "home_l"},
        {"key": "aircon", "name": "Clean the air conditioner filters", "due": "2026-08-09", "effort": 30,
         "list": "home_l"},
        {"key": "leak", "name": "Fix bathroom leak", "due": "2026-08-04", "completed": "2026-08-04T19:00",
         "list": "home_l"},
        {"key": "pills", "name": "Refill Oyijon's heart pills", "due": "2026-08-06", "priority": 1, "effort": 15,
         "list": "home_l"},
        {"key": "curtains", "name": "Hang new curtains", "list": "home_l", "trashed": "2026-07-25T09:00"},
        # kids
        {"key": "uniform", "name": "Buy Samir's school uniform", "due": "2026-08-20", "effort": 90, "priority": 2,
         "list": "kids_l"},
        {"key": "supplies", "name": "Buy school supplies", "due": "2026-08-25", "effort": 60, "list": "kids_l"},
        {"key": "notebooks_t", "name": "Notebooks and pens", "parent": "supplies", "effort": 20},
        {"key": "backpack", "name": "Backpack", "parent": "supplies", "effort": 30},
        {"key": "party", "name": "Plan Laylo's party", "due": "2026-08-14", "priority": 2, "effort": 120,
         "list": "kids_l"},
        {"key": "cake", "name": "Order the cake", "parent": "party", "due": "2026-08-12", "effort": 15},
        {"key": "invites", "name": "Invite her friends", "parent": "party", "due": "2026-08-08", "effort": 20},
        {"key": "balloons", "name": "Buy balloons", "parent": "party", "due": "2026-08-14", "effort": 15},
        {"key": "kg_forms", "name": "Kindergarten forms", "due": "2026-08-10", "effort": 30, "list": "kids_l"},
        {"key": "swim_fee", "name": "Pay swimming fee", "due": "2026-08-01", "completed": "2026-07-31T18:00",
         "list": "kids_l"},
        # wedding
        {"key": "gift", "name": "Buy gift for Kamola", "due": "2026-09-10", "priority": 2, "effort": 120,
         "list": "wedding_l"},
        {"key": "gift_old", "name": "Buy gift for Kamola", "due": "2026-07-11", "completed": "2026-07-10T19:00",
         "list": "wedding_l", "description": "fotiha present"},
        {"key": "dress", "name": "Pick up dress from tailor", "due": "2026-09-15", "effort": 30,
         "list": "wedding_l"},
        {"key": "collect", "name": "Collect gift fund money", "due": "2026-08-31", "effort": 30, "priority": 3,
         "list": "wedding_l"},
        {"key": "toast", "name": "Write a toast for the wedding", "due": "2026-09-18", "effort": 60,
         "list": "wedding_l"},
        # shopping
        {"key": "rice", "name": "Buy devzira rice", "due": "2026-08-08", "effort": 30, "list": "shop_l"},
        {"key": "lamb", "name": "Buy lamb for plov", "due": "2026-08-08", "effort": 30, "list": "shop_l"},
        {"key": "melons", "name": "Buy melons", "due": "2026-08-02", "completed": "2026-08-02T10:00",
         "list": "shop_l"},
        {"key": "ink", "name": "Buy printer ink", "list": "shop_l", "effort": 15},
        # on no list
        {"key": "tax", "name": "File tax declaration", "due": "2026-08-20", "priority": 1, "effort": 120,
         "description": "Ravshan has the income summary"},
        {"key": "car_ins", "name": "Renew car insurance", "due": "2026-08-27", "priority": 2, "effort": 30},
        {"key": "journal_read", "name": "Read implant journal", "effort": 60},
        {"key": "call_javlon", "name": "Call Javlon about mum's ticket", "due": "2026-08-06", "effort": 10},
        {"key": "visa", "name": "Apply for Turkey e-visa", "due": "2026-09-01", "priority": 2, "effort": 45},
        {"key": "course_fee", "name": "Pay Istanbul course fee", "due": "2026-08-15", "priority": 1, "effort": 15},
        {"key": "hotel", "name": "Book Samarkand hotel", "due": "2026-08-20", "effort": 30},
        {"key": "cards", "name": "Order business cards", "due": "2026-07-20", "completed": "2026-07-21T11:00"},
        {"key": "gym", "name": "Sign up for gym", "priority": 5},
        {"key": "charvak_t", "name": "Book Charvak cottage", "status": "cancelled"},
        {"key": "treadmill", "name": "Sell old treadmill", "trashed": "2026-05-01T09:00"},
    ]
    # electricity, monthly on the 10th
    for m in (6, 7):
        t.append({"key": f"elec_{m:02d}", "name": "Pay electricity", "due": f"2026-{m:02d}-10",
                  "completed": f"2026-{m:02d}-09T20:00", "list": "home_l"})
    t.append({"key": "elec_08", "name": "Pay electricity", "due": "2026-08-10", "list": "home_l", "effort": 10})
    return t


NOTEBOOKS = [
    {"key": "clinic_nb", "name": "Clinic"},
    {"key": "recipes_nb", "name": "Recipes"},
    {"key": "wedding_nb", "name": "Wedding"},
    {"key": "kids_nb", "name": "Kids"},
    {"key": "journal_nb", "name": "Journal"},
    {"key": "courses_nb", "name": "Old courses"},
]

NOTES = [
    {"key": "aziz_plov", "name": "Aziz's plov", "body": "devzira rice, lamb shoulder, yellow carrots, cumin at the end",
     "notebook": "recipes_nb", "created": "2026-06-07T18:00", "pinned": True},
    {"key": "somsa", "name": "Somsa dough", "body": "cold butter, fold four times, rest in the fridge",
     "notebook": "recipes_nb", "created": "2026-04-12T11:00"},
    {"key": "lagman", "name": "Lagman", "body": "pull the noodles thin, peppers and beef",
     "notebook": "recipes_nb", "created": "2026-07-19T20:10"},
    {"key": "chuchvara", "name": "Chuchvara", "body": "small dumplings, dill in the broth",
     "notebook": "recipes_nb", "created": "2026-05-03T19:00"},
    {"key": "autoclave_n", "name": "Autoclave readings", "body": "cycle 134 degrees, pressure dropping on cycle 3",
     "notebook": "clinic_nb", "created": "2026-08-03T22:15"},
    {"key": "prices", "name": "Supplier prices", "body": "composite up 12 percent, gloves the same",
     "notebook": "clinic_nb", "created": "2026-07-28T12:00"},
    {"key": "insp_list", "name": "Inspection checklist", "body": "sterilization log, waste contract, extinguishers",
     "notebook": "clinic_nb", "created": "2026-07-31T21:00", "pinned": True},
    {"key": "bek_notes", "name": "Bekzod case notes", "body": "two root canals to recheck, good with kids",
     "notebook": "clinic_nb", "created": "2026-07-24T18:30"},
    {"key": "feedback", "name": "Patient feedback", "body": "waiting room too warm, parking hard",
     "notebook": "clinic_nb", "created": "2026-06-20T13:00"},
    {"key": "guests", "name": "Wedding guest list", "body": "our side 40 people, Samarkand relatives 25",
     "notebook": "wedding_nb", "created": "2026-07-12T10:00"},
    {"key": "gift_ideas", "name": "Gift ideas for Kamola", "body": "gold earrings, a dastarkhan set, silk suzani",
     "notebook": "wedding_nb", "created": "2026-07-20T21:30"},
    {"key": "toast_draft", "name": "Toast draft", "body": "start with the story of the apricot tree",
     "notebook": "wedding_nb", "created": "2026-08-02T23:00"},
    {"key": "school_list", "name": "Samir school list", "body": "white shirts, black trousers, 12 notebooks",
     "notebook": "kids_nb", "created": "2026-07-30T08:00"},
    {"key": "party_plan", "name": "Laylo party plan", "body": "clown at 5, cake from Bon, 12 kids",
     "notebook": "kids_nb", "created": "2026-08-01T19:00"},
    {"key": "kg_contacts", "name": "Kindergarten contacts", "body": "Lola opa, group 3, pickup by six",
     "notebook": "kids_nb", "created": "2026-06-25T09:00"},
    {"key": "july_thoughts", "name": "July thoughts", "body": "too many evenings at the clinic",
     "notebook": "journal_nb", "created": "2026-07-31T23:30"},
    {"key": "june_thoughts", "name": "June thoughts", "body": "the kids grew so fast this spring",
     "notebook": "journal_nb", "created": "2026-06-30T22:00"},
    {"key": "meds", "name": "Oyijon medicines", "body": "bisoprolol morning, aspirin evening",
     "created": "2026-06-16T11:00", "pinned": True},
    {"key": "router", "name": "Router reset steps", "body": "hold the back button ten seconds",
     "created": "2026-03-02T10:00"},
    {"key": "tax_docs", "name": "Tax documents needed", "body": "income summary, clinic lease, receipts",
     "created": "2026-07-27T09:15"},
    {"key": "car_noise", "name": "Car noises", "body": "rattle on the left when braking",
     "created": "2026-08-04T19:40"},
    {"key": "istanbul_hotels", "name": "Istanbul course hotels", "body": "Sisli near the venue, ask Bekzod",
     "created": "2026-07-08T21:00"},
    {"key": "old_menu", "name": "Old clinic menu", "body": "price list 2024", "notebook": "clinic_nb",
     "created": "2025-01-10T10:00", "trashed": "2026-07-28T10:00"},
    {"key": "old_shopping", "name": "Old shopping list", "body": "spring", "created": "2026-03-15T10:00",
     "trashed": "2026-05-05T10:00"},
]

FOLDERS = [
    {"key": "clinic_f", "name": "Clinic papers"},
    {"key": "home_f", "name": "Home"},
    {"key": "tax_f", "name": "Taxes"},
    {"key": "school_f", "name": "Kids school"},
    {"key": "wedding_f", "name": "Wedding"},
    {"key": "scans_f", "name": "Scans"},
]

DOCUMENTS = [
    {"key": "xray_doc", "name": "X-ray licence 2025", "folder": "clinic_f", "created": "2025-09-01T10:00"},
    {"key": "lease", "name": "Clinic lease", "folder": "clinic_f", "starred": True, "created": "2024-03-01T12:00"},
    {"key": "waste_doc", "name": "Waste disposal contract", "folder": "clinic_f", "created": "2025-08-14T11:00"},
    {"key": "insp_report", "name": "Inspection report 2025", "folder": "clinic_f", "created": "2025-08-20T15:00"},
    {"key": "invoice", "name": "Supplier invoice July", "folder": "clinic_f", "created": "2026-07-28T12:30"},
    {"key": "old_prices", "name": "Old price list", "folder": "clinic_f", "created": "2025-02-01T10:00",
     "trashed": "2026-07-25T10:00"},
    {"key": "flat_cert", "name": "Flat ownership certificate", "folder": "home_f", "starred": True,
     "created": "2019-05-10T10:00"},
    {"key": "gas_contract", "name": "Gas contract", "folder": "home_f", "created": "2022-01-15T10:00"},
    {"key": "tax_2025", "name": "Tax declaration 2025", "folder": "tax_f", "created": "2026-03-10T16:00"},
    {"key": "income", "name": "Income summary", "folder": "tax_f", "created": "2026-07-27T09:30"},
    {"key": "samir_cert", "name": "Samir school certificate", "folder": "school_f", "created": "2026-06-28T14:00"},
    {"key": "laylo_card", "name": "Laylo medical card", "folder": "school_f", "created": "2026-07-15T10:00"},
    {"key": "hall_contract", "name": "Wedding hall contract", "folder": "wedding_f", "starred": True,
     "created": "2026-07-19T12:30"},
    {"key": "catering", "name": "Catering quote", "folder": "wedding_f", "created": "2026-07-21T18:45"},
    {"key": "course_invite", "name": "Istanbul course invitation", "created": "2026-07-06T09:00"},
    {"key": "car_policy", "name": "Car insurance policy", "created": "2025-08-27T10:00"},
    {"key": "scan_a", "name": "Scan 0712", "created": "2026-07-12T20:05"},
    {"key": "scan_b", "name": "Scan 0713", "created": "2026-07-13T20:06"},
    {"key": "old_lease", "name": "Old flat lease", "created": "2023-04-01T10:00", "trashed": "2026-04-01T10:00"},
]

ALBUMS = [
    {"key": "family_a", "name": "Family"},
    {"key": "plov_a", "name": "Plov Sundays"},
    {"key": "wedding_a", "name": "Kamola's wedding"},
    {"key": "clinic_a", "name": "Clinic"},
    {"key": "kids_a", "name": "Kids"},
    {"key": "istanbul_a", "name": "Istanbul 2026"},
]

PHOTOS = [
    {"key": "p_plov_0726", "name": "Plov at Aziz's", "taken": "2026-07-26T14:10", "albums": ["plov_a"],
     "people": ["aziz", "rustam"]},
    {"key": "p_kazan", "name": "Kazan on the fire", "taken": "2026-07-19T13:30", "albums": ["plov_a"],
     "people": ["aziz"], "starred": True},
    {"key": "p_table", "name": "Sunday table", "taken": "2026-08-02T14:00", "albums": ["plov_a"],
     "people": ["aziz", "zarina", "malika_t", "kamola"]},
    {"key": "p_fotiha", "name": "Fotiha toast", "taken": "2026-07-11T19:00", "albums": ["wedding_a"],
     "people": ["kamola", "otabek", "farida"], "starred": True},
    {"key": "p_couple", "name": "Kamola and Otabek", "taken": "2026-07-11T19:30", "albums": ["wedding_a", "family_a"],
     "people": ["kamola", "otabek"]},
    {"key": "p_hall", "name": "Wedding hall", "taken": "2026-07-19T11:20", "albums": ["wedding_a"],
     "people": ["kamola"]},
    {"key": "p_dress", "name": "Dress sketch", "taken": "2026-07-21T18:00", "albums": ["wedding_a"]},
    {"key": "p_pool", "name": "Samir at the pool", "taken": "2026-08-01T10:30", "albums": ["kids_a"],
     "people": ["samir"]},
    {"key": "p_park", "name": "Laylo in the park", "taken": "2026-07-18T17:00", "albums": ["kids_a", "family_a"],
     "people": ["laylo"]},
    {"key": "p_melons", "name": "Kids with melons", "taken": "2026-08-02T18:30", "albums": ["kids_a", "family_a"],
     "people": ["samir", "laylo"], "starred": True},
    {"key": "p_brave", "name": "Brave Laylo", "taken": "2026-07-15T09:20", "albums": ["kids_a"],
     "people": ["laylo"]},
    {"key": "p_bike", "name": "Samir's new bike", "taken": "2026-06-20T18:00", "albums": ["kids_a"],
     "people": ["samir"]},
    {"key": "p_anniv", "name": "Anniversary dinner", "taken": "2026-07-30T20:00", "albums": ["family_a"],
     "people": ["rustam"]},
    {"key": "p_garden", "name": "Oyijon in the garden", "taken": "2026-07-18T08:30", "albums": ["family_a"],
     "people": ["dilbar"]},
    {"key": "p_chorsu", "name": "Chorsu spices", "taken": "2026-08-01T08:40", "albums": ["family_a"],
     "people": ["dilbar"]},
    {"key": "p_registan", "name": "Registan at night", "taken": "2025-09-14T21:00", "albums": ["family_a"]},
    {"key": "p_mum", "name": "Mum at the station", "taken": "2026-06-02T15:00", "albums": ["family_a"],
     "people": ["farida"]},
    {"key": "p_team", "name": "Clinic team", "taken": "2026-06-12T13:00", "albums": ["clinic_a"],
     "people": ["farrukh", "gulnora", "malika_y", "shakhnoza", "bekzod"], "starred": True},
    {"key": "p_chair", "name": "New dental chair", "taken": "2026-07-02T11:00", "albums": ["clinic_a"]},
    {"key": "p_training", "name": "Hygiene training", "taken": "2026-07-22T15:00", "albums": ["clinic_a"],
     "people": ["shakhnoza", "malika_y"]},
    {"key": "p_xray", "name": "Old X-ray unit", "taken": "2026-07-29T12:00", "albums": ["clinic_a"]},
    {"key": "p_waiting", "name": "Waiting room", "taken": "2026-05-20T10:00", "albums": ["clinic_a"]},
    {"key": "p_sunset", "name": "Sunset over the TV tower", "taken": "2026-07-18T20:10"},
    {"key": "p_receipt", "name": "Receipt for lamb", "taken": "2026-08-01T09:10"},
    {"key": "p_whiteboard", "name": "Rota whiteboard", "taken": "2026-07-27T08:20"},
    {"key": "p_dashboard", "name": "Car dashboard light", "taken": "2026-08-04T19:35"},
    {"key": "p_cat", "name": "Nigora's cat", "taken": "2026-07-25T16:00", "people": ["nigora"]},
    {"key": "p_leak", "name": "Bathroom leak", "taken": "2026-08-03T21:00"},
    {"key": "p_pipe", "name": "Sardor fixing the pipe", "taken": "2026-08-04T18:30", "people": ["sardor_p"]},
    {"key": "p_screenshot", "name": "Screenshot 0729", "taken": "2026-07-29T22:00"},
    {"key": "p_blurry", "name": "Blurry plov", "taken": "2026-08-02T14:01", "trashed": "2026-08-03T08:00",
     "people": ["aziz"]},
    {"key": "p_blurry_old", "name": "Blurry fitting", "taken": "2026-05-30T15:00", "trashed": "2026-06-01T08:00"},
]

DEBTS = [
    {"key": "d_aziz", "person": "aziz", "direction": "owes_me", "amount": 250000, "name": "Lamb for plov",
     "date": "2026-08-03"},
    {"key": "d_zarina", "person": "zarina", "direction": "i_owe", "amount": 120000, "name": "Taxi to Chorsu",
     "date": "2026-08-01"},
    {"key": "d_bekzod", "person": "bekzod", "direction": "owes_me", "amount": 500000, "name": "Course deposit",
     "date": "2026-07-06"},
    {"key": "d_gulnora", "person": "gulnora", "direction": "i_owe", "amount": 80000, "name": "Lunch cover",
     "date": "2026-07-29"},
    {"key": "d_javlon", "person": "javlon", "direction": "i_owe", "amount": 1500000, "name": "Mum's train tickets",
     "date": "2026-07-22"},
    {"key": "d_shahlo", "person": "shahlo", "direction": "owes_me", "amount": 300000, "name": "Concert tickets",
     "date": "2026-06-14"},
    {"key": "d_sardor_p", "person": "sardor_p", "direction": "i_owe", "amount": 400000, "name": "Pipe repair",
     "date": "2026-08-04"},
    {"key": "d_nigora", "person": "nigora", "direction": "owes_me", "amount": 60000, "name": "Bread and milk",
     "date": "2026-07-30"},
    {"key": "d_kamola", "person": "kamola", "direction": "i_owe", "amount": 200000, "name": "Fabric deposit",
     "date": "2026-06-25"},
    {"key": "d_malika_t", "person": "malika_t", "direction": "owes_me", "amount": 150000, "name": "Gift fund share",
     "date": "2026-07-20"},
    {"key": "d_otabek", "person": "otabek", "direction": "owes_me", "amount": 500000, "name": "Hall deposit share",
     "date": "2026-07-19"},
    {"key": "d_ravshan", "person": "ravshan", "direction": "i_owe", "amount": 500000, "name": "Accounting fee",
     "date": "2026-06-30", "settled": "2026-07-10T12:00"},
    {"key": "d_anvar", "person": "anvar", "direction": "owes_me", "amount": 50000, "name": "Change from taxi",
     "date": "2026-05-15", "settled": "2026-05-20T09:00"},
]

LOCKER = [
    {"key": "click", "name": "Click app", "type": "login", "username": "nadia.rahimi", "url": "https://click.uz",
     "password": "Registan#88", "starred": True},
    {"key": "crm", "name": "Clinic CRM", "type": "login", "username": "dr.rahimi", "url": "https://crm.smiledent.uz",
     "password": "Molar-2026!", "notes": "clinic"},
    {"key": "gov", "name": "my.gov.uz", "type": "login", "username": "AD2231445", "url": "https://my.gov.uz",
     "password": "Samarqand1990", "notes": "taxes and permits"},
    {"key": "visa_card", "name": "Kapitalbank Visa", "type": "card", "card_number": "4278 3100 5521 9043",
     "cvv": "614", "starred": True},
    {"key": "safe", "name": "Clinic safe", "type": "note", "notes": "4-8-1-6, spare key with Farrukh"},
    {"key": "id_card", "name": "ID card", "type": "identity", "password": "AD2231445"},
    {"key": "wifi", "name": "Home wifi", "type": "wifi", "password": "plov-sunday-7"},
    {"key": "clinic_wifi", "name": "Clinic wifi", "type": "wifi", "password": "smile2026"},
    {"key": "laptop", "name": "Laptop", "type": "password", "password": "Laylo2020"},
    {"key": "backup", "name": "Clinic backup server", "type": "ssh_key", "notes": "clinic",
     "password": "ssh-ed25519 AAAAC3-smiledent"},
    {"key": "sms_api", "name": "SMS reminders API", "type": "api_credential", "notes": "clinic, patient recalls",
     "password": "eskiz-5521-key"},
    {"key": "passport", "name": "Uzbek passport", "type": "passport", "notes": "expires 2031"},
    {"key": "savings", "name": "Hamkorbank savings", "type": "bank_account", "notes": "gift fund money"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence", "notes": "renew 2028"},
    {"key": "imaging", "name": "Dental imaging software", "type": "software_licence", "password": "DIS-7730-NR",
     "notes": "clinic"},
    {"key": "usdt", "name": "Javlon's USDT wallet", "type": "crypto_wallet", "notes": "Javlon set it up"},
    {"key": "assoc", "name": "Dental association", "type": "membership", "notes": "clinic, renew in january"},
    {"key": "marriage", "name": "Marriage certificate copy", "type": "document", "notes": "notarised copy"},
    {"key": "old_email", "name": "Old clinic email", "type": "login", "username": "smiledent.old",
     "url": "https://mail.ru", "password": "tooth2019", "trashed": "2026-07-30T09:00"},
    {"key": "old_gym", "name": "Old gym card", "type": "membership", "notes": "Fitness Plaza",
     "trashed": "2026-07-28T09:00"},
]

LINKS = [
    {"from": "resin", "to": "farrukh"},
    {"from": "autoclave", "to": "farrukh"},
    {"from": "insp_prep", "to": "farrukh"},
    {"from": "insp_prep", "to": "gulnora"},
    {"from": "steril_log", "to": "malika_y"},
    {"from": "recalls", "to": "gulnora"},
    {"from": "bek_review", "to": "bekzod"},
    {"from": "ceramic", "to": "oybek"},
    {"from": "leak", "to": "sardor_p"},
    {"from": "pills", "to": "dilbar"},
    {"from": "uniform", "to": "samir"},
    {"from": "supplies", "to": "samir"},
    {"from": "party", "to": "laylo"},
    {"from": "kg_forms", "to": "laylo"},
    {"from": "kg_forms", "to": "lola"},
    {"from": "gift", "to": "kamola"},
    {"from": "gift_old", "to": "kamola"},
    {"from": "dress", "to": "kamola"},
    {"from": "collect", "to": "aziz"},
    {"from": "collect", "to": "zarina"},
    {"from": "lamb", "to": "aziz"},
    {"from": "tax", "to": "ravshan"},
    {"from": "call_javlon", "to": "javlon"},
    {"from": "call_javlon", "to": "farida"},
    {"from": "course_fee", "to": "bekzod"},
    {"from": "aziz_plov", "to": "aziz"},
    {"from": "bek_notes", "to": "bekzod"},
    {"from": "prices", "to": "farrukh"},
    {"from": "insp_list", "to": "farrukh"},
    {"from": "insp_list", "to": "gulnora"},
    {"from": "guests", "to": "kamola"},
    {"from": "gift_ideas", "to": "kamola"},
    {"from": "gift_ideas", "to": "zarina"},
    {"from": "toast_draft", "to": "kamola"},
    {"from": "party_plan", "to": "laylo"},
    {"from": "school_list", "to": "samir"},
    {"from": "kg_contacts", "to": "lola"},
    {"from": "meds", "to": "dilbar"},
    {"from": "tax_docs", "to": "ravshan"},
    {"from": "istanbul_hotels", "to": "bekzod"},
]


def world():
    return {
        "me": "Nadia Rahimi",
        "epoch": "2019-01-01T09:00",
        "seed": "T23",
        "currency": "UZS",
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
    out = HERE / "T23.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
