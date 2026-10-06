from gold import *
import json

world("T29", "2026-09-23T18:10", "Achieng Odhiambo", "train")

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T29-001", "list open week narrowing person complete reschedule two-writes",
  T("what's open on the karen list this week", rows("karen_mockup", "karen_tiles", "inv_faith_sep"),
    ref=[ans(kind="task", linked_to="$karen_list", where="status = open", when=J(U("week", 0)))]),
  T("which of those are for faith", rows("karen_tiles", "inv_faith_sep"),
    ref=[ans(within="@prev", linked_to="$faith")]),
  T("tick off the invoice one and push the tiles to monday",
    diff(upd("inv_faith_sep", status="completed", completed=ANY), upd("karen_tiles", date="2026-09-28")),
    ref=[act("complete", rows="$inv_faith_sep", more=True),
         act("reschedule", rows="$karen_tiles", args=lines(to=U("week", 1, weekday=1)))]))

S("T29-002", "decoy-invoices ask date-narrow complete what-else exclude",
  T("tick off the faith invoice", ask("inv_faith_sep", "inv_faith_c"),
    ref=[act("complete", kind="task", name="faith invoice")]),
  T("the one due friday", diff(upd("inv_faith_sep", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="faith invoice", when=J(U("week", 0, weekday=5)))]),
  T("what else is still open for faith", rows("karen_tiles"),
    ref=[ans(kind="task", linked_to="$faith", where="status = open", exclude="$inv_faith_sep, $inv_faith_c")]))

