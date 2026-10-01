from gold import *


S("T25-026", "six turns person met cadence spans weekday time log undo ledger",
  T("people i know from somewhere other than work",
    rows("sylvie", "marc_g", "nadia", "tom", "elise", "sarah_c", "ines", "rachel", "gab", "luca", "hannah"),
    ref=[ans(kind="person", where='met != "work" and met is set')]),
  T("which of them am i supposed to see every two weeks or less often",
    rows("sylvie", "marc_g", "nadia", "elise", "sarah_c", "rachel"),
    ref=[ans(kind="person", within="@prev", where="cadence >= 14 days")]),
  T("who did i get in contact with, last week onward",
    rows("daniel", "hiroko", "kenji", "sarah_n", "priya", "jess", "nadia", "sarah_c", "rachel", "marc_t",
         "josee", "caron", "zoe", "matthieu"),
    ref=[ans(kind="person", when={"from": U("week", -1)})]),
  T("and last thursday at 8pm exactly", rows("kenji", "josee"),
    ref=[ans(kind="person", when=U("week", -1, weekday=4, time="20:00"))]),
  T("log a call with Kenji Tanaka, he rang about thanksgiving", diff(upd("kenji", date=ANY)),
    ref=[act("log", rows="$kenji", args=lines(kind="call"))]),
  T("undo that, it was mom on his phone", diff(),
    ref=[act("undo")]))

S("T25-027", "person note count linked notes delete named",
  T("who has more than one note about them", rows("mika", "sarah_n", "josee"),
    ref=[ans(kind="person", where="note count > 1")]),
  T("the lawyer's notes, what are they", rows("timeline", "lawyer_q"),
    ref=[ans(kind="note", linked_to="$josee")]),
  T("delete Lawyer questions, she answered all of it", diff(trash("lawyer_q")),
    ref=[act("delete", kind="note", name="Lawyer questions")]))

S("T25-028", "person event count debt count",
  T("book club people who actually show up in my diary", rows("sarah_c", "ines"),
    ref=[ans(kind="person", where='met = "book club" and event count != 0')]),
  T("who do i have two or more debts with", rows("daniel"),
    ref=[ans(kind="person", where="debt count >= 2")]),
  T("what's the balance with Daniel Roy", val((444, "CAD")),
    ref=[ans(op="balance", rows="$daniel")]))

S("T25-029", "five turns debt amount literal within sum max",
  T("small debts under 50", rows("d_nadia", "d_jess", "d_sarah_c", "d_elise", "d_gab", "d_priya", "d_matthieu", "d_daniel_piano"),
    ref=[ans(kind="debt", where="amount < 50")]),
  T("just the open ones", rows("d_nadia", "d_jess", "d_elise", "d_priya", "d_matthieu"),
    ref=[ans(kind="debt", within="@prev", where='status = "open"')]),
  T("how much do those people owe me in total", val((112, "CAD")),
    ref=[ans(op="sum", field="amount", within="@prev", where='direction = "owes_me"')]),
  T("biggest open one each way", vgroups({"owes_me": (180, "CAD"), "i_owe": (300, "CAD")}),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]),
  T("who's the 300 one to", rows("d_kenji"),
    ref=[ans(kind="debt", where='direction = "i_owe" and amount = 300')]))

S("T25-030", "debt spans month names open end weekday",
  T("debts from august through september",
    rows("d_kenji", "d_marc_g", "d_daniel_piano", "d_sarah_c", "d_tom", "d_nadia", "d_zoe"),
    ref=[ans(kind="debt", when=span(U("month", 0, name=8), U("month", 0, name=9)))]),
  T("since sept twentieth", rows("d_tom", "d_nadia", "d_zoe", "d_priya", "d_elise", "d_daniel_boots", "d_jess"),
    ref=[ans(kind="debt", when={"from": D("2026-09-20")})]),
  T("anything logged before last friday that i owe",
    rows("d_daniel_piano", "d_tom", "d_sarah_c", "d_kenji", "d_zoe"),
    ref=[ans(kind="debt", when={"to": U("week", -1, weekday=5)}, where='direction = "i_owe"')]),
  T("from sept first to oct second at 6pm, same thing", rows("d_daniel_piano", "d_sarah_c", "d_tom", "d_zoe"),
    ref=[ans(kind="debt", when=span(D("2026-09-01"), D("2026-10-02", "18:00")), where='direction = "i_owe"')]))

