from gold import *
import json
def J(d):
    return json.dumps(d, separators=(",", ":"))
X("T29-040",
  T("and how many of those take half an hour or more", val(3),
    ref=[ans(op="count", kind="task", where="status = open and effort >= 30 minutes", when=J(U("week", 0)))]))
X("T29-046",
  T("now push the rest of the home tasks due this week to monday",
    diff(upd("mpesa_float", date="2026-09-28"), upd("kplc", date="2026-09-28")),
    ref=[find(kind="task", linked_to="$home_list", where="status = open", when=J(U("week", 0))),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]))
X("T29-047",
  T("and move the faith design review to monday", ask("client_faith", "client_faith2"),
    ref=[act("reschedule", kind="event", name="design review", linked_to="$faith",
             args=lines(to=U("week", 1, weekday=1)))]))
X("T29-026",
  T("any airport transfer booked for the 22nd", rows(),
    ref=[search("transfer"), ans(kind="event", name="transfer", when=J(D("2026-10-22")))]))
X("T29-053",
  T("next doctor's appointment?", rows(),
    ref=[search("doctor"), ans(kind="event", name="doctor", when=J({"from": U("day", 0)}), order="date asc", limit=1)]))
X("T29-037",
  T("and my old safaricom login, bring it back", diff(restore("old_login")),
    ref=[act("restore", kind="locker item", name="safaricom login", trashed=True)]))

S("T29-002-P", "decoy-invoices ask date-narrow complete what-else exclude para",
  T("faith invoice is done, tick it", ask("inv_faith_sep", "inv_faith_c"),
    ref=[act("complete", kind="task", name="faith invoice")]),
  T("the friday one", diff(upd("inv_faith_sep", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="faith invoice", when=J(U("week", 0, weekday=5)))]),
  T("besides those, what's open for faith", rows("karen_tiles"),
    ref=[ans(kind="task", linked_to="$faith", where="status = open", exclude="$inv_faith_sep, $inv_faith_c")]))

S("T29-006-P", "role-search accountant event task-count order-limit reschedule ordinal para",
  T("accountant visit, when is it", rows("tax_meeting"),
    ref=[search("accountant"), ans(kind="event", linked_to="$gladys")]),
  T("open tasks about tax?", rows("tax_docs", "tax_return"),
    ref=[ans(kind="task", name="tax", where="status = open")]),
  T("earliest due of those", rows("tax_docs"),
    ref=[ans(within="@prev", order="date asc", limit=1)]),
  T("make it the 12th", diff(upd("tax_docs", date="2026-10-12")),
    ref=[act("reschedule", rows="$tax_docs", args=lines(to=D("2026-10-12")))]))

S("T29-010-P", "documents folder starred year-narrow star month para",
  T("contracts folder, starred documents", rows("karen_contract", "lease"),
    ref=[ans(kind="document", linked_to="$contracts_f", where="starred = yes")]),
  T("unstarred ones in there?", rows("runda_contract"),
    ref=[ans(kind="document", linked_to="$contracts_f", where="starred = no")]),
  T("give that one a star", diff(upd("runda_contract", starred=True)),
    ref=[act("star", rows="$runda_contract")]),
  T("invoices dated august, got any", rows("inv_karen_aug", "inv_runda_aug"),
    ref=[ans(kind="document", name="invoice", when=J(U("month", 0, name=8)))]))

S("T29-013-P", "trashed list restore task event past-window para",
  T("tasks sitting in the trash, which", rows("old_ar", "old_flat"),
    ref=[ans(kind="task", trashed=True)]),
  T("restore the rose one", diff(restore("old_ar")),
    ref=[act("restore", kind="task", name="rose", trashed=True)]),
  T("restore the meeting with her as well", diff(restore("old_meet")),
    ref=[act("restore", kind="event", name="meeting with rose", trashed=True)]),
  T("also the old agent, hezekiah", decline("not_found"),
    ref=[act("restore", kind="person", name="hezekiah", trashed=True)]))

