from gold import *
import json

world("T26", "2026-11-24T05:30", "Ahmed Bello", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


FROM_TODAY = {"from": U("day", 0)}

# recovery: a find with order and limit sent twice, then answered from its result
house_notes = find(kind="note", linked_to="$house_nb", order="date desc", limit=2)
S("T26-131", "recovery find order limit note repeat answer min effort sum typo",
  T("the last two notes i put in the house build notebook", rows("block_count", "socket_plan"),
    ref=[house_notes, bad(house_notes), ans(within="@prev")]),
  T("i've got fifteen minutes before the school run, what's the quickest thing still open on the kids school list", val(20),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$kids_l", where='status = "open"'),
         ans(value="@prev")]),
  T("total effort on the shoppin list", val(165),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$shop_l", where='status = open'),
         ans(value="@prev")]))

# recovery twice: the hint, then the nudge, then an answer
house_open = find(kind="task", linked_to="$house_l", where='status = "open"', order="date asc", limit=3)
S("T26-132", "recovery twice find order limit task answer sum duration max min typo",
  T("next three open tasks on the house build list", rows("roofing", "instalment", "tiles"),
    ref=[house_open, bad(house_open), bad(house_open), ans(within="@prev")]),
  T("how many minutes will i spend at site vists with olumide this month altogether", val(360),
    ref=[comp(op="sum", field="duration", kind="event", name="Site visit with Olumide", when=U("month", 0)),
         ans(value="@prev")]),
  T("what's the longest thing i've got in december, i want to keep that whole day clear", val(480),
    ref=[comp(op="max", field="duration", kind="event", when=U("month", 0, name=12)),
         ans(value="@prev")]),
  T("smallest effrot on the offshore list", val(15),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$rig_l", where='status = "open"'),
         ans(value="@prev")]))

S("T26-133", "limit then min within max debt i owe sum owed to me",
  T("which of my next four events is the shortest", rows("dentist_femi"),
    ref=[find(kind="event", when=FROM_TODAY, order="date asc", limit=4),
         ans(within="@prev", order="duration asc", limit=1)]),
  T("biggset amount i owe anybody", val((250000, "NGN")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'),
         ans(value="@prev")]),
  T("what's the total of everyone who owes me money right now, i want to plan the christmas budget", val((415000, "NGN")),
    ref=[comp(op="sum", field="amount", kind="debt", where='direction = "owes_me" and status = "open"'),
         ans(value="@prev")]))

S("T26-134", "ask options event reschedule never mind max debt limit min within",
  T("push the handover call with segun to 7", ask("handover_1", "handover_2"),
    ref=[act("reschedule", kind="event", name="Handover call with Segun", args=lines(to=U("day", 0, anchor="row", time="19:00"))),
         find(kind="event", name="Handover call with Segun"),
         askc("the one on the 13th or the one on december 9th?", options="$handover_1, $handover_2")]),
  T("actually hold on, let me check with segun whether he can even do the evening before i touch anything", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's the biggest single amount open between me and anyone, either way, i want the big number", val((250000, "NGN")),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"'),
         ans(value="@prev")]),
  T("of the three biggest things i owe which is the smallest", rows("d_sunday"),
    ref=[find(kind="debt", where='direction = "i_owe" and status = "open"', order="amount desc", limit=3),
         ans(within="@prev", order="amount asc", limit=1)]))

S("T26-135", "sum lent since november max kids task min next week limit two",
  T("how much have i lent out since the first of november, crew and site people both", val((105000, "NGN")),
    ref=[comp(op="sum", field="amount", kind="debt", where='direction = "owes_me" and status = "open"',
              when={"from": D("2026-11-01")}),
         ans(value="@prev")]),
  T("biggest effort on the kids list", val(60),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$kids_l", where='status = "open"'),
         ans(value="@prev")]),
  T("of everything due next week what's the quickest one, i want to knock it out before the flight", val(15),
    ref=[comp(op="min", field="effort", kind="task", when=U("week", 1), where='status = open'),
         ans(value="@prev")]),
  T("of the two open tasks due first which one is the longset", val(40),
    ref=[find(kind="task", where='status = "open"', order="date asc", limit=2),
         comp(op="max", field="effort", within="@prev"),
         ans(value="@prev")]))

S("T26-136", "ask cross-kind star never mind limit sum min december",
  T("star the passport", ask("passport", "passport_scan"),
    ref=[askc("your nigerian passport in the locker or the passport scan document?", options="$passport, $passport_scan")]),
  T("skip it, i'll do both properly when i'm at the desk with the physical copy tonight", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("add up the two smallest amounts anyone owes me", val((35000, "NGN")),
    ref=[find(kind="debt", where='direction = "owes_me" and status = "open"', order="amount asc", limit=2),
         comp(op="sum", field="amount", within="@prev"),
         ans(value="@prev")]),
  T("what's the shortest thing on the calendar in december, cancelled ones don't count", val(30),
    ref=[comp(op="min", field="duration", kind="event", when=U("month", 0, name=12), where='status != "cancelled"'),
         ans(value="@prev")]))

S("T26-137", "unbounded notes ask cross-kind never mind unbounded vault",
  T("wipe all my notes, every notebok, i'm done with the lot and starting fresh", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("delete the house build one", ask("house_l", "house_nb", "house_f"),
    ref=[askc("the house build list, notebook or folder?", options="$house_l, $house_nb, $house_f")]),
  T("no leave them all, the drawings and the block count are still in there and i need them for the bank", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("clear out everything in the vault, every event and task and note, i'm starting over in january", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T26-138", "limit person last contacted unbounded debts min cadence max in progress",
  T("the last three people i spoke to, typing fast", rows("mama", "ngozi", "aisha"),
    ref=[ans(kind="person", order="date desc", limit=3)]),
  T("delete all my debts, i'm sick of the whole ledger, every one of them", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("fewest days between check-ins i set for anyone, cadense wise", val(3),
    ref=[ans(op="min", field="cadence", kind="person")]),
  T("biggest effort among my in progress stuff, i need to know if i can finish it before i fly out", val(2400),
    ref=[comp(op="max", field="effort", kind="task", where='status = "in_progress"'),
         ans(value="@prev")]))

S("T26-140", "limit offshore note unbounded people sum football max november",
  T("my ltaest note in the offshore log", rows("handover_n"),
    ref=[ans(kind="note", linked_to="$offshore_nb", order="date desc", limit=1)]),
  T("delete all my conatcts, every single person, i'm starting over", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("how many minutes of footbal does dayo have this month, added together", val(270),
    ref=[comp(op="sum", field="duration", kind="event", name="Football", when=U("month", 0)),
         ans(value="@prev")]),
  T("and the longest one that month, not counting cancelled ones", val(240),
    ref=[comp(op="max", field="duration", kind="event", when=U("month", 0), where='status != "cancelled"'),
         ans(value="@prev")]))
