from gold import *
import json

world("T21", "2026-06-06T09:00", "Grace Mwangi", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


NOW = W({"from": U("day", 0)})
TOMORROW = W({"from": U("day", 1)})
THIS_WEEK = W(U("week", 0))
THIS_MONTH = W(U("month", 0))
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

BIG2 = find(kind="debt", where=IOWE, order="amount desc", limit=2)
S("T21-131", "recovery limit find repeat answer then min owed then sum typo then max",
  T("my two biggest debts to pay", rows("d_githinji", "d_kevin", order=True),
    ref=[BIG2, bad(BIG2), ans(within="@prev")]),
  T("what's the smallest amount someone owes me right now, i'd like to chase the little ones first",
    val((500, "KES")),
    ref=[ans(op="min", field="amount", kind="debt", where=OWED)]),
  T("what do i owe pepole altogether", val((10000, "KES")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]),
  T("and the biggest one anyone owes me", val((15000, "KES")),
    ref=[ans(op="max", field="amount", kind="debt", where=OWED)]))

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

S("T21-133", "min owed typo then max then ask clinic review later never mind",
  T("the smallest debt owed to me, i'd like to collect the little ones sooner via a mesage",
    val((500, "KES")),
    ref=[ans(op="min", field="amount", kind="debt", where=OWED)]),
  T("and the biggest one, i think that's brian for the rent deposit in eldoret that he still hasn't paid",
    val((15000, "KES")),
    ref=[ans(op="max", field="amount", kind="debt", where=OWED)]),
  T("move the clinic review to 3", ask("clinic_may", "clinic_june"),
    ref=[act("reschedule", kind="event", name="Clinic review",
             args=lines(to=U("day", 0, anchor="row", time="15:00"))),
         find(kind="event", name="Clinic review"),
         askc("the one on the 12th of may or the one on the 9th of june?", options="$clinic_may, $clinic_june")]),
  T("actually leave it, anne says the whole clinic schedule is fixed until july and i can't change either of them, i'll ring on sundya",
    decline("never_mind"),
    ref=[dec("never_mind")]))

S("T21-134", "sum owed hard then min effort chama list typo then max effort then latest note",
  T("add up everything people owe me right now, including the rent deposit from brian",
    val((19500, "KES")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWED)]),
  T("smallest effort on the chama list, the lowest one i meen", val(5),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$chama_l", where='status = "open"')]),
  T("and the biggest effort estimate on that list, the minutes i think", val(45),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$chama_l", where='status = "open"')]),
  T("latest note i wrote", rows("grad_plan"),
    ref=[ans(kind="note", order="date desc", limit=1)]))

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

S("T21-138", "oldest debt typo then unbounded debts then max owed then min duration",
  T("the oldst debt i still owe", rows("d_beatrice"),
    ref=[ans(kind="debt", where=IOWE, order="date asc", limit=1)]),
  T("remove all the debts and the groups too, i'd like the money side completely empty",
    decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("how much is the largest single amount i still owe anyone, the one i should pay first",
    val((4500, "KES")),
    ref=[ans(op="max", field="amount", kind="debt", where=IOWE)]),
  T("and the shortest event on the calendar", val(30),
    ref=[ans(op="min", field="duration", kind="event")]))

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
