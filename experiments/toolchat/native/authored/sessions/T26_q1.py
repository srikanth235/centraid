from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T26-Q001", "photos from event date plus person i2pat",
  T("what was on the 15th of november", rows("kemi_bday"),
    ref=[ans(kind="event", when=J(D("2026-11-15")))]),
  T("photos of kemi from that party", rows("p_cake", "p_kemi_friends", "p_bday_family"),
    ref=[ans(kind="photo", linked_to="$kemi", when=J(D("2026-11-15")))]))

S("T26-Q002", "how many before date from today to i2pat",
  T("how many football sessions are there before the 8th of december", val(2),
    ref=[ans(op="count", kind="event", name="football", when=J(span(U("day", 0), D("2026-12-08"))))]))

S("T26-Q003", "subtasks count parent i2pat",
  T("how many steps are in the plan for mama's 70th", val(3),
    ref=[ans(op="count", kind="task", linked_to="$party")]),
  T("and wire the new house", val(3),
    ref=[ans(op="count", kind="task", linked_to="$wiring")]))

S("T26-Q004", "what else after plan steps same parent open i2pat",
  T("what's the next step on mama's 70th plan", rows("caterer"),
    ref=[ans(kind="task", linked_to="$party", order="date asc", limit=1)]),
  T("what else", rows("canopy", "aso_ebi"),
    ref=[ans(kind="task", linked_to="$party", where="status = open", exclude="@prev")]))

S("T26-Q005", "allergic note body search not tasks i2pat",
  T("add a note, femi is allergic to peanuts", diff(new("note", name=ANY, body=has("allergic"))),
    ref=[act("create", args="kind: note\nname: Femi allergic to peanuts\nbody: femi is allergic to peanuts")]),
  T("what's femi allergic to", rows("+1"),
    ref=[ans(kind="note", where='body contains "allergic"')]))

S("T26-Q006", "next time person has anything order limit i2pat",
  T("when's the next time olumide has anything on", rows("roof_insp"),
    ref=[ans(kind="event", linked_to="$olumide", when=J({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T26-Q007", "events left status not cancelled from today i2pat",
  T("how many ajo meetings are left", val(2),
    ref=[ans(op="count", kind="event", name="Ajo meeting", where="status != cancelled", when=J({"from": U("day", 0)}))]))

S("T26-Q008", "elliptic and the role drops condition i2pat",
  T("who are my cousins", rows("bayo", "funmi", "sade", "ibrahim"),
    ref=[ans(kind="person", where='role = "cousin"')]),
  T("and the electricians", rows("chidi", "segun"),
    ref=[ans(kind="person", where='role contains "electrician"')]))

S("T26-Q009", "members of named group find group first i2pat",
  T("who's in the bonga crew kitty", rows("me", "chidi", "emeka_n", "emeka_o", "musa", "victor", "tunde"),
    ref=[find(kind="group", name="bonga crew"), ans(kind="person", linked_to="@prev")]))

S("T26-Q010", "is there a kind none not_found ignore near hints i2pat",
  T("is there a poultry folder", decline("not_found"),
    ref=[ans(kind="folder", name="poultry"), dec("not_found")]))

S("T26-Q011", "let X know followup decline never reuse verb i2pat",
  T("push the pta meeting to thursday", diff(upd("pta", date="2026-11-26T14:00")),
    ref=[act("reschedule", rows="$pta", args=lines(to=U("week", 0, weekday=4)))]),
  T("tell adaeze", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T26-Q012", "personal fact no field decline i2pat",
  T("tobi's blood group is o positive", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T26-Q013", "first name matches several ask candidates i2pat",
  T("when's the crane inspection", rows("crane"),
    ref=[ans(kind="event", name="Crane inspection")]),
  T("and emeka", ask("emeka_n", "emeka_o"),
    ref=[find(kind="person", name="Emeka"), askc("Emeka Nwosu or Emeka Obi?", options="$emeka_n, $emeka_o")]))

S("T26-Q014", "make folder create name from topic i2pat",
  T("make a folder for the poultry stuff", diff(new("folder", name=has("Poultry"))),
    ref=[act("create", args="kind: folder\nname: Poultry")]))

S("T26-Q015", "no-match decline not_found i2pat",
  T("when's the school sports day", decline("not_found"),
    ref=[search("sports day"), dec("not_found")]))

S("T26-Q016", "correction turn move to Nth same time i2pat",
  T("move the car service to friday", diff(upd("car_service", date="2026-11-27T13:00")),
    ref=[act("reschedule", rows="$car_service", args=lines(to=U("week", 0, weekday=5)))]),
  T("actually no, move it to the 30th, same time", diff(upd("car_service", date="2026-11-30T13:00")),
    ref=[act("reschedule", rows="$car_service", args=lines(to=D("2026-11-30", "13:00")))]))

S("T26-Q017", "due weekday cue words in name not dates i2pat",
  T("add a task to call mama before sunday lunch, due thursday", diff(new("task", name=has("call mama"), date="2026-11-26")),
    ref=[act("create", args=lines(kind="task", name="Call Mama before Sunday lunch", date=U("week", 0, weekday=4)))]))

S("T26-Q018", "named month ahead next year no time i2pat",
  T("remind me to renew my passport on the 14th of february", diff(new("task", name=has("passport"), date="2027-02-14")),
    ref=[act("create", args=lines(kind="task", name="Renew passport", date=D("2027-02-14")))]))

S("T26-Q019", "do both after read naming action i2pat",
  T("i'll tick off what's due on the 2nd of december, what's that", rows("cables", "db_board"),
    ref=[ans(kind="task", when=J(D("2026-12-02")))]),
  T("do both", diff(upd("cables", status="completed", completed=ANY), upd("db_board", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]))

S("T26-Q020", "just the descriptive word group of person i2pat",
  T("which groups is musa in", rows("rig_g", "welfare_g"),
    ref=[ans(kind="group", linked_to="$musa")]),
  T("just the welfare one", rows("welfare_g"),
    ref=[ans(kind="group", linked_to="$musa", name="welfare")]))

S("T26-Q021", "last contact verb person row i2pat",
  T("when did i last speak to mama", rows("mama"),
    ref=[ans(kind="person", name="Mama")]))

S("T26-Q022", "same list over named rows kind list i2pat",
  T("are the multimeter and the coveralls on the same list", rows("rig_l"),
    ref=[find(kind="task", name="multimeter"), find(kind="task", name="coveralls"), ans(kind="list", linked_to="@1, @2")]))

S("T26-Q023", "what X stuff name across task document i2pat",
  T("what electrical stuff do i have", rows("drawings", "elec_drawings"),
    ref=[ans(kind="task,document", name="electrical")]))

S("T26-Q024", "what am i getting person gift notes i2pat",
  T("what am i getting mama", rows("gift_ideas"),
    ref=[search("mama", kind="person"), ans(kind="note", linked_to="$mama", name="gift")]))

S("T26-Q025", "elliptical past-tense did complete i2pat",
  T("did the inverter batteries", diff(upd("inverter", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="inverter batteries")]))
