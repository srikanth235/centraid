from gold import *
import json

world("T05", "2026-01-20T06:40", "Priya Raman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


LIVE = 'status = "open"'


def next_day_shift():
    return find(kind="event", name="ICU day shift", when=W({"from": U("day", 0)}), order="date asc", limit=1)


def home_open():
    return find(kind="task", linked_to="$homelist", where=LIVE)


S("T05-131", "recovery next day shift, surgery list min max sum",
  T("how long till my next day shift, need to tell the carpool", rows("day_0120"),
    ref=[next_day_shift(), bad(next_day_shift()), ans(within="@prev")]),
  T("what's the quickest thing left on amma's surgery list, i've got five mins before the bus", val(5),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$surgerylist", where=LIVE), ans(value="@prev")]),
  T("and which one's the longest, the one i should block time for on my off day", rows("insurance_claim"),
    ref=[ans(kind="task", linked_to="$surgerylist", where=LIVE, order="effort desc", limit=1)]),
  T("how many minuts is the whole surgery list, roughly, i'll have to squeeze it around the intrested relatives", val(110),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$surgerylist", where=LIVE), ans(value="@prev")]))

S("T05-135", "temple list sum max, cricket limit, tightest cadence",
  T("how many minutes of temple commitee work is left, i want to see if i can do it in one go", val(105),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$templelist", where=LIVE), ans(value="@prev")]),
  T("what's the longest single job on it", val(90),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$templelist", where=LIVE), ans(value="@prev")]),
  T("when are the next two cricket nights, i keep mixing up the dates and it's alot of them", rows("cric_0125", "cric_0208"),
    ref=[ans(kind="event", name="Cricket night at Vicky's", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("what's the shortest catch up gap i've set for anyone, i think its my parents, they're diffrent to the rest", val(1),
    ref=[comp(op="min", field="cadence", kind="person"), ans(value="@prev")]))

S("T05-140", "icu list limit, pay ask never-mind, wipe locker",
  T("whic two things on the ICU list are due first", rows("leave", "farhan_card"),
    ref=[ans(kind="task", linked_to="$iculist", where=LIVE, order="date asc", limit=2)]),
  T("tick off pay", ask("eb_jan", "selvi_pay", "tax", "lic_02"),
    ref=[act("complete", kind="task", name="Pay"),
         find(kind="task", name="Pay", where=LIVE),
         askc("EB bill, Selvi's salary, property tax or the LIC premium?", options="@prev")]),
  T("wait, i haven't paid any of them yet, the app's down, so leave it all as it is", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("i want to wipe evrything in the locker, every login, card and pin, i'm switching phones tomorrow", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))
