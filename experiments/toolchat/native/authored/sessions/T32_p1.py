from gold import *

import json

world("T32", "2026-10-28T16:10", "Rosa Delgado-Ortiz", "train")

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T32-001-P", "empty follow-up within complete write-then-read bakery-list para",
  T("bakery list, what's still open for today", rows(),
    ref=[ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("day", 0)))]),
  T("what about tomorrow", rows("mu_orange", "mu_boxes", "yeast"),
    ref=[ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("day", 1)))]),
  T("nothing longer than half an hour", rows("mu_orange", "yeast"),
    ref=[ans(within="@prev", where="effort <= 30")]),
  T("those two are done so mark them complete, then what's still open on the bakery list for tomorrow",
    rows("mu_boxes", also=diff(upd("mu_orange", status="completed", completed=ANY),
                                upd("yeast", status="completed", completed=ANY))),
    ref=[act("complete", rows="@prev", more=True),
         ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("day", 1)))]))

S("T32-004-P", "cancel ambiguous ask pick undo-not-undone para",
  T("the posada's off, cancel it", ask("posada_bakery", "posada_street"),
    ref=[act("cancel", kind="event", name="Posada")]),
  T("bakery one", diff(upd("posada_bakery", status="cancelled")),
    ref=[act("cancel", rows="$posada_bakery")]),
  T("we're still doing it after all, so undo", diff(),
    ref=[act("undo")]))

