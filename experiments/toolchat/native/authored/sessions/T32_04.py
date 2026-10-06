from gold import *
import json

world("T32", "2026-10-28T16:10", "Rosa Delgado-Ortiz", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T32-066", "same-word-pick person-relations debts notes tasks photos possessor",
  T("any open debts with don teodoro", rows("d_teodoro"),
    ref=[ans(kind="debt", linked_to="$teodoro", where="status = open")]),
  T("and notes about him", rows("b_suppliers"),
    ref=[ans(kind="note", linked_to="$teodoro")]),
  T("tasks for him that are still open", rows("flour_oct", "order_flour"),
    ref=[ans(kind="task", linked_to="$teodoro", where="status = open")]),
  T("and dani's photos", rows("p_ki_dani", "p_ki_both", "p_ki_ring", "p_ki_hike", "p_wedding_dress"),
    ref=[ans(kind="photo", linked_to="$dani")]))

S("T32-067", "same-word-pick star document topic two-row-linked_to ask-person",
  T("star the health inspection one", diff(upd("d_health", starred=True)),
    ref=[act("star", kind="document", name="health inspection")]),
  T("and the sat one", diff(upd("d_sat26", starred=True)),
    ref=[act("star", kind="document", name="sat")]),
  T("which wedding jobs are for rodrigo", rows("w_menu"),
    ref=[ans(kind="task", linked_to="$wedding_l, $rodrigo")]),
  T("star maria too", ask("maria_o", "marilu", "marichuy"),
    ref=[act("star", kind="person", name="Maria")]))

S("T32-068", "same-word-pick album usage-described link-target two-row-linked_to",
  T("put the receipt photo in the bakery album", diff(link("bakery_a", "p_receipt")),
    ref=[act("add_to", kind="photo", name="receipt", args="to: $bakery_a")]),
  T("and the oven plate one", diff(link("bakery_a", "p_oven_serial")),
    ref=[act("add_to", kind="photo", name="oven plate", args="to: $bakery_a")]),
  T("which of emi's pics are in there now", rows("p_ba_loaves", "p_ba_van"),
    ref=[ans(kind="photo", linked_to="$emi, $bakery_a")]))

S("T32-069", "same-word-pick group translated family folder list decoys link-target",
  T("put pepe in the family group", diff(link("familia", "pepe")),
    ref=[act("add_to", kind="person", name="Pepe", args="to: $familia")]),
  T("and my niece gabriela", diff(link("familia", "gaby")),
    ref=[act("add_to", kind="person", name="Gabriela", args="to: $familia")]))

S("T32-070", "same-word-pick both second-event posada group-decoy event-vs-group",
  T("move both posadas a day earlier, the bakery one and the vecinal one",
    diff(upd("posada_bakery", date="2026-12-15T18:00"), upd("posada_street", date="2026-12-22T19:00")),
    ref=[act("reschedule", rows="$posada_bakery, $posada_street", args=lines(to=U("day", -1, anchor="row")))]),
  T("who's coming to the vecinal one", rows("chela", "lupe_r"),
    ref=[ans(kind="person", linked_to="$posada_street")]),
  T("and who's in the group", rows("me", "chela", "lupe_r"),
    ref=[ans(kind="person", linked_to="$posada")]))

S("T32-071", "create-args task-vs-event remind-me call-tradesperson inert-clause chore errand appointment",
  T("remind me to call the electrician monday, the stall lights keep tripping",
    diff(new("task", name="Call the electrician", date="2026-11-02")),
    ref=[act("create", args=lines(kind="task", name="Call the electrician", date=U("week", 1, weekday=1)))]),
  T("and call don chuy fri about the brakes",
    diff(new("task", name="Call Don Chuy about the brakes", date="2026-10-30")),
    ref=[act("create", args=lines(kind="task", name="Call Don Chuy about the brakes", date=U("week", 0, weekday=5)))]),
  T("and pick up emi's suit from the tailor saturday",
    diff(new("task", name="Pick up Emi's suit from the tailor", date="2026-10-31")),
    ref=[act("create", args=lines(kind="task", name="Pick up Emi's suit from the tailor", date=U("week", 0, weekday=6)))]),
  T("i've got a haircut next friday at 4, put it in",
    diff(new("event", name="Haircut", date="2026-11-06T16:00")),
    ref=[act("create", args=lines(kind="event", name="Haircut", date=U("week", 1, weekday=5, time="16:00")))]))

