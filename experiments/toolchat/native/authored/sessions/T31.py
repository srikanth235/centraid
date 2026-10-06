from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-001", "shifts follow-up within exclude cancel",
  T("what night shifts are on next week", rows("shift_1109", "shift_1111", "night_swap"),
    ref=[ans(kind="event", name="night shift", when=J(U("week", 1)))]),
  T("which of those is magda on", rows("shift_1109", "shift_1111"),
    ref=[ans(within="@prev", linked_to="$magda")]),
  T("and who else is on the monday one besides her", rows("przemek"),
    ref=[ans(kind="person", linked_to="$shift_1109", exclude="$magda")]),
  T("cancel the swap shift next friday, marcin took it", diff(upd("night_swap", status="cancelled")),
    ref=[act("cancel", kind="event", name="swap shift", when=J(U("week", 1, weekday=5)))]))

S("T31-002", "debts kuba settle balance",
  T("what debts have i got with kuba", rows("d_kuba_gas", "d_kuba_net"),
    ref=[ans(kind="debt", linked_to="$kuba")]),
  T("which one's from last month", rows("d_kuba_net"),
    ref=[ans(within="@prev", when=J(U("month", -1)))]),
  T("kuba's squared that up, so settle it", diff(upd("d_kuba_net", status="settled")),
    ref=[act("settle_debt", rows="$d_kuba_net")]),
  T("and settle my gas share, then tell me where i stand with him",
    val((20, "PLN"), also=diff(upd("d_kuba_gas", status="settled"))),
    ref=[act("settle_debt", kind="debt", linked_to="$kuba", where="direction = i_owe", more=True),
         ans(op="balance", rows="$kuba")]))

S("T31-003", "weekend exclude duration reschedule anchor",
  T("what's on this weekend",
    rows("flat_dinner", "league_1108", "brunch_adi", "mama_1108", "kasia_call"),
    ref=[ans(kind="event", when=J(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]),
  T("what's on sunday besides the league", rows("brunch_adi", "mama_1108", "kasia_call"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=7)), exclude="$league_1108")]),
  T("how long is adi's brunch", rows("brunch_adi"),
    ref=[ans(kind="event", name="brunch")]),
  T("he's running late, push it back an hour", diff(upd("brunch_adi", date="2026-11-08T14:30")),
    ref=[act("reschedule", rows="$brunch_adi", args=lines(to=U("hour", 1, anchor="row")))]))

S("T31-004", "due tomorrow list within complete reschedule two-writes",
  T("what's due tomorrow", rows("bin_rota", "shopping", "handover", "kit_wash", "pay_ola"),
    ref=[ans(kind="task", when=J(U("day", 1)), where="status = open")]),
  T("which of those are on the flat list", rows("bin_rota", "shopping"),
    ref=[ans(within="@prev", linked_to="$flat_l")]),
  T("bins done, and push the shopping to sunday",
    diff(upd("bin_rota", status="completed", completed=ANY), upd("shopping", date="2026-11-08")),
    ref=[act("complete", rows="$bin_rota", more=True),
         act("reschedule", rows="$shopping", args=lines(to=U("week", 0, weekday=7)))]),
  T("the gas bill's paid too, tick it off and bump the shower head to the 20th",
    diff(upd("gas_pay", status="completed", completed=ANY), upd("fix_shower", date="2026-11-20")),
    ref=[act("complete", rows="$gas_pay", more=True),
         act("reschedule", rows="$fix_shower", args=lines(to=D("2026-11-20")))]))

S("T31-005", "two marcins within complete debts",
  T("which marcins have i got", rows("marcin_l", "marcin_b"),
    ref=[ans(kind="person", name="marcin")]),
  T("which one's the nurse", rows("marcin_b"),
    ref=[ans(within="@prev", where='role contains "nurse"')]),
  T("any open tasks about him", rows("swap_shift"),
    ref=[ans(kind="task", linked_to="$marcin_b", where="status = open")]),
  T("ok that swap is sorted, tick it off", diff(upd("swap_shift", status="completed", completed=ANY)),
    ref=[act("complete", rows="$swap_shift")]),
  T("and where do i stand with the football marcin", val((-115, "PLN")),
    ref=[ans(op="balance", rows="$marcin_l")]))