S("T25-031", "five turns debt spans status set count",
  T("what did people borrow from me in june and july", rows("d_daniel_camp", "d_gab", "d_matthieu"),
    ref=[ans(kind="debt", when=span(U("month", 0, name=6), U("month", 0, name=7)), where='direction = "owes_me"')]),
  T("and from oct first on", rows("d_priya", "d_daniel_boots", "d_jess"),
    ref=[ans(kind="debt", when={"from": D("2026-10-01")}, where='direction = "owes_me"')]),
  T("everything up to tuesday this week, both ways, open only",
    rows("d_daniel_camp", "d_daniel_boots", "d_nadia", "d_tom", "d_kenji", "d_marc_g", "d_elise", "d_zoe",
         "d_priya", "d_matthieu"),
    ref=[ans(kind="debt", when={"to": U("week", 0, weekday=2)}, where='status = "open"')]),
  T("between sept twenty-sixth and oct sixth at noon", rows("d_nadia", "d_zoe", "d_priya", "d_elise", "d_daniel_boots"),
    ref=[ans(kind="debt", when=span(D("2026-09-26"), D("2026-10-06", "12:00")))]),
  T("how many debts have i logged in total, open or settled", val(14),
    ref=[ans(op="count", kind="debt", where="status is set")]))

S("T25-032", "event status enum week duration month",
  T("last week, what wasn't cancelled", rows("therapy_0929", "piano_0930"),
    ref=[ans(kind="event", when=U("week", -1), where="status != cancelled")]),
  T("and what was", rows("handoff_1002", "hike_sutton"),
    ref=[ans(kind="event", when=U("week", -1), where="status = cancelled")]),
  T("long stuff this month, 120 min or more",
    rows("hike_sutton", "offsite", "thanksgiving", "book_10", "hike_tremblant", "usability", "workshop",
         "yoga_oct", "halloween_ev"),
    ref=[ans(kind="event", when=U("month", 0), where="duration >= 120")]))

S("T25-033", "event spans date datetime open count",
  T("what do i have from the nineteenth till noon on the twentieth", rows("inspection", "usability", "workshop"),
    ref=[ans(kind="event", when=span(D("2026-10-19"), D("2026-10-20", "12:00")))]),
  T("how many things from nov first onwards", val(13),
    ref=[ans(op="count", kind="event", when={"from": D("2026-11-01")})]),
  T("which of those are two hours plus", rows("hike_royal", "mika_bday", "book_11", "book_12"),
    ref=[ans(kind="event", when={"from": D("2026-11-01")}, where="duration >= 120")]))

S("T25-034", "empty result event trashed read span",
  T("is there a pottery class coming up", rows("pottery"),
    ref=[ans(kind="event", name="Pottery class"), ans(kind="event", name="Pottery class", trashed=True)]),
  T("ok what's on from the twenty-fourth on with Hannah Weiss", rows("yoga_oct"),
    ref=[ans(kind="event", linked_to="$hannah", when={"from": D("2026-10-24")})]))

S("T25-035", "empty result event search recovery reschedule",
  T("when's my yoga class", rows("yoga_oct"),
    ref=[ans(kind="event", name="yoga class"), search("yoga"), ans(rows="$yoga_oct")]),
  T("push it an hour later", diff(upd("yoga_oct", date="2026-10-25T11:00")),
    ref=[act("reschedule", rows="$yoga_oct", args=lines(to=U("hour", 1, anchor="row")))]))

