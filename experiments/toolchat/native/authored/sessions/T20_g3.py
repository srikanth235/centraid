from gold import *
import json

world("T20", "2026-05-28T16:10", "Matteo Ricci", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


NOW = W({"from": U("day", 0)})
TOMORROW = W({"from": U("day", 1)})
THIS_WEEK = W(U("week", 0))
NEXT_MONTH = W(U("month", 1))
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

BIG2 = find(kind="debt", where=IOWE, order="amount desc", limit=2)
S("T20-131", "recovery limit find repeat answer then min owed then sum typo then max",
  T("my two biggest debts to pay", rows("d_fede", "d_gianni", order=True),
    ref=[BIG2, bad(BIG2), ans(within="@prev")]),
  T("which is the smallest amount anyone owes me right now, i want to chase the little ones first",
    val((25, "EUR")),
    ref=[ans(op="min", field="amount", kind="debt", where=OWED)]),
  T("what do i owe altogeter", val((495, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]),
  T("and the biggest one anyone owes me", val((85, "EUR")),
    ref=[ans(op="max", field="amount", kind="debt", where=OWED)]))

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

S("T20-133", "min owed typo then max then ask chianti event later never mind",
  T("the smallest debt owed to me, i'd like to collect the little ones wiht a quick message",
    val((25, "EUR")),
    ref=[ans(op="min", field="amount", kind="debt", where=OWED)]),
  T("and the biggest one, i think that's giulia for the curtain fabric that she still hasn't paid",
    val((85, "EUR")),
    ref=[ans(op="max", field="amount", kind="debt", where=OWED)]),
  T("push the chianti one back an hour", ask("fede_visit", "gran_fondo"),
    ref=[act("reschedule", kind="event", name="Chianti", args=lines(to=U("hour", 1, anchor="row"))),
         askc("the estate visit with fede on the 2nd of june or the gran fondo on the 14th?", options="$fede_visit, $gran_fondo")]),
  T("actually leave it, fede is still confirming the visit and the gran fondo start is set by the organisers, i'll check saterday",
    decline("never_mind"),
    ref=[dec("never_mind")]))

S("T20-134", "sum owed hard then min effort wedding list typo then max effort then latest note",
  T("add up everything people owe me right now, including the curtain fabric money from giulia",
    val((230, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWED)]),
  T("smallest effort on the wedding list, the lowest one i mean", val(60),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$wedding_l", where='status = "open"')]),
  T("and the biggest effort estimate on that list, the wine pairing i think", val(120),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$wedding_l", where='status = "open"')]),
  T("latest note i wrote", rows("boxes_count"),
    ref=[ans(kind="note", order="date desc", limit=1)]))

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

S("T20-138", "oldest debt typo then unbounded debts then max owed then min duration",
  T("the oldset debt i still owe", rows("d_fede"),
    ref=[ans(kind="debt", where=IOWE, order="date asc", limit=1)]),
  T("remove all the debts and the groups too, i'd like the money side completely empty",
    decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("how much is the largest single amount i still owe anyone, the one i should pay first",
    val((180, "EUR")),
    ref=[ans(op="max", field="amount", kind="debt", where=IOWE)]),
  T("and the shortest event on the calendar", val(30),
    ref=[ans(op="min", field="duration", kind="event")]))

S("T20-139", "three smallest owed then next dentist typo then sum bike then ask log lorenzo never mind",
  T("the three smallest debts i owe", rows("d_chiara", "d_andrea", "d_gianni", order=True),
    ref=[ans(kind="debt", where=IOWE, order="amount asc", limit=3)]),
  T("my next dentist appointmnet", rows("dentist_jun"),
    ref=[ans(kind="event", name="Dentist", when=NOW, order="date asc", limit=1)]),
  T("how much effort is the whole bike list, all of it added up", val(65),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$bike_l", where='status = "open"')]),
  T("log a call with lorenzo", ask("lorenzo_g", "lorenzo_r"),
    ref=[act("log", kind="person", name="Lorenzo", args=lines(kind="call")),
         askc("lorenzo the head chef or your cousin lorenzo?", options="$lorenzo_g, $lorenzo_r")]),
  T("oh wait, forget it, i'll see the head chef at work in an hour and my cousin messaged me anyway",
    decline("never_mind"),
    ref=[dec("never_mind")]))

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
