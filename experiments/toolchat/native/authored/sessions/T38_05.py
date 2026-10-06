from gold import *
import json


def J(d):
    return json.dumps(d, separators=(",", ":"))



S("T38-099", "set-answers parent-task-vs-subtasks licence renewal open complete count",
  T("what's left under the 2027 licence renewal", rows("licence27_3", "licence27_4", "licence27_5"),
    ref=[ans(kind="task", linked_to="$licence27", where="status = open")]),
  T("tick off the ministry inspection one, it's booked, then tell me how many are left",
    val(2, also=diff(upd("licence27_3", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Book the ministry inspection", more=True),
         ans(op="count", kind="task", linked_to="$licence27", where="status = open")]))

S("T38-100", "set-answers superlative oldest find-then-act delete newest star oldest-read",
  T("delete the oldest supplies order that's still open", diff(trash("sup_240805")),
    ref=[find(kind="task", name="Order clinic supplies", where="status = open", order="date asc", limit=1),
         act("delete", rows="@prev")]),
  T("star the newest staff payroll summary", diff(upd("doc_098", starred=True)),
    ref=[find(kind="document", name="Staff payroll summary", order="date desc", limit=1),
         act("star", rows="@prev")]),
  T("and which one's the oldest", rows("doc_004"),
    ref=[ans(kind="document", name="Staff payroll summary", order="date asc", limit=1)]))

S("T38-101", "container-link-reads within linked_to clinic-list-vs-clinic-finance name-collision next-week",
  T("what's due next week that i haven't done", rows("sup_270517", "licence27_3", "t_018", "grad27_5", "t_048"),
    ref=[ans(kind="task", where="status = open", when=J(U("week", 1)))]),
  T("which of those are on the clinic list", rows("sup_270517", "licence27_3", "t_048"),
    ref=[ans(within="@prev", linked_to="$clinic_l")]),
  T("and what's open on clinic finance this month", rows("net_270515", "t_117", "sal_270528"),
    ref=[ans(kind="task", linked_to="$finance_l", where="status = open", when=J(U("month", 0)))]))

S("T38-102", "container-link-reads owner groups-i'm-in count then list then within where then within linked_to person",
  T("how many groups do i belong to", val(15),
    ref=[ans(op="count", kind="group", linked_to="$me")]),
  T("which ones", rows("umrah", "aqaba", "dubai", "cairo", "istanbul", "study_group", "football", "dana_parents", "family_fund",
                       "friday_kitty", "clinic_supplies", "clinic_lunch", "teta_care", "building", "friends_dinner"),
    ref=[ans(kind="group", linked_to="$me")]),
  T("which of those aren't in JOD", rows("dubai", "istanbul", "cairo"),
    ref=[ans(within="@prev", where='currency != "JOD"')]),
  T("and which of them has baba in it", rows("dubai"),
    ref=[ans(within="@prev", linked_to="$baba")]))

S("T38-103", "container-link-reads person events through the person link week substitution count",
  T("what's dana got on this week that's still on", rows("dsw_270511", "fl_270514"),
    ref=[ans(kind="event", linked_to="$dana", where="status != cancelled", when=J(U("week", 0)))]),
  T("and next week", rows("dsw_270518", "fl_270521"),
    ref=[ans(kind="event", linked_to="$dana", where="status != cancelled", when=J(U("week", 1)))]),
  T("how many swim classes does she have this month", val(4),
    ref=[ans(op="count", kind="event", name="swim class", linked_to="$dana", when=J(U("month", 0)))]))

S("T38-104", "container-link-reads folder car-vs-car-insurance collision insurance-folder within starred",
  T("what's in the car folder", rows("doc_025", "doc_026", "doc_055", "doc_056", "doc_085", "doc_086"),
    ref=[ans(kind="document", linked_to="$carf")]),
  T("and the insurance folder",
    rows("doc_010", "doc_011", "doc_012", "doc_040", "doc_041", "doc_070", "doc_071", "doc_072", "doc_100"),
    ref=[ans(kind="document", linked_to="$insf")]),
  T("just the starred ones", rows("doc_010", "doc_100"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T38-105", "container-link-reads parent-task-container vs group same-word umrah members complete-subtask",
  T("what's left on the umrah plan", rows("umrah_p_1", "umrah_p_2"),
    ref=[ans(kind="task", linked_to="$umrah_p", where="status = open")]),
  T("who's in the umrah fund", rows("baba", "mama", "teta", "me"),
    ref=[ans(kind="person", linked_to="$umrah")]),
  T("tick off the passports one, then show me what's left on the plan",
    rows("umrah_p_1", also=diff(upd("umrah_p_2", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Check the passports", more=True),
         ans(kind="task", linked_to="$umrah_p", where="status = open")]))

S("T38-106", "stray-conditions electrician role-exact inert-purpose ask two-holders then star-by-name log inert-date-clause",
  T("who's the electrician, need someone to look at the clinic wiring", rows("leen_zureiqat", "qasim_bataineh"),
    ref=[ans(kind="person", where='role = "electrician"')]),
  T("star the electrician so i have a number at hand", ask("leen_zureiqat", "qasim_bataineh"),
    ref=[act("star", kind="person", where='role = "electrician"')]),
  T("qasim, he quoted less", diff(upd("qasim_bataineh", starred=True)),
    ref=[act("star", kind="person", name="Qasim")]),
  T("log a call with qasim, he's coming to look at it on tuesday", diff(upd("qasim_bataineh", date=ANY)),
    ref=[act("log", kind="person", name="Qasim", args="kind: call")]))

S("T38-107", "stray-conditions member-count purpose-clause met-contains within role-contains",
  T("how many are in the building fund, i'm splitting the lift repair between them", val(13),
    ref=[ans(op="count", kind="person", linked_to="$building")]),
  T("who did i meet at the university, for the graduation invites",
    rows("raji_anabtawi", "basma_al_najjar", "sufyan_nimri", "dania_nabulsi", "talal_daoud", "dunia_bishara", "usama_yaghmour",
         "enas_qasem", "waleed_masri", "fadwa_obeidat", "husam"),
    ref=[ans(kind="person", where='met contains "university"')]),
  T("which of them are classmates", rows("raji_anabtawi", "dania_nabulsi", "usama_yaghmour", "fadwa_obeidat"),
    ref=[ans(within="@prev", where='role contains "classmate"')]))

S("T38-108", "stray-conditions description-contains purpose-clause calls-teta staff-meetings month",
  T("which calls with teta this month mention yazan, i want to tell him she's asking", rows("ct_270527"),
    ref=[ans(kind="event", name="Call Teta", where='description contains "Yazan"', when=J(U("month", 0)))]),
  T("and the staff meetings with the rota note this month, for the eid schedule", rows("csm_270502", "csm_270509"),
    ref=[ans(kind="event", name="Clinic staff meeting", where='description contains "rota"', when=J(U("month", 0)))]))

S("T38-109", "stray-conditions by-name write inert purpose star-document-year complete-task role-not-location",
  T("star the 2027 clinic operating licence so i can find it when the ministry comes",
    diff(upd("doc_094", starred=True)),
    ref=[act("star", kind="document", name="Clinic operating licence", when=J(U("year", 0)))]),
  T("complete the vaccine fridge log, rasha did it before lunch",
    diff(upd("t_131", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Check the vaccine fridge temperature log")]),
  T("who's the pharmacist at the clinic, i need to ask about gloves", rows("dr_sami"),
    ref=[ans(kind="person", where='role = "pharmacist"')]))

S("T38-110", "stray-conditions no-status-on-people role-exact building-committee no-description-on-photos name",
  T("who's still on the building committee", rows("shireen_barghouti", "tamara_nimri", "zain_yaghmour", "areej_shawabkeh"),
    ref=[ans(kind="person", where='role = "building committee"')]),
  T("any photos of the first harvest from the garden", rows("ph_garden_a_05", "ph_garden_a_11", "ph_garden_a_17"),
    ref=[ans(kind="photo", name="first harvest")]))

S("T38-111", "date-window before-weekday closed-from-today future then past-tense open count cancelled calls",
  T("what's on before sunday", rows("ct_270513", "fl_270514"),
    ref=[bad(ans(kind="event", when=J({"from": U("day", 0), "to": {"weekday": 6}}))),
         ans(kind="event", when=J(span(U("day", 0), U("week", 0, weekday=6))))]),
  T("how many calls to teta did we cancel before march", val(9),
    ref=[ans(op="count", kind="event", name="Call Teta", where="status = cancelled",
             when=J({"to": U("month", 0, name=2)}))]))

S("T38-112", "date-window named-month whole-month future past X-or-older year count within-container",
  T("how many events are on in june", val(20),
    ref=[bad(ans(op="count", kind="event", when=J({"unit": "month", "name": 6}))),
         ans(op="count", kind="event", when=J(U("month", 0, name=6)))]),
  T("and how many were there in march", val(23),
    ref=[ans(op="count", kind="event", when=J(U("month", 0, name=3)))]),
  T("how many docs are 2025 or older", val(56),
    ref=[ans(op="count", kind="document", when=J({"to": U("year", -2)}))]),
  T("just the tax folder ones", val(8),
    ref=[ans(op="count", kind="document", linked_to="$taxf", when=J({"to": U("year", -2)}))]))

S("T38-113", "date-window ordinal past-tense vs upcoming past-perfect count to-today vs still-to-come",
  T("which events got cancelled on the 7th", rows("fl_270507"),
    ref=[ans(kind="event", where="status = cancelled", when=J(D("2027-05-07")))]),
  T("and anything on the 20th", rows("ct_270520"),
    ref=[ans(kind="event", when=J(D("2027-05-20")))]),
  T("how many calls to teta have we had this month", val(1),
    ref=[ans(op="count", kind="event", name="Call Teta", where="status != cancelled",
             when=J(span(U("month", 0), U("day", 0))))]),
  T("and how many are still to come this month", val(3),
    ref=[ans(op="count", kind="event", name="Call Teta", where="status != cancelled",
             when=J(span(U("day", 0), U("month", 0))))]))

S("T38-114", "date-window from-X-on open span future and past two-years-ago longer-than duration where",
  T("how many swim classes does dana have from june on", val(3),
    ref=[ans(op="count", kind="event", name="swim class", where="status != cancelled",
             when=J({"from": U("month", 0, name=6)}))]),
  T("which calls to teta got cancelled from march on", rows("ct_270422"),
    ref=[ans(kind="event", name="Call Teta", where="status = cancelled", when=J({"from": U("month", 0, name=3)}))]),
  T("and how many were cancelled two years ago", val(2),
    ref=[ans(op="count", kind="event", name="Call Teta", where="status = cancelled", when=J(U("year", -2)))]),
  T("which events next month are longer than two hours",
    rows("clinic_anniv", "fl_270604", "fl_270611", "fdr_270612", "fl_270618", "grad_2027", "fl_270625"),
    ref=[bad(ans(kind="event", where="duration > 2 hours", when=J(U("month", 1)))),
         ans(kind="event", where="duration > 120", when=J(U("month", 1)))]))

S("T38-115", "date-window time-of-day pick of a shown list no-when sunday last-saturday later-one",
  T("what's on sunday", rows("csm_270516", "eid_a27"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=7)))]),
  T("which of those is the morning one", rows("csm_270516"),
    ref=[ans(rows="$csm_270516")]),
  T("and what was on last saturday", rows("yf_270508", "fdr_270508"),
    ref=[ans(kind="event", when=J(U("week", -1, weekday=6)))]),
  T("which one was later", rows("fdr_270508"),
    ref=[ans(rows="$fdr_270508")]))

S("T38-116", "mixed rename quoted-span inside longer sentence folder",
  T('i want the tax folder to say "taxes and zakat" from now on, it holds both',
    diff(upd("taxf", name="taxes and zakat")),
    ref=[act("edit", kind="folder", name="Tax", args="name: taxes and zakat")]))

S("T38-117", "mixed note body append add-to-the-note open-then-edit pin",
  T("add 'ask the landlord about parking' to the clinic opening hours note",
    diff(upd("loose_6", body=has("Sunday to Thursday", "landlord about parking"))),
    ref=[opn("$loose_6"),
         act("edit", rows="$loose_6",
             args=lines(body="Sunday to Thursday nine to six, Saturday nine to two, closed on Friday. Ask the landlord about parking"))]),
  T("pin it too", diff(upd("loose_6", pinned=True)),
    ref=[act("edit", rows="$loose_6", args="pinned: yes")]))

S("T38-118", "mixed settle_up amount person group partial then group balance",
  T("dr tala handed me 50 dinars towards the supplies pool",
    diff(upd("dr_tala", balance=ANY), settle=[("Tala Khoury", "50.00")]),
    ref=[bad(act("settle_up", rows="$dr_tala", args="amount: 50")),
         act("settle_up", rows="$dr_tala", args="group: $clinic_supplies\namount: 50")]),
  T("so where is she at in there now", val((-88.333, "JOD")),
    ref=[ans(op="balance", kind="group", name="Clinic Supplies Pool", linked_to="$dr_tala")]))

S("T38-119", "mixed kind-word-decides notes documents same-topic school then latest within",
  T("any school notes", rows("sch_1", "sch_2", "sch_3", "sch_4", "sch_5"),
    ref=[ans(kind="note", name="school")]),
  T("and documents", rows("doc_014", "doc_044", "doc_074"),
    ref=[ans(kind="document", name="school")]),
  T("and which one's the most recent", rows("doc_074"),
    ref=[ans(within="@prev", order="date desc", limit=1)]))

S("T38-120", "mixed weekday-and-clock date argument on writes reschedule from-to create",
  T("move mama's eye test from next wednesday to friday at 10", diff(upd("oo_065", date="2027-05-14T10:00")),
    ref=[act("reschedule", kind="event", name="Eye test", when=J(U("week", 1, weekday=3)),
             args=lines(to=U("week", 0, weekday=5, time="10:00")))]),
  T("dentist for dana next thursday at 9", diff(new("event", name=has("dentist"), date="2027-05-20T09:00")),
    ref=[act("create", args=lines(kind="event", name="Dentist - Dana", date=U("week", 1, weekday=4, time="09:00")))]))