S("T25-036", "event overlap refused ask create",
  T("put Mika's swim trial on wednesday at 4:45 for half an hour", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Mika's swim trial",
                                      date=U("week", 1, weekday=3, time="16:45"), duration=30))),
         askc("her piano lesson runs 4:30 to 5:15 that day. do the swim trial at 5:30 instead?")]),
  T("yes 5:30", diff(new("event", name="Mika's swim trial", date="2026-10-14T17:30")),
    ref=[act("create", args=lines(kind="event", name="Mika's swim trial", date=D("2026-10-14", "17:30"),
                                  duration=30))]))

S("T25-037", "event overlap trashed slot ask create",
  T("book a massage on oct twenty-third at 7pm", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Massage", date=D("2026-10-23", "19:00"),
                                      duration=60))),
         askc("movie night is in the bin but still holds 7 to 9:30 that evening. restore it, or pick another time?")]),
  T("4pm then, an hour", diff(new("event", name="Massage", date="2026-10-23T16:00")),
    ref=[act("create", args=lines(kind="event", name="Massage", date=D("2026-10-23", "16:00"), duration=60))]))

S("T25-038", "task effort unit priority subtasks linked",
  T("quick stuff due next week, thirty min or less",
    rows("receipts_1", "export_assets", "research_plan", "field_trip", "radiator", "dry_clean", "library",
         "pharmacy", "first_aid", "therapy_book", "thank_you"),
    ref=[ans(kind="task", when=U("week", 1), where="effort <= 30 min")]),
  T("which of those are priority three or lower", rows("research_plan"),
    ref=[ans(kind="task", within="@prev", where="priority >= 3")]),
  T("which tasks have subtasks", rows("plan", "onboarding"),
    ref=[ans(kind="task", where="task count >= 1")]),
  T("what's left under Update parenting plan", rows("holiday_sched", "review_lawyer", "sign_plan"),
    ref=[ans(kind="task", linked_to="$plan")]))

S("T25-039", "refused 1 hour repair list count",
  T("which tasks are estimated above an hour",
    rows("plan", "onboarding", "wireframes", "deck", "ds_docs", "icons", "costume", "gallery", "hike_boots",
         "novel"),
    ref=[bad(ans(kind="task", where="effort > 1 hour")),
         ans(kind="task", where="effort > 60")]),
  T("which of them sit on a list", rows("plan", "onboarding", "deck", "ds_docs", "icons", "costume", "gallery",
                                         "hike_boots"),
    ref=[ans(kind="task", within="@prev", where="list count > 0")]))

S("T25-040", "task spans relative datetime month name linked",
  T("work list stuff due between tomorrow and friday 5pm", rows("onboarding", "deck", "participants", "research_plan"),
    ref=[ans(kind="task", linked_to="$work_l", when=span(U("day", 1), U("week", 1, weekday=5, time="17:00")))]),
  T("mika list from next week through end of november",
    rows("receipts_1", "field_trip", "flu_shot", "invites", "ski", "costume"),
    ref=[ans(kind="task", linked_to="$mika_l", when=span(U("week", 1), U("month", 0, name=11)))]),
  T("which one's due last", rows("ski"),
    ref=[ans(kind="task", within="@prev", order="date desc", limit=1)]))

S("T25-041", "note month name anchor time notebook count",
  T("notes from september",
    rows("hilaire_notes", "grateful", "lawyer_q", "retro", "picks", "bday_ideas", "orford_notes",
         "onboarding_ideas", "therapy_notes"),
    ref=[ans(kind="note", when=U("month", 0, name=9))]),
  T("the one i wrote two nights ago at 10pm", rows("ped_questions"),
    ref=[ans(kind="note", when={"unit": "day", "rel": -2, "anchor": "today", "time": "22:00"})]),
  T("pin it", diff(upd("ped_questions", pinned=True)),
    ref=[act("edit", rows="@prev", args=lines(pinned="yes"))]))

S("T25-042", "note spans month name datetime relative person count",
  T("notes from august up to oct fourth at 9pm",
    rows("gallery_note", "hilaire_notes", "grateful", "lawyer_q", "retro", "picks", "bday_ideas",
         "orford_notes", "onboarding_ideas", "therapy_notes", "ski_note", "custody"),
    ref=[ans(kind="note", when=span(U("month", 0, name=8), D("2026-10-04", "21:00")))]),
  T("from september through last week, which ones are about someone",
    rows("picks", "orford_notes", "therapy_notes", "lawyer_q", "retro", "bday_ideas", "ski_note",
         "s11_thoughts"),
    ref=[ans(kind="note", when=span(U("month", 0, name=9), U("week", -1)), where="person count != 0")]))

