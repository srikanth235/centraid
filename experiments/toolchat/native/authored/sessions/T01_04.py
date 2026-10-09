from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T01-077", "folder count delete folder where",
  T("which folders actually have something in", rows("school_f", "house_f", "work_f", "travel_f", "money_f", "old_flat_f"),
    ref=[ans(kind="folder", where="document count != 0")]),
  T("delete the one that doesn't", diff(gone("car_f")),
    ref=[act("delete", kind="folder", where="document count = 0")]))

S("T01-079", "where duration cmp person count",
  T("what's on next week that's longer than two hours",
    rows("ld_0316", "study_day", "night_0319", "night_0320", "mum_bday"),
    ref=[ans(kind="event", when=J(U("week", 1)), where="duration > 120")]),
  T("any of those with other people", rows("mum_bday"),
    ref=[ans(within="@prev", where="person count > 0")]),
  T("cancel one of the shifts", ask("ld_0316", "night_0319", "night_0320"),
    ref=[find(within="@1", where='description contains "Ward 7"'),
         askc("Which one - the long day on the 16th or a night on the 19th or 20th?", options="@prev")]))

S("T01-080", "where effort cmp narrow complete status-ne",
  T("anything quick i can knock off tonight, under twenty mins",
    rows("skip", "permission", "study_parking", "nowtv", "card_mum", "prescription"),
    ref=[ans(kind="task", where="effort < 20 and status = open")]),
  T("which of those are tomorrow", rows("permission", "prescription"),
    ref=[ans(within="@prev", when=J(U("day", 1)))]),
  T("done both, anything else for tomorrow", rows("reading_book", "charger", "plumber_quote", "tesco",
    also=diff(upd("permission", status="completed", completed=ANY), upd("prescription", status="completed", completed=ANY))),
    ref=[act("complete", rows="$permission, $prescription", more=True),
         ans(kind="task", when=J(U("day", 1)), where="status = open")]),
  T("what's on the kids list that isn't done yet",
    rows("dinner_money", "boots", "tobi_passport", "reading_book", "childcare", "swim_kit"),
    ref=[ans(kind="task", linked_to="$kids_list", where="status = open")]))

S("T01-081", "note contains pinned unpin person-count span",
  T("which recipes mention mum", rows("egusi"),
    ref=[ans(kind="note", linked_to="$recipes", where='body contains "Mum"')]),
  T("what have i got pinned", rows("drug_calc", "allergy"),
    ref=[ans(kind="note", where="pinned = yes")]),
  T("could you unpin drug calc cheat sheet, what's left pinned", rows("allergy", also=diff(upd("drug_calc", pinned=False))),
    ref=[act("edit", rows="$drug_calc", args="pinned: no", more=True), ans(kind="note", where="pinned = yes")]),
  T("which notes have got people tagged",
    rows("allergy", "hen_ideas", "egusi", "kit_sizes", "refl_sepsis", "refl_falls", "gift_ideas", "gaz_questions"),
    ref=[ans(kind="note", where="person count >= 1")]),
  T("and what did i write from the first till",
    rows("gift_ideas", "nights_list", "diary_rough", "paint_shortlist", "packing", "gp_questions", "gaz_questions",
         "easter_plan", "diary_good"),
    ref=[ans(kind="note", when=J(span(D("2026-03-01"), U("day", 0))))]))

S("T01-082", "locker url contains star unstar-named",
  T("which of my logins are nhs ones", rows("nhs_login", "nhs_mail"),
    ref=[ans(kind="locker item", where='type = login and url contains "nhs"')]),
  T("star nhsmail", diff(upd("nhs_mail", starred=True)),
    ref=[act("star", rows="$nhs_mail")]),
  T("and unstar microsoft 365, it renews itself", diff(upd("office365", starred=False)),
    ref=[act("unstar", kind="locker item", name="Microsoft 365")]))

S("T01-083", "create group add_to where nickname members",
  T("new group called Kitchen Kitty, in pounds",
    diff(new("group", name="Kitchen Kitty", currency="GBP"), link("new", "me")),
    ref=[act("create", args="kind: group\nname: Kitchen Kitty\ncurrency: GBP")]),
  T("add gaz and cal to it", diff(link("+1", "gary"), link("+1", "callum")),
    ref=[act("add_to", kind="person", where='nickname = "Gaz"', args="to: $c1", more=True),
         act("add_to", kind="person", where='nickname = "Cal"', args="to: $c1")]),
  T("who's in it now", rows("me", "gary", "callum"),
    ref=[ans(kind="person", linked_to="$c1")]))

