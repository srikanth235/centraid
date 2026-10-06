"""World E: Ji-an Yoo's household vault (Seoul, statistics PhD student, KRW vault).

    python3 eval/worlds/E_build.py      # writes eval/worlds/E.json (deterministic)

Today in the sessions is Friday 2027-04-09 21:20 (home in Bongcheon-dong after the Friday seminar and a late
dinner; the spring concert is six weeks off and the thesis proposal three).

Persona: Ji-an Yoo, 28, a fourth-year PhD student in statistics at Seoul National University who tutors
maths part-time (five high-school and middle-school students and their parents). She shares a villa flat in
Bongcheon-dong, Gwanak-gu with two flatmates, Ha-eun Song and Min-seo Cho, and Bori, a grey shelter cat. She
plays cello in the Hangang Amateur Orchestra (Saturday rehearsals; its kitty is a group). Her parents (Eomma
and Appa) and Halmoni live in Daegu, her younger brother Jun-seo studies in Busan. The vault is in KRW; the one
foreign-currency position is the JPY group "Kyoto Trip 2026" (a vault debt can only be in the vault's own
currency, so the yen live in the group, where she owes Mi-na, and the debt row is the won share).

Built-in ambiguity: two Min-juns (Min-jun Kim, a labmate; Min-jun Park, her cello stand partner), look-alike
spellings (Ha-rin Kang and Ha-rim Kang, twin students; Ji-hye Yoon, second violin, and Jihye Yun, a school
friend), nicknames (Eomma, Appa, Halmoni, Imo, Ajumma, Minnie, Prof Bae, Jin Sunbae, Maestro Oh, Dr Lim),
look-alike events (Orchestra rehearsal / sectional / committee meeting, Vet check-up / vaccination, Advisor
meeting x3, Dinner with Mi-na / Coffee with Mi-na), near-duplicate tasks (five Pay rent, four Buy cat litter,
four Collect tutoring fee, three Email Prof Bae, two Pay orchestra dues), cancelled events and tasks, and
trashed rows of every trashable kind (one inside the 30-day restore window, one past it).
"""
from __future__ import annotations

import datetime as dt
import json
import re
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent

ME = "Ji-an Yoo"
TODAY = "2027-04-09T21:20"
TODAY_DT = dt.datetime.fromisoformat(TODAY)
TODAY_D = TODAY_DT.date()
EPOCH = "2026-01-12T09:00"
EPOCH_DT = dt.datetime.fromisoformat(EPOCH)
DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
assert DOW[TODAY_D.weekday()] == "Fri"

# ----------------------------------------------------------------------------------------------
# people
# ----------------------------------------------------------------------------------------------

people = [
    # Daegu
    {"key": "eomma", "name": "Mi-kyung Kwon", "role": "mum", "nickname": "Eomma", "starred": True, "cadence": 3,
     "last_contacted": "2027-04-08T20:40", "last_contacted_kind": "call", "met": "Daegu"},
    {"key": "appa", "name": "Dong-hyun Yoo", "role": "dad", "nickname": "Appa", "starred": True, "cadence": 7,
     "last_contacted": "2027-04-04T19:10", "met": "Daegu"},
    {"key": "halmoni", "name": "Sun-ja Choi", "role": "grandmother", "nickname": "Halmoni", "cadence": 14,
     "last_contacted": "2027-03-28T18:00", "met": "Daegu"},
    {"key": "jun_seo", "name": "Jun-seo Yoo", "role": "younger brother", "cadence": 10,
     "last_contacted": "2027-04-05T23:10", "last_contacted_kind": "message", "met": "Busan"},
    {"key": "imo", "name": "Eun-kyung Kwon", "role": "aunt", "nickname": "Imo", "met": "Daegu"},
    # the flat and Bori
    {"key": "ha_eun", "name": "Ha-eun Song", "role": "flatmate", "starred": True, "cadence": 1,
     "last_contacted": "2027-04-09T08:05", "last_contacted_kind": "visit"},
    {"key": "min_seo", "name": "Min-seo Cho", "role": "flatmate", "nickname": "Minnie", "cadence": 1,
     "last_contacted": "2027-04-08T22:30", "last_contacted_kind": "visit"},
    {"key": "landlady", "name": "Soon-ok Ahn", "role": "landlady", "nickname": "Ajumma", "met": "Bongcheon-dong"},
    {"key": "vet", "name": "Tae-woo Lim", "role": "vet", "nickname": "Dr Lim", "met": "Bongcheon-dong"},
    # the lab
    {"key": "advisor", "name": "Sung-ho Bae", "role": "PhD advisor", "nickname": "Prof Bae", "starred": True,
     "cadence": 14, "last_contacted": "2027-03-31T15:30", "met": "Stats Lab"},
    {"key": "jin_sunbae", "name": "Jin-woo Seo", "role": "senior labmate", "nickname": "Jin Sunbae",
     "cadence": 7, "last_contacted": "2027-04-09T18:40", "last_contacted_kind": "coffee", "met": "Stats Lab"},
    {"key": "minjun_k", "name": "Min-jun Kim", "role": "labmate", "cadence": 14,
     "last_contacted": "2027-04-06T12:30", "last_contacted_kind": "message", "met": "Stats Lab"},
    {"key": "su_bin", "name": "Su-bin Ryu", "role": "labmate", "met": "Stats Lab"},
    {"key": "dept_office", "name": "Eun-hee Hwang", "role": "department office", "met": "Stats Department"},
    # the orchestra
    {"key": "maestro", "name": "Chang-hoon Oh", "role": "conductor", "nickname": "Maestro Oh", "starred": True,
     "met": "Hangang Orchestra"},
    {"key": "concertmaster", "name": "Seul-gi Hong", "role": "concertmaster", "met": "Hangang Orchestra"},
    {"key": "minjun_p", "name": "Min-jun Park", "role": "cello stand partner", "cadence": 14,
     "last_contacted": "2027-04-03T17:30", "last_contacted_kind": "coffee", "met": "Hangang Orchestra"},
    {"key": "treasurer", "name": "Bo-ra Jeon", "role": "orchestra treasurer", "met": "Hangang Orchestra"},
    {"key": "librarian", "name": "Dae-sung Yang", "role": "orchestra librarian", "met": "Hangang Orchestra"},
    {"key": "jihye_y", "name": "Ji-hye Yoon", "role": "second violin", "met": "Hangang Orchestra"},
    # the students and their parents
    {"key": "yunho", "name": "Yun-ho Seo", "role": "student, 11th grade calculus", "cadence": 7,
     "last_contacted": "2027-04-06T21:05", "last_contacted_kind": "visit", "met": "tutoring"},
    {"key": "mrs_jang", "name": "Kyung-ae Jang", "role": "Yun-ho's mother", "met": "tutoring",
     "last_contacted": "2027-04-01T10:00", "last_contacted_kind": "message"},
    {"key": "harin", "name": "Ha-rin Kang", "role": "student, 9th grade (twin)", "met": "tutoring"},
    {"key": "harim", "name": "Ha-rim Kang", "role": "student, 9th grade (twin)", "met": "tutoring"},
    {"key": "mr_kang", "name": "Tae-sik Kang", "role": "the twins' father", "met": "tutoring"},
    {"key": "doyun", "name": "Do-yun Moon", "role": "student, 8th grade online", "met": "tutoring"},
    {"key": "seungwoo", "name": "Seung-woo Baek", "role": "student, SAT maths", "met": "tutoring"},
    # friends and services
    {"key": "mina", "name": "Mi-na Jeon", "role": "best friend", "nickname": "Mina", "starred": True, "cadence": 7,
     "last_contacted": "2027-04-07T22:15", "last_contacted_kind": "message", "met": "university"},
    {"key": "hoseok", "name": "Ho-seok Jang", "role": "friend", "met": "university", "cadence": 30,
     "last_contacted": "2027-03-14T19:00"},
    {"key": "jihye_yun", "name": "Jihye Yun", "role": "high-school friend", "met": "Daegu", "cadence": 45,
     "last_contacted": "2027-02-27T21:00", "last_contacted_kind": "message"},
    {"key": "dentist", "name": "Kyung-soo Park", "role": "dentist", "nickname": "Dr Park"},
    {"key": "hairdresser", "name": "Soo-jin Lee", "role": "hairdresser"},
    # trashed: one inside the restore window, one past it
    {"key": "old_student", "name": "Joon-young Oh", "role": "former student", "met": "tutoring",
     "trashed": "2027-03-30T11:00"},
    {"key": "old_flatmate", "name": "Hye-won Baek", "role": "old flatmate", "met": "Sillim",
     "trashed": "2026-12-14T10:00"},
]

