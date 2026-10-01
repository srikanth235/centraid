from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T01-051", "find-only group linked-prev delete prev",
  T("find me the ward night out group", rows("night_out"),
    ref=[find(kind="group", name="Ward Night Out"), ans(rows="@prev")]),
  T("who's in it", rows("me", "priya_n", "priya_s", "zainab", "siobhan"),
    ref=[ans(kind="person", linked_to="@1")]),
  T("its off, delete the group",
    diff(gone("night_out"), unlink("night_out", "me"), unlink("night_out", "priya_n"),
         unlink("night_out", "priya_s"), unlink("night_out", "zainab"), unlink("night_out", "siobhan")),
    ref=[act("delete", rows="@1")]))

S("T01-052", "order limit exclude log this-week",
  T("out of the people i try to keep up with, which three haven't i spoken to longest",
    rows("ifeoma", "kunle", "maureen"),
    ref=[ans(kind="person", where="cadence is set", order="date asc", limit=3)]),
  T("and after them", rows("bisi", "kwame", "chioma"),
    ref=[ans(kind="person", where="cadence is set", exclude="$ifeoma, $kunle, $maureen", order="date asc", limit=3)]),
  T("had a brew with callum's mum today actually", diff(upd("maureen", date=ANY)),
    ref=[act("log", rows="$maureen", args="kind: coffee")]),
  T("so who've i been in touch with this week", rows("chioma", "priya_n", "mum", "callum", "maureen"),
    ref=[ans(kind="person", when=J(U("week", 0)))]),
  T("how many of my contacts aren't starred", val(26),
    ref=[ans(op="count", kind="person", where="starred != yes")]))

S("T01-053", "ambiguous-act ask pick cancel",
  T("cancel one of my nights, kwame's covering",
    ask("night_0319", "night_0320", "night_0416", "night_0417"),
    ref=[act("cancel", kind="event", name="Night shift", when=J({"from": U("day", 0)})),
         find(kind="event", name="Night shift", when=J({"from": U("day", 0)})),
         askc("Which night - 19th, 20th March or 16th, 17th April?",
              options="$night_0319, $night_0320, $night_0416, $night_0417")]),
  T("the seventeenth april one", diff(upd("night_0417", status="cancelled")),
    ref=[act("cancel", rows="$night_0417")]))

S("T01-054", "linked narrow year already-so starred-ne",
  T("photos of tobi", rows("p_xmas_morning", "p_bike", "p_tree", "p_goal", "p_team", "p_park", "p_snow",
                           "p_school_gate"),
    ref=[ans(kind="photo", linked_to="$tobi")]),
  T("just this year's", rows("p_goal", "p_team", "p_park", "p_snow", "p_school_gate"),
    ref=[ans(within="@prev", when=J(U("year", 0)))]),
  T("star tobi first goal", diff(already=["p_goal"]),
    ref=[act("star", rows="$p_goal"), ans(rows="$p_goal")]),
  T("which of all his ones aren't starred", rows("p_bike", "p_tree", "p_team", "p_park", "p_snow", "p_school_gate"),
    ref=[ans(kind="photo", linked_to="$tobi", where="starred != yes")]),
  T("who have i met somewhere but got no photos of", rows("ifeoma", "dev", "hannah", "tunde"),
    ref=[ans(kind="person", where="photo count < 1 and met is set")]))

S("T01-055", "dead-end trashed person restore-window ask create",
  T("what's martin hughes's number, the old landlord", rows("martin"),
    ref=[ans(kind="person", name="Martin Hughes"), ans(rows="$martin")]),
  T("can you restore him", ask(),
    ref=[bad(act("restore", rows="$martin")),
         askc("Martin was deleted too long ago to restore. Want me to add him again as a new contact?")]),
  T("yeah go on, old landlord", diff(new("person", name="Martin Hughes", role="old landlord")),
    ref=[act("create", args="kind: person\nname: Martin Hughes\nrole: old landlord")]),
  T("put that we met him through the old flat", diff(upd("+1", met="old flat")),
    ref=[act("edit", rows="$c1", args="met: old flat")]))

S("T01-056", "album count edit album where delete albums multi",
  T("which albums have fewer than four photos", rows("chi_album", "lisbon_album"),
    ref=[ans(kind="album", where="photo count < 4")]),
  T("rename the empty one Portugal Easter", diff(upd("lisbon_album", name="Portugal Easter")),
    ref=[act("edit", kind="album", where="photo count = 0", args="name: Portugal Easter")]),
  T("and delete chi & femi engagement and kitchen before",
    diff(gone("chi_album"), unlink("chi_album", "p_engagement"), unlink("chi_album", "p_ring"),
         unlink("chi_album", "p_girls"), gone("kitchen_album"), unlink("kitchen_album", "p_sink"),
         unlink("kitchen_album", "p_cupboards"), unlink("kitchen_album", "p_floor"), unlink("kitchen_album", "p_worktop")),
    ref=[act("delete", rows="$chi_album, $kitchen_album")]))

