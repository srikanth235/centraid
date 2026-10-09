from gold import *
import json

world("T35", "2026-11-12T19:20", "Freya Lindqvist", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


# ---- same-word-pick: the verb, the kind word, the topic, the gloss or the second name decides ----

S("T35-066", "same-word-pick star unstar person verb-decides two-lars two-ingrids",
  T("star ingrid", diff(upd("ingrid_m", starred=True)),
    ref=[act("star", kind="person", name="ingrid")]),
  T("and unstar lars", diff(upd("lars_h", starred=False)),
    ref=[act("unstar", kind="person", name="lars")]))

S("T35-067", "same-word-pick add_to album jonas link-target two-row linked_to",
  T("put the photo from mamma's table in jonas's album", diff(link("jonas_album", "p_bergen_table")),
    ref=[act("add_to", rows="$p_bergen_table", args=lines(to="$jonas_album"))]),
  T("which photos of jonas are in the bergen album", rows("p_bergen_table"),
    ref=[ans(kind="photo", linked_to="$jonas, $bergen_album")]))

S("T35-068", "same-word-pick possessor jonas dentist gloss mine",
  T("when's jonas's dentist this month", rows("dentist_jonas"),
    ref=[ans(kind="event", name="dentist jonas", when=J(U("month", 0)))]),
  T("and mine", rows("dentist"),
    ref=[ans(rows="$dentist")]))

S("T35-069", "same-word-pick ask pick constraint documents insurance tax-return",
  T("star the home insurance", ask("home_insurance", "home_insurance_25"),
    ref=[act("star", kind="document", name="home insurance")]),
  T("the 2026 one", diff(upd("home_insurance", starred=True)),
    ref=[act("star", rows="$home_insurance")]),
  T("and the tax return from this year", diff(upd("tax_2025", starred=True)),
    ref=[act("star", kind="document", name="tax return", when=J(U("year", 0)))]))

S("T35-070", "same-word-pick both second-name translated agm cod-survey document-vs-task",
  T("push the cod team meeting and the parent-teacher meeting back an hour",
    diff(upd("cod_team", date="2026-11-13T12:00"), upd("parent_teacher", date="2026-11-19T18:00")),
    ref=[act("reschedule", rows="$cod_team, $parent_teacher", args=lines(to=U("hour", 1, anchor="row")))]),
  T("when's the sailing club agm", rows("club_agm"),
    ref=[ans(kind="event", name="agm")]),
  T("and star the cod survey plan", diff(upd("cruise_plan", starred=True)),
    ref=[act("star", kind="document", name="cod survey plan")]))


# ---- create-args -----------------------------------------------------------------------------

S("T35-071", "create-args locker login user-label wifi implied-type inert-purpose",
  T("save a login for posten, user freya.l, it's for tracking parcels",
    diff(new("locker item", name=has("posten"), type="login", username="freya.l")),
    ref=[act("create", args=lines(kind="locker item", name="Posten", type="login", username="freya.l"))]),
  T("add mamma's wifi to the locker too, need it for christmas",
    diff(new("locker item", name=has("mamma", "wifi"), type="wifi")),
    ref=[act("create", args=lines(kind="locker item", name="Mamma's wifi", type="wifi"))]),
  T("what's in the locker trash", rows("old_wifi", "old_login"),
    ref=[ans(kind="locker item", trashed=True)]))

S("T35-072", "create-args task-vs-event call-tradesperson appointment list-link chore errand inert-purpose",
  T("call frode friday about the brake noise",
    diff(new("task", name=has("frode"), date="2026-11-13")),
    ref=[act("create", args="kind: task\nname: Call Frode about the brake noise\ndate: " + J(U("week", 0, weekday=5)))]),
  T("physio appointment friday at 9",
    diff(new("event", name=has("physio"), date="2026-11-13T09:00")),
    ref=[bad(act("create", args=lines(kind="event", name="Physio appointment", date=U("week", 0, weekday=5, time="9am")))),
         act("create", args=lines(kind="event", name="Physio appointment", date=U("week", 0, weekday=5, time="09:00")))]),
  T("and remind me to call the roofer monday, on the home list",
    diff(new("task", name=has("roofer"), date="2026-11-16"), link("home_list", "new")),
    ref=[act("create", args="kind: task\nname: Call the roofer\ndate: " + J(U("week", 1, weekday=1)) + "\nlist: $home_list")]),
  T("and pick up jonas's boots from the shop saturday, he needs them for skiing",
    diff(new("task", name=has("boots"), date="2026-11-14")),
    ref=[act("create", args=lines(kind="task", name="Pick up Jonas's boots from the shop", date=U("week", 0, weekday=6)))]))

S("T35-073", "create-args person label-words one-attribute-per-line debt inert-date-clause",
  T("add berit moe, the new neighbour, goes by bit, she takes my parcels",
    diff(new("person", name="Berit Moe", role="neighbour", nickname="Bit")),
    ref=[act("create", args=lines(kind="person", name="Berit Moe", role="neighbour", nickname="Bit"))]),
  T("kjersti owes me 300 for the cinema, we went wednesday",
    diff(new("debt", name=has("cinema"), amount=300, direction="owes_me"), link("new", "kjersti")),
    ref=[act("create", args=lines(kind="debt", name="Cinema", person="$kjersti", amount="300", direction="owes_me"))]),
  T("and put a note in the house notebook, nils does the drive on thursdays",
    diff(new("note", name=ANY, body=has("nils", "drive")), link("house_nb", "new")),
    ref=[act("create", args="kind: note\nname: Nils and the drive\nbody: nils does the drive on thursdays\nnotebook: $house_nb")]))

S("T35-074", "create-args album group inert-purpose add_to-new",
  T("make an album called polar night, for the aurora pics",
    diff(new("album", name="Polar night")),
    ref=[act("create", args=lines(kind="album", name="Polar night"))]),
  T("put the aurora photo in it",
    diff(link("+1", "p_aurora")),
    ref=[act("add_to", rows="$p_aurora", args=lines(to="$c1"))]),
  T("and a group called lofoten, to split the trip costs with kjersti and siv",
    diff(new("group", name="Lofoten", currency="NOK"), link("new", "me"), link("new", "kjersti"), link("new", "siv")),
    ref=[act("create", args="kind: group\nname: Lofoten\ncurrency: NOK", more=True),
         act("add_to", rows="$kjersti, $siv", args="to: $new")]))

S("T35-075", "create-args task one-attribute-per-line list-link subtask-parent repair-plain-date",
  T("add a task, order two spare winch cables, due the 30th, 20 min, priority 2, lab list",
    diff(new("task", name=has("winch", "cables"), date="2026-11-30", effort=20, priority=2), link("lab_list", "new")),
    ref=[bad(act("create", args="kind: task\nname: Order two spare winch cables\ndate: 2026-11-30\neffort: 20\npriority: 2\nlist: $lab_list")),
         act("create", args="kind: task\nname: Order two spare winch cables\ndate: " + J(D("2026-11-30")) + "\neffort: 20\npriority: 2\nlist: $lab_list")]),
  T("and a subtask under the cod survey, book the harbour pilot, due december 5th",
    diff(new("task", name=has("harbour", "pilot"), date="2026-12-05"), link("cod", "new")),
    ref=[act("create", args="kind: task\nname: Book the harbour pilot\ndate: " + J(D("2026-12-05")) + "\nparent: $cod")]))


# ---- verb-choice -----------------------------------------------------------------------------

S("T35-076", "verb-choice remove_from put-it-back add_to move-folder",
  T("take the chimney sweep task off the home list, i'll ring them tomorrow", diff(unlink("home_list", "chimney")),
    ref=[act("remove_from", kind="task", name="chimney sweep", args=lines(from_="$home_list"))]),
  T("put it back, i'll forget otherwise", diff(link("home_list", "chimney")),
    ref=[act("add_to", rows="$chimney", args=lines(to="$home_list"))]),
  T("move the club budget to the tax folder", diff(link("tax_f", "club_budget"), unlink("club_f", "club_budget")),
    ref=[act("add_to", kind="document", name="club budget", args=lines(to="$tax_f"))]),
  T("ok put it back where it was", diff(link("club_f", "club_budget"), unlink("tax_f", "club_budget")),
    ref=[act("add_to", rows="$club_budget", args=lines(to="$club_f"))]))

S("T35-077", "verb-choice delete put-it-back restore jot-down create-note add_to-new",
  T("delete the chimney sweep task, i'll ring them tomorrow", diff(trash("chimney")),
    ref=[act("delete", kind="task", name="chimney sweep")]),
  T("put it back, i'll forget otherwise", diff(restore("chimney")),
    ref=[act("restore", rows="$chimney")]),
  T("jot down that the sweep wants the flue open before he comes", diff(new("note", name=ANY, body=has("flue"))),
    ref=[act("create", args="kind: note\nname: Chimney sweep\nbody: sweep wants the flue open before he comes")]),
  T("file it in the house notebook", diff(link("house_nb", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$house_nb"))]))

S("T35-078", "verb-choice reschedule make-it-hour no-wait-weekday make-it-duration edit",
  T("move the parent-teacher meeting to tuesday", diff(upd("parent_teacher", date="2026-11-17T17:00")),
    ref=[act("reschedule", kind="event", name="parent-teacher meeting", args=lines(to=U("week", 1, weekday=2)))]),
  T("make it 6", diff(upd("parent_teacher", date="2026-11-17T18:00")),
    ref=[act("reschedule", rows="$parent_teacher", args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("no wait, wednesday", diff(upd("parent_teacher", date="2026-11-18T18:00")),
    ref=[act("reschedule", rows="$parent_teacher", args=lines(to=U("week", 1, weekday=3)))]),
  T("and make it 45 minutes", diff(upd("parent_teacher", duration=45)),
    ref=[act("edit", rows="$parent_teacher", args="duration: 45")]))

S("T35-079", "verb-choice add-one create-task block-time create-event after-read",
  T("what's open on the trips list", rows("xmas_gifts", "pack_xmas", "hurti_book"),
    ref=[ans(kind="task", linked_to="$trips_list", where="status = open")]),
  T("add one for the ski passes, due next friday",
    diff(new("task", name=has("ski", "passes"), date="2026-11-20"), link("trips_list", "new")),
    ref=[bad(act("create", args="kind: task\nname: Buy the ski passes\ndate: next friday\nlist: $trips_list")),
         act("create", args="kind: task\nname: Buy the ski passes\ndate: " + J(U("week", 1, weekday=5)) + "\nlist: $trips_list")]),
  T("block 2 to 4 tomorrow for the grant report",
    diff(new("event", name=has("grant", "report"), date="2026-11-13T14:00", duration=120)),
    ref=[act("create", args=lines(kind="event", name="Grant report", date=U("day", 1, time="14:00"), duration=120))]),
  T("and make another list called trips, for the summer", diff(new("list", name="Trips")),
    ref=[act("create", args=lines(kind="list", name="Trips"))]))

S("T35-080", "verb-choice reschedule bare-attribute edit-priority log-idiom in-progress edit-status",
  T("push the poster task to the 25th", diff(upd("poster", date="2026-11-25")),
    ref=[act("reschedule", kind="task", name="poster", args=lines(to=D("2026-11-25")))]),
  T("priority 1", diff(upd("poster", priority=1)),
    ref=[act("edit", rows="$poster", args="priority: 1")]),
  T("spoke to astrid on the phone, she's fine", diff(upd("astrid", date=ANY)),
    ref=[act("log", rows="$astrid", args="kind: call")]),
  T("and mark the poster one in progress, i've started the layout", diff(upd("poster", status="in_progress")),
    ref=[act("edit", rows="$poster", args="status: in_progress")]))


# ---- stop-signals ----------------------------------------------------------------------------

S("T35-081", "stop-signals not_found decoy near-hit by-name-answer substitution tax-return trash-read miss",
  T("where's my tax return for 2023", decline("not_found"), rows("tax_2024", "tax_2025"),
    ref=[ans(kind="document", name="tax return 2023")]),
  T("what about 2025", rows("tax_2025"),
    ref=[ans(kind="document", name="tax return 2025")]),
  T("is the 2023 one in the trash maybe", decline("not_found"), rows(),
    ref=[ans(kind="document", name="tax return 2023", trashed=True)]),
  T("what's my netflix login", decline("not_found"), rows(),
    ref=[ans(kind="locker item", name="netflix")]))

S("T35-082", "stop-signals never_mind end-of-message middle-of-message start-of-message by-name-delete-missing after-ask",
  T("delete the old gym login, actually never mind", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("cancel the swim on the 24th, no wait never mind, i'll keep it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("can you move the dentist to tuesday", ask("dentist", "dentist_jonas"),
    ref=[act("reschedule", kind="event", name="dentist", args=lines(to=U("week", 1, weekday=2)))]),
  T("never mind, i'll ring them myself", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T35-083", "stop-signals fyi no-request ask then cancel",
  T("fyi jonas has a cold", ask(),
    ref=[askc("Do you want me to change anything because of that, like his football on sunday?")]),
  T("yeah cancel his football on sunday", diff(upd("football", status="cancelled")),
    ref=[act("cancel", kind="event", name="football", when=J(U("week", 0, weekday=7)))]),
  T("and cancel his swim meet on saturday", decline("not_found"),
    ref=[act("cancel", kind="event", name="swim meet", when=J(U("week", 0, weekday=6)))]))

S("T35-084", "stop-signals unbounded-except decline then bounded delete cancelled",
  T("what's still open on the home list this month", rows("elec_bill", "heat_pump", "lights", "chimney"),
    ref=[ans(kind="task", linked_to="$home_list", where="status = open", when=J(U("month", 0)))]),
  T("delete everything on there except the heat pump filter", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("just the cancelled ones then", diff(trash("cancelled_paint"), trash("cancelled_shed")),
    ref=[find(kind="task", linked_to="$home_list", where="status = cancelled"), act("delete", rows="@prev")]),
  T("ok put them back, i might need them", diff(restore("cancelled_paint"), restore("cancelled_shed")),
    ref=[act("restore", rows="@2")]))

S("T35-085", "stop-signals out_of_scope off-topic decoy cod ski then not_found membership",
  T("what's the best way to cook cod", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("when's the cod survey cruise", rows("cod_survey"),
    ref=[ans(kind="event", name="cod survey")]),
  T("will it snow for jonas's skiing saturday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("what's my gym membership number", decline("not_found"), rows("club_member"),
    ref=[ans(kind="locker item", name="gym membership")]))


# ---- set-answers -----------------------------------------------------------------------------

S("T35-086", "set-answers role-noun lookup dentist neighbour-ingrid exact-role",
  T("who's my dentist", rows("mikkel"),
    ref=[ans(kind="person", where='role = "dentist"')]),
  T("and which ingrid is the neighbour", rows("ingrid_m"),
    ref=[ans(kind="person", name="ingrid", where='role = "neighbour"')]),
  T("and anyone in the trash", rows("old_broker", "old_builder"),
    ref=[ans(kind="person", trashed=True)]))

S("T35-087", "set-answers debts directional out back henrik",
  T("what does henrik still owe me", rows("d_henrik_boots"),
    ref=[ans(kind="debt", linked_to="$henrik", where="direction = owes_me and status = open")]),
  T("and what do i still owe him", rows("d_henrik_jacket"),
    ref=[ans(kind="debt", linked_to="$henrik", where="direction = i_owe and status = open")]))

S("T35-088", "set-answers same-word events meeting dentist weekday-decides",
  T("what time is the meeting next thursday", rows("parent_teacher"),
    ref=[ans(kind="event", name="meeting", when=J(U("week", 1, weekday=4)))]),
  T("and the one tomorrow", rows("cod_team"),
    ref=[ans(kind="event", name="meeting", when=J(U("day", 1)))]),
  T("what about the dentist on wednesday", rows("dentist"),
    ref=[ans(kind="event", name="dentist", when=J(U("week", 1, weekday=3)))]))

S("T35-089", "set-answers parent-task vs subtasks winter-boat-work complete write-then-read",
  T("what's left on the winter boat work", rows("winter_antifoul", "winter_winch"),
    ref=[ans(kind="task", linked_to="$winter_work", where="status = open")]),
  T("and when's the work itself due", rows("winter_work"),
    ref=[ans(kind="task", name="winter boat work")]),
  T("tick off the paint order, trond's sending the invoice, then what's left on it",
    rows("winter_winch", also=diff(upd("winter_antifoul", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="antifouling paint", more=True),
         ans(kind="task", linked_to="$winter_work", where="status = open")]))

S("T35-090", "set-answers superlative oldest find-then-act settle_debt biggest",
  T("i've paid the oldest thing i owe, settle it", diff(upd("d_tuva", status="settled")),
    ref=[find(kind="debt", where="direction = i_owe and status = open", order="date asc", limit=1),
         act("settle_debt", rows="@prev")]),
  T("and what's the biggest i still owe", rows("d_trond"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount desc", limit=1)]))
