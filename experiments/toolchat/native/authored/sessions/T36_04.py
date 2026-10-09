from gold import *
import json

world("T36", "2026-12-09T21:15", "Dev Mehra", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T36-066", "same-word-pick both-events link-target photo-album person-group two-row-linked_to",
  T("move both the lunch with rohan and the bunty call to monday",
    diff(upd("lunch_rohan_k", date="2026-12-14T13:00"), upd("catchup_bunty", date="2026-12-14T21:00")),
    ref=[act("reschedule", rows="$catchup_bunty, $lunch_rohan_k", args=lines(to=U("week", 1, weekday=1)))]),
  T("put the bunty sangeet photo in the wedding one", diff(link("wedding_album", "p_bunty")),
    ref=[act("add_to", rows="$p_bunty", args="to: $wedding_album")]),
  T("and aai too, add her to wedding", diff(link("wedding", "aai")),
    ref=[act("add_to", rows="$aai", args="to: $wedding")]),
  T("which of anju's photos are in the wedding one now", rows("p_haldi", "p_mehendi", "p_phere", "p_varmala"),
    ref=[ans(kind="photo", linked_to="$anjali, $wedding_album")]))

S("T36-067", "same-word-pick topic-decides gloss star person",
  T("who's coming to the office party", rows("priya_d", "chinmay", "vaishnavi"),
    ref=[ans(kind="person", linked_to="$office_party")]),
  T("star priya", diff(upd("priya_d", starred=True)),
    ref=[act("star", rows="$priya_d")]),
  T("and anju's cousin priya too", diff(upd("priya_s", starred=True)),
    ref=[find(kind="person", name="priya", where='role contains "cousin"'), act("star", rows="@prev")]))

