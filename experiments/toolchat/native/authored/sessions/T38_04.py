from gold import *
import json


def J(d):
    return json.dumps(d, separators=(",", ":"))


FROM_NOW = J({"from": U("day", 0)})


S("T38-076", "same-word dana-school folder-vs-list add_to document container-collision list-read open",
  T("file dana's 2024 report card in her school folder and show me what's in there now",
    rows("doc_013", "doc_014", "doc_015", "doc_043", "doc_044", "doc_045", "doc_073", "doc_074", "doc_075",
         also=diff(link("schoolf", "doc_013"))),
    ref=[act("add_to", kind="document", name="Dana report card 2024", args="to: $schoolf", more=True),
         ans(kind="document", linked_to="$schoolf")]),
  T("and what's still open on her school list",
    rows("t_068", "dana_reg", "dana_reg_1", "dana_reg_2", "dana_reg_3", "dana_reg_4"),
    ref=[ans(kind="task", linked_to="$dana_l", where="status = open")]),
  T("put dana's drawing in her school album", ask("ph_loose_267", "ph_loose_282", "ph_loose_297"),
    ref=[act("add_to", kind="photo", name="Dana's drawing", args="to: $dana_a")]))

S("T38-077", "same-word yazan-studies list-vs-album identical-name count two-row-linked person-photos",
  T("what's open on yazan's studies", rows("grad27", "grad27_2", "grad27_3", "grad27_4", "grad27_5"),
    ref=[ans(kind="task", linked_to="$yazan_l", where="status = open")]),
  T("and how many photos are in yazan's studies", val(22),
    ref=[ans(op="count", kind="photo", linked_to="$grad_a")]),
  T("which of those have yazan in them",
    rows("ph_grad_a_01", "ph_grad_a_07", "ph_grad_a_10", "ph_grad_a_11", "ph_grad_a_14", "ph_grad_a_15"),
    ref=[ans(kind="photo", linked_to="$grad_a, $yazan")]))

S("T38-078", "same-word teta person-album-list-group-folder photos star document year read album-decides-photo",
  T("star teta's pension statement from 2026", diff(upd("doc_084", starred=True)),
    ref=[act("star", kind="document", name="Teta's pension statement", when=J(U("year", -1)))]),
  T("who's in teta's care", rows("layla_h", "ammo_fadi", "khalto_rima", "omar_k", "me"),
    ref=[ans(kind="person", linked_to="$teta_care")]),
  T("star the at teta's 2 photo from eid 2026", diff(upd("ph_eid26_09", starred=True)),
    ref=[act("star", kind="photo", name="At Teta's 2", linked_to="$eid26")]))

