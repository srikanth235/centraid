from gold import *
import json

world("T32", "2026-10-28T16:10", "Rosa Delgado-Ortiz", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T32-045", "group members delete-group undo-not-undone group-with-expenses ask rename",
  T("who's in the posada vecinal group", rows("me", "chela", "lupe_r"),
    ref=[ans(kind="person", linked_to="$posada")]),
  T("delete it, the street isn't doing it", diff(gone("posada"), unlink("posada", "me"), unlink("posada", "chela"),
                                                  unlink("posada", "lupe_r")),
    ref=[act("delete", rows="$posada")]),
  T("undo that", diff(),
    ref=[act("undo")]),
  T("delete the boda group then", ask(),
    ref=[act("delete", rows="$boda")]),
  T("ok rename it to wedding fund", diff(upd("boda", name="Wedding fund")),
    ref=[act("edit", rows="$boda", args="name: Wedding fund")]))

S("T32-046", "search find-only within multi-kind when reschedule cancel-by-date",
  T("anything about the oven", rows("oven_fix", "oven_old", "oven_part", "b_oven", "p_oven_serial", "p_ba_oven"),
    ref=[find(kind="event,task,note,photo", name="oven"), ans(rows="@prev")]),
  T("which are due before december", rows("oven_fix", "oven_old", "oven_part"),
    ref=[ans(within="@prev", kind="task,event", when=W({"to": D("2026-11-30")}))]),
  T("push the thermostat order to friday", diff(upd("oven_part", date="2026-10-30")),
    ref=[act("reschedule", rows="$oven_part", args=lines(to=U("week", 0, weekday=5)))]),
  T("cancel the maintenance on the ninth", diff(upd("oven_fix", status="cancelled")),
    ref=[act("cancel", kind="event", name="Oven maintenance", when=W(D("2026-11-09")))]))

S("T32-047", "debt create balance since k4 sum-within settle_debt created-row",
  T("i owe chuy 800 for the tires", diff(new("debt", name=has("tires"), direction="i_owe", amount=800), link("new", "chuy")),
    ref=[act("create", args=lines(kind="debt", name="tires", amount=800, direction="i_owe", person="$chuy"))]),
  T("and my balance with chuy?", val((-800, "MXN")),
    ref=[ans(op="balance", rows="$chuy")]),
  T("debts i owe since the start of october over 500", rows("d_memo_flour", "d_teodoro", "+1"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open and amount > 500", when=W({"from": D("2026-10-01")}))]),
  T("so what's the total", val((10800, "MXN")),
    ref=[ans(op="sum", field="amount", kind="debt", within="@prev")]),
  T("settle the teodoro one, paid him cash", diff(upd("d_teodoro", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$teodoro", where="status = open")]))

S("T32-048", "what-else exclude within duration",
  T("what's on thursday", rows("pickup_flor", "coro_1029"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=4)))]),
  T("what else this week besides those", rows("flour_1027", "dani_arrives", "stall_oct31", "stall_nov01", "cemetery", "calldani_1101"),
    ref=[ans(kind="event", when=W(U("week", 0)), exclude="@prev")]),
  T("and next week besides the van service",
    rows("stall_nov02", "mass_muertos", "dani_leaves", "vendors", "coro_1105", "accountant_a", "calldani_1108"),
    ref=[ans(kind="event", when=W(U("week", 1)), exclude="$van_service")]),
  T("which are longer than an hour", rows("stall_nov02", "mass_muertos", "coro_1105"),
    ref=[ans(within="@prev", where="duration > 60")]))

S("T32-049", "repair weekend list when empty-follow-up",
  T("left on the bakery list this weekend", rows("mu_stall", "wages"),
    ref=[bad(ans(kind="task", linked_to="$bakery_l", where="status = open", when=W({"weekday": 6}))),
         ans(kind="task", linked_to="$bakery_l", where="status = open",
             when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]),
  T("and sunday", rows(),
    ref=[ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("week", 0, weekday=7)))]))

S("T32-050", "morning count three-calls repair-args find-answer",
  T("how many open bakery jobs are due this week", val(9),
    ref=[ans(op="count", kind="task", linked_to="$bakery_l", where="status = open", when=W(U("week", 0)))]),
  T("tick the yeast, push the boxes to friday and tell me what's left on the bakery list for tomorrow",
    rows("mu_orange", also=diff(upd("yeast", status="completed", completed=ANY), upd("mu_boxes", date="2026-10-30"))),
    ref=[bad(act("complete", rows="$yeast", args="status: completed", more=True)),
         act("complete", rows="$yeast", more=True),
         act("reschedule", rows="$mu_boxes", args=lines(to=U("week", 0, weekday=5)), more=True),
         ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("day", 1)))]),
  T("who's at the stall on saturday", rows("memo", "beto", "yesenia"),
    ref=[find(kind="event", name="market stall", when=W(U("week", 0, weekday=6))),
         ans(kind="person", linked_to="@prev")]))

