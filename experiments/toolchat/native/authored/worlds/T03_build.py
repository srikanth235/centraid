"""World T03: Rafael Duarte Silva, secondary-school chemistry teacher in Porto (EUR vault).

    python3 authored/worlds/T03_build.py      # writes authored/worlds/T03.json (deterministic)

Today in the sessions is Wednesday 2026-10-14 21:10. Built-in ambiguity: two Pedros (Pedro Almeida,
physics colleague; Pedro Costa, futsal dad and kitty treasurer), two Anas (Ana Rita Sousa, biology
colleague; Dra. Ana Lopes, Mãe's cardiologist), Tiago the son vs Thiago Oliveira the Salvador host
(a misspelled-looking pair), look-alike events (two Mãe cardiology appointments, two matches vs
Boavista / Leixões / Salgueiros, two handovers), near-duplicate tasks (two "Pay EDP bill", the
Mark 9B / 9C tests, weekly bibs, monthly prescriptions), nicknames (Jo, Migas, Vitinha, Zé, Mãe),
cancelled events, completed tasks, trashed rows (recent and one older than 30 days), an empty
group (Magusto 2026), an empty folder and notebook, and one BRL group.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def d(y, m, dd):
    return date(y, m, dd)


def people():
    return [
        {"key": "joana", "name": "Joana Ferreira", "role": "partner, architect", "nickname": "Jo", "starred": True,
         "cadence": 1, "last_contacted": "2026-10-14T19:30", "last_contacted_kind": "visit", "met": "Serralves, 2021"},
        {"key": "tiago", "name": "Tiago Silva", "role": "son", "starred": True, "cadence": 2,
         "last_contacted": "2026-10-13T20:00", "last_contacted_kind": "call"},
        {"key": "ines", "name": "Inês Moura", "role": "Tiago's mum", "cadence": 7,
         "last_contacted": "2026-10-11T18:10", "last_contacted_kind": "message"},
        {"key": "graca", "name": "Graça Duarte", "role": "mum", "nickname": "Mãe", "starred": True, "cadence": 2,
         "last_contacted": "2026-10-12T16:00", "last_contacted_kind": "visit"},
        {"key": "marta", "name": "Marta Silva", "role": "sister, lives in Lisbon", "cadence": 14,
         "last_contacted": "2026-10-04T21:00", "last_contacted_kind": "call"},
        {"key": "pedro_a", "name": "Pedro Almeida", "role": "physics teacher, colleague", "cadence": 7,
         "last_contacted": "2026-10-14T13:00", "last_contacted_kind": "coffee", "met": "Escola Garcia de Orta, 2015"},
        {"key": "pedro_c", "name": "Pedro Costa", "role": "futsal dad, kitty treasurer",
         "last_contacted": "2026-10-10T11:40", "last_contacted_kind": "message", "met": "futsal pre-season 2025"},
        {"key": "ana_rita", "name": "Ana Rita Sousa", "role": "biology teacher, colleague", "cadence": 14,
         "last_contacted": "2026-10-07T13:00", "last_contacted_kind": "coffee"},
        {"key": "ana_lopes", "name": "Ana Lopes", "role": "cardiologist, Hospital São João", "nickname": "Dra. Lopes"},
        {"key": "luisa", "name": "Luísa Carvalho", "role": "school director",
         "last_contacted": "2026-10-09T10:00", "last_contacted_kind": "meeting"},
        {"key": "nuno", "name": "Nuno Faria", "role": "maths teacher, colleague", "cadence": 30,
         "last_contacted": "2026-09-30T16:00", "last_contacted_kind": "message"},
        {"key": "rui", "name": "Rui Moreira", "role": "lab technician", "met": "Escola Garcia de Orta, 2018"},
        {"key": "sonia", "name": "Sónia Pinto", "role": "futsal mum (Martim)"},
        {"key": "helena", "name": "Helena Rocha", "role": "futsal mum (Gui)"},
        {"key": "vitor", "name": "Vítor Mendes", "role": "assistant coach", "nickname": "Vitinha", "cadence": 7,
         "last_contacted": "2026-10-10T12:00", "last_contacted_kind": "visit", "met": "futsal pre-season 2025"},
        {"key": "carla", "name": "Carla Neves", "role": "club coordinator, CD Ramalde",
         "last_contacted": "2026-10-06T19:00", "last_contacted_kind": "call"},
        {"key": "miguel", "name": "Miguel Antunes", "role": "friend", "nickname": "Migas", "cadence": 14,
         "last_contacted": "2026-10-02T23:00", "last_contacted_kind": "visit", "met": "FEUP, 2003"},
        {"key": "bruno", "name": "Bruno Tavares", "role": "friend", "cadence": 21,
         "last_contacted": "2026-09-20T21:00", "last_contacted_kind": "message", "met": "FEUP, 2003"},
        {"key": "filipa", "name": "Filipa Gomes", "role": "friend", "cadence": 30,
         "last_contacted": "2026-08-30T20:00", "last_contacted_kind": "coffee"},
        {"key": "ricardo", "name": "Ricardo Barros", "role": "friend, padel partner", "nickname": "Ricky"},
        {"key": "thiago_o", "name": "Thiago Oliveira", "role": "Airbnb host, Salvador", "met": "Salvador, July 2026"},
        {"key": "henrique", "name": "Henrique Matos", "role": "family doctor", "nickname": "Dr. Matos",
         "last_contacted": "2026-09-30T10:00", "last_contacted_kind": "meeting"},
        {"key": "beatriz", "name": "Beatriz Reis", "role": "orthodontist (Tiago)"},
        {"key": "armando", "name": "Armando Pires", "role": "landlord", "nickname": "Sr. Armando"},
        {"key": "ze", "name": "José Correia", "role": "mechanic", "nickname": "Zé"},
        {"key": "teresa", "name": "Teresa Faria", "role": "Mãe's neighbour", "cadence": 30,
         "last_contacted": "2026-09-12T11:00", "last_contacted_kind": "visit"},
        {"key": "sofia", "name": "Sofia Martins", "role": "Joana's business partner"},
        {"key": "carlos", "name": "Carlos Vieira", "role": "ex futsal dad", "trashed": "2026-10-05T10:00"},
    ]


GROUPS = [
    {"key": "kitty", "name": "Futsal kitty", "members": ["pedro_c", "sonia", "helena", "vitor"], "created": "2026-09-05T20:00"},
    {"key": "lisboa", "name": "Lisbon conference", "members": ["ana_rita", "nuno", "pedro_a"], "created": "2026-09-18T17:00"},
    {"key": "brasil", "name": "Brasil 2026", "currency": "BRL", "members": ["joana", "marta", "thiago_o"],
     "created": "2026-06-10T21:00"},
    {"key": "casa", "name": "Casa", "members": ["joana"], "created": "2025-09-01T10:00"},
    {"key": "jantares", "name": "Friday dinners", "members": ["miguel", "bruno", "filipa", "ricardo"], "created": "2026-01-15T22:00"},
    {"key": "magusto_g", "name": "Magusto 2026", "members": ["joana", "graca", "marta"], "created": "2026-10-10T12:00"},
]

EXPENSES = [
    {"group": "kitty", "name": "Match balls", "amount": 72, "paid_by": "me", "split": ["me", "pedro_c", "sonia", "helena"], "date": "2026-09-12"},
    {"group": "kitty", "name": "Tournament entry fee", "amount": 120, "paid_by": "pedro_c",
     "split": ["me", "pedro_c", "sonia", "helena", "vitor"], "date": "2026-09-28"},
    {"group": "kitty", "name": "Snacks for the Leixões game", "amount": 18.60, "paid_by": "sonia",
     "split": ["me", "sonia", "helena"], "date": "2026-09-19"},
    {"group": "kitty", "name": "Bibs and cones", "amount": 45, "paid_by": "me", "split": ["me", "pedro_c", "vitor"], "date": "2026-10-03"},
    {"group": "lisboa", "name": "Hotel Lisboa", "amount": 360, "paid_by": "me", "split": ["me", "ana_rita", "nuno", "pedro_a"], "date": "2026-09-20"},
    {"group": "lisboa", "name": "Alfa Pendular tickets", "amount": 127.60, "paid_by": "ana_rita",
     "split": ["me", "ana_rita", "nuno", "pedro_a"], "date": "2026-09-22"},
    {"group": "lisboa", "name": "Registration fees", "amount": 240, "paid_by": "nuno", "split": ["me", "ana_rita", "nuno", "pedro_a"], "date": "2026-09-25"},
    {"group": "brasil", "name": "Apartment in Barra", "amount": 4800, "paid_by": "me", "split": ["me", "joana", "marta"], "date": "2026-07-29"},
    {"group": "brasil", "name": "Boat to Morro", "amount": 480, "paid_by": "joana", "split": ["me", "joana", "marta"], "date": "2026-08-04"},
    {"group": "brasil", "name": "Moqueca dinner", "amount": 360, "paid_by": "thiago_o", "split": ["me", "joana", "marta", "thiago_o"], "date": "2026-08-06"},
    {"group": "brasil", "name": "Car rental", "amount": 1250, "paid_by": "marta", "split": ["me", "joana", "marta"], "date": "2026-08-09"},
    {"group": "casa", "name": "EDP September", "amount": 84.30, "paid_by": "me", "split": ["me", "joana"], "date": "2026-09-21"},
    {"group": "casa", "name": "MEO internet", "amount": 39.99, "paid_by": "joana", "split": ["me", "joana"], "date": "2026-10-01"},
    {"group": "casa", "name": "Continente shop", "amount": 112.45, "paid_by": "me", "split": ["me", "joana"], "date": "2026-10-10"},
    {"group": "casa", "name": "IKEA shelf", "amount": 89, "paid_by": "joana", "split": ["me", "joana"], "date": "2026-10-04"},
    {"group": "jantares", "name": "Dinner at Cantina 31", "amount": 132, "paid_by": "miguel",
     "split": ["me", "miguel", "bruno", "filipa", "ricardo"], "date": "2026-09-25"},
    {"group": "jantares", "name": "Pizza night", "amount": 64, "paid_by": "me", "split": ["me", "miguel", "bruno", "filipa", "ricardo"], "date": "2026-10-09"},
]

LISTS = [
    {"key": "school", "name": "School", "area": "work"},
    {"key": "home", "name": "Home", "area": "home"},
    {"key": "futsal", "name": "Futsal", "area": "kids"},
    {"key": "mae_list", "name": "Mãe's care", "area": "family"},
    {"key": "tiago_list", "name": "Tiago", "area": "family"},
]

OPPONENTS = [
    (d(2026, 9, 19), "Leixões"), (d(2026, 9, 26), "Boavista"), (d(2026, 10, 3), "Salgueiros"),
    (d(2026, 10, 10), "Padroense"), (d(2026, 10, 17), "Candal"), (d(2026, 10, 24), "Leça"),
    (d(2026, 10, 31), "Infesta"), (d(2026, 11, 14), "Boavista"), (d(2026, 11, 21), "Leixões"),
    (d(2026, 11, 28), "Ramaldense"), (d(2026, 12, 5), "Salgueiros"),
]


def events():
    out = []
    # futsal training, Thursdays 18:30-20:00 (one cancelled: pavilion closed)
    start = d(2026, 9, 10)
    for i in range(14):
        day = start + timedelta(weeks=i)
        ev = {"key": f"train_{day.strftime('%m%d')}", "name": "Futsal training", "start": f"{day}T18:30",
              "end": f"{day}T20:00", "attendees": ["vitor", "tiago"], "description": "Pavilhão do Ramalde"}
        if day == d(2026, 10, 8):
            ev["cancelled"] = "2026-10-07T12:00"
        out.append(ev)
    # matches, Saturdays 10:00-11:30
    for day, opp in OPPONENTS:
        out.append({"key": f"match_{day.strftime('%m%d')}", "name": f"Futsal match vs {opp}", "start": f"{day}T10:00",
                    "end": f"{day}T11:30", "attendees": ["vitor", "tiago"]})
    # department meeting, Wednesdays 16:30-18:00
    start = d(2026, 9, 16)
    for i in range(11):
        day = start + timedelta(weeks=i)
        out.append({"key": f"dept_{day.strftime('%m%d')}", "name": "Department meeting", "start": f"{day}T16:30",
                    "end": f"{day}T18:00", "attendees": ["pedro_a", "ana_rita", "nuno"]})
    # Mãe's physio, Mondays 15:00-16:00 (one cancelled)
    start = d(2026, 9, 21)
    for i in range(10):
        day = start + timedelta(weeks=i)
        ev = {"key": f"physio_{day.strftime('%m%d')}", "name": "Mãe physio", "start": f"{day}T15:00",
              "end": f"{day}T16:00", "attendees": ["graca"], "description": "Clínica da Boavista, knee"}
        if day == d(2026, 10, 12):
            ev["cancelled"] = "2026-10-11T09:00"
        out.append(ev)
    out += [
        {"key": "mae_bloods", "name": "Mãe blood tests", "start": "2026-10-16T08:30", "end": "2026-10-16T09:15",
         "attendees": ["graca"], "description": "fasting, Centro de Saúde"},
        {"key": "cardio_fu", "name": "Mãe cardiology follow-up", "start": "2026-10-20T10:00", "end": "2026-10-20T11:00",
         "attendees": ["graca", "ana_lopes"], "description": "Hospital São João, bring the BP log"},
        {"key": "cardio_echo", "name": "Mãe cardiology echo", "start": "2026-11-10T09:30", "end": "2026-11-10T10:30",
         "attendees": ["graca", "ana_lopes"]},
        {"key": "mae_eyes", "name": "Mãe eye exam", "start": "2026-11-03T11:00", "end": "2026-11-03T12:00",
         "attendees": ["graca"]},
        {"key": "mae_gp", "name": "Mãe GP appointment", "start": "2026-09-30T10:00", "end": "2026-09-30T10:30",
         "attendees": ["graca", "henrique"]},
        {"key": "ortho", "name": "Tiago orthodontist", "start": "2026-10-27T17:30", "end": "2026-10-27T18:15",
         "attendees": ["tiago", "beatriz"]},
        {"key": "ptm", "name": "Parent-teacher meetings 9B", "start": "2026-10-22T17:00", "end": "2026-10-22T18:15",
         "attendees": ["luisa"]},
        {"key": "invig", "name": "Exam invigilation", "start": "2026-10-15T09:00", "end": "2026-10-15T11:00",
         "attendees": ["pedro_a"]},
        {"key": "lab_training", "name": "Lab safety training", "start": "2026-10-21T14:00", "end": "2026-10-21T16:00",
         "attendees": ["rui"]},
        {"key": "school_trip", "name": "9th grade trip to Visionarium", "start": "2026-10-28T08:30", "end": "2026-10-28T16:00",
         "attendees": ["ana_rita"]},
        {"key": "magusto", "name": "Magusto at school", "start": "2026-11-11T14:00", "end": "2026-11-11T16:00"},
        {"key": "miguel_dinner", "name": "Dinner at Miguel's", "start": "2026-10-16T20:00", "end": "2026-10-16T23:00",
         "attendees": ["miguel", "bruno", "filipa", "ricardo"]},
        {"key": "anniv", "name": "Anniversary dinner with Joana", "start": "2026-10-17T20:30", "end": "2026-10-17T23:00",
         "attendees": ["joana"], "description": "Cantinho do Avillez, table for 2"},
        {"key": "expo", "name": "Joana's studio exhibition", "start": "2026-10-23T19:00", "end": "2026-10-23T21:30",
         "attendees": ["joana", "sofia"]},
        {"key": "classico", "name": "FC Porto vs Benfica", "start": "2026-10-25T20:30", "end": "2026-10-25T22:30",
         "attendees": ["bruno", "tiago"]},
        {"key": "handover_1004", "name": "Tiago to Inês's", "start": "2026-10-04T18:00", "end": "2026-10-04T18:30",
         "attendees": ["tiago", "ines"]},
        {"key": "handover_1018", "name": "Tiago to Inês's", "start": "2026-10-18T18:00", "end": "2026-10-18T18:30",
         "attendees": ["tiago", "ines"]},
        {"key": "handover_1101", "name": "Tiago to Inês's", "start": "2026-11-01T18:00", "end": "2026-11-01T18:30",
         "attendees": ["tiago", "ines"]},
        {"key": "train_lx", "name": "Train to Lisbon", "start": "2026-11-06T07:09", "end": "2026-11-06T09:50",
         "attendees": ["ana_rita", "nuno", "pedro_a"], "description": "Alfa Pendular, carriage 4"},
        {"key": "conf", "name": "Chemistry teachers conference", "start": "2026-11-06T10:00", "end": "2026-11-07T17:00",
         "attendees": ["ana_rita", "nuno", "pedro_a"], "description": "Faculdade de Ciências, Lisboa"},
        {"key": "train_back", "name": "Train back to Porto", "start": "2026-11-07T18:09", "end": "2026-11-07T21:00",
         "attendees": ["ana_rita", "nuno", "pedro_a"]},
        {"key": "futsal_parents", "name": "Futsal parents meeting", "start": "2026-10-13T20:00", "end": "2026-10-13T21:00",
         "attendees": ["carla", "pedro_c"], "cancelled": "2026-10-12T18:00"},
        {"key": "tournament", "name": "December futsal tournament", "start": "2026-12-12T09:00", "end": "2026-12-12T18:00",
         "attendees": ["vitor", "carla", "tiago"]},
        {"key": "ipo_ev", "name": "Car inspection", "start": "2026-10-30T09:00", "end": "2026-10-30T10:00", "attendees": ["ze"]},
        {"key": "dentist", "name": "Dentist check-up", "start": "2026-11-04T09:00", "end": "2026-11-04T09:45"},
        {"key": "marta_lunch", "name": "Lunch with Marta", "start": "2026-10-31T13:00", "end": "2026-10-31T15:00",
         "attendees": ["marta", "graca"]},
        {"key": "tiago_party", "name": "Tiago's birthday party", "start": "2026-11-21T15:00", "end": "2026-11-21T18:00",
         "attendees": ["tiago", "joana"], "description": "Bowling at NorteShopping"},
        {"key": "flight_ssa", "name": "Flight Porto to Salvador", "start": "2026-07-28T11:40", "end": "2026-07-28T17:20",
         "attendees": ["joana", "tiago", "marta"], "description": "TAP TP109"},
        {"key": "flight_opo", "name": "Flight Salvador to Porto", "start": "2026-08-14T22:10", "end": "2026-08-15T11:00",
         "attendees": ["joana", "tiago", "marta"]},
        {"key": "padel", "name": "Padel with Ricky", "start": "2026-10-20T19:00", "end": "2026-10-20T20:30",
         "attendees": ["ricardo"], "trashed": "2026-10-09T10:00"},
        {"key": "bbq", "name": "Futsal season kickoff BBQ", "start": "2026-09-12T13:00", "end": "2026-09-12T17:00",
         "attendees": ["vitor", "pedro_c", "sonia", "helena", "carla"]},
    ]
    return out


def tasks():
    t = [
        # school
        {"key": "mark_9b", "name": "Mark 9B tests", "due": "2026-10-19", "priority": 2, "effort": 180, "list": "school"},
        {"key": "mark_9c", "name": "Mark 9C tests", "due": "2026-10-21", "effort": 150, "list": "school"},
        {"key": "lab_10a", "name": "Grade 10A lab reports", "due": "2026-10-16", "status": "in_progress", "effort": 120,
         "list": "school"},
        {"key": "titration", "name": "Prepare titration practical", "due": "2026-10-23", "priority": 1, "effort": 90,
         "list": "school", "description": "10th grade acid-base titration, phenolphthalein"},
        {"key": "burettes", "name": "Order burettes", "parent": "titration", "completed": "2026-10-09T11:00"},
        {"key": "worksheet", "name": "Write titration worksheet", "parent": "titration", "due": "2026-10-20", "effort": 45},
        {"key": "naoh", "name": "Standardise the NaOH solution", "parent": "titration", "due": "2026-10-22", "effort": 30},
        {"key": "abstract", "name": "Submit conference abstract", "due": "2026-09-25", "completed": "2026-09-24T22:00",
         "list": "school"},
        {"key": "slides", "name": "Conference slides", "due": "2026-11-04", "effort": 240, "list": "school", "priority": 2,
         "description": "microscale chemistry talk, 20 min"},
        {"key": "inventory", "name": "Lab inventory", "status": "in_progress", "effort": 60, "list": "school"},
        {"key": "luisa_budget", "name": "Email Luísa about the lab budget", "due": "2026-10-15", "list": "school"},
        {"key": "moodle", "name": "Update Moodle page for 11th grade", "due": "2026-10-18", "effort": 30, "list": "school"},
        {"key": "report_cards", "name": "Write 1st term report cards", "due": "2026-12-15", "priority": 3, "effort": 300,
         "list": "school"},
        {"key": "invig_swap", "name": "Swap invigilation with Pedro", "due": "2026-10-10", "status": "cancelled", "list": "school"},
        {"key": "safety_form", "name": "Sign lab safety form", "completed": "2026-09-18T10:00", "list": "school"},
        # home
        {"key": "edp_sep", "name": "Pay EDP bill", "due": "2026-09-20", "completed": "2026-09-19T21:00", "list": "home"},
        {"key": "edp_oct", "name": "Pay EDP bill", "due": "2026-10-20", "priority": 2, "list": "home"},
        {"key": "tap", "name": "Fix bathroom tap", "due": "2026-10-18", "effort": 45, "list": "home"},
        {"key": "boiler", "name": "Call Sr. Armando about the boiler", "due": "2026-10-15", "list": "home"},
        {"key": "bulbs", "name": "Buy lightbulbs", "list": "home", "effort": 15},
        {"key": "ipo_book", "name": "Book car inspection", "completed": "2026-10-05T09:30", "list": "home"},
        {"key": "car_ins", "name": "Renew car insurance", "due": "2026-11-30", "list": "home"},
        {"key": "service", "name": "Get the car serviced", "due": "2026-11-10", "list": "home", "effort": 120},
        {"key": "irs", "name": "Submit IRS", "due": "2026-06-30", "completed": "2026-06-20T22:00", "list": "home"},
        {"key": "ikea", "name": "Return the IKEA shelf", "due": "2026-10-24", "list": "home"},
        # futsal
        {"key": "kitty_collect", "name": "Collect kitty money for October", "due": "2026-10-17", "list": "futsal",
         "description": "10 euros per kid"},
        {"key": "jerseys", "name": "Order new jerseys", "due": "2026-10-30", "status": "in_progress", "list": "futsal",
         "description": "14 jerseys, sizes 10-12, navy with white numbers", "effort": 60},
        {"key": "pavilion", "name": "Book pavilion for December tournament", "due": "2026-10-31", "priority": 1,
         "list": "futsal"},
        {"key": "schedule_print", "name": "Print match schedule", "completed": "2026-09-14T20:00", "list": "futsal"},
        {"key": "first_aid", "name": "Restock first aid kit", "due": "2026-10-16", "list": "futsal", "effort": 20},
        {"key": "ref_form", "name": "Send referee form to Carla", "due": "2026-10-19", "list": "futsal"},
        # Mãe
        {"key": "call_matos", "name": "Call Dr. Matos about blood results", "due": "2026-10-19", "list": "mae_list",
         "priority": 2},
        {"key": "eyes_book", "name": "Book Mãe's eye exam", "completed": "2026-10-01T10:00", "list": "mae_list"},
        {"key": "pills", "name": "Buy Mãe a pill organiser", "due": "2026-10-05", "status": "cancelled", "list": "mae_list"},
        {"key": "mae_irs", "name": "Sort Mãe's IRS papers", "due": "2026-11-30", "list": "mae_list", "effort": 90},
        {"key": "stair", "name": "Get a quote for Mãe's stair rail", "due": "2026-10-30", "list": "mae_list"},
        # Tiago
        {"key": "gift", "name": "Tiago's birthday present", "due": "2026-11-15", "priority": 2, "list": "tiago_list"},
        {"key": "party", "name": "Plan Tiago's birthday party", "due": "2026-11-14", "list": "tiago_list", "status": "in_progress"},
        {"key": "invites", "name": "Send party invites", "parent": "party", "due": "2026-10-31"},
        {"key": "cake", "name": "Order the cake", "parent": "party", "due": "2026-11-18"},
        {"key": "bowling", "name": "Book the bowling alley", "parent": "party", "completed": "2026-10-06T19:00"},
        {"key": "trip_form", "name": "Sign Tiago's school trip form", "due": "2026-10-16", "list": "tiago_list", "effort": 5},
        {"key": "cc_renew", "name": "Renew Tiago's Cartão de Cidadão", "due": "2026-12-01", "list": "tiago_list", "effort": 60},
        {"key": "ines_receipts", "name": "Send Inês the school book receipts", "due": "2026-10-15", "list": "tiago_list"},
        # other
        {"key": "brasil_photos", "name": "Sort Brazil photos", "status": "in_progress", "effort": 90},
        {"key": "joana_gift", "name": "Anniversary gift for Joana", "due": "2026-10-17", "priority": 1},
        {"key": "run", "name": "Sign up for São Silvestre run", "due": "2026-11-20", "effort": 10},
        {"key": "gym", "name": "Cancel gym membership", "trashed": "2026-10-08T09:00"},
        {"key": "ink", "name": "Buy printer ink", "trashed": "2026-10-10T18:00", "list": "home"},
        {"key": "old_bike", "name": "Sell old bike", "trashed": "2026-08-01T10:00"},
        {"key": "flu_jab", "name": "Book Mãe's flu jab", "due": "2026-10-23", "priority": 1, "trashed": "2026-10-12T09:00"},
    ]
    for day, done in [("2026-09-17", "2026-09-17T21:00"), ("2026-09-24", "2026-09-24T21:30"),
                      ("2026-10-01", "2026-10-01T22:00"), ("2026-10-08", "2026-10-09T08:00")]:
        t.append({"key": f"bibs_{day[5:7]}{day[8:]}", "name": "Wash training bibs", "due": day, "completed": done,
                  "list": "futsal"})
    t.append({"key": "bibs_1015", "name": "Wash training bibs", "due": "2026-10-15", "list": "futsal", "effort": 15})
    for m, done in [(7, "2026-07-04T10:00"), (8, "2026-08-05T11:00"), (9, "2026-09-04T18:00"), (10, "2026-10-05T12:00")]:
        t.append({"key": f"scripts_{m:02d}", "name": "Pick up Mãe's prescriptions", "due": f"2026-{m:02d}-05",
                  "completed": done, "list": "mae_list"})
    t.append({"key": "scripts_11", "name": "Pick up Mãe's prescriptions", "due": "2026-11-05", "list": "mae_list"})
    return t


NOTEBOOKS = [
    {"key": "lessons", "name": "Lesson ideas"},
    {"key": "futsal_nb", "name": "Futsal"},
    {"key": "mae_nb", "name": "Mãe health"},
    {"key": "brasil_nb", "name": "Brazil"},
    {"key": "recipes", "name": "Recipes"},
    {"key": "old_nb", "name": "Old stuff"},
]

NOTES = [
    {"key": "redox", "name": "Redox demo ideas", "body": "copper wire in silver nitrate for the silver tree; thermite only outside with Rui",
     "notebook": "lessons", "created": "2026-09-20T21:00"},
    {"key": "titr_plan", "name": "Titration practical plan", "body": "0.1 M NaOH, phenolphthalein, groups of three, 50 minutes",
     "notebook": "lessons", "created": "2026-10-08T22:10"},
    {"key": "toothpaste", "name": "Elephant toothpaste", "body": "30% hydrogen peroxide, potassium iodide, dish soap, food colouring; goggles on",
     "notebook": "lessons", "created": "2026-09-10T20:00", "pinned": True},
    {"key": "songs", "name": "Periodic table songs", "body": "Tom Lehrer elements, the ASAP Science one for 7th grade",
     "notebook": "lessons", "created": "2026-09-02T18:00"},
    {"key": "talk", "name": "Conference talk outline", "body": "microscale chemistry in Portuguese schools; 20 minutes plus 5 of questions",
     "notebook": "lessons", "created": "2026-09-23T22:00"},
    {"key": "lineup", "name": "Starting five", "body": "Martim in goal, Duarte fixo, Gui and Rodrigo on the wings, Tiago pivot",
     "notebook": "futsal_nb", "created": "2026-10-09T22:30", "pinned": True},
    {"key": "drills", "name": "Passing drills", "body": "rondo 4v1, one-touch triangles, finish with 2v1 to goal",
     "notebook": "futsal_nb", "created": "2026-09-08T21:00"},
    {"key": "kitty_rules", "name": "Kitty rules", "body": "10 euros per kid per month, Pedro Costa keeps the tin, receipts go in the group",
     "notebook": "futsal_nb", "created": "2026-09-06T10:00"},
    {"key": "meds", "name": "Mãe's medication", "body": "bisoprolol 5mg morning, atorvastatin 20mg night, apixaban 5mg twice a day",
     "notebook": "mae_nb", "created": "2026-09-30T12:00", "pinned": True},
    {"key": "bp_log", "name": "Mãe blood pressure log", "body": "Oct 2 145/88, Oct 6 138/85, Oct 11 142/86",
     "notebook": "mae_nb", "created": "2026-10-02T19:00"},
    {"key": "cardio_q", "name": "Questions for the cardiologist", "body": "swollen ankles; can she stop the statin; is she ok to drive",
     "notebook": "mae_nb", "created": "2026-10-12T21:30"},
    {"key": "ssa_food", "name": "Salvador restaurants", "body": "Paraíso Tropical moqueca, Acarajé da Dinha, Sorveteria da Ribeira",
     "notebook": "brasil_nb", "created": "2026-07-30T23:00"},
    {"key": "brasil_pack", "name": "Packing list Brazil", "body": "sunscreen, adapters, Tiago's snorkel, hats, repellent",
     "notebook": "brasil_nb", "created": "2026-07-20T21:00"},
    {"key": "brasil_costs", "name": "Brazil costs recap", "body": "cash ran out on day 9, card fees about 2 percent",
     "notebook": "brasil_nb", "created": "2026-08-16T12:00"},
    {"key": "bacalhau", "name": "Bacalhau à Brás", "body": "shredded cod, matchstick potatoes, 6 eggs, onion, olives, parsley",
     "notebook": "recipes", "created": "2026-03-01T19:00"},
    {"key": "francesinha", "name": "Francesinha sauce", "body": "beer, tomato, piri-piri, bay leaf, a shot of port, reduce 40 minutes",
     "notebook": "recipes", "created": "2026-05-10T18:00"},
    {"key": "caldo", "name": "Caldo verde", "body": "potatoes, kale sliced thin, chouriço, good olive oil",
     "notebook": "recipes", "created": "2026-01-18T19:00"},
    {"key": "anniv_ideas", "name": "Anniversary ideas for Joana", "body": "Serralves at night, the ring shop on Rua das Flores, a weekend in Gerês",
     "created": "2026-10-03T23:00"},
    {"key": "sizes", "name": "Tiago's sizes", "body": "shoes 36, jersey 12, trousers 11-12", "created": "2026-09-01T20:00"},
    {"key": "books", "name": "Books to read", "body": "Saramago Blindness, The Periodic Table by Primo Levi, Pessoa", "created": "2026-06-11T22:00"},
    {"key": "journal", "name": "Rough Monday", "body": "physio cancelled, 9B chaos, Mãe tired; need to sleep more", "created": "2026-10-12T23:40"},
    {"key": "gift_ideas", "name": "Gift ideas for Tiago", "body": "futsal boots size 36, Lego Technic, Porto shirt with Pepê", "created": "2026-10-11T22:00"},
    {"key": "untitled", "name": "Untitled note", "created": "2026-10-13T22:05"},
    {"key": "old_lineup", "name": "Old futsal lineup", "body": "Carlos's boy in goal", "notebook": "futsal_nb",
     "created": "2026-09-01T10:00", "trashed": "2026-10-06T21:00"},
    {"key": "complaint", "name": "Draft complaint to the câmara", "body": "the potholes on Rua de Serpa Pinto", "created": "2026-09-15T10:00",
     "trashed": "2026-10-09T08:00"},
]

FOLDERS = [
    {"key": "school_f", "name": "School"},
    {"key": "casa_f", "name": "Casa"},
    {"key": "mae_f", "name": "Mãe medical"},
    {"key": "tiago_f", "name": "Tiago docs"},
    {"key": "car_f", "name": "Car"},
    {"key": "brasil_f", "name": "Brazil trip"},
    {"key": "scans_f", "name": "Scans 2019"},
]

DOCUMENTS = [
    {"key": "timetable", "name": "Timetable 2026-27", "folder": "school_f", "starred": True, "created": "2026-09-10T09:00"},
    {"key": "curriculum", "name": "Chemistry 10th grade curriculum", "folder": "school_f", "created": "2026-09-01T09:00"},
    {"key": "conf_reg", "name": "Conference registration", "folder": "school_f", "created": "2026-09-25T20:00"},
    {"key": "abstract_doc", "name": "Conference abstract", "folder": "school_f", "created": "2026-09-24T22:00"},
    {"key": "lease", "name": "Tenancy contract", "folder": "casa_f", "starred": True, "created": "2025-08-28T09:00"},
    {"key": "edp_doc", "name": "EDP contract", "folder": "casa_f", "created": "2025-09-02T09:00"},
    {"key": "echo_report", "name": "Mãe echocardiogram report", "folder": "mae_f", "created": "2026-05-14T12:00"},
    {"key": "bloods_doc", "name": "Mãe blood results September", "folder": "mae_f", "created": "2026-09-29T15:00"},
    {"key": "sns_card", "name": "Mãe SNS card scan", "folder": "mae_f", "created": "2026-01-10T10:00"},
    {"key": "custody", "name": "Custody agreement", "folder": "tiago_f", "starred": True, "created": "2023-03-15T10:00"},
    {"key": "enrolment", "name": "Tiago school enrolment", "folder": "tiago_f", "created": "2026-07-10T10:00"},
    {"key": "vaccines", "name": "Tiago vaccination record", "folder": "tiago_f", "created": "2025-11-02T10:00"},
    {"key": "car_policy", "name": "Car insurance policy", "folder": "car_f", "created": "2025-11-30T10:00"},
    {"key": "dua", "name": "Car registration DUA", "folder": "car_f", "created": "2024-04-02T10:00"},
    {"key": "ipo_cert", "name": "IPO certificate 2025", "folder": "car_f", "created": "2025-10-28T10:00"},
    {"key": "tap_booking", "name": "TAP booking Salvador", "folder": "brasil_f", "created": "2026-06-12T22:00"},
    {"key": "pousada", "name": "Pousada booking Morro de São Paulo", "folder": "brasil_f", "created": "2026-06-20T22:00"},
    {"key": "cv", "name": "CV 2026", "created": "2026-02-01T10:00"},
    {"key": "old_timetable", "name": "Timetable 2025-26", "folder": "school_f", "created": "2025-09-10T09:00",
     "trashed": "2026-10-02T10:00"},
]

ALBUMS = [
    {"key": "brasil_album", "name": "Brasil 2026"},
    {"key": "futsal_album", "name": "Futsal 2026-27"},
    {"key": "tiago_album", "name": "Tiago"},
    {"key": "family_album", "name": "Family"},
    {"key": "wallpapers", "name": "Wallpapers"},
]

PHOTOS = [
    {"key": "pelourinho", "name": "Pelourinho streets", "taken": "2026-07-29T16:00", "albums": ["brasil_album"], "people": ["joana"]},
    {"key": "farol", "name": "Farol da Barra", "taken": "2026-07-30T18:10", "albums": ["brasil_album"], "starred": True},
    {"key": "morro", "name": "Morro de São Paulo beach", "taken": "2026-08-04T12:30", "albums": ["brasil_album"],
     "people": ["joana", "tiago"]},
    {"key": "jo_beach", "name": "Joana at Porto da Barra", "taken": "2026-07-31T15:00", "albums": ["brasil_album"], "people": ["joana"]},
    {"key": "capoeira", "name": "Tiago trying capoeira", "taken": "2026-08-02T17:20", "albums": ["brasil_album", "tiago_album"],
     "people": ["tiago"], "starred": True},
    {"key": "acaraje", "name": "Acarajé stall", "taken": "2026-08-01T13:00", "albums": ["brasil_album"]},
    {"key": "moqueca_pic", "name": "Moqueca night", "taken": "2026-08-06T21:00", "albums": ["brasil_album"],
     "people": ["joana", "marta", "thiago_o"]},
    {"key": "thiago_pic", "name": "With Thiago on the terrace", "taken": "2026-08-07T19:00", "albums": ["brasil_album"],
     "people": ["thiago_o"]},
    {"key": "boat", "name": "Boat to Morro", "taken": "2026-08-04T08:45", "albums": ["brasil_album"], "people": ["marta"]},
    {"key": "sunset_barra", "name": "Sunset in Barra", "taken": "2026-08-10T17:40", "albums": ["brasil_album"], "starred": True},
    {"key": "elevador", "name": "Elevador Lacerda", "taken": "2026-08-11T11:00", "albums": ["brasil_album"]},
    {"key": "mercado", "name": "Mercado Modelo", "taken": "2026-08-11T12:00", "albums": ["brasil_album"], "people": ["marta", "tiago"]},
    {"key": "team_pic", "name": "Team photo 2026-27", "taken": "2026-09-12T13:30", "albums": ["futsal_album"],
     "people": ["tiago", "vitor"], "starred": True},
    {"key": "tiago_goal", "name": "Tiago's goal vs Leixões", "taken": "2026-09-19T10:40", "albums": ["futsal_album", "tiago_album"],
     "people": ["tiago"]},
    {"key": "bbq_pic", "name": "Kickoff BBQ", "taken": "2026-09-12T15:00", "albums": ["futsal_album"],
     "people": ["vitor", "pedro_c", "sonia", "helena"]},
    {"key": "bench", "name": "Bench vs Boavista", "taken": "2026-09-26T10:50", "albums": ["futsal_album"], "people": ["vitor"]},
    {"key": "vitor_pic", "name": "Vitinha giving the team talk", "taken": "2026-10-03T09:45", "albums": ["futsal_album"],
     "people": ["vitor"]},
    {"key": "bibs_pic", "name": "Muddy bibs", "taken": "2026-10-08T21:00", "albums": ["futsal_album"]},
    {"key": "padroense_pic", "name": "Win vs Padroense", "taken": "2026-10-10T11:35", "albums": ["futsal_album"],
     "people": ["tiago", "vitor"]},
    {"key": "first_day", "name": "First day of 6th grade", "taken": "2026-09-14T08:10", "albums": ["tiago_album"], "people": ["tiago"]},
    {"key": "bday10", "name": "Tiago's 10th birthday", "taken": "2025-11-21T16:00", "albums": ["tiago_album"],
     "people": ["tiago", "joana"]},
    {"key": "lego", "name": "Lego Technic crane", "taken": "2026-06-02T19:00", "albums": ["tiago_album"], "people": ["tiago"]},
    {"key": "mae_bday", "name": "Mãe's 78th birthday", "taken": "2026-03-08T14:00", "albums": ["family_album"],
     "people": ["graca", "marta"], "starred": True},
    {"key": "sunday_lunch", "name": "Sunday lunch at Mãe's", "taken": "2026-10-11T14:30", "albums": ["family_album"],
     "people": ["graca", "tiago"]},
    {"key": "serralves_pic", "name": "Joana and me at Serralves", "taken": "2026-06-14T18:00", "albums": ["family_album"],
     "people": ["joana"]},
    {"key": "marta_visit", "name": "Marta on the Ribeira", "taken": "2026-04-05T16:00", "albums": ["family_album"], "people": ["marta"]},
    {"key": "mae_garden", "name": "Mãe's garden", "taken": "2026-05-20T11:00", "albums": ["family_album"], "people": ["graca"]},
    {"key": "xmas", "name": "Christmas 2025", "taken": "2025-12-25T15:00", "albums": ["family_album"],
     "people": ["graca", "marta", "tiago", "joana"]},
    {"key": "whiteboard", "name": "Whiteboard redox notes", "taken": "2026-10-06T11:00"},
    {"key": "setup", "name": "Titration setup", "taken": "2026-10-09T10:30"},
    {"key": "receipt_pic", "name": "Kitty receipt", "taken": "2026-10-03T12:00"},
    {"key": "douro", "name": "Douro at dusk", "taken": "2026-10-01T19:10"},
    {"key": "silver_tree", "name": "Silver tree demo", "taken": "2026-10-13T11:00"},
    {"key": "foz", "name": "Foz sunset", "taken": "2026-10-13T18:45"},
    {"key": "blurry", "name": "Blurry pavilion shot", "taken": "2026-10-10T10:05", "trashed": "2026-10-11T09:00"},
]

DEBTS = [
    {"key": "d_balls", "person": "pedro_c", "direction": "owes_me", "amount": 24, "name": "Spare match ball", "date": "2026-09-30"},
    {"key": "d_books", "person": "ines", "direction": "i_owe", "amount": 67.40, "name": "Half of Tiago's school books", "date": "2026-09-08"},
    {"key": "d_concert", "person": "joana", "direction": "i_owe", "amount": 45, "name": "Concert tickets", "date": "2026-09-27"},
    {"key": "d_cantina", "person": "miguel", "direction": "owes_me", "amount": 30, "name": "Taxi home", "date": "2026-09-25",
     "settled": "2026-09-28T10:00"},
    {"key": "d_nuno", "person": "nuno", "direction": "owes_me", "amount": 31.90, "name": "Metro and lunch in Lisbon", "date": "2026-10-02"},
    {"key": "d_capsules", "person": "ana_rita", "direction": "i_owe", "amount": 12, "name": "Coffee capsules", "date": "2026-09-15",
     "settled": "2026-09-22T13:00"},
    {"key": "d_glasses", "person": "marta", "direction": "i_owe", "amount": 150, "name": "Mãe's glasses, my half", "date": "2026-09-05"},
    {"key": "d_classico", "person": "bruno", "direction": "owes_me", "amount": 60, "name": "Clássico tickets", "date": "2026-10-06"},
    {"key": "d_deposit", "person": "thiago_o", "direction": "i_owe", "amount": 200, "name": "Salvador apartment deposit",
     "date": "2026-06-15", "settled": "2026-07-29T12:00"},
    {"key": "d_cones", "person": "vitor", "direction": "owes_me", "amount": 15, "name": "Cones and markers", "date": "2026-10-03"},
    {"key": "d_padel", "person": "ricardo", "direction": "i_owe", "amount": 20, "name": "Padel court", "date": "2026-10-07"},
    {"key": "d_pharmacy", "person": "graca", "direction": "owes_me", "amount": 38.50, "name": "Pharmacy run", "date": "2026-10-05"},
    {"key": "d_fee", "person": "sonia", "direction": "owes_me", "amount": 10, "name": "Martim's tournament fee", "date": "2026-09-28"},
]

LOCKER = [
    {"key": "inovar", "name": "Inovar school login", "type": "login", "username": "rafael.silva@esgarciaorta.pt",
     "url": "https://inovar.esgarciaorta.pt", "password": "Titula-0,1M!", "starred": True},
    {"key": "moodle_login", "name": "Moodle login", "type": "login", "username": "rdsilva", "url": "https://moodle.esgarciaorta.pt",
     "password": "benzene-ring-6"},
    {"key": "gmail", "name": "Gmail", "type": "login", "username": "rafa.duarte.silva@gmail.com", "url": "https://mail.google.com",
     "password": "Dragao1893#", "code": "KRSXG5CTMVRXEZLU"},
    {"key": "cgd_card", "name": "Caixa debit card", "type": "card", "card_number": "4176 5500 1234 8890", "cvv": "303", "starred": True},
    {"key": "cc_id", "name": "Cartão de Cidadão", "type": "identity"},
    {"key": "wifi", "name": "Home wifi", "type": "wifi", "password": "francesinha-2026"},
    {"key": "router", "name": "Router admin", "type": "password", "password": "meo-admin-4471"},
    {"key": "ssh", "name": "School lab server key", "type": "ssh_key", "notes": "ed25519, lab-pc-03", "code": "ssh-ed25519 AAAAC3Nza lab"},
    {"key": "api", "name": "PubChem API key", "type": "api_credential", "code": "pc-8f2a-77e1-lab", "notes": "for the 11th grade project"},
    {"key": "passport", "name": "Passport", "type": "passport", "notes": "CB123456, expires 2031"},
    {"key": "cgd_acct", "name": "CGD current account", "type": "bank_account", "notes": "IBAN PT50 0035 0000 1234 5678 9012 3"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence", "notes": "P-1234567, B category, valid until 2035"},
    {"key": "chemdraw", "name": "ChemDraw licence", "type": "software_licence", "code": "CDW-2026-TEACH-9931", "notes": "school licence, 1 seat"},
    {"key": "wallet", "name": "Bitcoin wallet", "type": "crypto_wallet", "notes": "Ledger Nano, 12 words in the safe at Mãe's"},
    {"key": "solinca", "name": "Solinca gym membership", "type": "membership", "notes": "member 88213, renews January"},
    {"key": "uefa", "name": "UEFA C coaching licence", "type": "document", "notes": "FPF 2024, number 5512"},
    {"key": "pavilion_code", "name": "Pavilion key box code", "type": "note", "notes": "2604, left of the side door"},
    {"key": "netflix", "name": "Netflix login", "type": "login", "username": "rafa.duarte.silva@gmail.com", "password": "old-pass-99",
     "trashed": "2026-10-07T20:00"},
]

LINKS = [
    {"from": "call_matos", "to": "henrique"},
    {"from": "boiler", "to": "armando"},
    {"from": "service", "to": "ze"},
    {"from": "ref_form", "to": "carla"},
    {"from": "kitty_collect", "to": "pedro_c"},
    {"from": "jerseys", "to": "vitor"},
    {"from": "pavilion", "to": "carla"},
    {"from": "luisa_budget", "to": "luisa"},
    {"from": "inventory", "to": "rui"},
    {"from": "slides", "to": "ana_rita"},
    {"from": "invig_swap", "to": "pedro_a"},
    {"from": "gift", "to": "tiago"},
    {"from": "party", "to": "tiago"},
    {"from": "trip_form", "to": "tiago"},
    {"from": "cc_renew", "to": "tiago"},
    {"from": "ines_receipts", "to": "ines"},
    {"from": "joana_gift", "to": "joana"},
    {"from": "stair", "to": "teresa"},
    {"from": "mae_irs", "to": "graca"},
    {"from": "eyes_book", "to": "graca"},
    {"from": "scripts_11", "to": "graca"},
    {"from": "anniv_ideas", "to": "joana"},
    {"from": "sizes", "to": "tiago"},
    {"from": "gift_ideas", "to": "tiago"},
    {"from": "meds", "to": "graca"},
    {"from": "bp_log", "to": "graca"},
    {"from": "cardio_q", "to": "ana_lopes"},
    {"from": "kitty_rules", "to": "pedro_c"},
    {"from": "ssa_food", "to": "thiago_o"},
    {"from": "redox", "to": "rui"},
]


def _check_overlaps(evs):
    def parse(s):
        return datetime.fromisoformat(s if "T" in s else s + "T00:00")
    spans = sorted((parse(e["start"]), parse(e["end"]), e["key"]) for e in evs)
    for (a0, a1, ak), (b0, b1, bk) in zip(spans, spans[1:]):
        assert b0 >= a1, f"overlap {ak} / {bk}"


def world():
    evs = events()
    _check_overlaps(evs)
    return {
        "me": "Rafael Duarte Silva",
        "epoch": "2025-08-01T09:00",
        "seed": "T03",
        "currency": "EUR",
        "people": people(),
        "groups": GROUPS,
        "expenses": EXPENSES,
        "lists": LISTS,
        "events": evs,
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


if __name__ == "__main__":
    out = HERE / "T03.json"
    w = world()
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
