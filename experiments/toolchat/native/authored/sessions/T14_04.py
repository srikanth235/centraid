from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T14-076", "seven turns baile night balance settle_up",
  T("what's the plan for baile 12", rows("baile_12"),
    ref=[ans(kind="event", name="Baile 12")]),
  T("who from the collective is on five or more things in my diary", rows("nath", "guga"),
    ref=[ans(kind="person", where='event count >= 5 and role contains "Baile Torto"')]),
  T("log a message with nathalia prado, sent her the setlist", diff(upd("nath", date=ANY)),
    ref=[act("log", rows="$nath", args=lines(kind="message"))]),
  T("who's in coletivo baile torto again", rows("rafa_m", "nath", "guga", "marcos_o", "ana_paula", "me"),
    ref=[ans(kind="person", linked_to="$baile")]),
  T("how much am i down in coletivo baile torto", val((-90, "BRL")),
    ref=[ans(op="balance", kind="group", name="Coletivo Baile Torto", linked_to="$me")]),
  T("settle up with rafael mendes in there, the speaker rental", diff(settle=[("Rafael Mendes", "160.00")]),
    ref=[act("settle_up", rows="$rafa_m", args=lines(group="$baile"))]),
  T("and what do i owe nath outside the group", rows("d_nath"),
    ref=[ans(kind="debt", linked_to="$nath")]))