S("T29-017-P", "create event edit-duration clash-ask create-evening para",
  T("physio appointment tomorrow at 10am, add it", diff(new("event", name=has("physio"), date="2026-09-24T10:00")),
    ref=[act("create", args=lines(kind="event", name="Physio", date=U("day", 1, time="10:00")))]),
  T("90 minutes long instead", diff(upd("+1", duration=90)),
    ref=[act("edit", rows="$c1", args="duration: 90")]),
  T("dinner friday 8pm as well", ask("dinner_wambs"),
    ref=[act("create", args=lines(kind="event", name="Dinner", date=U("week", 0, weekday=5, time="20:00")))]))

S("T29-021-P", "star-selector two-writes unstar para",
  T("juma's photos in the club rides album all get starred, and the sunrise one loses its star",
    diff(upd("p_ride_group", starred=True), upd("p_ride_ngong", starred=True), upd("p_ride_chai", starred=True),
         upd("p_ride_sunrise", starred=False)),
    ref=[find(kind="photo", linked_to="$juma, $rides_album"),
         act("star", rows="@1", more=True),
         act("unstar", kind="photo", name="sunrise")]))

S("T29-024-P", "bulk-ask delete-finished confirm para",
  T("get rid of every finished task", ask(),
    ref=[find(kind="task", where="status = completed"),
         act("delete", rows="@1")]),
  T("yep, do it",
    diff(trash("karen_nca"), trash("karen_pour"), trash("inv_faith_aug"), trash("runda_survey"), trash("runda_inv_aug"),
         trash("rent_sep"), trash("rent_aug"), trash("vacc_task"), trash("dog_food_old"), trash("car_serv"),
         trash("kit_sizes"), trash("kitty_dues_aug"), trash("book_flight")),
    ref=[act("delete", rows="@1")]))