S("T01-084", "album count rename",
  T("which albums are empty", rows("lisbon_album"),
    ref=[ans(kind="album", where="photo count = 0")]),
  T("call it Lisbon Easter 2026", diff(upd("lisbon_album", name="Lisbon Easter 2026")),
    ref=[act("edit", rows="$lisbon_album", args="name: Lisbon Easter 2026")]),
  T("how many in the kids one", val(10),
    ref=[ans(op="count", kind="photo", linked_to="$kids_album")]))

S("T01-085", "folder count star doc",
  T("documents sitting outside every folder", rows("birth_cert"),
    ref=[ans(kind="document", where="folder count = 0")]),
  T("star it, its important", diff(upd("birth_cert", starred=True)),
    ref=[act("star", rows="$birth_cert")]),
  T("and move it into a folder", ask(),
    ref=[askc("Which folder - School, House, Work, Travel, Money or Old Flat?")]))

S("T01-086", "month name narrow cancel from-date attendees",
  T("what's in april", rows("mot", "flight_out", "flight_home", "ld_0413", "ld_0414", "night_0416", "night_0417",
                           "hen_class", "hen_dinner"),
    ref=[ans(kind="event", when=J(U("month", 0, name=4)))]),
  T("just work", rows("ld_0413", "ld_0414", "night_0416", "night_0417"),
    ref=[ans(within="@prev", where='description contains "Ward 7"')]),
  T("cancel the sixteenth, swapped with siobhan. what's left?",
    rows("ld_0413", "ld_0414", "night_0417", also=diff(upd("night_0416", status="cancelled"))),
    ref=[act("cancel", rows="$night_0416", more=True), ans(within="@prev", where="status != cancelled")]),
  T("what's the first thing from first may on", rows("wedding"),
    ref=[ans(kind="event", when=J({"from": D("2026-05-01")}), order="date asc", limit=1)]),
  T("who's going to that", rows("chioma", "callum"),
    ref=[ans(kind="person", linked_to="$wedding")]))

S("T01-087", "last-month-name album count add_to feb photo-time unstar",
  T("pics from december", rows("p_ward_xmas", "p_nativity", "p_tree", "p_xmas_morning", "p_bike", "p_xmas_dinner"),
    ref=[ans(kind="photo", when=J(U("month", -1, name=12)))]),
  T("which aren't in an album", rows("p_ward_xmas"),
    ref=[ans(within="@prev", where="album count = 0")]),
  T("put it in christmas", diff(link("xmas_album", "p_ward_xmas")),
    ref=[act("add_to", rows="$p_ward_xmas", args="to: $xmas_album")]),
  T("and feb?", rows("p_swim_gala", "p_worktop", "p_goal", "p_tooth", "p_fiveaside"),
    ref=[ans(kind="photo", when=J(U("month", 0, name=2)))]),
  T("what's the one i took last sunday at 6:40", rows("p_sunrise"),
    ref=[ans(kind="photo", when=J(U("week", -1, weekday=7, time="06:40")))]),
  T("unstar it", diff(upd("p_sunrise", starred=False)),
    ref=[act("unstar", rows="$p_sunrise")]))

S("T01-088", "met-in create group add_to prev",
  T("who do i know from church or antenatal class", rows("ifeoma", "jess_w"),
    ref=[ans(kind="person", where='met in ("church", "antenatal class")')]),
  T("make a group called Sunday Lunch Club in pounds and put them both in",
    diff(new("group", name="Sunday Lunch Club", currency="GBP"), link("new", "me"), link("new", "ifeoma"),
         link("new", "jess_w")),
    ref=[act("create", args="kind: group\nname: Sunday Lunch Club\ncurrency: GBP", more=True),
         act("add_to", rows="@1", args="to: $new")]))

S("T01-089", "date span count within",
  T("what's booked twenty-third to twenty-seventh", rows("fitting", "first_fix", "fiveaside_0324", "farm_trip", "training_0325",
                                     "team_meeting", "dentist", "easter_hunt"),
    ref=[ans(kind="event", when=J(span(D("2026-03-23"), D("2026-03-27"))))]),
  T("how many things is that", val(8),
    ref=[ans(op="count", within="@prev")]),
  T("cancel the kids thing on the wednesday", ask("farm_trip", "training_0325"),
    ref=[find(kind="event", within="@1", when=J(U("week", 2, weekday=3))),
         askc("Ada's farm trip or Tobi's football training?", options="$farm_trip, $training_0325")]))

