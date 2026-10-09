from gold import *
import json
def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T30-003-P", "same-name read description balance para",
  T("sam?", rows("sam_b", "sam_n"),
    ref=[ans(kind="person", name="Sam")]),
  T("balance with the colleague sam", val((46, "CAD")),
    ref=[ans(op="balance", kind="person", name="Sam", where='role = "colleague"')]),
  T("neighbour sam?", val((-17.84, "CAD")),
    ref=[ans(op="balance", kind="person", name="Sam", where='role = "neighbour"')]))

S("T30-009-P", "relation event person span cancel reschedule same-time read-back para",
  T("until sunday, what does zoé have on", rows("pl_270217", "sw_270220"),
    ref=[ans(kind="event", linked_to="$zoe", when=J(span(U("day", 0), U("week", 0, weekday=7))))]),
  T("she has a cold, so saturday's swim is off, cancel it", diff(upd("sw_270220", status="cancelled")),
    ref=[act("cancel", kind="event", name="Swim class", when=J(U("week", 0, weekday=6)))]),
  T("piano moves to thursday at the same time", diff(upd("pl_270217", date="2027-02-18T16:30")),
    ref=[act("reschedule", rows="$pl_270217", args=lines(to=U("week", 0, weekday=4)))]),
  T("so what do i have thursday", rows("pl_270217"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=4)))]))

S("T30-014-P", "trashed restore task decline-window trash-read para",
  T("by mistake i deleted the glasses renewal, restore it", diff(restore("t_003")),
    ref=[act("restore", kind="task", name="glasses", trashed=True)]),
  T("property tax one too", diff(restore("t_009")),
    ref=[act("restore", kind="task", name="property tax", trashed=True)]),
  T("what else sits in the trash among tasks", rows("t_014", "t_022", "t_033", "t_046", "t_058", "t_071"),
    ref=[ans(kind="task", trashed=True)]),
  T("winter boots one, restore it", diff(restore("t_014")),
    ref=[act("restore", kind="task", name="winter boots", trashed=True)]),
  T("from november, the savings one", decline("not_found"),
    ref=[act("restore", kind="task", name="savings account", trashed=True)]))