S("T32-072", "create-args locker login-label wifi-implied card inert-clause",
  T("add a login for the imss portal, user rosa.espiga",
    diff(new("locker item", name="IMSS portal", type="login", username="rosa.espiga")),
    ref=[act("create", args=lines(kind="locker item", name="IMSS portal", type="login", username="rosa.espiga"))]),
  T("and a wifi login for the market office",
    diff(new("locker item", name="Market office wifi", type="wifi")),
    ref=[act("create", args=lines(kind="locker item", name="Market office wifi", type="wifi"))]),
  T("save my santander debit card, the one i use for the flour payments",
    diff(new("locker item", name="Santander debit card", type="card")),
    ref=[act("create", args=lines(kind="locker item", name="Santander debit card", type="card"))]))

S("T32-073", "create-args person label-words one-attribute-per-line inert-met repair create-then-add_to-group",
  T("new contact alma torres, the florist i met at the mercado, call her every 10 days",
    diff(new("person", name="Alma Torres", role="florist", cadence=10)),
    ref=[bad(act("create", args=lines(kind="person", name="Alma Torres", role="florist", met="Mercado", cadence=10))),
         act("create", args=lines(kind="person", name="Alma Torres", role="florist", cadence=10))]),
  T("add a contact called vicente flores, role egg seller, nickname vicho",
    diff(new("person", name="Vicente Flores", role="egg seller", nickname="Vicho")),
    ref=[act("create", args=lines(kind="person", name="Vicente Flores", role="egg seller", nickname="Vicho"))]),
  T("add jorge mendez, the new neighbour, to the posada group",
    diff(new("person", name="Jorge Mendez", role="neighbour"), link("posada", "new")),
    ref=[act("create", args=lines(kind="person", name="Jorge Mendez", role="neighbour"), more=True),
         act("add_to", rows="$new", args="to: $posada")]))

S("T32-074", "create-args debt group album inert-purpose-clause",
  T("i owe reyna 1200 for the eggs, i'll pay her friday",
    diff(new("debt", name="eggs", amount=1200, direction="i_owe"), link("new", "reyna")),
    ref=[act("create", args=lines(kind="debt", name="eggs", amount=1200, direction="i_owe", person="$reyna"))]),
  T("new group called gas money, for splitting the van fuel",
    diff(new("group", name="Gas money", currency="MXN"), link("new", "me")),
    ref=[act("create", args="kind: group\nname: Gas money")]),
  T("and an album called baptism, for the old pictures",
    diff(new("album", name="Baptism")),
    ref=[act("create", args="kind: album\nname: Baptism")]))

S("T32-075", "create-args container-links task-list note-notebook document-folder",
  T("remind me to call the plumber about the roof thursday, put it on the home list",
    diff(new("task", name="Call the plumber about the roof", date="2026-10-29"), link("home_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Call the plumber about the roof", date=U("week", 0, weekday=4),
                                  list="$home_l"))]),
  T("note for the bakery notes notebook, pick up the new thermostat from don chato on monday",
    diff(new("note", name="Thermostat pickup", body="pick up the new thermostat from don chato on monday"),
         link("bakery_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Thermostat pickup",
                                  body="pick up the new thermostat from don chato on monday", notebook="$bakery_nb"))]),
  T("and a doc called wedding seating in the wedding folder",
    diff(new("document", name="Wedding seating"), link("wedding_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Wedding seating", folder="$wedding_f"))]))

S("T32-076", "verb-choice put-it-back remove_from add_to album count",
  T("take the old sign pic out of la espiga and tell me how many are left in there",
    val(7, also=diff(unlink("bakery_a", "p_ba_sign"))),
    ref=[act("remove_from", kind="photo", name="old sign", args="from: $bakery_a", more=True),
         ans(op="count", kind="photo", linked_to="$bakery_a")]),
  T("put it back", diff(link("bakery_a", "p_ba_sign")),
    ref=[act("add_to", rows="$p_ba_sign", args="to: $bakery_a")]),
  T("which wedding jobs are still open", rows("call_dani", "w_guests", "w_menu", "w_venue", "w_cake", "w_rooms", "w_rings"),
    ref=[ans(kind="task", linked_to="$wedding_l", where="status = open")]),
  T("started the menu, mark it in progress and tell me what else is open on the wedding list",
    rows("call_dani", "w_guests", "w_venue", "w_cake", "w_rooms", "w_rings", also=diff(upd("w_menu", status="in_progress"))),
    ref=[act("edit", rows="$w_menu", args="status: in_progress", more=True),
         ans(kind="task", linked_to="$wedding_l", where="status = open", exclude="$w_menu")]))