S("T01-090", "group members narrow create add_to prev",
  T("who's in the ward 7 coffee club", rows("me", "priya_n", "priya_s", "gemma", "kwame", "siobhan"),
    ref=[ans(kind="person", linked_to="$coffee")]),
  T("which of them did i meet on the ward", rows("priya_n", "priya_s", "gemma", "kwame", "siobhan"),
    ref=[ans(within="@prev", where='met = "Ward 7"')]),
  T("make a group for gemma's leaving do, pounds, and add that lot",
    diff(new("group", name=has("Leaving"), currency="GBP"), link("new", "me"), link("new", "priya_n"),
         link("new", "priya_s"), link("new", "gemma"), link("new", "kwame"), link("new", "siobhan")),
    ref=[act("create", args="kind: group\nname: Gemma's Leaving Do\ncurrency: GBP", more=True),
         act("add_to", rows="@2", args="to: $new")]))

S("T01-091", "repair create-kind-in-args list",
  T("remind me to buy suncream for lisbon, put it on life admin",
    diff(new("task", name=has("suncream")), link("admin_list", "new")),
    ref=[bad(act("create", args="name: Buy suncream for Lisbon\nkind: task\nlist: $admin_list")),
         act("create", args="kind: task\nname: Buy suncream for Lisbon\nlist: $admin_list")]),
  T("due the first", diff(upd("+1", date="2026-04-01")),
    ref=[act("reschedule", rows="$c1", args=lines(to=D("2026-04-01")))]))

S("T01-092", "repair reveal-wrong-field",
  T("what's the security code on the barclays debit card", diff(reveal=[("barclays_card", "417")]),
    ref=[bad(act("reveal", rows="$barclays_card", args="field: security_code")),
         act("reveal", rows="$barclays_card", args="field: cvv")]),
  T("and the long number", diff(reveal=[("barclays_card", "4929123456781234")]),
    ref=[act("reveal", rows="$barclays_card", args="field: card_number")]))

S("T01-094", "repair where-field-kind-lacks",
  T("which events are in liverpool", rows("hen_class"),
    ref=[bad(ans(kind="event", where='location contains "Liverpool"')),
         ans(kind="event", where='description contains "Liverpool"')]),
  T("and who's going", rows("chioma", "laura", "jess_w", "jess_o", "zainab", "priya_n"),
    ref=[ans(kind="person", linked_to="$hen_class")]))

S("T01-095", "repair multi-kind-where linked focus reschedule",
  T("what's open for tobi", rows("tobi_passport", "boots"),
    ref=[bad(ans(kind="task,event", linked_to="$tobi", where="status = open")),
         ans(kind="task", linked_to="$tobi", where="status = open")]),
  T("and his stuff this week", rows("training_0311", "match_0315"),
    ref=[ans(kind="event", linked_to="$tobi", when=J(U("week", 0)))]),
  T("move his match to 11", diff(upd("match_0315", date="2026-03-15T11:00")),
    ref=[act("reschedule", rows="$match_0315", args=lines(to=U("day", 0, anchor="row", time="11:00")))]))