S("T14-077", "ambiguous marcos ask log debt settle",
  T("log a visit with marcos", ask("marcos_t", "marcos_o"),
    ref=[act("log", kind="person", name="Marcos", args=lines(kind="visit")),
         askc("marcos tavares the mechanic or marcos oliveira from the collective?", options="$marcos_t, $marcos_o")]),
  T("the mechanic", diff(upd("marcos_t", date=ANY)),
    ref=[act("log", rows="$marcos_t", args=lines(kind="visit"))]),
  T("when's the oil change at marcos", rows("oil"),
    ref=[ans(kind="event", name="Oil change at Marcos")]),
  T("do i owe him for the brake pads", rows("d_marcos_t"),
    ref=[ans(kind="debt", linked_to="$marcos_t")]),
  T("settle it, paid him cash", diff(upd("d_marcos_t", status="settled")),
    ref=[act("settle_debt", rows="@prev")]),
  T("what else do i owe", rows("d_junior", "d_nath", "d_patricia", "d_wesley"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T14-078", "trashed people restore where prev window decline",
  T("who's in the contacts trash", rows("felipe", "renata", "caio"),
    ref=[find(kind="person", trashed=True), ans(rows="@prev")]),
  T("restore the old dj partner", diff(restore("felipe")),
    ref=[act("restore", kind="person", where='role contains "DJ partner"', trashed=True)]),
  T("the event planner one", diff(restore("renata")),
    ref=[find(kind="person", trashed=True, where='role contains "planner"'),
         act("restore", rows="@prev")]),
  T("and caio?", ask(),
    ref=[find(kind="person", name="Caio", trashed=True),
         bad(act("restore", rows="$caio")),
         askc("caio's past the 30-day restore window, he can't come back. add him as a new contact?")]),
  T("no leave him", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T14-079", "single create person log new",
  T("add Dona Rosa, sells pão de queijo at the barra funda hub, and log a visit, saw her",
    diff(new("person", name="Dona Rosa", role=ANY, date=ANY)),
    ref=[act("create", more=True, args=lines(kind="person", name="Dona Rosa", role="pão de queijo, Barra Funda hub")),
         act("log", rows="$new", args=lines(kind="visit"))]))

S("T14-080", "carro list remove_from where ambiguous ipva recovery",
  T("what's on the carro list", rows("ipva_26", "ipva_25", "cnh", "dashcam", "rating", "phone_mount", "seat_covers", "fuel_log"),
    ref=[ans(kind="task", linked_to="$carro_l")]),
  T("take the cancelled one off it", diff(unlink("carro_l", "phone_mount")),
    ref=[act("remove_from", kind="task", linked_to="$carro_l", where='status = "cancelled"', args=lines(from_="$carro_l"))]),
  T("move pay ipva to the thirteenth", diff(upd("ipva_26", date="2026-11-13")),
    ref=[act("reschedule", kind="task", name="Pay IPVA", args=lines(to=D("2026-11-13"))),
         act("reschedule", rows="$ipva_26", args=lines(to=D("2026-11-13")))]),
  T("how's the fuel sheet going", rows("fuel_log"),
    ref=[find(kind="task", name="fuel sheet"),
         search("fuel sheet", kind="task"),
         ans(rows="$fuel_log")]))

S("T14-081", "compras remove_from where task count",
  T("anything on the compras list that's already done", rows("coffee"),
    ref=[ans(kind="task", linked_to="$compras_l", where='status = "completed"')]),
  T("take it off the list", diff(unlink("compras_l", "coffee")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$compras_l"))]),
  T("which lists have fewer than four tasks", rows("compras_l"),
    ref=[ans(kind="list", where="task count < 4")]))

S("T14-082", "locker trash restore window delete named count",
  T("what's in the locker trash", rows("old_ifood", "old_wifi"),
    ref=[find(kind="locker item", trashed=True), ans(rows="@prev")]),
  T("restore the ifood courier login", ask(),
    ref=[bad(act("restore", rows="$old_ifood")),
         askc("the ifood login is past the 30-day restore window, it can't come back. make a new entry?")]),
  T("no. delete rider pdf instead, the rider lives in documents", diff(trash("rider_l")),
    ref=[act("delete", kind="locker item", name="Rider PDF")]),
  T("how many locker items have i got", val(17),
    ref=[ans(op="count", kind="locker item")]))

S("T14-083", "locker create star unstar new",
  T("save my Mixcloud login, username djtomasf, url https://mixcloud.com",
    diff(new("locker item", name="Mixcloud", username="djtomasf", url="https://mixcloud.com")),
    ref=[act("create", args=lines(kind="locker item", name="Mixcloud", type="login", username="djtomasf",
                                  url="https://mixcloud.com"))]),
  T("star it", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("hmm no unstar it, only the uber one stays starred", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]))

S("T14-084", "notebook where edit prev folder create delete new",
  T("which notebook has exactly two notes", rows("uber_nb"),
    ref=[find(kind="notebook", where="note count = 2"), ans(rows="@prev")]),
  T("rename it to Uber notes", diff(upd("uber_nb", name="Uber notes")),
    ref=[act("edit", rows="@prev", args=lines(name="Uber notes"))]),
  T("and make a folder Uber receipts", diff(new("folder", name="Uber receipts")),
    ref=[act("create", args=lines(kind="folder", name="Uber receipts"))]),
  T("nah delete that folder, car pool receipts is enough", diff(gone("+1")),
    ref=[act("delete", rows="$c1")]))

S("T14-085", "single event duration set date",
  T("everything on the twenty-ninth with how long each one runs", rows("physio_1029", "accountant", "fut_1029"),
    ref=[ans(kind="event", when=W(D("2026-10-29")), where="duration is set")]))

S("T14-086", "weekend status set duration set reschedule ambiguous ask",
  T("what's on this weekend, confirmed or tentative", rows("baile_12", "regina_lunch"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))), where="status is set")]),
  T("how long is lunch with larissa's parents", rows("regina_lunch"),
    ref=[ans(kind="event", name="Lunch with Larissa's parents")]),
  T("and next weekend, anything with a set duration", rows("landlord", "lunch_mae"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=6), U("week", 1, weekday=7))), where="duration is set")]),
  T("push the dj set at bar do kleber to 11pm", ask("kleber_1030", "kleber_1113"),
    ref=[find(kind="event", name="DJ set at Bar do Kleber", when=W({"from": U("day", 0)})),
         act("reschedule", kind="event", name="DJ set at Bar do Kleber", args=lines(to=U("day", 0, anchor="row", time="23:00"))),
         askc("next friday's or the one on nov 13?", options="$kleber_1030, $kleber_1113")]))

