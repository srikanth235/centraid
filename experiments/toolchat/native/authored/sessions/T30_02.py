from gold import *
import json

world("T30", "2027-02-16T21:05", "Élise Gagnon-Lavoie", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T30-023", "list status bulk find-act when overdue",
  T("what's still open on the maison list",
    rows("cmp_250303", "cmp_250602", "rec_260528", "cmp_270215", "t_104", "rec_270218", "wat_270220", "t_017", "furn_270315"),
    ref=[ans(kind="task", linked_to="$maison", where="status = open")]),
  T("tick off the overdue ones, did them ages ago",
    diff(upd("cmp_250303", status="completed", completed=ANY), upd("cmp_250602", status="completed", completed=ANY),
         upd("rec_260528", status="completed", completed=ANY), upd("cmp_270215", status="completed", completed=ANY)),
    ref=[find(kind="task", linked_to="$maison", where="status = open", when=J({"to": U("day", -1)})),
         act("complete", rows="@prev")]))

S("T30-024", "balance multi-currency settle_up refusal-ask remove_from",
  T("where am i with marie-eve", val((-374, "CAD"), (640, "EUR")),
    ref=[ans(op="balance", kind="person", name="Marie-Eve")]),
  T("she paid me back for paris, settle that up", diff(settle=[("Marie-Ève Pelletier", "640.00")]),
    ref=[act("settle_up", rows="$marie_eve", args="group: $paris")]),
  T("and take her out of the paris group", ask("marie_eve", "paris"),
    ref=[act("remove_from", rows="$marie_eve", args="from: $paris")]))

S("T30-025", "role search find-only log message",
  T("accountant, last time we talked?", rows("annie_belanger"),
    ref=[search("accountant", kind="person"), ans(rows="@prev")]),
  T("log that i emailed her today", diff(upd("annie_belanger", date=ANY)),
    ref=[act("log", rows="$annie_belanger", args="kind: message")]))

