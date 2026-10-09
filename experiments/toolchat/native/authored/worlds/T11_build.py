"""World T11: Siobhan Kelly, dairy farmer outside Ennis, County Clare (EUR vault).

    python3 authored/worlds/T11_build.py      # writes authored/worlds/T11.json (deterministic)

Today in the sessions is Sunday 2026-07-26 07:30 (after morning milking). Married to Declan,
three kids (Aoife 14, Cian 11, Roisin 7); PJ is her father-in-law, Mam is her own mother. On the
mart co-op board, secretary-ish on the GAA club committee, in the school parents group; the vet
(Fergal Moloney), the silage contractor (Sean Mahon) and the creamery milk rep (Liam O'Dea) run
through the calendar. Built-in ambiguity: two Seans (Sean Mahon the contractor, Sean Hehir the
club chairman), two Marys (Mary Lynch from the parents group, Mary Considine next door), nicknames
(Mam, PJ, Tadhgie, the vet), a misspelled-looking name (Deirdre Quinlivan), two GAA groups, two
"Silage bales" debts, the TB test and its reading, two "Ring the vet" tasks, monthly dairy-nut
orders and ESB bills, cancelled events, completed tasks, trashed rows inside and past the 30-day
restore window, an empty group, an empty folder and an empty notebook.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        {"key": "declan", "name": "Declan Kelly", "role": "husband", "starred": True,
         "last_contacted": "2026-07-25T21:00", "last_contacted_kind": "call"},
        {"key": "aoife", "name": "Aoife Kelly", "role": "daughter, 14"},
        {"key": "cian", "name": "Cian Kelly", "role": "son, 11"},
        {"key": "roisin", "name": "Roisin Kelly", "role": "daughter, 7"},
        {"key": "mam", "name": "Bridget Nolan", "role": "mother", "nickname": "Mam", "cadence": 3, "starred": True,
         "met": "Kilrush", "last_contacted": "2026-07-23T18:00", "last_contacted_kind": "call"},
        {"key": "pj", "name": "Patrick Kelly", "role": "father-in-law", "nickname": "PJ", "cadence": 7,
         "last_contacted": "2026-07-25T19:00", "last_contacted_kind": "visit"},
        {"key": "noreen", "name": "Noreen Kelly", "role": "sister-in-law", "cadence": 14, "met": "Ennis",
         "last_contacted": "2026-07-10T11:00", "last_contacted_kind": "coffee"},
        {"key": "fergal", "name": "Fergal Moloney", "role": "vet", "nickname": "the vet", "met": "Ennis mart",
         "cadence": 30, "last_contacted": "2026-07-10T09:30", "last_contacted_kind": "visit"},
        {"key": "sean_m", "name": "Sean Mahon", "role": "silage contractor", "cadence": 30, "met": "Clarecastle",
         "last_contacted": "2026-07-12T20:00", "last_contacted_kind": "call"},
        {"key": "sean_h", "name": "Sean Hehir", "role": "GAA club chairman", "cadence": 14,
         "last_contacted": "2026-07-07T21:30", "last_contacted_kind": "meeting"},
        {"key": "eileen", "name": "Eileen Frawley", "role": "GAA club treasurer", "cadence": 14,
         "last_contacted": "2026-07-19T21:30", "last_contacted_kind": "message"},
        {"key": "tadhg", "name": "Tadhg Moroney", "role": "U12 coach", "nickname": "Tadhgie", "cadence": 7,
         "last_contacted": "2026-07-22T20:05", "last_contacted_kind": "message"},
        {"key": "mary_l", "name": "Mary Lynch", "role": "parents group chair", "met": "school gate", "cadence": 30,
         "last_contacted": "2026-06-15T21:00", "last_contacted_kind": "meeting"},
        {"key": "mary_c", "name": "Mary Considine", "role": "neighbour", "cadence": 7,
         "last_contacted": "2026-07-24T12:00", "last_contacted_kind": "visit"},
        {"key": "mick", "name": "Mick Considine", "role": "neighbour, farmer", "cadence": 14,
         "last_contacted": "2026-07-14T19:00", "last_contacted_kind": "visit"},
        {"key": "niamh", "name": "Niamh Daly", "role": "school principal", "met": "school"},
        {"key": "clodagh", "name": "Clodagh Barry", "role": "parents group", "met": "school gate", "cadence": 30,
         "last_contacted": "2026-06-20T10:00", "last_contacted_kind": "coffee"},
        {"key": "tom", "name": "Tom Keane", "role": "mart manager", "met": "Ennis mart", "cadence": 30,
         "last_contacted": "2026-07-16T15:00", "last_contacted_kind": "meeting"},
        {"key": "gerry", "name": "Gerry Mulqueen", "role": "co-op board", "met": "co-op AGM", "cadence": 60,
         "last_contacted": "2026-05-20T20:00", "last_contacted_kind": "meeting"},
        {"key": "liam", "name": "Liam O'Dea", "role": "creamery milk rep", "cadence": 30,
         "last_contacted": "2026-06-30T10:00", "last_contacted_kind": "call"},
        {"key": "orla", "name": "Orla Garvey", "role": "Teagasc adviser", "met": "discussion group", "cadence": 60,
         "last_contacted": "2026-07-23T13:00", "last_contacted_kind": "meeting"},
        {"key": "ger", "name": "Ger Hogan", "role": "relief milker", "cadence": 14,
         "last_contacted": "2026-07-20T06:00", "last_contacted_kind": "visit"},
        {"key": "pat", "name": "Pat Linnane", "role": "hoof trimmer"},
        {"key": "kevin", "name": "Kevin Burke", "role": "AI technician", "cadence": 30,
         "last_contacted": "2026-06-05T08:00", "last_contacted_kind": "visit"},
        {"key": "martin", "name": "Martin Clancy", "role": "fencing contractor"},
        {"key": "brendan", "name": "Brendan Tierney", "role": "accountant", "met": "Ennis", "cadence": 90,
         "last_contacted": "2026-04-28T11:00", "last_contacted_kind": "meeting"},
        {"key": "deirdre", "name": "Deirdre Quinlivan", "role": "AIB business adviser", "cadence": 90,
         "last_contacted": "2026-07-21T12:00", "last_contacted_kind": "meeting"},
        {"key": "aisling", "name": "Aisling Casey", "role": "GP", "met": "Ennis"},
        {"key": "joe", "name": "Joe Griffin", "role": "farm insurance broker"},
        {"key": "emer", "name": "Emer Keating", "role": "orthodontist"},
        {"key": "tony", "name": "Tony Egan", "role": "hay buyer", "trashed": "2026-07-08T10:00"},
        {"key": "frank", "name": "Frank Mescall", "role": "old milk tester", "trashed": "2026-05-02T10:00"},
    ]


GROUPS = [
    {"key": "lotto", "name": "GAA club lotto", "members": ["sean_h", "eileen", "tadhg"], "created": "2025-09-01T20:00"},
    {"key": "juvenile", "name": "GAA juvenile fundraiser", "members": ["tadhg", "eileen", "mary_l"],
     "created": "2026-05-01T20:00"},
    {"key": "tour", "name": "School tour bus", "members": ["mary_l", "clodagh", "niamh"], "created": "2026-05-10T09:00"},
    {"key": "tanker", "name": "Slurry tanker share", "members": ["mick", "mary_c", "pj"], "created": "2025-03-01T10:00"},
    {"key": "chelt", "name": "Cheltenham 2026", "currency": "GBP", "members": ["declan", "noreen", "pj"],
     "created": "2026-02-20T20:00"},
    {"key": "silage_coop", "name": "Silage co-op 2025", "members": ["mick", "sean_m"], "created": "2025-06-01T10:00"},
]

EXPENSES = [
    {"group": "lotto", "name": "Lotto ticket printing", "amount": 90, "paid_by": "me",
     "split": ["me", "sean_h", "eileen"], "date": "2026-07-01"},
    {"group": "lotto", "name": "Jackpot top-up", "amount": 200, "paid_by": "sean_h",
     "split": ["me", "sean_h", "eileen", "tadhg"], "date": "2026-07-19"},
    {"group": "juvenile", "name": "Cones and bibs", "amount": 64, "paid_by": "tadhg",
     "split": ["me", "tadhg"], "date": "2026-06-10"},
    {"group": "juvenile", "name": "Bag pack at SuperValu float", "amount": 40, "paid_by": "me",
     "split": ["me", "tadhg", "eileen", "mary_l"], "date": "2026-07-11"},
    {"group": "tour", "name": "Bus deposit", "amount": 300, "paid_by": "mary_l",
     "split": ["me", "mary_l", "clodagh"], "date": "2026-05-20"},
    {"group": "tanker", "name": "Tanker tyre", "amount": 420, "paid_by": "mick",
     "split": ["me", "mick", "pj"], "date": "2026-06-02"},
    {"group": "tanker", "name": "Tanker service", "amount": 180, "paid_by": "me",
     "split": ["me", "mick"], "date": "2026-07-03"},
    {"group": "chelt", "name": "Hotel in Cheltenham", "amount": 640, "paid_by": "declan",
     "split": ["me", "declan", "noreen", "pj"], "date": "2026-03-10"},
    {"group": "chelt", "name": "Gold Cup tickets", "amount": 360, "paid_by": "me",
     "split": ["me", "declan", "noreen"], "date": "2026-03-13"},
]

LISTS = [
    {"key": "farm_l", "name": "Farm", "area": "farm"},
    {"key": "house_l", "name": "House", "area": "home"},
    {"key": "club_l", "name": "Club", "area": "GAA"},
    {"key": "school_l", "name": "School", "area": "kids"},
    {"key": "paper_l", "name": "Paperwork"},
]


def events():
    out = []
    # GAA committee, first Tuesday of the month
    for x in ["2026-04-07", "2026-05-05", "2026-06-02", "2026-07-07", "2026-08-04", "2026-09-01"]:
        d = date.fromisoformat(x)
        out.append({"key": f"gaa_{d.strftime('%m%d')}", "name": "GAA committee meeting", "start": f"{d}T20:00",
                    "end": f"{d}T21:30", "attendees": ["sean_h", "eileen"], "description": "clubhouse"})
    # milk recording, monthly
    for x in ["2026-04-15", "2026-05-13", "2026-06-17", "2026-07-15", "2026-08-12", "2026-09-16"]:
        d = date.fromisoformat(x)
        out.append({"key": f"milkrec_{d.strftime('%m%d')}", "name": "Milk recording", "start": f"{d}T06:30",
                    "end": f"{d}T08:30"})
    # U12 hurling training, Wednesdays
    d = date(2026, 6, 3)
    while d <= date(2026, 8, 26):
        ev = {"key": f"u12_{d.strftime('%m%d')}", "name": "U12 hurling training", "start": f"{d}T19:00",
              "end": f"{d}T20:00", "attendees": ["cian", "tadhg"], "description": "Cian, bring the helmet"}
        if d == date(2026, 7, 8):
            ev["cancelled"] = "2026-07-08T15:00"
        out.append(ev)
        d += timedelta(weeks=1)
    # parents group
    for x in ["2026-04-20", "2026-05-18", "2026-06-15", "2026-09-07"]:
        d = date.fromisoformat(x)
        out.append({"key": f"parents_{d.strftime('%m%d')}", "name": "Parents group meeting", "start": f"{d}T20:00",
                    "end": f"{d}T21:00", "attendees": ["mary_l", "clodagh"]})
    # club lotto draw, Sunday nights
    for x in ["2026-07-05", "2026-07-12", "2026-07-19", "2026-07-26", "2026-08-02"]:
        d = date.fromisoformat(x)
        out.append({"key": f"draw_{d.strftime('%m%d')}", "name": "Club lotto draw", "start": f"{d}T21:00",
                    "end": f"{d}T21:30", "attendees": ["eileen"]})
    out += [
        # herd
        {"key": "tb_test", "name": "TB test", "start": "2026-07-28T09:00", "end": "2026-07-28T12:00",
         "attendees": ["fergal"], "description": "full herd, pens ready by 8:30"},
        {"key": "tb_read", "name": "TB test reading", "start": "2026-07-31T09:00", "end": "2026-07-31T11:00",
         "attendees": ["fergal"]},
        {"key": "vet_lame", "name": "Vet visit for the lame cow", "start": "2026-07-10T09:00", "end": "2026-07-10T10:00",
         "attendees": ["fergal"]},
        {"key": "vet_scan", "name": "Vet visit for scanning", "start": "2026-08-06T08:00", "end": "2026-08-06T10:00",
         "attendees": ["fergal"]},
        {"key": "hoof", "name": "Hoof trimming", "start": "2026-07-30T10:00", "end": "2026-07-30T13:00",
         "attendees": ["pat"]},
        {"key": "ai_call", "name": "AI call-out", "start": "2026-07-27T07:00", "end": "2026-07-27T07:30",
         "attendees": ["kevin"]},
        {"key": "silage2", "name": "Second cut silage", "start": "2026-08-08T08:00", "end": "2026-08-08T18:00",
         "attendees": ["sean_m", "mick"], "description": "the long field and the bog meadow"},
        {"key": "mart_wean", "name": "Ennis mart weanling sale", "start": "2026-07-16T11:00", "end": "2026-07-16T15:00",
         "attendees": ["tom"]},
        {"key": "mart_cull", "name": "Ennis mart cull cows", "start": "2026-08-06T11:00", "end": "2026-08-06T14:00",
         "attendees": ["tom"]},
        {"key": "coop_mtg", "name": "Co-op milk supply meeting", "start": "2026-08-04T14:00", "end": "2026-08-04T15:00",
         "attendees": ["liam", "gerry"], "description": "new supply agreement and the quota for next year"},
        {"key": "teagasc_grp", "name": "Teagasc discussion group", "start": "2026-07-23T11:00", "end": "2026-07-23T13:00",
         "attendees": ["orla", "mick"]},
        {"key": "farm_walk", "name": "Teagasc farm walk", "start": "2026-08-20T11:00", "end": "2026-08-20T13:30",
         "attendees": ["orla"], "description": "grassland, at the Hogans' in Quin"},
        {"key": "accounts", "name": "Accounts meeting with Brendan", "start": "2026-08-11T10:00", "end": "2026-08-11T11:00",
         "attendees": ["brendan"]},
        {"key": "bank", "name": "AIB loan meeting", "start": "2026-07-21T11:00", "end": "2026-07-21T12:00",
         "attendees": ["deirdre"]},
        {"key": "safety", "name": "Farm safety inspection", "start": "2026-09-10T10:00", "end": "2026-09-10T11:30"},
        # family
        {"key": "ortho", "name": "Aoife's orthodontist", "start": "2026-07-29T15:30", "end": "2026-07-29T16:15",
         "attendees": ["aoife", "emer"]},
        {"key": "dentist", "name": "Roisin's dentist", "start": "2026-08-05T16:00", "end": "2026-08-05T16:30",
         "attendees": ["roisin"]},
        {"key": "show", "name": "Ennistymon show", "start": "2026-08-01T10:00", "end": "2026-08-01T17:00",
         "attendees": ["declan", "aoife", "cian", "roisin"]},
        {"key": "beach", "name": "Beach day in Lahinch", "start": "2026-07-19T13:00", "end": "2026-07-19T18:00",
         "attendees": ["declan", "roisin"], "cancelled": "2026-07-18T20:00"},
        {"key": "cian_party", "name": "Cian's birthday party", "start": "2026-08-09T14:00", "end": "2026-08-09T17:00",
         "attendees": ["cian"]},
        {"key": "school_night", "name": "Back to school night", "start": "2026-08-27T19:00", "end": "2026-08-27T20:30",
         "attendees": ["niamh"]},
        {"key": "uniforms", "name": "Uniform shopping in Ennis", "start": "2026-08-13T14:00", "end": "2026-08-13T16:00",
         "attendees": ["aoife", "roisin"]},
        {"key": "kilkee", "name": "Kilkee mobile home", "start": "2026-08-17T12:00", "end": "2026-08-19T16:00",
         "attendees": ["declan", "aoife", "cian", "roisin"]},
        {"key": "noreen_coffee", "name": "Coffee with Noreen", "start": "2026-07-31T14:00", "end": "2026-07-31T15:00",
         "attendees": ["noreen"]},
        {"key": "mass", "name": "Anniversary mass for Granny Nolan", "start": "2026-08-02T10:00",
         "end": "2026-08-02T11:00", "attendees": ["mam"]},
        {"key": "pj_dinner", "name": "Dinner at PJ's", "start": "2026-07-25T18:30", "end": "2026-07-25T20:30",
         "attendees": ["pj", "declan"]},
        {"key": "gp", "name": "GP check-up", "start": "2026-08-10T09:30", "end": "2026-08-10T10:00",
         "attendees": ["aisling"]},
        # club
        {"key": "blitz", "name": "U12 blitz in Cusack Park", "start": "2026-08-15T10:00", "end": "2026-08-15T14:00",
         "attendees": ["cian", "tadhg"]},
        {"key": "bbq", "name": "Club barbecue", "start": "2026-07-18T18:00", "end": "2026-07-18T22:00",
         "attendees": ["sean_h", "eileen", "tadhg"], "cancelled": "2026-07-15T12:00"},
        {"key": "quiz", "name": "Quiz night fundraiser", "start": "2026-07-17T21:00", "end": "2026-07-17T23:00",
         "attendees": ["eileen"], "trashed": "2026-07-09T10:00"},
        {"key": "silage_mtg", "name": "Silage co-op meeting", "start": "2026-05-06T20:00", "end": "2026-05-06T21:00",
         "attendees": ["mick", "sean_m"], "trashed": "2026-05-01T10:00"},
        {"key": "school_tour", "name": "School tour to Bunratty", "start": "2026-06-05T09:00", "end": "2026-06-05T15:00",
         "attendees": ["roisin", "mary_l"]},
    ]
    return out


def tasks():
    t = [
        # farm
        {"key": "fence", "name": "Fix the paddock fence", "due": "2026-07-28", "effort": 180, "priority": 2,
         "list": "farm_l"},
        {"key": "fert", "name": "Spread fertiliser on the out farm", "due": "2026-07-30", "effort": 240, "list": "farm_l"},
        {"key": "calf_shed", "name": "Clean out the calf shed", "due": "2026-08-05", "effort": 120, "priority": 3,
         "list": "farm_l"},
        {"key": "bulk_tank", "name": "Get quotes for a new bulk tank", "due": "2026-08-31", "priority": 2,
         "list": "farm_l", "description": "the old one is 18 years old, TAMS grant might cover 60%"},
        {"key": "bt_dairymaster", "name": "Ring Dairymaster", "parent": "bulk_tank", "due": "2026-08-07", "effort": 15},
        {"key": "bt_fullwood", "name": "Ring Fullwood", "parent": "bulk_tank", "due": "2026-08-07", "effort": 15},
        {"key": "bt_tams", "name": "Check the TAMS grant terms", "parent": "bulk_tank", "due": "2026-08-14", "effort": 60},
        {"key": "tb_prep", "name": "Get ready for the TB test", "due": "2026-07-27", "priority": 1, "list": "farm_l"},
        {"key": "tb_pen", "name": "Pen the heifers", "parent": "tb_prep", "due": "2026-07-27", "effort": 60},
        {"key": "tb_tags", "name": "Check tags on the calves", "parent": "tb_prep", "due": "2026-07-27", "effort": 45},
        {"key": "machine", "name": "Service the milking machine", "due": "2026-08-10", "effort": 90, "list": "farm_l"},
        {"key": "herd_reg", "name": "Send herd register to Fergal", "due": "2026-07-27", "effort": 15, "priority": 1,
         "list": "farm_l"},
        {"key": "minerals", "name": "Order mineral buckets", "due": "2026-07-29", "effort": 10, "list": "farm_l"},
        {"key": "thistles", "name": "Spray the thistles", "status": "in_progress", "effort": 120, "list": "farm_l"},
        {"key": "silage_book", "name": "Book the silage contractor", "due": "2026-07-10",
         "completed": "2026-07-09T20:00", "list": "farm_l"},
        {"key": "troughs", "name": "Check the water troughs", "due": "2026-07-26", "effort": 30, "list": "farm_l"},
        {"key": "vet_lame_t", "name": "Ring the vet about the lame cow", "due": "2026-07-09",
         "completed": "2026-07-09T08:00"},
        {"key": "vet_calves", "name": "Ring the vet about the calves coughing", "due": "2026-07-27", "effort": 10,
         "priority": 2},
        {"key": "hoof_book", "name": "Book the hoof trimmer", "due": "2026-07-20", "completed": "2026-07-18T09:00",
         "list": "farm_l"},
        {"key": "spreader", "name": "Sell the old slurry spreader", "trashed": "2026-05-20T10:00", "list": "farm_l"},
        {"key": "yard_light", "name": "Replace the yard light", "due": "2026-07-31", "trashed": "2026-07-15T10:00",
         "list": "farm_l"},
        {"key": "reseed", "name": "Reseed the bog meadow", "due": "2026-09-15", "effort": 300, "list": "farm_l",
         "description": "after second cut, Orla says a clover mix"},
        # house
        {"key": "house_ins", "name": "Renew house insurance", "due": "2026-08-15", "priority": 1, "list": "house_l"},
        {"key": "nct", "name": "Book NCT for the Octavia", "due": "2026-08-20", "effort": 15, "list": "house_l"},
        {"key": "gutters", "name": "Clear the gutters", "effort": 60, "list": "house_l"},
        {"key": "sky", "name": "Cancel Sky Sports", "status": "cancelled", "list": "house_l"},
        {"key": "boiler", "name": "Get the boiler serviced", "due": "2026-09-01", "effort": 20, "list": "house_l"},
        # club
        {"key": "lotto_sell", "name": "Sell lotto tickets at mass", "status": "in_progress", "list": "club_l",
         "effort": 45},
        {"key": "raffle", "name": "Print raffle tickets", "due": "2026-08-01", "effort": 30, "list": "club_l"},
        {"key": "jerseys", "name": "Sort jerseys for the U12s", "due": "2026-08-10", "priority": 2, "list": "club_l",
         "effort": 60},
        {"key": "minutes_jul", "name": "Type up July minutes", "due": "2026-07-14", "completed": "2026-07-13T22:00",
         "list": "club_l"},
        {"key": "pitch", "name": "Book the pitch for the blitz", "due": "2026-08-05", "effort": 10, "list": "club_l"},
        # school
        {"key": "books", "name": "Order school books", "due": "2026-08-14", "priority": 2, "list": "school_l"},
        {"key": "books_aoife", "name": "Aoife's books", "parent": "books", "due": "2026-08-14", "effort": 20},
        {"key": "books_cian", "name": "Cian's books", "parent": "books", "due": "2026-08-14", "effort": 20},
        {"key": "books_roisin", "name": "Roisin's books", "parent": "books", "due": "2026-08-14", "effort": 20,
         "completed": "2026-07-22T21:00"},
        {"key": "tour_dep", "name": "Pay school tour deposit", "due": "2026-05-20", "completed": "2026-05-19T20:00",
         "list": "school_l"},
        {"key": "labels", "name": "Label the uniforms", "due": "2026-08-28", "effort": 60, "list": "school_l"},
        {"key": "swim", "name": "Sign Roisin up for swimming", "due": "2026-08-01", "effort": 15, "list": "school_l"},
        # paperwork
        {"key": "receipts", "name": "Send receipts to Brendan", "due": "2026-08-07", "effort": 30, "list": "paper_l"},
        {"key": "herd_ins", "name": "Renew herd insurance", "due": "2026-09-01", "list": "paper_l"},
        {"key": "nitrates", "name": "Update the nitrates records", "due": "2026-07-31", "effort": 120, "priority": 1,
         "list": "paper_l"},
        {"key": "milk_stmt", "name": "Check the June milk statement", "due": "2026-07-20", "effort": 20,
         "list": "paper_l"},
        {"key": "biss", "name": "Submit BISS application", "due": "2026-05-15", "completed": "2026-05-14T22:00",
         "list": "paper_l"},
        # no list
        {"key": "cian_present", "name": "Birthday present for Cian", "due": "2026-08-08", "priority": 2},
        {"key": "call_mam", "name": "Call Mam about Sunday", "due": "2026-07-26", "effort": 10},
        {"key": "camogie", "name": "Collect Aoife from camogie camp", "due": "2026-07-31", "effort": 40},
        {"key": "mass_card", "name": "Get a mass card for the Hehirs", "due": "2026-07-24",
         "completed": "2026-07-24T12:00"},
        {"key": "kilkee_book", "name": "Book the Kilkee mobile home", "completed": "2026-04-02T20:00"},
    ]
    # dairy nuts, monthly
    for m in range(4, 8):
        t.append({"key": f"nuts_{m:02d}", "name": "Order dairy nuts", "due": f"2026-{m:02d}-01",
                  "completed": f"2026-{m - 1:02d}-29T20:00" if m > 3 else None, "list": "farm_l"})
    t.append({"key": "nuts_08", "name": "Order dairy nuts", "due": "2026-08-01", "effort": 10, "list": "farm_l"})
    # ESB, every two months
    t.append({"key": "esb_03", "name": "Pay the ESB bill", "due": "2026-03-15", "completed": "2026-03-14T21:00",
              "list": "house_l"})
    t.append({"key": "esb_05", "name": "Pay the ESB bill", "due": "2026-05-15", "completed": "2026-05-15T09:00",
              "list": "house_l"})
    t.append({"key": "esb_07", "name": "Pay the ESB bill", "due": "2026-07-15", "list": "house_l", "effort": 5})
    for x in t:
        if x.get("completed") is None:
            x.pop("completed", None)
    return t


NOTEBOOKS = [
    {"key": "herd_nb", "name": "Herd notes"},
    {"key": "gaa_nb", "name": "GAA minutes"},
    {"key": "recipes_nb", "name": "Recipes"},
    {"key": "school_nb", "name": "School stuff"},
    {"key": "grass_nb", "name": "Grass budget"},
]

NOTES = [
    {"key": "lame_cow", "name": "Lame cow 214", "body": "white line disease back left, block on, check again in 10 days",
     "notebook": "herd_nb", "created": "2026-07-10T10:15"},
    {"key": "calving", "name": "Calving dates 2027", "body": "first cows due 1 February, 68 in calf to AI, 12 to the Angus bull",
     "notebook": "herd_nb", "created": "2026-06-20T21:00", "pinned": True},
    {"key": "scc", "name": "SCC figures", "body": "June 180, July 165, watch cow 88",
     "notebook": "herd_nb", "created": "2026-07-16T07:40"},
    {"key": "bull", "name": "Angus bull", "body": "bought from Tom Keane, docile, 1400 euro", "notebook": "herd_nb",
     "created": "2026-04-12T19:00"},
    {"key": "min_jun", "name": "June committee minutes", "body": "lotto up 12 percent, new nets for the juvenile pitch",
     "notebook": "gaa_nb", "created": "2026-06-02T22:00"},
    {"key": "min_jul", "name": "July committee minutes", "body": "barbecue cancelled, jerseys ordered, Sean to ring the county board",
     "notebook": "gaa_nb", "created": "2026-07-07T22:10"},
    {"key": "lotto_rules", "name": "Lotto rules", "body": "tbc", "notebook": "gaa_nb", "created": "2026-05-05T22:00"},
    {"key": "brown_bread", "name": "Brown bread", "body": "Mam's recipe: 1lb wholemeal, buttermilk, a fist of oat flakes",
     "notebook": "recipes_nb", "created": "2026-02-14T16:00", "pinned": True},
    {"key": "apple_tart", "name": "Apple tart", "body": "bramleys from PJ's tree, cloves, shortcrust", "notebook": "recipes_nb",
     "created": "2026-03-01T15:00"},
    {"key": "stew", "name": "Beef stew", "body": "shin beef, Guinness, 3 hours low", "notebook": "recipes_nb",
     "created": "2026-01-20T17:00"},
    {"key": "book_list", "name": "Book lists", "body": "Aoife 2nd year, Cian 5th class, Roisin 1st class", "notebook": "school_nb",
     "created": "2026-07-01T20:00"},
    {"key": "tour_notes", "name": "School tour", "body": "bus 300, Bunratty group rate, packed lunches", "notebook": "school_nb",
     "created": "2026-05-20T21:00"},
    {"key": "allergies", "name": "Allergies", "body": "Roisin: penicillin. Cian: none. Aoife: hay fever", "notebook": "school_nb",
     "created": "2026-01-10T20:00", "pinned": True},
    {"key": "quote_note", "name": "Bulk tank quotes", "body": "Dairymaster 21k installed, waiting on Fullwood",
     "created": "2026-07-22T13:30"},
    {"key": "fence_note", "name": "Fencing", "body": "Martin can do the paddock the week of the 27th, 400 euro",
     "created": "2026-07-14T20:00"},
    {"key": "cian_ideas", "name": "Present ideas for Cian", "body": "new hurley 30 inch, Clare jersey, helmet",
     "created": "2026-07-19T21:00"},
    {"key": "orla_tips", "name": "Orla's advice", "body": "cut nitrogen on the out farm, clover mix, soil samples in October",
     "created": "2026-07-23T13:15"},
    {"key": "coop_q", "name": "Questions for the co-op", "body": "quota for next year, protein bonus, collection time",
     "created": "2026-07-25T08:00"},
    {"key": "blank", "name": "Untitled", "body": "tbc", "created": "2026-07-20T06:40"},
    {"key": "old_grazing", "name": "Grazing plan 2025", "body": "paddocks 1-14 rotation, 21 days", "created": "2025-03-01T10:00",
     "trashed": "2026-06-10T10:00"},
    {"key": "quiz_qs", "name": "Quiz questions", "body": "round 3: Clare hurling", "created": "2026-07-01T21:00",
     "trashed": "2026-07-20T10:00"},
]

FOLDERS = [
    {"key": "herd_f", "name": "Herd records"},
    {"key": "bank_f", "name": "Bank and loans"},
    {"key": "dept_f", "name": "Department"},
    {"key": "school_f", "name": "School"},
    {"key": "ins_f", "name": "Insurance"},
    {"key": "tractor_f", "name": "Old tractor"},
]

DOCUMENTS = [
    {"key": "herd_register", "name": "Herd register 2026", "folder": "herd_f", "starred": True,
     "created": "2026-01-02T10:00"},
    {"key": "tb_cert", "name": "TB test certificate 2025", "folder": "herd_f", "created": "2025-07-30T12:00"},
    {"key": "ai_records", "name": "AI records summer", "folder": "herd_f", "created": "2026-07-17T21:00"},
    {"key": "loan_offer", "name": "AIB loan offer", "folder": "bank_f", "starred": True, "created": "2026-07-21T12:30"},
    {"key": "bank_stmt", "name": "Bank statement June", "folder": "bank_f", "created": "2026-07-03T09:00"},
    {"key": "biss_doc", "name": "BISS confirmation", "folder": "dept_f", "created": "2026-05-15T08:00"},
    {"key": "nitrates_doc", "name": "Nitrates derogation letter", "folder": "dept_f", "created": "2026-03-20T10:00"},
    {"key": "tams_doc", "name": "TAMS guidelines", "folder": "dept_f", "created": "2026-07-22T10:30"},
    {"key": "booklist_doc", "name": "Booklist 2nd year", "folder": "school_f", "created": "2026-07-01T19:30"},
    {"key": "tour_form", "name": "School tour consent form", "folder": "school_f", "created": "2026-05-12T20:00"},
    {"key": "house_policy", "name": "House insurance policy", "folder": "ins_f", "starred": True,
     "created": "2025-08-15T10:00"},
    {"key": "farm_policy", "name": "Farm insurance policy", "folder": "ins_f", "created": "2025-09-01T10:00"},
    {"key": "milk_june", "name": "Milk statement June", "created": "2026-07-10T08:00", "starred": True},
    {"key": "scc_report", "name": "SCC report July", "created": "2026-07-24T10:00"},
    {"key": "fence_quote", "name": "Fencing quote from Martin", "created": "2026-07-14T20:30"},
    {"key": "supply_agree", "name": "Milk supply agreement draft", "created": "2026-07-24T16:00"},
    {"key": "old_tractor_doc", "name": "Tractor logbook", "folder": "herd_f", "created": "2024-03-01T10:00",
     "trashed": "2026-07-18T10:00"},
]

ALBUMS = [
    {"key": "calves_al", "name": "Calves 2026"},
    {"key": "hurling_al", "name": "Cian's hurling"},
    {"key": "kilkee_al", "name": "Kilkee 2025"},
    {"key": "family_al", "name": "Family"},
    {"key": "farm_al", "name": "The farm"},
    {"key": "comm_al", "name": "Roisin's communion"},
]

PHOTOS = [
    {"key": "p_first_calf", "name": "First calf of the year", "taken": "2026-02-01T05:40", "albums": ["calves_al"],
     "starred": True},
    {"key": "p_twins", "name": "Twin heifer calves", "taken": "2026-02-18T07:10", "albums": ["calves_al"]},
    {"key": "p_roisin_calf", "name": "Roisin feeding a calf", "taken": "2026-03-07T17:00", "albums": ["calves_al", "family_al"],
     "people": ["roisin"], "starred": True},
    {"key": "p_calf_shed", "name": "Calf shed full", "taken": "2026-03-20T08:00", "albums": ["calves_al"]},
    {"key": "p_angus", "name": "The Angus bull", "taken": "2026-04-12T15:00", "albums": ["farm_al"], "people": ["tom"]},
    {"key": "p_cian_goal", "name": "Cian's goal against Clarecastle", "taken": "2026-06-20T11:30",
     "albums": ["hurling_al"], "people": ["cian"], "starred": True},
    {"key": "p_u12_team", "name": "U12 team photo", "taken": "2026-06-24T20:05", "albums": ["hurling_al"],
     "people": ["cian", "tadhg"]},
    {"key": "p_cian_helmet", "name": "Cian in the new helmet", "taken": "2026-07-01T19:00", "albums": ["hurling_al"],
     "people": ["cian"]},
    {"key": "p_tadhg_speech", "name": "Tadhgie's team talk", "taken": "2026-07-15T19:10", "albums": ["hurling_al"],
     "people": ["tadhg", "cian"]},
    {"key": "p_kilkee_beach", "name": "Kilkee beach", "taken": "2025-08-18T15:00", "albums": ["kilkee_al"], "starred": True},
    {"key": "p_kilkee_chips", "name": "Chips on the prom", "taken": "2025-08-18T19:30", "albums": ["kilkee_al"],
     "people": ["declan", "roisin"]},
    {"key": "p_pollock", "name": "Pollock holes", "taken": "2025-08-19T11:00", "albums": ["kilkee_al"],
     "people": ["aoife", "cian"]},
    {"key": "p_comm_church", "name": "Roisin outside the church", "taken": "2026-05-16T12:00", "albums": ["comm_al"],
     "people": ["roisin"], "starred": True},
    {"key": "p_comm_grans", "name": "Roisin with Mam and PJ", "taken": "2026-05-16T13:30", "albums": ["comm_al", "family_al"],
     "people": ["roisin", "mam", "pj"]},
    {"key": "p_comm_cake", "name": "Communion cake", "taken": "2026-05-16T16:00", "albums": ["comm_al"]},
    {"key": "p_comm_family", "name": "All of us at the communion", "taken": "2026-05-16T14:00",
     "albums": ["comm_al", "family_al"], "people": ["declan", "aoife", "cian", "roisin"]},
    {"key": "p_aoife_camogie", "name": "Aoife's camogie final", "taken": "2026-06-06T16:00", "albums": ["family_al"],
     "people": ["aoife"]},
    {"key": "p_xmas", "name": "Christmas at Mam's", "taken": "2025-12-25T15:00", "albums": ["family_al"],
     "people": ["mam", "declan", "aoife", "cian", "roisin"], "starred": True},
    {"key": "p_silage1", "name": "First cut silage", "taken": "2026-05-28T18:00", "albums": ["farm_al"],
     "people": ["sean_m"]},
    {"key": "p_parlour", "name": "Milking parlour at dawn", "taken": "2026-06-30T05:50", "albums": ["farm_al"]},
    {"key": "p_sunset", "name": "Sunset over the bog meadow", "taken": "2026-07-04T21:45", "albums": ["farm_al"],
     "starred": True},
    {"key": "p_herd_lane", "name": "Cows on the lane", "taken": "2026-07-12T16:30", "albums": ["farm_al"]},
    {"key": "p_fence", "name": "Broken paddock fence", "taken": "2026-07-13T09:10"},
    {"key": "p_lame", "name": "Cow 214 hoof", "taken": "2026-07-10T09:20", "people": ["fergal"]},
    {"key": "p_trough", "name": "Leaking trough", "taken": "2026-07-21T07:15"},
    {"key": "p_meter", "name": "Milk meter reading", "taken": "2026-07-15T07:00"},
    {"key": "p_mart", "name": "Weanlings in the ring", "taken": "2026-07-16T12:30", "people": ["tom"]},
    {"key": "p_show_2025", "name": "Ennistymon show 2025", "taken": "2025-08-02T14:00", "people": ["declan", "roisin"]},
    {"key": "p_pj_tractor", "name": "PJ on the old Massey", "taken": "2026-06-14T17:20", "people": ["pj"]},
    {"key": "p_mam_garden", "name": "Mam in her garden", "taken": "2026-07-23T17:40", "people": ["mam"]},
    {"key": "p_lotto", "name": "Lotto tickets table", "taken": "2026-07-19T21:10", "people": ["eileen"]},
    {"key": "p_booklist", "name": "Booklist screenshot", "taken": "2026-07-01T19:40"},
    {"key": "p_blurry", "name": "Blurry hurling shot", "taken": "2026-07-15T19:30", "albums": ["hurling_al"],
     "trashed": "2026-07-16T08:00"},
    {"key": "p_old_yard", "name": "Old yard before the shed", "taken": "2019-05-01T12:00", "trashed": "2026-06-01T10:00"},
    {"key": "p_selfie", "name": "Selfie at the mart", "taken": "2026-07-16T13:00", "trashed": "2026-07-17T09:00"},
]

DEBTS = [
    {"key": "d_sean_silage", "person": "sean_m", "direction": "i_owe", "amount": 850, "name": "Silage bales",
     "date": "2026-07-12"},
    {"key": "d_mick_silage", "person": "mick", "direction": "owes_me", "amount": 240, "name": "Silage bales for Mick",
     "date": "2026-07-14"},
    {"key": "d_fergal", "person": "fergal", "direction": "i_owe", "amount": 310, "name": "Vet bill balance",
     "date": "2026-07-10"},
    {"key": "d_eileen", "person": "eileen", "direction": "i_owe", "amount": 50, "name": "Lotto float",
     "date": "2026-07-19"},
    {"key": "d_clodagh", "person": "clodagh", "direction": "owes_me", "amount": 25, "name": "Bus share for the tour",
     "date": "2026-06-20"},
    {"key": "d_tadhg", "person": "tadhg", "direction": "owes_me", "amount": 150, "name": "Jersey deposit",
     "date": "2026-07-22"},
    {"key": "d_ger", "person": "ger", "direction": "i_owe", "amount": 180, "name": "Relief milking weekend",
     "date": "2026-07-20"},
    {"key": "d_mary_c", "person": "mary_c", "direction": "i_owe", "amount": 12, "name": "Eggs and brown bread",
     "date": "2026-07-24"},
    {"key": "d_kevin", "person": "kevin", "direction": "i_owe", "amount": 95, "name": "AI straws",
     "date": "2026-06-05", "settled": "2026-06-30T10:00"},
    {"key": "d_tom", "person": "tom", "direction": "owes_me", "amount": 200, "name": "Weanling deposit",
     "date": "2026-07-16"},
    {"key": "d_noreen", "person": "noreen", "direction": "owes_me", "amount": 120, "name": "Cheltenham race cards",
     "date": "2026-03-12", "settled": "2026-04-01T10:00"},
    {"key": "d_pj", "person": "pj", "direction": "owes_me", "amount": 60, "name": "Diesel for the Massey",
     "date": "2026-06-14"},
    {"key": "d_mick_diesel", "person": "mick", "direction": "i_owe", "amount": 45, "name": "Diesel from Mick",
     "date": "2026-07-03"},
]

LOCKER = [
    {"key": "aib", "name": "AIB online banking", "type": "login", "username": "skelly.farm",
     "url": "https://aib.ie", "password": "Clover-Meadow-88", "starred": True},
    {"key": "icbf", "name": "ICBF herd account", "type": "login", "username": "IE5512890",
     "url": "https://icbf.com", "password": "Friesian214!"},
    {"key": "agfood", "name": "Agfood.ie", "type": "login", "username": "IE5512890",
     "url": "https://agfood.ie", "password": "Burren-Gate-3"},
    {"key": "creamery", "name": "Creamery supplier portal", "type": "login", "username": "kelly.siobhan",
     "password": "Lahinch2019"},
    {"key": "debit", "name": "AIB debit card", "type": "card", "card_number": "4921 5566 0034 7781", "cvv": "412",
     "starred": True},
    {"key": "gates", "name": "Gate codes", "type": "note", "notes": "yard 4471, out farm 1990, Mick's lane 2020"},
    {"key": "pps", "name": "PPS number", "type": "identity", "password": "7654321KA"},
    {"key": "wifi", "name": "Farmhouse wifi", "type": "wifi", "password": "hurling-cian-2015"},
    {"key": "parlour_pc", "name": "Parlour computer", "type": "password", "password": "Milking-0530"},
    {"key": "ssh", "name": "Parlour PC remote key", "type": "ssh_key", "notes": "set up by Declan's cousin",
     "password": "ssh-ed25519 AAAAC3-parlour"},
    {"key": "weather", "name": "Weather station API", "type": "api_credential", "notes": "rooftop station on the dairy",
     "code": "met-clare-8812"},
    {"key": "passport", "name": "Siobhan's passport", "type": "passport", "notes": "expires March 2029"},
    {"key": "cu", "name": "Credit union account", "type": "bank_account", "notes": "Ennis credit union, kids' savings"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence", "notes": "B and W categories, renew 2031"},
    {"key": "herdapp", "name": "HerdPlus app licence", "type": "software_licence", "code": "HP-CLARE-5512"},
    {"key": "crypto", "name": "Cian's bitcoin from Uncle Mike", "type": "crypto_wallet",
     "notes": "0.002 BTC, seed words in the safe"},
    {"key": "icmsa", "name": "ICMSA membership", "type": "membership", "notes": "member 40122", "starred": True},
    {"key": "folio", "name": "Land folio copy", "type": "document", "notes": "folio CE12345F, out farm"},
]

LINKS = [
    {"from": "fence", "to": "martin"},
    {"from": "herd_reg", "to": "fergal"},
    {"from": "vet_calves", "to": "fergal"},
    {"from": "vet_lame_t", "to": "fergal"},
    {"from": "tb_prep", "to": "fergal"},
    {"from": "bulk_tank", "to": "liam"},
    {"from": "jerseys", "to": "tadhg"},
    {"from": "raffle", "to": "eileen"},
    {"from": "receipts", "to": "brendan"},
    {"from": "cian_present", "to": "cian"},
    {"from": "call_mam", "to": "mam"},
    {"from": "camogie", "to": "aoife"},
    {"from": "swim", "to": "roisin"},
    {"from": "silage_book", "to": "sean_m"},
    {"from": "hoof_book", "to": "pat"},
    {"from": "house_ins", "to": "joe"},
    {"from": "herd_ins", "to": "joe"},
    {"from": "reseed", "to": "orla"},
    {"from": "lame_cow", "to": "fergal"},
    {"from": "bull", "to": "tom"},
    {"from": "min_jul", "to": "sean_h"},
    {"from": "min_jul", "to": "eileen"},
    {"from": "min_jun", "to": "sean_h"},
    {"from": "brown_bread", "to": "mam"},
    {"from": "apple_tart", "to": "pj"},
    {"from": "tour_notes", "to": "mary_l"},
    {"from": "quote_note", "to": "liam"},
    {"from": "fence_note", "to": "martin"},
    {"from": "cian_ideas", "to": "cian"},
    {"from": "orla_tips", "to": "orla"},
    {"from": "coop_q", "to": "liam"},
    {"from": "coop_q", "to": "gerry"},
]


def world():
    return {
        "me": "Siobhan Kelly",
        "epoch": "2025-01-05T09:00",
        "seed": "T11",
        "currency": "EUR",
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
    keys = [e["key"] for e in evs]
    assert len(keys) == len(set(keys))


if __name__ == "__main__":
    w = world()
    check_overlaps(w["events"])
    allkeys = [r["key"] for sec in ("people", "groups", "lists", "notebooks", "folders", "albums", "events", "tasks",
                                    "notes", "documents", "photos", "debts", "locker") for r in w[sec]]
    assert len(allkeys) == len(set(allkeys)), [k for k in allkeys if allkeys.count(k) > 1]
    out = HERE / "T11.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
