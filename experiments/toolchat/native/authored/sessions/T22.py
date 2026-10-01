from gold import *
import json

world("T22", "2026-07-13T21:25", "Sven Lindqvist", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T22-001", "star person multi unstar named starred read",
  T("star Lennart and Karin, they're both helping with the party", diff(upd("lennart", starred=True), upd("karin", starred=True)),
    ref=[act("star", rows="$lennart, $karin")]),
  T("and unstar Erik Sjöberg", diff(upd("erik_s", starred=False)),
    ref=[act("unstar", rows="$erik_s")]),
  T("who's starred now", rows("ahmed", "birgitta", "lennart", "karin", "david"),
    ref=[ans(kind="person", where="starred = yes")]))

S("T22-002", "unstar named nickname empty",
  T("take the star off david kim", diff(upd("david", starred=False)),
    ref=[act("unstar", kind="person", name="David Kim")]),
  T("which padel people don't have a nickname saved", rows("erik_s", "erik_l", "hanna", "mats"),
    ref=[ans(kind="person", where='nickname is empty and role contains "padel"')]))

S("T22-003", "single cadence literal",
  T("who do i only need to check in with less than every two weeks", rows("johan_b", "samira", "nour", "linnea", "maria"),
    ref=[ans(kind="person", where="cadence > 14")]))

S("T22-004", "group person count edit group named count",
  T("which groups have more than five people in them", rows("padel_g", "fika_g"),
    ref=[ans(kind="group", where="person count > 5")]),
  T("rename the fika fund one to Late shift fika", diff(upd("fika_g", name="Late shift fika")),
    ref=[act("edit", rows="$fika_g", args=lines(name="Late shift fika"))]),
  T("how many people in it", val(6),
    ref=[ans(op="count", kind="person", linked_to="$fika_g")]))

S("T22-005", "find-only group edit group prev",
  T("the group that's me karin and gunnar, what's it called", rows("crayfish_g"),
    ref=[find(kind="group", where="person count < 4"), ans(rows="@prev")]),
  T("call it Crayfish party instead, we do it every year", diff(upd("crayfish_g", name="Crayfish party")),
    ref=[act("edit", rows="@prev", args=lines(name="Crayfish party"))]))

S("T22-006", "group currency edit group prev compute balance debt",
  T("which of my groups is in euros", rows("berlin_g"),
    ref=[ans(kind="group", where='currency = "EUR"')]),
  T("rename that to Berlin September", diff(upd("berlin_g", name="Berlin September")),
    ref=[act("edit", rows="@prev", args=lines(name="Berlin September"))]),
  T("where am i with david", val((-90, "EUR"), (-450, "SEK")),
    ref=[comp(op="balance", rows="$david"), ans(value="@prev")]),
  T("and on the debts side?", rows("d_david"),
    ref=[ans(kind="debt", linked_to="$david")]))

S("T22-007", "delete event where empty read",
  T("delete the cancelled thing on sunday", diff(trash("kayak")),
    ref=[act("delete", kind="event", when=W(U("week", 0, weekday=7)), where='status = "cancelled"')]),
  T("anything else on sunday", rows(),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=7)))]))

S("T22-008", "cancelled events delete event where named",
  T("anything get cancelled last week", rows("karin_dinner"),
    ref=[ans(kind="event", when=W(U("week", -1)), where='status = "cancelled"')]),
  T("delete all the cancelled stuff from last week", diff(trash("karin_dinner")),
    ref=[act("delete", kind="event", when=W(U("week", -1)), where='status = "cancelled"')]),
  T("and the padel match that got called off in june", diff(trash("padel_0623")),
    ref=[act("delete", kind="event", name="Padel league match", when=W(U("month", 0, name=6)),
             where='status = "cancelled"')]))

S("T22-009", "delete event multi swimming",
  T("which swimming lessons has elias got coming up", rows("swim_1", "swim_2"),
    ref=[ans(kind="event", name="Swimming lesson")]),
  T("pool's shut for repairs, delete both", diff(trash("swim_1"), trash("swim_2")),
    ref=[act("delete", rows="$swim_1, $swim_2")]))

