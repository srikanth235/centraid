from gold import *
import json

world("T30", "2027-02-16T21:05", "Élise Gagnon-Lavoie", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T30-114", "ask-content debt create balance documents find-act star unstar name when count where",
  T("i owe mat for the movie", ask(),
    ref=[askc("How much did you owe Mat for the movie?")]),
  T("eighteen dollars", diff(new("debt", name=has("movie"), amount=18, direction="i_owe"), link("new", "mathieu")),
    ref=[act("create", args="kind: debt\nname: movie\namount: 18\ndirection: i_owe\nperson: $mathieu")]),
  T("so what's my overall balance with mat after the movie", val((115.33, "CAD"), (635, "EUR"), (-292.5, "USD")),
    ref=[ans(op="balance", kind="person", name="Mat")]),
  T("star every report card from 2025 and 2026", diff(upd("doc_35", starred=True), upd("doc_33", starred=True), upd("doc_59", starred=True),
                                                     upd("doc_34", starred=True), upd("doc_60", starred=True)),
    ref=[find(kind="document", name="report card", when=J(span(D("2025-01-01"), D("2026-12-31")))),
         act("star", rows="@prev")]),
  T("unstar the ones for émile", diff(upd("doc_34", starred=False), upd("doc_60", starred=False)),
    ref=[find(kind="document", name="report card Émile", where="starred = yes"),
         act("unstar", rows="@prev")]),
  T("how many report cards are starred now", val(3),
    ref=[ans(op="count", kind="document", name="report card", where="starred = yes")]))

