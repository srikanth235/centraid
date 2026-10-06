from gold import *

world("T04", "2026-10-14T19:40", "Aisha Rahman", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


OPEN = 'status = "open"'

S("T04-K001", "referent software licence renew i3skill S1",
  T("what's the lightroom licence", rows("lightroom"),
    ref=[ans(kind="locker item", name="Lightroom")]),
  T("when does it renew", rows("lightroom"),
    ref=[ans(rows="$lightroom")]))

S("T04-K002", "referent count narrows in progress i3skill S1",
  T("how many tasks are open on the wedding prep list", val(7),
    ref=[ans(kind="task", op="count", linked_to="$wedlist", where=OPEN)]),
  T("how many are in progress", val(2),
    ref=[ans(kind="task", op="count", linked_to="$wedlist", where='status = "in_progress"')]))

S("T04-K003", "referent event people it i3skill S1",
  T("when's the cake tasting", rows("cake"),
    ref=[ans(kind="event", name="Cake tasting")]),
  T("who's coming to it", rows("zainab", "hamza"),
    ref=[ans(kind="person", linked_to="$cake")]))

S("T04-K004", "referent created task add to list i3skill S1",
  T("add a task buy bin bags", diff(new("task", name=has("bin bags"))),
    ref=[act("create", args=lines(kind="task", name="Buy bin bags"))]),
  T("put it on the house list", diff(link("houselist", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$houselist"))]))

S("T04-K005", "referent event how long it i3skill S1",
  T("when's the dentist", rows("dentist"),
    ref=[ans(kind="event", name="Dentist")]),
  T("how long is it", rows("dentist"),
    ref=[ans(rows="$dentist")]))

S("T04-K006", "perfect did i this month i3skill S2",
  T("how many night shifts have i done this month", val(3),
    ref=[ans(kind="event", op="count", name="Night shift", when=J({"from": U("month", 0), "to": U("day", 0)}))]))

S("T04-K007", "single day thursday sunday i3skill S2",
  T("what's on thursday", rows("dark_1015", "rota_meet"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=4)))]),
  T("and sunday", rows("lunch_1018"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=7)))]))

S("T04-K008", "still in november ahead i3skill S2",
  T("are the istanbul flights still in november", rows("flight_out", "flight_back"),
    ref=[ans(kind="event", name="flight", when=J(U("month", 0, name=11)))]))

S("T04-K009", "still in december wedding i3skill S2",
  T("is the wedding still in december", rows("wedding_day"),
    ref=[ans(kind="event", name="wedding", when=J(U("month", 0, name=12)))]))

S("T04-K010", "duration hours minutes effort i3skill S2",
  T("which tasks take over 2 hours", rows("speech", "audit", "als_prep", "scan"),
    ref=[ans(kind="task", where="effort > 120")]),
  T("and under 10 minutes", rows("bins"),
    ref=[ans(kind="task", where="effort < 10")]))

S("T04-K011", "cadence weeks days i3skill S2",
  T("who do i check in with every three weeks", rows("sana", "leah"),
    ref=[ans(kind="person", where="cadence = 21 days")]),
  T("and monthly", rows("nasreen", "fatima_k", "aoife"),
    ref=[ans(kind="person", where="cadence = 30 days")]))

S("T04-K012", "relation to event dates line i3skill S2",
  T("what's left on the work admin list before the arcp", rows("audit", "reflections", "cbd", "rota_swap", "als_prep", "teaching_prep"),
    ref=[ans(kind="task", linked_to="$worklist", where=OPEN, when=J({"to": D("2026-11-18")}))]))

S("T04-K013", "read not write rent paid i3skill S3",
  T("did i pay the rent", rows("rent_oct", "rent_nov"),
    ref=[ans(kind="task", name="Pay rent")]))

S("T04-K014", "read debt i owe tom i3skill S3",
  T("did i pay tom for the boiler engineer", rows("d_tom"),
    ref=[ans(kind="debt", name="Boiler engineer")]))

S("T04-K015", "read cancelled pub quiz i3skill S3",
  T("was the pub quiz cancelled", rows("pub_quiz"),
    ref=[ans(kind="event", name="pub quiz")]))

S("T04-K016", "read booked car service task i3skill S3",
  T("did i book the car service", rows("book_service"),
    ref=[ans(kind="task", name="Book car service")]))

S("T04-K017", "read starred of them logins i3skill S3",
  T("what logins have i got", rows("nhsmail", "horus"),
    ref=[ans(kind="locker item", where='type = "login"')]),
  T("which of them are starred", rows("nhsmail"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T04-K018", "read then write flu jab i3skill S3",
  T("is the audit slides task done", rows("audit_slides"),
    ref=[ans(kind="task", name="Make audit slides")]),
  T("it's finished, tick it off", diff(upd("audit_slides", status="completed", completed=ANY)),
    ref=[act("complete", rows="$audit_slides")]))

S("T04-K019", "no invention task description search i3skill S4",
  T("mark the bombay mix one as done", diff(upd("favours", status="completed", completed=ANY)),
    ref=[search("bombay mix", kind="task"), act("complete", rows="$favours")]))

S("T04-K020", "no invention role mechanic log i3skill S4",
  T("log a call with the mechanic", diff(upd("kev", date=ANY)),
    ref=[act("log", kind="person", where='role contains "mechanic"', args=lines(kind="call"))]))

S("T04-K021", "no invention missing body ask i3skill S4",
  T("add a note", ask(),
    ref=[askc("What should the note be called and say?")]))

S("T04-K022", "no invention note body search read i3skill S4",
  T("where did i write down the kunefe place", rows("ist_food"),
    ref=[search("kunefe", kind="note"), ans(rows="$ist_food")]))

S("T04-K023", "no invention note body search pin i3skill S4",
  T("pin the one that says golden hour", diff(upd("whitby_notes", pinned=True)),
    ref=[search("golden hour", kind="note"), act("edit", rows="$whitby_notes", args=lines(pinned="yes"))]))
