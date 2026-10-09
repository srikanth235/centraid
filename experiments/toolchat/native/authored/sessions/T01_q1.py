from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T01-Q001", "instead-weekday reschedule time-only i2pat",
  T("ada's swimming at 10 instead on saturday", diff(upd("swim_0314", date="2026-03-14T10:00")),
    ref=[act("reschedule", kind="event", linked_to="$ada", when=J(U("week", 0, weekday=6)),
             args=lines(to=U("day", 0, anchor="row", time="10:00")))]))

S("T01-Q002", "subtasks count parent i2pat",
  T("how many subtasks has hen do planning got", val(5),
    ref=[ans(op="count", kind="task", linked_to="$hen_plan")]),
  T("and the kitchen renovation", val(12),
    ref=[ans(op="count", kind="task", linked_to="$reno")]))

S("T01-Q003", "single-day list evening within-prev i2pat",
  T("what've i got on tuesday", rows("pe_tobi", "fiveaside_0317"),
    ref=[ans(kind="event", when=J(U("week", 1, weekday=2)))]),
  T("just the after 6 one", rows("fiveaside_0317"),
    ref=[ans(within="@prev", when=J({"from": U("week", 1, weekday=2, time="18:00")}))]))

S("T01-Q004", "documents not-from exclude find i2pat",
  T("what documents have i saved since the first of january",
    rows("quote_pickering", "quote_wren", "home_ins", "payslip_jan", "payslip_feb", "rota_mar", "flight_booking",
         "apartment_conf", "car_renewal", "farm_letter"),
    ref=[ans(kind="document", when=J({"from": D("2026-01-01")}))]),
  T("just the ones not from the work folder",
    rows("quote_pickering", "quote_wren", "home_ins", "flight_booking", "apartment_conf", "car_renewal", "farm_letter"),
    ref=[find(kind="document", linked_to="$work_f"), ans(within="@1", exclude="@prev")]))

S("T01-Q005", "next-time person event order limit i2pat",
  T("when's the next time dean has anything on", rows("match_0315"),
    ref=[ans(kind="event", linked_to="$dean", when=J({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T01-Q006", "debts settled status-only i2pat",
  T("which ious have been settled", rows("d_priya_s", "d_dev", "d_kwame_old"),
    ref=[ans(kind="debt", where="status = settled")]))

S("T01-Q007", "fresh date drops link filter i2pat",
  T("what's tobi got on this week", rows("training_0311", "match_0315"),
    ref=[ans(kind="event", linked_to="$tobi", when=J(U("week", 0)))]),
  T("and what's on monday the sixteenth", rows("ld_0316"),
    ref=[ans(kind="event", when=J(D("2026-03-16")))]))

S("T01-Q008", "group members find group first i2pat",
  T("who's in the coffee club", rows("me", "priya_n", "priya_s", "gemma", "kwame", "siobhan"),
    ref=[find(kind="group", name="coffee club"), ans(kind="person", linked_to="@prev")]))

S("T01-Q009", "possessive teacher role i2pat",
  T("who's tobi's teacher", rows("harpreet"),
    ref=[ans(kind="person", where='role = "Tobi\'s teacher"')]),
  T("and ada's", rows("owen"),
    ref=[ans(kind="person", where='role = "Ada\'s teacher"')]))

S("T01-Q010", "remove two named rows from list i2pat",
  T("take the two e-learning ones off my work list", diff(unlink("work_list", "fire_safety"), unlink("work_list", "infection")),
    ref=[find(kind="task", name="e-learning", linked_to="$work_list"), act("remove_from", rows="@prev", args="from: $work_list")]))

S("T01-Q011", "personal fact no field decline i2pat",
  T("dayo's birthday is the ninth of june", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T01-Q012", "generic group word ask candidates i2pat",
  T("add gemma to the ward group", ask("coffee", "night_out"),
    ref=[askc("Ward 7 Coffee Club or Ward Night Out?", options="$coffee, $night_out")]))

S("T01-Q013", "add_to destination missing ask create i2pat",
  T("file the falls audit note in my nursing notebook", ask(),
    ref=[askc("You don't have a nursing notebook. Create it?")]))

S("T01-Q014", "no-match decline not_found i2pat",
  T("when's the school disco", decline("not_found"),
    ref=[search("disco"), dec("not_found")]))

S("T01-Q015", "world knowledge out_of_scope i2pat",
  T("what's the weather like in lisbon in april", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T01-Q016", "how-many-had upper bound today i2pat",
  T("how many swimming lessons has ada had so far", val(3),
    ref=[ans(op="count", kind="event", name="swimming lesson", when=J({"to": U("day", 0)}))]))

S("T01-Q017", "named month ahead next year no time i2pat",
  T("remind me to send the p60 to the accountant on the ninth of february",
    diff(new("task", name=has("P60"), date="2027-02-09")),
    ref=[act("create", args=lines(kind="task", name="Send P60 to the accountant", date=D("2027-02-09")))]))

S("T01-Q018", "offset from another row date absolute i2pat",
  T("put buy dust sheets on my list two days before the kitchen fitting",
    diff(new("task", name=has("dust sheets"), date="2026-03-21")),
    ref=[act("create", args=lines(kind="task", name="Buy dust sheets", date=D("2026-03-21")))]))

S("T01-Q019", "list word zero lists notes i2pat",
  T("show me the packing list", rows("packing"),
    ref=[ans(kind="note,document", name="packing")]))

S("T01-Q020", "last contacted person row i2pat",
  T("when did i last ring kunle", rows("kunle"),
    ref=[ans(kind="person", name="Kunle")]))

S("T01-Q021", "cadence monthly or less often i2pat",
  T("who do i only keep in touch with monthly or less often", rows("ifeoma"),
    ref=[ans(kind="person", where="cadence >= 30 days")]))

S("T01-Q022", "cadence every three weeks or rarer i2pat",
  T("who's on a cadence of three weeks or longer", rows("maureen", "ifeoma"),
    ref=[ans(kind="person", where="cadence >= 21 days")]))

S("T01-Q023", "gift notes of person i2pat",
  T("what am i getting mum", rows("gift_ideas"),
    ref=[search("mum", kind="person"), ans(kind="note", linked_to="$mum", name="gift")]))

S("T01-Q024", "when do we leave flight event i2pat",
  T("when do we leave for lisbon", rows("flight_out"),
    ref=[ans(kind="event", name="Flight to Lisbon")]))

S("T01-Q025", "which most within prev order desc i2pat",
  T("what are people holding over me", rows("d_priya_lunch", "d_gemma_tickets", "d_kunle", "d_jess_w", "d_callum"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which is the most", rows("d_kunle"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))
