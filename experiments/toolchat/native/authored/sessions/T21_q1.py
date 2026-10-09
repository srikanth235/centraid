from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T21-Q001", "birthday noun name across kinds i2pat",
  T("when was kevin's birthday", rows("kevin_bday"),
    ref=[ans(kind="event,task", name="Kevin's birthday")]))

S("T21-Q002", "about word body contains i2pat",
  T("any notes about the roof", rows("harambee_target", "prayer"),
    ref=[ans(kind="note", where='body contains "roof"')]))

S("T21-Q003", "photos from the event date plus person i2pat",
  T("what was on the 16th of may", rows("kevin_bday"),
    ref=[ans(kind="event", when=J(D("2026-05-16")))]),
  T("photos of kevin from that dinner", rows("kevin_bday_p"),
    ref=[ans(kind="photo", linked_to="$kevin", when=J(D("2026-05-16")))]))

S("T21-Q004", "the one with field value read i2pat",
  T("the one with username head.kiamunyi", rows("nemis"),
    ref=[ans(kind="locker item", where='username = "head.kiamunyi"')]))

S("T21-Q005", "place thing password name filter wifi read i2pat",
  T("what's the home wifi password", rows("wifi"),
    ref=[ans(kind="locker item", name="Home wifi")]))

S("T21-Q006", "what else after plan steps same parent open i2pat",
  T("what's the first step on the mock exam timetable", rows("hod_slots"),
    ref=[ans(kind="task", linked_to="$mock_tt", order="date asc", limit=1)]),
  T("what else", rows("print_tt"),
    ref=[ans(kind="task", linked_to="$mock_tt", where="status = open", exclude="@prev")]))

S("T21-Q007", "bare noun across kinds ask no inherit i2pat",
  T("what's open on the school list", rows("mock_tt", "term_report", "arrears", "ribbons", "obs_g4", "appraisals", "gutter", "tsc", "feeding"),
    ref=[ans(kind="task", linked_to="$school_l", where="status = open")]),
  T("arrears", ask("arrears", "arrears_list"),
    ref=[askc("The fees arrears follow-up task or the fees arrears list document?", options="$arrears, $arrears_list")]))

S("T21-Q008", "cadence two weeks or less often i2pat",
  T("who's on a cadence of two weeks or less often",
    rows("wanjiru", "naomi", "esther", "peter_k", "daniel", "alice", "mary_a", "rose", "rev_kiprono"),
    ref=[ans(kind="person", where="cadence >= 14 days")]))

S("T21-Q009", "events left status not cancelled from today i2pat",
  T("how many staff briefings are left", val(8),
    ref=[ans(op="count", kind="event", name="Staff briefing", where="status != cancelled", when=J({"from": U("day", 0)}))]))

S("T21-Q010", "second clause whos left open owes_me i2pat",
  T("achieng paid me back for the lunch, who's left",
    rows("d_rose", "d_brian", "d_peter_o", "d_alice", also=diff(upd("d_mary_a", status="settled"))),
    ref=[act("settle_debt", kind="debt", linked_to="$mary_a", where="status = open", more=True),
         ans(kind="debt", where="direction = owes_me and status = open")]))

S("T21-Q011", "add a note content create i2pat",
  T("add a note, remember to bring the sugar for staff tea", diff(new("note", name=ANY, body=has("sugar"))),
    ref=[act("create", args="kind: note\nname: Sugar for staff tea\nbody: remember to bring the sugar for staff tea")]))

S("T21-Q012", "is there a kind none not_found ignore near hints i2pat",
  T("is there a naivasha album", decline("not_found"),
    ref=[ans(kind="album", name="Naivasha"), dec("not_found")]))

S("T21-Q013", "outside world call decline i2pat",
  T("call the lands office and ask about my title deed copy", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T21-Q014", "external service book decline i2pat",
  T("book me a matatu to nyeri for sunday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T21-Q015", "first name matches several rows ask candidates i2pat",
  T("when's the bom meeting", rows("bom_may", "bom_june"),
    ref=[ans(kind="event", name="BOM meeting")]),
  T("and mary", ask("mary_w", "mary_a"),
    ref=[find(kind="person", name="Mary"), askc("Mary Wambui or Mary Achieng?", options="$mary_w, $mary_a")]))

S("T21-Q016", "nth and mth of month same month past i2pat",
  T("what was on the 4th and the 5th of june", rows("choir_0604", "budget_joseph"),
    ref=[find(kind="event", when=J(D("2026-06-04"))), find(kind="event", when=J(D("2026-06-05"))), ans(rows="@1, @2")]))

S("T21-Q017", "bare weekday nearest upcoming reschedule i2pat",
  T("move the plot survey to monday", diff(upd("survey", date="2026-06-08T15:00")),
    ref=[act("reschedule", rows="$survey", args=lines(to=U("week", 1, weekday=1)))]))

S("T21-Q018", "correction turn move to Nth same time i2pat",
  T("put the car service on thursday", diff(upd("car_service", date="2026-06-11T08:00")),
    ref=[act("reschedule", rows="$car_service", args=lines(to=U("week", 1, weekday=4)))]),
  T("actually no, move it to the 18th, same time", diff(upd("car_service", date="2026-06-18T08:00")),
    ref=[act("reschedule", rows="$car_service", args=lines(to=D("2026-06-18", "08:00")))]))

S("T21-Q019", "document by name with month no verb i2pat",
  T("the bom minutes from may", rows("bom_minutes"),
    ref=[ans(kind="document", name="BOM minutes")]))

S("T21-Q020", "add one after listing container create with link i2pat",
  T("what's open on the church list", rows("cards", "pledges", "robes"),
    ref=[ans(kind="task", linked_to="$church_l", where="status = open")]),
  T("add one for printing the programme", diff(new("task", name=has("programme")), link("church_l", "new")),
    ref=[act("create", args="kind: task\nname: Print the programme\nlist: $church_l")]))

S("T21-Q021", "do both after read naming action i2pat",
  T("i want to tick off tuesday's tasks, what are they", rows("term_report", "call_esther"),
    ref=[ans(kind="task", when=J(U("week", 1, weekday=2)))]),
  T("do both", diff(upd("term_report", status="completed", completed=ANY), upd("call_esther", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]))

S("T21-Q022", "my short word file star not role i2pat",
  T("star my sha", diff(upd("sha_letter", starred=True)),
    ref=[act("star", kind="document", name="SHA")]))

S("T21-Q023", "no notes description empty i2pat",
  T("which school tasks have no notes", rows("mock_tt", "arrears", "ribbons", "obs_g4", "appraisals", "tsc"),
    ref=[ans(kind="task", linked_to="$school_l", where="description is empty")]))

S("T21-Q024", "same list over named rows kind list i2pat",
  T("are the gas and the water bill on the same list", rows("home_l"),
    ref=[find(kind="task", name="gas"), find(kind="task", name="water bill"), ans(kind="list", linked_to="@1, @2")]))

S("T21-Q025", "will take duration edit minutes i2pat",
  T("typing the minutes will take 60 minutes", diff(upd("minutes", effort=60)),
    ref=[act("edit", rows="$minutes", args="effort: 60")]))
