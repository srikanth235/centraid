"""World T37: Liam O'Brien's household vault (Galway, retired teacher, EUR vault).

    python3 authored/worlds/T37_build.py      # writes authored/worlds/T37.json (deterministic)

Today in the sessions is Tuesday 2027-03-09 10:40 (back from the physio, the week before St Patrick's Day).

Persona: Liam O'Brien, 61, a retired primary-school teacher in Galway (Salthill). Married to Maura ("Mo");
daughter Aoife (Cian, 8, and Saoirse, 5) lives ten minutes away, son Conor and his baby Oisin are in
Dublin. Liam minds the grandchildren on Wednesdays, coaches the under-12 hurlers at Kilcorran GAA, runs
the Claddagh Book Club kitty and has a long list of medical appointments (cardiology, physio for the
knee, hearing, eyes). His brother Declan ("Dec") lives in Boston; the one foreign-currency position is
the USD group "Boston Trip" (a vault debt can only be in the vault's own currency, so the USD money
lives in the group, where Declan is owed it). The vault is in EUR.

Built-in ambiguity: two Seans (Sean Murphy, GAA chairman; Sean Burke, book club), two Declans (his brother and the
optician Declan Joyce) and two Marys (Mary Keane,
book club; Mary O'Brien, Maura's sister), look-alike events (Cardiology clinic vs Cardiology bloods, Physio -
knee vs Physio review, Hurling training vs Hurling match, Dentist - Liam vs Dentist - Cian), near-duplicate
tasks (four Pay ESB bill, five Order repeat prescription, two Book Cian's communion tasks), nicknames (Mo,
Dec, Granda, Fr Tom), hard-to-spell names (Siobhan Ni Chonghaile, Caoimhe Ni Dhomhnaill, Tadhg O Se),
cancelled events, completed and cancelled tasks, an empty group and an empty folder, and trashed rows of every
trashable kind (one inside the 30-day restore window, one past it).
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

ME = "Liam O'Brien"
TODAY = "2027-03-09T10:40"
TODAY_D = dt.date(2027, 3, 9)

people = [
    {"key": "maura", "name": "Maura O'Brien", "role": "wife", "nickname": "Mo", "starred": True, "cadence": 1,
     "last_contacted": "2027-03-09T08:15", "created": "2026-11-01T09:00"},
    {"key": "aoife", "name": "Aoife Daly", "role": "daughter", "starred": True, "cadence": 2,
     "last_contacted": "2027-03-08T19:30", "last_contacted_kind": "call", "met": "Salthill"},
    {"key": "cian", "name": "Cian Daly", "role": "grandson", "nickname": "Cian", "starred": True,
     "met": "Salthill"},
    {"key": "saoirse", "name": "Saoirse Daly", "role": "granddaughter", "starred": True, "met": "Salthill"},
    {"key": "conor", "name": "Conor O'Brien", "role": "son", "cadence": 7, "last_contacted": "2027-03-06T17:00",
     "last_contacted_kind": "call", "met": "Dublin"},
    {"key": "oisin", "name": "Oisin O'Brien", "role": "grandson", "met": "Dublin"},
    {"key": "declan", "name": "Declan O'Brien", "role": "brother", "nickname": "Dec", "starred": True, "cadence": 7,
     "last_contacted": "2027-03-07T18:10", "last_contacted_kind": "call", "met": "Boston"},
    {"key": "mary_o", "name": "Mary O'Brien", "role": "sister-in-law", "met": "Tuam", "cadence": 30,
     "last_contacted": "2027-02-14T16:00"},
    {"key": "mary_k", "name": "Mary Keane", "role": "book club", "met": "Claddagh Book Club", "cadence": 30,
     "last_contacted": "2027-03-04T22:00"},
    {"key": "sean_m", "name": "Sean Murphy", "role": "GAA chairman", "met": "Kilcorran GAA", "cadence": 14,
     "last_contacted": "2027-03-02T20:00"},
    {"key": "sean_b", "name": "Sean Burke", "role": "book club", "met": "Claddagh Book Club"},
    {"key": "tadhg", "name": "Tadhg O Se", "role": "GAA coach", "met": "Kilcorran GAA", "starred": True,
     "cadence": 7, "last_contacted": "2027-03-07T12:00"},
    {"key": "siobhan", "name": "Siobhan Ni Chonghaile", "role": "book club host", "met": "Claddagh Book Club",
     "cadence": 30, "last_contacted": "2027-02-26T11:00"},
    {"key": "caoimhe", "name": "Caoimhe Ni Dhomhnaill", "role": "GAA secretary", "met": "Kilcorran GAA"},
    {"key": "padraig", "name": "Padraig Fahy", "role": "GAA treasurer", "met": "Kilcorran GAA"},
    {"key": "fr_tom", "name": "Tom Concannon", "role": "parish priest", "nickname": "Fr Tom", "met": "Salthill"},
    {"key": "gerry", "name": "Gerry Walsh", "role": "golf friend", "met": "Salthill golf club", "cadence": 14,
     "last_contacted": "2027-03-01T15:00"},
    {"key": "brendan", "name": "Brendan Cullinane", "role": "old colleague", "met": "St Joseph's school",
     "cadence": 60, "last_contacted": "2027-01-15T11:00"},
    {"key": "nuala", "name": "Nuala Hanley", "role": "neighbour", "met": "Salthill", "starred": True},
    {"key": "dr_nolan", "name": "Ruth Nolan", "role": "GP", "nickname": "Dr Nolan"},
    {"key": "dr_prasad", "name": "Anil Prasad", "role": "cardiologist", "nickname": "Dr Prasad"},
    {"key": "physio", "name": "Eimear Rooney", "role": "physiotherapist"},
    {"key": "audio", "name": "Colm Greene", "role": "audiologist"},
    {"key": "dentist", "name": "Fiona Lally", "role": "dentist"},
    {"key": "optician", "name": "Declan Joyce", "role": "optician", "met": "Shop Street"},
    {"key": "plumber", "name": "Michael Kelly", "role": "plumber"},
    {"key": "pat", "name": "Pat Keady", "role": "accountant", "cadence": 90, "last_contacted": "2026-12-10T11:00"},
    {"key": "kathleen", "name": "Kathleen Sullivan", "role": "Boston cousin", "met": "Boston"},
    {"key": "jack", "name": "Jack Sullivan", "role": "Boston cousin", "met": "Boston"},
    {"key": "eoin", "name": "Eoin Tierney", "role": "U12 hurler's dad", "met": "Kilcorran GAA"},
    {"key": "old_plumber", "name": "Bernard Hession", "role": "old plumber", "trashed": "2027-01-12T10:00"},
    {"key": "old_coach", "name": "Ciaran Naughton", "role": "old coach", "trashed": "2027-02-27T10:00"},
]

groups = [
    {"key": "bookclub", "name": "Book Club Kitty", "currency": "EUR",
     "members": ["siobhan", "mary_k", "sean_b", "brendan"], "created": "2026-12-05T20:00"},
    {"key": "gaa", "name": "Kilcorran Coaches Fund", "currency": "EUR",
     "members": ["tadhg", "padraig", "caoimhe", "sean_m"], "created": "2026-12-10T20:00"},
    {"key": "family", "name": "Family Birthdays", "currency": "EUR", "members": ["aoife", "conor", "maura"],
     "created": "2026-12-15T20:00"},
    {"key": "boston", "name": "Boston Trip", "currency": "USD", "members": ["declan", "kathleen", "jack"],
     "created": "2026-12-20T20:00"},
    {"key": "golf", "name": "Golf Society Pot", "currency": "EUR", "members": ["gerry", "brendan", "sean_m"],
     "created": "2027-01-05T20:00"},
    {"key": "camino", "name": "Camino 2027", "currency": "EUR", "members": ["gerry", "tadhg"],
     "created": "2027-02-20T20:00"},  # empty on purpose: no expenses yet
]

expenses = [
    {"group": "bookclub", "name": "Book order for March", "amount": 96, "paid_by": "siobhan",
     "split": ["me", "siobhan", "mary_k", "sean_b"], "date": "2027-02-10"},
    {"group": "bookclub", "name": "Wine and cheese", "amount": 60, "paid_by": "me",
     "split": ["me", "siobhan", "mary_k", "sean_b", "brendan"], "date": "2027-03-04"},
    {"group": "bookclub", "name": "Christmas dinner deposit", "amount": 150, "paid_by": "mary_k",
     "split": ["me", "siobhan", "mary_k", "brendan"], "date": "2026-12-12"},
    {"group": "gaa", "name": "New sliotars", "amount": 180, "paid_by": "tadhg", "split": ["me", "tadhg", "padraig"],
     "date": "2027-02-17"},
    {"group": "gaa", "name": "Training bibs", "amount": 120, "paid_by": "me", "split": ["me", "tadhg", "caoimhe"],
     "date": "2027-02-24"},
    {"group": "gaa", "name": "Minibus diesel", "amount": 75, "paid_by": "padraig", "split": ["me", "padraig", "sean_m"],
     "date": "2027-03-01"},
    {"group": "family", "name": "Maura's birthday cake", "amount": 48, "paid_by": "aoife", "split": ["me", "aoife", "conor"],
     "date": "2027-01-23"},
    {"group": "family", "name": "Cian's birthday present", "amount": 90, "paid_by": "me", "split": ["me", "maura"],
     "date": "2027-02-27"},
    {"group": "boston", "name": "Fenway tickets", "amount": 240, "paid_by": "declan",
     "split": ["me", "declan", "kathleen", "jack"], "date": "2026-12-27"},
    {"group": "boston", "name": "Dinner in the North End", "amount": 180, "paid_by": "me",
     "split": ["me", "declan", "kathleen"], "date": "2026-12-28"},
    {"group": "boston", "name": "Hire car", "amount": 310, "paid_by": "jack", "split": ["me", "declan", "jack"],
     "date": "2026-12-29"},
    {"group": "golf", "name": "Society prizes", "amount": 120, "paid_by": "gerry", "split": ["me", "gerry", "brendan"],
     "date": "2027-02-06"},
    {"group": "golf", "name": "Fees for the outing", "amount": 210, "paid_by": "me", "split": ["me", "gerry", "sean_m"],
     "date": "2027-02-20"},
]

lists = [
    {"key": "house_list", "name": "House", "area": "home"},
    {"key": "health_list", "name": "Health", "area": "family"},
    {"key": "gaa_list", "name": "Kilcorran GAA", "area": "social"},
    {"key": "family_list", "name": "Family", "area": "family"},
    {"key": "club_list", "name": "Book club and golf", "area": "social"},
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


weekly("physio", "Physio - knee", "2027-02-01", "2027-03-29", "10:00", "10:45", cancel=("2027-02-15",),
       attendees=["physio"])
weekly("grandkids", "Minding Cian and Saoirse", "2027-02-03", "2027-04-07", "15:00", "18:00",
       cancel=("2027-02-17",), attendees=["cian", "saoirse"])
weekly("calldec", "Call Declan", "2027-02-07", "2027-04-04", "18:00", "18:30", skip=("2027-03-28",),
       cancel=("2027-02-07",), attendees=["declan"])
weekly("training", "Hurling training", "2027-02-16", "2027-04-06", "18:30", "19:45", cancel=("2027-03-02",),
       attendees=["tadhg", "eoin"])

ev("bookclub_jan", "Book club", "2027-01-07T19:30", "2027-01-07T21:30", attendees=["siobhan", "mary_k", "sean_b"])
ev("bookclub_feb", "Book club", "2027-02-04T19:30", "2027-02-04T21:30", attendees=["siobhan", "mary_k", "sean_b"])
ev("bookclub_mar", "Book club", "2027-03-04T19:30", "2027-03-04T21:30", attendees=["siobhan", "mary_k", "sean_b"])
ev("bookclub_apr", "Book club", "2027-04-01T19:30", "2027-04-01T21:30", attendees=["siobhan", "mary_k", "sean_b"],
   description="Hamnet, Siobhan hosts")
ev("hurling_match", "Hurling match v Oranmore", "2027-03-13T11:00", "2027-03-13T13:00", attendees=["tadhg", "eoin"])
ev("hurling_match2", "Hurling match v Clarinbridge", "2027-03-27T11:00", "2027-03-27T13:00", attendees=["tadhg"])
ev("hurling_match_old", "Hurling match v Tuam", "2027-02-13T11:00", "2027-02-13T13:00", attendees=["tadhg"],
   cancelled=True)
ev("gaa_agm", "Kilcorran GAA AGM", "2027-03-18T20:00", "2027-03-18T22:00", attendees=["sean_m", "caoimhe", "padraig"],
   description="bring the treasurer's note")
ev("cardio", "Cardiology clinic", "2027-03-24T11:00", "2027-03-24T11:45", attendees=["dr_prasad"])
ev("cardio_bloods", "Cardiology bloods", "2027-03-22T08:30", "2027-03-22T09:00", attendees=["dr_prasad"])
ev("cardio_old", "Cardiology clinic", "2027-01-27T11:00", "2027-01-27T11:45", attendees=["dr_prasad"])
ev("physio_review", "Physio review", "2027-03-30T10:00", "2027-03-30T10:30", attendees=["physio"])
ev("gp", "GP check-up", "2027-03-16T09:30", "2027-03-16T10:00", attendees=["dr_nolan"])
ev("hearing", "Hearing test", "2027-03-12T14:00", "2027-03-12T15:00", attendees=["audio"])
ev("eyes", "Eye test", "2027-04-08T10:30", "2027-04-08T11:15", attendees=["optician"])
ev("dentist_liam", "Dentist - Liam", "2027-03-19T09:00", "2027-03-19T09:45", attendees=["dentist"])
ev("dentist_cian", "Dentist - Cian", "2027-03-30T16:00", "2027-03-30T16:30", attendees=["dentist", "cian"])
ev("stpat", "St Patrick's Day parade", "2027-03-17T12:00", "2027-03-17T14:30", attendees=["maura", "aoife", "cian", "saoirse"])
ev("stpat_dinner", "St Patrick's dinner at Aoife's", "2027-03-17T18:30", "2027-03-17T21:00", attendees=["aoife"])
ev("good_friday", "Good Friday walk to the Spanish Arch", "2027-03-26T11:00", "2027-03-26T12:30", attendees=["maura"])
ev("easter", "Easter Sunday lunch", "2027-03-28T13:00", "2027-03-28T16:00", attendees=["aoife", "conor", "oisin", "maura"])
ev("golf_outing", "Golf society outing", "2027-03-20T10:00", "2027-03-20T15:30", attendees=["gerry", "brendan"])
ev("golf_old", "Golf society outing", "2027-02-20T10:00", "2027-02-20T15:30", attendees=["gerry", "brendan", "sean_m"])
ev("dinner_nuala", "Dinner with Nuala and Frank", "2027-03-13T19:30", "2027-03-13T22:00", attendees=["nuala"])
ev("coffee_brendan", "Coffee with Brendan", "2027-03-11T11:00", "2027-03-11T12:00", attendees=["brendan"])
ev("tax_pat", "Tax return with Pat", "2027-03-25T14:30", "2027-03-25T15:30", attendees=["pat"])
ev("boiler", "Boiler service", "2027-03-15T07:45", "2027-03-15T09:15", attendees=["plumber"])
ev("mass_baptism", "Oisin's christening in Dublin", "2027-04-17T12:00", "2027-04-17T16:00",
   attendees=["conor", "oisin", "fr_tom"])
ev("fly_dublin", "Train to Dublin", "2027-04-16T09:00", "2027-04-16T11:45")
ev("boston_trip", "Boston visit", "2026-12-26T10:00", "2027-01-02T20:00", attendees=["declan", "kathleen", "jack"])
ev("camino_start", "Camino walk begins", "2027-05-17T08:00", "2027-06-14T18:00", attendees=["gerry", "tadhg"])
ev("communion", "Cian's First Communion", "2027-05-15T11:00", "2027-05-15T13:30", attendees=["cian", "fr_tom", "aoife"])
ev("old_coffee", "Coffee with Ciaran", "2027-02-02T11:00", "2027-02-02T12:00", attendees=["old_coach"],
   trashed="2027-02-27T10:30")
ev("old_plumber_visit", "Plumber visit", "2026-12-10T10:00", "2026-12-10T11:00", attendees=["old_plumber"],
   trashed="2027-01-12T10:30")

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


for mo, due, done in [("nov", "2026-11-20", "2026-11-19T21:00"), ("jan", "2027-01-20", "2027-01-19T20:00"),
                      ("mar_old", "2027-03-02", "2027-03-02T09:10")]:
    task(f"esb_{mo}", "Pay ESB bill", "house_list", due, done)
task("esb_mar", "Pay ESB bill", "house_list", "2027-03-20", priority=1)

for due, done, k in [("2026-12-01", "2026-11-30T10:00", "dec"), ("2027-01-02", "2027-01-02T11:00", "jan"),
                     ("2027-02-01", "2027-02-01T09:30", "feb"), ("2027-03-01", "2027-03-01T10:15", "mar")]:
    task(f"rx_{k}", "Order repeat prescription", "health_list", due, done)
task("rx_apr", "Order repeat prescription", "health_list", "2027-04-01", priority=1)

d = dt.date(2027, 1, 12)
while d <= dt.date(2027, 3, 23):
    iso = d.isoformat()
    task(f"bins_{iso[5:7]}{iso[8:]}", "Put the bins out", "house_list", f"{iso}T20:00",
         None if d >= dt.date(2027, 3, 9) else f"{iso}T20:10")
    d += dt.timedelta(days=14)

task("easter_proj", "Easter weekend with the family", "family_list", "2027-03-28", priority=2, status="in_progress")
for k, name, due, done, extra in [
    ("lamb", "Order the lamb from the butcher", "2027-03-22", None, {"effort": 15}),
    ("eggs", "Buy Easter eggs for the grandchildren", "2027-03-25", None, {"effort": 45}),
    ("beds", "Make up the spare beds for Conor", "2027-03-26", None, {"effort": 30}),
    ("flowers", "Flowers for the grave", "2027-03-24", None, {"effort": 30}),
    ("menu", "Plan the Easter menu with Mo", "2027-03-07", "2027-03-07T17:00", {}),
]:
    task(f"easter_{k}", name, "family_list", due, done, parent="easter_proj", **extra)

task("camino_proj", "Camino 2027 preparation", "club_list", "2027-05-17", status="in_progress", priority=2)
for k, name, due, done, extra in [
    ("boots", "Break in the new boots", "2027-04-15", None, {"effort": 240}),
    ("flights", "Book the flights to Porto", "2027-03-14", None, {"priority": 1}),
    ("credentials", "Order the pilgrim credentials", "2027-02-28", "2027-02-26T15:00", {}),
    ("insurance", "Sort travel insurance", "2027-04-10", None, {"effort": 30}),
    ("knee", "Ask Dr Prasad about the walking", "2027-03-24", None, {}),
]:
    task(f"camino_{k}", name, "club_list", due, done, parent="camino_proj", **extra)

task("garden_proj", "Spring garden clean-up", "house_list", "2027-04-30", status="in_progress")
for k, name, due, done in [("prune", "Prune the roses", "2027-03-14", None), ("shed", "Tidy the shed", "2027-03-28", None),
                           ("seeds", "Buy vegetable seeds", "2027-03-12", None),
                           ("lawn", "First cut of the lawn", "2027-04-10", None),
                           ("bulbs", "Plant the new bulbs", "2026-11-05", "2026-11-04T15:00")]:
    task(f"garden_{k}", name, "house_list", due, done, parent="garden_proj")

task("communion_dress", "Book Cian's communion suit fitting", "family_list", "2027-04-05", effort=20)
task("communion_cake", "Book Cian's communion cake", "family_list", "2027-04-20")
task("conor_visit", "Book the train to Dublin", "family_list", "2027-03-30", effort=10)
task("saoirse_party", "Plan Saoirse's birthday party", "family_list", "2027-05-01", priority=2)
task("aoife_key", "Return Aoife's spare key", "family_list", "2027-03-12", effort=5)

task("gaa_report", "Write the treasurer's note for the AGM", "gaa_list", "2027-03-16", priority=2, effort=60)
task("gaa_dues", "Collect U12 membership dues", "gaa_list", "2027-03-31", priority=1)
task("gaa_dues_old", "Collect U12 membership dues", "gaa_list", "2026-12-18", "2026-12-18T20:30")
task("gaa_sliotars", "Wash the training sliotars", "gaa_list", "2027-03-11", effort=20)
task("gaa_insurance", "Check the club insurance cert", "gaa_list", "2027-03-25")
task("gaa_minibus", "Book the minibus for the Clarinbridge match", "gaa_list", "2027-03-22", effort=10)
task("gaa_vests", "Order new training bibs", "gaa_list", "2027-02-20", "2027-02-17T18:00")

task("hearing_aid", "Collect the hearing aid moulds", "health_list", "2027-03-12", effort=30)
task("flu_jab", "Book the flu jab", "health_list", "2026-10-10", "2026-10-09T10:00")
task("bp_log", "Write up the blood pressure log", "health_list", "2027-03-22", effort=15)
task("knee_ex", "Do the knee exercises", "health_list", "2027-03-10", effort=20)
task("eye_form", "Fill in the eye clinic form", "health_list", "2027-04-01")

task("book_next", "Read the next book club pick", "club_list", "2027-03-31", effort=240)
task("book_pay", "Pay Siobhan for the books", due="2027-03-10", effort=5)
task("golf_fee", "Pay the golf society fee", "club_list", "2027-03-18", effort=5)
task("pay_declan", "Pay Dec for the hire car", due="2027-03-15", priority=1)
task("cancelled_shed", "Build a new shed", "house_list", status="cancelled")
task("cancelled_patio", "Lay the patio", "house_list", status="cancelled")
task("old_gate", "Fix the garden gate", "house_list", trashed="2027-03-03T10:00")
task("old_quote", "Get a quote for the roof", trashed="2027-01-12T10:15")

# ----------------------------------------------------------------------------------------------
# notes
# ----------------------------------------------------------------------------------------------

notebooks = [
    {"key": "book_nb", "name": "Book Club Notes"},
    {"key": "gaa_nb", "name": "GAA Notebook"},
    {"key": "health_nb", "name": "Health Log"},
    {"key": "garden_nb", "name": "Garden"},
]

notes = [
    {"key": "bk_jan", "name": "January book - Small Things Like These", "notebook": "book_nb",
     "created": "2027-01-07T22:00", "body": "short and sad, Sean B thought the ending too soft, Mary K cried twice"},
    {"key": "bk_feb", "name": "February book - Normal People", "notebook": "book_nb", "created": "2027-02-04T22:00",
     "body": "split evening, Brendan had not finished, Siobhan loved the Galway scenes"},
    {"key": "bk_mar", "name": "March book - The Glass Hotel", "notebook": "book_nb", "created": "2027-03-04T22:00",
     "body": "good discussion on the fraud plot, next month is Hamnet at Siobhan's"},
    {"key": "bk_rules", "name": "Book club rules", "notebook": "book_nb", "created": "2026-12-05T20:30", "pinned": True,
     "body": "first Thursday of the month, host picks the book, five euro each into the kitty"},
    {"key": "bk_list", "name": "Books to suggest", "notebook": "book_nb", "created": "2027-01-15T19:00",
     "body": "The Heather Blazing, Foster, Trespasses, a Maeve Brennan collection"},
    {"key": "gaa_u12", "name": "U12 squad", "notebook": "gaa_nb", "created": "2027-02-08T20:00", "pinned": True,
     "body": "twenty two players, six new this year, Eoin's lad is the best with the hurl"},
    {"key": "gaa_drills", "name": "Training drills", "notebook": "gaa_nb", "created": "2027-02-10T19:00",
     "body": "ground ball relay, wall passes, handpass triangles, finish with a small sided game"},
    {"key": "gaa_garda", "name": "Garda vetting reminder", "notebook": "gaa_nb", "created": "2027-02-12T10:00",
     "body": "all coaches renew vetting every three years, Liam's is due in October, Caoimhe has the forms"},
    {"key": "gaa_match1", "name": "Match notes v Athenry", "notebook": "gaa_nb", "created": "2027-02-06T13:30",
     "body": "lost by two points, subs came on late, work on the puck-outs"},
    {"key": "gaa_agm_note", "name": "AGM agenda", "notebook": "gaa_nb", "created": "2027-03-02T20:30",
     "body": "chairman's report, accounts, new pitch lights, elections for secretary"},
    {"key": "gaa_fees", "name": "Membership fees", "notebook": "gaa_nb", "created": "2027-01-10T10:00",
     "body": "juvenile fifty, adult hundred and twenty, family cap two hundred"},
    {"key": "hl_bp", "name": "Blood pressure log", "notebook": "health_nb", "created": "2027-02-01T08:00",
     "body": "morning readings mostly 128 over 82, one spike after the match, tablets at breakfast"},
    {"key": "hl_cardio", "name": "Cardiology notes", "notebook": "health_nb", "created": "2027-01-27T12:30",
     "body": "Dr Prasad happy with the echo, bloods again in March, no heavy lifting until review"},
    {"key": "hl_knee", "name": "Knee physio plan", "notebook": "health_nb", "created": "2027-01-18T11:00", "pinned": True,
     "body": "squats to a chair, straight leg raises, no hurling drills with the lads yet"},
    {"key": "hl_hearing", "name": "Hearing questions", "notebook": "health_nb", "created": "2027-03-01T09:00",
     "body": "ask about the cost of the aids, battery life, whether the HSE grant applies"},
    {"key": "hl_meds", "name": "Medication list", "notebook": "health_nb", "created": "2026-12-02T09:00",
     "body": "blood pressure tablet in the morning, statin at night, aspirin with lunch"},
    {"key": "gd_roses", "name": "Rose pruning", "notebook": "garden_nb", "created": "2027-03-01T15:00",
     "body": "after the frosts, cut to an outward bud, bin the diseased stems"},
    {"key": "gd_veg", "name": "Vegetable plan", "notebook": "garden_nb", "created": "2027-02-15T16:00",
     "body": "potatoes by Patrick's Day, onions, scallions, tomatoes under cover in April"},
    {"key": "diary_walk", "name": "Diary entry - Salthill walk", "created": "2027-02-27T21:00",
     "body": "windy promenade, Mo walked faster than me, a swim off Blackrock would have finished me"},
    {"key": "diary_cian", "name": "Diary entry - Cian's goal", "created": "2027-03-06T20:00",
     "body": "Cian scored his first goal in the under-nines, ice cream on the way home"},
    {"key": "boston_notes", "name": "Boston visit notes", "created": "2027-01-02T22:00",
     "body": "Fenway tour, Dec's new knee, lobster rolls, Kathleen's fiftieth, snow to the ankles"},
    {"key": "mo_gifts", "name": "Gift ideas for Mo", "created": "2027-02-10T21:00",
     "body": "a new walking jacket, concert tickets in the Town Hall, a piece of Claddagh jewellery"},
    {"key": "recipe_stew", "name": "Irish stew", "created": "2026-12-12T18:00",
     "body": "lamb neck, carrots, onions, potatoes, a little pearl barley, simmer two hours"},
    {"key": "car_notes", "name": "Car reg and NCT", "created": "2026-12-01T12:00",
     "body": "211 G 4821, NCT due in June, tyres at 2.3 bar"},
    {"key": "old_idea", "name": "Old idea - poteen museum", "created": "2026-12-20T10:00",
     "body": "a heritage trail around Connemara", "trashed": "2027-01-15T10:00"},
    {"key": "old_scratch", "name": "Scratch list", "created": "2027-03-01T10:00", "body": "bread, rashers, milk",
     "trashed": "2027-03-04T10:00"},
]

# ----------------------------------------------------------------------------------------------
# documents
# ----------------------------------------------------------------------------------------------

folders = [
    {"key": "pension_f", "name": "Pension and Tax"},
    {"key": "health_f", "name": "Health"},
    {"key": "gaa_f", "name": "Kilcorran GAA"},
    {"key": "house_f", "name": "House"},
    {"key": "travel_f", "name": "Travel"},
    {"key": "empty_f", "name": "To file"},  # stays empty
]

documents = [
    {"key": "pension_stmt", "name": "Teachers pension statement 2026", "folder": "pension_f", "created": "2027-01-15T10:00",
     "starred": True},
    {"key": "pension_stmt25", "name": "Teachers pension statement 2025", "folder": "pension_f", "created": "2026-01-15T10:00"},
    {"key": "tax_2025", "name": "Tax return 2025", "folder": "pension_f", "created": "2026-10-30T10:00"},
    {"key": "tax_2024", "name": "Tax return 2024", "folder": "pension_f", "created": "2025-10-28T10:00"},
    {"key": "echo_report", "name": "Echo report January", "folder": "health_f", "created": "2027-01-27T12:00", "starred": True},
    {"key": "hospital_letter", "name": "Hospital appointment letter", "folder": "health_f", "created": "2027-02-10T10:00"},
    {"key": "vhi_policy", "name": "VHI policy 2027", "folder": "health_f", "created": "2027-01-05T10:00"},
    {"key": "gaa_constitution", "name": "Club constitution", "folder": "gaa_f", "created": "2026-12-10T09:00"},
    {"key": "gaa_accounts", "name": "Club accounts 2026", "folder": "gaa_f", "created": "2027-02-25T09:00"},
    {"key": "gaa_vetting", "name": "Garda vetting forms", "folder": "gaa_f", "created": "2027-02-12T09:00"},
    {"key": "house_ins", "name": "House insurance 2027", "folder": "house_f", "created": "2027-01-12T10:00", "starred": True},
    {"key": "house_ins26", "name": "House insurance 2026", "folder": "house_f", "created": "2026-01-12T10:00"},
    {"key": "boiler_cert", "name": "Boiler service cert 2026", "folder": "house_f", "created": "2026-03-17T10:00"},
    {"key": "camino_plan", "name": "Camino itinerary", "folder": "travel_f", "created": "2027-02-22T10:00"},
    {"key": "boston_tickets", "name": "Boston flights December", "folder": "travel_f", "created": "2026-10-05T10:00"},
    {"key": "passport_scan", "name": "Passport scan", "created": "2026-12-01T10:00"},
    {"key": "will_copy", "name": "Will copy 2025", "created": "2025-06-10T10:00"},
    {"key": "christening_inv", "name": "Christening invitation", "created": "2027-02-14T10:00"},
    {"key": "old_roof_doc", "name": "Old roof quote", "folder": "house_f", "created": "2026-11-01T10:00",
     "trashed": "2027-01-12T10:20"},
    {"key": "old_scan", "name": "Old vetting form", "folder": "gaa_f", "created": "2024-02-01T10:00",
     "trashed": "2027-03-01T10:00"},
]

# ----------------------------------------------------------------------------------------------
# photos
# ----------------------------------------------------------------------------------------------

albums = [
    {"key": "grand_album", "name": "Grandchildren"},
    {"key": "hurl_album", "name": "Kilcorran Hurling"},
    {"key": "boston_album", "name": "Boston Christmas"},
    {"key": "garden_album", "name": "The Garden"},
]

photos = [
    {"key": "p_cian_goal", "name": "Cian's first goal", "taken": "2027-03-06T11:40", "albums": ["grand_album"],
     "people": ["cian", "aoife"], "starred": True},
    {"key": "p_saoirse_bday", "name": "Saoirse's fifth birthday", "taken": "2026-05-02T15:00", "albums": ["grand_album"],
     "people": ["saoirse"], "starred": True},
    {"key": "p_oisin_first", "name": "Oisin at three months", "taken": "2026-12-20T12:00", "albums": ["grand_album"],
     "people": ["oisin", "conor"], "starred": True},
    {"key": "p_wed_minding", "name": "Wednesday minding crew", "taken": "2027-02-24T16:30", "albums": ["grand_album"],
     "people": ["cian", "saoirse"]},
    {"key": "p_cian_hurl", "name": "Cian with the hurl", "taken": "2027-01-30T10:30", "albums": ["grand_album", "hurl_album"],
     "people": ["cian"]},
    {"key": "p_saoirse_beach", "name": "Saoirse at Silver Strand", "taken": "2026-08-15T14:00", "albums": ["grand_album"],
     "people": ["saoirse", "aoife"]},
    {"key": "p_cian_snow", "name": "Cian and the snowman", "taken": "2027-01-10T11:30", "albums": ["grand_album"],
     "people": ["cian"]},
    {"key": "p_xmas_kids", "name": "Christmas morning", "taken": "2026-12-25T09:30", "albums": ["grand_album"],
     "people": ["cian", "saoirse", "oisin"]},
    {"key": "p_hurl_team", "name": "U12 squad photo", "taken": "2027-02-14T11:00", "albums": ["hurl_album"],
     "people": ["tadhg", "eoin"], "starred": True},
    {"key": "p_hurl_drill", "name": "Wall passes drill", "taken": "2027-02-23T19:00", "albums": ["hurl_album"],
     "people": ["tadhg"]},
    {"key": "p_hurl_match", "name": "Match v Athenry", "taken": "2027-02-06T11:20", "albums": ["hurl_album"],
     "people": ["tadhg", "sean_m"]},
    {"key": "p_hurl_bibs", "name": "New training bibs", "taken": "2027-02-24T18:20", "albums": ["hurl_album"],
     "people": ["caoimhe"]},
    {"key": "p_hurl_pitch", "name": "Frosty pitch", "taken": "2027-01-26T08:30", "albums": ["hurl_album"]},
    {"key": "p_hurl_cup", "name": "Presentation of the county cup", "taken": "2026-11-21T20:00", "albums": ["hurl_album"],
     "people": ["sean_m", "padraig"]},
    {"key": "p_bos_fenway", "name": "Fenway Park", "taken": "2026-12-27T19:00", "albums": ["boston_album"],
     "people": ["declan", "jack"], "starred": True},
    {"key": "p_bos_dec", "name": "Dec at the Common", "taken": "2026-12-28T12:00", "albums": ["boston_album"],
     "people": ["declan"], "starred": True},
    {"key": "p_bos_northend", "name": "Dinner in the North End", "taken": "2026-12-28T20:30", "albums": ["boston_album"],
     "people": ["declan", "kathleen"]},
    {"key": "p_bos_snow", "name": "Snow in Quincy", "taken": "2026-12-30T09:00", "albums": ["boston_album"]},
    {"key": "p_bos_kath", "name": "Kathleen's fiftieth", "taken": "2026-12-31T21:00", "albums": ["boston_album"],
     "people": ["kathleen", "jack"]},
    {"key": "p_bos_harbour", "name": "Boston harbour at dusk", "taken": "2027-01-01T16:30", "albums": ["boston_album"]},
    {"key": "p_gd_roses", "name": "The roses before pruning", "taken": "2027-03-01T15:30", "albums": ["garden_album"]},
    {"key": "p_gd_shed", "name": "The shed", "taken": "2027-02-15T16:20", "albums": ["garden_album"]},
    {"key": "p_gd_daffs", "name": "First daffodils", "taken": "2027-02-28T12:00", "albums": ["garden_album"],
     "people": ["maura"], "starred": True},
    {"key": "p_gd_veg", "name": "Raised beds laid out", "taken": "2026-11-05T15:00", "albums": ["garden_album"]},
    {"key": "p_gd_frost", "name": "Frost on the lawn", "taken": "2027-01-11T08:00", "albums": ["garden_album"]},
    {"key": "p_maura_walk", "name": "Mo on the prom", "taken": "2027-02-27T12:15", "people": ["maura"], "starred": True},
    {"key": "p_bookclub", "name": "Book club at Siobhan's", "taken": "2027-03-04T21:15",
     "people": ["siobhan", "mary_k", "sean_b"]},
    {"key": "p_golf", "name": "Golf outing group", "taken": "2027-02-20T14:30", "people": ["gerry", "brendan", "sean_m"]},
    {"key": "p_nuala", "name": "Nuala's garden party", "taken": "2026-08-22T17:00", "people": ["nuala"]},
    {"key": "p_aoife_house", "name": "Aoife's new kitchen", "taken": "2027-01-17T15:00", "people": ["aoife"]},
    {"key": "p_physio", "name": "Knee strapped up", "taken": "2027-01-18T11:20"},
    {"key": "p_sunset", "name": "Sunset off Salthill", "taken": "2027-02-27T17:45"},
    {"key": "p_cardio_letter", "name": "Photo of the hospital letter", "taken": "2027-02-10T10:30"},
    {"key": "p_mass", "name": "Mass at the Cathedral", "taken": "2027-01-24T11:00", "people": ["fr_tom"]},
    {"key": "p_blurry", "name": "Blurry photo", "taken": "2027-03-05T09:00", "trashed": "2027-03-07T09:00"},
    {"key": "p_receipt", "name": "Screenshot of the bibs receipt", "taken": "2027-02-24T14:00",
     "trashed": "2027-01-28T09:00"},
]

# ----------------------------------------------------------------------------------------------
# debts
# ----------------------------------------------------------------------------------------------

debts = [
    {"key": "d_aoife_cake", "person": "aoife", "direction": "owes_me", "amount": 16, "name": "cake share",
     "date": "2027-01-23"},
    {"key": "d_mary_k", "person": "mary_k", "direction": "i_owe", "amount": 37.5, "name": "Christmas dinner deposit",
     "date": "2026-12-12"},
    {"key": "d_siobhan", "person": "siobhan", "direction": "i_owe", "amount": 24, "name": "March books",
     "date": "2027-02-10"},
    {"key": "d_sean_b", "person": "sean_b", "direction": "owes_me", "amount": 12, "name": "wine and cheese share",
     "date": "2027-03-04"},
    {"key": "d_tadhg", "person": "tadhg", "direction": "i_owe", "amount": 60, "name": "sliotars share",
     "date": "2027-02-17"},
    {"key": "d_padraig", "person": "padraig", "direction": "i_owe", "amount": 25, "name": "minibus diesel share",
     "date": "2027-03-01"},
    {"key": "d_gerry", "person": "gerry", "direction": "owes_me", "amount": 70, "name": "golf outing fees",
     "date": "2027-02-20"},
    {"key": "d_declan", "person": "declan", "direction": "i_owe", "amount": 140, "name": "Boston hire car and tickets in euro",
     "date": "2026-12-29"},
    {"key": "d_nuala", "person": "nuala", "direction": "owes_me", "amount": 18, "name": "bin collection",
     "date": "2027-02-18"},
    {"key": "d_conor", "person": "conor", "direction": "owes_me", "amount": 200, "name": "baby gear loan",
     "date": "2026-11-10"},
    {"key": "d_plumber", "person": "plumber", "direction": "i_owe", "amount": 180, "name": "radiator valve",
     "date": "2027-01-20", "settled": "2027-01-22T10:00"},
    {"key": "d_brendan", "person": "brendan", "direction": "owes_me", "amount": 40, "name": "round of drinks",
     "date": "2026-12-12", "settled": "2026-12-19T10:00"},
    {"key": "d_eoin", "person": "eoin", "direction": "owes_me", "amount": 15, "name": "hurl grips",
     "date": "2027-02-10", "settled": "2027-02-17T10:00"},
]

# ----------------------------------------------------------------------------------------------
# locker
# ----------------------------------------------------------------------------------------------

locker = [
    {"key": "aib_login", "name": "AIB online banking", "type": "login", "username": "liam.obrien61",
     "url": "https://aib.ie", "password": "Salthill#Hurl61", "starred": True},
    {"key": "revenue_login", "name": "Revenue MyAccount", "type": "login", "username": "6543210A",
     "url": "https://revenue.ie", "password": "TaxReturn!Oct26"},
    {"key": "hse_login", "name": "HSE patient portal", "type": "login", "username": "liam.obrien@eircom.net",
     "url": "https://hse.ie", "password": "Cardiology-Mar27"},
    {"key": "aib_card", "name": "AIB debit card", "type": "card", "card_number": "4929384712039921", "cvv": "507"},
    {"key": "joint_acct", "name": "Joint account with Maura", "type": "bank_account",
     "notes": "AIB Salthill, IBAN IE29 AIBK 9311 5212 3456 78", "starred": True},
    {"key": "home_wifi", "name": "Home wifi", "type": "wifi", "password": "Granda&Nana1966", "starred": True},
    {"key": "aoife_wifi", "name": "Aoife's wifi", "type": "wifi", "password": "CianSaoirse2019"},
    {"key": "gate_code", "name": "GAA pitch gate code", "type": "note", "notes": "1916 then the key"},
    {"key": "revolut_pw", "name": "Revolut app", "type": "password", "password": "GalwayRev#44"},
    {"key": "pps_id", "name": "PPS number card", "type": "identity"},
    {"key": "passport", "name": "Passport - Liam", "type": "passport", "notes": "no. PA1234567, expires 2031-08-09"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence", "notes": "IE 0123456789"},
    {"key": "gaa_member", "name": "Kilcorran GAA membership", "type": "membership",
     "notes": "family membership, paid to December", "starred": True},
    {"key": "weather_api", "name": "Weather API key", "type": "api_credential", "notes": "for the pitch-conditions widget"},
    {"key": "nas_ssh", "name": "Home NAS SSH key", "type": "ssh_key", "notes": "photos server under the stairs"},
    {"key": "office_lic", "name": "Microsoft 365 licence", "type": "software_licence", "notes": "family, renews 1 August"},
    {"key": "btc", "name": "Crypto wallet", "type": "crypto_wallet", "notes": "small, Conor set it up, about 250 euro"},
    {"key": "will", "name": "Will - signed copy", "type": "document",
     "notes": "original with the solicitor on Eyre Square, copy in the Pension and Tax folder"},
    {"key": "old_wifi", "name": "Old Tuam road wifi", "type": "wifi", "password": "Tuam2020Wifi",
     "trashed": "2026-12-15T10:00"},
    {"key": "old_login", "name": "Old Eir login", "type": "login", "username": "lobrien61",
     "password": "OldEir12", "trashed": "2027-03-02T10:00"},
]

links = [
    {"from": "easter_lamb", "to": "maura"},
    {"from": "easter_eggs", "to": "cian"},
    {"from": "easter_beds", "to": "conor"},
    {"from": "communion_dress", "to": "cian"},
    {"from": "communion_cake", "to": "aoife"},
    {"from": "conor_visit", "to": "conor"},
    {"from": "saoirse_party", "to": "saoirse"},
    {"from": "aoife_key", "to": "aoife"},
    {"from": "gaa_report", "to": "padraig"},
    {"from": "gaa_dues", "to": "caoimhe"},
    {"from": "gaa_minibus", "to": "tadhg"},
    {"from": "camino_flights", "to": "gerry"},
    {"from": "camino_knee", "to": "dr_prasad"},
    {"from": "hearing_aid", "to": "audio"},
    {"from": "eye_form", "to": "optician"},
    {"from": "rx_apr", "to": "dr_nolan"},
    {"from": "book_pay", "to": "siobhan"},
    {"from": "pay_declan", "to": "declan"},
    {"from": "golf_fee", "to": "gerry"},
    {"from": "bk_jan", "to": "sean_b"},
    {"from": "bk_mar", "to": "siobhan"},
    {"from": "gaa_u12", "to": "tadhg"},
    {"from": "gaa_match1", "to": "tadhg"},
    {"from": "hl_cardio", "to": "dr_prasad"},
    {"from": "hl_knee", "to": "physio"},
    {"from": "boston_notes", "to": "declan"},
    {"from": "mo_gifts", "to": "maura"},
    {"from": "diary_cian", "to": "cian"},
    {"from": "gd_roses", "to": "maura"},
]

world = {
    "me": ME, "today": TODAY, "epoch": "2026-11-01T09:00", "seed": "T37", "currency": "EUR",
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
    (HERE / "T37.json").write_text(json.dumps(world, indent=1, ensure_ascii=False) + "\n")
    counts = {k: len(v) for k, v in world.items() if isinstance(v, list)}
    print("T37:", counts)