# ----------------------------------------------------------------------------------------------
# groups and expenses
# ----------------------------------------------------------------------------------------------

groups = [
    {"key": "flat_bills", "name": "Bongcheon Flat Bills", "currency": "KRW", "members": ["ha_eun", "min_seo"],
     "created": "2026-01-12T10:00"},
    {"key": "orch_kitty", "name": "Hangang Orchestra Kitty", "currency": "KRW",
     "members": ["treasurer", "maestro", "concertmaster", "minjun_p", "librarian", "jihye_y"],
     "created": "2026-02-07T15:00"},
    {"key": "kyoto", "name": "Kyoto Trip 2026", "currency": "JPY", "members": ["mina", "hoseok"],
     "created": "2026-02-20T21:00"},
    {"key": "lab_fund", "name": "Stats Lab Dinner Fund", "currency": "KRW",
     "members": ["jin_sunbae", "minjun_k", "su_bin"], "created": "2026-03-04T18:00"},
    {"key": "daegu_fund", "name": "Daegu Family Fund", "currency": "KRW", "members": ["jun_seo", "imo"],
     "created": "2026-09-20T20:00"},
    {"key": "jeju", "name": "Jeju Weekend 2027", "currency": "KRW", "members": ["mina", "hoseok", "ha_eun"],
     "created": "2027-03-22T22:00"},  # still being planned: no expenses yet
]

expenses = [
    {"group": "flat_bills", "name": "Wifi March", "amount": 33000, "paid_by": "ha_eun",
     "split": ["me", "ha_eun", "min_seo"], "date": "2027-03-05"},
    {"group": "flat_bills", "name": "Gas bill March", "amount": 41000, "paid_by": "me",
     "split": ["me", "ha_eun", "min_seo"], "date": "2027-03-20"},
    {"group": "flat_bills", "name": "Electricity March", "amount": 58000, "paid_by": "min_seo",
     "split": ["me", "ha_eun", "min_seo"], "date": "2027-03-22"},
    {"group": "flat_bills", "name": "Detergent and toilet paper", "amount": 24800, "paid_by": "ha_eun",
     "split": ["me", "ha_eun", "min_seo"], "date": "2027-04-01"},
    {"group": "orch_kitty", "name": "Rehearsal room rent March", "amount": 240000, "paid_by": "treasurer",
     "split": ["me", "treasurer", "concertmaster", "minjun_p", "librarian", "jihye_y"], "date": "2027-03-02"},
    {"group": "orch_kitty", "name": "Sheet music copies", "amount": 38000, "paid_by": "librarian",
     "split": ["me", "librarian", "minjun_p", "jihye_y"], "date": "2027-03-13"},
    {"group": "orch_kitty", "name": "Concert hall deposit", "amount": 600000, "paid_by": "treasurer",
     "split": ["me", "treasurer", "maestro", "concertmaster", "minjun_p", "librarian", "jihye_y"],
     "date": "2027-03-26"},
    {"group": "orch_kitty", "name": "Chicken and beer after rehearsal", "amount": 96000, "paid_by": "me",
     "split": ["me", "concertmaster", "minjun_p", "librarian", "jihye_y", "treasurer"], "date": "2027-04-03"},
    {"group": "kyoto", "name": "Ryokan in Gion, two nights", "amount": 54000, "paid_by": "mina",
     "split": ["me", "mina", "hoseok"], "date": "2026-03-28"},
    {"group": "kyoto", "name": "Haruka express tickets", "amount": 8400, "paid_by": "hoseok",
     "split": ["me", "mina", "hoseok"], "date": "2026-03-27"},
    {"group": "kyoto", "name": "Kaiseki dinner", "amount": 24000, "paid_by": "me",
     "split": ["me", "mina", "hoseok"], "date": "2026-03-29"},
    {"group": "kyoto", "name": "Nishiki market snacks", "amount": 6300, "paid_by": "me",
     "split": ["me", "mina"], "date": "2026-03-29"},
    {"group": "lab_fund", "name": "Lab dinner at the samgyeopsal place", "amount": 148000, "paid_by": "jin_sunbae",
     "split": ["me", "jin_sunbae", "minjun_k", "su_bin"], "date": "2027-03-19"},
    {"group": "lab_fund", "name": "Coffee beans for the lab", "amount": 32000, "paid_by": "me",
     "split": ["me", "jin_sunbae", "minjun_k", "su_bin"], "date": "2027-03-29"},
    {"group": "lab_fund", "name": "Prof Bae's birthday cake", "amount": 45000, "paid_by": "su_bin",
     "split": ["me", "jin_sunbae", "minjun_k", "su_bin"], "date": "2027-04-02"},
    {"group": "daegu_fund", "name": "Halmoni's hospital copay", "amount": 60000, "paid_by": "imo",
     "split": ["me", "jun_seo", "imo"], "date": "2027-03-08"},
    {"group": "daegu_fund", "name": "Chuseok gift set", "amount": 90000, "paid_by": "me",
     "split": ["me", "jun_seo"], "date": "2026-09-18"},
]

lists = [
    {"key": "thesis", "name": "PhD thesis", "area": "research"},
    {"key": "tutoring", "name": "Tutoring", "area": "work"},
    {"key": "flat_l", "name": "Flat and Bori", "area": "home"},
    {"key": "orch_l", "name": "Orchestra", "area": "music"},
    {"key": "family", "name": "Daegu and family", "area": "family"},
    {"key": "errands", "name": "Errands", "area": "home"},
]

# ----------------------------------------------------------------------------------------------
# events
# ----------------------------------------------------------------------------------------------

events = []
_busy = []


def _when(text):
    """'Thu 2027-04-15' -> a date, asserting the weekday is the one written."""
    dow, day = text.split()
    d = dt.date.fromisoformat(day)
    assert DOW[d.weekday()] == dow, f"{day} is a {DOW[d.weekday()]}, not {dow}"
    return d


def ev(key, name, when, start, end, **kw):
    d = _when(when) if isinstance(when, str) else when
    s = dt.datetime.fromisoformat(f"{d.isoformat()}T{start}")
    e = dt.datetime.fromisoformat(end if "T" in end else f"{d.isoformat()}T{end}")
    for bs, be, bk in _busy:
        assert not (s < be and bs < e), f"{key} overlaps {bk}"
    _busy.append((s, e, key))
    created = max(EPOCH_DT, min(s - dt.timedelta(days=3, hours=2), TODAY_DT - dt.timedelta(days=1)))
    row = {"key": key, "name": name, "start": s.strftime("%Y-%m-%dT%H:%M"), "end": e.strftime("%Y-%m-%dT%H:%M"),
           "created": created.strftime("%Y-%m-%dT%H:%M")}
    row.update(kw)
    events.append(row)


def weekly(first, last, step=7):
    d, stop = dt.date.fromisoformat(first), dt.date.fromisoformat(last)
    while d <= stop:
        yield d
        d += dt.timedelta(days=step)


def series(prefix, name, dates, start, end, skip=(), cancel=(), **kw):
    for d in dates:
        if d.isoformat() in skip:
            continue
        extra = dict(kw)
        if d.isoformat() in cancel:
            extra["cancelled"] = True
        ev(f"{prefix}_{d.strftime('%m%d')}", name, d, start, end, **extra)


# the Saturday rehearsals, the Monday lab meeting, the tutoring rounds, the Sunday call home
series("rehearse", "Orchestra rehearsal", weekly("2027-03-13", "2027-05-15"), "14:00", "17:00",
       skip={"2027-04-24"}, cancel={"2027-03-20"}, attendees=["maestro", "minjun_p"],
       description="Hangang community hall, room B")
series("labmtg", "Lab meeting", weekly("2027-03-29", "2027-04-26"), "10:00", "11:30",
       attendees=["advisor", "jin_sunbae", "minjun_k", "su_bin"])
series("yunho", "Tutoring - Yun-ho", weekly("2027-03-30", "2027-04-27"), "19:00", "21:00",
       cancel={"2027-04-06"}, attendees=["yunho"])
