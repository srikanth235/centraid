"""World T33: Hiro and Mei Tanaka-Lim's household vault (Singapore, SGD vault).

    python3 authored/worlds/T33_build.py      # writes authored/worlds/T33.json (deterministic)

Today in the sessions is Saturday 2026-12-12 08:50 (breakfast before Kenji's swim class, the helper is
off on Saturdays this month, the condo year-end rush has started).

Persona: Hiro Tanaka-Lim, 38, a software engineer at a logistics company, with his wife Mei Tanaka-Lim, 38,
a hospital pharmacist (both use the vault; the vault owner is Hiro and Mei is a person row). Their toddler
Kenji is two. Rina Santos is their live-in helper (a Sunday off most weeks). They live in a condo, Parc
Vista in Bishan, where Hiro sits on the management committee (the "Parc Vista Committee" group). Mei's
parents Pa and Ma live in Penang (the one foreign-currency position is the MYR group "Penang Family Fund",
a vault debt can only be in the vault's own currency); Hiro's parents Okaasan and Otousan are in Osaka.

Built-in ambiguity: two Davids (David Lee, committee treasurer; David Ng, a colleague), two look-alike
Priyas (Priya Nair from the playgroup, Priya Nayar from work), hard-to-spell names (Kuldeep Singh Dhillon,
Rosnah Abdullah), nicknames (Pa, Ma, Okaasan, Ate Rina, Teacher Amanda, Mr Chua, Auntie Fong), look-alike
events (Toddler swim and Toddler swim - makeup, Committee meeting and Committee meeting - budget, two
Paediatrician check-ups, two Aircon servicing), near-duplicate tasks (three "Pay condo maintenance fee",
two "Renew Rina's work permit"), cancelled events, completed and cancelled tasks, and trashed rows of
every trashable kind (some inside the 30-day restore window, some past it).
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

ME = "Hiro Tanaka-Lim"
TODAY = "2026-12-12T08:50"
TODAY_D = dt.date(2026, 12, 12)

people = [
    {"key": "mei", "name": "Mei Tanaka-Lim", "role": "wife", "starred": True, "cadence": 1,
     "last_contacted": "2026-12-12T07:30", "created": "2025-06-01T09:00"},
    {"key": "kenji", "name": "Kenji Tanaka-Lim", "role": "son", "starred": True, "cadence": 1,
     "last_contacted": "2026-12-12T07:00"},
    {"key": "rina", "name": "Rina Santos", "role": "helper", "nickname": "Ate Rina", "starred": True,
     "cadence": 1, "last_contacted": "2026-12-11T21:00", "met": "Parc Vista"},
    {"key": "pa", "name": "Lim Kok Leong", "role": "father-in-law", "nickname": "Pa", "cadence": 7,
     "last_contacted": "2026-12-08T20:00", "last_contacted_kind": "call", "met": "Penang"},
    {"key": "ma", "name": "Tan Siew Lan", "role": "mother-in-law", "nickname": "Ma", "starred": True, "cadence": 3,
     "last_contacted": "2026-12-10T20:30", "last_contacted_kind": "call", "met": "Penang"},
    {"key": "junhao", "name": "Lim Jun Hao", "role": "brother-in-law", "cadence": 21,
     "last_contacted": "2026-11-28T19:00", "met": "Penang"},
    {"key": "okaasan", "name": "Tanaka Yoko", "role": "mother", "nickname": "Okaasan", "starred": True,
     "cadence": 7, "last_contacted": "2026-12-06T20:30", "last_contacted_kind": "call", "met": "Osaka"},
    {"key": "otousan", "name": "Tanaka Kenichi", "role": "father", "nickname": "Otousan", "cadence": 14,
     "last_contacted": "2026-12-06T20:40", "last_contacted_kind": "call", "met": "Osaka"},
    {"key": "chua", "name": "Chua Boon Keng", "role": "committee chairman", "nickname": "Mr Chua",
     "met": "Parc Vista", "cadence": 14, "last_contacted": "2026-12-03T19:00"},
    {"key": "david_l", "name": "David Lee", "role": "committee treasurer", "met": "Parc Vista"},
    {"key": "fong", "name": "Fong Mei Yin", "role": "committee member", "nickname": "Auntie Fong",
     "met": "Parc Vista"},
    {"key": "rosnah", "name": "Rosnah Abdullah", "role": "committee secretary", "met": "Parc Vista"},
    {"key": "kuldeep", "name": "Kuldeep Singh Dhillon", "role": "committee member", "met": "Parc Vista"},
    {"key": "wong", "name": "Wong Lai Peng", "role": "neighbour", "nickname": "Mdm Wong", "met": "Parc Vista"},
    {"key": "amanda", "name": "Amanda Koh", "role": "playgroup teacher", "nickname": "Teacher Amanda",
     "met": "Little Sprouts", "cadence": 30, "last_contacted": "2026-11-20T09:00"},
    {"key": "priya_nair", "name": "Priya Nair", "role": "playgroup parent", "met": "Little Sprouts",
     "last_contacted": "2026-12-09T10:30", "last_contacted_kind": "message"},
    {"key": "priya_nayar", "name": "Priya Nayar", "role": "colleague", "met": "work"},
    {"key": "sarah", "name": "Sarah Goh", "role": "playgroup parent", "met": "Little Sprouts"},
    {"key": "jiahui", "name": "Tan Jia Hui", "role": "playgroup parent", "met": "Little Sprouts"},
    {"key": "david_n", "name": "David Ng", "role": "colleague", "met": "work", "cadence": 30,
     "last_contacted": "2026-12-04T15:00"},
    {"key": "weijie", "name": "Teo Wei Jie", "role": "friend", "met": "NUS", "starred": True, "cadence": 14,
     "last_contacted": "2026-12-01T21:00"},
    {"key": "ravi", "name": "Ravi Subramaniam", "role": "friend", "met": "NUS"},
    {"key": "celine", "name": "Celine Ho", "role": "friend", "met": "NUS"},
    {"key": "ong", "name": "Ong Beng Hock", "role": "paediatrician", "nickname": "Dr Ong"},
    {"key": "dentist", "name": "Vanessa Tay", "role": "dentist", "nickname": "Dr Tay"},
    {"key": "ahseng", "name": "Lee Ah Seng", "role": "aircon technician", "nickname": "Ah Seng"},
    {"key": "agency", "name": "Grace Pereira", "role": "maid agency contact", "met": "Helpers Hub"},
    {"key": "stella", "name": "Stella Ng", "role": "managing agent", "met": "Parc Vista"},
    {"key": "kim", "name": "Kim Soo-ah", "role": "friend", "met": "Bishan"},
    {"key": "old_col", "name": "Marcus Teo", "role": "old colleague", "met": "previous job",
     "trashed": "2026-08-10T10:00"},
    {"key": "old_agent", "name": "Pamela Yeo", "role": "old property agent", "met": "Bishan",
     "trashed": "2026-11-26T10:00"},
]

groups = [
    {"key": "committee", "name": "Parc Vista Committee", "currency": "SGD",
     "members": ["chua", "david_l", "fong", "rosnah", "kuldeep"], "created": "2025-03-10T19:00"},
    {"key": "playgroup", "name": "Little Sprouts Playgroup", "currency": "SGD",
     "members": ["amanda", "priya_nair", "sarah", "jiahui"], "created": "2026-01-12T09:00"},
    {"key": "penang", "name": "Penang Family Fund", "currency": "MYR",
     "members": ["pa", "ma", "junhao", "mei"], "created": "2025-12-01T20:00"},
    {"key": "household", "name": "Household with Mei", "currency": "SGD", "members": ["mei"],
     "created": "2025-06-01T10:00"},
    {"key": "dinner", "name": "NUS Dinner Club", "currency": "SGD", "members": ["weijie", "ravi", "celine", "kim"],
     "created": "2026-02-03T20:00"},
    {"key": "okaasan_gift", "name": "Okaasan Birthday Gift", "currency": "SGD", "members": ["mei"],
     "created": "2026-12-01T21:00"},
]

expenses = [
    {"group": "committee", "name": "Fireworks for National Day", "amount": 2400, "paid_by": "chua",
     "split": ["me", "chua", "david_l", "fong", "rosnah", "kuldeep"], "date": "2026-08-09"},
    {"group": "committee", "name": "AGM printing", "amount": 180, "paid_by": "me",
     "split": ["me", "rosnah", "david_l"], "date": "2026-11-18"},
    {"group": "committee", "name": "Christmas lights for the lobby", "amount": 360, "paid_by": "fong",
     "split": ["me", "fong", "chua", "kuldeep"], "date": "2026-12-02"},
    {"group": "playgroup", "name": "Art supplies", "amount": 96, "paid_by": "priya_nair",
     "split": ["me", "priya_nair", "sarah", "jiahui"], "date": "2026-10-14"},
    {"group": "playgroup", "name": "Teacher's appreciation gift", "amount": 120, "paid_by": "me",
     "split": ["me", "priya_nair", "sarah", "jiahui", "amanda"], "date": "2026-11-27"},
    {"group": "playgroup", "name": "Pumpkin patch outing", "amount": 210, "paid_by": "jiahui",
     "split": ["me", "jiahui", "sarah"], "date": "2026-10-31"},
    {"group": "penang", "name": "Ma's cataract surgery", "amount": 4800, "paid_by": "junhao",
     "split": ["me", "junhao", "mei"], "date": "2026-09-15"},
    {"group": "penang", "name": "Chinese New Year hampers", "amount": 900, "paid_by": "me",
     "split": ["me", "pa", "ma", "junhao"], "date": "2026-11-10"},
    {"group": "penang", "name": "Penang house roof", "amount": 6500, "paid_by": "pa",
     "split": ["me", "pa", "junhao"], "date": "2026-07-04"},
    {"group": "household", "name": "Kenji's stroller", "amount": 420, "paid_by": "mei",
     "split": ["me", "mei"], "date": "2026-10-03"},
    {"group": "household", "name": "Fairprice shop", "amount": 168, "paid_by": "me",
     "split": ["me", "mei"], "date": "2026-12-05"},
    {"group": "dinner", "name": "Omakase night", "amount": 640, "paid_by": "weijie",
     "split": ["me", "weijie", "ravi", "celine"], "date": "2026-11-14"},
    {"group": "dinner", "name": "Hotpot at Haidilao", "amount": 285, "paid_by": "me",
     "split": ["me", "ravi", "kim", "celine"], "date": "2026-10-10"},
]

lists = [
    {"key": "home_l", "name": "Home", "area": "home"},
    {"key": "kenji_l", "name": "Kenji", "area": "family"},
    {"key": "condo_l", "name": "Condo Committee", "area": "social"},
    {"key": "work_l", "name": "Work", "area": "work"},
    {"key": "penang_l", "name": "Penang Trip", "area": "family"},
    {"key": "money_l", "name": "Money", "area": "home"},
]

# ------------------------------------------------------------------------------------------------
# events
# ------------------------------------------------------------------------------------------------

events = []
_busy = []


def dtm(day, hhmm):
    h, m = hhmm.split(":")
    return dt.datetime(day.year, day.month, day.day, int(h), int(m))


def add_event(key, name, day, start, end, **kw):
    """Place an event; overlapping ones are refused (cancelled and trashed events still occupy their slot)."""
    s, e = dtm(day, start), dtm(day, end)
    if end < start:
        e += dt.timedelta(days=1)
    for bs, be in _busy:
        if s < be and bs < e:
            return False
    _busy.append((s, e))
    row = {"key": key, "name": name, "start": s.strftime("%Y-%m-%dT%H:%M"), "end": e.strftime("%Y-%m-%dT%H:%M")}
    row.update({k: v for k, v in kw.items() if v is not None})
    events.append(row)
    return True


def must(*args, **kw):
    assert add_event(*args, **kw), f"event overlaps: {args[0]}"


def every(first, last, step=7):
    d = dt.date.fromisoformat(first)
    stop = dt.date.fromisoformat(last)
    while d <= stop:
        yield d
        d += dt.timedelta(days=step)


def D(text):
    return dt.date.fromisoformat(text)


# Saturday toddler swim (a make-up class has a look-alike name)
for d in every("2026-10-03", "2026-12-19"):
    must(f"swim_{d:%m%d}", "Toddler swim", d, "09:30", "10:15", attendees=["kenji", "mei"],
         cancelled=(d == D("2026-10-17")), description="bring the swim nappy and the blue towel"
         if d.day % 3 == 0 else None)
must("swim_makeup", "Toddler swim - makeup", D("2026-10-21"), "16:00", "16:45", attendees=["kenji"])
# Wednesday playgroup
for d in every("2026-10-07", "2026-12-09"):
    must(f"play_{d:%m%d}", "Playgroup", d, "10:00", "11:30", attendees=["kenji", "amanda", "priya_nair"],
         cancelled=(d == D("2026-11-11")))
# Sunday call with Okaasan
for d in every("2026-10-04", "2026-11-29"):
    must(f"okaasan_{d:%m%d}", "Call Okaasan", d, "20:30", "21:00", attendees=["okaasan"])
# monthly committee meeting, first Tuesday; a budget one as a look-alike
for d in ["2026-08-04", "2026-09-01", "2026-10-06", "2026-11-03", "2027-01-05", "2027-02-02"]:
    must(f"cm_{d[5:7]}{d[8:]}", "Committee meeting", D(d), "20:00", "21:30",
         attendees=["chua", "david_l", "fong", "rosnah", "kuldeep"], cancelled=(d == "2026-09-01"))
must("cm_budget", "Committee meeting - budget", D("2026-12-15"), "20:00", "21:30",
     attendees=["chua", "david_l"], description="bring the sinking fund sheet")
must("agm", "Condo AGM", D("2027-01-23"), "10:00", "12:30", attendees=["chua", "david_l", "fong", "rosnah", "kuldeep"])

must("ped_a", "Paediatrician check-up", D("2026-12-17"), "10:30", "11:00", attendees=["ong", "kenji"])
must("ped_b", "Paediatrician check-up", D("2026-06-18"), "10:30", "11:00", attendees=["ong", "kenji"])
must("vaccine", "Kenji's 24-month vaccination", D("2026-12-18"), "09:00", "09:30", attendees=["ong", "kenji"])
must("aircon_a", "Aircon servicing", D("2026-12-14"), "14:00", "16:00", attendees=["ahseng"])
must("aircon_b", "Aircon servicing", D("2026-06-22"), "14:00", "16:00", attendees=["ahseng"])
must("dentist_ev", "Dentist check-up", D("2026-12-22"), "17:30", "18:15", attendees=["dentist"])
must("permit_visit", "MOM appointment for Rina's work permit", D("2026-12-16"), "09:30", "10:30", attendees=["rina"])
must("agency_call", "Call Helpers Hub", D("2026-12-10"), "13:00", "13:20", attendees=["agency"])
must("sprouts_concert", "Little Sprouts Christmas concert", D("2026-12-19"), "15:00", "16:30",
     attendees=["kenji", "amanda", "priya_nair", "sarah", "jiahui"])
must("dinner_club", "NUS dinner club", D("2026-12-11"), "19:30", "22:00", attendees=["weijie", "ravi", "celine"])
must("dinner_club2", "NUS dinner club", D("2026-11-14"), "19:30", "22:00", attendees=["weijie", "ravi", "celine"])
must("hotpot_kim", "Hotpot with Kim", D("2026-12-13"), "18:30", "20:30", attendees=["kim"], cancelled=True)
must("brunch_wj", "Brunch with Wei Jie", D("2026-12-13"), "11:00", "12:30", attendees=["weijie"])
must("lunch_david", "Lunch with David", D("2026-12-15"), "12:30", "13:30", attendees=["david_n"])
must("work_offsite", "Team offsite at Sentosa", D("2026-12-04"), "09:00", "18:00", attendees=["david_n", "priya_nayar"])
must("work_review", "Year-end performance review", D("2026-12-21"), "15:00", "16:00")
must("work_party", "Company year-end party", D("2026-12-18"), "18:30", "23:00", attendees=["david_n", "priya_nayar"])
must("flight_pg", "Flight to Penang", D("2026-12-24"), "07:55", "09:05", attendees=["mei", "kenji"],
     description="Scoot from Changi T1")
must("flight_back", "Flight back from Penang", D("2026-12-28"), "19:40", "20:50", attendees=["mei", "kenji"])
must("pa_birthday", "Pa's birthday dinner", D("2026-12-26"), "19:00", "21:30", attendees=["pa", "ma", "junhao"],
     description="the dim sum place on Lebuh Campbell")
must("tree_lighting", "Condo Christmas tree lighting", D("2026-12-20"), "18:00", "19:30",
     attendees=["fong", "chua", "wong"])
must("cleaners", "Condo deep clean of the lobby", D("2026-12-12"), "13:00", "14:00", attendees=["stella"])
must("movie", "Movie night with Mei", D("2026-12-12"), "20:00", "22:30", attendees=["mei"])
must("babysit_ma", "Date night, Rina babysits", D("2026-12-19"), "19:00", "22:00", attendees=["mei", "rina"])
must("japan_flight", "Flight to Osaka", D("2027-02-12"), "23:15", "07:00", attendees=["mei", "kenji"],
     description="SQ at midnight, land at Kansai at seven")
must("old_lunch", "Lunch with Marcus", D("2026-07-16"), "12:30", "13:30", trashed="2026-08-10T10:30",
     attendees=["old_col"])
must("old_viewing", "Flat viewing with Pamela", D("2026-11-21"), "11:00", "12:00", trashed="2026-11-26T10:30",
     attendees=["old_agent"])
must("old_expo", "Baby expo at Suntec", D("2026-09-13"), "11:00", "15:00", trashed="2026-09-20T10:00")

# ------------------------------------------------------------------------------------------------
# tasks
# ------------------------------------------------------------------------------------------------

tasks = [
    # Penang trip, with subtasks
    {"key": "penang_trip", "name": "Plan the Penang Christmas trip", "list": "penang_l", "priority": 2,
     "status": "in_progress", "due": "2026-12-24"},
    {"key": "pg_flights", "name": "Book the Scoot flights", "parent": "penang_trip", "list": "penang_l",
     "completed": "2026-10-20T22:00"},
    {"key": "pg_ringgit", "name": "Change some ringgit", "parent": "penang_trip", "list": "penang_l",
     "due": "2026-12-20", "effort": 20},
    {"key": "pg_gifts", "name": "Buy gifts for Pa and Ma", "parent": "penang_trip", "list": "penang_l",
     "due": "2026-12-19", "effort": 90},
    {"key": "pg_pack", "name": "Pack Kenji's bag", "parent": "penang_trip", "list": "penang_l", "due": "2026-12-23",
     "effort": 40},
    {"key": "pg_carseat", "name": "Ask Junhao to borrow the car seat", "parent": "penang_trip", "list": "penang_l",
     "completed": "2026-11-30T21:30"},
    {"key": "pg_pet", "name": "Arrange the plants while we are away", "parent": "penang_trip", "list": "home_l",
     "due": "2026-12-22", "effort": 10},
    # condo fees: near duplicates
    {"key": "fee_dec", "name": "Pay condo maintenance fee", "list": "money_l", "due": "2026-12-15", "priority": 1},
    {"key": "fee_nov", "name": "Pay condo maintenance fee", "list": "money_l", "due": "2026-11-15",
     "completed": "2026-11-14T22:00"},
    {"key": "fee_oct", "name": "Pay condo maintenance fee", "list": "money_l", "due": "2026-10-15",
     "completed": "2026-10-15T08:00"},
    {"key": "utilities", "name": "Pay the SP utilities bill", "list": "money_l", "due": "2026-12-20", "effort": 5},
    {"key": "utilities_nov", "name": "Pay the SP utilities bill", "list": "money_l", "due": "2026-11-20",
     "completed": "2026-11-19T21:00"},
    {"key": "cc_bill", "name": "Pay the credit card", "list": "money_l", "due": "2026-12-18", "priority": 1},
    {"key": "starhub", "name": "Pay the Singtel fibre bill", "list": "money_l", "due": "2026-12-05",
     "completed": "2026-12-04T21:30"},
    {"key": "cpf", "name": "Top up Mei's CPF account", "list": "money_l", "due": "2026-12-30", "effort": 15},
    {"key": "tax_rel", "name": "Claim the child relief", "list": "money_l", "due": "2027-03-01", "effort": 30},
    {"key": "insurance", "name": "Review the home insurance", "list": "money_l", "due": "2027-01-15", "effort": 45},
    # helper
    {"key": "permit_a", "name": "Renew Rina's work permit", "list": "home_l", "due": "2026-12-16", "priority": 1},
    {"key": "permit_b", "name": "Renew Rina's work permit", "list": "home_l", "due": "2025-12-12",
     "completed": "2025-12-10T11:00"},
    {"key": "rina_leave", "name": "Agree Rina's leave dates", "list": "home_l", "completed": "2026-11-22T20:00"},
    {"key": "rina_gift", "name": "Buy Rina's Christmas bonus envelope", "list": "home_l", "due": "2026-12-23",
     "effort": 10},
    {"key": "rina_insure", "name": "Renew Rina's medical insurance", "list": "home_l", "due": "2026-12-28",
     "effort": 20},
    # condo
    {"key": "agm_paper", "name": "Print the AGM papers", "list": "condo_l", "due": "2027-01-10", "effort": 30},
    {"key": "agm_agenda", "name": "Draft the AGM agenda", "list": "condo_l", "due": "2026-12-28", "priority": 2,
     "effort": 60},
    {"key": "budget_sheet", "name": "Update the sinking fund sheet", "list": "condo_l", "due": "2026-12-14",
     "effort": 45, "priority": 2},
    {"key": "lift_quote", "name": "Get a second quote for the lift upgrade", "list": "condo_l", "due": "2026-12-18"},
    {"key": "tree", "name": "Collect the Christmas tree from storage", "list": "condo_l", "due": "2026-12-19",
     "effort": 30},
    {"key": "minutes", "name": "Send the November minutes", "list": "condo_l", "due": "2026-11-10",
     "completed": "2026-11-09T22:30"},
    {"key": "minutes_dec", "name": "Send the December minutes", "list": "condo_l", "due": "2026-12-17"},
    {"key": "pay_david", "name": "Pay David for the AGM printing refund", "list": "condo_l", "due": "2026-12-14",
     "effort": 5},
    {"key": "pay_fong", "name": "Pay Auntie Fong for the lights", "list": "condo_l", "due": "2026-12-13", "effort": 5},
    {"key": "noise", "name": "Reply to Mdm Wong about the noise", "list": "condo_l", "due": "2026-12-12"},
    # kenji
    {"key": "k_vacc", "name": "Bring Kenji's health booklet to the clinic", "list": "kenji_l", "due": "2026-12-17",
     "effort": 5},
    {"key": "k_swim", "name": "Buy Kenji new swim trunks", "list": "kenji_l", "due": "2026-12-13", "effort": 30},
    {"key": "k_preschool", "name": "Register Kenji for nursery", "list": "kenji_l", "due": "2027-01-31",
     "priority": 2, "effort": 60},
    {"key": "k_concert", "name": "Make Kenji's reindeer costume", "list": "kenji_l", "due": "2026-12-18", "effort": 90},
    {"key": "k_teacher", "name": "Write Teacher Amanda's thank-you card", "list": "kenji_l", "due": "2026-12-18",
     "effort": 20},
    {"key": "k_diapers", "name": "Order diapers", "list": "kenji_l", "due": "2026-12-14", "effort": 10},
    {"key": "k_diapers_old", "name": "Order diapers", "list": "kenji_l", "due": "2026-11-14",
     "completed": "2026-11-13T21:00"},
    {"key": "k_toys", "name": "Sort out the outgrown toys", "list": "kenji_l", "status": "cancelled"},
    {"key": "k_photos", "name": "Print the Kenji year photo book", "list": "kenji_l", "due": "2026-12-31",
     "effort": 120},
    {"key": "k_sunscreen", "name": "Buy sunscreen for Penang", "list": "kenji_l", "due": "2026-12-20", "effort": 15},
    # work
    {"key": "w_review", "name": "Write my self-review", "list": "work_l", "due": "2026-12-18", "priority": 2,
     "effort": 90},
    {"key": "w_handover", "name": "Finish the handover doc before leave", "list": "work_l", "due": "2026-12-22",
     "effort": 120},
    {"key": "w_leave", "name": "Submit my leave application", "list": "work_l", "completed": "2026-11-02T10:00"},
    {"key": "w_gift", "name": "Buy a gift for the team exchange", "list": "work_l", "due": "2026-12-17", "effort": 40},
    # home
    {"key": "h_aircon", "name": "Move the plants away from the aircon", "list": "home_l", "due": "2026-12-13",
     "effort": 10},
    {"key": "h_bulbs", "name": "Replace the hallway bulbs", "list": "home_l", "due": "2026-12-15", "effort": 15},
    {"key": "h_groceries", "name": "Order groceries from RedMart", "list": "home_l", "due": "2026-12-13", "effort": 20},
    {"key": "h_groceries_old", "name": "Order groceries from RedMart", "list": "home_l", "due": "2026-12-06",
     "completed": "2026-12-05T21:00"},
    {"key": "h_curtain", "name": "Hang the new curtains in Kenji's room", "list": "home_l", "due": "2026-12-20",
     "effort": 45},
    {"key": "h_return", "name": "Return the stroller rain cover", "list": "home_l", "due": "2026-12-16", "effort": 20},
    {"key": "h_cny", "name": "Order CNY cookies", "list": "home_l", "due": "2027-01-10", "effort": 15},
    {"key": "pay_priya", "name": "Pay Priya for the art supplies", "due": "2026-12-14", "effort": 5},
    {"key": "pay_jiahui", "name": "Pay Jia Hui for the pumpkin patch", "due": "2026-12-14", "effort": 5},
    {"key": "pay_weijie", "name": "Pay Wei Jie for the omakase", "due": "2026-12-15", "priority": 1},
    {"key": "pay_junhao", "name": "Send Jun Hao our share for Ma's surgery", "due": "2026-12-20", "priority": 2},
    {"key": "old_agent_t", "name": "Cancel the property agent", "list": "home_l", "trashed": "2026-11-26T10:20"},
    {"key": "old_expo_t", "name": "Buy tickets for the baby expo", "list": "kenji_l", "trashed": "2026-09-20T10:10"},
    {"key": "old_wall", "name": "Repaint the study", "list": "home_l", "trashed": "2026-11-20T09:00"},
]

# ------------------------------------------------------------------------------------------------
# notes
# ------------------------------------------------------------------------------------------------

notebooks = [
    {"key": "kenji_nb", "name": "Kenji Notes"},
    {"key": "condo_nb", "name": "Condo Notes"},
    {"key": "recipes_nb", "name": "Recipes"},
    {"key": "ideas_nb", "name": "Ideas"},  # stays empty
]

notes = [
    {"key": "kn_milestones", "name": "Kenji milestones", "notebook": "kenji_nb", "created": "2025-05-02T20:00",
     "pinned": True, "body": "first steps at twelve months, first word was bola, two-word sentences since November"},
    {"key": "kn_allergy", "name": "Kenji food and allergies", "notebook": "kenji_nb", "created": "2025-09-12T19:00",
     "body": "no peanuts until Dr Ong says, loves tofu and kaya toast, hates raw tomato"},
    {"key": "kn_sleep", "name": "Sleep routine", "notebook": "kenji_nb", "created": "2026-03-04T21:00",
     "body": "bath at seven, two books, lights out at eight, white noise on, nap at one"},
    {"key": "kn_swim", "name": "Swim class notes", "notebook": "kenji_nb", "created": "2026-10-03T11:00",
     "body": "blowing bubbles now, floats with the noodle, coach says no dunking until January"},
    {"key": "kn_vacc", "name": "Vaccination schedule", "notebook": "kenji_nb", "created": "2025-06-10T10:00",
     "body": "MMR and varicella at twelve months, boosters at twenty-four months, bring the booklet"},
    {"key": "cn_rules", "name": "Committee rules of order", "notebook": "condo_nb", "created": "2025-03-12T20:00",
     "pinned": True, "body": "quorum is five, minutes within a week, treasurer reports every meeting"},
    {"key": "cn_nov", "name": "Committee meeting 3 November", "notebook": "condo_nb", "created": "2026-11-03T22:00",
     "body": "lift upgrade quotes, pool pump replaced, lobby lights for Christmas, AGM date fixed for January"},
    {"key": "cn_lift", "name": "Lift upgrade options", "notebook": "condo_nb", "created": "2026-11-20T21:30",
     "body": "quote one 180k, quote two 165k, modernise one lift at a time, residents vote at the AGM"},
    {"key": "cn_sinking", "name": "Sinking fund status", "notebook": "condo_nb", "created": "2026-10-06T22:15",
     "body": "balance 412k, next big item is the roof waterproofing, David wants a five year plan"},
    {"key": "cn_complaints", "name": "Resident complaints log", "notebook": "condo_nb", "created": "2026-11-28T10:00",
     "body": "noise from unit 12-03, bicycles in the lobby, the pool closes at ten, bin chute smell"},
    {"key": "rc_laksa", "name": "Mei's laksa", "notebook": "recipes_nb", "created": "2026-02-08T18:00",
     "body": "rempah from scratch, coconut milk, prawn stock, tau pok, fresh laksa leaves"},
    {"key": "rc_okonomi", "name": "Okonomiyaki Osaka style", "notebook": "recipes_nb", "created": "2026-04-19T12:30",
     "body": "cabbage, grated yam, bonito flakes, mayo zigzag, Okaasan's sauce ratio"},
    {"key": "rc_bakkutteh", "name": "Pa's bak kut teh", "notebook": "recipes_nb", "created": "2026-06-14T17:00",
     "body": "pork ribs, garlic bulbs, white pepper, simmer two hours, dark soy on the side"},
    {"key": "rc_kaya", "name": "Kaya toast for Kenji", "notebook": "recipes_nb", "created": "2026-07-26T08:00",
     "body": "thin slice of toast, a little kaya, soft egg, no soy sauce"},
    {"key": "diary_tired", "name": "Diary entry - rough week", "created": "2026-11-27T23:00",
     "body": "Kenji had a fever, Mei took two days off, I finished the release at midnight"},
    {"key": "diary_happy", "name": "Diary entry - swim day", "created": "2026-10-24T20:30",
     "body": "Kenji blew bubbles for the first time, big grin, chicken rice after"},
    {"key": "penang_ideas", "name": "Penang food list", "created": "2026-11-05T21:00",
     "body": "char kway teow at Lorong Selamat, cendol on Penang Road, Ma's nasi kandar, ABC at Kek Seng"},
    {"key": "osaka_ideas", "name": "Osaka trip ideas", "created": "2026-10-28T21:30",
     "body": "Universal Studios with Kenji, takoyaki in Dotonbori, Okaasan wants a family photo"},
    {"key": "gift_okaasan", "name": "Gift ideas for Okaasan", "created": "2026-12-01T21:15",
     "body": "a silk scarf, good tea from Ronnefeldt, a framed photo of Kenji"},
    {"key": "helper_rules", "name": "Household rhythm with Rina", "created": "2026-01-05T20:00",
     "body": "market on Tuesdays, Kenji's nap at one, Sunday rest day, phone off at ten"},
    {"key": "budget", "name": "Monthly budget", "created": "2026-01-02T20:00",
     "body": "mortgage 3800, helper 900, groceries 1200, childcare 1300, insurance 500, save 3000"},
    {"key": "pharm_notes", "name": "Mei's work contacts", "created": "2026-05-12T09:00",
     "body": "pharmacy head Dr Lau, rota on the shared sheet, off on Saturdays this month"},
    {"key": "old_note", "name": "Old shopping list", "created": "2026-11-01T10:00", "body": "milk, nappies, bananas",
     "trashed": "2026-12-01T10:00"},
    {"key": "old_draft", "name": "Draft complaint email", "created": "2026-04-12T10:00",
     "body": "the lift was out of service for three days again", "trashed": "2026-05-12T10:00"},
]

# ------------------------------------------------------------------------------------------------
# documents
# ------------------------------------------------------------------------------------------------

folders = [
    {"key": "condo_f", "name": "Condo"},
    {"key": "kenji_f", "name": "Kenji"},
    {"key": "money_f", "name": "Money"},
    {"key": "helper_f", "name": "Helper"},
    {"key": "empty_f", "name": "To file"},  # stays empty
]

documents = [
    {"key": "d_sp25", "name": "Sale and purchase agreement", "folder": "condo_f", "created": "2024-05-12T10:00",
     "starred": True},
    {"key": "d_minutes_oct", "name": "Committee minutes October 2026", "folder": "condo_f",
     "created": "2026-10-13T10:00"},
    {"key": "d_minutes_nov", "name": "Committee minutes November 2026", "folder": "condo_f",
     "created": "2026-11-10T10:00"},
    {"key": "d_bylaws", "name": "Condo by-laws 2025", "folder": "condo_f", "created": "2025-03-12T10:00"},
    {"key": "d_budget26", "name": "Condo budget 2026", "folder": "condo_f", "created": "2026-01-20T10:00"},
    {"key": "d_budget27", "name": "Condo budget 2027", "folder": "condo_f", "created": "2026-12-01T10:00",
     "starred": True},
    {"key": "d_birth", "name": "Kenji's birth certificate", "folder": "kenji_f", "created": "2024-11-20T10:00",
     "starred": True},
    {"key": "d_booklet", "name": "Kenji's health booklet scan", "folder": "kenji_f", "created": "2025-06-10T10:00"},
    {"key": "d_nursery", "name": "Nursery application form", "folder": "kenji_f", "created": "2026-12-05T10:00"},
    {"key": "d_passport_k", "name": "Kenji's passport scan", "folder": "kenji_f", "created": "2025-08-01T10:00"},
    {"key": "d_tax25", "name": "Income tax notice of assessment 2025", "folder": "money_f",
     "created": "2026-05-20T10:00"},
    {"key": "d_tax24", "name": "Income tax notice of assessment 2024", "folder": "money_f",
     "created": "2025-05-22T10:00"},
    {"key": "d_cpf", "name": "CPF statement 2026", "folder": "money_f", "created": "2026-07-02T10:00"},
    {"key": "d_loan", "name": "Home loan statement December 2026", "folder": "money_f", "created": "2026-12-03T10:00"},
    {"key": "d_permit", "name": "Rina's work permit 2025", "folder": "helper_f", "created": "2025-12-10T10:00"},
    {"key": "d_contract", "name": "Rina's employment contract", "folder": "helper_f", "created": "2024-12-14T10:00",
     "starred": True},
    {"key": "d_insure_h", "name": "Home insurance policy", "created": "2025-01-15T10:00"},
    {"key": "d_flights", "name": "Penang flight confirmation", "created": "2026-10-20T22:10"},
    {"key": "d_old_permit", "name": "Rina's work permit 2024", "folder": "helper_f", "created": "2024-12-14T10:30",
     "trashed": "2026-12-05T10:00"},
    {"key": "d_old_quote", "name": "Old renovation quote", "folder": "condo_f", "created": "2024-06-10T10:00",
     "trashed": "2026-08-01T10:00"},
]

# ------------------------------------------------------------------------------------------------
# albums and photos
# ------------------------------------------------------------------------------------------------

albums = [
    {"key": "kenji_a", "name": "Kenji Growing Up"},
    {"key": "condo_a", "name": "Parc Vista Events"},
    {"key": "penang_a", "name": "Penang Visits"},
    {"key": "osaka_a", "name": "Osaka Summer"},
]

photos = [
    {"key": "p_k_born", "name": "Kenji at one day old", "taken": "2024-11-18T09:30", "albums": ["kenji_a"],
     "people": ["mei"], "starred": True},
    {"key": "p_k_steps", "name": "Kenji's first steps", "taken": "2025-11-22T17:00", "albums": ["kenji_a"],
     "people": ["kenji"], "starred": True},
    {"key": "p_k_bday", "name": "Kenji's second birthday cake", "taken": "2026-11-18T18:30", "albums": ["kenji_a"],
     "people": ["kenji", "mei"], "starred": True},
    {"key": "p_k_swim", "name": "Kenji's first swim class", "taken": "2026-10-03T10:00", "albums": ["kenji_a"],
     "people": ["kenji"]},
    {"key": "p_k_bubbles", "name": "Blowing bubbles", "taken": "2026-10-24T09:50", "albums": ["kenji_a"],
     "people": ["kenji"]},
    {"key": "p_k_sleep", "name": "Kenji asleep in the stroller", "taken": "2026-09-05T15:00", "albums": ["kenji_a"],
     "people": ["kenji"]},
    {"key": "p_k_rina", "name": "Rina and Kenji at the playground", "taken": "2026-08-15T17:30",
     "albums": ["kenji_a"], "people": ["rina", "kenji"]},
    {"key": "p_k_playgroup", "name": "Playgroup finger painting", "taken": "2026-10-14T11:00",
     "albums": ["kenji_a"], "people": ["amanda", "priya_nair"]},
    {"key": "p_c_ndp", "name": "National Day fireworks from the roof", "taken": "2026-08-09T20:30",
     "albums": ["condo_a"], "people": ["chua", "fong"], "starred": True},
    {"key": "p_c_lobby", "name": "The lobby Christmas lights", "taken": "2026-12-02T19:00", "albums": ["condo_a"],
     "people": ["fong"]},
    {"key": "p_c_agm", "name": "Last year's AGM crowd", "taken": "2026-01-24T11:30", "albums": ["condo_a"],
     "people": ["chua", "david_l", "rosnah"]},
    {"key": "p_c_pool", "name": "Pool party for the kids", "taken": "2026-06-06T16:00", "albums": ["condo_a"],
     "people": ["kuldeep", "wong"]},
    {"key": "p_c_bbq", "name": "Neighbours' BBQ", "taken": "2026-04-18T19:00", "albums": ["condo_a"],
     "people": ["chua", "kuldeep", "wong"]},
    {"key": "p_c_pump", "name": "The new pool pump", "taken": "2026-11-03T09:00", "albums": ["condo_a"]},
    {"key": "p_p_ma", "name": "Ma with Kenji at the Penang house", "taken": "2026-02-14T11:00",
     "albums": ["penang_a"], "people": ["ma", "kenji"], "starred": True},
    {"key": "p_p_pa", "name": "Pa at the hawker stall", "taken": "2026-02-14T19:30", "albums": ["penang_a"],
     "people": ["pa"]},
    {"key": "p_p_family", "name": "Lim family lunch", "taken": "2026-02-15T13:00", "albums": ["penang_a"],
     "people": ["pa", "ma", "junhao", "mei"], "starred": True},
    {"key": "p_p_cendol", "name": "Cendol on Penang Road", "taken": "2026-02-15T16:00", "albums": ["penang_a"],
     "people": ["mei"]},
    {"key": "p_p_beach", "name": "Batu Ferringhi beach", "taken": "2025-12-27T17:40", "albums": ["penang_a"]},
    {"key": "p_p_temple", "name": "Kek Lok Si temple", "taken": "2025-12-28T10:30", "albums": ["penang_a"],
     "people": ["junhao"]},
    {"key": "p_o_castle", "name": "Osaka Castle", "taken": "2026-08-02T10:30", "albums": ["osaka_a"],
     "people": ["okaasan", "otousan"], "starred": True},
    {"key": "p_o_dotonbori", "name": "Dotonbori at night", "taken": "2026-08-02T20:40", "albums": ["osaka_a"],
     "people": ["mei"]},
    {"key": "p_o_okaasan", "name": "Okaasan and Kenji", "taken": "2026-08-03T14:00", "albums": ["osaka_a"],
     "people": ["okaasan", "kenji"]},
    {"key": "p_o_takoyaki", "name": "Takoyaki stall", "taken": "2026-08-02T21:10", "albums": ["osaka_a"]},
    {"key": "p_o_family", "name": "Tanaka family dinner", "taken": "2026-08-04T19:30", "albums": ["osaka_a"],
     "people": ["okaasan", "otousan", "mei"]},
    {"key": "p_wj", "name": "Wei Jie at the omakase", "taken": "2026-11-14T20:10", "people": ["weijie", "ravi"]},
    {"key": "p_amanda", "name": "Teacher Amanda with the class", "taken": "2026-11-27T11:00",
     "people": ["amanda", "sarah"]},
    {"key": "p_mei_work", "name": "Mei in her white coat", "taken": "2026-05-12T08:10", "people": ["mei"]},
    {"key": "p_rina_cake", "name": "Rina's birthday cake", "taken": "2026-09-30T20:00", "people": ["rina"]},
    {"key": "p_david", "name": "Condo treasurer with the sinking fund sheet", "taken": "2026-10-06T21:00",
     "people": ["david_l"]},
    {"key": "p_receipt", "name": "Receipt for the stroller", "taken": "2026-10-03T14:00"},
    {"key": "p_curtain", "name": "Curtain fabric swatches", "taken": "2026-12-01T12:00"},
    {"key": "p_aircon", "name": "The aircon filter, filthy", "taken": "2026-11-29T11:00"},
    {"key": "p_form", "name": "Nursery form pages", "taken": "2026-12-05T10:20"},
    {"key": "p_blurry", "name": "Blurry photo", "taken": "2026-12-07T09:00", "trashed": "2026-12-09T09:00"},
    {"key": "p_screen", "name": "Screenshot of the booking", "taken": "2026-07-03T12:00", "trashed": "2026-08-05T09:00"},
]

# ------------------------------------------------------------------------------------------------
# debts (in SGD, the vault currency)
# ------------------------------------------------------------------------------------------------

debts = [
    {"key": "d_david_print", "person": "david_l", "direction": "owes_me", "amount": 60, "name": "AGM printing share",
     "date": "2026-11-18"},
    {"key": "d_fong_lights", "person": "fong", "direction": "i_owe", "amount": 90, "name": "my share of the lobby lights",
     "date": "2026-12-02"},
    {"key": "d_priya_art", "person": "priya_nair", "direction": "i_owe", "amount": 24, "name": "art supplies",
     "date": "2026-10-14"},
    {"key": "d_jiahui", "person": "jiahui", "direction": "i_owe", "amount": 70, "name": "pumpkin patch outing",
     "date": "2026-10-31"},
    {"key": "d_sarah", "person": "sarah", "direction": "owes_me", "amount": 40, "name": "teacher gift share",
     "date": "2026-11-27"},
    {"key": "d_weijie", "person": "weijie", "direction": "i_owe", "amount": 160, "name": "my part of the omakase",
     "date": "2026-11-14"},
    {"key": "d_ravi", "person": "ravi", "direction": "owes_me", "amount": 71.25, "name": "hotpot share",
     "date": "2026-10-10"},
    {"key": "d_kim", "person": "kim", "direction": "owes_me", "amount": 71.25, "name": "hotpot other share",
     "date": "2026-10-10"},
    {"key": "d_junhao", "person": "junhao", "direction": "i_owe", "amount": 400, "name": "Ma's surgery share in dollars",
     "date": "2026-09-15"},
    {"key": "d_mei", "person": "mei", "direction": "owes_me", "amount": 210, "name": "stroller half",
     "date": "2026-10-03", "settled": "2026-10-05T10:00"},
    {"key": "d_david_n", "person": "david_n", "direction": "owes_me", "amount": 18, "name": "team lunch",
     "date": "2026-11-09", "settled": "2026-11-12T10:00"},
    {"key": "d_stella", "person": "stella", "direction": "i_owe", "amount": 35, "name": "visitor carpark coupons",
     "date": "2026-11-22"},
    {"key": "d_ahseng", "person": "ahseng", "direction": "i_owe", "amount": 120, "name": "aircon gas top-up",
     "date": "2026-06-22", "settled": "2026-06-23T10:00"},
    {"key": "d_celine", "person": "celine", "direction": "owes_me", "amount": 55, "name": "concert tickets",
     "date": "2026-09-05"},
]

# ------------------------------------------------------------------------------------------------
# locker
# ------------------------------------------------------------------------------------------------

locker = [
    {"key": "dbs_login", "name": "DBS digibank", "type": "login", "username": "hiro.tanakalim",
     "url": "https://dbs.com.sg", "password": "ParcVista#Bishan38", "starred": True},
    {"key": "singpass", "name": "Singpass", "type": "login", "username": "S8812345A",
     "url": "https://singpass.gov.sg", "password": "Kenji2024!Sg"},
    {"key": "sp_login", "name": "SP Group utilities", "type": "login", "username": "hiro.tl@mail.example",
     "url": "https://spgroup.com.sg", "password": "Utilities-Rina7"},
    {"key": "dbs_card", "name": "DBS Altitude card", "type": "card", "card_number": "5424180279791765", "cvv": "385"},
    {"key": "uob_card", "name": "UOB One card", "type": "card", "card_number": "4147202828281234", "cvv": "627"},
    {"key": "dbs_acct", "name": "DBS joint account", "type": "bank_account",
     "notes": "branch Bishan Junction 8, account 123-456789-0", "starred": True},
    {"key": "home_wifi", "name": "Home wifi", "type": "wifi", "password": "ParcVistaStack12", "starred": True},
    {"key": "penang_wifi", "name": "Penang house wifi", "type": "wifi", "password": "LimFamily1957"},
    {"key": "lobby_code", "name": "Lobby gate code", "type": "note", "notes": "7351 then hash"},
    {"key": "netflix_pw", "name": "Netflix", "type": "password", "password": "KenjiTV-Sundays9"},
    {"key": "nric", "name": "NRIC", "type": "identity"},
    {"key": "passport", "name": "Passport - Hiro", "type": "passport", "notes": "no. K1234567A, expires 2031-02-18"},
    {"key": "licence", "name": "Singapore driving licence", "type": "driving_licence",
     "notes": "class 3, valid to 2033"},
    {"key": "club_member", "name": "Condo gym and pool access", "type": "membership",
     "notes": "unit 08-14, card number 220117"},
    {"key": "gh_api", "name": "GitHub API token", "type": "api_credential", "notes": "for the committee notice script"},
    {"key": "nas_ssh", "name": "Synology SSH key", "type": "ssh_key", "notes": "NAS in the study, photos backup"},
    {"key": "jetbrains", "name": "JetBrains licence", "type": "software_licence", "notes": "renews every February",
     "starred": True},
    {"key": "btc", "name": "Crypto wallet", "type": "crypto_wallet", "notes": "small, about 500 dollars"},
    {"key": "deed", "name": "Property title - original", "type": "document",
     "notes": "lawyer holds the original, scan in the condo folder"},
    {"key": "old_wifi", "name": "Old HDB flat wifi", "type": "wifi", "password": "Ang-Mo-Kio2023",
     "trashed": "2026-09-14T10:00"},
    {"key": "old_login", "name": "Old POSB login", "type": "login", "username": "hiro_tl", "password": "OldPosb12",
     "trashed": "2026-12-03T10:00"},
]

links = [
    {"from": "pg_flights", "to": "mei"},
    {"from": "pg_gifts", "to": "ma"},
    {"from": "pg_carseat", "to": "junhao"},
    {"from": "pg_ringgit", "to": "pa"},
    {"from": "fee_dec", "to": "stella"},
    {"from": "fee_nov", "to": "stella"},
    {"from": "fee_oct", "to": "stella"},
    {"from": "cpf", "to": "mei"},
    {"from": "permit_a", "to": "rina"},
    {"from": "permit_b", "to": "rina"},
    {"from": "rina_leave", "to": "rina"},
    {"from": "rina_gift", "to": "rina"},
    {"from": "agm_paper", "to": "rosnah"},
    {"from": "agm_agenda", "to": "chua"},
    {"from": "budget_sheet", "to": "david_l"},
    {"from": "lift_quote", "to": "kuldeep"},
    {"from": "tree", "to": "fong"},
    {"from": "minutes", "to": "rosnah"},
    {"from": "pay_david", "to": "david_l"},
    {"from": "pay_fong", "to": "fong"},
    {"from": "noise", "to": "wong"},
    {"from": "k_vacc", "to": "ong"},
    {"from": "k_teacher", "to": "amanda"},
    {"from": "k_concert", "to": "amanda"},
    {"from": "h_aircon", "to": "ahseng"},
    {"from": "pay_priya", "to": "priya_nair"},
    {"from": "pay_jiahui", "to": "jiahui"},
    {"from": "pay_weijie", "to": "weijie"},
    {"from": "pay_junhao", "to": "junhao"},
    {"from": "w_gift", "to": "david_n"},
    {"from": "w_handover", "to": "priya_nayar"},
    {"from": "kn_vacc", "to": "ong"},
    {"from": "kn_milestones", "to": "kenji"},
    {"from": "cn_nov", "to": "chua"},
    {"from": "cn_sinking", "to": "david_l"},
    {"from": "cn_complaints", "to": "wong"},
    {"from": "rc_laksa", "to": "mei"},
    {"from": "rc_okonomi", "to": "okaasan"},
    {"from": "rc_bakkutteh", "to": "pa"},
    {"from": "gift_okaasan", "to": "okaasan"},
    {"from": "diary_tired", "to": "mei"},
    {"from": "penang_ideas", "to": "ma"},
    {"from": "helper_rules", "to": "rina"},
    {"from": "d_permit", "to": "rina"},
    {"from": "d_birth", "to": "kenji"},
    {"from": "d_budget27", "to": "david_l"},
]

world = {
    "me": ME, "today": TODAY, "epoch": "2025-06-01T09:00", "seed": "T33", "currency": "SGD",
    "people": people, "groups": groups, "expenses": expenses, "lists": lists, "events": events,
    "tasks": tasks, "notebooks": notebooks, "notes": notes, "folders": folders, "documents": documents,
    "albums": albums, "photos": photos, "debts": debts, "locker": locker, "links": links,
}

SIZES = {"people": (25, 35), "groups": (4, 6), "events": (50, 70), "tasks": (50, 70), "notes": (20, 30),
         "documents": (15, 20), "photos": (30, 40), "debts": (10, 15), "locker": (15, 22)}


def check(w):
    """Keys unique, every reference resolves, no two events overlap, every locker type present, the sizes
    the brief asks for, trashed rows of every trashable kind."""
    keys = {}
    for kind, rows in w.items():
        if not isinstance(rows, list):
            continue
        for r in rows:
            if "key" in r:
                assert r["key"] not in keys, f"duplicate key {r['key']}"
                assert r["key"] == r["key"].lower() and " " not in r["key"] and r["key"].isascii(), r["key"]
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
    for d in w["debts"]:
        need(d["person"], "people")
    for e in w["events"]:
        [need(a, "people") for a in e.get("attendees", [])]
    for ln in w["links"]:
        assert ln["from"] in keys and ln["to"] in keys, ln
    names = [g["name"] for g in w["groups"]] + [n["name"] for n in w["notebooks"]] + [a["name"] for a in w["albums"]]
    assert len(names) == len(set(names)), "group/notebook/album names must be unique"
    spans = sorted((e["start"], e.get("end", e["start"]), e["key"]) for e in w["events"])
    for (s1, e1, k1), (s2, e2, k2) in zip(spans, spans[1:]):
        assert e1 <= s2, f"events overlap: {k1} and {k2}"
    assert len({r["type"] for r in w["locker"]}) == 15, sorted({r["type"] for r in w["locker"]})
    assert len({p["name"] for p in w["people"]}) == len(w["people"]), "duplicate person names"
    for kind, (lo, hi) in SIZES.items():
        assert lo <= len(w[kind]) <= hi, f"{kind}: {len(w[kind])} not in {lo}-{hi}"
    for kind in ("people", "events", "tasks", "notes", "documents", "photos", "locker"):
        assert sum(1 for r in w[kind] if r.get("trashed")) >= 2, f"trashed {kind}"
    assert any(e.get("cancelled") for e in w["events"]) and any(t.get("status") == "cancelled" for t in w["tasks"])
    assert any(t.get("completed") for t in w["tasks"])
    assert any(not [x for x in w["documents"] if x.get("folder") == f["key"]] for f in w["folders"])
    assert any(not [x for x in w["notes"] if x.get("notebook") == n["key"]] for n in w["notebooks"])
    assert any(not [x for x in w["expenses"] if x["group"] == g["key"]] for g in w["groups"])


if __name__ == "__main__":
    check(world)
    (HERE / "T33.json").write_text(json.dumps(world, indent=1, ensure_ascii=False) + "\n")
    counts = {k: len(v) for k, v in world.items() if isinstance(v, list)}
    print("T33:", counts)
