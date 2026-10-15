from gold import *
import json

world("T19", "2026-04-14T20:40", "Fatima Al-Sayed", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


NOW = W({"from": U("day", 0)})
TOMORROW = W({"from": U("day", 1)})
THIS_WEEK = W(U("week", 0))
THIS_MONTH = W(U("month", 0))
NEXT3 = find(kind="event", when=NOW, order="date asc", limit=3)
S("T19-132", "limit events then sum effort week then max duration then min",
  T("what's next in the diary, the next three", rows("run_0414", "berrada_meet", "lina_vacc", order=True),
    ref=[ans(kind="event", when=NOW, order="date asc", limit=3)]),
  T("how many mintues of tasks are due this week, everything on every list added up", val(370),
    ref=[ans(op="sum", field="effort", kind="task", when=THIS_WEEK, where='status = "open"')]),
  T("longest thing on the calendar in april, the night duties don't count they're always twelve hours",
    val(360),
    ref=[ans(op="max", field="duration", kind="event", when=THIS_MONTH, where='duration != 720')]),
  T("and the shortest one this month", val(20),
    ref=[ans(op="min", field="duration", kind="event", when=THIS_MONTH)]))

S("T19-135", "sum baba list max kids list typo min home open next swim limit typo",
  T("total effort on baba's list", val(135),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$baba_l", where='status = "open"')]),
  T("the longest task on the kids list", val(30),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$kids_l", where='status = "open"')]),
  T("how few minutes is the shortest open job on the home list, i want something quick to tick off tonight",
    val(10),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$home_l", where='status = "open"')]),
  T("next 2 swimming lesons", rows("swim_0415", "swim_0422", order=True),
    ref=[ans(kind="event", name="Adam's swimming lesson", when=NOW, order="date asc", limit=2)]))

S("T19-137", "unbounded typo then ask log coffee samira never mind then unbounded long",
  T("remove everythig", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("log a coffee with samira", ask("samira_a", "samira_b"),
    ref=[act("log", kind="person", name="Samira", args=lines(kind="coffee")),
         askc("samira alaoui, ines's mum, or samira bennani, rayan's mum?", options="$samira_a, $samira_b")]),
  T("never mind", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("erase all my notes and documents and photos, i want a totally clean slate before eid",
    decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T19-140", "latest documents then unbounded typo then ask staff meeting never mind then sum tasks",
  T("my latest 2 documents", rows("scan_41", "fees_invoice", order=True),
    ref=[ans(kind="document", order="date desc", limit=2)]),
  T("wipe the wohle vault", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("move the staff meeting to 2", ask("staff_03", "staff_04", "staff_05"),
    ref=[act("reschedule", kind="event", name="Pharmacy staff meeting",
             args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         find(kind="event", name="Pharmacy staff meeting"),
         askc("march's, april's or may's?", options="$staff_03, $staff_04, $staff_05")]),
  T("no no, don't move any of them, the whole team already agreed on those times so just leave it",
    decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how many minutes of tasks are due on the twentieth altogether, wich list doesnt matter", val(45),
    ref=[ans(op="sum", field="effort", kind="task", when=W(D("2026-04-20")), where='status = "open"')]))