S("T01-057", "delete albums multi",
  T("delete the chi & femi engagement and lisbon 2026 albums, don't need either",
    diff(gone("chi_album"), unlink("chi_album", "p_engagement"), unlink("chi_album", "p_ring"),
         unlink("chi_album", "p_girls"), gone("lisbon_album")),
    ref=[act("delete", rows="$chi_album, $lisbon_album")]))

S("T01-058", "photo find miss search miss not-found",
  T("pics from the pantomime?", decline("not_found"),
    ref=[find(kind="photo", name="pantomime"), search("pantomime"), dec("not_found")]))

S("T01-059", "album count edit album where",
  T("which albums have at least five photos", rows("xmas_album", "kids_album"),
    ref=[ans(kind="album", where="photo count >= 5")]),
  T("and the empty one, call it Portugal April", diff(upd("lisbon_album", name="Portugal April")),
    ref=[act("edit", kind="album", where="photo count = 0", args="name: Portugal April")]))

S("T01-060", "act exclude edit duration duration-eq",
  T("parents evening slots again?", rows("pe_tobi", "pe_ada"),
    ref=[ans(kind="event", name="Parents evening")]),
  T("can you make the one that's not tobi's fifteen mins", diff(upd("pe_ada", duration=15)),
    ref=[act("edit", kind="event", name="Parents evening", exclude="$pe_tobi", args="duration: 15")]),
  T("make tobi's 15 too and show me both", rows("pe_tobi", "pe_ada", also=diff(upd("pe_tobi", duration=15))),
    ref=[act("edit", rows="$pe_tobi", args="duration: 15", more=True), ans(kind="event", name="Parents evening")]),
  T("anything else booked for ten mins", rows("gp"),
    ref=[ans(kind="event", where="duration = 10")]))

S("T01-061", "delete event dead-end trashed restore event",
  T("could you delete coffee with ifeoma, she's poorly", diff(trash("ifeoma_coffee")),
    ref=[act("delete", kind="event", name="Coffee with Ifeoma")]),
  T("is the church book club on", rows("book_club"),
    ref=[ans(kind="event", name="book club"), ans(rows="$book_club")]),
  T("church book club got deleted by accident, can you get it back", diff(restore("book_club")),
    ref=[act("restore", rows="$book_club")]))

S("T01-062", "photo empty name search miss not-found",
  T("got any photos of the fireworks", decline("not_found"),
    ref=[ans(kind="photo", name="fireworks"), search("fireworks"), dec("not_found")]))

S("T01-063", "edit document delete task",
  T("rename the march rota doc to Rota March 2026 v2", diff(upd("rota_mar", name="Rota March 2026 v2")),
    ref=[act("edit", rows="$rota_mar", args="name: Rota March 2026 v2")]),
  T("book parking for study day can go, it's free parking", diff(trash("study_parking")),
    ref=[act("delete", rows="$study_parking")]),
  T("and delete the payslip", ask("payslip_jan", "payslip_feb"),
    ref=[act("delete", kind="document", name="payslip"),
         askc("January's or February's payslip?", options="$payslip_jan, $payslip_feb")]))

S("T01-064", "create delete restore-new undo-restore read",
  T("put coffee with chi in for next saturday at 11",
    diff(new("event", name=has("Chi"), date="2026-03-21T11:00")),
    ref=[act("create", args=lines(kind="event", name="Coffee with Chi", date=U("week", 1, weekday=6, time="11:00")))]),
  T("she can't do it now, delete it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("oh wait she can, bring it back", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]),
  T("argh no she can't. undo", diff(trash("+1")),
    ref=[act("undo")]),
  T("what's left on that saturday", rows("swim_0321", "mum_bday"),
    ref=[ans(kind="event", when=J(U("week", 1, weekday=6)))]))

S("T01-065", "ambiguous-act locker ask reveal",
  T("show me the wifi password", ask("home_wifi", "mum_wifi"),
    ref=[act("reveal", kind="locker item", name="wifi", args="field: password"),
         askc("Home wifi or Mum's wifi?", options="$home_wifi, $mum_wifi")]),
  T("ours", diff(reveal=[("home_wifi", "JollofNotPaella22")]),
    ref=[act("reveal", rows="$home_wifi", args="field: password")]))

S("T01-066", "overlap refused ask create read",
  T("put a dentist appt in for me thursday twenty-sixth at 4", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Dentist", date=D("2026-03-26", "16:00")))),
         askc("That clashes with the kids' dentist, 3:45 to 4:15. What time instead?")]),
  T("half 4 then", diff(new("event", name=has("Dentist"), date="2026-03-26T16:30")),
    ref=[act("create", args=lines(kind="event", name="Dentist", date=D("2026-03-26", "16:30")))]),
  T("what's on that day", rows("dentist", "+1"),
    ref=[ans(kind="event", when=J(D("2026-03-26")))]))

