from gold import *
import json

world("T18", "2026-03-01T11:20", "Jordan Ellis", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


NOW = W({"from": U("day", 0)})
NEXT_WEEK = W(U("week", 1))
NEXT3 = find(kind="event", when=NOW, order="date asc", limit=3)
S("T18-132", "recovery twice limit events then sum effort then max duration",
  T("whats coming up, just the next three", rows("climb_mar", "shower_call", "vax", order=True),
    ref=[NEXT3, bad(NEXT3), bad(NEXT3), ans(within="@prev")]),
  T("how many minuets of tasks are due next week, everything on every list added up", val(630),
    ref=[ans(op="sum", field="effort", kind="task", when=NEXT_WEEK, where='status = "open"')]),
  T("longest thing on the calendar in march, the d&d nights don't count they're always four hours",
    val(180),
    ref=[ans(op="max", field="duration", kind="event", when=W(U("month", 0)), where='duration != 240')]),
  T("and the shortest one this month", val(30),
    ref=[ans(op="min", field="duration", kind="event", when=W(U("month", 0)))]))

S("T18-135", "sum shower effort max dog list typo min home open next dnd limit typo",
  T("total effort on the baby shower list", val(170),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$shower_l", where='status = "open"')]),
  T("longset task on the biscuit list", val(30),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$dog_l", where='status = "open"')]),
  T("of the stuff still open on the home list, what's the smallest effort estimate i gave any of them",
    val(5),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$home_l", where='status = "open"')]),
  T("next 2 dnd sessons", rows("dnd_0305", "dnd_0312", order=True),
    ref=[ans(kind="event", name="D&D session", when=NOW, order="date asc", limit=2)]))

S("T18-137", "unbounded typo then ask log coffee alex never mind then unbounded long",
  T("delete eveything", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("move climbing to 7", ask("climb_feb", "climb_mar"),
    ref=[act("reschedule", kind="event", name="Climbing with Brooke",
             args=lines(to=U("day", 0, anchor="row", time="19:00"))),
         find(kind="event", name="Climbing with Brooke"),
         askc("the one on the 23rd of february or tomorrow's?", options="$climb_feb, $climb_mar")]),
  T("nah forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("wipe all my notes and documents and photos, i want a clean slate before the baby arrives",
    decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T18-140", "latest photos then unbounded typo then ask cancel vet never mind then sum tasks typo",
  T("my latest 2 photos", rows("b_creek", "whiteboard", order=True),
    ref=[ans(kind="photo", order="date desc", limit=2)]),
  T("clear out the enitre vault", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("cancel the vet check-up", ask("vet_feb", "vet_apr"),
    ref=[act("cancel", kind="event", name="Biscuit's vet check-up"),
         find(kind="event", name="Biscuit's vet check-up"),
         askc("the one in february or the one on the 15th of april?", options="$vet_feb, $vet_apr")]),
  T("no no, don't cancel anything, i just realised biscuit still needs both of those check-ups so leave it",
    decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how many minutes of tasks are due on the fifth altogether", val(50),
    ref=[ans(op="sum", field="effort", kind="task", when=W(D("2026-03-05")), where='status = "open"')]))