S("T30-026", "empty-search recovery event relation order-limit reschedule",
  T("when's my next yoga class", rows(),
    ref=[search("yoga"),
         ans(kind="event", name="yoga", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("i meant léa's volleyball", rows("vb_270222"),
    ref=[ans(kind="event", name="volleyball", linked_to="$lea", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("move it to next tuesday", diff(upd("vb_270222", date="2027-02-23T17:30")),
    ref=[act("reschedule", rows="$vb_270222", args=lines(to=U("week", 1, weekday=2)))]))

S("T30-027", "folder delete write-read list document",
  T("delete the à classer folder, it's empty, and what folders do i have left",
    rows("impots_f", "assurances_f", "ecole_f", "hockey_f", "maison_f", "sante_f", "voyages_f", "auto_f", "travail_f", "banque_f",
         also=diff(gone("vide_f"))),
    ref=[act("delete", kind="folder", name="À classer", more=True),
         ans(kind="folder")]),
  T("what's in banque", rows("doc_25", "doc_26", "doc_51", "doc_52"),
    ref=[ans(kind="document", linked_to="$banque_f")]))

S("T30-028", "list add_to move where",
  T("move the open car insurance task to the budget list, it's a bill",
    diff(unlink("auto", "ins_270215"), link("budget", "ins_270215")),
    ref=[act("add_to", kind="task", name="car insurance", where="status = open", args="to: $budget")]))

S("T30-029", "event next relation group exclude reschedule anchor-row",
  T("when's the next book club", rows("bc_270226"),
    ref=[ans(kind="event", name="Book club", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("who from the cercle is going", rows("book_host", "marie_eve", "genevieve_t"),
    ref=[ans(kind="person", linked_to="$cercle, $bc_270226")]),
  T("and who's in the cercle but not going",
    rows("antoine_thibault", "yasmine_khoury", "raj_gauthier", "camille_paquette", "thierry_leclerc", "me"),
    ref=[ans(kind="person", linked_to="$cercle", exclude="@prev")]),
  T("push it back a day", diff(upd("bc_270226", date="2027-02-27T19:30")),
    ref=[act("reschedule", rows="$bc_270226", args=lines(to=U("day", 1, anchor="row")))]))

S("T30-030", "event order-limit name person-relation",
  T("what was the latest réunion de ruelle", rows("oo_016"),
    ref=[ans(kind="event", name="Réunion de ruelle", when=J({"to": U("day", 0)}), order="date desc", limit=1)]),
  T("who was there", rows("sam_b", "melanie_c"),
    ref=[ans(kind="person", linked_to="$oo_016")]))

S("T30-031", "repair weekday-without-unit span within relation cancel",
  T("what's on friday and saturday", rows("hg_270220", "sw_270220"),
    ref=[bad(ans(kind="event", when=J({"weekday": 5}))),
         ans(kind="event", when=J(span(U("week", 0, weekday=5), U("week", 0, weekday=6))))]),
  T("which of those is emile's", rows("hg_270220"),
    ref=[ans(within="@prev", linked_to="$emile")]),
  T("cancel it, he's down with the flu", diff(upd("hg_270220", status="cancelled")),
    ref=[act("cancel", rows="$hg_270220")]))

S("T30-032", "repair effort-unit where list-relation within complete",
  T("which open tasks take under half an hour", rows("t_020", "t_060", "t_188", "opus_260928", "t_078", "wat_270220", "t_099", "t_106", "opus_270228", "t_115", "furn_270315", "t_211"),
    ref=[bad(ans(kind="task", where="status = open and effort < 0.5 hour")),
         ans(kind="task", where="status = open and effort < 30")]),
  T("just the ones on the maison list", rows("wat_270220", "furn_270315"),
    ref=[ans(within="@prev", linked_to="$maison")]),
  T("furnace filter's done", diff(upd("furn_270315", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="furnace filter")]))

S("T30-033", "repair create-person-starred create star edit cadence",
  T("add dr lemieux, the new pediatrician, and star her",
    diff(new("person", name="Dr Lemieux", role="pediatrician", starred=True)),
    ref=[bad(act("create", args="kind: person\nname: Dr Lemieux\nrole: pediatrician\nstarred: yes")),
         act("create", args="kind: person\nname: Dr Lemieux\nrole: pediatrician", more=True),
         act("star", rows="$new")]),
  T("and see her every four weeks", diff(upd("+1", cadence=28)),
    ref=[act("edit", rows="$c1", args="cadence: 28")]))

S("T30-034", "two-writes complete reschedule undo read where",
  T("tick off the streaming one and push the gutters to the fourteenth",
    diff(upd("t_106", status="completed", completed=ANY), upd("t_017", date="2027-03-14")),
    ref=[act("complete", kind="task", name="streaming", where="status = open", more=True),
         act("reschedule", kind="task", name="gutters", where="status = open", args=lines(to=D("2027-03-14")))]),
  T("undo that, i changed my mind", diff(upd("t_106", status="open", completed=None), upd("t_017", date="2027-03-07")),
    ref=[act("undo")]),
  T("is the gutters thing back on the seventh", rows("t_017"),
    ref=[ans(kind="task", name="gutters", where="status = open")]))

S("T30-035", "decline unbounded bulk-cap-ask confirm-yes find-act delete",
  T("delete every task i have", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("ok just the paid hydro ones then", ask(),
    ref=[find(kind="task", name="Pay Hydro-Québec", where="status = completed"),
         act("delete", rows="@prev")]),
  T("yes go ahead",
    diff(trash("hq_240220"), trash("hq_240420"), trash("hq_240620"), trash("hq_240820"), trash("hq_241020"), trash("hq_241220"),
         trash("hq_250220"), trash("hq_250620"), trash("hq_250820"), trash("hq_251020"), trash("hq_251220"), trash("hq_260220"),
         trash("hq_260420"), trash("hq_260620"), trash("hq_260820"), trash("hq_261220")),
    ref=[act("delete", rows="@prev")]))

S("T30-036", "bulk star find-act photos relation",
  T("star all of léa's photos in the camping album", diff(upd("ph_camping24_10", starred=True), upd("ph_camping24_11", starred=True), upd("ph_camping24_16", starred=True)),
    ref=[find(kind="photo", linked_to="$camping24, $lea"),
         act("star", rows="@prev")]))

S("T30-037", "compute group value open priority where",
  T("how many open tasks per priority", vgroups({"1": 3, "2": 3, "none": 35}),
    ref=[comp(op="count", kind="task", group="priority", where="status = open"),
         ans(value="@prev")]),
  T("which are priority one", rows("t_099", "rent_270301", "t_211"),
    ref=[ans(kind="task", where="priority = 1 and status = open")]))

S("T30-039", "trashed restore event decline-window when read",
  T("restore léa's doctor appointment from the trash", diff(restore("oo_005")),
    ref=[act("restore", kind="event", name="Doctor - Léa", trashed=True)]),
  T("and the report card night", diff(restore("oo_011")),
    ref=[act("restore", kind="event", name="Report card night", trashed=True)]),
  T("and the hair appointment", decline("not_found"),
    ref=[act("restore", kind="event", name="Hair appointment", trashed=True)]),
  T("which doctor appointments does léa have in 2026", rows("oo_005"),
    ref=[ans(kind="event", name="Doctor - Léa", when=J(span(D("2026-01-01"), D("2026-12-31"))))]))

S("T30-040", "event order-limit create focus-created reschedule",
  T("what's the latest doctor appointment for léa", rows("oo_039"),
    ref=[ans(kind="event", name="Doctor - Léa", when=J({"to": U("day", 0)}), order="date desc", limit=1)]),
  T("book her another one for next thursday at 9", diff(new("event", name=has("Doctor"), date="2027-02-25T09:00")),
    ref=[act("create", args=lines(kind="event", name="Doctor - Léa", date=U("week", 1, weekday=4, time="09:00")))]),
  T("push the doctor back a day instead", diff(upd("+1", date="2027-02-26T09:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("day", 1, anchor="row")))]))

S("T30-041", "ambiguous-ask event delete date-select month-year",
  T("delete the team lunch", ask("oo_060", "oo_035", "oo_015", "oo_000", "oo_049"),
    ref=[act("delete", kind="event", name="Team lunch")]),
  T("the april 2024 one", diff(trash("oo_060")),
    ref=[act("delete", kind="event", name="Team lunch", when=J(U("month", -3, name=4)))]))

S("T30-042", "find-chain event person group within exclude",
  T("who was at the souper chez maman last march", rows("maman", "papa"),
    ref=[find(kind="event", name="Souper chez Maman", when=J(U("month", -1, name=3))),
         ans(kind="person", linked_to="@prev")]),
  T("which of them are in the famille gagnon group", rows("maman", "papa"),
    ref=[ans(within="@prev", linked_to="$famille_gagnon")]),
  T("and who else is in it", rows("isabelle", "martin", "marie_claude", "me"),
    ref=[ans(kind="person", linked_to="$famille_gagnon", exclude="@prev")]))

S("T30-038", "debt create write-read balance settle_debt amount relation",
  T("marie-pier owes me 15 for the carpool gas, what's her total now",
    val((209.68, "CAD"), also=diff(new("debt", name="carpool gas", amount=15, direction="owes_me"), link("new", "marie_pier"))),
    ref=[act("create", args="kind: debt\nname: carpool gas\namount: 15\ndirection: owes_me\nperson: $marie_pier", more=True),
         ans(op="balance", rows="$marie_pier")]),
  T("she paid the 15, settle it", diff(upd("+1", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$marie_pier", where="amount = 15")]))

S("T30-043", "note open find-open-answer relation edit-after-open",
  T("what does my allergy note say", rows("loose_5"),
    ref=[find(kind="note", name="allergy"), opn("$loose_5"), ans(rows="@prev")]),
  T("what are the gift ideas for maman", rows("loose_4"),
    ref=[ans(kind="note", name="gift ideas Maman")]),
  T("add a hat to that list", diff(upd("loose_4", body=has("hat"))),
    ref=[opn("$loose_4"),
         act("edit", rows="$loose_4", args="body: a cashmere scarf, tickets to the orchestra, a good photo album, a hat")]))

S("T30-044", "subtasks container where when complete-rows",
  T("what's left under the sous-sol reno that's due before june",
    rows("sous_sol_proj_9", "sous_sol_proj_10", "sous_sol_proj_11", "sous_sol_proj_12"),
    ref=[ans(kind="task", linked_to="$sous_sol_proj", where="status = open", when=J({"to": D("2027-05-31")}))]),
  T("basement's done, tick off all of those and the reno itself",
    diff(upd("sous_sol_proj_9", status="completed", completed=ANY), upd("sous_sol_proj_10", status="completed", completed=ANY),
         upd("sous_sol_proj_11", status="completed", completed=ANY), upd("sous_sol_proj_12", status="completed", completed=ANY),
         upd("sous_sol_proj", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev, $sous_sol_proj")]))
