from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

OPEN = 'status = "open"'

BIGJOB = find(kind="task", where=OPEN)

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
