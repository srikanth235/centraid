from gold import *

import json

world("T32", "2026-10-28T16:10", "Rosa Delgado-Ortiz", "train")

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T32-091-P", "container-link-reads list-name-collision within-linked folder-vs-list para",
  T("family list stuff still open up to the end of november", rows("carmen_meds", "emi_gift", "carmen_gift"),
    ref=[ans(kind="task", linked_to="$family_l", where="status = open",
             when=W(span(U("day", 0), U("month", 0, name=11))))]),
  T("of those, the ones for carmen", rows("carmen_meds", "carmen_gift"),
    ref=[ans(within="@prev", linked_to="$carmen")]),
  T("family folder contents?", rows("d_carmen_id", "d_deed"),
    ref=[ans(kind="document", linked_to="$family_f")]))

S("T32-094-P", "container-link-reads album-vs-person collision within exclude para",
  T("dani and emi album, list its photos", rows("p_ki_dani", "p_ki_emi", "p_ki_both", "p_ki_ring", "p_ki_hike"),
    ref=[ans(kind="photo", linked_to="$kids_a")]),
  T("of those, rodrigo appears in which", rows("p_ki_ring"),
    ref=[ans(within="@prev", linked_to="$rodrigo")]),
  T("dani photos outside that album", rows("p_wedding_dress"),
    ref=[ans(kind="photo", linked_to="$dani", exclude="@1")]))

S("T32-097-P", "stray-or-operator-conditions inert-clause by-name-writes star pin complete para",
  T("i keep losing the van registration card, put a star on it", diff(upd("d_vanreg", starred=True)),
    ref=[act("star", kind="document", name="van registration")]),
  T("choir needs the mass rota close at hand, so pin it", diff(upd("c_rota", pinned=True)),
    ref=[act("edit", kind="note", name="mass rota", args="pinned: yes")]),
  T("don chato says the thermostat order is on its way, so mark that complete; and then what's open on the bakery list tomorrow",
    rows("mu_orange", "mu_boxes", "yeast", also=diff(upd("oven_part", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="thermostat", more=True),
         ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("day", 1)))]))

S("T32-100-P", "stray-or-operator-conditions side-clause-with-date effort-when reschedule para",
  T("before the wedding i want things squared, so which debts are still open",
    rows("d_memo_flour", "d_teodoro", "d_maria_roof", "d_maria_med", "d_emi", "d_dani", "d_rodrigo", "d_xochitl",
         "d_aurelio", "d_chela", "d_flor", "d_omar"),
    ref=[ans(kind="debt", where="status = open")]),
  T("i'm free friday afternoon, so what's due then that takes under an hour",
    rows("mu_sugar", "mu_float", "tea_towels", "carmen_meds", "gas_tank", "marigolds", "van_fuel"),
    ref=[ans(kind="task", where="status = open and effort < 60", when=W(U("week", 0, weekday=5)))]),
  T("beto's out until friday, so the yeast task goes to friday", diff(upd("yeast", date="2026-10-30")),
    ref=[act("reschedule", kind="task", name="yeast", args=lines(to=U("week", 0, weekday=5)))]))

S("T32-103-P", "date-window-reads from-on-open-span past-perfect-count closed-at-today count para",
  T("count flour deliveries starting the 10th", val(4),
    ref=[ans(op="count", kind="event", name="Flour delivery", when=W({"from": D("2026-11-10")}))]),
  T("sunday calls with dani, how many have we done since october began", val(3),
    ref=[ans(op="count", kind="event", name="Call Dani", where="status != cancelled",
             when=W({"from": D("2026-10-01"), "to": U("day", 0)}))]),
  T("and from next sunday onward, how many remain", val(4),
    ref=[ans(op="count", kind="event", name="Call Dani", when=W({"from": U("week", 1, weekday=7)}))]))
