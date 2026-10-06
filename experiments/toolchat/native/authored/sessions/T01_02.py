from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T01-026", "note spans narrow name body contains",
  T("what notes did i write from the first to today",
    rows("gift_ideas", "nights_list", "diary_rough", "paint_shortlist", "packing", "gp_questions", "gaz_questions",
         "easter_plan", "diary_good"),
    ref=[ans(kind="note", when=J(span(D("2026-03-01"), U("day", 0))))]),
  T("which of those are diary entries", rows("diary_rough", "diary_good"),
    ref=[ans(within="@prev", name="Diary entry")]),
  T("and between sunday and tuesday 9pm", rows("diary_rough", "paint_shortlist", "packing", "gp_questions"),
    ref=[ans(kind="note", when=J(span(U("week", -1, weekday=7), U("week", 0, weekday=2, time="21:00"))))]),
  T("reno notes since february", rows("worktop_quotes", "paint_shortlist", "gaz_questions"),
    ref=[ans(kind="note", linked_to="$reno_nb", when=J({"from": {"unit": "month", "name": 2, "rel": 0}}))]),
  T("which one mentions teal", rows("paint_shortlist"),
    ref=[ans(within="@prev", where='body contains "teal"')]))

S("T01-027", "restore note named add_to multi span notebook count delete prev",
  T("restore my old shopping list note", diff(restore("old_note")),
    ref=[act("restore", kind="note", name="Old shopping list", trashed=True)]),
  T("put that and car reg and tyre pressures in family",
    diff(link("family_nb", "old_note"), link("family_nb", "car_details")),
    ref=[act("add_to", rows="$old_note, $car_details", args="to: $family_nb")]),
  T("notes from the ninth to wednesday 8pm", rows("packing", "gp_questions", "gaz_questions", "easter_plan"),
    ref=[ans(kind="note", when=J(span(D("2026-03-09"), U("week", 0, weekday=3, time="20:00"))))]),
  T("any notebooks with only one note in", rows("old_nb"),
    ref=[ans(kind="notebook", where="note count = 1")]),
  T("delete it", diff(gone("old_nb"), unlink("old_nb", "old_revision")),
    ref=[act("delete", rows="@prev")]))

S("T01-028", "document spans star folder count ambiguous-act ask",
  T("docs i saved from last month up to the fifth", rows("payslip_feb", "rota_mar", "car_renewal", "farm_letter"),
    ref=[ans(kind="document", when=J(span(U("month", -1), D("2026-03-05"))))]),
  T("and from the start of the year to twenty-eighth jan 10am",
    rows("home_ins", "apartment_conf", "flight_booking", "quote_wren", "payslip_jan"),
    ref=[ans(kind="document", when=J(span(U("year", 0), D("2026-01-28", "10:00"))))]),
  T("star payslip january 2026", diff(upd("payslip_jan", starred=True)),
    ref=[act("star", rows="$payslip_jan")]),
  T("how many folders have actually got stuff in", val(6),
    ref=[ans(op="count", kind="folder", where="document count != 0")]),
  T("can you delete the kitchen quote", ask("quote_pickering", "quote_wren"),
    ref=[act("delete", kind="document", name="kitchen quote"),
         askc("Pickering Kitchens or Wren?", options="$quote_pickering, $quote_wren")]))

S("T01-029", "create event edit repair field-kind-lacks",
  T("can you put ada's swimming gala in for sat twenty-eighth at 2",
    diff(new("event", name=has("gala"), date="2026-03-28T14:00")),
    ref=[act("create", args=lines(kind="event", name="Ada swimming gala", date=D("2026-03-28", "14:00")))]),
  T("its two hours not 1", diff(upd("+1", duration=120)),
    ref=[act("edit", rows="$c1", args="duration: 120")]),
  T("add that its at the aquatics centre", diff(upd("+1", description=has("Aquatics"))),
    ref=[bad(act("edit", rows="$c1", args="location: Manchester Aquatics Centre")),
         act("edit", rows="$c1", args="description: Manchester Aquatics Centre")]))

