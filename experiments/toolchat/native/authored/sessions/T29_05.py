from gold import *
import json

world("T29", "2026-09-23T18:10", "Achieng Odhiambo", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


# ---- same-word-pick: a name word that several rows share (T29-066 .. T29-070) ----------------------------

S("T29-066", "r2 same-word link-target add-to group folder photo family members kind-word-decides",
  T("add mama and baba to the family fund",
    diff(link("kisumu_fund", "mama"), link("kisumu_fund", "baba")),
    ref=[act("add_to", rows="$mama, $baba", args=lines(to="$kisumu_fund"))]),
  T("who's in the family fund now", rows("me", "otieno", "akinyi", "aunt_atieno", "mama", "baba"),
    ref=[ans(kind="person", linked_to="$kisumu_fund")]),
  T("and what's in the family folder", rows("land_title", "baba_nhif", "simba_cert"),
    ref=[ans(kind="document", linked_to="$family_f")]),
  T("which photos of mama are in the kisumu album", rows("p_kisumu_family", "p_kisumu_mama"),
    ref=[ans(kind="photo", linked_to="$mama, $kisumu_album")]))

S("T29-067", "r2 same-word possessor-vs-relation debt person baba otieno empty settle",
  T("what do i owe baba", rows(),
    ref=[ans(kind="debt", linked_to="$baba")]),
  T("what about baba's hospital share", rows("d_otieno"),
    ref=[ans(kind="debt", name="hospital share")]),
  T("who's that one owed to", rows("otieno"),
    ref=[ans(kind="person", linked_to="$d_otieno")]),
  T("settle it", diff(upd("d_otieno", status="settled")),
    ref=[act("settle_debt", rows="$d_otieno")]))

S("T29-068", "r2 same-word both documents star topic-decides jersey photo task folder",
  T("what's in the club folder", rows("club_constitution", "club_budget", "jersey_quote"),
    ref=[ans(kind="document", linked_to="$club_f")]),
  T("star the constitution and the jersey one, then show me what's starred in there",
    rows("club_constitution", "jersey_quote",
         also=diff(upd("club_constitution", starred=True), upd("jersey_quote", starred=True))),
    ref=[act("star", rows="$club_constitution, $jersey_quote", more=True),
         ans(kind="document", linked_to="$club_f", where="starred = yes")]),
  T("and the ones that aren't", rows("club_budget"),
    ref=[ans(kind="document", linked_to="$club_f", where="starred = no")]),
  T("and star otieno", ask("otieno", "kevin_o"),
    ref=[act("star", kind="person", name="otieno")]))

S("T29-069", "r2 same-word both-events second-name car-service task-decoy reschedule anchor-row undo put-them-back karen-album",
  T("push the dentist and the car service back a week",
    diff(upd("dentist", date="2026-10-20T08:30"), upd("mot", date="2026-10-07T08:00")),
    ref=[act("reschedule", rows="$dentist, $mot", args=lines(to=U("week", 1, anchor="row")))]),
  T("put them back, changed my mind",
    diff(upd("dentist", date="2026-10-13T08:30"), upd("mot", date="2026-09-30T08:00")),
    ref=[act("undo")]),
  T("what's the car one now", rows("mot"),
    ref=[ans(kind="event", name="car service")]),
  T("put the courtyard sketch and the printed drawing set in the karen album",
    diff(link("site_album", "p_sketch"), link("site_album", "p_drawing_set")),
    ref=[act("add_to", rows="$p_sketch, $p_drawing_set", args=lines(to="$site_album"))]))

S("T29-070", "r2 same-word verb-decides wifi star complete settle-debt locker task debt",
  T("star the kisumu wifi", diff(upd("kisumu_wifi", starred=True)),
    ref=[act("star", kind="locker item", name="kisumu wifi")]),
  T("tick off the wifi, paid it", diff(upd("wifi_pay", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="wifi")]),
  T("and i've paid wambs my half of it, mark that and tell me where i stand with her",
    val((-250, "KES"), also=diff(upd("d_wambui_wifi", status="settled"))),
    ref=[act("settle_debt", kind="debt", name="wifi", more=True),
         ans(op="balance", rows="$wambui")]),
  T("pin the vet's advice note", diff(upd("simba_vet", pinned=True)),
    ref=[act("edit", kind="note", name="advice", args="pinned: yes")]))


# ---- create-args: a create sentence with extra clauses (T29-071 .. T29-075) --------------------------------

S("T29-071", "r2 create-args locker login username-label type-implied wifi inert-purpose star-new",
  T("new login for the nca portal, user a.odhiambo, url nca.go.ke, for the site inspections",
    diff(new("locker item", name=has("nca"), type="login", username="a.odhiambo", url="nca.go.ke")),
    ref=[act("create", args=lines(kind="locker item", name="NCA portal", type="login", username="a.odhiambo",
                                  url="nca.go.ke"))]),
  T("and one for the studio wifi", diff(new("locker item", name=has("studio", "wifi"), type="wifi")),
    ref=[bad(act("create", args=lines(kind="locker item", name="Studio wifi", type="wifi login"))),
         act("create", args=lines(kind="locker item", name="Studio wifi", type="wifi"))]),
  T("star the nca one", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("spoke to the vet this morning, log it", diff(upd("wafula", date=ANY)),
    ref=[search("vet", kind="person"), act("log", rows="$wafula", args="kind: call")]))

S("T29-072", "r2 create-args task-vs-event tradesperson-call appointment errand family-call-event weekday",
  T("call collins about the brake pads on friday",
    diff(new("task", name=has("collins", "brake"), date="2026-09-25")),
    ref=[act("create", args=lines(kind="task", name="Call Collins about the brake pads", date=U("week", 0, weekday=5)))]),
  T("eye test appointment thursday at 11",
    diff(new("event", name=has("eye"), date="2026-09-24T11:00")),
    ref=[act("create", args=lines(kind="event", name="Eye test appointment", date=U("week", 0, weekday=4, time="11:00")))]),
  T("and pick up the roofing samples saturday",
    diff(new("task", name=has("roofing", "samples"), date="2026-09-26")),
    ref=[act("create", args=lines(kind="task", name="Pick up the roofing samples", date=U("week", 0, weekday=6)))]),
  T("call baba saturday at 6pm",
    diff(new("event", name=has("baba"), date="2026-09-26T18:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Baba", date=U("week", 0, weekday=6, time="18:00")))]))

S("T29-073", "r2 create-args person role nickname one-per-line debt inert-clause album purpose-clause",
  T("add jane kamau, a roofer, nickname jay, i need her for the kisumu job",
    diff(new("person", name="Jane Kamau", role="roofer", nickname="Jay")),
    ref=[act("create", args=lines(kind="person", name="Jane Kamau", role="roofer", nickname="Jay"))]),
  T("i owe her 12000 for the roof deposit, i'll pay after the 15th",
    diff(new("debt", name=has("roof", "deposit"), amount=12000, direction="i_owe"), link("new", "+1")),
    ref=[act("create", args=lines(kind="debt", name="Roof deposit", person="$c1", amount="12000", direction="i_owe"))]),
  T("make an album for the kisumu roof job, i'll send it to the insurer",
    diff(new("album", name=has("kisumu", "roof"))),
    ref=[act("create", args=lines(kind="album", name="Kisumu roof job"))]))

S("T29-074", "r2 create-args container-link to-it task-list note-notebook document-folder write-read",
  T("add buy a battery for the gate to the home list, due the 30th, the keypad's dying",
    diff(new("task", name=has("battery", "gate"), date="2026-09-30"), link("home_list", "new")),
    ref=[act("create", args=lines(kind="task", name="Buy a battery for the gate", date=D("2026-09-30"), list="$home_list"))]),
  T("and a note called fish stew in the kitchen notebook, tilapia, coconut milk and tomatoes",
    diff(new("note", name=has("fish", "stew"), body=has("tilapia", "coconut")), link("kitchen_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Fish stew", body="tilapia, coconut milk and tomatoes", notebook="$kitchen_nb"))]),
  T("save a doc called site agreement in contracts",
    diff(new("document", name=has("site", "agreement")), link("contracts_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Site agreement", folder="$contracts_f"))]),
  T("what's in contracts now", rows("karen_contract", "runda_contract", "lease", "+3"),
    ref=[ans(kind="document", linked_to="$contracts_f")]))

