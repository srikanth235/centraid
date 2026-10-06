"""World T35: Freya Lindqvist's household vault (Tromso, marine biologist, NOK vault).

    python3 authored/worlds/T35_build.py      # writes authored/worlds/T35.json (deterministic)

Today in the sessions is Thursday 2026-11-12 19:20 (home from the lab, Jonas arrives tomorrow).

Persona: Freya Lindqvist, 44, a marine biologist at the university marine lab in Tromso. Divorced from
Henrik Dahl; their son Jonas (15) lives with her on alternate weeks (handover every second Friday). She
keeps the kitty of the Tromso Seilforening sailing club, her parents Per and Ingrid are in Bergen and her
sister Astrid is in Oslo. The vault is in NOK; the one foreign-currency position is the EUR group
"Kiel Week 2026" (a vault debt can only be in the vault's own currency).

Built-in ambiguity: two Larses (Lars Hansen, club commodore; Lars Eide, colleague) and two Ingrids (her
mother, "Mamma", and Ingrid Moe, a neighbour), look-alike events (Dinner with Astrid, Dentist check-up vs
Dentist - Jonas, Lab meeting vs Cod team meeting, Coffee with Kjersti), near-duplicate tasks (four Pay
mortgage, nine Stock the fridge for Jonas, two grant reports), nicknames (Mamma, Pappa, Commodore, Prof
Marit), hard-to-spell names (Kjersti Jossang, Gunnhild Odegard, Hjordis Thorbjornsen), cancelled events,
completed and cancelled tasks, an empty group and an empty folder, and trashed rows of every trashable
kind (one inside the 30-day restore window, one past it).
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

ME = "Freya Lindqvist"
TODAY = "2026-11-12T19:20"
TODAY_D = dt.date(2026, 11, 12)

people = [
    {"key": "jonas", "name": "Jonas Lindqvist", "role": "son", "starred": True, "cadence": 1,
     "last_contacted": "2026-11-12T07:50", "last_contacted_kind": "message", "created": "2026-01-05T09:00"},
    {"key": "henrik", "name": "Henrik Dahl", "role": "ex-husband", "cadence": 7,
     "last_contacted": "2026-11-10T20:15", "last_contacted_kind": "message", "met": "Tromso"},
    {"key": "mamma", "name": "Ingrid Lindqvist", "role": "mum", "nickname": "Mamma", "starred": True, "cadence": 7,
     "last_contacted": "2026-11-09T18:00", "last_contacted_kind": "call", "met": "Bergen"},
    {"key": "pappa", "name": "Per Lindqvist", "role": "dad", "nickname": "Pappa", "cadence": 14,
     "last_contacted": "2026-11-01T17:30", "last_contacted_kind": "call", "met": "Bergen"},
    {"key": "astrid", "name": "Astrid Lindqvist", "role": "sister", "starred": True, "cadence": 10,
     "last_contacted": "2026-11-05T21:00", "met": "Oslo"},
    {"key": "ingrid_m", "name": "Ingrid Moe", "role": "neighbour", "met": "Storgata"},
    {"key": "nils", "name": "Nils Hagen", "role": "neighbour", "met": "Storgata"},
    {"key": "lars_h", "name": "Lars Hansen", "role": "club commodore", "nickname": "Commodore", "starred": True,
     "met": "Tromso Seilforening", "cadence": 14, "last_contacted": "2026-10-30T19:00"},
    {"key": "lars_e", "name": "Lars Eide", "role": "colleague", "met": "marine lab", "cadence": 7,
     "last_contacted": "2026-11-12T10:30"},
    {"key": "marit", "name": "Marit Solberg", "role": "group leader", "nickname": "Prof Marit", "met": "marine lab",
     "cadence": 14, "last_contacted": "2026-11-09T09:30"},
    {"key": "ola", "name": "Ola Strand", "role": "lab technician", "met": "marine lab"},
    {"key": "sigrid", "name": "Sigrid Berg", "role": "PhD student", "met": "marine lab", "cadence": 7,
     "last_contacted": "2026-11-11T15:00"},
    {"key": "torunn", "name": "Torunn Hauge", "role": "lab manager", "met": "marine lab"},
    {"key": "roar", "name": "Roar Johansen", "role": "vessel skipper", "met": "research vessel"},
    {"key": "tuva", "name": "Tuva Ronningen", "role": "club treasurer", "met": "Tromso Seilforening"},
    {"key": "hjordis", "name": "Hjordis Thorbjornsen", "role": "club secretary", "met": "Tromso Seilforening"},
    {"key": "bjorn", "name": "Bjorn Nilsen", "role": "sailing friend", "met": "Tromso Seilforening", "cadence": 21,
     "last_contacted": "2026-10-18T14:00"},
    {"key": "kjersti", "name": "Kjersti Jossang", "role": "friend", "starred": True, "cadence": 10,
     "last_contacted": "2026-11-07T16:00", "met": "university"},
    {"key": "gunnhild", "name": "Gunnhild Odegard", "role": "dive buddy", "met": "dive club"},
    {"key": "siv", "name": "Siv Karlsen", "role": "friend", "met": "yoga"},
    {"key": "eirik", "name": "Eirik Haugen", "role": "football coach", "met": "Jonas's team"},
    {"key": "hanne", "name": "Hanne Saether", "role": "Jonas's teacher", "met": "Tromso videregaende"},
    {"key": "dr_vik", "name": "Thea Vik", "role": "GP", "nickname": "Dr Vik"},
    {"key": "mikkel", "name": "Mikkel Aas", "role": "dentist"},
    {"key": "trond", "name": "Trond Mathisen", "role": "boatyard owner", "met": "Skattora"},
    {"key": "frode", "name": "Frode Lund", "role": "mechanic"},
    {"key": "elin", "name": "Elin Krog", "role": "accountant", "cadence": 90, "last_contacted": "2026-08-20T11:00"},
    {"key": "jens", "name": "Jens Petersen", "role": "Kiel crew", "met": "Kiel"},
    {"key": "mia", "name": "Mia Schroder", "role": "Kiel crew", "met": "Kiel"},
    {"key": "old_broker", "name": "Svein Aune", "role": "old boat broker", "trashed": "2026-08-30T10:00"},
    {"key": "old_builder", "name": "Camilla Roth", "role": "old contractor", "trashed": "2026-11-05T10:00"},
]

groups = [
    {"key": "seilklubb", "name": "Seilforening Kitty", "currency": "NOK",
     "members": ["lars_h", "tuva", "hjordis", "bjorn", "roar"], "created": "2026-02-10T19:00"},
    {"key": "lab_coffee", "name": "Lab Coffee Club", "currency": "NOK", "members": ["lars_e", "ola", "sigrid", "marit"],
     "created": "2026-01-12T09:00"},
    {"key": "jonas_costs", "name": "Jonas Shared Costs", "currency": "NOK", "members": ["henrik"],
     "created": "2026-01-05T10:00"},
    {"key": "kiel", "name": "Kiel Week 2026", "currency": "EUR", "members": ["jens", "mia", "bjorn"],
     "created": "2026-04-02T20:00"},
    {"key": "bergen", "name": "Bergen Family", "currency": "NOK", "members": ["mamma", "pappa", "astrid"],
     "created": "2026-03-01T20:00"},
    {"key": "hurtigruten", "name": "Hurtigruten 2027", "currency": "NOK", "members": ["kjersti", "gunnhild"],
     "created": "2026-11-02T20:00"},  # empty on purpose: no expenses yet
]

expenses = [
    {"group": "seilklubb", "name": "Race buoys", "amount": 5400, "paid_by": "me",
     "split": ["me", "lars_h", "tuva", "hjordis", "bjorn"], "date": "2026-05-12"},
    {"group": "seilklubb", "name": "Rescue boat fuel", "amount": 2100, "paid_by": "roar",
     "split": ["me", "lars_h", "roar", "bjorn"], "date": "2026-07-04"},
    {"group": "seilklubb", "name": "Season end pizza", "amount": 1800, "paid_by": "tuva",
     "split": ["me", "lars_h", "tuva", "hjordis", "bjorn", "roar"], "date": "2026-10-03"},
    {"group": "seilklubb", "name": "Lift-out crane", "amount": 6000, "paid_by": "lars_h",
     "split": ["me", "lars_h", "tuva", "bjorn"], "date": "2026-10-03"},
    {"group": "lab_coffee", "name": "Coffee beans", "amount": 960, "paid_by": "ola",
     "split": ["me", "lars_e", "ola", "sigrid"], "date": "2026-09-14"},
    {"group": "lab_coffee", "name": "Milk and oat drink", "amount": 340, "paid_by": "me",
     "split": ["me", "lars_e", "ola", "sigrid", "marit"], "date": "2026-10-19"},
    {"group": "jonas_costs", "name": "Football boots", "amount": 1899, "paid_by": "me", "split": ["me", "henrik"],
     "date": "2026-09-05"},
    {"group": "jonas_costs", "name": "Winter jacket", "amount": 2600, "paid_by": "henrik", "split": ["me", "henrik"],
     "date": "2026-10-11"},
    {"group": "jonas_costs", "name": "Dentist braces check", "amount": 1450, "paid_by": "me",
     "split": ["me", "henrik"], "date": "2026-10-22"},
    {"group": "kiel", "name": "Harbour fees", "amount": 310, "paid_by": "jens", "split": ["me", "jens", "mia", "bjorn"],
     "date": "2026-06-21"},
    {"group": "kiel", "name": "Crew dinner", "amount": 188, "paid_by": "me", "split": ["me", "jens", "mia", "bjorn"],
     "date": "2026-06-24"},
    {"group": "bergen", "name": "Pappa's 75th present", "amount": 3200, "paid_by": "astrid",
     "split": ["me", "astrid", "mamma"], "date": "2026-08-14"},
    {"group": "bergen", "name": "Christmas hamper", "amount": 1500, "paid_by": "me", "split": ["me", "astrid"],
     "date": "2026-11-02"},
]

lists = [
    {"key": "lab_list", "name": "Lab", "area": "work"},
    {"key": "home_list", "name": "Home", "area": "home"},
    {"key": "jonas_list", "name": "Jonas", "area": "family"},
    {"key": "klubb_list", "name": "Seilklubb", "area": "social"},
    {"key": "trips_list", "name": "Trips", "area": "social"},
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


weekly("handover", "Jonas handover", "2026-09-04", "2026-12-18", "17:00", "17:30", step=14, attendees=["jonas", "henrik"])
weekly("race", "Wednesday race", "2026-08-12", "2026-09-30", "18:00", "20:30", cancel=("2026-09-09",),
       attendees=["lars_h", "bjorn"])
weekly("lab", "Lab meeting", "2026-09-07", "2026-12-14", "09:00", "10:00", cancel=("2026-10-19",), skip=("2026-11-09",),
       attendees=["marit", "lars_e", "sigrid"])
weekly("swim", "Morning swim", "2026-09-08", "2026-12-15", "06:30", "07:15", skip=("2026-10-13", "2026-11-03"),
       cancel=("2026-11-10",))

ev("cod_team", "Cod team meeting", "2026-11-13T11:00", "2026-11-13T12:00", attendees=["sigrid", "ola", "lars_e"])
ev("dentist", "Dentist check-up", "2026-11-18T08:00", "2026-11-18T08:45", attendees=["mikkel"])
ev("dentist_jonas", "Dentist - Jonas", "2026-11-26T15:30", "2026-11-26T16:15", attendees=["mikkel", "jonas"])
ev("parent_teacher", "Parent-teacher meeting", "2026-11-19T17:00", "2026-11-19T17:30", attendees=["hanne"])
ev("dinner_astrid", "Dinner with Astrid", "2026-11-21T19:00", "2026-11-21T21:30", attendees=["astrid"])
ev("dinner_astrid_old", "Dinner with Astrid", "2026-10-09T19:00", "2026-10-09T21:30", attendees=["astrid"])
ev("dinner_siv", "Dinner with Siv", "2026-11-06T19:00", "2026-11-06T21:00", attendees=["siv"], cancelled=True)
ev("coffee_kjersti", "Coffee with Kjersti", "2026-11-16T16:00", "2026-11-16T17:00", attendees=["kjersti"])
ev("coffee_kjersti_old", "Coffee with Kjersti", "2026-10-26T16:00", "2026-10-26T17:00", attendees=["kjersti"])
ev("ski_jonas", "Skiing at Tromsdalen", "2026-11-14T10:00", "2026-11-14T14:00", attendees=["jonas"])
ev("football", "Jonas football match", "2026-11-15T12:00", "2026-11-15T13:30", attendees=["jonas", "eirik"])
ev("club_agm", "Seilforening AGM", "2026-11-28T12:00", "2026-11-28T14:00", attendees=["lars_h", "tuva", "hjordis"],
   description="bring the kitty receipts")
ev("polar_party", "Polar night party", "2026-11-27T19:00", "2026-11-27T23:00", attendees=["bjorn", "lars_h"])
ev("liftout", "Boat lift-out", "2026-10-03T08:00", "2026-10-03T12:00", attendees=["trond", "lars_h"])
ev("shrinkwrap", "Boat shrink-wrap", "2026-10-10T09:00", "2026-10-10T12:00", attendees=["trond"])
ev("symposium", "Arctic marine symposium", "2026-12-02T08:30", "2026-12-04T16:00", attendees=["marit"],
   description="Bergen, poster session on Thursday")
ev("health_check", "Annual health check", "2026-12-08T08:30", "2026-12-08T09:15", attendees=["dr_vik"])
ev("car_service", "Car service at Frode's", "2026-11-24T07:45", "2026-11-24T09:00", attendees=["frode"])
ev("tax_meeting", "Tax planning with Elin", "2026-12-10T13:00", "2026-12-10T14:00", attendees=["elin"])
ev("fly_bergen", "Flight to Bergen", "2026-12-23T10:00", "2026-12-23T12:10")
ev("xmas", "Christmas at Mamma's", "2026-12-24T14:00", "2026-12-26T12:00", attendees=["mamma", "pappa", "astrid"])
ev("fly_back", "Flight back from Bergen", "2026-12-28T15:00", "2026-12-28T17:10")
ev("cod_survey", "Cod survey cruise", "2027-01-12T07:00", "2027-01-23T18:00", attendees=["roar", "sigrid", "ola"])
ev("kiel_regatta", "Kiel Week regatta", "2026-06-20T08:00", "2026-06-28T18:00", attendees=["jens", "mia", "bjorn"])
ev("old_lunch", "Team lunch", "2026-10-29T12:00", "2026-10-29T13:00", attendees=["lars_e"],
   trashed="2026-11-05T10:00")
ev("old_meet", "Meeting with Svein", "2026-08-12T14:00", "2026-08-12T15:00", attendees=["old_broker"],
   trashed="2026-08-30T10:30")

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


# four mortgage payments, the last one open
for mo, due, done in [("aug", "2026-08-01", "2026-07-31T21:00"), ("sep", "2026-09-01", "2026-09-01T08:30"),
                      ("oct", "2026-10-01", "2026-09-30T19:45"), ("nov", "2026-11-01", "2026-11-01T10:00")]:
    task(f"mortgage_{mo}", "Pay mortgage", "home_list", due, done)
task("mortgage_dec", "Pay mortgage", "home_list", "2026-12-01", priority=1)

# the fridge for Jonas week, every second Friday morning
d = dt.date(2026, 8, 21)
while d <= dt.date(2026, 11, 13):
    iso = d.isoformat()
    task(f"fridge_{iso[5:7]}{iso[8:]}", "Stock the fridge for Jonas", "jonas_list", f"{iso}T12:00",
         None if d >= dt.date(2026, 11, 13) else f"{iso}T11:30")
    d += dt.timedelta(days=14)

task("cod", "Cod acoustic survey 2027", "lab_list", "2027-01-12", priority=2, status="in_progress")
for k, name, due, done, extra in [
    ("vessel", "Book vessel time", "2026-09-15", "2026-09-10T14:00", {}),
    ("permits", "Get the sampling permits", "2026-10-15", "2026-10-12T10:00", {}),
    ("gear", "Order sampling gear", "2026-11-20", None, {"effort": 45}),
    ("echo", "Calibrate the echosounder", "2026-11-30", None, {"effort": 180, "priority": 2}),
    ("crew", "Draw up the crew roster", "2026-12-10", None, {"effort": 60}),
    ("risk", "Write the risk assessment", "2026-12-15", None, {"effort": 120}),
]:
    task(f"cod_{k}", name, "lab_list", due, done, parent="cod", **extra)

task("grant_progress", "Submit grant progress report", "lab_list", "2026-11-27", priority=1, effort=240)
task("grant_final", "Submit grant final report", "lab_list", "2027-03-31")
task("grant_old", "Submit grant progress report", "lab_list", "2026-05-29", "2026-05-28T16:00")
task("review_paper", "Review Sigrid's manuscript", "lab_list", "2026-11-18", effort=150)
task("poster", "Print the symposium poster", "lab_list", "2026-11-30", effort=30)
task("sample_log", "Update the sample log", "lab_list", "2026-11-13", effort=20)
task("sample_log_old", "Update the sample log", "lab_list", "2026-10-30", "2026-10-30T15:00")
task("ethics", "Renew animal ethics approval", "lab_list", "2026-12-18", priority=1)
task("buy_ice", "Order dry ice for the cruise", "lab_list", "2027-01-05", effort=10)
task("lab_safety", "Complete the lab safety refresher", "lab_list", "2026-09-30", "2026-09-28T12:00")

task("winter_work", "Winter boat work", "klubb_list", "2027-03-15", status="in_progress")
for k, name, due, done in [("antifoul", "Order antifouling paint", "2026-12-01", None),
                           ("winch", "Service the winch", "2027-01-20", None),
                           ("tiller", "Varnish the tiller", "2026-10-20", "2026-10-24T13:00"),
                           ("sails", "Drop sails at the sailmaker", "2026-10-12", "2026-10-11T16:00")]:
    task(f"winter_{k}", name, "klubb_list", due, done, parent="winter_work")
task("kitty_sheet", "Update the kitty spreadsheet", "klubb_list", "2026-11-26", effort=30)
task("kitty_receipts", "Photograph the kitty receipts", "klubb_list", "2026-11-26", effort=20)
task("agm_report", "Write the treasurer's note for the AGM", "klubb_list", "2026-11-27", priority=2)
task("insurance_boat", "Renew the boat insurance", "klubb_list", "2026-12-20", effort=30)
task("race_prizes", "Order race trophies", "klubb_list", "2026-09-20", "2026-09-18T18:00")

task("jonas_boots", "Buy Jonas new winter boots", "jonas_list", "2026-11-13", effort=60)
task("jonas_dentist", "Book Jonas's braces appointment", "jonas_list", "2026-11-05", "2026-11-03T09:00")
task("jonas_form", "Sign Jonas's school trip form", "jonas_list", "2026-11-20")
task("jonas_fees", "Pay Jonas's football fees", "jonas_list", "2026-11-25", effort=5)
task("jonas_fees_old", "Pay Jonas's football fees", "jonas_list", "2026-08-25", "2026-08-24T20:00")
task("jonas_bday", "Plan Jonas's 16th birthday", "jonas_list", "2027-01-30", priority=2)

task("snow_tyres", "Put on the winter tyres", "home_list", "2026-11-01", "2026-10-31T11:00")
task("chimney", "Book the chimney sweep", "home_list", "2026-11-30")
task("heat_pump", "Clean the heat pump filter", "home_list", "2026-11-22", effort=15)
task("lights", "Hang the window lights", "home_list", "2026-11-27", effort=40)
task("elec_bill", "Pay the electricity bill", "home_list", "2026-11-20")
task("elec_bill_old", "Pay the electricity bill", "home_list", "2026-10-20", "2026-10-19T21:00")
task("tax_card", "Check the tax card", "home_list", "2026-12-12")

task("book_flights", "Book Christmas flights to Bergen", "trips_list", "2026-09-30", "2026-09-27T20:00")
task("xmas_gifts", "Buy Christmas presents", "trips_list", "2026-12-18", effort=180)
task("pack_xmas", "Pack for Bergen", "trips_list", "2026-12-22")
task("hurti_book", "Look at Hurtigruten cabins", "trips_list", "2026-12-05", effort=30)
task("pay_astrid", "Pay Astrid for the hamper", due="2026-11-14")
task("pay_lars", "Pay Lars for the coffee", due="2026-11-16", effort=5)
task("cancelled_paint", "Repaint the hallway", "home_list", status="cancelled")
task("cancelled_shed", "Build a shed for the kayaks", "home_list", status="cancelled")
task("old_gift", "Return Svein's tools", trashed="2026-08-30T10:15")
task("old_gutter", "Fix the gutter", "home_list", trashed="2026-11-08T10:00")

# ----------------------------------------------------------------------------------------------
# notes
# ----------------------------------------------------------------------------------------------

notebooks = [
    {"key": "lab_nb", "name": "Lab Notes"},
    {"key": "sail_nb", "name": "Sailing"},
    {"key": "jonas_nb", "name": "Jonas Notes"},
    {"key": "house_nb", "name": "House"},
]

notes = [
    {"key": "lab_cod1", "name": "Cod survey planning 14 Sep", "notebook": "lab_nb", "created": "2026-09-14T14:00",
     "body": "transects every 20 nautical miles, night trawls only on the shelf, Roar wants two spare winch cables"},
    {"key": "lab_cod2", "name": "Cod survey planning 2 Nov", "notebook": "lab_nb", "created": "2026-11-02T14:00",
     "body": "Sigrid takes the otolith station, echosounder calibration in the harbour before departure"},
    {"key": "lab_methods", "name": "Otolith method", "notebook": "lab_nb", "created": "2026-03-10T10:00",
     "pinned": True, "body": "rinse in water, dry overnight, mount in resin, read under the scope twice"},
    {"key": "lab_stats", "name": "Statistics reminders", "notebook": "lab_nb", "created": "2026-04-22T09:00",
     "body": "mixed models for transect, log the length data, check for outliers before the run"},
    {"key": "lab_meeting1", "name": "Lab meeting 5 Oct", "notebook": "lab_nb", "created": "2026-10-05T10:15",
     "body": "Marit wants the grant report draft by mid November, Ola flags the freezer alarm"},
    {"key": "lab_meeting2", "name": "Lab meeting 2 Nov", "notebook": "lab_nb", "created": "2026-11-02T10:10",
     "body": "ethics renewal due in December, Lars E to share the plankton counts"},
    {"key": "lab_seminar", "name": "Seminar notes - krill and cod", "notebook": "lab_nb", "created": "2026-09-24T16:00",
     "body": "krill swarms shifted north, cod condition lower in the east, ask Marit about the dataset"},
    {"key": "sail_rules", "name": "Club rules", "notebook": "sail_nb", "created": "2026-02-11T19:30", "pinned": True,
     "body": "lifejackets always, two on the rescue boat, no racing in wind over fifteen metres per second"},
    {"key": "sail_kitty", "name": "Kitty rules", "notebook": "sail_nb", "created": "2026-02-12T19:30",
     "body": "receipts for anything over 500, two signatures for withdrawals, balance read out at the AGM"},
    {"key": "sail_winter", "name": "Winter checklist", "notebook": "sail_nb", "created": "2026-10-01T19:00",
     "body": "engine winterised, battery home, sails to the sailmaker, rig tension noted, bilge pump tested"},
    {"key": "sail_season", "name": "Season recap 2026", "notebook": "sail_nb", "created": "2026-10-04T20:00",
     "body": "eleven races, one cancelled for storm, Bjorn won the autumn cup by two points"},
    {"key": "jonas_school", "name": "School contacts", "notebook": "jonas_nb", "created": "2026-08-18T20:00",
     "body": "Hanne Saether is contact teacher, absence line opens at eight, parent evening in November"},
    {"key": "jonas_sizes", "name": "Jonas sizes", "notebook": "jonas_nb", "created": "2026-09-05T18:00",
     "body": "boots 44, jacket 176, football boots 44 narrow"},
    {"key": "jonas_weeks", "name": "Handover routine", "notebook": "jonas_nb", "created": "2026-01-06T19:00",
     "pinned": True, "body": "handover Fridays at five, his bag lives by the door, football kit goes in the wash on Sunday"},
    {"key": "house_boiler", "name": "Heat pump and boiler", "notebook": "house_nb", "created": "2026-02-04T10:00",
     "body": "filter every month in winter, service due in spring, manual in the hall drawer"},
    {"key": "house_snow", "name": "Snow clearing", "notebook": "house_nb", "created": "2026-11-03T08:00",
     "body": "Nils clears the drive for 800 a month, shovel is in the cellar, salt by the back door"},
    {"key": "house_xmas", "name": "Christmas lights plan", "notebook": "house_nb", "created": "2026-11-08T20:00",
     "body": "window lights first, outdoor string only after the polar night party"},
    {"key": "diary_ski", "name": "Diary entry - first snow", "created": "2026-10-28T21:30",
     "body": "first snow in town, Jonas walked to school in trainers, swim at half past six anyway"},
    {"key": "diary_whale", "name": "Diary entry - humpbacks", "created": "2026-11-01T22:00",
     "body": "humpbacks in the fjord from the lab window, Sigrid cried a little, we stayed late"},
    {"key": "kiel_notes", "name": "Kiel Week takeaways", "created": "2026-06-29T21:00",
     "body": "tight harbour, good wind on day three, never enter the second race without a spare spinnaker"},
    {"key": "xmas_ideas", "name": "Christmas present ideas", "created": "2026-11-02T20:30",
     "body": "wool socks for Pappa, a book on Arctic birds for Mamma, climbing shoes for Jonas"},
    {"key": "recipe_fish", "name": "Fish soup", "created": "2026-03-20T18:00",
     "body": "cod cheeks, leeks, cream, a spoon of saffron, serve with flatbread"},
    {"key": "car_notes", "name": "Car reg and tyre pressures", "created": "2026-01-10T12:00",
     "body": "EV 41872, 2.4 bar front and rear, studded tyres from 1 November"},
    {"key": "polar_notes", "name": "Polar night plans", "created": "2026-11-09T20:00",
     "body": "sunrise lamp at 7, vitamin D, one outdoor evening a week, aurora trip with Gunnhild"},
    {"key": "old_idea", "name": "Old idea - kayak rental", "created": "2026-03-01T10:00",
     "body": "kayak rental at Skattora marina", "trashed": "2026-08-20T10:00"},
    {"key": "old_scratch", "name": "Scratch list", "created": "2026-11-01T10:00", "body": "milk, brunost, coffee",
     "trashed": "2026-11-07T10:00"},
]

# ----------------------------------------------------------------------------------------------
# documents
# ----------------------------------------------------------------------------------------------

folders = [
    {"key": "work_f", "name": "Work"},
    {"key": "house_f", "name": "House"},
    {"key": "club_f", "name": "Club"},
    {"key": "jonas_f", "name": "Jonas"},
    {"key": "tax_f", "name": "Tax"},
    {"key": "empty_f", "name": "To file"},  # stays empty
]

documents = [
    {"key": "grant_agreement", "name": "Grant agreement", "folder": "work_f", "created": "2025-12-10T10:00", "starred": True},
    {"key": "ethics_permit", "name": "Animal ethics permit 2025", "folder": "work_f", "created": "2025-12-18T10:00"},
    {"key": "cruise_plan", "name": "Cod survey cruise plan", "folder": "work_f", "created": "2026-10-20T10:00"},
    {"key": "mortgage_doc", "name": "Mortgage agreement", "folder": "house_f", "created": "2021-05-12T10:00", "starred": True},
    {"key": "home_insurance", "name": "Home insurance 2026", "folder": "house_f", "created": "2026-01-15T10:00"},
    {"key": "home_insurance_25", "name": "Home insurance 2025", "folder": "house_f", "created": "2025-01-15T10:00"},
    {"key": "heat_manual", "name": "Heat pump manual", "folder": "house_f", "created": "2024-09-02T10:00"},
    {"key": "club_constitution", "name": "Club constitution", "folder": "club_f", "created": "2026-02-10T09:00"},
    {"key": "club_budget", "name": "Club budget 2026", "folder": "club_f", "created": "2026-02-14T09:00"},
    {"key": "club_accounts", "name": "Kitty accounts 2025", "folder": "club_f", "created": "2026-01-20T09:00"},
    {"key": "boat_reg", "name": "Boat registration", "folder": "club_f", "created": "2024-04-02T10:00"},
    {"key": "custody", "name": "Parenting agreement", "folder": "jonas_f", "created": "2024-03-01T10:00", "starred": True},
    {"key": "jonas_passport", "name": "Jonas passport scan", "folder": "jonas_f", "created": "2025-06-10T10:00"},
    {"key": "jonas_vacc", "name": "Jonas vaccination record", "folder": "jonas_f", "created": "2025-08-22T10:00"},
    {"key": "tax_2025", "name": "Tax return 2025", "folder": "tax_f", "created": "2026-04-28T10:00"},
    {"key": "tax_2024", "name": "Tax return 2024", "folder": "tax_f", "created": "2025-04-27T10:00"},
    {"key": "passport_scan", "name": "Passport scan", "created": "2026-01-10T10:00"},
    {"key": "dive_cert", "name": "Dive certificate", "created": "2019-07-02T10:00"},
    {"key": "old_contract", "name": "Old boat broker contract", "folder": "club_f", "created": "2025-09-01T10:00",
     "trashed": "2026-08-30T10:20"},
    {"key": "old_scan", "name": "Heating quote scan", "folder": "house_f", "created": "2026-10-20T10:00",
     "trashed": "2026-11-06T10:00"},
]

# ----------------------------------------------------------------------------------------------
# photos
# ----------------------------------------------------------------------------------------------

albums = [
    {"key": "jonas_album", "name": "Jonas"},
    {"key": "season_album", "name": "Sailing Season 2026"},
    {"key": "field_album", "name": "Lab and Fieldwork"},
    {"key": "bergen_album", "name": "Bergen Photos"},
]

photos = [
    {"key": "p_jonas_born", "name": "Jonas on his first ski", "taken": "2015-02-14T11:00", "albums": ["jonas_album"],
     "starred": True},
    {"key": "p_jonas_boat", "name": "Jonas at the helm", "taken": "2026-06-14T15:00", "albums": ["jonas_album", "season_album"],
     "people": ["jonas"], "starred": True},
    {"key": "p_jonas_goal", "name": "Jonas scores", "taken": "2026-10-04T13:00", "albums": ["jonas_album"],
     "people": ["jonas", "eirik"]},
    {"key": "p_jonas_birthday", "name": "Jonas fifteenth birthday", "taken": "2026-01-30T18:00",
     "albums": ["jonas_album"], "people": ["jonas", "astrid"]},
    {"key": "p_jonas_exam", "name": "Jonas after the school trip", "taken": "2026-09-19T17:00",
     "albums": ["jonas_album"]},
    {"key": "p_jonas_snow", "name": "Jonas in the first snow", "taken": "2026-10-28T08:10", "albums": ["jonas_album"]},
    {"key": "p_jonas_kitchen", "name": "Jonas making waffles", "taken": "2026-11-01T10:30", "albums": ["jonas_album"],
     "people": ["jonas"]},
    {"key": "p_race_start", "name": "Start line Wednesday race", "taken": "2026-08-19T18:05", "albums": ["season_album"],
     "people": ["lars_h", "bjorn"]},
    {"key": "p_race_win", "name": "Bjorn's autumn cup", "taken": "2026-09-30T20:20", "albums": ["season_album"],
     "people": ["bjorn"], "starred": True},
    {"key": "p_race_storm", "name": "Storm clouds over the fjord", "taken": "2026-09-09T17:40",
     "albums": ["season_album"]},
    {"key": "p_liftout", "name": "Boat in the crane", "taken": "2026-10-03T09:10", "albums": ["season_album"],
     "people": ["trond"]},
    {"key": "p_kiel_fleet", "name": "Kiel start fleet", "taken": "2026-06-22T11:00", "albums": ["season_album"],
     "people": ["jens", "mia"]},
    {"key": "p_kiel_dinner", "name": "Kiel crew dinner", "taken": "2026-06-24T21:00", "albums": ["season_album"],
     "people": ["jens", "mia", "bjorn"]},
    {"key": "p_field_trawl", "name": "Night trawl on deck", "taken": "2026-05-19T23:30", "albums": ["field_album"],
     "people": ["roar", "sigrid"]},
    {"key": "p_field_cod", "name": "Cod catch measured", "taken": "2026-05-20T06:40", "albums": ["field_album"],
     "people": ["ola"], "starred": True},
    {"key": "p_field_otolith", "name": "Otolith under the scope", "taken": "2026-09-22T13:00", "albums": ["field_album"]},
    {"key": "p_field_whale", "name": "Humpback outside the lab", "taken": "2026-11-01T14:20", "albums": ["field_album"],
     "people": ["sigrid"], "starred": True},
    {"key": "p_field_ship", "name": "The research vessel at the quay", "taken": "2026-05-18T15:00",
     "albums": ["field_album"], "people": ["roar"]},
    {"key": "p_field_team", "name": "Lab team group photo", "taken": "2026-09-04T12:00", "albums": ["field_album"],
     "people": ["marit", "lars_e", "ola", "sigrid", "torunn"]},
    {"key": "p_bergen_pappa", "name": "Pappa's 75th", "taken": "2026-08-15T16:00", "albums": ["bergen_album"],
     "people": ["pappa", "mamma", "astrid"], "starred": True},
    {"key": "p_bergen_bryggen", "name": "Bryggen in the rain", "taken": "2026-08-16T11:00", "albums": ["bergen_album"]},
    {"key": "p_bergen_table", "name": "Mamma's table", "taken": "2025-12-25T14:00", "albums": ["bergen_album"],
     "people": ["mamma", "pappa", "astrid", "jonas"]},
    {"key": "p_bergen_fish", "name": "Fish market", "taken": "2026-08-16T13:30", "albums": ["bergen_album"],
     "people": ["astrid"]},
    {"key": "p_bergen_mamma", "name": "Mamma baking", "taken": "2025-12-24T10:00", "albums": ["bergen_album"],
     "people": ["mamma"]},
    {"key": "p_aurora", "name": "Aurora over Kvaloya", "taken": "2026-10-17T22:30", "people": ["gunnhild"],
     "starred": True},
    {"key": "p_dive", "name": "Diving at Skulsfjord", "taken": "2026-08-30T14:00", "people": ["gunnhild"]},
    {"key": "p_kjersti", "name": "Kjersti and me", "taken": "2026-07-04T19:00", "people": ["kjersti"]},
    {"key": "p_siv_yoga", "name": "Yoga on the quay", "taken": "2026-07-11T08:00", "people": ["siv"]},
    {"key": "p_house", "name": "The house in the snow", "taken": "2026-11-03T09:00"},
    {"key": "p_sunrise", "name": "Last sun before the polar night", "taken": "2026-11-26T11:20"},
    {"key": "p_poster", "name": "Draft of the poster", "taken": "2026-11-10T16:00"},
    {"key": "p_boat_hull", "name": "Hull after the pressure wash", "taken": "2026-10-04T10:00", "people": ["trond"]},
    {"key": "p_ferry", "name": "Hurtigruten leaving the harbour", "taken": "2026-09-27T21:00"},
    {"key": "p_blurry", "name": "Blurry photo", "taken": "2026-10-30T09:00", "trashed": "2026-11-08T09:00"},
    {"key": "p_receipt", "name": "Screenshot of the crane receipt", "taken": "2026-10-03T14:00",
     "trashed": "2026-09-25T09:00"},
]

# ----------------------------------------------------------------------------------------------
# debts
# ----------------------------------------------------------------------------------------------

debts = [
    {"key": "d_henrik_boots", "person": "henrik", "direction": "owes_me", "amount": 950, "name": "football boots half",
     "date": "2026-09-05"},
    {"key": "d_henrik_jacket", "person": "henrik", "direction": "i_owe", "amount": 1300, "name": "jacket half",
     "date": "2026-10-11"},
    {"key": "d_astrid", "person": "astrid", "direction": "owes_me", "amount": 750, "name": "Christmas hamper half",
     "date": "2026-11-02"},
    {"key": "d_lars_e", "person": "lars_e", "direction": "i_owe", "amount": 120, "name": "coffee run",
     "date": "2026-11-05"},
    {"key": "d_tuva", "person": "tuva", "direction": "i_owe", "amount": 450, "name": "pizza share",
     "date": "2026-10-03"},
    {"key": "d_bjorn", "person": "bjorn", "direction": "owes_me", "amount": 1500, "name": "crane share",
     "date": "2026-10-03"},
    {"key": "d_lars_h", "person": "lars_h", "direction": "owes_me", "amount": 900, "name": "buoys share",
     "date": "2026-05-12"},
    {"key": "d_kjersti", "person": "kjersti", "direction": "owes_me", "amount": 640, "name": "concert tickets",
     "date": "2026-09-12"},
    {"key": "d_gunnhild", "person": "gunnhild", "direction": "i_owe", "amount": 2200, "name": "aurora trip share",
     "date": "2026-10-17"},
    {"key": "d_trond", "person": "trond", "direction": "i_owe", "amount": 3800, "name": "shrink-wrap and storage",
     "date": "2026-10-10"},
    {"key": "d_siv", "person": "siv", "direction": "owes_me", "amount": 300, "name": "yoga drop-in",
     "date": "2026-07-11", "settled": "2026-07-18T10:00"},
    {"key": "d_frode", "person": "frode", "direction": "i_owe", "amount": 5200, "name": "brake pads",
     "date": "2026-08-12", "settled": "2026-08-14T10:00"},
    {"key": "d_ola", "person": "ola", "direction": "owes_me", "amount": 480, "name": "coffee beans share",
     "date": "2026-09-14", "settled": "2026-09-30T10:00"},
]

# ----------------------------------------------------------------------------------------------
# locker
# ----------------------------------------------------------------------------------------------

locker = [
    {"key": "dnb_login", "name": "DNB nettbank", "type": "login", "username": "freya.lindqvist",
     "url": "https://dnb.no", "password": "Skattora#Fjord44", "starred": True},
    {"key": "uit_login", "name": "University portal", "type": "login", "username": "flindqvist",
     "url": "https://uit.no", "password": "Otolith-Cod2026"},
    {"key": "tromso_kraft", "name": "Elvia power account", "type": "login", "username": "freya.l@mail.no",
     "url": "https://elvia.no", "password": "Polarnatt!1112"},
    {"key": "visa_card", "name": "Visa DNB", "type": "card", "card_number": "4925118723064401", "cvv": "318"},
    {"key": "dnb_acct", "name": "Joint household account", "type": "bank_account",
     "notes": "account 1503 12 34567, shared with Henrik for Jonas costs", "starred": True},
    {"key": "home_wifi", "name": "Home wifi", "type": "wifi", "password": "Nordlys-Jonas15", "starred": True},
    {"key": "lab_wifi", "name": "Lab guest wifi", "type": "wifi", "password": "MarineGuest2026"},
    {"key": "gate_code", "name": "Boatyard gate code", "type": "note", "notes": "7731 then hash"},
    {"key": "vipps_pw", "name": "Vipps app", "type": "password", "password": "SeilVipps#58"},
    {"key": "national_id", "name": "Fodselsnummer card", "type": "identity"},
    {"key": "passport", "name": "Passport - Freya", "type": "passport", "notes": "no. P1234567, expires 2030-09-12"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence", "notes": "NO 0412 9988"},
    {"key": "club_member", "name": "Seilforening membership", "type": "membership",
     "notes": "member 118, fee paid to March", "starred": True},
    {"key": "ocean_api", "name": "Ocean data API key", "type": "api_credential", "notes": "for the survey dashboard"},
    {"key": "lab_ssh", "name": "Lab cluster SSH key", "type": "ssh_key", "notes": "university HPC login node"},
    {"key": "matlab", "name": "MATLAB licence", "type": "software_licence", "notes": "campus licence, renews 1 January"},
    {"key": "btc", "name": "Crypto wallet", "type": "crypto_wallet", "notes": "small, about 3000 kroner"},
    {"key": "will", "name": "Will - signed copy", "type": "document",
     "notes": "original with the lawyer in Tromso, copy in the Jonas folder"},
    {"key": "old_wifi", "name": "Old flat wifi", "type": "wifi", "password": "Hansnes2022",
     "trashed": "2026-09-01T10:00"},
    {"key": "old_login", "name": "Old Telenor login", "type": "login", "username": "freya.dahl",
     "password": "OldTelenor9", "trashed": "2026-11-04T10:00"},
]

links = [
    {"from": "jonas_boots", "to": "jonas"},
    {"from": "jonas_dentist", "to": "mikkel"},
    {"from": "jonas_form", "to": "hanne"},
    {"from": "jonas_fees", "to": "eirik"},
    {"from": "jonas_bday", "to": "jonas"},
    {"from": "fridge_1113", "to": "jonas"},
    {"from": "review_paper", "to": "sigrid"},
    {"from": "sample_log", "to": "ola"},
    {"from": "cod_crew", "to": "roar"},
    {"from": "cod_vessel", "to": "roar"},
    {"from": "cod_echo", "to": "ola"},
    {"from": "grant_progress", "to": "marit"},
    {"from": "kitty_sheet", "to": "tuva"},
    {"from": "agm_report", "to": "tuva"},
    {"from": "winter_antifoul", "to": "trond"},
    {"from": "winter_winch", "to": "trond"},
    {"from": "pay_astrid", "to": "astrid"},
    {"from": "pay_lars", "to": "lars_e"},
    {"from": "elec_bill", "to": "ingrid_m"},
    {"from": "hurti_book", "to": "kjersti"},
    {"from": "lab_cod1", "to": "roar"},
    {"from": "lab_cod2", "to": "sigrid"},
    {"from": "lab_meeting1", "to": "marit"},
    {"from": "sail_season", "to": "bjorn"},
    {"from": "jonas_school", "to": "hanne"},
    {"from": "house_snow", "to": "nils"},
    {"from": "xmas_ideas", "to": "mamma"},
    {"from": "polar_notes", "to": "gunnhild"},
    {"from": "kiel_notes", "to": "jens"},
]

world = {
    "me": ME, "today": TODAY, "epoch": "2026-01-05T09:00", "seed": "T35", "currency": "NOK",
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
    (HERE / "T35.json").write_text(json.dumps(world, indent=1, ensure_ascii=False) + "\n")
    counts = {k: len(v) for k, v in world.items() if isinstance(v, list)}
    print("T35:", counts)