S("T38-079", "same-word school-photos debt-vs-task settle_debt person-possessor read complete",
  T("yazan paid me back for the school photos, mark it settled", diff(upd("debt_39", status="settled")),
    ref=[search("Yazan", kind="person"),
         act("settle_debt", kind="debt", name="school photos", linked_to="$yazan")]),
  T("is samar's school photos one still open", rows("debt_24"),
    ref=[search("Samar", kind="person"),
         ans(kind="debt", name="school photos", linked_to="$samar_shraideh", where="status = open")]),
  T("and tick off ordering dana's school photos, did it today", diff(upd("t_068", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Order Dana's school photos")]),
  T("and star the card i use for the clinic", diff(upd("clinic_card", starred=True)),
    ref=[act("star", kind="locker item", name="clinic", where="type = card")]))

S("T38-080", "same-word both-events cancel car-service eye-test empty-read then two-yousefs star ask gloss",
  T("mama's eye test and the car service are both off, cancel them",
    diff(upd("oo_065", status="cancelled"), upd("oo_034", status="cancelled")),
    ref=[act("cancel", kind="event", name="Eye test", when=FROM_NOW, more=True),
         act("cancel", kind="event", name="Car service", when=FROM_NOW)]),
  T("any car service left", rows(),
    ref=[ans(kind="event", name="Car service", where="status != cancelled", when=FROM_NOW)]),
  T("star yousef", ask("yousef_a", "yousef_n"),
    ref=[act("star", kind="person", name="Yousef")]),
  T("the one from the clinic", diff(upd("yousef_n", starred=True)),
    ref=[act("star", kind="person", name="Yousef", where='met = "clinic"')]))

S("T38-081", "create-args locker login user-label url wifi implied-type",
  T("new login for the lab supplier portal, user nour.lab, the site is medlab.jo",
    diff(new("locker item", name=has("lab"), type="login", username="nour.lab", url=has("medlab"))),
    ref=[act("create", args=lines(kind="locker item", name="Lab supplier portal", type="login", username="nour.lab",
                                  url="medlab.jo"))]),
  T("also save the guest wifi at the clinic", diff(new("locker item", name=has("guest"), type="wifi")),
    ref=[act("create", args=lines(kind="locker item", name="Clinic guest wifi", type="wifi"))]))

S("T38-082", "create-args person label-word purpose-clause role nickname one-attribute-per-line cadence",
  T("new contact, name lama nabulsi, role pastry chef, nickname lulu, she does the clinic cakes",
    diff(new("person", name="Lama Nabulsi", role="pastry chef", nickname="Lulu")),
    ref=[act("create", args=lines(kind="person", name="Lama Nabulsi", role="pastry chef", nickname="Lulu"))]),
  T("and i should call her every three weeks or so", diff(upd("+1", cadence=21)),
    ref=[act("edit", rows="$c1", args="cadence: 21")]))

S("T38-083", "create-args task-vs-event call-tradesperson appointment errand",
  T("call the plumber about the kitchen tap on friday, it's been dripping all week",
    diff(new("task", name=has("plumber"), date="2027-05-14")),
    ref=[act("create", args=lines(kind="task", name="Call the plumber about the kitchen tap", date=U("week", 0, weekday=5)))]),
  T("dentist for yazan thursday at 4", diff(new("event", name=has("dentist"), date="2027-05-13T16:00")),
    ref=[act("create", args=lines(kind="event", name="Dentist - Yazan", date=U("week", 0, weekday=4, time="16:00")))]),
  T("pick up mama's cake from the bakery saturday",
    diff(new("task", name=has("cake"), date="2027-05-15")),
    ref=[act("create", args=lines(kind="task", name="Pick up Mama's cake from the bakery",
                                  date=U("week", 0, weekday=6)))]))

S("T38-084", "create-args container-link task-list note-notebook album purpose-clause",
  T("remind me to order new gloves, clinic list, we keep running out",
    diff(new("task", name=has("gloves")), link("clinic_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Order new gloves", list="$clinic_l"))]),
  T("and a note in clinic admin, rasha wants the sterilizer serviced before eid",
    diff(new("note", name=has("sterilizer"), body=has("rasha")), link("clinic_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Sterilizer service", body="Rasha wants the sterilizer serviced before Eid",
                                  notebook="$clinic_nb"))]),
  T("make an album for yazan's graduation, i'll add the photos after the ceremony",
    diff(new("album", name=has("graduation"))),
    ref=[act("create", args=lines(kind="album", name="Yazan's Graduation"))]))

S("T38-085", "create-args debt direction person group currency purpose-clause two-creates-one-turn",
  T("dana owes me 3 dinars for the stickers, i'll remind her friday, and i owe mahmoud 8 for the parking",
    diff(new("debt", name=has("stickers"), amount=3, direction="owes_me"), link("new", "dana"),
         new("debt", name=has("parking"), amount=8, direction="i_owe"), link("new", "mahmoud")),
    ref=[search("Dana", kind="person"), search("Mahmoud", kind="person"),
         act("create", args=lines(kind="debt", name="stickers", amount=3, direction="owes_me", person="$dana"), more=True),
         act("create", args=lines(kind="debt", name="parking", amount=8, direction="i_owe", person="$mahmoud"))]),
  T("start a group for the eid sweets, we'll split it in dinars",
    diff(new("group", name=has("sweets"), currency="JOD"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Eid Sweets", currency="JOD"))]))

S("T38-086", "verb-choice put-it-back after remove_from document folder add_to then after a task move to a list add_to back",
  T("take the 2025 internet contract out of the rent and utilities folder", diff(unlink("rentf", "doc_033")),
    ref=[act("remove_from", kind="document", name="Internet contract 2025", args="from: $rentf")]),
  T("put it back", diff(link("rentf", "doc_033")),
    ref=[act("add_to", rows="$doc_033", args="to: $rentf")]),
  T("and move the cleaning service booking to the home list", diff(unlink("clinic_l", "t_111"), link("home_l", "t_111")),
    ref=[act("add_to", kind="task", name="Book the cleaning service", where="status = open", args="to: $home_l")]),
  T("no, put it back on the clinic list", diff(unlink("home_l", "t_111"), link("clinic_l", "t_111")),
    ref=[act("add_to", kind="task", name="Book the cleaning service", where="status = open", args="to: $clinic_l")]))

S("T38-087", "verb-choice put-it-back after delete document restore same row as the remove session",
  T("delete the 2025 internet contract, we changed provider", diff(trash("doc_033")),
    ref=[act("delete", kind="document", name="Internet contract 2025")]),
  T("put it back", diff(restore("doc_033")),
    ref=[act("restore", rows="$doc_033")]),
  T("and the 2024 one, i deleted that last week", diff(restore("doc_003")),
    ref=[find(kind="document", name="Internet contract 2024", trashed=True), act("restore", rows="@prev")]))

S("T38-088", "verb-choice mark-in-progress edit status task subtasks read",
  T("mark booking the photographer as in progress, i've rung a few",
    diff(upd("grad27_2", status="in_progress")),
    ref=[act("edit", kind="task", name="Book the photographer", args="status: in_progress")]),
  T("and the invitations one too, then show me which graduation jobs are in progress",
    rows("grad27_2", "grad27_5", also=diff(upd("grad27_5", status="in_progress"))),
    ref=[act("edit", kind="task", name="Print the invitations", args="status: in_progress", more=True),
         ans(kind="task", linked_to="$grad27", where="status = in_progress")]),
  T("make a second yazan's studies list for his masters, this one's nearly done",
    diff(new("list", name="Yazan's Studies")),
    ref=[act("create", args=lines(kind="list", name="Yazan's Studies"))]))

S("T38-089", "verb-choice reschedule-time make-it-hour no-wait-weekday bare-fragment duration edit",
  T("push tomorrow's call with teta to friday", diff(upd("ct_270513", date="2027-05-14T19:00")),
    ref=[act("reschedule", kind="event", name="Call Teta", when=J(U("day", 1)), args=lines(to=U("week", 0, weekday=5)))]),
  T("make it 6", diff(upd("ct_270513", date="2027-05-14T18:00")),
    ref=[act("reschedule", rows="$ct_270513", args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("no wait, saturday", diff(upd("ct_270513", date="2027-05-15T18:00")),
    ref=[act("reschedule", rows="$ct_270513", args=lines(to=U("week", 0, weekday=6)))]),
  T("half an hour", diff(upd("ct_270513", duration=30)),
    ref=[act("edit", rows="$ct_270513", args="duration: 30")]))

S("T38-090", "verb-choice log-idioms call coffee block-time create-event add-another create",
  T("khalto rima just rang me about the dinner", diff(upd("khalto_rima", date=ANY)),
    ref=[act("log", kind="person", name="Khalto Rima", args="kind: call")]),
  T("had a coffee with husam this afternoon", diff(upd("husam", date=ANY)),
    ref=[act("log", kind="person", name="Husam", args="kind: coffee")]),
  T("block monday 10 to 12 for the accountant",
    diff(new("event", name=has("accountant"), date="2027-05-17T10:00", duration=120)),
    ref=[act("create", args=lines(kind="event", name="Accountant", date=U("week", 1, weekday=1, time="10:00"),
                                  duration=120))]),
  T("add another one thursday, same time", diff(new("event", name=has("accountant"), date="2027-05-13T10:00", duration=120)),
    ref=[act("create", args=lines(kind="event", name="Accountant", date=U("week", 0, weekday=4, time="10:00"),
                                  duration=120))]))

S("T38-091", "stop-signals miss decoy-near-hit visit-events-on-vault-line empty answer then person-link miss then write miss",
  T("when's the vet visit", rows(),
    ref=[ans(kind="event", name="vet")]),
  T("when is dana's dentist appointment", rows(),
    ref=[ans(kind="event", name="dentist", linked_to="$dana")]),
  T("cancel the piano lesson, she's given it up", decline("not_found"),
    ref=[act("cancel", kind="event", name="Piano lesson")]))

S("T38-092", "stop-signals never_mind middle end by-name delete missing row start after a read",
  T("what's on tomorrow", rows("ct_270513"),
    ref=[ans(kind="event", when=J(U("day", 1)), where="status != cancelled")]),
  T("push the call with teta to friday, no wait never mind, thursday's fine", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("delete dana's piano lesson, actually forget it, she's not going anyway", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("never mind the supplies order, i'll do it myself", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T38-093", "stop-signals fyi no-request ask statement about a shown row then confirm write",
  T("is the orange internet payment still open", rows("net_270515"),
    ref=[ans(kind="task", name="Pay Orange internet", where="status = open")]),
  T("fyi i already paid it", ask(),
    ref=[askc("Want me to mark it as done?")]),
  T("yes tick it off", diff(upd("net_270515", status="completed", completed=ANY)),
    ref=[act("complete", rows="$net_270515")]))

S("T38-094", "stop-signals everything-except-one unbounded then bounded delete read",
  T("delete everything in the garden notebook except the herb garden plan", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("ok just the lemon tree one, then show me what's left in the notebook",
    rows("gar_1", "gar_3", also=diff(trash("gar_2"))),
    ref=[act("delete", kind="note", name="Lemon tree notes", more=True),
         ans(kind="note", linked_to="$garden_nb")]))

S("T38-095", "stop-signals off-topic out_of_scope after a vault read decoy focus row",
  T("when's yazan's next football game", rows("yf_270522"),
    ref=[ans(kind="event", name="Yazan's football", where="status != cancelled", when=FROM_NOW, order="date asc", limit=1)]),
  T("and who won the last one", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T38-096", "set-answers role-noun dentist exact-role decoys log then stationery-supplier live-vs-trashed namesake",
  T("who's my dentist", rows("nabila_abu_ghosh"),
    ref=[ans(kind="person", where='role = "dentist"')]),
  T("log a call with her, i just booked the cleaning", diff(upd("nabila_abu_ghosh", date=ANY)),
    ref=[act("log", rows="$nabila_abu_ghosh", args="kind: call")]),
  T("who's the stationery supplier", rows("amani_rawashdeh"),
    ref=[ans(kind="person", where='role = "stationery supplier"')]),
  T("and the one i deleted", rows("zahra_haddad"),
    ref=[ans(kind="person", where='role = "stationery supplier"', trashed=True)]))

S("T38-097", "set-answers debts both-directions accountant i_owe owes_me settle_debt balance",
  T("do i still owe the accountant anything", rows("debt_41"),
    ref=[search("accountant", kind="person"),
         ans(kind="debt", linked_to="$accountant", where="direction = i_owe and status = open")]),
  T("and going the other way", rows("debt_10"),
    ref=[ans(kind="debt", linked_to="$accountant", where="direction = owes_me and status = open")]),
  T("he's paid me that one, tick it off and tell me what the net is between us now",
    val((-155.5, "JOD"), also=diff(upd("debt_10", status="settled"))),
    ref=[act("settle_debt", kind="debt", linked_to="$accountant", where="direction = owes_me and status = open", more=True),
         ans(op="balance", kind="person", rows="$accountant")]))

S("T38-098", "set-answers two-same-word-events weekday decides lunch sunday friday reschedule attendees",
  T("what time's lunch on sunday", rows("eid_a27"),
    ref=[ans(kind="event", name="lunch", when=J(U("week", 0, weekday=7)))]),
  T("and the friday one", rows("fl_270514"),
    ref=[ans(kind="event", name="lunch", when=J(U("week", 0, weekday=5)))]),
  T("push the sunday one to 1", diff(upd("eid_a27", date="2027-05-16T13:00")),
    ref=[act("reschedule", kind="event", name="lunch", when=J(U("week", 0, weekday=7)),
             args=lines(to=U("day", 0, anchor="row", time="13:00")))]),
  T("who's going to it", rows("teta", "ammo_fadi", "baba"),
    ref=[ans(kind="person", linked_to="$eid_a27")]))