S("T29-075", "r2 create-args remind-me-lead card-type-implied group-members one-attribute-per-line add-one-more add-to",
  T("remind me to send gladys the receipts by friday",
    diff(new("task", name=has("send", "gladys", "receipts"), date="2026-09-25")),
    ref=[act("create", args=lines(kind="task", name="Send Gladys the receipts", date=U("week", 0, weekday=5)))]),
  T("add my new stanbic debit card to the locker",
    diff(new("locker item", name=has("stanbic"), type="card")),
    ref=[act("create", args=lines(kind="locker item", name="Stanbic debit card", type="card"))]),
  T("start a group called roof money with akinyi and auntie atieno, we're splitting the bill",
    diff(new("group", name=has("roof", "money")), link("new", "me"), link("new", "akinyi"), link("new", "aunt_atieno")),
    ref=[act("create", args=lines(kind="group", name="Roof money"), more=True),
         act("add_to", rows="$akinyi, $aunt_atieno", args=lines(to="$new"))]),
  T("add one more, mama", diff(link("+3", "mama")),
    ref=[act("add_to", rows="$mama", args=lines(to="$c3"))]))

# ---- verb-choice: a short idiom whose verb is not the surface verb (T29-076 .. T29-080) -------------------

S("T29-076", "r2 verb-choice put-it-back remove-from add-to photo album add-one create-album count",
  T("take the jersey mockup out of the club rides album", diff(unlink("rides_album", "p_ride_jersey")),
    ref=[act("remove_from", kind="photo", name="jersey mockup", args=lines(from_="$rides_album"))]),
  T("put it back", diff(link("rides_album", "p_ride_jersey")),
    ref=[act("add_to", rows="$p_ride_jersey", args=lines(to="$rides_album"))]),
  T("how many albums have i got", val(4),
    ref=[ans(op="count", kind="album")]),
  T("add one for the jersey designs", diff(new("album", name=has("jersey", "designs"))),
    ref=[act("create", args=lines(kind="album", name="Jersey designs"))]))

