from gold import *

import json

world("T35", "2026-11-12T19:20", "Freya Lindqvist", "train")

def J(d):
    return json.dumps(d, separators=(",", ":"))

DONE_BEFORE_NOV = ["mortgage_aug", "mortgage_sep", "mortgage_oct", "fridge_0821", "fridge_0904", "fridge_0918", "fridge_1002",
                   "fridge_1016", "fridge_1030", "cod_vessel", "cod_permits", "grant_old", "sample_log_old", "lab_safety",
                   "winter_tiller", "winter_sails", "race_prizes", "jonas_fees_old", "elec_bill_old", "book_flights"]


S("T35-004-P", "relation empty next decline para",
  T("cod team meeting, which coffee club people are going", rows("sigrid", "ola", "lars_e"),
    ref=[ans(kind="person", linked_to="$cod_team, $lab_coffee")]),
  T("what about marit", rows(),
    ref=[ans(kind="event", name="cod team meeting", linked_to="$marit")]),
  T("next event she's got", rows("lab_1116"),
    ref=[ans(kind="event", linked_to="$marit", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("let her know by text that i'm late monday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T35-008-P", "event name month status person para",
  T("september's wednesday races", rows("race_0902", "race_0909", "race_0916", "race_0923", "race_0930"),
    ref=[ans(kind="event", name="wednesday race", when=J(U("month", 0, name=9)))]),
  T("the one that got cancelled?", rows("race_0909"),
    ref=[ans(within="@prev", where="status = cancelled")]),
  T("who was supposed to attend", rows("lars_h", "bjorn"),
    ref=[ans(kind="person", linked_to="$race_0909")]),
  T("october's?", rows(),
    ref=[ans(kind="event", name="wednesday race", when=J(U("month", 0, name=10)))]),
  T("august races that really took place, count", val(3),
    ref=[ans(op="count", kind="event", name="wednesday race", when=J(U("month", 0, name=8)), where="status != cancelled")]))

S("T35-012-P", "two-writes star unstar undo para",
  T("club constitution gets a star, mortgage agreement loses its star", diff(upd("club_constitution", starred=True), upd("mortgage_doc", starred=False)),
    ref=[act("star", rows="$club_constitution", more=True), act("unstar", rows="$mortgage_doc")]),
  T("undo it", diff(upd("club_constitution", starred=False), upd("mortgage_doc", starred=True)),
    ref=[act("undo")]),
  T("only the constitution should get the star", diff(upd("club_constitution", starred=True)),
    ref=[act("star", rows="$club_constitution")]))

S("T35-016-P", "create task list reschedule new-row read para",
  T("home list needs a reminder to call the chimney sweep back", diff(new("task", name=has("chimney", "sweep")), link("home_list", "new")),
    ref=[act("create", args="kind: task\nname: Call the chimney sweep back\nlist: $home_list")]),
  T("monday's the deadline", diff(upd("+1", date="2026-11-16")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 1, weekday=1)))]),
  T("this week on the home list", rows(),
    ref=[ans(kind="task", linked_to="$home_list", when=J(U("week", 0)))]),
  T("next week's?", rows("+1", "elec_bill", "heat_pump"),
    ref=[ans(kind="task", linked_to="$home_list", when=J(U("week", 1)))]))

S("T35-020-P", "ambiguous delete document description para",
  T("home insurance, get rid of it", ask("home_insurance", "home_insurance_25"),
    ref=[act("delete", kind="document", name="home insurance")]),
  T("it's expired so it's the 2025 one", diff(trash("home_insurance_25")),
    ref=[act("delete", rows="$home_insurance_25")]))

S("T35-024-P", "cancel name-date undo para",
  T("morning swim on the 24th is off, cancel it", diff(upd("swim_1124", status="cancelled")),
    ref=[act("cancel", kind="event", name="morning swim", when=D("2026-11-24"))]),
  T("first of december's as well", diff(upd("swim_1201", status="cancelled")),
    ref=[act("cancel", kind="event", name="morning swim", when=D("2026-12-01"))]),
  T("undo it", diff(),
    ref=[act("undo")]))

S("T35-028-P", "group balance me compute search para",
  T("my balance in the kiel week 2026 group?", val((63.5, "EUR")),
    ref=[search("Freya", kind="person"),
         comp(op="balance", kind="group", name="Kiel Week 2026", linked_to="$me"), ans(value="@prev")]),
  T("lab coffee club?", val((32, "NOK")),
    ref=[comp(op="balance", kind="group", name="Lab Coffee Club", linked_to="$me"), ans(value="@prev")]),
  T("tuva's balance in the seilforening kitty group?", val((-1080, "NOK")),
    ref=[comp(op="balance", kind="group", name="Seilforening Kitty", linked_to="$tuva"), ans(value="@prev")]),
  T("lab coffee club headcount?", val(5),
    ref=[ans(op="count", kind="person", linked_to="$lab_coffee")]),
  T("sigrid's balance in the lab coffee club?", val((-308, "NOK")),
    ref=[ans(op="balance", kind="group", name="Lab Coffee Club", linked_to="$sigrid")]))

S("T35-032-P", "ambiguous log nickname answer-line para",
  T("i called lars, log it", ask("lars_h", "lars_e"),
    ref=[act("log", kind="person", name="lars", args="kind: call")]),
  T("commodore one", diff(upd("lars_h", date=ANY)),
    ref=[act("log", rows="$lars_h", args="kind: call")]))

S("T35-036-P", "ambiguous star document answer-line para",
  T("passport scan gets a star", ask("passport_scan", "jonas_passport"),
    ref=[act("star", kind="document", name="passport scan")]),
  T("my own, not jonas's", diff(upd("passport_scan", starred=True)),
    ref=[act("star", rows="$passport_scan")]))

S("T35-040-P", "notes body month find-only pin para",
  T("november notes where ethics comes up", rows("lab_meeting2"),
    ref=[ans(kind="note", where='body contains "ethics"', when=J(U("month", 0, name=11)))]),
  T("what notebook holds it", rows("lab_nb"),
    ref=[find(kind="notebook", linked_to="$lab_meeting2"), ans(rows="@prev")]),
  T("pin that one", diff(upd("lab_meeting2", pinned=True)),
    ref=[act("edit", rows="$lab_meeting2", args="pinned: yes")]))

S("T35-044-P", "ask missing event create para",
  T("need to add an event", ask(),
    ref=[askc("What's the event and when is it?")]),
  T("saturday at 7, dinner with kjersti", diff(new("event", name=has("kjersti"), date="2026-11-14T19:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Kjersti", date=U("week", 0, weekday=6, time="19:00")))]))