S("T29-028-P", "search-empty ask-recover role-search planning para",
  T("my physio, who", rows(),
    ref=[search("physio"), ans(kind="person", name="physio")]),
  T("next time i meet the planning officer, when", rows("planning"),
    ref=[search("planning officer"),
         ans(kind="event", linked_to="$mwanaisha", when=J({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T29-032-P", "find-bulk reschedule friday-tasks narrow-person para",
  T("move every task due friday to monday",
    diff(upd("karen_tiles", date="2026-09-28"), upd("inv_faith_sep", date="2026-09-28"), upd("mama_meds", date="2026-09-28")),
    ref=[find(kind="task", where="status = open", when=J(U("week", 0, weekday=5))),
         act("reschedule", rows="@1", args=lines(to=U("week", 1, weekday=1)))]),
  T("faith ones only", rows("karen_tiles", "inv_faith_sep"),
    ref=[ans(within="@prev", linked_to="$faith")]))

S("T29-035-P", "find-bulk add-to move-docs month folder-read para",
  T("archive folder gets all the documents from august",
    diff(link("archive_f", "inv_karen_aug"), unlink("invoices_f", "inv_karen_aug"),
         link("archive_f", "inv_runda_aug"), unlink("invoices_f", "inv_runda_aug"),
         link("archive_f", "runda_survey_doc"), unlink("permits_f", "runda_survey_doc"),
         link("archive_f", "jersey_quote"), unlink("club_f", "jersey_quote")),
    ref=[find(kind="document", when=J(U("month", 0, name=8))),
         act("add_to", rows="@1", args="to: $archive_f")]),
  T("archive contents now?", rows("inv_karen_aug", "inv_runda_aug", "runda_survey_doc", "jersey_quote"),
    ref=[ans(kind="document", linked_to="$archive_f")]))

S("T29-039-P", "decline-fabricated read-wifi never-mind out-of-scope para",
  T("the kisumu house needs a new wifi password, make one up", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("ok the current one then, what is it", rows("kisumu_wifi"),
    ref=[ans(kind="locker item", name="kisumu wifi")]),
  T("send mama a text saying i'm landing at 8", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T29-043-P", "two-writes complete reschedule left-this-week para",
  T("kplc tokens is done, and the gas moves to friday",
    diff(upd("kplc", status="completed", completed=ANY), upd("gas", date="2026-09-25")),
    ref=[act("complete", kind="task", name="kplc tokens", more=True),
         act("reschedule", kind="task", name="gas", args=lines(to=U("week", 0, weekday=5)))]))

S("T29-046-P", "where-four person-count narrow-when two-writes complete para",
  T("open tasks of 30 minutes or longer, without a priority, and not tied to anyone",
    rows("dog_food", "flat_fix", "kitty_report", "tax_docs", "insurance", "bike_service"),
    ref=[ans(kind="task", where="status = open and effort >= 30 minutes and priority is empty and person count = 0")]),
  T("due before october, among those", rows("dog_food", "flat_fix", "kitty_report", "bike_service"),
    ref=[ans(within="@prev", when=J({"to": D("2026-09-30")}))]),
  T("dog food and kitty spreadsheet are done, tick both",
    diff(upd("dog_food", status="completed", completed=ANY), upd("kitty_report", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="dog food", more=True),
         act("complete", kind="task", name="kitty spreadsheet")]))

S("T29-050-P", "ask-missing create-group members-new two-calls para",
  T("start a new group", ask(),
    ref=[askc("What should the group be called, and which currency?")]),
  T("call it weekend riders, shillings, kip and juma in it",
    diff(new("group", name="Weekend Riders", currency="KES"), link("new", "me"), link("new", "kip"), link("new", "juma")),
    ref=[act("create", args=lines(kind="group", name="Weekend Riders", currency="KES"), more=True),
         act("add_to", rows="$kip, $juma", args="to: $new")]),
  T("members?", rows("me", "kip", "juma"),
    ref=[ans(kind="person", linked_to="$c1")]))

S("T29-054-P", "repair-unit container-subtasks narrow where when exclude write-read role-search log para",
  T("karen house, which sub-tasks are open",
    rows("karen_dwgs", "karen_roof", "karen_boq", "karen_tiles", "inv_faith_sep", "karen_mockup"),
    ref=[ans(kind="task", linked_to="$karen", where="status = open")]),
  T("any that need an hour or more", rows("karen_dwgs", "karen_roof", "karen_boq", "karen_tiles"),
    ref=[bad(ans(within="@prev", where="effort >= 1 hour")),
         ans(within="@prev", where="effort >= 60 minutes")]),
  T("due on or before the 30th", rows("karen_roof", "karen_tiles"),
    ref=[ans(within="@prev", when=J({"to": D("2026-09-30")}))]),
  T("everything except the tiles one", rows("karen_roof"),
    ref=[ans(within="@prev", exclude="$karen_tiles")]),
  T("monday week for it, plus what else is due then",
    rows("rent_oct", also=diff(upd("karen_roof", date="2026-10-05"))),
    ref=[act("reschedule", rows="$karen_roof", args=lines(to=U("week", 2, weekday=1)), more=True),
         ans(kind="task", where="status = open", when=J(U("week", 2, weekday=1)), exclude="$karen_roof")]),
  T("engineer, log a call", diff(upd("peter", date=ANY)),
    ref=[search("engineer"), act("log", rows="$peter", args="kind: call")]))

S("T29-058-P", "compute-max value order-limit decline-text repair-create-field count-open para",
  T("largest amount owed to me?", val((5000, "KES")),
    ref=[comp(op="max", field="amount", kind="debt", where="direction = owes_me and status = open"),
         ans(value="@1")]),
  T("whose is it", rows("d_naomi"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open", order="amount desc", limit=1)]),
  T("send her a text about it", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("on friday i need to chase her for it, add a task", diff(new("task", name=has("chase"), date="2026-09-25")),
    ref=[bad(act("create", args="kind: task\nname: Chase Naomi for the bus fare\ndue: friday")),
         act("create", args=lines(kind="task", name="Chase Naomi for the bus fare", date=U("week", 0, weekday=5)))]),
  T("total number of open debts", val(10),
    ref=[ans(op="count", kind="debt", where="status = open")]))

S("T29-061-P", "debts bulk settle-debt over-ten-thousand before-august sum owes-me year repair-sum-field ambiguous-debt para",
  T("from before august, settle my debts over 10000",
    diff(upd("d_lena", status="settled"), upd("d_otieno", status="settled")),
    ref=[find(kind="debt", where="direction = i_owe and status = open and amount > 10000", when=J({"to": D("2026-07-31")})),
         act("settle_debt", rows="@prev")]),
  T("total owed to me this year, all in", val((8300, "KES")),
    ref=[bad(ans(op="sum", kind="debt", where="direction = owes_me and status = open", when=J(U("year", 0)))),
         ans(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open", when=J(U("year", 0)))]),
  T("wambs' debt, settle it", ask("d_wambui_wifi", "d_wambui_tokens"),
    ref=[act("settle_debt", kind="debt", linked_to="$wambui")]),
  T("wifi", diff(upd("d_wambui_wifi", status="settled")),
    ref=[act("settle_debt", kind="debt", name="wifi", linked_to="$wambui")]))

S("T29-064-P", "photos docs trash bulk-star september count-person-count exclude archive past-window restore search-miss ambiguous-note pin para",
  T("unstarred things in the karen site album from september, give them stars",
    diff(upd("p_site_cols", starred=True), upd("p_site_slab", starred=True), upd("p_site_rain", starred=True),
         upd("p_site_visit", starred=True), upd("p_site_truss", starred=True)),
    ref=[find(kind="photo", linked_to="$site_album", where="starred = no", when=J(U("month", 0, name=9))),
         act("star", rows="@prev")]),
  T("count the starred ones that have a person in them", val(5),
    ref=[ans(op="count", kind="photo", where="starred = yes and person count >= 1")]),
  T("except the constitution, move this year's club docs into the archive folder",
    diff(link("archive_f", "club_budget"), unlink("club_f", "club_budget"),
         link("archive_f", "jersey_quote"), unlink("club_f", "jersey_quote")),
    ref=[find(kind="document", linked_to="$club_f", when=J(U("year", 0)), exclude="$club_constitution"),
         act("add_to", rows="@prev", args="to: $archive_f")]),
  T("in site notes, pin the karen meeting note", ask("karen_site1", "karen_site2", "karen_site3"),
    ref=[act("edit", kind="note", name="karen meeting", linked_to="$site_nb", args="pinned: yes")]),
  T("the one from yesterday", diff(upd("karen_site3", pinned=True)),
    ref=[act("edit", kind="note", name="karen meeting", when=J(U("day", -1)), args="pinned: yes")]),
  T("restore the old quote template too", decline("not_found"),
    ref=[act("restore", kind="document", name="old quote template", trashed=True)]),
  T("restore the august meeting with rose", diff(restore("old_meet")),
    ref=[act("restore", kind="event", name="meeting with rose", when=J(U("month", 0, name=8)), trashed=True)]),
  T("she's a client again, so bring rose wanjala back", diff(restore("old_client")),
    ref=[act("restore", kind="person", name="rose wanjala", trashed=True)]),
  T("lamu trip photos from august, any", rows(),
    ref=[search("lamu"), ans(kind="photo", name="lamu", when=J(U("month", 0, name=8)))]),
  T("electrician for karen site?", rows(),
    ref=[search("electrician"), ans(kind="person", name="electrician")]))

S("T29-067-P", "r2 same-word possessor-vs-relation debt person baba otieno empty settle para",
  T("baba, what do i owe him", rows(),
    ref=[ans(kind="debt", linked_to="$baba")]),
  T("and the hospital share with baba", rows("d_otieno"),
    ref=[ans(kind="debt", name="hospital share")]),
  T("that one's owed to whom", rows("otieno"),
    ref=[ans(kind="person", linked_to="$d_otieno")]),
  T("mark it settled", diff(upd("d_otieno", status="settled")),
    ref=[act("settle_debt", rows="$d_otieno")]))

S("T29-071-P", "r2 create-args locker login username-label type-implied wifi inert-purpose star-new para",
  T("nca portal login please, username a.odhiambo, url nca.go.ke, it's for the site inspections",
    diff(new("locker item", name=has("nca"), type="login", username="a.odhiambo", url="nca.go.ke")),
    ref=[act("create", args=lines(kind="locker item", name="NCA portal", type="login", username="a.odhiambo",
                                  url="nca.go.ke"))]),
  T("studio wifi as well", diff(new("locker item", name=has("studio", "wifi"), type="wifi")),
    ref=[bad(act("create", args=lines(kind="locker item", name="Studio wifi", type="wifi login"))),
         act("create", args=lines(kind="locker item", name="Studio wifi", type="wifi"))]),
  T("nca one gets a star", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("this morning i spoke to the vet, put it in the log", diff(upd("wafula", date=ANY)),
    ref=[search("vet", kind="person"), act("log", rows="$wafula", args="kind: call")]))

S("T29-074-P", "r2 create-args container-link to-it task-list note-notebook document-folder write-read para",
  T("the keypad's dying, so put buy a battery for the gate on the home list, due the 30th",
    diff(new("task", name=has("battery", "gate"), date="2026-09-30"), link("home_list", "new")),
    ref=[act("create", args=lines(kind="task", name="Buy a battery for the gate", date=D("2026-09-30"), list="$home_list"))]),
  T("kitchen notebook gets a note called fish stew, saying tilapia, coconut milk and tomatoes",
    diff(new("note", name=has("fish", "stew"), body=has("tilapia", "coconut")), link("kitchen_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Fish stew", body="tilapia, coconut milk and tomatoes", notebook="$kitchen_nb"))]),
  T("doc named site agreement goes into contracts",
    diff(new("document", name=has("site", "agreement")), link("contracts_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Site agreement", folder="$contracts_f"))]),
  T("contracts contents now?", rows("karen_contract", "runda_contract", "lease", "+3"),
    ref=[ans(kind="document", linked_to="$contracts_f")]))

S("T29-078-P", "r2 verb-choice in-progress edit-status no-wait-weekday reschedule not-undo task para",
  T("tax return is under way, set it to in progress", diff(upd("tax_return", status="in_progress")),
    ref=[act("edit", kind="task", name="tax return", args="status: in_progress")]),
  T("monday for the kplc tokens, and what else is due monday",
    rows("gas", "inv_faith_c", also=diff(upd("kplc", date="2026-09-28"))),
    ref=[act("reschedule", kind="task", name="kplc tokens", args=lines(to=U("week", 1, weekday=1)), more=True),
         ans(kind="task", where="status = open", when=J(U("week", 1, weekday=1)), exclude="$kplc")]),
  T("make that tuesday", diff(upd("kplc", date="2026-09-29")),
    ref=[act("reschedule", rows="$kplc", args=lines(to=U("week", 1, weekday=2)))]),
  T("roof truss one is in progress as well, set it", diff(upd("karen_roof", status="in_progress")),
    ref=[act("edit", kind="task", name="roof truss", args="status: in_progress")]))

S("T29-082-P", "r2 stop-signal never-mind end middle start delete-nonexistent ask no-wait-day para",
  T("get rid of the lamu trip album, no wait, forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("site visit needs to be thursday", ask("karen_site_0929", "runda_site_0924", "runda_site_1001"),
    ref=[act("reschedule", kind="event", name="site visit", args=lines(to=U("week", 0, weekday=4)))]),
  T("forget it, i'm seeing kevin friday anyway", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("gym task, clear it out, nah keep it, i renew tomorrow", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T29-085-P", "r2 stop-signal out-of-scope off-topic weather exchange-rate write-by-name-miss not-found decoy fyi-decline para",
  T("rain on saturday for the ride, will there be any", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("kes to euro today, what's the rate", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("saturday's yoga is off, cancel it", decline("not_found"),
    ref=[act("cancel", kind="event", name="yoga", when=J(U("week", 0, weekday=6)))]),
  T("all night in kisumu it rained", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T29-089-P", "r2 set-answer parent-task subtasks runda in-progress left within effort-over-an-hour para",
  T("runda extension, is it in progress", rows("runda"),
    ref=[ans(kind="task", name="runda extension")]),
  T("what remains beneath it", rows("runda_concept", "runda_inv", "runda_submit", "runda_neighbours"),
    ref=[ans(kind="task", linked_to="$runda", where="status = open")]),
  T("any of them still more than an hour", rows("runda_concept"),
    ref=[ans(within="@prev", where="effort > 60")]))
