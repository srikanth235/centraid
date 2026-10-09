"""World T07: Maria Ines Quispe, agronomist in Cusco running a family potato cooperative (PEN vault).

    python3 authored/worlds/T07_build.py      # writes authored/worlds/T07.json (deterministic)

Today in the sessions is Thursday 2026-03-12 12:30 (rainy season, blight scouting, loan paperwork
for the coop, Holy Week coming up with the choir, daughter Valeria at university in Lima).
Built-in ambiguity: two Rosas (Rosa Mamani, coop treasurer; Rosa Condori, choir alto), nicknames
(Mama Juana, Lucho, Padre Alfredo, Hermana Lucia), a hard-to-spell name (Ccahuana), two "Meeting
with Agrobanco" events, two "Seed order" notes, two "Buy fungicide" tasks, a run of monthly rent
and coop-dues tasks, weekly rehearsals and scouting rounds, cancelled events, completed tasks, and
trashed rows both inside and past the 30-day restore window.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        {"key": "julio", "name": "Julio Huaman", "role": "husband", "starred": True, "cadence": 1,
         "last_contacted": "2026-03-12T07:00", "last_contacted_kind": "visit", "met": "Universidad San Antonio Abad"},
        {"key": "valeria", "name": "Valeria Huaman Quispe", "role": "daughter, agronomy student at La Molina",
         "nickname": "Vale", "starred": True, "cadence": 7,
         "last_contacted": "2026-03-08T20:30", "last_contacted_kind": "call", "met": "Cusco"},
        {"key": "juana", "name": "Juana Ramos", "role": "mother", "nickname": "Mama Juana", "cadence": 3,
         "last_contacted": "2026-03-10T17:00", "last_contacted_kind": "visit", "met": "Cusco"},
        {"key": "luis", "name": "Luis Quispe", "role": "brother", "nickname": "Lucho", "cadence": 14,
         "last_contacted": "2026-02-22T13:00", "last_contacted_kind": "visit", "met": "Cusco"},
        {"key": "carla", "name": "Carla Quispe", "role": "sister in Arequipa", "cadence": 14,
         "last_contacted": "2026-03-10T20:00", "last_contacted_kind": "call", "met": "Cusco"},
        {"key": "diego", "name": "Diego Huaman", "role": "nephew"},
        {"key": "camila", "name": "Camila Soto", "role": "Valeria's roommate", "met": "Lima, February 2026",
         "last_contacted": "2026-02-01T12:00", "last_contacted_kind": "message"},
        # coop
        {"key": "teodoro", "name": "Teodoro Apaza", "role": "coop president", "cadence": 7, "starred": True,
         "last_contacted": "2026-03-11T18:00", "last_contacted_kind": "call", "met": "Coop assembly"},
        {"key": "rosa_m", "name": "Rosa Mamani", "role": "coop treasurer", "cadence": 14,
         "last_contacted": "2026-03-05T12:00", "last_contacted_kind": "visit", "met": "Coop assembly"},
        {"key": "efrain", "name": "Efrain Ccahuana", "role": "field hand, coop member", "cadence": 7,
         "last_contacted": "2026-03-09T10:00", "last_contacted_kind": "visit", "met": "Coop assembly"},
        {"key": "wilber", "name": "Wilber Yupanqui", "role": "coop member, pump owner", "cadence": 30,
         "last_contacted": "2026-03-02T16:00", "last_contacted_kind": "message", "met": "Coop assembly"},
        {"key": "nilda", "name": "Nilda Choque", "role": "coop member, Pisac stall", "cadence": 30,
         "last_contacted": "2026-02-14T13:00", "last_contacted_kind": "visit", "met": "Pisac market"},
        {"key": "fortunata", "name": "Fortunata Sutta", "role": "coop member", "met": "Pisac market",
         "last_contacted": "2026-01-10T13:00", "last_contacted_kind": "visit"},
        # choir
        {"key": "rosa_c", "name": "Rosa Condori", "role": "choir alto", "cadence": 7,
         "last_contacted": "2026-03-11T21:00", "last_contacted_kind": "message", "met": "San Blas choir"},
        {"key": "lucia", "name": "Lucia Paz", "role": "choir director", "nickname": "Hermana Lucia", "cadence": 7,
         "last_contacted": "2026-03-11T21:10", "last_contacted_kind": "visit", "met": "San Blas choir"},
        {"key": "jaime", "name": "Jaime Torres", "role": "choir tenor",
         "last_contacted": "2026-03-08T10:00", "last_contacted_kind": "message", "met": "San Blas choir"},
        {"key": "carmen", "name": "Carmen Rojas", "role": "choir soprano", "met": "San Blas choir",
         "last_contacted": "2026-03-04T19:00", "last_contacted_kind": "visit"},
        {"key": "alfredo", "name": "Alfredo Salas", "role": "parish priest", "nickname": "Padre Alfredo",
         "last_contacted": "2026-03-08T09:40", "last_contacted_kind": "visit"},
        # work
        {"key": "hugo", "name": "Hugo Cardenas", "role": "INIA potato researcher", "cadence": 21, "starred": True,
         "last_contacted": "2026-02-26T12:00", "last_contacted_kind": "visit", "met": "INIA Andenes"},
        {"key": "patricia", "name": "Patricia Luna", "role": "Agrobanco loan officer",
         "last_contacted": "2026-03-05T11:00", "last_contacted_kind": "visit"},
        {"key": "marco", "name": "Marco Villena", "role": "buyer, Lima supermarket chain", "cadence": 14,
         "last_contacted": "2026-02-27T15:00", "last_contacted_kind": "call", "met": "Expo Papa 2025"},
        {"key": "sonia", "name": "Sonia Flores", "role": "seed potato supplier",
         "last_contacted": "2026-03-10T17:00", "last_contacted_kind": "visit", "met": "Seed fair in Pisac"},
        {"key": "raul", "name": "Raul Tito", "role": "truck driver",
         "last_contacted": "2026-01-15T09:00", "last_contacted_kind": "call"},
        {"key": "gabriel", "name": "Gabriel Pinto", "role": "mechanic, Pinto's garage"},
        {"key": "elena", "name": "Elena Vargas", "role": "dentist"},
        {"key": "ana", "name": "Ana Mamani", "role": "neighbour", "cadence": 30,
         "last_contacted": "2025-12-24T20:00", "last_contacted_kind": "visit"},
        {"key": "oscar", "name": "Oscar Huillca", "role": "old seed dealer", "trashed": "2026-03-03T10:00"},
        {"key": "benito", "name": "Benito Quispe", "role": "cousin, moved to Chile"},
    ]


GROUPS = [
    {"key": "coop_g", "name": "Papa Andina coop", "members": ["rosa_m", "efrain", "wilber", "nilda", "teodoro", "fortunata"],
     "created": "2024-04-10T10:00"},
    {"key": "choir_g", "name": "San Blas choir", "members": ["rosa_c", "lucia", "jaime", "carmen", "alfredo"],
     "created": "2025-02-01T19:00"},
    {"key": "family_g", "name": "Valeria's Lima costs", "members": ["julio", "valeria"], "created": "2026-01-20T20:00"},
    {"key": "quito_g", "name": "Quito congress trip", "currency": "USD", "members": ["hugo", "teodoro"],
     "created": "2026-02-18T10:00"},
    {"key": "pisac_g", "name": "Pisac market stall", "members": ["nilda", "fortunata"], "created": "2025-09-01T09:00"},
    {"key": "raffle_g", "name": "Choir raffle fund", "members": ["carmen", "jaime"], "created": "2026-03-01T19:00"},
]

EXPENSES = [
    {"group": "coop_g", "name": "Guano fertilizer", "amount": 1200, "paid_by": "me",
     "split": ["me", "rosa_m", "efrain", "wilber", "nilda", "teodoro"], "date": "2026-02-20"},
    {"group": "coop_g", "name": "Truck rental to Urcos", "amount": 600, "paid_by": "teodoro",
     "split": ["me", "teodoro", "wilber"], "date": "2026-02-27"},
    {"group": "coop_g", "name": "Expo stand fee", "amount": 900, "paid_by": "rosa_m",
     "split": ["me", "rosa_m", "teodoro"], "date": "2026-02-10"},
    {"group": "choir_g", "name": "Robe dry cleaning", "amount": 150, "paid_by": "me",
     "split": ["me", "rosa_c", "lucia"], "date": "2026-02-28"},
    {"group": "choir_g", "name": "Sheet music", "amount": 60, "paid_by": "lucia",
     "split": ["me", "lucia", "jaime"], "date": "2026-02-25"},
    {"group": "family_g", "name": "Room deposit", "amount": 800, "paid_by": "me", "split": ["me", "julio"], "date": "2026-01-25"},
    {"group": "family_g", "name": "Flights to Lima", "amount": 460, "paid_by": "julio", "split": ["me", "julio"], "date": "2026-02-01"},
    {"group": "quito_g", "name": "Hotel in Quito", "amount": 360, "paid_by": "hugo", "split": ["me", "hugo", "teodoro"],
     "date": "2026-02-20"},
    {"group": "pisac_g", "name": "Stall permit", "amount": 80, "paid_by": "nilda", "split": ["me", "nilda"], "date": "2025-09-05"},
]

LISTS = [
    {"key": "farm_l", "name": "Farm", "area": "farm"},
    {"key": "coop_l", "name": "Coop", "area": "coop"},
    {"key": "home_l", "name": "Home", "area": "home"},
    {"key": "choir_l", "name": "Choir", "area": "church"},
    {"key": "vale_l", "name": "Valeria", "area": "family"},
]


def weekly(prefix, name, first, last, start, end, attendees, **extra):
    out, d = [], date.fromisoformat(first)
    while d <= date.fromisoformat(last):
        out.append({"key": f"{prefix}_{d.strftime('%m%d')}", "name": name, "start": f"{d}T{start}",
                    "end": f"{d}T{end}", "attendees": list(attendees), **extra})
        d += timedelta(weeks=1)
    return out


def events():
    out = []
    out += weekly("reh", "Choir rehearsal", "2026-02-04", "2026-04-29", "19:00", "21:00",
                  ["lucia", "rosa_c", "jaime", "carmen"], description="parish hall, San Blas")
    for e in out:
        if e["key"] == "reh_0218":
            e["cancelled"] = "2026-02-16T12:00"
    out += weekly("mass", "Sunday mass with the choir", "2026-03-01", "2026-04-26", "08:00", "09:30", ["alfredo", "lucia"])
    out += weekly("scout", "Blight scouting, lot 3", "2026-02-16", "2026-04-13", "07:00", "10:00", ["efrain"])
    out += weekly("vcall", "Call with Valeria", "2026-02-22", "2026-04-05", "20:00", "20:30", ["valeria"])
    for d in ["2026-01-10", "2026-02-14", "2026-03-14", "2026-04-11"]:
        out.append({"key": f"asm_{d[5:7]}{d[8:]}", "name": "Coop assembly", "start": f"{d}T10:00", "end": f"{d}T13:00",
                    "attendees": ["teodoro", "rosa_m", "efrain", "wilber", "nilda"], "description": "community hall, Huasao"})
    out += [
        {"key": "agro_0305", "name": "Meeting with Agrobanco", "start": "2026-03-05T10:00", "end": "2026-03-05T11:00",
         "attendees": ["patricia"]},
        {"key": "agro_0319", "name": "Meeting with Agrobanco", "start": "2026-03-19T10:00", "end": "2026-03-19T11:00",
         "attendees": ["patricia", "teodoro"], "description": "bring the loan folder"},
        {"key": "dentist", "name": "Dentist appointment", "start": "2026-03-17T16:00", "end": "2026-03-17T16:45",
         "attendees": ["elena"]},
        {"key": "inia_day", "name": "INIA field day at Andenes", "start": "2026-03-20T08:00", "end": "2026-03-20T14:00",
         "attendees": ["hugo"], "description": "bring soil samples from lot 3"},
        {"key": "seed_delivery", "name": "Seed delivery from Sonia", "start": "2026-03-13T09:00", "end": "2026-03-13T10:00",
         "attendees": ["sonia"]},
        {"key": "land_tax", "name": "Pay land tax at the municipality", "start": "2026-03-13T11:00", "end": "2026-03-13T11:30"},
        {"key": "marco_call", "name": "Video call with Marco", "start": "2026-03-12T16:00", "end": "2026-03-12T16:30",
         "attendees": ["marco"]},
        {"key": "carla_call", "name": "Call with Carla", "start": "2026-03-10T20:00", "end": "2026-03-10T20:30",
         "attendees": ["carla"]},
        {"key": "mechanic", "name": "Truck service at Pinto's garage", "start": "2026-03-16T14:00", "end": "2026-03-16T15:00",
         "attendees": ["gabriel"]},
        {"key": "clinic", "name": "Take Mama Juana to the clinic", "start": "2026-03-18T09:00", "end": "2026-03-18T10:30",
         "attendees": ["juana"]},
        {"key": "julio_bday", "name": "Julio's birthday dinner", "start": "2026-03-21T19:30", "end": "2026-03-21T22:00",
         "attendees": ["julio", "juana", "luis"], "description": "Pachapapa, San Blas"},
        {"key": "expo", "name": "Expo Papa Lima", "start": "2026-03-26T09:00", "end": "2026-03-28T18:00",
         "attendees": ["marco", "teodoro"], "description": "stand 14, pavilion B"},
        {"key": "palm", "name": "Palm Sunday procession", "start": "2026-03-29T10:00", "end": "2026-03-29T12:00",
         "attendees": ["alfredo"]},
        {"key": "raffle_draw", "name": "Choir raffle draw", "start": "2026-03-31T19:00", "end": "2026-03-31T20:00",
         "attendees": ["carmen", "jaime"]},
        {"key": "airport", "name": "Pick up Valeria at the airport", "start": "2026-04-01T14:00", "end": "2026-04-01T15:30",
         "attendees": ["valeria"]},
        {"key": "concert", "name": "Holy Thursday concert", "start": "2026-04-02T19:00", "end": "2026-04-02T21:00",
         "attendees": ["lucia", "rosa_c", "jaime", "carmen", "alfredo"]},
        {"key": "marco_visit", "name": "Marco's visit to the plots", "start": "2026-04-17T09:00", "end": "2026-04-17T12:00",
         "attendees": ["marco", "efrain"]},
        {"key": "harvest", "name": "Harvest start, lot 3", "start": "2026-04-20T06:00", "end": "2026-04-20T12:00",
         "attendees": ["efrain", "wilber", "raul"]},
        {"key": "truck", "name": "Truck to Lima market", "start": "2026-04-24T05:00", "end": "2026-04-24T07:00",
         "attendees": ["raul"]},
        {"key": "quito", "name": "INIA potato congress in Quito", "start": "2026-05-12T08:00", "end": "2026-05-14T18:00",
         "attendees": ["hugo", "teodoro"]},
        {"key": "soil", "name": "Soil sampling with Hugo", "start": "2026-02-26T08:00", "end": "2026-02-26T12:00",
         "attendees": ["hugo"]},
        {"key": "pisac_fair", "name": "Seed fair in Pisac", "start": "2026-03-07T09:00", "end": "2026-03-07T13:00",
         "attendees": ["sonia", "nilda"], "cancelled": "2026-03-04T18:00"},
        {"key": "carla_lunch", "name": "Lunch with Carla", "start": "2026-03-22T13:00", "end": "2026-03-22T15:00",
         "attendees": ["carla"], "trashed": "2026-03-09T20:00"},
    ]
    return out


def tasks():
    t = [
        # Valeria
        {"key": "rent_jan", "name": "Pay Valeria's rent", "due": "2026-01-05", "completed": "2026-01-04T19:00", "list": "vale_l"},
        {"key": "rent_feb", "name": "Pay Valeria's rent", "due": "2026-02-05", "completed": "2026-02-05T08:00", "list": "vale_l"},
        {"key": "rent_mar", "name": "Pay Valeria's rent", "due": "2026-03-15", "list": "vale_l", "priority": 1},
        {"key": "vale_box", "name": "Send Valeria a box of chuno", "due": "2026-03-20", "list": "vale_l", "effort": 30},
        {"key": "vale_fees", "name": "Pay Valeria's tuition", "due": "2026-03-31", "list": "vale_l", "priority": 1},
        {"key": "vale_laptop", "name": "Look for a laptop for Valeria", "list": "vale_l", "effort": 60},
        # farm
        {"key": "fung_1", "name": "Buy fungicide", "due": "2026-03-13", "list": "farm_l", "priority": 2, "effort": 30,
         "description": "mancozeb, 4 kg"},
        {"key": "fung_2", "name": "Buy fungicide", "due": "2026-02-20", "completed": "2026-02-19T11:00", "list": "farm_l"},
        {"key": "scout_report", "name": "Write blight scouting report", "due": "2026-03-16", "effort": 90, "list": "farm_l",
         "priority": 2, "description": "lot 3 and lot 5, photos of lesions"},
        {"key": "ferti", "name": "Order guano fertilizer", "due": "2026-04-10", "list": "farm_l", "effort": 30},
        {"key": "trial_data", "name": "Enter trial data into the spreadsheet", "due": "2026-03-19", "effort": 180,
         "list": "farm_l", "priority": 3},
        {"key": "irrigation", "name": "Check the irrigation channel", "due": "2026-03-14", "effort": 60, "list": "farm_l"},
        {"key": "storehouse", "name": "Clean out the storehouse", "due": "2026-04-05", "effort": 240, "list": "farm_l"},
        {"key": "sacks", "name": "Buy harvest sacks", "due": "2026-04-15", "list": "farm_l", "effort": 30},
        {"key": "seedlings", "name": "Water the greenhouse seedlings", "completed": "2026-03-11T07:30", "list": "farm_l"},
        {"key": "hugo_email", "name": "Email Hugo the trial plan", "due": "2026-03-16", "effort": 20},
        {"key": "bulletin", "name": "Read the INIA bulletin on native varieties", "effort": 60},
        # coop
        {"key": "seed_pay", "name": "Pay Sonia for the seed potatoes", "due": "2026-03-13", "priority": 2, "list": "coop_l"},
        {"key": "agro_docs", "name": "Gather documents for the Agrobanco loan", "due": "2026-03-18", "priority": 1,
         "effort": 120, "status": "in_progress", "list": "coop_l", "description": "Patricia's checklist from the 5th"},
        {"key": "agro_ruc", "name": "Print the RUC certificate", "parent": "agro_docs", "completed": "2026-03-06T10:00"},
        {"key": "agro_bank", "name": "Get bank statements", "parent": "agro_docs", "due": "2026-03-17"},
        {"key": "agro_title", "name": "Copy of the land title", "parent": "agro_docs", "due": "2026-03-17"},
        {"key": "agenda", "name": "Draft the assembly agenda", "due": "2026-03-13", "effort": 60, "list": "coop_l"},
        {"key": "minutes", "name": "Send the February minutes", "completed": "2026-02-20T21:00", "list": "coop_l"},
        {"key": "scale", "name": "Fix the weighing scale", "due": "2026-03-25", "effort": 45, "list": "coop_l"},
        {"key": "expo_stand", "name": "Book the stand at Expo Papa", "completed": "2026-02-10T12:00", "list": "coop_l"},
        {"key": "expo_samples", "name": "Pack tuber samples for the Expo", "due": "2026-03-24", "effort": 120,
         "list": "coop_l", "priority": 2, "description": "12 varieties, label each bag"},
        {"key": "expo_banner", "name": "Print the coop banner", "due": "2026-03-20", "list": "coop_l", "effort": 30},
        {"key": "truck_book", "name": "Book Raul's truck for April", "due": "2026-03-25", "list": "coop_l"},
        {"key": "member_list", "name": "Update the coop member list", "due": "2026-03-27", "list": "coop_l", "priority": 4},
        {"key": "print_photos", "name": "Print harvest photos for the coop", "completed": "2025-07-10T16:00", "list": "coop_l"},
        # choir
        {"key": "scores", "name": "Photocopy the Holy Week scores", "due": "2026-03-24", "list": "choir_l", "effort": 30},
        {"key": "robes", "name": "Wash the choir robes", "due": "2026-03-28", "list": "choir_l", "effort": 60},
        {"key": "tickets", "name": "Sell raffle tickets", "due": "2026-03-31", "status": "in_progress", "list": "choir_l"},
        {"key": "alto_line", "name": "Learn the alto line for Psalm 22", "due": "2026-03-31", "list": "choir_l", "effort": 30,
         "priority": 3},
        # home
        {"key": "gas", "name": "Refill the gas cylinder", "due": "2026-03-12", "list": "home_l", "effort": 15},
        {"key": "roof", "name": "Fix the leaking roof", "status": "in_progress", "list": "home_l", "priority": 2,
         "description": "corner over the storeroom"},
        {"key": "water_bill", "name": "Pay the water bill", "due": "2026-03-20", "list": "home_l"},
        {"key": "elec_bill", "name": "Pay the electricity bill", "completed": "2026-03-02T09:00", "list": "home_l"},
        {"key": "mama_pills", "name": "Buy Mama Juana's pills", "due": "2026-03-14", "list": "home_l", "effort": 15},
        # personal
        {"key": "sunat", "name": "File the SUNAT tax return", "due": "2026-03-31", "priority": 1, "effort": 120,
         "description": "annual income tax, farm receipts in the tax folder"},
        {"key": "dentist_confirm", "name": "Call the dentist to confirm", "completed": "2026-03-10T09:00"},
        {"key": "insurance", "name": "Renew crop insurance", "due": "2026-04-30", "priority": 2},
        {"key": "julio_gift", "name": "Buy Julio's birthday present", "due": "2026-03-20"},
        {"key": "carla_card", "name": "Send Carla a birthday card", "status": "cancelled", "due": "2026-02-28"},
        # trashed
        {"key": "poster", "name": "Design the raffle poster", "list": "choir_l", "trashed": "2026-03-06T10:00"},
        {"key": "manure", "name": "Ask about llama manure", "trashed": "2026-03-08T18:00"},
        {"key": "senasa", "name": "Renew the SENASA certificate", "trashed": "2026-01-20T10:00"},
    ]
    # coop dues, monthly on the last day: history plus this month's
    for m, d in [(10, "2025-10-31"), (11, "2025-11-30"), (12, "2025-12-31"), (1, "2026-01-31"), (2, "2026-02-28")]:
        t.append({"key": f"dues_{m:02d}", "name": "Pay coop dues", "due": d, "completed": f"{d}T18:00", "list": "coop_l"})
    t.append({"key": "dues_03", "name": "Pay coop dues", "due": "2026-03-31", "list": "coop_l"})
    return t


NOTEBOOKS = [
    {"key": "field_nb", "name": "Field notes"},
    {"key": "coop_nb", "name": "Coop"},
    {"key": "choir_nb", "name": "Choir"},
    {"key": "recipes_nb", "name": "Recipes"},
    {"key": "vale_nb", "name": "Valeria"},
]

NOTES = [
    {"key": "seed_2025", "name": "Seed order", "body": "Yungay 20 sacks, Canchan 15, Peruanita 5 from Sonia",
     "notebook": "coop_nb", "created": "2025-09-20T19:00"},
    {"key": "seed_2026", "name": "Seed order", "body": "Canchan 25 sacks, Unica 10, Amarilla Tumbay 6; Sonia wants half up front",
     "notebook": "field_nb", "created": "2026-03-02T21:00"},
    {"key": "blight_log", "name": "Blight log lot 3", "body": "first lesions 16 Feb on the Canchan rows, sprayed 18 Feb and 2 Mar",
     "notebook": "field_nb", "created": "2026-02-16T11:00", "pinned": True},
    {"key": "trial_plan", "name": "Variety trial plan", "body": "8 native varieties, 3 reps, plots of 20 plants, score blight weekly",
     "notebook": "field_nb", "created": "2026-01-15T09:30"},
    {"key": "soil_notes", "name": "Soil test results", "body": "pH 5.4 on lot 3, low phosphorus, organic matter ok",
     "notebook": "field_nb", "created": "2026-03-03T15:20"},
    {"key": "rain", "name": "Rain gauge readings", "body": "Feb total 168 mm, heaviest 23 Feb with 31 mm",
     "notebook": "field_nb", "created": "2026-02-01T07:00"},
    {"key": "natives", "name": "Native varieties list", "body": "Huayro, Peruanita, Qompis, Puka Mama, Wakar Waqra",
     "notebook": "field_nb", "created": "2025-11-10T20:00"},
    {"key": "feb_min", "name": "February assembly minutes", "body": "approved the loan request, dues stay at 20 soles, Nilda to run the Pisac stall",
     "notebook": "coop_nb", "created": "2026-02-14T13:30"},
    {"key": "mar_agenda", "name": "March assembly agenda", "body": "loan update, Expo samples, truck for April, new members",
     "notebook": "coop_nb", "created": "2026-03-10T21:00"},
    {"key": "prices", "name": "Lima market prices", "body": "Canchan 1.40 a kilo, Peruanita 3.20, Huayro 2.80 at Santa Anita",
     "notebook": "coop_nb", "created": "2026-03-09T18:00", "pinned": True},
    {"key": "loan_notes", "name": "Agrobanco loan conditions", "body": "40,000 soles, 18 months, 11% a year, first payment after harvest",
     "notebook": "coop_nb", "created": "2026-03-05T11:15"},
    {"key": "expo_ideas", "name": "Expo stand ideas", "body": "tasting of papa a la huancaina, variety board, photos of the terraces",
     "notebook": "coop_nb", "created": "2026-02-25T20:00"},
    {"key": "repertoire", "name": "Holy Week repertoire", "body": "Psalm 22, Stabat Mater in Quechua, Pange lingua",
     "notebook": "choir_nb", "created": "2026-02-20T21:15", "pinned": True},
    {"key": "seating", "name": "Choir seating", "body": "altos on the left with Rosa, tenors behind, Carmen leads the sopranos",
     "notebook": "choir_nb", "created": "2026-01-28T21:00"},
    {"key": "raffle_notes", "name": "Raffle prizes", "body": "a sheep from Don Teodoro, a woven blanket, two sacks of Peruanita",
     "notebook": "choir_nb", "created": "2026-03-01T20:30"},
    {"key": "chuno", "name": "Chuno soup", "body": "soak the chuno overnight, lamb, mint, a little aji",
     "notebook": "recipes_nb", "created": "2025-06-10T19:00"},
    {"key": "ocopa", "name": "Mama Juana's ocopa", "body": "huacatay, peanuts, aji amarillo, queso fresco, soda crackers",
     "notebook": "recipes_nb", "created": "2025-12-24T11:00"},
    {"key": "huancaina", "name": "Papa a la huancaina", "body": "aji amarillo, queso fresco, evaporated milk, Canchan boiled whole",
     "notebook": "recipes_nb", "created": "2026-01-05T13:00"},
    {"key": "vale_budget", "name": "Valeria's monthly budget", "body": "room 650, food 500, bus 120, books 80",
     "notebook": "vale_nb", "created": "2026-02-28T21:30"},
    {"key": "vale_courses", "name": "Valeria's courses this term", "body": "soil science, plant pathology, statistics, English II",
     "notebook": "vale_nb", "created": "2026-03-08T21:00"},
    {"key": "frost", "name": "Thoughts after the frost", "body": "lost about a third of lot 5; next year plant the bitter varieties up top",
     "created": "2026-02-10T22:00"},
    {"key": "julio_gifts", "name": "Gift ideas for Julio", "body": "a good hat, the Arguedas book, new boots",
     "created": "2026-03-06T21:00"},
    {"key": "hugo_qs", "name": "Things to ask Hugo", "body": "resistant clones for 3800 m, can INIA lend the soil auger",
     "created": "2026-03-11T22:00"},
    {"key": "old_roster", "name": "Old choir roster", "body": "2024 members and phone numbers",
     "notebook": "choir_nb", "created": "2025-08-01T20:00", "trashed": "2026-03-04T21:00"},
    {"key": "old_prices", "name": "2024 seed prices", "body": "Yungay 1.10 a kilo",
     "created": "2024-09-01T20:00", "trashed": "2025-12-20T10:00"},
]

FOLDERS = [
    {"key": "coop_f", "name": "Coop papers"},
    {"key": "loan_f", "name": "Agrobanco loan"},
    {"key": "vale_f", "name": "Valeria"},
    {"key": "house_f", "name": "House"},
    {"key": "trials_f", "name": "Field trials"},
    {"key": "tax_f", "name": "Tax 2025"},
]

DOCUMENTS = [
    {"key": "statutes", "name": "Coop statutes", "folder": "coop_f", "starred": True, "created": "2024-05-02T10:00"},
    {"key": "register", "name": "Coop member register", "folder": "coop_f", "created": "2026-01-12T10:00"},
    {"key": "min_doc", "name": "Signed February minutes", "folder": "coop_f", "created": "2026-02-15T09:00"},
    {"key": "expo_contract", "name": "Expo Papa stand contract", "folder": "coop_f", "created": "2026-02-10T12:30"},
    {"key": "loan_app", "name": "Loan application form", "folder": "loan_f", "created": "2026-03-05T12:00"},
    {"key": "repay", "name": "Repayment schedule draft", "folder": "loan_f", "created": "2026-03-06T16:00"},
    {"key": "title", "name": "Land title lot 3", "folder": "loan_f", "starred": True, "created": "2019-08-14T10:00"},
    {"key": "enrol", "name": "Valeria's enrolment certificate", "folder": "vale_f", "created": "2026-03-02T10:00"},
    {"key": "lease", "name": "Valeria's room lease", "folder": "vale_f", "created": "2026-02-01T10:00"},
    {"key": "grades", "name": "Valeria's grades 2025", "folder": "vale_f", "created": "2026-01-20T10:00"},
    {"key": "water_doc", "name": "Water bill February", "folder": "house_f", "created": "2026-03-03T09:00"},
    {"key": "elec_doc", "name": "Electricity bill February", "folder": "house_f", "created": "2026-03-01T09:00"},
    {"key": "deed", "name": "House deed", "folder": "house_f", "created": "2010-05-20T10:00"},
    {"key": "protocol", "name": "Variety trial protocol", "folder": "trials_f", "created": "2026-01-15T10:00"},
    {"key": "inia_rep", "name": "INIA blight report 2025", "folder": "trials_f", "starred": True, "created": "2025-11-30T10:00"},
    {"key": "soil_pdf", "name": "Soil lab results", "folder": "trials_f", "created": "2026-03-03T15:00"},
    {"key": "dni_scan", "name": "DNI scan", "created": "2023-04-10T10:00"},
    {"key": "seed_receipt", "name": "Seed receipt from Sonia", "created": "2026-03-10T17:00"},
    {"key": "old_pricelist", "name": "Old price list", "created": "2025-10-01T10:00", "trashed": "2026-03-07T10:00"},
]

ALBUMS = [
    {"key": "harvest_al", "name": "Harvest 2025"},
    {"key": "choir_al", "name": "Choir"},
    {"key": "vale_al", "name": "Valeria in Lima"},
    {"key": "trials_al", "name": "Field trials"},
    {"key": "family_al", "name": "Family"},
    {"key": "expo_al", "name": "Expo 2025"},
]

PHOTOS = [
    {"key": "h_dig", "name": "Digging the Canchan rows", "taken": "2025-05-12T09:00", "albums": ["harvest_al"], "people": ["efrain"]},
    {"key": "h_sacks", "name": "Sacks by the road", "taken": "2025-05-14T15:00", "albums": ["harvest_al"]},
    {"key": "h_truck", "name": "Loading Raul's truck", "taken": "2025-05-20T06:30", "albums": ["harvest_al"], "people": ["raul"]},
    {"key": "h_huayro", "name": "Huayro close-up", "taken": "2025-05-22T11:00", "albums": ["harvest_al", "trials_al"], "starred": True},
    {"key": "h_pachamanca", "name": "Harvest pachamanca", "taken": "2025-06-01T14:00", "albums": ["harvest_al", "family_al"],
     "people": ["julio", "juana", "luis"]},
    {"key": "h_vale", "name": "Valeria at the harvest", "taken": "2025-06-02T10:00", "albums": ["harvest_al", "family_al", "vale_al"],
     "people": ["valeria"], "starred": True},
    {"key": "c_xmas", "name": "Christmas concert", "taken": "2025-12-24T21:00", "albums": ["choir_al", "family_al"],
     "people": ["juana", "lucia", "rosa_c"], "starred": True},
    {"key": "c_reh", "name": "Rehearsal in the parish hall", "taken": "2026-02-11T20:00", "albums": ["choir_al"],
     "people": ["lucia", "jaime", "carmen"]},
    {"key": "c_robes", "name": "New robes", "taken": "2026-02-28T12:00", "albums": ["choir_al"], "people": ["rosa_c"]},
    {"key": "c_palm", "name": "Palm Sunday 2025", "taken": "2025-04-13T10:30", "albums": ["choir_al"], "people": ["alfredo"]},
    {"key": "v_campus", "name": "Valeria on campus", "taken": "2026-02-28T13:00", "albums": ["vale_al"], "people": ["valeria"]},
    {"key": "v_room", "name": "Valeria's new room", "taken": "2026-02-02T17:00", "albums": ["vale_al"], "people": ["valeria", "camila"]},
    {"key": "v_beach", "name": "Miraflores boardwalk", "taken": "2026-02-03T18:30", "albums": ["vale_al"], "people": ["valeria", "julio"]},
    {"key": "v_lab", "name": "Valeria in the soil lab", "taken": "2026-03-06T11:00", "albums": ["vale_al"], "people": ["valeria"]},
    {"key": "t_plots", "name": "Trial plots after planting", "taken": "2026-01-20T10:00", "albums": ["trials_al"]},
    {"key": "t_lesion", "name": "Blight lesions on Canchan", "taken": "2026-02-16T09:00", "albums": ["trials_al"], "starred": True},
    {"key": "t_spray", "name": "Spraying lot 3", "taken": "2026-03-02T08:00", "albums": ["trials_al"], "people": ["efrain"]},
    {"key": "t_hugo", "name": "Hugo with the soil auger", "taken": "2026-02-26T10:30", "albums": ["trials_al"], "people": ["hugo"]},
    {"key": "t_flowers", "name": "Flowering Peruanita", "taken": "2026-03-09T11:00", "albums": ["trials_al"]},
    {"key": "f_bday", "name": "Julio's birthday 2025", "taken": "2025-03-21T21:00", "albums": ["family_al"],
     "people": ["julio", "juana", "luis", "carla"]},
    {"key": "f_mama", "name": "Mama Juana's garden", "taken": "2025-10-05T16:00", "albums": ["family_al"], "people": ["juana"]},
    {"key": "f_carla", "name": "Carla's visit", "taken": "2026-01-02T13:00", "albums": ["family_al"], "people": ["carla", "diego"]},
    {"key": "e_stand", "name": "Our stand at Expo 2025", "taken": "2025-03-27T10:00", "albums": ["expo_al"],
     "people": ["teodoro", "rosa_m"]},
    {"key": "e_ribbon", "name": "Second prize ribbon", "taken": "2025-03-28T17:00", "albums": ["expo_al", "harvest_al"], "starred": True},
    {"key": "frost_pic", "name": "Frost on lot 5", "taken": "2026-02-10T06:40"},
    {"key": "tyres", "name": "New truck tyres", "taken": "2026-01-28T12:00"},
    {"key": "rainbow", "name": "Rainbow over Huasao", "taken": "2026-03-01T17:30", "starred": True},
    {"key": "meeting_pic", "name": "Assembly in the community hall", "taken": "2026-02-14T11:00",
     "people": ["teodoro", "rosa_m", "nilda", "wilber"]},
    {"key": "receipt_pic", "name": "Photo of the seed receipt", "taken": "2026-03-10T17:05"},
    {"key": "sunset", "name": "Sunset from the terraces", "taken": "2026-03-11T18:10"},
    {"key": "blurry", "name": "Blurry lesion close-up", "taken": "2026-03-09T11:05", "albums": ["trials_al"],
     "trashed": "2026-03-10T08:00"},
    {"key": "dup_stand", "name": "Duplicate of the stand photo", "taken": "2025-03-27T10:01", "trashed": "2026-03-02T09:00"},
    {"key": "bus_ticket", "name": "Screenshot of the bus ticket", "taken": "2026-01-10T08:00", "trashed": "2026-01-15T09:00"},
]

DEBTS = [
    {"key": "d_rosa", "person": "rosa_m", "direction": "owes_me", "amount": 120, "name": "Fertilizer share", "date": "2026-02-20"},
    {"key": "d_wilber", "person": "wilber", "direction": "i_owe", "amount": 45, "name": "Diesel for the pump", "date": "2026-03-02"},
    {"key": "d_luis", "person": "luis", "direction": "owes_me", "amount": 300, "name": "Tractor part", "date": "2025-11-15"},
    {"key": "d_carla", "person": "carla", "direction": "i_owe", "amount": 80, "name": "Mama Juana's glasses", "date": "2026-01-25"},
    {"key": "d_jaime", "person": "jaime", "direction": "owes_me", "amount": 25, "name": "Raffle ticket money", "date": "2026-03-08"},
    {"key": "d_carmen", "person": "carmen", "direction": "owes_me", "amount": 15, "name": "Robe cleaning share", "date": "2026-03-04"},
    {"key": "d_efrain", "person": "efrain", "direction": "i_owe", "amount": 60, "name": "Day wages for scouting", "date": "2026-03-09T18:00"},
    {"key": "d_sonia", "person": "sonia", "direction": "i_owe", "amount": 350, "name": "Seed potatoes balance", "date": "2026-03-10T17:00"},
    {"key": "d_nilda", "person": "nilda", "direction": "owes_me", "amount": 30, "name": "Bus fare to Urubamba", "date": "2026-02-12",
     "settled": "2026-02-20T10:00"},
    {"key": "d_raul", "person": "raul", "direction": "i_owe", "amount": 200, "name": "Truck deposit", "date": "2026-01-15",
     "settled": "2026-01-20T10:00"},
    {"key": "d_teodoro", "person": "teodoro", "direction": "owes_me", "amount": 50, "name": "Assembly lunch", "date": "2026-02-14"},
    {"key": "d_lucia", "person": "lucia", "direction": "i_owe", "amount": 20, "name": "Sheet music copies", "date": "2026-02-25"},
    {"key": "d_hugo", "person": "hugo", "direction": "i_owe", "amount": 90, "name": "Lab fee share", "date": "2026-03-03"},
]

LOCKER = [
    {"key": "agro_login", "name": "Agrobanco online banking", "type": "login", "username": "mquispe",
     "url": "https://www.agrobanco.com.pe", "password": "Papa-Andina-40k"},
    {"key": "sunat_login", "name": "SUNAT Clave SOL", "type": "login", "username": "10412345678",
     "url": "https://www.sunat.gob.pe", "password": "clavesol2026", "starred": True},
    {"key": "gmail", "name": "Gmail", "type": "login", "username": "maria.quispe.agro@gmail.com",
     "url": "https://mail.google.com", "password": "huayro-rojo-77"},
    {"key": "bcp_card", "name": "BCP debit card", "type": "card", "card_number": "4557 8812 0034 5519", "cvv": "318", "starred": True},
    {"key": "visa", "name": "Interbank Visa", "type": "card", "card_number": "4213 5500 9981 2270", "cvv": "644"},
    {"key": "padlock", "name": "Storehouse padlock code", "type": "note", "notes": "2718, the blue padlock on the back door"},
    {"key": "dni", "name": "DNI", "type": "identity", "password": "41234567"},
    {"key": "wifi", "name": "Home wifi", "type": "wifi", "password": "chacra-huasao-58"},
    {"key": "laptop_pw", "name": "Coop laptop password", "type": "password", "password": "Canchan#2026"},
    {"key": "station_ssh", "name": "Weather station SSH key", "type": "ssh_key", "notes": "raspberry pi at lot 3",
     "password": "ssh-ed25519 AAAAC3Nz-lot3-station"},
    {"key": "weather_api", "name": "Weather API key", "type": "api_credential", "notes": "senamhi data pull", "password": "wx-7c1f-huasao"},
    {"key": "passport", "name": "Passport", "type": "passport", "notes": "expires 2029, needed for Quito"},
    {"key": "bcp_savings", "name": "BCP savings account", "type": "bank_account", "notes": "account 285-1234567-0-44, coop savings"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence", "notes": "A-IIb, expires 2027"},
    {"key": "office", "name": "Office 365 licence", "type": "software_licence", "code": "O365-QX77-2026", "notes": "family plan"},
    {"key": "wallet", "name": "Old Binance wallet", "type": "crypto_wallet", "notes": "a little USDT from Benito, seed phrase in the safe"},
    {"key": "cip", "name": "Colegio de Ingenieros membership", "type": "membership", "notes": "CIP 98231, fees paid to June"},
    {"key": "senasa_cert", "name": "SENASA producer certificate", "type": "document", "notes": "certificate 0417-CU"},
    {"key": "movistar", "name": "Old Movistar login", "type": "login", "username": "mquispe77", "url": "https://mi.movistar.pe",
     "password": "movi1234", "trashed": "2026-03-03T09:00"},
    {"key": "bbva_card", "name": "Old BBVA card", "type": "card", "card_number": "4919 1100 2233 4455", "cvv": "901",
     "trashed": "2026-01-05T09:00"},
]

LINKS = [
    {"from": "vale_box", "to": "valeria"},
    {"from": "vale_fees", "to": "valeria"},
    {"from": "vale_laptop", "to": "valeria"},
    {"from": "rent_mar", "to": "valeria"},
    {"from": "hugo_email", "to": "hugo"},
    {"from": "trial_data", "to": "hugo"},
    {"from": "seed_pay", "to": "sonia"},
    {"from": "agro_docs", "to": "patricia"},
    {"from": "agenda", "to": "teodoro"},
    {"from": "expo_samples", "to": "teodoro"},
    {"from": "expo_samples", "to": "rosa_m"},
    {"from": "truck_book", "to": "raul"},
    {"from": "scores", "to": "lucia"},
    {"from": "tickets", "to": "carmen"},
    {"from": "mama_pills", "to": "juana"},
    {"from": "julio_gift", "to": "julio"},
    {"from": "scale", "to": "wilber"},
    {"from": "irrigation", "to": "efrain"},
    {"from": "scout_report", "to": "efrain"},
    {"from": "trial_plan", "to": "hugo"},
    {"from": "loan_notes", "to": "patricia"},
    {"from": "raffle_notes", "to": "carmen"},
    {"from": "ocopa", "to": "juana"},
    {"from": "vale_budget", "to": "valeria"},
    {"from": "vale_courses", "to": "valeria"},
    {"from": "julio_gifts", "to": "julio"},
    {"from": "hugo_qs", "to": "hugo"},
    {"from": "seed_2026", "to": "sonia"},
    {"from": "seed_2025", "to": "sonia"},
    {"from": "prices", "to": "marco"},
    {"from": "feb_min", "to": "teodoro"},
    {"from": "feb_min", "to": "rosa_m"},
]


def world():
    return {
        "me": "Maria Ines Quispe",
        "epoch": "2024-04-01T09:00",
        "seed": "T07",
        "currency": "PEN",
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
    spans = sorted((datetime.fromisoformat(e["start"]), datetime.fromisoformat(e["end"]), e["key"]) for e in evs)
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
    allkeys = [r["key"] for sec in w.values() if isinstance(sec, list) for r in sec if isinstance(r, dict) and "key" in r]
    dup = {k for k in allkeys if allkeys.count(k) > 1}
    assert not dup, dup
    out = HERE / "T07.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
