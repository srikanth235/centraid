from gold import *
import json

world("T04", "2026-10-14T19:40", "Aisha Rahman", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T04-C001", "c3c compound log star referential person",
  T("log a coffee with aoife and star her",
    diff(upd("aoife", date=ANY, starred=True)),
    ref=[act("log", kind="person", name="Aoife", args=lines(kind="coffee"), more=True),
         act("star", rows="$aoife")]))

S("T04-C002", "c3c compound three writes create note add_to edit pin",
  T("new note Hen do budget, 300 each all in, put it in istanbul and pin it",
    diff(new("note", name="Hen do budget", body=has("300"), pinned=True), link("ist_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Hen do budget", body="300 each all in"), more=True),
         act("add_to", rows="$new", args=lines(to="$ist_nb"), more=True),
         act("edit", rows="$new", args=lines(pinned="yes"))]))

S("T04-C004", "c3c compound cancel reschedule friday week at N",
  T("cancel the car service, and can you put the dentist to friday week at 4",
    diff(upd("car_service", status="cancelled"), upd("dentist", date="2026-10-30T16:00")),
    ref=[act("cancel", kind="event", name="Car service at Barker Motors", more=True),
         act("reschedule", kind="event", name="Dentist check-up", args=lines(to=U("week", 2, weekday=5, time="16:00")))]))

S("T04-C901", "c3c cell7 search miss decline then span",
  T('find my notes about the marathn', decline("not_found"),
    ref=[search("marathon", kind="note"), dec("not_found")]),
  T("who've i spoken to from monday to the 13th", rows("priya", "zainab", "tom"),
    ref=[ans(kind="person", when=W(span(U("week", 0, weekday=1), D("2026-10-13"))))]))
