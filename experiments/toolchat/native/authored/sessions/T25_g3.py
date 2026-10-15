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