S("T32-051", "search role multi-call relation reschedule-row-anchor from-today",
  T("when do i see the doctor", rows("doctor"),
    ref=[search("doctor", kind="person"), ans(kind="event", linked_to="$pablo")]),
  T("a week later", diff(upd("doctor", date="2026-11-16T16:30")),
    ref=[act("reschedule", rows="$doctor", args=lines(to=U("week", 1, anchor="row")))]),
  T("what about the priest, anything coming up that isn't cancelled", rows("mass_muertos", "concert"),
    ref=[search("priest", kind="person"),
         ans(kind="event", linked_to="$ignacio", where="status != cancelled", when=W({"from": U("day", 0)}))]))

S("T32-052", "trashed note find-restore window",
  T("bring back the old shopping list note", diff(restore("old_note")),
    ref=[find(kind="note", trashed=True, name="shopping list"), act("restore", rows="@1")]),
  T("and the draft of the sign text", decline("not_found"),
    ref=[act("restore", kind="note", trashed=True, name="sign text")]))

S("T32-053", "broken-off clause create notebook add_to-two",
  T("move the van log into... hmm, new notebook called garage", diff(new("notebook", name=has("garage"))),
    ref=[act("create", args=lines(kind="notebook", name="Garage"))]),
  T("put the van log and house repairs in it", diff(link("+1", "van_log"), link("+1", "home_oaxaca")),
    ref=[act("add_to", rows="$van_log, $home_oaxaca", args="to: $c1")]))

S("T32-054", "bare-plural ask then both",
  T("move the two open photocopy jobs to friday", ask("copies", "recipe_card"),
    ref=[act("reschedule", kind="task", name="photocopy", where="status = open", args=lines(to=U("week", 0, weekday=5)))]),
  T("both", diff(upd("copies", date="2026-10-30"), upd("recipe_card", date="2026-10-30")),
    ref=[act("reschedule", rows="$copies, $recipe_card", args=lines(to=U("week", 0, weekday=5)))]))

S("T32-055", "decline text egress reveal unbounded",
  T("text maria that dinner is on thursday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("whatsapp the house wifi code to chela", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("ok just show me the house wifi code, the one at home, and star it",
    diff(upd("house_wifi", starred=True), reveal=[("house_wifi", "CasaOrtiz2020")]),
    ref=[act("reveal", rows="$house_wifi", args="field: password", more=True),
         act("star", rows="$house_wifi")]),
  T("wipe every task i have", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T32-056", "ambiguous log ask pick role then ambiguous cancel by weekday",
  T("log a call with maria", ask("maria_o", "marilu", "marichuy"),
    ref=[act("log", kind="person", name="Maria", args="kind: call")]),
  T("the choir soprano", diff(upd("marilu", date=ANY)),
    ref=[act("log", kind="person", name="Maria", where='role contains "soprano"', args="kind: call")]),
  T("cancel the market stall", ask("stall_oct31", "stall_nov01", "stall_nov02"),
    ref=[act("cancel", kind="event", name="market stall")]),
  T("saturday's one", diff(upd("stall_oct31", status="cancelled")),
    ref=[act("cancel", kind="event", name="market stall", when=W(U("week", 0, weekday=6)))]))

S("T32-057", "wedding chain named-month relation where date same-time day-before group-balance k4",
  T("what's open on the wedding list in november", rows("w_guests", "w_cake", "w_menu"),
    ref=[ans(kind="task", linked_to="$wedding_l", where="status = open", when=W(U("month", 0, name=11)))]),
  T("starred people at the cake tasting", rows("dani"),
    ref=[ans(kind="person", linked_to="$tasting", where="starred = yes")]),
  T("move the tasting to the 5th of december, same time", diff(upd("tasting", date="2026-12-05T16:00")),
    ref=[act("reschedule", rows="$tasting", args=lines(to=D("2026-12-05")))]),
  T("and the cake sample the day before", diff(upd("w_cake", date="2026-12-04")),
    ref=[act("reschedule", rows="$w_cake", args=lines(to=D("2026-12-04")))]),
  T("where am i in the boda group", val((18175, "MXN")),
    ref=[search("Rosa", kind="person"),
         ans(op="balance", kind="group", name="Boda de Dani", linked_to="$me")]),
  T("open high priority wedding jobs due before the tasting", rows("call_dani", "w_venue"),
    ref=[ans(kind="task", linked_to="$wedding_l", where="status = open and priority = 1", when=W({"to": D("2026-12-05")}))]))

S("T32-058", "choir find-answer exclude count-k4 decline create-task",
  T("who's coming to thursday's choir rehearsal", rows("aurelio", "marilu", "marichuy"),
    ref=[find(kind="event", name="Choir rehearsal", when=W(U("week", 0, weekday=4))),
         ans(kind="person", linked_to="@prev")]),
  T("which sopranos aren't on that list", rows("lupita", "xochitl"),
    ref=[ans(kind="person", linked_to="$coro", where='role contains "soprano"', exclude="@prev")]),
  T("rehearsals maestro cancelled this month, how many", val(1),
    ref=[ans(op="count", kind="event", name="Choir rehearsal", where="status = cancelled", when=W(U("month", 0)))]),
  T("text them", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("add a task to call lupita and xochitl, due tomorrow, on the choir list",
    diff(new("task", name=has("lupita", "xochitl"), date="2026-10-29", status="open"), link("choir_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Call Lupita and Xochitl", date=U("day", 1), list="$choir_l"))]))

S("T32-059", "van week long session ambiguous-task two-writes already-so",
  T("when's the van service, this week or next", rows("van_service"),
    ref=[ans(kind="event", name="Van service", when=W(span(U("week", 0), U("week", 1))))]),
  T("and the jobs for it", rows("van_a", "van_brakes"),
    ref=[ans(kind="task", name="Service the van", where="status = open")]),
  T("tick off the open van job, chuy did it", ask("van_a", "van_brakes"),
    ref=[act("complete", kind="task", name="Service the van", where="status = open")]),
  T("the brakes one", diff(upd("van_brakes", status="completed", completed=ANY)),
    ref=[act("complete", rows="$van_brakes")]),
  T("don chuy can't do tuesday so push the appointment and the main job to the 5th",
    diff(upd("van_service", date="2026-11-05T09:00"), upd("van_a", date="2026-11-05")),
    ref=[act("reschedule", rows="$van_service", args=lines(to=D("2026-11-05")), more=True),
         act("reschedule", rows="$van_a", args=lines(to=D("2026-11-05")))]),
  T("van insurance card for this year", rows("d_ins26"),
    ref=[ans(kind="document", name="Van insurance", when=W(U("year", 0)))]),
  T("star it", diff(already=["d_ins26"]),
    ref=[act("star", rows="$d_ins26"), ans(rows="$d_ins26")]))

S("T32-060", "repair money-unit k4 debts when",
  T("debts i still owe over a thousand pesos since september",
    rows("d_maria_roof", "d_memo_flour", "d_teodoro"),
    ref=[bad(ans(kind="debt", where="direction = i_owe and status = open and amount > 1000 pesos",
                 when=W({"from": D("2026-09-01")}))),
         ans(kind="debt", where="direction = i_owe and status = open and amount > 1000 MXN",
             when=W({"from": D("2026-09-01")}))]))

S("T32-061", "sum k4 debts month",
  T("total people still owe me from october", val((3120, "MXN")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open",
             when=W(U("month", 0)))]))

