from gold import *

world("T08", "2026-04-06T17:50", "Deshawn Carter", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


OPEN = 'status = "open"'

S("T08-K001", "referent membership renew i3skill S1",
  T("show me the costco membership", rows("costco"),
    ref=[ans(kind="locker item", name="Costco")]),
  T("when does it renew", rows("costco"),
    ref=[ans(rows="$costco")]))

S("T08-K002", "referent count narrows priority i3skill S1",
  T("how many tasks are open on the reunion list", val(6),
    ref=[ans(kind="task", op="count", linked_to="$reunion_l", where=OPEN)]),
  T("how many are priority 2", val(2),
    ref=[ans(kind="task", op="count", linked_to="$reunion_l", where=OPEN + " and priority = 2")]))

S("T08-K003", "referent next event people it i3skill S1",
  T("when's the next dentist appointment", rows("dentist_jalen"),
    ref=[ans(kind="event", name="Dentist appointment", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("who's it for", rows("jalen", "dr_shah"),
    ref=[ans(kind="person", linked_to="$dentist_jalen")]))

S("T08-K004", "referent created task typed date i3skill S1",
  T("add a task renew the pavilion deposit", diff(new("task", name=has("pavilion", "deposit"))),
    ref=[act("create", args=lines(kind="task", name="Renew the pavilion deposit"))]),
  T("make it due the 15th", diff(upd("+1", date="2026-04-15")),
    ref=[act("reschedule", rows="$c1", args=lines(to=D("2026-04-15")))]))

S("T08-K005", "referent person him log i3skill S1",
  T("when did i last talk to marcus bell", rows("marcus_b"),
    ref=[ans(kind="person", name="Marcus Bell")]),
  T("log a coffee with him", diff(upd("marcus_b", date=ANY)),
    ref=[act("log", rows="$marcus_b", args=lines(kind="coffee"))]))

S("T08-K006", "referent folder then the noun star i3skill S1",
  T("what's in the taxes folder", rows("w2", "f1099", "return24"),
    ref=[ans(kind="document", linked_to="$taxes_f")]),
  T("star the 1099", diff(upd("f1099", starred=True)),
    ref=[act("star", rows="$f1099")]))

S("T08-K007", "referent due today that one i3skill S1",
  T("what's due today", rows("filter_apr"),
    ref=[ans(kind="task", where=OPEN, when=J(U("day", 0)))]),
  T("push that one to friday", diff(upd("filter_apr", date="2026-04-10")),
    ref=[act("reschedule", rows="$filter_apr", args=lines(to=U("week", 0, weekday=5)))]))

S("T08-K008", "perfect had this month i3skill S2",
  T("how many times has jalen had practice this month", val(1),
    ref=[ans(kind="event", op="count", name="football practice", when=J({"from": U("month", 0), "to": U("day", 0)}))]))

S("T08-K009", "single day friday saturday i3skill S2",
  T("what's on friday", rows("oncall_0410", "tax_appt"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=5)))]),
  T("and saturday", rows("haircut"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=6)))]))

S("T08-K010", "still in may ahead i3skill S2",
  T("is the lanier trip still in may", rows("lanier"),
    ref=[ans(kind="event", name="Lanier", when=J(U("month", 0, name=5)))]))

S("T08-K011", "duration hours effort i3skill S2",
  T("which tasks take over 2 hours", rows("osha", "nate", "slideshow"),
    ref=[ans(kind="task", where="effort > 120")]))

S("T08-K012", "cadence three weeks i3skill S2",
  T("who's on a three week cadence", rows("darnell", "trey"),
    ref=[ans(kind="person", where="cadence = 21 days")]))

S("T08-K013", "read not write water bill i3skill S3",
  T("did i pay the water bill", rows("water_01", "water_02", "water_03", "water_04"),
    ref=[ans(kind="task", name="Pay water bill")]))

S("T08-K014", "read debt i owe kevin i3skill S3",
  T("did i pay kevin for the ladder", rows("d_kevin"),
    ref=[ans(kind="debt", name="ladder")]))

S("T08-K015", "read cancelled softball i3skill S3",
  T("was the softball game cancelled", rows("softball"),
    ref=[ans(kind="event", name="softball")]))

S("T08-K016", "read then write timesheet i3skill S3",
  T("has the april timesheet been submitted", rows("ts_apr"),
    ref=[ans(kind="task", name="Submit timesheet", when=J(U("month", 0, name=4)))]),
  T("yeah it went in, mark it done", diff(upd("ts_apr", status="completed", completed=ANY)),
    ref=[act("complete", rows="$ts_apr")]))

S("T08-K017", "read starred of them memberships i3skill S3",
  T("what memberships do i have", rows("costco", "union_card"),
    ref=[ans(kind="locker item", where='type = "membership"')]),
  T("which of them are starred", rows("union_card"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T08-K018", "read trashed did i delete i3skill S3",
  T("did i delete the gym task", rows("gym_cancel"),
    ref=[ans(kind="task", name="gym", trashed=True)]))

S("T08-K019", "read debt two follow i3skill S3",
  T("has trey paid me for the hawks tickets", rows("d_trey"),
    ref=[ans(kind="debt", name="Hawks tickets")]),
  T("and dre's shirt deposit", rows("d_dre"),
    ref=[ans(kind="debt", name="Reunion shirt deposit")]))

S("T08-K020", "no invention task description search i3skill S4",
  T("mark the royal blue one as done", diff(upd("shirts", status="completed", completed=ANY)),
    ref=[search("royal blue", kind="task"), act("complete", rows="$shirts")]))

S("T08-K021", "no invention note body search pin i3skill S4",
  T("pin the one that says no glass", diff(upd("pavilion_notes", pinned=True)),
    ref=[search("no glass", kind="note"), act("edit", rows="$pavilion_notes", args=lines(pinned="yes"))]))

S("T08-K022", "no invention role dispatcher log i3skill S4",
  T("log a message to the dispatcher", diff(upd("sheila", date=ANY)),
    ref=[act("log", kind="person", where='role contains "dispatcher"', args=lines(kind="message"))]))

S("T08-K023", "no invention role property manager log i3skill S4",
  T("log a call with the property manager", diff(upd("gloria", date=ANY)),
    ref=[act("log", kind="person", where='role = "property manager"', args=lines(kind="call"))]))

S("T08-K024", "no invention missing list name ask i3skill S4",
  T("make a new list", ask(),
    ref=[askc("What should the list be called?")]))

S("T08-K025", "no invention note body search read i3skill S4",
  T("which note mentions the float switch", rows("franklin"),
    ref=[search("float switch", kind="note"), ans(rows="$franklin")]))

S("T08-K026", "no invention task description search overtime i3skill S4",
  T("complete the overtime rotation one", diff(upd("grievance", status="completed", completed=ANY)),
    ref=[search("overtime rotation", kind="task"), act("complete", rows="$grievance")]))

S("T08-K027", "referent debt that one i3skill S1",
  T("what's the biggest debt i owe", rows("d_mama"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"', order="amount desc", limit=1)]),
  T("what's that for", rows("d_mama"),
    ref=[ans(rows="$d_mama")]))

S("T08-K028", "read starred named row i3skill S3",
  T("is the union card starred", rows("union_card"),
    ref=[ans(kind="locker item", name="Union membership card")]))

S("T08-K029", "read confirmed physical tentative i3skill S3",
  T("is jalen's sports physical confirmed", rows("physical"),
    ref=[ans(kind="event", name="sports physical")]))
