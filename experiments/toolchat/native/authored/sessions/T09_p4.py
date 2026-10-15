from gold import *
import json

world("T09", "2026-05-13T08:05", "Hanae Okafor", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# 201 "both" after a two-row result, found through a nickname
# 202 ordinals after a listing, and a number picked from an ask
S("T09-202", "ordinal second condo list complete ask pick bar prep at 7",
  T("condo list, what's there", rows("agm_notice", "repaint", "reserve", "bike_room", "minutes_apr"),
    ref=[ans(kind="task", linked_to="$condo_list")]),
  T("the second one is done, ravi sent all three", diff(upd("repaint", status="completed", completed=ANY)),
    ref=[act("complete", rows="$repaint")]),
  T("push bar prep to 7", ask("bp_0519", "bp_0526", "bp_0602"),
    ref=[act("reschedule", kind="event", name="Bar prep session", when=W({"from": U("day", 0)}), args=lines(to=U("day", 0, anchor="row", time="19:00"))),
         askc("1 the 19th, 2 the 26th or 3 june 2nd?", options="$bp_0519, $bp_0526, $bp_0602")]),
  T("3 is fine", diff(upd("bp_0602", date="2026-06-02T19:00")),
    ref=[act("reschedule", rows="$bp_0602", args=lines(to=U("day", 0, anchor="row", time="19:00")))]))

# 204 everything but two
# 205 bare weekdays, "at N", a relative range
S("T09-205", "bare weekday at N cake florist range create call today",
  T("move the cake tasting to sunday at 2", diff(upd("cake", date="2026-05-17T14:00")),
    ref=[act("reschedule", kind="event", name="Cake tasting", args=lines(to=U("week", 0, weekday=7, time="14:00")))]),
  T("and the florist consult to monday at 12", diff(upd("florist", date="2026-05-18T12:00")),
    ref=[act("reschedule", kind="event", name="Florist consult", args=lines(to=U("week", 1, weekday=1, time="12:00")))]),
  T("what do i have monday to wednesday next week", rows("florist", "hearing", "elevator", "bp_0519", "priya_lunch", "wcall_0520"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]),
  T("call obaachan at 5", diff(new("event", name=has("obaachan"), date="2026-05-13T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Obaachan", date=U("day", 0, time="17:00")))]))

# 206 two writes in one message