S("T32-062", "empty named-month recovery photos relation where",
  T("any starred photos of beto from august", rows(),
    ref=[ans(kind="photo", linked_to="$beto", where="starred = yes", when=W(U("month", 0, name=8)))]),
  T("september then", rows("p_ba_oven"),
    ref=[ans(kind="photo", linked_to="$beto", where="starred = yes", when=W(U("month", 0, name=9)))]))

S("T32-063", "compute group status direction",
  T("how many tasks by status", vgroups({"open": 46, "completed": 11, "in_progress": 1, "cancelled": 1}),
    ref=[comp(op="count", kind="task", group="status"), ans(value="@prev")]),
  T("open debts, what i owe versus owed to me", vgroups({"i_owe": (12026, "MXN"), "owes_me": (23120, "MXN")}),
    ref=[comp(op="sum", field="amount", kind="debt", where="status = open", group="direction"), ans(value="@prev")]))

S("T32-064", "find-then-star several relation where",
  T("star all three sopranos in the choir", diff(upd("marilu", starred=True), upd("lupita", starred=True),
                                              upd("xochitl", starred=True)),
    ref=[find(kind="person", linked_to="$coro", where='role contains "soprano"'),
         act("star", rows="@prev")]))

S("T32-065", "delete photo-in-album undo-photo delete-two restore-photo",
  T("delete the old sign photo, la espiga", diff(trash("p_ba_sign"), unlink("bakery_a", "p_ba_sign")),
    ref=[act("delete", kind="photo", name="old sign", linked_to="$bakery_a")]),
  T("wait undo that", diff(restore("p_ba_sign"), link("bakery_a", "p_ba_sign")),
    ref=[act("undo")]),
  T("delete the receipt for the boxes and the repaint the sign task, both are dead now",
    diff(trash("p_receipt"), trash("new_sign")),
    ref=[act("delete", kind="photo", name="receipt", more=True),
         act("delete", kind="task", name="Repaint the bakery sign")]),
  T("bring back the blurry one", diff(restore("p_blurry")),
    ref=[act("restore", kind="photo", trashed=True, name="blurry")]))

