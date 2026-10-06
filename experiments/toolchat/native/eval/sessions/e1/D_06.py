from gold import *
import json

world("D", "2026-12-20T19:40", "Marisol Reyes-Kapoor", "eval")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("D-E098", "long packing notes tasks edit decline compute",
  T("show me the guadalajara lists", rows("gdl_list", "nn56", "nn57", "nn58", "nn59"),
    ref=[ans(kind="note", name="guadalajara list")]),
  T("the shopping one", rows("gdl_list"),
    ref=[ans(within="@prev", name="shopping")]),
  T("add tequila to it", diff(upd("gdl_list", body=has("tequila"))),
    ref=[act("edit", rows="$gdl_list", args="body: cajeta for Liz, huaraches for Arun, piñata, tequila")]),
  T("how long is the packing task", val(120),
    ref=[comp(op="max", field="effort", kind="task", name="pack guadalajara"), ans(value="@prev")]),
  T("start it, mark it in progress", diff(upd("pack_gdl", status="in_progress")),
    ref=[act("edit", kind="task", name="pack guadalajara", args="status: in_progress")]),
  T("what time is the flight, the hours keep getting mixed up", rows("flight_gdl"),
    ref=[ans(kind="event", name="flight to guadalajara", when=W({"from": U("day", 0)}))]),
  T("set an alarm for 5am so we're not late for the airport", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("D-E099", "nochebuena people reschedule note edit decline",
  T("who's coming to nochebuena, for the seating plan", rows("mama", "papa", "gabi", "tio"),
    ref=[find(kind="event", name="nochebuena dinner"), ans(kind="person", linked_to="$xmas_eve")]),
  T("move the dinner to 9", diff(upd("xmas_eve", date="2026-12-24T21:00")),
    ref=[act("reschedule", rows="$xmas_eve", args=lines(to=U("week", 1, weekday=4, time="21:00")))]),
  T("tell everyone it moved", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("what's on the pinned menu note", rows("xmas_menu"),
    ref=[ans(kind="note", name="nochebuena menu", where="pinned = yes")]),
  T("add arroz con leche", diff(upd("xmas_menu", body=has("arroz"))),
    ref=[act("edit", rows="$xmas_menu", args="body: bacalao, romeritos, ponche, tamales from Doña Lupe, arroz con leche")]),
  T("is it pinned", rows("xmas_menu"),
    ref=[ans(kind="note", name="nochebuena menu", where="pinned = yes")]))

S("D-E100", "monday plan span reschedule complete",
  T("what's on monday", rows("dentist_kids", "standup154", "recital"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=1)))]),
  T("who goes to the dentist", rows("lucia", "arun", "dentist_d"),
    ref=[ans(kind="person", linked_to="$dentist_kids")]),
  T("push the dentist to 9", diff(upd("dentist_kids", date="2026-12-21T09:00")),
    ref=[act("reschedule", rows="$dentist_kids", args=lines(to=U("day", 1, time="09:00")))]),
  T("monday morning, what else", rows("dentist_kids", "standup154"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1, time="08:00"), U("week", 1, weekday=1, time="12:00"))))]),
  T("is lucia's flowers task still open, or did dev get them", rows("recital_flowers"),
    ref=[ans(kind="task", name="flowers", where="status = open")]),
  T("not yet, but tick it off, dev's getting them", diff(upd("recital_flowers", status="completed", completed=ANY)),
    ref=[act("complete", rows="$recital_flowers")]),
  T("how many tasks are due monday now", val(5),
    ref=[ans(op="count", kind="task", when=W(U("week", 1, weekday=1)), where="status = open")]))

