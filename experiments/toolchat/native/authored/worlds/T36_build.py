"""World T36: Dev and Anjali Mehra's household vault (Pune, newly married, INR vault).

    python3 authored/worlds/T36_build.py      # writes authored/worlds/T36.json (deterministic)

Today in the sessions is Wednesday 2026-12-09 21:15 (home in Baner after a late sprint planning).

Persona: Dev Mehra, 33, a software engineer in Pune (the vault is his phone; his wife Anjali, 33, a
product designer, is in it as a person with a nickname and shares most of it). They married on Sunday
2026-11-22 in Pune and are settling into a rented flat in Baner. Two sets of parents: his in Chandigarh
(Papa and Mummy) and hers in Kothrud (Baba and Aai). The wedding was paid for by a handful of relatives
and friends, so the group "Wedding Settle-Up" still carries unsettled balances. They share one Honda
Activa scooter. The vault is in INR; the one foreign-currency position is the AED group "Dubai Trip"
(a vault debt can only be in the vault's own currency).

Built-in ambiguity: two Rohans (Rohan Kulkarni, a friend; Rohan Mehra, "Bunty", his cousin) and two
Priyas (Priya Deshpande, a colleague; Priya Sharma, Anjali's cousin), look-alike events (Dinner at Aai's
vs Dinner at Mummy's, Doctor - Papa vs Doctor - Baba, Scooter service vs Scooter PUC), near-duplicate
tasks (four Pay society maintenance, two thank-you tasks, address changes on Aadhaar and PAN),
nicknames (Papa, Mummy, Aai, Baba, Anju, Bunty), hard-to-spell names (Vaishnavi Ghaisas, Chinmay
Phadnis), cancelled events, completed and cancelled tasks, an empty group and an empty folder, and
trashed rows of every trashable kind (one inside the 30-day restore window, one past it).
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

ME = "Dev Mehra"
TODAY = "2026-12-09T21:15"
TODAY_D = dt.date(2026, 12, 9)

people = [
    {"key": "anjali", "name": "Anjali Mehra", "role": "wife", "nickname": "Anju", "starred": True, "cadence": 1,
     "last_contacted": "2026-12-09T20:30", "created": "2026-01-05T09:00"},
    {"key": "papa", "name": "Rajesh Mehra", "role": "dad", "nickname": "Papa", "starred": True, "cadence": 7,
     "last_contacted": "2026-12-06T11:10", "last_contacted_kind": "call", "met": "Chandigarh"},
    {"key": "mummy", "name": "Sunita Mehra", "role": "mum", "nickname": "Mummy", "starred": True, "cadence": 3,
     "last_contacted": "2026-12-08T19:00", "last_contacted_kind": "call", "met": "Chandigarh"},
    {"key": "baba", "name": "Prakash Joshi", "role": "father-in-law", "nickname": "Baba", "cadence": 10,
     "last_contacted": "2026-12-04T18:00", "met": "Kothrud"},
    {"key": "aai", "name": "Meena Joshi", "role": "mother-in-law", "nickname": "Aai", "starred": True, "cadence": 5,
     "last_contacted": "2026-12-07T20:00", "last_contacted_kind": "call", "met": "Kothrud"},
    {"key": "sneha", "name": "Sneha Joshi", "role": "sister-in-law", "cadence": 14,
     "last_contacted": "2026-12-01T21:00", "last_contacted_kind": "message", "met": "Kothrud"},
    {"key": "rohan_m", "name": "Rohan Mehra", "role": "cousin", "nickname": "Bunty", "met": "Delhi", "cadence": 21,
     "last_contacted": "2026-11-24T22:00"},
    {"key": "rohan_k", "name": "Rohan Kulkarni", "role": "college friend", "met": "COEP", "cadence": 14,
     "last_contacted": "2026-12-05T10:00", "last_contacted_kind": "coffee", "starred": True},
    {"key": "priya_d", "name": "Priya Deshpande", "role": "colleague", "met": "office", "cadence": 7,
     "last_contacted": "2026-12-09T17:00"},
    {"key": "priya_s", "name": "Priya Sharma", "role": "Anjali's cousin", "met": "Nashik"},
    {"key": "vikram", "name": "Vikram Mehra", "role": "uncle", "nickname": "Vikram Chacha", "met": "Delhi",
     "cadence": 30, "last_contacted": "2026-11-28T12:00"},
    {"key": "kunal", "name": "Kunal Bhatia", "role": "friend", "met": "COEP", "cadence": 30,
     "last_contacted": "2026-11-23T23:00"},
    {"key": "shreya", "name": "Shreya Apte", "role": "Anjali's best friend", "met": "design college"},
    {"key": "vaishnavi", "name": "Vaishnavi Ghaisas", "role": "colleague", "met": "office"},
    {"key": "chinmay", "name": "Chinmay Phadnis", "role": "team lead", "met": "office", "cadence": 14,
     "last_contacted": "2026-12-08T11:30"},
    {"key": "siddharth", "name": "Siddharth Rao", "role": "badminton partner", "met": "society courts", "cadence": 7,
     "last_contacted": "2026-12-05T08:10"},
    {"key": "landlord", "name": "Mr Naik", "role": "landlord", "nickname": "Naik uncle", "met": "Baner"},
    {"key": "ganesh", "name": "Ganesh Pawar", "role": "scooter mechanic", "met": "Baner"},
    {"key": "dr_kelkar", "name": "Sunil Kelkar", "role": "family doctor", "nickname": "Dr Kelkar"},
    {"key": "dentist", "name": "Meghna Joshi", "role": "dentist"},
    {"key": "caterer", "name": "Hemant Wagh", "role": "wedding caterer", "met": "Pune"},
    {"key": "decorator", "name": "Tanvi Raut", "role": "wedding decorator", "met": "Pune"},
    {"key": "photog", "name": "Aditya Sathe", "role": "wedding photographer", "met": "Pune"},
    {"key": "priest", "name": "Pandit Joshi", "role": "priest", "met": "Kothrud"},
    {"key": "maid", "name": "Lata Shinde", "role": "house help", "nickname": "Lata tai"},
    {"key": "ca", "name": "Narendra Gupte", "role": "CA", "cadence": 90, "last_contacted": "2026-09-10T11:00"},
    {"key": "arjun", "name": "Arjun Menon", "role": "Dubai trip friend", "met": "Dubai"},
    {"key": "tarun", "name": "Tarun Saxena", "role": "Dubai trip friend", "met": "Dubai"},
    {"key": "neha", "name": "Neha Iyer", "role": "friend", "met": "yoga"},
    {"key": "old_agent", "name": "Prasad Limaye", "role": "old flat broker", "trashed": "2026-09-12T10:00"},
    {"key": "old_vendor", "name": "Rutuja Bhide", "role": "old wedding vendor", "trashed": "2026-11-27T10:00"},
]

groups = [
    {"key": "wedding", "name": "Wedding Settle-Up", "currency": "INR",
     "members": ["vikram", "rohan_m", "sneha", "kunal", "baba"], "created": "2026-10-05T20:00"},
    {"key": "flat", "name": "Baner Flat Bills", "currency": "INR", "members": ["anjali"],
     "created": "2026-08-01T10:00"},
    {"key": "mehra_fund", "name": "Mehra Parents Fund", "currency": "INR", "members": ["papa", "mummy", "rohan_m"],
     "created": "2026-03-10T20:00"},
    {"key": "joshi_fund", "name": "Joshi Parents Fund", "currency": "INR", "members": ["baba", "aai", "sneha"],
     "created": "2026-11-10T20:00"},
    {"key": "dubai", "name": "Dubai Trip", "currency": "AED", "members": ["arjun", "tarun", "rohan_k"],
     "created": "2026-09-20T20:00"},
    {"key": "honeymoon", "name": "Honeymoon Fund", "currency": "INR", "members": ["anjali", "shreya"],
     "created": "2026-12-02T20:00"},  # empty on purpose: no expenses yet
]

expenses = [
    {"group": "wedding", "name": "Venue advance", "amount": 150000, "paid_by": "baba",
     "split": ["me", "baba", "vikram", "sneha"], "date": "2026-10-10"},
    {"group": "wedding", "name": "Caterer advance", "amount": 120000, "paid_by": "vikram",
     "split": ["me", "baba", "vikram", "rohan_m"], "date": "2026-10-18"},
    {"group": "wedding", "name": "Decorator balance", "amount": 64000, "paid_by": "me",
     "split": ["me", "baba", "vikram", "sneha", "rohan_m"], "date": "2026-11-20"},
    {"group": "wedding", "name": "Photographer package", "amount": 90000, "paid_by": "rohan_m",
     "split": ["me", "baba", "rohan_m"], "date": "2026-11-12"},
    {"group": "wedding", "name": "Sangeet DJ and sound", "amount": 36000, "paid_by": "kunal",
     "split": ["me", "kunal", "rohan_m", "sneha"], "date": "2026-11-21"},
    {"group": "wedding", "name": "Return gifts", "amount": 18000, "paid_by": "sneha",
     "split": ["me", "sneha", "vikram"], "date": "2026-11-18"},
    {"group": "flat", "name": "Wifi December", "amount": 1180, "paid_by": "anjali", "split": ["me", "anjali"],
     "date": "2026-12-02"},
    {"group": "flat", "name": "Cooking gas", "amount": 1100, "paid_by": "me", "split": ["me", "anjali"],
     "date": "2026-11-30"},
    {"group": "mehra_fund", "name": "Papa's cataract surgery", "amount": 60000, "paid_by": "me",
     "split": ["me", "papa", "rohan_m"], "date": "2026-07-14"},
    {"group": "mehra_fund", "name": "Mummy's physio", "amount": 8400, "paid_by": "papa", "split": ["me", "papa"],
     "date": "2026-10-02"},
    {"group": "joshi_fund", "name": "Aai's fridge", "amount": 32000, "paid_by": "baba", "split": ["me", "baba", "sneha"],
     "date": "2026-11-28"},
    {"group": "dubai", "name": "Desert safari", "amount": 840, "paid_by": "arjun",
     "split": ["me", "arjun", "tarun", "rohan_k"], "date": "2026-10-09"},
    {"group": "dubai", "name": "Hotel two nights", "amount": 1560, "paid_by": "me",
     "split": ["me", "arjun", "tarun", "rohan_k"], "date": "2026-10-08"},
]

lists = [
    {"key": "wedding_list", "name": "Wedding wrap-up", "area": "social"},
    {"key": "home_list", "name": "Flat", "area": "home"},
    {"key": "work_list", "name": "Work", "area": "work"},
    {"key": "scooter_list", "name": "Scooter", "area": "home"},
    {"key": "parents_list", "name": "Parents", "area": "family"},
]

# ----------------------------------------------------------------------------------------------
# events
# ----------------------------------------------------------------------------------------------

events = []


def ev(key, name, start, end, **kw):
    row = {"key": key, "name": name, "start": start, "end": end}
    row.update({k: v for k, v in kw.items() if v})
    events.append(row)


def weekly(prefix, name, first, last, start, end, step=7, skip=(), cancel=(), **kw):
    d = dt.date.fromisoformat(first)
    stop = dt.date.fromisoformat(last)
    while d <= stop:
        iso = d.isoformat()
        if iso not in skip:
            ev(f"{prefix}_{iso[5:7]}{iso[8:]}", name, f"{iso}T{start}", f"{iso}T{end}",
               cancelled=(iso in cancel), **kw)
        d += dt.timedelta(days=step)


weekly("callm", "Call Mummy", "2026-09-13", "2026-12-27", "11:00", "11:30", skip=("2026-11-22", "2026-10-11", "2026-11-29"),
       cancel=("2026-10-18",), attendees=["mummy"])
weekly("badm", "Badminton at the society courts", "2026-09-12", "2026-12-26", "07:00", "08:00",
       skip=("2026-11-21", "2026-10-10", "2026-11-28"), cancel=("2026-10-24",), attendees=["siddharth"])
weekly("sprint", "Sprint review", "2026-09-03", "2026-12-10", "16:00", "17:00", step=14, cancel=("2026-10-29",),
       attendees=["chinmay", "priya_d"])
weekly("aai_dinner", "Dinner at Aai's", "2026-10-04", "2026-12-20", "19:30", "21:30", step=21, attendees=["aai", "baba"])

ev("mehendi", "Mehendi", "2026-11-20T15:00", "2026-11-20T19:00", attendees=["anjali", "shreya", "sneha"])
ev("sangeet", "Sangeet night", "2026-11-21T18:00", "2026-11-21T23:30", attendees=["kunal", "rohan_m", "sneha"])
ev("wedding_day", "Wedding - Pune", "2026-11-22T09:00", "2026-11-22T16:00", attendees=["anjali", "papa", "mummy", "baba", "aai"])
ev("reception", "Wedding reception", "2026-11-23T19:00", "2026-11-23T22:30", attendees=["vikram", "rohan_k"])
ev("griha", "Griha pravesh puja", "2026-11-26T08:30", "2026-11-26T10:30", attendees=["priest", "landlord", "aai"])
ev("goa", "Honeymoon in Goa", "2026-11-28T09:00", "2026-12-03T20:00", attendees=["anjali"])
ev("office_party", "Office reception party", "2026-12-12T19:00", "2026-12-12T22:00", attendees=["priya_d", "chinmay", "vaishnavi"])
ev("dinner_mummy", "Dinner at Mummy's", "2026-12-26T20:00", "2026-12-26T22:00", attendees=["mummy", "papa"])
ev("dinner_mummy_old", "Dinner at Mummy's", "2026-08-15T20:00", "2026-08-15T22:00", attendees=["mummy", "papa"])
ev("doc_papa", "Doctor - Papa", "2026-12-28T10:00", "2026-12-28T10:45", attendees=["papa", "dr_kelkar"])
ev("doc_baba", "Doctor - Baba", "2026-12-16T11:00", "2026-12-16T11:45", attendees=["baba", "dr_kelkar"])
ev("scooter_service", "Scooter service", "2026-12-14T09:00", "2026-12-14T10:30", attendees=["ganesh"])
ev("scooter_puc", "Scooter PUC check", "2026-12-18T08:30", "2026-12-18T09:00", attendees=["ganesh"])
ev("scooter_service_old", "Scooter service", "2026-09-07T09:00", "2026-09-07T10:30", attendees=["ganesh"])
ev("dentist_ev", "Dentist check-up", "2026-12-21T09:00", "2026-12-21T09:45", attendees=["dentist"])
ev("lunch_rohan_k", "Lunch with Rohan K", "2026-12-11T13:00", "2026-12-11T14:00", attendees=["rohan_k"])
ev("catchup_bunty", "Call with Bunty", "2026-12-13T21:00", "2026-12-13T21:30", attendees=["rohan_m"])
ev("coffee_priya", "Coffee with Priya", "2026-12-15T17:30", "2026-12-15T18:30", attendees=["priya_d"])
ev("shreya_bday", "Shreya's birthday dinner", "2026-12-19T20:00", "2026-12-19T23:00", attendees=["shreya", "anjali"])
ev("ca_meeting", "Tax planning with the CA", "2026-12-17T12:30", "2026-12-17T13:30", attendees=["ca"])
ev("naik_rent", "Meet Naik uncle about the agreement", "2026-12-22T18:30", "2026-12-22T19:15", attendees=["landlord"])
ev("fly_chd", "Flight to Chandigarh", "2026-12-24T06:30", "2026-12-24T09:15")
ev("lohri", "Lohri at Papa's", "2027-01-13T18:00", "2027-01-13T22:00", attendees=["papa", "mummy", "rohan_m"])
ev("fly_back", "Flight back to Pune", "2026-12-30T17:00", "2026-12-30T19:45")
ev("ny_party", "New Year party at Kunal's", "2026-12-31T21:00", "2027-01-01T01:30", attendees=["kunal", "rohan_k"])
ev("registration", "Marriage registration at the office", "2026-12-08T10:00", "2026-12-08T11:30", attendees=["anjali"])
ev("dubai_trip", "Dubai trip", "2026-10-08T06:00", "2026-10-11T23:00", attendees=["arjun", "tarun", "rohan_k"])
ev("engagement", "Rohan Mehra's engagement", "2027-02-06T17:00", "2027-02-06T21:00", attendees=["rohan_m", "vikram"])
ev("old_meet", "Meeting with Prasad", "2026-08-05T18:00", "2026-08-05T19:00", attendees=["old_agent"],
   trashed="2026-09-12T10:30")
ev("old_tasting", "Menu tasting with Rutuja", "2026-10-02T12:00", "2026-10-02T13:00", attendees=["old_vendor"],
   trashed="2026-11-27T10:30")

# ----------------------------------------------------------------------------------------------
# tasks
# ----------------------------------------------------------------------------------------------

tasks = []


def task(key, name, lst=None, due=None, done=None, **kw):
    row = {"key": key, "name": name}
    if lst:
        row["list"] = lst
    if due:
        row["due"] = due
    if done:
        row["completed"] = done
    row.update(kw)
    tasks.append(row)


for mo, due, done in [("aug", "2026-08-05", "2026-08-04T21:00"), ("sep", "2026-09-05", "2026-09-05T08:30"),
                      ("oct", "2026-10-05", "2026-10-03T19:45"), ("nov", "2026-11-05", "2026-11-05T10:00")]:
    task(f"rent_{mo}", "Pay flat rent", "home_list", due, done)
task("rent_dec", "Pay flat rent", "home_list", "2026-12-05", "2026-12-04T22:10")
task("rent_jan", "Pay flat rent", "home_list", "2027-01-05", priority=1)

for mo, due, done in [("sep", "2026-09-10", "2026-09-09T20:00"), ("oct", "2026-10-10", "2026-10-10T09:00"),
                      ("nov", "2026-11-10", "2026-11-11T09:30")]:
    task(f"maint_{mo}", "Pay society maintenance", "home_list", due, done)
task("maint_dec", "Pay society maintenance", "home_list", "2026-12-10", priority=1)
task("maint_jan", "Pay society maintenance", "home_list", "2027-01-10")

for mo, due, done in [("jul", "2026-07-03", "2026-07-02T21:00"), ("aug", "2026-08-03", "2026-08-03T08:00"),
                      ("sep", "2026-09-03", "2026-09-03T08:15"), ("oct", "2026-10-03", "2026-10-02T22:00"),
                      ("nov", "2026-11-03", "2026-11-02T20:00")]:
    task(f"emi_{mo}", "Pay scooter EMI", "scooter_list", due, done)
task("emi_dec", "Pay scooter EMI", "scooter_list", "2026-12-03", "2026-12-03T09:00")
task("emi_jan", "Pay scooter EMI", "scooter_list", "2027-01-03")

task("wrap", "Wedding wrap-up", "wedding_list", "2026-12-31", priority=2, status="in_progress")
for k, name, due, done, extra in [
    ("settle", "Settle up with the relatives", "2026-12-20", None, {"priority": 2}),
    ("thanks_cards", "Send thank-you cards", "2026-12-15", None, {"effort": 90}),
    ("album", "Choose photos for the album", "2026-12-22", None, {"effort": 120}),
    ("video", "Collect the wedding video", "2026-12-12", None, {"effort": 20}),
    ("gifts_list", "Note down who gave which gift", "2026-11-29", "2026-11-30T21:00", {}),
    ("return_decor", "Return the rented decor props", "2026-11-25", "2026-11-25T17:00", {}),
    ("pay_caterer", "Pay the caterer balance", "2026-11-24", "2026-11-24T12:00", {}),
]:
    task(f"wrap_{k}", name, "wedding_list", due, done, parent="wrap", **extra)
task("thanks_msgs", "Send thank-you messages", "wedding_list", "2026-12-10", effort=60)
task("thanks_cards_old", "Send thank-you cards", "wedding_list", "2026-11-28", "2026-11-28T20:00")

task("name_change", "Anjali's name change paperwork", "home_list", "2027-01-31", status="in_progress", priority=2)
for k, name, due, done, extra in [
    ("marriage_cert", "Get the marriage certificate", "2026-12-08", "2026-12-08T12:30", {}),
    ("aadhaar", "Update address on Aadhaar", "2026-12-18", None, {"effort": 30}),
    ("pan", "Update address on PAN", "2026-12-20", None, {"effort": 30}),
    ("bank", "Change Anjali's surname at the bank", "2027-01-10", None, {"effort": 60}),
    ("passport", "Apply for the passport name change", "2027-01-20", None, {"effort": 90, "priority": 2}),
]:
    task(f"nc_{k}", name, "home_list", due, done, parent="name_change", **extra)

task("exam_pending", "Submit the work-from-home form", "work_list", "2026-12-11", effort=15)
task("leave_apply", "Apply for leave for Chandigarh", "work_list", "2026-12-14", priority=1)
task("leave_old", "Apply for wedding leave", "work_list", "2026-10-15", "2026-10-14T18:00")
task("tax_proofs", "Upload tax proofs to payroll", "work_list", "2026-12-28", effort=40)
task("perf_review", "Write the self review", "work_list", "2026-12-18", effort=120, priority=2)
task("release_notes", "Draft release notes for 4.2", "work_list", "2026-12-10", effort=60)
task("pr_review", "Review Vaishnavi's pull request", "work_list", "2026-12-10", effort=45)
task("onsite_form", "Fill the onsite visa form", "work_list", "2027-01-15", status="cancelled")

task("scooter_ins", "Renew scooter insurance", "scooter_list", "2026-12-30", priority=1, effort=20)
task("scooter_ins_old", "Renew scooter insurance", "scooter_list", "2025-12-28", "2025-12-27T18:00")
task("scooter_puc_t", "Get the PUC certificate", "scooter_list", "2026-12-18", effort=20)
task("scooter_tyre", "Check the rear tyre", "scooter_list", "2026-12-14", effort=15)
task("scooter_helmet", "Buy a helmet for Anjali", "scooter_list", "2026-12-20", effort=45)
task("scooter_challan", "Pay the traffic challan", "scooter_list", "2026-09-30", "2026-09-29T19:00")

task("mummy_gift", "Buy a shawl for Mummy", "parents_list", "2026-12-22", effort=60)
task("papa_report", "Collect Papa's eye reports", "parents_list", "2026-12-14")
task("aai_fridge", "Arrange delivery of Aai's fridge", "parents_list", "2026-11-30", "2026-11-29T15:00")
task("baba_meds", "Order Baba's medicines", "parents_list", "2026-12-12", effort=15)
task("pack_chd", "Pack for Chandigarh", "parents_list", "2026-12-23")
task("book_fly", "Book the Chandigarh flights", "parents_list", "2026-11-15", "2026-11-14T22:00")

task("pay_vikram", "Pay Vikram uncle for the caterer", due="2026-12-20", priority=1)
task("pay_rohan", "Pay Rohan for the photographer", due="2026-12-20")
task("pay_kunal", "Pay Kunal for the DJ", due="2026-12-18", effort=5)
task("buy_geyser", "Buy a geyser for the bathroom", "home_list", "2026-12-24", effort=90)
task("curtains", "Order curtains for the bedroom", "home_list", "2026-12-17", effort=60)
task("old_sofa", "Sell the old sofa", trashed="2026-09-12T10:15")
task("old_decor", "Compare decor quotes", "wedding_list", trashed="2026-11-27T10:15")

# ----------------------------------------------------------------------------------------------
# notes
# ----------------------------------------------------------------------------------------------

notebooks = [
    {"key": "wedding_nb", "name": "Wedding Planning"},
    {"key": "home_nb", "name": "Flat Notes"},
    {"key": "work_nb", "name": "Work Journal"},
    {"key": "kitchen_nb", "name": "Kitchen"},
]

notes = [
    {"key": "w_budget", "name": "Wedding budget", "notebook": "wedding_nb", "created": "2026-08-20T21:00", "pinned": True,
     "body": "venue and food are the big two, decor and photographer next, keep ten percent aside for surprises"},
    {"key": "w_guests", "name": "Guest list split", "notebook": "wedding_nb", "created": "2026-09-02T21:30",
     "body": "two hundred and forty in total, a hundred and ten from our side, Aai wants the Nashik cousins invited"},
    {"key": "w_rituals", "name": "Ritual timeline", "notebook": "wedding_nb", "created": "2026-10-12T20:00",
     "body": "haldi in the morning, sangeet in the evening, muhurat at 11.40 on Sunday, reception on Monday"},
    {"key": "w_vendors", "name": "Vendor contacts", "notebook": "wedding_nb", "created": "2026-09-10T19:00",
     "body": "Hemant caterer, Tanvi decorator, Aditya photographer, Pandit Joshi for the ceremony"},
    {"key": "w_vows", "name": "Speech draft", "notebook": "wedding_nb", "created": "2026-11-15T22:30",
     "body": "thank both families, mention the COEP canteen, keep it under three minutes"},
    {"key": "w_settle", "name": "Who paid what", "notebook": "wedding_nb", "created": "2026-11-27T21:00",
     "body": "Baba paid the venue, Vikram chacha paid the caterer advance, Bunty paid the photographer, rest is mine"},
    {"key": "w_after", "name": "After the wedding", "notebook": "wedding_nb", "created": "2026-11-30T20:00",
     "body": "settle the group first, then cards, then the album, name change paperwork in January"},
    {"key": "flat_move", "name": "Moving checklist", "notebook": "home_nb", "created": "2026-08-01T20:00",
     "body": "gas connection, wifi, curtains, the society welcome form, lease signed with Naik uncle"},
    {"key": "flat_rules", "name": "Society rules", "notebook": "home_nb", "created": "2026-08-03T10:00",
     "body": "maintenance by the tenth, no loud music after ten, scooter parking in slot B14"},
    {"key": "flat_wifi", "name": "Router setup", "notebook": "home_nb", "created": "2026-08-05T19:00",
     "body": "fibre plan 600 mbps, router in the hall, reset button behind the pinhole"},
    {"key": "flat_shop", "name": "Things to buy for the flat", "notebook": "home_nb", "created": "2026-11-29T18:00",
     "body": "geyser, curtains, an ironing board, a second pressure cooker"},
    {"key": "flat_help", "name": "Lata tai schedule", "notebook": "home_nb", "created": "2026-08-10T09:00",
     "body": "comes at seven, Sundays off, 3500 a month paid on the first"},
    {"key": "work_sprint", "name": "Sprint 41 retro", "notebook": "work_nb", "created": "2026-10-15T17:30",
     "body": "deploys too slow, flaky tests in payments, Chinmay wants a freeze before the holidays"},
    {"key": "work_goals", "name": "Goals for the half", "notebook": "work_nb", "created": "2026-07-06T10:00",
     "body": "own the notifications service, mentor Vaishnavi, cut p95 latency by a third"},
    {"key": "work_1on1", "name": "One-on-one with Chinmay", "notebook": "work_nb", "created": "2026-11-18T15:00",
     "body": "promotion case in March, take the onsite in January if the visa works out"},
    {"key": "work_oncall", "name": "On-call runbook notes", "notebook": "work_nb", "created": "2026-09-22T11:00",
     "body": "restart the consumer first, check the dead-letter queue, page Priya if it repeats"},
    {"key": "kit_poha", "name": "Kanda poha", "notebook": "kitchen_nb", "created": "2026-08-14T09:00",
     "body": "thick poha, onions, peanuts, curry leaves, lemon at the end, Aai's trick is a pinch of sugar"},
    {"key": "kit_rajma", "name": "Mummy's rajma", "notebook": "kitchen_nb", "created": "2026-09-27T13:00",
     "body": "soak overnight, pressure cook six whistles, onion tomato masala, simmer an hour"},
    {"key": "kit_puranpoli", "name": "Puran poli", "notebook": "kitchen_nb", "created": "2026-10-20T17:00",
     "body": "chana dal and jaggery filling, rest the dough, ghee on the tawa"},
    {"key": "diary_wedding", "name": "Diary entry - wedding night", "created": "2026-11-23T01:30",
     "body": "dance floor full, Papa and Baba finally hugged, ate two bites in the whole day"},
    {"key": "diary_goa", "name": "Diary entry - Goa", "created": "2026-11-30T22:00",
     "body": "Palolem sunsets, scooter rental, Anju beat me at carrom, back to work soon"},
    {"key": "dubai_notes", "name": "Dubai trip notes", "created": "2026-10-12T20:00",
     "body": "desert safari was the highlight, metro is cheap, Tarun lost his card at the mall"},
    {"key": "gifts_note", "name": "Gift ideas for the parents", "created": "2026-12-03T21:00",
     "body": "shawl for Mummy, a reading lamp for Baba, Aai wants a pressure cooker, Papa a new radio"},
    {"key": "scooter_notes", "name": "Scooter details", "created": "2026-08-12T12:00",
     "body": "Honda Activa, MH12 AB 4521, service every 3000 km, insurance due end of December"},
    {"key": "old_idea", "name": "Old idea - Goa wedding", "created": "2026-05-02T10:00",
     "body": "destination wedding in Goa, too expensive", "trashed": "2026-08-20T10:00"},
    {"key": "old_scratch", "name": "Scratch list", "created": "2026-12-01T10:00", "body": "milk, eggs, atta",
     "trashed": "2026-12-05T10:00"},
]

# ----------------------------------------------------------------------------------------------
# documents
# ----------------------------------------------------------------------------------------------

folders = [
    {"key": "wedding_f", "name": "Wedding"},
    {"key": "flat_f", "name": "Flat"},
    {"key": "id_f", "name": "IDs"},
    {"key": "scooter_f", "name": "Scooter"},
    {"key": "work_f", "name": "Work"},
    {"key": "empty_f", "name": "To file"},  # stays empty
]

documents = [
    {"key": "marriage_cert_d", "name": "Marriage certificate", "folder": "wedding_f", "created": "2026-12-08T13:00",
     "starred": True},
    {"key": "caterer_inv", "name": "Caterer invoice", "folder": "wedding_f", "created": "2026-11-24T12:30"},
    {"key": "decor_inv", "name": "Decorator invoice", "folder": "wedding_f", "created": "2026-11-20T18:00"},
    {"key": "photog_contract", "name": "Photographer contract", "folder": "wedding_f", "created": "2026-09-30T10:00"},
    {"key": "venue_receipt", "name": "Venue advance receipt", "folder": "wedding_f", "created": "2026-10-10T11:00"},
    {"key": "lease", "name": "Baner flat lease", "folder": "flat_f", "created": "2026-08-01T11:00", "starred": True},
    {"key": "police_verif", "name": "Police verification form", "folder": "flat_f", "created": "2026-08-03T12:00"},
    {"key": "society_noc", "name": "Society NOC", "folder": "flat_f", "created": "2026-08-02T12:00"},
    {"key": "aadhaar_dev", "name": "Aadhaar scan - Dev", "folder": "id_f", "created": "2026-01-10T10:00"},
    {"key": "aadhaar_anjali", "name": "Aadhaar scan - Anjali", "folder": "id_f", "created": "2026-12-02T10:00"},
    {"key": "pan_dev", "name": "PAN card scan", "folder": "id_f", "created": "2026-01-10T10:05"},
    {"key": "passport_scan", "name": "Passport scan", "folder": "id_f", "created": "2026-01-10T10:10"},
    {"key": "scooter_rc", "name": "Scooter RC book", "folder": "scooter_f", "created": "2025-12-28T10:00"},
    {"key": "scooter_ins_d", "name": "Scooter insurance 2025", "folder": "scooter_f", "created": "2025-12-28T10:30"},
    {"key": "offer_letter", "name": "Offer letter", "folder": "work_f", "created": "2024-06-10T10:00"},
    {"key": "form16", "name": "Form 16 2025", "folder": "work_f", "created": "2026-06-05T10:00"},
    {"key": "payslip_nov", "name": "Payslip November", "created": "2026-12-01T10:00"},
    {"key": "dubai_visa", "name": "Dubai visa copy", "created": "2026-09-25T10:00"},
    {"key": "old_quote", "name": "Old caterer quote", "folder": "wedding_f", "created": "2026-09-01T10:00",
     "trashed": "2026-11-27T10:20"},
    {"key": "old_lease", "name": "Old Kothrud lease draft", "folder": "flat_f", "created": "2026-05-20T10:00",
     "trashed": "2026-09-12T10:00"},
]

# ----------------------------------------------------------------------------------------------
# photos
# ----------------------------------------------------------------------------------------------

albums = [
    {"key": "wedding_album", "name": "Wedding Day"},
    {"key": "goa_album", "name": "Goa Honeymoon"},
    {"key": "flat_album", "name": "Our Flat"},
    {"key": "rides_album", "name": "Scooter Rides"},
]

photos = [
    {"key": "p_haldi", "name": "Haldi in the morning", "taken": "2026-11-21T10:00", "albums": ["wedding_album"],
     "people": ["anjali", "sneha"]},
    {"key": "p_mehendi", "name": "Anju's mehendi", "taken": "2026-11-20T16:30", "albums": ["wedding_album"],
     "people": ["anjali", "shreya"], "starred": True},
    {"key": "p_sangeet", "name": "Sangeet dance floor", "taken": "2026-11-21T21:15", "albums": ["wedding_album"],
     "people": ["kunal", "rohan_m"]},
    {"key": "p_phere", "name": "The saat phere", "taken": "2026-11-22T11:50", "albums": ["wedding_album"],
     "people": ["anjali", "priest"], "starred": True},
    {"key": "p_family", "name": "Both families on stage", "taken": "2026-11-22T14:00", "albums": ["wedding_album"],
     "people": ["papa", "mummy", "baba", "aai", "sneha"], "starred": True},
    {"key": "p_varmala", "name": "Varmala exchange", "taken": "2026-11-22T10:30", "albums": ["wedding_album"],
     "people": ["anjali"]},
    {"key": "p_reception", "name": "Reception cake", "taken": "2026-11-23T20:30", "albums": ["wedding_album"],
     "people": ["vikram"]},
    {"key": "p_friends", "name": "College gang at the reception", "taken": "2026-11-23T21:10",
     "albums": ["wedding_album"], "people": ["rohan_k", "kunal"]},
    {"key": "p_decor", "name": "Mandap decor", "taken": "2026-11-22T07:30", "albums": ["wedding_album"],
     "people": ["decorator"]},
    {"key": "p_goa_beach", "name": "Palolem beach", "taken": "2026-11-29T17:45", "albums": ["goa_album"],
     "people": ["anjali"], "starred": True},
    {"key": "p_goa_scooter", "name": "Rented scooter in Goa", "taken": "2026-11-30T11:00", "albums": ["goa_album"]},
    {"key": "p_goa_dinner", "name": "Dinner at the shack", "taken": "2026-12-01T20:15", "albums": ["goa_album"],
     "people": ["anjali"]},
    {"key": "p_goa_fort", "name": "Fort Aguada", "taken": "2026-12-02T10:30", "albums": ["goa_album"]},
    {"key": "p_goa_sunset", "name": "Sunset from the cliff", "taken": "2026-12-02T18:20", "albums": ["goa_album"],
     "starred": True},
    {"key": "p_flat_keys", "name": "Getting the keys", "taken": "2026-08-01T12:00", "albums": ["flat_album"],
     "people": ["landlord"]},
    {"key": "p_flat_empty", "name": "The empty living room", "taken": "2026-08-01T12:30", "albums": ["flat_album"]},
    {"key": "p_flat_puja", "name": "Griha pravesh puja", "taken": "2026-11-26T09:15", "albums": ["flat_album"],
     "people": ["priest", "aai"]},
    {"key": "p_flat_balcony", "name": "Balcony view of Baner hills", "taken": "2026-08-15T06:30",
     "albums": ["flat_album"]},
    {"key": "p_flat_kitchen", "name": "First dinner cooked at home", "taken": "2026-08-09T21:00",
     "albums": ["flat_album"], "people": ["anjali"]},
    {"key": "p_ride_sinhagad", "name": "Sinhagad on the Activa", "taken": "2026-10-04T07:30", "albums": ["rides_album"],
     "people": ["anjali"], "starred": True},
    {"key": "p_ride_mulshi", "name": "Mulshi lake stop", "taken": "2026-09-20T09:00", "albums": ["rides_album"]},
    {"key": "p_ride_fc", "name": "Chai on FC Road", "taken": "2026-09-27T18:30", "albums": ["rides_album"],
     "people": ["rohan_k"]},
    {"key": "p_ride_puncture", "name": "Puncture near Pashan", "taken": "2026-10-18T08:40", "albums": ["rides_album"]},
    {"key": "p_dubai_dune", "name": "Dune bashing", "taken": "2026-10-09T16:00", "people": ["arjun", "tarun", "rohan_k"],
     "starred": True},
    {"key": "p_dubai_burj", "name": "Burj Khalifa at night", "taken": "2026-10-09T21:30", "people": ["rohan_k"]},
    {"key": "p_dubai_mall", "name": "The mall fountain", "taken": "2026-10-10T19:00", "people": ["tarun"]},
    {"key": "p_office", "name": "Office team lunch", "taken": "2026-11-12T13:30", "people": ["priya_d", "chinmay", "vaishnavi"]},
    {"key": "p_cousin", "name": "Cousins at Aai's", "taken": "2026-10-25T18:00", "people": ["priya_s", "sneha"]},
    {"key": "p_bunty", "name": "Bunty at the sangeet", "taken": "2026-11-21T22:00", "people": ["rohan_m"]},
    {"key": "p_diwali", "name": "Diwali diyas at Aai's", "taken": "2026-11-08T19:00", "people": ["aai", "baba"]},
    {"key": "p_ca_docs", "name": "Tax documents spread out", "taken": "2026-12-03T20:00"},
    {"key": "p_coep", "name": "COEP reunion", "taken": "2026-09-05T20:00", "people": ["rohan_k", "kunal"]},
    {"key": "p_badminton", "name": "Badminton after the match", "taken": "2026-10-31T08:20", "people": ["siddharth"]},
    {"key": "p_blurry", "name": "Blurry photo", "taken": "2026-11-30T09:00", "trashed": "2026-12-03T09:00"},
    {"key": "p_receipt", "name": "Screenshot of the DJ receipt", "taken": "2026-10-12T12:00",
     "trashed": "2026-10-20T09:00"},
]

# ----------------------------------------------------------------------------------------------
# debts
# ----------------------------------------------------------------------------------------------

debts = [
    {"key": "d_vikram", "person": "vikram", "direction": "i_owe", "amount": 30000, "name": "caterer advance share",
     "date": "2026-10-18"},
    {"key": "d_baba", "person": "baba", "direction": "i_owe", "amount": 37500, "name": "venue advance share",
     "date": "2026-10-10"},
    {"key": "d_rohan_m", "person": "rohan_m", "direction": "i_owe", "amount": 30000, "name": "photographer share",
     "date": "2026-11-12"},
    {"key": "d_kunal", "person": "kunal", "direction": "i_owe", "amount": 9000, "name": "sangeet DJ share",
     "date": "2026-11-21"},
    {"key": "d_sneha", "person": "sneha", "direction": "owes_me", "amount": 6000, "name": "return gifts share",
     "date": "2026-11-18"},
    {"key": "d_papa", "person": "papa", "direction": "owes_me", "amount": 20000, "name": "cataract surgery share",
     "date": "2026-07-14"},
    {"key": "d_anjali", "person": "anjali", "direction": "i_owe", "amount": 590, "name": "wifi half",
     "date": "2026-12-02"},
    {"key": "d_rohan_k", "person": "rohan_k", "direction": "owes_me", "amount": 12000, "name": "Dubai hotel in rupees",
     "date": "2026-10-08"},
    {"key": "d_priya_d", "person": "priya_d", "direction": "owes_me", "amount": 850, "name": "team lunch",
     "date": "2026-11-12"},
    {"key": "d_siddharth", "person": "siddharth", "direction": "i_owe", "amount": 400, "name": "shuttlecocks",
     "date": "2026-11-28"},
    {"key": "d_ganesh", "person": "ganesh", "direction": "i_owe", "amount": 2350, "name": "scooter chain and tyre",
     "date": "2026-09-07", "settled": "2026-09-09T10:00"},
    {"key": "d_neha", "person": "neha", "direction": "owes_me", "amount": 1500, "name": "yoga workshop",
     "date": "2026-08-22", "settled": "2026-09-01T10:00"},
    {"key": "d_arjun", "person": "arjun", "direction": "owes_me", "amount": 3200, "name": "airport cab",
     "date": "2026-10-08", "settled": "2026-10-20T10:00"},
]

# ----------------------------------------------------------------------------------------------
# locker
# ----------------------------------------------------------------------------------------------

locker = [
    {"key": "hdfc_login", "name": "HDFC NetBanking", "type": "login", "username": "devmehra33",
     "url": "https://hdfcbank.com", "password": "Baner#Activa14", "starred": True},
    {"key": "sbi_login", "name": "SBI YONO", "type": "login", "username": "dev.mehra",
     "url": "https://sbi.co.in", "password": "Chandigarh-Mummy9"},
    {"key": "it_login", "name": "Income tax portal", "type": "login", "username": "ABCPM1234D",
     "url": "https://incometax.gov.in", "password": "TaxSeason!2026"},
    {"key": "hdfc_card", "name": "HDFC credit card", "type": "card", "card_number": "4386280012345678", "cvv": "442"},
    {"key": "joint_acct", "name": "Joint account with Anjali", "type": "bank_account",
     "notes": "HDFC Baner branch, account 50100123456789, IFSC HDFC0000612", "starred": True},
    {"key": "home_wifi", "name": "Flat wifi", "type": "wifi", "password": "Anju&Dev2026", "starred": True},
    {"key": "aai_wifi", "name": "Aai's wifi", "type": "wifi", "password": "KothrudJoshi58"},
    {"key": "gate_code", "name": "Society gate code", "type": "note", "notes": "2468 then the green button"},
    {"key": "upi_pin", "name": "PhonePe app", "type": "password", "password": "PuneUpi#77"},
    {"key": "aadhaar_id", "name": "Aadhaar card", "type": "identity"},
    {"key": "passport", "name": "Passport - Dev", "type": "passport", "notes": "no. Z1234567, expires 2033-04-18"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence", "notes": "MH12 20190012345"},
    {"key": "gym_member", "name": "Cult gym membership", "type": "membership",
     "notes": "annual, renews in March", "starred": True},
    {"key": "cloud_api", "name": "Cloud console API key", "type": "api_credential", "notes": "for the side project"},
    {"key": "work_ssh", "name": "Work laptop SSH key", "type": "ssh_key", "notes": "office GitLab, rotates in June"},
    {"key": "figma", "name": "JetBrains licence", "type": "software_licence", "notes": "personal, renews 20 February"},
    {"key": "btc", "name": "Crypto wallet", "type": "crypto_wallet", "notes": "small, about 15000 rupees"},
    {"key": "rent_agreement", "name": "Rent agreement", "type": "document",
     "notes": "original with Naik uncle, scan in the Flat folder"},
    {"key": "old_wifi", "name": "Old Kothrud wifi", "type": "wifi", "password": "Joshi2024Pune",
     "trashed": "2026-09-15T10:00"},
    {"key": "old_login", "name": "Old Airtel login", "type": "login", "username": "dev.mehra.33",
     "password": "OldAirtel7", "trashed": "2026-11-30T10:00"},
]

links = [
    {"from": "wrap_settle", "to": "vikram"},
    {"from": "wrap_thanks_cards", "to": "aai"},
    {"from": "pay_vikram", "to": "vikram"},
    {"from": "pay_rohan", "to": "rohan_m"},
    {"from": "pay_kunal", "to": "kunal"},
    {"from": "wrap_pay_caterer", "to": "caterer"},
    {"from": "wrap_video", "to": "photog"},
    {"from": "wrap_return_decor", "to": "decorator"},
    {"from": "scooter_tyre", "to": "ganesh"},
    {"from": "scooter_puc_t", "to": "ganesh"},
    {"from": "scooter_helmet", "to": "anjali"},
    {"from": "mummy_gift", "to": "mummy"},
    {"from": "papa_report", "to": "papa"},
    {"from": "baba_meds", "to": "baba"},
    {"from": "aai_fridge", "to": "aai"},
    {"from": "maint_dec", "to": "landlord"},
    {"from": "rent_dec", "to": "landlord"},
    {"from": "pr_review", "to": "vaishnavi"},
    {"from": "perf_review", "to": "chinmay"},
    {"from": "nc_bank", "to": "anjali"},
    {"from": "w_vendors", "to": "caterer"},
    {"from": "w_settle", "to": "vikram"},
    {"from": "w_rituals", "to": "priest"},
    {"from": "work_1on1", "to": "chinmay"},
    {"from": "flat_help", "to": "maid"},
    {"from": "kit_puranpoli", "to": "aai"},
    {"from": "kit_rajma", "to": "mummy"},
    {"from": "dubai_notes", "to": "tarun"},
    {"from": "gifts_note", "to": "sneha"},
]

world = {
    "me": ME, "today": TODAY, "epoch": "2026-01-05T09:00", "seed": "T36", "currency": "INR",
    "people": people, "groups": groups, "expenses": expenses, "lists": lists, "events": events,
    "tasks": tasks, "notebooks": notebooks, "notes": notes, "folders": folders, "documents": documents,
    "albums": albums, "photos": photos, "debts": debts, "locker": locker, "links": links,
}


def check(w):
    """Keys unique and snake_case, every reference resolves, no two events overlap (cancelled and
    trashed ones are created live, so they count too), every locker type is present, the world has the
    size and the ambiguity the brief asks for."""
    keys = {}
    for kind, rows in w.items():
        if not isinstance(rows, list):
            continue
        for r in rows:
            if "key" in r:
                assert r["key"] not in keys, f"duplicate key {r['key']}"
                assert r["key"] == r["key"].lower() and " " not in r["key"] and len(r["key"]) <= 20, r["key"]
                keys[r["key"]] = kind
    keys["me"] = "people"

    def need(key, kind):
        assert keys.get(key) == kind, f"{key} is not a {kind}"

    for g in w["groups"]:
        [need(m, "people") for m in g["members"]]
        assert len(set(g["members"])) == len(g["members"]), g["key"]
    for e in w["expenses"]:
        need(e["group"], "groups")
        [need(m, "people") for m in e["split"]]
        need(e["paid_by"], "people")
        members = set(next(g["members"] for g in w["groups"] if g["key"] == e["group"])) | {"me"}
        assert set(e["split"]) | {e["paid_by"]} <= members, f"expense outside its group: {e['name']}"
    for t in w["tasks"]:
        if "parent" in t:
            need(t["parent"], "tasks")
        if "list" in t:
            need(t["list"], "lists")
    for n in w["notes"]:
        if "notebook" in n:
            need(n["notebook"], "notebooks")
    for d in w["documents"]:
        if "folder" in d:
            need(d["folder"], "folders")
    for p in w["photos"]:
        [need(a, "albums") for a in p.get("albums", [])]
        [need(q, "people") for q in p.get("people", [])]
        assert len(set(p.get("albums", []))) == len(p.get("albums", [])), p["key"]
    for d in w["debts"]:
        need(d["person"], "people")
    for e in w["events"]:
        [need(a, "people") for a in e.get("attendees", [])]
    for ln in w["links"]:
        assert ln["from"] in keys and ln["to"] in keys, ln
    names = [g["name"] for g in w["groups"]] + [n["name"] for n in w["notebooks"]] + [a["name"] for a in w["albums"]]
    assert len(names) == len(set(names)), "group/notebook/album names must be unique"
    assert len({p["name"] for p in w["people"]}) == len(w["people"]), "duplicate person names"
    spans = sorted((e["start"], e["end"], e["key"]) for e in w["events"])
    for (s1, e1, k1), (s2, e2, k2) in zip(spans, spans[1:]):
        assert e1 <= s2, f"events overlap: {k1} and {k2}"
    assert len({r["type"] for r in w["locker"]}) == 15
    assert w["me"] and w["today"]
    # size, per the brief's ordinary ranges
    n = {k: len(v) for k, v in w.items() if isinstance(v, list)}
    for kind, lo, hi in [("people", 25, 35), ("groups", 4, 6), ("events", 50, 70), ("tasks", 50, 70), ("notes", 20, 30),
                         ("documents", 15, 20), ("photos", 30, 40), ("debts", 10, 15), ("locker", 15, 20)]:
        assert lo <= n[kind] <= hi, f"{kind}: {n[kind]} not in {lo}-{hi}"
    # trashed rows of every trashable kind, one inside the restore window and one past it
    for kind in ("people", "events", "tasks", "notes", "documents", "photos", "locker"):
        stamps = [r["trashed"] for r in w[kind] if "trashed" in r]
        assert stamps, f"no trashed {kind}"
        age = [(dt.datetime.fromisoformat(w["today"]) - dt.datetime.fromisoformat(s)).days for s in stamps]
        assert any(a <= 30 for a in age) and any(a > 30 for a in age), f"trashed {kind} window mix: {age}"
    # ambiguity: two pairs of people sharing a first name, cancelled events, completed + cancelled tasks
    firsts = [p["name"].split()[0] for p in w["people"] if "trashed" not in p]
    assert sum(1 for f in set(firsts) if firsts.count(f) >= 2) >= 2, "need two same-first-name pairs"
    assert any(e.get("cancelled") for e in w["events"])
    assert any(t.get("completed") for t in w["tasks"]) and any(t.get("status") == "cancelled" for t in w["tasks"])
    assert any(not g["members"] or not [e for e in w["expenses"] if e["group"] == g["key"]] for g in w["groups"])
    assert any(f["key"] not in {d.get("folder") for d in w["documents"]} for f in w["folders"])


if __name__ == "__main__":
    check(world)
    (HERE / "T36.json").write_text(json.dumps(world, indent=1, ensure_ascii=False) + "\n")
    counts = {k: len(v) for k, v in world.items() if isinstance(v, list)}
    print("T36:", counts)
