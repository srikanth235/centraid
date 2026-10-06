from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

IOWE = 'direction = "i_owe" and status = "open"'

OWED = 'direction = "owes_me" and status = "open"'

TOP3 = find(kind="debt", where=IOWE, order="amount desc", limit=3)

OPEN = 'status = "open"'

BIGJOB = find(kind="task", where=OPEN)

S("T07-131-P", "recovery limit find debts repeated min sum typo para",
  T("top three debts i owe, largest first", rows("d_sonia", "d_hugo", "d_carla", order=True),
    ref=[TOP3, bad(TOP3), ans(within="@prev")]),
  T("which of my debts is the smallest, i want that cleared before the others", val((20, "PEN")),
    ref=[ans(op="min", field="amount", kind="debt", where=IOWE)]),
  T("total still due to me from everybody, the tractor money included", val((510, "PEN")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWED)]),
  T("largest among those?", val((300, "PEN")),
    ref=[ans(op="max", field="amount", kind="debt", where=OWED)]))

S("T07-136-P", "rehearsal ask never_mind masses limit min typo para",
  T("rehearsal needs moving", ask(),
    ref=[askc("which rehearsal, and to when?")]),
  T("leave the rehearsals, i'll sort it with lucia at the next one", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("next two sunday masses, times please, i always forget", rows("mass_0315", "mass_0322", order=True),
    ref=[ans(kind="event", name="mass", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("which coop list task takes the least time", val(30),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$coop_l", where=OPEN)]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T07-201-P", "both task event reschedule bare weekday prev para",
  T("seed things for tomorrow?", rows("seed_delivery", "seed_pay"),
    ref=[ans(kind="task,event", name="seed", when=W(U("day", 1)))]),
  T("both move to monday", diff(upd("seed_delivery", date="2026-03-16T09:00"), upd("seed_pay", date="2026-03-16")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]),
  T("monday's lineup after that then?", rows("scout_0316", "seed_delivery", "mechanic"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=1)))]))