S("T32-007-P", "locker read reveal egress para",
  T("pw for the bakery wifi?", rows("bakery_wifi"),
    ref=[ans(kind="locker item", name="Bakery wifi")]),
  T("yes show me", diff(reveal=[("bakery_wifi", "LaEspiga1998")]),
    ref=[act("reveal", rows="$bakery_wifi", args="field: password")]),
  T("send it over to her by text", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T32-010-P", "notes notebook contains year pin write-then-read para",
  T("this year's bakery notes that talk about flour", rows("b_suppliers"),
    ref=[ans(kind="note", linked_to="$bakery_nb", where='body contains "flour"', when=W(U("year", 0)))]),
  T("pin that one, and what's its text", rows("b_suppliers", also=diff(upd("b_suppliers", pinned=True))),
    ref=[act("edit", rows="$b_suppliers", args="pinned: yes", more=True),
         ans(rows="$b_suppliers")]),
  T("choir notebook, anything there with lupita in it", rows("c_dues"),
    ref=[ans(kind="note", linked_to="$coro_nb", where='body contains "Lupita"')]))

S("T32-013-P", "photos linked album within star add_to count-k4 para",
  T("la espiga album, show the photos with emi in them", rows("p_ba_loaves", "p_ba_van"),
    ref=[ans(kind="photo", linked_to="$emi, $bakery_a")]),
  T("starred only", rows("p_ba_loaves"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("it belongs in the dani and emi album as well", diff(link("kids_a", "p_ba_loaves")),
    ref=[act("add_to", rows="$p_ba_loaves", args="to: $kids_a")]),
  T("count of this year's starred photos in the dani and emi album", val(1),
    ref=[ans(op="count", kind="photo", linked_to="$kids_a", where="starred = yes", when=W(U("year", 0)))]),
  T("call the dani and emi album the kids from now on and give me its photo count",
    val(6, also=diff(upd("kids_a", name="The kids"))),
    ref=[act("edit", rows="$kids_a", args="name: The kids", more=True),
         ans(op="count", kind="photo", linked_to="$kids_a")]))

S("T32-016-P", "group create add_to-new members para",
  T("set up crew as a group in pesos with beto, yesenia and emi in it",
    diff(new("group", name=has("crew"), currency="MXN"), link("new", "me"), link("new", "beto"), link("new", "yesenia"),
         link("new", "emi")),
    ref=[act("create", args="kind: group\nname: Crew\ncurrency: MXN", more=True),
         act("add_to", rows="$beto, $yesenia, $emi", args="to: $new")]),
  T("also need a list called crew jobs for the same people", diff(new("list", name=has("crew", "jobs"))),
    ref=[act("create", args="kind: list\nname: Crew jobs")]))

S("T32-019-P", "repair refused-unit cadence edit-and-unstar two-writes para",
  T("starred people i should be in touch with more often than every two weeks",
    rows("emi", "dani", "carmen", "beto", "aurelio"),
    ref=[bad(ans(kind="person", where="starred = yes and cadence < 2 weeks")),
         ans(kind="person", where="starred = yes and cadence < 14")]),
  T("beto to every other day, and take the star off the maestro",
    diff(upd("beto", cadence=2), upd("aurelio", starred=False)),
    ref=[act("edit", rows="$beto", args="cadence: 2", more=True),
         act("unstar", rows="$aurelio")]))

S("T32-022-P", "trashed find-restore decline-window read trashed-filters restore-by-name para",
  T("she's helping for muertos so karla needs to come back", diff(restore("old_emp")),
    ref=[find(kind="person", trashed=True, name="Karla"), act("restore", rows="@1")]),
  T("hilario as well", decline("not_found"),
    ref=[act("restore", kind="person", trashed=True, name="Hilario")]),
  T("which bakery tasks did i delete that are still open", rows("old_karla_t", "old_sup_t"),
    ref=[ans(kind="task", linked_to="$bakery_l", where="status = open", trashed=True)]),
  T("karla's wages task on the bakery list needs to come back", diff(restore("old_karla_t")),
    ref=[act("restore", kind="task", trashed=True, name="Karla", linked_to="$bakery_l")]))

S("T32-025-P", "balance person-role group-narrow settle_up-and-remove para",
  T("maria my sister, where do i stand", val((-2477.5, "MXN")),
    ref=[ans(op="balance", kind="person", name="Maria", where='role = "sister"')]),
  T("familia group only", val((1237.5, "MXN")),
    ref=[ans(op="balance", kind="group", name="Familia Delgado Ortiz", linked_to="$maria_o")]),
  T("first settle up with her in that group, then take her out of it",
    diff(upd("maria_o", balance=ANY), unlink("familia", "maria_o"), settle=[("Maria Ortiz", "1237.50")]),
    ref=[act("settle_up", rows="$maria_o", args="group: $familia", more=True),
         act("remove_from", rows="$maria_o", args="from: $familia")]))

S("T32-028-P", "bulk-cap ask yes delete events exclude para",
  T("every event that's already passed, get rid of them",
    ask(),
    ref=[act("delete", kind="event", when=W({"to": U("day", -1)}))]),
  T("yes please, do it",
    diff(trash("van_tires"), trash("accountant_b"), trash("pickup_flor_old"), trash("oven_old"), trash("flour_0929"),
         trash("coro_1001"), trash("calldani_1004"), trash("coro_1008"), trash("flour_1013"), trash("coro_1015"),
         trash("calldani_1011"), trash("calldani_1018"), trash("workshop_b"), trash("coro_1022"), trash("calldani_1025"),
         trash("flour_1027")),
    ref=[act("delete", kind="event", when=W({"to": U("day", -1)}))]),
  T("besides the stall days, what else do i have this week on the calendar",
    rows("pickup_flor", "coro_1029", "dani_arrives", "cemetery", "calldani_1101"),
    ref=[find(kind="event", name="market stall"),
         ans(kind="event", when=W(U("week", 0)), exclude="@prev")]))

S("T32-031-P", "create clash ask then create empty-search para",
  T("thursday at 8 i'm having dinner with maria, put it in", ask("coro_1029"),
    ref=[act("create", args=lines(kind="event", name="Dinner with Maria", date=U("week", 0, weekday=4, time="20:00")))]),
  T("let's do friday", diff(new("event", name=has("dinner"), date="2026-10-30T20:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Maria", date=U("week", 0, weekday=5, time="20:00")))]),
  T("got a florist anywhere in my contacts", rows(),
    ref=[search("florist"),
         ans(kind="person", where='role contains "florist"')]))

S("T32-034-P", "create task fields list priority filter within-longest para",
  T("new task on the family list, call the notary, next tuesday, high priority",
    diff(new("task", name=has("notary"), date="2026-11-03", priority=1, status="open"), link("family_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Call the notary", date=U("week", 1, weekday=2), priority=1,
                                  list="$family_l"))]),
  T("family list items still open that fall due by the end of november", rows("carmen_meds", "emi_gift", "carmen_gift", "+1"),
    ref=[ans(kind="task", linked_to="$family_l", where="status = open", when=W({"to": D("2026-11-30")}))]),
  T("longest one?", rows("carmen_gift"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]))

S("T32-037-P", "misspelled two-logs balance usd-group where-when para",
  T("log them, i rang gabriella just now and had coffee with don memo this morning",
    diff(upd("gaby", date=ANY), upd("memo", date=ANY)),
    ref=[act("log", kind="person", name="Gabriella", args="kind: call", more=True),
         act("log", rows="$memo", args="kind: coffee")]),
  T("what's the balance with her", val((-30, "USD")),
    ref=[ans(op="balance", rows="$gaby")]),
  T("who did i talk to this week among starred people with a cadence under 4 days",
    rows("emi", "dani", "carmen", "beto"),
    ref=[ans(kind="person", where="starred = yes and cadence <= 3", when=W(U("week", 0)))]))

S("T32-040-P", "photos person where star-both-then-read empty-search para",
  T("rodrigo's photos without a star", rows("p_wedding_venue", "p_ki_ring"),
    ref=[ans(kind="photo", linked_to="$rodrigo", where="starred = no")]),
  T("put a star on both, then which ones are starred now",
    rows("p_wedding_venue", "p_ki_ring", also=diff(upd("p_wedding_venue", starred=True), upd("p_ki_ring", starred=True))),
    ref=[act("star", rows="@prev", more=True),
         ans(within="@1", where="starred = yes")]),
  T("baptism pictures from last year, got any", rows(),
    ref=[search("baptism"),
         ans(kind="photo", name="baptism", when=W(U("year", -1)))]))

S("T32-043-P", "locker where two-writes star unstar restore-locker para",
  T("show my starred logins", rows("bbva_login"),
    ref=[ans(kind="locker item", where='type = "login" and starred = yes')]),
  T("username for sat portal?", rows("sat_login"),
    ref=[ans(kind="locker item", name="SAT portal")]),
  T("put a star on that one, and take it off the bbva one", diff(upd("sat_login", starred=True), upd("bbva_login", starred=False)),
    ref=[act("star", rows="$sat_login", more=True),
         act("unstar", rows="$bbva_login")]),
  T("the old telmex login, can i have it back", diff(restore("old_login")),
    ref=[act("restore", kind="locker item", trashed=True, name="Telmex")]),
  T("retitle the sat one as sat tax portal", diff(upd("sat_login", name="SAT tax portal")),
    ref=[act("edit", rows="$sat_login", args="name: SAT tax portal")]))

S("T32-046-P", "search find-only within multi-kind when reschedule cancel-by-date para",
  T("got anything on the oven", rows("oven_fix", "oven_old", "oven_part", "b_oven", "p_oven_serial", "p_ba_oven"),
    ref=[find(kind="event,task,note,photo", name="oven"), ans(rows="@prev")]),
  T("of those, which land before december", rows("oven_fix", "oven_old", "oven_part"),
    ref=[ans(within="@prev", kind="task,event", when=W({"to": D("2026-11-30")}))]),
  T("the thermostat order should be friday now", diff(upd("oven_part", date="2026-10-30")),
    ref=[act("reschedule", rows="$oven_part", args=lines(to=U("week", 0, weekday=5)))]),
  T("the maintenance on the ninth is off, cancel it", diff(upd("oven_fix", status="cancelled")),
    ref=[act("cancel", kind="event", name="Oven maintenance", when=W(D("2026-11-09")))]))

S("T32-049-P", "repair weekend list when empty-follow-up para",
  T("bakery list items still open this weekend", rows("mu_stall", "wages"),
    ref=[bad(ans(kind="task", linked_to="$bakery_l", where="status = open", when=W({"weekday": 6}))),
         ans(kind="task", linked_to="$bakery_l", where="status = open",
             when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]),
  T("sunday only?", rows(),
    ref=[ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("week", 0, weekday=7)))]))

