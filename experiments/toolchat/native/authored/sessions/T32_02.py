from gold import *
import json

world("T32", "2026-10-28T16:10", "Rosa Delgado-Ortiz", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T32-023", "bulk reschedule filter list date within write-then-count",
  T("bump all of tomorrow's open bakery jobs to friday",
    diff(upd("mu_orange", date="2026-10-30"), upd("mu_boxes", date="2026-10-30"), upd("yeast", date="2026-10-30")),
    ref=[find(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("day", 1))),
         act("reschedule", rows="@prev", args=lines(to=U("week", 0, weekday=5)))]),
  T("and what's open on the bakery list friday",
    rows("mu_sugar", "mu_float", "tea_towels", "mu_orange", "mu_boxes", "yeast"),
    ref=[ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("week", 0, weekday=5)))]),
  T("just half hour or under", rows("mu_orange", "yeast", "mu_sugar", "mu_float"),
    ref=[ans(within="@prev", where="effort <= 30")]),
  T("tick the yeast and sugar, how many left for friday",
    val(4, also=diff(upd("yeast", status="completed", completed=ANY), upd("mu_sugar", status="completed", completed=ANY))),
    ref=[act("complete", rows="$yeast, $mu_sugar", more=True),
         ans(op="count", kind="task", linked_to="$bakery_l", where="status = open", when=W(U("week", 0, weekday=5)))]))

