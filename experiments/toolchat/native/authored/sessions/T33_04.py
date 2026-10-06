from gold import *


def J(d):
    return json.dumps(d, separators=(",", ":"))


# --- same-word-pick: one word, several rows; the verb, the topic, a gloss or the kind of row decides ------------------

S("T33-066", "same-word-pick person-vs-debt possessor topic-decides substitution settle-debt",
  T("how much is ma's surgery share", val((400, "SGD")),
    ref=[ans(op="sum", field="amount", kind="debt", name="ma's surgery")]),
  T("and the omakase one", val((160, "SGD")),
    ref=[ans(op="sum", field="amount", kind="debt", name="omakase")]),
  T("paid wei jie back this morning, settle it and tell me what i still owe in total",
    val((619, "SGD"), also=diff(upd("d_weijie", status="settled"))),
    ref=[act("settle_debt", rows="$d_weijie", more="true"),
         ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open")]))

S("T33-067", "same-word-pick link-target photo-album person-group count",
  T("put the treasurer photo in parc vista", diff(link("condo_a", "p_david")),
    ref=[act("add_to", rows="$p_david", args="to: $condo_a")]),
  T("and mdm wong in there too", diff(link("committee", "wong")),
    ref=[act("add_to", rows="$wong", args="to: $committee")]),
  T("and the nursery form pages photo in kenji", diff(link("kenji_a", "p_form")),
    ref=[act("add_to", rows="$p_form", args="to: $kenji_a")]),
  T("how many photos are in parc vista now", val(7),
    ref=[ans(op="count", kind="photo", linked_to="$condo_a")]))

S("T33-068", "same-word-pick two-row-linked_to photos person-album star verb-decides unstar",
  T("photos of jun hao in penang", rows("p_p_family", "p_p_temple"),
    ref=[ans(kind="photo", linked_to="$junhao, $penang_a")]),
  T("star the temple one", diff(upd("p_p_temple", starred=ANY)),
    ref=[act("star", rows="$p_p_temple")]),
  T("which of ma's photos in penang are starred", rows("p_p_ma", "p_p_family"),
    ref=[ans(kind="photo", linked_to="$ma, $penang_a", where="starred = yes")]),
  T("unstar the condo budget", diff(upd("d_budget27", starred=ANY)),
    ref=[act("unstar", kind="document", name="condo budget")]))

S("T33-069", "same-word-pick verb-decides document-vs-task star complete namesake-ask pick-by-year",
  T("can you star the home insurance", diff(upd("d_insure_h", starred=ANY)),
    ref=[act("star", kind="document", name="home insurance")]),
  T("and tick off the home insurance", diff(upd("insurance", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="home insurance")]),
  T("star the tax notice", ask("d_tax25", "d_tax24"),
    ref=[act("star", kind="document", name="tax notice")]),
  T("the 2025 one", diff(upd("d_tax25", starred=ANY)),
    ref=[act("star", rows="$d_tax25")]))

S("T33-070", "same-word-pick person-namesake ask pick-by-gloss usage-described-name both-events",
  T("star david", ask("david_l", "david_n"),
    ref=[act("star", kind="person", name="david")]),
  T("the committee one", diff(upd("david_l", starred=ANY)),
    ref=[act("star", rows="$david_l")]),
  T("just spoke to the aircon guy, log it", diff(upd("ahseng", date=ANY)),
    ref=[search("aircon", kind="person"),
         act("log", rows="$ahseng", args="kind: call")]),
  T("when are the paediatrician check up and kenji's vaccination", rows("ped_a", "vaccine"),
    ref=[find(kind="event", name="paediatrician check up", when=J({"from": U("day", 0)})),
         ans(rows="@prev, $vaccine")]))

# --- create-args: the clauses around the thing being made are not the thing --------------------------------------------

S("T33-071", "create-args login username-label purpose-clause",
  T("new login for the town council portal, user hiro.tl, for the parking fines",
    diff(new("locker item", name=has("town council"), type="login", username="hiro.tl")),
    ref=[act("create", args=lines(kind="locker item", name="Town council portal", type="login", username="hiro.tl"))]),
  T("and one for the singtel app, username hirotl88, for the bill",
    diff(new("locker item", name=has("singtel"), type="login", username="hirotl88")),
    ref=[act("create", args=lines(kind="locker item", name="Singtel app", type="login", username="hirotl88"))]))

S("T33-072", "create-args task-vs-event call-tradesperson appointment errand remind-me",
  T("remind me to call the aircon guy on monday about the leak",
    diff(new("task", name=has("call", "aircon"), date="2026-12-14")),
    ref=[act("create", args=lines(kind="task", name="Call the aircon guy about the leak", date=U("week", 1, weekday=1)))]),
  T("and put in a dentist appointment next friday at 11",
    diff(new("event", name=has("dentist"), date="2026-12-18T11:00")),
    ref=[act("create", args=lines(kind="event", name="Dentist appointment", date=U("week", 1, weekday=5, time="11:00")))]),
  T("also pick up the cake from bengawan solo on sunday",
    diff(new("task", name=has("cake"), date="2026-12-13")),
    ref=[act("create", args=lines(kind="task", name="Pick up the cake from Bengawan Solo", date=U("week", 0, weekday=7)))]))

S("T33-073", "create-args person-label group-purpose debt-purpose album-purpose",
  T("new contact, name is mr goh, he's the carpenter, for the shoe cabinet",
    diff(new("person", name=has("goh"), role="carpenter")),
    ref=[act("create", args=lines(kind="person", name="Mr Goh", role="carpenter"))]),
  T("make a group called bali trip in rupiah so we can split the villa",
    diff(new("group", name=has("bali"), currency="IDR"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Bali Trip", currency="IDR"))]),
  T("celine owes me 12 for the popcorn, she said she'd pay at the next dinner",
    diff(new("debt", name=has("popcorn"), amount=12, direction="owes_me"), link("new", "celine")),
    ref=[act("create", args=lines(kind="debt", name="popcorn", amount=12, direction="owes_me", person="$celine"))]),
  T("and an album called bali photos for the trip",
    diff(new("album", name=has("bali", "photos"))),
    ref=[act("create", args=lines(kind="album", name="Bali photos"))]))

S("T33-074", "create-args implied-wifi-type container-link-named task-on-list container-link-to-it new-notebook",
  T("add okaasan's wifi to the locker", diff(new("locker item", name=has("okaasan", "wifi"), type="wifi")),
    ref=[act("create", args=lines(kind="locker item", name="Okaasan's wifi", type="wifi"))]),
  T("new task on the kenji list, book the nursery open house for friday",
    diff(new("task", name=has("open house"), date="2026-12-18"), link("kenji_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Book the nursery open house", date=U("week", 1, weekday=5), list="$kenji_l"))]),
  T("make a notebook called school stuff", diff(new("notebook", name=has("school"))),
    ref=[act("create", args=lines(kind="notebook", name="School stuff"))]),
  T("add a note to it, uniform sizes 2 and 3",
    diff(new("note", name=has("uniform"), body=has("sizes 2")), link("+3", "new")),
    ref=[act("create", args=lines(kind="note", name="Uniform sizes", body="sizes 2 and 3", notebook="$c3"))]))

S("T33-075", "create-args one-attribute-per-line login-url event-description person-role-nickname",
  T("add the nparks login, user hiro.tl2, nparks.gov.sg",
    diff(new("locker item", name=has("nparks"), type="login", username="hiro.tl2", url=has("nparks.gov.sg"))),
    ref=[act("create", args=lines(kind="locker item", name="NParks", type="login", username="hiro.tl2", url="nparks.gov.sg"))]),
  T("put a physio session on monday at 6, bring the knee brace",
    diff(new("event", name=has("physio"), date="2026-12-14T18:00", description=has("knee brace"))),
    ref=[act("create", args=lines(kind="event", name="Physio session", date=U("week", 1, weekday=1, time="18:00"),
                                  description="bring the knee brace"))]),
  T("and add kelvin lim, plumber, everyone calls him pipe",
    diff(new("person", name=has("kelvin"), role="plumber", nickname="Pipe")),
    ref=[act("create", args=lines(kind="person", name="Kelvin Lim", role="plumber", nickname="Pipe"))]))

# --- verb-choice: the idiom names the act, the surface verb does not ------------------------------------------------------

S("T33-076", "verb-choice remove_from then put-it-back add_to photo album",
  T("take the pool pump photo out of parc vista", diff(unlink("condo_a", "p_c_pump")),
    ref=[act("remove_from", kind="photo", name="pool pump", args="from: $condo_a")]),
  T("actually put it back", diff(link("condo_a", "p_c_pump")),
    ref=[act("add_to", rows="$p_c_pump", args="to: $condo_a")]),
  T("is the pool pump photo in parc vista now", rows("p_c_pump"),
    ref=[ans(kind="photo", name="pool pump", linked_to="$condo_a")]))

S("T33-077", "verb-choice delete then put-it-back restore photo album-not-restored",
  T("get rid of the pool pump photo", diff(trash("p_c_pump"), unlink("condo_a", "p_c_pump")),
    ref=[act("delete", kind="photo", name="pool pump")]),
  T("actually put it back", diff(restore("p_c_pump")),
    ref=[act("restore", rows="$p_c_pump")]),
  T("is the pool pump photo in parc vista now", rows(),
    ref=[ans(kind="photo", name="pool pump", linked_to="$condo_a")]))

S("T33-078", "verb-choice make-it-hour reschedule-not-duration mark-in-progress edit-status",
  T("when's the next aircon servicing", rows("aircon_a"),
    ref=[ans(kind="event", name="aircon servicing", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("push it to tuesday", diff(upd("aircon_a", date="2026-12-15T14:00")),
    ref=[act("reschedule", rows="$aircon_a", args=lines(to=U("week", 1, weekday=2)))]),
  T("make it 3", diff(upd("aircon_a", date="2026-12-15T15:00")),
    ref=[act("reschedule", rows="$aircon_a", args=lines(to=U("week", 1, weekday=2, time="15:00")))]),
  T("and mark the hallway bulbs in progress, i've bought them", diff(upd("h_bulbs", status="in_progress")),
    ref=[act("edit", kind="task", name="hallway bulbs", args=lines(status="in_progress"))]))

S("T33-079", "verb-choice block-time create-event no-wait-weekday reschedule bare-fragment edit-duration repair-date",
  T("block 2 to 4 on thursday for the lift quote visit",
    diff(new("event", name=has("lift"), date="2026-12-17T14:00", duration=120)),
    ref=[bad(act("create", args=lines(kind="event", name="Lift quote visit",
                                      date={"unit": "week", "rel": 1, "weekday": 4, "time": "2:00"}, duration=120))),
         act("create", args=lines(kind="event", name="Lift quote visit", date=U("week", 1, weekday=4, time="14:00"), duration=120))]),
  T("no wait, friday", diff(upd("+1", date="2026-12-18T14:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 1, weekday=5)))]),
  T("just an hour", diff(upd("+1", duration=60)),
    ref=[act("edit", rows="$c1", args="duration: 60")]))

S("T33-080", "verb-choice just-off-the-phone log jot-down create-note add-one create-event",
  T("just hung up with ma", diff(upd("ma", date=ANY)),
    ref=[act("log", rows="$ma", args="kind: call")]),
  T("jot down she wants us to bring the kuih lapis on the 26th", diff(new("note", name=ANY, body=has("kuih lapis"))),
    ref=[act("create", args=lines(kind="note", name="Kuih lapis for the 26th", body="Ma wants us to bring the kuih lapis on the 26th"))]),
  T("when was the last playgroup", rows("play_1209"),
    ref=[ans(kind="event", name="playgroup", order="date desc", limit=1, when=J({"to": U("day", 0)}))]),
  T("add one for the 23rd at 10", diff(new("event", name=has("playgroup"), date="2026-12-23T10:00")),
    ref=[act("create", args=lines(kind="event", name="Playgroup", date=D("2026-12-23", "10:00")))]))

# --- stop-signals: the gold stops where the model goes on -------------------------------------------------------------------

S("T33-081", "stop-signals read-miss runtime-answers-empty write-miss runtime-composes decoy-near-hit",
  T("when's mei's physio", rows(),
    ref=[ans(kind="event", name="physio")]),
  T("is there a pension letter in documents", rows(),
    ref=[ans(kind="document", name="pension letter")]),
  T("cancel the piano recital", decline("not_found"),
    ref=[act("cancel", kind="event", name="piano recital")]))

S("T33-082", "stop-signals never-mind retraction start middle by-name-delete-missing",
  T("never mind, leave the aircon servicing where it is", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's on thursday", rows("ped_a"),
    ref=[ans(kind="event", when=J(U("week", 1, weekday=4)))]),
  T("delete the piano lesson task, no wait, forget it, i'll check the list first", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T33-083", "stop-signals fyi-no-request ask then create-note-in-notebook",
  T("fyi the lift will be down all of tuesday", ask(),
    ref=[askc("Do you want me to note that down somewhere?")]),
  T("yeah a note in condo notes", diff(new("note", name=ANY, body=has("lift")), link("condo_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Lift down on tuesday", body="the lift will be down all of tuesday", notebook="$condo_nb"))]),
  T("btw kenji only napped 40 minutes today", ask(),
    ref=[askc("Is there anything you want me to do about that?")]))

S("T33-084", "stop-signals unbounded-except bounded-delete event-except",
  T("delete every task except the penang trip ones", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("ok just the finished ones on the home list", diff(trash("permit_b"), trash("rina_leave"), trash("h_groceries_old")),
    ref=[find(kind="task", linked_to="$home_l", where="status = completed"),
         act("delete", rows="@prev")]),
  T("and cancel everything this week except the swim", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T33-085", "stop-signals out-of-scope lure-words not-not-found",
  T("will it rain at the brunch, wei jie wants to sit outside", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("how many ringgit to the dollar today", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

# --- set-answers: the answer is a part of what the lookup finds -------------------------------------------------------------

S("T33-086", "set-answers role-noun mother-vs-in-law father",
  T("who's my mother", rows("okaasan"),
    ref=[ans(kind="person", where='role = "mother"')]),
  T("and my father", rows("otousan"),
    ref=[ans(kind="person", where='role = "father"')]))

S("T33-087", "set-answers role-noun colleagues within-month treasurer role-contains",
  T("who are my colleagues", rows("david_n", "priya_nayar"),
    ref=[ans(kind="person", where='role = "colleague"')]),
  T("which of them have i spoken to this month", rows("david_n"),
    ref=[ans(within="@prev", when=J(U("month", 0)))]),
  T("and who's the treasurer", rows("david_l"),
    ref=[ans(kind="person", where='role contains "treasurer"')]),
  T("is marcus teo in the trash", rows("old_col"),
    ref=[ans(kind="person", name="marcus teo", trashed="true")]))

S("T33-088", "set-answers debts both-directions within superlative oldest find-then-settle remaining-sum",
  T("what debts are still open",
    rows("d_david_print", "d_fong_lights", "d_priya_art", "d_jiahui", "d_sarah", "d_weijie", "d_ravi", "d_kim",
         "d_junhao", "d_stella", "d_celine"),
    ref=[ans(kind="debt", where="status = open")]),
  T("just the ones people owe me", rows("d_david_print", "d_sarah", "d_ravi", "d_kim", "d_celine"),
    ref=[ans(within="@prev", where="direction = owes_me")]),
  T("the oldest one's been paid, settle it", diff(upd("d_celine", status="settled")),
    ref=[find(within="@prev", order="date asc", limit=1),
         act("settle_debt", rows="@prev")]),
  T("so how much are people still holding", val((242.5, "SGD")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open")]))

S("T33-089", "set-answers same-word-events weekday-decides substitution",
  T("what time's the christmas thing next sunday", rows("tree_lighting"),
    ref=[ans(kind="event", name="christmas", when=J(U("week", 1, weekday=7)))]),
  T("and next saturday", rows("sprouts_concert"),
    ref=[ans(kind="event", name="christmas", when=J(U("week", 1, weekday=6)))]),
  T("cancel the swim, kenji's got a fever", ask("swim_1212", "swim_1219"),
    ref=[act("cancel", kind="event", name="swim")]),
  T("the one next saturday", diff(upd("swim_1219", status="cancelled")),
    ref=[act("cancel", rows="$swim_1219")]))

S("T33-090", "set-answers parent-task vs subtasks superlative longest",
  T("when's the penang trip task due", rows("penang_trip"),
    ref=[ans(kind="task", name="penang trip")]),
  T("and the stuff under it that's still open", rows("pg_ringgit", "pg_gifts", "pg_pack", "pg_pet"),
    ref=[ans(kind="task", linked_to="$penang_trip", where="status = open")]),
  T("which one's the longest", rows("pg_gifts"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]))