S("T30-115", "repair cadence-unit where edit log person tasks count where when complete within",
  T("which people am i supposed to see every two weeks", rows("mamie", "papa"),
    ref=[bad(ans(kind="person", where="cadence = 2 weeks")),
         ans(kind="person", where="cadence = 14")]),
  T("make papa weekly", diff(upd("papa", cadence=7)),
    ref=[act("edit", rows="$papa", args="cadence: 7")]),
  T("and add a log entry saying i called him", diff(upd("papa", date=ANY)),
    ref=[act("log", rows="$papa", args="kind: call")]),
  T("how many open compost tasks are there", val(3),
    ref=[ans(op="count", kind="task", name="Take out compost", where="status = open")]),
  T("which ones are from before this year", rows("cmp_250303", "cmp_250602"),
    ref=[ans(kind="task", name="Take out compost", where="status = open", when=J({"to": U("year", -1)}))]),
  T("tick those off, did them ages ago",
    diff(upd("cmp_250303", status="completed", completed=ANY), upd("cmp_250602", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]))

S("T30-116", "ask-referent cancel tomorrow read",
  T("cancel it", ask(),
    ref=[askc("Cancel which event?")]),
  T("tomorrow's tire swap", diff(upd("oo_038", status="cancelled")),
    ref=[act("cancel", kind="event", name="Winter tires swap", when=J(U("day", 1)))]),
  T("is the library run tomorrow too", rows("oo_029"),
    ref=[ans(kind="event", name="library", when=J(U("day", 1)))]))

S("T30-117", "ask-content remind create edit priority",
  T("remind me", ask(),
    ref=[askc("What should I remind you about?")]),
  T("to call the landlord about the heating on friday, it's been freezing in the kitchen and he keeps saying he'll send someone but nobody ever shows up",
    diff(new("task", name=has("landlord"), date="2027-02-19")),
    ref=[bad(act("create", args="kind: task\nname: Call the landlord about the heating\ndate: friday")),
         act("create", args=lines(kind="task", name="Call the landlord about the heating", date=U("week", 0, weekday=5)))]),
  T("make it priority one", diff(upd("+1", priority=1)),
    ref=[act("edit", rows="$c1", args="priority: 1")]))

S("T30-118", "ask-referent star ambiguous-ask date-select document",
  T("star it", ask(),
    ref=[askc("Star which one?")]),
  T("the notice of assessment", ask("doc_02", "doc_54"),
    ref=[act("star", kind="document", name="notice of assessment")]),
  T("the one from last year", diff(upd("doc_54", starred=True)),
    ref=[act("star", kind="document", name="notice of assessment", when=J(U("year", -1)))]))

S("T30-119", "find-act settle_debt linked where when span balance",
  T("lucie's debts from 2024 and 2025 are all paid, the ones she owes me",
    diff(upd("debt_10", status="settled"), upd("debt_04", status="settled"), upd("debt_16", status="settled")),
    ref=[find(kind="debt", linked_to="$lucie_boucher", where="direction = owes_me and status = open", when=J(span(D("2024-01-01"), D("2025-12-31")))),
         act("settle_debt", rows="@prev")]),
  T("which debts does she still owe me after that", rows("debt_28", "debt_34", "debt_40"),
    ref=[ans(kind="debt", linked_to="$lucie_boucher", where="direction = owes_me and status = open")]),
  T("and where do we stand overall, lucie and me", val((258, "CAD")),
    ref=[ans(op="balance", kind="person", name="Lucie Boucher")]))

S("T30-120", "tasks repair effort-unit where when complete name",
  T("open tasks this month that take under an hour", rows("t_078", "wat_270220", "t_099", "t_106", "opus_270228"),
    ref=[bad(ans(kind="task", where="status = open and effort < 1 hour", when=J(U("month", 0)))),
         ans(kind="task", where="status = open and effort < 60", when=J(U("month", 0)))]),
  T("ok the offline maps one is done, i downloaded everything last night", diff(upd("t_078", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="offline maps", where="status = open")]),
  T("and the streaming one", diff(upd("t_106", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="streaming", where="status = open")]))

S("T30-121", "locker star unstar two-writes undo where",
  T("star the visa, unstar the home wifi", diff(upd("visa", starred=True), upd("home_wifi", starred=False)),
    ref=[act("star", kind="locker item", name="Visa", more=True),
         act("unstar", kind="locker item", name="Home wifi")]),
  T("undo that", diff(upd("visa", starred=False), upd("home_wifi", starred=True)),
    ref=[act("undo")]),
  T("ok so which cards and wifis are starred in there right now", rows("home_wifi"),
    ref=[ans(kind="locker item", where='starred = yes and type in ("card", "wifi")')]))

S("T30-122", "compute group value starred document photo person",
  T("how many documents are starred versus not", vgroups({"no": 49, "yes": 7}),
    ref=[comp(op="count", kind="document", group="starred"),
         ans(value="@prev")]),
  T("and photos", vgroups({"no": 281, "yes": 11}),
    ref=[comp(op="count", kind="photo", group="starred"),
         ans(value="@prev")]),
  T("and people", vgroups({"no": 158, "yes": 23}),
    ref=[comp(op="count", kind="person", group="starred"),
         ans(value="@prev")]))

S("T30-123", "events empty-next last create reschedule",
  T("when's the next parent-teacher meeting", rows(),
    ref=[ans(kind="event", name="Parent-teacher meeting", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("and which one happened most recently", rows("oo_043"),
    ref=[ans(kind="event", name="Parent-teacher meeting", when=J({"to": U("day", 0)}), order="date desc", limit=1)]),
  T("set one up with zoé's teacher thursday at half past four, she wants to talk about her grades", diff(new("event", name=has("Parent-teacher"), date="2027-02-18T16:30")),
    ref=[act("create", args=lines(kind="event", name="Parent-teacher meeting - Zoé", date=U("week", 0, weekday=4, time="16:30")))]),
  T("actually friday same time", diff(upd("+1", date="2027-02-19T16:30")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 0, weekday=5)))]))

S("T30-124", "find-act complete budget effort where when linked within reschedule repair",
  T("complete the still open budget tasks due before march that take under fifteen minutes", diff(upd("t_106", status="completed", completed=ANY)),
    ref=[find(kind="task", linked_to="$budget", where="status = open and effort < 15", when=J({"to": D("2027-02-28")})),
         act("complete", rows="@prev")]),
  T("anything else open that takes under half an hour",
    rows("t_020", "t_060", "t_188", "opus_260928", "t_078", "wat_270220", "t_099", "opus_270228", "t_115", "furn_270315", "t_211"),
    ref=[bad(ans(kind="task", where="status = open and effort < half an hour")),
         ans(kind="task", where="status = open and effort < 30")]),
  T("and which of those ones have a priority set", rows("t_099", "t_211"),
    ref=[ans(within="@prev", where="priority is set")]),
  T("push those a week", diff(upd("t_099", date="2027-03-02"), upd("t_211", date="2027-04-06")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 1, anchor="row")))]))

