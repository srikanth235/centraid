from gold import *
import json

world("T37", "2027-03-09T10:40", "Liam O'Brien", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# ---- same-word-pick: a word two or more rows share; the verb, the topic or a gloss decides -------------------------

S("T37-066", "same-word star unstar document camino lookalikes verb-decides topic house-insurance",
  T("what's in the travel folder", rows("boston_tickets", "camino_plan"),
    ref=[ans(kind="document", linked_to="$travel_f")]),
  T("star the camino one", diff(upd("camino_plan", starred=True)),
    ref=[act("star", kind="document", name="camino")]),
  T("and the boston one too", diff(upd("boston_tickets", starred=True)),
    ref=[act("star", kind="document", name="boston")]),
  T("unstar the house insurance, that's sorted now", diff(upd("house_ins", starred=False)),
    ref=[act("unstar", kind="document", name="house insurance")]))

S("T37-067", "same-word link add_to photo album kilcorran group-folder-list-lookalikes two-row-linked_to full-name",
  T("can you stick cian's first goal in kilcorran as well", diff(link("hurl_album", "p_cian_goal")),
    ref=[act("add_to", rows="$p_cian_goal", args="to: $hurl_album")]),
  T("which photos of tadhg are in kilcorran", rows("p_hurl_team", "p_hurl_drill", "p_hurl_match"),
    ref=[ans(kind="photo", linked_to="$tadhg, $hurl_album")]),
  T("and what's in kilcorran hurling now",
    rows("p_hurl_team", "p_hurl_drill", "p_hurl_match", "p_hurl_bibs", "p_hurl_pitch", "p_hurl_cup", "p_cian_hurl",
         "p_cian_goal"),
    ref=[ans(kind="photo", linked_to="$hurl_album")]))

S("T37-068", "same-word read both two-events linked-to-all dinner-lookalikes gloss paddys-day",
  T("what dinners have i got coming up", rows("dinner_nuala", "stpat_dinner"),
    ref=[ans(kind="event", name="dinner", when=W({"from": U("day", 0)}))]),
  T("who's at the paddy's day one", rows("aoife"),
    ref=[ans(kind="person", linked_to="$stpat_dinner")]),
  T("and who's at both that and the parade", rows("aoife"),
    ref=[ans(kind="person", linked_to="$stpat_dinner, $stpat")]))

S("T37-069", "same-word settle_debt complete debt-vs-task-vs-person possessor verb-decides",
  T("paid padraig for the minibus, settle it", diff(upd("d_padraig", status="settled")),
    ref=[act("settle_debt", kind="debt", name="minibus", linked_to="$padraig")]),
  T("and tick off the minibus booking, then what's left on the gaa list before the agm",
    rows("gaa_sliotars", "gaa_report", also=diff(upd("gaa_minibus", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="minibus", more=True),
         ans(kind="task", linked_to="$gaa_list", where="status = open", when=W({"to": D("2027-03-18")}))]))

S("T37-070", "same-word star person mary sean nothing-decides-ask gloss topic role-lookup",
  T("star mary", ask("mary_k", "mary_o"),
    ref=[act("star", kind="person", name="mary")]),
  T("the sister-in-law", diff(upd("mary_o", starred=True)),
    ref=[act("star", rows="$mary_o")]),
  T("and who's the gaa chairman", rows("sean_m"),
    ref=[ans(kind="person", where='role = "GAA chairman"')]),
  T("star sean", diff(upd("sean_m", starred=True)),
    ref=[act("star", rows="$sean_m")]))

# ---- create-args: extra clauses around a create ---------------------------------------------------------------------

S("T37-071", "create login username-label url one-per-line implied-type",
  T("can you add the esb login, user liam.obrien61, esb.ie",
    diff(new("locker item", name=has("esb"), type="login", username="liam.obrien61", url=has("esb.ie"))),
    ref=[act("create", args="kind: locker item\nname: ESB login\ntype: login\nusername: liam.obrien61\nurl: esb.ie")]))

S("T37-072", "create locker wifi passport implied-type purpose-clause then jot-down note then jot-down read",
  T("save the wifi at the caravan, the grandkids keep asking for it",
    diff(new("locker item", name=has("caravan"), type="wifi")),
    ref=[act("create", args="kind: locker item\nname: Caravan wifi\ntype: wifi")]),
  T("and maura's passport, add that too",
    diff(new("locker item", name=has("maura", "passport"), type="passport")),
    ref=[act("create", args="kind: locker item\nname: Passport - Maura\ntype: passport")]),
  T("jot down that the caravan wifi changes every june",
    diff(new("note", name=has("caravan"), body=has("june"))),
    ref=[act("create", args="kind: note\nname: Caravan wifi\nbody: the caravan wifi changes every june")]),
  T("what did i jot down about the caravan", rows("+3"),
    ref=[ans(kind="note", name="caravan")]))

S("T37-073", "create task-vs-event call-tradesperson errand two-in-one appointment make-it-clock make-it-duration call-person",
  T("remind me to ring the plumber friday and pick up the hurls from the repair man saturday, the radiator's dripping again",
    diff(new("task", name=has("plumber"), date="2027-03-12"), new("task", name=has("hurls"), date="2027-03-13")),
    ref=[act("create", args="kind: task\nname: Ring the plumber\n" + lines(date=U("week", 0, weekday=5)), more=True),
         act("create", args="kind: task\nname: Pick up the hurls from the repair man\n" +
             lines(date=U("week", 0, weekday=6)))]),
  T("put maura's dentist in the diary thursday the 25th, make it 10",
    diff(new("event", name=has("dentist", "maura"), date="2027-03-25T10:00")),
    ref=[act("create", args="kind: event\nname: Dentist - Maura\n" + lines(date=D("2027-03-25", "10:00")))]),
  T("and a pint with the lads friday at 8, make it two hours",
    diff(new("event", name=has("pint"), date="2027-03-12T20:00", duration=120)),
    ref=[act("create", args="kind: event\nname: Pint with the lads\n" +
             lines(date=U("week", 0, weekday=5, time="20:00")) + "\nduration: 120")]),
  T("and call mary o'brien thursday at 5",
    diff(new("event", name=has("mary"), date="2027-03-11T17:00")),
    ref=[act("create", args="kind: event\nname: Call Mary O'Brien\n" +
             lines(date=U("week", 0, weekday=4, time="17:00")))]))

S("T37-074", "create task-in-list note-in-notebook jot-down album then add_to-new container-link purpose-clause",
  T("add get the gutters cleaned to the house list, due the 27th, and what else is open on there",
    rows("esb_mar", "bins_0309", "bins_0323", "garden_proj", "garden_prune", "garden_shed", "garden_seeds", "garden_lawn",
         also=diff(new("task", name=has("gutters"), date="2027-03-27"), link("house_list", "new"))),
    ref=[act("create", args="kind: task\nname: Get the gutters cleaned\n" + lines(date=D("2027-03-27")) +
             "\nlist: $house_list", more=True),
         ans(kind="task", linked_to="$house_list", where="status = open", exclude="$new")]),
  T("jot down in the garden notebook that i need slug pellets for the lettuces",
    diff(new("note", name=has("slug"), body=has("pellets", "lettuces")), link("garden_nb", "new")),
    ref=[act("create", args="kind: note\nname: Slug pellets\nbody: need slug pellets for the lettuces\nnotebook: $garden_nb")]),
  T("start an album called silver strand for the beach shots",
    diff(new("album", name="Silver Strand")),
    ref=[act("create", args="kind: album\nname: Silver Strand")]),
  T("put saoirse at silver strand in it", diff(link("+3", "p_saoirse_beach")),
    ref=[act("add_to", rows="$p_saoirse_beach", args="to: $new")]))

S("T37-075", "create person role-nickname-label debt-purpose group-currency-purpose created-link",
  T("add dermot shaw, role roofer, goes by dermy, he's quoting for the shed",
    diff(new("person", name="Dermot Shaw", role="roofer", nickname="Dermy")),
    ref=[act("create", args="kind: person\nname: Dermot Shaw\nrole: roofer\nnickname: Dermy")]),
  T("dermy owes me 30 for the lift to the airport, he'll sort it friday",
    diff(new("debt", name=has("airport"), amount=30, direction="owes_me"), link("new", "+1")),
    ref=[act("create", args="kind: debt\nname: airport lift\namount: 30\ndirection: owes_me\nperson: $new")]),
  T("could you start a group for the cheltenham trip in euro, the lads are going in march",
    diff(new("group", name=has("cheltenham"), currency="EUR"), link("new", "me")),
    ref=[act("create", args="kind: group\nname: Cheltenham Trip\ncurrency: EUR")]))

# ---- verb-choice: a short idiom after a write or a read, whose verb is not the surface verb -------------------------

S("T37-076", "verb-choice remove_from document folder put-it-back add_to not-restore then reschedule put-it-back",
  T("take the echo report out of the health folder", diff(unlink("health_f", "echo_report")),
    ref=[act("remove_from", kind="document", name="echo report", args="from: $health_f")]),
  T("put it back", diff(link("health_f", "echo_report")),
    ref=[act("add_to", rows="$echo_report", args="to: $health_f")]),
  T("push the gp check-up to monday", diff(upd("gp", date="2027-03-15T09:30")),
    ref=[act("reschedule", kind="event", name="gp check-up", args=lines(to=U("week", 1, weekday=1)))]),
  T("put it back", diff(upd("gp", date="2027-03-16T09:30")),
    ref=[act("reschedule", rows="$gp", args=lines(to=U("week", 1, weekday=2, time="09:30")))]))

S("T37-077", "verb-choice delete document put-it-back restore not-add_to then photo delete put-it-back undo",
  T("delete the echo report", diff(trash("echo_report")),
    ref=[act("delete", kind="document", name="echo report")]),
  T("put it back", diff(restore("echo_report")),
    ref=[act("restore", rows="$echo_report")]),
  T("delete the frosty pitch photo", diff(trash("p_hurl_pitch"), unlink("hurl_album", "p_hurl_pitch")),
    ref=[act("delete", kind="photo", name="frosty pitch")]),
  T("put it back", diff(restore("p_hurl_pitch"), link("hurl_album", "p_hurl_pitch")),
    ref=[act("undo")]))

S("T37-078", "verb-choice reschedule no-wait-weekday make-it-hour edit-duration fragment",
  T("push the hearing test to monday", diff(upd("hearing", date="2027-03-15T14:00")),
    ref=[act("reschedule", kind="event", name="hearing test", args=lines(to=U("week", 1, weekday=1)))]),
  T("no wait, thursday", diff(upd("hearing", date="2027-03-11T14:00")),
    ref=[act("reschedule", rows="$hearing", args=lines(to=U("week", 0, weekday=4)))]),
  T("make it 3", diff(upd("hearing", date="2027-03-11T15:00")),
    ref=[act("reschedule", rows="$hearing", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("an hour and a half", diff(upd("hearing", duration=90)),
    ref=[act("edit", rows="$hearing", args="duration: 90")]))

S("T37-079", "verb-choice add_to move-task bring-it-back add_to then edit status in-progress then create second-container-same-name",
  T("could you move the minibus booking to the family list",
    diff(link("family_list", "gaa_minibus"), unlink("gaa_list", "gaa_minibus")),
    ref=[act("add_to", kind="task", name="minibus", args="to: $family_list")]),
  T("no, bring it back", diff(link("gaa_list", "gaa_minibus"), unlink("family_list", "gaa_minibus")),
    ref=[act("add_to", rows="$gaa_minibus", args="to: $gaa_list")]),
  T("mark the minibus one in progress, i'm ringing round today", diff(upd("gaa_minibus", status="in_progress")),
    ref=[act("edit", kind="task", name="minibus", args="status: in_progress")]),
  T("and make another family list, one for the grandkids' stuff", diff(new("list", name="Family")),
    ref=[act("create", args="kind: list\nname: Family")]))

S("T37-080", "verb-choice create add-one same-name block-time then log idiom log-a-call",
  T("when's the physio review", rows("physio_review"),
    ref=[ans(kind="event", name="physio review")]),
  T("add one on the 13th of april at 10",
    diff(new("event", name=has("physio", "review"), date="2027-04-13T10:00")),
    ref=[act("create", args="kind: event\nname: Physio review\n" + lines(date=D("2027-04-13", "10:00")))]),
  T("block saturday 2 to 4 for the shed",
    diff(new("event", name=has("shed"), date="2027-03-13T14:00", duration=120)),
    ref=[act("create", args="kind: event\nname: Shed\n" + lines(date=U("week", 0, weekday=6, time="14:00")) +
             "\nduration: 120")]),
  T("just got off the phone with tadhg, log a call", diff(upd("tadhg", date="2027-03-09T10:40")),
    ref=[act("log", kind="person", name="tadhg", args="kind: call")]))

# ---- stop-signals: the gold stops where a model proceeds -----------------------------------------------------------
# a miss is the runtime's (SPEC 4.8): the reference is the by-name call and nothing after it

S("T37-081", "stop read-miss near-hit vault-line-decoy then read-miss near-hit then read-miss empty then write-miss ask",
  T("when's the car insurance due", rows("house_ins", "house_ins26"), decline("not_found"),
    ref=[ans(kind="document", name="car insurance")]),
  T("when's the hearing aid fitting", rows("hearing_aid"), decline("not_found"),
    ref=[ans(kind="event", name="hearing aid fitting")]),
  T("and my roofer's number", rows(), decline("not_found"),
    ref=[ans(kind="person", name="roofer")]),
  T("can you shift the car service across to friday", ask("boiler"),
    ref=[act("reschedule", kind="event", name="car service", args=lines(to=U("week", 0, weekday=5)))]))

S("T37-082", "stop never_mind comma-retraction nonexistent-delete then undo-retraction then middle-retraction",
  T("get rid of the garage task, actually never mind", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("push the hearing test to monday", diff(upd("hearing", date="2027-03-15T14:00")),
    ref=[act("reschedule", kind="event", name="hearing test", args=lines(to=U("week", 1, weekday=1)))]),
  T("no wait, undo that", diff(upd("hearing", date="2027-03-12T14:00")),
    ref=[act("undo")]),
  T("push it to the 15th, no wait forget it, thursday's grand", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T37-083", "stop never_mind after-ask start-retraction then read then self-correcting reschedule",
  T("cancel the minding", ask("grandkids_0310", "grandkids_0317"),
    ref=[act("cancel", kind="event", name="minding cian and saoirse")]),
  T("actually never mind the minding", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's on tomorrow", rows("grandkids_0310"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("move the physio review to friday, no wait, thursday", diff(upd("physio_review", date="2027-03-11T10:00")),
    ref=[act("reschedule", kind="event", name="physio review", args=lines(to=U("week", 0, weekday=4)))]))

S("T37-084", "stop off-topic first-turn then fyi-no-request ask then read then off-topic later-turn decoy",
  T("who won the all-ireland hurling final last year", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("aoife says she's popping over saturday", ask(),
    ref=[askc("Do you want me to put that in your diary?")]),
  T("what's on saturday", rows("hurling_match", "dinner_nuala"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=6)))]),
  T("who's favourite for the hurling this weekend", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T37-085", "stop unbounded everything-except then write-miss trashed-only then all-but-one read then all-but-one star",
  T("delete all my notes except the irish stew one", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("fine, just tick off fix the roof", decline("not_found"),
    ref=[act("complete", kind="task", name="roof")]),
  T("ok then show me everything on the health list except the knee exercises",
    rows("flu_jab", "rx_dec", "rx_jan", "rx_feb", "rx_mar", "hearing_aid", "bp_log", "eye_form", "rx_apr"),
    ref=[ans(kind="task", linked_to="$health_list", exclude="$knee_ex")]),
  T("star every photo in the garden album except the shed one",
    diff(upd("p_gd_roses", starred=True), upd("p_gd_veg", starred=True), upd("p_gd_frost", starred=True)),
    ref=[find(kind="photo", linked_to="$garden_album", exclude="$p_gd_shed"), act("star", rows="@prev")]))

# ---- set-answers: the answer is a subset of what a search, the vault line or the last list shows -------------------

S("T37-086", "set-answers role-noun plumber live-vs-trashed namesake where-role then debts empty then kinship role",
  T("who's my plumber", rows("plumber"),
    ref=[ans(kind="person", where='role = "plumber"')]),
  T("do i owe him anything", rows(),
    ref=[ans(kind="debt", linked_to="$plumber", where="status = open")]),
  T("and who's my brother", rows("declan"),
    ref=[ans(kind="person", where='role = "brother"')]))

S("T37-087", "set-answers role-noun dentist events-lookalikes then next appointment person-link",
  T("who's my dentist", rows("dentist"),
    ref=[ans(kind="person", where='role = "dentist"')]),
  T("when's my next appointment with her", rows("dentist_liam"),
    ref=[ans(kind="event", linked_to="$dentist", when=W({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T37-088", "set-answers two-same-word-events weekday-pick cardiology monday wednesday",
  T("when's the cardiology stuff coming up", rows("cardio", "cardio_bloods"),
    ref=[ans(kind="event", name="cardiology", when=W({"from": U("day", 0)}))]),
  T("just the wednesday one", rows("cardio"),
    ref=[ans(rows="$cardio")]))

S("T37-089", "set-answers parent-task vs subtasks project then in-progress read",
  T("how's the easter project going", rows("easter_proj"),
    ref=[ans(rows="$easter_proj")]),
  T("and which jobs are in progress right now", rows("easter_proj", "camino_proj", "garden_proj"),
    ref=[ans(kind="task", where="status = in_progress")]))

S("T37-090", "set-answers superlative oldest find-order-limit-then-act star settle_debt",
  T("star the oldest photo in the garden album", diff(upd("p_gd_veg", starred=True)),
    ref=[find(kind="photo", linked_to="$garden_album", order="date asc", limit=1), act("star", rows="@prev")]),
  T("and settle the oldest debt i owe", diff(upd("d_mary_k", status="settled")),
    ref=[find(kind="debt", where="direction = i_owe and status = open", order="date asc", limit=1),
         act("settle_debt", rows="@prev")]))
