from gold import *
import json

world("T32", "2026-10-28T16:10", "Rosa Delgado-Ortiz", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T32-091", "container-link-reads list-name-collision within-linked folder-vs-list",
  T("what's left on the family list before the end of november", rows("carmen_meds", "emi_gift", "carmen_gift"),
    ref=[ans(kind="task", linked_to="$family_l", where="status = open",
             when=W(span(U("day", 0), U("month", 0, name=11))))]),
  T("which of those are for carmen", rows("carmen_meds", "carmen_gift"),
    ref=[ans(within="@prev", linked_to="$carmen")]),
  T("and what's in the family folder", rows("d_carmen_id", "d_deed"),
    ref=[ans(kind="document", linked_to="$family_f")]))

S("T32-092", "container-link-reads owner-row groups person-count within photos-of-me",
  T("how many groups am i in", val(6),
    ref=[ans(op="count", kind="group", linked_to="$me")]),
  T("which of them have more than 3 people", rows("coro", "familia", "boda", "panaderos"),
    ref=[ans(within="@prev", where="person count > 3")]),
  T("how many photos am i in", val(0),
    ref=[ans(op="count", kind="photo", linked_to="$me")]))

S("T32-093", "container-link-reads person-appointments linked within week",
  T("what's don memo got coming up this week and next", rows("stall_oct31", "stall_nov01", "stall_nov02", "vendors"),
    ref=[ans(kind="event", linked_to="$memo", when=W(span(U("week", 0), U("week", 1))))]),
  T("which of those has beto on too", rows("stall_oct31", "stall_nov01", "stall_nov02"),
    ref=[ans(within="@prev", linked_to="$beto")]),
  T("and what does yesenia have this week", rows("stall_oct31", "stall_nov01"),
    ref=[ans(kind="event", linked_to="$yesenia", when=W(U("week", 0)))]))

S("T32-094", "container-link-reads album-vs-person collision within exclude",
  T("what's in the dani and emi album", rows("p_ki_dani", "p_ki_emi", "p_ki_both", "p_ki_ring", "p_ki_hike"),
    ref=[ans(kind="photo", linked_to="$kids_a")]),
  T("which of those have rodrigo in them", rows("p_ki_ring"),
    ref=[ans(within="@prev", linked_to="$rodrigo")]),
  T("and dani pics that aren't in that album", rows("p_wedding_dress"),
    ref=[ans(kind="photo", linked_to="$dani", exclude="@1")]))

S("T32-095", "container-link-reads album-vs-parent-task collision within linked",
  T("what's in the muertos album", rows("p_mu_altar", "p_mu_stall", "p_mu_cemetery", "p_mu_mass", "p_mu_flowers"),
    ref=[ans(kind="photo", linked_to="$muertos_a")]),
  T("which of those have carmen in them", rows("p_mu_altar", "p_mu_cemetery"),
    ref=[ans(within="@prev", linked_to="$carmen")]),
  T("and what's left under the muertos orders", rows("mu_orange", "mu_boxes", "mu_sugar", "mu_stall", "mu_float"),
    ref=[ans(kind="task", linked_to="$muertos", where="status = open")]))

S("T32-096", "stray-or-operator-conditions inert-purpose-clause reads linked body-contains",
  T("which of the van docs are starred, i need them for the insurance claim",
    rows("d_ins26"),
    ref=[ans(kind="document", linked_to="$van_f", where="starred = yes")]),
  T("starred photos of emi, for the birthday slideshow",
    rows("p_ba_loaves", "p_ki_both"),
    ref=[ans(kind="photo", linked_to="$emi", where="starred = yes")]),
  T("what notes mention flour, for the budget", rows("b_suppliers", "budget", "r_polvorones"),
    ref=[ans(kind="note", where='body contains "flour"')]))

S("T32-097", "stray-or-operator-conditions inert-clause by-name-writes star pin complete",
  T("star the van registration card so i can find it quick", diff(upd("d_vanreg", starred=True)),
    ref=[act("star", kind="document", name="van registration")]),
  T("pin the mass rota, the choir needs it handy", diff(upd("c_rota", pinned=True)),
    ref=[act("edit", kind="note", name="mass rota", args="pinned: yes")]),
  T("tick off the thermostat order, don chato says it's on the way, and what's left on the bakery list for tomorrow",
    rows("mu_orange", "mu_boxes", "yeast", also=diff(upd("oven_part", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="thermostat", more=True),
         ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("day", 1)))]))