series("harin", "Tutoring - Ha-rin", weekly("2027-04-08", "2027-05-06", 14), "18:00", "19:30", attendees=["harin"])
series("harim", "Tutoring - Ha-rim", weekly("2027-04-08", "2027-05-06", 14), "19:30", "21:00", attendees=["harim"])
series("doyun", "Tutoring - Do-yun (online)", weekly("2027-04-02", "2027-04-23"), "17:00", "18:00",
       attendees=["doyun"])
series("callhome", "Call Eomma", weekly("2027-03-28", "2027-05-02"), "20:00", "20:30", skip={"2027-04-25"},
       attendees=["eomma"])
series("seungwoo", "Tutoring - Seung-woo", [dt.date(2027, 3, 14), dt.date(2027, 3, 28), dt.date(2027, 4, 11)],
       "15:00", "17:00", attendees=["seungwoo"])
series("sectional", "Orchestra sectional - cellos", [dt.date(2027, 3, 24), dt.date(2027, 4, 7), dt.date(2027, 4, 28)],
       "19:30", "21:00", attendees=["minjun_p"])

ev("advisor_mar", "Advisor meeting", "Wed 2027-03-03", "14:00", "15:00", attendees=["advisor"])
ev("advisor_mar31", "Advisor meeting", "Wed 2027-03-31", "14:00", "15:00", attendees=["advisor"], cancelled=True,
   description="Prof Bae is at a conference in Jeju")
ev("advisor_apr", "Advisor meeting", "Wed 2027-04-14", "14:00", "15:00", attendees=["advisor"])
ev("proposal", "Thesis proposal defense", "Fri 2027-04-30", "10:00", "12:00",
   attendees=["advisor", "jin_sunbae"], description="seminar room 302, committee of four")
ev("dentist_apr", "Dentist - Dr Park", "Thu 2027-04-15", "15:30", "16:15", attendees=["dentist"])
ev("dentist_feb", "Dentist - Dr Park", "Fri 2027-02-26", "16:00", "16:45", attendees=["dentist"])
ev("vet_check", "Vet - Bori check-up", "Sat 2027-03-13", "11:00", "11:30", attendees=["vet"])
ev("vet_vacc", "Vet - Bori vaccination", "Sat 2027-04-17", "11:00", "11:30", attendees=["vet"])
ev("dinner_mina_mar", "Dinner with Mi-na", "Fri 2027-03-19", "19:00", "21:00", attendees=["mina"])
ev("dinner_mina_apr", "Dinner with Mi-na", "Fri 2027-04-16", "19:00", "21:00", attendees=["mina"])
ev("coffee_mina", "Coffee with Mi-na", "Sat 2027-04-03", "10:00", "11:00", attendees=["mina"])
ev("hair", "Hair appointment", "Sun 2027-04-11", "11:00", "12:30", attendees=["hairdresser"])
ev("brunch_junseo", "Brunch with Jun-seo", "Sun 2027-04-18", "11:00", "13:00", attendees=["jun_seo"],
   description="he is in Seoul for a job fair")
ev("committee", "Orchestra committee meeting", "Sun 2027-04-18", "18:30", "19:30",
   attendees=["treasurer", "maestro", "librarian"], description="agree the concert programme order")
ev("lease_talk", "Lease renewal talk with Ajumma", "Tue 2027-04-20", "18:00", "18:40", attendees=["landlady"])
ev("flat_dinner", "Flat dinner - Ha-eun's birthday", "Sat 2027-03-27", "19:00", "22:00",
   attendees=["ha_eun", "min_seo"])
ev("ktx_down", "KTX to Daegu", "Fri 2027-04-23", "18:30", "20:40", description="car 5, seat 11A")
ev("halmoni80", "Halmoni's 80th birthday lunch", "Sat 2027-04-24", "12:00", "14:30",
   attendees=["halmoni", "eomma", "appa", "imo", "jun_seo"], description="at the restaurant near Dongseongno")
ev("ktx_up", "KTX back to Seoul", "Sun 2027-04-25", "17:00", "19:10")
ev("dress", "Dress rehearsal", "Fri 2027-05-21", "19:00", "21:30", attendees=["maestro"])
ev("concert", "Spring concert - Hangang Orchestra", "Sat 2027-05-22", "15:00", "17:30",
   attendees=["maestro", "concertmaster", "minjun_p", "eomma", "appa"], description="black dress, arrive at 13:00")
ev("kss", "KSS spring conference", "Thu 2027-05-27", "09:00", "2027-05-28T17:00", attendees=["advisor"],
   description="poster session on the Friday")
ev("ice_cream", "Hangang picnic with Mi-na", "Sun 2027-05-02", "13:00", "16:00", attendees=["mina", "hoseok"],
   cancelled=True, description="rain forecast, moved to a cafe")
ev("kyoto_trip", "Kyoto trip", "Fri 2026-03-27", "07:30", "2026-03-30T22:00", attendees=["mina", "hoseok"],
   description="Gimpo to Kansai, ryokan in Gion")
ev("chuseok", "Chuseok in Daegu", "Thu 2026-09-24", "09:00", "2026-09-27T18:00",
   attendees=["eomma", "appa", "halmoni", "jun_seo"])
ev("autumn_concert", "Autumn concert - Hangang Orchestra", "Sat 2026-11-14", "15:00", "17:30",
   attendees=["maestro", "concertmaster", "minjun_p"], description="Hangang community hall")
ev("seollal", "Seollal in Daegu", "Fri 2027-02-05", "10:00", "2027-02-07T17:00",
   attendees=["eomma", "appa", "halmoni", "imo"])
ev("old_dinner", "Dinner with Mi-na", "Fri 2027-03-26", "19:00", "21:00", attendees=["mina"],
   trashed="2027-03-30T09:00")
ev("old_rehearse", "Orchestra rehearsal", "Sat 2027-02-20", "14:00", "17:00", attendees=["maestro"],
   trashed="2027-02-25T10:00")

# ----------------------------------------------------------------------------------------------
# tasks
# ----------------------------------------------------------------------------------------------

tasks = []


def task(key, name, due=None, lst=None, **kw):
    row = {"key": key, "name": name}
    if due:
        row["due"] = due
    if lst:
        row["list"] = lst
    row.update(kw)
    tasks.append(row)
    return row


def done(stamp):
    return {"completed": stamp}


# chapter 3 and the proposal: projects with subtasks
task("ch3", "Thesis chapter 3", "2027-05-31", "thesis", priority=2, status="in_progress")
task("ch3_var", "Derive the variance estimator", "2027-02-26", "thesis", parent="ch3", **done("2027-02-25T22:10"))
task("ch3_code", "Code the bootstrap in R", "2027-03-12", "thesis", parent="ch3", effort=180,
     **done("2027-03-11T23:30"))
task("ch3_sim", "Rerun the simulations with 2000 replicates", "2027-04-16", "thesis", parent="ch3", effort=120)
task("ch3_plot", "Fix the coverage plot", "2027-04-12", "thesis", parent="ch3", effort=45)
task("ch3_disc", "Write the discussion section", "2027-04-23", "thesis", parent="ch3", effort=240, priority=2)
task("ch3_send", "Send the draft to Prof Bae", "2027-04-26", "thesis", parent="ch3")
task("ch3_rev", "Revise after the comments", "2027-05-14", "thesis", parent="ch3", effort=180)
task("ch3_refs", "Proofread the references", "2027-05-28", "thesis", parent="ch3", effort=60)

task("prop", "Thesis proposal defense", "2027-04-30", "thesis", priority=1, status="in_progress")
task("prop_room", "Book the seminar room", "2027-03-26", "thesis", parent="prop", **done("2027-03-25T16:00"))
task("prop_mail", "Email the committee the final draft", "2027-04-16", "thesis", parent="prop", priority=1)
task("prop_print", "Print the proposal for the committee", "2027-04-26", "thesis", parent="prop", effort=20)
task("prop_slides", "Make the slides", "2027-04-23", "thesis", parent="prop", effort=240)
task("prop_rehearse", "Rehearse the talk with Jin Sunbae", "2027-04-27", "thesis", parent="prop", effort=90)