S("T30-125", "documents count name order-limit star repair",
  T("how many report cards do i have", val(9),
    ref=[ans(op="count", kind="document", name="report card")]),
  T("which one's the newest", rows("doc_60"),
    ref=[bad(ans(kind="document", name="report card", order="newest", limit=1)),
         ans(kind="document", name="report card", order="date desc", limit=1)]),
  T("star it", diff(upd("doc_60", starred=True)),
    ref=[act("star", rows="$doc_60")]),
  T("and the oldest?", rows("doc_04"),
    ref=[ans(kind="document", name="report card", order="date asc", limit=1)]),
  T("how many report cards are émile's", val(4),
    ref=[ans(op="count", kind="document", name="report card Émile")]))

S("T30-126", "documents find-act star unstar undo count relation where when",
  T("star the 2025 maison documents", diff(upd("doc_40", starred=True), upd("doc_39", starred=True), upd("doc_41", starred=True)),
    ref=[find(kind="document", linked_to="$maison_f", when=J(U("year", -2))),
         act("star", rows="@prev")]),
  T("and the two from 2024", diff(upd("doc_15", starred=True), upd("doc_14", starred=True)),
    ref=[find(kind="document", linked_to="$maison_f", when=J(U("year", -3))),
         act("star", rows="@prev")]),
  T("how many starred documents do i have now", val(12),
    ref=[ans(op="count", kind="document", where="starred = yes")]),
  T("unstar the two maison ones from 2024 again", diff(upd("doc_15", starred=False), upd("doc_14", starred=False)),
    ref=[find(kind="document", linked_to="$maison_f", where="starred = yes", when=J(U("year", -3))),
         act("unstar", rows="@prev")]),
  T("undo that", diff(upd("doc_15", starred=True), upd("doc_14", starred=True)),
    ref=[act("undo")]))

S("T30-127", "find-act edit priority task linked where when budget",
  T("make the budget tasks due before march priority one",
    diff(upd("impots27_1", priority=1), upd("t_106", priority=1), upd("hq_261020", priority=1),
         upd("hq_270220", priority=1), upd("hq_250420", priority=1), upd("t_050", priority=1)),
    ref=[find(kind="task", linked_to="$budget", where="status = open", when=J({"to": D("2027-02-28")})),
         act("edit", rows="@prev", args="priority: 1")]))

S("T30-128", "find-act delete task name where when linked k4 hydro",
  T("delete the completed hydro payments from 2024 on the budget list",
    diff(trash("hq_240620"), trash("hq_241220"), trash("hq_240220"), trash("hq_240420"), trash("hq_240820"), trash("hq_241020")),
    ref=[find(kind="task", name="Pay Hydro-Québec", where="status = completed", when=J(U("year", -3)), linked_to="$budget"),
         act("delete", rows="@prev")]))

S("T30-129", "photos count when where starred",
  T("how many photos did i take in 2025", val(110),
    ref=[ans(op="count", kind="photo", when=J(U("year", -2)))]),
  T("and how many photos are starred across the whole library", val(11),
    ref=[ans(op="count", kind="photo", where="starred = yes")]))

