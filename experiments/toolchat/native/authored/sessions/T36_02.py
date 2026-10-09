from gold import *
import json

world("T36", "2026-12-09T21:15", "Dev Mehra", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T36-023", "group delete members unlink refused expenses rename",
  T("delete the honeymoon fund group",
    diff(gone("honeymoon"), unlink("honeymoon", "anjali"), unlink("honeymoon", "shreya"), unlink("honeymoon", "me")),
    ref=[act("delete", rows="$honeymoon")]),
  T("and the baner flat bills one", ask(),
    ref=[act("delete", rows="$flat")]),
  T("ok just rename it to flat expenses", diff(upd("flat", name="Flat expenses")),
    ref=[act("edit", rows="$flat", args="name: Flat expenses")]))

S("T36-024", "remove_from balance ask settle_up",
  T("take shreya off the honeymoon fund", diff(unlink("honeymoon", "shreya")),
    ref=[act("remove_from", rows="$shreya", args="from: $honeymoon")]),
  T("and kunal off the wedding group", ask("kunal", "wedding"),
    ref=[act("remove_from", rows="$kunal", args="from: $wedding")]),
  T("settle up with kunal in the wedding group first", diff(upd("kunal", balance=ANY), settle=[("Kunal", "9000.00")]),
    ref=[act("settle_up", rows="$kunal", args="group: $wedding")]))

S("T36-025", "find act prev reschedule list when status within effort",
  T("push everything due tomorrow on the work list to monday",
    diff(upd("release_notes", date="2026-12-14"), upd("pr_review", date="2026-12-14")),
    ref=[find(kind="task", linked_to="$work_list", where="status = open", when=J(U("day", 1))),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]),
  T("whats left on work now", rows("exam_pending", "leave_apply", "tax_proofs", "perf_review", "release_notes", "pr_review"),
    ref=[ans(kind="task", linked_to="$work_list", where="status = open")]),
  T("which of those work ones take more than half an hour", rows("perf_review", "tax_proofs", "release_notes", "pr_review"),
    ref=[ans(within="@prev", where="effort > 30")]))

S("T36-026", "find cancel prev span count status",
  T("cancel the rest of the month's badminton",
    diff(upd("badm_1212", status="cancelled"), upd("badm_1219", status="cancelled"), upd("badm_1226", status="cancelled")),
    ref=[find(kind="event", name="badminton", when=J({"from": U("day", 0), "to": U("month", 0)})),
         act("cancel", rows="@prev")]),
  T("how many sessions are still on in december", val(0),
    ref=[ans(op="count", kind="event", name="badminton", where="status != cancelled",
             when=J({"from": U("day", 0), "to": U("month", 0)}))]))

S("T36-027", "subtasks due by complete both left",
  T("which subtasks of the wedding wrap-up are due by the 15th", rows("wrap_video", "wrap_thanks_cards"),
    ref=[ans(kind="task", linked_to="$wrap", where="status = open", when=J({"to": D("2026-12-15")}))]),
  T("tick both off", diff(upd("wrap_video", status="completed", completed=ANY),
                          upd("wrap_thanks_cards", status="completed", completed=ANY)),
    ref=[act("complete", rows="$wrap_video, $wrap_thanks_cards")]),
  T("what's left under it", rows("wrap_settle", "wrap_album"),
    ref=[ans(kind="task", linked_to="$wrap", where="status = open")]),
  T("delete the thank you cards", ask("wrap_thanks_cards", "thanks_cards_old"),
    ref=[act("delete", kind="task", name="thank-you cards")]))

S("T36-028", "photos unfiled create album add_to more count",
  T("which photos arent in an album yet",
    rows("p_dubai_dune", "p_dubai_burj", "p_dubai_mall", "p_office", "p_cousin", "p_bunty", "p_diwali", "p_ca_docs",
         "p_coep", "p_badminton"),
    ref=[ans(kind="photo", where="album count = 0")]),
  T("make an album called dubai trip and put the three dubai ones in it",
    diff(new("album", name=has("dubai")), link("new", "p_dubai_dune"), link("new", "p_dubai_burj"),
         link("new", "p_dubai_mall")),
    ref=[act("create", kind="album", args="name: Dubai trip", more=True),
         act("add_to", rows="$p_dubai_dune, $p_dubai_burj, $p_dubai_mall", args="to: $new")]),
  T("how many are still unsorted", val(7),
    ref=[ans(op="count", kind="photo", where="album count = 0")]),
  T("star the burj and mall ones and tell me how many starred are in the dubai album",
    val(3, also=diff(upd("p_dubai_burj", starred=True), upd("p_dubai_mall", starred=True))),
    ref=[act("star", rows="$p_dubai_burj, $p_dubai_mall", more=True),
         ans(op="count", kind="photo", linked_to="$c1", where="starred = yes")]))