S("T01-096", "person spans anchor-time log undo-ledger relog",
  T("who have i spoken to monday to wednesday this week", rows("chioma", "priya_n", "mum"),
    ref=[ans(kind="person", when=J(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]),
  T("and since the start of feb",
    rows("kunle", "maureen", "bisi", "kwame", "chioma", "priya_n", "mum", "callum"),
    ref=[ans(kind="person", when=J(span({"unit": "month", "name": 2, "rel": 0}, U("day", 0))))]),
  T("who was it i messaged at 7:40 this morning", rows("callum"),
    ref=[ans(kind="person", when=J({"unit": "day", "rel": 0, "time": "07:40", "anchor": "today"}))]),
  T("rang bisi now, log it", diff(upd("bisi", date=ANY)),
    ref=[search("Bisi", kind="person"), act("log", rows="$bisi", args="kind: call")]),
  T("can you undo that", diff(),
    ref=[act("undo")]),
  T("fine, leave it. so when's bisi down as last contacted", rows("bisi"),
    ref=[ans(rows="$bisi")]))

S("T01-097", "ambiguous-act ask never-mind",
  T("cancel ada's swimming", ask("swim_0314", "swim_0321", "swim_0328"),
    ref=[act("cancel", kind="event", name="swimming lesson", when=J({"from": U("day", 0)})),
         find(kind="event", name="swimming lesson", when=J({"from": U("day", 0)})),
         askc("Which lesson - 14th, 21st or 28th?", options="$swim_0314, $swim_0321, $swim_0328")]),
  T("hmm actually forget it, she wants to go", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T01-098", "search pick log not-found",
  T("when did i last see mrs clarke", rows("maureen"),
    ref=[ans(rows="$maureen")]),
  T("went round hers sunday, log it", diff(upd("maureen", date=ANY)),
    ref=[act("log", rows="$maureen", args="kind: visit")]),
  T("when's ada's piano lesson", decline("not_found"),
    ref=[search("piano"), dec("not_found")]))

S("T01-099", "debt linkcount empty date spans amount",
  T("any debts that aren't tied to a person", rows(),
    ref=[ans(kind="debt", where="person count <= 0")]),
  T("what's come up since the first of march",
    rows("d_zainab", "d_kunle", "d_kwame_taxi", "d_priya_lunch", "d_callum"),
    ref=[ans(kind="debt", when=J({"from": D("2026-03-01")}))]),
  T("and from before this month that's open",
    rows("d_gemma_tickets", "d_siobhan", "d_mum_uniform", "d_jess_w"),
    ref=[ans(kind="debt", when=J({"to": U("month", -1)}), where="status = open")]),
  T("which of those are more than 20", rows("d_gemma_tickets", "d_mum_uniform", "d_jess_w"),
    ref=[ans(within="@prev", where="amount > 20")]),
  T("what about between the fourth at noon and wednesday gone",
    rows("d_kunle", "d_kwame_taxi", "d_priya_lunch", "d_callum"),
    ref=[ans(kind="debt", when=J(span(D("2026-03-04", "12:00"), U("week", 0, weekday=3))))]))

S("T01-100", "ambiguous-locker ask reveal out-of-scope",
  T("what's the nhs password", ask("nhs_login", "nhs_mail"),
    ref=[askc("Smartcard login or NHSmail?", options="$nhs_login, $nhs_mail")]),
  T("the email one", diff(reveal=[("nhs_mail", "Tobi&Ada2016")]),
    ref=[act("reveal", rows="$nhs_mail", args="field: password")]),
  T("can you reset it for me on the nhs site", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))


# --- follow-up turns (coverage + realism rework) ---------------------------------------------

X("T01-083",
  T("scrap kitchen kitty and the ward night out group too",
    diff(gone("+1"), unlink("+1", "me"), unlink("+1", "gary"), unlink("+1", "callum"),
         gone("night_out"), unlink("night_out", "me"), unlink("night_out", "priya_n"),
         unlink("night_out", "priya_s"), unlink("night_out", "zainab"), unlink("night_out", "siobhan")),
    ref=[act("delete", rows="$c1, $night_out")]))

X("T01-066",
  T("delete it, i'll ring them instead", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("no wait, bring it back", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

X("T01-014",
  T("put a note on renew car insurance: ring the direct line first", diff(upd("car_ins", description=has("direct line"))),
    ref=[act("edit", kind="task", name="Renew car insurance", args="description: ring the direct line first")]))

X("T01-050",
  T("delete collect prescription and book ada's eye test, both sorted", diff(trash("prescription"), trash("eye_test")),
    ref=[act("delete", rows="$prescription, $eye_test")]))

X("T01-072",
  T("can you get back the login i deleted last week", diff(restore("old_virgin")),
    ref=[act("restore", kind="locker item", trashed=True, where='type = "login"')]))

X("T01-094",
  T("who's down for three or more events", rows("ada", "callum", "chioma", "dean", "mum", "priya_n", "sophie", "tobi"),
    ref=[ans(kind="person", where="event count >= 3")]))

X("T01-005",
  T("who's got at least two events with me", rows("ada", "callum", "chioma", "dean", "gary", "jess_o", "jess_w", "kunle", "laura", "mum", "priya_n", "sophie", "tobi", "zainab"),
    ref=[ans(kind="person", where="event count >= 2")]))

X("T01-054",
  T("which starred people have fewer than two photos", rows("gemma"),
    ref=[ans(kind="person", where="starred = yes and photo count < 2")]))

X("T01-011",
  T("which of the shifts are Ward 7 night ones", rows("night_0305", "night_0306", "night_0307", "night_0319", "night_0320", "night_0416", "night_0417"),
    ref=[ans(kind="event", where='description = "Ward 7 night"')]))

X("T01-098",
  T("who did i talk to between last monday and last friday", rows(),
    ref=[ans(kind="person", when=J(span(U("week", -1, weekday=1), U("week", -1, weekday=5))))]))

X("T01-019",
  T("who've i spoken to from january up to today", rows("bisi", "callum", "chioma", "ifeoma", "kunle", "kwame", "maureen", "mum", "priya_n"),
    ref=[ans(kind="person", when=J(span(U("month", 0, name=1), U("day", 0))))]))

X("T01-091",
  T("what's on the kids list from next week on", rows("childcare", "dinner_money", "swim_kit", "tobi_passport"),
    ref=[ans(kind="task", linked_to="$kids_list", when=J({"from": U("week", 1)}))]))

X("T01-095",
  T("what's due from this monday till friday 6pm", rows("bins_0310", "charger", "nowtv", "permission", "plumber_quote", "prescription", "reading_book", "reply_chi"),
    ref=[ans(kind="task", when=J(span(U("week", 0, weekday=1), U("week", 0, weekday=5, time="18:00"))))]))

X("T01-040",
  T("recipes from february onwards", rows("banana_bread", "shepherds"),
    ref=[ans(kind="note", linked_to="$recipes", when=J({"from": U("month", 0, name=2)}))]))

X("T01-017",
  T("pics from last monday through end of march", rows("p_book_day", "p_reading", "p_sunrise", "p_teal", "p_tiles"),
    ref=[ans(kind="photo", when=J(span(U("week", -1, weekday=1), U("month", 0, name=3))))]))

X("T01-003",
  T("any debts from first feb 9am to last friday", rows("d_gemma_tickets", "d_jess_w", "d_kunle", "d_mum_uniform", "d_priya_s", "d_siobhan", "d_zainab"),
    ref=[ans(kind="debt", when=J(span(D("2026-02-01", "09:00"), U("week", -1, weekday=5))))]))

X("T01-092",
  T("debts from before this month", rows("d_dev", "d_gemma_tickets", "d_jess_w", "d_kwame_old", "d_mum_uniform", "d_priya_s", "d_siobhan"),
    ref=[ans(kind="debt", when=J({"to": U("month", -1)}))]))

X("T01-068",
  T("which days are Ward 7 day ones", rows("ld_0223", "ld_0226", "ld_0302", "ld_0303", "ld_0309", "ld_0310", "ld_0316", "ld_0330", "ld_0331", "ld_0413", "ld_0414"),
    ref=[ans(kind="event", where='description = "Ward 7 day"')]))

X("T01-088",
  T("who from ward 7 has fewer than one photo", rows("hannah"),
    ref=[ans(kind="person", where='met = "Ward 7" and photo count < 1')]))

X("T01-065",
  T("could you star gaz while you're at it", diff(upd("gary", starred=True)),
    ref=[act("star", kind="person", name="Gaz"), search("gaz", kind="person"), act("star", rows="$gary")]))

X("T01-073",
  T("open the tyre note", rows("car_details"),
    ref=[find(kind="note", name="Tyre note"), search("tyre", kind="note"), ans(rows="@prev")]))

X("T01-085",
  T("is there a scan of my passport in docs", decline("not_found"),
    ref=[find(kind="document", name="Passport scan"), search("passport", kind="document"), dec("not_found")]))

X("T01-089",
  T("move the easter egg thing to 3", diff(upd("easter_hunt", date="2026-03-27T15:00")),
    ref=[act("reschedule", kind="event", name="Easter egg thing", args=lines(to=U("day", 0, anchor="row", time="15:00"))),
         search("easter egg", kind="event"),
         act("reschedule", rows="$easter_hunt", args=lines(to=U("day", 0, anchor="row", time="15:00")))]))

X("T01-059",
  T("open my sepsis write-up", rows("refl_sepsis"),
    ref=[find(kind="note", name="Sepsis write-up"), search("sepsis", kind="note"), ans(rows="@prev")]))

X("T01-075",
  T("and push tobi football training back half an hour", ask("training_0318", "training_0325"),
    ref=[act("reschedule", kind="event", name="Tobi football training", args=lines(to=U("minute", 30, anchor="row"))),
         find(kind="event", name="Tobi football training"),
         askc("which one, the 18th or the 25th?", options="$training_0318, $training_0325")]))