S("T14-087", "cadence literal within to month log empty edit",
  T("who am i supposed to see every thirty days", rows("thiago", "marcos_t", "jorge", "regina", "fernanda", "priscila"),
    ref=[ans(kind="person", where="cadence = 30")]),
  T("which of them haven't i talked to since before october", rows("regina", "fernanda"),
    ref=[ans(within="@prev", when=W({"to": U("month", 0, name=9)}))]),
  T("rang fernanda dias about the mei, log a call", diff(upd("fernanda", date=ANY)),
    ref=[act("log", rows="$fernanda", args=lines(kind="call"))]),
  T("who has no cadence at all", rows("otavio", "neide", "bianca", "helena", "jhonatan", "juliana", "me"),
    ref=[ans(kind="person", where="cadence is empty")]),
  T("set jhonatan silva to every thirty days", diff(upd("jhonatan", cadence=30)),
    ref=[act("edit", rows="$jhonatan", args=lines(cadence=30))]))

S("T14-088", "photo count album count album photo count delete",
  T("who's in one photo", rows("regina", "lurdes", "diego", "marcos_o", "priscila", "ana_paula", "kleber", "rafa_s",
                                   "patricia"),
    ref=[find(kind="person", where="photo count = 1"), ans(rows="@prev")]),
  T("starred pics that are in fewer than 2 albums", rows("lari_beach", "mae_garden", "flyer_12", "sunset_marg"),
    ref=[ans(kind="photo", where="album count < 2 and starred = yes")]),
  T("any album with exactly three photos", rows("car_album"),
    ref=[ans(kind="album", where="photo count = 3")]),
  T("delete the bumper scratch pic from it, the claim's closed", diff(trash("car_scratch"), unlink("car_album", "car_scratch")),
    ref=[act("delete", kind="photo", name="Bumper scratch")]))

S("T14-089", "six turns task cells ambiguous invoice",
  T("what's due from monday through the end of next week that isn't done",
    rows("phone_mount", "mae_meds", "diego_call", "headphones", "mae_plan", "mei_decl", "football_fee", "dashcam",
         "mae_exam", "leak", "mae_split"),
    ref=[ans(kind="task", when=W(span(U("week", 1, weekday=1), U("week", 1))), where='status != "completed"')]),
  T("which of those take over 60 minutes", rows("dashcam", "leak"),
    ref=[ans(within="@prev", where="effort > 60 minutes")]),
  T("which task has 'gig thirtieth Oct' as the description", rows("inv_kleber_nov"),
    ref=[ans(kind="task", where='description = "gig 30 Oct"')]),
  T("move send invoice to kleber to next friday", diff(upd("inv_kleber_nov", date="2026-10-30")),
    ref=[act("reschedule", kind="task", name="Send invoice to Kleber", args=lines(to=U("week", 1, weekday=5))),
         act("reschedule", rows="$inv_kleber_nov", args=lines(to=U("week", 1, weekday=5)))]),
  T("tasks with nobody attached, due from nov first on",
    rows("ipva_26", "cnh", "cnh_exam", "cnh_photo", "mix", "mix_cover", "mix_upload", "rent_nov", "shelf", "das", "passport",
         "plan_11"),
    ref=[ans(kind="task", where="person count = 0", when=W({"from": D("2026-11-01")}))]),
  T("and anything open that's overdue", rows("rating", "gas"),
    ref=[ans(kind="task", where='status = "open"', when=W({"to": U("day", -1)}))]))

S("T14-090", "notes week to sunday person count body empty",
  T("notes from last week through this sunday",
    rows("gift_ideas", "airport_tips", "vo_party", "idea_edit", "car_km", "pharm_2", "set12", "mae_bp", "helena_qs"),
    ref=[ans(kind="note", when=W(span(U("week", -1), U("week", 0, weekday=7))))]),
  T("which of them have somebody linked", rows("gift_ideas", "vo_party", "set12", "mae_bp", "helena_qs"),
    ref=[ans(within="@prev", where="person count != 0")]),
  T("any blank ones in there", rows(),
    ref=[ans(kind="note", within="@1", where="body is empty")]))