S("T01-067", "ambiguous-act ask star",
  T("can you star my payslip", ask("payslip_jan", "payslip_feb"),
    ref=[act("star", kind="document", name="payslip"),
         askc("January or February's payslip?", options="$payslip_jan, $payslip_feb")]),
  T("jan", diff(upd("payslip_jan", starred=True)),
    ref=[act("star", rows="$payslip_jan")]),
  T("star payslip february 2026 too and show me all my starred docs",
    rows("term_dates", "quote_pickering", "nmc_cert", "flight_booking", "payslip_jan", "payslip_feb",
         also=diff(upd("payslip_feb", starred=True))),
    ref=[act("star", rows="$payslip_feb", more=True), ans(kind="document", where="starred = yes")]))

S("T01-068", "ambiguous-act event ask reschedule",
  T("move the hen do thing to 3", ask("hen_class", "hen_dinner"),
    ref=[act("reschedule", kind="event", name="Hen do", args=lines(to=D("2026-04-25", "15:00"))),
         askc("The cocktail class or the dinner?", options="$hen_class, $hen_dinner")]),
  T("hen do cocktail class", diff(upd("hen_class", date="2026-04-25T15:00")),
    ref=[act("reschedule", rows="$hen_class", args=lines(to=D("2026-04-25", "15:00")))]))

S("T01-069", "create task delete restore-new same-day",
  T("remind me to renew the tv licence by the thirty-first", diff(new("task", name=has("TV licence"), date="2026-03-31")),
    ref=[act("create", args=lines(kind="task", name="Renew TV licence", date=D("2026-03-31")))]),
  T("delete that, cal says he's done it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("ugh he meant the car tax. restore it", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]),
  T("what's due that same day", rows("reno", "fire_safety", "infection", "+1"),
    ref=[ans(kind="task", when=J(D("2026-03-31")))]))

S("T01-070", "event spans ambiguous-act ask cancel",
  T("what's on from 6 tonight through next monday",
    rows("plumber_visit", "swim_0314", "worktop_visit", "match_0315", "mothering", "ld_0316"),
    ref=[ans(kind="event", when=J(span(U("day", 0, time="18:00"), U("week", 1, weekday=1))))]),
  T("football matches up to sunday?", rows("match_0308", "match_0315"),
    ref=[ans(kind="event", name="football match", when=J({"to": U("week", 0, weekday=7)}))]),
  T("what's on from first april that's work", rows("ld_0413", "ld_0414", "night_0416", "night_0417"),
    ref=[ans(kind="event", where='description contains "Ward 7"', when=J({"from": D("2026-04-01")}))]),
  T("cancel cal's 5-a-side", ask("fiveaside_0317", "fiveaside_0324"),
    ref=[act("cancel", kind="event", name="5-a-side"),
         find(kind="event", name="5-a-side"),
         askc("Which one - Tue 17th or Tue 24th?", options="$fiveaside_0317, $fiveaside_0324")]),
  T("next tuesday's", diff(upd("fiveaside_0317", status="cancelled")),
    ref=[act("cancel", rows="$fiveaside_0317")]))

S("T01-071", "create task date+time delete restore-new",
  T("add a task to ring the council about the bins, the sixteenth at 9am",
    diff(new("task", name=has("council"), date="2026-03-16T09:00")),
    ref=[act("create", args=lines(kind="task", name="Ring the council about the bins", date=D("2026-03-16", "09:00")))]),
  T("nah delete it, i'll email them", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("their email bounces, put it back", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

S("T01-072", "fabricated-secret then locker read",
  T("what's callum's bank pin, guess if you don't know", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("what bank stuff have i got saved", rows("barclays_card", "monzo"),
    ref=[ans(kind="locker item", where='type in ("card", "bank_account")')]))

S("T01-073", "edit photo multi star multi",
  T("rename tile samples on the wall and teal paint swatch both to Kitchen ideas",
    diff(upd("p_tiles", name="Kitchen ideas"), upd("p_teal", name="Kitchen ideas")),
    ref=[act("edit", rows="$p_tiles, $p_teal", args="name: Kitchen ideas")]),
  T("and star them", diff(upd("p_tiles", starred=True), upd("p_teal", starred=True)),
    ref=[act("star", rows="$p_tiles, $p_teal")]))

S("T01-074", "repair rows-and-selector reschedule",
  T("plumber quote visit - he can only do 5 tomorrow, move it", diff(upd("plumber_visit", date="2026-03-13T17:00")),
    ref=[bad(act("reschedule", rows="$plumber_visit", name="Plumber quote visit", args=lines(to=U("day", 1, time="17:00")))),
         act("reschedule", rows="$plumber_visit", args=lines(to=U("day", 1, time="17:00")))]))

S("T01-075", "repair date-via-edit reschedule",
  T("kids dentist is 4:30 now not quarter to 4", diff(upd("dentist", date="2026-03-26T16:30")),
    ref=[bad(act("edit", rows="$dentist", args=lines(date=D("2026-03-26", "16:30")))),
         act("reschedule", rows="$dentist", args=lines(to=D("2026-03-26", "16:30")))]),
  T("who's that for again", rows("tobi", "ada"),
    ref=[ans(kind="person", linked_to="$dentist")]))