S("T01-031", "not-found decline order limit",
  T("when's tobi's karate class", decline("not_found"),
    ref=[search("karate"), dec("not_found")]),
  T("sorry, ada's swimming lesson. next one?", rows("swim_0314"),
    ref=[ans(kind="event", name="swimming lesson", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("how many more has she got after that", val(2),
    ref=[ans(op="count", kind="event", name="swimming lesson", when=J({"from": U("day", 0)}), exclude="$swim_0314")]))

S("T01-032", "ask never-mind",
  T("move ada's swimming on saturday to", ask(),
    ref=[askc("Move Saturday's swimming lesson to when?")]),
  T("actually leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T01-033", "restore document where star prev spans",
  T("restore whatever i deleted out of the money folder", diff(restore("p60_old")),
    ref=[act("restore", kind="document", trashed=True, linked_to="$money_f")]),
  T("what's in there now", rows("ctax_bill", "p60", "car_renewal", "p60_old"),
    ref=[ans(kind="document", linked_to="$money_f")]),
  T("star the lot", diff(upd("ctax_bill", starred=True), upd("p60", starred=True), upd("car_renewal", starred=True),
                         upd("p60_old", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("what docs came in from the start of the year up to fifth march",
    rows("home_ins", "apartment_conf", "flight_booking", "quote_wren", "payslip_jan", "quote_pickering", "rota_mar",
         "car_renewal", "payslip_feb", "farm_letter"),
    ref=[ans(kind="document", when=J(span(U("year", 0), D("2026-03-05"))))]),
  T("and from last week to monday lunchtime", rows("farm_letter"),
    ref=[ans(kind="document", when=J(span(U("week", -1), U("week", 0, weekday=1, time="12:00"))))]))

S("T01-034", "create person star rename",
  T("new contact rhian price, the new childminder",
    diff(new("person", name="Rhian Price", role="childminder")),
    ref=[act("create", args="kind: person\nname: Rhian Price\nrole: childminder")]),
  T("give her a star", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("oh its rhiannon not rhian", diff(upd("+1", name="Rhiannon Price")),
    ref=[act("edit", rows="$c1", args="name: Rhiannon Price")]),
  T("who have i got starred that i met somewhere", rows("chioma", "gemma"),
    ref=[ans(kind="person", where="met is set and starred = yes")]))

S("T01-035", "delete restore person starred-ne",
  T("could you delete dev patel, they've moved", diff(trash("dev")),
    ref=[act("delete", kind="person", name="Dev Patel")]),
  T("hmm no put him back, callum wants his number", diff(restore("dev")),
    ref=[act("restore", rows="$dev")]),
  T("starred people, give me the count", val(6),
    ref=[ans(op="count", kind="person", where="starred = yes")]),
  T("and who am i meant to keep in touch with that isn't starred",
    rows("ifeoma", "kunle", "maureen", "bisi", "kwame"),
    ref=[ans(kind="person", where="starred != yes and cadence is set")]))

S("T01-036", "ambiguous-act remove_from ask unstar",
  T("take priya out of the night out group", ask("priya_n", "priya_s"),
    ref=[act("remove_from", kind="person", name="Priya", args="from: $night_out"),
         askc("Which Priya - Priya Nair or Priya Shah?", options="$priya_n, $priya_s")]),
  T("shah", diff(unlink("night_out", "priya_s")),
    ref=[act("remove_from", rows="$priya_s", args="from: $night_out")]),
  T("can you unstar gemma, she's moved to ICU", diff(upd("gemma", starred=False)),
    ref=[act("unstar", kind="person", name="Gemma")]))

S("T01-037", "reopen add_to remove_from task completed-set",
  T("reopen the worktop one, the oak's discontinued", diff(upd("worktops", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="worktops")]),
  T("put the prescripton one on life admin", diff(link("admin_list", "prescription")),
    ref=[act("add_to", kind="task", name="prescription", args="to: $admin_list")]),
  T("could you take ada's swimming costume off the kids list", diff(unlink("kids_list", "swim_kit")),
    ref=[act("remove_from", kind="task", name="swimming costume", args="from: $kids_list")]),
  T("what's actually been done on the kids list", rows("book_dentist", "costume"),
    ref=[ans(kind="task", linked_to="$kids_list", where="completed is set")]))

S("T01-038", "restore document where find star prev",
  T("i deleted something out of the work folder by mistake, get it back", diff(restore("payslip_dec")),
    ref=[act("restore", kind="document", trashed=True, linked_to="$work_f")]),
  T("and star both autumn reports", diff(upd("tobi_report", starred=True), upd("ada_report", starred=True)),
    ref=[find(kind="document", name="autumn report"), act("star", rows="@prev")]))

S("T01-039", "delete note notebook remove_from empty-notebook delete-prev",
  T("delete the pharmacolgy revision note", diff(trash("old_revision")),
    ref=[act("delete", kind="note", name="pharmacology")]),
  T("and delete the uni notes notebook", diff(gone("old_nb"), unlink("old_nb", "old_revision")),
    ref=[act("delete", rows="$old_nb")]),
  T("take banana bread out of recipes", diff(unlink("recipes", "banana_bread")),
    ref=[act("remove_from", kind="note", name="banana bread", args="from: $recipes")]),
  T("any notebooks left with nothing in them", rows("bible_nb"),
    ref=[ans(kind="notebook", where="note count = 0")]),
  T("get rid of that one too", diff(gone("bible_nb")),
    ref=[act("delete", rows="@prev")]))

S("T01-040", "trashed note restore add_to more",
  T("is my old shopping list note in the trash", rows("old_note"),
    ref=[ans(kind="note", name="shopping list", trashed=True)]),
  T("restore it and put it in family", diff(restore("old_note"), link("family_nb", "old_note")),
    ref=[act("restore", rows="$old_note", more=True), act("add_to", rows="$old_note", args="to: $family_nb")]),
  T("how many notes in family", val(7),
    ref=[ans(op="count", kind="note", linked_to="$family_nb")]))

S("T01-041", "find-only group members delete prev",
  T("is the secret santa group on here", rows("santa"),
    ref=[find(kind="group", name="Secret Santa"), ans(rows="@prev")]),
  T("who's in it", rows("me", "gemma", "kwame", "siobhan"),
    ref=[ans(kind="person", linked_to="$santa")]),
  T("delete it, that's long done",
    diff(gone("santa"), unlink("santa", "me"), unlink("santa", "gemma"), unlink("santa", "kwame"),
         unlink("santa", "siobhan")),
    ref=[act("delete", rows="@1")]),
  T("any groups not in pounds, like euros or naira", rows("lisbon", "family_fund"),
    ref=[ans(kind="group", where='currency in ("EUR", "NGN")')]))

S("T01-042", "photo spans starred time add_to find-only trashed restore prev",
  T("pics from december up to the first day back, sixth jan 9am",
    rows("p_ward_xmas", "p_nativity", "p_tree", "p_xmas_morning", "p_bike", "p_xmas_dinner", "p_school_gate"),
    ref=[ans(kind="photo", when=J(span({"unit": "month", "name": 12, "rel": -1}, D("2026-01-06", "09:00"))))]),
  T("which are starred", rows("p_xmas_morning", "p_nativity"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("what's the one from wednesday at half 7", rows("p_reading"),
    ref=[ans(kind="photo", when=J(U("week", 0, weekday=3, time="19:30")))]),
  T("put it in kids", diff(link("kids_album", "p_reading")),
    ref=[act("add_to", rows="$p_reading", args="to: $kids_album")]),
  T("is the receipt screenshot in the trash", rows("p_receipt"),
    ref=[find(kind="photo", name="receipt", trashed=True), ans(rows="@prev")]),
  T("restore it", diff(restore("p_receipt")),
    ref=[act("restore", rows="@prev")]))

S("T01-043", "restore photo edit unstar restore-prev",
  T("the receipt screenshot i deleted, restore it", diff(restore("p_receipt")),
    ref=[act("restore", kind="photo", name="receipt", trashed=True)]),
  T("call it tile shop receipt", diff(upd("p_receipt", name="Tile shop receipt")),
    ref=[act("edit", rows="$p_receipt", args="name: Tile shop receipt")]),
  T("could you unstar the sunrise pic", diff(upd("p_sunrise", starred=False)),
    ref=[act("unstar", kind="photo", name="sunrise")]),
  T("what's left in the photo trash", rows("p_blurry"),
    ref=[ans(kind="photo", trashed=True)]),
  T("get that back too", diff(restore("p_blurry")),
    ref=[act("restore", rows="@prev")]))

S("T01-044", "album create edit delete photo remove_from album-count answer-empty",
  T("make an album for the hen do", diff(new("album", name=has("Hen"))),
    ref=[act("create", args="kind: album\nname: Hen Do")]),
  T("can you take tobi's new bike out of christmas 2025", diff(unlink("xmas_album", "p_bike")),
    ref=[act("remove_from", kind="photo", name="Tobi's new bike", args="from: $xmas_album")]),
  T("rename lisbon 2026 to Lisbon Easter", diff(upd("lisbon_album", name="Lisbon Easter")),
    ref=[act("edit", rows="$lisbon_album", args="name: Lisbon Easter")]),
  T("and delete the engagement one", diff(gone("chi_album"), unlink("chi_album", "p_engagement"),
                                         unlink("chi_album", "p_ring"), unlink("chi_album", "p_girls")),
    ref=[act("delete", rows="$chi_album")]),
  T("which albums have five or more pics", rows("kids_album"),
    ref=[ans(kind="album", where="photo count >= 5")]),
  T("what's in the hen do one so far", rows(),
    ref=[ans(kind="photo", linked_to="$c1")]))

S("T01-045", "photo spans month name find edit prev",
  T("photos from last monday to the end of march", rows("p_book_day", "p_tiles", "p_teal", "p_sunrise", "p_reading"),
    ref=[ans(kind="photo", when=J(span(U("week", -1, weekday=1), {"unit": "month", "name": 3, "rel": 0})))]),
  T("and in feb", rows("p_swim_gala", "p_worktop", "p_goal", "p_tooth", "p_fiveaside"),
    ref=[ans(kind="photo", when=J(U("month", 0, name=2)))]),
  T("and december to the sixth jan at 9",
    rows("p_ward_xmas", "p_nativity", "p_tree", "p_xmas_morning", "p_bike", "p_xmas_dinner", "p_school_gate"),
    ref=[ans(kind="photo", when=J(span({"unit": "month", "name": 12, "rel": -1}, D("2026-01-06", "09:00"))))]),
  T("rename the three old kitchen ones to Old kitchen",
    diff(upd("p_sink", name="Old kitchen"), upd("p_cupboards", name="Old kitchen"), upd("p_floor", name="Old kitchen")),
    ref=[find(kind="photo", name="Old kitchen"), act("edit", rows="@prev", args="name: Old kitchen")]))

S("T01-046", "locker delete unstar find-trashed restore",
  T("could you delete the netflix login, cal pays for it", diff(trash("netflix")),
    ref=[act("delete", kind="locker item", name="Netflix")]),
  T("could you unstar monzo, what's starred in there", rows("nhs_login", "home_wifi", "office365",
                                                     also=diff(upd("monzo", starred=False))),
    ref=[act("unstar", kind="locker item", name="Monzo", more=True), ans(kind="locker item", where="starred = yes")]),
  T("what's in the locker delete, i need the virgin media login back", diff(restore("old_virgin")),
    ref=[find(kind="locker item", trashed=True), act("restore", rows="$old_virgin")]))

S("T01-047", "notebook folder create edit empty-folders",
  T("new notebook called lisbon", diff(new("notebook", name="Lisbon")),
    ref=[act("create", args="kind: notebook\nname: Lisbon")]),
  T("rename the reno notebook to Kitchen Reno Notes", diff(upd("reno_nb", name="Kitchen Reno Notes")),
    ref=[act("edit", rows="$reno_nb", args="name: Kitchen Reno Notes")]),
  T("and a folder for the hen do", diff(new("folder", name=has("Hen"))),
    ref=[act("create", args="kind: folder\nname: Hen Do")]),
  T("money folder should be called finance", diff(upd("money_f", name="Finance")),
    ref=[act("edit", rows="$money_f", args="name: Finance")]),
  T("which folders have nothing in them", rows("+2", "car_f"),
    ref=[ans(kind="folder", where="document count = 0")]))

S("T01-048", "list create edit folder refused ask knock-on",
  T("new list for easter hols stuff", diff(new("list", name=has("Easter"))),
    ref=[act("create", args="kind: list\nname: Easter Hols\narea: family")]),
  T("hen do list should be under friends not social", diff(upd("hen_list", area="friends")),
    ref=[act("edit", rows="$hen_list", args="area: friends")]),
  T("delete the old flat folder, we moved out ages ago", ask(),
    ref=[bad(act("delete", rows="$old_flat_f")),
         askc("Old Flat still has the deposit letter in it, so it can't be deleted yet. Move the letter somewhere first?")]),
  T("yeah stick it in money and then delete the folder",
    diff(unlink("old_flat_f", "deposit_letter"), link("money_f", "deposit_letter"), gone("old_flat_f")),
    ref=[act("add_to", rows="$deposit_letter", args="to: $money_f", more=True),
         act("delete", rows="$old_flat_f")]))

S("T01-049", "move document delete folder knock-on",
  T("move the old flat deposit letter into house and delete the old flat folder",
    diff(unlink("old_flat_f", "deposit_letter"), link("house_f", "deposit_letter"), gone("old_flat_f")),
    ref=[act("add_to", rows="$deposit_letter", args="to: $house_f", more=True),
         act("delete", rows="$old_flat_f")]))

S("T01-050", "repair malformed-where reschedule weekday",
  T("which tasks are priority one", rows("instalment", "permission", "tobi_passport"),
    ref=[bad(ans(kind="task", where="priority == 1")),
         ans(kind="task", where="priority = 1")]),
  T("move renew tobi's passport to monday", diff(upd("tobi_passport", date="2026-03-16")),
    ref=[act("reschedule", rows="$tobi_passport", args=lines(to=U("week", 1, weekday=1)))]))
