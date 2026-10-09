"""World T21: Grace Mwangi, primary-school headteacher in Nakuru (KES vault).

    python3 authored/worlds/T21_build.py      # writes authored/worlds/T21.json (deterministic)

Today in the sessions is Saturday 2026-06-06 09:00 (second term; chama meets at two).
Grace is a widow with two grown sons (Kevin in Nairobi, Brian finishing at Moi University) and
raises her niece Shiru (Faith Wanjiru). She heads Kiamunyi Primary, sits on its board (BOM),
keeps the books of the Tumaini women's chama and is on the church harambee committee.
Built-in ambiguity: two Marys (deputy head, chama treasurer), two Peters (BOM chair, church
elder), nicknames (Shiru, Bri, Tabby, Mama Njeri, Fundi), a misspelled-looking name (Jecinta),
two "Dentist" events, two "Clinic review" events, two "BOM meeting" events, near-duplicate
tasks ("Buy exercise books", "Submit TSC returns", "Send chama contribution", monthly KPLC),
two folders sharing "School" (School board, School fees), cancelled events, completed tasks,
rows trashed inside and past the 30-day restore window, an empty group, an empty folder, an
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
        {"key": "kevin", "name": "Kevin Mwangi", "role": "elder son, engineer in Nairobi", "starred": True,
         "cadence": 7, "last_contacted": "2026-05-31T20:00", "last_contacted_kind": "call"},
        {"key": "brian", "name": "Brian Mwangi", "role": "younger son, Moi University", "nickname": "Bri",
         "cadence": 7, "last_contacted": "2026-06-04T19:00", "last_contacted_kind": "call"},
        {"key": "wanjiru", "name": "Faith Wanjiru", "role": "niece, Form 2 at Menengai Girls", "nickname": "Shiru",
         "starred": True, "cadence": 14, "last_contacted": "2026-06-01T17:30", "last_contacted_kind": "visit"},
        {"key": "naomi", "name": "Naomi Wairimu", "role": "Kevin's wife", "cadence": 30,
         "last_contacted": "2026-05-16T21:00", "last_contacted_kind": "message"},
        {"key": "esther", "name": "Esther Njeri", "role": "sister in Nyeri", "nickname": "Mama Njeri",
         "cadence": 14, "last_contacted": "2026-05-24T18:00", "last_contacted_kind": "call", "met": "Nyeri"},
        {"key": "james", "name": "James Maina", "role": "brother-in-law", "met": "Nyeri"},
        {"key": "tabby", "name": "Tabitha Chepkoech", "role": "house help", "nickname": "Tabby",
         "last_contacted": "2026-06-05T18:00", "last_contacted_kind": "message"},
        # school
        {"key": "mary_w", "name": "Mary Wambui", "role": "deputy headteacher", "starred": True, "cadence": 3,
         "last_contacted": "2026-06-05T15:30", "last_contacted_kind": "meeting"},
        {"key": "peter_k", "name": "Peter Kariuki", "role": "BOM chairman", "cadence": 14,
         "last_contacted": "2026-05-27T10:00", "last_contacted_kind": "call"},
        {"key": "joseph", "name": "Joseph Mutua", "role": "school bursar", "cadence": 7,
         "last_contacted": "2026-06-05T14:00", "last_contacted_kind": "meeting"},
        {"key": "janet", "name": "Janet Akinyi", "role": "Grade 4 teacher"},
        {"key": "daniel", "name": "Daniel Ruto", "role": "Grade 6 class teacher", "cadence": 30,
         "last_contacted": "2026-06-02T12:30", "last_contacted_kind": "meeting"},
        {"key": "collins", "name": "Collins Omondi", "role": "ICT teacher"},
        {"key": "jecinta", "name": "Jecinta Chebet", "role": "school cook"},
        {"key": "githinji", "name": "Samuel Githinji", "role": "mechanic", "nickname": "Fundi"},
        # chama
        {"key": "alice", "name": "Alice Nyambura", "role": "chama chairlady", "starred": True, "cadence": 14,
         "last_contacted": "2026-05-02T16:00", "last_contacted_kind": "meeting"},
        {"key": "mary_a", "name": "Mary Achieng", "role": "chama treasurer", "cadence": 14,
         "last_contacted": "2026-06-03T19:00", "last_contacted_kind": "call"},
        {"key": "beatrice", "name": "Beatrice Moraa", "role": "chama member"},
        {"key": "rose", "name": "Rose Wanjiku", "role": "chama member, tailor", "cadence": 30,
         "last_contacted": "2026-05-16T11:00", "last_contacted_kind": "visit"},
        # church
        {"key": "rev_kiprono", "name": "Rev. Samuel Kiprono", "role": "parish minister", "cadence": 30,
         "last_contacted": "2026-05-31T12:30", "last_contacted_kind": "visit"},
        {"key": "peter_o", "name": "Peter Otieno", "role": "church elder, harambee treasurer",
         "last_contacted": "2026-06-01T18:00", "last_contacted_kind": "call"},
        {"key": "susan", "name": "Susan Chelimo", "role": "women's guild, choir"},
        # others
        {"key": "anne", "name": "Dr. Anne Wafula", "role": "doctor, Valley Hospital"},
        {"key": "moses", "name": "Moses Kiprop", "role": "boda rider"},
        {"key": "wycliffe", "name": "Wycliffe Barasa", "role": "land surveyor"},
        {"key": "lucy", "name": "Lucy Muthoni", "role": "hairdresser"},
        # trashed: one inside the 30-day window, one past it
        {"key": "hassan", "name": "Hassan Omar", "role": "old tenant", "trashed": "2026-05-20T10:00"},
        {"key": "ndegwa", "name": "Francis Ndegwa", "role": "former BOM member", "trashed": "2026-03-02T09:00"},
    ]


GROUPS = [
    {"key": "chama", "name": "Tumaini chama", "currency": "KES",
     "members": ["alice", "mary_a", "beatrice", "rose", "susan"], "created": "2024-01-06T14:00"},
    {"key": "harambee", "name": "Church harambee 2026", "currency": "KES",
     "members": ["peter_o", "rev_kiprono", "susan"], "created": "2026-04-12T13:00"},
    {"key": "bom_tea", "name": "BOM tea fund", "currency": "KES",
     "members": ["peter_k", "mary_w", "joseph"], "created": "2025-09-01T10:00"},
    {"key": "family", "name": "Mwangi family", "members": ["kevin", "brian", "naomi"],
     "created": "2025-12-20T19:00"},
    {"key": "grad_trip", "name": "Eldoret graduation trip", "currency": "KES", "created": "2026-05-30T20:00"},
]

EXPENSES = [
    {"group": "chama", "name": "Tent hire", "amount": 6000, "paid_by": "me",
     "split": ["me", "alice", "mary_a", "beatrice"], "date": "2026-03-21"},
    {"group": "chama", "name": "Lunch at May meeting", "amount": 2500, "paid_by": "mary_a",
     "split": ["me", "mary_a", "rose", "susan", "beatrice"], "date": "2026-05-02"},
    {"group": "harambee", "name": "Harambee cards printing", "amount": 4500, "paid_by": "peter_o",
     "split": ["me", "peter_o", "rev_kiprono"], "date": "2026-05-20"},
    {"group": "bom_tea", "name": "Tea and mandazi", "amount": 1800, "paid_by": "me",
     "split": ["me", "peter_k", "mary_w", "joseph"], "date": "2026-05-13"},
    {"group": "bom_tea", "name": "Sugar and milk", "amount": 900, "paid_by": "joseph",
     "split": ["me", "joseph", "mary_w"], "date": "2026-06-03"},
    {"group": "family", "name": "Dad's memorial lunch", "amount": 12000, "paid_by": "kevin",
     "split": ["me", "kevin", "brian"], "date": "2026-02-15"},
]

LISTS = [
    {"key": "school_l", "name": "School", "area": "work"},
    {"key": "home_l", "name": "Home", "area": "family"},
    {"key": "shopping_l", "name": "Shopping"},
    {"key": "chama_l", "name": "Chama", "area": "community"},
    {"key": "church_l", "name": "Church", "area": "community"},
    {"key": "health_l", "name": "Health", "area": "health"},
    {"key": "garden_l", "name": "Garden"},
]


def events():
    out = []
    # staff briefing, Monday mornings through second term
    d = date(2026, 4, 27)
    while d <= date(2026, 7, 27):
        ev = {"key": f"brief_{d.strftime('%m%d')}", "name": "Staff briefing", "start": f"{d}T07:30",
              "end": f"{d}T08:00", "attendees": ["mary_w"], "description": "staffroom"}
        if d == date(2026, 5, 25):
            ev["cancelled"] = "2026-05-22T16:00"
        out.append(ev)
        d += timedelta(weeks=1)
    # chama, first Saturday of the month
    for m, dd in ((2, 7), (3, 7), (4, 4), (5, 2), (6, 6), (7, 4), (8, 1)):
        out.append({"key": f"chama_{m:02d}", "name": "Chama meeting", "start": f"2026-{m:02d}-{dd:02d}T14:00",
                    "end": f"2026-{m:02d}-{dd:02d}T16:00", "attendees": ["alice", "mary_a"],
                    "description": "at Alice's place"})
    # choir practice, Thursday evenings
    d = date(2026, 5, 7)
    while d <= date(2026, 6, 25):
        out.append({"key": f"choir_{d.strftime('%m%d')}", "name": "Choir practice", "start": f"{d}T17:30",
                    "end": f"{d}T19:00", "attendees": ["susan"]})
        d += timedelta(weeks=1)
    out += [
        # school
        {"key": "bom_may", "name": "BOM meeting", "start": "2026-05-13T10:00", "end": "2026-05-13T12:00",
         "attendees": ["peter_k", "mary_w", "joseph"], "description": "school boardroom"},
        {"key": "bom_june", "name": "BOM meeting", "start": "2026-06-10T10:00", "end": "2026-06-10T12:00",
         "attendees": ["peter_k", "mary_w", "joseph"], "description": "school boardroom"},
        {"key": "bom_fin", "name": "BOM finance committee", "start": "2026-06-24T10:00", "end": "2026-06-24T11:30",
         "attendees": ["peter_k", "joseph"]},
        {"key": "budget_joseph", "name": "Budget review with Joseph", "start": "2026-06-05T14:00",
         "end": "2026-06-05T15:00", "attendees": ["joseph"]},
        {"key": "mock_start", "name": "Mock exams start", "start": "2026-06-16T08:00", "end": "2026-06-16T12:00",
         "attendees": ["mary_w", "daniel"], "description": "Grade 6 and Grade 8 blocks"},
        {"key": "sports_day", "name": "Sports day", "start": "2026-06-19T09:00", "end": "2026-06-19T15:00",
         "attendees": ["mary_w", "collins"], "description": "school field"},
        {"key": "g6_parents", "name": "Grade 6 parents meeting", "start": "2026-06-18T14:00",
         "end": "2026-06-18T15:30", "attendees": ["daniel"]},
        {"key": "parents_day", "name": "Parents' day", "start": "2026-07-03T10:00", "end": "2026-07-03T13:00",
         "attendees": ["mary_w", "peter_k"], "description": "main hall"},
        {"key": "prize_giving", "name": "Prize giving day", "start": "2026-03-27T10:00", "end": "2026-03-27T13:00",
         "attendees": ["mary_w", "peter_k"]},
        {"key": "county_meet", "name": "County education meeting", "start": "2026-06-23T09:00",
         "end": "2026-06-23T13:00", "description": "county offices, bring enrolment figures"},
        {"key": "heads_conf", "name": "Heads' conference", "start": "2026-08-11T08:00", "end": "2026-08-11T17:00",
         "description": "Mombasa"},
        {"key": "book_fair", "name": "Book fair", "start": "2026-05-20T09:00", "end": "2026-05-20T13:00",
         "attendees": ["janet"]},
        {"key": "lunch_mary", "name": "Lunch with Mary", "start": "2026-06-11T13:00", "end": "2026-06-11T14:00",
         "attendees": ["mary_w"]},
        {"key": "staff_trip", "name": "Staff trip to Naivasha", "start": "2026-05-30T07:00",
         "end": "2026-05-30T18:00", "cancelled": "2026-05-21T12:00"},
        # church and chama
        {"key": "harambee_plan", "name": "Harambee planning meeting", "start": "2026-06-08T17:00",
         "end": "2026-06-08T18:00", "attendees": ["peter_o", "rev_kiprono"]},
        {"key": "harambee_day", "name": "Church harambee", "start": "2026-06-21T11:00", "end": "2026-06-21T15:00",
         "attendees": ["peter_o", "rev_kiprono", "susan"], "description": "church grounds, tents from chama"},
        {"key": "chama_retreat", "name": "Chama retreat", "start": "2026-06-20T08:00", "end": "2026-06-20T17:00",
         "attendees": ["alice", "beatrice"], "cancelled": "2026-06-01T09:00"},
        {"key": "rose_wedding", "name": "Rose's daughter's wedding", "start": "2026-06-27T10:00",
         "end": "2026-06-27T16:00", "attendees": ["rose"], "description": "Lanet, bring the envelope"},
        {"key": "funeral_molo", "name": "Funeral in Molo", "start": "2026-05-23T09:00", "end": "2026-05-23T14:00"},
        # family and health
        {"key": "dentist_shiru", "name": "Dentist", "start": "2026-06-12T16:00", "end": "2026-06-12T16:45",
         "attendees": ["wanjiru"]},
        {"key": "dentist_me", "name": "Dentist", "start": "2026-06-30T15:00", "end": "2026-06-30T15:30"},
        {"key": "clinic_may", "name": "Clinic review", "start": "2026-05-12T11:00", "end": "2026-05-12T11:30",
         "attendees": ["anne"], "description": "Valley Hospital, BP check"},
        {"key": "clinic_june", "name": "Clinic review", "start": "2026-06-09T11:00", "end": "2026-06-09T11:30",
         "attendees": ["anne"], "description": "Valley Hospital, BP check"},
        {"key": "kevin_call", "name": "Call with Kevin", "start": "2026-06-07T20:00", "end": "2026-06-07T20:30",
         "attendees": ["kevin"]},
        {"key": "kevin_visit", "name": "Kevin and Naomi visiting", "start": "2026-06-13T12:00",
         "end": "2026-06-13T18:00", "attendees": ["kevin", "naomi"]},
        {"key": "kevin_bday", "name": "Kevin's birthday dinner", "start": "2026-05-16T19:00",
         "end": "2026-05-16T21:00", "attendees": ["kevin", "naomi"]},
        {"key": "brian_grad", "name": "Brian's graduation", "start": "2026-07-10T09:00", "end": "2026-07-10T14:00",
         "attendees": ["brian", "kevin"], "description": "Moi University, Eldoret"},
        {"key": "shiru_visit", "name": "Shiru's visiting day", "start": "2026-06-28T10:00",
         "end": "2026-06-28T14:00", "attendees": ["wanjiru"], "description": "Menengai Girls, carry shopping"},
        {"key": "shiru_halfterm", "name": "Pick Shiru for half term", "start": "2026-07-17T12:00",
         "end": "2026-07-17T13:00", "attendees": ["wanjiru", "moses"]},
        {"key": "ruracio", "name": "Ruracio in Nyeri", "start": "2026-07-18T09:00", "end": "2026-07-18T17:00",
         "attendees": ["esther", "james"]},
        {"key": "car_service", "name": "Car service", "start": "2026-06-17T08:00", "end": "2026-06-17T10:00",
         "attendees": ["githinji"]},
        {"key": "survey", "name": "Plot survey with Wycliffe", "start": "2026-06-15T15:00",
         "end": "2026-06-15T16:30", "attendees": ["wycliffe"], "description": "Bahati plot beacons"},
        {"key": "salon", "name": "Hair appointment", "start": "2026-06-02T16:00", "end": "2026-06-02T17:00",
         "attendees": ["lucy"], "trashed": "2026-06-01T08:00"},
        {"key": "salon_old", "name": "Hair appointment", "start": "2026-04-14T16:00", "end": "2026-04-14T17:00",
         "attendees": ["lucy"], "trashed": "2026-04-10T08:00"},
    ]
    return out


def tasks():
    t = [
        # school
        {"key": "mock_tt", "name": "Prepare mock exam timetable", "due": "2026-06-10", "priority": 1,
         "effort": 120, "list": "school_l", "status": "in_progress"},
        {"key": "hod_slots", "name": "Get subject slots from HODs", "parent": "mock_tt", "due": "2026-06-08",
         "effort": 30},
        {"key": "print_tt", "name": "Print the timetable", "parent": "mock_tt", "due": "2026-06-12", "effort": 30},
        {"key": "term_report", "name": "Write term 2 report for BOM", "due": "2026-06-09", "priority": 2,
         "effort": 180, "list": "school_l", "description": "enrolment, fees arrears, staffing"},
        {"key": "arrears", "name": "Follow up fees arrears list", "due": "2026-06-12", "list": "school_l",
         "effort": 60},
        {"key": "ribbons", "name": "Order sports day ribbons", "due": "2026-06-15", "list": "school_l",
         "effort": 30, "priority": 3},
        {"key": "books_1", "name": "Buy exercise books", "due": "2026-06-08", "list": "shopping_l", "effort": 30},
        {"key": "books_2", "name": "Buy exercise books", "due": "2026-05-04", "completed": "2026-05-04T17:00",
         "list": "shopping_l"},
        {"key": "obs_g4", "name": "Lesson observation Grade 4", "due": "2026-06-11", "effort": 40,
         "list": "school_l"},
        {"key": "appraisals", "name": "Staff appraisals", "status": "in_progress", "effort": 300,
         "list": "school_l", "priority": 2},
        {"key": "appr_janet", "name": "Appraise Janet", "parent": "appraisals", "completed": "2026-06-03T15:00",
         "due": "2026-06-03"},
        {"key": "appr_daniel", "name": "Appraise Daniel", "parent": "appraisals", "due": "2026-06-19",
         "effort": 60},
        {"key": "appr_collins", "name": "Appraise Collins", "parent": "appraisals", "due": "2026-06-26",
         "effort": 60},
        {"key": "gutter", "name": "Fix classroom roof gutter", "due": "2026-06-20", "list": "school_l",
         "priority": 2, "description": "Grade 3 block, call the fundi"},
        {"key": "tank", "name": "Clean the water tank", "due": "2026-05-28", "completed": "2026-05-28T16:00",
         "list": "school_l", "description": "school tank behind the kitchen"},
        {"key": "tsc", "name": "Submit TSC returns", "due": "2026-06-05", "priority": 1, "effort": 45,
         "list": "school_l"},
        {"key": "tsc_old", "name": "Submit TSC returns", "due": "2026-03-05", "completed": "2026-03-04T16:00",
         "list": "school_l"},
        {"key": "feeding", "name": "Renew school feeding contract", "due": "2026-06-30", "priority": 2,
         "effort": 90, "list": "school_l", "description": "Jecinta has the supplier quotes"},
        {"key": "library", "name": "Sort the library donation", "completed": "2026-05-22T15:00",
         "list": "school_l", "effort": 120},
        # home
        {"key": "water_bill", "name": "Pay Nakuru water bill", "due": "2026-06-15", "effort": 10, "list": "home_l"},
        {"key": "shiru_fees", "name": "Pay Shiru's school fees", "due": "2026-06-20", "priority": 1,
         "list": "home_l", "effort": 15},
        {"key": "shiru_fees_old", "name": "Pay Shiru's school fees", "due": "2026-01-10",
         "completed": "2026-01-09T12:00", "list": "home_l"},
        {"key": "shoes", "name": "Buy Shiru new school shoes", "due": "2026-06-25", "list": "shopping_l",
         "effort": 60},
        {"key": "gas", "name": "Refill gas cylinder", "due": "2026-06-07", "effort": 20, "list": "home_l"},
        {"key": "latch", "name": "Fix the gate latch", "status": "in_progress", "list": "home_l"},
        {"key": "tabby_pay", "name": "Pay Tabby", "due": "2026-06-30", "effort": 10, "list": "home_l"},
        {"key": "deed", "name": "Collect title deed copy from lands office", "due": "2026-06-22", "priority": 2,
         "effort": 120},
        {"key": "insurance", "name": "Renew car insurance", "due": "2026-06-28", "priority": 1, "effort": 30},
        {"key": "book_service", "name": "Book car service", "due": "2026-06-01", "completed": "2026-06-01T10:00"},
        {"key": "grad_gift", "name": "Buy gift for Brian's graduation", "due": "2026-07-05", "list": "shopping_l",
         "priority": 2},
        {"key": "curtains", "name": "Buy curtains for the sitting room", "list": "shopping_l",
         "trashed": "2026-05-25T09:00"},
        {"key": "sofa", "name": "Sell the old sofa", "trashed": "2026-04-01T09:00"},
        {"key": "naivasha_plan", "name": "Plan staff trip to Naivasha", "status": "cancelled", "list": "school_l"},
        {"key": "seedlings", "name": "Plant the avocado seedlings", "due": "2026-06-14", "effort": 90},
        # chama and church
        {"key": "minutes", "name": "Type chama minutes", "due": "2026-06-08", "list": "chama_l", "effort": 45},
        {"key": "contrib", "name": "Send chama contribution", "due": "2026-06-06", "list": "chama_l", "effort": 5},
        {"key": "contrib_may", "name": "Send chama contribution", "due": "2026-05-02",
         "completed": "2026-05-02T09:00", "list": "chama_l"},
        {"key": "loan_forms", "name": "Check chama loan forms", "due": "2026-06-13", "list": "chama_l",
         "priority": 3, "effort": 30, "description": "Beatrice and Rose applied"},
        {"key": "cards", "name": "Distribute harambee cards", "due": "2026-06-14", "list": "church_l",
         "effort": 60},
        {"key": "pledges", "name": "Record harambee pledges", "due": "2026-06-22", "list": "church_l",
         "effort": 60, "priority": 2},
        {"key": "robes", "name": "Collect choir robes from tailor", "due": "2026-06-11", "list": "church_l",
         "effort": 30},
        {"key": "tithe", "name": "Give tithe envelope", "due": "2026-05-31", "completed": "2026-05-31T11:00",
         "list": "church_l"},
        # health and personal
        {"key": "bp_pills", "name": "Refill blood pressure pills", "due": "2026-06-08", "priority": 1,
         "list": "health_l", "effort": 20},
        {"key": "eye_test", "name": "Book eye test", "list": "health_l"},
        {"key": "walk", "name": "Evening walk", "list": "health_l", "effort": 30, "status": "in_progress"},
        {"key": "call_esther", "name": "Call Esther about Shiru's visit", "due": "2026-06-09", "effort": 10},
        {"key": "thesis", "name": "Read Brian's thesis draft", "due": "2026-06-30", "effort": 240},
        {"key": "pension", "name": "Check pension statement", "priority": 3, "effort": 30},
        {"key": "sha_card", "name": "Update SHA card details", "due": "2026-05-29", "completed": "2026-05-29T12:00",
         "effort": 40},
        {"key": "airtime", "name": "Send airtime to Esther", "due": "2026-06-05", "completed": "2026-06-05T20:00",
         "effort": 5},
    ]
    # KPLC electricity, monthly on the 10th
    for m in range(2, 6):
        t.append({"key": f"kplc_{m:02d}", "name": "Pay KPLC bill", "due": f"2026-{m:02d}-10",
                  "completed": f"2026-{m:02d}-09T19:00", "list": "home_l"})
    t.append({"key": "kplc_06", "name": "Pay KPLC bill", "due": "2026-06-10", "list": "home_l", "effort": 10})
    return t


NOTEBOOKS = [
    {"key": "school_nb", "name": "School"},
    {"key": "chama_nb", "name": "Chama"},
    {"key": "church_nb", "name": "Church"},
    {"key": "recipes_nb", "name": "Recipes"},
    {"key": "family_nb", "name": "Family"},
    {"key": "diary_nb", "name": "Diary 2019"},
    {"key": "scratch_nb", "name": "Scratch"},
]

NOTES = [
    {"key": "bom_agenda", "name": "BOM agenda June", "body": "fees arrears, gutter repair, feeding contract, staffing",
     "notebook": "school_nb", "created": "2026-06-03T20:15", "pinned": True},
    {"key": "enrolment", "name": "Enrolment figures", "body": "Grade 1 to 6: 642 pupils, Junior school 211",
     "notebook": "school_nb", "created": "2026-05-26T10:00"},
    {"key": "staffing", "name": "Staffing gaps", "body": "need a Kiswahili teacher, Collins covering ICT and maths",
     "notebook": "school_nb", "created": "2026-05-28T16:00"},
    {"key": "obs_notes", "name": "Observation notes Janet", "body": "good group work, weak on time keeping",
     "notebook": "school_nb", "created": "2026-06-03T15:30"},
    {"key": "mock_plan", "name": "Mock exam plan", "body": "Grade 6 on Tuesday, Grade 8 on Wednesday, marking Friday",
     "notebook": "school_nb", "created": "2026-05-29T21:00"},
    {"key": "chama_rules", "name": "Chama rules", "body": "2000 a month each, loans at 10 percent, fine 200 for lateness",
     "notebook": "chama_nb", "created": "2024-01-06T16:00", "pinned": True},
    {"key": "chama_may", "name": "May meeting minutes", "body": "merry-go-round to Beatrice, tent money refunded",
     "notebook": "chama_nb", "created": "2026-05-02T17:00"},
    {"key": "loans", "name": "Loan applications", "body": "Beatrice 20000, Rose 15000, both for school fees",
     "notebook": "chama_nb", "created": "2026-06-01T19:30"},
    {"key": "harambee_target", "name": "Harambee target", "body": "target 1.2 million for the church roof",
     "notebook": "church_nb", "created": "2026-04-12T14:00"},
    {"key": "sermon", "name": "Sermon notes", "body": "Nehemiah rebuilding the wall, each family its own section",
     "notebook": "church_nb", "created": "2026-05-31T13:00"},
    {"key": "choir_songs", "name": "Choir songs for harambee", "body": "Tukutendereza, Bwana ni mchungaji",
     "notebook": "church_nb", "created": "2026-06-04T19:15"},
    {"key": "mukimo", "name": "Mukimo", "body": "potatoes, maize, pumpkin leaves, mash while hot",
     "notebook": "recipes_nb", "created": "2025-12-20T12:00"},
    {"key": "chapati", "name": "Chapati", "body": "warm water, a little sugar, rest the dough an hour",
     "notebook": "recipes_nb", "created": "2026-02-14T10:00"},
    {"key": "githeri", "name": "Githeri", "body": "soak the beans overnight, fry onions and dhania",
     "notebook": "recipes_nb", "created": "2026-05-05T18:00"},
    {"key": "shiru_term", "name": "Shiru term 2", "body": "maths improving, needs a new geometry set",
     "notebook": "family_nb", "created": "2026-06-01T20:00"},
    {"key": "grad_plan", "name": "Graduation plan", "body": "leave Nakuru 6am, Kevin drives, lunch at the hotel",
     "notebook": "family_nb", "created": "2026-06-05T21:10"},
    {"key": "dad_memorial", "name": "Memorial lunch", "body": "Kevin paid, Brian and I to refund our share",
     "notebook": "family_nb", "created": "2026-02-15T19:00"},
    {"key": "gift_ideas", "name": "Gift ideas", "body": "Brian: a leather bag; Shiru: a watch",
     "created": "2026-06-05T08:00"},
    {"key": "plot_notes", "name": "Bahati plot", "body": "beacons missing on the east side, Wycliffe to recheck",
     "created": "2026-05-27T19:00"},
    {"key": "car_notes", "name": "Car issues", "body": "brakes squeak, AC not cooling", "created": "2026-06-02T07:00"},
    {"key": "prayer", "name": "Prayer list", "body": "Esther's knee, Brian's exams, the school roof",
     "created": "2026-05-24T21:30", "pinned": True},
    {"key": "wifi_note", "name": "Router notes", "body": "Safaricom home fibre, restart the box in the study",
     "created": "2026-01-10T10:00"},
    {"key": "old_budget", "name": "Old house budget", "body": "2025 figures", "created": "2025-03-01T10:00",
     "trashed": "2026-05-30T10:00"},
    {"key": "old_minutes", "name": "Old chama minutes", "body": "2023", "created": "2023-06-01T10:00",
     "trashed": "2026-03-15T10:00"},
]

FOLDERS = [
    {"key": "board_f", "name": "School board"},
    {"key": "fees_f", "name": "School fees"},
    {"key": "land_f", "name": "Land"},
    {"key": "medical_f", "name": "Medical"},
    {"key": "chama_f", "name": "Chama"},
    {"key": "receipts_f", "name": "Old receipts"},
]

DOCUMENTS = [
    {"key": "bom_minutes", "name": "BOM minutes May", "folder": "board_f", "created": "2026-05-14T09:00"},
    {"key": "school_budget", "name": "School budget 2026", "folder": "board_f", "starred": True,
     "created": "2026-01-20T10:00"},
    {"key": "audit_letter", "name": "Audit letter", "folder": "board_f", "created": "2026-03-18T11:00"},
    {"key": "fee_structure", "name": "Fee structure 2026", "folder": "fees_f", "created": "2026-01-05T09:00"},
    {"key": "arrears_list", "name": "Fees arrears list", "folder": "fees_f", "created": "2026-06-01T12:00"},
    {"key": "shiru_receipt", "name": "Shiru fee receipt", "folder": "fees_f", "created": "2026-01-09T12:30"},
    {"key": "title", "name": "Bahati title deed", "folder": "land_f", "starred": True, "created": "2019-08-01T10:00"},
    {"key": "survey_map", "name": "Survey map", "folder": "land_f", "created": "2026-05-27T18:00"},
    {"key": "bp_chart", "name": "BP readings", "folder": "medical_f", "created": "2026-05-12T12:00"},
    {"key": "sha_letter", "name": "SHA registration", "folder": "medical_f", "created": "2026-05-29T12:10"},
    {"key": "chama_const", "name": "Chama constitution", "folder": "chama_f", "starred": True,
     "created": "2024-01-06T15:00"},
    {"key": "chama_ledger", "name": "Chama ledger 2026", "folder": "chama_f", "created": "2026-02-07T16:30"},
    {"key": "tsc_payslip", "name": "TSC payslip May", "created": "2026-05-28T08:00"},
    {"key": "grad_invite", "name": "Graduation invitation", "created": "2026-05-30T20:30"},
    {"key": "insurance_doc", "name": "Car insurance renewal", "created": "2026-06-04T10:45"},
    {"key": "scan_1", "name": "Scan 004", "created": "2026-06-02T18:00"},
    {"key": "scan_2", "name": "Scan 005", "created": "2026-06-02T18:01"},
    {"key": "old_lease", "name": "Old shop lease", "created": "2022-04-01T10:00", "trashed": "2026-05-18T10:00"},
]

ALBUMS = [
    {"key": "grad_album", "name": "Graduations"},
    {"key": "shiru_album", "name": "Shiru"},
    {"key": "chama_album", "name": "Chama"},
    {"key": "school_album", "name": "School events"},
    {"key": "family_album", "name": "Family"},
    {"key": "mombasa_album", "name": "Mombasa 2026"},
]

PHOTOS = [
    {"key": "kevin_grad", "name": "Kevin's graduation", "taken": "2021-12-10T11:00", "albums": ["grad_album", "family_album"],
     "people": ["kevin"], "starred": True},
    {"key": "gown_fitting", "name": "Brian in his gown", "taken": "2026-05-30T15:00", "albums": ["grad_album"],
     "people": ["brian"]},
    {"key": "shiru_form1", "name": "Shiru first day Form 1", "taken": "2025-01-13T07:30", "albums": ["shiru_album"],
     "people": ["wanjiru"], "starred": True},
    {"key": "shiru_prize", "name": "Shiru's maths prize", "taken": "2026-04-02T12:00", "albums": ["shiru_album"],
     "people": ["wanjiru"]},
    {"key": "shiru_bday", "name": "Shiru's birthday cake", "taken": "2026-05-09T19:00",
     "albums": ["shiru_album", "family_album"], "people": ["wanjiru", "tabby"]},
    {"key": "shiru_visit_p", "name": "Visiting day lunch", "taken": "2026-05-24T13:00", "albums": ["shiru_album"],
     "people": ["wanjiru"]},
    {"key": "chama_tent", "name": "Chama tent", "taken": "2026-03-21T12:00", "albums": ["chama_album"],
     "people": ["alice", "mary_a", "beatrice"]},
    {"key": "chama_may_p", "name": "May chama group photo", "taken": "2026-05-02T15:30", "albums": ["chama_album"],
     "people": ["alice", "mary_a", "beatrice", "rose", "susan"], "starred": True},
    {"key": "chama_cheque", "name": "Merry-go-round cheque", "taken": "2026-05-02T15:45", "albums": ["chama_album"],
     "people": ["beatrice"]},
    {"key": "prize_day1", "name": "Prize giving stage", "taken": "2026-03-27T11:00", "albums": ["school_album"],
     "people": ["mary_w", "peter_k"]},
    {"key": "prize_day2", "name": "Top pupils Grade 6", "taken": "2026-03-27T11:30", "albums": ["school_album"],
     "people": ["daniel"]},
    {"key": "book_fair_p", "name": "Book fair stand", "taken": "2026-05-20T10:15", "albums": ["school_album"],
     "people": ["janet"]},
    {"key": "new_tank", "name": "New water tank", "taken": "2026-05-28T16:10", "albums": ["school_album"]},
    {"key": "gutter_p", "name": "Broken gutter", "taken": "2026-06-01T10:00"},
    {"key": "staff_photo", "name": "Staff photo 2026", "taken": "2026-02-02T10:00", "albums": ["school_album"],
     "people": ["mary_w", "janet", "daniel", "collins", "joseph"], "starred": True},
    {"key": "kevin_bday_p", "name": "Kevin's birthday dinner", "taken": "2026-05-16T20:00", "albums": ["family_album"],
     "people": ["kevin", "naomi"]},
    {"key": "memorial_p", "name": "Memorial lunch", "taken": "2026-02-15T14:00", "albums": ["family_album"],
     "people": ["kevin", "brian", "esther"]},
    {"key": "nyeri_farm", "name": "Nyeri farm", "taken": "2025-12-22T10:00", "albums": ["family_album"],
     "people": ["esther", "james"]},
    {"key": "menengai", "name": "Menengai crater view", "taken": "2026-04-18T17:40", "starred": True},
    {"key": "lake_nakuru", "name": "Flamingos at Lake Nakuru", "taken": "2026-04-19T08:30"},
    {"key": "sunset", "name": "Sunset from the verandah", "taken": "2026-06-04T18:40"},
    {"key": "avocado", "name": "Avocado seedlings", "taken": "2026-06-05T17:00"},
    {"key": "church_roof", "name": "Church roof", "taken": "2026-04-12T12:30", "people": ["rev_kiprono"]},
    {"key": "harambee_cards_p", "name": "Harambee cards", "taken": "2026-05-20T16:00", "people": ["peter_o"]},
    {"key": "choir_p", "name": "Choir in new robes", "taken": "2025-12-25T11:00", "people": ["susan"]},
    {"key": "receipt_p", "name": "Photo of hardware receipt", "taken": "2026-06-03T12:00"},
    {"key": "whiteboard", "name": "Whiteboard timetable", "taken": "2026-06-04T14:00"},
    {"key": "survey_p", "name": "Plot beacon", "taken": "2026-05-27T15:00", "people": ["wycliffe"]},
    {"key": "tabby_kitchen", "name": "Tabby in the kitchen", "taken": "2026-05-10T12:00", "people": ["tabby"]},
    {"key": "flowers", "name": "Roses in the garden", "taken": "2026-05-31T08:00"},
    {"key": "blurry_1", "name": "Blurry choir", "taken": "2026-05-21T18:00", "trashed": "2026-05-22T07:00",
     "people": ["susan"]},
    {"key": "blurry_2", "name": "Blurry prize giving", "taken": "2026-03-27T11:10", "trashed": "2026-04-02T08:00"},
    {"key": "dup_tank", "name": "Water tank duplicate", "taken": "2026-05-28T16:11", "trashed": "2026-05-29T08:00"},
]

DEBTS = [
    {"key": "d_mary_a", "person": "mary_a", "direction": "owes_me", "amount": 500, "name": "Lunch contribution",
     "date": "2026-05-02"},
    {"key": "d_rose", "person": "rose", "direction": "owes_me", "amount": 500, "name": "Fabric for choir robes",
     "date": "2026-05-16"},
    {"key": "d_beatrice", "person": "beatrice", "direction": "i_owe", "amount": 1200, "name": "Merry-go-round top up",
     "date": "2026-04-04"},
    {"key": "d_brian", "person": "brian", "direction": "owes_me", "amount": 15000, "name": "Rent deposit Eldoret",
     "date": "2026-03-10"},
    {"key": "d_kevin", "person": "kevin", "direction": "i_owe", "amount": 3000, "name": "Airtime and data",
     "date": "2026-05-28"},
    {"key": "d_githinji", "person": "githinji", "direction": "i_owe", "amount": 4500, "name": "Brake pads",
     "date": "2026-06-01"},
    {"key": "d_peter_o", "person": "peter_o", "direction": "owes_me", "amount": 2000, "name": "Harambee card printing",
     "date": "2026-05-20"},
    {"key": "d_joseph", "person": "joseph", "direction": "i_owe", "amount": 800, "name": "Staff tea sugar",
     "date": "2026-06-03"},
    {"key": "d_esther", "person": "esther", "direction": "owes_me", "amount": 7000, "name": "Shiru's uniform",
     "date": "2026-02-14", "settled": "2026-04-01T10:00"},
    {"key": "d_susan", "person": "susan", "direction": "i_owe", "amount": 500, "name": "Choir robe deposit",
     "date": "2026-05-21"},
    {"key": "d_tabby", "person": "tabby", "direction": "i_owe", "amount": 2500, "name": "Tabby's advance",
     "date": "2026-04-30", "settled": "2026-05-30T18:00"},
    {"key": "d_alice", "person": "alice", "direction": "owes_me", "amount": 1500, "name": "Tent hire share",
     "date": "2026-03-21"},
    {"key": "d_naomi", "person": "naomi", "direction": "owes_me", "amount": 1000, "name": "Baby shower cake",
     "date": "2026-01-17", "settled": "2026-02-01T12:00"},
]

LOCKER = [
    {"key": "kcb", "name": "KCB mobile banking", "type": "login", "username": "gmwangi", "url": "https://kcb.co.ke",
     "password": "Menengai#64", "starred": True},
    {"key": "tsc_portal", "name": "TSC portal", "type": "login", "username": "TSC-418822",
     "url": "https://tsc.go.ke", "password": "Kiamunyi2026!", "notes": "school"},
    {"key": "itax", "name": "KRA iTax", "type": "login", "username": "A00912345X", "url": "https://itax.kra.go.ke",
     "password": "Shiru-2011", "notes": "personal"},
    {"key": "nemis", "name": "NEMIS", "type": "login", "username": "head.kiamunyi", "url": "https://nemis.education.go.ke",
     "password": "Grade6-Mock", "notes": "school"},
    {"key": "equity_card", "name": "Equity debit card", "type": "card", "card_number": "4187 2200 9134 5566",
     "cvv": "318", "starred": True},
    {"key": "safe_code", "name": "Office safe", "type": "note", "notes": "7-3-9-1, spare key with Joseph"},
    {"key": "nat_id", "name": "National ID", "type": "identity", "password": "21457789"},
    {"key": "wifi", "name": "Home wifi", "type": "wifi", "password": "flamingo-2026"},
    {"key": "office_pc", "name": "Office PC", "type": "password", "password": "Headteacher@1"},
    {"key": "server_key", "name": "School server key", "type": "ssh_key", "notes": "school",
     "password": "ssh-ed25519 AAAAC3-kiamunyi"},
    {"key": "sms_key", "name": "Parents SMS gateway", "type": "api_credential", "notes": "fees reminders",
     "password": "sms-7781-kiam"},
    {"key": "passport", "name": "Kenyan passport", "type": "passport", "notes": "expires 2029"},
    {"key": "equity_acc", "name": "Equity savings account", "type": "bank_account", "notes": "Shiru's fees account"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence", "notes": "smart DL, renew 2027"},
    {"key": "office_key", "name": "Office 2021 licence", "type": "software_licence", "password": "O21-GRCE-4471"},
    {"key": "crypto", "name": "Brian's crypto wallet", "type": "crypto_wallet", "notes": "Brian set it up, seed in the safe"},
    {"key": "sha", "name": "SHA membership", "type": "membership", "notes": "family cover"},
    {"key": "deed_copy", "name": "Title deed copy", "type": "document", "notes": "certified copy, lands office Nakuru"},
    {"key": "yahoo", "name": "Old Yahoo mail", "type": "login", "username": "gracem64", "url": "https://mail.yahoo.com",
     "password": "harambee99", "trashed": "2026-05-28T09:00"},
]

LINKS = [
    {"from": "arrears", "to": "joseph"},
    {"from": "term_report", "to": "peter_k"},
    {"from": "obs_g4", "to": "janet"},
    {"from": "appr_janet", "to": "janet"},
    {"from": "appr_daniel", "to": "daniel"},
    {"from": "appr_collins", "to": "collins"},
    {"from": "feeding", "to": "jecinta"},
    {"from": "gutter", "to": "githinji"},
    {"from": "shiru_fees", "to": "wanjiru"},
    {"from": "shoes", "to": "wanjiru"},
    {"from": "tabby_pay", "to": "tabby"},
    {"from": "grad_gift", "to": "brian"},
    {"from": "thesis", "to": "brian"},
    {"from": "call_esther", "to": "esther"},
    {"from": "loan_forms", "to": "beatrice"},
    {"from": "loan_forms", "to": "rose"},
    {"from": "cards", "to": "peter_o"},
    {"from": "robes", "to": "rose"},
    {"from": "minutes", "to": "mary_a"},
    {"from": "deed", "to": "wycliffe"},
    {"from": "bom_agenda", "to": "peter_k"},
    {"from": "bom_agenda", "to": "joseph"},
    {"from": "obs_notes", "to": "janet"},
    {"from": "staffing", "to": "collins"},
    {"from": "loans", "to": "beatrice"},
    {"from": "loans", "to": "rose"},
    {"from": "chama_may", "to": "beatrice"},
    {"from": "shiru_term", "to": "wanjiru"},
    {"from": "grad_plan", "to": "brian"},
    {"from": "grad_plan", "to": "kevin"},
    {"from": "dad_memorial", "to": "kevin"},
    {"from": "gift_ideas", "to": "brian"},
    {"from": "gift_ideas", "to": "wanjiru"},
    {"from": "plot_notes", "to": "wycliffe"},
    {"from": "prayer", "to": "esther"},
    {"from": "sermon", "to": "rev_kiprono"},
]


def world():
    return {
        "me": "Grace Mwangi",
        "epoch": "2019-01-01T09:00",
        "seed": "T21",
        "currency": "KES",
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
    out = HERE / "T21.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