S("T32-052-P", "trashed note find-restore window para",
  T("undelete the old shopping list note", diff(restore("old_note")),
    ref=[find(kind="note", trashed=True, name="shopping list"), act("restore", rows="@1")]),
  T("sign text draft too", decline("not_found"),
    ref=[act("restore", kind="note", trashed=True, name="sign text")]))

S("T32-058-P", "choir find-answer exclude count-k4 decline create-task para",
  T("thursday's choir rehearsal, who's on the list", rows("aurelio", "marilu", "marichuy"),
    ref=[find(kind="event", name="Choir rehearsal", when=W(U("week", 0, weekday=4))),
         ans(kind="person", linked_to="@prev")]),
  T("any sopranos missing from it", rows("lupita", "xochitl"),
    ref=[ans(kind="person", linked_to="$coro", where='role contains "soprano"', exclude="@prev")]),
  T("how many choir rehearsals did the maestro call off this month", val(1),
    ref=[ans(op="count", kind="event", name="Choir rehearsal", where="status = cancelled", when=W(U("month", 0)))]),
  T("text them", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("choir list, new task by tomorrow, call lupita and xochitl",
    diff(new("task", name=has("lupita", "xochitl"), date="2026-10-29", status="open"), link("choir_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Call Lupita and Xochitl", date=U("day", 1), list="$choir_l"))]))