S("T36-068", "same-word-pick possessor-vs-relation debt-vs-task star-wifi",
  T("paid kunal his dj share", diff(upd("d_kunal", status="settled")),
    ref=[act("settle_debt", rows="$d_kunal")]),
  T("and tick off the pay kunal task", diff(upd("pay_kunal", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pay_kunal")]),
  T("star aai's wifi", diff(upd("aai_wifi", starred=True)),
    ref=[act("star", rows="$aai_wifi")]))

S("T36-069", "same-word-pick verb-decides gloss ask star person",
  T("star rohan", diff(upd("rohan_m", starred=True)),
    ref=[act("star", kind="person", name="rohan")]),
  T("and take the star off the college one", diff(upd("rohan_k", starred=False)),
    ref=[act("unstar", kind="person", name="rohan", where='role contains "college"')]),
  T("star joshi", ask("baba", "sneha", "priest", "dentist"),
    ref=[act("star", kind="person", name="joshi")]),
  T("the sister in law", diff(upd("sneha", starred=True)),
    ref=[act("star", rows="$sneha")]))

S("T36-070", "same-word-pick verb-decides document-vs-task photos ask",
  T("star the scooter insurance", diff(upd("scooter_ins_d", starred=True)),
    ref=[act("star", rows="$scooter_ins_d")]),
  T("and tick off the insurance one, renewed it today",
    diff(upd("scooter_ins", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="scooter insurance")]),
  T("star the sangeet photo", ask("p_sangeet", "p_bunty"),
    ref=[act("star", kind="photo", name="sangeet")]),
  T("the dance floor one", diff(upd("p_sangeet", starred=True)),
    ref=[act("star", rows="$p_sangeet")]))

S("T36-071", "create-args locker login username-label wifi-type",
  T("save my zerodha login, user is dev.trades, site is kite.zerodha.com, i'll add the password later",
    diff(new("locker item", name=has("zerodha"), type="login", username="dev.trades", url=has("kite.zerodha.com"))),
    ref=[act("create", kind="locker item",
             args=lines(name="Zerodha", type="login", username="dev.trades", url="kite.zerodha.com"))]),
  T("and save the office guest wifi too", diff(new("locker item", name=has("guest", "wifi"), type="wifi")),
    ref=[act("create", kind="locker item", args=lines(name="Office guest wifi", type="wifi"))]))

S("T36-072", "create-args task purpose-clause list-link tradesperson-call",
  T("add a task to buy a ladder, the balcony curtains need one, put it on the flat list",
    diff(new("task", name=has("ladder")), link("home_list", "new")),
    ref=[act("create", kind="task", args=lines(name="Buy a ladder", list="$home_list"))]),
  T("and one more on it, call the geyser guy saturday",
    diff(new("task", name=has("geyser"), date="2026-12-12"), link("home_list", "new")),
    ref=[act("create", kind="task", args=lines(name="Call the geyser guy", date=U("week", 0, weekday=6), list="$home_list"))]))

S("T36-073", "create-args task-vs-event chore errand appointment",
  T("call ganesh about the chain on saturday",
    diff(new("task", name=has("ganesh"), date="2026-12-12")),
    ref=[act("create", kind="task", args=lines(name="Call Ganesh about the chain", date=U("week", 0, weekday=6)))]),
  T("and the caterer, call him monday about the final bill",
    diff(new("task", name=has("caterer"), date="2026-12-14")),
    ref=[act("create", kind="task", args=lines(name="Call the caterer about the final bill", date=U("week", 1, weekday=1)))]),
  T("call papa saturday at 5", diff(new("event", name=has("papa"), date="2026-12-12T17:00")),
    ref=[act("create", kind="event", args=lines(name="Call Papa", date=U("week", 0, weekday=6, time="17:00")))]))

S("T36-074", "create-args person label-strip debt purpose-name",
  T("add a person, pooja kulkarni, role yoga teacher, nickname pooji",
    diff(new("person", name="Pooja Kulkarni", role="yoga teacher", nickname="Pooji")),
    ref=[act("create", kind="person", args=lines(name="Pooja Kulkarni", role="yoga teacher", nickname="Pooji"))]),
  T("neha owes me 800 for the yoga mat",
    diff(new("debt", name=has("yoga mat"), amount=800, direction="owes_me"), link("new", "neha")),
    ref=[act("create", kind="debt", args=lines(name="Yoga mat", person="$neha", amount="800", direction="owes_me"))]),
  T("and i owe siddharth 300 for the court booking, we play saturday",
    diff(new("debt", name=has("court"), amount=300, direction="i_owe"), link("new", "siddharth")),
    ref=[act("create", kind="debt", args=lines(name="Court booking", person="$siddharth", amount="300", direction="i_owe"))]))

S("T36-075", "create-args album group add_to-new currency",
  T("make an album called coep reunion for the old college photos and put the coep one in it",
    diff(new("album", name=has("coep")), link("new", "p_coep")),
    ref=[act("create", kind="album", args="name: COEP reunion", more=True),
         act("add_to", rows="$p_coep", args="to: $new")]),
  T("and a group called badminton fund in rupees for the court fees, with siddharth",
    diff(new("group", name=has("badminton"), currency="INR"), link("new", "me"), link("new", "siddharth")),
    ref=[act("create", kind="group", args=lines(name="Badminton fund", currency="INR"), more=True),
         act("add_to", rows="$siddharth", args="to: $new")]))

S("T36-076", "verb-choice put-it-back add_to move",
  T("take the puncture photo out of the scooter rides album", diff(unlink("rides_album", "p_ride_puncture")),
    ref=[act("remove_from", kind="photo", name="puncture", args="from: $rides_album")]),
  T("put it back", diff(link("rides_album", "p_ride_puncture")),
    ref=[act("add_to", rows="$p_ride_puncture", args="to: $rides_album")]),
  T("move the rajma recipe to flat notes", diff(link("home_nb", "kit_rajma"), unlink("kitchen_nb", "kit_rajma")),
    ref=[act("add_to", kind="note", name="rajma", args="to: $home_nb")]),
  T("no, put it back", diff(link("kitchen_nb", "kit_rajma"), unlink("home_nb", "kit_rajma")),
    ref=[act("add_to", rows="$kit_rajma", args="to: $kitchen_nb")]))

S("T36-077", "verb-choice put-it-back restore add_to",
  T("delete the puncture photo", diff(trash("p_ride_puncture"), unlink("rides_album", "p_ride_puncture")),
    ref=[act("delete", rows="$p_ride_puncture")]),
  T("put it back", diff(restore("p_ride_puncture")),
    ref=[act("restore", rows="$p_ride_puncture")]),
  T("and in scooter rides again", diff(link("rides_album", "p_ride_puncture")),
    ref=[act("add_to", rows="$p_ride_puncture", args="to: $rides_album")]),
  T("and get the blurry one out of the trash", diff(restore("p_blurry")),
    ref=[act("restore", kind="photo", name="blurry", trashed=True)]))

S("T36-078", "verb-choice in-progress edit-status add-one create",
  T("what's left on the scooter list", rows("scooter_tyre", "scooter_puc_t", "scooter_helmet", "scooter_ins", "emi_jan"),
    ref=[ans(kind="task", linked_to="$scooter_list", where="status = open")]),
  T("mark the tyre one in progress", diff(upd("scooter_tyre", status="in_progress")),
    ref=[act("edit", rows="$scooter_tyre", args="status: in_progress")]),
  T("add one on there to oil the chain, saturday",
    diff(new("task", name=has("chain"), date="2026-12-12"), link("scooter_list", "new")),
    ref=[act("create", kind="task", args=lines(name="Oil the chain", date=U("week", 0, weekday=6), list="$scooter_list"))]),
  T("push the scooter service to thursday", ask("scooter_service", "scooter_service_old"),
    ref=[act("reschedule", kind="event", name="scooter service", args=lines(to=U("week", 0, weekday=4)))]))

S("T36-079", "verb-choice make-it-hour no-wait bare-fragment edit",
  T("move the coffee with priya to thursday", diff(upd("coffee_priya", date="2026-12-10T17:30")),
    ref=[act("reschedule", rows="$coffee_priya", args=lines(to=U("week", 0, weekday=4)))]),
  T("make it 6", diff(upd("coffee_priya", date="2026-12-10T18:00")),
    ref=[act("reschedule", rows="$coffee_priya", args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("no wait, friday", diff(upd("coffee_priya", date="2026-12-11T18:00")),
    ref=[act("reschedule", rows="$coffee_priya", args=lines(to=U("week", 0, weekday=5)))]),
  T("45 mins", diff(upd("coffee_priya", duration=45)),
    ref=[act("edit", rows="$coffee_priya", args="duration: 45")]))

S("T36-080", "verb-choice log-idiom block-time create-event",
  T("when did i last speak to papa", rows("papa"),
    ref=[ans(kind="person", name="papa")]),
  T("he just rang me", diff(upd("papa", date=ANY)),
    ref=[act("log", rows="$papa", args="kind: call")]),
  T("block saturday 3 to 5 for the dry fruits run",
    diff(new("event", name=has("dry fruits"), date="2026-12-12T15:00", duration=120)),
    ref=[act("create", kind="event", args=lines(name="Dry fruits run",
                                                 date=span(U("week", 0, weekday=6, time="15:00"),
                                                           U("week", 0, weekday=6, time="17:00"))))]))

S("T36-081", "stop-signals not_found near-hit remind-me",
  T("have i got a plumber saved", rows(),
    ref=[ans(kind="person", name="plumber")]),
  T("and an electrician", rows(),
    ref=[ans(kind="person", name="electrician")]),
  T("is the home insurance policy saved anywhere", rows("scooter_ins_d"),
    ref=[ans(kind="document", name="home insurance")]),
  T("ok remind me to look for it tomorrow", diff(new("task", name=has("insurance"), date="2026-12-10")),
    ref=[act("create", kind="task", args=lines(name="Look for the home insurance policy", date=U("day", 1)))]))

S("T36-082", "stop-signals not_found decoy out_of_scope",
  T("when's the geyser guy coming", rows("buy_geyser"),
    ref=[ans(kind="event", name="geyser")]),
  T("whats a good restaurant for dinner near kothrud", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("that india match last night was unreal lol", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("who's my tailor", rows(),
    ref=[ans(kind="person", name="tailor")]))

S("T36-083", "stop-signals never_mind start middle end",
  T("cancel saturday's badminton, actually never mind", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("nvm the dentist thing, i'll sort it myself", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("bring back the old sofa task", decline("not_found"),
    ref=[act("restore", kind="task", name="old sofa", trashed=True)]),
  T("delete the old sofa task, no wait, leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T36-084", "stop-signals unbounded except",
  T("wipe all my notes except the wedding budget one", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("ok then just delete the cancelled tasks", diff(trash("onsite_form")),
    ref=[act("delete", kind="task", where="status = cancelled")]),
  T("and all my events, delete them except the wedding ones", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T36-085", "stop-signals fyi ask create-note",
  T("fyi anju's cousin priya is visiting in january", ask(),
    ref=[askc("Do you want me to save that, as a note or a reminder?")]),
  T("yes save it as a note", diff(new("note", name=has("priya"), body=has("january"))),
    ref=[act("create", kind="note", args=lines(name="Priya visiting", body="Anju's cousin Priya is visiting in January"))]),
  T("heads up, the society gate code is changing next week", ask(),
    ref=[askc("Should I remind you to update the gate code?")]))

S("T36-086", "set-answers role-noun exact-role",
  T("which joshi is my dentist", rows("dentist"),
    ref=[ans(kind="person", name="joshi", where='role = "dentist"')]),
  T("and my cousin", rows("rohan_m"),
    ref=[ans(kind="person", where='role = "cousin"')]),
  T("and anju's", rows("priya_s"),
    ref=[ans(kind="person", where='role = "Anjali\'s cousin"')]),
  T("and my wedding vendors", rows("caterer", "decorator", "photog"),
    ref=[ans(kind="person", where='role contains "wedding"')]))

S("T36-087", "set-answers debts direction two-rohans",
  T("what do i owe bunty", rows("d_rohan_m"),
    ref=[bad(ans(kind="debt", linked_to="$rohan_m", where="direction = owed")),
         ans(kind="debt", linked_to="$rohan_m", where="direction = i_owe")]),
  T("and what does rohan from college owe me", rows("d_rohan_k"),
    ref=[find(kind="person", name="rohan", where='role contains "college"'),
         ans(kind="debt", linked_to="@prev", where="direction = owes_me")]))

S("T36-088", "set-answers same-word-events weekday-decides",
  T("when's the doctor visit next wednesday", rows("doc_baba"),
    ref=[ans(kind="event", name="doctor", when=J(U("week", 1, weekday=3)))]),
  T("and the dinner saturday week", rows("dinner_mummy"),
    ref=[ans(kind="event", name="dinner", when=J(U("week", 2, weekday=6)))]),
  T("and next saturday", rows("shreya_bday"),
    ref=[ans(kind="event", name="dinner", when=J(U("week", 1, weekday=6)))]),
  T("move the doctor visit to friday", ask("doc_baba", "doc_papa"),
    ref=[act("reschedule", kind="event", name="doctor", args=lines(to=U("week", 0, weekday=5)))]))

S("T36-089", "set-answers parent-vs-subtasks",
  T("is the wedding wrap-up task done", rows("wrap"),
    ref=[ans(kind="task", name="wedding wrap-up")]),
  T("which of its parts are", rows("wrap_gifts_list", "wrap_return_decor", "wrap_pay_caterer"),
    ref=[ans(kind="task", linked_to="$wrap", where="status = completed")]),
  T("and is the decor quotes task gone", rows("old_decor"),
    ref=[find(kind="task", name="decor quotes", trashed=True), ans(rows="@prev")]))

S("T36-090", "set-answers superlative find-then-act",
  T("tick off the longest one on the work list", diff(upd("perf_review", status="completed", completed=ANY)),
    ref=[find(kind="task", linked_to="$work_list", where="status = open", order="effort desc", limit=1),
         act("complete", rows="@prev")]),
  T("star my oldest photo", diff(upd("p_flat_keys", starred=True)),
    ref=[find(kind="photo", order="date asc", limit=1), act("star", rows="@prev")]),
  T("and i paid off the biggest debt i had", diff(upd("d_baba", status="settled")),
    ref=[find(kind="debt", where="direction = i_owe and status = open", order="amount desc", limit=1),
         act("settle_debt", rows="@prev")]))
