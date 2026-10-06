from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T02-051", "compute group answer value follow-ups",
  T("breakdown of my client work tasks by status",
    vgroups({"open": 6, "in_progress": 2, "completed": 3}),
    ref=[comp(op="count", group="status", kind="task", linked_to="$clientwork"), ans(value="@prev")]),
  T("which ones are in progress", rows("gl_sketches", "mf_spots"),
    ref=[ans(kind="task", linked_to="$clientwork", where='status = "in_progress"')]),
  T("total effort on those two", val(840),
    ref=[ans(op="sum", field="effort", within="@prev")]),
  T("which one has four spots, autumn issue as the description", rows("mf_spots"),
    ref=[ans(kind="task", where='description = "four spots, autumn issue"')]))

S("T02-052", "min max debts",
  T("smallest amount anyone owes me?", val((30, "CAD")),
    ref=[ans(op="min", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("which debt of mine is highest", rows("d_arun_tix"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"', order="amount desc", limit=1)]),
  T("who's that to", rows("arun"),
    ref=[find(kind="debt", where='direction = "i_owe" and status = "open"', order="amount desc", limit=1),
         ans(kind="person", linked_to="@prev")]),
  T("which ones exactly 30", rows("d_sophie_taxi"),
    ref=[ans(kind="debt", where="amount = 30")]),
  T("how many did i end up owing from april first to the end of may", val(4),
    ref=[ans(op="count", kind="debt", where='direction = "i_owe"',
             when=W({"from": D("2027-04-01", "00:00"), "to": U("month", 0, name=5)}))]))

S("T02-053", "find linked_to order limit reschedule keep time",
  T("move my next climbing sesh with diego to wed the sixteenth", diff(upd("climb_0614", date="2027-06-16T19:00")),
    ref=[find(kind="event", linked_to="$diego", when=W({"from": U("day", 0)}), order="date asc", limit=1),
         act("reschedule", rows="$climb_0614", args=lines(to=D("2027-06-16")))]),
  T("how's my week looking",
    rows("call_marcus", "mf_kickoff", "pottery_0610", "portfolio_review", "farmers", "gallery", "dimsum_jun"),
    ref=[ans(kind="event", when=W({"from": U("day", 0), "to": U("week", 0, weekday=7)}))]),
  T("push the tokyo flight back a day", ask("flight_out", "flight_back"),
    ref=[act("reschedule", kind="event", name="Flight", args=lines(to=U("day", 1, anchor="row"))),
         askc("the flight out on the 14th or the one home on the 28th?", options="$flight_out, $flight_back")]))

S("T02-054", "weekend find within exclude bulk cancel",
  T("got anything on the weekend", rows("farmers", "gallery", "dimsum_jun"),
    ref=[ans(kind="event", when=W({"from": U("week", 0, weekday=6), "to": U("week", 0, weekday=7)}))]),
  T("cancel all of it except dim sum, i'm wiped", diff(upd("farmers", status="cancelled"), upd("gallery", status="cancelled")),
    ref=[find(within="@prev", exclude="$dimsum_jun"), act("cancel", rows="@prev")]),
  T("what did i delete from the calendar this month", rows("coffee_siobhan", "open_house"),
    ref=[ans(kind="event", trashed=True, when=W(U("month", 0)))]),
  T("restore coffee with siobhan and the clay studio open house", diff(restore("coffee_siobhan"), restore("open_house")),
    ref=[act("restore", rows="$coffee_siobhan, $open_house")]))

S("T02-055", "find trashed restore multi album count anchor",
  T("undelete the blurry pic and the invoice screenshot", diff(restore("blurry"), restore("inv_shot")),
    ref=[find(kind="photo", trashed=True), act("restore", rows="$blurry, $inv_shot")]),
  T("photos with no album, which?",
    rows("desk", "jess_cat", "tomo_mock", "sunset_flat", "blurry", "shelves", "inv_shot"),
    ref=[ans(kind="photo", where="album count = 0")]),
  T("any pics from two days ago", rows("dad_garden"),
    ref=[ans(kind="photo", when=W(U("day", -2, anchor="today")))]))

S("T02-056", "act linked_to act when",
  T("tick off the task for auntie ivy, card's in the mail. what else is left this week",
    rows("soap_1", "tomo_logo", "tap", "gl_colour", "clay_tools", "rachel_followup", "gl_send", also=diff(upd("thankyou", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", linked_to="$ivy", more=True),
         ans(kind="task", when=W(U("week", 0)), where='status = "open"')]),
  T("and cancel pottery on the twenty-fourth, i'm at a wedding", diff(upd("pottery_0624", status="cancelled")),
    ref=[act("cancel", kind="event", name="Pottery class", when=W(D("2027-06-24")))]),
  T("which notes are older than march", rows("palette_hg", "gesture", "rates"),
    ref=[ans(kind="note", when=W({"to": D("2027-02-28")}))]))

S("T02-057", "act within act where",
  T("what's on my tokyo prep list", rows("teamlab", "jr_pass", "insurance", "yen", "pocket_wifi", "passport_renew", "sekaido"),
    ref=[ans(kind="task", linked_to="$tokyoprep")]),
  T("got the jr pass sorted", diff(upd("jr_pass", status="completed", completed=ANY)),
    ref=[act("complete", within="@prev", name="JR pass")]),
  T("also mark buy dish soap done", diff(upd("soap_1", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Buy dish soap")]),
  T("the high priority one on tokyo prep with no time on it, call it 45 min", diff(upd("insurance", effort=45)),
    ref=[act("edit", kind="task", linked_to="$tokyoprep", where="effort is empty and priority is set",
             args=lines(effort=45))]))

S("T02-059", "repair balance two people ask pick",
  T("how much does sophie owe me", ask("sophie_t", "sophie_d"),
    ref=[bad(ans(op="balance", kind="person", name="Sophie")),
         askc("sophie tran or sophie delacroix?", options="$sophie_t, $sophie_d")]),
  T("tran", val((30, "CAD"), (49500, "JPY")),
    ref=[ans(op="balance", rows="$sophie_t")]),
  T("she owes me another 25 for the gallery drinks",
    diff(new("debt", name=has("drinks"), amount=25, direction="owes_me"), link("new", "sophie_t")),
    ref=[act("create", args=lines(kind="debt", name="Gallery drinks", person="$sophie_t", amount="25", direction="owes_me"))]),
  T("who did i talk to from the monday before last through may", rows("priya", "kai"),
    ref=[ans(kind="person", when=W({"from": U("week", -2, weekday=1), "to": U("month", 0, name=5)}))]))

S("T02-060", "ask photo pick star",
  T("can you star the sunset photo", diff(upd("sunset_flat", starred=True)),
    ref=[act("star", kind="photo", name="sunset")]),
  T("what's the pic from yesterday at 3:20", rows("shelves"),
    ref=[ans(kind="photo", when=W(U("day", -1, time="15:20")))]))

S("T02-061", "write then read subtasks",
  T("colour studies are done, what's left under the greenleaf sketches",
    rows("gl_send", also=diff(upd("gl_colour", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Colour studies", more=True),
         ans(kind="task", linked_to="$gl_sketches", where='status = "open"')]))

S("T02-062", "cancel then read attendees",
  T("cancel squamish climbing day on the nineteenth, rain all weekend. who do i need to tell",
    rows("diego", "nadia", "arun", also=diff(upd("squamish_jun", status="cancelled"))),
    ref=[act("cancel", kind="event", name="Squamish climbing day", when=W(D("2027-06-19")), more=True),
         ans(kind="person", linked_to="$squamish_jun")]))

S("T02-063", "where contains empty result",
  T("which notes mention ramen", rows("tokyo_food"),
    ref=[ans(kind="note", where='body contains "ramen"')]),
  T("matcha?", rows(),
    ref=[ans(kind="note", where='body contains "matcha"')]),
  T("restore the note that mentions olympic village and put it in sketchbook notes",
    diff(restore("crawl"), link("sketchbook", "crawl")),
    ref=[act("restore", kind="note", trashed=True, where='body contains "Olympic Village"', more=True),
         act("add_to", rows="$crawl", args=lines(to="$sketchbook"))]),
  T("add matcha at ippodo to the tokyo food list", diff(upd("tokyo_food", body="Fuunji tsukemen, Afuri yuzu ramen, depachika at Isetan, tamagoyaki at Tsukiji, matcha at Ippodo")),
    ref=[opn("$tokyo_food"),
         act("edit", rows="$tokyo_food",
             args=lines(body="Fuunji tsukemen, Afuri yuzu ramen, depachika at Isetan, tamagoyaki at Tsukiji, matcha at Ippodo"))]),
  T("what notes have i made since june", rows("packing", "mf_brief", "journal_jun1", "fox", "idea_fox", "idea_crow"),
    ref=[ans(kind="note", when=W({"from": U("month", 0, name=6)}))]))

S("T02-064", "where is set narrowing starred",
  T("who has a nickname saved", rows("arun", "mom", "dad", "ivy", "tom", "diego"),
    ref=[ans(kind="person", where="nickname is set")]),
  T("which of them are starred", rows("arun", "mom"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("who has one besides mama and baba", rows("arun", "ivy", "tom", "diego"),
    ref=[ans(kind="person", where='nickname is set and nickname != "Mama" and nickname != "Baba"')]),
  T("which of my starred people are in 2 pics or fewer", rows("marcus"),
    ref=[ans(kind="person", where="starred = yes and photo count <= 2")]))

S("T02-065", "where count people photos",
  T("people who turn up in 3+ photos of mine", rows("arun", "mina", "diego", "kai", "mom", "dad"),
    ref=[ans(kind="person", where="photo count >= 3")]),
  T("and which albums have more than 5 pics", rows("hg_album", "pottery_album"),
    ref=[ans(kind="album", where="photo count > 5")]),
  T("star the pic of diego", ask("squamish_crag", "diego_v5", "hive_comp"),
    ref=[act("star", kind="photo", linked_to="$diego"),
         askc("which one, squamish crag, diego on the v5 or the hive comp?", options="$squamish_crag, $diego_v5, $hive_comp")]),
  T("how many people are in one photo or fewer", val(21),
    ref=[ans(op="count", kind="person", where="photo count <= 1")]),
  T("how many pics from may up to last week", val(13),
    ref=[ans(op="count", kind="photo", when=W({"from": U("month", 0, name=5), "to": U("week", -1)}))]))

S("T02-066", "where count containers delete prev folder refused",
  T("any empty folders", rows("old_scans"),
    ref=[ans(kind="folder", where="document count = 0")]),
  T("delete it", diff(gone("old_scans")),
    ref=[act("delete", rows="@prev")]),
  T("and the flat folder, i don't need it", ask(),
    ref=[bad(act("delete", rows="$flat_docs")),
         askc("flat still has the lease and the tenant insurance policy in it. move those out first?")]),
  T("nah leave it. any empty notebooks?", rows("old_nb"),
    ref=[ans(kind="notebook", where="note count = 0")]),
  T("delete that one", diff(gone("old_nb")),
    ref=[act("delete", rows="@prev")]))

S("T02-067", "compute name group trashed",
  T("how many pottery classes are on vs cancelled", vgroups({"tentative": 17, "cancelled": 1}),
    ref=[comp(op="count", group="status", kind="event", name="Pottery class"), ans(value="@prev")]),
  T("count the deleted tasks, split by status", vgroups({"open": 3}),
    ref=[comp(op="count", group="status", kind="task", trashed=True), ans(value="@prev")]),
  T("is return library books around", rows("library"),
    ref=[ans(kind="task", name="Return library books"),
         ans(kind="task", name="Return library books", trashed=True)]),
  T("restore that and the bike tune up", diff(restore("library"), restore("bike")),
    ref=[find(kind="task", trashed=True, name="Tune up bike"), act("restore", rows="$library, $bike")]))

S("T02-068", "compute rows within exclude",
  T("show me every debt that's open", rows("d_mf", "d_tomo", "d_arun_tix", "d_sophie_taxi", "d_diego_chalk",
                                              "d_kai_books", "d_priya_sushi", "d_mom_phone", "d_carlos"),
    ref=[ans(kind="debt", where='status = "open"')]),
  T("split by direction", vgroups({"owes_me": (1375, "CAD"), "i_owe": (215.5, "CAD")}),
    ref=[comp(op="sum", field="amount", group="direction", rows="@prev"), ans(value="@prev")]),
  T("same but leave out the tomo kill fee, that's never getting paid",
    vgroups({"owes_me": (1075, "CAD"), "i_owe": (215.5, "CAD")}),
    ref=[comp(op="sum", field="amount", group="direction", kind="debt", where='status = "open"', exclude="$d_tomo"),
         ans(value="@prev")]),
  T("the open ones over 200 CAD", rows("d_mf", "d_tomo"),
    ref=[ans(kind="debt", where='status = "open" and amount > 200 CAD')]),
  T("and open ones from before last friday",
    rows("d_mf", "d_arun_tix", "d_sophie_taxi", "d_diego_chalk", "d_kai_books", "d_priya_sushi", "d_mom_phone", "d_carlos"),
    ref=[ans(kind="debt", where='status = "open"', when=W({"to": U("week", -1, weekday=5)}))]))

S("T02-069", "search log multi-row decline",
  T("had lunch at my parents, log a visit with mom and dad", diff(upd("mom", date=ANY), upd("dad", date=ANY)),
    ref=[search("mom", kind="person"), search("dad", kind="person"),
         act("log", rows="$mom, $dad", args=lines(kind="visit"))]),
  T("and whatsapp kai that i owe him for the flowers", decline("out_of_scope", "sealed_egress"),
    ref=[dec("out_of_scope")]),
  T("who have i been in touch w from last monday thru june",
    rows("sophie_d", "sophie_t", "marcus", "jess", "arun", "diego", "mom", "dad"),
    ref=[ans(kind="person", when=W({"from": U("week", -1, weekday=1), "to": U("month", 0, name=6)}))]))

S("T02-070", "event create span repair add_to args",
  T("book glaze night at the studio friday 7 to 9",
    diff(new("event", name=has("glaze"), date="2027-06-11T19:00", duration=120)),
    ref=[act("create", args=lines(kind="event", name="Glaze night",
                                  date={"from": U("week", 0, weekday=5, time="19:00"), "to": U("week", 0, weekday=5, time="21:00")}))]),
  T("what's the kiln schedule", rows("kiln"),
    ref=[ans(kind="note", name="Kiln schedule")]),
  T("can you put the celadon mug pic in climbing lol no wait, family", diff(link("fam_album", "celadon_mug")),
    ref=[bad(act("add_to", kind="photo", name="Celadon mug", args=lines(album="$fam_album"))),
         act("add_to", kind="photo", name="Celadon mug", args=lines(to="$fam_album"))]))

S("T02-072", "month name narrowing priority",
  T("what's due in july", rows("rent_jul", "pocket_wifi", "adobe_renew", "yen", "gst_q2"),
    ref=[ans(kind="task", when=W(U("month", 0, name=7)))]),
  T("any of those high priority", rows("rent_jul", "gst_q2"),
    ref=[ans(within="@prev", where="priority >= 1 and priority <= 2")]),
  T("and on tokyo prep, from next monday to the end of the month", rows("jr_pass", "insurance"),
    ref=[ans(kind="task", linked_to="$tokyoprep", when=W({"from": U("week", 1, weekday=1), "to": U("month", 0)}))]))

S("T02-073", "count last month invoices repair kind",
  T("how many invoices did i get out last month", val(2),
    ref=[search("invoice", kind="task"),
         ans(op="count", kind="task", name="Invoice", where='status = "completed"', when=W(U("month", -1)))]),
  T("what's my gst number", rows("gst_no"),
    ref=[ans(kind="locker item", name="GST number")]),
  T("notes from before mid march", rows("palette_hg", "gesture", "rates", "kiln", "wheel_tips"),
    ref=[ans(kind="note", when=W({"to": D("2027-03-15")}))]))

S("T02-074", "hour unit create minute anchor",
  T("remind me in two hrs to email farah about the print proofs", diff(new("task", name=has("farah"), date="2027-06-08T13:05")),
    ref=[act("create", args=lines(kind="task", name="Email Farah about the print proofs", date=U("hour", 2)))]),
  T("and push the marcus call half an hour later", diff(upd("call_marcus", date="2027-06-09T10:30")),
    ref=[act("reschedule", kind="event", name="Call with Marcus re Greenleaf mural",
             args=lines(to=U("minute", 30, anchor="row")))]),
  T("book studio time wed 10 to 11", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Studio time",
                                      date={"from": U("week", 0, weekday=3, time="10:00"), "to": U("week", 0, weekday=3, time="11:00")}))),
         askc("that clashes with the marcus call at 10:30. want 12 to 1 instead?")]),
  T("ya do 12 to 1", diff(new("event", name="Studio time", date="2027-06-09T12:00", duration=60)),
    ref=[act("create", args=lines(kind="event", name="Studio time",
                                  date={"from": D("2027-06-09", "12:00"), "to": D("2027-06-09", "13:00")}))]))

S("T02-075", "year unit narrowing",
  T("photos from last year", rows("balance_rock", "tow_hill", "agate", "masset", "totem", "ferry_pic", "rainforest",
                                  "cabin_porch", "mina_sketch", "eagle", "carving", "tlell"),
    ref=[ans(kind="photo", when=W(U("year", -1)))]),
  T("only starred", rows("tow_hill", "mina_sketch"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("delete eagle over naikoon, its out of focus", diff(trash("eagle"), unlink("hg_album", "eagle")),
    ref=[act("delete", kind="photo", name="Eagle over Naikoon")]),
  T("and what's from the last week", rows("desk", "sunset_flat", "dad_garden"),
    ref=[ans(kind="photo", when=W(U("week", -1, anchor="today")))]),
  T("is there a tokyo album yet", decline("not_found"),
    ref=[ans(kind="album", name="Tokyo"), dec("not_found")]))
