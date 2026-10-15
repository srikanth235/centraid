from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
def J(d):
    return json.dumps(d, separators=(",", ":"))
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
LIVE = 'status = "open"'
LIVE_EV = 'status != "cancelled"'
def next_prod():
    return find(kind="event", name="Weekly production meeting", when=W({"from": U("day", 0)}), order="date asc", limit=1)
def nets():
    return find(kind="event", name="Tigers net practice", when=W({"from": U("day", 0)}))


S("T16-122-P", "decline out_of_scope bus ticket then reschedule date then priority para",
  T("get me a green line bus ticket for the 28th", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("bus tickets task, make it the 27th", diff(upd("tickets", date="2026-12-27")),
    ref=[act("reschedule", kind="task", name="Book bus tickets for Cox's Bazar", args=lines(to=D("2026-12-27")))]),
  T("set its priority to top", diff(upd("tickets", priority=1)),
    ref=[act("edit", rows="$tickets", args=lines(priority=1))]),
  T("land deed copy in the locker gets a star", diff(upd("deed_copy", starred=True)),
    ref=[act("star", kind="locker item", name="Land deed copy")]))

S("T16-128-P", "reopen task then reschedule then scratch undo para",
  T("hr says the numbers were wrong, so reopen the november overtime list", diff(upd("overtime_nov", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Submit overtime list for November")]),
  T("make it due tomorrow", diff(upd("overtime_nov", date="2026-12-17")),
    ref=[act("reschedule", rows="$overtime_nov", args=lines(to=U("day", 1)))]),
  T("back to the old due date, undo", diff(upd("overtime_nov", date="2026-11-30")),
    ref=[act("undo")]))

S("T16-133-P", "ask cancel fire drill never mind then cricket list min max para",
  T("fire drill is off, cancel it", ask("fire_drill", "fire_drill_nov"),
    ref=[act("cancel", kind="event", name="Fire drill"),
         find(kind="event", name="Fire drill"),
         askc("the one on the 23rd or the november one?", options="$fire_drill, $fire_drill_nov")]),
  T("hold on, keep it, the buyer wants the drill records at the audt", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("cricket list's shortest job, smllest? waiting for the bus", val(15),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$cricket_l", where=LIVE)]),
  T("longest there", val(30),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$cricket_l", where=LIVE)]))