task("concert_t", "Spring concert prep", "2027-05-22", "orch_l", status="in_progress")
task("concert_parts", "Print the cello parts", "2027-03-10", "orch_l", parent="concert_t", **done("2027-03-09T21:00"))
task("concert_learn", "Learn the Dvorak slow movement", "2027-04-30", "orch_l", parent="concert_t", effort=600)
task("concert_fee", "Pay the concert fee", "2027-04-20", "orch_l", parent="concert_t", priority=1)
task("concert_shoes", "Buy black concert shoes", "2027-05-10", "orch_l", parent="concert_t")
task("concert_invite", "Invite Eomma and Appa to the concert", "2027-05-01", "orch_l", parent="concert_t")

task("halmoni_t", "Halmoni's 80th birthday", "2027-04-24", "family", priority=2)
task("halmoni_ktx", "Book the KTX to Daegu", "2027-04-12", "family", parent="halmoni_t", priority=1)
task("halmoni_gift", "Buy a present for Halmoni", "2027-04-20", "family", parent="halmoni_t", effort=60)
task("halmoni_cake", "Order the birthday cake with Imo", "2027-04-19", "family", parent="halmoni_t")

# rent, fees and the cat: near-duplicates by design
for key, due, extra in [("rent_jan", "2027-01-05", done("2027-01-04T21:00")), ("rent_feb", "2027-02-05", done("2027-02-05T09:30")),
                        ("rent_mar", "2027-03-05", done("2027-03-04T22:15")), ("rent_apr", "2027-04-05", done("2027-04-05T08:50")),
                        ("rent_may", "2027-05-05", {"priority": 1})]:
    task(key, "Pay rent", due, "flat_l", **extra)
for key, due, extra in [("fee_yun_jan", "2027-01-25", done("2027-01-26T20:00")), ("fee_yun_feb", "2027-02-25", done("2027-02-25T21:10")),
                        ("fee_yun_mar", "2027-03-25", done("2027-03-30T20:30")), ("fee_yun_apr", "2027-04-25", {})]:
    task(key, "Collect tutoring fee - Mrs Jang", due, "tutoring", **extra)
task("fee_kang_mar", "Collect tutoring fee - Mr Kang", "2027-03-25", "tutoring", **done("2027-03-26T20:00"))
task("fee_kang_apr", "Collect tutoring fee - Mr Kang", "2027-04-25", "tutoring")
for key, due, extra in [("litter_jan", "2027-01-18", done("2027-01-18T19:00")), ("litter_feb", "2027-02-20", done("2027-02-21T11:00")),
                        ("litter_mar", "2027-03-22", done("2027-03-22T18:30")), ("litter_apr", "2027-04-12", {"effort": 15})]:
    task(key, "Buy cat litter", due, "flat_l", **extra)
task("food_mar", "Order Bori's food", "2027-03-15", "flat_l", **done("2027-03-14T23:00"))
task("food_apr", "Order Bori's food", "2027-04-14", "flat_l")
task("dues_jan", "Pay orchestra dues", "2027-01-15", "orch_l", **done("2027-01-15T12:00"))
task("dues_apr", "Pay orchestra dues", "2027-04-05", "orch_l", priority=1)  # overdue
task("mail_bae_jan", "Email Prof Bae", "2027-02-02", "thesis", **done("2027-02-02T11:00"))
task("mail_bae_mar", "Email Prof Bae", "2027-03-28", "thesis", **done("2027-03-28T10:15"))
task("mail_bae_apr", "Email Prof Bae", "2027-04-12", "thesis", effort=15)

# tutoring prep and marking
task("prep_yun_a", "Prepare lesson - Yun-ho", "2027-03-22", "tutoring", **done("2027-03-22T15:00"))
task("prep_yun_b", "Prepare lesson - Yun-ho", "2027-04-05", "tutoring", **done("2027-04-05T16:20"))
task("prep_yun_c", "Prepare lesson - Yun-ho", "2027-04-12", "tutoring", effort=60)
task("grade_harin", "Grade Ha-rin's quiz", "2027-04-08", "tutoring", effort=20, **done("2027-04-08T17:30"))
task("grade_harim", "Grade Ha-rim's quiz", "2027-04-08", "tutoring", effort=20)
task("sat_sheet", "Make Seung-woo a SAT practice sheet", "2027-04-10", "tutoring", effort=45)

# everything else
task("libbooks", "Return library books", "2027-04-02", "errands", effort=20)  # overdue
task("kss_abs", "Submit the KSS abstract", "2027-02-15", "thesis", **done("2027-02-14T23:40"))
task("kss_reg", "Register for the KSS conference", "2027-04-20", "thesis", effort=15)
task("travel_grant", "Apply for the conference travel grant", "2027-04-28", "thesis", effort=60)
task("japanese", "Sign up for Japanese class", "2027-03-10", "errands", status="cancelled")
task("vet_book", "Book Bori's vaccination", "2027-03-30", "flat_l", **done("2027-03-30T12:00"))
task("lease_copy", "Ask Ajumma for a copy of the lease", "2027-04-16", "flat_l")
task("junseo_refund", "Send Jun-seo the KTX refund form", "2027-04-07", "family")  # overdue
task("appa_gift", "Buy a birthday present for Appa", "2027-06-05", "family", effort=60)
task("bowing", "Ask Min-jun about the bowing marks", "2027-04-10", "orch_l", effort=10)
task("book_minjun", "Return Min-jun's stats book", "2027-04-13", "thesis", effort=5)
task("gym_locker", "Renew the old gym locker", "2027-02-01", "errands", trashed="2027-03-31T10:00")
task("scratch_task", "Buy a desk lamp", "2027-01-20", "errands", trashed="2027-02-18T10:00")
for t in tasks:  # a task is made a few days before it is due
    if t.get("due"):
        made = dt.datetime.fromisoformat(t["due"][:10] + "T09:00") - dt.timedelta(days=6, hours=-1 * (len(t["key"]) % 5))
        t["created"] = max(EPOCH_DT, min(made, TODAY_DT - dt.timedelta(days=1))).strftime("%Y-%m-%dT%H:%M")

# ----------------------------------------------------------------------------------------------
# notes
# ----------------------------------------------------------------------------------------------

notebooks = [
    {"key": "thesis_nb", "name": "Thesis Notes"},
    {"key": "tutor_nb", "name": "Tutoring Notes"},
    {"key": "orch_nb", "name": "Orchestra Notes"},
    {"key": "bori_nb", "name": "Bori Care"},
    {"key": "recipes_nb", "name": "Recipes"},
    {"key": "reading_nb", "name": "Reading List"},  # stays empty
]
notes = []


def note(key, name, nb, created, body, **kw):
    row = {"key": key, "name": name, "created": created, "body": body}
    if nb:
        row["notebook"] = nb
    row.update(kw)
    notes.append(row)


note("ch3_outline", "Chapter 3 outline", "thesis_nb", "2027-03-02T20:00",
     "motivation, the bootstrap estimator, coverage simulations, a real data example on air quality")
note("bae_mar3", "Advisor feedback 3 Mar", "thesis_nb", "2027-03-03T15:20",
     "tighten the assumptions, show coverage for small n, drop the second example, start the proposal slides early")
note("sim_settings", "Simulation settings", "thesis_nb", "2027-03-09T23:10",
     "n 200 and 1000, rho 0.3 and 0.7, 2000 replicates, seed 20270301, cluster node 3")
note("prop_checklist", "Proposal defence checklist", "thesis_nb", "2027-03-26T17:00",
     "room booked, slides to Prof Bae a week before, print four copies, water for the committee, backup laptop", pinned=True)
note("boot_reading", "Bootstrap papers to read", "thesis_nb", "2027-02-18T11:30",
     "Efron 1979, the block bootstrap review, two recent preprints on coverage")
note("yunho_prog", "Yun-ho progress", "tutor_nb", "2027-04-06T21:20",
     "limits are fine, still slips on the chain rule, midterm on the 22nd, needs timed practice")
note("twins_weak", "Ha-rin and Ha-rim weak spots", "tutor_nb", "2027-03-25T21:15",
     "Ha-rin rushes algebra, Ha-rim skips the working, both fine on geometry, quiz every second week")
note("doyun_setup", "Do-yun online setup", "tutor_nb", "2027-03-18T14:20",
     "shared whiteboard link, he joins from his phone, mum sits in the first ten minutes")
note("seungwoo_plan", "Seung-woo SAT plan", "tutor_nb", "2027-03-14T17:10",
     "two practice sections a week, review wrong answers on Sunday, test date in June")
