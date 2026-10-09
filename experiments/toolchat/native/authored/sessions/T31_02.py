from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-026", "admin tasks four-constraints sum-within reschedule week",
  T("open admin tasks due before the 20th under half an hour", rows("physio_book", "flu_shot"),
    ref=[ans(kind="task", linked_to="$admin_l", where="status = open and effort < 30",
             when=J({"to": D("2026-11-19")}))]),
  T("how many minutes is that altogether", val(25),
    ref=[ans(op="sum", field="effort", within="@prev")]),
  T("push the physio one to monday week", diff(upd("physio_book", date="2026-11-16")),
    ref=[act("reschedule", rows="$physio_book", args=lines(to=U("week", 2, weekday=1)))]))

S("T31-027", "league darek before november count compute went ahead",
  T("how many league games did darek get to before november, not counting the cancelled one", val(2),
    ref=[comp(op="count", kind="event", name="league match", linked_to="$darek", where="status != cancelled",
              when=J({"to": D("2026-10-31")})),
         ans(value="@prev")]))

S("T31-028", "magda night shift cancel person-link exclude-cancelled",
  T("who's on the night shift on the 23rd", rows("shift_1123"),
    ref=[ans(kind="event", name="night shift", when=J(D("2026-11-23")))]),
  T("cancel magda's night shift that day", diff(upd("shift_1123", status="cancelled")),
    ref=[act("cancel", kind="event", name="night shift", linked_to="$magda", when=J(D("2026-11-23")))]),
  T("swap przemek's night shift on the 11th to the 12th, same time", diff(upd("shift_1111", date="2026-11-12T20:00")),
    ref=[act("reschedule", kind="event", name="night shift", linked_to="$przemek", when=J(D("2026-11-11")),
             args=lines(to=D("2026-11-12")))]))

S("T31-029", "ewa day shifts within reschedule same-time",
  T("which day shifts is ewa on this month", rows("shift_1102", "shift_1104", "shift_1105", "shift_1116", "shift_1118"),
    ref=[ans(kind="event", name="day shift", linked_to="$ewa", when=J(U("month", 0)))]),
  T("which of those are still ahead", rows("shift_1116", "shift_1118"),
    ref=[ans(within="@prev", when=J({"from": U("day", 1)}))]),
  T("move ewa's day shift on the 16th to the 17th, same time",
    diff(upd("shift_1116", date="2026-11-17T07:00")),
    ref=[act("reschedule", kind="event", name="day shift", linked_to="$ewa", when=J(D("2026-11-16")),
             args=lines(to=D("2026-11-17")))]))

S("T31-030", "repair effort unit family tasks",
  T("which family tasks take more than an hour", rows("london_gifts"),
    ref=[bad(ans(kind="task", linked_to="$family_l", where="effort > 1 hour")),
         ans(kind="task", linked_to="$family_l", where="effort > 60")]),
  T("and push all the family ones under twenty minutes to saturday",
    diff(upd("tata_birthday", date="2026-11-07"), upd("train_ticket", date="2026-11-07")),
    ref=[find(kind="task", linked_to="$family_l", where="effort < 20"),
         act("reschedule", rows="@2", args=lines(to=U("week", 0, weekday=6)))]))

S("T31-031", "stag planning event people notes add-to-notebook",
  T("who's coming to the stag planning dinner", rows("adrian", "marcin_l"),
    ref=[ans(kind="person", linked_to="$stag_planning")]),
  T("any notes about adi", rows("n_stag"),
    ref=[ans(kind="note", linked_to="$adrian")]),
  T("file that under ideas", diff(link("ideas_nb", "n_stag")),
    ref=[act("add_to", rows="$n_stag", args=lines(to="$ideas_nb"))]))

S("T31-032", "adi wedding tasks reschedule",
  T("what do i still need to do for adi", rows("adi_gift", "adi_wedding"),
    ref=[ans(kind="task", linked_to="$adrian", where="status = open")]),
  T("move the wedding gift for adi to the 14th", diff(upd("adi_wedding", date="2026-11-14")),
    ref=[act("reschedule", kind="task", name="wedding gift", linked_to="$adrian", args=lines(to=D("2026-11-14")))]))

S("T31-033", "zakopane group balance substitution members",
  T("am i up or down on zakopane", val((300, "PLN")),
    ref=[search("Tomasz", kind="person"),
         ans(op="balance", kind="group", name="Zakopane Weekend", linked_to="$me")]),
  T("and adrian?", val((-340, "PLN")),
    ref=[ans(op="balance", kind="group", name="Zakopane Weekend", linked_to="$adrian")]),
  T("anna from nursing school isn't coming, take her out of the group", diff(unlink("zakopane", "anna_wl")),
    ref=[act("remove_from", rows="$anna_wl", args=lines(from_="$zakopane"))]),
  T("any notes for the zakopane group", rows("n_trip_zak"),
    ref=[ans(kind="note", linked_to="$zakopane"), ans(kind="note", name="zakopane")]))