S("T32-077", "verb-choice put-it-back delete restore album-forgotten empty re-add",
  T("get rid of the old sign pic and tell me how many are left in la espiga",
    val(7, also=diff(trash("p_ba_sign"), unlink("bakery_a", "p_ba_sign"))),
    ref=[act("delete", kind="photo", name="old sign", more=True),
         ans(op="count", kind="photo", linked_to="$bakery_a")]),
  T("put it back", diff(restore("p_ba_sign")),
    ref=[act("restore", rows="$p_ba_sign")]),
  T("is it in la espiga", rows(),
    ref=[ans(kind="photo", name="old sign", linked_to="$bakery_a")]),
  T("ok add it to la espiga again", diff(link("bakery_a", "p_ba_sign")),
    ref=[act("add_to", rows="$p_ba_sign", args="to: $bakery_a")]))

S("T32-078", "verb-choice put-it-back move add_to log-idiom jot-down create-note",
  T("put the tablecloths on the home list and show me what's on it now",
    rows("gas_tank", "roof_fix", "water_tank", "altar", "marigolds", "tea_towels",
         also=diff(unlink("bakery_l", "tea_towels"), link("home_l", "tea_towels"))),
    ref=[act("add_to", kind="task", name="tablecloths", args="to: $home_l", more=True),
         ans(kind="task", linked_to="$home_l")]),
  T("put it back", diff(unlink("home_l", "tea_towels"), link("bakery_l", "tea_towels")),
    ref=[act("add_to", rows="$tea_towels", args="to: $bakery_l")]),
  T("just hung up with pepe", diff(upd("pepe", date=ANY)),
    ref=[act("log", kind="person", name="Pepe", args="kind: call")]),
  T("jot down that he's coming for the wedding in february",
    diff(new("note", name="Pepe coming in february", body="pepe is coming for the wedding in february")),
    ref=[act("create", args=lines(kind="note", name="Pepe coming in february",
                                  body="pepe is coming for the wedding in february"))]))

S("T32-079", "verb-choice reschedule-chain make-it-hour no-wait-weekday bare-attribute-edit",
  T("move the check up with dr cervantes to tuesday", diff(upd("doctor", date="2026-11-03T16:30")),
    ref=[act("reschedule", kind="event", name="Dr Cervantes", args=lines(to=U("week", 1, weekday=2)))]),
  T("make it 5", diff(upd("doctor", date="2026-11-03T17:00")),
    ref=[act("reschedule", rows="$doctor", args=lines(to=U("day", 0, anchor="row", time="17:00")))]),
  T("no wait, thursday", diff(upd("doctor", date="2026-10-29T17:00")),
    ref=[act("reschedule", rows="$doctor", args=lines(to=U("week", 0, weekday=4)))]),
  T("an hour and a half", diff(upd("doctor", duration=90)),
    ref=[act("edit", rows="$doctor", args="duration: 90")]))