note("fees", "Tutoring fees and schedule", "tutor_nb", "2027-01-04T10:00",
     "Yun-ho 400000 a month, the twins 600000, Do-yun 200000, Seung-woo 150000 a lesson", pinned=True)
note("dvorak", "Dvorak slow movement fingerings", "orch_nb", "2027-03-10T22:00",
     "shift early in bar 12, open string at the entry, ask Maestro Oh about the ritardando")
note("programme", "Spring concert programme", "orch_nb", "2027-03-27T21:00",
     "overture first, the Dvorak symphony after the break, encore to be decided, call time 13:00", pinned=True)
note("brahms_bow", "Bowing marks for the Brahms", "orch_nb", "2027-02-27T21:30",
     "up bow at the pickup, long bows in the theme, copy Min-jun's marks for the second page")
note("room_rules", "Rehearsal room rules", "orch_nb", "2026-02-14T16:00",
     "no food in the room, chairs back at five to five, the key goes back to the office")
note("bori_food", "Bori food and allergies", "bori_nb", "2026-01-20T22:00",
     "salmon kibble only, no chicken treats, wet food on Sundays, water fountain needs a new filter monthly", pinned=True)
note("bori_vacc", "Bori vaccination schedule", "bori_nb", "2026-04-10T10:00",
     "boosters every year in April, rabies every three years, flea drops monthly")
note("bori_vet", "Vet visit 13 Mar", "bori_nb", "2027-03-13T12:00",
     "weight 4.1 kilos, teeth fine, Dr Lim says book the booster for April")
note("jjigae", "Kimchi jjigae", "recipes_nb", "2026-02-02T19:30",
     "old kimchi, pork belly, onion, a spoon of gochugaru, simmer thirty minutes, tofu last")
note("doenjang", "Doenjang jjigae", "recipes_nb", "2026-03-15T19:00",
     "anchovy stock, zucchini, potato, tofu, a green chilli, doenjang and a little gochujang")
note("japchae", "Eomma's japchae", "recipes_nb", "2026-09-27T14:00",
     "sweet potato noodles, spinach, carrot, mushrooms, soy and sugar, sesame oil last")
note("tteok", "Tteokbokki for the flat", "recipes_nb", "2026-11-20T20:30",
     "rice cakes soaked in warm water, fish cakes, gochujang sauce, boiled eggs, scallions")
note("diary_bad", "Diary entry - bad week", None, "2027-03-12T23:30",
     "simulations crashed twice, Prof Bae unhappy with the plot, skipped the gym, Bori slept on my keyboard")
note("diary_good", "Diary entry - good rehearsal", None, "2027-03-27T22:30",
     "the slow movement finally clicked, Maestro Oh smiled, chicken with the cellos")
note("kyoto_pack", "Kyoto packing list", None, "2026-03-20T22:00",
     "passport, yen from the airport, rain jacket, a small umbrella, comfortable shoes, the camera")
note("halmoni_ideas", "Gift ideas for Halmoni", None, "2027-04-02T21:40",
     "a warm cardigan, a photo book of Bori, ginseng candies, a new radio")
note("lease_notes", "Lease notes from Ajumma", None, "2027-02-14T18:30",
     "deposit stays as is, rent up 20000 from June, no more cats allowed, boiler checked in October")
note("old_scratch", "Scratch note", None, "2027-03-20T10:00", "call the dentist, buy tape", trashed="2027-04-01T09:00")
note("old_shopping", "Old shopping list", None, "2026-11-01T10:00", "eggs, tofu, kimchi", trashed="2026-12-15T10:00")

# ----------------------------------------------------------------------------------------------
# folders and documents
# ----------------------------------------------------------------------------------------------

folders = [
    {"key": "thesis_f", "name": "Thesis"}, {"key": "housing_f", "name": "Housing"},
    {"key": "tutoring_f", "name": "Tutoring"}, {"key": "orch_f", "name": "Orchestra"},
    {"key": "medical_f", "name": "Medical and Bori"}, {"key": "papers_f", "name": "Papers"},
    {"key": "sort_f", "name": "To Sort"},  # stays empty
]
documents = [
    {"key": "proposal_v3", "name": "Thesis proposal draft v3", "folder": "thesis_f", "created": "2027-03-30T23:00"},
    {"key": "kss_abstract", "name": "KSS 2027 abstract", "folder": "thesis_f", "created": "2027-02-14T23:30"},
    {"key": "ch3_results", "name": "Chapter 3 simulation results 2027-03", "folder": "thesis_f",
     "created": "2027-03-28T21:00"},
    {"key": "scholarship", "name": "Scholarship letter 2026", "folder": "thesis_f", "created": "2026-03-04T10:00",
     "starred": True},
    {"key": "lease_2026", "name": "Lease contract 2026", "folder": "housing_f", "created": "2026-06-12T11:00",
     "starred": True},
    {"key": "cat_addendum", "name": "Lease addendum for the cat 2026", "folder": "housing_f",
     "created": "2026-09-02T10:00"},
    {"key": "contract_yun", "name": "Tutoring contract - Yun-ho 2027", "folder": "tutoring_f",
     "created": "2027-01-04T10:30"},
    {"key": "contract_kang", "name": "Tutoring contract - Kang twins 2027", "folder": "tutoring_f",
     "created": "2027-01-11T10:30"},
    {"key": "receipts_q1", "name": "Tutoring fee receipts 2027 Q1", "folder": "tutoring_f", "created": "2027-03-31T20:00"},
    {"key": "orch_form", "name": "Orchestra membership form 2027", "folder": "orch_f", "created": "2027-01-09T15:00"},
    {"key": "programme_draft", "name": "Spring concert programme draft 2027", "folder": "orch_f",
     "created": "2027-03-29T20:00"},
    {"key": "bylaws", "name": "Hangang Orchestra bylaws 2025", "folder": "orch_f", "created": "2025-09-06T15:00"},
    {"key": "bori_vacc_doc", "name": "Bori vaccination record 2026", "folder": "medical_f", "created": "2026-04-10T11:00"},
    {"key": "bori_adopt", "name": "Bori adoption papers 2025", "folder": "medical_f", "created": "2025-11-02T14:00",
     "starred": True},
    {"key": "tax_2026", "name": "Year-end tax settlement 2026", "folder": "papers_f", "created": "2027-02-10T21:00"},
    {"key": "passport_scan", "name": "Passport scan", "folder": "papers_f", "created": "2026-01-13T10:00"},
    {"key": "licence_scan", "name": "Driver's licence scan", "folder": "papers_f", "created": "2026-01-13T10:05"},
    {"key": "tuition_spring", "name": "Tuition receipt Spring 2027", "created": "2027-03-05T14:00"},
    {"key": "old_lease_draft", "name": "Old lease draft 2025", "folder": "housing_f", "created": "2025-12-20T10:00",
     "trashed": "2026-12-14T10:30"},
    {"key": "dup_scan", "name": "Duplicate scan", "folder": "papers_f", "created": "2027-03-10T10:00",
     "trashed": "2027-04-02T10:00"},
]

# ----------------------------------------------------------------------------------------------
# albums and photos
# ----------------------------------------------------------------------------------------------