S("T32-024", "superlative order-limit debts settle_debt effort-sum",
  T("longest open job on the wedding list", rows("w_cake"),
    ref=[ans(kind="task", linked_to="$wedding_l", where="status = open", order="effort desc", limit=1)]),
  T("and the biggest debt i still owe", rows("d_teodoro"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount desc", limit=1)]),
  T("and the oldest one i owe", rows("d_maria_roof"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="date asc", limit=1)]),
  T("paid maria for the roof, settle it", diff(upd("d_maria_roof", status="settled")),
    ref=[act("settle_debt", rows="$d_maria_roof")]),
  T("how many minutes of work are left on the bakery list this week", val(285),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$bakery_l", where="status = open", when=W(U("week", 0)))]),
  T("bump the longest open wedding job to 200 minutes", diff(upd("w_cake", effort=200)),
    ref=[act("edit", kind="task", linked_to="$wedding_l", where="status = open", order="effort desc", limit=1,
             args="effort: 200")]))

S("T32-025", "balance person-role group-narrow settle_up-and-remove",
  T("where am i with my sister maria", val((-2477.5, "MXN")),
    ref=[ans(op="balance", kind="person", name="Maria", where='role = "sister"')]),
  T("just the familia group", val((1237.5, "MXN")),
    ref=[ans(op="balance", kind="group", name="Familia Delgado Ortiz", linked_to="$maria_o")]),
  T("settle up with her there and then take her out of the group",
    diff(upd("maria_o", balance=ANY), unlink("familia", "maria_o"), settle=[("Maria Ortiz", "1237.50")]),
    ref=[act("settle_up", rows="$maria_o", args="group: $familia", more=True),
         act("remove_from", rows="$maria_o", args="from: $familia")]))

S("T32-026", "events linked status when week cancel",
  T("what's on with dani between now and sunday, not cancelled", rows("dani_arrives", "calldani_1101"),
    ref=[ans(kind="event", linked_to="$dani", where="status != cancelled", when=W(span(U("day", 0), U("week", 0, weekday=7))))]),
  T("and next week", rows("dani_leaves", "calldani_1108"),
    ref=[ans(kind="event", linked_to="$dani", where="status != cancelled", when=W(U("week", 1)))]),
  T("cancel the sunday call that week", diff(upd("calldani_1108", status="cancelled")),
    ref=[act("cancel", kind="event", name="Call Dani", when=W(U("week", 1, weekday=7)))]))

S("T32-027", "trashed documents restore window in-folder",
  T("bring back the permit one", diff(restore("d_old_perm")),
    ref=[act("restore", kind="document", trashed=True, name="permit")]),
  T("and the oven quote", decline("not_found"),
    ref=[act("restore", kind="document", trashed=True, name="oven quote")]),
  T("is the 2024 permit back in the bakery folder", rows("d_old_perm"),
    ref=[ans(kind="document", name="permit 2024", linked_to="$bakery_f")]))

S("T32-028", "bulk-cap ask yes delete events exclude",
  T("clear out all the events that are already over",
    ask(),
    ref=[act("delete", kind="event", when=W({"to": U("day", -1)}))]),
  T("yes go ahead",
    diff(trash("van_tires"), trash("accountant_b"), trash("pickup_flor_old"), trash("oven_old"), trash("flour_0929"),
         trash("coro_1001"), trash("calldani_1004"), trash("coro_1008"), trash("flour_1013"), trash("coro_1015"),
         trash("calldani_1011"), trash("calldani_1018"), trash("workshop_b"), trash("coro_1022"), trash("calldani_1025"),
         trash("flour_1027")),
    ref=[act("delete", kind="event", when=W({"to": U("day", -1)}))]),
  T("what's left on the calendar this week besides the stall days",
    rows("pickup_flor", "coro_1029", "dani_arrives", "cemetery", "calldani_1101"),
    ref=[find(kind="event", name="market stall"),
         ans(kind="event", when=W(U("week", 0)), exclude="@prev")]))

S("T32-029", "ambiguous star ask pick role find-then-star",
  T("star hernandez", ask("lupita", "lupe_r", "chuy"),
    ref=[act("star", kind="person", name="Hernandez")]),
  T("the neighbour", diff(upd("lupe_r", starred=True)),
    ref=[act("star", kind="person", name="Hernandez", where='role = "neighbour"')]),
  T("and the other hernandez from the choir", diff(upd("lupita", starred=True)),
    ref=[find(kind="person", name="Hernandez", where='role contains "choir"'),
         act("star", rows="@prev")]))

S("T32-030", "remove_from refused balance ask then debt settle write-then-read",
  T("take emi out of the familia group", ask("emi", "familia"),
    ref=[act("remove_from", kind="person", name="Emi", args="from: $familia")]),
  T("where am i with him", val((562.5, "MXN")),
    ref=[ans(op="balance", rows="$emi")]),
  T("does he owe me anything still open", rows("d_emi"),
    ref=[ans(kind="debt", linked_to="$emi", where="direction = owes_me and status = open")]),
  T("he paid me in cash this morning, so settle it and show me what's still owed to me",
    rows("d_maria_med", "d_dani", "d_rodrigo", "d_flor", "d_omar", also=diff(upd("d_emi", status="settled"))),
    ref=[act("settle_debt", kind="debt", linked_to="$emi", where="status = open", more=True),
         ans(kind="debt", where="direction = owes_me and status = open")]))

S("T32-031", "create clash ask then create empty-search",
  T("add dinner with maria thursday at 8", ask("coro_1029"),
    ref=[act("create", args=lines(kind="event", name="Dinner with Maria", date=U("week", 0, weekday=4, time="20:00")))]),
  T("make it friday", diff(new("event", name=has("dinner"), date="2026-10-30T20:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Maria", date=U("week", 0, weekday=5, time="20:00")))]),
  T("is there a florist in my contacts", rows(),
    ref=[search("florist"),
         ans(kind="person", where='role contains "florist"')]))

S("T32-032", "event series ask by date reschedule count-month cancel-date",
  T("push the flour delivery to the 11th",
    ask("flour_0929", "flour_1013", "flour_1027", "flour_1110", "flour_1124", "flour_1208", "flour_1222"),
    ref=[act("reschedule", kind="event", name="Flour delivery", args=lines(to=D("2026-11-11")))]),
  T("the one on the tenth of november", diff(upd("flour_1110", date="2026-11-11T05:30")),
    ref=[act("reschedule", rows="$flour_1110", args=lines(to=D("2026-11-11")))]),
  T("how many flour deliveries left in december", val(2),
    ref=[ans(op="count", kind="event", name="Flour delivery", when=W(U("month", 0, name=12)))]),
  T("cancel the 22nd of december one", diff(upd("flour_1222", status="cancelled")),
    ref=[act("cancel", kind="event", name="Flour delivery", when=W(D("2026-12-22")))]))

S("T32-033", "reopen-by-month then reschedule then exclude",
  T("reopen the september cfe payment", diff(upd("cfe_sep", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Pay the CFE electricity bill", when=W(U("month", 0, name=9)))]),
  T("and push it to friday", diff(upd("cfe_sep", date="2026-10-30")),
    ref=[act("reschedule", rows="$cfe_sep", args=lines(to=U("week", 0, weekday=5)))]),
  T("what else is due friday on the bakery list besides the cfe one", rows("mu_sugar", "mu_float", "tea_towels"),
    ref=[ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("week", 0, weekday=5)),
             exclude="$cfe_sep")]))

S("T32-034", "create task fields list priority filter within-longest",
  T("add a task to call the notary next tuesday, high priority, put it on the family list",
    diff(new("task", name=has("notary"), date="2026-11-03", priority=1, status="open"), link("family_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Call the notary", date=U("week", 1, weekday=2), priority=1,
                                  list="$family_l"))]),
  T("open family tasks due before the end of november", rows("carmen_meds", "emi_gift", "carmen_gift", "+1"),
    ref=[ans(kind="task", linked_to="$family_l", where="status = open", when=W({"to": D("2026-11-30")}))]),
  T("which is the longest", rows("carmen_gift"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]))

S("T32-035", "subtasks container within order-limit add_to-parent-declined when",
  T("what's left under dia de muertos orders this week", rows("mu_orange", "mu_boxes", "mu_sugar", "mu_stall", "mu_float"),
    ref=[ans(kind="task", linked_to="$muertos", where="status = open", when=W(U("week", 0)))]),
  T("the longest one", rows("mu_stall"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]),
  T("put the tablecloths under it too", decline("out_of_scope"),
    ref=[act("add_to", rows="$tea_towels", args="to: $muertos")]))

S("T32-036", "person create-and-star cadence",
  T("add hector ramos the notary as a contact and star him",
    diff(new("person", name=has("hector", "ramos"), role="notary", starred=True)),
    ref=[act("create", args=lines(kind="person", name="Hector Ramos", role="notary"), more=True),
         act("star", rows="$new")]),
  T("talk to him every 30 days", diff(upd("+1", cadence=30)),
    ref=[act("edit", rows="$c1", args="cadence: 30")]))

S("T32-037", "misspelled two-logs balance usd-group where-when",
  T("rang gabriella just now and had coffee with don memo this morning, log them",
    diff(upd("gaby", date=ANY), upd("memo", date=ANY)),
    ref=[act("log", kind="person", name="Gabriella", args="kind: call", more=True),
         act("log", rows="$memo", args="kind: coffee")]),
  T("where am i with her", val((-30, "USD")),
    ref=[ans(op="balance", rows="$gaby")]),
  T("starred people i spoke to this week with cadence under 4 days",
    rows("emi", "dani", "carmen", "beto"),
    ref=[ans(kind="person", where="starred = yes and cadence <= 3", when=W(U("week", 0)))]))

S("T32-038", "note create notebook move delete-notebook write-then-read",
  T("new note in the ideas notebook, try a pan de elote for the posadas",
    diff(new("note", name=ANY, body=has("pan de elote")), link("ideas_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Pan de elote", body="try a pan de elote for the posadas",
                                  notebook="$ideas_nb"))]),
  T("that's a recipe, move it to recetas", diff(unlink("ideas_nb", "+1"), link("recipes_nb", "+1")),
    ref=[act("add_to", rows="$c1", args="to: $recipes_nb")]),
  T("delete the empty ideas notebook, which are left",
    rows("recipes_nb", "bakery_nb", "coro_nb", also=diff(gone("ideas_nb"))),
    ref=[act("delete", rows="$ideas_nb", more=True),
         ans(kind="notebook")]))