S("T32-098", "stray-or-operator-conditions role-like-nouns exact-role name-not-direction group-not-role status-lacking",
  T("who's on the counter", rows("yesenia"),
    ref=[ans(kind="person", where='role = "counter"')]),
  T("any open deposits", rows("d_flor"),
    ref=[ans(kind="debt", name="deposit", where="status = open")]),
  T("who are the chicago cousins", rows("me", "pepe", "gaby"),
    ref=[ans(kind="person", linked_to="$chicago")]),
  T("and who's still in the choir", rows("me", "aurelio", "marilu", "marichuy", "lupita", "xochitl", "cuauh", "ramiro"),
    ref=[ans(kind="person", linked_to="$coro")]))

S("T32-099", "stray-or-operator-conditions met-description-body-contains photo-name-only",
  T("who did i meet at the mercado", rows("memo", "omar"),
    ref=[ans(kind="person", where='met contains "Mercado"')]),
  T("any events that mention the thermostat", rows("oven_fix"),
    ref=[ans(kind="event", where='description contains "thermostat"')]),
  T("photos that mention the oven", rows("p_ba_oven", "p_oven_serial"),
    ref=[ans(kind="photo", name="oven")]),
  T("and notes in the bakery notebook about the technician", rows("b_oven"),
    ref=[ans(kind="note", linked_to="$bakery_nb", where='body contains "technician"')]))

S("T32-100", "stray-or-operator-conditions side-clause-with-date effort-when reschedule",
  T("which debts are open, i want to square things before the wedding",
    rows("d_memo_flour", "d_teodoro", "d_maria_roof", "d_maria_med", "d_emi", "d_dani", "d_rodrigo", "d_xochitl",
         "d_aurelio", "d_chela", "d_flor", "d_omar"),
    ref=[ans(kind="debt", where="status = open")]),
  T("what's due friday that takes under an hour, i've got a free afternoon",
    rows("mu_sugar", "mu_float", "tea_towels", "carmen_meds", "gas_tank", "marigolds", "van_fuel"),
    ref=[ans(kind="task", where="status = open and effort < 60", when=W(U("week", 0, weekday=5)))]),
  T("move the yeast to friday, beto won't be in till then", diff(upd("yeast", date="2026-10-30")),
    ref=[act("reschedule", kind="task", name="yeast", args=lines(to=U("week", 0, weekday=5)))]))

S("T32-101", "date-window-reads before-window both-tenses ordinal-past ordinal-upcoming repair-date-expression",
  T("what's on before friday", rows("pickup_flor", "coro_1029"),
    ref=[bad(ans(kind="event", when=W({"from": U("day", 0), "to": {"weekday": 4}}))),
         ans(kind="event", when=W(span(U("day", 0), U("week", 0, weekday=4))))]),
  T("what did we have before the 5th", rows("van_tires", "accountant_b", "pickup_flor_old", "oven_old", "flour_0929",
                                              "coro_1001", "calldani_1004"),
    ref=[ans(kind="event", when=W({"to": D("2026-10-04")}))]),
  T("what was on the 21st", rows("workshop_b"),
    ref=[ans(kind="event", when=W(D("2026-10-21")))]),
  T("and what's on the 20th", rows("emi_bday"),
    ref=[ans(kind="event", when=W(D("2026-11-20")))]))

S("T32-102", "date-window-reads named-month both-tenses or-older year-arithmetic",
  T("which choir rehearsals are in december", rows("coro_1203", "coro_1210", "coro_1217"),
    ref=[ans(kind="event", name="Choir rehearsal", when=W(U("month", 0, name=12)))]),
  T("what did i have in september", rows("pickup_flor_old", "oven_old", "flour_0929"),
    ref=[ans(kind="event", when=W(U("month", 0, name=9)))]),
  T("events from august or older", rows("van_tires", "accountant_b"),
    ref=[ans(kind="event", when=W({"to": U("month", 0, name=8)}))]),
  T("documents from two years ago", rows("d_vanreg", "d_deed"),
    ref=[ans(kind="document", when=W(U("year", -2)))]))

