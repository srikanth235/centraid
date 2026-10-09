from gold import *

import json

world("T37", "2027-03-09T10:40", "Liam O'Brien", "train")

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T37-002-P", "list status date within narrow complete para",
  T("gaa list tasks still open ahead of the agm", rows("gaa_sliotars", "gaa_report"),
    ref=[ans(kind="task", linked_to="$gaa_list", where="status = open", when=W({"to": D("2027-03-18")}))]),
  T("keep only those under half an hour", rows("gaa_sliotars"),
    ref=[ans(within="@prev", where="effort < 30")]),
  T("mark the sliotars on the gaa list as done, i washed them last night", diff(upd("gaa_sliotars", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="sliotars", linked_to="$gaa_list")]),
  T("this month, apart from the treasurer's note one, what other gaa list tasks are open", rows("gaa_minibus", "gaa_insurance", "gaa_dues"),
    ref=[ans(kind="task", linked_to="$gaa_list", where="status = open", when=W(U("month", 0)),
             exclude="$gaa_report")]))

S("T37-006-P", "chain event attendees group find balance-person decoy-names para",
  T("easter lunch guest list?", rows("aoife", "conor", "oisin", "maura"),
    ref=[find(kind="person", linked_to="$easter"), ans(rows="@prev")]),
  T("april book club attendees?", rows("siobhan", "mary_k", "sean_b"),
    ref=[find(kind="event", name="book club", when=W(U("month", 0, name=4))),
         ans(kind="person", linked_to="@prev")]),
  T("my balance with mary from book club", val((-63, "EUR")),
    ref=[ans(op="balance", kind="person", name="mary", linked_to="$bookclub")]),
  T("book club is off, cancel it", ask("bookclub_jan", "bookclub_feb", "bookclub_mar", "bookclub_apr"),
    ref=[act("cancel", kind="event", name="book club")]))

S("T37-010-P", "create clash composed-ask retry wrong-container decline para",
  T("diary entry for thursday at 11, coffee with gerry", ask("coffee_brendan"),
    ref=[act("create", args="kind: event\nname: Coffee with Gerry\n" + lines(date=U("week", 0, weekday=4, time="11:00")))]),
  T("friday then", diff(new("event", name=has("coffee", "gerry"), date="2027-03-12T11:00")),
    ref=[act("create", args="kind: event\nname: Coffee with Gerry\n" + lines(date=U("week", 0, weekday=5, time="11:00")))]),
  T("gerry joins it", decline("out_of_scope"),
    ref=[act("add_to", rows="$gerry", args="to: $new")]))

S("T37-015-P", "events name month where-not-cancelled substitution within-when reschedule same-time para",
  T("february physio sessions, leaving out the cancelled one", rows("physio_0201", "physio_0208", "physio_0222"),
    ref=[ans(kind="event", name="physio", when=W(U("month", 0, name=2)), where="status != cancelled")]),
  T("this month's?", rows("physio_0301", "physio_0308", "physio_0315", "physio_0322", "physio_0329", "physio_review"),
    ref=[ans(kind="event", name="physio", when=W(U("month", 0)), where="status != cancelled")]),
  T("the upcoming ones among them?", rows("physio_0315", "physio_0322", "physio_0329", "physio_review"),
    ref=[ans(within="@prev", when=W({"from": U("day", 1)}))]),
  T("physio review on the 30th moves to the first of april, same time", diff(upd("physio_review", date="2027-04-01T10:00")),
    ref=[act("reschedule", kind="event", name="physio review", when=W(D("2027-03-30")), args=lines(to=D("2027-04-01")))]),
  T("physio session count this year, split by status", vgroups({"tentative": 9, "cancelled": 1}),
    ref=[comp(op="count", kind="event", name="physio", group="status", when=W(U("year", 0))), ans(value="@prev")]))

S("T37-019-P", "group-balance-me person-sub group-members photos-link-all para",
  T("my balance in the boston group?", val((-43.34, "USD")),
    ref=[ans(op="balance", kind="group", name="Boston Trip", linked_to="$me")]),
  T("dec's?", val((16.67, "USD")),
    ref=[ans(op="balance", kind="group", name="Boston Trip", linked_to="$declan")]),
  T("boston group members?", rows("me", "declan", "kathleen", "jack"),
    ref=[find(kind="person", linked_to="$boston"), ans(rows="@prev")]),
  T("boston album pictures from the 28th that show dec", rows("p_bos_dec", "p_bos_northend"),
    ref=[ans(kind="photo", linked_to="$declan, $boston_album", when=W(D("2026-12-28")))]))