S("T32-039", "trashed-note-read note open-then-edit-body two-edits pin unpin",
  T("any deleted notes from this year that mention the oven", rows("old_draft"),
    ref=[ans(kind="note", trashed=True, where='body contains "oven"', when=W(U("year", 0)))]),
  T("add a picture frame to carmen's gift ideas note",
    diff(upd("gift_carmen", body=has("rebozo", "picture frame"))),
    ref=[opn("$gift_carmen"),
         act("edit", rows="$gift_carmen", args="body: a rebozo, new glasses, a rocking chair for the patio, a picture frame")]),
  T("pin it", diff(upd("gift_carmen", pinned=True)),
    ref=[act("edit", rows="$gift_carmen", args="pinned: yes")]))

S("T32-040", "photos person where star-both-then-read empty-search",
  T("which photos of rodrigo aren't starred", rows("p_wedding_venue", "p_ki_ring"),
    ref=[ans(kind="photo", linked_to="$rodrigo", where="starred = no")]),
  T("star both, then which are starred",
    rows("p_wedding_venue", "p_ki_ring", also=diff(upd("p_wedding_venue", starred=True), upd("p_ki_ring", starred=True))),
    ref=[act("star", rows="@prev", more=True),
         ans(within="@1", where="starred = yes")]),
  T("any photos of the baptism from last year", rows(),
    ref=[search("baptism"),
         ans(kind="photo", name="baptism", when=W(U("year", -1)))]))