S("T29-003", "balance person group-balance me-search superlative debts settle write-read",
  T("where am i with wambs", val((-2000, "KES")),
    ref=[ans(op="balance", rows="$wambui")]),
  T("and my share of the flat bills", val((-1450, "KES")),
    ref=[search("Achieng", kind="person"),
         ans(op="balance", kind="group", name="Kilimani Flat Bills", linked_to="$me")]),
  T("biggest debt i owe", rows("d_otieno"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount desc", limit=1)]),
  T("smallest owed to me?", rows("d_juma_chai"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open", order="amount asc", limit=1)]),
  T("settle that one and show me what's still owed to me",
    rows("d_kevin_m", "d_wambui_tokens", "d_naomi", also=diff(upd("d_juma_chai", status="settled"))),
    ref=[act("settle_debt", rows="$d_juma_chai", more=True),
         ans(kind="debt", where="direction = owes_me and status = open")]))

S("T29-004", "name month-name within pick people reschedule",
  T("which club rides are on in october", rows("ride_1003", "ride_1010", "ride_1017", "ride_1024", "ride_1031"),
    ref=[ans(kind="event", name="club ride", when=J(U("month", 0, name=10)))]),
  T("the ngong hills one", rows("ride_1031"),
    ref=[ans(within="@prev", name="ngong hills")]),
  T("who from the riders is coming to it", rows("kip", "kevin_m"),
    ref=[ans(kind="person", linked_to="$riders, $ride_1031")]),
  T("start it at 7am instead", diff(upd("ride_1031", date="2026-10-31T07:00")),
    ref=[act("reschedule", rows="$ride_1031", args=lines(to=D("2026-10-31", "07:00")))]))

S("T29-005", "ambiguous-person ask log role-narrow next-event substitution",
  T("log a coffee with kevin", ask("kevin_m", "kevin_o"),
    ref=[act("log", kind="person", name="kevin", args="kind: coffee")]),
  T("the one from the club", diff(upd("kevin_m", date=ANY)),
    ref=[act("log", kind="person", name="kevin", linked_to="$riders", args="kind: coffee")]),
  T("what's the next thing i've got with him", rows("ride_0926"),
    ref=[ans(kind="event", linked_to="$kevin_m", when=J({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T29-006", "role-search accountant event task-count order-limit reschedule ordinal",
  T("when am i seeing the accountant", rows("tax_meeting"),
    ref=[search("accountant"), ans(kind="event", linked_to="$gladys")]),
  T("any tax tasks still open", rows("tax_docs", "tax_return"),
    ref=[ans(kind="task", name="tax", where="status = open")]),
  T("which one's due first", rows("tax_docs"),
    ref=[ans(within="@prev", order="date asc", limit=1)]),
  T("push it to the 12th", diff(upd("tax_docs", date="2026-10-12")),
    ref=[act("reschedule", rows="$tax_docs", args=lines(to=D("2026-10-12")))]))

S("T29-007", "role-search vet event-span photos album-year starred-narrow reschedule",
  T("what's coming up with the vet", rows("vet_vacc", "vet_followup"),
    ref=[search("vet", kind="person"),
         ans(kind="event", linked_to="$wafula", when=J({"from": U("day", 0)}))]),
  T("move the vaccination to monday morning at 9", diff(upd("vet_vacc", date="2026-09-28T09:00")),
    ref=[act("reschedule", kind="event", name="vaccination", args=lines(to=U("week", 1, weekday=1, time="09:00")))]),
  T("photos of simba from this year", rows("p_simba_beach", "p_simba_sofa", "p_simba_vet", "p_simba_karura", "p_simba_groom"),
    ref=[ans(kind="photo", name="simba", when=J(U("year", 0)))]),
  T("only the starred ones", rows("p_simba_karura"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T29-008", "folder trashed-read restore ask-folder",
  T("what's in the archive folder's trash", rows("old_contract", "old_quote"),
    ref=[ans(kind="document", linked_to="$archive_f", trashed=True)]),
  T("bring back the rose wanjala contract", diff(restore("old_contract")),
    ref=[act("restore", kind="document", name="rose wanjala contract", trashed=True)]),
  T("now delete the archive folder", ask("old_contract", "old_quote"),
    ref=[act("delete", rows="$archive_f")]))

S("T29-009", "notes month body-contains narrow notebook pin what-else exclude",
  T("notes from september that mention rain", rows("karen_site2", "diary_tough"),
    ref=[ans(kind="note", where='body contains "rain"', when=J(U("month", 0, name=9)))]),
  T("just the one in site notes", rows("karen_site2"),
    ref=[ans(within="@prev", linked_to="$site_nb")]),
  T("pin it", diff(upd("karen_site2", pinned=True)),
    ref=[act("edit", rows="$karen_site2", args="pinned: yes")]),
  T("what else is pinned", rows("planning_checklist", "club_rules", "simba_food"),
    ref=[ans(kind="note", where="pinned = yes", exclude="$karen_site2")]),
  T("which of those mention beef", rows("simba_food"),
    ref=[ans(within="@prev", where='body contains "beef"')]))

S("T29-010", "documents folder starred year-narrow star month",
  T("starred docs in the contracts folder", rows("karen_contract", "lease"),
    ref=[ans(kind="document", linked_to="$contracts_f", where="starred = yes")]),
  T("and the ones that aren't starred", rows("runda_contract"),
    ref=[ans(kind="document", linked_to="$contracts_f", where="starred = no")]),
  T("star that one", diff(upd("runda_contract", starred=True)),
    ref=[act("star", rows="$runda_contract")]),
  T("any invoices from august", rows("inv_karen_aug", "inv_runda_aug"),
    ref=[ans(kind="document", name="invoice", when=J(U("month", 0, name=8)))]))

S("T29-011", "photos person-album exclude star starred since",
  T("photos of kip in the club rides album", rows("p_ride_sunrise", "p_ride_group", "p_ride_ngong"),
    ref=[ans(kind="photo", linked_to="$kip, $rides_album")]),
  T("all but the group one", rows("p_ride_sunrise", "p_ride_ngong"),
    ref=[ans(kind="photo", linked_to="$kip, $rides_album", exclude="$p_ride_group")]),
  T("star the ngong one", diff(upd("p_ride_ngong", starred=True)),
    ref=[act("star", rows="$p_ride_ngong")]),
  T("which ones in that album are starred now", rows("p_ride_sunrise", "p_ride_ngong"),
    ref=[ans(kind="photo", linked_to="$rides_album", where="starred = yes")]),
  T("and the unstarred photos of kevin mwangi", rows("p_ride_group", "p_ride_flat"),
    ref=[ans(kind="photo", linked_to="$kevin_m", where="starred = no")]))

S("T29-012", "wifi two-rows reveal egress locker-type starred",
  T("what's the wifi password", rows("flat_wifi", "kisumu_wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("the kisumu one, show me", diff(reveal=[("kisumu_wifi", "Milimani2026")]),
    ref=[act("reveal", rows="$kisumu_wifi", args="field: password")]),
  T("text it to akinyi", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("which logins have i starred", rows("equity_login"),
    ref=[ans(kind="locker item", where="type = login and starred = yes")]))

S("T29-013", "trashed list restore task event past-window",
  T("tasks in the trash?", rows("old_ar", "old_flat"),
    ref=[ans(kind="task", trashed=True)]),
  T("bring back the one about rose", diff(restore("old_ar")),
    ref=[act("restore", kind="task", name="rose", trashed=True)]),
  T("and the meeting with her", diff(restore("old_meet")),
    ref=[act("restore", kind="event", name="meeting with rose", trashed=True)]),
  T("and hezekiah the old agent", decline("not_found"),
    ref=[act("restore", kind="person", name="hezekiah", trashed=True)]))

S("T29-014", "undo complete due-day narrow-person",
  T("tick off the gas one", diff(upd("gas", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="gas")]),
  T("undo that, i haven't done it yet", diff(upd("gas", status="open", completed=None)),
    ref=[act("undo")]),
  T("what's due on friday", rows("karen_tiles", "inv_faith_sep", "mama_meds"),
    ref=[ans(kind="task", where="status = open", when=J(U("week", 0, weekday=5)))]),
  T("which of those are about faith", rows("karen_tiles", "inv_faith_sep"),
    ref=[ans(within="@prev", linked_to="$faith")]))

S("T29-015", "remove-with-balance ask settle-up remove",
  T("take wambs out of the flat bills group", ask("wambui", "flat"),
    ref=[act("remove_from", kind="person", name="wambs", args="from: $flat")]),
  T("settle up with her first", diff(upd("wambui", balance=ANY), settle=[("Wambui", "1450.00")]),
    ref=[act("settle_up", rows="$wambui", args="group: $flat")]),
  T("ok now take her out", diff(unlink("flat", "wambui")),
    ref=[act("remove_from", rows="$wambui", args="from: $flat")]))

S("T29-016", "name-week two-dates same-time past-last order-limit photo-day",
  T("what's on for simba this week", rows("vet_vacc", "groom"),
    ref=[ans(kind="event", name="simba", when=J(U("week", 0)))]),
  T("move the grooming from sunday to monday, same time", diff(upd("groom", date="2026-09-28T11:00")),
    ref=[act("reschedule", kind="event", name="grooming", when=J(U("week", 0, weekday=7)),
             args=lines(to=U("week", 1, weekday=1)))]),
  T("when was he last groomed", rows("groom_aug"),
    ref=[ans(kind="event", name="grooming", when=J({"to": U("day", 0)}), order="date desc", limit=1)]),
  T("any photos from that day", rows("p_simba_groom"),
    ref=[ans(kind="photo", when=J(D("2026-08-23")))]))

S("T29-017", "create event edit-duration clash-ask create-evening",
  T("put the physio in tomorrow at 10am", diff(new("event", name=has("physio"), date="2026-09-24T10:00")),
    ref=[act("create", args=lines(kind="event", name="Physio", date=U("day", 1, time="10:00")))]),
  T("make it 90 minutes", diff(upd("+1", duration=90)),
    ref=[act("edit", rows="$c1", args="duration: 90")]),
  T("also dinner on friday at 8pm", ask("dinner_wambs"),
    ref=[act("create", args=lines(kind="event", name="Dinner", date=U("week", 0, weekday=5, time="20:00")))]))

S("T29-018", "two-writes cancel create-task still-open",
  T("cancel the dinner with wambs and add a task to rebook it next friday",
    diff(upd("dinner_wambs", status="cancelled"), new("task", name=has("rebook"), date="2026-10-02")),
    ref=[act("cancel", kind="event", name="dinner with wambs", more=True),
         act("create", args=lines(kind="task", name="Rebook dinner with Wambs", date=U("week", 1, weekday=5)))]),
  T("what's still on friday", rows("client_faith"),
    ref=[ans(kind="event", where="status != cancelled", when=J(U("week", 0, weekday=5)))]),
  T("and which tasks due next week are about someone",
    rows("inv_faith_c", "karen_roof", "runda_concept", "runda_inv", "kitty_dues", "berlin_reimb", "vacc_cert", "runda_submit"),
    ref=[ans(kind="task", where="status = open and person count >= 1", when=J(U("week", 1)))]))

S("T29-019", "debt order-limit settle sum-with-where",
  T("which debt have i been sitting on the longest", rows("d_lena"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="date asc", limit=1)]),
  T("settle it", diff(upd("d_lena", status="settled")),
    ref=[act("settle_debt", rows="$d_lena")]),
  T("what i owe in total", val((49250, "KES")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open")]))

S("T29-020", "find-oldest delete undo body-contains",
  T("delete the oldest note in the kitchen notebook", diff(trash("pilau")),
    ref=[find(kind="note", linked_to="$kitchen_nb", order="date asc", limit=1),
         act("delete", rows="@1")]),
  T("no wait, put it back", diff(restore("pilau")),
    ref=[act("undo")]),
  T("which kitchen notes mention beef", rows("pilau"),
    ref=[ans(kind="note", linked_to="$kitchen_nb", where='body contains "beef"')]))

S("T29-021", "star-selector two-writes unstar",
  T("star all the photos of juma in the club rides album and unstar the sunrise one",
    diff(upd("p_ride_group", starred=True), upd("p_ride_ngong", starred=True), upd("p_ride_chai", starred=True),
         upd("p_ride_sunrise", starred=False)),
    ref=[find(kind="photo", linked_to="$juma, $rides_album"),
         act("star", rows="@1", more=True),
         act("unstar", kind="photo", name="sunrise")]))

S("T29-022", "ask-missing-content create-note add-to-notebook",
  T("add a note", ask(),
    ref=[askc("What should the note say?")]),
  T("baba's lunch menu - nyama choma, ugali and kachumbari", diff(new("note", name=has("menu"), body=has("nyama"))),
    ref=[act("create", args=lines(kind="note", name="Baba's lunch menu", body="nyama choma, ugali and kachumbari"))]),
  T("put it in the kitchen notebook", diff(link("kitchen_nb", "+1")),
    ref=[act("add_to", rows="$c1", args="to: $kitchen_nb")]))