S("T25-043", "notebook note count edit folder prev",
  T("notebooks with one note or none", rows("sketch_nb", "wedding_nb"),
    ref=[ans(kind="notebook", where="note count <= 1")]),
  T("any empty folders too", rows("scans_f"),
    ref=[ans(kind="folder", where="document count = 0")]),
  T("rename that one Receipts", diff(upd("scans_f", name="Receipts")),
    ref=[act("edit", rows="@prev", args=lines(name="Receipts"))]))

S("T25-044", "document spans datetime relative weekday",
  T("docs added from sept twenty-first 1pm through this week",
    rows("nda", "plan_draft", "passport_app", "boots_receipt", "trip_form", "scan_a", "scan_b"),
    ref=[ans(kind="document", when=span(D("2026-09-21", "13:00"), U("week", 0)))]),
  T("from oct second 8pm to thursday", rows("passport_app", "boots_receipt", "trip_form"),
    ref=[ans(kind="document", when=span(D("2026-10-02", "20:00"), U("week", 0, weekday=4)))]),
  T("star the passport one", diff(upd("passport_app", starred=True)),
    ref=[act("star", rows="$passport_app")]))

S("T25-045", "photo date rel week spans weekday",
  T("pics from sept twenty-sixth", rows("orford_ridge", "orford_group", "fall_colours"),
    ref=[ans(kind="photo", when=D("2026-09-26"))]),
  T("and last week", rows("s11_cover", "handoff_p", "tooth", "rainy", "leaves"),
    ref=[ans(kind="photo", when=U("week", -1))]),
  T("from last saturday to oct eighth",
    rows("tooth", "rainy", "leaves", "sunset", "whiteboard", "boots_p", "sticky", "latte"),
    ref=[ans(kind="photo", when=span(U("week", -1, weekday=6), D("2026-10-08")))]),
  T("last friday through this tuesday, how many", val(7),
    ref=[ans(op="count", kind="photo", when=span(U("week", -1, weekday=5), U("week", 0, weekday=2)))]))

S("T25-046", "album photo count locker type notes empty",
  T("which albums actually have photos in them",
    rows("mika_album", "hikes_album", "book_album", "vermont_album", "summer_album"),
    ref=[ans(kind="album", where="photo count != 0")]),
  T("locker things that aren't logins and have no notes",
    rows("visa", "sin", "wifi", "laptop", "fonts", "climbing", "health_card"),
    ref=[ans(kind="locker item", where='type != "login" and notes is empty')]))

S("T25-047", "decline out_of_scope single",
  T("book me a flight to vancouver for christmas", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T25-048", "create task undo create",
  T("remind me to buy cranberry sauce tomorrow", diff(new("task", name=has("cranberry"), date="2026-10-12")),
    ref=[act("create", args=lines(kind="task", name="Buy cranberry sauce", date=U("day", 1)))]),
  T("undo, mom already bought some", diff(trash("+1")),
    ref=[act("undo")]))

S("T25-049", "empty result locker find search miss decline reveal",
  T("what's my netflix password", decline("not_found"),
    ref=[find(kind="locker item", name="Netflix"), search("netflix"), dec("not_found")]),
  T("oh its under Streaming account i think", diff(reveal=[("streaming", "movienight7")]),
    ref=[act("reveal", kind="locker item", name="Streaming account", args=lines(field="password"))]))

S("T25-050", "refused delete folder ask delete empty folder",
  T("delete the apartment folder", ask(),
    ref=[bad(act("delete", kind="folder", name="Apartment")),
         askc("the apartment folder still has 3 documents in it, so it can't go. move them out first?")]),
  T("no. delete the Scans folder instead, that one's empty", diff(gone("scans_f")),
    ref=[act("delete", kind="folder", name="Scans")]))