S("T36-029", "photos person decoy month starred unstar",
  T("photos of college friend rohan from october", rows("p_dubai_dune", "p_dubai_burj"),
    ref=[ans(kind="photo", linked_to="$rohan_k", when=J(U("month", 0, name=10)))]),
  T("which are starred", rows("p_dubai_dune"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it", diff(upd("p_dubai_dune", starred=False)),
    ref=[act("unstar", rows="$p_dubai_dune")]),
  T("star the burj one instead and tell me how many starred photos rohan is in",
    val(1, also=diff(upd("p_dubai_burj", starred=True))),
    ref=[act("star", rows="$p_dubai_burj", more=True),
         ans(op="count", kind="photo", linked_to="$rohan_k", where="starred = yes")]))

S("T36-030", "balance person narrowed group superlative debt",
  T("where am i with anju", val((-630, "INR")),
    ref=[ans(op="balance", kind="person", name="anju")]),
  T("just the household one", val((40, "INR")),
    ref=[ans(op="balance", kind="group", name="Baner Flat Bills", linked_to="$anjali")]),
  T("what's the biggest debt i have to pay off", rows("d_baba"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount desc", limit=1)]))

S("T36-031", "group balance me then member substitution",
  T("where do i stand in the dubai trip", val((960, "AED")),
    ref=[ans(op="balance", kind="group", name="Dubai Trip", linked_to="$me")]),
  T("and arjun's", val((240, "AED")),
    ref=[ans(op="balance", kind="group", name="Dubai Trip", linked_to="$arjun")]),
  T("same for the wedding group, mine", val((-61300, "INR")),
    ref=[ans(op="balance", kind="group", name="Wedding Settle-Up", linked_to="$me")]))

S("T36-032", "settle_debt two more sum owed",
  T("paid siddharth for the shuttlecocks and kunal for the dj",
    diff(upd("d_siddharth", status="settled"), upd("d_kunal", status="settled")),
    ref=[act("settle_debt", kind="debt", name="shuttlecocks", more=True),
         act("settle_debt", kind="debt", name="dj")]),
  T("what's the smallest thing i still owe", val((590, "INR")),
    ref=[comp(op="min", field="amount", kind="debt", where="direction = i_owe and status = open"),
         ans(value="@prev")]))

S("T36-033", "notes body contains notebook month pin",
  T("notes that mention the caterer", rows("w_vendors", "w_settle"),
    ref=[ans(kind="note", where='body contains "caterer"')]),
  T("just the ones in the wedding planning notebook from november", rows("w_settle"),
    ref=[ans(kind="note", linked_to="$wedding_nb", where='body contains "caterer"', when=J(U("month", 0, name=11)))]),
  T("pin it", diff(upd("w_settle", pinned=True)),
    ref=[act("edit", rows="$w_settle", args="pinned: yes")]))

S("T36-034", "ordinal third last reschedule day only week",
  T("whats on next week", rows("scooter_service", "coffee_priya", "doc_baba", "ca_meeting", "scooter_puc", "badm_1219",
                                "shreya_bday", "callm_1220"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("the third one should go to friday", diff(upd("doc_baba", date="2026-12-18T11:00")),
    ref=[act("reschedule", rows="$doc_baba", args=lines(to=U("week", 1, weekday=5)))]),
  T("and the last one to the 22nd", diff(upd("callm_1220", date="2026-12-22T11:00")),
    ref=[act("reschedule", rows="$callm_1220", args=lines(to=D("2026-12-22")))]))

S("T36-035", "log ambiguous person ask role pick",
  T("rang priya on my break", ask("priya_d", "priya_s"),
    ref=[act("log", kind="person", name="priya", args="kind: call")]),
  T("the work one", diff(upd("priya_d", date=ANY)),
    ref=[act("log", rows="$priya_d", args="kind: call")]))

S("T36-036", "star near spelling delete trashed not_found",
  T("star sneeha", diff(upd("sneha", starred=True)),
    ref=[act("star", kind="person", name="sneeha")]),
  T("delete the old sofa task", decline("not_found"),
    ref=[act("delete", kind="task", name="old sofa")]),
  T("ok delete the wedding recption event then", ask("reception"),
    ref=[act("delete", kind="event", name="wedding recption")]))

S("T36-037", "create clash ask evening retry day read",
  T("book lunch with kunal friday at 1", ask("lunch_rohan_k"),
    ref=[act("create", kind="event", args=lines(name="Lunch with Kunal", date=U("week", 0, weekday=5, time="13:00")))]),
  T("ok make it 2.30 then", diff(new("event", name=has("kunal"), date="2026-12-11T14:30")),
    ref=[act("create", kind="event", args=lines(name="Lunch with Kunal", date=U("week", 0, weekday=5, time="14:30")))]),
  T("whats on friday", rows("lunch_rohan_k", "+1"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=5)))]))

S("T36-038", "cancel then reschedule cancelled ask",
  T("cancel the coffee with priya", diff(upd("coffee_priya", status="cancelled")),
    ref=[act("cancel", rows="$coffee_priya")]),
  T("actually make it the 17th at 5", ask("coffee_priya"),
    ref=[act("reschedule", rows="$coffee_priya", args=lines(to=D("2026-12-17", "17:00")))]))

S("T36-039", "bulk delete cap ask yes restore all series",
  T("delete all the finished tasks", ask(),
    ref=[act("delete", kind="task", where="status = completed")]),
  T("yes go ahead",
    diff(*[trash(k) for k in ["rent_aug", "rent_sep", "rent_oct", "rent_nov", "rent_dec", "maint_sep", "maint_oct",
                              "maint_nov", "emi_jul", "emi_aug", "emi_sep", "emi_oct", "emi_nov", "emi_dec",
                              "wrap_gifts_list", "wrap_return_decor", "wrap_pay_caterer", "thanks_cards_old",
                              "nc_marriage_cert", "leave_old", "scooter_ins_old", "scooter_challan", "aai_fridge",
                              "book_fly"]]),
    ref=[act("delete", kind="task", where="status = completed")]),
  T("bring back all the scooter emi ones",
    diff(*[restore(k) for k in ["emi_jul", "emi_aug", "emi_sep", "emi_oct", "emi_nov", "emi_dec"]]),
    ref=[act("restore", kind="task", name="scooter emi", trashed=True)]))

S("T36-040", "undo star log not undone",
  T("star the police verification form", diff(upd("police_verif", starred=True)),
    ref=[act("star", rows="$police_verif")]),
  T("undo that", diff(upd("police_verif", starred=False)),
    ref=[act("undo")]),
  T("rang my mother in law, log it", diff(upd("aai", date=ANY)),
    ref=[search("mother in law", kind="person"), act("log", rows="$aai", args="kind: call")]),
  T("undo that too", diff(),
    ref=[act("undo")]))

S("T36-041", "write read more wrap-up open sum within",
  T("mark choose photos for the album done and tell me what's still open under the wedding wrap-up",
    rows("wrap_settle", "wrap_thanks_cards", "wrap_video", also=diff(upd("wrap_album", status="completed", completed=ANY))),
    ref=[act("complete", rows="$wrap_album", more=True),
         ans(kind="task", linked_to="$wrap", where="status = open")]),
  T("how long will those take", val(110),
    ref=[ans(op="sum", field="effort", kind="task", within="@prev")]))

S("T36-042", "repair edit status cancel next empty",
  T("mark the dentist visit as cancelled", diff(upd("dentist_ev", status="cancelled")),
    ref=[bad(act("edit", kind="event", name="dentist", args="status: cancelled")),
         act("cancel", kind="event", name="dentist")]),
  T("when's my next dentist thing", rows(),
    ref=[ans(kind="event", name="dentist")]))

S("T36-043", "repair answer group compute grouped status",
  T("break my tasks down by status, how many each", vgroups({"completed": 24, "cancelled": 1, "in_progress": 2, "open": 32}),
    ref=[bad(ans(op="count", kind="task", group="status")),
         comp(op="count", kind="task", group="status"), ans(value="@prev")]))

S("T36-044", "decline text create remind decline weather",
  T("message anju that i'm stuck in traffic", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok just remind me to tell her tonight", diff(new("task", name=has("anju"))),
    ref=[act("create", kind="task", args=lines(name="Tell Anju I'm stuck in traffic", date=U("day", 0)))]),
  T("whats the weather like in pune tomorrow", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))
