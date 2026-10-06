from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T07-076", "people met within group count log task count",
  T("who did i meet at the coop assembly", rows("teodoro", "rosa_m", "efrain", "wilber"),
    ref=[ans(kind="person", where='met = "Coop assembly"')]),
  T("which of them are in two or more groups", rows("teodoro"),
    ref=[ans(kind="person", within="@prev", where="group count >= 2")]),
  T("log a call with teodoro apaza", diff(upd("teodoro", date=ANY)),
    ref=[act("log", kind="person", name="Teodoro Apaza", args=lines(kind="call"))]),
  T("who's got two or more tasks tied to them", rows("valeria", "hugo", "teodoro", "efrain"),
    ref=[ans(kind="person", where="task count >= 2")]))

S("T07-077", "rosa condori balance cadence group size delete undo",
  T("rosa condori's balance with me?", val((50, "PEN")),
    ref=[ans(op="balance", kind="person", name="Rosa Condori")]),
  T("who in the san blas choir do i check in with more often than every two weeks", rows("rosa_c", "lucia"),
    ref=[ans(kind="person", linked_to="$choir_g", where="cadence < 14 days")]),
  T("groups with three people or fewer, me included", rows("family_g", "quito_g", "pisac_g", "raffle_g"),
    ref=[ans(kind="group", where="person count <= 3")]),
  T("delete the choir raffle fund", diff(gone("raffle_g"), unlink("raffle_g", "carmen"), unlink("raffle_g", "jaime"),
                                         unlink("raffle_g", "me")),
    ref=[act("delete", kind="group", name="Choir raffle fund")]),
  T("move the coop assembly to 11", ask(),
    ref=[act("reschedule", kind="event", name="Coop assembly", args=lines(to=U("day", 0, anchor="row", time="11:00"))),
         askc("which assembly, this saturday's or april's?")]))

S("T07-078", "task bin find restore multi reschedule read",
  T("what's in the task trash", rows("poster", "manure", "senasa"),
    ref=[find(kind="task", trashed=True), ans(rows="@prev")]),
  T("restore design the raffle poster and ask about llama manure", diff(restore("poster"), restore("manure")),
    ref=[act("restore", rows="$poster, $manure")]),
  T("give the llama manure one next friday as a due date", diff(upd("manure", date="2026-03-20")),
    ref=[act("reschedule", rows="$manure", args=lines(to=U("week", 1, weekday=5)))]),
  T("so what's due that friday", rows("vale_box", "expo_banner", "water_bill", "julio_gift", "manure"),
    ref=[ans(kind="task", when=W(U("week", 1, weekday=5)))]))

S("T07-079", "find miss search miss where description edit prev",
  T("find my income tax task", rows("sunat"),
    ref=[find(kind="task", name="income tax"), find(kind="task", where='description contains "income tax"'), ans(rows="@prev")]),
  T("rename it File SUNAT return 2025 and make it due the twenty-seventh",
    diff(upd("sunat", name="File SUNAT return 2025", date="2026-03-27")),
    ref=[act("edit", rows="@prev", args=lines(name="File SUNAT return 2025"), more=True),
         act("reschedule", rows="$sunat", args=lines(to=D("2026-03-27")))]),
  T("what else is due that day", rows("member_list"),
    ref=[ans(kind="task", when=W(D("2026-03-27")), exclude="$sunat")]))

S("T07-080", "reschedule task where add_to multi count",
  T("move my task for raul to next thursday", diff(upd("truck_book", date="2026-03-19")),
    ref=[act("reschedule", kind="task", linked_to="$raul", args=lines(to=U("week", 1, weekday=4)))]),
  T("put book raul's truck for april and fix the weighing scale on the farm list",
    diff(unlink("coop_l", "truck_book"), unlink("coop_l", "scale"), link("farm_l", "truck_book"), link("farm_l", "scale")),
    ref=[act("add_to", rows="$truck_book, $scale", args=lines(to="$farm_l"))]),
  T("move the call with valeria to 9pm", ask(),
    ref=[act("reschedule", kind="event", name="Call with Valeria", args=lines(to=U("day", 0, anchor="row", time="21:00"))),
         askc("which call with valeria, this sunday's or a later one?")]))

