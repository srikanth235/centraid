from gold import *
import json

world("T21", "2026-06-06T09:00", "Grace Mwangi", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


NOW = W({"from": U("day", 0)})
TOMORROW = W({"from": U("day", 1)})
THIS_WEEK = W(U("week", 0))
THIS_MONTH = W(U("month", 0))
NEXT3 = find(kind="event", when=NOW, order="date asc", limit=3)
S("T21-132", "limit events then sum effort week then max duration then min",
  T("what's next in the diary, the next three", rows("chama_06", "kevin_call", "brief_0608", order=True),
    ref=[ans(kind="event", when=NOW, order="date asc", limit=3)]),
  T("how many minutes of tasks are due this week, everything on every list added up, dont seperate them",
    val(70),
    ref=[ans(op="sum", field="effort", kind="task", when=THIS_WEEK, where='status = "open"')]),
  T("longest thing on the calendar this month, the chama retreat doesn't count, it's 540 mins",
    val(360),
    ref=[ans(op="max", field="duration", kind="event", when=THIS_MONTH, where='duration != 540')]),
  T("and the shortest one this month", val(30),
    ref=[ans(op="min", field="duration", kind="event", when=THIS_MONTH)]))

S("T21-135", "sum church list max school list typo min home open next choir limit typo",
  T("total effort on the church list", val(150),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$church_l", where='status = "open"')]),
  T("the largset task on the school list", val(180),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$school_l", where='status = "open"')]),
  T("how few minutes is the shortest open job on the home list, i want something quick to tick off this morning",
    val(10),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$home_l", where='status = "open"')]),
  T("next 2 choir practces", rows("choir_0611", "choir_0618", order=True),
    ref=[ans(kind="event", name="Choir practice", when=NOW, order="date asc", limit=2)]))

S("T21-137", "unbounded typo then ask star peter never mind then unbounded long",
  T("remove evrythng", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("star peter", ask("peter_k", "peter_o"),
    ref=[act("star", kind="person", name="Peter"),
         askc("peter the BOM chair or peter the church elder?", options="$peter_k, $peter_o")]),
  T("never mind", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("erase all my notes and documents and photos, i want a totally clean slate before the term ends",
    decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T21-140", "latest documents then unbounded typo then ask delete school folder never mind then sum tasks",
  T("my latest 2 documents", rows("insurance_doc", "scan_2", order=True),
    ref=[ans(kind="document", order="date desc", limit=2)]),
  T("wipe the whol vault", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("delete the school folder", ask("board_f", "fees_f"),
    ref=[act("delete", kind="folder", name="School"),
         askc("school board or school fees?", options="$board_f, $fees_f")]),
  T("no no, don't delete anything, the board papers and the fee receipts are both what the auditor asked for so just leave it",
    decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how many minutes of tasks are due on the twelfth of june altogether, ignore the ones i already finished", val(90),
    ref=[ans(op="sum", field="effort", kind="task", when=W(D("2026-06-12")), where='status = "open"')]))