S("T14-091", "notes month span count edit named recovery",
  T("notes from last month to this month",
    rows("hotspots", "mae_meds_n", "set11", "ins_claim", "set_kleber", "lease_note", "idea_collab", "pharm_1", "set_cv",
         "idea_sample", "gift_ideas", "airport_tips", "vo_party", "idea_edit", "car_km", "pharm_2", "set12", "mae_bp",
         "helena_qs"),
    ref=[ans(kind="note", when=W(span(U("month", -1), U("month", 0))))]),
  T("how many is that", val(19),
    ref=[ans(op="count", within="@prev")]),
  T("is the odometer notes one in car pool", rows("car_km"),
    ref=[ans(kind="note", name="Odometer notes"),
         search("odometer", kind="note"),
         ans(rows="$car_km")]),
  T("update it: handover twenty-sixth Oct: 85,020 km", diff(upd("car_km", body=has("85,020"))),
    ref=[act("edit", rows="$car_km", args=lines(body="handover 19 Oct: 84,210 km. handover 26 Oct: 85,020 km"))]),
  T("add to rodízio rules: fuel receipts go in the glovebox",
    diff(upd("rodizio", body=has("glovebox"))),
    ref=[opn("$rodizio"),
         act("edit", kind="note", name="Rodízio rules",
             args=lines(body="tank full at handover, Juninho nights, Rafa Sundays. fuel receipts go in the glovebox"))]))

S("T14-092", "documents month spans anchor already",
  T("any docs from august", rows("blood_doc", "das_aug"),
    ref=[find(kind="document", when=W(U("month", 0, name=8))), ans(rows="@prev")]),
  T("and from august up to the tenth of october",
    rows("blood_doc", "das_aug", "ins_policy", "rx", "das_sep", "echo_doc", "contract_cv", "tyre_rcpt", "contract_bsas"),
    ref=[ans(kind="document", when=W(span(U("month", 0, name=8), D("2026-10-10"))))]),
  T("docs added this week", rows("fuel_rcpt"),
    ref=[ans(kind="document", when=W(U("week", 0, anchor="today")))]),
  T("put fuel receipts week 42 in car pool receipts", diff(already=["fuel_rcpt"]),
    ref=[act("add_to", rows="$fuel_rcpt", args=lines(to="$car_pool_f")),
         ans(rows="$fuel_rcpt")]))

