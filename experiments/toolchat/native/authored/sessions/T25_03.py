from gold import *


S("T25-052", "five turns group balance settle_up amount undo ledger settle_debt",
  T("where's Daniel Roy at in Mika expenses", val((-199.5, "CAD")),
    ref=[ans(op="balance", kind="group", name="Mika expenses", linked_to="$daniel")]),
  T("he paid me back 64.50 for the boots", diff(upd("daniel", balance=ANY), settle=[("Daniel Roy", "64.50")]),
    ref=[act("settle_up", rows="$daniel", args=lines(group="$mika_exp", amount=64.5))]),
  T("undo that, it was the camp money not the boots", diff(),
    ref=[act("undo")]),
  T("fine, settle all of it with him", diff(settle=["Daniel Roy"]),
    ref=[act("settle_up", rows="$daniel", args=lines(group="$mika_exp"))]),
  T("and mark the Half of winter boots debt settled", diff(upd("d_daniel_boots", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Half of winter boots")]))

S("T25-053", "six turns decline out_of_scope ambiguous log members tasks four calls write read note",
  T("text marc that i'm in for tremblant", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok log that i messaged marc about it", diff(upd("marc_g", date=ANY)),
    ref=[act("log", kind="person", name="Marc", args=lines(kind="message")),
         act("log", rows="$marc_g", args=lines(kind="message"))]),
  T("who's coming on the Tremblant hiking weekend", rows("marc_g", "nadia", "tom", "elise"),
    ref=[ans(kind="person", linked_to="$hike_tremblant")]),
  T("what's left on my hiking list", rows("hike_boots", "first_aid", "route"),
    ref=[ans(kind="task", linked_to="$hike_l", where='status = open')]),
  T("move Pack first aid kit to thursday and Buy new hiking boots to wednesday, delete Plan November hike route, then show me the list",
    rows("hike_boots", "first_aid", also=diff(upd("first_aid", date="2026-10-15"), upd("hike_boots", date="2026-10-14"),
                                              trash("route"))),
    ref=[act("reschedule", rows="$first_aid", args=lines(to=U("week", 1, weekday=4)), more=True),
         act("reschedule", rows="$hike_boots", args=lines(to=U("week", 1, weekday=3)), more=True),
         act("delete", rows="$route", more=True),
         ans(kind="task", linked_to="$hike_l", where='status = open')]),
  T("what's in the Tremblant packing list", rows("tremblant_pack"),
    ref=[ans(kind="note", name="Tremblant packing list")]))

S("T25-054", "five turns book club ambiguous ask log balance settle_up",
  T("book club next week?", rows("book_10"),
    ref=[ans(kind="event", name="Book club", when=U("week", 1))]),
  T("log a coffee with sarah", ask("sarah_c", "sarah_n"),
    ref=[act("log", kind="person", name="Sarah", args=lines(kind="coffee")),
         askc("sarah cohen or sarah nguyen?", options="$sarah_c, $sarah_n")]),
  T("cohen", diff(upd("sarah_c", date=ANY)),
    ref=[act("log", rows="$sarah_c", args=lines(kind="coffee"))]),
  T("what's my balance with her", val((-12, "CAD")),
    ref=[comp(op="balance", rows="$sarah_c"), ans(value="@prev")]),
  T("settle up with her in the Book club kitty", diff(settle=["Sarah Cohen"]),
    ref=[act("settle_up", rows="$sarah_c", args=lines(group="$bookclub"))]))

S("T25-055", "ambiguous event ask reschedule",
  T("move the dentist to next friday 8:30", ask("dentist_mika", "dentist_me"),
    ref=[act("reschedule", kind="event", name="Dentist", args=lines(to=U("week", 1, weekday=5, time="08:30"))),
         find(kind="event", name="Dentist"),
         askc("mika's dentist on the 21st or yours on nov 4?", options="$dentist_mika, $dentist_me")]),
  T("mine", diff(upd("dentist_me", date="2026-10-16T08:30")),
    ref=[act("reschedule", rows="$dentist_me", args=lines(to=D("2026-10-16", "08:30")))]))

S("T25-056", "four turns duplicate tasks ambiguous add_to undo link complete",
  T("is Send Daniel the receipts done", rows("receipts_1", "receipts_2"),
    ref=[ans(kind="task", name="Send Daniel the receipts")]),
  T("move Send Daniel the receipts to divorce admin, the open one",
    diff(unlink("mika_l", "receipts_1"), link("legal_l", "receipts_1")),
    ref=[act("add_to", kind="task", name="Send Daniel the receipts", args=lines(to="$legal_l")),
         act("add_to", rows="$receipts_1", args=lines(to="$legal_l"))]),
  T("undo that", diff(link("mika_l", "receipts_1"), unlink("legal_l", "receipts_1")),
    ref=[act("undo")]),
  T("mark it done, sent them this morning", diff(upd("receipts_1", status="completed", completed=ANY)),
    ref=[act("complete", rows="$receipts_1")]))

S("T25-057", "five turns hydro count complete undo field reschedule",
  T("did Pay Hydro bill get done this month", rows("hydro_10"),
    ref=[ans(kind="task", name="Pay Hydro bill", when=U("month", 0))]),
  T("how many have i paid since june", val(4),
    ref=[ans(op="count", kind="task", name="Pay Hydro bill", where='status = "completed"')]),
  T("mark this month's one done", diff(upd("hydro_10", status="completed", completed=ANY)),
    ref=[act("complete", rows="$hydro_10")]),
  T("undo, the payment bounced", diff(upd("hydro_10", status="open", completed=None)),
    ref=[act("undo")]),
  T("push it to friday", diff(upd("hydro_10", date="2026-10-16")),
    ref=[act("reschedule", rows="$hydro_10", args=lines(to=U("week", 1, weekday=5)))]))

S("T25-058", "compute min debt group sum direction",
  T("smallest open debt each way", vgroups({"owes_me": (12, "CAD"), "i_owe": (25, "CAD")}),
    ref=[comp(op="min", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]),
  T("and total open each way", vgroups({"owes_me": (416.5, "CAD"), "i_owe": (535, "CAD")}),
    ref=[comp(op="sum", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]))

S("T25-059", "create notebook edit new add_to note",
  T("new notebook Co-parenting", diff(new("notebook", name="Co-parenting")),
    ref=[act("create", args=lines(kind="notebook", name="Co-parenting"))]),
  T("rename it Co-parenting log", diff(upd("+1", name="Co-parenting log")),
    ref=[act("edit", rows="$c1", args=lines(name="Co-parenting log"))]),
  T("move Custody schedule into it", diff(unlink("mika_nb", "custody"), link("+1", "custody")),
    ref=[act("add_to", kind="note", name="Custody schedule", args=lines(to="$c1"))]))

S("T25-060", "four turns create notebook edit new note month add_to",
  T("make a notebook Tremblant 2026", diff(new("notebook", name="Tremblant 2026")),
    ref=[act("create", args=lines(kind="notebook", name="Tremblant 2026"))]),
  T("call it Tremblant trip", diff(upd("+1", name="Tremblant trip")),
    ref=[act("edit", rows="$c1", args=lines(name="Tremblant trip"))]),
  T("my notes from october?",
    rows("s11_thoughts", "tremblant_pack", "talking_points", "one_on_one_n", "ped_questions", "grocery_tg",
         "ski_note"),
    ref=[ans(kind="note", when=U("month", 0, name=10))]),
  T("put Tremblant packing list in the new notebook", diff(unlink("hike_nb", "tremblant_pack"), link("+1", "tremblant_pack")),
    ref=[act("add_to", rows="$tremblant_pack", args=lines(to="$c1"))]))

S("T25-062", "event month open end count",
  T("anything on from december on", rows("book_12"),
    ref=[ans(kind="event", when={"from": U("month", 0, name=12)})]),
  T("how many book clubs are left this year", val(3),
    ref=[ans(op="count", kind="event", name="Book club", when={"from": U("day", 0)})]))

S("T25-063", "four turns trashed event find-only restore prev restore person undo restore",
  T("did i delete Drinks with Kevin", rows("drinks_kevin"),
    ref=[find(kind="event", name="Drinks with Kevin", trashed=True), ans(rows="@prev")]),
  T("restore it", diff(restore("drinks_kevin")),
    ref=[act("restore", rows="@prev")]),
  T("and bring back Kevin Lambert too", diff(restore("kevin_l")),
    ref=[act("restore", kind="person", name="Kevin Lambert", trashed=True)]),
  T("undo that, he can stay gone", diff(trash("kevin_l")),
    ref=[act("undo")]))

S("T25-064", "duplicate tasks read delete prev multi",
  T("Submit expense report, which ones do i have", rows("expense_1", "expense_2"),
    ref=[ans(kind="task", name="Submit expense report")]),
  T("delete both, finance does it", diff(trash("expense_1"), trash("expense_2")),
    ref=[act("delete", rows="@prev")]))

S("T25-065", "note notebook person count delete where",
  T("hiking notebook notes that are about someone", rows("orford_notes", "tremblant_pack"),
    ref=[ans(kind="note", linked_to="$hike_nb", where="person count != 0")]),
  T("delete the one that says parking was full by 9", diff(trash("orford_notes")),
    ref=[act("delete", kind="note", where='body contains "parking full"')]))

S("T25-066", "restore note where month trashed read",
  T("restore the note i deleted that i'd written in september", diff(restore("old_grocery")),
    ref=[act("restore", kind="note", trashed=True, when=U("month", 0, name=9))]),
  T("is Anniversary ideas in the trash too", rows("anniv_note"),
    ref=[ans(kind="note", name="Anniversary ideas", trashed=True)]))

S("T25-067", "document named read delete prev",
  T("show me the Mika passport application", rows("passport_app"),
    ref=[ans(kind="document", name="Mika passport application")]),
  T("delete it, we did it all at the office", diff(trash("passport_app")),
    ref=[act("delete", rows="@prev")]))

S("T25-068", "four turns create document add_to delete restore new",
  T("new doc Holiday schedule draft", diff(new("document", name="Holiday schedule draft")),
    ref=[act("create", args=lines(kind="document", name="Holiday schedule draft"))]),
  T("put it in the Divorce folder", diff(link("divorce_f", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$divorce_f"))]),
  T("delete it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("wait restore that, wrong doc", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

S("T25-069", "refused delete folder ask remove_from multi delete",
  T("delete the Taxes 2025 folder", ask(),
    ref=[bad(act("delete", kind="folder", name="Taxes 2025")),
         askc("it still holds 2 documents, so it can't be deleted yet. take them out first?")]),
  T("yes take Notice of assessment 2025 and T4 from Lumen out, then delete it",
    diff(unlink("taxes_f", "noa"), unlink("taxes_f", "t4"), gone("taxes_f")),
    ref=[act("remove_from", rows="$noa, $t4", args=lines(from_="$taxes_f"), more=True),
         act("delete", rows="$taxes_f")]))

S("T25-070", "photo last month within person count delete prev multi",
  T("photos from last month",
    rows("hilaire_summit", "hilaire_lake", "orford_ridge", "orford_group", "fall_colours", "book_sept", "apples"),
    ref=[ans(kind="photo", when=U("month", -1))]),
  T("which of those have nobody in them", rows("hilaire_lake", "fall_colours"),
    ref=[ans(kind="photo", within="@prev", where="person count = 0")]),
  T("delete them", diff(trash("hilaire_lake"), trash("fall_colours"), unlink("hikes_album", "hilaire_lake")),
    ref=[act("delete", rows="@prev")]))

S("T25-071", "photo date within album remove_from prev",
  T("pics from oct third", rows("tooth", "rainy"),
    ref=[ans(kind="photo", when=D("2026-10-03"))]),
  T("which are in the Mika album", rows("tooth"),
    ref=[ans(kind="photo", within="@prev", linked_to="$mika_album")]),
  T("take it out of there", diff(unlink("mika_album", "tooth")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$mika_album"))]))

S("T25-073", "empty result locker search delete prev",
  T("gym card in my locker?", rows("climbing"),
    ref=[find(kind="locker item", name="gym card"), search("gym", kind="locker item"), ans(rows="$climbing")]),
  T("delete it, i cancelled", diff(trash("climbing")),
    ref=[act("delete", rows="@prev")]))

S("T25-074", "star locker where read starred",
  T("star my gym pass", diff(upd("climbing", starred=True)),
    ref=[act("star", kind="locker item", where='type = "membership"')]),
  T("starred stuff in the locker, besides that", rows("banking", "visa"),
    ref=[ans(kind="locker item", where="starred = yes", exclude="$climbing")]))

S("T25-075", "folder linked edit prev",
  T("which folder is Lease 2026 in", rows("apt_f"),
    ref=[ans(kind="folder", linked_to="$lease")]),
  T("rename it Apartment on Laurier", diff(upd("apt_f", name="Apartment on Laurier")),
    ref=[act("edit", rows="@prev", args=lines(name="Apartment on Laurier"))]))
