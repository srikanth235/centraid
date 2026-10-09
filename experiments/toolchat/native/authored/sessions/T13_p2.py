from gold import *
import json
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
LIVE = 'status = "open"'
OWE = 'direction = "i_owe" and status = "open"'
def next_group():
    return find(kind="event", name="Lab group meeting", when=W({"from": U("day", 0)}), order="date asc", limit=1)
def badminton():
    return find(kind="event", name="Badminton", when=W(span(U("day", 0), U("month", 0))))
WEEKEND = W(span(U("week", 0, weekday=6), U("week", 0, weekday=7)))
def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T13-120-P", "reschedule event bare weekday at-n then scratch that undo para",
  T("dentist, monday at 9 would be better", diff(upd("dentist", date="2026-09-07T09:00")),
    ref=[act("reschedule", kind="event", name="Dentist appointment",
             args=lines(to=U("week", 1, weekday=1, time="09:00")))]),
  T("back to how it was, undo the dentist move", diff(upd("dentist", date="2026-09-14T08:30")),
    ref=[act("undo")]),
  T("gym induction at 8 please", diff(upd("gym", date="2026-09-07T08:00")),
    ref=[act("reschedule", kind="event", name="Gym induction", args=lines(to=U("day", 0, anchor="row", time="08:00")))]))

S("T13-126-P", "ask person log ngozi then star then text out of scope para",
  T("i messaged ngozi, log it", ask("aunty_ngozi", "ngozi_e"),
    ref=[act("log", kind="person", name="Ngozi", args=lines(kind="message")),
         askc("aunty ngozi okonkwo or ngozi eze?", options="$aunty_ngozi, $ngozi_e")]),
  T("the treasurer one, regarding fees", diff(upd("ngozi_e", date=ANY)),
    ref=[act("log", rows="$ngozi_e", args=lines(kind="message"))]),
  T("give her a star", diff(upd("ngozi_e", starred=True)),
    ref=[act("star", rows="$ngozi_e", kind="person")]),
  T("also text her, fees are due friday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T13-131-P", "recovery next lab group meeting then lab list min max sum para",
  T("next lab group meeting date? room needs booking", rows("group_0907"),
    ref=[next_group(), bad(next_group()), ans(within="@prev")]),
  T("shortest job still on the lab list, quikest", val(10),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$lab_l", where=LIVE)]),
  T("longest one, probably the xrd data", val(120),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$lab_l", where=LIVE)]),
  T("lab list in total time altogther, to see whether a weekend covers it", val(230),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$lab_l", where=LIVE), ans(value="@prev")]))

S("T13-136-P", "ask cancel flight never mind then latest notes limit then longest event para",
  T("flight is off, cancel it", ask("lisbon_out", "lisbon_back", "lagos_flight"),
    ref=[act("cancel", kind="event", name="Flight"),
         askc("lisbon out, lisbon back or the lagos one?", options="$lisbon_out, $lisbon_back, $lagos_flight")]),
  T("hold on, helen hasn't replied about the conference dates, so leave every one alone", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("newest three notse of mine", rows("conf_ideas", "glovebox_log", "xrd_notes", order=True),
    ref=[ans(kind="note", order="date desc", limit=3)]),
  T("this month's diary, longest event that hasn't been cancelled", val(420),
    ref=[ans(op="max", field="duration", kind="event", when=W(U("month", 0)), where='status != "cancelled"')]))

S("T13-201-P", "both xrd sessions reschedule prev linked para",
  T("upcoming xrd sessions?", rows("xrd_0908", "xrd_0915"),
    ref=[find(kind="event", name="XRD session", when=W({"from": U("day", 0)})), ans(rows="@prev")]),
  T("both should be at 3 instead", diff(upd("xrd_0908", date="2026-09-08T15:00"), upd("xrd_0915", date="2026-09-15T15:00")),
    ref=[act("reschedule", rows="@1", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("attendees for them", rows("raj"),
    ref=[ans(kind="person", linked_to="$xrd_0908, $xrd_0915")]))
