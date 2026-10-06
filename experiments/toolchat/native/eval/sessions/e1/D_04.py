from gold import *
import json

world("D", "2026-12-20T19:40", "Marisol Reyes-Kapoor", "eval")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("D-E066", "ambiguous-task ask five-open",
  T("tick off update budget spreadsheet, the december numbers are finally done", ask("tk26", "tk132", "tk192", "tk625", "tk742"),
    ref=[act("complete", kind="task", name="update budget spreadsheet"),
         find(kind="task", name="update budget spreadsheet", where="status = open"),
         askc("Five of those are open, which one?", options="@1")]))

S("D-E067", "ambiguous-task ask pick-by-date",
  T("tick off pay credit card", ask("tk440", "tk641"),
    ref=[act("complete", kind="task", name="pay credit card"),
         find(kind="task", name="pay credit card", where="status = open"),
         askc("There are two open, the one due christmas or the one from march?", options="@1")]),
  T("the christmas one", diff(upd("tk440", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tk440")]))

S("D-E068", "ambiguous-task ask pick",
  T("mow the lawn is done", ask("tk130", "tk154"),
    ref=[act("complete", kind="task", name="mow the lawn"),
         find(kind="task", name="mow the lawn", where="status = open"),
         askc("Which one, june or january?", options="@1")]),
  T("june", diff(upd("tk130", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tk130")]))

S("D-E069", "ambiguous-note ask delete undo",
  T("delete the chilaquiles note, there are three of them", ask("nn7", "nn8", "nn9"),
    ref=[act("delete", kind="note", name="chilaquiles"),
         askc("Which one: Chilaquiles, 2 or 3?", options="$nn7, $nn8, $nn9")]),
  T("the newest one, the other two are the ones i keep", diff(trash("nn9")),
    ref=[find(kind="note", name="chilaquiles", order="date desc", limit=1), act("delete", rows="$nn9")]),
  T("undo", diff(restore("nn9")),
    ref=[act("undo")]))

S("D-E070", "ambiguous-document ask star",
  T("star the tax return", ask("dc11", "dc12", "dc13"),
    ref=[act("star", kind="document", name="tax return"),
         askc("Which year: 2024, 2025 or 2026?", options="$dc11, $dc12, $dc13")]),
  T("the 2026 one", diff(upd("dc13", starred=True)),
    ref=[act("star", rows="$dc13")]),
  T("and 2025 too", diff(upd("dc12", starred=True)),
    ref=[act("star", rows="$dc12")]))

S("D-E071", "ambiguous-event ask cancel",
  T("cancel the birthday party, we can't make it", ask("ev96", "gabi_party"),
    ref=[act("cancel", kind="event", name="birthday party"),
         find(kind="event", name="birthday party", when=W({"from": U("day", 0)})),
         askc("Two coming up, christmas day or gabi's 40th?", options="@1")]),
  T("the christmas one", diff(upd("ev96", status="cancelled")),
    ref=[act("cancel", rows="$ev96")]))

S("D-E072", "ambiguous-person ask star",
  T("star kavya, her number keeps getting lost in the contacts", ask("kavya", "kavya2"),
    ref=[act("star", kind="person", name="kavya"),
         askc("Kavya Kapoor or Kavya Menon?", options="$kavya, $kavya2")]),
  T("the pta one", diff(upd("kavya2", starred=True)),
    ref=[act("star", rows="$kavya2")]))

S("D-E073", "create task weekday list",
  T("add wash the car for saturday", diff(new("task", name="Wash the car", date="2026-12-26")),
    ref=[act("create", args=lines(kind="task", name="Wash the car", date=U("week", 1, weekday=6)))]),
  T("stick it on the home list too, and make it priority 3", diff(link("home_l", "+1"), upd("+1", priority=3)),
    ref=[act("add_to", rows="$c1", args="to: $home_l", more=True), act("edit", rows="$c1", args="priority: 3")]))

S("D-E074", "ambiguous-event pick-future reschedule",
  T("push movie night a day", diff(upd("ev106", date="2027-01-09T11:00")),
    ref=[act("reschedule", kind="event", name="movie night", args=lines(to=U("day", 1, anchor="row"))),
         find(kind="event", name="movie night", when=W({"from": U("day", 0)})),
         act("reschedule", rows="$ev106", args=lines(to=U("day", 1, anchor="row")))]),
  T("what day is it on now", rows("ev106"),
    ref=[ans(rows="$ev106")]))

S("D-E075", "typo empty search recover",
  T("when's the kitchen walkthru", rows("reno_meeting"),
    ref=[find(kind="event", name="walkthru"), search("walkthru"), ans(rows="$reno_meeting")]))

S("D-E076", "ask-open create",
  T("put dinner on the calendar", ask(),
    ref=[askc("Which day and time?")]),
  T("friday at 7 with the carters", diff(new("event", name=has("dinner"), date="2026-12-25T19:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with the Carters", date=U("week", 1, weekday=5, time="19:00")))]))

S("D-E077", "decline scope person-number",
  T("what's paul russo's number", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("D-E078", "decline scope email",
  T("email karen the q4 report", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("D-E079", "contractor event people note star",
  T("is the kitchen walkthrough still in january", rows("reno_meeting"),
    ref=[ans(kind="event", name="kitchen walkthrough", when=W(U("month", 1)))]),
  T("who's it with", rows("contractor"),
    ref=[ans(kind="person", linked_to="$reno_meeting")]),
  T("what's his quote say", rows("reno_quote"),
    ref=[ans(kind="note", name="quote")]),
  T("star vinnie and put down that i spoke to him today", diff(upd("contractor", starred=True, date=ANY)),
    ref=[act("star", kind="person", name="vinnie", more=True), act("log", kind="person", name="vinnie", args="kind: call")]))

S("D-E080", "recurring practice exclude cancel fragment",
  T("when's arun's next practice, the carpool wants to know", rows("soccer_prac120"),
    ref=[ans(kind="event", name="arun soccer practice", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("and the one after", rows("soccer_prac121"),
    ref=[ans(kind="event", name="arun soccer practice", when=W({"from": U("day", 0)}), order="date asc", limit=1, exclude="$soccer_prac120")]),
  T("cancel the one on the twenty-ninth", diff(upd("soccer_prac121", status="cancelled")),
    ref=[act("cancel", kind="event", name="arun soccer practice", when=W(D("2026-12-29")))]),
  T("and the fifth", diff(upd("soccer_prac122", status="cancelled")),
    ref=[act("cancel", kind="event", name="arun soccer practice", when=W(D("2027-01-05")))]),
  T("what practices are left in january", rows("soccer_prac123", "soccer_prac124", "soccer_prac125"),
    ref=[ans(kind="event", name="arun soccer practice", when=W(U("month", 1)), where="status != cancelled")]))

S("D-E081", "read tomorrow tasks",
  T("what's due tomorrow", rows("pack_gdl", "tamales", "passports_d", "recital_flowers", "oof", "water_plants", "tk742"),
    ref=[ans(kind="task", when=W(U("day", 1)))]))

S("D-E082", "count open tasks compute",
  T("open tasks, how many", val(69),
    ref=[comp(op="count", kind="task", where="status = open"), ans(value="@prev")]))

S("D-E083", "people linked event",
  T("who's coming to the posada", rows("tio", "gabi"),
    ref=[find(kind="person", linked_to="$posada"), ans(rows="@1")]))

S("D-E084", "document read tickets unstar",
  T("show me the starred e-tickets", rows("gdl_tickets"),
    ref=[find(kind="note", name="e-tickets"), ans(kind="document", name="e-tickets", where="starred = yes")]),
  T("unstar it, we're past the booking now", diff(upd("gdl_tickets", starred=False)),
    ref=[act("unstar", rows="$gdl_tickets")]))