S("T29-077", "r2 verb-choice put-it-back delete restore photo album not-back-in-album add-to",
  T("delete the jersey mockup", diff(trash("p_ride_jersey"), unlink("rides_album", "p_ride_jersey")),
    ref=[act("delete", kind="photo", name="jersey mockup")]),
  T("put it back", diff(restore("p_ride_jersey")),
    ref=[act("restore", rows="$p_ride_jersey")]),
  T("is it in the club rides album again", rows(),
    ref=[ans(kind="photo", name="jersey mockup", linked_to="$rides_album")]),
  T("no? put it in then", diff(link("rides_album", "p_ride_jersey")),
    ref=[act("add_to", rows="$p_ride_jersey", args=lines(to="$rides_album"))]))

S("T29-078", "r2 verb-choice in-progress edit-status no-wait-weekday reschedule not-undo task",
  T("i've started on the tax return, mark it in progress", diff(upd("tax_return", status="in_progress")),
    ref=[act("edit", kind="task", name="tax return", args="status: in_progress")]),
  T("push the kplc tokens to monday, what else is due monday",
    rows("gas", "inv_faith_c", also=diff(upd("kplc", date="2026-09-28"))),
    ref=[act("reschedule", kind="task", name="kplc tokens", args=lines(to=U("week", 1, weekday=1)), more=True),
         ans(kind="task", where="status = open", when=J(U("week", 1, weekday=1)), exclude="$kplc")]),
  T("no wait, tuesday", diff(upd("kplc", date="2026-09-29")),
    ref=[act("reschedule", rows="$kplc", args=lines(to=U("week", 1, weekday=2)))]),
  T("and mark the roof truss one in progress too", diff(upd("karen_roof", status="in_progress")),
    ref=[act("edit", kind="task", name="roof truss", args="status: in_progress")]))