S("T07-081", "note remove_from where notebook count add_to named write read",
  T("take the pinned note out of the choir notebook", diff(unlink("choir_nb", "repertoire")),
    ref=[act("remove_from", kind="note", linked_to="$choir_nb", where="pinned = yes", args=lines(from_="$choir_nb"))]),
  T("how many notes have no notebook", val(4),
    ref=[ans(op="count", kind="note", where="notebook count = 0")]),
  T("put things to ask hugo into field notes and show me what's in field notes",
    rows("seed_2026", "blight_log", "trial_plan", "soil_notes", "rain", "natives", "hugo_qs", also=diff(link("field_nb", "hugo_qs"))),
    ref=[act("add_to", kind="note", name="Things to ask Hugo", args=lines(to="$field_nb"), more=True),
         ans(kind="note", linked_to="$field_nb")]))

S("T07-082", "folder count create unstar new find folder edit prev",
  T("which docs have no folder", rows("dni_scan", "seed_receipt"),
    ref=[ans(kind="document", where="folder count <= 0")]),
  T("new doc, Crop insurance quote, star it", diff(new("document", name="Crop insurance quote", starred=True)),
    ref=[act("create", more=True, args=lines(kind="document", name="Crop insurance quote")), act("star", rows="$new")]),
  T("unstar it, rosa says that quote expired", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]),
  T("find the valeria folder", rows("vale_f"),
    ref=[find(kind="folder", name="Valeria"), ans(rows="@prev")]),
  T("rename it Valeria La Molina", diff(upd("vale_f", name="Valeria La Molina")),
    ref=[act("edit", rows="@prev", args=lines(name="Valeria La Molina"))]))

S("T07-083", "restore photo where album count unstar already",
  T("the expo photo from last year i deleted, bring it back", diff(restore("dup_stand")),
    ref=[act("restore", kind="photo", trashed=True, when=W(U("year", -1)))]),
  T("photos in two or more albums", rows("h_huayro", "h_pachamanca", "h_vale", "c_xmas", "e_ribbon"),
    ref=[ans(kind="photo", where="album count >= 2")]),
  T("unstar christmas concert", diff(upd("c_xmas", starred=False)),
    ref=[act("unstar", kind="photo", name="Christmas concert")]),
  T("and star the rainbow over huasao", diff(already=["rainbow"]),
    ref=[act("star", kind="photo", name="Rainbow over Huasao"), ans(rows="$rainbow")]))

S("T07-084", "albums photos find delete prev ask",
  T("which albums have i got", rows("harvest_al", "choir_al", "vale_al", "trials_al", "family_al", "expo_al"),
    ref=[ans(kind="album")]),
  T("what's in expo 2025", rows("e_stand", "e_ribbon"),
    ref=[ans(kind="photo", linked_to="$expo_al")]),
  T("delete the expo 2025 album", diff(gone("expo_al"), unlink("expo_al", "e_stand"), unlink("expo_al", "e_ribbon")),
    ref=[find(kind="album", name="Expo 2025"), act("delete", rows="@prev")]),
  T("and delete the photo of valeria", ask("h_vale", "v_campus", "v_room", "v_lab"),
    ref=[act("delete", kind="photo", name="Valeria"),
         askc("which one: at the harvest, on campus, her new room or in the soil lab?",
              options="$h_vale, $v_campus, $v_room, $v_lab")]))