S("T35-048-P", "count status effort date para",
  T("open tasks that run over an hour and fall due before december, count", val(3),
    ref=[ans(op="count", kind="task", where="status = open and effort > 60 minutes", when=J({"to": D("2026-11-30")}))]))

S("T35-052-P", "cancelled reschedule ask create para",
  T("dinner with siv on the 6th should shift to next friday", ask("dinner_siv"),
    ref=[act("reschedule", kind="event", name="dinner with siv", when=D("2026-11-06"), args=lines(to=U("week", 1, weekday=5)))]),
  T("then next friday at 7 make a fresh one", diff(new("event", name=has("siv"), date="2026-11-20T19:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Siv", date=U("week", 1, weekday=5, time="19:00")))]))

S("T35-056-P", "no-link recovery find-only exclude log para",
  T("agm tasks that are still open", rows("agm_report"),
    ref=[ans(kind="task", linked_to="$club_agm", where="status = open"),
         ans(kind="task", name="agm", where="status = open")]),
  T("apart from tuva, who else is coming", rows("lars_h", "hjordis"),
    ref=[find(kind="person", linked_to="$club_agm", exclude="$tuva"), ans(rows="@prev")]),
  T("put a message to the pair of them in the log", diff(upd("lars_h", date=ANY), upd("hjordis", date=ANY)),
    ref=[act("log", rows="@prev", args="kind: message")]),
  T("receipts task should land the day before the agm", diff(upd("kitty_receipts", date="2026-11-27")),
    ref=[act("reschedule", rows="$kitty_receipts", args=lines(to=D("2026-11-27")))]))