S("T31-006", "group members add remove delete undo",
  T("who's in the stag do group", rows("me", "adrian", "marcin_l"),
    ref=[ans(kind="person", linked_to="$stag")]),
  T("add tomek maj to it", diff(link("stag", "tomek_m")),
    ref=[act("add_to", rows="$tomek_m", args=lines(to="$stag"))]),
  T("take marcin lis back out", diff(unlink("stag", "marcin_l")),
    ref=[act("remove_from", rows="$marcin_l", args=lines(from_="$stag"))]),
  T("actually bin the whole group, adi's doing it differently",
    diff(gone("stag"), unlink("stag", "me"), unlink("stag", "adrian"), unlink("stag", "tomek_m")),
    ref=[act("delete", kind="group", name="Adi's Stag Do 2027")]),
  T("undo that", diff(),
    ref=[act("undo")]))

S("T31-007", "wifi reveal egress logins starred",
  T("wifi pw?", rows("flat_wifi", "nowysacz_wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("read me the flat one", diff(reveal=[("flat_wifi", "Krakowska3Pokoje")]),
    ref=[act("reveal", rows="$flat_wifi", args="field: password")]),
  T("text it to kuba", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("which logins are starred", rows("pko_login"),
    ref=[ans(kind="locker item", where="type = login and starred = yes")]))

S("T31-008", "photos person album starred star",
  T("photos of babcia", rows("p_ns_table", "p_ns_babcia", "p_ns_walk", "p_ns_all"),
    ref=[ans(kind="photo", linked_to="$babcia")]),
  T("just the starred", rows("p_ns_table"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("babcia and mama together in the nowy sacz album", rows("p_ns_table", "p_ns_walk", "p_ns_all"),
    ref=[ans(kind="photo", linked_to="$babcia, $mama, $family_a")]),
  T("star the church walk one from october", diff(upd("p_ns_walk", starred=True)),
    ref=[act("star", kind="photo", name="church walk", when=J(U("month", -1, name=10)))]))


S("T31-009", "ward tasks within person-count reschedule anchor week",
  T("open ward tasks due next week", rows("uniforms", "swap_shift", "gift_card"),
    ref=[ans(kind="task", linked_to="$ward_l", where="status = open", when=J(U("week", 1)))]),
  T("which of those are about someone", rows("swap_shift", "gift_card"),
    ref=[ans(within="@prev", where="person count >= 1")]),
  T("push the card one back a week", diff(upd("gift_card", date="2026-11-20")),
    ref=[act("reschedule", rows="$gift_card", args=lines(to=U("week", 1, anchor="row")))]))

S("T31-010", "mama calls next description cancel reschedule",
  T("when's my next call with mama", rows("mama_1108"),
    ref=[ans(kind="event", name="call mama", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("which calls this month have babcia on too", rows("mama_1108", "mama_1122"),
    ref=[ans(kind="event", name="call mama", where='description contains "Babcia"', when=J(U("month", 0)))]),
  T("cancel the one on the 22nd", diff(upd("mama_1122", status="cancelled")),
    ref=[act("cancel", kind="event", name="call mama", when=J(D("2026-11-22")))]),
  T("and move the first one to monday at 7", diff(upd("mama_1108", date="2026-11-09T19:00")),
    ref=[act("reschedule", rows="$mama_1108", args=lines(to=U("week", 1, weekday=1, time="19:00")))]))

S("T31-011", "london subtasks sum effort complete",
  T("what's left on the london trip", rows("london_gifts", "london_pounds", "london_pack"),
    ref=[ans(kind="task", linked_to="$london_trip", where="status = open")]),
  T("anything over an hour on there", rows("london_gifts"),
    ref=[ans(within="@prev", where="effort > 60")]),
  T("add up all the minutes left", val(185),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$london_trip", where="status = open"),
         ans(value="@prev")]),
  T("tick off the pounds on the london trip, got them at the kantor", diff(upd("london_pounds", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="pounds", linked_to="$london_trip")]))

S("T31-012", "group balance substitution person balance settle-debt",
  T("where am i with the london christmas group", val((2, "GBP")),
    ref=[search("Tomasz", kind="person"), ans(op="balance", kind="group", name="London Christmas", linked_to="$me")]),
  T("and kasia?", val((14, "GBP")),
    ref=[ans(op="balance", kind="group", name="London Christmas", linked_to="$kasia")]),
  T("net out what me and kasia owe", val((2, "GBP"), (-150, "PLN")),
    ref=[ans(op="balance", rows="$kasia")]),
  T("mark what i owe kasia as paid", diff(upd("d_kasia", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$kasia", where="direction = i_owe")]))

S("T31-013", "ward gifts members role balance settle-up",
  T("who's in ward 4b gifts", rows("me", "marcin_b", "ewa", "magda", "przemek", "anna_w"),
    ref=[ans(kind="person", linked_to="$ward_gifts")]),
  T("which of them are nurses", rows("marcin_b", "ewa", "magda", "anna_w"),
    ref=[ans(within="@prev", where='role contains "nurse"')]),
  T("what's the balance with ewa", val((-18, "PLN")),
    ref=[ans(op="balance", rows="$ewa")]),
  T("settle up with magda in the gifts group", diff(upd("magda", balance=ANY)),
    ref=[act("settle_up", rows="$magda", args=lines(group="$ward_gifts"))]),
  T("what events has the ward gifts group got coming up", rows("hospital_party"),
    ref=[find(kind="event", linked_to="$ward_gifts"), ans(kind="event", name="ward")]))

S("T31-014", "trash tasks restore past-window",
  T("show me the tasks i've thrown away", rows("old_chase", "old_split", "old_book"),
    ref=[ans(kind="task", trashed=True)]),
  T("bring back the mateusz one", diff(restore("old_split")),
    ref=[act("restore", rows="$old_split")]),
  T("and the library books", decline("not_found"),
    ref=[act("restore", rows="$old_book")]))

S("T31-015", "create task add-to-list edit effort",
  T("new task: renew parking permit, due the 20th, put it on the admin list",
    diff(new("task", name=has("parking"), date="2026-11-20"), link("admin_l", "new")),
    ref=[act("create", kind="task", args=lines(name="Renew parking permit", date=D("2026-11-20")), more=True),
         act("add_to", rows="$new", args=lines(to="$admin_l"))]),
  T("make it 45 minutes", diff(upd("+1", effort=45)),
    ref=[act("edit", rows="$c1", args=lines(effort="45"))]),
  T("how many open admin tasks are due before december", val(8),
    ref=[comp(op="count", kind="task", linked_to="$admin_l", where="status = open", when=J({"to": D("2026-11-30")})),
         ans(value="@prev")]))


S("T31-016", "role search sister open-tasks order log complete two-writes",
  T("any open tasks about my sister", rows("call_kasia", "london_gifts"),
    ref=[search("sister", kind="person"), ans(kind="task", linked_to="$kasia", where="status = open")]),
  T("which one's due first", rows("call_kasia"),
    ref=[ans(within="@prev", order="date asc", limit=1)]),
  T("just spoke to her, log it and tick that off", diff(upd("kasia", date=ANY), upd("call_kasia", status="completed", completed=ANY)),
    ref=[act("log", rows="$kasia", args="kind: call", more=True),
         act("complete", rows="$call_kasia")]))

S("T31-017", "landlord role search tasks notes documents starred",
  T("open tasks about the landlord this month", rows("rent_nov", "fix_shower"),
    ref=[search("landlord", kind="person"),
         ans(kind="task", linked_to="$landlord", where="status = open", when=J(U("month", 0)))]),
  T("and any notes on him", rows("n_boiler"),
    ref=[ans(kind="note", linked_to="$landlord")]),
  T("star the landlord's boiler report, he sent it over", diff(upd("d_boiler", starred=True)),
    ref=[act("star", kind="document", name="boiler report", linked_to="$landlord"),
         act("star", kind="document", name="boiler report")]))

S("T31-018", "debts owed-to-me month name sum settle",
  T("what's owed to me from october", rows("d_kuba_net", "d_piotr_balls", "d_michal_balls", "d_adi_tickets"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open", when=J(U("month", -1, name=10)))]),
  T("just the match balls ones", rows("d_piotr_balls", "d_michal_balls"),
    ref=[ans(within="@prev", name="match balls")]),
  T("what do they come to together", val((90, "PLN")),
    ref=[ans(op="sum", field="amount", within="@prev")]),
  T("piotr's paid up, settle his", diff(upd("d_piotr_balls", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$piotr")]))

S("T31-019", "ambiguous dentist reschedule pick",
  T("move the dentist to the 26th", ask("dentist_ev", "dentist_ev2"),
    ref=[act("reschedule", kind="event", name="dentist", args=lines(to=D("2026-11-26", "15:45")))]),
  T("the november one", diff(upd("dentist_ev", date="2026-11-26T15:45")),
    ref=[act("reschedule", kind="event", name="dentist", when=J(U("month", 0)), args=lines(to=D("2026-11-26", "15:45")))]))

S("T31-020", "ambiguous physio cancel pick month-left",
  T("cancel the physio", ask("physio_a", "physio_b", "physio_c"),
    ref=[act("cancel", kind="event", name="physio")]),
  T("the shoulder one on the 26th", diff(upd("physio_b", status="cancelled")),
    ref=[act("cancel", kind="event", name="physio shoulder", when=J(D("2026-11-26")))]),
  T("what physio have i got left in november", rows("physio_a"),
    ref=[ans(kind="event", name="physio", where="status != cancelled", when=J(U("month", 0)))]))

S("T31-021", "decline egress text person",
  T("text kasia i'm landing at nine", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T31-022", "decline unbounded delete all tasks",
  T("delete all my tasks", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T31-023", "bulk delete ask confirm trash",
  T("delete the finished tasks", ask(),
    ref=[find(kind="task", where="status = completed"), act("delete", rows="@1")]),
  T("yes all of them",
    diff(trash("london_flights"), trash("london_leave"), trash("rent_oct"), trash("rent_sep"), trash("net_pay"),
         trash("elec_pay"), trash("bin_rota_prev"), trash("shopping_prev"), trash("timesheet"),
         trash("kit_wash_prev"), trash("league_fee"), trash("call_kasia_prev"), trash("physio_book_old"),
         trash("dentist_book")),
    ref=[act("delete", rows="@1")]),
  T("bring back the pay rent from october", diff(restore("rent_oct")),
    ref=[find(kind="task", name="pay rent", trashed=True, when=J(U("month", -1, name=10))), act("restore", rows="@2")]))

S("T31-024", "five-a-side hall december cancel still-on",
  T("five-a-side in the hall in december", rows("fas_1201", "fas_1208", "fas_1215"),
    ref=[ans(kind="event", name="five-a-side hall", when=J(U("month", 0, name=12)))]),
  T("cancel the one on the 8th", diff(upd("fas_1208", status="cancelled")),
    ref=[act("cancel", kind="event", name="five-a-side", when=J(D("2026-12-08")))]),
  T("is the first of december one still on", rows("fas_1201"),
    ref=[ans(kind="event", name="five-a-side", where="status != cancelled", when=J(D("2026-12-01")))]))

S("T31-025", "two agnieszkas near-name role-met log",
  T("agnieszka", rows("agnieszka", "agnieszka_n"),
    ref=[ans(kind="person", name="agnieszka")]),
  T("the one from the flat", rows("agnieszka_n"),
    ref=[ans(within="@prev", where='met = "Krakowska flat"')]),
  T("is the other one in the zakopane group", rows("agnieszka"),
    ref=[ans(kind="person", name="agnieszka", linked_to="$zakopane", exclude="$agnieszka_n")]),
  T("log a message with the flat one", diff(upd("agnieszka_n", date=ANY)),
    ref=[act("log", rows="$agnieszka_n", args="kind: message")]))