S("T29-079", "r2 verb-choice make-it-hour reschedule-time not-duration make-it-duration edit-duration an-hour-earlier event",
  T("move the dennis meeting to next thursday", diff(upd("client_dennis", date="2026-10-01T11:00")),
    ref=[act("reschedule", kind="event", name="dennis meeting", args=lines(to=U("week", 1, weekday=4)))]),
  T("make it 4", diff(upd("client_dennis", date="2026-10-01T16:00")),
    ref=[act("reschedule", rows="$client_dennis", args=lines(to=U("week", 1, weekday=4, time="16:00")))]),
  T("make it 90 minutes", diff(upd("client_dennis", duration=90)),
    ref=[act("edit", rows="$client_dennis", args="duration: 90")]),
  T("make it an hour earlier, dennis has another meeting after", diff(upd("client_dennis", date="2026-10-01T15:00")),
    ref=[act("reschedule", rows="$client_dennis", args=lines(to=U("hour", -1, anchor="row")))]))

S("T29-080", "r2 verb-choice log-idiom call-just-happened block-time create-event ask-log-visit kin-mum search-read",
  T("when was the last time i spoke to my mum", rows("mama"),
    ref=[search("mum", kind="person"), ans(rows="$mama")]),
  T("she just called me, we chatted for ages", diff(upd("mama", date=ANY)),
    ref=[act("log", rows="$mama", args="kind: call")]),
  T("block friday 2 to 4 for the drawings, what else is on friday",
    rows("client_faith", "dinner_wambs",
         also=diff(new("event", name=has("drawings"), date="2026-09-25T14:00", duration=120))),
    ref=[act("create", args=lines(kind="event", name="Drawings", date=U("week", 0, weekday=5, time="14:00"), duration="120"),
             more=True),
         ans(kind="event", when=J(U("week", 0, weekday=5)), exclude="$new")]),
  T("log a visit", ask(),
    ref=[askc("Who did you visit?")]))

# ---- stop-signals: the gold stops where the model carries on (T29-081 .. T29-085) -------------------------

S("T29-081", "r2 stop-signal not-found decoy near-hit vault-line wifi birthday lease read-by-name-miss runtime-composed",
  T("what's the office wifi password",
    decline("not_found"), rows("flat_wifi", "kisumu_wifi", "nas_ssh", "old_wifi"),
    ref=[ans(kind="locker item", name="office wifi")]),
  T("ok the flat one then", rows("flat_wifi"),
    ref=[ans(kind="locker item", name="flat wifi")]),
  T("when's mwende's birthday",
    decline("not_found"), rows("baba_bday", "ian_bday"),
    ref=[ans(kind="event", name="mwende birthday")]),
  T("is there a kisumu house lease in my documents",
    decline("not_found"), rows("kisumu_wifi_task", "kisumu_house", "kisumu_wifi"),
    ref=[ans(kind="document", name="kisumu house lease")]))

