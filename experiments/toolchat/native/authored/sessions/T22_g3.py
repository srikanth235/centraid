from gold import *
import json

world("T22", "2026-07-13T21:25", "Sven Lindqvist", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


NOW = W({"from": U("day", 0)})
TOMORROW = W({"from": U("day", 1)})
THIS_WEEK = W(U("week", 0))
THIS_MONTH = W(U("month", 0))
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

BIG2 = find(kind="debt", where=IOWE, order="amount desc", limit=2)
S("T22-131", "recovery limit find repeat answer then min owed then sum typo then max",
  T("my two biggest debts to pay", rows("d_karin", "d_gunnar", order=True),
    ref=[BIG2, bad(BIG2), ans(within="@prev")]),
  T("what's the smallest amount someone owes me right now, i'd like to chase the little ones first",
    val((120, "SEK")),
    ref=[ans(op="min", field="amount", kind="debt", where=OWED)]),
  T("what's the total ammount i owe", val((2790, "SEK")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]),
  T("and the biggest one anyone owes me", val((2000, "SEK")),
    ref=[ans(op="max", field="amount", kind="debt", where=OWED)]))

NEXT3 = find(kind="event", when=NOW, order="date asc", limit=3)
S("T22-132", "recovery twice limit events then sum effort week then max duration then min",
  T("what's next in the diary, the next three", rows("safety_walk", "swim_1", "padel_0714", order=True),
    ref=[NEXT3, bad(NEXT3), bad(NEXT3), ans(within="@prev")]),
  T("how many minutes of tasks are due this week on the calender, everything on every list added up",
    val(255),
    ref=[ans(op="sum", field="effort", kind="task", when=THIS_WEEK, where='status = "open"')]),
  T("longest thing on the calendar this month, the eight hour ones don't count",
    val(240),
    ref=[ans(op="max", field="duration", kind="event", when=THIS_MONTH, where='duration < 480')]),
  T("and the shortest one this month", val(30),
    ref=[ans(op="min", field="duration", kind="event", when=THIS_MONTH)]))

S("T22-133", "min owed typo then max then ask parents picnic later never mind",
  T("the smallest debt owed to me, i'd like to collect the little ones tomorow via a message",
    val((120, "SEK")),
    ref=[ans(op="min", field="amount", kind="debt", where=OWED)]),
  T("and the biggest one, i think that's samira for the train tickets that she still hasn't paid",
    val((2000, "SEK")),
    ref=[ans(op="max", field="amount", kind="debt", where=OWED)]),
  T("move the picnic to 12", ask("picnic_jun", "picnic_aug"),
    ref=[act("reschedule", kind="event", name="Parents network picnic",
             args=lines(to=U("day", 0, anchor="row", time="12:00"))),
         find(kind="event", name="Parents network picnic"),
         askc("the one on the 14th of june or the one on the 16th of august?", options="$picnic_jun, $picnic_aug")]),
  T("actually leave it, maria says the park booking is fixed and we can't shift either of the picnics, ill ask on thrusday",
    decline("never_mind"),
    ref=[dec("never_mind")]))

S("T22-134", "sum owed hard then min effort padel list typo then max effort then latest note",
  T("add up everything people owe me right now, including the train tickets money from samira",
    val((2920, "SEK")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWED)]),
  T("smallest effort on the padel list of what's remaning, the lowest one i mean", val(5),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$padel_l", where='status = "open"')]),
  T("and the biggest effort estimate on that list, the padel balls i think", val(10),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$padel_l", where='status = "open"')]),
  T("latest note i wrote", rows("speech_draft"),
    ref=[ans(kind="note", order="date desc", limit=1)]))

S("T22-135", "sum shopping list max warehouse list typo min home open next padel limit typo",
  T("total effort on the shopping list", val(75),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$shop_l", where='status = "open"')]),
  T("the biggets task on the warehouse list", val(120),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$work_l", where='status = "open"')]),
  T("how few minutes is the shortest open job on the home list, i want something quick to tick off tonight",
    val(5),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$home_l", where='status = "open"')]),
  T("next 2 padel matches thsi month", rows("padel_0714", "padel_0721", order=True),
    ref=[ans(kind="event", name="Padel league match", when=NOW, order="date asc", limit=2)]))

S("T22-136", "ask tick off padel court never mind hard then top two owed total then max then min",
  T("tick off book padel court", ask("court_1", "court_2"),
    ref=[act("complete", kind="task", name="Book padel court"),
         find(kind="task", name="Book padel court"),
         askc("thursday's due on the 16th or the one from the 8th of july?", options="$court_1, $court_2")]),
  T("hold on, never mind, i just remembered erik already booked the court for thursday so i shouldn't tick either, ill check satrday",
    decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what do my two biggest debts to me add up to", val((2300, "SEK")),
    ref=[find(kind="debt", where=OWED, order="amount desc", limit=2),
         ans(op="sum", field="amount", within="@prev")]),
  T("and the biggest of those", rows("d_samira"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]),
  T("smallest of the two", rows("d_erik"),
    ref=[ans(within="@3", order="amount asc", limit=1)]))

S("T22-137", "unbounded typo then ask log coffee johan never mind then unbounded long",
  T("wipe eveyrthing", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("log a coffee with johan", ask("johan_b", "johan_n"),
    ref=[act("log", kind="person", name="Johan", args=lines(kind="coffee")),
         askc("johan berg your brother-in-law or johan nilsson the warehouse manager?", options="$johan_b, $johan_n")]),
  T("never mind", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("erase all my notes and documents and photos, i want a totally clean slate before the autumn",
    decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T22-138", "oldest debt typo then unbounded debts then max owed then min duration",
  T("the oldist debt i still owe", rows("d_david"),
    ref=[ans(kind="debt", where=IOWE, order="date asc", limit=1)]),
  T("remove all the debts and the groups too, i'd like the money side completely empty",
    decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("how much is the largest single amount i still owe anyone, the one i should pay first",
    val((1200, "SEK")),
    ref=[ans(op="max", field="amount", kind="debt", where=IOWE)]),
  T("and the shortest event on the calendar", val(30),
    ref=[ans(op="min", field="duration", kind="event")]))

S("T22-139", "three smallest owed then next swim typo then sum warehouse then ask cancel dentist never mind",
  T("the three smallest debts i owe", rows("d_fatima", "d_mats", "d_david", order=True),
    ref=[ans(kind="debt", where=IOWE, order="amount asc", limit=3)]),
  T("my next swimming lessn", rows("swim_1"),
    ref=[ans(kind="event", name="Swimming lesson for Elias", when=NOW, order="date asc", limit=1)]),
  T("how much effort is the whole warehouse list, all of it added up", val(155),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$work_l", where='status = "open"')]),
  T("cancel the dentist", ask("dentist_jun", "dentist_aug"),
    ref=[act("cancel", kind="event", name="Dentist for Elias"),
         find(kind="event", name="Dentist for Elias"),
         askc("the one on the 10th of june or the one on the 19th of august?", options="$dentist_jun, $dentist_aug")]),
  T("oh wait, forget it, elias needs both of those check-ups so leave them exactly as they are",
    decline("never_mind"),
    ref=[dec("never_mind")]))

S("T22-140", "latest documents then unbounded typo then ask tick fritids fee never mind then sum tasks",
  T("my latest 2 documents", rows("scan_2", "scan_1", order=True),
    ref=[ans(kind="document", order="date desc", limit=2)]),
  T("wipe the wole vault", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("tick off pay the fritids fee", ask("fee_05", "fee_06", "fee_07"),
    ref=[act("complete", kind="task", name="Pay the fritids fee"),
         find(kind="task", name="Pay the fritids fee"),
         askc("may's, june's or the one due on the 28th of july?", options="$fee_05, $fee_06, $fee_07")]),
  T("no no, don't tick anything, ahmed pays the fee from his account on the 28th so just leave all of them",
    decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how many minutes of tasks are due on the twentieth of july altogether, ignor the ones i already finished",
    val(150),
    ref=[ans(op="sum", field="effort", kind="task", when=W(D("2026-07-20")), where='status = "open"')]))
