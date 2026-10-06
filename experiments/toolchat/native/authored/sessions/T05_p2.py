from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

OWE = 'direction = "i_owe" and status = "open"'

OWED = 'direction = "owes_me" and status = "open"'

LIVE = 'status = "open"'

def next_day_shift():
    return find(kind="event", name="ICU day shift", when=W({"from": U("day", 0)}), order="date asc", limit=1)

def home_open():
    return find(kind="task", linked_to="$homelist", where=LIVE)

S("T05-131-P", "recovery next day shift, surgery list min max sum para",
  T("carpool needs to know: time until my next day shift", rows("day_0120"),
    ref=[next_day_shift(), bad(next_day_shift()), ans(within="@prev")]),
  T("amma's surgery list, which remaining job is quickest, i've got five mins before the bus", val(5),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$surgerylist", where=LIVE), ans(value="@prev")]),
  T("longest remaining one, to block time for on my off day", rows("insurance_claim"),
    ref=[ans(kind="task", linked_to="$surgerylist", where=LIVE, order="effort desc", limit=1)]),
  T("whole surgery list in minutes, roughly, to squeeze around the interested relatives", val(110),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$surgerylist", where=LIVE), ans(value="@prev")]))

S("T05-135-P", "temple list sum max, cricket limit, tightest cadence para",
  T("temple committee work remaining in minutes, to see if i can do it in one go", val(105),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$templelist", where=LIVE), ans(value="@prev")]),
  T("biggest single job on it?", val(90),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$templelist", where=LIVE), ans(value="@prev")]),
  T("next two cricket nights, dates please, there's a lot of them and i keep mixing them up", rows("cric_0125", "cric_0208"),
    ref=[ans(kind="event", name="Cricket night at Vicky's", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("shortest catch up gap i've set, probably my parents, they're different to the rest", val(1),
    ref=[comp(op="min", field="cadence", kind="person"), ans(value="@prev")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T05-202-P", "ordinal last third weekend cancel reschedule para",
  T("upcoming night shifts", rows("night_0123", "night_0124", "night_0127", "night_0128", "night_0206", "night_0207"),
    ref=[ans(kind="event", name="night shift", when=W({"from": U("day", 0)}))]),
  T("last one needs cancelling, sowmya's swapping me", diff(upd("night_0207", status="cancelled")),
    ref=[act("cancel", rows="$night_0207")]),
  T("this weekend's schedule?", rows("tc_0124", "night_0124", "movie", "cric_0125"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]),
  T("make the third one 11 now", diff(upd("movie", date="2026-01-25T11:00")),
    ref=[act("reschedule", rows="$movie", args=lines(to=U("week", 0, weekday=7, time="11:00")))]))