S("T31-034", "football fund balance debt-count match-balls",
  T("where do i stand in the football fund", val((21.25, "PLN")),
    ref=[search("Tomasz", kind="person"),
         ans(op="balance", kind="group", name="Tuesday Football Fund", linked_to="$me")]),
  T("who from there have i got debts with", rows("marcin_l", "darek", "michal", "piotr"),
    ref=[ans(kind="person", linked_to="$fiveaside", where="debt count >= 1")]),
  T("who owes me for the match balls", rows("d_piotr_balls", "d_michal_balls"),
    ref=[ans(kind="debt", name="match balls", where="direction = owes_me and status = open")]))

S("T31-035", "recipes eggs newest pin",
  T("recipes with eggs in the kitchen notebook", rows("n_zurek", "n_shakshuka"),
    ref=[ans(kind="note", linked_to="$recipes_nb", where='body contains "egg"')]),
  T("which one did i write most recently", rows("n_shakshuka"),
    ref=[ans(within="@prev", order="date desc", limit=1)]),
  T("pin it", diff(upd("n_shakshuka", pinned=True)),
    ref=[act("edit", rows="$n_shakshuka", args="pinned: yes")]))

S("T31-036", "taxes folder this year star add-to-folder",
  T("what's in the taxes folder from this year", rows("d_pit25", "d_zus"),
    ref=[ans(kind="document", linked_to="$taxes_f", when=J(U("year", 0)))]),
  T("star the zus one in the taxes folder", diff(upd("d_zus", starred=True)),
    ref=[act("star", kind="document", name="zus", linked_to="$taxes_f")]),
  T("and the passport scan can go in to file", diff(link("empty_f", "d_passport")),
    ref=[act("add_to", kind="document", name="passport", args=lines(to="$empty_f"))]))

S("T31-037", "write-then-read delete folder list empty",
  T("delete the to file folder and show me what folders i've got left",
    rows("work_f", "flat_f", "health_f", "taxes_f", also=diff(gone("empty_f"))),
    ref=[act("delete", kind="folder", name="To file", more=True), ans(kind="folder")]),
  T("which of them are empty", rows(),
    ref=[ans(kind="folder", where="document count = 0")]))

S("T31-038", "locker starred within reveal",
  T("what's starred in the locker", rows("pko_login", "pko_acct", "flat_wifi", "jetbrains"),
    ref=[ans(kind="locker item", where="starred = yes")]),
  T("just the logins and wifi", rows("pko_login", "flat_wifi"),
    ref=[ans(within="@prev", where='type in ("login", "wifi")')]),
  T("read me the bank login password", diff(reveal=[("pko_login", "Krakowska#Vistula29")]),
    ref=[act("reveal", rows="$pko_login", args="field: password")]))