S("T32-064-P", "find-then-star several relation where para",
  T("give a star to all three sopranos in the choir", diff(upd("marilu", starred=True), upd("lupita", starred=True),
                                              upd("xochitl", starred=True)),
    ref=[find(kind="person", linked_to="$coro", where='role contains "soprano"'),
         act("star", rows="@prev")]))

S("T32-067-P", "same-word-pick star document topic two-row-linked_to ask-person para",
  T("put a star on the health inspection one", diff(upd("d_health", starred=True)),
    ref=[act("star", kind="document", name="health inspection")]),
  T("sat one as well", diff(upd("d_sat26", starred=True)),
    ref=[act("star", kind="document", name="sat")]),
  T("jobs on the wedding list for rodrigo", rows("w_menu"),
    ref=[ans(kind="task", linked_to="$wedding_l, $rodrigo")]),
  T("star maria as well", ask("maria_o", "marilu", "marichuy"),
    ref=[act("star", kind="person", name="Maria")]))

S("T32-070-P", "same-word-pick both second-event posada group-decoy event-vs-group para",
  T("the bakery posada and the vecinal posada both need to happen a day earlier",
    diff(upd("posada_bakery", date="2026-12-15T18:00"), upd("posada_street", date="2026-12-22T19:00")),
    ref=[act("reschedule", rows="$posada_bakery, $posada_street", args=lines(to=U("day", -1, anchor="row")))]),
  T("vecinal one, who's coming", rows("chela", "lupe_r"),
    ref=[ans(kind="person", linked_to="$posada_street")]),
  T("and the group itself, who's in it", rows("me", "chela", "lupe_r"),
    ref=[ans(kind="person", linked_to="$posada")]))

S("T32-076-P", "verb-choice put-it-back remove_from add_to album count para",
  T("remove the old sign pic from la espiga, then count what's left in there",
    val(7, also=diff(unlink("bakery_a", "p_ba_sign"))),
    ref=[act("remove_from", kind="photo", name="old sign", args="from: $bakery_a", more=True),
         ans(op="count", kind="photo", linked_to="$bakery_a")]),
  T("stick it back in", diff(link("bakery_a", "p_ba_sign")),
    ref=[act("add_to", rows="$p_ba_sign", args="to: $bakery_a")]),
  T("open jobs on the wedding list", rows("call_dani", "w_guests", "w_menu", "w_venue", "w_cake", "w_rooms", "w_rings"),
    ref=[ans(kind="task", linked_to="$wedding_l", where="status = open")]),
  T("menu's underway, so set it to in progress and list the other open jobs on the wedding list",
    rows("call_dani", "w_guests", "w_venue", "w_cake", "w_rooms", "w_rings", also=diff(upd("w_menu", status="in_progress"))),
    ref=[act("edit", rows="$w_menu", args="status: in_progress", more=True),
         ans(kind="task", linked_to="$wedding_l", where="status = open", exclude="$w_menu")]))

S("T32-079-P", "verb-choice reschedule-chain make-it-hour no-wait-weekday bare-attribute-edit para",
  T("dr cervantes check up, tuesday instead", diff(upd("doctor", date="2026-11-03T16:30")),
    ref=[act("reschedule", kind="event", name="Dr Cervantes", args=lines(to=U("week", 1, weekday=2)))]),
  T("5 works better", diff(upd("doctor", date="2026-11-03T17:00")),
    ref=[act("reschedule", rows="$doctor", args=lines(to=U("day", 0, anchor="row", time="17:00")))]),
  T("scratch that, thursday", diff(upd("doctor", date="2026-10-29T17:00")),
    ref=[act("reschedule", rows="$doctor", args=lines(to=U("week", 0, weekday=4)))]),
  T("give it an hour and a half", diff(upd("doctor", duration=90)),
    ref=[act("edit", rows="$doctor", args="duration: 90")]))

S("T32-088-P", "set-answers same-word events weekday decides stall pickup ask-then-weekday para",
  T("sunday market stall opening time?", rows("stall_nov01"),
    ref=[ans(kind="event", name="market stall", when=W(U("week", 0, weekday=7)))]),
  T("monday's?", rows("stall_nov02"),
    ref=[ans(kind="event", name="market stall", when=W(U("week", 1, weekday=1)))]),
  T("flor pickup, make that fri", ask("pickup_flor", "pickup_flor2"),
    ref=[act("reschedule", kind="event", name="Order pickup - Flor", args=lines(to=U("week", 0, weekday=5)))]),
  T("thursday's one", diff(upd("pickup_flor", date="2026-10-30T10:00")),
    ref=[act("reschedule", kind="event", name="Order pickup - Flor", when=W(U("week", 0, weekday=4)),
             args=lines(to=U("week", 0, weekday=5)))]))
