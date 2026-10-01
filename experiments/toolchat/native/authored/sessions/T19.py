from gold import *
import json

world("T19", "2026-04-14T20:40", "Fatima Al-Sayed", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T19-001", "star person where starred read",
  T("star baba's endocrinologist", diff(upd("dr_fassi", starred=True)),
    ref=[act("star", kind="person", where='role contains "endocrinologist"')]),
  T("who else is starred", rows("youssef_a", "baba", "salma"),
    ref=[ans(kind="person", where="starred = yes", exclude="$dr_fassi")]))

S("T19-002", "find person role star prev log",
  T("who's the night duty pharmacist again", rows("kenza"),
    ref=[find(kind="person", where='role contains "night duty"'), ans(rows="@prev")]),
  T("star her", diff(upd("kenza", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("and log a coffee with her, we had one after the shift", diff(upd("kenza", date=ANY)),
    ref=[act("log", rows="$kenza", args=lines(kind="coffee"))]))

S("T19-003", "create event weekday time read cancel new",
  T("put Pharmacy inspection on thursday at 10am",
    diff(new("event", name="Pharmacy inspection", date="2026-04-16T10:00")),
    ref=[act("create", args=lines(kind="event", name="Pharmacy inspection",
                                  date=U("week", 0, weekday=4, time="10:00")))]),
  T("what's on thursday now", rows("run_0416", "+1", "ptm", "yoga"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=4)))]),
  T("inspector postponed. cancel it", diff(upd("+1", status="cancelled")),
    ref=[act("cancel", rows="$c1")]))

S("T19-004", "single delete event where weekday time",
  T("delete whatever i had at 7pm this thursday, not happening", diff(trash("yoga")),
    ref=[act("delete", kind="event", when=W(U("week", 0, weekday=4, time="19:00")))]))

S("T19-005", "complete task multi list read",
  T("buy adam's swimming goggles and sign adam's homework book, both done",
    diff(upd("goggles", status="completed", completed=ANY), upd("homework", status="completed", completed=ANY)),
    ref=[act("complete", rows="$goggles, $homework")]),
  T("what's open on the kids list", rows("fees", "lina_forms", "rota_mail"),
    ref=[ans(kind="task", linked_to="$kids_l", where='status = "open"')]))

S("T19-006", "create task complete reopen new",
  T("remind me to call Rkia about next week's visits, tomorrow",
    diff(new("task", name=has("Rkia"), date="2026-04-15")),
    ref=[act("create", args=lines(kind="task", name="Call Rkia about next week's visits", date=U("day", 1)))]),
  T("rang her, tick it", diff(upd("+1", status="completed", completed=ANY)),
    ref=[act("complete", rows="$c1")]),
  T("ugh it went to voicemail. reopen that", diff(upd("+1", status="open", completed=None)),
    ref=[act("reopen", rows="$c1")]))

S("T19-007", "edit note named read",
  T("add 1.52 after dinner tonight to glucose readings april",
    diff(upd("readings", body=has("1.52"))),
    ref=[find(kind="note", name="Glucose readings April"),
         act("edit", rows="$readings",
             args=lines(body="fasting 1.32, 1.28, 1.45 after couscous on Friday, 1.52 after dinner tonight"))]),
  T("is that one pinned?", rows("readings"),
    ref=[ans(rows="$readings")]))

S("T19-008", "delete note named undo delete",
  T("delete the car service notes, the garage has it all", diff(trash("car_note")),
    ref=[act("delete", kind="note", name="Car service notes")]),
  T("no wait undo, i need the tyre bit", diff(restore("car_note")),
    ref=[act("undo")]))

S("T19-009", "edit document where today add_to",
  T("the scan i made today is baba's new prescription, call it Baba's prescription April",
    diff(upd("scan_41", name="Baba's prescription April")),
    ref=[act("edit", kind="document", when=W(U("day", 0)), args=lines(name="Baba's prescription April"))]),
  T("and file it under baba medical", diff(link("f_baba", "scan_41")),
    ref=[act("add_to", rows="$scan_41", args=lines(to="$f_baba"))]))

S("T19-010", "documents no folder find within delete prev",
  T("which documents haven't been filed anywhere", rows("scan_41", "scan_42", "bus_tickets"),
    ref=[ans(kind="document", where="folder count = 0")]),
  T("just the scans", rows("scan_41", "scan_42"),
    ref=[find(within="@prev", name="Scan"), ans(rows="@prev")]),
  T("delete them both, i have the paper copies", diff(trash("scan_41"), trash("scan_42")),
    ref=[act("delete", rows="@prev")]))

S("T19-011", "single create document add_to new",
  T("new doc Fire safety certificate 2026, put it in pharmacy papers",
    diff(new("document", name="Fire safety certificate 2026"), link("f_pharm", "new")),
    ref=[act("create", args=lines(kind="document", name="Fire safety certificate 2026"), more=True),
         act("add_to", rows="$new", args=lines(to="$f_pharm"))]))

S("T19-012", "edit photo named star",
  T("rename rain on the boulevard to Rain on Zerktouni", diff(upd("rain", name="Rain on Zerktouni")),
    ref=[act("edit", rows="$rain", args=lines(name="Rain on Zerktouni"))]),
  T("star it too, it's a nice one", diff(upd("rain", starred=True)),
    ref=[act("star", rows="$rain")]))

