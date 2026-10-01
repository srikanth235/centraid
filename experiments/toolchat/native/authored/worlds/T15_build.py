"""World T15: Ingrid Solberg, marine biologist on a research vessel rotation out of Tromsø (NOK vault).

    python3 authored/worlds/T15_build.py      # writes authored/worlds/T15.json (deterministic)

Today in the sessions is Monday 2026-11-09 10:15: ashore between cruise HV-2610 (back 30 October)
and cruise HV-2611 on R/V Havella (sails 23 November). Lives in Tromsø with her partner Jonas and
their cat Pusur; keeps the crew mess fund on board, shares a cabin in Lyngen with Jonas, Torstein
and Hanne, and climbs with the Tromsø climbing club. Built-in ambiguity: two Eriks (captain Erik
Nilsen, climbing partner Erik Johansen), nicknames (Halle, Tosse, Mari, Kapteinen), a
misspelled-looking name (Ailo Gaup), two cruise planning meetings, two vet visits for Pusur, two
"Renew seafarer medical" tasks, monthly bills, two cruise reports and two payslips among the
documents, two "Cruise" lists, cancelled events, completed tasks, trashed rows inside and past the
30-day restore window, an empty group, two empty folders and an empty album.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        # home and family
        {"key": "jonas", "name": "Jonas Berg", "role": "partner", "cadence": 1, "starred": True, "met": "Tromsø",
         "last_contacted": "2026-11-09T08:00", "last_contacted_kind": "message"},
        {"key": "mum", "name": "Astrid Solberg", "role": "mum, Bodø", "nickname": "Mamma", "cadence": 7,
         "starred": True, "last_contacted": "2026-11-01T18:00", "last_contacted_kind": "call"},
        {"key": "dad", "name": "Per Solberg", "role": "dad, Bodø", "cadence": 14,
         "last_contacted": "2026-10-18T18:00", "last_contacted_kind": "call"},
        {"key": "anders", "name": "Anders Solberg", "role": "brother, Oslo", "cadence": 30,
         "last_contacted": "2026-09-27T20:00", "last_contacted_kind": "message"},
        {"key": "berit", "name": "Berit Berg", "role": "Jonas's mum", "cadence": 30,
         "last_contacted": "2026-11-01T17:00", "last_contacted_kind": "visit"},
        {"key": "knut", "name": "Knut Berg", "role": "Jonas's dad",
         "last_contacted": "2026-11-01T17:00", "last_contacted_kind": "visit"},
        # R/V Havella
        {"key": "erik_n", "name": "Erik Nilsen", "role": "captain", "nickname": "Kapteinen", "cadence": 14,
         "met": "R/V Havella", "last_contacted": "2026-11-04T09:00", "last_contacted_kind": "call"},
        {"key": "hallvard", "name": "Hallvard Moe", "role": "chief scientist", "nickname": "Halle", "cadence": 7,
         "starred": True, "met": "UiT", "last_contacted": "2026-11-04T10:00", "last_contacted_kind": "coffee"},
        {"key": "tor", "name": "Tor Isaksen", "role": "instrument technician", "met": "R/V Havella",
         "last_contacted": "2026-10-30T15:00", "last_contacted_kind": "visit"},
        {"key": "svein", "name": "Svein Larsen", "role": "cook", "met": "R/V Havella",
         "last_contacted": "2026-10-29T12:00", "last_contacted_kind": "visit"},
        {"key": "bjorn", "name": "Bjørn Strand", "role": "bosun", "met": "R/V Havella", "cadence": 30,
         "last_contacted": "2026-10-30T14:00", "last_contacted_kind": "visit"},
        {"key": "ailo", "name": "Ailo Gaup", "role": "deckhand", "met": "R/V Havella",
         "last_contacted": "2026-10-28T20:00", "last_contacted_kind": "coffee"},
        {"key": "linnea", "name": "Linnea Holm", "role": "deckhand", "met": "R/V Havella",
         "last_contacted": "2026-11-02T19:00", "last_contacted_kind": "message"},
        {"key": "rune", "name": "Rune Pedersen", "role": "engineer", "met": "R/V Havella"},
        {"key": "marianne", "name": "Marianne Eide", "role": "PhD student", "nickname": "Mari", "cadence": 14,
         "met": "UiT", "last_contacted": "2026-11-06T13:00", "last_contacted_kind": "coffee"},
        # UiT and collaborators
        {"key": "marte", "name": "Marte Olsen", "role": "PhD student", "cadence": 14, "met": "UiT",
         "last_contacted": "2026-11-05T11:00", "last_contacted_kind": "coffee"},
        {"key": "geir", "name": "Geir Hansen", "role": "head of group", "cadence": 30, "met": "UiT",
         "last_contacted": "2026-10-06T10:00", "last_contacted_kind": "visit"},
        {"key": "sofie", "name": "Sofie Andersen", "role": "postdoc", "met": "UiT",
         "last_contacted": "2026-11-03T15:00", "last_contacted_kind": "message"},
        {"key": "jan", "name": "Jan Schröder", "role": "collaborator, Kiel", "cadence": 30, "met": "Kiel workshop 2025",
         "last_contacted": "2026-10-08T16:00", "last_contacted_kind": "call"},
        {"key": "ingvild", "name": "Ingvild Rasmussen", "role": "friend", "cadence": 14, "met": "UiT",
         "last_contacted": "2026-10-21T12:00", "last_contacted_kind": "coffee"},
        # climbing and cabin
        {"key": "erik_j", "name": "Erik Johansen", "role": "climbing partner", "cadence": 7,
         "met": "Tromsø climbing club", "last_contacted": "2026-11-03T20:00", "last_contacted_kind": "visit"},
        {"key": "kaja", "name": "Kaja Johansen", "role": "climbing friend", "met": "Tromsø climbing club",
         "last_contacted": "2026-11-03T20:00", "last_contacted_kind": "visit"},
        {"key": "silje", "name": "Silje Nordby", "role": "climbing friend", "cadence": 14,
         "met": "Tromsø climbing club", "last_contacted": "2026-11-05T19:00", "last_contacted_kind": "visit"},
        {"key": "torstein", "name": "Torstein Haugen", "role": "cabin co-owner", "nickname": "Tosse",
         "cadence": 30, "met": "Lyngen", "last_contacted": "2026-11-08T12:00", "last_contacted_kind": "visit"},
        {"key": "hanne", "name": "Hanne Vik", "role": "cabin co-owner", "met": "Lyngen",
         "last_contacted": "2026-10-11T18:00", "last_contacted_kind": "message"},
        # services
        {"key": "ane", "name": "Ane Karlsen", "role": "vet"},
        {"key": "mats", "name": "Mats Lund", "role": "dentist"},
        {"key": "ola", "name": "Ola Bakken", "role": "mechanic", "last_contacted": "2026-10-24T09:00",
         "last_contacted_kind": "visit"},
        # trashed
        {"key": "kristoffer", "name": "Kristoffer Dahl", "role": "old flatmate", "trashed": "2026-10-28T21:00"},
        {"key": "lars", "name": "Lars Moen", "role": "former colleague", "trashed": "2026-06-02T10:00"},
    ]


GROUPS = [
    {"key": "mess", "name": "Crew mess fund", "currency": "NOK",
     "members": ["erik_n", "hallvard", "tor", "svein", "bjorn", "ailo", "linnea", "rune", "marianne"],
     "created": "2025-09-01T12:00"},
    {"key": "cabin", "name": "Lyngen cabin share", "currency": "NOK", "members": ["jonas", "torstein", "hanne"],
     "created": "2024-05-01T12:00"},
    {"key": "climb", "name": "Tromsø climbing club", "currency": "NOK", "members": ["erik_j", "silje", "torstein", "kaja"],
     "created": "2025-01-10T12:00"},
    {"key": "kiel", "name": "Kiel workshop", "currency": "EUR", "members": ["jan", "sofie", "marte"],
     "created": "2026-09-01T10:00"},
    {"key": "abisko", "name": "Abisko ski trip", "currency": "SEK", "members": ["jonas", "erik_j", "kaja"],
     "created": "2026-02-01T10:00"},
    {"key": "whale", "name": "Whale safari", "currency": "NOK", "members": ["silje", "ingvild"],
     "created": "2026-10-20T10:00"},
]

EXPENSES = [
    {"group": "mess", "name": "Coffee and waffles", "amount": 1800, "paid_by": "me",
     "split": ["me", "erik_n", "hallvard", "tor", "svein", "bjorn", "ailo", "linnea", "rune"], "date": "2026-10-15"},
    {"group": "mess", "name": "Birthday cake for Bjørn", "amount": 450, "paid_by": "svein",
     "split": ["me", "svein", "bjorn", "ailo", "linnea"], "date": "2026-10-20"},
    {"group": "mess", "name": "Brown cheese and jam", "amount": 640, "paid_by": "linnea",
     "split": ["me", "linnea", "marianne", "rune"], "date": "2026-10-24"},
    {"group": "mess", "name": "Taco Friday", "amount": 1200, "paid_by": "me",
     "split": ["me", "linnea", "ailo", "marianne"], "date": "2026-10-23"},
    {"group": "cabin", "name": "Firewood delivery", "amount": 3200, "paid_by": "me",
     "split": ["me", "jonas", "torstein", "hanne"], "date": "2026-10-03"},
    {"group": "cabin", "name": "Cabin electricity September", "amount": 1480, "paid_by": "torstein",
     "split": ["me", "jonas", "torstein", "hanne"], "date": "2026-10-01"},
    {"group": "cabin", "name": "New gas bottle", "amount": 560, "paid_by": "hanne",
     "split": ["me", "jonas", "torstein", "hanne"], "date": "2026-09-12"},
    {"group": "climb", "name": "Rope for the club wall", "amount": 2400, "paid_by": "erik_j",
     "split": ["me", "erik_j", "silje", "torstein"], "date": "2026-09-20"},
    {"group": "climb", "name": "Chalk bulk order", "amount": 600, "paid_by": "me",
     "split": ["me", "silje", "kaja"], "date": "2026-10-05"},
    {"group": "kiel", "name": "Hotel in Kiel", "amount": 720, "paid_by": "me", "split": ["me", "jan", "sofie", "marte"],
     "date": "2026-09-18"},
    {"group": "kiel", "name": "Workshop dinner", "amount": 260, "paid_by": "jan", "split": ["me", "jan", "sofie", "marte"],
     "date": "2026-09-19"},
    {"group": "abisko", "name": "Cabin at Abisko", "amount": 6000, "paid_by": "jonas",
     "split": ["me", "jonas", "erik_j", "kaja"], "date": "2026-03-10"},
    {"group": "abisko", "name": "Train tickets", "amount": 1600, "paid_by": "me", "split": ["me", "jonas"],
     "date": "2026-03-08"},
]

LISTS = [
    {"key": "prep_l", "name": "Cruise prep", "area": "work - ship"},
    {"key": "gear_l", "name": "Cruise gear", "area": "work - ship"},
    {"key": "lab_l", "name": "Lab", "area": "work - lab"},
    {"key": "home_l", "name": "Home", "area": "home"},
    {"key": "cabin_l", "name": "Cabin", "area": "cabin share"},
    {"key": "climb_l", "name": "Climbing", "area": "hobby"},
    {"key": "shop_l", "name": "Shopping"},
]


def events():
    out = []
    # bouldering, Tuesdays 18:00 (not while at sea)
    d = date(2026, 9, 1)
    sea = {date(2026, 10, 13), date(2026, 10, 20), date(2026, 10, 27), date(2026, 11, 24), date(2026, 12, 1),
           date(2026, 12, 8)}
    while d <= date(2026, 12, 15):
        if d not in sea:
            ev = {"key": f"boulder_{d.strftime('%m%d')}", "name": "Bouldering night", "start": f"{d}T18:00",
                  "end": f"{d}T20:00", "attendees": ["erik_j", "silje"], "description": "Tromsø Klatresenter"}
            if d == date(2026, 11, 3):
                ev["cancelled"] = "2026-11-02T12:00"
            out.append(ev)
        d += timedelta(weeks=1)
    # lab meeting, Fridays 09:00
    d = date(2026, 9, 4)
    fri_sea = {date(2026, 10, 16), date(2026, 10, 23), date(2026, 10, 30), date(2026, 11, 27), date(2026, 12, 4),
               date(2026, 12, 11)}
    while d <= date(2026, 12, 18):
        if d not in fri_sea:
            out.append({"key": f"labmtg_{d.strftime('%m%d')}", "name": "Plankton group meeting",
                        "start": f"{d}T09:00", "end": f"{d}T10:00", "attendees": ["geir", "marte", "sofie"],
                        "description": "Biology building, room 2.214"})
        d += timedelta(weeks=1)
    # Sunday dinner at Jonas's parents, first Sunday of the month
    for d in (date(2026, 10, 4), date(2026, 11, 1), date(2026, 12, 6)):
        out.append({"key": f"bergs_{d.strftime('%m%d')}", "name": "Dinner at Berit and Knut's",
                    "start": f"{d}T17:00", "end": f"{d}T20:00", "attendees": ["jonas", "berit", "knut"]})
    out += [
        # ship
        {"key": "cruise10_out", "name": "Cruise HV-2610 departure", "start": "2026-10-12T08:00",
         "end": "2026-10-12T09:00", "attendees": ["erik_n", "hallvard", "tor"], "description": "Breivika quay"},
        {"key": "cruise10_back", "name": "Cruise HV-2610 return", "start": "2026-10-30T14:00",
         "end": "2026-10-30T15:00", "attendees": ["erik_n", "hallvard"]},
        {"key": "plan_1111", "name": "Cruise planning meeting", "start": "2026-11-11T13:00", "end": "2026-11-11T14:30",
         "attendees": ["erik_n", "hallvard"], "description": "station list and CTD casts"},
        {"key": "plan_1118", "name": "Cruise planning meeting", "start": "2026-11-18T13:00", "end": "2026-11-18T14:30",
         "attendees": ["erik_n", "hallvard", "tor"], "description": "final sign-off"},
        {"key": "drill", "name": "Safety drill briefing", "start": "2026-11-20T10:30", "end": "2026-11-20T11:30",
         "attendees": ["erik_n", "bjorn"]},
        {"key": "cruise11_out", "name": "Cruise HV-2611 departure", "start": "2026-11-23T08:00",
         "end": "2026-11-23T09:00", "attendees": ["erik_n", "hallvard", "tor", "marianne"], "description": "Breivika quay"},
        {"key": "cruise11_back", "name": "Cruise HV-2611 return", "start": "2026-12-11T14:00",
         "end": "2026-12-11T15:00", "attendees": ["erik_n", "hallvard"]},
        {"key": "survival", "name": "Sea survival refresher", "start": "2026-11-16T08:00", "end": "2026-11-16T16:00",
         "description": "RS Tromsø, bring swimwear"},
        {"key": "debrief", "name": "HV-2610 debrief", "start": "2026-11-02T13:00", "end": "2026-11-02T14:00",
         "attendees": ["hallvard", "tor", "marianne"]},
        # lab and UiT
        {"key": "seminar", "name": "Seminar talk on copepods in the polar night", "start": "2026-11-10T14:15",
         "end": "2026-11-10T15:00", "attendees": ["geir", "marte", "sofie"], "description": "Auditorium 3"},
        {"key": "defence", "name": "Marte's PhD defence", "start": "2026-11-17T10:15", "end": "2026-11-17T13:00",
         "attendees": ["marte", "geir"]},
        {"key": "kiel_call", "name": "Video call with the Kiel group", "start": "2026-11-12T10:00",
         "end": "2026-11-12T11:00", "attendees": ["jan", "sofie"]},
        {"key": "kiel_ws", "name": "Kiel data workshop", "start": "2026-09-17T09:00", "end": "2026-09-17T17:00",
         "attendees": ["jan", "sofie", "marte"]},
        {"key": "julebord", "name": "Institute julebord", "start": "2026-12-12T19:00", "end": "2026-12-12T23:30",
         "attendees": ["geir", "marte", "sofie", "ingvild"]},
        {"key": "lunch_ingvild", "name": "Lunch with Ingvild", "start": "2026-11-10T12:00", "end": "2026-11-10T13:00",
         "attendees": ["ingvild"]},
        {"key": "coffee_halle", "name": "Coffee with Hallvard", "start": "2026-11-04T10:00", "end": "2026-11-04T10:30",
         "attendees": ["hallvard"]},
        # home, Pusur and errands
        {"key": "vet_1112", "name": "Vet check for Pusur", "start": "2026-11-12T16:00", "end": "2026-11-12T16:30",
         "attendees": ["ane"], "description": "limping on the back left paw"},
        {"key": "vet_1215", "name": "Vet vaccination for Pusur", "start": "2026-12-15T16:00", "end": "2026-12-15T16:30",
         "attendees": ["ane"]},
        {"key": "dentist", "name": "Dentist", "start": "2026-11-13T11:00", "end": "2026-11-13T11:45",
         "attendees": ["mats"]},
        {"key": "haircut", "name": "Haircut", "start": "2026-11-12T11:30", "end": "2026-11-12T12:15"},
        {"key": "car_service", "name": "Car service at Bakken", "start": "2026-11-19T08:00", "end": "2026-11-19T09:00",
         "attendees": ["ola"]},
        {"key": "tyres", "name": "Winter tyres fitted", "start": "2026-10-24T09:00", "end": "2026-10-24T10:00",
         "attendees": ["ola"]},
        {"key": "aurora", "name": "Northern lights drive with Jonas", "start": "2026-11-14T21:00",
         "end": "2026-11-14T23:30", "attendees": ["jonas"]},
        {"key": "jonas_bday", "name": "Jonas's birthday dinner", "start": "2026-11-21T19:00", "end": "2026-11-21T22:00",
         "attendees": ["jonas", "berit", "knut", "torstein"], "description": "table for five at Emma's"},
        {"key": "kino", "name": "Cinema with Jonas", "start": "2026-11-11T20:00", "end": "2026-11-11T22:00",
         "attendees": ["jonas"], "cancelled": "2026-11-08T10:00"},
        {"key": "erik_dinner", "name": "Dinner with Erik and Kaja", "start": "2026-11-13T19:00", "end": "2026-11-13T22:00",
         "attendees": ["erik_j", "kaja"]},
        {"key": "sauna", "name": "Harbour sauna with Silje", "start": "2026-11-05T19:00", "end": "2026-11-05T20:30",
         "attendees": ["silje"]},
        {"key": "whale_trip", "name": "Whale safari at Skjervøy", "start": "2026-11-15T09:00", "end": "2026-11-15T15:00",
         "attendees": ["silje", "ingvild"], "cancelled": "2026-11-06T09:00"},
        # climbing and cabin
        {"key": "agm", "name": "Climbing club AGM", "start": "2026-11-19T19:00", "end": "2026-11-19T21:00",
         "attendees": ["erik_j", "silje", "torstein"], "description": "club room, bring the accounts"},
        {"key": "ice", "name": "Ice climbing in Lyngen", "start": "2026-12-13T08:00", "end": "2026-12-13T16:00",
         "attendees": ["erik_j", "torstein"]},
        {"key": "cabin_wknd", "name": "Cabin weekend in Lyngen", "start": "2026-11-07T10:00", "end": "2026-11-08T16:00",
         "attendees": ["jonas", "torstein"]},
        {"key": "cabin_meeting", "name": "Cabin share meeting", "start": "2026-11-26T19:00", "end": "2026-11-26T20:00",
         "attendees": ["jonas", "torstein", "hanne"], "description": "on video from the ship"},
        # family, travel
        {"key": "flight_bodo", "name": "Flight to Bodø", "start": "2026-12-20T12:00", "end": "2026-12-20T12:55",
         "description": "WF 931"},
        {"key": "christmas", "name": "Christmas in Bodø", "start": "2026-12-24T15:00", "end": "2026-12-24T22:00",
         "attendees": ["mum", "dad", "anders", "jonas"]},
        {"key": "mum_call", "name": "Call with Mamma", "start": "2026-11-15T18:00", "end": "2026-11-15T18:30",
         "attendees": ["mum"]},
        {"key": "anders_visit", "name": "Anders visiting", "start": "2026-11-28T12:00", "end": "2026-11-28T18:00",
         "attendees": ["anders"], "cancelled": "2026-11-05T20:00"},
        # trashed
        {"key": "yoga", "name": "Yoga taster class", "start": "2026-11-16T18:00", "end": "2026-11-16T19:00",
         "trashed": "2026-11-01T10:00"},
        {"key": "bookclub", "name": "Book club", "start": "2026-09-24T19:00", "end": "2026-09-24T21:00",
         "attendees": ["ingvild"], "trashed": "2026-09-10T10:00"},
    ]
    return out


def tasks():
    t = [
        # cruise prep
        {"key": "nets", "name": "Pack plankton nets", "due": "2026-11-20", "effort": 60, "list": "prep_l"},
        {"key": "ctd", "name": "Calibrate CTD sensors", "due": "2026-11-19", "effort": 240, "status": "in_progress",
         "list": "prep_l"},
        {"key": "formalin", "name": "Order formalin", "due": "2026-11-12", "effort": 20, "priority": 1, "list": "prep_l",
         "description": "2 x 5 litres from Chemtrade"},
        {"key": "cruise_plan", "name": "Submit cruise plan", "due": "2026-11-16T12:00", "effort": 90, "priority": 1,
         "list": "prep_l", "description": "send to Hallvard and the captain"},
        {"key": "freezer", "name": "Book sample freezer space", "due": "2026-11-17", "effort": 15, "list": "prep_l"},
        {"key": "crew_list", "name": "Update crew list", "due": "2026-11-18", "effort": 30, "list": "prep_l"},
        {"key": "med_old", "name": "Renew seafarer medical", "due": "2026-10-01", "completed": "2026-09-28T11:00",
         "list": "prep_l"},
        {"key": "med_new", "name": "Renew seafarer medical", "due": "2027-09-28", "effort": 60, "list": "prep_l"},
        # cruise gear
        {"key": "gloves", "name": "Buy thermal gloves", "due": "2026-11-15", "effort": 30, "list": "gear_l"},
        {"key": "jars", "name": "Label sample jars", "due": "2026-11-20", "effort": 120, "list": "gear_l"},
        {"key": "suit", "name": "Check the immersion suit fits", "due": "2026-11-16", "effort": 20, "list": "gear_l"},
        {"key": "boots", "name": "Resole deck boots", "due": "2026-10-10", "completed": "2026-10-09T15:00",
         "list": "gear_l"},
        # lab
        {"key": "copepods", "name": "Analyse copepod samples from HV-2610", "due": "2026-12-18", "effort": 600,
         "status": "in_progress", "priority": 2, "list": "lab_l"},
        {"key": "report", "name": "Write cruise report HV-2610", "due": "2026-11-13", "effort": 300, "priority": 1,
         "list": "lab_l"},
        {"key": "ctd_profiles", "name": "Compile CTD profiles", "parent": "report", "due": "2026-11-11", "effort": 120},
        {"key": "station_log", "name": "Draft station log summary", "parent": "report", "due": "2026-11-12", "effort": 60},
        {"key": "send_report", "name": "Send report to Hallvard", "parent": "report", "due": "2026-11-13", "effort": 10},
        {"key": "marte_ch", "name": "Review Marte's thesis chapter", "due": "2026-11-12", "effort": 180, "list": "lab_l"},
        {"key": "abstract", "name": "Submit abstract to Ocean Sciences", "due": "2026-10-02",
         "completed": "2026-10-01T22:00", "list": "lab_l"},
        {"key": "bulb", "name": "Order microscope bulb", "due": "2026-11-05", "completed": "2026-11-04T09:30",
         "list": "lab_l"},
        {"key": "kiel_reply", "name": "Reply to Jan about data sharing", "due": "2026-11-10", "effort": 20,
         "list": "lab_l"},
        {"key": "slides", "name": "Prepare seminar slides", "due": "2026-11-10T12:00", "effort": 180, "priority": 1,
         "status": "in_progress", "list": "lab_l"},
        {"key": "inventory", "name": "Update lab inventory", "status": "cancelled", "list": "lab_l"},
        {"key": "claim", "name": "Travel claim for HV-2610", "due": "2026-11-20", "effort": 45, "list": "lab_l",
         "description": "receipts are in the blue envelope"},
        {"key": "data_upload", "name": "Upload HV-2610 CTD data to the archive", "due": "2026-11-27", "effort": 60,
         "list": "lab_l"},
        # home
        {"key": "cat_food", "name": "Buy cat food for Pusur", "due": "2026-11-10", "effort": 15, "list": "home_l"},
        {"key": "vet_book", "name": "Book vet for Pusur's vaccination", "due": "2026-10-05",
         "completed": "2026-10-04T12:00", "list": "home_l"},
        {"key": "tap", "name": "Fix the bathroom tap", "due": "2026-11-15", "effort": 60, "list": "home_l"},
        {"key": "tyres_task", "name": "Change to winter tyres", "due": "2026-10-25", "completed": "2026-10-24T10:00",
         "list": "home_l"},
        {"key": "gutters", "name": "Clear the gutters", "status": "cancelled", "list": "home_l"},
        {"key": "insurance", "name": "Renew home insurance", "due": "2026-12-01", "effort": 30, "priority": 2,
         "list": "home_l"},
        {"key": "plants", "name": "Ask Jonas to water the plants", "due": "2026-11-22", "effort": 5, "list": "home_l"},
        {"key": "snow_shovel", "name": "Buy a new snow shovel", "due": "2026-11-14", "effort": 20, "list": "home_l"},
        # cabin
        {"key": "firewood", "name": "Order firewood for the cabin", "due": "2026-11-14", "effort": 30, "list": "cabin_l"},
        {"key": "hinge", "name": "Fix the cabin door hinge", "effort": 90, "list": "cabin_l"},
        {"key": "xmas_cabin", "name": "Book the cabin for New Year", "due": "2026-11-30", "effort": 10, "list": "cabin_l"},
        {"key": "cabin_el_09", "name": "Pay cabin electricity", "due": "2026-09-25", "completed": "2026-09-24T19:00",
         "list": "cabin_l"},
        {"key": "cabin_el_10", "name": "Pay cabin electricity", "due": "2026-10-25", "completed": "2026-10-26T08:00",
         "list": "cabin_l"},
        {"key": "cabin_el_11", "name": "Pay cabin electricity", "due": "2026-11-25", "effort": 10, "list": "cabin_l"},
        # climbing
        {"key": "rope", "name": "Retire the old rope", "due": "2026-11-15", "effort": 10, "list": "climb_l"},
        {"key": "screws", "name": "Buy new ice screws", "due": "2026-12-01", "effort": 30, "list": "climb_l"},
        {"key": "agenda", "name": "Write the AGM agenda", "due": "2026-11-17", "effort": 60, "priority": 2,
         "list": "climb_l"},
        {"key": "club_fee", "name": "Pay climbing club fee", "due": "2026-09-15", "completed": "2026-09-14T20:00",
         "list": "climb_l"},
        {"key": "belay", "name": "Return belay device to Erik", "effort": 5, "list": "climb_l"},
        # shopping
        {"key": "socks", "name": "Buy wool socks", "effort": 20, "list": "shop_l"},
        {"key": "batteries", "name": "Buy headlamp batteries", "due": "2026-11-20", "effort": 10, "list": "shop_l"},
        {"key": "present", "name": "Buy birthday present for Jonas", "due": "2026-11-19", "effort": 60, "priority": 1,
         "list": "shop_l"},
        # unlisted
        {"key": "call_mum", "name": "Call Mamma about Christmas", "due": "2026-11-11", "effort": 15},
        {"key": "passport", "name": "Renew passport", "due": "2027-02-01", "effort": 60, "priority": 3},
        {"key": "flights", "name": "Book flights to Bodø", "due": "2026-10-20", "completed": "2026-10-19T21:00"},
        {"key": "photos_silje", "name": "Send the sauna photos to Silje", "effort": 10},
        {"key": "halle_book", "name": "Give Hallvard his book back", "effort": 5},
        {"key": "sami", "name": "Learn Sámi basics", "trashed": "2026-10-25T10:00"},
        {"key": "kayak", "name": "Sell the old kayak", "due": "2026-07-01", "trashed": "2026-08-01T10:00"},
        {"key": "chains", "name": "Buy snow chains", "due": "2026-11-12", "effort": 30, "trashed": "2026-11-02T18:00"},
    ]
    # electricity at home, monthly on the 20th
    for m in (8, 9, 10):
        t.append({"key": f"power_{m:02d}", "name": "Pay the power bill", "due": f"2026-{m:02d}-20",
                  "completed": f"2026-{m:02d}-19T20:00", "list": "home_l"})
    t.append({"key": "power_11", "name": "Pay the power bill", "due": "2026-11-20", "effort": 10, "list": "home_l"})
    return t


NOTEBOOKS = [
    {"key": "cruise_nb", "name": "Cruise log HV-2610"},
    {"key": "methods_nb", "name": "Lab methods"},
    {"key": "routes_nb", "name": "Climbing routes"},
    {"key": "galley_nb", "name": "Galley recipes"},
    {"key": "cabin_nb", "name": "Cabin book"},
    {"key": "reading_nb", "name": "Reading notes"},
]

NOTES = [
    {"key": "st12", "name": "Station 12 net haul", "body": "Calanus finmarchicus dominant, 180 m, ice edge",
     "notebook": "cruise_nb", "created": "2026-10-17T03:40", "pinned": True},
    {"key": "st19", "name": "Station 19 CTD cast", "body": "cast aborted at 400 m, winch fault, Tor fixed it",
     "notebook": "cruise_nb", "created": "2026-10-21T11:15"},
    {"key": "storm", "name": "Storm day off Bjørnøya", "body": "no sampling, everyone seasick, Svein made lapskaus",
     "notebook": "cruise_nb", "created": "2026-10-24T20:00"},
    {"key": "ice_edge", "name": "Ice edge observations", "body": "polar cod under the floes, two ivory gulls",
     "notebook": "cruise_nb", "created": "2026-10-26T14:30"},
    {"key": "fixation", "name": "Formalin fixation protocol", "body": "4 percent buffered, 1 part sample to 9",
     "notebook": "methods_nb", "created": "2026-03-10T10:00", "pinned": True},
    {"key": "subsample", "name": "Folsom splitter subsampling", "body": "split until about 200 copepods per aliquot",
     "notebook": "methods_nb", "created": "2026-05-04T09:00"},
    {"key": "lipid", "name": "Lipid sac measurements", "body": "photograph lateral, measure in ImageJ",
     "notebook": "methods_nb", "created": "2026-11-05T15:20"},
    {"key": "kvaloya", "name": "Kvaløya crag", "body": "north face stays wet until June, 6a slab is great",
     "notebook": "routes_nb", "created": "2026-06-14T21:00"},
    {"key": "lyngen_ice", "name": "Lyngen ice lines", "body": "Blåisen WI3, check avalanche forecast",
     "notebook": "routes_nb", "created": "2026-11-06T22:10"},
    {"key": "lapskaus", "name": "Svein's lapskaus", "body": "salted beef, potatoes, swede, cook three hours",
     "notebook": "galley_nb", "created": "2026-10-25T18:00"},
    {"key": "waffles", "name": "Ship waffles", "body": "cardamom, sour cream, brown cheese on top",
     "notebook": "galley_nb", "created": "2026-10-16T16:00", "pinned": True},
    {"key": "woodstove", "name": "Wood stove tips", "body": "open the damper fully before lighting",
     "notebook": "cabin_nb", "created": "2025-12-28T12:00"},
    {"key": "cabin_rules", "name": "Cabin rota", "body": "Jonas and I have weeks 1 and 3, Torstein 2, Hanne 4",
     "notebook": "cabin_nb", "created": "2026-01-15T20:00"},
    {"key": "arctic_book", "name": "The Arctic Ocean book notes", "body": "chapter 4 on the Atlantic inflow",
     "notebook": "reading_nb", "created": "2026-09-02T22:00"},
    {"key": "seminar_notes", "name": "Seminar outline", "body": "diel migration stops in the polar night, three slides",
     "created": "2026-11-06T16:00"},
    {"key": "gift_ideas", "name": "Gift ideas for Jonas", "body": "new headtorch, a print by Karl Erik Harr",
     "created": "2026-11-01T22:30"},
    {"key": "pusur_note", "name": "Pusur's limp", "body": "started Friday, back left paw, eating fine",
     "created": "2026-11-08T09:00"},
    {"key": "christmas_note", "name": "Christmas plans", "body": "Bodø from the 20th, Jonas joins on the 23rd",
     "created": "2026-10-30T21:00"},
    {"key": "kiel_note", "name": "Kiel data sharing", "body": "Jan wants the zooplankton counts by December",
     "created": "2026-10-08T16:30"},
    {"key": "cruise_plan_note", "name": "HV-2611 station ideas", "body": "repeat stations 12 to 19, add a night series",
     "created": "2026-11-04T11:00"},
    {"key": "agm_note", "name": "AGM points", "body": "new rope fund, youth sessions, treasurer handover",
     "created": "2026-11-03T21:30"},
    {"key": "debrief_note", "name": "Debrief notes", "body": "winch fault, freezer alarm, too few night stations",
     "created": "2026-11-02T14:10"},
    {"key": "wishlist", "name": "Gear wishlist", "created": "2026-10-02T20:00"},
    {"key": "old_draft", "name": "Old abstract draft", "body": "first version, too long", "created": "2026-09-20T10:00",
     "trashed": "2026-10-20T10:00"},
    {"key": "old_packing", "name": "Packing list 2025", "body": "thermals, seasick pills, headlamp",
     "created": "2025-09-01T10:00", "trashed": "2026-07-15T10:00"},
]

FOLDERS = [
    {"key": "certs_f", "name": "Ship certificates"},
    {"key": "reports_f", "name": "Cruise reports"},
    {"key": "cabin_f", "name": "Cabin share"},
    {"key": "home_f", "name": "Home and car"},
    {"key": "pay_f", "name": "Pay and tax"},
    {"key": "kiel_f", "name": "Kiel project"},
    {"key": "apps_f", "name": "Old applications"},
    {"key": "scans_f", "name": "Scans to sort"},
]

DOCUMENTS = [
    {"key": "medical_cert", "name": "Seafarer medical certificate", "folder": "certs_f", "starred": True,
     "created": "2025-09-28T11:30"},
    {"key": "survival_cert", "name": "Sea survival certificate", "folder": "certs_f", "created": "2022-11-20T15:00"},
    {"key": "stcw", "name": "STCW basic safety training", "folder": "certs_f", "starred": True,
     "created": "2022-11-21T09:00"},
    {"key": "report_09", "name": "Cruise report HV-2609", "folder": "reports_f", "created": "2026-09-30T16:00"},
    {"key": "report_10", "name": "Cruise report HV-2610 draft", "folder": "reports_f", "created": "2026-11-06T17:30"},
    {"key": "cabin_agreement", "name": "Cabin share agreement", "folder": "cabin_f", "starred": True,
     "created": "2024-05-02T10:00"},
    {"key": "cabin_invoice", "name": "Cabin electricity invoice October", "folder": "cabin_f",
     "created": "2026-11-02T08:00"},
    {"key": "car_ins", "name": "Car insurance 2026", "folder": "home_f", "created": "2026-01-03T10:00"},
    {"key": "home_ins", "name": "Home insurance policy", "folder": "home_f", "starred": True,
     "created": "2025-12-01T10:00"},
    {"key": "tax", "name": "Tax return 2025", "folder": "pay_f", "created": "2026-04-28T21:00"},
    {"key": "pay_oct", "name": "Payslip October", "folder": "pay_f", "created": "2026-10-31T08:00"},
    {"key": "pay_sep", "name": "Payslip September", "folder": "pay_f", "created": "2026-09-30T08:00"},
    {"key": "kiel_dsa", "name": "Kiel data sharing agreement", "folder": "kiel_f", "created": "2026-10-08T17:00"},
    {"key": "vaccine_card", "name": "Pusur vaccination card", "starred": True, "created": "2026-03-02T12:00"},
    {"key": "passport_scan", "name": "Passport scan", "created": "2025-02-10T10:00"},
    {"key": "tyre_receipt", "name": "Tyre hotel receipt", "created": "2026-11-08T17:45"},
    {"key": "plan_v1", "name": "Cruise plan HV-2611 v1", "created": "2026-10-31T11:00", "trashed": "2026-11-04T10:00"},
    {"key": "old_cv", "name": "CV 2023", "created": "2023-01-10T10:00", "trashed": "2026-06-30T10:00"},
]

ALBUMS = [
    {"key": "cruise_al", "name": "HV-2610 at sea"},
    {"key": "aurora_al", "name": "Northern lights"},
    {"key": "pusur_al", "name": "Pusur"},
    {"key": "climb_al", "name": "Climbing 2026"},
    {"key": "cabin_al", "name": "Lyngen cabin"},
    {"key": "best_al", "name": "Best of 2026"},
    {"key": "xmas_al", "name": "Christmas 2026"},
]

PHOTOS = [
    {"key": "p_ice_edge", "name": "Ice edge at dawn", "taken": "2026-10-26T08:30", "albums": ["cruise_al", "best_al"],
     "starred": True},
    {"key": "p_net", "name": "Net coming up at station 12", "taken": "2026-10-17T03:30", "albums": ["cruise_al"],
     "people": ["ailo", "bjorn"]},
    {"key": "p_copepod", "name": "Calanus under the microscope", "taken": "2026-10-18T14:00",
     "albums": ["cruise_al", "best_al"], "starred": True},
    {"key": "p_crew", "name": "Crew photo on the helideck", "taken": "2026-10-29T12:00", "albums": ["cruise_al"],
     "people": ["erik_n", "hallvard", "tor", "svein", "bjorn", "ailo", "linnea", "rune", "marianne"], "starred": True},
    {"key": "p_galley", "name": "Svein in the galley", "taken": "2026-10-25T17:30", "albums": ["cruise_al"],
     "people": ["svein"]},
    {"key": "p_winch", "name": "Tor fixing the winch", "taken": "2026-10-21T12:00", "albums": ["cruise_al"],
     "people": ["tor"]},
    {"key": "p_walrus", "name": "Walrus on the floe", "taken": "2026-10-26T15:10", "albums": ["cruise_al"]},
    {"key": "p_aurora1", "name": "Aurora over Kvaløya", "taken": "2026-11-01T22:40", "albums": ["aurora_al", "best_al"],
     "people": ["jonas"], "starred": True},
    {"key": "p_aurora2", "name": "Green aurora from the ship", "taken": "2026-10-22T23:50", "albums": ["aurora_al"]},
    {"key": "p_aurora3", "name": "Aurora at the cabin", "taken": "2026-11-07T23:15", "albums": ["aurora_al", "cabin_al"],
     "people": ["jonas", "torstein"]},
    {"key": "p_pusur_box", "name": "Pusur in the sample box", "taken": "2026-11-01T10:00", "albums": ["pusur_al", "best_al"],
     "starred": True},
    {"key": "p_pusur_window", "name": "Pusur watching the snow", "taken": "2026-11-06T09:20", "albums": ["pusur_al"]},
    {"key": "p_pusur_vet", "name": "Pusur at the vet", "taken": "2026-03-02T11:40", "albums": ["pusur_al"]},
    {"key": "p_pusur_jonas", "name": "Pusur asleep on Jonas", "taken": "2026-10-31T21:00", "albums": ["pusur_al"],
     "people": ["jonas"]},
    {"key": "p_boulder", "name": "Silje on the yellow problem", "taken": "2026-11-05T18:40", "albums": ["climb_al"],
     "people": ["silje"]},
    {"key": "p_kvaloya", "name": "Erik leading on Kvaløya", "taken": "2026-06-14T15:00", "albums": ["climb_al", "best_al"],
     "people": ["erik_j"], "starred": True},
    {"key": "p_summit", "name": "Summit of Store Blåmann", "taken": "2026-07-19T13:30", "albums": ["climb_al"],
     "people": ["erik_j", "kaja"]},
    {"key": "p_cabin_snow", "name": "Cabin in the first snow", "taken": "2026-11-07T11:00", "albums": ["cabin_al"]},
    {"key": "p_woodpile", "name": "Firewood stacked", "taken": "2026-10-04T14:00", "albums": ["cabin_al"],
     "people": ["torstein"]},
    {"key": "p_sauna", "name": "Harbour sauna", "taken": "2026-11-05T20:15", "people": ["silje"]},
    {"key": "p_abisko", "name": "Abisko tracks", "taken": "2026-03-11T12:00", "people": ["jonas", "erik_j", "kaja"],
     "starred": True},
    {"key": "p_seminar", "name": "Seminar title slide", "taken": "2026-11-06T16:30"},
    {"key": "p_receipt", "name": "Taco Friday receipt", "taken": "2026-10-23T19:00"},
    {"key": "p_ctd", "name": "CTD rosette on deck", "taken": "2026-10-19T07:00"},
    {"key": "p_kiel", "name": "Kiel harbour", "taken": "2026-09-18T18:00", "people": ["jan", "sofie"]},
    {"key": "p_mum", "name": "Mamma's kitchen in Bodø", "taken": "2026-08-10T12:00", "people": ["mum"]},
    {"key": "p_tyres", "name": "Tyre hotel ticket", "taken": "2026-10-24T09:30"},
    {"key": "p_gull", "name": "Ivory gull", "taken": "2026-10-26T14:40", "albums": ["cruise_al"], "starred": True},
    {"key": "p_marte", "name": "Marte with her poster", "taken": "2026-09-17T15:00", "people": ["marte"]},
    {"key": "p_fjord", "name": "Balsfjord at noon", "taken": "2026-11-08T12:10"},
    {"key": "p_blurry", "name": "Blurry aurora", "taken": "2026-11-01T22:35", "albums": ["aurora_al"],
     "trashed": "2026-11-02T09:00"},
    {"key": "p_seasick", "name": "Seasick selfie", "taken": "2026-10-24T11:00", "trashed": "2026-10-25T10:00"},
    {"key": "p_old_flat", "name": "Old flat in Breivika", "taken": "2024-05-01T12:00", "trashed": "2026-07-01T10:00"},
    {"key": "p_dup_crew", "name": "Crew photo duplicate", "taken": "2026-10-29T12:01", "people": ["erik_n", "hallvard"],
     "trashed": "2026-10-30T20:00"},
]

DEBTS = [
    {"key": "d_jonas_groceries", "person": "jonas", "direction": "i_owe", "amount": 640, "name": "Groceries at Rema",
     "date": "2026-11-06"},
    {"key": "d_erik_j", "person": "erik_j", "direction": "owes_me", "amount": 350, "name": "Ice screws half",
     "date": "2026-10-04"},
    {"key": "d_silje", "person": "silje", "direction": "owes_me", "amount": 180, "name": "Sauna tickets",
     "date": "2026-11-05"},
    {"key": "d_torstein", "person": "torstein", "direction": "i_owe", "amount": 420, "name": "Ferry to Lyngen",
     "date": "2026-11-07"},
    {"key": "d_marianne", "person": "marianne", "direction": "owes_me", "amount": 250, "name": "Sample vials",
     "date": "2026-10-28"},
    {"key": "d_hallvard", "person": "hallvard", "direction": "i_owe", "amount": 95, "name": "Coffee beans",
     "date": "2026-11-04"},
    {"key": "d_anders", "person": "anders", "direction": "owes_me", "amount": 1200, "name": "Concert tickets",
     "date": "2026-08-20"},
    {"key": "d_ingvild", "person": "ingvild", "direction": "owes_me", "amount": 160, "name": "Lunch",
     "date": "2026-10-21", "settled": "2026-10-28T12:00"},
    {"key": "d_kaja", "person": "kaja", "direction": "i_owe", "amount": 300, "name": "Headtorch",
     "date": "2026-10-02"},
    {"key": "d_linnea", "person": "linnea", "direction": "owes_me", "amount": 75, "name": "Seasick pills",
     "date": "2026-10-24"},
    {"key": "d_mum", "person": "mum", "direction": "i_owe", "amount": 2000, "name": "Flights to Bodø",
     "date": "2026-10-19"},
    {"key": "d_tor", "person": "tor", "direction": "owes_me", "amount": 110, "name": "Pizza on the quay",
     "date": "2026-10-30", "settled": "2026-11-02T10:00"},
    {"key": "d_jonas_vet", "person": "jonas", "direction": "owes_me", "amount": 450, "name": "Half of the vet bill",
     "date": "2026-03-02"},
]

LOCKER = [
    {"key": "uit_login", "name": "UiT login", "type": "login", "username": "iso004", "url": "https://uit.no",
     "password": "Calanus-Hyperboreus-7", "starred": True},
    {"key": "cruise_portal", "name": "Cruise planning portal", "type": "login", "username": "ingrid.solberg",
     "url": "https://cruise.havella.no", "password": "Breivika-quay-23"},
    {"key": "visa", "name": "DNB Visa", "type": "card", "card_number": "4925 1180 6612 3047", "cvv": "338",
     "starred": True},
    {"key": "mastercard", "name": "Sparebank Mastercard", "type": "card", "card_number": "5413 7702 9981 2260",
     "cvv": "061"},
    {"key": "cabin_code", "name": "Cabin key box code", "type": "note", "notes": "key box behind the woodshed, 7731"},
    {"key": "id_number", "name": "National ID number", "type": "identity"},
    {"key": "home_wifi", "name": "Home wifi", "type": "wifi", "password": "pusur-sover-mye"},
    {"key": "lab_pc", "name": "Ship lab PC", "type": "password", "password": "Winch-fault-19"},
    {"key": "saga_key", "name": "Saga cluster key", "type": "ssh_key", "notes": "ed25519, laptop only"},
    {"key": "copernicus", "name": "Copernicus Marine API", "type": "api_credential", "code": "cmems-88f2-ingrid",
     "notes": "for sea ice charts"},
    {"key": "passport_l", "name": "Norwegian passport", "type": "passport", "notes": "expires May 2027"},
    {"key": "dnb_account", "name": "DNB current account", "type": "bank_account", "notes": "salary goes here"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence", "notes": "class B and BE"},
    {"key": "matlab", "name": "MATLAB licence", "type": "software_licence", "code": "ML-40228-UIT",
     "notes": "university campus licence"},
    {"key": "btc", "name": "Old Bitcoin wallet", "type": "crypto_wallet", "notes": "tiny amount from 2021"},
    {"key": "dnt", "name": "DNT membership", "type": "membership", "notes": "member 4471902", "starred": True},
    {"key": "club_card", "name": "Climbing club membership", "type": "membership", "notes": "wall access card 118"},
    {"key": "boat_licence", "name": "Boat licence", "type": "document", "notes": "båtførerbevis scan"},
    {"key": "old_netflix", "name": "Netflix", "type": "login", "username": "ingrid.s@gmail.com",
     "url": "https://netflix.com", "password": "fjord-films-2", "trashed": "2026-10-30T10:00"},
    {"key": "old_tinder", "name": "Old Strava login", "type": "login", "username": "ingrid_climbs",
     "url": "https://strava.com", "password": "lyngen-alps", "trashed": "2026-07-20T10:00"},
]

LINKS = [
    {"from": "nets", "to": "hallvard"},
    {"from": "ctd", "to": "tor"},
    {"from": "ctd", "to": "hallvard"},
    {"from": "cruise_plan", "to": "hallvard"},
    {"from": "cruise_plan", "to": "erik_n"},
    {"from": "crew_list", "to": "erik_n"},
    {"from": "freezer", "to": "tor"},
    {"from": "send_report", "to": "hallvard"},
    {"from": "marte_ch", "to": "marte"},
    {"from": "kiel_reply", "to": "jan"},
    {"from": "data_upload", "to": "jan"},
    {"from": "tap", "to": "jonas"},
    {"from": "plants", "to": "jonas"},
    {"from": "firewood", "to": "torstein"},
    {"from": "hinge", "to": "torstein"},
    {"from": "xmas_cabin", "to": "hanne"},
    {"from": "xmas_cabin", "to": "torstein"},
    {"from": "agenda", "to": "erik_j"},
    {"from": "agenda", "to": "silje"},
    {"from": "belay", "to": "erik_j"},
    {"from": "present", "to": "jonas"},
    {"from": "call_mum", "to": "mum"},
    {"from": "photos_silje", "to": "silje"},
    {"from": "halle_book", "to": "hallvard"},
    {"from": "st12", "to": "ailo"},
    {"from": "st19", "to": "tor"},
    {"from": "storm", "to": "svein"},
    {"from": "lapskaus", "to": "svein"},
    {"from": "cabin_rules", "to": "jonas"},
    {"from": "cabin_rules", "to": "torstein"},
    {"from": "cabin_rules", "to": "hanne"},
    {"from": "lyngen_ice", "to": "erik_j"},
    {"from": "gift_ideas", "to": "jonas"},
    {"from": "christmas_note", "to": "mum"},
    {"from": "christmas_note", "to": "jonas"},
    {"from": "kiel_note", "to": "jan"},
    {"from": "cruise_plan_note", "to": "hallvard"},
    {"from": "agm_note", "to": "erik_j"},
    {"from": "debrief_note", "to": "hallvard"},
    {"from": "debrief_note", "to": "tor"},
    {"from": "pusur_note", "to": "ane"},
]


def world():
    return {
        "me": "Ingrid Solberg",
        "epoch": "2024-01-05T09:00",
        "seed": "T15",
        "currency": "NOK",
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
        f = datetime.fromisoformat(e["end"]) if e.get("end") else (
            s + timedelta(hours=1) if "T" in e["start"] else s + timedelta(days=1))
        spans.append((s, f, e["key"]))
    spans.sort()
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
    allkeys = [r["key"] for sec in ("people", "groups", "lists", "events", "tasks", "notebooks", "notes", "folders",
                                    "documents", "albums", "photos", "debts", "locker") for r in w[sec]]
    dup = {k for k in allkeys if allkeys.count(k) > 1}
    assert not dup, dup
    out = HERE / "T15.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
