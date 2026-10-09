"""World T16: Rafiq Chowdhury, garment factory floor manager in Dhaka (BDT vault).

    python3 authored/worlds/T16_build.py      # writes authored/worlds/T16.json (deterministic)

Today in the sessions is Wednesday 2026-12-16 18:00 (Victory Day; the factory is shut).
Joint family of nine in Mirpur: Rafiq, wife Nasrin, parents (Abba, Amma), son Tanvir, daughter
Mim, younger brother Shafiq with his wife Farzana and son Arif. Runs the family fund, plays for
and keeps the kitty of the Mirpur Tigers cricket team, and tracks the Eid bonus for the Line 3
staff. Built-in ambiguity: two Rahims (line supervisor, cricket bowler), two Karims (Abba is
Abdul Karim, HR officer Karim Hossain), nicknames (Abba, Amma, Mim, Mizan, Babu, Topu), a
misspelled-looking name (Jewel), two "Team photo" photos, two cardiology check-ups for Abba,
recurring cricket nets and production meetings, near-duplicate tasks ("Buy cricket balls",
monthly bills), cancelled events, completed tasks, people trashed inside and past the 30-day
restore window, an empty group, an empty folder, and groups with and without a currency.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        # family
        {"key": "nasrin", "name": "Nasrin Chowdhury", "role": "wife", "starred": True, "met": "Comilla",
         "last_contacted": "2026-12-16T13:00", "last_contacted_kind": "visit"},
        {"key": "abba", "name": "Abdul Karim Chowdhury", "role": "father", "nickname": "Abba", "starred": True},
        {"key": "amma", "name": "Rokeya Begum", "role": "mother", "nickname": "Amma", "starred": True},
        {"key": "tanvir", "name": "Tanvir Chowdhury", "role": "son, class 9"},
        {"key": "mim", "name": "Sadia Chowdhury", "role": "daughter, class 5", "nickname": "Mim"},
        {"key": "shafiq", "name": "Shafiq Chowdhury", "role": "younger brother", "cadence": 7, "met": "Comilla",
         "last_contacted": "2026-12-14T21:00", "last_contacted_kind": "visit"},
        {"key": "farzana", "name": "Farzana Akter", "role": "sister-in-law, Shafiq's wife"},
        {"key": "arif", "name": "Arif Chowdhury", "role": "nephew"},
        {"key": "rehana", "name": "Rehana Begum", "role": "sister, Sylhet", "cadence": 14, "starred": True,
         "last_contacted": "2026-11-29T20:00", "last_contacted_kind": "call"},
        {"key": "masud", "name": "Masud Chowdhury", "role": "cousin, Dubai", "cadence": 30, "met": "Comilla",
         "last_contacted": "2026-10-30T22:00", "last_contacted_kind": "message"},
        # factory
        {"key": "rahim_u", "name": "Rahim Uddin", "role": "line supervisor, Line 3", "cadence": 7,
         "last_contacted": "2026-12-15T17:30", "last_contacted_kind": "meeting"},
        {"key": "jahanara", "name": "Jahanara Khatun", "role": "quality inspector", "cadence": 7,
         "last_contacted": "2026-12-15T11:00", "last_contacted_kind": "meeting"},
        {"key": "mizan", "name": "Mizanur Rahman", "role": "cutting master", "nickname": "Mizan", "cadence": 14,
         "last_contacted": "2026-12-10T12:00", "last_contacted_kind": "meeting"},
        {"key": "salma", "name": "Salma Begum", "role": "sewing operator, Line 3"},
        {"key": "kamal", "name": "Kamal Hossain", "role": "production manager", "starred": True, "cadence": 7,
         "last_contacted": "2026-12-13T09:00", "last_contacted_kind": "meeting"},
        {"key": "karim_h", "name": "Karim Hossain", "role": "HR officer", "cadence": 14,
         "last_contacted": "2026-12-08T15:00", "last_contacted_kind": "call"},
        {"key": "nazmul", "name": "Nazmul Haque", "role": "maintenance mechanic"},
        {"key": "rubina", "name": "Rubina Akter", "role": "line supervisor, Line 5", "cadence": 14,
         "last_contacted": "2026-12-02T16:00", "last_contacted_kind": "call"},
        {"key": "faruk", "name": "Faruk Ahmed"},
        # cricket
        {"key": "rahim_m", "name": "Rahim Mia", "role": "Mirpur Tigers, fast bowler", "cadence": 7,
         "last_contacted": "2026-12-11T09:30", "last_contacted_kind": "visit"},
        {"key": "sohel", "name": "Sohel Rana", "role": "Mirpur Tigers captain", "cadence": 7, "starred": True,
         "last_contacted": "2026-12-11T09:30", "last_contacted_kind": "visit"},
        {"key": "imran", "name": "Imran Kabir", "role": "Mirpur Tigers, wicketkeeper"},
        {"key": "babu", "name": "Nurul Islam", "role": "Mirpur Tigers, all-rounder", "nickname": "Babu"},
        {"key": "jewel", "name": "Jewel Sarkar", "role": "Mirpur Tigers, opener"},
        {"key": "topu", "name": "Tofazzal Hossain", "nickname": "Topu"},
        # others
        {"key": "ferdousi", "name": "Ferdousi Rahman", "role": "cardiologist, Abba's doctor", "nickname": "Dr. Ferdousi"},
        {"key": "sharmin", "name": "Sharmin Sultana", "role": "Tanvir's maths tutor", "cadence": 30,
         "last_contacted": "2026-11-20T18:00", "last_contacted_kind": "call"},
        {"key": "selim", "name": "Selim Reza", "role": "CNG driver"},
        {"key": "monir", "name": "Moniruzzaman", "role": "electrician", "nickname": "Monir"},
        {"key": "anwar", "name": "Anwar Hossain"},
        # trashed: three inside the 30-day window, one past it
        {"key": "liton", "name": "Liton Das", "role": "old Tigers teammate", "trashed": "2026-12-05T10:00"},
        {"key": "pervez", "name": "Pervez Alam", "role": "ex supervisor, Line 2", "trashed": "2026-12-10T09:00"},
        {"key": "shahin", "name": "Shahin Mollah", "role": "land broker", "trashed": "2026-11-25T19:00"},
        {"key": "delwar", "name": "Delwar Hossain", "role": "old landlord", "trashed": "2026-09-20T10:00"},
    ]


GROUPS = [
    {"key": "fund", "name": "Family fund", "members": ["nasrin", "shafiq", "farzana", "abba"],
     "created": "2026-01-10T10:00"},
    {"key": "tigers", "name": "Mirpur Tigers kitty", "currency": "BDT",
     "members": ["rahim_m", "sohel", "imran", "babu", "jewel"], "created": "2025-10-01T09:00"},
    {"key": "bonus", "name": "Line 3 Eid bonus pool", "currency": "BDT",
     "members": ["rahim_u", "jahanara", "salma", "mizan"], "created": "2026-05-01T10:00"},
    {"key": "coxs", "name": "Cox's Bazar trip", "members": ["shafiq", "masud", "nasrin"],
     "created": "2026-10-20T20:00"},
    {"key": "kolkata", "name": "Kolkata shopping", "currency": "INR", "members": ["shafiq", "farzana"],
     "created": "2026-09-01T10:00"},
    {"key": "picnic", "name": "Factory picnic 2025", "members": ["kamal", "rubina"], "created": "2025-01-05T10:00"},
]

EXPENSES = [
    {"group": "fund", "name": "Abba's medicine", "amount": 4800, "paid_by": "me",
     "split": ["me", "shafiq"], "date": "2026-12-02"},
    {"group": "fund", "name": "Gas bill November", "amount": 1080, "paid_by": "shafiq",
     "split": ["me", "shafiq"], "date": "2026-11-28"},
    {"group": "fund", "name": "Roof repair", "amount": 12000, "paid_by": "me",
     "split": ["me", "shafiq", "abba"], "date": "2026-10-15"},
    {"group": "tigers", "name": "Ground rent December", "amount": 3000, "paid_by": "me",
     "split": ["me", "rahim_m", "sohel", "imran", "babu", "jewel"], "date": "2026-12-04"},
    {"group": "tigers", "name": "New balls", "amount": 1800, "paid_by": "sohel",
     "split": ["me", "rahim_m", "sohel", "jewel"], "date": "2026-12-11"},
    {"group": "bonus", "name": "Sweets for the line", "amount": 2400, "paid_by": "me",
     "split": ["me", "rahim_u", "jahanara", "salma"], "date": "2026-06-10"},
    {"group": "bonus", "name": "Gift for Salma's wedding", "amount": 2000, "paid_by": "rahim_u",
     "split": ["me", "rahim_u", "jahanara", "mizan"], "date": "2026-11-18"},
    {"group": "coxs", "name": "Hotel advance", "amount": 9000, "paid_by": "masud",
     "split": ["me", "shafiq", "masud"], "date": "2026-11-05"},
    {"group": "kolkata", "name": "Saree shopping", "amount": 6400, "paid_by": "farzana",
     "split": ["me", "farzana"], "date": "2026-09-14", "currency": "INR"},
]

LISTS = [
    {"key": "home_l", "name": "Home", "area": "family"},
    {"key": "factory_l", "name": "Factory", "area": "work"},
    {"key": "cricket_l", "name": "Cricket", "area": "sport"},
    {"key": "kids_l", "name": "Kids school", "area": "family"},
    {"key": "shopping_l", "name": "Shopping"},
    {"key": "health_l", "name": "Abba's health", "area": "health"},
]


def events():
    out = []
    # cricket nets, Friday mornings
    d = date(2026, 10, 2)
    while d <= date(2027, 1, 29):
        ev = {"key": f"nets_{d.strftime('%m%d')}", "name": "Tigers net practice", "start": f"{d}T07:00",
              "end": f"{d}T09:00", "attendees": ["sohel", "rahim_m"], "description": "Mirpur indoor stadium"}
        if d == date(2026, 11, 20):
            ev["cancelled"] = "2026-11-18T20:00"
        if d == date(2026, 12, 18):
            ev["end"] = f"{d}T08:30"  # match that day at 10
        out.append(ev)
        d += timedelta(weeks=1)
    # weekly production meeting, Sunday mornings
    d = date(2026, 11, 1)
    while d <= date(2027, 1, 24):
        ev = {"key": f"prod_{d.strftime('%m%d')}", "name": "Weekly production meeting", "start": f"{d}T09:00",
              "end": f"{d}T10:00", "attendees": ["kamal", "rahim_u", "rubina"], "description": "conference room 2"}
        if d == date(2026, 12, 27):
            ev["cancelled"] = "2026-12-15T12:00"
        out.append(ev)
        d += timedelta(weeks=1)
    out += [
        # family
        {"key": "victory_lunch", "name": "Victory Day family lunch", "start": "2026-12-16T13:00",
         "end": "2026-12-16T15:00", "attendees": ["nasrin", "abba", "amma", "shafiq", "farzana"]},
        {"key": "cardio_nov", "name": "Cardiology check-up for Abba", "start": "2026-11-12T17:00",
         "end": "2026-11-12T18:00", "attendees": ["abba", "ferdousi"], "description": "Ibn Sina Dhanmondi"},
        {"key": "cardio_jan", "name": "Cardiology check-up for Abba", "start": "2027-01-14T17:00",
         "end": "2027-01-14T18:00", "attendees": ["abba", "ferdousi"], "description": "Ibn Sina Dhanmondi"},
        {"key": "echo_test", "name": "Abba's echo test", "start": "2026-12-22T08:30", "end": "2026-12-22T09:30",
         "attendees": ["abba"], "description": "fasting, bring old reports"},
        {"key": "ptm_mim", "name": "Mim's parent-teacher meeting", "start": "2026-12-19T11:00",
         "end": "2026-12-19T12:00", "attendees": ["mim", "nasrin"]},
        {"key": "tanvir_result", "name": "Tanvir's result day", "start": "2026-12-30T10:00",
         "end": "2026-12-30T11:00", "attendees": ["tanvir"]},
        {"key": "tutor_meet", "name": "Meet Tanvir's tutor", "start": "2026-12-17T19:00", "end": "2026-12-17T19:30",
         "attendees": ["sharmin", "tanvir"]},
        {"key": "holud", "name": "Arif's cousin's gaye holud", "start": "2026-12-24T18:00", "end": "2026-12-24T22:00",
         "attendees": ["shafiq", "farzana", "arif"]},
        {"key": "wedding", "name": "Wedding in Comilla", "start": "2026-12-26T12:00", "end": "2026-12-26T20:00",
         "attendees": ["shafiq", "farzana", "nasrin", "amma"], "description": "bus from Sayedabad at 7"},
        {"key": "rehana_visit", "name": "Rehana apa visiting", "start": "2027-01-08T15:00", "end": "2027-01-08T20:00",
         "attendees": ["rehana"]},
        {"key": "masud_call", "name": "Call with Masud", "start": "2026-12-20T21:00", "end": "2026-12-20T21:30",
         "attendees": ["masud"]},
        {"key": "coxs_trip", "name": "Cox's Bazar trip", "start": "2027-01-21T06:00", "end": "2027-01-21T12:00",
         "attendees": ["shafiq", "masud", "nasrin"], "description": "Green Line bus, Arambagh counter"},
        {"key": "pitha", "name": "Pitha festival at Mim's school", "start": "2027-01-09T10:00",
         "end": "2027-01-09T13:00", "attendees": ["mim"]},
        {"key": "boishakh", "name": "Shopping for winter clothes", "start": "2026-12-12T16:00",
         "end": "2026-12-12T19:00", "attendees": ["nasrin", "mim"]},
        {"key": "eid_adha", "name": "Eid al-Adha prayer", "start": "2026-05-27T07:30", "end": "2026-05-27T08:30",
         "attendees": ["abba", "tanvir", "shafiq"]},
        {"key": "doctor_amma", "name": "Amma's eye doctor", "start": "2026-12-03T16:00", "end": "2026-12-03T17:00",
         "attendees": ["amma"], "cancelled": "2026-12-01T10:00"},
        {"key": "dentist_mim", "name": "Dentist for Mim", "start": "2026-11-26T17:30", "end": "2026-11-26T18:00",
         "attendees": ["mim"], "trashed": "2026-11-24T09:00"},
        # factory
        {"key": "buyer_audit", "name": "H&M buyer audit", "start": "2026-12-21T10:00", "end": "2026-12-21T14:00",
         "attendees": ["kamal", "jahanara"], "description": "compliance walk, Line 3 and Line 5"},
        {"key": "fire_drill", "name": "Fire drill", "start": "2026-12-23T11:00", "end": "2026-12-23T12:00",
         "attendees": ["faruk", "nazmul"], "description": "all floors"},
        {"key": "fire_drill_nov", "name": "Fire drill", "start": "2026-11-18T11:00", "end": "2026-11-18T12:00",
         "attendees": ["faruk", "nazmul"], "description": "all floors"},
        {"key": "bonus_meet", "name": "Eid bonus meeting with HR", "start": "2027-01-06T15:00",
         "end": "2027-01-06T16:00", "attendees": ["karim_h", "kamal"]},
        {"key": "line3_review", "name": "Line 3 efficiency review", "start": "2026-12-17T14:00",
         "end": "2026-12-17T15:00", "attendees": ["rahim_u", "kamal"]},
        {"key": "machine_service", "name": "Overlock machine servicing", "start": "2026-12-19T08:00",
         "end": "2026-12-19T10:00", "attendees": ["nazmul"]},
        {"key": "quality_training", "name": "Quality training for new operators", "start": "2026-12-28T14:00",
         "end": "2026-12-28T16:00", "attendees": ["jahanara", "salma"], "description": "Line 3 training room"},
        {"key": "shipment", "name": "Shipment cut-off", "start": "2026-12-29T17:00", "end": "2026-12-29T18:00",
         "attendees": ["kamal"]},
        {"key": "safety_walk", "name": "Safety walk with Kamal bhai", "start": "2026-12-10T10:00",
         "end": "2026-12-10T11:00", "attendees": ["kamal"]},
        {"key": "salma_wedding", "name": "Salma's wedding", "start": "2026-11-20T18:00", "end": "2026-11-20T22:00",
         "attendees": ["salma", "rahim_u", "jahanara"]},
        {"key": "picnic_ev", "name": "Factory picnic", "start": "2027-02-05T08:00", "end": "2027-02-05T18:00",
         "attendees": ["kamal", "rubina"], "description": "Gazipur resort"},
        # cricket
        {"key": "match_uttara", "name": "Match vs Uttara Strikers", "start": "2026-12-18T10:00",
         "end": "2026-12-18T16:00", "attendees": ["sohel", "rahim_m", "imran", "babu", "jewel"],
         "description": "Mirpur indoor stadium"},
        {"key": "match_final", "name": "Winter cup final", "start": "2027-01-01T10:00", "end": "2027-01-01T16:00",
         "attendees": ["sohel", "rahim_m", "imran", "babu", "jewel"], "description": "Abahani ground"},
        {"key": "match_dhanmondi", "name": "Match vs Dhanmondi XI", "start": "2026-12-05T10:00",
         "end": "2026-12-05T16:00", "attendees": ["sohel", "rahim_m", "imran"], "description": "Abahani ground"},
        {"key": "team_dinner", "name": "Tigers team dinner", "start": "2026-12-18T20:00", "end": "2026-12-18T22:00",
         "attendees": ["sohel", "rahim_m", "babu"]},
        {"key": "kit_pickup", "name": "Collect new jerseys", "start": "2026-12-17T17:00", "end": "2026-12-17T18:00",
         "attendees": ["imran"], "cancelled": "2026-12-16T11:00"},
        {"key": "tea_topu", "name": "Tea with Topu", "start": "2026-12-20T17:00", "end": "2026-12-20T18:00",
         "attendees": ["topu"]},
        {"key": "bank_visit", "name": "Bank visit for DPS", "start": "2026-12-22T11:00", "end": "2026-12-22T12:00"},
        {"key": "electrician", "name": "Electrician for the meter", "start": "2026-12-20T10:00",
         "end": "2026-12-20T11:00", "attendees": ["monir"]},
    ]
    return out


def tasks():
    t = [
        # home
        {"key": "gas_bill", "name": "Pay Titas gas bill", "due": "2026-12-20", "list": "home_l", "effort": 15},
        {"key": "roof", "name": "Check the roof leak after rain", "completed": "2026-10-20T10:00", "list": "home_l"},
        {"key": "water_pump", "name": "Fix the water pump", "due": "2026-12-18", "priority": 1, "list": "home_l",
         "effort": 60, "description": "motor hums but no water, call Monir"},
        {"key": "blanket", "name": "Buy blankets for the village", "due": "2026-12-24", "list": "shopping_l",
         "priority": 2, "description": "ten blankets for the Comilla house"},
        {"key": "rice", "name": "Order rice sack", "due": "2026-12-19", "list": "shopping_l", "effort": 10},
        {"key": "fridge", "name": "Get the fridge repaired", "trashed": "2026-12-08T09:00", "list": "home_l"},
        {"key": "paint", "name": "Paint the front gate", "trashed": "2026-10-01T09:00"},
        {"key": "land_tax", "name": "Pay land tax for Comilla plot", "due": "2026-12-31", "priority": 2, "list": "home_l"},
        {"key": "dps", "name": "Renew DPS at the bank", "due": "2026-12-22", "priority": 1, "effort": 45},
        {"key": "bkash", "name": "Send money to Rehana apa", "due": "2026-12-17", "effort": 5},
        {"key": "nid_amma", "name": "Correct Amma's NID spelling", "status": "in_progress", "effort": 120,
         "description": "election office Mirpur 10, bring birth certificate"},
        {"key": "wedding_gift", "name": "Buy wedding gift for Comilla", "due": "2026-12-23", "list": "shopping_l",
         "effort": 60},
        # kids
        {"key": "tanvir_fee", "name": "Pay Tanvir's coaching fee", "due": "2026-12-05", "completed": "2026-12-04T19:00",
         "list": "kids_l"},
        {"key": "tanvir_fee_jan", "name": "Pay Tanvir's coaching fee", "due": "2027-01-05", "list": "kids_l"},
        {"key": "mim_books", "name": "Buy Mim's new class books", "due": "2027-01-02", "list": "kids_l", "effort": 90},
        {"key": "mim_uniform", "name": "Mim's school uniform", "due": "2027-01-02", "list": "kids_l",
         "status": "cancelled"},
        {"key": "admission", "name": "Tanvir's college admission form", "due": "2027-01-15", "list": "kids_l",
         "priority": 1, "effort": 60},
        {"key": "science_fair", "name": "Help Mim with science fair project", "due": "2026-11-30",
         "completed": "2026-11-29T21:00", "list": "kids_l"},
        # health
        {"key": "abba_meds", "name": "Refill Abba's heart medicine", "due": "2026-12-18", "priority": 1,
         "list": "health_l", "effort": 20},
        {"key": "abba_reports", "name": "Collect Abba's blood reports", "due": "2026-12-21", "list": "health_l"},
        {"key": "bp_machine", "name": "Buy BP machine", "completed": "2026-11-15T12:00", "list": "health_l"},
        {"key": "amma_glasses", "name": "Amma's new glasses", "status": "in_progress", "list": "health_l"},
        # factory
        {"key": "bonus_sheet", "name": "Eid bonus sheet for Line 3", "due": "2027-01-10", "priority": 1,
         "status": "in_progress", "list": "factory_l", "effort": 180,
         "description": "basic plus attendance, check with HR"},
        {"key": "attendance", "name": "Pull attendance records", "parent": "bonus_sheet", "due": "2026-12-28",
         "effort": 60},
        {"key": "hr_check", "name": "Check rates with Karim bhai", "parent": "bonus_sheet", "due": "2027-01-04",
         "effort": 30},
        {"key": "bonus_sign", "name": "Get Kamal bhai's signature", "parent": "bonus_sheet", "due": "2027-01-08"},
        {"key": "audit_prep", "name": "Prepare Line 3 for buyer audit", "due": "2026-12-20", "priority": 1,
         "list": "factory_l", "effort": 240, "description": "fire exits clear, needle log updated"},
        {"key": "needle_log", "name": "Update the broken needle log", "due": "2026-12-19", "list": "factory_l",
         "effort": 30, "description": "needle log for Line 3 and Line 5"},
        {"key": "overtime", "name": "Submit overtime list", "due": "2026-12-17", "list": "factory_l", "effort": 20},
        {"key": "overtime_nov", "name": "Submit overtime list for November", "due": "2026-11-30",
         "completed": "2026-11-30T17:00", "list": "factory_l"},
        {"key": "new_ops", "name": "Train new operators on overlock", "status": "in_progress", "list": "factory_l",
         "effort": 300},
        {"key": "lighting", "name": "Report broken tube lights on Line 5", "due": "2026-12-15",
         "completed": "2026-12-14T10:00", "list": "factory_l"},
        {"key": "ppe", "name": "Order masks and gloves", "due": "2026-12-22", "list": "factory_l", "priority": 3},
        {"key": "salma_leave", "name": "Approve Salma's leave", "due": "2026-12-18", "effort": 5},
        {"key": "target_chart", "name": "Put up the daily target chart", "list": "factory_l",
         "description": "whiteboard by the Line 3 entrance"},
        # cricket
        {"key": "balls_1", "name": "Buy cricket balls", "due": "2026-12-17", "list": "cricket_l", "effort": 30},
        {"key": "balls_2", "name": "Buy cricket balls", "due": "2026-11-12", "completed": "2026-11-11T18:00",
         "list": "cricket_l"},
        {"key": "jerseys", "name": "Order team jerseys", "due": "2026-12-10", "completed": "2026-12-09T20:00",
         "list": "cricket_l"},
        {"key": "ground_book", "name": "Book Abahani ground for the final", "due": "2026-12-20", "priority": 2,
         "list": "cricket_l"},
        {"key": "fixtures", "name": "Make the fixture list", "list": "cricket_l", "status": "in_progress",
         "description": "winter cup fixtures for the notice board"},
        {"key": "kitty_collect", "name": "Collect kitty from the team", "due": "2026-12-18", "list": "cricket_l",
         "effort": 15},
        {"key": "scorebook", "name": "Buy a new scorebook", "list": "cricket_l", "trashed": "2026-12-12T09:00"},
        # misc
        {"key": "tv_bill", "name": "Pay the dish line bill", "due": "2026-12-10", "effort": 5},
        {"key": "cng_fare", "name": "Fix a monthly rate with Selim", "cancelled": True, "status": "cancelled"},
        {"key": "phone", "name": "Recharge Abba's phone", "due": "2026-12-16", "effort": 5},
        {"key": "passport", "name": "Renew my passport", "due": "2027-02-28", "priority": 3, "effort": 120},
        {"key": "tickets", "name": "Book bus tickets for Cox's Bazar", "due": "2026-12-28", "priority": 2,
         "effort": 30, "description": "Green Line, five seats"},
    ]
    # electricity bill (DESCO), monthly on the 12th
    for m in range(8, 13):
        t.append({"key": f"desco_{m:02d}", "name": "Pay DESCO electricity bill", "due": f"2026-{m:02d}-12",
                  "completed": f"2026-{m:02d}-11T20:00", "list": "home_l"})
    t.append({"key": "desco_01", "name": "Pay DESCO electricity bill", "due": "2027-01-12", "list": "home_l"})
    # house help salary, monthly on the 1st
    for m in (10, 11, 12):
        t.append({"key": f"bua_{m:02d}", "name": "Pay Bua's salary", "due": f"2026-{m:02d}-01",
                  "completed": f"2026-{m:02d}-01T09:00"})
    t.append({"key": "bua_01", "name": "Pay Bua's salary", "due": "2027-01-01"})
    for x in t:
        x.pop("cancelled", None)
    return t


NOTEBOOKS = [
    {"key": "factory_nb", "name": "Factory floor"},
    {"key": "cricket_nb", "name": "Cricket"},
    {"key": "recipes_nb", "name": "Amma's recipes"},
    {"key": "fund_nb", "name": "Family fund"},
    {"key": "eid24_nb", "name": "Eid 2024"},
    {"key": "eid25_nb", "name": "Eid 2025"},
]

NOTES = [
    {"key": "line3_targets", "name": "Line 3 targets", "body": "1200 pieces per shift, polo shirts, 22 operators",
     "notebook": "factory_nb", "created": "2026-12-01T09:00", "pinned": True},
    {"key": "audit_list", "name": "Audit checklist", "body": "fire exits, first aid box, needle log, child care room",
     "notebook": "factory_nb", "created": "2026-12-08T10:00"},
    {"key": "operators", "name": "New operators", "body": "Salma to train Rina and Shirin on the overlock",
     "notebook": "factory_nb", "created": "2026-11-25T15:00"},
    {"key": "bonus_rates", "name": "Bonus rates", "body": "operators half of basic, supervisors 60 percent, helpers 3000",
     "notebook": "factory_nb", "created": "2026-11-10T16:00"},
    {"key": "rahim_feedback", "name": "Feedback for Rahim", "body": "good on output, needs to handle absences earlier",
     "notebook": "factory_nb", "created": "2026-12-15T18:00"},
    {"key": "batting", "name": "Batting order", "body": "Jewel, Imran, Sohel, me, Babu; Rahim bowls first over",
     "notebook": "cricket_nb", "created": "2026-12-11T21:00", "pinned": True},
    {"key": "kitty_rules", "name": "Kitty rules", "body": "500 per month each, balls and ground rent come out first",
     "notebook": "cricket_nb", "created": "2026-10-01T20:00"},
    {"key": "uttara_scout", "name": "Uttara Strikers", "body": "left arm spinner, weak against short ball",
     "notebook": "cricket_nb", "created": "2026-12-14T22:00"},
    {"key": "shutki", "name": "Shutki bhuna", "body": "soak the dried fish, lots of onion and green chilli",
     "notebook": "recipes_nb", "created": "2026-08-10T12:00"},
    {"key": "pitha_recipe", "name": "Bhapa pitha", "body": "rice flour, date molasses, steam in a cloth",
     "notebook": "recipes_nb", "created": "2026-12-02T19:00", "pinned": True},
    {"key": "khichuri", "name": "Bhuna khichuri", "body": "moong dal roasted first, beef on Fridays",
     "notebook": "recipes_nb", "created": "2026-09-05T13:00"},
    {"key": "fund_rules", "name": "Fund rules", "body": "each brother 5000 a month, Abba's medicine first",
     "notebook": "fund_nb", "created": "2026-01-10T10:30"},
    {"key": "fund_dec", "name": "December fund summary", "body": "in 10000, medicine 4800, gas 1080",
     "notebook": "fund_nb", "created": "2026-12-14T21:30"},
    {"key": "eid24_gifts", "name": "Eid gifts 2024", "body": "panjabi for Abba, saree for Amma",
     "notebook": "eid24_nb", "created": "2024-04-05T20:00"},
    {"key": "eid25_gifts", "name": "Eid gifts 2025", "body": "shoes for Tanvir, dress for Mim",
     "notebook": "eid25_nb", "created": "2025-03-25T20:00"},
    {"key": "eid25_list", "name": "Eid bazar list", "body": "semai, sugar, milk, dates", "notebook": "eid25_nb",
     "created": "2025-03-26T20:00"},
    {"key": "tanvir_marks", "name": "Tanvir's marks", "body": "maths 72, physics 80, english 65",
     "created": "2026-11-28T20:00"},
    {"key": "wifi_note", "name": "Router notes", "body": "Link3 connection, restart the box under the stairs",
     "created": "2026-07-01T10:00"},
    {"key": "gift_ideas", "name": "Gift ideas", "body": "Nasrin: gold earrings; Mim: a bicycle", "created": "2026-12-06T22:00"},
    {"key": "meeting_rahim", "name": "Chat with Rahim and Jahanara", "body": "rework rate on Line 3 up to 6 percent",
     "created": "2026-12-09T17:00"},
    {"key": "comilla_trip", "name": "Comilla plan", "body": "bus at 7, gift, blankets, meet Anwar chacha",
     "created": "2026-12-13T22:00"},
    {"key": "abba_diet", "name": "Abba's diet", "body": "low salt, no beef, walk after asr", "created": "2026-11-13T09:00"},
    {"key": "old_plan", "name": "Old flat plan", "body": "3 rooms in Pallabi, 25000 rent", "created": "2025-12-01T10:00",
     "trashed": "2026-12-01T10:00"},
    {"key": "old_scores", "name": "Old scores", "body": "2024 season", "created": "2024-12-01T10:00",
     "trashed": "2026-10-15T10:00"},
]

FOLDERS = [
    {"key": "house_f", "name": "House papers"},
    {"key": "factory_f", "name": "Factory"},
    {"key": "medical_f", "name": "Medical"},
    {"key": "school_f", "name": "School"},
    {"key": "bank_f", "name": "Bank"},
    {"key": "misc_f", "name": "Misc"},
]

DOCUMENTS = [
    {"key": "deed", "name": "Comilla land deed", "folder": "house_f", "starred": True, "created": "2024-02-10T10:00"},
    {"key": "mutation", "name": "Land mutation paper", "folder": "house_f", "created": "2025-06-05T10:00"},
    {"key": "gas_card", "name": "Titas gas card", "folder": "house_f", "created": "2026-01-15T10:00"},
    {"key": "payslip_nov", "name": "Salary sheet November", "folder": "factory_f", "created": "2026-12-01T11:00"},
    {"key": "payslip_oct", "name": "Salary sheet October", "folder": "factory_f", "created": "2026-11-01T11:00"},
    {"key": "appointment", "name": "Appointment letter", "folder": "factory_f", "starred": True,
     "created": "2019-03-01T10:00"},
    {"key": "audit_report", "name": "Last audit report", "folder": "factory_f", "created": "2026-06-20T10:00"},
    {"key": "ecg", "name": "Abba's ECG report", "folder": "medical_f", "created": "2026-11-12T19:00"},
    {"key": "prescription", "name": "Abba's prescription", "folder": "medical_f", "starred": True,
     "created": "2026-11-12T19:10"},
    {"key": "blood_report", "name": "Abba's blood report", "folder": "medical_f", "created": "2026-10-02T12:00"},
    {"key": "tanvir_admit", "name": "Tanvir's admit card", "folder": "school_f", "created": "2026-11-20T18:00"},
    {"key": "mim_report", "name": "Mim's report card", "folder": "school_f", "created": "2026-12-10T17:00"},
    {"key": "dps_paper", "name": "DPS statement", "folder": "bank_f", "created": "2026-12-01T10:00"},
    {"key": "tin", "name": "TIN certificate", "folder": "bank_f", "created": "2024-11-20T10:00"},
    {"key": "tax_return", "name": "Tax return 2026", "created": "2026-11-29T21:00"},
    {"key": "bus_tickets", "name": "Green Line e-ticket", "created": "2026-12-15T22:00"},
    {"key": "tigers_fixtures", "name": "Winter cup fixtures", "created": "2026-11-30T20:00"},
    {"key": "scan_a", "name": "Scan 0012", "created": "2026-12-14T20:00"},
    {"key": "scan_b", "name": "Scan 0013", "created": "2026-12-14T20:01"},
    {"key": "old_lease", "name": "Old lease Pallabi", "folder": "house_f", "created": "2023-01-01T10:00",
     "trashed": "2026-12-03T10:00"},
]

ALBUMS = [
    {"key": "tigers_album", "name": "Tigers 2026"},
    {"key": "family_album", "name": "Family"},
    {"key": "victory_album", "name": "Victory Day"},
    {"key": "factory_album", "name": "Factory floor"},
    {"key": "comilla_album", "name": "Comilla"},
    {"key": "wedding_album", "name": "Salma's wedding"},
    {"key": "empty_album", "name": "Cox's Bazar 2027"},
]

PHOTOS = [
    {"key": "team_2025", "name": "Team photo", "taken": "2025-12-20T16:30", "albums": ["tigers_album"],
     "people": ["sohel", "rahim_m", "liton"], "starred": True},
    {"key": "team_2026", "name": "Team photo", "taken": "2026-12-05T16:30", "albums": ["tigers_album", "family_album"],
     "people": ["sohel", "rahim_m", "imran", "babu", "jewel"]},
    {"key": "trophy", "name": "Trophy lift", "taken": "2026-02-14T17:00", "albums": ["tigers_album"],
     "people": ["sohel"], "starred": True},
    {"key": "rahim_wickets", "name": "Rahim's five wickets", "taken": "2026-12-05T14:10", "albums": ["tigers_album"],
     "people": ["rahim_m"]},
    {"key": "nets_rain", "name": "Nets in the rain", "taken": "2026-10-09T08:00", "albums": ["tigers_album"]},
    {"key": "scoreboard", "name": "Scoreboard vs Dhanmondi", "taken": "2026-12-05T15:50", "albums": ["tigers_album"]},
    {"key": "victory_flag", "name": "Flag on the roof", "taken": "2026-12-16T08:00", "albums": ["victory_album"],
     "people": ["tanvir", "mim"], "starred": True},
    {"key": "victory_lunch_p", "name": "Victory Day lunch", "taken": "2026-12-16T14:00",
     "albums": ["victory_album", "family_album"], "people": ["abba", "amma", "nasrin"]},
    {"key": "smriti", "name": "Smriti Soudho at dawn", "taken": "2026-12-16T06:30", "albums": ["victory_album"]},
    {"key": "victory_2025", "name": "Parade 2025", "taken": "2025-12-16T09:00", "albums": ["victory_album"]},
    {"key": "abba_amma", "name": "Abba and Amma on the veranda", "taken": "2026-11-01T17:00",
     "albums": ["family_album"], "people": ["abba", "amma"], "starred": True},
    {"key": "mim_prize", "name": "Mim's science prize", "taken": "2026-11-30T12:00", "albums": ["family_album"],
     "people": ["mim"]},
    {"key": "tanvir_bat", "name": "Tanvir batting", "taken": "2026-11-06T08:30", "albums": ["family_album", "tigers_album"],
     "people": ["tanvir"]},
    {"key": "family_dinner", "name": "Nine at the table", "taken": "2026-10-03T21:00", "albums": ["family_album"],
     "people": ["nasrin", "abba", "amma", "shafiq", "farzana", "arif"]},
    {"key": "arif_bday", "name": "Arif's birthday cake", "taken": "2026-09-18T20:00", "albums": ["family_album"],
     "people": ["arif", "farzana"]},
    {"key": "line3_team", "name": "Line 3 team", "taken": "2026-06-10T13:00", "albums": ["factory_album"],
     "people": ["rahim_u", "jahanara", "salma"], "starred": True},
    {"key": "target_board", "name": "Target board", "taken": "2026-12-14T10:00", "albums": ["factory_album"]},
    {"key": "fire_drill_p", "name": "Fire drill assembly", "taken": "2026-11-18T11:20", "albums": ["factory_album"],
     "people": ["faruk"]},
    {"key": "new_machines", "name": "New overlock machines", "taken": "2026-12-09T09:00", "albums": ["factory_album"],
     "people": ["nazmul"]},
    {"key": "comilla_pond", "name": "Pond at the village house", "taken": "2026-10-24T16:00", "albums": ["comilla_album"],
     "starred": True},
    {"key": "comilla_paddy", "name": "Paddy harvest", "taken": "2026-10-25T09:00", "albums": ["comilla_album"]},
    {"key": "comilla_anwar", "name": "Anwar chacha at the mosque", "taken": "2026-10-25T13:00",
     "albums": ["comilla_album"], "people": ["anwar"]},
    {"key": "salma_stage", "name": "Salma on stage", "taken": "2026-11-20T19:30", "albums": ["wedding_album"],
     "people": ["salma"]},
    {"key": "wedding_group", "name": "Line 3 at the wedding", "taken": "2026-11-20T20:10",
     "albums": ["wedding_album", "factory_album"], "people": ["salma", "rahim_u", "jahanara"]},
    {"key": "rickshaw", "name": "Rickshaw art", "taken": "2026-12-12T17:00"},
    {"key": "winter_market", "name": "Winter market in Mirpur", "taken": "2026-12-12T18:00",
     "people": ["nasrin", "mim"]},
    {"key": "fog", "name": "Fog on the Turag", "taken": "2026-12-15T06:45", "starred": True},
    {"key": "sunset_roof", "name": "Sunset from the roof", "taken": "2026-12-14T17:20"},
    {"key": "tutor_note", "name": "Photo of tutor's note", "taken": "2026-12-11T19:00"},
    {"key": "receipt_balls", "name": "Receipt for balls", "taken": "2026-12-11T18:30"},
    {"key": "old_team", "name": "Old team 2019", "taken": "2019-12-01T16:00", "people": ["liton", "sohel"]},
    {"key": "blurry_1", "name": "Blurry catch", "taken": "2026-12-05T13:00", "trashed": "2026-12-06T09:00"},
    {"key": "blurry_2", "name": "Blurry fireworks", "taken": "2025-12-31T23:59", "trashed": "2026-12-12T09:00"},
    {"key": "blurry_3", "name": "Blurry bus window", "taken": "2026-10-24T08:00", "trashed": "2026-10-30T09:00"},
]

DEBTS = [
    {"key": "d_shafiq", "person": "shafiq", "direction": "owes_me", "amount": 5000, "name": "Motorbike repair",
     "date": "2026-11-22"},
    {"key": "d_babu", "person": "babu", "direction": "owes_me", "amount": 500, "name": "Kitty for November",
     "date": "2026-11-01"},
    {"key": "d_jewel", "person": "jewel", "direction": "owes_me", "amount": 500, "name": "Kitty for December",
     "date": "2026-12-01"},
    {"key": "d_imran", "person": "imran", "direction": "owes_me", "amount": 800, "name": "Wicketkeeping gloves",
     "date": "2026-12-07"},
    {"key": "d_masud", "person": "masud", "direction": "i_owe", "amount": 3000, "name": "Hotel share Cox's Bazar",
     "date": "2026-11-05"},
    {"key": "d_mizan", "person": "mizan", "direction": "i_owe", "amount": 1200, "name": "Lunch for the cutting section",
     "date": "2026-12-09"},
    {"key": "d_selim", "person": "selim", "direction": "i_owe", "amount": 350, "name": "CNG fare to Gazipur",
     "date": "2026-12-14"},
    {"key": "d_rahim_u", "person": "rahim_u", "direction": "owes_me", "amount": 2000, "name": "Advance for his mother's operation",
     "date": "2026-10-12"},
    {"key": "d_topu", "person": "topu", "direction": "owes_me", "amount": 1500, "name": "Bat from Bangabazar",
     "date": "2026-09-20", "settled": "2026-10-10T18:00"},
    {"key": "d_farzana", "person": "farzana", "direction": "i_owe", "amount": 700, "name": "Pitha ingredients",
     "date": "2026-12-02", "settled": "2026-12-05T20:00"},
    {"key": "d_monir", "person": "monir", "direction": "i_owe", "amount": 600, "name": "Fan wiring",
     "date": "2026-12-15"},
    {"key": "d_sohel", "person": "sohel", "direction": "i_owe", "amount": 400, "name": "Tea and singara after nets",
     "date": "2026-12-11"},
]

LOCKER = [
    {"key": "gmail", "name": "Gmail", "type": "login", "username": "rafiq.chowdhury78@gmail.com",
     "url": "https://mail.google.com", "password": "Comilla-1978!", "starred": True},
    {"key": "erp", "name": "Factory ERP", "type": "login", "username": "rafiq.fm",
     "url": "https://erp.factory.local", "password": "Line3-Target-1200", "notes": "work"},
    {"key": "bkash_l", "name": "bKash", "type": "login", "username": "01711-000000", "url": "https://www.bkash.com",
     "password": "58213", "notes": "personal"},
    {"key": "dbbl", "name": "DBBL internet banking", "type": "login", "username": "rafiqc",
     "url": "https://ibanking.dutchbanglabank.com", "password": "Tigers-Pace-11"},
    {"key": "debit_card", "name": "DBBL Nexus card", "type": "card", "card_number": "6011 2233 4455 6677", "cvv": "412",
     "starred": True},
    {"key": "locker_code", "name": "Almirah lock", "type": "note", "notes": "4-7-1-9, key under the prayer mat"},
    {"key": "nid", "name": "National ID", "type": "identity", "password": "19781203"},
    {"key": "wifi", "name": "Home wifi", "type": "wifi", "password": "mirpur-tigers-2026"},
    {"key": "pc_pass", "name": "Office PC password", "type": "password", "password": "Overlock#5"},
    {"key": "server_key", "name": "ERP server key", "type": "ssh_key", "notes": "IT gave it for the reports",
     "password": "ssh-ed25519 AAAAC3-erp-reports"},
    {"key": "sms_api", "name": "Attendance SMS API", "type": "api_credential", "notes": "work",
     "password": "sms-gw-7781"},
    {"key": "passport_l", "name": "Bangladesh passport", "type": "passport", "notes": "expires March 2027"},
    {"key": "savings", "name": "Sonali Bank savings", "type": "bank_account", "notes": "family fund account"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence", "notes": "motorbike, BRTA Mirpur"},
    {"key": "office_key", "name": "Office 2021 key", "type": "software_licence", "password": "O21-RAFQ-7788"},
    {"key": "crypto", "name": "Masud's crypto wallet", "type": "crypto_wallet", "notes": "USDT from Masud, seed in almirah"},
    {"key": "club_card", "name": "Mirpur club membership", "type": "membership", "notes": "Tigers ground access",
     "starred": True},
    {"key": "deed_copy", "name": "Land deed copy", "type": "document", "notes": "certified copy, Comilla registry"},
    {"key": "old_yahoo", "name": "Old Yahoo mail", "type": "login", "username": "rafiq_78", "url": "https://mail.yahoo.com",
     "password": "garments99", "trashed": "2026-12-09T09:00"},
]

LINKS = [
    {"from": "water_pump", "to": "monir"},
    {"from": "bkash", "to": "rehana"},
    {"from": "nid_amma", "to": "amma"},
    {"from": "tanvir_fee_jan", "to": "tanvir"},
    {"from": "admission", "to": "tanvir"},
    {"from": "mim_books", "to": "mim"},
    {"from": "abba_meds", "to": "abba"},
    {"from": "abba_reports", "to": "abba"},
    {"from": "bonus_sheet", "to": "karim_h"},
    {"from": "bonus_sheet", "to": "kamal"},
    {"from": "hr_check", "to": "karim_h"},
    {"from": "audit_prep", "to": "rahim_u"},
    {"from": "audit_prep", "to": "jahanara"},
    {"from": "new_ops", "to": "salma"},
    {"from": "salma_leave", "to": "salma"},
    {"from": "kitty_collect", "to": "babu"},
    {"from": "kitty_collect", "to": "jewel"},
    {"from": "ground_book", "to": "sohel"},
    {"from": "tickets", "to": "shafiq"},
    {"from": "phone", "to": "abba"},
    {"from": "rahim_feedback", "to": "rahim_u"},
    {"from": "meeting_rahim", "to": "rahim_u"},
    {"from": "meeting_rahim", "to": "jahanara"},
    {"from": "audit_list", "to": "jahanara"},
    {"from": "operators", "to": "salma"},
    {"from": "batting", "to": "sohel"},
    {"from": "batting", "to": "jewel"},
    {"from": "uttara_scout", "to": "rahim_m"},
    {"from": "tanvir_marks", "to": "tanvir"},
    {"from": "abba_diet", "to": "abba"},
    {"from": "comilla_trip", "to": "anwar"},
    {"from": "gift_ideas", "to": "nasrin"},
    {"from": "gift_ideas", "to": "mim"},
    {"from": "fund_dec", "to": "shafiq"},
]


def world():
    return {
        "me": "Rafiq Chowdhury",
        "epoch": "2023-01-01T09:00",
        "seed": "T16",
        "currency": "BDT",
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
    out = HERE / "T16.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