S("T19-013", "create album add_to photo named",
  T("make an album called Baba's health", diff(new("album", name="Baba's health")),
    ref=[act("create", args=lines(kind="album", name="Baba's health"))]),
  T("put the glucometer reading photo in it", diff(link("+1", "meter")),
    ref=[act("add_to", rows="$meter", args=lines(to="$c1"))]),
  T("and the photo of baba's prescription", diff(link("+1", "rx_photo")),
    ref=[act("add_to", rows="$rx_photo", args=lines(to="$c1"))]))

S("T19-014", "locker edit where type url empty",
  T("on my passport entry change the note to: expires July 2026, renewal appointment May fifth",
    diff(upd("passport_l", notes=has("May 5"))),
    ref=[act("edit", kind="locker item", where='type = "passport"',
             args=lines(notes="expires July 2026, renewal appointment May 5"))]),
  T("which locker things have no website", rows("visa", "safe", "cin", "wifi_home", "wifi_pharm", "pc_pass", "ssh",
                                                 "sms_api", "passport_l", "bank_acc", "licence_l", "software",
                                                 "crypto", "ordre_card", "baba_cnss_l"),
    ref=[ans(kind="locker item", where="url is empty")]),
  T("and of those which are starred", rows("visa", "ordre_card"),
    ref=[find(kind="locker item", within="@prev", where="starred = yes"), ans(rows="@prev")]))

S("T19-015", "trashed locker restore named",
  T("is my old yahoo mail in the trash", rows("yahoo"),
    ref=[ans(kind="locker item", name="Old Yahoo mail"), ans(rows="$yahoo")]),
  T("restore it, i need an old email from the ordre", diff(restore("yahoo")),
    ref=[act("restore", rows="$yahoo")]))

S("T19-016", "locker create note reveal new",
  T("save the pharmacy alarm code in the locker: 4471, disarm within 30 seconds",
    diff(new("locker item", name=has("alarm"))),
    ref=[act("create", args=lines(kind="locker item", name="Pharmacy alarm code", type="note",
                                  notes="4471, disarm within 30 seconds"))]),
  T("what was the code", diff(reveal=[("+1", "4471")]),
    ref=[act("reveal", rows="$c1", kind="locker item", args=lines(field="notes"))]))

S("T19-017", "empty notebook delete prev",
  T("notebooks with no notes in them, got any", rows("nb_ramadan"),
    ref=[ans(kind="notebook", where="note count = 0")]),
  T("delete it", diff(gone("nb_ramadan")),
    ref=[act("delete", rows="@prev")]))

S("T19-018", "list task count find edit prev",
  T("which list has nothing on it", rows("summer_l"),
    ref=[find(kind="list", where="task count = 0"), ans(rows="@prev")]),
  T("rename it Agadir in July", diff(upd("summer_l", name="Agadir in July")),
    ref=[act("edit", rows="@prev", args=lines(name="Agadir in July"))]))

S("T19-019", "create person add_to group settle_up new already",
  T("add Loubna Rami, the new cashier, and put her in the coffee fund",
    diff(new("person", name="Loubna Rami", role=ANY), link("coffee", "new")),
    ref=[act("create", args=lines(kind="person", name="Loubna Rami", role="cashier"), more=True),
         act("add_to", rows="$new", args=lines(to="$coffee"))]),
  T("settle her up in the fund so she starts clean", diff(already=["+1"]),
    ref=[act("settle_up", rows="$c1", kind="person", args=lines(group="$coffee")), ans(rows="$c1")]))

S("T19-020", "single decline out_of_scope",
  T("can you place tomorrow's order on the wholesaler site for me", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T19-021", "compute sum group status pharmacy list",
  T("how much work is left on the pharmacy list, total minutes by status",
    vgroups({"open": 350, "completed": 80, "in_progress": 0, "cancelled": 0}),
    ref=[comp(op="sum", field="effort", group="status", kind="task", linked_to="$pharm_l"), ans(value="@prev")]),
  T("which open ones are the long ones, over an hour", rows("count_sheets"),
    ref=[ans(kind="task", linked_to="$pharm_l", where='status = "open" and effort > 60')]))

S("T19-022", "ambiguous locker reveal pick",
  T("what's the wifi password", rows("wifi_home", "wifi_pharm"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("show me the pharmacy one", diff(reveal=[("wifi_pharm", "Maarif-Pharma-5G")]),
    ref=[act("reveal", kind="locker item", name="wifi", args=lines(field="password")),
         act("reveal", rows="$wifi_pharm", args=lines(field="password"))]))

S("T19-023", "empty result task search create",
  T("did i put a task for the insuline pens", rows("insulin"),
    ref=[find(kind="task", name="insuline"), search("insuline pens", kind="task"), ans(rows="$insulin")]),
  T("when's it due", rows("insulin"),
    ref=[ans(rows="$insulin")]))

S("T19-024", "restore window note refused decline",
  T("bring back my ramadan menu note, want it for next year", ask(),
    ref=[bad(act("restore", kind="note", name="Ramadan menu", trashed=True)),
         askc("the ramadan menu was binned in february, past the 30 days, so it can't come back. start a new one?")]),
  T("no forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T19-025", "create group knock-on add_to",
  T("start a group Lina's party for splitting the costs with Youssef", diff(new("group", name="Lina's party"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Lina's party"))]),
  T("add him", diff(link("+1", "youssef_a")),
    ref=[act("add_to", rows="$youssef_a", args=lines(to="$c1"))]),
  T("and hajja zineb", diff(link("+1", "zineb")),
    ref=[act("add_to", rows="$zineb", args=lines(to="$c1"))]))
