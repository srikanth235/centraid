from gold import *
import json

world("T25", "2026-10-11T18:45", "Yuki Tanaka", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


FROM_TODAY = {"from": U("day", 0)}

# recovery: a find with order and limit sent twice, then answered from its result
work_notes = find(kind="note", linked_to="$work_nb", order="date desc", limit=2)
S("T25-131", "recovery find order limit note repeat answer min effort sum typo",
  T("the last couple of notes i saved in the work notebook", rows("talking_points", "one_on_one_n"),
    ref=[work_notes, bad(work_notes), ans(within="@prev")]),
  T("ten minutes before mika's home, what's the quickest thing on her list that's still open", val(5),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$mika_l", where='status = "open"'),
         ans(value="@prev")]),
  T("total effort left on the divorse admin list", val(80),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$legal_l", where='status = open'),
         ans(value="@prev")]))

# recovery twice: the hint, then the nudge, then an answer
piano_three = find(kind="event", name="Piano lesson", when=FROM_TODAY, order="date asc", limit=3)
S("T25-132", "recovery twice find order limit event answer sum duration max min typo",
  T("next three piano lessons", rows("piano_1014", "piano_1021", "piano_1028"),
    ref=[piano_three, bad(piano_three), bad(piano_three), ans(within="@prev")]),
  T("how many minutes of theraphy do i have between now and the end of november, all of it added up", val(150),
    ref=[comp(op="sum", field="duration", kind="event", name="Therapy",
              when=span(U("day", 0), U("month", 0, name=11))),
         ans(value="@prev")]),
  T("what's the longest thing on my calendar in november, i want to keep one afternoon free", val(180),
    ref=[comp(op="max", field="duration", kind="event", when=U("month", 0, name=11)),
         ans(value="@prev")]),
  T("smallest effot left on the hiking list", val(20),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$hike_l", where='status = open'),
         ans(value="@prev")]))

S("T25-133", "limit then min within max debt i owe sum daniel",
  T("which of the next three things on my calendar is the shortest", rows("one_on_one"),
    ref=[find(kind="event", when=FROM_TODAY, order="date asc", limit=3),
         ans(within="@prev", order="duration asc", limit=1)]),
  T("bigegst amount i owe any one person", val((300, "CAD")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'),
         ans(value="@prev")]),
  T("how much has daniel run up with me in total, the camp and the boots both, so i can send him one number", val((244.5, "CAD")),
    ref=[comp(op="sum", field="amount", kind="debt", linked_to="$daniel", where='direction = "owes_me" and status = "open"'),
         ans(value="@prev")]))

S("T25-134", "ask options task reschedule never mind max debt limit min within",
  T("the expense report has to land on friday now, shift it", ask("expense_1", "expense_2"),
    ref=[act("reschedule", kind="task", name="Submit expense report", args=lines(to=U("week", 1, weekday=5))),
         find(kind="task", name="Submit expense report"),
         askc("the one due november 6th or the one from the 9th that's already done?", options="$expense_1, $expense_2")]),
  T("hold off, i'll ask sarah at work whether she needs the report earlier before i push anything around", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's the priciest thing i've got open with anyone, either way, i want to see the big number", val((300, "CAD")),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"'),
         ans(value="@prev")]),
  T("the smallest of the three longest open taks", val(180),
    ref=[find(kind="task", where='status = "open"', order="effort desc", limit=3),
         comp(op="min", field="effort", within="@prev"),
         ans(value="@prev")]))

S("T25-135", "sum debts since october max home task min next week limit two",
  T("how much do people owe me since the first of october, friends and coworkers both", val((98.5, "CAD")),
    ref=[comp(op="sum", field="amount", kind="debt", where='direction = "owes_me" and status = "open"',
              when={"from": D("2026-10-01")}),
         ans(value="@prev")]),
  T("biggest eefort on my home list", val(90),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$home_l", where='status = "open"'),
         ans(value="@prev")]),
  T("of everything due next week what's the quickest one, i want to knock it out first", val(5),
    ref=[comp(op="min", field="effort", kind="task", when=U("week", 1), where='status = open'),
         ans(value="@prev")]),
  T("of the two open tasks due first which is the longr one", val(15),
    ref=[find(kind="task", where='status = "open"', order="date asc", limit=2),
         comp(op="max", field="effort", within="@prev"),
         ans(value="@prev")]))

S("T25-136", "ask cross-kind delete never mind limit sum min hike",
  T("delete the boots receipt", ask("boots_receipt", "boots_p"),
    ref=[askc("the winter boots receipt document or the boots receipt photo?", options="$boots_receipt, $boots_p")]),
  T("leave both, i'll figure out which one to clear when i'm back at my laptop tomorrow", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("add up the two smallest amounts anyone owes me", val((34, "CAD")),
    ref=[find(kind="debt", where='direction = "owes_me" and status = "open"', order="amount asc", limit=2),
         comp(op="sum", field="amount", within="@prev"),
         ans(value="@prev")]),
  T("what's the shortest hike i've got on the books, cancelled ones don't count", val(120),
    ref=[comp(op="min", field="duration", kind="event", name="Hike", where='status != "cancelled"'),
         ans(value="@prev")]))

S("T25-137", "unbounded photos ask cross-kind never mind unbounded calendar",
  T("delete every foto i have, i'm done with the clutter and the storage warnings", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("delete the hiking one", ask("hike_l", "hike_nb"),
    ref=[askc("the hiking list or the hiking notebook?", options="$hike_l, $hike_nb")]),
  T("actually leave them, i still need the trail notes and the tasks for tremblant nex weekend", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("clear the whole calendar so i can start fresh after the holidays, every single event", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T25-138", "limit person last contacted unbounded tasks min cadence max in progress",
  T("the last three people i got in touch with, typing fast", rows("hiroko", "daniel", "priya"),
    ref=[ans(kind="person", order="date desc", limit=3)]),
  T("delete all my tasks, honestly the whole list is dead weight now, every one of them", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("fewest days between check-ins i set for anyone, cadense wise", val(7),
    ref=[ans(op="min", field="cadence", kind="person")]),
  T("biggest effort among my in progress stuff, i need to know if i can finish it before the week is over", val(240),
    ref=[comp(op="max", field="effort", kind="task", where='status = "in_progress"'),
         ans(value="@prev")]))

S("T25-139", "limit book club limit photos ask cross-kind star never mind",
  T("when's the next book club", rows("book_10"),
    ref=[ans(kind="event", name="Book club", when=FROM_TODAY, order="date asc", limit=1)]),
  T("the four newst photos", rows("grandma", "airport", "pumpkin", "latte"),
    ref=[ans(kind="photo", order="date desc", limit=4)]),
  T("star the passport", ask("passport", "passport_app"),
    ref=[askc("your canadian passport in the locker or mika's passport application?", options="$passport, $passport_app")]),
  T("nvm, don't star either one, i'll sort the passwrod stuff out when mika's application comes back", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T25-140", "limit hiking note unbounded people sum piano max october",
  T("my latst hiking note", rows("tremblant_pack"),
    ref=[ans(kind="note", linked_to="$hike_nb", order="date desc", limit=1)]),
  T("delete all my contcts, every single person, i'm starting over", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("how many minutes of piano lessns does mika have in october, added together", val(180),
    ref=[comp(op="sum", field="duration", kind="event", name="Piano lesson", when=U("month", 0, name=10)),
         ans(value="@prev")]),
  T("and the longest single event that month", val(1560),
    ref=[comp(op="max", field="duration", kind="event", when=U("month", 0, name=10)),
         ans(value="@prev")]))