albums = [
    {"key": "bori_al", "name": "Bori"}, {"key": "kyoto_al", "name": "Kyoto 2026"},
    {"key": "orch_al", "name": "Hangang Orchestra"}, {"key": "daegu_al", "name": "Daegu"},
    {"key": "lab_al", "name": "Lab Outings"}, {"key": "sort_al", "name": "Unsorted Scans"},  # stays empty
]
photos = [
    {"key": "p_bori_adopt", "name": "Bori on adoption day", "taken": "2025-11-02T15:30", "albums": ["bori_al"],
     "starred": True},
    {"key": "p_bori_box", "name": "Bori in a cardboard box", "taken": "2025-11-09T20:10", "albums": ["bori_al"]},
    {"key": "p_bori_desk", "name": "Bori on my desk", "taken": "2026-01-20T22:40", "albums": ["bori_al"]},
    {"key": "p_bori_laptop", "name": "Bori and the laptop", "taken": "2026-03-03T01:15", "albums": ["bori_al"]},
    {"key": "p_bori_window", "name": "Bori in the window", "taken": "2027-02-28T16:20", "albums": ["bori_al"],
     "starred": True},
    {"key": "p_bori_cello", "name": "Bori with the cello case", "taken": "2027-03-06T12:45", "albums": ["bori_al"],
     "people": ["ha_eun"]},
    {"key": "p_bori_vet", "name": "Bori at the vet", "taken": "2027-03-13T11:10", "albums": ["bori_al"],
     "people": ["vet"]},
    {"key": "p_bori_sofa", "name": "Bori asleep on the sofa", "taken": "2027-04-04T14:00", "albums": ["bori_al"],
     "people": ["min_seo"]},
    {"key": "p_ky_gates", "name": "Fushimi Inari gates", "taken": "2026-03-27T10:30", "albums": ["kyoto_al"],
     "people": ["mina"], "starred": True},
    {"key": "p_ky_gion", "name": "Gion at dusk", "taken": "2026-03-28T18:40", "albums": ["kyoto_al"]},
    {"key": "p_ky_breakfast", "name": "Ryokan breakfast", "taken": "2026-03-29T08:20", "albums": ["kyoto_al"],
     "people": ["hoseok"]},
    {"key": "p_ky_bamboo", "name": "Arashiyama bamboo grove", "taken": "2026-03-29T11:15", "albums": ["kyoto_al"]},
    {"key": "p_ky_kaiseki", "name": "Kaiseki dinner", "taken": "2026-03-29T19:30", "albums": ["kyoto_al"],
     "people": ["mina", "hoseok"]},
    {"key": "p_ky_kiyomizu", "name": "Mi-na at Kiyomizu", "taken": "2026-03-30T09:50", "albums": ["kyoto_al"],
     "people": ["mina"]},
    {"key": "p_ky_deer", "name": "Ho-seok and the deer in Nara", "taken": "2026-03-30T14:05",
     "albums": ["kyoto_al"], "people": ["hoseok"]},
    {"key": "p_or_stage", "name": "Autumn concert stage", "taken": "2026-11-14T16:30", "albums": ["orch_al"],
     "people": ["maestro"], "starred": True},
    {"key": "p_or_cellos", "name": "The cello section", "taken": "2026-11-14T14:45", "albums": ["orch_al"],
     "people": ["minjun_p"]},
    {"key": "p_or_maestro", "name": "Maestro Oh rehearsing", "taken": "2027-03-13T15:20", "albums": ["orch_al"],
     "people": ["maestro"]},
    {"key": "p_or_cover", "name": "Concert programme cover", "taken": "2027-03-29T20:30", "albums": ["orch_al"]},
    {"key": "p_or_chicken", "name": "Chicken after rehearsal", "taken": "2027-04-03T18:10", "albums": ["orch_al"],
     "people": ["concertmaster", "minjun_p", "librarian", "jihye_y"]},
    {"key": "p_or_partner", "name": "Stand partner Min-jun", "taken": "2027-03-27T16:10", "albums": ["orch_al"],
     "people": ["minjun_p"]},
    {"key": "p_dg_table", "name": "Chuseok table 2026", "taken": "2026-09-25T12:30", "albums": ["daegu_al"],
     "people": ["eomma", "appa", "halmoni"], "starred": True},
    {"key": "p_dg_halmoni", "name": "Halmoni and Eomma in the kitchen", "taken": "2026-09-24T17:00",
     "albums": ["daegu_al"], "people": ["halmoni", "eomma"]},
    {"key": "p_dg_garden", "name": "Appa's tomato garden", "taken": "2026-09-26T09:10", "albums": ["daegu_al"],
     "people": ["appa"]},
    {"key": "p_dg_street", "name": "Dongseongno street at night", "taken": "2026-09-26T20:20", "albums": ["daegu_al"]},
    {"key": "p_dg_apsan", "name": "Jun-seo and me on Apsan", "taken": "2026-09-27T11:00", "albums": ["daegu_al"],
     "people": ["jun_seo"]},
    {"key": "p_lab_dinner", "name": "Lab dinner at the samgyeopsal place", "taken": "2027-03-19T20:15",
     "albums": ["lab_al"], "people": ["jin_sunbae", "minjun_k", "su_bin"]},
    {"key": "p_lab_cake", "name": "Prof Bae's birthday cake", "taken": "2027-04-02T16:00", "albums": ["lab_al"],
     "people": ["advisor", "su_bin"]},
    {"key": "p_lab_poster", "name": "Poster test print", "taken": "2027-03-04T11:30", "albums": ["lab_al"]},
    {"key": "p_blossoms", "name": "Cherry blossoms at Yeouido", "taken": "2027-04-03T12:10", "people": ["mina", "hoseok"]},
    {"key": "p_hangang", "name": "The Han River at night", "taken": "2027-03-21T22:05"},
    {"key": "p_board", "name": "Whiteboard derivation", "taken": "2027-02-25T21:30"},
    {"key": "p_worksheet", "name": "Tutoring worksheet scan", "taken": "2027-04-06T20:50", "people": ["yunho"]},
    {"key": "p_balcony", "name": "View from the flat balcony", "taken": "2026-07-03T06:40"},
    {"key": "p_desk", "name": "My thesis desk", "taken": "2027-01-15T23:00", "starred": True},
    {"key": "p_textbook", "name": "Receipt for the textbook", "taken": "2027-03-31T13:00"},
    {"key": "p_blurry", "name": "Blurry cat photo", "taken": "2027-03-29T07:30", "trashed": "2027-04-03T09:00"},
    {"key": "p_chat", "name": "Screenshot of the chat", "taken": "2026-11-02T12:00", "trashed": "2026-12-02T09:00"},
]

# ----------------------------------------------------------------------------------------------
# debts
# ----------------------------------------------------------------------------------------------

debts = [
    {"key": "d_haeun_groceries", "person": "ha_eun", "direction": "owes_me", "amount": 18500,
     "name": "groceries I paid for", "date": "2027-04-02"},
    {"key": "d_minseo_cleaner", "person": "min_seo", "direction": "i_owe", "amount": 15000,
     "name": "bathroom cleaner and mop", "date": "2027-03-27"},
    {"key": "d_mina_kyoto", "person": "mina", "direction": "i_owe", "amount": 62000,
     "name": "Kyoto ryokan share in won (about 6850 yen)", "date": "2026-03-30"},
    {"key": "d_junseo_case", "person": "jun_seo", "direction": "owes_me", "amount": 40000,
     "name": "phone case I bought him", "date": "2027-03-08"},
    {"key": "d_minjun_k_lunch", "person": "minjun_k", "direction": "owes_me", "amount": 9500,
     "name": "cafeteria lunch", "date": "2027-04-06"},
    {"key": "d_jin_coffee", "person": "jin_sunbae", "direction": "i_owe", "amount": 5000,
     "name": "coffee after the seminar", "date": "2027-04-09"},
    {"key": "d_bora_chicken", "person": "treasurer", "direction": "i_owe", "amount": 12000,
     "name": "chicken night share", "date": "2027-03-13", "settled": "2027-03-20T17:30"},
    {"key": "d_mrsjang_book", "person": "mrs_jang", "direction": "owes_me", "amount": 28000,
     "name": "workbook I ordered for Yun-ho", "date": "2027-03-10"},
    {"key": "d_mina_cinema", "person": "mina", "direction": "owes_me", "amount": 14000,
     "name": "cinema tickets", "date": "2027-03-19", "settled": "2027-04-01T21:00"},
    {"key": "d_hoseok_ramen", "person": "hoseok", "direction": "owes_me", "amount": 11000,
     "name": "ramen after the blossoms", "date": "2027-04-03"},
    {"key": "d_minjun_p_score", "person": "minjun_p", "direction": "i_owe", "amount": 22000,
     "name": "Dvorak score he lent the money for", "date": "2027-02-27", "settled": "2027-03-06T16:45"},
    {"key": "d_imo_cake", "person": "imo", "direction": "owes_me", "amount": 35000,
     "name": "half of Halmoni's cake", "date": "2027-04-05"},
    {"key": "d_landlady_repair", "person": "landlady", "direction": "owes_me", "amount": 80000,
     "name": "boiler repair she will refund", "date": "2027-01-22"},
]

# ----------------------------------------------------------------------------------------------
# locker
# ----------------------------------------------------------------------------------------------

