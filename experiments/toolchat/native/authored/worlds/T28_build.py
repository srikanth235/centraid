"""World T28: Wiremu Tane, retired bus driver and kaumātua in Rotorua (NZD vault).

    python3 authored/worlds/T28_build.py      # writes authored/worlds/T28.json (deterministic)

Today in the sessions is Saturday 2026-02-21 12:00 (late summer; Tama's cricket has just finished).
Wiremu is married to Aroha; their four children are Hemi (Hamilton), Mere (Rotorua), Rawiri
(Brisbane) and Kiri (Tauranga, married to Dave Walker), with five mokopuna in summer sport and
kapa haka. He sits on the marae committee, helps tutor kapa haka, has just helped run his uncle
Hohepa's tangi and is organising the Tane whānau reunion at Easter. Built-in ambiguity: two
Arohas (wife Aroha Tane, granddaughter Aroha Walker "Ro"), two Hemis (son Hemi Tane, marae chair
Hemi Rangi), nicknames (Nanny Ria, Whaea Hine, Trev, Ro), a misspelled-looking name (Ngaire
Tomoana), two "Reunion planning hui" and two "GP appointment with Dr Lim" events, recurring kapa
haka practice, touch, cricket, waka ama and marae meetings, near-duplicate tasks ("Pay the power
bill"), two lists sharing "Reunion", cancelled events, completed tasks, rows trashed inside and
past the 30-day restore window, empty groups, an empty folder, an empty notebook, a one-note
notebook and an empty album, and one group in AUD.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        # whānau
        {"key": "aroha", "name": "Aroha Tane", "role": "wife", "starred": True, "met": "Ngongotahā",
         "last_contacted": "2026-02-21T08:00", "last_contacted_kind": "visit"},
        {"key": "hemi_t", "name": "Hemi Tane", "role": "son, Hamilton", "cadence": 7, "met": "Rotorua",
         "last_contacted": "2026-02-18T19:30", "last_contacted_kind": "call"},
        {"key": "mere", "name": "Mere Tane", "role": "daughter, Rotorua", "starred": True, "cadence": 7,
         "last_contacted": "2026-02-20T12:00", "last_contacted_kind": "visit"},
        {"key": "rawiri", "name": "Rawiri Tane", "role": "son, Brisbane", "cadence": 14,
         "last_contacted": "2026-02-08T20:00", "last_contacted_kind": "call"},
        {"key": "kiri", "name": "Kiri Walker", "role": "daughter, Tauranga", "cadence": 14,
         "last_contacted": "2026-02-14T18:00", "last_contacted_kind": "visit"},
        {"key": "dave", "name": "Dave Walker", "role": "son-in-law, Kiri's husband", "met": "Tauranga"},
        {"key": "manaia", "name": "Manaia Tane", "role": "mokopuna, 15, waka ama"},
        {"key": "tama", "name": "Tama Tane", "role": "mokopuna, 12, cricket"},
        {"key": "ana", "name": "Ana Tane", "role": "mokopuna, 10, netball and kapa haka"},
        {"key": "aroha_w", "name": "Aroha Walker", "role": "mokopuna, 9, touch", "nickname": "Ro"},
        {"key": "nikau", "name": "Nikau Walker", "role": "mokopuna, 7, touch"},
        {"key": "ria", "name": "Ria Tane", "role": "sister", "nickname": "Nanny Ria", "starred": True, "cadence": 7,
         "last_contacted": "2026-02-20T10:00", "last_contacted_kind": "visit"},
        {"key": "pita", "name": "Pita Ngata", "role": "cousin, kaumātua", "cadence": 14, "met": "Ōhinemutu",
         "last_contacted": "2026-02-12T14:00", "last_contacted_kind": "visit"},
        {"key": "tui", "name": "Tui Ngata", "role": "Pita's wife"},
        # marae
        {"key": "hemi_r", "name": "Hemi Rangi", "role": "marae committee chair", "cadence": 14,
         "last_contacted": "2026-02-17T19:00", "last_contacted_kind": "call"},
        {"key": "huia", "name": "Huia Morgan", "role": "marae committee secretary", "cadence": 30,
         "last_contacted": "2026-02-03T18:00", "last_contacted_kind": "message"},
        {"key": "moana", "name": "Moana Paki", "role": "marae committee treasurer",
         "last_contacted": "2026-02-14T16:00", "last_contacted_kind": "visit"},
        # kapa haka
        {"key": "hine", "name": "Hine Kereama", "role": "kapa haka tutor", "nickname": "Whaea Hine", "starred": True,
         "cadence": 7, "last_contacted": "2026-02-18T20:30", "last_contacted_kind": "visit"},
        {"key": "rangi", "name": "Rangi Paora", "role": "kapa haka leader"},
        {"key": "wiki", "name": "Wiki Te Awa", "role": "kapa haka, alto"},
        # sport
        {"key": "brent", "name": "Brent Harris", "role": "Tama's cricket coach"},
        {"key": "leanne", "name": "Leanne Smith", "role": "Ana's netball coach"},
        # bus depot mates
        {"key": "kevin", "name": "Kevin O'Brien", "role": "old bus driver mate", "cadence": 30, "met": "Rotorua depot",
         "last_contacted": "2026-01-24T13:00", "last_contacted_kind": "coffee"},
        {"key": "trev", "name": "Trevor Wilson", "role": "old bus driver mate", "nickname": "Trev", "met": "Rotorua depot",
         "last_contacted": "2026-02-11T10:00", "last_contacted_kind": "visit"},
        # others
        {"key": "ngaire", "name": "Ngaire Tomoana", "role": "hāngī caterer", "cadence": 30,
         "last_contacted": "2026-02-19T11:00", "last_contacted_kind": "call"},
        {"key": "sarah", "name": "Sarah Lim", "role": "GP"},
        {"key": "sam", "name": "Sam Patel", "role": "neighbour",
         "last_contacted": "2026-02-19T17:00", "last_contacted_kind": "visit"},
        {"key": "tony", "name": "Tony Russo", "role": "mechanic"},
        # trashed: one inside the 30-day window, one past it
        {"key": "jason", "name": "Jason Reid", "role": "old insurance broker", "trashed": "2026-02-10T09:00"},
        {"key": "gary", "name": "Gary Hunt", "role": "old landlord", "trashed": "2025-12-01T09:00"},
    ]


GROUPS = [
    {"key": "marae_g", "name": "Marae committee koha fund", "members": ["hemi_r", "huia", "moana", "pita"],
     "created": "2025-06-01T10:00"},
    {"key": "reunion_g", "name": "Tane reunion 2026", "members": ["hemi_t", "mere", "rawiri", "kiri", "ria"],
     "created": "2026-01-05T10:00"},
    {"key": "kapa_g", "name": "Kapa haka koha", "members": ["hine", "rangi", "wiki"],
     "created": "2025-11-01T10:00"},
    {"key": "brisbane_g", "name": "Brisbane trip", "currency": "AUD", "members": ["rawiri", "aroha", "mere"],
     "created": "2026-02-15T10:00"},
    {"key": "tangi_g", "name": "Uncle Hohepa's tangi", "members": ["pita", "tui", "ria"],
     "created": "2026-02-09T10:00"},
    {"key": "bus_g", "name": "Bus depot old boys", "members": ["kevin", "trev"],
     "created": "2026-01-20T10:00"},
    {"key": "fish_g", "name": "Tarawera fishing", "members": ["hemi_t", "dave", "tama"],
     "created": "2026-02-01T10:00"},
]

EXPENSES = [
    {"group": "marae_g", "name": "Working bee sausages", "amount": 120, "paid_by": "me",
     "split": ["me", "hemi_r", "moana", "pita"], "date": "2026-02-14"},
    {"group": "marae_g", "name": "Printer ink", "amount": 60, "paid_by": "huia",
     "split": ["me", "huia"], "date": "2026-02-04"},
    {"group": "reunion_g", "name": "Hall deposit", "amount": 400, "paid_by": "me",
     "split": ["me", "hemi_t", "mere", "rawiri", "kiri"], "date": "2026-02-09"},
    {"group": "reunion_g", "name": "T-shirt sample", "amount": 45, "paid_by": "mere",
     "split": ["me", "mere", "kiri"], "date": "2026-02-19"},
    {"group": "kapa_g", "name": "Uniform dry cleaning", "amount": 90, "paid_by": "hine",
     "split": ["me", "hine", "rangi"], "date": "2026-02-17"},
    {"group": "brisbane_g", "name": "Airbnb deposit", "amount": 600, "paid_by": "rawiri",
     "split": ["me", "aroha", "mere", "rawiri"], "date": "2026-02-18", "currency": "AUD"},
    {"group": "tangi_g", "name": "Kai for the tangi", "amount": 900, "paid_by": "pita",
     "split": ["me", "pita", "tui", "ria"], "date": "2026-02-11"},
    {"group": "tangi_g", "name": "Flowers", "amount": 150, "paid_by": "me",
     "split": ["me", "ria"], "date": "2026-02-10"},
]

LISTS = [
    {"key": "marae_l", "name": "Marae", "area": "community"},
    {"key": "reunion_l", "name": "Reunion", "area": "whānau"},
    {"key": "reunion_cat_l", "name": "Reunion catering", "area": "whānau"},
    {"key": "kapa_l", "name": "Kapa haka", "area": "community"},
    {"key": "home_l", "name": "Home", "area": "home"},
    {"key": "sport_l", "name": "Mokopuna sport", "area": "whānau"},
    {"key": "shop_l", "name": "Shopping"},
]


def events():
    out = []
    # kapa haka practice, Wednesday evenings
    d = date(2026, 1, 7)
    while d <= date(2026, 3, 25):
        ev = {"key": f"kapa_{d.strftime('%m%d')}", "name": "Kapa haka practice", "start": f"{d}T18:30",
              "end": f"{d}T20:30", "attendees": ["hine", "ana"], "description": "wharenui"}
        if d == date(2026, 2, 4):
            ev["cancelled"] = "2026-02-02T09:00"
        out.append(ev)
        d += timedelta(weeks=1)
    # touch for Nikau and Ro, Monday evenings
    d = date(2026, 1, 26)
    while d <= date(2026, 3, 16):
        out.append({"key": f"touch_{d.strftime('%m%d')}", "name": "Touch for Nikau and Ro", "start": f"{d}T17:30",
                    "end": f"{d}T18:30", "attendees": ["nikau", "aroha_w"], "description": "Smallbone Park"})
        d += timedelta(weeks=1)
    # Tama's cricket, Saturday mornings
    d = date(2026, 1, 10)
    while d <= date(2026, 3, 14):
        out.append({"key": f"cricket_{d.strftime('%m%d')}", "name": "Tama's cricket", "start": f"{d}T09:00",
                    "end": f"{d}T12:00", "attendees": ["tama"], "description": "Smallbone Park"})
        d += timedelta(weeks=1)
    # waka ama training for Manaia, Friday afternoons
    d = date(2026, 1, 30)
    while d <= date(2026, 3, 6):
        out.append({"key": f"waka_{d.strftime('%m%d')}", "name": "Waka ama training", "start": f"{d}T16:00",
                    "end": f"{d}T17:30", "attendees": ["manaia"], "description": "Lake Rotorua, Ohau channel end"})
        d += timedelta(weeks=1)
    # marae committee meeting, first Sunday of the month
    for d in (date(2026, 1, 4), date(2026, 2, 1), date(2026, 3, 1), date(2026, 4, 5)):
        out.append({"key": f"marae_{d.strftime('%m%d')}", "name": "Marae committee meeting", "start": f"{d}T14:00",
                    "end": f"{d}T16:00", "attendees": ["hemi_r", "huia", "moana", "pita"],
                    "description": "wharekai"})
    out += [
        {"key": "waitangi", "name": "Waitangi Day at the marae", "start": "2026-02-06T08:00", "end": "2026-02-06T13:00",
         "attendees": ["aroha", "hemi_r", "pita"], "description": "dawn service then hāngī"},
        {"key": "tangi_hui", "name": "Tangi hui with Pita", "start": "2026-02-09T10:00", "end": "2026-02-09T11:00",
         "attendees": ["pita"]},
        {"key": "tangi", "name": "Tangi for Uncle Hohepa", "start": "2026-02-11T10:00", "end": "2026-02-11T16:00",
         "attendees": ["pita", "tui", "ria", "aroha"], "description": "Ōhinemutu, burial at the urupā"},
        {"key": "hui_feb", "name": "Reunion planning hui", "start": "2026-02-08T14:00", "end": "2026-02-08T16:00",
         "attendees": ["hemi_t", "mere", "kiri", "ria"], "description": "at Mere's"},
        {"key": "hui_mar", "name": "Reunion planning hui", "start": "2026-03-08T14:00", "end": "2026-03-08T16:00",
         "attendees": ["hemi_t", "mere", "kiri", "ria"], "description": "at the marae"},
        {"key": "gp_feb", "name": "GP appointment with Dr Lim", "start": "2026-02-24T09:30", "end": "2026-02-24T10:00",
         "attendees": ["sarah"], "description": "blood pressure review"},
        {"key": "gp_mar", "name": "GP appointment with Dr Lim", "start": "2026-03-24T09:30", "end": "2026-03-24T10:00",
         "attendees": ["sarah"], "description": "knee"},
        {"key": "aroha_bday", "name": "Aroha's birthday dinner", "start": "2026-02-26T18:00", "end": "2026-02-26T21:00",
         "attendees": ["aroha", "mere", "hemi_t", "kiri", "dave"], "description": "Atticus Finch, Eat Streat"},
        {"key": "netball", "name": "Ana's netball grading", "start": "2026-02-28T13:00", "end": "2026-02-28T15:00",
         "attendees": ["ana", "leanne"]},
        {"key": "regatta", "name": "Manaia's waka ama regatta", "start": "2026-03-07T13:00", "end": "2026-03-07T17:00",
         "attendees": ["manaia", "kiri"], "description": "Lake Karapiro"},
        {"key": "regionals", "name": "Kapa haka regionals", "start": "2026-03-21T13:00", "end": "2026-03-21T18:00",
         "attendees": ["hine", "rangi", "wiki", "ana"], "description": "Rotorua Energy Events Centre"},
        {"key": "touch_final", "name": "Touch tournament final", "start": "2026-03-21T09:00", "end": "2026-03-21T12:00",
         "attendees": ["nikau", "aroha_w"]},
        {"key": "reunion", "name": "Tane whānau reunion", "start": "2026-04-04T10:00", "end": "2026-04-04T22:00",
         "attendees": ["hemi_t", "mere", "rawiri", "kiri", "ria", "pita"], "description": "the marae, Easter Saturday"},
        {"key": "hemi_visit", "name": "Hemi visiting from Hamilton", "start": "2026-02-22T11:00",
         "end": "2026-02-22T15:00", "attendees": ["hemi_t"]},
        {"key": "rawiri_call", "name": "Call with Rawiri", "start": "2026-02-22T19:00", "end": "2026-02-22T19:30",
         "attendees": ["rawiri"]},
        {"key": "kevin_coffee", "name": "Coffee with Kevin", "start": "2026-01-24T13:00", "end": "2026-01-24T14:00",
         "attendees": ["kevin"]},
        {"key": "depot_lunch", "name": "Bus depot reunion lunch", "start": "2026-02-27T12:00", "end": "2026-02-27T14:00",
         "attendees": ["kevin", "trev"], "description": "the RSA"},
        {"key": "fishing", "name": "Fishing at Lake Tarawera", "start": "2026-02-15T06:00", "end": "2026-02-15T11:00",
         "attendees": ["hemi_t", "dave"], "cancelled": "2026-02-13T20:00"},
        {"key": "bowls", "name": "Bowls with Trev", "start": "2026-02-18T10:00", "end": "2026-02-18T12:00",
         "attendees": ["trev"], "cancelled": "2026-02-17T08:00"},
        {"key": "working_bee", "name": "Marae working bee", "start": "2026-02-14T13:00", "end": "2026-02-14T16:00",
         "attendees": ["hemi_r", "moana", "pita"], "description": "clear the drains, paint the wharekai"},
        {"key": "hangi_trial", "name": "Hāngī trial run", "start": "2026-03-14T14:00", "end": "2026-03-14T18:00",
         "attendees": ["ngaire", "pita"]},
        {"key": "wof", "name": "Car WOF at Tony's", "start": "2026-02-25T08:00", "end": "2026-02-25T09:00"},
        {"key": "blood", "name": "Blood test", "start": "2026-02-19T08:00", "end": "2026-02-19T08:30"},
        {"key": "school_mtg", "name": "Tama's school meeting", "start": "2026-02-17T15:30", "end": "2026-02-17T16:00",
         "attendees": ["tama"]},
        {"key": "hine_korero", "name": "Kōrero with Whaea Hine", "start": "2026-02-23T10:00",
         "end": "2026-02-23T11:00", "attendees": ["hine"], "description": "new haka for regionals"},
        {"key": "mere_lunch", "name": "Lunch with Mere", "start": "2026-02-20T12:00", "end": "2026-02-20T13:00",
         "attendees": ["mere"]},
        {"key": "ria_cuppa", "name": "Cuppa with Nanny Ria", "start": "2026-02-20T10:00", "end": "2026-02-20T11:00",
         "attendees": ["ria"]},
        {"key": "flight", "name": "Flight to Brisbane", "start": "2026-03-27T07:00", "end": "2026-03-27T10:30",
         "attendees": ["aroha", "mere"], "description": "Air NZ via Auckland"},
        {"key": "tyre", "name": "Tyre change", "start": "2026-02-12T10:00", "end": "2026-02-12T11:00",
         "trashed": "2026-02-10T09:00"},
        {"key": "timetable", "name": "Bus timetable meeting", "start": "2025-11-12T10:00", "end": "2025-11-12T11:00",
         "attendees": ["kevin"], "trashed": "2025-12-02T09:00"},
    ]
    return out


def tasks():
    t = [
        # home
        {"key": "lawns", "name": "Mow the lawns", "due": "2026-02-21", "effort": 45, "list": "home_l"},
        {"key": "spouting", "name": "Clean the spouting", "due": "2026-02-28", "priority": 3, "effort": 90,
         "list": "home_l"},
        {"key": "rates", "name": "Pay the council rates", "due": "2026-02-20", "completed": "2026-02-19T10:00",
         "effort": 10, "list": "home_l"},
        {"key": "smoke", "name": "Check smoke alarms", "effort": 15, "list": "home_l"},
        {"key": "wof_task", "name": "Book the car WOF", "due": "2026-02-18", "completed": "2026-02-16T09:00",
         "list": "home_l"},
        {"key": "insurance", "name": "Renew house insurance", "due": "2026-03-01", "priority": 1, "effort": 30,
         "list": "home_l"},
        {"key": "ute", "name": "Sell the old ute", "status": "cancelled", "list": "home_l"},
        {"key": "fence", "name": "Fix the back fence", "status": "in_progress", "priority": 4, "effort": 240,
         "list": "home_l", "description": "two posts rotten by the clothesline"},
        {"key": "tap", "name": "Fix the kitchen tap", "due": "2026-03-03", "effort": 60, "list": "home_l"},
        {"key": "mara", "name": "Water the māra kai", "due": "2026-02-22", "effort": 30, "list": "home_l"},
        # marae
        {"key": "roof_quotes", "name": "Get quotes for the wharekai roof", "due": "2026-02-27", "priority": 1,
         "effort": 60, "list": "marae_l", "description": "three quotes before the March hui"},
        {"key": "minutes", "name": "Type up the committee minutes", "due": "2026-02-05",
         "completed": "2026-02-04T19:00", "list": "marae_l"},
        {"key": "koha_book", "name": "Update the koha book", "due": "2026-02-24", "priority": 2, "effort": 30,
         "list": "marae_l"},
        {"key": "mattresses", "name": "Air the wharenui mattresses", "due": "2026-03-01", "effort": 120,
         "list": "marae_l"},
        {"key": "mower", "name": "Service the marae mower", "status": "cancelled", "list": "marae_l"},
        {"key": "agenda", "name": "Draft the March hui agenda", "due": "2026-02-26", "effort": 45, "list": "marae_l"},
        # reunion
        {"key": "venue", "name": "Confirm the reunion venue", "due": "2026-02-10", "completed": "2026-02-09T15:00",
         "list": "reunion_l"},
        {"key": "tshirts", "name": "Order reunion t-shirts", "due": "2026-03-06", "priority": 2, "effort": 60,
         "list": "reunion_l"},
        {"key": "invites", "name": "Send reunion invites", "status": "in_progress", "priority": 1, "effort": 180,
         "due": "2026-02-28", "list": "reunion_l"},
        {"key": "inv_aus", "name": "Invite the Australia whānau", "parent": "invites", "due": "2026-02-25",
         "effort": 30},
        {"key": "inv_fb", "name": "Post on the whānau Facebook page", "parent": "invites", "due": "2026-02-23",
         "effort": 15},
        {"key": "inv_kaum", "name": "Ring the kaumātua", "parent": "invites", "due": "2026-02-27", "effort": 60},
        {"key": "chart", "name": "Print the whakapapa chart", "due": "2026-03-20", "priority": 2, "effort": 90,
         "list": "reunion_l"},
        {"key": "slideshow", "name": "Make the photo slideshow", "due": "2026-03-30", "effort": 240,
         "list": "reunion_l"},
        # reunion catering
        {"key": "meat", "name": "Order meat for the hāngī", "due": "2026-03-25", "priority": 1, "effort": 30,
         "list": "reunion_cat_l"},
        {"key": "stones", "name": "Sort the hāngī stones", "due": "2026-03-28", "effort": 120,
         "list": "reunion_cat_l"},
        {"key": "kai_list", "name": "Write the kai list", "due": "2026-02-20", "completed": "2026-02-18T20:00",
         "list": "reunion_cat_l"},
        # kapa haka
        {"key": "piupiu", "name": "Fix Ana's piupiu", "due": "2026-03-10", "effort": 90, "list": "kapa_l"},
        {"key": "waiata", "name": "Learn the new waiata words", "due": "2026-03-18", "effort": 60,
         "status": "in_progress", "list": "kapa_l"},
        {"key": "van", "name": "Book a van for regionals", "due": "2026-03-05", "priority": 2, "effort": 20,
         "list": "kapa_l"},
        {"key": "uniforms", "name": "Wash the kapa haka uniforms", "due": "2026-02-17",
         "completed": "2026-02-17T18:00", "list": "kapa_l"},
        # mokopuna sport
        {"key": "spikes", "name": "Buy cricket spikes for Tama", "due": "2026-02-27", "effort": 45, "list": "sport_l"},
        {"key": "netball_fees", "name": "Pay Ana's netball fees", "due": "2026-02-26", "priority": 2, "effort": 10,
         "list": "sport_l"},
        {"key": "touch_rego", "name": "Register Nikau and Ro for touch", "due": "2026-01-20",
         "completed": "2026-01-18T10:00", "list": "sport_l"},
        {"key": "bottles", "name": "Buy drink bottles for touch", "effort": 15, "list": "sport_l"},
        {"key": "rides", "name": "Organise rides to the regatta", "due": "2026-03-05", "effort": 30,
         "list": "sport_l"},
        # shopping
        {"key": "kumara", "name": "Buy kūmara", "due": "2026-02-21", "effort": 20, "list": "shop_l"},
        {"key": "gift", "name": "Buy Aroha's birthday present", "due": "2026-02-25", "priority": 1, "effort": 60,
         "list": "shop_l", "description": "the pounamu she liked at the market"},
        {"key": "batteries", "name": "Buy hearing aid batteries", "effort": 10, "list": "shop_l"},
        # loose
        {"key": "thanks", "name": "Send thank-you cards after the tangi", "due": "2026-02-20", "priority": 2,
         "effort": 60},
        {"key": "will", "name": "Update my will", "due": "2026-03-31", "priority": 3, "effort": 120},
        {"key": "passport_t", "name": "Renew passport for Brisbane", "due": "2026-02-27", "priority": 1,
         "effort": 45},
        {"key": "hearing", "name": "Book a hearing test", "due": "2026-03-10", "effort": 10},
        {"key": "ring_rawiri", "name": "Ring Rawiri about flights", "due": "2026-02-22", "effort": 15},
        {"key": "gp_forms", "name": "Fill in the GP forms", "due": "2026-02-23", "effort": 20},
        {"key": "moko_money", "name": "Put money in the mokopuna accounts", "due": "2026-02-28", "effort": 15},
        {"key": "koha_tangi", "name": "Drop koha to Tui", "due": "2026-02-13", "completed": "2026-02-12T15:00"},
        # trashed
        {"key": "garage", "name": "Clean out the garage", "list": "home_l", "trashed": "2026-02-14T10:00"},
        {"key": "library", "name": "Return library books", "due": "2026-02-06", "trashed": "2026-02-05T10:00"},
        {"key": "sky", "name": "Cancel Sky TV", "trashed": "2025-12-20T10:00"},
    ]
    # power bill, monthly on the 20th
    for m, done in ((("2025", 12), "2025-12-19T09:00"), (("2026", 1), "2026-01-19T09:00")):
        t.append({"key": f"power_{m[1]:02d}", "name": "Pay the power bill", "due": f"{m[0]}-{m[1]:02d}-20",
                  "completed": done, "list": "home_l", "effort": 5})
    t.append({"key": "power_02", "name": "Pay the power bill", "due": "2026-02-20", "list": "home_l", "effort": 5})
    t.append({"key": "power_03", "name": "Pay the power bill", "due": "2026-03-20", "list": "home_l", "effort": 5})
    return t


NOTEBOOKS = [
    {"key": "marae_nb", "name": "Marae committee"},
    {"key": "kapa_nb", "name": "Kapa haka notes"},
    {"key": "whak_nb", "name": "Whakapapa"},
    {"key": "recipes_nb", "name": "Recipes"},
    {"key": "reunion_nb", "name": "Reunion planning"},
    {"key": "garden_nb", "name": "Māra kai"},
    {"key": "bus_nb", "name": "Bus stories"},
]

NOTES = [
    {"key": "hui_notes", "name": "Committee hui February", "body": "roof quotes, koha book audit, working bee on the 14th",
     "notebook": "marae_nb", "created": "2026-02-01T16:30"},
    {"key": "roof_note", "name": "Wharekai roof", "body": "leaks over the kitchen, Hemi knows a roofer",
     "notebook": "marae_nb", "created": "2026-02-14T17:00"},
    {"key": "marae_rules", "name": "Marae rules", "body": "no shoes in the wharenui, no kai in the wharenui",
     "notebook": "marae_nb", "created": "2025-10-01T10:00", "pinned": True},
    {"key": "waiata_list", "name": "Waiata list", "body": "E pari rā, Tūtira mai, the new haka for regionals",
     "notebook": "kapa_nb", "created": "2026-01-07T21:00", "pinned": True},
    {"key": "regionals_note", "name": "Regionals notes", "body": "entry at 1pm, Ana front row, Rangi leads",
     "notebook": "kapa_nb", "created": "2026-02-18T21:00"},
    {"key": "whakapapa", "name": "Tane whakapapa", "body": "Tamati m. Huria, nine children, Koro was the youngest",
     "notebook": "whak_nb", "created": "2025-08-01T10:00", "pinned": True},
    {"key": "ngata_line", "name": "Ngata line", "body": "Hohepa, Pita and Tui's side, from Ōhinemutu",
     "notebook": "whak_nb", "created": "2026-01-15T19:00"},
    {"key": "ria_qs", "name": "Questions for Nanny Ria", "body": "who was Koro's first wife, where is the old photo box",
     "notebook": "whak_nb", "created": "2026-02-20T11:15"},
    {"key": "rewena", "name": "Aroha's rewena bread", "body": "potato bug, feed it every second day",
     "notebook": "recipes_nb", "created": "2025-11-10T15:00"},
    {"key": "boilup", "name": "Boil-up", "body": "pork bones, watercress, doughboys on top",
     "notebook": "recipes_nb", "created": "2026-01-30T18:00"},
    {"key": "pudding", "name": "Steamed pudding", "body": "golden syrup, two hours in the pot",
     "notebook": "recipes_nb", "created": "2025-12-20T14:00"},
    {"key": "budget", "name": "Reunion budget", "body": "hall 800, hāngī 1500, t-shirts 900",
     "notebook": "reunion_nb", "created": "2026-02-08T16:30"},
    {"key": "guest_list", "name": "Reunion guest list", "body": "tbc", "notebook": "reunion_nb",
     "created": "2026-02-09T20:00"},
    {"key": "hangi_plan", "name": "Hāngī plan", "body": "pit at 5am, stones from Pita, 120 people",
     "notebook": "reunion_nb", "created": "2026-02-18T19:00"},
    {"key": "planting", "name": "Planting plan", "body": "kūmara in October, pūhā along the fence",
     "notebook": "garden_nb", "created": "2025-09-20T09:00"},
    {"key": "speech", "name": "Speech for Uncle Hohepa", "body": "his bus route stories, the eel weir, his waiata",
     "created": "2026-02-10T22:00", "pinned": True},
    {"key": "brisbane_ideas", "name": "Brisbane trip ideas", "body": "Rawiri's footy game, the Gold Coast",
     "created": "2026-02-15T20:00"},
    {"key": "doc_qs", "name": "Doctor questions", "body": "blood pressure pills, the left knee",
     "created": "2026-02-19T09:00"},
    {"key": "cricket_stats", "name": "Tama's cricket stats", "body": "34 not out, two wickets",
     "created": "2026-02-14T12:30"},
    {"key": "tell_rawiri", "name": "Things to tell Rawiri", "body": "tbc", "created": "2026-02-21T09:00"},
    {"key": "reo", "name": "Te reo phrases for the mokopuna", "body": "kia tūpato, kei te pēhea koe, haere mai",
     "created": "2026-01-20T19:00"},
    {"key": "tshirt_sizes", "name": "T-shirt sizes", "body": "mostly XL, six kids sizes",
     "created": "2026-02-19T21:40"},
    # trashed
    {"key": "old_koha", "name": "Old koha list", "body": "2025 koha", "created": "2025-12-01T10:00",
     "trashed": "2026-02-12T10:00"},
    {"key": "xmas_menu", "name": "Christmas menu", "body": "ham, pāua fritters, pavlova", "created": "2025-12-10T10:00",
     "trashed": "2026-02-02T10:00"},
    {"key": "reunion_2023", "name": "2023 reunion notes", "body": "old notes", "created": "2023-04-01T10:00",
     "trashed": "2025-12-10T10:00"},
]

FOLDERS = [
    {"key": "marae_f", "name": "Marae"},
    {"key": "whanau_f", "name": "Whānau"},
    {"key": "health_f", "name": "Health"},
    {"key": "house_f", "name": "House"},
    {"key": "reunion_f", "name": "Reunion"},
    {"key": "pension_f", "name": "Pension"},
    {"key": "oldbus_f", "name": "Old bus stuff"},
]

DOCUMENTS = [
    {"key": "trust_deed", "name": "Marae trust deed", "folder": "marae_f", "created": "2019-05-01T10:00",
     "starred": True},
    {"key": "roof_quote", "name": "Wharekai roof quote", "folder": "marae_f", "created": "2026-02-16T14:20"},
    {"key": "minutes_doc", "name": "Committee minutes February", "folder": "marae_f", "created": "2026-02-04T19:00"},
    {"key": "chart_scan", "name": "Whakapapa chart scan", "folder": "whanau_f", "created": "2025-08-02T10:00"},
    {"key": "notice", "name": "Uncle Hohepa's funeral notice", "folder": "whanau_f", "created": "2026-02-10T21:30"},
    {"key": "blood_results", "name": "Blood test results", "folder": "health_f", "created": "2026-02-20T15:45"},
    {"key": "hearing_warranty", "name": "Hearing aid warranty", "folder": "health_f", "created": "2024-06-10T10:00"},
    {"key": "policy", "name": "House insurance policy", "folder": "house_f", "created": "2025-03-01T10:00",
     "starred": True},
    {"key": "rates_notice", "name": "Council rates notice", "folder": "house_f", "created": "2026-01-15T10:00"},
    {"key": "power_jan", "name": "Power bill January", "folder": "house_f", "created": "2026-01-28T08:00"},
    {"key": "venue_booking", "name": "Reunion venue booking", "folder": "reunion_f", "created": "2026-02-09T15:30"},
    {"key": "tshirt_design", "name": "T-shirt design", "folder": "reunion_f", "created": "2026-02-19T21:15"},
    {"key": "super", "name": "Super statement", "folder": "pension_f", "created": "2026-01-10T10:00"},
    {"key": "service_cert", "name": "Bus company service certificate", "folder": "pension_f",
     "created": "2020-06-30T10:00", "starred": True},
    {"key": "scan", "name": "Scan 0221", "created": "2026-02-21T09:40"},
    {"key": "itinerary", "name": "Brisbane flight itinerary", "created": "2026-02-18T20:10"},
    {"key": "draw", "name": "Netball draw", "created": "2026-02-17T18:00"},
    # trashed
    {"key": "old_will", "name": "Old will", "folder": "whanau_f", "created": "2015-03-01T10:00",
     "trashed": "2026-02-01T10:00"},
    {"key": "power_dec", "name": "Power bill December", "folder": "house_f", "created": "2025-12-28T08:00",
     "trashed": "2026-01-05T10:00"},
]

ALBUMS = [
    {"key": "moko_al", "name": "Mokopuna"},
    {"key": "kapa_al", "name": "Kapa haka 2026"},
    {"key": "waitangi_al", "name": "Waitangi Day"},
    {"key": "reunion23_al", "name": "Reunion 2023"},
    {"key": "hohepa_al", "name": "Uncle Hohepa"},
    {"key": "bus_al", "name": "Bus days"},
    {"key": "brisbane_al", "name": "Brisbane 2026"},
]

PHOTOS = [
    {"key": "p_cricket", "name": "Tama batting", "taken": "2026-02-14T10:30", "albums": ["moko_al"],
     "people": ["tama"], "starred": True},
    {"key": "p_touch", "name": "Nikau scores a try", "taken": "2026-02-16T18:05", "albums": ["moko_al"],
     "people": ["nikau", "aroha_w"]},
    {"key": "p_waka", "name": "Manaia on the lake", "taken": "2026-02-20T16:30", "albums": ["moko_al"],
     "people": ["manaia"]},
    {"key": "p_netball", "name": "Ana at netball", "taken": "2026-02-07T13:40", "albums": ["moko_al"],
     "people": ["ana"]},
    {"key": "p_ro", "name": "Ro with her medal", "taken": "2026-01-31T17:00", "albums": ["moko_al"],
     "people": ["aroha_w"], "starred": True},
    {"key": "p_moko_all", "name": "All five mokopuna", "taken": "2026-01-01T15:00", "albums": ["moko_al"],
     "people": ["manaia", "tama", "ana", "aroha_w", "nikau"], "starred": True},
    {"key": "p_practice", "name": "Practice in the wharenui", "taken": "2026-02-18T19:30", "albums": ["kapa_al"],
     "people": ["hine", "ana"]},
    {"key": "p_poi", "name": "Poi line", "taken": "2026-02-11T19:15", "albums": ["kapa_al"],
     "people": ["ana", "wiki"]},
    {"key": "p_hine", "name": "Whaea Hine teaching", "taken": "2026-01-21T19:00", "albums": ["kapa_al"],
     "people": ["hine"]},
    {"key": "p_dawn", "name": "Dawn service", "taken": "2026-02-06T05:45", "albums": ["waitangi_al"],
     "people": ["hemi_r", "pita"], "starred": True},
    {"key": "p_hangi_w", "name": "Lifting the hāngī", "taken": "2026-02-06T12:30", "albums": ["waitangi_al"],
     "people": ["pita"]},
    {"key": "p_flags", "name": "Flags at the marae", "taken": "2026-02-06T09:00", "albums": ["waitangi_al"]},
    {"key": "p_reunion23", "name": "Reunion 2023 group photo", "taken": "2023-04-08T15:00", "albums": ["reunion23_al"],
     "people": ["hemi_t", "mere", "rawiri", "kiri", "ria", "pita"], "starred": True},
    {"key": "p_haka23", "name": "Haka for the kaumātua", "taken": "2023-04-08T12:00", "albums": ["reunion23_al"],
     "people": ["manaia", "tama"]},
    {"key": "p_hohepa", "name": "Uncle Hohepa at the lake", "taken": "2019-01-12T11:00", "albums": ["hohepa_al"],
     "starred": True},
    {"key": "p_urupa", "name": "Flowers at the urupā", "taken": "2026-02-11T15:30", "albums": ["hohepa_al"],
     "people": ["pita", "tui", "ria"]},
    {"key": "p_bus", "name": "My last route 11 bus", "taken": "2020-06-30T17:00", "albums": ["bus_al"],
     "people": ["kevin"], "starred": True},
    {"key": "p_depot", "name": "Depot crew 2015", "taken": "2015-12-18T12:00", "albums": ["bus_al"],
     "people": ["kevin", "trev"]},
    {"key": "p_working", "name": "Working bee crew", "taken": "2026-02-14T15:00", "people": ["hemi_r", "moana", "pita"]},
    {"key": "p_roof", "name": "Leaky wharekai roof", "taken": "2026-02-14T14:00"},
    {"key": "p_lunch", "name": "Lunch with Mere at the lakefront", "taken": "2026-02-20T12:20", "people": ["mere"]},
    {"key": "p_ria", "name": "Nanny Ria's garden", "taken": "2026-02-20T10:40", "people": ["ria"]},
    {"key": "p_school", "name": "Tama's school", "taken": "2026-02-17T15:25", "people": ["tama"]},
    {"key": "p_kumara", "name": "Kūmara harvest", "taken": "2026-02-15T09:00", "people": ["aroha"]},
    {"key": "p_sunset", "name": "Sunset over Lake Rotorua", "taken": "2026-02-13T20:30"},
    {"key": "p_geyser", "name": "Pōhutu going off", "taken": "2026-02-13T11:00"},
    {"key": "p_aroha", "name": "Aroha in the garden", "taken": "2026-02-21T08:15", "people": ["aroha"]},
    {"key": "p_receipt", "name": "Hall deposit receipt", "taken": "2026-02-09T15:40"},
    {"key": "p_tshirt", "name": "T-shirt sample", "taken": "2026-02-19T21:20", "people": ["mere"]},
    {"key": "p_rawiri", "name": "Rawiri's new house", "taken": "2026-02-08T19:00", "people": ["rawiri"]},
    {"key": "p_fishing", "name": "Tarawera from the boat ramp", "taken": "2026-01-18T07:00", "people": ["hemi_t", "dave"]},
    {"key": "p_bday", "name": "Aroha's cake last year", "taken": "2025-02-26T20:00", "people": ["aroha", "mere"]},
    # trashed
    {"key": "p_blurry", "name": "Blurry haka shot", "taken": "2026-02-18T19:35", "albums": ["kapa_al"],
     "trashed": "2026-02-19T09:00"},
    {"key": "p_dup", "name": "Duplicate cricket photo", "taken": "2026-02-14T10:31", "trashed": "2026-02-15T09:00"},
    {"key": "p_sign", "name": "Old depot sign", "taken": "2016-03-01T10:00", "albums": ["bus_al"],
     "trashed": "2025-12-01T09:00"},
]

DEBTS = [
    {"key": "d_kevin", "person": "kevin", "direction": "owes_me", "amount": 40, "name": "Petrol to Taupō",
     "date": "2026-01-24"},
    {"key": "d_trev", "person": "trev", "direction": "i_owe", "amount": 25, "name": "Bowls fees",
     "date": "2026-02-11"},
    {"key": "d_mere", "person": "mere", "direction": "owes_me", "amount": 150, "name": "Power bill share",
     "date": "2026-02-02"},
    {"key": "d_hemi", "person": "hemi_t", "direction": "i_owe", "amount": 300, "name": "Ute repairs",
     "date": "2026-01-12"},
    {"key": "d_kiri", "person": "kiri", "direction": "owes_me", "amount": 60, "name": "Netball fees",
     "date": "2026-02-16"},
    {"key": "d_rawiri", "person": "rawiri", "direction": "owes_me", "amount": 500, "name": "Flights deposit",
     "date": "2026-02-18"},
    {"key": "d_ngaire", "person": "ngaire", "direction": "i_owe", "amount": 220, "name": "Hāngī catering deposit",
     "date": "2026-02-19"},
    {"key": "d_pita", "person": "pita", "direction": "i_owe", "amount": 80, "name": "Tangi petrol",
     "date": "2026-02-12"},
    {"key": "d_moana", "person": "moana", "direction": "owes_me", "amount": 35, "name": "Koha tin top-up",
     "date": "2026-02-14"},
    {"key": "d_ria", "person": "ria", "direction": "i_owe", "amount": 50, "name": "Groceries",
     "date": "2026-02-20"},
    {"key": "d_dave", "person": "dave", "direction": "owes_me", "amount": 120, "name": "Fishing gear",
     "date": "2025-12-28", "settled": "2026-01-15T10:00"},
    {"key": "d_huia", "person": "huia", "direction": "owes_me", "amount": 25, "name": "Printing",
     "date": "2026-01-05", "settled": "2026-01-20T10:00"},
    {"key": "d_sam", "person": "sam", "direction": "i_owe", "amount": 15, "name": "Mower petrol",
     "date": "2026-02-21"},
]

LOCKER = [
    {"key": "asb", "name": "ASB online banking", "type": "login", "username": "wiremu.tane",
     "url": "https://www.asb.co.nz", "password": "Rotoiti-Kuia-58", "starred": True, "notes": "personal"},
    {"key": "trust_portal", "name": "Marae trust portal", "type": "login", "username": "wtane.committee",
     "url": "https://trust.example.nz", "password": "Wharekai-Roof-26", "notes": "committee"},
    {"key": "airnz", "name": "Air NZ Airpoints", "type": "login", "username": "wiremu58",
     "url": "https://www.airnewzealand.co.nz", "password": "Kotuku-Flight-7"},
    {"key": "visa", "name": "ASB Visa", "type": "card", "card_number": "4988 1122 3344 5566", "cvv": "742",
     "starred": True},
    {"key": "alarm", "name": "Marae alarm code", "type": "note", "notes": "code 1-8-4-0, panel by the kitchen door"},
    {"key": "csc", "name": "Community services card", "type": "identity", "password": "CSC-88213"},
    {"key": "wifi", "name": "Home wifi", "type": "wifi", "password": "kumara-patch-44"},
    {"key": "wifi_marae", "name": "Marae wifi", "type": "wifi", "password": "wharenui-2026"},
    {"key": "padlock", "name": "Gate padlock code", "type": "password", "password": "3318"},
    {"key": "ssh", "name": "Home PC backup key", "type": "ssh_key", "notes": "photo backup drive"},
    {"key": "tides", "name": "Tides API key", "type": "api_credential", "notes": "for the fishing app"},
    {"key": "passport_l", "name": "NZ passport", "type": "passport", "notes": "expires March 2026"},
    {"key": "reunion_acct", "name": "Reunion account", "type": "bank_account", "notes": "Kiwibank, Mere co-signs"},
    {"key": "licence", "name": "Driver licence", "type": "driving_licence", "notes": "class 2, P endorsement lapsed"},
    {"key": "office", "name": "Microsoft 365 family", "type": "software_licence", "notes": "renews in May"},
    {"key": "bitcoin", "name": "Bitcoin from Rawiri", "type": "crypto_wallet", "notes": "tiny, a gift from 2021"},
    {"key": "supergold", "name": "SuperGold card", "type": "membership", "notes": "discounts at Mitre 10",
     "starred": True},
    {"key": "housing", "name": "Kaumātua housing papers", "type": "document", "notes": "council flat waitlist"},
    {"key": "old_sky", "name": "Old Sky TV login", "type": "login", "username": "tanewhanau",
     "url": "https://www.sky.co.nz", "password": "Rugby-Sky-99", "trashed": "2026-02-09T09:00"},
    {"key": "old_spark", "name": "Old Spark email", "type": "login", "username": "wtane@xtra",
     "url": "https://www.spark.co.nz", "password": "Xtra-Mail-1", "trashed": "2025-11-30T09:00"},
]

LINKS = [
    {"from": "fence", "to": "hemi_t"},
    {"from": "roof_quotes", "to": "hemi_r"},
    {"from": "roof_quotes", "to": "moana"},
    {"from": "koha_book", "to": "moana"},
    {"from": "agenda", "to": "hemi_r"},
    {"from": "agenda", "to": "huia"},
    {"from": "tshirts", "to": "mere"},
    {"from": "inv_aus", "to": "rawiri"},
    {"from": "inv_kaum", "to": "pita"},
    {"from": "inv_kaum", "to": "ria"},
    {"from": "slideshow", "to": "manaia"},
    {"from": "meat", "to": "ngaire"},
    {"from": "stones", "to": "pita"},
    {"from": "kai_list", "to": "ngaire"},
    {"from": "piupiu", "to": "ana"},
    {"from": "piupiu", "to": "hine"},
    {"from": "van", "to": "rangi"},
    {"from": "spikes", "to": "tama"},
    {"from": "netball_fees", "to": "ana"},
    {"from": "touch_rego", "to": "nikau"},
    {"from": "touch_rego", "to": "aroha_w"},
    {"from": "rides", "to": "manaia"},
    {"from": "rides", "to": "kiri"},
    {"from": "gift", "to": "aroha"},
    {"from": "thanks", "to": "pita"},
    {"from": "thanks", "to": "tui"},
    {"from": "ring_rawiri", "to": "rawiri"},
    {"from": "koha_tangi", "to": "tui"},
    {"from": "hui_notes", "to": "hemi_r"},
    {"from": "hui_notes", "to": "huia"},
    {"from": "hui_notes", "to": "moana"},
    {"from": "roof_note", "to": "hemi_r"},
    {"from": "regionals_note", "to": "hine"},
    {"from": "regionals_note", "to": "rangi"},
    {"from": "regionals_note", "to": "ana"},
    {"from": "ngata_line", "to": "pita"},
    {"from": "ngata_line", "to": "tui"},
    {"from": "ria_qs", "to": "ria"},
    {"from": "rewena", "to": "aroha"},
    {"from": "budget", "to": "mere"},
    {"from": "budget", "to": "kiri"},
    {"from": "hangi_plan", "to": "ngaire"},
    {"from": "hangi_plan", "to": "pita"},
    {"from": "speech", "to": "pita"},
    {"from": "brisbane_ideas", "to": "rawiri"},
    {"from": "cricket_stats", "to": "tama"},
    {"from": "tell_rawiri", "to": "rawiri"},
    {"from": "tshirt_sizes", "to": "mere"},
]


def world():
    return {
        "me": "Wiremu Tane",
        "epoch": "2015-01-01T09:00",
        "seed": "T28",
        "currency": "NZD",
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
    out = HERE / "T28.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