S("T22-010", "delete event multi undo delete",
  T("delete Dinner at Karin's and Kayaking with David, neither is happening", diff(trash("karin_dinner"), trash("kayak")),
    ref=[act("delete", rows="$karin_dinner, $kayak")]),
  T("wait undo that, i want them kept for the record", diff(restore("karin_dinner"), restore("kayak")),
    ref=[act("undo")]))

S("T22-011", "reopen task prev padel list",
  T("did i book the padel court for last week", rows("court_2"),
    ref=[ans(kind="task", name="Book padel court", where='status = "completed"')]),
  T("reopen it, the booking fell through", diff(upd("court_2", status="open", completed=None)),
    ref=[act("reopen", rows="@prev")]),
  T("what's open on the padel list", rows("court_1", "court_2", "balls"),
    ref=[ans(kind="task", linked_to="$padel_l", where='status = "open"')]))

S("T22-012", "reopen task prev summer house list",
  T("what have i ticked off on the summer house list", rows("book_plumber"),
    ref=[ans(kind="task", linked_to="$sh_l", where='status = "completed"')]),
  T("reopen that, kent cancelled on us", diff(upd("book_plumber", status="open", completed=None)),
    ref=[act("reopen", rows="@prev")]))

S("T22-013", "delete task where list read",
  T("delete the cancelled task on the summer house repairs list", diff(trash("sauna")),
    ref=[act("delete", kind="task", linked_to="$shr_l", where='status = "cancelled"')]),
  T("what's left on that list", rows("roof_tile", "shutters"),
    ref=[ans(kind="task", linked_to="$shr_l")]))

S("T22-014", "delete task where list count priority literal",
  T("the cancelled task that's not on any list, delete it", diff(trash("guest_room")),
    ref=[act("delete", kind="task", where='status = "cancelled" and list count = 0')]),
  T("what's my priority one stuff", rows("car_insurance", "sh_share", "roof_tile", "aug_schedule", "inv_prep"),
    ref=[ans(kind="task", where="priority < 2")]))

S("T22-015", "create note notebook edit note new undo field",
  T("new note in padel tactics: Hanna's lob, she always goes cross court",
    diff(new("note", name="Hanna's lob", body=has("cross court")), link("padel_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Hanna's lob", body="she always goes cross court",
                                  notebook="$padel_nb"))]),
  T("add that she struggles with the bandeja too", diff(upd("+1", body=has("bandeja"))),
    ref=[act("edit", rows="$c1", args=lines(body="she always goes cross court, struggles with the bandeja"))]),
  T("hmm undo that", diff(upd("+1", body="she always goes cross court")),
    ref=[act("undo")]))

S("T22-016", "create note notebook undo create",
  T("start a note Handover for Micke in the warehouse notebook: scanners 3 and 7 are broken",
    diff(new("note", name="Handover for Micke", body=has("scanners")), link("work_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Handover for Micke", body="scanners 3 and 7 are broken",
                                  notebook="$work_nb"))]),
  T("no scrap that, undo", diff(trash("+1")),
    ref=[act("undo")]))