S("T32-080", "verb-choice add-one create make-it-hour reschedule block-time create",
  T("when's the next choir rehearsal", rows("coro_1029"),
    ref=[ans(kind="event", name="Choir rehearsal", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("add one friday at 5", diff(new("event", name="Choir rehearsal", date="2026-10-30T17:00")),
    ref=[act("create", args=lines(kind="event", name="Choir rehearsal", date=U("week", 0, weekday=5, time="17:00")))]),
  T("make it 6", diff(upd("+1", date="2026-10-30T18:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("block 3 to 4 tomorrow for the van wash", diff(new("event", name="Van wash", date="2026-10-29T15:00", duration=60)),
    ref=[act("create", args=lines(kind="event", name="Van wash", date=U("day", 1, time="15:00"), duration=60))]))

S("T32-081", "stop-signals runtime-miss near-hit decoy read-miss write-miss",
  T("when's the choir christmas party",
    rows("concert","coro_1112","coro_1119","coro_1126","coro_1203","coro_1210","coro_1217"), decline("not_found"),
    ref=[ans(kind="event", name="christmas party")]),
  T("open the oven warranty", rows("d_old_quote"), decline("not_found"),
    ref=[ans(kind="document", name="oven warranty")]),
  T("move the baptism to friday", decline("not_found"),
    ref=[act("reschedule", kind="event", name="baptism", args=lines(to=U("week", 0, weekday=5)))]),
  T("delete the old shop camera", ask("camera_ssh"),
    ref=[act("delete", kind="locker item", name="old shop camera")]))

S("T32-082", "stop-signals never_mind end middle start start-with-new-request",
  T("delete the 2023 permit, actually never mind", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("move the van service to friday, no wait never mind it's fine where it is", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("never mind about the dentist, i'll keep it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("never mind the posada, what's on friday", rows("dani_arrives"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=5)))]))

S("T32-083", "stop-signals fyi-no-request ask then body edit then fyi ask",
  T("fyi flour is 560 a bag now", ask(),
    ref=[askc("Do you want me to update the flour price in your supplier prices note?")]),
  T("yes, change the flour price in the supplier prices note",
    diff(upd("b_suppliers", body=has("flour 25 kilo bag 560 pesos"))),
    ref=[opn("$b_suppliers"),
         act("edit", rows="$b_suppliers", args="body: flour 25 kilo bag 560 pesos, eggs 58 a dozen, butter 118 a kilo, sugar 24 a kilo")]),
  T("btw don chuy says the van won't be ready till friday", ask(),
    ref=[askc("Do you want me to move the van service?")]))

S("T32-084", "stop-signals unbounded-except bounded-delete find-then-delete restore-one-back",
  T("wipe all my documents except the lease", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("ok just clear out the done ones on the bakery list",
    diff(trash("mu_eggs"), trash("flour_sep"), trash("flour_oct1"), trash("order_flour_old"), trash("cfe_sep"),
         trash("wages_prev")),
    ref=[find(kind="task", linked_to="$bakery_l", where="status = completed"),
         act("delete", rows="@prev")]),
  T("oops, bring the september cfe payment back", diff(restore("cfe_sep")),
    ref=[act("restore", kind="task", trashed=True, name="CFE")]))

S("T32-085", "stop-signals out_of_scope weather fyi-chatter conversion then read",
  T("what's the weather doing saturday for the stall", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ugh it's been pouring all week, nobody's coming", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("how many pesos is 25 dollars", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("fine, what's on saturday then", rows("stall_oct31"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=6)))]))

S("T32-086", "set-answers role-noun lookup exact-role-not-contains person-link appointment",
  T("who's my accountant", rows("sofia"),
    ref=[ans(kind="person", where='role = "accountant"')]),
  T("and the baker", rows("beto"),
    ref=[ans(kind="person", where='role = "baker"')]),
  T("my doctor too", rows("pablo"),
    ref=[ans(kind="person", where='role = "doctor"')]),
  T("when do i see him", rows("doctor"),
    ref=[ans(kind="event", linked_to="$pablo")]))

S("T32-087", "set-answers debt direction one-of-two",
  T("what does maria ortiz owe me", rows("d_maria_med"),
    ref=[ans(kind="debt", linked_to="$maria_o", where="direction = owes_me")]),
  T("and what do i have to pay her", rows("d_maria_roof"),
    ref=[ans(kind="debt", linked_to="$maria_o", where="direction = i_owe")]))

S("T32-088", "set-answers same-word events weekday decides stall pickup ask-then-weekday",
  T("what time does the sunday market stall open", rows("stall_nov01"),
    ref=[ans(kind="event", name="market stall", when=W(U("week", 0, weekday=7)))]),
  T("and the monday one", rows("stall_nov02"),
    ref=[ans(kind="event", name="market stall", when=W(U("week", 1, weekday=1)))]),
  T("move the flor pickup to fri", ask("pickup_flor", "pickup_flor2"),
    ref=[act("reschedule", kind="event", name="Order pickup - Flor", args=lines(to=U("week", 0, weekday=5)))]),
  T("the thursday one", diff(upd("pickup_flor", date="2026-10-30T10:00")),
    ref=[act("reschedule", kind="event", name="Order pickup - Flor", when=W(U("week", 0, weekday=4)),
             args=lines(to=U("week", 0, weekday=5)))]))

S("T32-089", "set-answers parent-task vs subtasks count within parent-row repair-field-lacking",
  T("how many jobs are left under the muertos orders", val(5),
    ref=[ans(op="count", kind="task", linked_to="$muertos", where="status = open")]),
  T("which of those take more than half an hour", rows("mu_boxes", "mu_stall"),
    ref=[bad(ans(within="@prev", where="duration > 30")),
         ans(within="@prev", where="effort > 30")]),
  T("and when's the main one due", rows("muertos"),
    ref=[ans(rows="$muertos")]))

S("T32-090", "set-answers superlative find-then-act oldest newest",
  T("tick off the oldest open job on the bakery list", diff(upd("flour_oct", status="completed", completed=ANY)),
    ref=[find(kind="task", linked_to="$bakery_l", where="status = open", order="date asc", limit=1),
         act("complete", rows="@prev")]),
  T("and star the newest pic in la espiga", diff(upd("p_ba_flour", starred=True)),
    ref=[find(kind="photo", linked_to="$bakery_a", order="date desc", limit=1),
         act("star", rows="@prev")]))