locker = [
    {"key": "naver", "name": "Naver account", "type": "login", "username": "jian.yoo",
     "url": "https://naver.com", "password": "Bori&Cello2026", "code": "JBSWY3DPEHPK3PXP", "starred": True},
    {"key": "mysnu", "name": "mySNU portal", "type": "login", "username": "jianyoo", "url": "https://my.snu.ac.kr",
     "password": "Stats#Phd4th"},
    {"key": "kakaobank", "name": "KakaoBank", "type": "login", "username": "jian.yoo@kakao.com",
     "url": "https://kakaobank.com", "password": "Hangang-Seoul27"},
    {"key": "kb_card", "name": "KB Kookmin debit card", "type": "card", "card_number": "9430123498765432",
     "cvv": "482"},
    {"key": "door_code", "name": "Flat door code", "type": "note", "notes": "2580 then the bell", "starred": True},
    {"key": "resident_card", "name": "Resident registration card", "type": "identity"},
    {"key": "flat_wifi", "name": "Flat wifi", "type": "wifi", "password": "BoriMeow302", "starred": True},
    {"key": "lab_wifi", "name": "Lab wifi", "type": "wifi", "password": "StatsLab-Guest27"},
    {"key": "gov24", "name": "Government24 portal", "type": "password", "password": "Seoul!Gov2027"},
    {"key": "cluster_ssh", "name": "Lab cluster SSH key", "type": "ssh_key",
     "notes": "ed25519, gpu node 3, renew in June"},
    {"key": "kakao_api", "name": "Kakao Maps API key", "type": "api_credential",
     "notes": "for the tutoring scheduler script"},
    {"key": "passport", "name": "Passport", "type": "passport", "notes": "M12345678, expires 2031-08-14"},
    {"key": "kb_acct", "name": "KB Kookmin account", "type": "bank_account",
     "notes": "Sillim branch, account 123401-04-567890", "starred": True},
    {"key": "licence", "name": "Driver's licence", "type": "driving_licence",
     "notes": "class 2 regular, renew in 2030"},
    {"key": "matlab", "name": "MATLAB campus licence", "type": "software_licence",
     "notes": "SNU campus licence, renews every March", "starred": True},
    {"key": "wallet", "name": "Crypto wallet", "type": "crypto_wallet",
     "notes": "a little Ethereum from a hackathon, about 90000 won"},
    {"key": "orch_member", "name": "Hangang Orchestra membership", "type": "membership",
     "notes": "member no. 27, dues paid to June"},
    {"key": "lease_orig", "name": "Lease contract original", "type": "document",
     "notes": "original with Ajumma, scan in the Housing folder"},
    {"key": "old_wifi", "name": "Old Sillim flat wifi", "type": "wifi", "password": "Sillim2025!",
     "trashed": "2027-04-01T10:00"},
    {"key": "old_daum", "name": "Old Daum login", "type": "login", "username": "jian_yoo", "password": "OldDaum77",
     "trashed": "2026-12-20T10:00"},
]

# ----------------------------------------------------------------------------------------------
# links (task -> person, note -> person: the only ones the model sees)
# ----------------------------------------------------------------------------------------------

links = [
    {"from": "fee_yun_jan", "to": "mrs_jang"}, {"from": "fee_yun_feb", "to": "mrs_jang"},
    {"from": "fee_yun_mar", "to": "mrs_jang"}, {"from": "fee_yun_apr", "to": "mrs_jang"},
    {"from": "fee_kang_mar", "to": "mr_kang"}, {"from": "fee_kang_apr", "to": "mr_kang"},
    {"from": "prep_yun_a", "to": "yunho"}, {"from": "prep_yun_b", "to": "yunho"}, {"from": "prep_yun_c", "to": "yunho"},
    {"from": "grade_harin", "to": "harin"}, {"from": "grade_harim", "to": "harim"},
    {"from": "sat_sheet", "to": "seungwoo"}, {"from": "mail_bae_jan", "to": "advisor"}, {"from": "mail_bae_mar", "to": "advisor"},
    {"from": "mail_bae_apr", "to": "advisor"}, {"from": "ch3_send", "to": "advisor"},
    {"from": "prop_rehearse", "to": "jin_sunbae"},
    {"from": "vet_book", "to": "vet"}, {"from": "halmoni_gift", "to": "halmoni"},
    {"from": "halmoni_cake", "to": "imo"}, {"from": "junseo_refund", "to": "jun_seo"},
    {"from": "lease_copy", "to": "landlady"}, {"from": "appa_gift", "to": "appa"},
    {"from": "bowing", "to": "minjun_p"}, {"from": "book_minjun", "to": "minjun_k"},
    {"from": "dues_apr", "to": "treasurer"}, {"from": "dues_jan", "to": "treasurer"},
    {"from": "yunho_prog", "to": "yunho"}, {"from": "twins_weak", "to": "harin"}, {"from": "twins_weak", "to": "harim"},
    {"from": "doyun_setup", "to": "doyun"}, {"from": "seungwoo_plan", "to": "seungwoo"},
    {"from": "bae_mar3", "to": "advisor"}, {"from": "bori_vet", "to": "vet"},
    {"from": "japchae", "to": "eomma"}, {"from": "halmoni_ideas", "to": "halmoni"},
    {"from": "lease_notes", "to": "landlady"}, {"from": "dvorak", "to": "maestro"},
    {"from": "brahms_bow", "to": "minjun_p"},
]

world = {
    "me": ME, "today": TODAY, "epoch": EPOCH, "seed": "E", "currency": "KRW",
    "people": people, "groups": groups, "expenses": expenses, "lists": lists, "events": events,
    "tasks": tasks, "notebooks": notebooks, "notes": notes, "folders": folders, "documents": documents,
    "albums": albums, "photos": photos, "debts": debts, "locker": locker, "links": links,
}

# ----------------------------------------------------------------------------------------------
# checks shared by the three held-out worlds (E, F, G): references, keys, the seeder's own refusals
# ----------------------------------------------------------------------------------------------

LOCKER_TYPES = ["login", "card", "note", "identity", "wifi", "password", "ssh_key", "api_credential", "passport",
                "bank_account", "driving_licence", "software_licence", "crypto_wallet", "membership", "document"]
# the fields a type keeps (the seeder reports, or silently nulls, anything else)
LOCKER_KEEPS = {
    "login": {"username", "url", "notes", "password", "code"}, "card": {"card_number", "cvv"}, "note": {"notes"},
    "identity": set(), "wifi": {"password"}, "password": {"password"},
}
TRASH_KINDS = ("people", "events", "tasks", "notes", "documents", "photos", "locker")


def _stamp(text):
    return dt.datetime.fromisoformat(text if "T" in text else text + "T00:00")


