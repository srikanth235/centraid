from gold import *

world("T21", "2026-06-06T09:00", "Grace Mwangi", "train")


S("T21-001", "create person star new",
  T("add Zawadi Mwangi to contacts, my granddaughter, kevin and naomi's little girl",
    diff(new("person", name="Zawadi Mwangi", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Zawadi Mwangi", role="granddaughter"))]),
  T("star her", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]))

S("T21-002", "group members star multi",
  T("who's in the bom tea fund", rows("peter_k", "mary_w", "joseph", "me"),
    ref=[ans(kind="person", linked_to="$bom_tea")]),
  T("star Peter Kariuki and Joseph Mutua", diff(upd("peter_k", starred=True), upd("joseph", starred=True)),
    ref=[act("star", rows="$peter_k, $joseph")]),
  T("log a coffee with mary, we sat down after the tea fund thing", diff(upd("mary_w", date=ANY)),
    ref=[act("log", kind="person", name="Mary", args=lines(kind="coffee")),
         act("log", rows="$mary_w", args=lines(kind="coffee"))]),
  T("when's the next BOM meeting", rows("bom_june"),
    ref=[ans(kind="event", name="BOM meeting", when={"from": U("day", 0)})]),
  T("remind me to print copies for it on tuesday", diff(new("task", name=has("copies"), date="2026-06-09")),
    ref=[act("create", args=lines(kind="task", name="Print BOM copies", date=U("week", 1, weekday=2)))]),
  T("is Francis Ndegwa in contacts? he used to sit on the board", rows("ndegwa"),
    ref=[ans(kind="person", name="Francis Ndegwa"), ans(kind="person", name="Francis Ndegwa", trashed=True)]))

S("T21-003", "create event day read delete new",
  T("put meeting with the KNEC officer on tuesday at 2", diff(new("event", name=has("KNEC"), date="2026-06-09T14:00")),
    ref=[act("create", args=lines(kind="event", name="Meeting with KNEC officer",
                                  date=U("week", 1, weekday=2, time="14:00")))]),
  T("what else do i have that day", rows("clinic_june", "+1"),
    ref=[ans(kind="event", when=D("2026-06-09"))]),
  T("he texted, not coming. delete it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T21-004", "single delete event named",
  T("delete funeral in molo from the calendar", diff(trash("funeral_molo")),
    ref=[act("delete", kind="event", name="Funeral in Molo")]))

S("T21-005", "reopen task where knock-on reschedule",
  T("reopen the tank cleaning one, the tank is dirty again", diff(upd("tank", status="open", completed=None)),
    ref=[act("reopen", kind="task", where='description contains "tank"')]),
  T("due next friday", diff(upd("tank", date="2026-06-12")),
    ref=[act("reschedule", rows="$tank", args=lines(to=U("week", 1, weekday=5)))]),
  T("is Lunch with Mary on for thursday? and log a call with mary, spoke this morning",
    diff(upd("mary_w", date=ANY)),
    ref=[find(kind="event", name="Lunch with Mary"),
         act("log", kind="person", name="Mary", args=lines(kind="call")),
         act("log", rows="$mary_w", args=lines(kind="call"))]))

S("T21-006", "delete task named delete photo named",
  T("delete Plant the avocado seedlings, the seedlings all dried up", diff(trash("seedlings")),
    ref=[act("delete", kind="task", name="Plant the avocado seedlings")]),
  T("and the photo of them", diff(trash("avocado")),
    ref=[act("delete", kind="photo", name="Avocado seedlings")]),
  T("when's the house help salary due", rows("tabby_pay"),
    ref=[ans(kind="task", name="house help salary"), search("house help", kind="person"),
         ans(kind="task", linked_to="$tabby")]))

S("T21-007", "note read edit prev",
  T("show me the staffing gaps note", rows("staffing"),
    ref=[ans(kind="note", name="Staffing gaps")]),
  T("add that TSC is posting a kiswahili teacher in July",
    diff(upd("staffing", body=has("July"))),
    ref=[act("edit", rows="@prev",
             args=lines(body="need a Kiswahili teacher, Collins covering ICT and maths. TSC is posting a Kiswahili teacher in July"))]))

S("T21-008", "note find delete prev",
  T("any note about the car", rows("car_notes"),
    ref=[ans(kind="note", name="car")]),
  T("fundi sorted all of it, delete that", diff(trash("car_notes")),
    ref=[act("delete", rows="@prev")]),
  T("the note on chama loans?", rows("loans"),
    ref=[ans(kind="note", name="chama loans"), search("loan", kind="note"), ans(rows="$loans")]))

S("T21-009", "notes yesterday read",
  T("what notes did i write yesterday", rows("grad_plan", "gift_ideas"),
    ref=[ans(kind="note", when=U("day", -1))]),
  T("what does the graduation one say", rows("grad_plan"),
    ref=[ans(rows="$grad_plan")]),
  T("any notes on Fundi", rows(),
    ref=[ans(kind="note", name="Fundi"), search("Fundi", kind="person"), ans(kind="note", linked_to="$githinji")]),
  T("make a note Car service checklist: brakes, AC gas, tyres",
    diff(new("note", name="Car service checklist", body=has("brakes"))),
    ref=[act("create", args=lines(kind="note", name="Car service checklist", body="brakes, AC gas, tyres"))]),
  T("file that under family", diff(link("family_nb", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$family_nb"))]))

S("T21-010", "create document edit new add_to",
  T("save a doc KNEC circular", diff(new("document", name="KNEC circular")),
    ref=[act("create", args=lines(kind="document", name="KNEC circular"))]),
  T("call it KNEC circular on assessment instead, and file it under school board",
    diff(upd("+1", name="KNEC circular on assessment"), link("board_f", "+1")),
    ref=[act("edit", rows="$c1", args=lines(name="KNEC circular on assessment"), more=True),
         act("add_to", rows="$c1", args=lines(to="$board_f"))]))

S("T21-011", "document where folder delete multi",
  T("docs with no folder, list them", rows("tsc_payslip", "grad_invite", "insurance_doc", "scan_1", "scan_2"),
    ref=[ans(kind="document", where="folder count = 0")]),
  T("scan 004 and scan 005 are blank pages, delete both", diff(trash("scan_1"), trash("scan_2")),
    ref=[act("delete", rows="$scan_1, $scan_2")]),
  T("where's the doc for Bri's graduation", rows("grad_invite"),
    ref=[ans(kind="document", name="Bri graduation"), search("graduation", kind="document"),
         ans(rows="$grad_invite")]))

S("T21-012", "remove_from document named count",
  T("pull the audit letter out of the school board folder", diff(unlink("board_f", "audit_letter")),
    ref=[act("remove_from", kind="document", name="Audit letter", args=lines(from_="$board_f"))]),
  T("how many docs left in there", val(2),
    ref=[ans(op="count", kind="document", linked_to="$board_f")]),
  T("then delete the School board folder", ask(),
    ref=[bad(act("delete", rows="$board_f")),
         askc("school board still has 2 documents, so it can't be deleted. move them out first?")]))

S("T21-013", "photo find edit prev",
  T("photos from the book fair?", rows("book_fair_p"),
    ref=[ans(kind="photo", name="book fair")]),
  T("rename it Book fair 2026", diff(upd("book_fair_p", name="Book fair 2026")),
    ref=[act("edit", rows="@prev", args=lines(name="Book fair 2026"))]),
  T("star Shiru's birthday cake", diff(upd("shiru_bday", starred=True)),
    ref=[act("star", kind="photo", name="Shiru's birthday cake")]),
  T("chuck it in the family album too", diff(already=["shiru_bday"]),
    ref=[act("add_to", rows="$shiru_bday", args=lines(to="$family_album")), ans(rows="$shiru_bday")]),
  T("which albums is it in", rows("shiru_album", "family_album"),
    ref=[find(kind="album", linked_to="$shiru_bday"), ans(rows="@prev")]))

S("T21-014", "photo span add_to prev",
  T("pics from easter weekend", rows("menengai", "lake_nakuru"),
    ref=[ans(kind="photo", when=span(D("2026-04-18"), D("2026-04-19")))]),
  T("shove those two in the family album", diff(link("family_album", "menengai"), link("family_album", "lake_nakuru")),
    ref=[act("add_to", rows="@prev", args=lines(to="$family_album"))]))

S("T21-015", "single album edit where",
  T("rename the empty album to Eldoret graduation", diff(upd("mombasa_album", name="Eldoret graduation")),
    ref=[act("edit", kind="album", where="photo count = 0", args=lines(name="Eldoret graduation"))]))

S("T21-016", "locker create edit new",
  T("add a locker login for the school bus tracker, username kiamunyi.bus",
    diff(new("locker item", name=has("bus"), type="login", username="kiamunyi.bus")),
    ref=[act("create", args=lines(kind="locker item", name="School bus tracker", type="login",
                                  username="kiamunyi.bus"))]),
  T("put school in its notes", diff(upd("+1", notes="school")),
    ref=[act("edit", rows="$c1", args=lines(notes="school"))]))

S("T21-017", "locker trashed find restore prev",
  T("anything in the locker trash?", rows("yahoo"),
    ref=[find(kind="locker item", trashed=True), ans(rows="@prev")]),
  T("bring it back, i need the old emails", diff(restore("yahoo")),
    ref=[act("restore", rows="@prev")]))

S("T21-018", "create notebook add_to note",
  T("new notebook Harambee", diff(new("notebook", name="Harambee")),
    ref=[act("create", args=lines(kind="notebook", name="Harambee"))]),
  T("move the harambee target note into it", diff(unlink("church_nb", "harambee_target"), link("+1", "harambee_target")),
    ref=[act("add_to", kind="note", name="Harambee target", args=lines(to="$c1"))]))

S("T21-019", "notebook where delete multi",
  T("which notebooks are empty", rows("diary_nb", "scratch_nb"),
    ref=[ans(kind="notebook", where="note count = 0")]),
  T("delete both", diff(gone("diary_nb"), gone("scratch_nb")),
    ref=[act("delete", rows="@prev")]))

S("T21-020", "single list edit multi",
  T("garden and shopping lists, set area to home", diff(upd("garden_l", area="home"), upd("shopping_l", area="home")),
    ref=[act("edit", rows="$garden_l, $shopping_l", args=lines(area="home"))]))

S("T21-021", "group where count edit where",
  T("which groups have four people or fewer", rows("harambee", "bom_tea", "family", "grad_trip"),
    ref=[ans(kind="group", where="person count <= 4")]),
  T("the empty one, call it Brian's graduation", diff(upd("grad_trip", name="Brian's graduation")),
    ref=[act("edit", kind="group", where="person count <= 1", args=lines(name="Brian's graduation"))]))

S("T21-022", "create group add_to members read",
  T("create a group Shiru's trip fund", diff(new("group", name="Shiru's trip fund"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Shiru's trip fund"))]),
  T("add Esther Njeri and James Maina", diff(link("+1", "esther"), link("+1", "james")),
    ref=[act("add_to", rows="$esther, $james", args=lines(to="$c1"))]),
  T("who's in it now", rows("me", "esther", "james"),
    ref=[ans(kind="person", linked_to="$c1")]))

S("T21-023", "compute max debt direction",
  T("biggest open debt each way", vgroups({"owes_me": (15000, "KES"), "i_owe": (4500, "KES")}),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]),
  T("and who is the 15000 one", rows("d_brian"),
    ref=[ans(kind="debt", where='amount = 15000')]),
  T("Rent deposit Eldoret, brian paid me back. settle it", diff(upd("d_brian", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Rent deposit Eldoret")]),
  T("so what's the biggest one owed to me", val((2000, "KES")),
    ref=[ans(op="max", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("and the least open amount either direction", vgroups({"owes_me": (500, "KES"), "i_owe": (500, "KES")}),
    ref=[comp(op="min", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]))

S("T21-024", "decline sealed_egress reveal",
  T("whatsapp the home wifi password to kevin", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("ok show it to me", diff(reveal=[("wifi", "flamingo-2026")]),
    ref=[act("reveal", kind="locker item", name="Home wifi", args=lines(field="password"))]),
  T("add a meeting with the fundi about the gutter", ask(),
    ref=[askc("what day and time?")]))

S("T21-025", "ambiguous folder ask edit",
  T("rename the school folder to BOM papers", ask("board_f", "fees_f"),
    ref=[act("edit", kind="folder", name="School", args=lines(name="BOM papers")),
         askc("school board or school fees?", options="$board_f, $fees_f")]),
  T("the board one", diff(upd("board_f", name="BOM papers")),
    ref=[act("edit", rows="$board_f", args=lines(name="BOM papers"))]))