S("T30-130", "ambiguous-ask photo delete date-select",
  T("delete the cat next door photo, the neighbour's cat keeps showing up everywhere", ask("ph_loose_257", "ph_loose_287", "ph_loose_272"),
    ref=[act("delete", kind="photo", name="The cat next door")]),
  T("the one from 2024", diff(trash("ph_loose_272")),
    ref=[act("delete", kind="photo", name="The cat next door", when=J(U("year", -3)))]))

S("T30-131", "ambiguous-ask event cancel date-select",
  T("cancel the hockey practice", ask("hp_270223", "hp_270302", "hp_270309", "hp_270316", "hp_270323", "hp_270330"),
    ref=[act("cancel", kind="event", name="Hockey practice")]),
  T("the one on the ninth", diff(upd("hp_270309", status="cancelled")),
    ref=[act("cancel", kind="event", name="Hockey practice", when=J(D("2027-03-09")))]))

S("T30-132", "find-act delete event where status when year count trashed",
  T("delete the cancelled events from last year",
    diff(trash("oo_066"), trash("cm_261227"), trash("sw_261128"), trash("oo_019"), trash("cm_260308"), trash("bc_260327"),
         trash("oo_030"), trash("pl_261111"), trash("pl_260902"), trash("hg_260228"), trash("bc_260424")),
    ref=[find(kind="event", where="status = cancelled", when=J(U("year", -1))),
         act("delete", rows="@prev")]),
  T("how many events are in the trash now", val(17),
    ref=[ans(op="count", kind="event", trashed=True)]))

S("T30-133", "ambiguous-ask cancel event person-select school concert",
  T("cancel the school concert, we can't make it anymore", ask("oo_046", "oo_044", "oo_054"),
    ref=[act("cancel", kind="event", name="School concert")]),
  T("the one zoé's in", diff(upd("oo_044", status="cancelled")),
    ref=[act("cancel", kind="event", name="School concert", linked_to="$zoe")]))

S("T30-134", "compute group value locker type where starred",
  T("how many of each type do i have in the locker",
    vgroups({"api_credential": 1, "bank_account": 2, "card": 2, "crypto_wallet": 1, "document": 1, "driving_licence": 1, "identity": 1,
             "login": 5, "membership": 1, "note": 1, "passport": 1, "password": 2, "software_licence": 1, "ssh_key": 1, "wifi": 2}),
    ref=[comp(op="count", kind="locker item", group="type"),
         ans(value="@prev")]),
  T("and how many are starred in each type", vgroups({"bank_account": 1, "login": 1, "note": 1, "wifi": 1}),
    ref=[comp(op="count", kind="locker item", group="type", where="starred = yes"),
         ans(value="@prev")]))

S("T30-135", "write-read log person read name",
  T("log a call with maman and tell me when i last talked to papa", rows("papa", also=diff(upd("maman", date=ANY))),
    ref=[act("log", rows="$maman", args="kind: call", more=True),
         ans(kind="person", name="Papa")]),
  T("and mamie?", rows("mamie"),
    ref=[ans(kind="person", name="Mamie")]))

S("T30-136", "decline-sealed read locker wifi",
  T("can you text the home wifi password to maman, she's here this weekend and can't connect", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("ok what's the wifi at her place", rows("maman_wifi"),
    ref=[ans(kind="locker item", name="Maman's wifi")]))

S("T30-137", "reschedule task name linked where when two-dates k4",
  T("push zoé's open doctor booking due next tuesday to friday", diff(upd("t_099", date="2027-02-19")),
    ref=[act("reschedule", kind="task", name="Book Zoé's doctor", linked_to="$zoe", where="status = open", when=J(U("week", 1, weekday=2)), args=lines(to=U("week", 0, weekday=5)))]),
  T("and make it priority two", diff(upd("t_099", priority=2)),
    ref=[act("edit", rows="$t_099", args="priority: 2")]))