S("T32-103", "date-window-reads from-on-open-span past-perfect-count closed-at-today count",
  T("how many flour deliveries from the 10th on", val(4),
    ref=[ans(op="count", kind="event", name="Flour delivery", when=W({"from": D("2026-11-10")}))]),
  T("and how many sunday calls with dani had we done since the start of october", val(3),
    ref=[ans(op="count", kind="event", name="Call Dani", where="status != cancelled",
             when=W({"from": D("2026-10-01"), "to": U("day", 0)}))]),
  T("and how many are left from next sunday on", val(4),
    ref=[ans(op="count", kind="event", name="Call Dani", when=W({"from": U("week", 1, weekday=7)}))]))

S("T32-104", "date-window-reads duration-where-not-when week month substitution time-of-day-pick repair-unit",
  T("which events this week are longer than 2 hours", rows("stall_oct31", "stall_nov01", "cemetery"),
    ref=[bad(ans(kind="event", where="duration > 2 hours", when=W(U("week", 0)))),
         ans(kind="event", where="duration > 120", when=W(U("week", 0)))]),
  T("and in september", rows("oven_old"),
    ref=[ans(kind="event", where="duration > 120", when=W(U("month", 0, name=9)))]),
  T("what's on thurs", rows("pickup_flor", "coro_1029"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=4)))]),
  T("the evening one", rows("coro_1029"),
    ref=[ans(rows="$coro_1029")]))

S("T32-105", "date-window-reads year-arithmetic substitution album next-year last-year empty",
  T("what's in the dani and emi album from three years ago", rows("p_ki_emi"),
    ref=[ans(kind="photo", linked_to="$kids_a", when=W(U("year", -3)))]),
  T("and four years ago", rows("p_ki_dani"),
    ref=[ans(kind="photo", linked_to="$kids_a", when=W(U("year", -4)))]),
  T("what's on next year", rows("flight_pepe", "wedding"),
    ref=[ans(kind="event", when=W(U("year", 1)))]),
  T("what did i have last year", rows(),
    ref=[ans(kind="event", when=W(U("year", -1)))]))

S("T32-106", "mixed rename-quoted-span",
  T('rename the van log to "service history", it has all the repairs in it', diff(upd("van_log", name="service history")),
    ref=[act("edit", rows="$van_log", args="name: service history")]))

S("T32-107", "mixed body-append note",
  T('add "call don chato monday" to the oven problems note',
    diff(upd("b_oven", body="thermostat drifts twenty degrees, left deck runs hot, technician is Don Chato from the Abastos, call don chato monday")),
    ref=[opn("$b_oven"),
         act("edit", rows="$b_oven", args="body: thermostat drifts twenty degrees, left deck runs hot, technician is Don Chato from the Abastos, call don chato monday")]))

S("T32-108", "mixed settle_up-amount-and-person group-balance",
  T("i gave xochitl 100 for the posters, settle that in the coro group",
    diff(upd("xochitl", balance=ANY), settle=[("Xochitl Villalobos", "100.00")]),
    ref=[act("settle_up", rows="$xochitl", args="group: $coro\namount: 100")]),
  T("and where is she at in the group now", val((211, "MXN")),
    ref=[ans(op="balance", kind="group", name="Coro Santo Domingo", linked_to="$xochitl")]))

S("T32-109", "mixed kind-word-decides documents notes photos van",
  T("what van documents do i have", rows("d_ins25", "d_ins26", "d_vanreg", "d_service"),
    ref=[ans(kind="document", name="van")]),
  T("and notes", rows("van_log"),
    ref=[ans(kind="note", name="van")]),
  T("and pics", rows("p_ba_van", "p_van_noise"),
    ref=[ans(kind="photo", name="van")]))

S("T32-110", "mixed weekday-and-clock reschedule create",
  T("push the van service to mon 8am", diff(upd("van_service", date="2026-11-02T08:00")),
    ref=[act("reschedule", kind="event", name="van service", args=lines(to=U("week", 1, weekday=1, time="08:00")))]),
  T("book the oven guy thursday 9am", diff(new("event", name="Oven guy", date="2026-10-29T09:00")),
    ref=[act("create", args=lines(kind="event", name="Oven guy", date=U("week", 0, weekday=4, time="09:00")))]))
