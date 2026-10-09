from gold import *

world("T02", "2027-06-08T11:05", "Mei-Lin Chau", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


OPEN = 'status = "open"'

S("T02-K001", "referent membership renew i3skill S1",
  T("show me the hive membership", rows("hive"),
    ref=[ans(kind="locker item", name="Hive")]),
  T("when does it renew", rows("hive"),
    ref=[ans(rows="$hive")]))

S("T02-K002", "referent count narrows priority i3skill S1",
  T("how many open tasks are on the client work list", val(8),
    ref=[ans(kind="task", op="count", linked_to="$clientwork", where=OPEN)]),
  T("how many are priority 1", val(2),
    ref=[ans(kind="task", op="count", linked_to="$clientwork", where=OPEN + " and priority = 1")]))

S("T02-K003", "referent created task reschedule i3skill S1",
  T("add a task call ben about the radiator", diff(new("task", name=has("ben", "radiator"))),
    ref=[act("create", args=lines(kind="task", name="Call Ben about the radiator"))]),
  T("move it to friday", diff(upd("+1", date="2027-06-11")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 0, weekday=5)))]))

S("T02-K004", "referent next event cancel it i3skill S1",
  T("when's the next dim sum", rows("dimsum_jun"),
    ref=[ans(kind="event", name="Dim sum", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("cancel it", diff(upd("dimsum_jun", status="cancelled")),
    ref=[act("cancel", rows="$dimsum_jun")]))

S("T02-K005", "referent count debts narrows direction i3skill S1",
  T("how many open debts do i have", val(9),
    ref=[ans(kind="debt", op="count", where='status = "open"')]),
  T("how many are owed to me", val(5),
    ref=[ans(kind="debt", op="count", where='status = "open" and direction = "owes_me"')]))

S("T02-K006", "perfect did i this month i3skill S2",
  T("how many times did i climb at the hive this month", val(1),
    ref=[ans(kind="event", op="count", name="Climbing at The Hive", when=J({"from": U("month", 0), "to": U("day", 0)}))]))

S("T02-K007", "single day friday saturday i3skill S2",
  T("what's on friday", rows("portfolio_review"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=5)))]),
  T("and saturday", rows("gallery", "farmers"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=6)))]))

S("T02-K008", "still in july ahead i3skill S2",
  T("are the tokyo flights still in july", rows("flight_out", "flight_back"),
    ref=[ans(kind="event", name="flight", when=J(U("month", 0, name=7)))]))

S("T02-K009", "duration hours effort i3skill S2",
  T("which tasks take longer than 4 hours", rows("tide_final", "mf_spots"),
    ref=[ans(kind="task", where="effort > 240")]),
  T("and the ones under 20 minutes", rows("glaze_order"),
    ref=[ans(kind="task", where="effort < 20")]))

S("T02-K010", "cadence weeks days i3skill S2",
  T("who do i keep up with every two weeks", rows("kai", "dad"),
    ref=[ans(kind="person", where="cadence = 14 days")]))

S("T02-K011", "relation to event dates line i3skill S2",
  T("what's left on the flat list before the dentist", rows("hydro", "soap_1", "tap"),
    ref=[ans(kind="task", linked_to="$flatlist", where=OPEN, when=J({"to": D("2027-06-17")}))]))

S("T02-K012", "read not write sent pdf i3skill S3",
  T("did i send rachel the portfolio pdf", rows("rachel_followup"),
    ref=[ans(kind="task", name="portfolio PDF")]))

S("T02-K013", "read debt paid two i3skill S3",
  T("has marcus paid the greenleaf deposit", rows("d_gl"),
    ref=[ans(kind="debt", name="Greenleaf deposit")]),
  T("and tomo's kill fee", rows("d_tomo"),
    ref=[ans(kind="debt", name="kill fee")]))

S("T02-K014", "read cancelled launch i3skill S3",
  T("did the tomo launch get cancelled", rows("tomo_launch"),
    ref=[ans(kind="event", name="Tomo Coffee launch")]))

S("T02-K015", "read starred of them logins i3skill S3",
  T("what logins have i got", rows("adobe", "gmail", "etsy"),
    ref=[ans(kind="locker item", where='type = "login"')]),
  T("which of them are starred", rows("adobe"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T02-K016", "read then write hydro i3skill S3",
  T("is the hydro bill paid", rows("hydro"),
    ref=[ans(kind="task", name="hydro")]),
  T("no, tick it off, just did it", diff(upd("hydro", status="completed", completed=ANY)),
    ref=[act("complete", rows="$hydro")]))

S("T02-K017", "no invention task description search i3skill S4",
  T("push the autumn issue task to next friday", diff(upd("mf_spots", date="2027-06-18")),
    ref=[search("autumn issue", kind="task"), act("reschedule", rows="$mf_spots", args=lines(to=U("week", 1, weekday=5)))]))

S("T02-K018", "no invention note body search delete i3skill S4",
  T("delete the note about the crow postmaster", diff(trash("idea_crow")),
    ref=[search("crow postmaster", kind="note"), act("delete", rows="$idea_crow")]))

S("T02-K019", "no invention role landlord log i3skill S4",
  T("log a call with the landlord", diff(upd("ben", date=ANY)),
    ref=[act("log", kind="person", where='role = "landlord"', args=lines(kind="call"))]))

S("T02-K020", "no invention missing details ask i3skill S4",
  T("make a new event for friday", ask(),
    ref=[askc("What should the event be called, and what time?")]))

S("T02-K021", "no invention note read body search i3skill S4",
  T("what did i write about the shinkansen", rows("kyoto"),
    ref=[search("shinkansen", kind="note"), ans(rows="$kyoto")]))
