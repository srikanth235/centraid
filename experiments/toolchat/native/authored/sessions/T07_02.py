from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T07-026", "coop assembly agenda note complete list",
  T("when's the next coop assembly", rows("asm_0314"),
    ref=[ans(kind="event", name="Coop assembly", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("what does my agenda note say", rows("mar_agenda"),
    ref=[search("agenda", kind="note"), ans(rows="@prev")]),
  T("add raffle tickets from the choir at the end",
    diff(upd("mar_agenda", body="loan update, Expo samples, truck for April, new members, raffle tickets from the choir")),
    ref=[act("edit", rows="$mar_agenda",
             args=lines(body="loan update, Expo samples, truck for April, new members, raffle tickets from the choir"))]),
  T("and tick off drafting the agenda", diff(upd("agenda", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Draft the assembly agenda")]),
  T("what's not done on the coop list this month",
    rows("seed_pay", "agro_docs", "scale", "expo_samples", "expo_banner", "truck_book", "member_list", "dues_03"),
    ref=[ans(kind="task", linked_to="$coop_l", when=W(U("month", 0)), where='status != "completed"')]))

S("T07-027", "person edit multi cadence",
  T("set wilber and nilda to a weekly check-in, harvest is coming", diff(upd("wilber", cadence=7), upd("nilda", cadence=7)),
    ref=[act("edit", rows="$wilber, $nilda", args=lines(cadence=7))]),
  T("who's weekly now", rows("valeria", "teodoro", "efrain", "wilber", "nilda", "rosa_c", "lucia"),
    ref=[ans(kind="person", where="cadence = 7")]),
  T("rosa phoned now, record that", ask("rosa_m", "rosa_c"),
    ref=[act("log", kind="person", name="Rosa", args=lines(kind="call")),
         askc("rosa mamani or rosa condori?", options="$rosa_m, $rosa_c")]))

S("T07-028", "album find delete prev empty add_to",
  T("find the expo album", rows("expo_al"),
    ref=[find(kind="album", name="Expo"), ans(rows="@prev")]),
  T("delete it, those pics live in harvest",
    diff(gone("expo_al"), unlink("expo_al", "e_stand"), unlink("expo_al", "e_ribbon")),
    ref=[act("delete", rows="@prev")]),
  T("is the stand photo in any album", rows(),
    ref=[ans(kind="album", linked_to="$e_stand")]),
  T("put it in harvest 2025", diff(link("harvest_al", "e_stand")),
    ref=[act("add_to", rows="$e_stand", args=lines(to="$harvest_al"))]))

S("T07-029", "single photo count date span",
  T("how many photos did i take between the first and the eleventh", val(6),
    ref=[ans(op="count", kind="photo", when=W(span(D("2026-03-01"), D("2026-03-11"))))]))

S("T07-030", "locker trashed dead end restore",
  T("is my old movistar login around", rows("movistar"),
    ref=[ans(kind="locker item", name="Movistar"), ans(rows="$movistar")]),
  T("restore it, i need the username for the bill", diff(restore("movistar")),
    ref=[act("restore", rows="$movistar")]),
  T("and what's the web address on it", rows("movistar"),
    ref=[ans(rows="$movistar")]))

S("T07-031", "locker star prev knock-on",
  T("what's my interbank card saved as", rows("visa"),
    ref=[find(kind="locker item", name="Interbank"), ans(rows="@prev")]),
  T("star it", diff(upd("visa", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("rename it Interbank Visa Oro and move the loan application form to coop papers",
    diff(upd("visa", name="Interbank Visa Oro"), unlink("loan_f", "loan_app"), link("coop_f", "loan_app")),
    ref=[act("edit", rows="$visa", args=lines(name="Interbank Visa Oro"), more=True),
         act("add_to", kind="document", name="Loan application form", args=lines(to="$coop_f"))]))

S("T07-032", "person dates since anchor span",
  T("who have i been in touch with since the tenth", rows("julio", "juana", "carla", "teodoro", "rosa_c", "lucia", "sonia"),
    ref=[ans(kind="person", when=W({"from": D("2026-03-10")}))]),
  T("who was i with two days ago around 5pm", rows("juana", "sonia"),
    ref=[ans(kind="person", when=W(U("day", -2, time="17:00", anchor="today")))]),
  T("and who did i talk to from january up to last friday",
    rows("camila", "luis", "nilda", "fortunata", "hugo", "marco", "raul", "wilber", "rosa_m", "patricia", "carmen"),
    ref=[ans(kind="person", when=W(span(U("month", 0, name=1), U("week", -1, weekday=5))))]))

S("T07-033", "debt dates settle multi",
  T("debts from ninth march 6pm through end of march", rows("d_efrain", "d_sonia"),
    ref=[ans(kind="debt", when=W(span(D("2026-03-09", "18:00"), U("month", 0, name=3))))]),
  T("paid both of them this morning", diff(upd("d_efrain", status="settled"), upd("d_sonia", status="settled")),
    ref=[act("settle_debt", rows="$d_efrain, $d_sonia")]))

S("T07-034", "notes date spans linked_to all add_to note",
  T("what notes did i write from the first at 9am to the ninth at 6pm",
    rows("raffle_notes", "seed_2026", "soil_notes", "loan_notes", "julio_gifts", "vale_courses", "prices"),
    ref=[ans(kind="note", when=W(span(D("2026-03-01", "09:00"), D("2026-03-09", "18:00"))))]),
  T("which notes have both teodoro and rosa mamani on them", rows("feb_min"),
    ref=[ans(kind="note", linked_to="$teodoro, $rosa_m")]),
  T("put the note about the frost in field notes", diff(link("field_nb", "frost")),
    ref=[act("add_to", kind="note", name="Thoughts after the frost", args=lines(to="$field_nb"))]),
  T("notes from before the end of january?", rows("natives", "chuno", "ocopa", "huancaina", "trial_plan", "seating", "seed_2025"),
    ref=[ans(kind="note", when=W({"to": U("month", 0, name=1)}))]))

S("T07-035", "refused unit repair edit prev list count",
  T("any task that's going to take me past one hour", rows("scout_report", "trial_data", "storehouse", "agro_docs", "expo_samples", "sunat"),
    ref=[bad(ans(kind="task", where="effort > 1 hour")),
         ans(kind="task", where="effort > 60")]),
  T("the sunat one, add that the accountant is sr paredes",
    diff(upd("sunat", description="annual income tax, farm receipts in the tax folder; accountant is Sr Paredes")),
    ref=[find(within="@prev", name="SUNAT"),
         act("edit", rows="@prev", args=lines(description="annual income tax, farm receipts in the tax folder; accountant is Sr Paredes"))]),
  T("which of those big ones aren't on any list", rows("sunat"),
    ref=[ans(kind="task", within="@1", where="list count <= 0")]))

S("T07-036", "single task description set",
  T("which tasks have a description on them", rows("fung_1", "scout_report", "agro_docs", "expo_samples", "roof", "sunat"),
    ref=[ans(kind="task", where="description is set")]))

S("T07-037", "person create add_to remove_from new",
  T("add Graciela Huaman to the lima costs group, she's chipping in for vale's rent",
    diff(new("person", name="Graciela Huaman"), link("family_g", "new")),
    ref=[act("create", more=True, args=lines(kind="person", name="Graciela Huaman")),
         act("add_to", rows="$new", args=lines(to="$family_g"))]),
  T("hm take her back out, julio says no", diff(unlink("family_g", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$family_g"))]),
  T("who's in that group", rows("julio", "valeria", "me"),
    ref=[ans(kind="person", linked_to="$family_g")]))

S("T07-038", "events next week edit where duration person count",
  T("what's on next week", rows("scout_0316", "mechanic", "dentist", "clinic", "reh_0318", "agro_0319", "inia_day", "julio_bday",
                                "mass_0322", "vcall_0322"),
    ref=[ans(kind="event", when=W(U("week", 1)))]),
  T("for julio's dinner put reservation under Huaman, 8 people",
    diff(upd("julio_bday", description="reservation under Huaman, 8 people")),
    ref=[act("edit", kind="event", linked_to="$julio", when=W(U("week", 1)), args=lines(description="reservation under Huaman, 8 people"))]),
  T("which of next week's are an hour or less", rows("mechanic", "dentist", "agro_0319", "vcall_0322"),
    ref=[ans(kind="event", within="@1", where="duration <= 60")]),
  T("any of them with nobody else on", rows(),
    ref=[ans(kind="event", within="@1", where="person count = 0")]))

S("T07-039", "document dates star",
  T("docs i've added since last month", rows("min_doc", "expo_contract", "loan_app", "repay", "enrol", "lease", "water_doc",
                                             "elec_doc", "soil_pdf", "seed_receipt"),
    ref=[ans(kind="document", when=W({"from": U("month", -1)}))]),
  T("from last monday up to the fifth at noon", rows("enrol", "water_doc", "soil_pdf", "loan_app"),
    ref=[ans(kind="document", when=W(span(U("week", -1, weekday=1), D("2026-03-05", "12:00"))))]),
  T("star the loan form", diff(upd("loan_app", starred=True)),
    ref=[act("star", rows="$loan_app")]),
  T("and the inia lab results pdf, where is it", rows("soil_pdf"),
    ref=[find(kind="document", name="INIA lab results"), search("lab results", kind="document"), ans(rows="$soil_pdf")]))

S("T07-040", "document create unstar new folder prev",
  T("save a doc called Agrobanco approval letter in the loan folder and star it",
    diff(new("document", name="Agrobanco approval letter", starred=True), link("loan_f", "new")),
    ref=[act("create", more=True, args=lines(kind="document", name="Agrobanco approval letter", folder="$loan_f")),
         act("star", rows="$new")]),
  T("unstar it, it's only the draft", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]),
  T("what's starred in that folder", rows("title"),
    ref=[ans(kind="document", linked_to="$loan_f", where="starred = yes")]))

S("T07-041", "debt count remove_from where coop",
  T("which coop people have no debts with me at all", rows("fortunata"),
    ref=[ans(kind="person", where='debt count < 1 and role contains "coop"')]),
  T("take her off the coop group, she hasn't come since january", diff(unlink("coop_g", "fortunata")),
    ref=[act("remove_from", kind="person", linked_to="$coop_g", where='role = "coop member"', args=lines(from_="$coop_g"))]))

S("T07-042", "single locker type empty",
  T("any locker entries with no type set", rows(),
    ref=[ans(kind="locker item", where="type is empty")]))

S("T07-043", "find miss search recover balance",
  T("when's the quito conference", rows("quito"),
    ref=[find(kind="event", name="Quito conference"), search("quito", kind="event"), ans(rows="$quito")]),
  T("who's going", rows("hugo", "teodoro"),
    ref=[ans(kind="person", linked_to="$quito")]),
  T("what do i owe hugo all told", val((-90, "PEN"), (-120, "USD")),
    ref=[ans(op="balance", rows="$hugo")]))

S("T07-044", "photo date spans count star",
  T("photos from sixteenth feb to last wednesday", rows("t_lesion", "t_hugo", "c_robes", "v_campus", "rainbow", "t_spray"),
    ref=[ans(kind="photo", when=W(span(D("2026-02-16"), U("week", -1, weekday=3))))]),
  T("star the one of hugo", diff(upd("t_hugo", starred=True)),
    ref=[act("star", rows="$t_hugo")]),
  T("how many from january up to last friday", val(15),
    ref=[ans(op="count", kind="photo", when=W(span(U("month", 0, name=1), U("week", -1, weekday=5))))]),
  T("and before twentieth jan at noon?", val(14),
    ref=[ans(op="count", kind="photo", when=W({"to": D("2026-01-20", "12:00")}))]))

S("T07-045", "task date spans count",
  T("how many things are due from next monday on", val(25),
    ref=[ans(op="count", kind="task", when=W({"from": U("week", 1, weekday=1)}))]),
  T("and from april through the fifteenth at 6pm", rows("storehouse", "ferti", "sacks"),
    ref=[ans(kind="task", when=W(span(U("month", 0, name=4), D("2026-04-15", "18:00"))))]),
  T("delete the pay coop dues task", ask(),
    ref=[act("delete", kind="task", name="Pay coop dues"),
         askc("there's one per month, which one? this month's open one?")]))

S("T07-046", "task reschedule anchor edit undo field",
  T("push the irrigation check back two days", diff(upd("irrigation", date="2026-03-16")),
    ref=[act("reschedule", kind="task", name="irrigation", args=lines(to=U("day", 2, anchor="row")))]),
  T("and note that efrain is doing it, he knows the channel", diff(upd("irrigation", description="Efrain is doing it, he knows the channel")),
    ref=[act("edit", rows="$irrigation", args=lines(description="Efrain is doing it, he knows the channel"))]),
  T("undo that", diff(upd("irrigation", description=None)),
    ref=[act("undo")]))

S("T07-047", "valeria rent ambiguous narrow list call balance",
  T("vale's rent is paid, tick it", diff(upd("rent_mar", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay Valeria's rent"),
         act("complete", kind="task", name="Pay Valeria's rent", where='status = "open"')]),
  T("what else is on her list", rows("vale_box", "vale_fees", "vale_laptop"),
    ref=[ans(kind="task", linked_to="$vale_l", where='status = "open"')]),
  T("the box one, move it to saturday", diff(upd("vale_box", date="2026-03-14")),
    ref=[act("reschedule", rows="$vale_box", args=lines(to=U("week", 0, weekday=6)))]),
  T("when's my next call with her", rows("vcall_0315"),
    ref=[ans(kind="event", name="Call with Valeria", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("and where's she at in the lima costs group", val((0, "PEN")),
    ref=[ans(op="balance", kind="group", name="Valeria's Lima costs", linked_to="$valeria")]))

S("T07-048", "single today afternoon",
  T("anything this afternoon?", rows("marco_call"),
    ref=[ans(kind="event", when=W(U("day", 0)))]))

S("T07-049", "compute group count max min",
  T("how many tasks per status", vgroups({"open": 32, "in_progress": 3, "completed": 15, "cancelled": 1}),
    ref=[comp(op="count", kind="task", group="status"), ans(value="@prev")]),
  T("biggest open debt each way", vgroups({"owes_me": (300, "PEN"), "i_owe": (350, "PEN")}),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"', group="direction"), ans(value="@prev")]),
  T("smallest one someone owes me?", val((15, "PEN")),
    ref=[ans(op="min", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]))

S("T07-050", "folder delete refused ask then bulk",
  T("delete the valeria folder, she keeps her own copies", ask(),
    ref=[bad(act("delete", rows="$vale_f")),
         askc("the valeria folder still holds her enrolment certificate, lease and grades. move them somewhere first?")]),
  T("yeah put them in house and then get rid of it",
    diff(unlink("vale_f", "enrol"), unlink("vale_f", "lease"), unlink("vale_f", "grades"),
         link("house_f", "enrol"), link("house_f", "lease"), link("house_f", "grades"), gone("vale_f")),
    ref=[find(kind="document", linked_to="$vale_f"),
         act("add_to", rows="@prev", args=lines(to="$house_f"), more=True),
         act("delete", rows="$vale_f")]))