S("D-E101", "debts open filter decline settle sum",
  T("what debts am i still waiting on, so reminders can go out after christmas", rows("db21", "db24", "db27", "db28", "db36", "db50", "db54", "db59", "db61", "gabi_flight"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("just the ones over a hundred", rows("db36", "db50", "db59", "db61", "gabi_flight"),
    ref=[ans(within="@prev", where="amount > 100")]),
  T("text them about it", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("the uber one got paid", diff(upd("db36", status="settled")),
    ref=[act("settle_debt", rows="$db36")]),
  T("so what's left that people owe me", val((1105.66, "USD")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open")]))

S("D-E102", "debt create undo balance",
  T("dev owes me 20 for lunch, we both ate at the cafe", diff(new("debt", name=has("lunch"), amount=20, direction="owes_me"), link("new", "dev")),
    ref=[act("create", args=lines(kind="debt", name="lunch", amount=20, direction="owes_me", person="$dev"))]),
  T("i owe liz 30 for the cab", diff(new("debt", name=has("cab"), amount=30, direction="i_owe"), link("new", "liz")),
    ref=[act("create", args=lines(kind="debt", name="cab", amount=30, direction="i_owe", person="$liz"))]),
  T("undo that", diff(),
    ref=[act("undo")]),
  T("how much do i owe liz now", val((-325.52, "USD")),
    ref=[ans(op="balance", rows="$liz")]))

S("D-E103", "wrong-kind recover task document star",
  T("what's the tamales thing", rows("tamales"),
    ref=[find(kind="event", name="tamales"), ans(kind="task", name="tamales")]),
  T("tick it off", diff(upd("tamales", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tamales")]),
  T("and is the mortgage statement in there, the one for the refinance", rows("dc0", "dc1"),
    ref=[find(kind="note", name="mortgage statement"), ans(kind="document", name="mortgage statement")]),
  T("the 2026 one, star it", diff(upd("dc1", starred=True)),
    ref=[act("star", rows="$dc1")]))

S("D-E104", "trashed-only recover locker not-found",
  T("pull up the old comcast login", rows("old_login"),
    ref=[find(kind="locker item", name="comcast"), ans(kind="locker item", name="comcast", trashed=True)]),
  T("do i have an xfinity one, that's what they renamed it to", decline("not_found"),
    ref=[search("xfinity", kind="locker item"), dec("not_found")]),
  T("ok never mind then", decline("never_mind"),
    ref=[dec("never_mind")]))

S("D-E105", "nickname recover coach balance settle log",
  T("when's coach mike's next practice, arun lost his schedule", rows("soccer_prac120"),
    ref=[find(kind="person", name="coach mike"), search("Coach Mike", kind="person"),
         ans(kind="event", linked_to="$coach_d", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("what's my balance with him", val((-52.48, "USD")),
    ref=[ans(op="balance", rows="$coach_d")]),
  T("settle up with him in the snacks group", diff(upd("coach_d", balance=ANY)),
    ref=[act("settle_up", rows="$coach_d", args="group: $soccer")]),
  T("log a call with lulu", rows("lucia", also=diff(upd("lucia", date=ANY))),
    ref=[search("Lulu", kind="person"), act("log", rows="$lucia", args="kind: call", more=True), ans(rows="$lucia")]))

S("D-E106", "ask-open note create move delete undo",
  T("add a note, there's an idea for the garage", ask(),
    ref=[askc("What should it say?")]),
  T("ideas for the garage, measure the shelves", diff(new("note", name=has("garage"), body=has("shelves"))),
    ref=[act("create", args=lines(kind="note", name="Ideas for the garage", body="measure the shelves"))]),
  T("put it in the ideas notebook", diff(link("ideas_nb", "+1")),
    ref=[act("add_to", rows="$c1", args="to: $ideas_nb")]),
  T("delete it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("undo", diff(restore("+1")),
    ref=[act("undo")]))

S("D-E107", "ambiguous-person ask balance filter",
  T("what's sam's balance with me", ask("pp6", "pp43", "pp62", "pp91", "pp109"),
    ref=[find(kind="person", name="sam"), askc("Which Sam?", options="@1")]),
  T("the book club one", val((0, "USD")),
    ref=[ans(op="balance", rows="$pp91")]),
  T("and sam ali", val((0, "USD")),
    ref=[ans(op="balance", rows="$pp109")]),
  T("which sam is the babysitter", rows("pp6", "pp62"),
    ref=[ans(kind="person", name="sam", where='role = "babysitter"')]))

S("D-E108", "trashed tasks restore undo",
  T("did i delete the gutters task by accident", rows("tk233"),
    ref=[ans(kind="task", name="clean gutters", trashed=True)]),
  T("bring it back", diff(restore("tk233")),
    ref=[act("restore", rows="$tk233")]),
  T("and the car registration one", rows("tk581"),
    ref=[ans(kind="task", name="renew car registration", trashed=True)]),
  T("that one too", diff(restore("tk581")),
    ref=[act("restore", rows="$tk581")]),
  T("undo", diff(trash("tk581")),
    ref=[act("undo")]))

S("D-E109", "trashed library books filter restore",
  T("that library books task i got rid of", rows("tk483", "tk728"),
    ref=[ans(kind="task", name="return library books", trashed=True)]),
  T("which of them has an effort", rows("tk728"),
    ref=[ans(kind="task", name="return library books", trashed=True, where="effort is set")]),
  T("restore that one, the library is charging me fines", diff(restore("tk728")),
    ref=[act("restore", rows="$tk728")]))

S("D-E110", "focus pick reschedule",
  T("when's the kids dentist this month", rows("dentist_kids"),
    ref=[ans(kind="event", name="kids dentist", when=W(U("month", 0)))]),
  T("move the dentist to 9 tomorrow, the school run is first", diff(upd("dentist_kids", date="2026-12-21T09:00")),
    ref=[act("reschedule", kind="event", name="dentist", args=lines(to=U("day", 1, time="09:00")))]),
  T("and back to 8 actually", diff(upd("dentist_kids", date="2026-12-21T08:00")),
    ref=[act("reschedule", rows="$dentist_kids", args=lines(to=U("day", 1, time="08:00")))]))
