"""World T25: Yuki Tanaka, UX designer in Montréal (CAD vault).

    python3 authored/worlds/T25_build.py      # writes authored/worlds/T25.json (deterministic)

Today in the sessions is Sunday 2026-10-11 18:45 (Thanksgiving weekend; her mother Hiroko is
visiting from Vancouver). Yuki is recently divorced from Daniel Roy and shares custody of their
daughter Mika (9, grade 4) week on, week off, with a Friday handoff. She splits Mika's costs with
Daniel, hikes with the Sentiers group, goes to a monthly book club and works at Lumen, a design
studio. Built-in ambiguity: two Marcs (hiking organiser, landlord), two Sarahs (book club host,
product manager), nicknames (Gaby, Jess, Zozo), a misspelled-looking name (Matthieu), two
"Dentist" events, a recurring "Book club" and "Mika handoff", near-duplicate tasks ("Send Daniel
the receipts", "Submit expense report", monthly "Pay Hydro bill"), cancelled events, completed
tasks, rows trashed inside and past the 30-day restore window, an empty group, an empty folder, an
empty album, empty notebooks and an empty list.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        # family
        {"key": "mika", "name": "Mika Tanaka-Roy", "role": "daughter, grade 4", "starred": True},
        {"key": "daniel", "name": "Daniel Roy", "role": "ex-husband, Mika's dad", "cadence": 7,
         "last_contacted": "2026-10-09T17:45", "last_contacted_kind": "visit"},
        {"key": "hiroko", "name": "Hiroko Tanaka", "role": "mom, in Vancouver", "starred": True, "cadence": 7,
         "last_contacted": "2026-10-10T14:30", "last_contacted_kind": "visit"},
        {"key": "kenji", "name": "Kenji Tanaka", "role": "brother in Toronto", "cadence": 14,
         "last_contacted": "2026-10-01T20:00", "last_contacted_kind": "call"},
        {"key": "sylvie", "name": "Sylvie Roy", "role": "Mika's grandma, Daniel's mother", "met": "wedding",
         "cadence": 30, "last_contacted": "2026-09-13T11:00", "last_contacted_kind": "visit"},
        # work
        {"key": "sarah_n", "name": "Sarah Nguyen", "role": "product manager at Lumen", "met": "work", "cadence": 7,
         "last_contacted": "2026-10-06T12:00", "last_contacted_kind": "meeting"},
        {"key": "priya", "name": "Priya Raman", "role": "UX researcher at Lumen", "met": "work", "cadence": 7,
         "last_contacted": "2026-10-08T15:00", "last_contacted_kind": "meeting"},
        {"key": "olivier", "name": "Olivier Lefebvre", "role": "front-end lead at Lumen", "met": "work"},
        {"key": "jess", "name": "Jessica Wong", "role": "designer at Lumen, work bestie", "nickname": "Jess",
         "met": "work", "starred": True, "cadence": 7, "last_contacted": "2026-10-08T12:00",
         "last_contacted_kind": "coffee"},
        # hiking
        {"key": "marc_g", "name": "Marc Gagnon", "role": "hiking group organiser", "met": "hiking group",
         "cadence": 14, "last_contacted": "2026-09-26T16:00", "last_contacted_kind": "message"},
        {"key": "nadia", "name": "Nadia Haddad", "role": "hiking group, carpool driver", "met": "hiking group",
         "starred": True, "cadence": 14, "last_contacted": "2026-10-03T09:30", "last_contacted_kind": "message"},
        {"key": "tom", "name": "Tom O'Brien", "role": "hiking group", "met": "hiking group"},
        {"key": "elise", "name": "Elise Pelletier", "role": "hiking group, first aid", "met": "hiking group",
         "cadence": 30, "last_contacted": "2026-09-26T15:00", "last_contacted_kind": "message"},
        # book club
        {"key": "sarah_c", "name": "Sarah Cohen", "role": "book club host", "met": "book club", "cadence": 14,
         "last_contacted": "2026-10-04T21:00", "last_contacted_kind": "message"},
        {"key": "ines", "name": "Ines Moreau", "role": "book club", "met": "book club"},
        {"key": "rachel", "name": "Rachel Kim", "role": "book club, lives downstairs", "met": "book club",
         "cadence": 30, "last_contacted": "2026-10-06T12:00", "last_contacted_kind": "coffee"},
        {"key": "gab", "name": "Gabrielle Dubois", "role": "book club", "nickname": "Gaby", "met": "book club",
         "last_contacted": "2026-09-17T22:00", "last_contacted_kind": "visit"},
        # everyone else
        {"key": "marc_t", "name": "Marc Tremblay", "role": "landlord", "cadence": 60,
         "last_contacted": "2026-09-30T10:00", "last_contacted_kind": "call"},
        {"key": "josee", "name": "Josee Lavoie", "role": "family lawyer", "cadence": 14,
         "last_contacted": "2026-10-01T20:00", "last_contacted_kind": "call"},
        {"key": "mehta", "name": "Anand Mehta", "role": "therapist"},
        {"key": "fortin", "name": "Claire Fortin", "role": "Mika's pediatrician"},
        {"key": "caron", "name": "Isabelle Caron", "role": "Mika's teacher, grade 4",
         "last_contacted": "2026-10-06T08:15", "last_contacted_kind": "message"},
        {"key": "zoe", "name": "Zoe Gauthier", "role": "babysitter", "nickname": "Zozo", "cadence": 14,
         "last_contacted": "2026-10-02T18:00", "last_contacted_kind": "message"},
        {"key": "luca", "name": "Luca Bianchi", "role": "Mika's piano teacher", "met": "school recital"},
        {"key": "nadeau", "name": "Paul Nadeau", "role": "dentist"},
        {"key": "amelie", "name": "Amelie Roux", "role": "hairdresser"},
        {"key": "benoit", "name": "Benoit Leclerc", "role": "bike mechanic"},
        {"key": "matthieu", "name": "Matthieu Girard", "role": "neighbour upstairs",
         "last_contacted": "2026-10-06T12:00", "last_contacted_kind": "visit"},
        {"key": "hannah", "name": "Hannah Weiss", "role": "yoga instructor", "met": "yoga studio"},
        # trashed: one inside the 30-day window, one past it
        {"key": "kevin_l", "name": "Kevin Lambert", "role": "old coworker", "trashed": "2026-09-20T10:00"},
        {"key": "brad", "name": "Brad Wilson", "role": "Daniel's friend", "trashed": "2026-08-15T09:00"},
    ]


GROUPS = [
    {"key": "mika_exp", "name": "Mika expenses", "currency": "CAD", "members": ["daniel"],
     "created": "2026-06-05T20:00"},
    {"key": "hiking", "name": "Sentiers hiking", "currency": "CAD",
     "members": ["marc_g", "nadia", "tom", "elise"], "created": "2025-05-10T09:00"},
    {"key": "bookclub", "name": "Book club kitty", "currency": "CAD",
     "members": ["sarah_c", "ines", "rachel", "gab"], "created": "2025-09-18T21:00"},
    {"key": "vermont", "name": "Vermont weekend", "currency": "USD", "members": ["nadia", "tom"],
     "created": "2026-08-10T19:00"},
    {"key": "lunch_club", "name": "Lumen lunch club", "currency": "CAD", "members": ["olivier", "priya", "jess"],
     "created": "2026-03-02T12:00"},
    {"key": "halloween", "name": "Halloween party fund", "currency": "CAD", "created": "2026-10-05T20:00"},
]

EXPENSES = [
    {"group": "mika_exp", "name": "Summer camp", "amount": 360, "paid_by": "me", "split": ["me", "daniel"],
     "date": "2026-07-02"},
    {"group": "mika_exp", "name": "Piano books", "amount": 90, "paid_by": "daniel", "split": ["me", "daniel"],
     "date": "2026-09-09"},
    {"group": "mika_exp", "name": "Winter boots", "amount": 129, "paid_by": "me", "split": ["me", "daniel"],
     "date": "2026-10-06"},
    {"group": "hiking", "name": "Tremblant cabin", "amount": 480, "paid_by": "tom",
     "split": ["me", "tom", "nadia", "marc_g"], "date": "2026-09-20"},
    {"group": "hiking", "name": "Gas to Orford", "amount": 76, "paid_by": "me", "split": ["me", "nadia"],
     "date": "2026-09-26"},
    {"group": "bookclub", "name": "Wine and cheese", "amount": 60, "paid_by": "sarah_c",
     "split": ["me", "sarah_c", "ines", "rachel", "gab"], "date": "2026-09-17"},
    {"group": "vermont", "name": "Airbnb in Burlington", "amount": 540, "paid_by": "nadia",
     "split": ["me", "nadia", "tom"], "date": "2026-08-21"},
    {"group": "vermont", "name": "Dinner on Church Street", "amount": 150, "paid_by": "me",
     "split": ["me", "nadia", "tom"], "date": "2026-08-22"},
]

LISTS = [
    {"key": "home_l", "name": "Home", "area": "home"},
    {"key": "mika_l", "name": "Mika", "area": "family"},
    {"key": "work_l", "name": "Work", "area": "work"},
    {"key": "errands_l", "name": "Errands"},
    {"key": "hike_l", "name": "Hiking", "area": "hobbies"},
    {"key": "legal_l", "name": "Divorce admin", "area": "legal"},
    {"key": "someday_l", "name": "Someday"},
]


def events():
    out = []
    # custody handoff, every Friday at school pickup
    d = date(2026, 8, 28)
    while d <= date(2026, 11, 27):
        ev = {"key": f"handoff_{d.strftime('%m%d')}", "name": "Mika handoff", "start": f"{d}T17:30",
              "end": f"{d}T18:00", "attendees": ["daniel"], "description": "at the school gate"}
        if d == date(2026, 10, 2):
            ev["cancelled"] = "2026-09-30T09:00"
        out.append(ev)
        d += timedelta(weeks=1)
    # book club, third Thursday
    for m, dd in ((6, 18), (7, 16), (8, 20), (9, 17), (10, 15), (11, 19), (12, 17)):
        ev = {"key": f"book_{m:02d}", "name": "Book club", "start": f"2026-{m:02d}-{dd:02d}T19:00",
              "end": f"2026-{m:02d}-{dd:02d}T21:30", "attendees": ["sarah_c", "ines"],
              "description": "at Sarah's place"}
        if m == 8:
            ev["cancelled"] = "2026-08-15T12:00"
        out.append(ev)
    # piano, Wednesdays after school
    d = date(2026, 9, 9)
    while d <= date(2026, 11, 18):
        out.append({"key": f"piano_{d.strftime('%m%d')}", "name": "Piano lesson", "start": f"{d}T16:30",
                    "end": f"{d}T17:15", "attendees": ["mika", "luca"]})
        d += timedelta(weeks=1)
    # therapy, every second Tuesday
    for dd in ("2026-09-01", "2026-09-15", "2026-09-29", "2026-10-13", "2026-10-27", "2026-11-10"):
        out.append({"key": f"therapy_{dd[5:7]}{dd[8:]}", "name": "Therapy", "start": f"{dd}T12:00",
                    "end": f"{dd}T12:50", "attendees": ["mehta"]})
    out += [
        # hiking
        {"key": "hike_hilaire", "name": "Hike at Mont Saint-Hilaire", "start": "2026-09-12T08:00",
         "end": "2026-09-12T15:00", "attendees": ["marc_g", "nadia", "tom"], "description": "meet at the metro"},
        {"key": "hike_orford", "name": "Hike at Mont Orford", "start": "2026-09-26T08:00", "end": "2026-09-26T16:00",
         "attendees": ["marc_g", "nadia", "elise"], "description": "Nadia drives"},
        {"key": "hike_sutton", "name": "Hike at Mont Sutton", "start": "2026-10-03T08:00", "end": "2026-10-03T16:00",
         "attendees": ["marc_g", "nadia"], "cancelled": "2026-10-01T19:00", "description": "rain"},
        {"key": "hike_tremblant", "name": "Tremblant hiking weekend", "start": "2026-10-17T07:30",
         "end": "2026-10-18T09:30", "attendees": ["marc_g", "nadia", "tom", "elise"],
         "description": "cabin near the lake"},
        {"key": "hike_royal", "name": "Hike up Mont Royal", "start": "2026-11-07T09:00", "end": "2026-11-07T11:00",
         "attendees": ["marc_g"]},
        {"key": "vermont_trip", "name": "Vermont weekend", "start": "2026-08-21T08:00", "end": "2026-08-23T20:00",
         "attendees": ["nadia", "tom"], "description": "Burlington"},
        # family, custody and health
        {"key": "dentist_mika", "name": "Dentist", "start": "2026-10-21T15:00", "end": "2026-10-21T15:45",
         "attendees": ["mika", "nadeau"]},
        {"key": "dentist_me", "name": "Dentist", "start": "2026-11-04T08:30", "end": "2026-11-04T09:15",
         "attendees": ["nadeau"]},
        {"key": "pediatrician", "name": "Pediatrician checkup", "start": "2026-10-14T09:00",
         "end": "2026-10-14T09:40", "attendees": ["mika", "fortin"], "description": "flu shot too"},
        {"key": "ptm", "name": "Parent-teacher meeting", "start": "2026-10-22T18:00", "end": "2026-10-22T18:30",
         "attendees": ["caron", "daniel"], "description": "room 12"},
        {"key": "mediation", "name": "Mediation session", "start": "2026-09-03T14:00", "end": "2026-09-03T16:00",
         "attendees": ["josee", "daniel"]},
        {"key": "lawyer_call", "name": "Call with the lawyer", "start": "2026-10-16T12:30",
         "end": "2026-10-16T13:00", "attendees": ["josee"], "description": "parenting plan"},
        {"key": "thanksgiving", "name": "Thanksgiving dinner", "start": "2026-10-12T17:00",
         "end": "2026-10-12T21:00", "attendees": ["hiroko", "mika", "kenji"], "description": "at home"},
        {"key": "mom_flight", "name": "Mom's flight home", "start": "2026-10-18T11:00", "end": "2026-10-18T12:00",
         "attendees": ["hiroko"], "description": "YUL, drop her at 9"},
        {"key": "mom_arrives", "name": "Pick up mom at the airport", "start": "2026-10-10T13:30",
         "end": "2026-10-10T14:30", "attendees": ["hiroko"]},
        {"key": "mika_bday", "name": "Mika's birthday party", "start": "2026-11-14T13:00", "end": "2026-11-14T16:00",
         "attendees": ["mika", "daniel", "sylvie"], "description": "trampoline park"},
        {"key": "halloween_ev", "name": "Halloween party", "start": "2026-10-31T18:00", "end": "2026-10-31T21:00",
         "attendees": ["jess", "priya"]},
        {"key": "apple_picking", "name": "Apple picking with Mika", "start": "2026-09-27T10:00",
         "end": "2026-09-27T14:00", "attendees": ["mika"]},
        # work
        {"key": "portfolio_rev", "name": "Portfolio review", "start": "2026-10-15T14:00", "end": "2026-10-15T15:00",
         "attendees": ["sarah_n"]},
        {"key": "workshop", "name": "Client workshop", "start": "2026-10-20T09:00", "end": "2026-10-20T12:00",
         "attendees": ["sarah_n", "olivier", "priya"], "description": "onboarding flow, Northwind"},
        {"key": "usability", "name": "Usability testing", "start": "2026-10-19T13:00", "end": "2026-10-19T16:00",
         "attendees": ["priya"]},
        {"key": "offsite", "name": "Team offsite", "start": "2026-10-09T09:00", "end": "2026-10-09T16:00",
         "attendees": ["sarah_n", "olivier", "priya", "jess"], "cancelled": "2026-10-05T11:00"},
        {"key": "lunch_jess", "name": "Lunch with Jess", "start": "2026-10-08T12:00", "end": "2026-10-08T13:00",
         "attendees": ["jess"]},
        {"key": "one_on_one", "name": "1:1 with Sarah", "start": "2026-10-13T15:00", "end": "2026-10-13T15:30",
         "attendees": ["sarah_n"]},
        # errands and personal
        {"key": "coffee_marc", "name": "Coffee with Marc", "start": "2026-10-14T08:00", "end": "2026-10-14T08:30",
         "attendees": ["marc_g"]},
        {"key": "inspection", "name": "Apartment inspection", "start": "2026-10-19T10:00",
         "end": "2026-10-19T11:00", "attendees": ["marc_t"], "description": "radiators"},
        {"key": "bike_tune", "name": "Bike tune-up", "start": "2026-10-24T11:00", "end": "2026-10-24T12:00",
         "attendees": ["benoit"]},
        {"key": "haircut", "name": "Haircut", "start": "2026-09-24T17:00", "end": "2026-09-24T18:00",
         "attendees": ["amelie"]},
        {"key": "yoga_oct", "name": "Yoga workshop", "start": "2026-10-25T10:00", "end": "2026-10-25T12:00",
         "attendees": ["hannah"]},
        # trashed: inside the window, and past it
        {"key": "drinks_kevin", "name": "Drinks with Kevin", "start": "2026-09-25T18:00", "end": "2026-09-25T19:30",
         "attendees": ["kevin_l"], "trashed": "2026-09-22T10:00"},
        {"key": "movie_night", "name": "Movie night", "start": "2026-10-23T19:00", "end": "2026-10-23T21:30",
         "attendees": ["rachel"], "trashed": "2026-10-04T10:00"},
        {"key": "pottery", "name": "Pottery class", "start": "2026-09-05T10:00", "end": "2026-09-05T12:00",
         "trashed": "2026-08-20T09:00"},
    ]
    return out


def tasks():
    t = [
        # divorce admin
        {"key": "plan", "name": "Update parenting plan", "due": "2026-10-23", "priority": 1, "effort": 120,
         "list": "legal_l", "status": "in_progress", "description": "holidays, summer, Mika's activities"},
        {"key": "holiday_sched", "name": "Draft holiday schedule", "parent": "plan", "due": "2026-10-16", "effort": 60},
        {"key": "review_lawyer", "name": "Review plan with lawyer", "parent": "plan", "due": "2026-10-20",
         "effort": 30},
        {"key": "sign_plan", "name": "Sign final parenting plan", "parent": "plan", "due": "2026-10-23", "effort": 15},
        {"key": "joint_acct", "name": "Close joint bank account", "due": "2026-10-15", "priority": 1, "effort": 45,
         "list": "legal_l", "status": "in_progress"},
        {"key": "lease_name", "name": "Change name on hydro account", "due": "2026-10-30", "priority": 2,
         "effort": 20, "list": "legal_l"},
        {"key": "rrsp", "name": "Transfer RRSP split", "priority": 2, "effort": 60, "list": "legal_l",
         "description": "per the agreement, ask the bank"},
        {"key": "receipts_1", "name": "Send Daniel the receipts", "due": "2026-10-16", "effort": 15,
         "list": "mika_l", "description": "boots and piano"},
        {"key": "receipts_2", "name": "Send Daniel the receipts", "due": "2026-09-05",
         "completed": "2026-09-05T20:00", "list": "mika_l", "description": "summer camp"},
        # work
        {"key": "onboarding", "name": "Finish onboarding flow mockups", "due": "2026-10-14", "priority": 1,
         "effort": 240, "list": "work_l", "status": "in_progress"},
        {"key": "wireframes", "name": "Wireframes for step 3", "parent": "onboarding", "due": "2026-10-07",
         "completed": "2026-10-07T17:00", "effort": 90},
        {"key": "test_script", "name": "Write usability test script", "parent": "onboarding", "due": "2026-10-13",
         "effort": 60},
        {"key": "export_assets", "name": "Export assets for Olivier", "parent": "onboarding", "due": "2026-10-14",
         "effort": 30},
        {"key": "deck", "name": "Prepare portfolio review deck", "due": "2026-10-15", "priority": 2, "effort": 120,
         "list": "work_l"},
        {"key": "ds_docs", "name": "Write design system docs", "priority": 4, "effort": 180, "list": "work_l",
         "status": "in_progress"},
        {"key": "participants", "name": "Book usability participants", "due": "2026-10-16", "priority": 3,
         "effort": 45, "list": "work_l"},
        {"key": "expense_1", "name": "Submit expense report", "due": "2026-11-06", "effort": 20, "list": "work_l"},
        {"key": "expense_2", "name": "Submit expense report", "due": "2026-10-09", "completed": "2026-10-08T16:00",
         "list": "work_l"},
        {"key": "research_plan", "name": "Review Priya's research plan", "due": "2026-10-13", "effort": 30,
         "list": "work_l", "priority": 3},
        {"key": "icons", "name": "Redraw the icon set", "priority": 6, "effort": 300, "list": "work_l"},
        # Mika
        {"key": "field_trip", "name": "Sign Mika's field trip form", "due": "2026-10-13", "priority": 2,
         "effort": 5, "list": "mika_l"},
        {"key": "boots", "name": "Buy Mika winter boots", "due": "2026-10-06", "completed": "2026-10-06T18:30",
         "list": "mika_l"},
        {"key": "flu_shot", "name": "Book Mika's flu shot", "due": "2026-10-30", "effort": 10, "list": "mika_l"},
        {"key": "invites", "name": "Make birthday invitations", "due": "2026-10-31", "effort": 60, "list": "mika_l",
         "priority": 4},
        {"key": "ski", "name": "Register Mika for ski lessons", "due": "2026-11-15", "priority": 3, "effort": 30,
         "list": "mika_l"},
        {"key": "lunchbox", "name": "Label Mika's lunch containers", "due": "2026-08-30",
         "completed": "2026-08-30T19:00", "list": "mika_l"},
        {"key": "costume", "name": "Sew Mika's fox costume", "due": "2026-10-29", "effort": 180, "list": "mika_l",
         "priority": 2},
        # home
        {"key": "faucet", "name": "Fix the bathroom faucet", "status": "in_progress", "list": "home_l",
         "effort": 60},
        {"key": "gallery", "name": "Hang the gallery wall", "priority": 5, "effort": 90, "list": "home_l"},
        {"key": "smoke", "name": "Change smoke detector batteries", "due": "2026-11-01", "effort": 15,
         "list": "home_l"},
        {"key": "desk", "name": "Sell Daniel's old desk", "status": "cancelled", "list": "home_l"},
        {"key": "plants", "name": "Bring the balcony plants inside", "due": "2026-10-25", "effort": 45,
         "list": "home_l"},
        {"key": "radiator", "name": "Call landlord about radiator", "due": "2026-10-14", "effort": 10,
         "list": "home_l", "priority": 2},
        {"key": "curtains", "name": "Put up blackout curtains", "due": "2026-09-19", "completed": "2026-09-19T15:00",
         "list": "home_l", "effort": 45},
        # errands
        {"key": "dry_clean", "name": "Pick up dry cleaning", "due": "2026-10-13", "effort": 20, "list": "errands_l"},
        {"key": "groceries", "name": "Buy groceries for Thanksgiving", "due": "2026-10-11",
         "completed": "2026-10-11T11:00", "list": "errands_l", "effort": 60},
        {"key": "library", "name": "Return library books", "due": "2026-10-17", "effort": 20, "list": "errands_l"},
        {"key": "pharmacy", "name": "Pick up mom's prescription", "due": "2026-10-12", "effort": 15,
         "list": "errands_l", "priority": 1},
        # hiking
        {"key": "hike_boots", "name": "Buy new hiking boots", "due": "2026-10-15", "priority": 3, "effort": 90,
         "list": "hike_l"},
        {"key": "cabin", "name": "Book Tremblant cabin", "due": "2026-09-20", "completed": "2026-09-20T09:00",
         "list": "hike_l"},
        {"key": "first_aid", "name": "Pack first aid kit", "due": "2026-10-16", "effort": 20, "list": "hike_l"},
        {"key": "route", "name": "Plan November hike route", "priority": 6, "effort": 60, "list": "hike_l"},
        # personal, no list
        {"key": "novel", "name": "Finish reading Station Eleven", "due": "2026-10-15", "effort": 300},
        {"key": "therapy_book", "name": "Book November therapy sessions", "due": "2026-10-13", "effort": 10},
        {"key": "licence", "name": "Renew driver's licence", "due": "2026-11-30", "priority": 3, "effort": 60},
        {"key": "gym", "name": "Cancel old gym membership", "due": "2026-09-28", "completed": "2026-09-28T10:00"},
        {"key": "backup", "name": "Back up laptop", "priority": 7, "effort": 30},
        {"key": "thank_you", "name": "Write thank-you card to Rachel", "due": "2026-10-14", "effort": 15},
        # trashed: inside the window, and past it
        {"key": "couch", "name": "Buy couch for the new place", "list": "home_l", "trashed": "2026-09-25T09:00"},
        {"key": "anniversary", "name": "Plan anniversary dinner", "trashed": "2026-06-20T09:00"},
    ]
    # Hydro bill, monthly on the 20th
    for m in range(6, 10):
        t.append({"key": f"hydro_{m:02d}", "name": "Pay Hydro bill", "due": f"2026-{m:02d}-20",
                  "completed": f"2026-{m:02d}-18T20:00", "list": "home_l"})
    t.append({"key": "hydro_10", "name": "Pay Hydro bill", "due": "2026-10-20", "list": "home_l", "effort": 10})
    return t


NOTEBOOKS = [
    {"key": "journal_nb", "name": "Journal"},
    {"key": "book_nb", "name": "Book club"},
    {"key": "hike_nb", "name": "Hiking"},
    {"key": "work_nb", "name": "Work"},
    {"key": "mika_nb", "name": "Mika"},
    {"key": "recipes_nb", "name": "Recipes"},
    {"key": "sketch_nb", "name": "Sketch ideas"},
    {"key": "wedding_nb", "name": "Wedding planning"},
]

NOTES = [
    {"key": "custody", "name": "Custody schedule", "body": "week on week off, handoff fridays 5:30 at the school gate",
     "notebook": "mika_nb", "created": "2026-08-28T21:00", "pinned": True},
    {"key": "allergies", "name": "Mika allergies", "body": "tree nuts, epipen in the blue pouch",
     "notebook": "mika_nb", "created": "2026-06-15T10:00", "pinned": True},
    {"key": "ped_questions", "name": "Questions for the pediatrician", "body": "sleep, growth spurt, flu shot",
     "notebook": "mika_nb", "created": "2026-10-09T22:00"},
    {"key": "bday_ideas", "name": "Birthday party ideas", "body": "trampoline park, fox cake, 8 kids max",
     "notebook": "mika_nb", "created": "2026-09-21T21:30"},
    {"key": "grocery_tg", "name": "Thanksgiving grocery list", "body": "turkey breast, cranberries, squash, pie crust",
     "created": "2026-10-10T07:30"},
    {"key": "s11_thoughts", "name": "Station Eleven thoughts", "body": "loved the travelling symphony, slow middle",
     "notebook": "book_nb", "created": "2026-10-04T21:15"},
    {"key": "picks", "name": "Book club picks", "body": "Station Eleven in october, Piranesi in november",
     "notebook": "book_nb", "created": "2026-09-17T22:00"},
    {"key": "klara", "name": "Klara and the Sun notes", "body": "quiet, sad ending, good for discussion",
     "notebook": "book_nb", "created": "2026-07-16T22:10"},
    {"key": "tremblant_pack", "name": "Tremblant packing list", "body": "layers, headlamp, microspikes, snacks",
     "notebook": "hike_nb", "created": "2026-10-06T20:00"},
    {"key": "orford_notes", "name": "Orford trail notes", "body": "ridge was windy, 11 km, parking full by 9",
     "notebook": "hike_nb", "created": "2026-09-26T19:30"},
    {"key": "hilaire_notes", "name": "Saint-Hilaire trail notes", "body": "lake loop 6 km, easy, bring cash for parking",
     "notebook": "hike_nb", "created": "2026-09-12T18:00"},
    {"key": "onboarding_ideas", "name": "Onboarding flow ideas", "body": "progress bar, skip for later, fewer fields",
     "notebook": "work_nb", "created": "2026-09-29T11:00"},
    {"key": "talking_points", "name": "Portfolio talking points",
     "body": "lead with the transit app case study, then the design system", "notebook": "work_nb",
     "created": "2026-10-07T21:00"},
    {"key": "one_on_one_n", "name": "1:1 prep", "body": "raise the title change and the conference budget",
     "notebook": "work_nb", "created": "2026-10-05T15:00"},
    {"key": "retro", "name": "Retro notes", "body": "handoff to devs came too late, more pairing",
     "notebook": "work_nb", "created": "2026-09-18T16:00"},
    {"key": "therapy_notes", "name": "Therapy takeaways", "body": "boundaries with Daniel, protect the sleep routine",
     "notebook": "journal_nb", "created": "2026-09-29T13:15", "pinned": True},
    {"key": "new_apt", "name": "First week in the new apartment", "body": "quiet, lots of light, missing the old kitchen",
     "notebook": "journal_nb", "created": "2026-07-05T22:30"},
    {"key": "grateful", "name": "Things I'm grateful for", "body": "mom visiting, the hiking crew, Mika laughing",
     "notebook": "journal_nb", "created": "2026-09-06T23:00"},
    {"key": "timeline", "name": "Divorce timeline", "body": "papers filed in june, final agreement in september",
     "created": "2026-06-10T20:00"},
    {"key": "lawyer_q", "name": "Lawyer questions", "body": "RRSP split, holiday schedule, travel consent",
     "created": "2026-09-02T19:00"},
    {"key": "miso", "name": "Miso soup", "body": "dashi, white miso, tofu, wakame", "notebook": "recipes_nb",
     "created": "2025-11-10T18:00"},
    {"key": "curry", "name": "Mom's curry", "body": "roux blocks, grated apple, a spoon of honey",
     "notebook": "recipes_nb", "created": "2026-01-15T19:00"},
    {"key": "gallery_note", "name": "Gallery wall layout", "body": "three frames left, big print in the centre",
     "created": "2026-08-10T14:00"},
    {"key": "modem", "name": "Modem notes", "body": "modem in the hallway closet, restart if slow",
     "created": "2026-07-02T18:00"},
    {"key": "ski_note", "name": "Ski lesson options", "body": "saturday mornings at Mont Saint-Sauveur, 8 weeks",
     "notebook": "mika_nb", "created": "2026-10-03T20:15"},
    # trashed: two inside the window, one past it
    {"key": "anniv_note", "name": "Anniversary ideas", "body": "old habit, not needed anymore",
     "created": "2026-05-01T20:00", "trashed": "2026-09-30T21:00"},
    {"key": "old_grocery", "name": "Old grocery list", "body": "milk, eggs, rice", "created": "2026-09-20T10:00",
     "trashed": "2026-10-03T10:00"},
    {"key": "counselling", "name": "Counselling notes", "body": "sessions with Daniel, spring",
     "created": "2026-04-01T20:00", "trashed": "2026-07-10T10:00"},
]

FOLDERS = [
    {"key": "divorce_f", "name": "Divorce"},
    {"key": "school_f", "name": "Mika school"},
    {"key": "taxes_f", "name": "Taxes 2025"},
    {"key": "apt_f", "name": "Apartment"},
    {"key": "work_f", "name": "Work contracts"},
    {"key": "scans_f", "name": "Scans"},
]

DOCUMENTS = [
    {"key": "agreement", "name": "Divorce agreement", "folder": "divorce_f", "starred": True,
     "created": "2026-09-15T10:00"},
    {"key": "plan_draft", "name": "Parenting plan draft", "folder": "divorce_f", "created": "2026-09-28T16:00"},
    {"key": "mediation_sum", "name": "Mediation summary", "folder": "divorce_f", "created": "2026-09-03T17:00"},
    {"key": "report_card", "name": "Report card grade 3", "folder": "school_f", "created": "2026-06-25T15:00"},
    {"key": "trip_form", "name": "Field trip permission form", "folder": "school_f", "created": "2026-10-08T08:15"},
    {"key": "school_cal", "name": "School calendar 2026-27", "folder": "school_f", "created": "2026-08-30T12:00"},
    {"key": "noa", "name": "Notice of assessment 2025", "folder": "taxes_f", "created": "2026-05-10T09:00"},
    {"key": "t4", "name": "T4 from Lumen", "folder": "taxes_f", "created": "2026-02-20T09:00"},
    {"key": "lease", "name": "Lease 2026", "folder": "apt_f", "starred": True, "created": "2026-06-01T11:00"},
    {"key": "insurance", "name": "Renters insurance", "folder": "apt_f", "created": "2026-06-03T14:00"},
    {"key": "move_in", "name": "Move-in inspection", "folder": "apt_f", "created": "2026-06-30T10:00"},
    {"key": "contract", "name": "Lumen employment contract", "folder": "work_f", "created": "2024-03-01T09:00"},
    {"key": "nda", "name": "Northwind NDA", "folder": "work_f", "created": "2026-09-21T13:00"},
    {"key": "camp_receipt", "name": "Summer camp receipt", "created": "2026-07-02T09:30"},
    {"key": "boots_receipt", "name": "Winter boots receipt", "created": "2026-10-06T19:00", "starred": True},
    {"key": "scan_a", "name": "Scan 0142", "created": "2026-10-09T08:40"},
    {"key": "scan_b", "name": "Scan 0143", "created": "2026-10-09T08:41"},
    {"key": "passport_app", "name": "Mika passport application", "created": "2026-10-02T20:00"},
    # trashed: inside the window (still filed), and past it
    {"key": "joint_stmt", "name": "Joint account statement", "folder": "divorce_f", "created": "2026-08-01T10:00",
     "trashed": "2026-09-25T10:00"},
    {"key": "venue", "name": "Wedding venue contract", "created": "2015-03-01T10:00", "trashed": "2026-07-01T10:00"},
]

ALBUMS = [
    {"key": "mika_album", "name": "Mika"},
    {"key": "hikes_album", "name": "Hikes"},
    {"key": "book_album", "name": "Book club"},
    {"key": "vermont_album", "name": "Green Mountains"},
    {"key": "summer_album", "name": "Summer 2026"},
    {"key": "halloween_album", "name": "Halloween"},
]

PHOTOS = [
    {"key": "first_day", "name": "Mika first day of grade 4", "taken": "2026-08-31T08:00", "albums": ["mika_album"],
     "people": ["mika"], "starred": True},
    {"key": "recital", "name": "Piano recital", "taken": "2026-06-20T15:00", "albums": ["mika_album"],
     "people": ["mika", "luca"]},
    {"key": "tooth", "name": "Mika's lost tooth", "taken": "2026-10-03T19:00", "albums": ["mika_album"],
     "people": ["mika"]},
    {"key": "apples", "name": "Apple picking", "taken": "2026-09-27T12:00", "albums": ["mika_album"],
     "people": ["mika"]},
    {"key": "grandma", "name": "Mika and grandma", "taken": "2026-10-10T16:00", "albums": ["mika_album"],
     "people": ["mika", "hiroko"], "starred": True},
    {"key": "pumpkin", "name": "Pumpkin carving", "taken": "2026-10-09T19:00", "people": ["mika"]},
    {"key": "hilaire_summit", "name": "Saint-Hilaire summit", "taken": "2026-09-12T11:30", "albums": ["hikes_album"],
     "people": ["marc_g", "nadia", "tom"]},
    {"key": "hilaire_lake", "name": "Lac Hertel", "taken": "2026-09-12T13:00", "albums": ["hikes_album"]},
    {"key": "orford_ridge", "name": "Orford ridge", "taken": "2026-09-26T12:00", "albums": ["hikes_album"],
     "people": ["nadia", "elise"]},
    {"key": "orford_group", "name": "Orford group shot", "taken": "2026-09-26T14:30", "albums": ["hikes_album"],
     "people": ["marc_g", "nadia", "elise"], "starred": True},
    {"key": "fall_colours", "name": "Fall colours", "taken": "2026-09-26T15:10"},
    {"key": "rainy", "name": "Rainy Saturday", "taken": "2026-10-03T10:00"},
    {"key": "book_sept", "name": "Book club in September", "taken": "2026-09-17T21:00", "albums": ["book_album"],
     "people": ["sarah_c", "ines", "rachel", "gab"]},
    {"key": "s11_cover", "name": "Station Eleven cover", "taken": "2026-10-01T22:00", "albums": ["book_album"]},
    {"key": "burlington", "name": "Burlington waterfront", "taken": "2026-08-22T18:00",
     "albums": ["vermont_album"], "people": ["nadia", "tom"]},
    {"key": "waterbury", "name": "Ice cream in Waterbury", "taken": "2026-08-22T14:00", "albums": ["vermont_album"]},
    {"key": "camels_hump", "name": "Camel's Hump summit", "taken": "2026-08-23T11:00",
     "albums": ["vermont_album", "hikes_album"], "people": ["nadia", "tom"], "starred": True},
    {"key": "la_ronde", "name": "La Ronde with Mika", "taken": "2026-07-18T14:00",
     "albums": ["summer_album", "mika_album"], "people": ["mika"]},
    {"key": "oka", "name": "Beach at Oka", "taken": "2026-07-26T12:00", "albums": ["summer_album"]},
    {"key": "jazz", "name": "Jazz fest night", "taken": "2026-07-03T21:00", "albums": ["summer_album"],
     "people": ["jess"]},
    {"key": "keys", "name": "New apartment keys", "taken": "2026-06-01T12:00"},
    {"key": "gallery_p", "name": "Gallery wall test", "taken": "2026-08-10T15:00"},
    {"key": "whiteboard", "name": "Whiteboard sketch", "taken": "2026-10-06T11:00"},
    {"key": "sticky", "name": "Sticky notes wall", "taken": "2026-10-07T15:00", "people": ["priya"]},
    {"key": "boots_p", "name": "Boots receipt photo", "taken": "2026-10-06T18:55"},
    {"key": "sunset", "name": "Sunset from the balcony", "taken": "2026-10-05T18:40", "starred": True},
    {"key": "airport", "name": "Mom at the airport", "taken": "2026-10-10T14:30", "people": ["hiroko"]},
    {"key": "latte", "name": "Latte art", "taken": "2026-10-08T12:30", "people": ["jess"]},
    {"key": "handoff_p", "name": "Mika's backpack", "taken": "2026-10-02T17:40", "people": ["mika"]},
    {"key": "leaves", "name": "Leaves on Laurier", "taken": "2026-10-04T16:00"},
    # trashed
    {"key": "blurry_pumpkin", "name": "Blurry pumpkin", "taken": "2026-10-09T19:01", "trashed": "2026-10-10T09:00",
     "albums": ["mika_album"]},
    {"key": "dup_summit", "name": "Duplicate summit", "taken": "2026-09-12T11:31", "trashed": "2026-09-13T08:00"},
    {"key": "wedding_p", "name": "Wedding photo", "taken": "2015-06-20T16:00", "trashed": "2026-06-30T10:00"},
]

DEBTS = [
    {"key": "d_daniel_camp", "person": "daniel", "direction": "owes_me", "amount": 180, "name": "Half of summer camp",
     "date": "2026-07-02"},
    {"key": "d_daniel_boots", "person": "daniel", "direction": "owes_me", "amount": 64.5,
     "name": "Half of winter boots", "date": "2026-10-06"},
    {"key": "d_daniel_piano", "person": "daniel", "direction": "i_owe", "amount": 45, "name": "Half of piano books",
     "date": "2026-09-09", "settled": "2026-09-20T10:00"},
    {"key": "d_nadia", "person": "nadia", "direction": "owes_me", "amount": 38, "name": "Gas to Orford",
     "date": "2026-09-26"},
    {"key": "d_tom", "person": "tom", "direction": "i_owe", "amount": 120, "name": "Tremblant cabin share",
     "date": "2026-09-20"},
    {"key": "d_jess", "person": "jess", "direction": "owes_me", "amount": 22, "name": "Food court lunch",
     "date": "2026-10-08"},
    {"key": "d_sarah_c", "person": "sarah_c", "direction": "i_owe", "amount": 15, "name": "Wine for book club",
     "date": "2026-09-17", "settled": "2026-09-18T09:00"},
    {"key": "d_kenji", "person": "kenji", "direction": "i_owe", "amount": 300, "name": "Mom's plane ticket",
     "date": "2026-08-15"},
    {"key": "d_marc_g", "person": "marc_g", "direction": "owes_me", "amount": 60, "name": "Park passes",
     "date": "2026-08-30"},
    {"key": "d_elise", "person": "elise", "direction": "i_owe", "amount": 25, "name": "First aid refill",
     "date": "2026-10-04"},
    {"key": "d_gab", "person": "gab", "direction": "owes_me", "amount": 18, "name": "Piranesi copy",
     "date": "2026-06-12", "settled": "2026-07-01T12:00"},
    {"key": "d_zoe", "person": "zoe", "direction": "i_owe", "amount": 90, "name": "September babysitting",
     "date": "2026-09-30"},
    {"key": "d_priya", "person": "priya", "direction": "owes_me", "amount": 12, "name": "Coffee run",
     "date": "2026-10-02"},
    {"key": "d_matthieu", "person": "matthieu", "direction": "owes_me", "amount": 40, "name": "Moving dolly rental",
     "date": "2026-06-02"},
]

LOCKER = [
    {"key": "banking", "name": "Online banking", "type": "login", "username": "ytanaka88",
     "url": "https://banking.example.ca", "password": "Sakura!2026", "starred": True},
    {"key": "lumen_sso", "name": "Lumen SSO", "type": "login", "username": "yuki@lumen.studio",
     "url": "https://sso.lumen.studio", "password": "Pixel-Fox-44", "notes": "work"},
    {"key": "streaming", "name": "Streaming account", "type": "login", "username": "yuki.t",
     "url": "https://tv.example.com", "password": "movienight7", "notes": "Daniel still has it, change it"},
    {"key": "school_portal", "name": "School portal", "type": "login", "username": "parent.tanaka",
     "url": "https://portal.school.example", "password": "Mika2017!", "notes": "Mika"},
    {"key": "visa", "name": "Visa card", "type": "card", "card_number": "4520 1188 3077 9142", "cvv": "604",
     "starred": True},
    {"key": "door_code", "name": "Building door code", "type": "note", "notes": "4471 then pound, side door"},
    {"key": "sin", "name": "Social insurance number", "type": "identity", "password": "046 454 286"},
    {"key": "wifi", "name": "Home wifi", "type": "wifi", "password": "tanuki-plateau-9"},
    {"key": "laptop", "name": "Laptop login", "type": "password", "password": "Kintsugi#2024"},
    {"key": "git_key", "name": "Work git key", "type": "ssh_key", "notes": "work laptop",
     "password": "ssh-ed25519 AAAAC3-yuki-lumen"},
    {"key": "api_token", "name": "Prototype API token", "type": "api_credential", "notes": "Northwind sandbox",
     "password": "nw-sbx-5521"},
    {"key": "passport", "name": "Canadian passport", "type": "passport", "notes": "expires 2031"},
    {"key": "resp", "name": "RESP account", "type": "bank_account", "notes": "Mika's education savings"},
    {"key": "dl", "name": "Driver's licence", "type": "driving_licence", "notes": "renew in november"},
    {"key": "fonts", "name": "Font licence", "type": "software_licence", "password": "FNT-YT-8830"},
    {"key": "crypto", "name": "Old crypto wallet", "type": "crypto_wallet", "notes": "Daniel's idea, nearly empty"},
    {"key": "climbing", "name": "Climbing gym pass", "type": "membership"},
    {"key": "health_card", "name": "Health insurance card", "type": "document"},
    {"key": "joint_login", "name": "Joint account login", "type": "login", "username": "roy.tanaka",
     "url": "https://banking.example.ca", "password": "OurHome2019", "trashed": "2026-09-25T11:00"},
]

LINKS = [
    {"from": "plan", "to": "daniel"},
    {"from": "plan", "to": "josee"},
    {"from": "review_lawyer", "to": "josee"},
    {"from": "joint_acct", "to": "daniel"},
    {"from": "rrsp", "to": "josee"},
    {"from": "receipts_1", "to": "daniel"},
    {"from": "receipts_2", "to": "daniel"},
    {"from": "export_assets", "to": "olivier"},
    {"from": "deck", "to": "sarah_n"},
    {"from": "research_plan", "to": "priya"},
    {"from": "participants", "to": "priya"},
    {"from": "field_trip", "to": "caron"},
    {"from": "flu_shot", "to": "fortin"},
    {"from": "invites", "to": "mika"},
    {"from": "ski", "to": "mika"},
    {"from": "costume", "to": "mika"},
    {"from": "radiator", "to": "marc_t"},
    {"from": "pharmacy", "to": "hiroko"},
    {"from": "first_aid", "to": "elise"},
    {"from": "route", "to": "marc_g"},
    {"from": "thank_you", "to": "rachel"},
    {"from": "therapy_book", "to": "mehta"},
    {"from": "custody", "to": "daniel"},
    {"from": "custody", "to": "mika"},
    {"from": "allergies", "to": "mika"},
    {"from": "ped_questions", "to": "fortin"},
    {"from": "bday_ideas", "to": "mika"},
    {"from": "s11_thoughts", "to": "sarah_c"},
    {"from": "picks", "to": "ines"},
    {"from": "picks", "to": "gab"},
    {"from": "orford_notes", "to": "nadia"},
    {"from": "tremblant_pack", "to": "elise"},
    {"from": "talking_points", "to": "sarah_n"},
    {"from": "one_on_one_n", "to": "sarah_n"},
    {"from": "retro", "to": "olivier"},
    {"from": "retro", "to": "priya"},
    {"from": "therapy_notes", "to": "mehta"},
    {"from": "timeline", "to": "josee"},
    {"from": "lawyer_q", "to": "josee"},
    {"from": "curry", "to": "hiroko"},
    {"from": "ski_note", "to": "mika"},
]


def world():
    return {
        "me": "Yuki Tanaka",
        "epoch": "2019-01-01T09:00",
        "seed": "T25",
        "currency": "CAD",
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
    out = HERE / "T25.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