S("T14-093", "documents july to last week recovery star",
  T("documents from july to last week",
    rows("contract_kleber", "blood_doc", "das_aug", "ins_policy", "rx", "das_sep", "echo_doc", "contract_cv", "tyre_rcpt",
         "contract_bsas", "rider"),
    ref=[ans(kind="document", when=W(span(U("month", 0, name=7), U("week", -1))))]),
  T("which are starred", rows("echo_doc"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("star the kleber contract too and list the starred ones", rows("crlv", "echo_doc", "mei_cert", "lease", "contract_kleber",
                                                                   also=diff(upd("contract_kleber", starred=True))),
    ref=[act("star", kind="document", name="Kleber contract"),
         search("kleber contract", kind="document"),
         act("star", rows="$contract_kleber", more=True),
         ans(kind="document", where="starred = yes")]))

S("T14-094", "photo spans trashed restore undo",
  T("pics from the casa vermelha night, 11pm on the tenth to 3am", rows("cv_selfie", "cv_lights"),
    ref=[ans(kind="photo", when=W(span(D("2026-10-10", "23:00"), D("2026-10-11", "03:00"))))]),
  T("and from 6am on the nineteenth to the end of october",
    rows("car_odo", "movie_night", "vinyl_haul", "rain_car", "football", "haircut_p"),
    ref=[ans(kind="photo", when=W(span(D("2026-10-19", "06:00"), U("month", 0, name=10))))]),
  T("anything before september sitting in the trash", rows("felipe_p", "old_car"),
    ref=[ans(kind="photo", trashed=True, when=W({"to": U("month", 0, name=8)}))]),
  T("restore felipe and me at the old studio", diff(restore("felipe_p")),
    ref=[act("restore", rows="$felipe_p")]),
  T("undo that", diff(trash("felipe_p")),
    ref=[act("undo")]))

S("T14-095", "debt weekday from month span sum",
  T("debts from friday", rows("d_guga", "d_wesley"),
    ref=[ans(kind="debt", when=W(U("week", 0, weekday=5)))]),
  T("debts from last month onward",
    rows("d_patricia", "d_diego", "d_thiago", "d_kleber_old", "d_junior", "d_bianca", "d_rafa_s", "d_kleber", "d_nath",
         "d_guga", "d_wesley", "d_larissa"),
    ref=[find(kind="debt", when=W({"from": U("month", -1)})), ans(rows="@prev")]),
  T("from monday to the end of october, what do i owe", rows("d_junior", "d_nath", "d_wesley"),
    ref=[ans(kind="debt", when=W(span(U("week", -2, weekday=1), U("month", 0, name=10))), where='direction = "i_owe"')]),
  T("total of those", val((495, "BRL")),
    ref=[ans(op="sum", field="amount", within="@prev")]))

S("T14-096", "six turns ambiguous folder refused delete move",
  T("delete the car folder", ask("car_docs_f", "car_pool_f"),
    ref=[act("delete", kind="folder", name="car"),
         askc("car documents or car pool receipts?", options="$car_docs_f, $car_pool_f")]),
  T("the pool receipts one", ask(),
    ref=[bad(act("delete", rows="$car_pool_f")),
         askc("it still has the fuel receipts and the tyre invoice in it. move them to car documents first?")]),
  T("yeah move them there, delete it, and show me what's in car documents after",
    rows("crlv", "cnh_doc", "ins_policy", "fuel_rcpt", "tyre_rcpt",
         also=diff(unlink("car_pool_f", "fuel_rcpt"), unlink("car_pool_f", "tyre_rcpt"), link("car_docs_f", "fuel_rcpt"),
                   link("car_docs_f", "tyre_rcpt"), gone("car_pool_f"))),
    ref=[find(kind="document", linked_to="$car_pool_f"),
         act("add_to", rows="@prev", args=lines(to="$car_docs_f"), more=True),
         act("delete", rows="$car_pool_f", more=True),
         ans(kind="document", linked_to="$car_docs_f")]),
  T("scans to sort is empty right? delete it too", diff(gone("empty_f")),
    ref=[act("delete", rows="$empty_f")]),
  T("how many folders left", val(5),
    ref=[ans(op="count", kind="folder")]))

S("T14-097", "single decline sealed egress",
  T("send my nubank card details to larissa on whatsapp", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T14-098", "single decline out of scope",
  T("is it gonna rain in barra funda tonight", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T14-099", "recoveries misspelling nickname log",
  T("when's the studio aurora gig", rows("aurora"),
    ref=[ans(kind="event", name="Studio Aurora"),
         search("aurora", kind="event"),
         ans(rows="$aurora")]),
  T("so it got cancelled?", rows("aurora"),
    ref=[ans(rows="$aurora")]),
  T("what's priscilla's role again", rows("priscila"),
    ref=[ans(kind="person", name="Priscilla"),
         search("priscilla", kind="person"),
         ans(rows="$priscila")]),
  T("log a visit with her, bumped into her at the galpão", diff(upd("priscila", date=ANY)),
    ref=[act("log", rows="$priscila", args=lines(kind="visit"))]),
  T("and with dona neide, she brought cake", diff(upd("neide", date=ANY)),
    ref=[act("log", kind="person", name="Dona Neide", args=lines(kind="visit")),
         search("dona neide", kind="person"),
         act("log", rows="$neide", args=lines(kind="visit"))]))

S("T14-100", "seven turns mae medical group balance complete log ambiguous",
  T("who's in mãe's medical bills", rows("patricia", "diego", "me"),
    ref=[ans(kind="person", linked_to="$mae_g")]),
  T("how's my balance in there", val((-10, "BRL")),
    ref=[ans(op="balance", kind="group", name="Mãe's medical bills", linked_to="$me")]),
  T("and diego's", val((-130, "BRL")),
    ref=[ans(op="balance", kind="group", name="Mãe's medical bills", linked_to="$diego")]),
  T("is call diego about mom's appointment open", rows("diego_call"),
    ref=[ans(kind="task", name="Call Diego about Mom's appointment")]),
  T("done, called him now. tick it and log the call",
    diff(upd("diego_call", status="completed", completed=ANY), upd("diego", date=ANY)),
    ref=[act("complete", rows="$diego_call", more=True),
         act("log", rows="$diego", args=lines(kind="call"))]),
  T("what tasks are still open in the mãe list", rows("mae_meds", "mae_exam", "mae_plan", "mae_split", "mae_rail", "plan_11"),
    ref=[ans(kind="task", linked_to="$mae_l", where='status = "open"')]),
  T("move mom's cardiology appointment to 9am", diff(upd("cardio_nov", date="2026-11-03T09:00")),
    ref=[act("reschedule", kind="event", name="Mom's cardiology appointment", args=lines(to=U("day", 0, anchor="row", time="09:00"))),
         act("reschedule", rows="$cardio_nov", args=lines(to=U("day", 0, anchor="row", time="09:00")))]))


# --- follow-up turns appended to earlier sessions ---------------------------------------------

X("T14-006",
  T("and the one with bianka?", rows("d_bianca"),
    ref=[ans(kind="person", name="Bianka"),
         search("bianka", kind="person"),
         ans(kind="debt", linked_to="$bianca")]))

X("T14-008",
  T("who've i talked to from last week up to the twentieth", rows("otavio", "ana_paula", "kleber", "neide", "rafa_s", "patricia"),
    ref=[ans(kind="person", when=W(span(U("week", -1), D("2026-10-20"))))]))

X("T14-014",
  T("and move collective rehearsal to 9pm", ask(),
    ref=[act("reschedule", kind="event", name="Collective rehearsal", args=lines(to=U("day", 0, anchor="row", time="21:00"))),
         askc("which week's rehearsal? there's one every wednesday")]))

X("T14-016",
  T("tick off fix headphone cable and show me what's open on the dj list",
    rows("usb", "setlist12", "inv_kleber_nov", "flyer_art", "bsas_setlist",
         also=diff(upd("headphones", status="completed", completed=ANY))),
    ref=[act("complete", rows="$headphones", more=True),
         ans(kind="task", linked_to="$dj_l", where='status = "open"')]))

X("T14-022",
  T("and star rafael", ask("rafa_s", "rafa_m"),
    ref=[act("star", kind="person", name="Rafael"),
         askc("rafael souza from the car pool or rafael mendes?", options="$rafa_s, $rafa_m")]))

X("T14-023",
  T("add sunset on the marginal too and show me what's in gigs 2026",
    rows("b11_crowd", "p_kleber_1002", "cv_selfie", "cv_lights", "p_kleber_1016", "vinyl_haul", "sunset_marg",
         also=diff(link("gigs_album", "sunset_marg"))),
    ref=[act("add_to", rows="$sunset_marg", args=lines(to="$gigs_album"), more=True),
         ans(kind="photo", linked_to="$gigs_album")]))

X("T14-024",
  T("settle the football shirt one too and tell me what's owed to me",
    rows("d_rafa_s", "d_diego", "d_kleber", "d_bianca", also=diff(upd("d_thiago", status="settled"))),
    ref=[act("settle_debt", kind="debt", name="Football shirt", more=True),
         ans(kind="debt", where='direction = "owes_me" and status = "open"')]))

X("T14-030",
  T("anything in the locker with notes, other than the smart fit one",
    rows("rekordbox", "gate", "ssh", "spotify_api", "passport_l", "itau", "cnh_l", "btc", "rider_l"),
    ref=[ans(kind="locker item", where='notes is set', exclude="$smart_fit")]))

X("T14-031",
  T("make a folder Receipts 2026 instead", diff(new("folder", name="Receipts 2026")),
    ref=[act("create", args=lines(kind="folder", name="Receipts 2026"))]),
  T("show me all my folders", rows("car_docs_f", "car_pool_f", "mae_f", "mei_f", "contracts_f", "ape_f", "empty_f", "+2"),
    ref=[ans(kind="folder")]))

X("T14-036",
  T("what have i got with him from next monday till nov third", rows("reh_1028"),
    ref=[ans(kind="event", linked_to="$guga", when=W(span(U("week", 1, weekday=1), D("2026-11-03"))))]))

X("T14-037",
  T("delete the car pool handover", ask(),
    ref=[act("delete", kind="event", name="Car pool handover"),
         askc("which week's handover? there's one every monday")]))

X("T14-040",
  T("who did i see between friday 11am and today", rows("wesley", "guga", "junior", "larissa"),
    ref=[ans(kind="person", when=W(span(U("week", 0, weekday=5, time="11:00"), U("day", 0))))]))

X("T14-044",
  T("when's the pay das bill due", rows("das"),
    ref=[ans(kind="task", name="Pay DAS bill"),
         search("pay das", kind="task"),
         ans(rows="$das")]))

X("T14-047",
  T("where do i stand with juninho", val((-640, "BRL")),
    ref=[ans(kind="person", name="Juninho"),
         search("juninho", kind="person"),
         ans(op="balance", rows="$junior")]))

X("T14-049",
  T("which list has both pay das mei and renew passport", rows("admin_l"),
    ref=[ans(kind="list", linked_to="$das, $passport")]))

X("T14-059",
  T("move mom's physiotherapy to 10", ask("physio_1029", "physio_1105"),
    ref=[find(kind="event", name="Mom's physiotherapy", when=W({"from": U("day", 0)})),
         act("reschedule", kind="event", name="Mom's physiotherapy", args=lines(to=U("day", 0, anchor="row", time="10:00"))),
         askc("this thursday's session or the one on nov 5?", options="$physio_1029, $physio_1105")]))

X("T14-062",
  T("unstar the echocardiogram report and list what's starred", rows("crlv", "mei_cert", "lease",
                                                                        also=diff(upd("echo_doc", starred=False))),
    ref=[act("unstar", rows="$echo_doc", more=True),
         ans(kind="document", where="starred = yes")]))

X("T14-070",
  T("both of kleber's debts, settled or not", rows("d_kleber", "d_kleber_old"),
    ref=[ans(kind="debt", linked_to="$kleber", where='status in ("open", "settled")')]))

X("T14-073",
  T("and from next monday to the end of december, what's on with nath",
    rows("reh_1028", "reh_1104", "reh_1111", "reh_1118", "reh_1125", "baile_13"),
    ref=[ans(kind="event", linked_to="$nath", when=W(span(U("week", 1, weekday=1), U("month", 0, name=12))))]))

X("T14-081",
  T("and which lists aren't home", rows("carro_l", "dj_l", "mae_l", "admin_l", "compras_l"),
    ref=[ans(kind="list", where='area != "home"')]))

X("T14-083",
  T("which locker items have a username on them", rows("gmail", "gov", "soundcloud", "uber_login", "+1"),
    ref=[ans(kind="locker item", where="username is set")]))

X("T14-095",
  T("any debts where the amount's missing", rows(),
    ref=[ans(kind="debt", where="amount is empty")]))

X("T14-011",
  T("and me vs him overall, debts and all", val((-400, "BRL")),
    ref=[comp(op="balance", rows="$junior"), ans(value="@prev")]))

X("T14-095",
  T("biggest open one each way", vgroups({"owes_me": (600, "BRL"), "i_owe": (400, "BRL")}),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"', group="direction"), ans(value="@prev")]))