def check_common(w):
    """Keys unique and snake_case, every reference resolves, no two events overlap (cancelled and trashed
    ones are created live, so they count too), every locker type present with only the fields its type
    keeps, nothing created in the future, every trashable kind has a row trashed inside the 30-day
    restore window and one past it, and the seeder's own refusals (an expense outside its group, a
    parent that comes after its child) cannot happen."""
    today = _stamp(w["today"])
    assert w["me"] and w["today"] and w["currency"]
    keys = {}
    for kind, rows in w.items():
        if not isinstance(rows, list):
            continue
        for r in rows:
            if "key" in r:
                k = r["key"]
                assert k not in keys, f"duplicate key {k}"
                assert re.fullmatch(r"[a-z][a-z0-9_]*", k) and len(k) <= 30, f"bad key {k!r}"
                keys[k] = kind
    keys["me"] = "people"

    def need(key, kind):
        assert keys.get(key) == kind, f"{key} is not a {kind}"

    seen_task = set()
    for t in w["tasks"]:
        if "parent" in t:
            need(t["parent"], "tasks")
            assert t["parent"] in seen_task, f"parent {t['parent']} must come before its subtask {t['key']}"
        if "list" in t:
            need(t["list"], "lists")
        seen_task.add(t["key"])
        assert not (t.get("status") == "cancelled" and "completed" in t), t["key"]
    for g in w["groups"]:
        [need(m, "people") for m in g["members"]]
        assert len(set(g["members"])) == len(g["members"]), g["key"]
    for e in w["expenses"]:
        need(e["group"], "groups")
        [need(m, "people") for m in e["split"]]
        need(e["paid_by"], "people")
        members = set(next(g["members"] for g in w["groups"] if g["key"] == e["group"])) | {"me"}
        assert set(e["split"]) | {e["paid_by"]} <= members, f"expense outside its group: {e['name']}"
        assert len(set(e["split"])) == len(e["split"]), e["name"]
        assert _stamp(e["date"]) <= today, e["name"]
    for n in w["notes"]:
        if "notebook" in n:
            need(n["notebook"], "notebooks")
    for d in w["documents"]:
        if "folder" in d:
            need(d["folder"], "folders")
    for p in w["photos"]:
        [need(a, "albums") for a in p.get("albums", [])]
        [need(q, "people") for q in p.get("people", [])]
        assert len(set(p.get("albums", []))) == len(p.get("albums", [])), p["key"]
        assert _stamp(p["taken"]) <= today, p["key"]
    for d in w["debts"]:
        need(d["person"], "people")
        assert d["direction"] in ("owes_me", "i_owe") and d["amount"] > 0, d["key"]
        assert _stamp(d["date"]) <= today, d["key"]
        if "settled" in d:
            assert _stamp(d["date"]) <= _stamp(d["settled"]) <= today, d["key"]
    for e in w["events"]:
        [need(a, "people") for a in e.get("attendees", [])]
        assert e["start"] < e["end"], e["key"]
    for ln in w["links"]:
        assert ln["from"] in keys and ln["to"] in keys, ln
        assert keys[ln["to"]] == "people" and keys[ln["from"]] in ("tasks", "notes"), ln  # the only links the model sees
    assert len({(l["from"], l["to"]) for l in w["links"]}) == len(w["links"]), "duplicate link"
    # the names the vault keeps unique
    for section in ("people", "lists", "folders"):
        names = [r["name"] for r in w[section]]
        assert len(names) == len(set(names)), f"duplicate {section} names"
    names = [g["name"] for g in w["groups"]] + [n["name"] for n in w["notebooks"]] + [a["name"] for a in w["albums"]]
    assert len(names) == len(set(names)), "group/notebook/album names must be unique"
    # no overlapping events
    spans = sorted((e["start"], e["end"], e["key"]) for e in w["events"])
    for (s1, e1, k1), (s2, e2, k2) in zip(spans, spans[1:]):
        assert e1 <= s2, f"events overlap: {k1} and {k2}"
    # the locker
    assert {r["type"] for r in w["locker"]} == set(LOCKER_TYPES), sorted({r["type"] for r in w["locker"]})
    for r in w["locker"]:
        extra = set(r) - {"key", "name", "type", "starred", "trashed", "created"} - LOCKER_KEEPS.get(r["type"], {"notes"})
        assert not extra, f"{r['key']}: a {r['type']} item keeps no {sorted(extra)}"
    # nothing from the future; trash stamps sit between creation and today
    for kind in ("people", "events", "tasks", "notes", "documents", "photos", "locker", "lists", "groups"):
        for r in w[kind]:
            for field in ("created", "completed", "trashed"):
                if field in r and isinstance(r[field], str):
                    assert _stamp(r[field]) <= today, f"{r['key']}.{field} is in the future"
            if isinstance(r.get("trashed"), str) and "created" in r:
                assert _stamp(r["created"]) <= _stamp(r["trashed"]), f"{r['key']} trashed before it was made"
    # trashed rows of every trashable kind, inside the restore window and past it (not borderline)
    for kind in TRASH_KINDS:
        age = [(today - _stamp(r["trashed"])).days for r in w[kind] if isinstance(r.get("trashed"), str)]
        assert any(a <= 26 for a in age), f"no trashed {kind} inside the 30-day window: {age}"
        assert any(a >= 36 for a in age), f"no trashed {kind} past the 30-day window: {age}"
        assert all(a < 28 or a > 34 for a in age), f"a borderline trashed {kind}: {age}"
    # the ambiguity every vault needs
    assert any(e.get("cancelled") for e in w["events"] if e["start"] < w["today"]), "a cancelled past event"
    assert any(e.get("cancelled") for e in w["events"] if e["start"] > w["today"]), "a cancelled future event"
    assert any(t.get("status") == "cancelled" for t in w["tasks"]), "a cancelled task"
    assert any(t.get("status") == "in_progress" for t in w["tasks"]), "an in-progress task"
    assert any(t.get("completed") for t in w["tasks"]), "a completed task"
    assert any(not t.get("completed") and t.get("due", "9") < w["today"][:10] and "status" not in t
               and "trashed" not in t for t in w["tasks"]), "an open overdue task"
    assert sum(1 for p in w["people"] if p.get("nickname")) >= 5, "nicknames"
    assert any(any(e["group"] == g["key"] for e in w["expenses"]) for g in w["groups"]), "a group with expenses"
    assert any(not any(e["group"] == g["key"] for e in w["expenses"]) for g in w["groups"]), "an empty group"
    assert any(not any(d.get("folder") == f["key"] for d in w["documents"]) for f in w["folders"]), "an empty folder"
    assert any(not any(n.get("notebook") == b["key"] for n in w["notes"]) for b in w["notebooks"]), "an empty notebook"
    assert any(not any(a in p.get("albums", []) for p in w["photos"]) for a in [x["key"] for x in w["albums"]]), \
        "an empty album"
    assert any(t.get("parent") for t in w["tasks"]), "subtasks"
    assert any(p.get("starred") for p in w["people"]) and any(d.get("starred") for d in w["documents"])
    assert any(p.get("starred") for p in w["photos"]) and any(n.get("pinned") for n in w["notes"])
    assert any("settled" in d for d in w["debts"]) and any("settled" not in d for d in w["debts"])
    assert any(d["direction"] == "owes_me" for d in w["debts"]) and any(d["direction"] == "i_owe" for d in w["debts"])
    assert len({g.get("currency") for g in w["groups"]} | {w["currency"]}) >= 2, "a foreign-currency group"
    # a person's first name shared with another live person: the planted clusters only (the caller names them)
    firsts = Counter(p["name"].split()[0] for p in w["people"] if "trashed" not in p)
    return {f: c for f, c in firsts.items() if c > 1}


def check(w):
    clusters = check_common(w)
    assert clusters == {"Min-jun": 2}, clusters
    n = {k: len(v) for k, v in w.items() if isinstance(v, list)}
    # the ordinary size of the brief, with recurring history for volume
    assert 25 <= n["people"] <= 35 and 4 <= n["groups"] <= 6, n
    assert 50 <= n["events"] <= 70 and 50 <= n["tasks"] <= 70, n
    assert 20 <= n["notes"] <= 30 and 15 <= n["documents"] <= 20 and 30 <= n["photos"] <= 40, n
    assert 10 <= n["debts"] <= 15 and 15 <= n["locker"] <= 20, n
    # the planted ambiguity, by name
    names = {p["name"] for p in w["people"]}
    assert {"Min-jun Kim", "Min-jun Park", "Ha-rin Kang", "Ha-rim Kang", "Ji-hye Yoon", "Jihye Yun"} <= names
    ev_names = Counter(e["name"] for e in w["events"])
    assert ev_names["Advisor meeting"] == 3 and ev_names["Dinner with Mi-na"] == 3 and ev_names["Coffee with Mi-na"] == 1
    assert {"Orchestra rehearsal", "Orchestra sectional - cellos", "Orchestra committee meeting"} <= set(ev_names)
    assert {"Vet - Bori check-up", "Vet - Bori vaccination"} <= set(ev_names)
    assert {"Tutoring - Ha-rin", "Tutoring - Ha-rim"} <= set(ev_names)
    task_names = Counter(t["name"] for t in w["tasks"])
    assert task_names["Pay rent"] == 5 and task_names["Buy cat litter"] == 4 and task_names["Email Prof Bae"] == 3
    assert task_names["Collect tutoring fee - Mrs Jang"] == 4 and task_names["Pay orchestra dues"] == 2
    # the foreign-currency group (the yen) and the KRW debt row that goes with it
    kyoto = next(g for g in w["groups"] if g["currency"] == "JPY")
    assert any(e["group"] == kyoto["key"] for e in w["expenses"])
    assert any("Kyoto" in d["name"] for d in w["debts"])
    # the vault is a few months of recurring history deep
    assert sum(1 for t in w["tasks"] if t.get("completed")) >= 20


if __name__ == "__main__":
    check(world)
    (HERE / "E.json").write_text(json.dumps(world, indent=1, ensure_ascii=False) + "\n")
    counts = {k: len(v) for k, v in world.items() if isinstance(v, list)}
    print("E:", counts)