S("T30-020-P", "locker wifi read reveal egress where-type star para",
  T("wifi pw saved?", rows("home_wifi", "maman_wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("home, show me", diff(reveal=[("home_wifi", "ChezNousRosemont27")]),
    ref=[act("reveal", rows="$home_wifi", args="field: password")]),
  T("send it to mathieu in a text", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("starred logins, which", rows("desjardins"),
    ref=[ans(kind="locker item", where="type = login and starred = yes")]))

S("T30-025-P", "role search find-only log message para",
  T("when did i last talk to the accountant", rows("annie_belanger"),
    ref=[search("accountant", kind="person"), ans(rows="@prev")]),
  T("i emailed her today, put that in the log", diff(upd("annie_belanger", date=ANY)),
    ref=[act("log", rows="$annie_belanger", args="kind: message")]))

S("T30-029-P", "event next relation group exclude reschedule anchor-row para",
  T("next book club, when", rows("bc_270226"),
    ref=[ans(kind="event", name="Book club", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("which cercle members are going", rows("book_host", "marie_eve", "genevieve_t"),
    ref=[ans(kind="person", linked_to="$cercle, $bc_270226")]),
  T("cercle people not going?",
    rows("antoine_thibault", "yasmine_khoury", "raj_gauthier", "camille_paquette", "thierry_leclerc", "me"),
    ref=[ans(kind="person", linked_to="$cercle", exclude="@prev")]),
  T("a day later for it", diff(upd("bc_270226", date="2027-02-27T19:30")),
    ref=[act("reschedule", rows="$bc_270226", args=lines(to=U("day", 1, anchor="row")))]))

S("T30-034-P", "two-writes complete reschedule undo read where para",
  T("streaming one is done, and the gutters move to the fourteenth",
    diff(upd("t_106", status="completed", completed=ANY), upd("t_017", date="2027-03-14")),
    ref=[act("complete", kind="task", name="streaming", where="status = open", more=True),
         act("reschedule", kind="task", name="gutters", where="status = open", args=lines(to=D("2027-03-14")))]),
  T("i changed my mind, undo that", diff(upd("t_106", status="open", completed=None), upd("t_017", date="2027-03-07")),
    ref=[act("undo")]),
  T("gutters, is it back on the seventh", rows("t_017"),
    ref=[ans(kind="task", name="gutters", where="status = open")]))

S("T30-039-P", "trashed restore event decline-window when read para",
  T("léa's doctor appointment is in the trash, get it out of there", diff(restore("oo_005")),
    ref=[act("restore", kind="event", name="Doctor - Léa", trashed=True)]),
  T("report card night too", diff(restore("oo_011")),
    ref=[act("restore", kind="event", name="Report card night", trashed=True)]),
  T("hair appointment too", decline("not_found"),
    ref=[act("restore", kind="event", name="Hair appointment", trashed=True)]),
  T("léa's doctor appointments in 2026, which are there", rows("oo_005"),
    ref=[ans(kind="event", name="Doctor - Léa", when=J(span(D("2026-01-01"), D("2026-12-31"))))]))

S("T30-038-P", "debt create write-read balance settle_debt amount relation para",
  T("carpool gas, 15 from marie-pier, she owes me, so what's her total balance",
    val((209.68, "CAD"), also=diff(new("debt", name="carpool gas", amount=15, direction="owes_me"), link("new", "marie_pier"))),
    ref=[act("create", args="kind: debt\nname: carpool gas\namount: 15\ndirection: owes_me\nperson: $marie_pier", more=True),
         ans(op="balance", rows="$marie_pier")]),
  T("the 15 is paid by her, settle it", diff(upd("+1", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$marie_pier", where="amount = 15")]))

S("T30-047-P", "trashed restore locker decline-window para",
  T("old wifi, restore it", diff(restore("old_wifi")),
    ref=[act("restore", kind="locker item", name="old wifi", trashed=True)]),
  T("old bell login too", decline("not_found"),
    ref=[act("restore", kind="locker item", name="old Bell login", trashed=True)]))

S("T30-052-P", "documents folder when star bulk restore-doc within para",
  T("last year's stuff in the impôts folder", rows("doc_53", "doc_54", "doc_55"),
    ref=[ans(kind="document", linked_to="$impots_f", when=J(U("year", -1)))]),
  T("give a star to the unstarred ones", diff(upd("doc_53", starred=True), upd("doc_54", starred=True)),
    ref=[find(within="@prev", where="starred = no"),
         act("star", rows="@prev")]),
  T("restore the rl-1 slip from 2024", diff(restore("doc_03")),
    ref=[act("restore", kind="document", name="RL-1 slip", trashed=True, when=J(span(D("2024-01-01"), D("2024-12-31"))))]),
  T("starred impôts documents from last year, which", rows("doc_53", "doc_54", "doc_55"),
    ref=[ans(kind="document", linked_to="$impots_f", where="starred = yes", when=J(U("year", -1)))]))

S("T30-058-P", "event next empty order-limit chain person para",
  T("next piano recital, when", rows(),
    ref=[ans(kind="event", name="Piano recital", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("most recent one, who attended", rows("lise_b", "zoe"),
    ref=[find(kind="event", name="Piano recital", when=J({"to": U("day", 0)}), order="date desc", limit=1),
         ans(kind="person", linked_to="@prev")]))

S("T30-063-P", "locker reveal decline-fabricated where-type document star unstar within para",
  T("visa number, show me", diff(reveal=[("visa", "4501123498765432")]),
    ref=[act("reveal", rows="$visa", args="field: card_number")]),
  T("cvv too", diff(reveal=[("visa", "206")]),
    ref=[act("reveal", rows="$visa", args="field: cvv")]),
  T("make me up a pin", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("starred bank accounts, which", rows("joint"),
    ref=[ans(kind="locker item", where="type = bank_account and starred = yes")]),
  T("starred documents, which are they", rows("doc_01", "doc_10", "doc_19", "doc_28", "doc_37", "doc_46", "doc_55"),
    ref=[ans(kind="document", where="starred = yes")]),
  T("in the école folder, any of those", rows("doc_10"),
    ref=[ans(within="@prev", linked_to="$ecole_f")]),
  T("remove its star", diff(upd("doc_10", starred=False)),
    ref=[act("unstar", rows="$doc_10")]))

S("T30-068-P", "ask-missing never-mind read para",
  T("saturday's swim, change it to", ask(),
    ref=[askc("Move Saturday's swim class to when?")]),
  T("forget moving it, the swim stays saturday", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("then what does saturday hold", rows("hg_270220", "sw_270220"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=6)))]))

S("T30-073-P", "ask-referent reschedule event name trashed read restore para",
  T("make it friday", ask(),
    ref=[askc("Which one should I move to friday?")]),
  T("tomorrow's library return", diff(upd("oo_029", date="2027-02-19T16:00")),
    ref=[act("reschedule", kind="event", name="Library return", when=J(U("day", 1)), args=lines(to=U("week", 0, weekday=5)))]),
  T("i think i wiped an event by mistake, which events have i deleted lately", rows("oo_005", "oo_011", "oo_017", "oo_023", "oo_031", "oo_041"),
    ref=[ans(kind="event", trashed=True)]),
  T("restore the report card night", diff(restore("oo_011")),
    ref=[act("restore", kind="event", name="Report card night", trashed=True)]))

S("T30-078-P", "ask-referent reschedule event name write-read settle_debt balance linked when order-limit para",
  T("make it tuesday", ask(),
    ref=[askc("Move which one to tuesday?")]),
  T("march's furnace service", diff(upd("oo_034", date="2027-02-23T09:00")),
    ref=[act("reschedule", kind="event", name="Furnace service", when=J(U("month", 0, name=3)), args=lines(to=U("week", 1, weekday=2)))]),
  T("lucie settled the coffee run from 2024, so where do things stand with her now", val((554, "CAD"), also=diff(upd("debt_10", status="settled"))),
    ref=[act("settle_debt", kind="debt", name="coffee run", linked_to="$lucie_boucher", when=J(U("year", -3)), more=True),
         ans(op="balance", kind="person", name="Lucie Boucher")]),
  T("largest debt she still has with me", rows("debt_16"),
    ref=[ans(kind="debt", linked_to="$lucie_boucher", where="direction = owes_me and status = open", order="amount desc", limit=1)]))

S("T30-082-P", "find-act reschedule undo count maison list week where when para",
  T("everything due this week on the maison list moves to next week",
    diff(upd("wat_270220", date="2027-02-27T10:00"), upd("t_104", date="2027-02-23"),
         upd("rec_270218", date="2027-02-25T19:00"), upd("cmp_270215", date="2027-02-22T20:00")),
    ref=[find(kind="task", linked_to="$maison", where="status = open", when=J(U("week", 0))),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, anchor="row")))]),
  T("undo it",
    diff(upd("wat_270220", date="2027-02-20T10:00"), upd("t_104", date="2027-02-16"),
         upd("rec_270218", date="2027-02-18T19:00"), upd("cmp_270215", date="2027-02-15T20:00")),
    ref=[act("undo")]),
  T("only move the compost and the recycling",
    diff(upd("cmp_270215", date="2027-02-22T20:00"), upd("rec_270218", date="2027-02-25T19:00")),
    ref=[act("reschedule", kind="task", name="compost", where="status = open", when=J(U("week", 0)), args=lines(to=U("week", 1, anchor="row")), more=True),
         act("reschedule", kind="task", name="recycling", where="status = open", when=J(U("week", 0)), args=lines(to=U("week", 1, anchor="row")))]),
  T("count of open tasks due next week at this point", val(5),
    ref=[ans(op="count", kind="task", where="status = open", when=J(U("week", 1)))]))

S("T30-087-P", "reschedule two-dates anchor-row read para",
  T("change the furnace service date, fourth to eleventh", diff(upd("oo_034", date="2027-03-11T09:00")),
    ref=[act("reschedule", kind="event", name="Furnace service", when=J(D("2027-03-04")), args=lines(to=D("2027-03-11")))]),
  T("make it an hour later", diff(upd("oo_034", date="2027-03-11T10:00")),
    ref=[act("reschedule", rows="$oo_034", args=lines(to=U("hour", 1, anchor="row")))]),
  T("eleventh's agenda", rows("oo_034"),
    ref=[ans(kind="event", when=J(D("2027-03-11")))]))

S("T30-092-P", "ask-content event create write-read star locker where type starred para",
  T("add it to my calendar", ask(),
    ref=[askc("What's the event, and when?")]),
  T("friday at four, dentist for émile", diff(new("event", name=has("Dentist"), date="2027-02-19T16:00")),
    ref=[act("create", args=lines(kind="event", name="Dentist for Émile", date=U("week", 0, weekday=5, time="16:00")))]),
  T("visa gets a star, then list the starred cards", rows("visa", also=diff(upd("visa", starred=True))),
    ref=[act("star", kind="locker item", name="Visa", more=True),
         ans(kind="locker item", where="type = card and starred = yes")]),
  T("mastercard as well", diff(upd("mc", starred=True)),
    ref=[act("star", kind="locker item", name="Mastercard")]))

S("T30-097-P", "ambiguous-ask delete event date-select brunch decline-out-of-scope read person para",
  T("brunch with isabelle, delete it", ask("oo_061", "oo_002"),
    ref=[act("delete", kind="event", name="Brunch with Isabelle")]),
  T("the one from 2024", diff(trash("oo_061")),
    ref=[act("delete", kind="event", name="Brunch with Isabelle", when=J(U("year", -3)))]),
  T("my hands are full with the kids, please call maman for me", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("last time we talked, when was it", rows("maman"),
    ref=[ans(kind="person", name="Maman")]))

S("T30-102-P", "write-read reschedule event name when two-dates read find-act settle_debt linked where raj para",
  T("furnace service shifts to the fifth, then what's on that day", rows("oo_034", also=diff(upd("oo_034", date="2027-03-05T09:00"))),
    ref=[act("reschedule", kind="event", name="Furnace service", when=J(D("2027-03-04")), args=lines(to=D("2027-03-05")), more=True),
         ans(kind="event", when=J(D("2027-03-05")))]),
  T("settle raj roy's debts from before 2026, all of them are paid", diff(upd("debt_12", status="settled"), upd("debt_24", status="settled"), upd("debt_18", status="settled")),
    ref=[find(kind="debt", linked_to="$raj_roy", where="direction = owes_me and status = open", when=J({"to": D("2025-12-31")})),
         act("settle_debt", rows="@prev")]),
  T("his remaining open debts?", rows("debt_30", "debt_36"),
    ref=[ans(kind="debt", linked_to="$raj_roy", where="direction = owes_me and status = open")]))

S("T30-106-P", "reschedule task name where when linked two-dates k4 cancel event para",
  T("on the maison list, the open furnace filter task due march 15th goes to the 22nd", diff(upd("furn_270315", date="2027-03-22T10:00")),
    ref=[act("reschedule", kind="task", name="furnace filter", where="status = open", when=J(D("2027-03-15")), linked_to="$maison", args=lines(to=D("2027-03-22")))]),
  T("volleyball for léa on the twenty-second, switch it to wednesday", diff(upd("vb_270222", date="2027-02-24T17:30")),
    ref=[act("reschedule", kind="event", name="volleyball", linked_to="$lea", when=J(D("2027-02-22")), args=lines(to=U("week", 1, weekday=3)))]),
  T("émile has the flu, so cancel his practice on the twenty-third", diff(upd("hp_270223", status="cancelled")),
    ref=[act("cancel", kind="event", name="practice", linked_to="$emile", when=J(D("2027-02-23")))]))

S("T30-111-P", "event span two-reschedules undo complete task name where when linked k4 recycling para",
  T("next week from monday until wednesday, what's on the calendar", rows("vb_270222", "hp_270223", "pl_270224"),
    ref=[ans(kind="event", when=J(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]),
  T("volleyball on monday should go to wednesday, piano to thursday",
    diff(upd("vb_270222", date="2027-02-24T17:30"), upd("pl_270224", date="2027-02-25T16:30")),
    ref=[act("reschedule", rows="$vb_270222", args=lines(to=U("week", 1, weekday=3)), more=True),
         act("reschedule", rows="$pl_270224", args=lines(to=U("week", 1, weekday=4)))]),
  T("we'll keep both as they were, undo that",
    diff(upd("vb_270222", date="2027-02-22T17:30"), upd("pl_270224", date="2027-02-24T16:30")),
    ref=[act("undo")]),
  T("on the maison list, mark done the open recycling task due thursday the eighteenth", diff(upd("rec_270218", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Take out recycling", where="status = open", when=J(D("2027-02-18")), linked_to="$maison")]))

S("T30-116-P", "ask-referent cancel tomorrow read para",
  T("cancel that one", ask(),
    ref=[askc("Cancel which event?")]),
  T("tire swap tomorrow", diff(upd("oo_038", status="cancelled")),
    ref=[act("cancel", kind="event", name="Winter tires swap", when=J(U("day", 1)))]),
  T("library run tomorrow as well, is it", rows("oo_029"),
    ref=[ans(kind="event", name="library", when=J(U("day", 1)))]))

S("T30-121-P", "locker star unstar two-writes undo where para",
  T("visa gets a star and the home wifi loses its star", diff(upd("visa", starred=True), upd("home_wifi", starred=False)),
    ref=[act("star", kind="locker item", name="Visa", more=True),
         act("unstar", kind="locker item", name="Home wifi")]),
  T("undo it", diff(upd("visa", starred=False), upd("home_wifi", starred=True)),
    ref=[act("undo")]),
  T("right now, which cards and wifis in there are starred", rows("home_wifi"),
    ref=[ans(kind="locker item", where='starred = yes and type in ("card", "wifi")')]))