S("T37-023-P", "decline out-of-scope text edit description decline weather para",
  T("let aoife know by text i'll be late for the minding", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("tomorrow's minding should say running late in its description",
    diff(upd("grandkids_0310", description="running late")),
    ref=[act("edit", kind="event", name="minding cian and saoirse", when=W(U("day", 1)),
             args="description: running late")]),
  T("wednesday's weather?", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T37-027-P", "create group add_to-several members create-debt links para",
  T("new euro group called salthill walkers",
    diff(new("group", name="Salthill Walkers", currency="EUR"), link("new", "me")),
    ref=[act("create", args="kind: group\nname: Salthill Walkers\ncurrency: EUR")]),
  T("nuala and gerry join it", diff(link("+1", "nuala"), link("+1", "gerry")),
    ref=[act("add_to", rows="$nuala, $gerry", args="to: $new")]),
  T("who's in there now", rows("me", "nuala", "gerry"),
    ref=[find(kind="person", linked_to="$c1"), ans(rows="@prev")]),
  T("lotto debt, nuala owes me 12",
    diff(new("debt", name=has("lotto"), amount=12, direction="owes_me"), link("new", "nuala")),
    ref=[act("create", args="kind: debt\nname: lotto\namount: 12\ndirection: owes_me\nperson: $nuala")]))

S("T37-031-P", "k4 read next-three link where order-limit para",
  T("next three events with tadhg that haven't been called off",
    rows("training_0309", "hurling_match", "training_0316", order=True),
    ref=[bad(ans(kind="event", linked_to="$tadhg", when=W({"from": U("day", 0)}), where="status != cancelled",
                 order="start asc", limit=3)),
         ans(kind="event", linked_to="$tadhg", when=W({"from": U("day", 0)}), where="status != cancelled",
             order="date asc", limit=3)]),
  T("longest among them?", rows("hurling_match"),
    ref=[ans(within="@prev", order="duration desc", limit=1)]))

S("T37-035-P", "already-so star order-limit then answer follow-up star para",
  T("newest pension statement gets a star", diff(already=["pension_stmt"]),
    ref=[act("star", kind="document", name="pension statement", order="date desc", limit=1),
         ans(rows="$pension_stmt")]),
  T("last year's pension statement gets one too", diff(upd("pension_stmt25", starred=True)),
    ref=[find(kind="document", name="pension statement", when=W(U("year", -1))), act("star", rows="@prev")]))

S("T37-039-P", "settle_debt by link then still-owed read para",
  T("bin collection money is back from nuala, mark it settled", diff(upd("d_nuala", status="settled")),
    ref=[act("settle_debt", kind="debt", name="bin collection", linked_to="$nuala")]),
  T("outstanding debts owed to me?", rows("d_conor", "d_aoife_cake", "d_gerry", "d_sean_b"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]))

S("T37-043-P", "create event retry edit-duration para",
  T("friday at 1, lunch with maura", diff(new("event", name=has("lunch", "maura"), date="2027-03-12T13:00")),
    ref=[act("create", args="kind: event\nname: Lunch with Maura\n" + lines(date=U("week", 0, weekday=5, time="13:00")))]),
  T("an hour and a half long", diff(upd("+1", duration=90)),
    ref=[act("edit", rows="$new", args="duration: 90")]),
  T("friday apart from the lunch, what else", rows("hearing"),
    ref=[ans(kind="event", when=W(D("2027-03-12")), exclude="$new")]))

S("T37-047-P", "delete notebook unlinks then where-count-zero para",
  T("get rid of the garden notebook, keeping the notes",
    diff(gone("garden_nb"), unlink("garden_nb", "gd_roses"), unlink("garden_nb", "gd_veg")),
    ref=[act("delete", rows="$garden_nb")]),
  T("this year's notes without a notebook now?",
    rows("gd_roses", "gd_veg", "diary_walk", "diary_cian", "boston_notes", "mo_gifts"),
    ref=[ans(kind="note", where="notebook count = 0", when=W(U("year", 0)))]))

S("T37-051-P", "fabricated decline reveal sealed-egress para",
  T("invent a fresh password for the revolut app", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("then tell me the saved one", diff(reveal=[("revolut_pw", "GalwayRev#44")]),
    ref=[act("reveal", rows="$revolut_pw", args="field: password")]),
  T("send it to conor by email", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T37-055-P", "create subtask container read complete-two exclude para",
  T("easter project needs a subtask, iron the good tablecloth, due the 26th",
    diff(new("task", name=has("tablecloth"), date="2027-03-26"), link("easter_proj", "new")),
    ref=[act("create", args="kind: task\nname: Iron the good tablecloth\n" + lines(date=D("2027-03-26")) +
             "\nparent: $easter_proj")]),
  T("remaining subtasks?", rows("easter_lamb", "easter_eggs", "easter_beds", "easter_flowers", "+1"),
    ref=[ans(kind="task", linked_to="$easter_proj", where="status = open")]),
  T("mark the lamb and the eggs complete",
    diff(upd("easter_lamb", status="completed", completed=ANY), upd("easter_eggs", status="completed", completed=ANY)),
    ref=[act("complete", rows="$easter_lamb, $easter_eggs")]),
  T("apart from the tablecloth, what remains", rows("easter_beds", "easter_flowers"),
    ref=[ans(kind="task", linked_to="$easter_proj", where="status = open", exclude="$c1")]))

S("T37-059-P", "two-writes star-unstar then read starred ambiguous-person ask pick unstar-two where-two para",
  T("home wifi loses its star, aoife one gains one, then starred items that aren't logins",
    rows("joint_acct", "aoife_wifi", "gaa_member",
         also=diff(upd("home_wifi", starred=False), upd("aoife_wifi", starred=True))),
    ref=[act("unstar", rows="$home_wifi", more=True), act("star", rows="$aoife_wifi", more=True),
         ans(kind="locker item", where='starred = yes and type != "login"')]),
  T("sean gets a star", ask("sean_b", "sean_m"),
    ref=[act("star", kind="person", name="sean")]),
  T("gaa sean", diff(upd("sean_m", starred=True)),
    ref=[find(kind="person", name="sean", linked_to="$gaa"), act("star", rows="@prev")]),
  T("tadhg and cian lose their stars", diff(upd("tadhg", starred=False), upd("cian", starred=False)),
    ref=[act("unstar", rows="$tadhg, $cian")]),
  T("starred people with a weekly cadence", rows("declan"),
    ref=[ans(kind="person", where="starred = yes and cadence = 7")]),
  T("golf pot members who are starred", rows("sean_m"),
    ref=[ans(kind="person", linked_to="$golf", where="starred = yes")]))

S("T37-063-P", "repair where-date two-writes search-role star count-group delete-where undo-restore para",
  T("health list items due before the 20th", rows("knee_ex", "hearing_aid"),
    ref=[bad(ans(kind="task", linked_to="$health_list", where="status = open and due < 2027-03-20")),
         ans(kind="task", linked_to="$health_list", where="status = open", when=W({"to": D("2027-03-20")}))]),
  T("mark the knee exercises done and shift the hearing aid moulds to monday",
    diff(upd("knee_ex", status="completed", completed=ANY), upd("hearing_aid", date="2027-03-15")),
    ref=[act("complete", kind="task", name="knee exercises", more=True),
         act("reschedule", rows="$hearing_aid", args=lines(to=U("week", 1, weekday=1)))]),
  T("audiologist gets a star too", diff(upd("audio", starred=True)),
    ref=[search("audiologist", kind="person"), act("star", rows="$audio")]),
  T("family task count per status", vgroups({"open": 9, "in_progress": 1}),
    ref=[comp(op="count", kind="task", group="status", linked_to="$family_list"), ans(value="@prev")]),
  T("family list, finished ones get wiped", diff(trash("easter_menu")),
    ref=[act("delete", kind="task", linked_to="$family_list", where="status = completed")]),
  T("undo it", diff(restore("easter_menu")),
    ref=[act("undo")]))

S("T37-067-P", "same-word link add_to photo album kilcorran group-folder-list-lookalikes two-row-linked_to full-name para",
  T("cian's first goal belongs in kilcorran too", diff(link("hurl_album", "p_cian_goal")),
    ref=[act("add_to", rows="$p_cian_goal", args="to: $hurl_album")]),
  T("tadhg pictures within kilcorran?", rows("p_hurl_team", "p_hurl_drill", "p_hurl_match"),
    ref=[ans(kind="photo", linked_to="$tadhg, $hurl_album")]),
  T("kilcorran hurling album contents now?",
    rows("p_hurl_team", "p_hurl_drill", "p_hurl_match", "p_hurl_bibs", "p_hurl_pitch", "p_hurl_cup", "p_cian_hurl",
         "p_cian_goal"),
    ref=[ans(kind="photo", linked_to="$hurl_album")]))

S("T37-071-P", "create login username-label url one-per-line implied-type para",
  T("esb login for me, liam.obrien61 as user, site esb.ie",
    diff(new("locker item", name=has("esb"), type="login", username="liam.obrien61", url=has("esb.ie"))),
    ref=[act("create", args="kind: locker item\nname: ESB login\ntype: login\nusername: liam.obrien61\nurl: esb.ie")]))

S("T37-075-P", "create person role-nickname-label debt-purpose group-currency-purpose created-link para",
  T("dermot shaw is a roofer who goes by dermy, quoting for the shed, save him",
    diff(new("person", name="Dermot Shaw", role="roofer", nickname="Dermy")),
    ref=[act("create", args="kind: person\nname: Dermot Shaw\nrole: roofer\nnickname: Dermy")]),
  T("lift to the airport, dermy owes me 30, sorting it friday",
    diff(new("debt", name=has("airport"), amount=30, direction="owes_me"), link("new", "+1")),
    ref=[act("create", args="kind: debt\nname: airport lift\namount: 30\ndirection: owes_me\nperson: $new")]),
  T("cheltenham trip group in euro please, the lads are going in march",
    diff(new("group", name=has("cheltenham"), currency="EUR"), link("new", "me")),
    ref=[act("create", args="kind: group\nname: Cheltenham Trip\ncurrency: EUR")]))

S("T37-079-P", "verb-choice add_to move-task bring-it-back add_to then edit status in-progress then create second-container-same-name para",
  T("minibus booking should live on the family list",
    diff(link("family_list", "gaa_minibus"), unlink("gaa_list", "gaa_minibus")),
    ref=[act("add_to", kind="task", name="minibus", args="to: $family_list")]),
  T("no, back to where it was", diff(link("gaa_list", "gaa_minibus"), unlink("family_list", "gaa_minibus")),
    ref=[act("add_to", rows="$gaa_minibus", args="to: $gaa_list")]),
  T("ringing round today, so minibus one is in progress", diff(upd("gaa_minibus", status="in_progress")),
    ref=[act("edit", kind="task", name="minibus", args="status: in_progress")]),
  T("another family list for the grandkids' stuff", diff(new("list", name="Family")),
    ref=[act("create", args="kind: list\nname: Family")]))

S("T37-083-P", "stop never_mind after-ask start-retraction then read then self-correcting reschedule para",
  T("minding's off, cancel it", ask("grandkids_0310", "grandkids_0317"),
    ref=[act("cancel", kind="event", name="minding cian and saoirse")]),
  T("never mind the minding after all", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("tomorrow's agenda?", rows("grandkids_0310"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("physio review goes to friday, wait, thursday", diff(upd("physio_review", date="2027-03-11T10:00")),
    ref=[act("reschedule", kind="event", name="physio review", args=lines(to=U("week", 0, weekday=4)))]))

S("T37-087-P", "set-answers role-noun dentist events-lookalikes then next appointment person-link para",
  T("dentist, who is it", rows("dentist"),
    ref=[ans(kind="person", where='role = "dentist"')]),
  T("next appointment with her?", rows("dentist_liam"),
    ref=[ans(kind="event", linked_to="$dentist", when=W({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T37-091-P", "container-link-read parent-task garden purpose-carried notebook-album-collision then within-when then notebook para",
  T("garden tasks still open this month", rows("garden_prune", "garden_shed", "garden_seeds"),
    ref=[ans(kind="task", linked_to="$garden_proj", where="status = open", when=W(U("month", 0)))]),
  T("this week's due ones only", rows("garden_prune", "garden_seeds"),
    ref=[ans(within="@prev", when=W(U("week", 0)))]),
  T("garden notebook contents", rows("gd_roses", "gd_veg"),
    ref=[ans(kind="note", linked_to="$garden_nb")]))

S("T37-095-P", "container-link-read list-vs-folder-vs-notebook health status then within-linked_to person substitution then by-date para",
  T("health, what's open", rows("hearing_aid", "bp_log", "knee_ex", "eye_form", "rx_apr"),
    ref=[ans(kind="task", linked_to="$health_list", where="status = open")]),
  T("dr nolan's ones among them?", rows("rx_apr"),
    ref=[ans(within="@prev", linked_to="$dr_nolan")]),
  T("colm?", rows("hearing_aid"),
    ref=[ans(within="@1", linked_to="$audio")]),
  T("family list tasks outstanding by the 20th", rows("aoife_key"),
    ref=[ans(kind="task", linked_to="$family_list", where="status = open", when=W({"to": D("2027-03-20")}))]))

S("T37-099-P", "stray-condition photos no-description inert then role-looking noun task then exact role para",
  T("nana's card needs pictures, cian's from this year",
    rows("p_cian_goal", "p_wed_minding", "p_cian_hurl", "p_cian_snow"),
    ref=[ans(kind="photo", linked_to="$cian", when=W(U("year", 0)))]),
  T("treasurer's note deadline?", rows("gaa_report"),
    ref=[ans(kind="task", name="treasurer's note")]),
  T("check-up to book, which contact is my gp", rows("dr_nolan"),
    ref=[ans(kind="person", where='role = "GP"')]))
