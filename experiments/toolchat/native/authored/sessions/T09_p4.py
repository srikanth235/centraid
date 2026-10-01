from gold import *
import json

world("T09", "2026-05-13T08:05", "Hanae Okafor", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# 201 "both" after a two-row result, found through a nickname
S("T09-201", "both debts nickname search settle prev owes me collect",
  T("what's ada got outstanding with me", rows("d_ada", "d_ada2"),
    ref=[search("Ada", kind="person"), ans(kind="debt", linked_to="$ada")]),
  T("she sent it, settle those two", diff(upd("d_ada", status="settled"), upd("d_ada2", status="settled")),
    ref=[act("settle_debt", rows="@prev")]),
  T("who else owes me", rows("d_kemi", "d_priya_r", "d_aiden", "d_jordan_l", "d_mom"),
    ref=[ans(kind="debt", where='direction = "owes_me" and status = "open"')]))

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

# 203 which way the money goes: the sign flips after a debt I create
S("T09-203", "debts owe direction balance flip create i_owe settle mine",
  T("where am i with fatou", val((12, "CAD")),
    ref=[ans(op="balance", kind="person", name="Fatou Diallo")]),
  T("she covered my lunch, i owe her 15", diff(new("debt", name=has("lunch"), amount=15, direction="i_owe"), link("new", "fatou")),
    ref=[act("create", args=lines(kind="debt", name="Lunch", person="$fatou", amount="15", direction="i_owe"))]),
  T("and now?", val((-3, "CAD")),
    ref=[ans(op="balance", rows="$fatou")]),
  T("settle mine with ethan too, e-transferred him", diff(upd("d_ethan", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$ethan", where='direction = "i_owe"')]))

# 204 everything but two
S("T09-204", "except exclude two tasks bar prep reschedule week shift",
  T("what's still open on the bar prep list", rows("index_fatou", "boardroom", "mark_essays", "ethics_hypo", "mock_exam"),
    ref=[ans(kind="task", linked_to="$bar_list")]),
  T("push them all a week except the index and the mock exam",
    diff(upd("boardroom", date="2026-05-22"), upd("mark_essays", date="2026-05-25"), upd("ethics_hypo", date="2026-05-26")),
    ref=[find(kind="task", within="@prev", exclude="$index_fatou, $mock_exam"),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, anchor="row")))]),
  T("left this week?", rows("index_fatou"),
    ref=[ans(kind="task", linked_to="$bar_list", when=W(U("week", 0)))]))

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
S("T09-206", "two writes settle debt complete star document",
  T("paid marcus for the raptors tickets and i booked the boardroom", diff(upd("d_marcus", status="settled"), upd("boardroom", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="Raptors tickets", more=True),
         act("complete", kind="task", name="Book boardroom for June sessions")]),
  T("stamps are bought and star the photographer contract", diff(upd("stamps", status="completed", completed=ANY), upd("photo_contract", starred=True)),
    ref=[act("complete", kind="task", name="Buy stamps", more=True),
         act("star", kind="document", name="Photographer contract")]),
  T("total debt i'm carrying right now", val((2046.5, "CAD")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))