S("T35-060-P", "tasks next week find-only complete reschedule superlative para",
  T("open tasks due next week taking less than an hour", rows("pay_lars", "cod_gear", "heat_pump"),
    ref=[find(kind="task", where="status = open and effort < 60 minutes", when=J(U("week", 1))), ans(rows="@prev")]),
  T("first two are done, tick them", diff(upd("pay_lars", status="completed", completed=ANY), upd("cod_gear", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pay_lars, $cod_gear")]),
  T("third one goes to the 30th", diff(upd("heat_pump", date="2026-11-30")),
    ref=[act("reschedule", rows="$heat_pump", args=lines(to=D("2026-11-30")))]),
  T("home list items still open and due by the end of the month", rows("elec_bill", "lights", "chimney", "heat_pump"),
    ref=[find(kind="task", linked_to="$home_list", where="status = open", when=J({"to": D("2026-11-30")})), ans(rows="@prev")]),
  T("earliest due among them?", rows("elec_bill"),
    ref=[ans(within="@prev", order="date asc", limit=1)]))

S("T35-068-P", "same-word-pick possessor jonas dentist gloss mine para",
  T("jonas's dentist this month, what day is it", rows("dentist_jonas"),
    ref=[ans(kind="event", name="dentist jonas", when=J(U("month", 0)))]),
  T("mine?", rows("dentist"),
    ref=[ans(rows="$dentist")]))

S("T35-072-P", "create-args task-vs-event call-tradesperson appointment list-link chore errand inert-purpose para",
  T("friday's job, call frode about the brake noise",
    diff(new("task", name=has("frode"), date="2026-11-13")),
    ref=[act("create", args="kind: task\nname: Call Frode about the brake noise\ndate: " + J(U("week", 0, weekday=5)))]),
  T("friday at 9 i've got a physio appointment",
    diff(new("event", name=has("physio"), date="2026-11-13T09:00")),
    ref=[bad(act("create", args=lines(kind="event", name="Physio appointment", date=U("week", 0, weekday=5, time="9am")))),
         act("create", args=lines(kind="event", name="Physio appointment", date=U("week", 0, weekday=5, time="09:00")))]),
  T("home list, call the roofer on monday, remind me",
    diff(new("task", name=has("roofer"), date="2026-11-16"), link("home_list", "new")),
    ref=[act("create", args="kind: task\nname: Call the roofer\ndate: " + J(U("week", 1, weekday=1)) + "\nlist: $home_list")]),
  T("jonas needs boots for skiing, so saturday pick up jonas's boots from the shop",
    diff(new("task", name=has("boots"), date="2026-11-14")),
    ref=[act("create", args=lines(kind="task", name="Pick up Jonas's boots from the shop", date=U("week", 0, weekday=6)))]))

S("T35-076-P", "verb-choice remove_from put-it-back add_to move-folder para",
  T("i'm calling them tomorrow myself, so the chimney sweep task comes off the home list", diff(unlink("home_list", "chimney")),
    ref=[act("remove_from", kind="task", name="chimney sweep", args=lines(from_="$home_list"))]),
  T("return it to the list, otherwise i'll forget", diff(link("home_list", "chimney")),
    ref=[act("add_to", rows="$chimney", args=lines(to="$home_list"))]),
  T("club budget goes to the tax folder", diff(link("tax_f", "club_budget"), unlink("club_f", "club_budget")),
    ref=[act("add_to", kind="document", name="club budget", args=lines(to="$tax_f"))]),
  T("back to its old folder please", diff(link("club_f", "club_budget"), unlink("tax_f", "club_budget")),
    ref=[act("add_to", rows="$club_budget", args=lines(to="$club_f"))]))

S("T35-080-P", "verb-choice reschedule bare-attribute edit-priority log-idiom in-progress edit-status para",
  T("poster task goes to the 25th", diff(upd("poster", date="2026-11-25")),
    ref=[act("reschedule", kind="task", name="poster", args=lines(to=D("2026-11-25")))]),
  T("set priority to 1", diff(upd("poster", priority=1)),
    ref=[act("edit", rows="$poster", args="priority: 1")]),
  T("had a phone chat with astrid, she's fine", diff(upd("astrid", date=ANY)),
    ref=[act("log", rows="$astrid", args="kind: call")]),
  T("layout's started, so poster one is in progress now, mark it", diff(upd("poster", status="in_progress")),
    ref=[act("edit", rows="$poster", args="status: in_progress")]))

S("T35-084-P", "stop-signals unbounded-except decline then bounded delete cancelled para",
  T("home list items still open this month", rows("elec_bill", "heat_pump", "lights", "chimney"),
    ref=[ans(kind="task", linked_to="$home_list", where="status = open", when=J(U("month", 0)))]),
  T("get rid of all of it apart from the heat pump filter", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("only cancelled ones, then", diff(trash("cancelled_paint"), trash("cancelled_shed")),
    ref=[find(kind="task", linked_to="$home_list", where="status = cancelled"), act("delete", rows="@prev")]),
  T("might need them after all, restore them", diff(restore("cancelled_paint"), restore("cancelled_shed")),
    ref=[act("restore", rows="@2")]))

S("T35-088-P", "set-answers same-word events meeting dentist weekday-decides para",
  T("meeting next thursday, at what time", rows("parent_teacher"),
    ref=[ans(kind="event", name="meeting", when=J(U("week", 1, weekday=4)))]),
  T("tomorrow's one?", rows("cod_team"),
    ref=[ans(kind="event", name="meeting", when=J(U("day", 1)))]),
  T("dentist on wednesday?", rows("dentist"),
    ref=[ans(kind="event", name="dentist", when=J(U("week", 1, weekday=3)))]))

S("T35-092-P", "container-link-reads owner-row groups-i-am-in count within person-link para",
  T("my group membership count", val(6),
    ref=[ans(op="count", kind="group", linked_to="$me")]),
  T("bjorn's a member of which of them", rows("seilklubb", "kiel"),
    ref=[ans(within="@prev", linked_to="$bjorn")]))

S("T35-096-P", "stray-conditions by-name writes inert purpose clause star reschedule complete para",
  T("agm coming up, club budget needs a star", diff(upd("club_budget", starred=True)),
    ref=[act("star", kind="document", name="club budget")]),
  T("printer's free on the 25th, so poster task goes to the 25th", diff(upd("poster", date="2026-11-25")),
    ref=[act("reschedule", kind="task", name="poster", args=lines(to=D("2026-11-25")))]),
  T("sample log is done, finished before the cod team meeting, tick it",
    diff(upd("sample_log", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="sample log")]),
  T("grant report gets an extra week, to the 4th of december", ask("grant_progress", "grant_final"),
    ref=[act("reschedule", kind="task", name="grant report", args=lines(to=D("2026-12-04")))]))

S("T35-100-P", "stray-conditions field-the-kind-lacks person-status photo-description document-priority notebook-body para",
  T("lab people still active?", rows("marit", "lars_e", "ola", "sigrid", "torunn"),
    ref=[ans(kind="person", where='met contains "lab"')]),
  T("november humpback photos", rows("p_field_whale"),
    ref=[ans(kind="photo", name="humpback", when=J(U("month", 0, name=11)))]),
  T("urgent tax docs this year?", rows("tax_2025"),
    ref=[ans(kind="document", linked_to="$tax_f", when=J(U("year", 0)))]),
  T("cod survey notes live in which notebook", rows("lab_nb"),
    ref=[find(kind="note", name="cod survey"), ans(kind="notebook", linked_to="@prev")]))

S("T35-104-P", "date-window past-perfect-count since year-arithmetic duration-longer-than repair-unit para",
  T("wednesday races done from september onwards, count", val(4),
    ref=[ans(op="count", kind="event", name="wednesday race", when=J({"from": U("month", 0, name=9)}), where="status != cancelled")]),
  T("documents from two years ago?", rows("custody", "boat_reg", "heat_manual"),
    ref=[ans(kind="document", when=J(U("year", -2)))]),
  T("this month's events over three hours long?", rows("ski_jonas", "polar_party"),
    ref=[bad(ans(kind="event", when=J(U("month", 0)), where="duration > 3 hours")),
         ans(kind="event", when=J(U("month", 0)), where="duration > 180 minutes")]))
