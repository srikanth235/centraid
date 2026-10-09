from gold import *
import json

world("T10", "2026-06-19T14:20", "Bashir Haddad", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# 201 "all three" after a three-row result
S("T10-201", "all three tasks due span reschedule prev bare weekday",
  T("what's due today and tomorrow", rows("leak", "sat_task", "ac"),
    ref=[ans(kind="task", when=W(span(U("day", 0), U("day", 1))))]),
  T("push all three to monday", diff(upd("leak", date="2026-06-22"), upd("sat_task", date="2026-06-22"), upd("ac", date="2026-06-22")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]),
  T("what's due monday now", rows("call_dana", "leak", "gas", "sat_task", "lecture_q", "ac"),
    ref=[ans(kind="task", when=W(U("week", 1, weekday=1)))]))

# 202 ordinals after a listing, and a number picked from an ask
S("T10-202", "ordinal second mosque list complete ask pick physio at 11",
  T("what's on the mosque list", rows("statement_may", "receipts", "quotes", "pledges", "statement", "ablution"),
    ref=[ans(kind="task", linked_to="$mosque_l")]),
  T("the 27th one is done, all the pledges are in", diff(upd("pledges", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pledges")]),
  T("move physio to 11", ask("physio_0622", "physio_0629", "physio_0706"),
    ref=[act("reschedule", kind="event", name="Physiotherapy session", when=W({"from": U("day", 0)}), args=lines(to=U("day", 0, anchor="row", time="11:00"))),
         askc("1 monday the 22nd, 2 the 29th or 3 july 6th?", options="$physio_0622, $physio_0629, $physio_0706")]),
  T("3 is fine", diff(upd("physio_0706", date="2026-07-06T11:00")),
    ref=[act("reschedule", rows="$physio_0706", args=lines(to=U("day", 0, anchor="row", time="11:00")))]))

# 203 which way the money goes
# 204 everything but the last one
S("T10-204", "except exclude last one chess nights cancel status",
  T("chess club nights in july", rows("chess_0707", "chess_0714", "chess_0721", "chess_0728"),
    ref=[ans(kind="event", name="Chess club night", when=W(U("month", 0, name=7)))]),
  T("cancel them all except the last one", diff(upd("chess_0707", status="cancelled"), upd("chess_0714", status="cancelled"), upd("chess_0721", status="cancelled")),
    ref=[find(kind="event", within="@prev", exclude="$chess_0728"), act("cancel", rows="@prev")]),
  T("which ones are still on", rows("chess_0728"),
    ref=[ans(kind="event", name="Chess club night", when=W(U("month", 0, name=7)), where='status != "cancelled"')]))

# 205 bare weekdays, "at N", a relative range
S("T10-205", "bare weekday at N dentist ac range create saturday",
  T("move the dentist to thursday at 11", diff(upd("dentist", date="2026-06-25T11:00")),
    ref=[act("reschedule", kind="event", name="Dentist appointment", args=lines(to=U("week", 1, weekday=4, time="11:00")))]),
  T("and the ac guy to monday at 2", diff(upd("ac_service", date="2026-06-22T14:00")),
    ref=[search("ac guy", kind="event"),
         act("reschedule", kind="event", name="AC technician visit", args=lines(to=U("week", 1, weekday=1, time="14:00")))]),
  T("monday through wednesday next week, anything scheduled", rows("physio_0622", "huda_visit", "ac_service", "lecture", "blood_test", "site_visit", "chess_0623"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]),
  T("call huda saturday at 5", diff(new("event", name=has("huda"), date="2026-06-20T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Huda", date=U("week", 0, weekday=6, time="17:00")))]))

# 206 two writes in one message
