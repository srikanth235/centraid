"""World T12: Kenji Watanabe, owner of a small ramen shop in Sapporo (JPY vault).

    python3 authored/worlds/T12_build.py      # writes authored/worlds/T12.json (deterministic)

Today in the sessions is Tuesday 2026-08-18 15:45, two days back from the Obon trip to Osaka.
Married to Yuki, one toddler (Hana, 2); brother Takeshi in Osaka; runs the shop with a head cook
and four part-timers; buys noodles, pork, vegetables, kombu and miso from named suppliers; the
menu turns over with the seasons (hiyashi chuka ends with August, the autumn menu and the Autumn
Fest stall are next). Built-in ambiguity: two Ryos (Ryo Tanaka, Ryo Ishida), two Satos (Aiko,
Kenta), two Moris (Daisuke, and the trashed Tetsuya), two Hayashis, nicknames (Taka, Nishi-san,
Mei-chan, Dr. Yamada), a misspelled-looking name (Jyunichi Ogawa), two dentist appointments, two
accountant meetings, a health inspection and its follow-up, two wifi entries, near-duplicate
kombu orders, monthly rent history, cancelled events, completed tasks, rows trashed inside and
past the 30-day restore window, an empty group, an empty folder and an empty list.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def people():
    return [
        {"key": "yuki", "name": "Yuki Watanabe", "role": "wife", "starred": True, "cadence": 1,
         "last_contacted": "2026-08-18T12:10", "last_contacted_kind": "message"},
        {"key": "hana", "name": "Hana Watanabe", "role": "daughter"},
        {"key": "takeshi", "name": "Takeshi Watanabe", "role": "brother, Osaka", "cadence": 14, "starred": True,
         "met": "Osaka", "last_contacted": "2026-08-16T20:00", "last_contacted_kind": "call"},
        {"key": "emi", "name": "Emi Watanabe", "role": "sister-in-law, Osaka", "cadence": 60, "met": "Osaka",
         "last_contacted": "2026-08-15T19:00", "last_contacted_kind": "visit"},
        {"key": "fumiko", "name": "Fumiko Watanabe", "role": "mother, Asahikawa", "cadence": 7, "starred": True,
         "met": "Asahikawa", "last_contacted": "2026-08-09T18:00", "last_contacted_kind": "call"},
        {"key": "daisuke", "name": "Daisuke Mori", "role": "head cook", "cadence": 7,
         "last_contacted": "2026-08-18T11:00", "last_contacted_kind": "meeting"},
        {"key": "aiko", "name": "Aiko Sato", "role": "part-timer",
         "last_contacted": "2026-08-17T10:30", "last_contacted_kind": "meeting"},
        {"key": "ryo_t", "name": "Ryo Tanaka", "role": "part-timer",
         "last_contacted": "2026-08-17T10:30", "last_contacted_kind": "meeting"},
        {"key": "ryo_i", "name": "Ryo Ishida", "role": "dishwasher",
         "last_contacted": "2026-08-11T22:00", "last_contacted_kind": "message"},
        {"key": "mei", "name": "Mei Kobayashi", "role": "part-timer", "nickname": "Mei-chan",
         "last_contacted": "2026-08-14T09:00", "last_contacted_kind": "message"},
        {"key": "nishiyama", "name": "Hiroshi Nishiyama", "role": "noodle supplier", "nickname": "Nishi-san",
         "cadence": 30, "last_contacted": "2026-07-30T14:00", "last_contacted_kind": "visit"},
        {"key": "fujita", "name": "Makoto Fujita", "role": "pork supplier", "cadence": 30,
         "last_contacted": "2026-08-13T08:15", "last_contacted_kind": "call"},
        {"key": "endo", "name": "Kazuo Endo", "role": "vegetable farmer, Furano", "cadence": 60, "met": "Furano",
         "last_contacted": "2026-06-20T10:00", "last_contacted_kind": "call"},
        {"key": "ogawa", "name": "Jyunichi Ogawa", "role": "kombu supplier, Rishiri", "cadence": 90, "met": "Rishiri",
         "last_contacted": "2026-05-11T11:00", "last_contacted_kind": "call"},
        {"key": "ito", "name": "Goro Ito", "role": "miso supplier", "cadence": 30,
         "last_contacted": "2026-07-02T16:00", "last_contacted_kind": "call"},
        {"key": "hayashi_t", "name": "Tomoko Hayashi", "role": "beer rep", "cadence": 60,
         "last_contacted": "2026-07-22T15:00", "last_contacted_kind": "meeting"},
        {"key": "hayashi_m", "name": "Mariko Hayashi", "role": "playgroup mom",
         "last_contacted": "2026-08-07T11:00", "last_contacted_kind": "coffee"},
        {"key": "kimura", "name": "Masato Kimura", "role": "accountant", "cadence": 90,
         "last_contacted": "2026-07-15T14:00", "last_contacted_kind": "meeting"},
        {"key": "okada", "name": "Shigeru Okada", "role": "landlord",
         "last_contacted": "2026-04-01T10:00", "last_contacted_kind": "visit"},
        {"key": "suzuki", "name": "Naomi Suzuki", "role": "nursery teacher"},
        {"key": "yamada", "name": "Keiko Yamada", "role": "pediatrician", "nickname": "Dr. Yamada"},
        {"key": "nomura", "name": "Rie Nomura", "role": "dentist"},
        {"key": "yoshida", "name": "Akira Yoshida", "role": "health inspector"},
        {"key": "shun", "name": "Shun Takahashi", "role": "friend, ramen blogger", "nickname": "Taka", "cadence": 14,
         "starred": True, "met": "Hokkaido University", "last_contacted": "2026-08-02T21:00",
         "last_contacted_kind": "message"},
        {"key": "koji", "name": "Koji Nakamura", "role": "old classmate", "cadence": 30, "met": "Hokkaido University",
         "last_contacted": "2026-06-05T20:00", "last_contacted_kind": "call"},
        {"key": "minjun", "name": "Min-jun Park", "role": "ramyeon chef, Seoul", "met": "Seoul",
         "last_contacted": "2026-06-10T15:00", "last_contacted_kind": "visit"},
        {"key": "haruto", "name": "Haruto Sasaki", "role": "owner, gyoza shop next door", "cadence": 30,
         "last_contacted": "2026-08-11T21:30", "last_contacted_kind": "coffee"},
        {"key": "kenta_s", "name": "Kenta Sato", "role": "plumber",
         "last_contacted": "2026-08-17T16:00", "last_contacted_kind": "call"},
        {"key": "tetsuya", "name": "Tetsuya Mori", "role": "former part-timer", "trashed": "2026-08-05T10:00"},
        {"key": "sora", "name": "Sora Inoue", "role": "former delivery rider", "trashed": "2026-08-12T09:00"},
        {"key": "abe", "name": "Kenta Abe", "role": "old delivery driver", "trashed": "2026-05-02T09:00"},
    ]


GROUPS = [
    {"key": "staff", "name": "Shop staff kitty", "members": ["daisuke", "aiko", "ryo_t", "ryo_i", "mei"],
     "created": "2025-04-01T10:00"},
    {"key": "osaka", "name": "Osaka Obon trip", "members": ["takeshi", "emi", "yuki"], "created": "2026-07-01T21:00"},
    {"key": "seoul", "name": "Seoul ramyeon tour", "currency": "KRW", "members": ["shun", "koji", "minjun"],
     "created": "2026-05-10T21:00"},
    {"key": "alley", "name": "Ramen alley association", "members": ["haruto"], "created": "2025-06-01T10:00"},
    {"key": "yearend", "name": "Year-end party 2026", "members": ["daisuke", "aiko", "mei"],
     "created": "2026-08-10T22:00"},
]

EXPENSES = [
    {"group": "staff", "name": "Staff BBQ meat", "amount": 18000, "paid_by": "me",
     "split": ["me", "daisuke", "aiko", "ryo_t", "ryo_i", "mei"], "date": "2026-07-26"},
    {"group": "staff", "name": "Beers after stocktake", "amount": 7200, "paid_by": "daisuke",
     "split": ["me", "daisuke", "aiko", "ryo_t"], "date": "2026-08-01"},
    {"group": "osaka", "name": "Takoyaki party", "amount": 6000, "paid_by": "takeshi",
     "split": ["me", "takeshi", "emi", "yuki"], "date": "2026-08-14"},
    {"group": "osaka", "name": "Temple offering", "amount": 9000, "paid_by": "emi",
     "split": ["me", "takeshi", "emi"], "date": "2026-08-15"},
    {"group": "seoul", "name": "Guesthouse", "amount": 450000, "paid_by": "shun",
     "split": ["me", "shun", "koji"], "date": "2026-06-08"},
    {"group": "seoul", "name": "Noodle class", "amount": 120000, "paid_by": "me",
     "split": ["me", "shun", "koji", "minjun"], "date": "2026-06-10"},
    {"group": "alley", "name": "Lantern repairs", "amount": 30000, "paid_by": "haruto",
     "split": ["me", "haruto"], "date": "2026-07-20"},
]

LISTS = [
    {"key": "shop_l", "name": "Shop", "area": "work"},
    {"key": "seasonal_l", "name": "Seasonal menu", "area": "work"},
    {"key": "home_l", "name": "Home", "area": "home"},
    {"key": "hana_l", "name": "Hana", "area": "family"},
    {"key": "paper_l", "name": "Paperwork"},
    {"key": "balcony_l", "name": "Balcony garden"},
]


def events():
    out = []
    # staff meeting, Monday mornings (none on 31 Aug: boiler day)
    for x in ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17",
              "2026-08-24", "2026-09-07"]:
        d = date.fromisoformat(x)
        out.append({"key": f"staff_{d.strftime('%m%d')}", "name": "Staff meeting", "start": f"{d}T10:00",
                    "end": f"{d}T10:30", "attendees": ["daisuke", "aiko", "ryo_t"]})
    # pork delivery, Thursday mornings (skipped over Obon)
    for x in ["2026-07-02", "2026-07-09", "2026-07-16", "2026-07-23", "2026-07-30", "2026-08-06", "2026-08-20",
              "2026-08-27", "2026-09-03"]:
        d = date.fromisoformat(x)
        out.append({"key": f"pork_{d.strftime('%m%d')}", "name": "Pork delivery from Fujita", "start": f"{d}T08:00",
                    "end": f"{d}T08:30", "attendees": ["fujita"]})
    # Hana's swim class, Saturday mornings
    for x in ["2026-07-25", "2026-08-01", "2026-08-08", "2026-08-22", "2026-08-29", "2026-09-05"]:
        d = date.fromisoformat(x)
        ev = {"key": f"swim_{d.strftime('%m%d')}", "name": "Hana's swim class", "start": f"{d}T09:30",
              "end": f"{d}T10:15", "attendees": ["hana"], "description": "kids pool, Nakajima park"}
        if x == "2026-08-29":
            ev["cancelled"] = "2026-08-12T20:00"
        out.append(ev)
    # video call with Takeshi, every other Sunday evening
    for x in ["2026-07-05", "2026-07-19", "2026-08-02", "2026-08-23", "2026-09-06"]:
        d = date.fromisoformat(x)
        out.append({"key": f"call_{d.strftime('%m%d')}", "name": "Video call with Takeshi", "start": f"{d}T20:00",
                    "end": f"{d}T20:45", "attendees": ["takeshi"]})
    out += [
        {"key": "obon", "name": "Obon trip to Osaka", "start": "2026-08-13T07:00", "end": "2026-08-16T19:00",
         "attendees": ["yuki", "hana", "takeshi", "emi"], "description": "JAL from New Chitose, stay at Takeshi's"},
        {"key": "seoul_trip", "name": "Seoul ramyeon tour", "start": "2026-06-08T09:00", "end": "2026-06-11T18:00",
         "attendees": ["shun", "koji", "minjun"]},
        {"key": "koji_lunch", "name": "Lunch with Koji", "start": "2026-07-10T12:00", "end": "2026-07-10T13:00",
         "attendees": ["koji"]},
        {"key": "beer_tasting", "name": "Beer tasting with Hayashi", "start": "2026-07-22T15:00",
         "end": "2026-07-22T16:00", "attendees": ["hayashi_t"]},
        {"key": "staff_bbq", "name": "Staff BBQ", "start": "2026-07-26T12:00", "end": "2026-07-26T16:00",
         "attendees": ["daisuke", "aiko", "ryo_t", "ryo_i", "mei"], "description": "Toyohira riverside"},
        {"key": "koji_bbq", "name": "BBQ with Koji", "start": "2026-08-08T17:00", "end": "2026-08-08T20:00",
         "attendees": ["koji"], "cancelled": "2026-08-06T09:00"},
        {"key": "acct_may", "name": "Accountant meeting", "start": "2026-05-14T14:00", "end": "2026-05-14T15:00",
         "attendees": ["kimura"]},
        {"key": "acct_aug", "name": "Accountant meeting", "start": "2026-08-20T14:00", "end": "2026-08-20T15:00",
         "attendees": ["kimura"], "description": "bring July receipts"},
        {"key": "shift_plan", "name": "Staff shift planning", "start": "2026-08-18T11:00", "end": "2026-08-18T12:00",
         "attendees": ["daisuke"]},
        {"key": "haruto_coffee", "name": "Coffee with Haruto", "start": "2026-08-18T17:00", "end": "2026-08-18T17:30",
         "attendees": ["haruto"]},
        {"key": "checkup", "name": "Hana's checkup", "start": "2026-08-19T10:00", "end": "2026-08-19T10:30",
         "attendees": ["yamada", "hana", "yuki"]},
        {"key": "open_day", "name": "Nursery open day", "start": "2026-08-19T14:00", "end": "2026-08-19T15:00",
         "attendees": ["suzuki", "hana", "yuki"]},
        {"key": "ito_call", "name": "Miso order call with Ito", "start": "2026-08-19T16:00", "end": "2026-08-19T16:30",
         "attendees": ["ito"]},
        {"key": "dentist_me", "name": "Dentist appointment", "start": "2026-08-21T11:00", "end": "2026-08-21T11:45",
         "attendees": ["nomura"]},
        {"key": "shun_coffee", "name": "Coffee with Shun", "start": "2026-08-21T15:00", "end": "2026-08-21T16:00",
         "attendees": ["shun"]},
        {"key": "noodle_trial", "name": "Noodle trial with Nishiyama", "start": "2026-08-24T14:00",
         "end": "2026-08-24T15:00", "attendees": ["nishiyama", "daisuke"]},
        {"key": "lease_mtg", "name": "Lease renewal with Okada", "start": "2026-08-25T17:00", "end": "2026-08-25T18:00",
         "attendees": ["okada"]},
        {"key": "dentist_hana", "name": "Dentist appointment for Hana", "start": "2026-08-26T16:00",
         "end": "2026-08-26T16:30", "attendees": ["nomura", "hana"]},
        {"key": "inspection", "name": "Health inspection", "start": "2026-08-27T14:00", "end": "2026-08-27T15:00",
         "attendees": ["yoshida"]},
        {"key": "yuki_bday", "name": "Yuki's birthday dinner", "start": "2026-08-28T19:00", "end": "2026-08-28T21:30",
         "attendees": ["yuki", "hana"], "description": "table for three at Nijo market"},
        {"key": "farm", "name": "Farm visit in Furano", "start": "2026-08-30T08:00", "end": "2026-08-30T16:00",
         "attendees": ["endo", "yuki", "hana"]},
        {"key": "boiler_fix", "name": "Boiler maintenance", "start": "2026-08-31T13:00", "end": "2026-08-31T17:00",
         "attendees": ["kenta_s"]},
        {"key": "kombu_tasting", "name": "Kombu tasting with Ogawa", "start": "2026-09-03T14:00",
         "end": "2026-09-03T15:30", "attendees": ["ogawa"]},
        {"key": "mom_visit", "name": "Mom arrives from Asahikawa", "start": "2026-09-05T13:00",
         "end": "2026-09-05T14:00", "attendees": ["fumiko"]},
        {"key": "reinspection", "name": "Health inspection follow-up", "start": "2026-09-10T14:00",
         "end": "2026-09-10T14:30", "attendees": ["yoshida"]},
        {"key": "fest_setup", "name": "Autumn Fest stall setup", "start": "2026-09-11T08:00", "end": "2026-09-11T12:00",
         "attendees": ["daisuke", "haruto"]},
        {"key": "fest", "name": "Sapporo Autumn Fest stall", "start": "2026-09-12T10:00", "end": "2026-09-12T20:00",
         "attendees": ["daisuke", "aiko", "mei"], "description": "Odori park, block 8"},
        {"key": "expo", "name": "Ramen expo Tokyo", "start": "2026-09-20T09:00", "end": "2026-09-20T18:00",
         "attendees": ["shun"], "cancelled": "2026-08-01T12:00"},
        {"key": "tasting_night", "name": "Menu tasting night", "start": "2026-08-22T18:00", "end": "2026-08-22T20:00",
         "attendees": ["daisuke", "shun"], "trashed": "2026-08-10T09:00"},
        {"key": "stove_pickup", "name": "Old stove pickup", "start": "2026-06-02T09:00", "end": "2026-06-02T10:00",
         "trashed": "2026-06-01T09:00"},
    ]
    return out


def tasks():
    t = [
        # shop
        {"key": "kombu_jul", "name": "Order kombu from Rishiri", "due": "2026-07-05", "completed": "2026-07-04T10:00",
         "list": "shop_l"},
        {"key": "kombu_aug", "name": "Order kombu from Rishiri", "due": "2026-08-21", "effort": 15, "list": "shop_l"},
        {"key": "boiler", "name": "Fix the noodle boiler", "due": "2026-08-20", "priority": 1, "effort": 90,
         "status": "in_progress", "list": "shop_l"},
        {"key": "machine", "name": "Fix the noodle machine", "due": "2026-07-20", "completed": "2026-07-19T17:00",
         "list": "shop_l"},
        {"key": "noren", "name": "Replace the noren curtain", "due": "2026-09-15", "effort": 60, "list": "shop_l"},
        {"key": "chashu", "name": "Test new chashu recipe", "status": "in_progress", "effort": 180, "list": "shop_l"},
        {"key": "shifts", "name": "Post September shift schedule", "due": "2026-08-25", "effort": 45, "list": "shop_l"},
        {"key": "insp_prep", "name": "Prepare for health inspection", "due": "2026-08-27", "priority": 1,
         "list": "shop_l"},
        {"key": "fire_ext", "name": "Check fire extinguishers", "parent": "insp_prep", "due": "2026-08-26", "effort": 20},
        {"key": "hood", "name": "Deep clean the exhaust hood", "parent": "insp_prep", "due": "2026-08-26", "effort": 120,
         "priority": 1},
        {"key": "temp_log", "name": "Print fridge temperature logs", "parent": "insp_prep", "due": "2026-08-25",
         "effort": 15},
        # seasonal menu
        {"key": "hiyashi", "name": "Switch to hiyashi chuka menu", "due": "2026-06-15", "completed": "2026-06-14T21:00",
         "list": "seasonal_l"},
        {"key": "corn", "name": "Order Furano corn for miso butter ramen", "due": "2026-08-28", "effort": 20,
         "list": "seasonal_l"},
        {"key": "winter_miso", "name": "Order winter miso stock", "due": "2026-10-15", "priority": 2,
         "list": "seasonal_l"},
        {"key": "autumn_menu", "name": "Autumn menu launch", "due": "2026-09-15", "priority": 1, "list": "seasonal_l",
         "description": "miso butter corn, winter tsukemen trial"},
        {"key": "menu_photos", "name": "Shoot photos for autumn menu", "parent": "autumn_menu", "due": "2026-09-05",
         "effort": 60},
        {"key": "menu_print", "name": "Print new menus", "parent": "autumn_menu", "due": "2026-09-10", "effort": 30},
        {"key": "menu_price", "name": "Set autumn prices", "parent": "autumn_menu", "due": "2026-08-31", "effort": 45},
        {"key": "hiyashi_end", "name": "Stop hiyashi chuka at end of August", "due": "2026-08-31", "effort": 10,
         "list": "seasonal_l"},
        {"key": "fest_task", "name": "Autumn Fest stall", "due": "2026-09-12", "priority": 2, "list": "seasonal_l"},
        {"key": "fest_permit", "name": "Apply for stall permit", "parent": "fest_task", "due": "2026-08-17",
         "effort": 30, "completed": "2026-08-17T09:10"},
        {"key": "fest_gas", "name": "Rent portable gas burners", "parent": "fest_task", "due": "2026-09-05"},
        {"key": "fest_bowls", "name": "Order paper bowls", "parent": "fest_task", "due": "2026-09-01", "effort": 15},
        # home
        {"key": "aircon", "name": "Clean the air conditioner filter", "due": "2026-08-22", "effort": 30,
         "list": "home_l"},
        {"key": "gas_aug", "name": "Pay gas bill", "due": "2026-08-20", "effort": 5, "list": "home_l"},
        {"key": "gas_jul", "name": "Pay gas bill", "due": "2026-07-20", "completed": "2026-07-18T09:00",
         "list": "home_l"},
        {"key": "snow_tires", "name": "Book snow tire change", "due": "2026-10-30", "list": "home_l"},
        {"key": "shaken", "name": "Car inspection (shaken)", "due": "2026-09-18", "priority": 2, "effort": 120,
         "list": "home_l"},
        {"key": "rice_cooker", "name": "Buy new rice cooker", "status": "cancelled", "due": "2026-07-31",
         "list": "home_l"},
        # hana
        {"key": "nursery", "name": "Hana nursery application", "due": "2026-09-01", "priority": 1, "list": "hana_l"},
        {"key": "nursery_form", "name": "Fill in nursery form", "parent": "nursery", "due": "2026-08-25", "effort": 45},
        {"key": "nursery_photo", "name": "Get ID photo for Hana", "parent": "nursery", "due": "2026-08-22",
         "effort": 20},
        {"key": "nursery_cert", "name": "Get health certificate from Dr. Yamada", "parent": "nursery",
         "due": "2026-08-28"},
        {"key": "shoes", "name": "Buy new shoes for Hana", "due": "2026-08-23", "effort": 30, "list": "hana_l"},
        {"key": "flu_shot", "name": "Book Hana's flu shot", "due": "2026-10-01", "list": "hana_l"},
        {"key": "hana_bday", "name": "Plan Hana's 3rd birthday", "due": "2026-11-03", "list": "hana_l"},
        # paperwork
        {"key": "tax", "name": "File consumption tax return", "due": "2026-08-31", "priority": 1, "effort": 120,
         "list": "paper_l"},
        {"key": "receipts", "name": "Send July receipts to Kimura", "due": "2026-08-10", "effort": 30,
         "list": "paper_l"},
        {"key": "shop_ins_t", "name": "Renew shop insurance", "due": "2026-09-20", "effort": 30, "list": "paper_l"},
        {"key": "lease_t", "name": "Sign new lease", "due": "2026-08-25", "priority": 2, "list": "paper_l"},
        {"key": "permit_t", "name": "Renew food hygiene permit", "due": "2026-09-30", "priority": 2, "list": "paper_l"},
        # loose
        {"key": "call_mom", "name": "Call mom about September visit", "due": "2026-08-19", "effort": 10},
        {"key": "gift_yuki", "name": "Buy Yuki's birthday present", "due": "2026-08-27", "priority": 1, "effort": 60},
        {"key": "souvenirs", "name": "Send Osaka souvenirs to Nishiyama", "due": "2026-08-17",
         "completed": "2026-08-17T14:00"},
        {"key": "blog", "name": "Reply to Taka's blog interview", "due": "2026-08-24", "effort": 60},
        {"key": "aprons", "name": "Order new aprons", "due": "2026-08-20", "trashed": "2026-08-08T10:00",
         "list": "shop_l"},
        {"key": "old_bike", "name": "Sell old delivery bike", "trashed": "2026-04-10T10:00"},
    ]
    # shop rent, monthly on the 25th: history plus August open
    for m in range(1, 8):
        t.append({"key": f"rent_{m:02d}", "name": "Pay shop rent", "due": f"2026-{m:02d}-25",
                  "completed": f"2026-{m:02d}-24T10:00", "list": "shop_l", "effort": 10})
    t.append({"key": "rent_08", "name": "Pay shop rent", "due": "2026-08-25", "list": "shop_l", "effort": 10})
    return t


NOTEBOOKS = [
    {"key": "broth_nb", "name": "Broth recipes"},
    {"key": "supplier_nb", "name": "Supplier notes"},
    {"key": "hana_nb", "name": "Hana diary"},
    {"key": "ideas_nb", "name": "Shop ideas"},
    {"key": "accounts_nb", "name": "Accounts"},
]

NOTES = [
    {"key": "tonkotsu", "name": "Tonkotsu base", "body": "pork bones 12 hours, keep the boil rolling, skim every hour",
     "notebook": "broth_nb", "created": "2026-03-02T22:00", "pinned": True},
    {"key": "shio_tare", "name": "Shio tare", "body": "Rishiri kombu, dried scallop, Okhotsk sea salt",
     "notebook": "broth_nb", "created": "2026-03-20T23:00"},
    {"key": "miso_blend", "name": "Sapporo miso blend",
     "body": "red miso from Ito, white miso, a little hatcho; fry with lard and garlic",
     "notebook": "broth_nb", "created": "2026-04-05T22:30"},
    {"key": "hiyashi_note", "name": "Hiyashi chuka dressing", "body": "soy, rice vinegar, sesame oil, sugar; chill overnight",
     "notebook": "broth_nb", "created": "2026-06-10T21:00"},
    {"key": "noodle_specs", "name": "Nishiyama noodle specs", "body": "22 cm, 1.4 mm thick, curly for miso, straight for shio",
     "notebook": "supplier_nb", "created": "2026-05-03T15:00"},
    {"key": "fujita_prices", "name": "Fujita price list",
     "body": "pork belly 1450 yen per kg from August, bones free if we take 20 kg",
     "notebook": "supplier_nb", "created": "2026-07-31T20:00"},
    {"key": "corn_sched", "name": "Endo corn schedule", "body": "corn ready from 20 August, potatoes in September",
     "notebook": "supplier_nb", "created": "2026-06-20T11:00"},
    {"key": "kombu_order", "name": "Kombu order", "body": "second grade Rishiri kombu, 5 kg per quarter",
     "notebook": "supplier_nb", "created": "2026-05-11T12:00"},
    {"key": "hana_words", "name": "Hana's new words", "body": "says ramen and wan-wan now, waves at the noren",
     "notebook": "hana_nb", "created": "2026-07-28T21:00", "pinned": True},
    {"key": "hana_allergy", "name": "Hana allergies", "body": "no known allergies, check egg again at 3",
     "notebook": "hana_nb", "created": "2026-02-15T20:00"},
    {"key": "nursery_q", "name": "Nursery questions", "body": "ask about naps, lunch menu, pickup times",
     "notebook": "hana_nb", "created": "2026-08-14T21:30"},
    {"key": "idea_corn", "name": "Miso butter corn ramen", "body": "Furano corn, butter pat, extra garlic oil",
     "notebook": "ideas_nb", "created": "2026-07-05T23:00"},
    {"key": "idea_tsuke", "name": "Winter tsukemen", "body": "thick noodles from Nishiyama, dipping broth with yuzu",
     "notebook": "ideas_nb", "created": "2026-08-10T22:15"},
    {"key": "idea_kids", "name": "Kids menu", "body": "small shoyu bowl for toddlers, no chili, 400 yen",
     "notebook": "ideas_nb", "created": "2026-08-05T22:00"},
    {"key": "idea_fest", "name": "Festival menu", "body": "only miso and shio, paper bowls, 800 yen each",
     "notebook": "ideas_nb", "created": "2026-08-17T22:40"},
    {"key": "acct_july", "name": "July takings", "body": "sales 3.2 million yen, food cost 34 percent",
     "notebook": "accounts_nb", "created": "2026-08-03T21:00"},
    {"key": "acct_tax", "name": "Consumption tax notes", "body": "Kimura says file by 31 August, bring July receipts",
     "notebook": "accounts_nb", "created": "2026-07-15T16:00"},
    {"key": "osaka_note", "name": "Osaka trip notes", "body": "Takeshi recommends Kamukura, bring pickles for Emi",
     "created": "2026-08-12T22:00"},
    {"key": "lease_note", "name": "Lease renewal points", "body": "ask Okada about the 3 percent increase and parking",
     "created": "2026-08-16T22:00"},
    {"key": "staff_note", "name": "Staff feedback", "body": "Aiko wants weekend shifts, Ryo Tanaka has exams in September",
     "created": "2026-08-17T11:20"},
    {"key": "gift_note", "name": "Yuki gift ideas", "body": "hand cream, Rokkatei sweets, a day at Jozankei onsen",
     "created": "2026-08-17T23:10"},
    {"key": "old_prices", "name": "Old summer menu prices", "body": "hiyashi 950, shio 850, miso 900",
     "notebook": "ideas_nb", "created": "2026-05-01T21:00", "trashed": "2026-08-11T09:00"},
    {"key": "flyer_draft", "name": "Draft flyer text", "body": "grand reopening after the boiler fix",
     "created": "2026-05-20T21:00", "trashed": "2026-06-20T09:00"},
]

FOLDERS = [
    {"key": "permits_f", "name": "Permits"},
    {"key": "tax_f", "name": "Taxes 2025"},
    {"key": "lease_f", "name": "Lease"},
    {"key": "invoices_f", "name": "Supplier invoices"},
    {"key": "hana_f", "name": "Hana"},
    {"key": "insurance_f", "name": "Insurance"},
    {"key": "oldmenus_f", "name": "Old menus"},
]

DOCUMENTS = [
    {"key": "hygiene", "name": "Food hygiene permit", "folder": "permits_f", "starred": True,
     "created": "2024-10-01T10:00"},
    {"key": "fire_cert", "name": "Fire safety certificate", "folder": "permits_f", "created": "2025-03-15T10:00"},
    {"key": "stall_permit", "name": "Autumn Fest stall permit", "folder": "permits_f", "created": "2026-08-17T09:00"},
    {"key": "tax_2025", "name": "2025 tax return", "folder": "tax_f", "starred": True, "created": "2026-03-10T10:00"},
    {"key": "blue_form", "name": "Blue return form", "folder": "tax_f", "created": "2026-03-09T10:00"},
    {"key": "july_receipts", "name": "July receipts scan", "folder": "tax_f", "created": "2026-08-14T10:30"},
    {"key": "lease_2024", "name": "Shop lease 2024", "folder": "lease_f", "starred": True, "created": "2024-09-01T10:00"},
    {"key": "lease_draft", "name": "Lease renewal draft", "folder": "lease_f", "created": "2026-08-12T15:00"},
    {"key": "nishi_inv", "name": "Nishiyama invoice July", "folder": "invoices_f", "created": "2026-08-03T11:00"},
    {"key": "fujita_inv", "name": "Fujita invoice July", "folder": "invoices_f", "created": "2026-08-04T11:00"},
    {"key": "ito_inv", "name": "Ito miso invoice June", "folder": "invoices_f", "created": "2026-07-06T11:00"},
    {"key": "hana_ins", "name": "Hana's health insurance card", "folder": "hana_f", "created": "2025-01-20T10:00"},
    {"key": "hana_vax", "name": "Hana vaccination record", "folder": "hana_f", "starred": True,
     "created": "2026-02-15T10:00"},
    {"key": "nursery_doc", "name": "Nursery application form", "folder": "hana_f", "created": "2026-08-10T20:00"},
    {"key": "shop_ins", "name": "Shop insurance policy", "folder": "insurance_f", "starred": True,
     "created": "2025-09-20T10:00"},
    {"key": "car_ins", "name": "Car insurance certificate", "folder": "insurance_f", "created": "2025-11-01T10:00"},
    {"key": "menu_aug", "name": "August menu", "starred": True, "created": "2026-08-01T09:00"},
    {"key": "old_prices_doc", "name": "Old price list", "folder": "invoices_f", "created": "2026-04-01T10:00",
     "trashed": "2026-08-06T09:00"},
    {"key": "old_lease", "name": "Old lease 2020", "folder": "lease_f", "created": "2020-09-01T10:00",
     "trashed": "2026-06-10T09:00"},
]

ALBUMS = [
    {"key": "shop_album", "name": "Shop"},
    {"key": "menu_album", "name": "Menu shots"},
    {"key": "hana_album", "name": "Hana"},
    {"key": "osaka_album", "name": "Osaka Obon 2026"},
    {"key": "seoul_album", "name": "Seoul 2026"},
    {"key": "fest_album", "name": "Autumn Fest 2025"},
]

PHOTOS = [
    {"key": "shop_front", "name": "Shop front with the new noren", "taken": "2026-05-02T10:00", "albums": ["shop_album"],
     "starred": True},
    {"key": "bbq_p", "name": "Staff BBQ group shot", "taken": "2026-07-26T14:00", "albums": ["shop_album"],
     "people": ["daisuke", "aiko", "ryo_t", "ryo_i", "mei"], "starred": True},
    {"key": "queue_p", "name": "Queue outside on Saturday", "taken": "2026-08-08T12:30", "albums": ["shop_album"]},
    {"key": "daisuke_p", "name": "Daisuke at the stockpot", "taken": "2026-06-20T16:00", "albums": ["shop_album"],
     "people": ["daisuke"]},
    {"key": "boiler_p", "name": "Broken noodle boiler", "taken": "2026-08-17T15:00"},
    {"key": "miso_bowl", "name": "Miso ramen bowl", "taken": "2026-04-10T13:00", "albums": ["menu_album", "shop_album"]},
    {"key": "shio_bowl", "name": "Shio ramen bowl", "taken": "2026-04-10T13:30", "albums": ["menu_album"]},
    {"key": "hiyashi_p", "name": "Hiyashi chuka plate", "taken": "2026-06-15T12:00", "albums": ["menu_album"],
     "starred": True},
    {"key": "corn_p", "name": "Miso butter corn test", "taken": "2026-08-17T20:00"},
    {"key": "hana_pool", "name": "Hana at the pool", "taken": "2026-08-08T10:30", "albums": ["hana_album"],
     "people": ["hana"], "starred": True},
    {"key": "hana_osaka", "name": "Hana and Takeshi in Osaka", "taken": "2026-08-14T16:00",
     "albums": ["hana_album", "osaka_album"], "people": ["hana", "takeshi"]},
    {"key": "hana_bday2", "name": "Hana's 2nd birthday", "taken": "2025-11-03T15:00", "albums": ["hana_album"],
     "people": ["hana", "yuki"]},
    {"key": "hana_snow", "name": "Hana's first snow", "taken": "2025-12-05T11:00", "albums": ["hana_album"],
     "people": ["hana"]},
    {"key": "hana_noodles", "name": "Hana eating noodles", "taken": "2026-07-12T12:00", "people": ["hana"]},
    {"key": "castle", "name": "Osaka castle", "taken": "2026-08-14T11:00", "albums": ["osaka_album"], "people": ["yuki"]},
    {"key": "dotonbori", "name": "Dotonbori at night", "taken": "2026-08-14T21:00", "albums": ["osaka_album"]},
    {"key": "kamukura", "name": "Kamukura ramen with Takeshi", "taken": "2026-08-15T12:30", "albums": ["osaka_album"],
     "people": ["takeshi", "emi"]},
    {"key": "grave", "name": "Family grave visit", "taken": "2026-08-15T09:00", "albums": ["osaka_album"],
     "people": ["takeshi", "yuki"]},
    {"key": "gwangjang", "name": "Gwangjang market", "taken": "2026-06-09T12:00", "albums": ["seoul_album"],
     "people": ["shun", "koji"]},
    {"key": "noodle_class", "name": "Noodle class with Min-jun", "taken": "2026-06-10T15:00", "albums": ["seoul_album"],
     "people": ["minjun", "shun", "koji"]},
    {"key": "seoul_night", "name": "Seoul at night", "taken": "2026-06-10T21:00", "albums": ["seoul_album"]},
    {"key": "fest25_stall", "name": "Our stall 2025", "taken": "2025-09-13T12:00", "albums": ["fest_album"],
     "people": ["daisuke", "aiko"]},
    {"key": "fest25_crowd", "name": "Festival crowd", "taken": "2025-09-13T18:00", "albums": ["fest_album"]},
    {"key": "farm_p", "name": "Endo's corn field", "taken": "2025-08-30T10:00", "people": ["endo"]},
    {"key": "opening", "name": "Shop opening day", "taken": "2019-04-01T11:00", "people": ["yuki"], "starred": True},
    {"key": "wedding", "name": "Our wedding", "taken": "2021-06-12T14:00", "people": ["yuki"], "starred": True},
    {"key": "lanterns", "name": "Ramen alley lanterns", "taken": "2026-07-20T20:00", "people": ["haruto"]},
    {"key": "tsuke_p", "name": "Tsukemen trial bowl", "taken": "2026-08-10T22:30", "albums": ["menu_album"]},
    {"key": "hana_grandma", "name": "Hana with grandma", "taken": "2026-05-05T12:00", "albums": ["hana_album"],
     "people": ["hana", "fumiko"]},
    {"key": "beer_p", "name": "Beer tasting samples", "taken": "2026-07-22T15:30", "people": ["hayashi_t"]},
    {"key": "receipt_p", "name": "Costco receipt", "taken": "2026-08-11T18:00"},
    {"key": "blur_p", "name": "Blurry kitchen shot", "taken": "2026-08-17T15:05", "trashed": "2026-08-17T16:00"},
    {"key": "old_board", "name": "Old menu board", "taken": "2026-03-01T12:00", "trashed": "2026-05-01T09:00"},
]

DEBTS = [
    {"key": "d_takeshi", "person": "takeshi", "direction": "owes_me", "amount": 32000, "name": "Obon flight share",
     "date": "2026-08-12"},
    {"key": "d_shun", "person": "shun", "direction": "i_owe", "amount": 16500, "name": "Seoul guesthouse share",
     "date": "2026-06-12"},
    {"key": "d_koji", "person": "koji", "direction": "owes_me", "amount": 8000, "name": "Concert tickets",
     "date": "2026-05-20", "settled": "2026-06-05T10:00"},
    {"key": "d_haruto", "person": "haruto", "direction": "i_owe", "amount": 4500, "name": "Borrowed gas cylinder",
     "date": "2026-08-11"},
    {"key": "d_daisuke", "person": "daisuke", "direction": "owes_me", "amount": 30000, "name": "Advance on wages",
     "date": "2026-07-31"},
    {"key": "d_aiko", "person": "aiko", "direction": "i_owe", "amount": 2800, "name": "Taxi after late shift",
     "date": "2026-08-10"},
    {"key": "d_fujita", "person": "fujita", "direction": "i_owe", "amount": 12000, "name": "Extra pork bones",
     "date": "2026-08-13"},
    {"key": "d_nishiyama", "person": "nishiyama", "direction": "i_owe", "amount": 3500, "name": "Sample noodles",
     "date": "2026-07-28", "settled": "2026-08-03T10:00"},
    {"key": "d_mei", "person": "mei", "direction": "owes_me", "amount": 5000, "name": "Uniform deposit",
     "date": "2026-08-17"},
    {"key": "d_emi", "person": "emi", "direction": "i_owe", "amount": 9000, "name": "Kobe beef gift",
     "date": "2026-08-15"},
    {"key": "d_ryo_i", "person": "ryo_i", "direction": "owes_me", "amount": 7000, "name": "Bike repair loan",
     "date": "2026-08-03"},
    {"key": "d_kenta", "person": "kenta_s", "direction": "i_owe", "amount": 6800, "name": "Plumbing parts",
     "date": "2026-08-17"},
]

LOCKER = [
    {"key": "pos", "name": "Shop POS login", "type": "login", "username": "watanabe_ramen",
     "url": "https://pos.airshop.jp", "password": "Miso-Butter-88", "starred": True},
    {"key": "tabelog", "name": "Tabelog owner account", "type": "login", "username": "kenji.ramen@gmail.com",
     "url": "https://owner.tabelog.com", "password": "Noren2019!"},
    {"key": "gmail", "name": "Gmail", "type": "login", "username": "kenji.ramen@gmail.com",
     "url": "https://mail.google.com", "password": "Susukino-7-Kita"},
    {"key": "jcb", "name": "JCB business card", "type": "card", "card_number": "3540 1122 3344 5566", "cvv": "712",
     "starred": True},
    {"key": "safe", "name": "Shop safe combination", "type": "note", "notes": "32-18-5, turn left twice"},
    {"key": "mynumber", "name": "My Number card", "type": "identity", "password": "4410"},
    {"key": "wifi_shop", "name": "Shop wifi", "type": "wifi", "password": "tonkotsu-12-hours"},
    {"key": "wifi_home", "name": "Home wifi", "type": "wifi", "password": "hana-wan-wan-24"},
    {"key": "office_pc", "name": "Back office PC", "type": "password", "password": "Rishiri-Kombu-3"},
    {"key": "pos_key", "name": "POS server key", "type": "ssh_key", "notes": "back office mini PC",
     "password": "ssh-ed25519 AAAAC3-pos-box"},
    {"key": "delivery_api", "name": "Delivery app API key", "type": "api_credential", "notes": "menu sync",
     "code": "dlv-live-8812-ramen"},
    {"key": "passport", "name": "Passport", "type": "passport", "notes": "expires March 2029"},
    {"key": "bank", "name": "Hokkaido Bank business account", "type": "bank_account", "notes": "rent and supplier payments"},
    {"key": "licence", "name": "Driving licence", "type": "driving_licence", "notes": "gold licence, renew 2028"},
    {"key": "freee", "name": "Accounting software licence", "type": "software_licence", "code": "ACCT-KW-2026-9931"},
    {"key": "crypto", "name": "Crypto wallet from Takeshi", "type": "crypto_wallet", "notes": "small ETH gift, seed in the safe"},
    {"key": "ramen_assoc", "name": "Sapporo ramen association", "type": "membership", "notes": "member 0417"},
    {"key": "costco", "name": "Costco membership", "type": "membership", "notes": "business card, renews October",
     "starred": True},
    {"key": "reg_copy", "name": "Shop registration copy", "type": "document", "notes": "certified copy, Chuo ward office"},
    {"key": "old_tabelog", "name": "Old Tabelog login", "type": "login", "username": "kenji_w", "password": "shoyu2015",
     "trashed": "2026-08-01T09:00"},
]

LINKS = [
    {"from": "kombu_aug", "to": "ogawa"},
    {"from": "boiler", "to": "kenta_s"},
    {"from": "shifts", "to": "daisuke"},
    {"from": "corn", "to": "endo"},
    {"from": "winter_miso", "to": "ito"},
    {"from": "nursery_cert", "to": "yamada"},
    {"from": "tax", "to": "kimura"},
    {"from": "receipts", "to": "kimura"},
    {"from": "lease_t", "to": "okada"},
    {"from": "call_mom", "to": "fumiko"},
    {"from": "gift_yuki", "to": "yuki"},
    {"from": "souvenirs", "to": "nishiyama"},
    {"from": "blog", "to": "shun"},
    {"from": "menu_photos", "to": "shun"},
    {"from": "fest_gas", "to": "haruto"},
    {"from": "noodle_specs", "to": "nishiyama"},
    {"from": "fujita_prices", "to": "fujita"},
    {"from": "corn_sched", "to": "endo"},
    {"from": "kombu_order", "to": "ogawa"},
    {"from": "hana_words", "to": "hana"},
    {"from": "hana_allergy", "to": "hana"},
    {"from": "nursery_q", "to": "hana"},
    {"from": "nursery_q", "to": "yuki"},
    {"from": "acct_tax", "to": "kimura"},
    {"from": "osaka_note", "to": "takeshi"},
    {"from": "osaka_note", "to": "emi"},
    {"from": "lease_note", "to": "okada"},
    {"from": "staff_note", "to": "aiko"},
    {"from": "staff_note", "to": "ryo_t"},
    {"from": "gift_note", "to": "yuki"},
    {"from": "idea_tsuke", "to": "nishiyama"},
]


def world():
    return {
        "me": "Kenji Watanabe",
        "epoch": "2024-08-01T09:00",
        "seed": "T12",
        "currency": "JPY",
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
    keys = [r["key"] for sec in w.values() if isinstance(sec, list) for r in sec if isinstance(r, dict) and "key" in r]
    dup = {k for k in keys if keys.count(k) > 1}
    assert not dup, dup


if __name__ == "__main__":
    w = world()
    check_overlaps(w["events"])
    check_keys(w)
    out = HERE / "T12.json"
    out.write_text(json.dumps(w, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: " + ", ".join(f"{k} {len(v)}" for k, v in w.items() if isinstance(v, list)))