S("T31-039", "decline fabricated secret then reveal existing",
  T("invent a netflix password", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("ok then show me the old one", diff(reveal=[("netflix_login", "Shakshuka-Kuba88")]),
    ref=[act("reveal", rows="$netflix_login", args="field: password")]))

S("T31-040", "football photos starred person link add-to-album",
  T("starred photos in the football album", rows("p_fb_team", "p_fb_keeper"),
    ref=[ans(kind="photo", linked_to="$football_a", where="starred = yes")]),
  T("who's in the keeper one", rows("tomek_m"),
    ref=[ans(kind="person", linked_to="$p_fb_keeper")]),
  T("put the team photo in trips 2026 too", diff(link("trips_a", "p_fb_team")),
    ref=[act("add_to", rows="$p_fb_team", args=lines(to="$trips_a"))]))


S("T31-041", "restore person past-window cadence-read",
  T("bring iga back", diff(restore("old_coll")),
    ref=[find(kind="person", name="iga", trashed=True), act("restore", rows="@1")]),
  T("who else is in the people trash", rows("old_flat"),
    ref=[ans(kind="person", trashed=True)]),
  T("who haven't i spoken to in over two weeks that i'm meant to keep up with", rows("james", "babcia", "anna_wl"),
    ref=[ans(kind="person", where="cadence is set", when=J({"to": D("2026-10-21")}))]))

S("T31-042", "restore event past-window",
  T("get the concert at alchemia back", diff(restore("old_gig")),
    ref=[find(kind="event", name="concert alchemia", trashed=True), act("restore", rows="@1")]),
  T("what other events have i thrown out", rows("old_match", "old_dinner"),
    ref=[ans(kind="event", trashed=True)]))

S("T31-043", "restore note document",
  T("dig out the old shopping list note", diff(restore("old_note")),
    ref=[find(kind="note", name="old shopping list", trashed=True), act("restore", rows="@1")]),
  T("and the 2024 rental agreement", diff(restore("d_old_lease")),
    ref=[find(kind="document", name="rental agreement 2024", trashed=True), act("restore", rows="@2")]))

S("T31-044", "locker trash restore photo",
  T("has any locker item been trashed lately", rows("old_wifi", "old_login"),
    ref=[ans(kind="locker item", trashed=True)]),
  T("bring back the allegro login", diff(restore("old_login")),
    ref=[act("restore", rows="$old_login")]),
  T("and the blurry photo", diff(restore("p_blurry")),
    ref=[find(kind="photo", name="blurry", trashed=True), act("restore", rows="@2")]))

S("T31-045", "undo create note",
  T("new note: boiler pressure check, look at the gauge every sunday",
    diff(new("note", name=has("boiler pressure"))),
    ref=[act("create", kind="note", args=lines(name="Boiler pressure check", body="look at the gauge every sunday"))]),
  T("undo that", diff(trash("+1")),
    ref=[act("undo")]),
  T("what notes have i got from this week", rows(),
    ref=[ans(kind="note", when=J(U("week", 0)))]))

S("T31-046", "write-then-read star complete within",
  T("star the cpr certificate and show me my starred documents",
    rows("d_contract", "d_licence", "d_lease26", "d_cpr", also=diff(upd("d_cpr", starred=True))),
    ref=[act("star", kind="document", name="cpr certificate", more=True),
         ans(kind="document", where="starred = yes")]),
  T("tick off the handover sheet and tell me what's left on the ward list",
    rows("cpr_prep", "licence_renew", "swap_shift", "uniforms", "gift_card",
         also=diff(upd("handover", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="handover sheet", more=True),
         ans(kind="task", linked_to="$ward_l", where="status = open")]),
  T("which of those are due before the 20th", rows("cpr_prep", "swap_shift", "uniforms", "gift_card"),
    ref=[ans(within="@prev", when=J({"to": D("2026-11-19")}))]))

S("T31-047", "repair edit date then reschedule what-else",
  T("make the cpr e-learning due friday week", diff(upd("cpr_prep", date="2026-11-20")),
    ref=[bad(act("edit", rows="$cpr_prep", args=lines(date=U("week", 2, weekday=5)))),
         act("reschedule", rows="$cpr_prep", args=lines(to=U("week", 2, weekday=5)))]),
  T("and what else falls on that day", rows("pit"),
    ref=[ans(kind="task", when=J(D("2026-11-20")), where="status = open", exclude="$cpr_prep")]))

S("T31-048", "repair unquoted contains nurses night",
  T("which of my contacts are nurses", rows("marcin_b", "ewa", "magda", "anna_w"),
    ref=[bad(ans(kind="person", where="role contains nurse")),
         ans(kind="person", where='role contains "nurse"')]),
  T("the ones on the night team", rows("magda"),
    ref=[ans(within="@prev", where='role contains "night"')]),
  T("when's the ward christmas party", rows("hospital_party"),
    ref=[ans(kind="event", name="christmas party")]))

S("T31-049", "repair multi-kind where starred kasia",
  T("what starred stuff have i got of kasia", rows("p_tr_london"),
    ref=[bad(ans(kind="photo,note", linked_to="$kasia", where="starred = yes")),
         ans(kind="photo", linked_to="$kasia", where="starred = yes")]),
  T("and any notes", rows("n_gifts"),
    ref=[ans(kind="note", linked_to="$kasia")]),
  T("unstar the london eye one, it's too dark", diff(upd("p_tr_london", starred=False)),
    ref=[act("unstar", rows="$p_tr_london")]))

S("T31-050", "repair date-expression december long events",
  T("what's on in december that runs longer than four hours", rows("zakopane_trip", "hospital_party"),
    ref=[bad(ans(kind="event", where="duration > 240", when='{"unit":"month","name":12}')),
         ans(kind="event", where="duration > 240", when=J(U("month", 0, name=12)))]),
  T("who's going to the first one", rows("adrian", "natalia", "agnieszka", "basia"),
    ref=[ans(kind="person", linked_to="$zakopane_trip")]),
  T("push the party back a day, same time", diff(upd("hospital_party", date="2026-12-12T19:00")),
    ref=[act("reschedule", rows="$hospital_party", args=lines(to=U("day", 1, anchor="row")))]))

S("T31-051", "create note add-to-notebook pin pinned-in-notebook",
  T("new note: ward handover reminder, bring a pen. put it in ward notes",
    diff(new("note", name=has("handover reminder")), link("ward_nb", "new")),
    ref=[act("create", kind="note", args=lines(name="Ward handover reminder", body="bring a pen"), more=True),
         act("add_to", rows="$new", args=lines(to="$ward_nb"))]),
  T("pin it", diff(upd("+1", pinned=True)),
    ref=[act("edit", rows="$c1", args="pinned: yes")]),
  T("and unpin the handover checklist from march", diff(upd("n_handover", pinned=False)),
    ref=[act("edit", kind="note", name="handover checklist", when=J(U("month", -1, name=3)), args="pinned: no")]))

S("T31-052", "role search dad photos month multi-link next-dentist",
  T("photos of my dad from july", rows("p_ns_tata"),
    ref=[search("dad", kind="person"),
         ans(kind="photo", linked_to="$tata", when=J(U("month", 0, name=7)))]),
  T("and the ones with babcia too", rows("p_ns_table", "p_ns_all"),
    ref=[ans(kind="photo", linked_to="$tata, $babcia")]),
  T("when's my next dentist", rows("dentist_ev"),
    ref=[ans(kind="event", name="dentist", order="date asc", limit=1, when=J({"from": U("day", 0)}))]))