S("T29-082", "r2 stop-signal never-mind end middle start delete-nonexistent ask no-wait-day",
  T("delete the lamu trip album, nah forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("move the site visit to thursday", ask("karen_site_0929", "runda_site_0924", "runda_site_1001"),
    ref=[act("reschedule", kind="event", name="site visit", args=lines(to=U("week", 0, weekday=4)))]),
  T("actually forget it, i'll see kevin on friday", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("wipe the gym task, nah keep it, i renew tomorrow", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T29-083", "r2 stop-signal fyi no-request ask then reschedule date-narrow",
  T("faith rang, friday's no good for her", ask(),
    ref=[askc("Want me to move the design review to another day?")]),
  T("yeah monday at 9 instead", diff(upd("client_faith", date="2026-09-28T09:00")),
    ref=[act("reschedule", kind="event", name="design review", when=J(U("week", 0, weekday=5)),
             args=lines(to=U("week", 1, weekday=1, time="09:00")))]))

S("T29-084", "r2 stop-signal unbounded-destruction everything-except-one tasks photos delete bring-it-back restore",
  T("delete all my tasks except the rent one", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("ok just the gym one then", diff(trash("gym")),
    ref=[act("delete", kind="task", name="gym")]),
  T("bring it back", diff(restore("gym")),
    ref=[act("restore", rows="$gym")]),
  T("clear out all the photos apart from simba's", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T29-085", "r2 stop-signal out-of-scope off-topic weather exchange-rate write-by-name-miss not-found decoy fyi-decline",
  T("is it going to rain on saturday for the ride", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("what's the kes to euro rate today", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("cancel the yoga on saturday", decline("not_found"),
    ref=[act("cancel", kind="event", name="yoga", when=J(U("week", 0, weekday=6)))]),
  T("it rained all night in kisumu", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

# ---- set-answers: the answer is a subset of what the lookup shows (T29-086 .. T29-090) ---------------------

S("T29-086", "r2 set-answer role-noun best-friend exact-role friends dentist namesake",
  T("who's my best friend", rows("brenda"),
    ref=[ans(kind="person", where='role = "best friend"')]),
  T("and my other friends", rows("ian", "naomi", "amina"),
    ref=[ans(kind="person", where='role = "friend"')]),
  T("who's my dentist", rows("doreen"),
    ref=[ans(kind="person", where='role = "dentist"')]),
  T("and my clients", rows("faith", "dennis"),
    ref=[ans(kind="person", where='role = "client"')]))

S("T29-087", "r2 set-answer debts both-directions wambui owes-me i-owe subset settle kin-aunt star pick",
  T("what does wambs owe me", rows("d_wambui_tokens"),
    ref=[ans(kind="debt", linked_to="$wambui", where="direction = owes_me and status = open")]),
  T("and the one i still have to pay her", rows("d_wambui_wifi"),
    ref=[ans(kind="debt", linked_to="$wambui", where="direction = i_owe and status = open")]),
  T("settle the one she owes me", diff(upd("d_wambui_tokens", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$wambui", where="direction = owes_me")]),
  T("and star my aunt", diff(upd("aunt_atieno", starred=True)),
    ref=[find(kind="person", where='role = "aunt"'), act("star", rows="@prev")]))

S("T29-088", "r2 set-answer same-word events weekday-decides vet grooming reschedule put-it-back-reschedule",
  T("what time's the vet on saturday", rows("vet_vacc"),
    ref=[ans(kind="event", name="vet", when=J(U("week", 0, weekday=6)))]),
  T("and the grooming on sunday", rows("groom"),
    ref=[ans(kind="event", name="grooming", when=J(U("week", 0, weekday=7)))]),
  T("move that to monday", diff(upd("groom", date="2026-09-28T11:00")),
    ref=[act("reschedule", rows="$groom", args=lines(to=U("week", 1, weekday=1)))]),
  T("actually put it back", diff(upd("groom", date="2026-09-27T11:00")),
    ref=[act("reschedule", rows="$groom", args=lines(to=U("week", 0, weekday=7)))]))

S("T29-089", "r2 set-answer parent-task subtasks runda in-progress left within effort-over-an-hour",
  T("is the runda extension in progress", rows("runda"),
    ref=[ans(kind="task", name="runda extension")]),
  T("what's left under it", rows("runda_concept", "runda_inv", "runda_submit", "runda_neighbours"),
    ref=[ans(kind="task", linked_to="$runda", where="status = open")]),
  T("are any of those still over an hour", rows("runda_concept"),
    ref=[ans(within="@prev", where="effort > 60")]))

S("T29-090", "r2 set-answer superlative oldest newest find-order-limit then-act unstar pin undo note photo",
  T("unstar the oldest photo of simba", diff(upd("p_simba_pup", starred=False)),
    ref=[find(kind="photo", name="simba", order="date asc", limit=1),
         act("unstar", rows="@1")]),
  T("pin the newest note in site notes", diff(upd("karen_site3", pinned=True)),
    ref=[find(kind="note", linked_to="$site_nb", order="date desc", limit=1),
         act("edit", rows="@2", args="pinned: yes")]),
  T("actually no, undo that", diff(upd("karen_site3", pinned=False)),
    ref=[act("undo")]),
  T("what's the oldest note in the kitchen notebook", rows("pilau"),
    ref=[ans(kind="note", linked_to="$kitchen_nb", order="date asc", limit=1)]))