S("T32-041", "document rename-repair folder-linked where empty-search",
  T("rename the invitation draft in the wedding folder to final invitations", diff(upd("d_invites", name="Final invitations")),
    ref=[bad(act("edit", kind="document", name="invitation", linked_to="$wedding_f", args="title: Final invitations")),
         act("edit", kind="document", name="invitation", linked_to="$wedding_f", args="name: Final invitations")]),
  T("which wedding documents are starred", rows("d_venue"),
    ref=[ans(kind="document", linked_to="$wedding_f", where="starred = yes")]),
  T("any mortgage doc in the bakery folder", rows(),
    ref=[search("mortgage"),
         ans(kind="document", name="mortgage", linked_to="$bakery_f")]))

S("T32-042", "folder delete ask then write-then-read",
  T("delete the family folder", ask("d_carmen_id", "d_deed"),
    ref=[act("delete", rows="$family_f")]),
  T("delete the empty one, folders left?",
    rows("bakery_f", "van_f", "family_f", "wedding_f", also=diff(gone("empty_f"))),
    ref=[act("delete", kind="folder", where="document count = 0", more=True),
         ans(kind="folder")]),
  T("new taxes folder, put the sat return in it",
    diff(new("folder", name=has("taxes")), unlink("bakery_f", "d_sat26"), link("new", "d_sat26")),
    ref=[act("create", args="kind: folder\nname: Taxes", more=True),
         act("add_to", rows="$d_sat26", args="to: $new")]))

S("T32-043", "locker where two-writes star unstar restore-locker",
  T("which logins have i starred", rows("bbva_login"),
    ref=[ans(kind="locker item", where='type = "login" and starred = yes')]),
  T("sat portal username?", rows("sat_login"),
    ref=[ans(kind="locker item", name="SAT portal")]),
  T("star that one, unstar the bbva one", diff(upd("sat_login", starred=True), upd("bbva_login", starred=False)),
    ref=[act("star", rows="$sat_login", more=True),
         act("unstar", rows="$bbva_login")]),
  T("and the old telmex login", diff(restore("old_login")),
    ref=[act("restore", kind="locker item", trashed=True, name="Telmex")]),
  T("and rename the sat one to sat tax portal", diff(upd("sat_login", name="SAT tax portal")),
    ref=[act("edit", rows="$sat_login", args="name: SAT tax portal")]))

S("T32-044", "empty-search recovery multi-call month year where person-create",
  T("any hotel booked for dani's wedding", rows(),
    ref=[search("hotel"),
         ans(kind="event", name="hotel", linked_to="$dani")]),
  T("any bakery notes on the oven warranty this year", rows(),
    ref=[search("warranty"),
         ans(kind="note", linked_to="$bakery_nb", where='body contains "warranty"', when=W(U("year", 0)))]),
  T("plumber i met at the mercado?", rows(),
    ref=[search("plumber"),
         ans(kind="person", where='role contains "plumber" and met contains "Mercado"')]),
  T("task: find a plumber by december first", diff(new("task", name=has("plumber"), date="2026-12-01", status="open")),
    ref=[act("create", args=lines(kind="task", name="Find a plumber", date=D("2026-12-01")))]))