S("T07-085", "locker find star prev url type empty",
  T("what's saved for the passport", rows("passport"),
    ref=[find(kind="locker item", name="Passport"), ans(rows="@prev")]),
  T("star it, i need it for quito", diff(upd("passport", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("which login is for mail.google.com", rows("gmail"),
    ref=[ans(kind="locker item", where='url contains "mail.google.com"')]),
  T("any locker items without a type?", rows(),
    ref=[ans(kind="locker item", where="type is empty")]))

S("T07-086", "list empty recovery edit where area tasks",
  T("rename the family list to Vale", diff(upd("vale_l", name="Vale")),
    ref=[find(kind="list", name="family"),
         act("edit", kind="list", where='area = "family"', args=lines(name="Vale"))]),
  T("which lists aren't church or farm", rows("coop_l", "home_l", "vale_l"),
    ref=[ans(kind="list", where='area != "church" and area != "farm"')]),
  T("what's open on vale", rows("rent_mar", "vale_box", "vale_fees", "vale_laptop"),
    ref=[ans(kind="task", linked_to="$vale_l", where='status = "open"')]),
  T("move pay valeria's tuition to the twenty-fifth", diff(upd("vale_fees", date="2026-03-25")),
    ref=[act("reschedule", kind="task", name="Pay Valeria's tuition", args=lines(to=D("2026-03-25")))]),
  T("and the rent one this month?", rows("rent_mar"),
    ref=[ans(kind="task", name="Pay Valeria's rent", when=W(U("month", 0)))]))

S("T07-087", "create add_to remove_from new debt count",
  T("add Rufino Ccori to the pisac market stall group, he's taking over from fortunata",
    diff(new("person", name="Rufino Ccori"), link("pisac_g", "new")),
    ref=[act("create", more=True, args=lines(kind="person", name="Rufino Ccori")),
         act("add_to", rows="$new", args=lines(to="$pisac_g"))]),
  T("hmm take him back out, nilda hasn't agreed yet", diff(unlink("pisac_g", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$pisac_g"))]),
  T("any of my starred people i have no debts with", rows("julio", "valeria"),
    ref=[ans(kind="person", where="debt count < 1 and starred = yes")]))

S("T07-088", "priority description list count ambiguous delete ask",
  T("open tasks at priority one", rows("rent_mar", "sunat", "vale_fees"),
    ref=[ans(kind="task", where='priority <= 1 and status = "open"')]),
  T("which of those have notes on them", rows("sunat"),
    ref=[ans(kind="task", within="@prev", where="description is set")]),
  T("and open tasks that aren't on any list", rows("hugo_email", "bulletin", "sunat", "insurance", "julio_gift", "agro_bank",
                                                  "agro_title"),
    ref=[ans(kind="task", where='list count <= 0 and status = "open"')]),
  T("delete the buy fungicide task", ask("fung_1", "fung_2"),
    ref=[act("delete", kind="task", name="Buy fungicide"),
         find(kind="task", name="Buy fungicide"),
         askc("the open one due tomorrow or the one you finished in february?", options="$fung_1, $fung_2")]))

S("T07-089", "debts small settle multi miss decline",
  T("small debts people owe me, under 30", rows("d_jaime", "d_carmen"),
    ref=[ans(kind="debt", where='direction = "owes_me" and status = "open" and amount < 30 PEN')]),
  T("clear them both, not worth chasing", diff(upd("d_jaime", status="settled"), upd("d_carmen", status="settled")),
    ref=[act("settle_debt", rows="$d_jaime, $d_carmen")]),
  T("when's the harvest party", decline("not_found"),
    ref=[ans(kind="event", name="harvest party"), search("harvest party", kind="event"), dec("not_found")]))

S("T07-090", "single photo count feb",
  T("how many photos between first feb and twenty-eighth feb", val(9),
    ref=[ans(op="count", kind="photo", when=W(span(D("2026-02-01"), D("2026-02-28"))))]))

S("T07-091", "photo spans linked already ask",
  T("pics from first march to this monday", rows("rainbow", "t_spray", "v_lab", "t_flowers"),
    ref=[ans(kind="photo", when=W(span(D("2026-03-01"), U("week", 0, weekday=1))))]),
  T("how many from january through last sunday", val(15),
    ref=[ans(op="count", kind="photo", when=W(span(U("month", 0, name=1), U("week", -1, weekday=7))))]),
  T("any with valeria from before first feb at 8am", rows("h_vale"),
    ref=[ans(kind="photo", linked_to="$valeria", when=W({"to": D("2026-02-01", "08:00")}))]),
  T("star it", diff(already=["h_vale"]),
    ref=[act("star", rows="$h_vale"), ans(rows="$h_vale")]),
  T("star the photo from the soil lab too", diff(upd("v_lab", starred=True)),
    ref=[act("star", kind="photo", name="soil lab")]))

S("T07-092", "debt spans order balance",
  T("debts from first march 9am through end of march", rows("d_wilber", "d_jaime", "d_carmen", "d_efrain", "d_sonia", "d_hugo"),
    ref=[ans(kind="debt", when=W(span(D("2026-03-01", "09:00"), U("month", 0, name=3))))]),
  T("and from last month to last sunday, ones owed to me", rows("d_rosa", "d_jaime", "d_carmen", "d_nilda", "d_teodoro"),
    ref=[ans(kind="debt", when=W(span(U("month", -1), U("week", -1, weekday=7))), where='direction = "owes_me"')]),
  T("biggest of those", rows("d_rosa"),
    ref=[ans(kind="debt", within="@prev", order="amount desc", limit=1)]),
  T("what's rosa mamani's balance", val((20, "PEN")),
    ref=[ans(op="balance", kind="person", name="Rosa Mamani")]))

S("T07-093", "note spans accent fold recipe body contains",
  T("notes from second march 9pm to eighth march 9pm", rows("seed_2026", "soil_notes", "loan_notes", "julio_gifts", "vale_courses"),
    ref=[ans(kind="note", when=W(span(D("2026-03-02", "21:00"), D("2026-03-08", "21:00"))))]),
  T("and fifth march 11am till today", rows("loan_notes", "julio_gifts", "vale_courses", "prices", "mar_agenda", "hugo_qs"),
    ref=[ans(kind="note", when=W(span(D("2026-03-05", "11:00"), U("day", 0))))]),
  T("anything before feb", rows("natives", "chuno", "ocopa", "huancaina", "trial_plan", "seating", "seed_2025"),
    ref=[ans(kind="note", when=W({"to": U("month", 0, name=1)}))]),
  T("the chuño soup one, add 'or alpaca instead of lamb'",
    diff(upd("chuno", body="soak the chuno overnight, lamb, mint, a little aji; or alpaca instead of lamb")),
    ref=[act("edit", rows="$chuno", args=lines(body="soak the chuno overnight, lamb, mint, a little aji; or alpaca instead of lamb"))]),
  T("which recipes use aji", rows("chuno", "ocopa", "huancaina"),
    ref=[ans(kind="note", linked_to="$recipes_nb", where='body contains "aji"')]))

S("T07-094", "document dates date linked span",
  T("docs from third march", rows("water_doc", "soil_pdf"),
    ref=[ans(kind="document", when=W(D("2026-03-03")))]),
  T("from last month on, only the agrobanco loan folder", rows("loan_app", "repay"),
    ref=[ans(kind="document", linked_to="$loan_f", when=W({"from": U("month", -1)}))]),
  T("and from monday last week to third march 10am", rows("enrol", "water_doc"),
    ref=[ans(kind="document", when=W(span(U("week", -1, weekday=1), D("2026-03-03", "10:00"))))]))

S("T07-095", "task time reschedule spans events cancel count",
  T("move pay the water bill to next monday 8am", diff(upd("water_bill", date="2026-03-16T08:00")),
    ref=[act("reschedule", kind="task", name="Pay the water bill", args=lines(to=U("week", 1, weekday=1, time="08:00")))]),
  T("how many tasks from next monday on", val(25),
    ref=[ans(op="count", kind="task", when=W({"from": U("week", 1, weekday=1)}))]),
  T("and from april to tenth april midday", rows("storehouse", "ferti"),
    ref=[ans(kind="task", when=W(span(U("month", 0, name=4), D("2026-04-10", "12:00"))))]),
  T("events from tomorrow through sunday", rows("seed_delivery", "land_tax", "asm_0314", "mass_0315", "vcall_0315"),
    ref=[ans(kind="event", when=W(span(U("day", 1), U("week", 0, weekday=7))))]),
  T("cancel the land tax thing, i paid online and tell me what's left tomorrow",
    rows("seed_delivery", also=diff(upd("land_tax", status="cancelled"))),
    ref=[act("cancel", kind="event", name="land tax", more=True),
         ans(kind="event", when=W(U("day", 1)), where='status != "cancelled"')]),
  T("how many rehearsals from 7pm on the eighteenth", val(7),
    ref=[ans(op="count", kind="event", name="Choir rehearsal", when=W({"from": D("2026-03-18", "19:00")}))]))

S("T07-096", "person spans anchor log focus",
  T("who've i been in touch with since eleventh march", rows("teodoro", "rosa_c", "lucia", "julio"),
    ref=[ans(kind="person", when=W({"from": D("2026-03-11")}))]),
  T("and from january to last friday, coop people only", rows("nilda", "fortunata", "wilber", "rosa_m"),
    ref=[ans(kind="person", linked_to="$coop_g", when=W(span(U("month", 0, name=1), U("week", -1, weekday=5))))]),
  T("who was i with last night at 9", rows("rosa_c"),
    ref=[ans(kind="person", when=W(U("day", -1, time="21:00", anchor="today")))]),
  T("set rosa's check-in to every ten days", diff(upd("rosa_c", cadence=10)),
    ref=[act("edit", kind="person", name="Rosa", args=lines(cadence=10))]))

S("T07-097", "locker trashed open restore knock-on list miss create add_to",
  T("open the movistar login", rows("movistar"),
    ref=[find(kind="locker item", name="Movistar"), opn("$movistar"), ans(rows="$movistar")]),
  T("restore it", diff(restore("movistar")),
    ref=[act("restore", rows="$movistar")]),
  T("rename it Movistar login and move the repayment schedule draft to coop papers",
    diff(upd("movistar", name="Movistar login"), unlink("loan_f", "repay"), link("coop_f", "repay")),
    ref=[act("edit", rows="$movistar", args=lines(name="Movistar login"), more=True),
         act("add_to", kind="document", name="Repayment schedule draft", args=lines(to="$coop_f"))]),
  T("is there a list called phone stuff", decline("not_found"),
    ref=[find(kind="list", name="phone"), dec("not_found")]),
  T("make one then, Phone and internet, home area", diff(new("list", name="Phone and internet", area="home")),
    ref=[act("create", args=lines(kind="list", name="Phone and internet", area="home"))]),
  T("put pay the electricity bill on it", diff(unlink("home_l", "elec_bill"), link("+1", "elec_bill")),
    ref=[act("add_to", kind="task", name="Pay the electricity bill", args=lines(to="$new"))]),
  T("what's on it now", rows("elec_bill"),
    ref=[ans(kind="task", linked_to="$c1")]))

S("T07-098", "valeria calls edit multi carla call",
  T("next two calls with valeria", rows("vcall_0315", "vcall_0322"),
    ref=[ans(kind="event", name="Call with Valeria", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("note on both: ask about the laptop", diff(upd("vcall_0315", description="ask about the laptop"),
                                              upd("vcall_0322", description="ask about the laptop")),
    ref=[act("edit", rows="$vcall_0315, $vcall_0322", args=lines(description="ask about the laptop"))]),
  T("the call with carla this week, when was it", rows("carla_call"),
    ref=[ans(kind="event", name="Call with Carla", when=W(U("week", 0)))]))

S("T07-099", "rosa find settle up group",
  T("the rosa from the choir, what's her role again", rows("rosa_c"),
    ref=[find(kind="person", name="Rosa"), ans(rows="$rosa_c")]),
  T("and settle up with the rosa in the coop group", diff(settle=[("Rosa Mamani", "100")]),
    ref=[act("settle_up", kind="person", name="Rosa", linked_to="$coop_g", args=lines(group="$coop_g"))]))

S("T07-100", "declines write read ask",
  T("send the agrobanco password to teodoro", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("ok forget it. mark print the coop banner done and tell me what's left for the expo",
    rows("expo_samples", also=diff(upd("expo_banner", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Print the coop banner", more=True),
         ans(kind="task", name="Expo", where='status = "open"')]),
  T("wipe all my notes, i'm starting fresh", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("will it rain in cusco tomorrow", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("move the blight scouting", ask(),
    ref=[askc("which scouting round, and to when?")]))
