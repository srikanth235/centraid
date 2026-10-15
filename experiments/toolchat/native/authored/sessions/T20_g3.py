from gold import *
import json

world("T20", "2026-05-28T16:10", "Matteo Ricci", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


NOW = W({"from": U("day", 0)})
TOMORROW = W({"from": U("day", 1)})
THIS_WEEK = W(U("week", 0))
NEXT_MONTH = W(U("month", 1))
NEXT3 = find(kind="event", when=NOW, order="date asc", limit=3)
S("T20-132", "limit events then sum effort week then max duration then min",
  T("what's next in the diary, the next three", rows("supplier_call", "cellar_count", "photographer_call", order=True),
    ref=[ans(kind="event", when=NOW, order="date asc", limit=3)]),
  T("how many minutse of tasks are due this week, everything on every list added up", val(90),
    ref=[ans(op="sum", field="effort", kind="task", when=THIS_WEEK, where='status = "open"')]),
  T("longest block of time on the calendar next month, moving day doesn't count it's always ten hours",
    val(510),
    ref=[ans(op="max", field="duration", kind="event", when=NEXT_MONTH, where='duration < 600')]),
  T("and the shortest one next month", val(30),
    ref=[ans(op="min", field="duration", kind="event", when=NEXT_MONTH)]))

S("T20-135", "sum move list max cantina list typo min errands open next rides limit typo",
  T("total effort on the move list", val(345),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$move_l", where='status = "open"')]),
  T("the biggset task on the cantina list", val(30),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$cantina_l", where='status = "open"')]),
  T("how few minutes is the shortest open job on the errands list, i want something quick to tick off tonight",
    val(10),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$errands_l", where='status = "open"')]),
  T("next 2 sunday club rides", rows("ride_0531", "ride_0607", order=True),
    ref=[ans(kind="event", name="Sunday club ride", when=NOW, order="date asc", limit=2)]))

S("T20-137", "unbounded typo then ask log visit marco never mind then unbounded long",
  T("scrap everythin", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("log a visit with marco", ask("marco_e", "marco_l"),
    ref=[act("log", kind="person", name="Marco", args=lines(kind="visit")),
         askc("marco the club captain or marco the club mechanic?", options="$marco_e, $marco_l")]),
  T("never mind", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("erase all my notes and documents and photos, i want a totally clean slate before the move",
    decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T20-140", "latest documents then unbounded typo then ask delete tasting notes never mind then sum tasks",
  T("my latest 2 documents", rows("scan_2", "scan_1", order=True),
    ref=[ans(kind="document", order="date desc", limit=2)]),
  T("clear out my entrie vault", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("delete the tasting notes", ask("tasting_nb", "tasting25_nb"),
    ref=[act("delete", kind="notebook", name="Tasting notes"),
         askc("the tasting notes notebook or the 2025 one?", options="$tasting_nb, $tasting25_nb")]),
  T("no no, don't delete anything, the 2025 notes and this year's are both what i study from so just leave it",
    decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how many minutes of tasks are due on the fith of june altogether, wich list doesnt matter", val(150),
    ref=[ans(op="sum", field="effort", kind="task", when=W(D("2026-06-05")), where='status = "open"')]))
