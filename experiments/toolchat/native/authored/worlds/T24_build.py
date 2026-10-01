"""World T24: Carlos Mendoza, high-school basketball coach and history teacher in El Paso (USD vault).

    python3 authored/worlds/T24_build.py      # writes authored/worlds/T24.json (deterministic)

Today in the sessions is Friday 2026-09-18 15:05 (preseason: open gym Tue/Thu, conditioning Mon/Wed,
Saturday mornings on his brother-in-law Rudy's landscaping crew). Carlos is married to Elena; their
kids are Sofia (15, volleyball), Mateo (12) and Lucia (turning 7). He is a building rep in the
teachers' union. Built-in ambiguity: two Davids (booster treasurer David Ruiz, union rep David
Salazar), two Garzas (Rudy, Marisol), nicknames (Amá, Rudy, Patty, Tío Beto), a misspelled-looking
name (Micheal Duran), two "Dentist" appointments, two "Sofia volleyball game" events, two "Football
game duty" nights, near-duplicate tasks ("Mow Mrs. Whitfield's lawn", monthly water bill), cancelled
events, completed and cancelled tasks, rows trashed inside and past the 30-day restore window, an
empty group, an empty folder, an empty notebook, an empty album, and two groups in MXN.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        # family
        {"key": "elena", "name": "Elena Mendoza", "role": "wife", "starred": True, "met": "UTEP",
         "last_contacted": "2026-09-18T12:10", "last_contacted_kind": "message"},
        {"key": "sofia", "name": "Sofia Mendoza", "role": "daughter", "last_contacted": "2026-09-17T19:00",
         "last_contacted_kind": "visit"},
        {"key": "mateo", "name": "Mateo Mendoza", "role": "son"},
        {"key": "lucia", "name": "Lucia Mendoza", "role": "daughter"},
        {"key": "rosa", "name": "Rosa Mendoza", "role": "mother", "nickname": "Amá", "cadence": 7, "starred": True,
         "met": "family", "last_contacted": "2026-09-13T11:00", "last_contacted_kind": "visit"},
        {"key": "rudy", "name": "Rodolfo Garza", "role": "brother-in-law", "nickname": "Rudy", "cadence": 14,
         "met": "family", "last_contacted": "2026-09-12T11:30", "last_contacted_kind": "visit"},
        {"key": "marisol", "name": "Marisol Garza", "role": "sister-in-law", "cadence": 30,
         "last_contacted": "2026-08-30T17:00", "last_contacted_kind": "call"},
        {"key": "beto", "name": "Alberto Mendoza", "role": "uncle in Juárez", "nickname": "Tío Beto", "cadence": 30,
         "met": "family", "last_contacted": "2026-08-16T10:00", "last_contacted_kind": "call"},
        # school and team
        {"key": "ray", "name": "Ray Dominguez", "role": "assistant coach", "starred": True, "cadence": 7,
         "met": "UTEP", "last_contacted": "2026-09-17T17:40", "last_contacted_kind": "meeting"},
        {"key": "linda", "name": "Linda Chavez", "role": "athletic director", "cadence": 14,
         "met": "Coronado High", "last_contacted": "2026-09-10T08:00", "last_contacted_kind": "meeting"},
        {"key": "frank", "name": "Frank Ortega", "role": "principal", "cadence": 30,
         "last_contacted": "2026-09-04T09:00", "last_contacted_kind": "meeting"},
        {"key": "jessica", "name": "Jessica Torres", "role": "history dept chair", "starred": True, "cadence": 14,
         "met": "UTEP", "last_contacted": "2026-09-17T15:30", "last_contacted_kind": "meeting"},
        {"key": "david_r", "name": "David Ruiz", "role": "booster club treasurer", "cadence": 14,
         "met": "Coronado High", "last_contacted": "2026-09-15T19:30", "last_contacted_kind": "meeting"},
        {"key": "micheal", "name": "Micheal Duran", "role": "referee", "met": "summer league",
         "last_contacted": "2026-07-25T12:00", "last_contacted_kind": "message"},
        # team parents and players
        {"key": "patty", "name": "Patricia Nuñez", "role": "team parent", "nickname": "Patty", "starred": True,
         "cadence": 7, "last_contacted": "2026-09-16T20:00", "last_contacted_kind": "call"},
        {"key": "gilbert", "name": "Gilbert Herrera", "role": "team parent", "cadence": 21,
         "last_contacted": "2026-09-08T18:00", "last_contacted_kind": "message"},
        {"key": "yvonne", "name": "Yvonne Castillo", "role": "team parent", "starred": True,
         "last_contacted": "2026-09-15T19:30", "last_contacted_kind": "meeting"},
        {"key": "veronica", "name": "Veronica Lujan", "role": "team parent", "met": "church",
         "last_contacted": "2026-09-11T21:00", "last_contacted_kind": "message"},
        {"key": "marcus", "name": "Marcus Herrera", "role": "player, point guard"},
        {"key": "andre", "name": "Andre Lujan", "role": "player, center"},
        # union
        {"key": "david_s", "name": "David Salazar", "role": "union rep", "cadence": 14, "met": "union training",
         "last_contacted": "2026-09-16T18:30", "last_contacted_kind": "meeting"},
        {"key": "kim", "name": "Kimberly Walsh", "role": "union secretary", "cadence": 30,
         "last_contacted": "2026-09-09T16:00", "last_contacted_kind": "coffee"},
        {"key": "tom", "name": "Tom Beasley", "role": "union president", "starred": True,
         "last_contacted": "2026-08-19T18:30", "last_contacted_kind": "meeting"},
        # landscaping
        {"key": "hector", "name": "Hector Ramos", "role": "landscaping crew", "cadence": 7,
         "last_contacted": "2026-09-12T11:00", "last_contacted_kind": "visit"},
        {"key": "barbara", "name": "Barbara Whitfield", "role": "landscaping client",
         "last_contacted": "2026-09-12T10:30", "last_contacted_kind": "visit"},
        {"key": "javier", "name": "Javier Soto", "role": "landscaping client",
         "last_contacted": "2026-09-14T19:00", "last_contacted_kind": "call"},
        # others
        {"key": "priya", "name": "Priya Anand", "role": "pediatrician"},
        {"key": "sandra", "name": "Sandra Villalobos", "role": "dentist"},
        {"key": "lupe", "name": "Lupe Ortiz", "role": "neighbour", "met": "church", "cadence": 30,
         "last_contacted": "2026-09-06T10:00", "last_contacted_kind": "visit"},
        # trashed: one inside the 30-day window, one past it
        {"key": "greg", "name": "Greg Novak", "role": "old union contact", "trashed": "2026-09-05T09:00"},
        {"key": "tony", "name": "Tony Baca", "role": "old AAU coach", "trashed": "2026-07-20T09:00"},
    ]


GROUPS = [
    {"key": "booster_g", "name": "Booster club concessions", "members": ["david_r", "yvonne", "patty", "gilbert"],
     "created": "2025-11-01T10:00"},
    {"key": "yard_g", "name": "Rudy's landscaping crew", "members": ["rudy", "hector"],
     "created": "2026-04-01T10:00"},
    {"key": "reunion_g", "name": "Juárez family reunion", "currency": "MXN", "members": ["beto", "rudy", "marisol", "rosa"],
     "created": "2026-07-01T10:00"},
    {"key": "quince_g", "name": "Cousin Ana's quince gift", "currency": "MXN", "members": ["beto", "rosa"],
     "created": "2026-08-10T10:00"},
    {"key": "union_g", "name": "Union pizza fund", "members": ["david_s", "kim", "tom"],
     "created": "2026-08-15T10:00"},
    {"key": "banquet_g", "name": "Team banquet 2026", "members": ["patty", "yvonne"],
     "created": "2026-09-14T10:00"},
]

EXPENSES = [
    {"group": "booster_g", "name": "Concession candy", "amount": 180, "paid_by": "me",
     "split": ["me", "david_r", "yvonne", "patty"], "date": "2026-09-04"},
    {"group": "booster_g", "name": "Hot dog buns", "amount": 60, "paid_by": "yvonne",
     "split": ["me", "yvonne", "gilbert"], "date": "2026-09-11"},
    {"group": "yard_g", "name": "Trimmer line and gas", "amount": 90, "paid_by": "me",
     "split": ["me", "rudy", "hector"], "date": "2026-09-12"},
    {"group": "yard_g", "name": "Mulch delivery", "amount": 240, "paid_by": "rudy",
     "split": ["me", "rudy"], "date": "2026-09-05"},
    {"group": "reunion_g", "name": "Salon rental deposit", "amount": 4000, "paid_by": "beto",
     "split": ["me", "beto", "rudy", "rosa"], "date": "2026-08-20", "currency": "MXN"},
    {"group": "quince_g", "name": "Gift envelope", "amount": 3000, "paid_by": "me",
     "split": ["me", "beto", "rosa"], "date": "2026-08-12", "currency": "MXN"},
    {"group": "union_g", "name": "Pizza for September meeting", "amount": 75, "paid_by": "david_s",
     "split": ["me", "david_s", "kim", "tom"], "date": "2026-09-16"},
]

LISTS = [
    {"key": "home_l", "name": "Home", "area": "family"},
    {"key": "team_l", "name": "Basketball", "area": "coaching"},
    {"key": "school_l", "name": "History class", "area": "teaching"},
    {"key": "union_l", "name": "Union", "area": "union"},
    {"key": "land_l", "name": "Landscaping", "area": "side job"},
    {"key": "shop_l", "name": "Groceries"},
]


def events():
    out = []
    # open gym, Tuesday and Thursday afternoons
    d = date(2026, 9, 1)
    while d <= date(2026, 10, 15):
        if d.weekday() in (1, 3):
            ev = {"key": f"gym_{d.strftime('%m%d')}", "name": "Open gym", "start": f"{d}T16:00",
                  "end": f"{d}T17:30", "attendees": ["ray"], "description": "main gym, bring the ball cart"}
            if d == date(2026, 9, 10):
                ev["cancelled"] = "2026-09-08T12:00"
            out.append(ev)
        d += timedelta(days=1)
    # varsity conditioning, Monday and Wednesday mornings
    d = date(2026, 9, 9)
    while d <= date(2026, 9, 30):
        if d.weekday() in (0, 2):
            out.append({"key": f"cond_{d.strftime('%m%d')}", "name": "Varsity conditioning", "start": f"{d}T06:30",
                        "end": f"{d}T07:30", "attendees": ["ray"], "description": "track, then weight room"})
        d += timedelta(days=1)
    # landscaping Saturdays with Rudy's crew
    for d, client in [("2026-08-29", "Soto"), ("2026-09-05", "Castillo"), ("2026-09-12", "Whitfield"),
                      ("2026-09-19", "Soto"), ("2026-09-26", "Whitfield")]:
        out.append({"key": f"yard_{d[5:7]}{d[8:]}", "name": "Landscaping job", "start": f"{d}T07:00",
                    "end": f"{d}T11:00", "attendees": ["rudy", "hector"], "description": f"{client} yard"})
    # union meetings, third Wednesday
    for d in ("2026-08-19", "2026-09-16", "2026-10-21"):
        out.append({"key": f"union_{d[5:7]}", "name": "Union meeting", "start": f"{d}T17:00", "end": f"{d}T18:30",
                    "attendees": ["david_s", "kim", "tom"], "description": "library, room 114"})
    out += [
        # family
        {"key": "dentist_mateo", "name": "Dentist - Mateo", "start": "2026-09-22T17:45", "end": "2026-09-22T18:30",
         "attendees": ["mateo", "sandra"], "description": "Villalobos Family Dental"},
        {"key": "dentist_lucia", "name": "Dentist - Lucia", "start": "2026-10-06T17:45", "end": "2026-10-06T18:30",
         "attendees": ["lucia", "sandra"], "description": "Villalobos Family Dental"},
        {"key": "vb_0919", "name": "Sofia volleyball game", "start": "2026-09-19T13:00", "end": "2026-09-19T14:30",
         "attendees": ["sofia"], "description": "home vs Franklin"},
        {"key": "vb_0924", "name": "Sofia volleyball game", "start": "2026-09-24T18:00", "end": "2026-09-24T19:30",
         "attendees": ["sofia"], "description": "away at Eastwood"},
        {"key": "lucia_bday", "name": "Lucia's birthday party", "start": "2026-09-27T14:00", "end": "2026-09-27T17:00",
         "attendees": ["lucia", "elena", "rosa", "rudy", "marisol"], "description": "backyard, piñata at 4"},
        {"key": "anniv", "name": "Anniversary dinner with Elena", "start": "2026-10-03T19:00",
         "end": "2026-10-03T21:30", "attendees": ["elena"], "description": "L&J Cafe"},
        {"key": "checkup", "name": "Checkup with Dr. Anand", "start": "2026-09-25T15:00", "end": "2026-09-25T15:30",
         "attendees": ["lucia", "priya"]},
        {"key": "beto_call", "name": "Call with Tío Beto", "start": "2026-09-20T11:00", "end": "2026-09-20T11:30",
         "attendees": ["beto"]},
        {"key": "reunion", "name": "Juárez family reunion", "start": "2026-10-17T12:00", "end": "2026-10-17T20:00",
         "attendees": ["beto", "rosa", "rudy", "marisol", "elena"], "description": "Salón Las Palmas"},
        {"key": "science_fair", "name": "Mateo's science fair", "start": "2026-10-15T18:00", "end": "2026-10-15T19:30",
         "attendees": ["mateo"]},
        {"key": "school_play", "name": "Lucia's school play", "start": "2026-09-10T18:00", "end": "2026-09-10T19:00",
         "attendees": ["lucia", "elena"]},
        {"key": "oil_change", "name": "Oil change", "start": "2026-09-12T12:00", "end": "2026-09-12T12:45"},
        {"key": "elena_dinner", "name": "Elena's work dinner", "start": "2026-09-12T19:00", "end": "2026-09-12T21:00",
         "attendees": ["elena"], "cancelled": "2026-09-11T10:00"},
        {"key": "game_night", "name": "Game night at Rudy's", "start": "2026-09-13T18:00", "end": "2026-09-13T21:00",
         "attendees": ["rudy", "marisol"], "cancelled": "2026-09-13T09:00"},
        {"key": "estimate", "name": "Estimate at Soto house", "start": "2026-09-20T15:00", "end": "2026-09-20T16:00",
         "attendees": ["javier", "rudy"]},
        {"key": "ray_coffee", "name": "Coffee with Ray", "start": "2026-09-18T17:30", "end": "2026-09-18T18:00",
         "attendees": ["ray"]},
        # school
        {"key": "ptc", "name": "Parent-teacher conferences", "start": "2026-10-08T17:45", "end": "2026-10-08T20:00",
         "attendees": ["jessica"]},
        {"key": "bts_night", "name": "Back to school night", "start": "2026-09-03T18:00", "end": "2026-09-03T20:00",
         "attendees": ["frank", "jessica"]},
        {"key": "dept_mtg", "name": "History dept meeting", "start": "2026-09-17T15:15", "end": "2026-09-17T16:00",
         "attendees": ["jessica"]},
        {"key": "chamizal", "name": "Field trip to Chamizal", "start": "2026-10-02T08:30", "end": "2026-10-02T14:00",
         "attendees": ["jessica"], "description": "Chamizal National Memorial, two buses"},
        {"key": "staff_dev", "name": "Staff development day", "start": "2026-09-04T08:00", "end": "2026-09-04T15:00",
         "attendees": ["frank"]},
        {"key": "fb_0911", "name": "Football game duty", "start": "2026-09-11T19:00", "end": "2026-09-11T22:00",
         "attendees": ["linda"]},
        {"key": "fb_0925", "name": "Football game duty", "start": "2026-09-25T19:00", "end": "2026-09-25T22:00",
         "attendees": ["linda"]},
        # team
        {"key": "booster_0915", "name": "Booster club meeting", "start": "2026-09-15T18:30", "end": "2026-09-15T19:30",
         "attendees": ["david_r", "yvonne", "patty"]},
        {"key": "booster_1013", "name": "Booster club meeting", "start": "2026-10-13T18:30", "end": "2026-10-13T19:30",
         "attendees": ["david_r", "yvonne", "patty"]},
        {"key": "tryout_night", "name": "Tryouts info night", "start": "2026-10-01T18:30", "end": "2026-10-01T19:30",
         "attendees": ["ray", "patty", "gilbert", "veronica"]},
        {"key": "scrimmage", "name": "Scrimmage vs Coronado", "start": "2026-10-10T10:00", "end": "2026-10-10T12:00",
         "attendees": ["ray", "micheal"], "description": "their gym"},
        {"key": "ref_clinic", "name": "Referee clinic", "start": "2026-09-26T13:00", "end": "2026-09-26T16:00",
         "attendees": ["micheal"]},
        {"key": "coach_clinic", "name": "Coaches clinic in Las Cruces", "start": "2026-08-22T09:00",
         "end": "2026-08-22T15:00", "attendees": ["ray"]},
        {"key": "summer_final", "name": "Summer league final", "start": "2026-07-25T10:00", "end": "2026-07-25T12:00",
         "attendees": ["ray", "micheal"]},
        {"key": "film_session", "name": "Film session with Ray", "start": "2026-09-21T15:00", "end": "2026-09-21T16:00",
         "attendees": ["ray"]},
        # union
        {"key": "bargaining", "name": "Union bargaining session", "start": "2026-09-29T18:00",
         "end": "2026-09-29T20:00", "attendees": ["david_s", "tom"], "description": "district office"},
        {"key": "kim_coffee", "name": "Coffee with Kim", "start": "2026-09-09T15:15", "end": "2026-09-09T15:45",
         "attendees": ["kim"]},
        # trashed: two inside the 30-day window, one past it
        {"key": "haircut", "name": "Haircut", "start": "2026-09-08T18:00", "end": "2026-09-08T18:30",
         "trashed": "2026-09-09T09:00"},
        {"key": "car_wash", "name": "Car wash fundraiser", "start": "2026-09-06T09:00", "end": "2026-09-06T12:00",
         "attendees": ["patty", "yvonne"], "trashed": "2026-09-10T09:00"},
        {"key": "pool_party", "name": "Pool party at the Castillos", "start": "2026-08-01T14:00",
         "end": "2026-08-01T17:00", "attendees": ["yvonne"], "trashed": "2026-08-05T09:00"},
    ]
    return out


def tasks():
    t = [
        # home
        {"key": "garage_door", "name": "Fix the garage door opener", "due": "2026-09-19", "priority": 2, "effort": 45,
         "list": "home_l", "description": "clicks but won't lift, check the sensor"},
        {"key": "ac_filter", "name": "Replace AC filter", "due": "2026-09-20", "effort": 15, "list": "home_l"},
        {"key": "car_reg", "name": "Renew car registration", "due": "2026-09-30", "priority": 1, "effort": 20,
         "list": "home_l"},
        {"key": "garage_clean", "name": "Clean out the garage", "status": "cancelled", "priority": 4, "effort": 240,
         "list": "home_l"},
        {"key": "hvac", "name": "Schedule HVAC service", "due": "2026-09-01", "completed": "2026-08-31T19:00",
         "list": "home_l"},
        {"key": "mateo_bike", "name": "Fix Mateo's bike", "effort": 45, "list": "home_l"},
        # team
        {"key": "jerseys", "name": "Order new game jerseys", "due": "2026-09-25", "priority": 1, "effort": 60,
         "status": "in_progress", "list": "team_l", "description": "red home set, 15 players"},
        {"key": "sizes", "name": "Get jersey sizes from players", "parent": "jerseys", "due": "2026-09-21",
         "effort": 30},
        {"key": "quote", "name": "Get quote from Sun City Sports", "parent": "jerseys", "due": "2026-09-22",
         "effort": 20, "completed": "2026-09-16T20:00"},
        {"key": "jersey_money", "name": "Collect jersey money", "parent": "jerseys", "due": "2026-09-28",
         "effort": 60},
        {"key": "tryout_forms", "name": "Print tryout forms", "due": "2026-09-28", "effort": 15, "list": "team_l"},
        {"key": "book_gym", "name": "Book gym for tryouts", "due": "2026-09-10", "completed": "2026-09-09T12:00",
         "list": "team_l"},
        {"key": "roster", "name": "Update team roster", "due": "2026-09-23", "priority": 2, "effort": 30,
         "list": "team_l"},
        {"key": "film", "name": "Film study for Coronado", "due": "2026-10-09", "priority": 3, "effort": 120,
         "list": "team_l"},
        {"key": "email_parents", "name": "Email team parents about fundraiser", "due": "2026-09-18", "effort": 15,
         "list": "team_l"},
        {"key": "physicals", "name": "Check physicals forms", "due": "2026-09-21", "priority": 1, "effort": 45,
         "list": "team_l"},
        {"key": "balls", "name": "Order basketballs", "status": "cancelled", "priority": 5, "list": "team_l"},
        # history class
        {"key": "grade_tests", "name": "Grade unit 1 tests", "due": "2026-09-21", "priority": 1, "effort": 180,
         "status": "in_progress", "list": "school_l"},
        {"key": "lesson_rev", "name": "Write Mexican Revolution lesson plan", "due": "2026-09-22", "priority": 2,
         "effort": 90, "list": "school_l"},
        {"key": "trip_plan", "name": "Plan Chamizal field trip", "due": "2026-09-25", "priority": 2, "effort": 60,
         "status": "in_progress", "list": "school_l"},
        {"key": "slips", "name": "Send permission slips", "parent": "trip_plan", "due": "2026-09-21", "effort": 20},
        {"key": "bus", "name": "Book the bus", "parent": "trip_plan", "due": "2026-09-23",
         "completed": "2026-09-16T10:00"},
        {"key": "chaperones", "name": "Find two chaperones", "parent": "trip_plan", "due": "2026-09-24", "effort": 30},
        {"key": "grades_portal", "name": "Enter grades in portal", "due": "2026-09-25", "effort": 30,
         "list": "school_l"},
        {"key": "packets", "name": "Copy primary source packets", "due": "2026-09-18",
         "completed": "2026-09-17T07:15", "list": "school_l"},
        {"key": "syllabus", "name": "Update syllabus", "due": "2026-08-20", "completed": "2026-08-19T16:00",
         "list": "school_l"},
        # union
        {"key": "read_proposal", "name": "Read the contract proposal", "due": "2026-09-28", "priority": 2,
         "effort": 60, "list": "union_l"},
        {"key": "survey", "name": "Survey members about planning period", "due": "2026-10-02", "priority": 3,
         "effort": 90, "list": "union_l"},
        {"key": "dues", "name": "Pay union dues", "due": "2026-09-01", "completed": "2026-09-01T08:00",
         "list": "union_l"},
        {"key": "bargain_signup", "name": "Sign up for bargaining team", "status": "cancelled", "list": "union_l"},
        # landscaping
        {"key": "mow_1", "name": "Mow Mrs. Whitfield's lawn", "due": "2026-09-12", "completed": "2026-09-12T10:00",
         "list": "land_l", "effort": 90},
        {"key": "mow_2", "name": "Mow Mrs. Whitfield's lawn", "due": "2026-09-26", "list": "land_l", "effort": 90},
        {"key": "mulch", "name": "Buy mulch", "due": "2026-09-19", "effort": 30, "list": "land_l"},
        {"key": "invoice_soto", "name": "Send invoice to Soto", "due": "2026-09-21", "priority": 2, "effort": 15,
         "list": "land_l"},
        {"key": "trimmer", "name": "Fix trimmer line", "effort": 20, "list": "land_l"},
        {"key": "castillo_quote", "name": "Quote for Castillo backyard", "due": "2026-09-24", "priority": 3,
         "effort": 60, "list": "land_l"},
        # groceries
        {"key": "gatorade", "name": "Buy Gatorade for practice", "due": "2026-09-21", "effort": 15, "list": "shop_l"},
        {"key": "cake", "name": "Buy birthday cake for Lucia", "due": "2026-09-26", "priority": 2, "effort": 30,
         "list": "shop_l"},
        {"key": "ink", "name": "Buy printer ink", "effort": 10, "list": "shop_l"},
        # no list
        {"key": "call_ama", "name": "Call Amá about the reunion", "due": "2026-09-20", "effort": 15},
        {"key": "anniv_plan", "name": "Plan anniversary dinner", "due": "2026-09-30", "priority": 2, "effort": 30},
        {"key": "party", "name": "Lucia's birthday party prep", "due": "2026-09-27", "priority": 2,
         "status": "in_progress"},
        {"key": "pinata", "name": "Order piñata", "parent": "party", "due": "2026-09-24", "effort": 20},
        {"key": "invites", "name": "Send party invites", "parent": "party", "due": "2026-09-16",
         "completed": "2026-09-15T21:00"},
        {"key": "favors", "name": "Buy party favors", "parent": "party", "due": "2026-09-25", "effort": 30},
        {"key": "certificate", "name": "Renew teaching certificate", "due": "2026-11-30", "priority": 3,
         "effort": 120},
        {"key": "vb_forms", "name": "Doctor forms for Sofia's volleyball", "due": "2026-09-02",
         "completed": "2026-09-02T07:30"},
        {"key": "library", "name": "Return library books", "due": "2026-09-15", "effort": 10},
        {"key": "fence", "name": "Paint the back fence", "status": "cancelled", "priority": 5, "effort": 300},
        {"key": "treadmill", "name": "Sell old treadmill", "list": "home_l", "trashed": "2026-09-10T10:00"},
        {"key": "magazine", "name": "Cancel magazine subscription", "trashed": "2026-07-30T10:00"},
    ]
    # water bill, monthly on the 15th
    for m in (6, 7, 8):
        t.append({"key": f"water_{m:02d}", "name": "Pay water bill", "due": f"2026-{m:02d}-15",
                  "completed": f"2026-{m:02d}-14T20:00", "list": "home_l", "effort": 5})
    t.append({"key": "water_09", "name": "Pay water bill", "due": "2026-09-25", "list": "home_l", "effort": 5})
    return t


NOTEBOOKS = [
    {"key": "coach_nb", "name": "Coaching"},
    {"key": "hist_nb", "name": "History lessons"},
    {"key": "union_nb", "name": "Union"},
    {"key": "land_nb", "name": "Landscaping"},
    {"key": "recipes_nb", "name": "Recipes"},
    {"key": "ideas_nb", "name": "Old ideas"},
]

NOTES = [
    {"key": "press", "name": "Press break", "body": "ball to the middle, wings run, no dribbling into traps",
     "notebook": "coach_nb", "created": "2026-09-08T21:00"},
    {"key": "zone", "name": "Zone defense 2-3", "body": "Andre anchors the middle, wings close out hard",
     "notebook": "coach_nb", "created": "2026-09-14T20:30"},
    {"key": "drills", "name": "Tryout drills", "body": "3-man weave, shell drill, 17s for conditioning",
     "notebook": "coach_nb", "created": "2026-09-16T21:15"},
    {"key": "ft_note", "name": "Marcus free throws", "body": "elbow drifting out, 20 makes after every practice",
     "notebook": "coach_nb", "created": "2026-09-17T21:00"},
    {"key": "practice_plan", "name": "Practice plan week 3", "body": "Mon shooting, Tue press, Thu scrimmage",
     "notebook": "coach_nb", "created": "2026-09-13T19:00", "pinned": True},
    {"key": "rev_outline", "name": "Mexican Revolution outline", "body": "Díaz, Madero, Villa in Juárez, 1917 constitution",
     "notebook": "hist_nb", "created": "2026-09-15T20:00"},
    {"key": "chamizal_facts", "name": "Chamizal treaty facts", "body": "1963, river moved, land swap with Mexico",
     "notebook": "hist_nb", "created": "2026-09-10T20:30"},
    {"key": "questions", "name": "Discussion questions unit 2", "body": "why did the border move, who decided",
     "notebook": "hist_nb", "created": "2026-09-16T06:45"},
    {"key": "sources", "name": "Primary sources list", "body": "Zimmermann telegram, Plan de Ayala, border photos",
     "notebook": "hist_nb", "created": "2026-08-25T19:00"},
    {"key": "proposal_notes", "name": "Contract proposal notes", "body": "raise 3 percent, planning period cut is the fight",
     "notebook": "union_nb", "created": "2026-09-16T19:00"},
    {"key": "survey_qs", "name": "Planning period survey questions", "body": "minutes per week, duty periods, coverage",
     "notebook": "union_nb", "created": "2026-09-11T20:00"},
    {"key": "bargain_dates", "name": "Bargaining dates", "body": "sept 29, oct 13, oct 27 at the district office",
     "notebook": "union_nb", "created": "2026-09-02T18:00"},
    {"key": "whitfield_note", "name": "Whitfield yard notes", "body": "sprinkler head broken by the gate, dog in the back",
     "notebook": "land_nb", "created": "2026-09-12T12:30"},
    {"key": "soto_note", "name": "Soto estimate", "body": "front xeriscape, about 40 bags of rock",
     "notebook": "land_nb", "created": "2026-09-14T19:30"},
    {"key": "mulch_note", "name": "Mulch prices", "body": "Home Depot 4 a bag, the yard on Montana cheaper by the load",
     "notebook": "land_nb", "created": "2026-09-05T13:00"},
    {"key": "caldo", "name": "Amá's caldo de res", "body": "shank, corn, calabacita, cilantro at the end",
     "notebook": "recipes_nb", "created": "2026-08-09T18:00"},
    {"key": "enchiladas", "name": "Elena's enchiladas", "body": "red chile, queso fresco, bake 20 min",
     "notebook": "recipes_nb", "created": "2026-07-19T18:00"},
    {"key": "menudo", "name": "Menudo", "body": "start saturday night, hominy, oregano and lime",
     "notebook": "recipes_nb", "created": "2026-06-28T09:00"},
    {"key": "gift_elena", "name": "Gift ideas for Elena", "body": "turquoise earrings, spa day in Cloudcroft",
     "created": "2026-09-12T22:00"},
    {"key": "party_list", "name": "Lucia party list", "body": "piñata, frozen theme, cousins from Juárez",
     "created": "2026-09-14T21:30"},
    {"key": "car_note", "name": "Car maintenance", "body": "oil at 62000, tires rotated in june",
     "created": "2026-09-12T13:00"},
    {"key": "vb_sched", "name": "Sofia volleyball schedule", "body": "home games sat, away games thursday",
     "created": "2026-09-01T20:00"},
    {"key": "banquet_ideas", "name": "Banquet ideas", "body": "senior slideshow, trophies from Sun City",
     "created": "2026-09-15T20:10"},
    {"key": "old_plan", "name": "Old practice plan", "body": "summer league rotations", "notebook": "coach_nb",
     "created": "2026-07-01T10:00", "trashed": "2026-09-10T10:00"},
    {"key": "camp_ideas", "name": "Summer camp ideas", "body": "shooting camp for middle school",
     "created": "2026-05-01T10:00", "trashed": "2026-07-01T10:00"},
]

FOLDERS = [
    {"key": "team_f", "name": "Team"},
    {"key": "school_f", "name": "School"},
    {"key": "union_f", "name": "Union"},
    {"key": "house_f", "name": "House"},
    {"key": "land_f", "name": "Landscaping invoices"},
    {"key": "old_f", "name": "Old stuff"},
]

DOCUMENTS = [
    {"key": "roster_doc", "name": "Team roster 2026", "folder": "team_f", "created": "2026-08-20T19:00",
     "starred": True},
    {"key": "physicals_doc", "name": "Physicals checklist", "folder": "team_f", "created": "2026-09-01T07:00"},
    {"key": "tourney", "name": "Tournament schedule", "folder": "team_f", "created": "2026-09-14T19:30"},
    {"key": "jersey_quote", "name": "Jersey quote Sun City Sports", "folder": "team_f", "created": "2026-09-16T20:15"},
    {"key": "syllabus_doc", "name": "Syllabus US History", "folder": "school_f", "created": "2026-08-10T10:00",
     "starred": True},
    {"key": "slip_doc", "name": "Field trip permission slip", "folder": "school_f", "created": "2026-09-15T21:00"},
    {"key": "test_doc", "name": "Unit 1 test", "folder": "school_f", "created": "2026-09-08T06:30"},
    {"key": "proposal_doc", "name": "Contract proposal 2026", "folder": "union_f", "created": "2026-09-10T18:00"},
    {"key": "bylaws", "name": "Union bylaws", "folder": "union_f", "created": "2024-01-15T10:00"},
    {"key": "mortgage", "name": "Mortgage statement", "folder": "house_f", "created": "2026-09-01T09:00"},
    {"key": "home_ins", "name": "Home insurance policy", "folder": "house_f", "created": "2026-03-01T10:00",
     "starred": True},
    {"key": "reg_doc", "name": "Car registration renewal", "folder": "house_f", "created": "2026-09-05T11:00"},
    {"key": "inv_whit", "name": "Invoice Whitfield September", "folder": "land_f", "created": "2026-09-12T13:00"},
    {"key": "inv_soto", "name": "Invoice Soto August", "folder": "land_f", "created": "2026-08-30T12:00"},
    {"key": "scan", "name": "Scan 0912", "created": "2026-09-12T20:05"},
    {"key": "vax", "name": "Lucia vaccination record", "created": "2026-09-02T16:00"},
    {"key": "receipt", "name": "Receipt Home Depot", "created": "2026-09-13T10:30"},
    {"key": "old_roster", "name": "Old roster 2025", "folder": "team_f", "created": "2025-08-20T10:00",
     "trashed": "2026-09-08T09:00"},
    {"key": "tax_draft", "name": "2024 tax return draft", "folder": "house_f", "created": "2025-03-01T10:00",
     "trashed": "2026-06-30T09:00"},
]

ALBUMS = [
    {"key": "team_al", "name": "Basketball 2026"},
    {"key": "fam_al", "name": "Family"},
    {"key": "lucia_al", "name": "Lucia"},
    {"key": "land_al", "name": "Landscaping jobs"},
    {"key": "yards_al", "name": "Rudy's yards"},
    {"key": "juarez_al", "name": "Juárez 2025"},
    {"key": "banquet_al", "name": "Banquet 2026"},
]

PHOTOS = [
    {"key": "p_opengym", "name": "Open gym first day", "taken": "2026-09-01T16:30", "albums": ["team_al"],
     "people": ["ray", "marcus", "andre"], "starred": True},
    {"key": "p_press", "name": "Press break whiteboard", "taken": "2026-09-08T17:20", "albums": ["team_al"]},
    {"key": "p_marcus", "name": "Marcus at the line", "taken": "2026-09-15T17:05", "albums": ["team_al"],
     "people": ["marcus"]},
    {"key": "p_andre", "name": "Andre dunk", "taken": "2026-09-17T16:45", "albums": ["team_al"],
     "people": ["andre"]},
    {"key": "p_summer", "name": "Summer league champs", "taken": "2026-07-25T12:10", "albums": ["team_al"],
     "people": ["ray", "marcus", "andre", "micheal"], "starred": True},
    {"key": "p_clinic", "name": "Clinic in Las Cruces", "taken": "2026-08-22T12:00", "albums": ["team_al"],
     "people": ["ray"]},
    {"key": "p_bday_cake", "name": "Sofia's 15th cake", "taken": "2026-06-06T19:00", "albums": ["fam_al"],
     "people": ["sofia", "elena", "rosa"], "starred": True},
    {"key": "p_ama", "name": "Amá in the kitchen", "taken": "2026-09-13T11:15", "albums": ["fam_al"],
     "people": ["rosa"]},
    {"key": "p_beach", "name": "South Padre sunset", "taken": "2026-07-04T20:30", "albums": ["fam_al"],
     "people": ["elena"]},
    {"key": "p_bts", "name": "Kids first day of school", "taken": "2026-08-12T07:10", "albums": ["fam_al"],
     "people": ["sofia", "mateo", "lucia"], "starred": True},
    {"key": "p_vb", "name": "Sofia serving", "taken": "2026-09-05T13:40", "albums": ["fam_al"],
     "people": ["sofia"]},
    {"key": "p_bbq", "name": "Labor day carne asada", "taken": "2026-09-07T15:00", "albums": ["fam_al"],
     "people": ["rudy", "marisol", "elena"]},
    {"key": "p_play", "name": "Lucia as a sunflower", "taken": "2026-09-10T18:30", "albums": ["lucia_al", "fam_al"],
     "people": ["lucia"], "starred": True},
    {"key": "p_lucia_bike", "name": "Lucia training wheels off", "taken": "2026-08-30T10:00", "albums": ["lucia_al"],
     "people": ["lucia", "mateo"]},
    {"key": "p_lucia_zoo", "name": "Lucia at the zoo", "taken": "2026-07-18T11:00", "albums": ["lucia_al"],
     "people": ["lucia", "elena"]},
    {"key": "p_whit_before", "name": "Whitfield yard before", "taken": "2026-09-12T07:10", "albums": ["land_al"]},
    {"key": "p_whit_after", "name": "Whitfield yard after", "taken": "2026-09-12T10:50", "albums": ["land_al"],
     "people": ["hector"]},
    {"key": "p_soto_front", "name": "Soto front yard", "taken": "2026-08-29T08:00", "albums": ["land_al", "yards_al"]},
    {"key": "p_castillo", "name": "Castillo backyard", "taken": "2026-09-05T09:30", "albums": ["yards_al"],
     "people": ["rudy"]},
    {"key": "p_truck", "name": "Rudy's truck loaded", "taken": "2026-09-05T06:50", "albums": ["yards_al"],
     "people": ["rudy", "hector"]},
    {"key": "p_juarez_plaza", "name": "Plaza de Armas", "taken": "2025-10-18T13:00", "albums": ["juarez_al"],
     "people": ["beto"]},
    {"key": "p_juarez_cathedral", "name": "Cathedral in Juárez", "taken": "2025-10-18T15:00", "albums": ["juarez_al"]},
    {"key": "p_juarez_family", "name": "Family at the salón", "taken": "2025-10-18T19:00", "albums": ["juarez_al"],
     "people": ["beto", "rosa", "rudy", "marisol"], "starred": True},
    {"key": "p_union", "name": "Union meeting sign-in", "taken": "2026-09-16T17:05",
     "people": ["david_s", "kim"]},
    {"key": "p_whiteboard", "name": "Classroom whiteboard", "taken": "2026-09-16T07:05"},
    {"key": "p_chamizal", "name": "Chamizal memorial scouting", "taken": "2026-09-13T16:00"},
    {"key": "p_receipt", "name": "Receipt from Home Depot", "taken": "2026-09-13T10:20"},
    {"key": "p_jersey", "name": "Jersey sample", "taken": "2026-09-16T19:45", "people": ["ray"]},
    {"key": "p_sunset", "name": "Franklin Mountains sunset", "taken": "2026-09-14T19:10"},
    {"key": "p_anniv", "name": "Wedding day", "taken": "2011-10-01T17:00", "people": ["elena"], "starred": True},
    {"key": "p_sprinkler", "name": "Broken sprinkler head", "taken": "2026-09-12T08:15", "albums": ["land_al"]},
    {"key": "p_team_huddle", "name": "Team huddle", "taken": "2026-09-17T17:25", "albums": ["team_al"],
     "people": ["ray", "marcus", "andre"]},
    {"key": "p_blurry", "name": "Blurry gym shot", "taken": "2026-09-15T17:00", "albums": ["team_al"],
     "trashed": "2026-09-16T09:00"},
    {"key": "p_dup", "name": "Duplicate sunset", "taken": "2026-09-14T19:11", "trashed": "2026-09-15T09:00"},
    {"key": "p_old", "name": "Old classroom", "taken": "2024-05-20T12:00", "trashed": "2026-07-15T09:00"},
]

DEBTS = [
    {"key": "d_ray", "person": "ray", "direction": "owes_me", "amount": 40, "name": "Lunch at Whataburger",
     "date": "2026-09-11"},
    {"key": "d_rudy", "person": "rudy", "direction": "owes_me", "amount": 320, "name": "Saturday crew pay",
     "date": "2026-09-12"},
    {"key": "d_hector", "person": "hector", "direction": "i_owe", "amount": 60, "name": "Gas money",
     "date": "2026-09-05"},
    {"key": "d_patty", "person": "patty", "direction": "owes_me", "amount": 75, "name": "Team snacks",
     "date": "2026-09-02"},
    {"key": "d_gilbert", "person": "gilbert", "direction": "owes_me", "amount": 40, "name": "Tournament fee share",
     "date": "2026-08-28"},
    {"key": "d_david_s", "person": "david_s", "direction": "i_owe", "amount": 25, "name": "Pizza for union meeting",
     "date": "2026-09-16"},
    {"key": "d_beto", "person": "beto", "direction": "i_owe", "amount": 150, "name": "Reunion deposit",
     "date": "2026-08-15"},
    {"key": "d_marisol", "person": "marisol", "direction": "owes_me", "amount": 45, "name": "Party supplies",
     "date": "2026-09-14"},
    {"key": "d_kim", "person": "kim", "direction": "i_owe", "amount": 18, "name": "Coffee run",
     "date": "2026-09-09"},
    {"key": "d_yvonne", "person": "yvonne", "direction": "owes_me", "amount": 120, "name": "Concession supplies",
     "date": "2026-07-20", "settled": "2026-08-01T10:00"},
    {"key": "d_jessica", "person": "jessica", "direction": "owes_me", "amount": 30, "name": "Book order",
     "date": "2026-06-10", "settled": "2026-06-20T10:00"},
    {"key": "d_lupe", "person": "lupe", "direction": "i_owe", "amount": 45, "name": "Tree trimming split",
     "date": "2026-05-30"},
    {"key": "d_veronica", "person": "veronica", "direction": "owes_me", "amount": 55, "name": "Carpool gas",
     "date": "2026-09-17"},
]

LOCKER = [
    {"key": "district", "name": "School district portal", "type": "login", "username": "cmendoza",
     "url": "https://portal.episd.example", "password": "Chamizal-1963!", "notes": "school"},
    {"key": "venmo", "name": "Venmo", "type": "login", "username": "carlos-mendoza-ep",
     "url": "https://venmo.com", "password": "Franklin-Mtn-77", "starred": True, "notes": "personal"},
    {"key": "debit", "name": "Credit union debit card", "type": "card", "card_number": "4400 1288 7730 5512",
     "cvv": "604", "starred": True},
    {"key": "gym_alarm", "name": "Gym alarm code", "type": "note", "notes": "code 4-1-9-2, panel by the east doors"},
    {"key": "district_id", "name": "District employee ID", "type": "identity", "password": "E-2210847"},
    {"key": "wifi", "name": "Home wifi", "type": "wifi", "password": "lucia-sunflower-7"},
    {"key": "wifi_rudy", "name": "Rudy's wifi", "type": "wifi", "password": "garza-yard-2020"},
    {"key": "door_code", "name": "Classroom door code", "type": "password", "password": "3141"},
    {"key": "server_key", "name": "Home server key", "type": "ssh_key", "notes": "photo backup box"},
    {"key": "hudl", "name": "Hudl API key", "type": "api_credential", "notes": "game film uploads"},
    {"key": "passport", "name": "US passport", "type": "passport", "notes": "renew by 2028"},
    {"key": "savings", "name": "Credit union savings", "type": "bank_account", "notes": "personal"},
    {"key": "license", "name": "Texas driver license", "type": "driving_licence", "notes": "expires 2029"},
    {"key": "maxpreps", "name": "MaxPreps Pro", "type": "software_licence", "notes": "team stats"},
    {"key": "coinbase", "name": "Coinbase wallet", "type": "crypto_wallet", "notes": "tiny, from 2021"},
    {"key": "sams", "name": "Sam's Club membership", "type": "membership", "notes": "union discount"},
    {"key": "aft_card", "name": "Union membership card", "type": "membership", "notes": "union"},
    {"key": "birth_certs", "name": "Kids birth certificates", "type": "document", "notes": "safe in the closet"},
    {"key": "old_yahoo", "name": "Old Yahoo mail", "type": "login", "username": "cmendoza79",
     "url": "https://mail.yahoo.com", "password": "Juarez-79", "trashed": "2026-09-01T09:00"},
    {"key": "old_godaddy", "name": "GoDaddy team site", "type": "login", "username": "coachmendoza",
     "url": "https://godaddy.com", "password": "Hoops-2019", "trashed": "2026-06-15T09:00"},
]

LINKS = [
    {"from": "garage_door", "to": "elena"},
    {"from": "jerseys", "to": "ray"},
    {"from": "sizes", "to": "marcus"},
    {"from": "sizes", "to": "andre"},
    {"from": "jersey_money", "to": "patty"},
    {"from": "roster", "to": "ray"},
    {"from": "physicals", "to": "linda"},
    {"from": "email_parents", "to": "patty"},
    {"from": "email_parents", "to": "yvonne"},
    {"from": "grade_tests", "to": "jessica"},
    {"from": "trip_plan", "to": "jessica"},
    {"from": "chaperones", "to": "veronica"},
    {"from": "read_proposal", "to": "david_s"},
    {"from": "survey", "to": "kim"},
    {"from": "mow_1", "to": "barbara"},
    {"from": "mow_2", "to": "barbara"},
    {"from": "invoice_soto", "to": "javier"},
    {"from": "castillo_quote", "to": "yvonne"},
    {"from": "mulch", "to": "rudy"},
    {"from": "call_ama", "to": "rosa"},
    {"from": "anniv_plan", "to": "elena"},
    {"from": "party", "to": "lucia"},
    {"from": "cake", "to": "lucia"},
    {"from": "mateo_bike", "to": "mateo"},
    {"from": "ft_note", "to": "marcus"},
    {"from": "zone", "to": "andre"},
    {"from": "drills", "to": "ray"},
    {"from": "practice_plan", "to": "ray"},
    {"from": "proposal_notes", "to": "david_s"},
    {"from": "proposal_notes", "to": "tom"},
    {"from": "survey_qs", "to": "kim"},
    {"from": "whitfield_note", "to": "barbara"},
    {"from": "soto_note", "to": "javier"},
    {"from": "soto_note", "to": "rudy"},
    {"from": "caldo", "to": "rosa"},
    {"from": "enchiladas", "to": "elena"},
    {"from": "gift_elena", "to": "elena"},
    {"from": "party_list", "to": "lucia"},
    {"from": "party_list", "to": "marisol"},
    {"from": "vb_sched", "to": "sofia"},
    {"from": "banquet_ideas", "to": "patty"},
    {"from": "banquet_ideas", "to": "yvonne"},
    {"from": "banquet_ideas", "to": "david_r"},
]


def world():
    return {
        "me": "Carlos Mendoza",
        "epoch": "2023-01-01T09:00",
        "seed": "T24",
        "currency": "USD",
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
    out = HERE / "T24.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