S("T22-017", "create note delete note new",
  T("jot down: ask Linnea about the lean course", diff(new("note", name=ANY, body=has("lean"))),
    ref=[act("create", args=lines(kind="note", name="Lean course", body="ask Linnea about the lean course"))]),
  T("delete it, i'll ask her on thursday", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T22-018", "create note edit note new delete note new",
  T("make a note Party seating: Mamma next to Pappa, Elias by Karin",
    diff(new("note", name="Party seating", body=has("Elias"))),
    ref=[act("create", args=lines(kind="note", name="Party seating", body="Mamma next to Pappa, Elias by Karin"))]),
  T("put samira next to nour too", diff(upd("+1", body=has("Samira"))),
    ref=[act("edit", rows="$c1", args=lines(body="Mamma next to Pappa, Elias by Karin, Samira next to Nour"))]),
  T("never mind, delete the note, karin's doing the seating", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T22-019", "find-only folder count edit document multi",
  T("documents sitting outside folders", rows("scan_1", "scan_2", "camp_form", "berlin_booking"),
    ref=[find(kind="document", where="folder count = 0"), ans(rows="@prev")]),
  T("scan 0417 and scan 0418 are elias's passport application, name them that",
    diff(upd("scan_1", name="Elias's passport application"), upd("scan_2", name="Elias's passport application")),
    ref=[act("edit", rows="$scan_1, $scan_2", args=lines(name="Elias's passport application"))]))

S("T22-020", "edit document multi add_to count",
  T("Scan 0417 and Scan 0418 are the two pages of the car insurance offer, call them Car insurance offer",
    diff(upd("scan_1", name="Car insurance offer"), upd("scan_2", name="Car insurance offer")),
    ref=[act("edit", rows="$scan_1, $scan_2", args=lines(name="Car insurance offer"))]),
  T("put both in the car folder", diff(link("car_f", "scan_1"), link("car_f", "scan_2")),
    ref=[act("add_to", rows="$scan_1, $scan_2", args=lines(to="$car_f"))]),
  T("how many docs in car", val(4),
    ref=[ans(op="count", kind="document", linked_to="$car_f")]))

S("T22-021", "trashed document restore named",
  T("did i delete the april payslip", rows("old_payslip"),
    ref=[ans(kind="document", name="Payslip April", trashed=True)]),
  T("bring it back, the bank wants three months", diff(restore("old_payslip")),
    ref=[act("restore", rows="$old_payslip")]))

S("T22-022", "restore document named restore window ask never mind",
  T("restore Payslip April", diff(restore("old_payslip")),
    ref=[act("restore", kind="document", name="Payslip April", trashed=True)]),
  T("and the old lease from möllevången", ask(),
    ref=[bad(act("restore", kind="document", name="Old lease Möllevången", trashed=True)),
         askc("the old lease went in the bin in may, past the 30 days, so it can't come back. want a new document for it instead?")]),
  T("no leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T22-023", "remove_from document where folder read",
  T("take whatever i filed in the IKEA folder in june back out", diff(unlink("work_f", "payslip_jun")),
    ref=[act("remove_from", kind="document", linked_to="$work_f", when=W(U("month", 0, name=6)),
             args=lines(from_="$work_f"))]),
  T("what's left in there", rows("contract", "payslip_may", "forklift_cert"),
    ref=[ans(kind="document", linked_to="$work_f")]))

S("T22-024", "remove_from document where create folder add_to new",
  T("what's in adoption papers", rows("adoption_decision", "birth_cert", "medical_rec"),
    ref=[ans(kind="document", linked_to="$adopt_f")]),
  T("pull out the one i added this month, it goes with his school stuff", diff(unlink("adopt_f", "medical_rec")),
    ref=[act("remove_from", kind="document", linked_to="$adopt_f", when=W(U("month", 0)),
             args=lines(from_="$adopt_f"))]),
  T("make a folder School and put it in there", diff(new("folder", name="School"), link("new", "medical_rec")),
    ref=[act("create", args=lines(kind="folder", name="School"), more=True),
         act("add_to", rows="$medical_rec", args=lines(to="$new"))]))

S("T22-025", "five turns photo miss search edit photo multi add_to photo multi count person count",
  T("any photo called beach day", rows("p_ribersborg", "p_bridge"),
    ref=[find(kind="photo", name="beach day"), search("beach", kind="photo"),
         ans(rows="$p_ribersborg, $p_bridge")]),
  T("call them both Beach day with Elias",
    diff(upd("p_ribersborg", name="Beach day with Elias"), upd("p_bridge", name="Beach day with Elias")),
    ref=[act("edit", rows="$p_ribersborg, $p_bridge", args=lines(name="Beach day with Elias"))]),
  T("and put them in the elias album", diff(link("elias_al", "p_ribersborg"), link("elias_al", "p_bridge")),
    ref=[act("add_to", rows="$p_ribersborg, $p_bridge", args=lines(to="$elias_al"))]),
  T("what's the total in there", val(9),
    ref=[ans(op="count", kind="photo", linked_to="$elias_al")]),
  T("out of them, the ones where over two people appear", rows("p_bday7"),
    ref=[ans(kind="photo", linked_to="$elias_al", where="person count > 2")]))
