from gold import *
import json

world("T30", "2027-02-16T21:05", "Élise Gagnon-Lavoie", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T30-090", "ambiguous-ask cancel event person-select doctor decline-out-of-scope photo count",
  T("cancel the doctor", ask("oo_047", "oo_018", "oo_039", "oo_008", "oo_026"),
    ref=[act("cancel", kind="event", name="Doctor")]),
  T("émile's one, he's feeling better", diff(upd("oo_026", status="cancelled")),
    ref=[act("cancel", kind="event", name="Doctor", linked_to="$emile")]),
  T("upload the cabane photos from my phone into the cabane album", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("how many photos are in the cabane album", val(22),
    ref=[ans(op="count", kind="photo", linked_to="$cabane_a")]))

S("T30-091", "empty-recovery ask-content search task create add_to trashed read person where met restore",
  T("add milk and eggs to the grocery list", ask(),
    ref=[search("grocery"),
         askc("I can't find a grocery list. Which list should I put them on?")]),
  T("the maison one", diff(new("task", name=has("milk")), link("maison", "new")),
    ref=[act("create", args="kind: task\nname: Milk and eggs", more=True),
         act("add_to", rows="$new", args="to: $maison")]),
  T("any hydro-québec people in the trash, i think i deleted one or two of them by mistake", rows("camille_levesque"),
    ref=[ans(kind="person", trashed=True, where='met = "Hydro-Québec"')]),
  T("bring her back", diff(restore("camille_levesque")),
    ref=[act("restore", rows="$camille_levesque")]))

S("T30-092", "ask-content event create write-read star locker where type starred",
  T("put it on the calendar", ask(),
    ref=[askc("What's the event, and when?")]),
  T("dentist for émile friday at four", diff(new("event", name=has("Dentist"), date="2027-02-19T16:00")),
    ref=[act("create", args=lines(kind="event", name="Dentist for Émile", date=U("week", 0, weekday=5, time="16:00")))]),
  T("star the visa and tell me which cards are starred now", rows("visa", also=diff(upd("visa", starred=True))),
    ref=[act("star", kind="locker item", name="Visa", more=True),
         ans(kind="locker item", where="type = card and starred = yes")]),
  T("and the mastercard too", diff(upd("mc", starred=True)),
    ref=[act("star", kind="locker item", name="Mastercard")]))

S("T30-093", "ambiguous-ask log person role-select sister empty-recovery search tennis event read linked",
  T("log a call with isabelle", ask("isabelle", "isabelle_beaulieu", "isabelle_poirier", "isabelle_pelletier"),
    ref=[act("log", kind="person", name="Isabelle", args="kind: call")]),
  T("my sister, we talked about christmas plans", diff(upd("isabelle", date=ANY)),
    ref=[act("log", kind="person", name="Isabelle", where='role = "sister"', args="kind: call")]),
  T("when's zoé's tennis lesson", rows(),
    ref=[search("tennis"),
         ans(kind="event", name="tennis", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("ok what does she have this week", rows("pl_270217", "sw_270220"),
    ref=[ans(kind="event", linked_to="$zoe", when=J(U("week", 0)))]))

S("T30-094", "ask-referent balance person read ambiguous-ask delete event state-select cancelled",
  T("what's the balance", ask(),
    ref=[askc("With whom?")]),
  T("papa", val((-450, "CAD")),
    ref=[ans(op="balance", kind="person", name="Papa")]),
  T("delete the coffee with marie-ève", ask("oo_040", "oo_059", "oo_022", "oo_030"),
    ref=[act("delete", kind="event", name="Coffee with Marie-Ève")]),
  T("the cancelled one", diff(trash("oo_030")),
    ref=[act("delete", kind="event", name="Coffee with Marie-Ève", where="status = cancelled")]))

S("T30-095", "ambiguous-ask reopen task date-select windshield empty-recovery search thanksgiving event order-limit",
  T("reopen the windshield fluid task", ask("t_031", "t_107"),
    ref=[act("reopen", kind="task", name="windshield fluid")]),
  T("the november 2024 one", diff(upd("t_107", status="open")),
    ref=[act("reopen", kind="task", name="windshield fluid", when=J(U("month", -3, name=11)))]),
  T("when was the most recent thanksgiving at maman's", rows(),
    ref=[search("thanksgiving"),
         ans(kind="event", name="thanksgiving", when=J({"to": U("day", 0)}), order="date desc", limit=1)]),
  T("what about noël chez maman", rows("noel_26"),
    ref=[ans(kind="event", name="Noël chez Maman", when=J({"to": U("day", 0)}), order="date desc", limit=1)]))

S("T30-096", "ask-referent reveal locker where find-act cancel event name linked month",
  T("show me the password", ask(),
    ref=[askc("Which login or wifi do you mean?")]),
  T("the hydro one", diff(reveal=[("hq_login", "Bacs&Compost91")]),
    ref=[act("reveal", rows="$hq_login", args="field: password")]),
  T("cancel émile's practices in march", diff(upd("hp_270302", status="cancelled"), upd("hp_270309", status="cancelled"),
                                               upd("hp_270316", status="cancelled"), upd("hp_270323", status="cancelled"),
                                               upd("hp_270330", status="cancelled")),
    ref=[find(kind="event", name="practice", linked_to="$emile", when=J(U("month", 0, name=3))),
         act("cancel", rows="@prev")]),
  T("and léa's volleyball", diff(upd("vb_270308", status="cancelled"), upd("vb_270315", status="cancelled"),
                                  upd("vb_270322", status="cancelled"), upd("vb_270329", status="cancelled")),
    ref=[find(kind="event", name="volleyball", linked_to="$lea", when=J(U("month", 0, name=3))),
         act("cancel", rows="@prev")]))

S("T30-097", "ambiguous-ask delete event date-select brunch decline-out-of-scope read person",
  T("delete the brunch with isabelle", ask("oo_061", "oo_002"),
    ref=[act("delete", kind="event", name="Brunch with Isabelle")]),
  T("the 2024 one", diff(trash("oo_061")),
    ref=[act("delete", kind="event", name="Brunch with Isabelle", when=J(U("year", -3)))]),
  T("can you call maman for me, my hands are full with the kids right now", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("so when did we last talk", rows("maman"),
    ref=[ans(kind="person", name="Maman")]))

S("T30-098", "ask-referent reschedule event two-dates name when empty-recovery search synonym pediatrician",
  T("change the date", ask(),
    ref=[askc("Which one should I move, and to when?")]),
  T("the february book club to the 27th", diff(upd("bc_270226", date="2027-02-27T19:30")),
    ref=[act("reschedule", kind="event", name="Book club", when=J(U("month", 0, name=2)), args=lines(to=D("2027-02-27")))]),
  T("when's zoé's next pediatrician appointment", rows(),
    ref=[search("pediatrician"),
         ans(kind="event", name="Doctor Zoé", when=J({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T30-099", "ambiguous-ask delete event date-select optometrist empty-recovery search vaccine event order-limit",
  T("delete the optometrist", ask("oo_052", "oo_024", "oo_036", "oo_068", "oo_042"),
    ref=[act("delete", kind="event", name="Optometrist")]),
  T("the one from january", diff(trash("oo_042")),
    ref=[act("delete", kind="event", name="Optometrist", when=J(U("month", 0, name=1)))]),
  T("when's zoé's vaccine appointment", rows(),
    ref=[search("vaccine"),
         ans(kind="event", name="vaccine", when=J({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T30-100", "write-read delete name where when event also repair name-in-where description order-limit",
  T("delete the cancelled réunion de ruelle from 2025 and tell me what's left of them", rows("oo_001", "oo_020", "oo_016", also=diff(trash("oo_021"))),
    ref=[act("delete", kind="event", name="Réunion de ruelle", where="status = cancelled", when=J(U("year", -2)), more=True),
         ans(kind="event", name="Réunion de ruelle")]),
  T("which hockey games so far had a carpool", rows("hg_240302", "hg_240330", "hg_241012", "hg_250301", "hg_251220", "hg_261107", "hg_270206"),
    ref=[bad(ans(kind="event", where='name contains "Hockey game" and description contains "carpool"')),
         ans(kind="event", name="Hockey game", where='description contains "carpool"', when=J({"to": U("day", 0)}))]),
  T("and which was the latest", rows("hg_270206"),
    ref=[ans(kind="event", name="Hockey game", where='description contains "carpool"', when=J({"to": U("day", 0)}), order="date desc", limit=1)]))

S("T30-101", "find-act unstar document linked where when settle_debt name i_owe balance k4",
  T("unstar the starred impôts documents from 2025", diff(upd("doc_28", starred=False)),
    ref=[find(kind="document", linked_to="$impots_f", where="starred = yes", when=J(U("year", -2))),
         act("unstar", rows="@prev")]),
  T("i paid camille paquette back for last year's pizza", diff(upd("debt_35", status="settled")),
    ref=[act("settle_debt", kind="debt", name="pizza", linked_to="$camille_paquette", where="direction = i_owe", when=J(U("year", -1)))]),
  T("and what's my balance with her after that", val((0, "CAD")),
    ref=[ans(op="balance", kind="person", name="Camille Paquette")]))

S("T30-102", "write-read reschedule event name when two-dates read find-act settle_debt linked where raj",
  T("move the furnace service to the fifth and tell me what's on that day", rows("oo_034", also=diff(upd("oo_034", date="2027-03-05T09:00"))),
    ref=[act("reschedule", kind="event", name="Furnace service", when=J(D("2027-03-04")), args=lines(to=D("2027-03-05")), more=True),
         ans(kind="event", when=J(D("2027-03-05")))]),
  T("raj roy's debts from before 2026 are all settled", diff(upd("debt_12", status="settled"), upd("debt_24", status="settled"), upd("debt_18", status="settled")),
    ref=[find(kind="debt", linked_to="$raj_roy", where="direction = owes_me and status = open", when=J({"to": D("2025-12-31")})),
         act("settle_debt", rows="@prev")]),
  T("so which of his debts are still open", rows("debt_30", "debt_36"),
    ref=[ans(kind="debt", linked_to="$raj_roy", where="direction = owes_me and status = open")]))

S("T30-103", "write-read delete event name where count edit task linked when effort k4 read",
  T("delete the cancelled coffee with marie-ève and tell me how many coffees are left", val(3, also=diff(trash("oo_030"))),
    ref=[act("delete", kind="event", name="Coffee with Marie-Ève", where="status = cancelled", more=True),
         ans(op="count", kind="event", name="Coffee with Marie-Ève")]),
  T("set the open gutters task on the maison list, the one due march seventh, to ninety minutes", diff(upd("t_017", effort=90)),
    ref=[act("edit", kind="task", name="gutters", where="status = open", linked_to="$maison", when=J(D("2027-03-07")), args="effort: 90")]),
  T("which open maison tasks take an hour or more now", rows("t_017"),
    ref=[ans(kind="task", linked_to="$maison", where="status = open and effort >= 60")]))

S("T30-104", "find-act unstar document where when decline-out-of-scope read",
  T("unstar the 2025 documents that are starred", diff(upd("doc_37", starred=False), upd("doc_46", starred=False), upd("doc_28", starred=False)),
    ref=[find(kind="document", where="starred = yes", when=J(U("year", -2))),
         act("unstar", rows="@prev")]),
  T("please print the hockey schedule for the fridge, the new one with all the practices", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("which hockey schedule documents do i have saved in the vault", rows("doc_12", "doc_38"),
    ref=[ans(kind="document", name="hockey schedule")]))

S("T30-105", "complete task name where when linked k4 find-act delete relation trash-read",
  T("complete the open hydro payment due the 20th of february on the budget list", diff(upd("hq_270220", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay Hydro-Québec", where="status = open", when=J(D("2027-02-20")), linked_to="$budget")]),
  T("get rid of the cancelled windshield fluid tasks on the auto list", diff(trash("t_031"), trash("t_107")),
    ref=[find(kind="task", name="windshield fluid", where="status = cancelled", linked_to="$auto"),
         act("delete", rows="@prev")]),
  T("what tasks are in the trash now, i think i deleted the wrong one by mistake", rows("t_071", "t_033", "t_031", "t_107", "t_014", "t_009", "t_046", "t_003", "t_058", "t_022"),
    ref=[ans(kind="task", trashed=True)]))

S("T30-106", "reschedule task name where when linked two-dates k4 cancel event",
  T("move the open furnace filter task due march 15th on the maison list to the 22nd", diff(upd("furn_270315", date="2027-03-22T10:00")),
    ref=[act("reschedule", kind="task", name="furnace filter", where="status = open", when=J(D("2027-03-15")), linked_to="$maison", args=lines(to=D("2027-03-22")))]),
  T("move léa's volleyball on the twenty-second to wednesday", diff(upd("vb_270222", date="2027-02-24T17:30")),
    ref=[act("reschedule", kind="event", name="volleyball", linked_to="$lea", when=J(D("2027-02-22")), args=lines(to=U("week", 1, weekday=3)))]),
  T("and cancel émile's practice on the twenty-third, he's got the flu", diff(upd("hp_270223", status="cancelled")),
    ref=[act("cancel", kind="event", name="practice", linked_to="$emile", when=J(D("2027-02-23")))]))

S("T30-107", "reschedule task name where when linked two-dates k4 event count description log",
  T("push the open water the plants task due saturday on the maison list to monday", diff(upd("wat_270220", date="2027-02-22T10:00")),
    ref=[act("reschedule", kind="task", name="Water the plants", where="status = open", when=J(U("week", 0, weekday=6)), linked_to="$maison", args=lines(to=U("week", 1, weekday=1)))]),
  T("how many of maman's knee calls did we have last year", val(10),
    ref=[ans(op="count", kind="event", name="Call maman", where='description contains "knee"', when=J(U("year", -1)))]),
  T("i just called her tonight, so log it for me", diff(upd("maman", date=ANY)),
    ref=[act("log", rows="$maman", args="kind: call")]))

S("T30-108", "empty-recovery search bakery debt where decline-out-of-scope find-act star photos",
  T("do we owe the bakery anything", rows(),
    ref=[search("bakery"),
         ans(kind="debt", name="bakery", where="status = open")]),
  T("whatsapp the cabane photos to isabelle", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok star the sugar shack ones, those are the ones i want on the home screen", diff(upd("ph_cabane_a_07", starred=True), upd("ph_cabane_a_12", starred=True),
                                          upd("ph_cabane_a_02", starred=True), upd("ph_cabane_a_17", starred=True)),
    ref=[find(kind="photo", name="Sugar shack"),
         act("star", rows="@prev")]))

S("T30-109", "empty-recovery search karate event photos find-act star unstar undo name where when count",
  T("when's the next karate class", rows(),
    ref=[search("karate"),
         ans(kind="event", name="karate", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("star all the trophy photos from the hockey season, i want to see them first", diff(upd("ph_hockey24_18", starred=True), upd("ph_hockey24_06", starred=True), upd("ph_hockey24_12", starred=True)),
    ref=[find(kind="photo", name="Trophy"),
         act("star", rows="@prev")]),
  T("so how many photos are starred after that", val(14),
    ref=[ans(op="count", kind="photo", where="starred = yes")]),
  T("unstar the two trophy ones from 2025", diff(upd("ph_hockey24_18", starred=False), upd("ph_hockey24_12", starred=False)),
    ref=[find(kind="photo", name="Trophy", where="starred = yes", when=J(U("year", -2))),
         act("unstar", rows="@prev")]),
  T("undo that", diff(upd("ph_hockey24_18", starred=True), upd("ph_hockey24_12", starred=True)),
    ref=[act("undo")]))

S("T30-110", "empty-recovery search wedding event debts i_owe where ambiguous-ask settle_debt date-select sum",
  T("did we get a wedding invite", rows(),
    ref=[search("wedding"),
         ans(kind="event", name="wedding", when=J({"from": U("day", 0)}))]),
  T("show me the debts i owe that are over a hundred dollars", rows("debt_14", "debt_20", "debt_26", "debt_35"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open and amount > 100")]),
  T("the pizza one is paid, did it today", ask("debt_35", "debt_20", "debt_05"),
    ref=[act("settle_debt", kind="debt", name="pizza")]),
  T("the 2025 one", diff(upd("debt_20", status="settled")),
    ref=[act("settle_debt", kind="debt", name="pizza", when=J(U("year", -2)))]),
  T("so what's the total i still owe, all debts together", val((571, "CAD")),
    ref=[bad(ans(op="sum", kind="debt", where="direction = i_owe and status = open")),
         ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open")]))

S("T30-111", "event span two-reschedules undo complete task name where when linked k4 recycling",
  T("anything on the calendar between monday and wednesday next week", rows("vb_270222", "hp_270223", "pl_270224"),
    ref=[ans(kind="event", when=J(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]),
  T("push monday's volleyball to wednesday and piano to thursday",
    diff(upd("vb_270222", date="2027-02-24T17:30"), upd("pl_270224", date="2027-02-25T16:30")),
    ref=[act("reschedule", rows="$vb_270222", args=lines(to=U("week", 1, weekday=3)), more=True),
         act("reschedule", rows="$pl_270224", args=lines(to=U("week", 1, weekday=4)))]),
  T("undo that, we'll keep both as they were",
    diff(upd("vb_270222", date="2027-02-22T17:30"), upd("pl_270224", date="2027-02-24T16:30")),
    ref=[act("undo")]),
  T("complete the open recycling task due thursday the eighteenth on the maison list", diff(upd("rec_270218", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Take out recycling", where="status = open", when=J(D("2027-02-18")), linked_to="$maison")]))

S("T30-112", "settle_debt name linked where when k4 lucie repair people role cadence edit focus-pick",
  T("lucie boucher paid me for this year's coffee run", diff(upd("debt_40", status="settled")),
    ref=[act("settle_debt", kind="debt", name="coffee run", linked_to="$lucie_boucher", where="direction = owes_me", when=J(U("year", 0)))]),
  T("which neighbours do i keep in touch with monthly", rows("sam_b", "caroline_perreault"),
    ref=[bad(ans(kind="person", where='role = "neighbour" and cadence <= 1 month')),
         ans(kind="person", where='role = "neighbour" and cadence <= 30')]),
  T("put sam on every two weeks instead, we hang out all the time", diff(upd("sam_b", cadence=14)),
    ref=[act("edit", rows="$sam_b", args="cadence: 14")]),
  T("and how often do i see caroline", rows("caroline_perreault"),
    ref=[ans(kind="person", name="Caroline", where='role = "neighbour"')]))

S("T30-113", "empty-recovery search pool event write-read complete count where priority",
  T("when's the pool party", rows(),
    ref=[search("pool"),
         ans(kind="event", name="pool party", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("the gutters are done, how many open tasks do i have left", val(40, also=diff(upd("t_017", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="gutters", where="status = open", more=True),
         ans(op="count", kind="task", where="status = open")]),
  T("and just the ones with priority one", val(3),
    ref=[ans(op="count", kind="task", where="status = open and priority = 1")]),
  T("which ones", rows("t_099", "rent_270301", "t_211"),
    ref=[ans(kind="task", where="status = open and priority = 1")]))
