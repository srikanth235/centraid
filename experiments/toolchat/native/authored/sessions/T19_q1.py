from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T19-Q001", "how many before date from today to i2pat",
  T("how many swimming lessons are there before the 1st of may", val(3),
    ref=[ans(op="count", kind="event", name="swimming lesson", when=J(span(U("day", 0), D("2026-05-01"))))]))

S("T19-Q002", "subtasks count parent i2pat",
  T("how many steps are there for lina's birthday party", val(2),
    ref=[ans(op="count", kind="task", linked_to="$party_plan")]),
  T("and for filing baba's cnss reimbursement", val(2),
    ref=[ans(op="count", kind="task", linked_to="$reimburse")]))

S("T19-Q003", "single-day list evening within-prev i2pat",
  T("what's on thursday", rows("run_0416", "ptm", "yoga"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=4)))]),
  T("just after 6", rows("yoga"),
    ref=[ans(within="@prev", when=J({"from": U("week", 0, weekday=4, time="18:00")}))]))

S("T19-Q004", "allergic note body search not tasks i2pat",
  T("add a note, lina is allergic to eggs", diff(new("note", name=ANY, body=has("allergic"))),
    ref=[act("create", args="kind: note\nname: Lina allergic to eggs\nbody: lina is allergic to eggs")]),
  T("what's lina allergic to", rows("+1"),
    ref=[ans(kind="note", where='body contains "allergic"')]))

S("T19-Q005", "next time person has anything order limit i2pat",
  T("when's the next time baba has anything on", rows("podiatrist"),
    ref=[ans(kind="event", linked_to="$baba", when=J({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T19-Q006", "debts settled status-only i2pat",
  T("which of my ious are settled", rows("d_simo", "d_zineb"),
    ref=[ans(kind="debt", where="status = settled")]))

S("T19-Q007", "elliptic and the role drops condition i2pat",
  T("who are the school run parents", rows("samira_b", "samira_a", "driss"),
    ref=[ans(kind="person", where='role contains "school run parent"')]),
  T("and the plumber", rows("khalid"),
    ref=[ans(kind="person", where='role = "plumber"')]))

S("T19-Q008", "members of named group find group first i2pat",
  T("who's in the pharmacy coffee fund", rows("me", "nadia", "rachid", "imane", "kenza"),
    ref=[find(kind="group", name="coffee fund"), ans(kind="person", linked_to="@prev")]))

S("T19-Q009", "possessive teacher role i2pat",
  T("who's adam's teacher", rows("hakima"),
    ref=[ans(kind="person", where='role = "Adam\'s teacher"')]))

S("T19-Q010", "let X know followup decline never reuse verb i2pat",
  T("push lina's vaccine to friday", diff(upd("lina_vacc", date="2026-04-17T16:00")),
    ref=[act("reschedule", rows="$lina_vacc", args=lines(to=U("week", 0, weekday=5)))]),
  T("tell dr kettani", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T19-Q011", "personal fact no field decline i2pat",
  T("baba's blood group is a positive", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T19-Q012", "make notebook create name from topic i2pat",
  T("make a notebook for the ifrane trip", diff(new("notebook", name=has("Ifrane"))),
    ref=[act("create", args="kind: notebook\nname: Ifrane trip")]))

S("T19-Q013", "no-match decline not_found i2pat",
  T("when's adam's piano lesson", decline("not_found"),
    ref=[search("piano"), dec("not_found")]))

S("T19-Q014", "world knowledge out_of_scope i2pat",
  T("how far is rabat from casablanca", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T19-Q015", "due weekday cue words in name not dates i2pat",
  T("add a task to collect the sunday order, due friday", diff(new("task", name=has("sunday order"), date="2026-04-17")),
    ref=[act("create", args=lines(kind="task", name="Collect the Sunday order", date=U("week", 0, weekday=5)))]))

S("T19-Q016", "named month passed next year no time i2pat",
  T("remind me to renew the pharmacy licence on the 20th of january", diff(new("task", name=has("licence"), date="2027-01-20")),
    ref=[act("create", args=lines(kind="task", name="Renew the pharmacy licence", date=D("2027-01-20")))]))

S("T19-Q017", "offset from another row date absolute i2pat",
  T("put buy the gift on my tasks two days before lina's birthday party",
    diff(new("task", name=has("gift"), date="2026-04-24")),
    ref=[act("create", args=lines(kind="task", name="Buy the gift", date=D("2026-04-24")))]))

S("T19-Q018", "just the descriptive word group of person i2pat",
  T("which groups is omar in", rows("baba_care", "ifrane", "eid_sheep"),
    ref=[ans(kind="group", linked_to="$omar")]),
  T("just the sheep one", rows("eid_sheep"),
    ref=[ans(kind="group", linked_to="$omar", name="sheep")]))

S("T19-Q019", "last contact verb person row i2pat",
  T("when did i last call baba", rows("baba"),
    ref=[ans(kind="person", name="Baba")]))

S("T19-Q020", "cadence monthly or less often i2pat",
  T("who do i see monthly or less often", rows("simo", "mouhcine"),
    ref=[ans(kind="person", where="cadence >= 30 days")]))

S("T19-Q021", "what X stuff name across task document i2pat",
  T("what cnss stuff do i have", rows("reimburse", "cnss_claims", "cnss_mar", "cnss_feb", "cnss_card"),
    ref=[ans(kind="task,document", name="CNSS")]))

S("T19-Q022", "what am i getting person gift notes i2pat",
  T("what am i getting hajja", rows("gift_ideas"),
    ref=[search("hajja", kind="person"), ans(kind="note", linked_to="$zineb", name="gift")]))

S("T19-Q023", "body is empty read i2pat",
  T("which notes have nothing written in them", rows(),
    ref=[ans(kind="note", where="body is empty")]))

S("T19-Q024", "oldest earliest order date asc i2pat",
  T("what's my oldest document", rows("marriage"),
    ref=[ans(kind="document", order="date asc", limit=1)]))

S("T19-Q025", "name matches nothing pick listed by id i2pat",
  T("what's open on the kids list", rows("party_plan", "homework", "fees", "lina_forms", "rota_mail"),
    ref=[ans(kind="task", linked_to="$kids_l", where="status = open")]),
  T("tick off the school diary", diff(upd("homework", status="completed", completed=ANY)),
    ref=[act("complete", rows="$homework")]))
