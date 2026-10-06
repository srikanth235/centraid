from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
NOW = W({"from": U("day", 0)})
TOMORROW = W({"from": U("day", 1)})
THIS_WEEK = W(U("week", 0))
THIS_MONTH = W(U("month", 0))
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
BIG3 = find(kind="debt", where=IOWE, order="amount desc", limit=3)
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
def J(d):
    return json.dumps(d, separators=(",", ":"))
WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))


S("T19-001-P", "star person where starred read para",
  T("baba's endocrinologist gets a star", diff(upd("dr_fassi", starred=True)),
    ref=[act("star", kind="person", where='role contains "endocrinologist"')]),
  T("any other starred people", rows("youssef_a", "baba", "salma"),
    ref=[ans(kind="person", where="starred = yes", exclude="$dr_fassi")]))

S("T19-007-P", "edit note named read para",
  T("glucose readings april: tack on 1.52 after dinner tonight",
    diff(upd("readings", body=has("1.52"))),
    ref=[find(kind="note", name="Glucose readings April"),
         act("edit", rows="$readings",
             args=lines(body="fasting 1.32, 1.28, 1.45 after couscous on Friday, 1.52 after dinner tonight"))]),
  T("has it been pinned", rows("readings"),
    ref=[ans(rows="$readings")]))

S("T19-013-P", "create album add_to photo named para",
  T("new album, Baba's health", diff(new("album", name="Baba's health")),
    ref=[act("create", args=lines(kind="album", name="Baba's health"))]),
  T("glucometer reading photo goes in there", diff(link("+1", "meter")),
    ref=[act("add_to", rows="$meter", args=lines(to="$c1"))]),
  T("baba's prescription photo too", diff(link("+1", "rx_photo")),
    ref=[act("add_to", rows="$rx_photo", args=lines(to="$c1"))]))

S("T19-018-P", "list task count find edit prev para",
  T("empty list, which one", rows("summer_l"),
    ref=[find(kind="list", where="task count = 0"), ans(rows="@prev")]),
  T("call it Agadir in July from now", diff(upd("summer_l", name="Agadir in July")),
    ref=[act("edit", rows="@prev", args=lines(name="Agadir in July"))]))

S("T19-026-P", "repair refused weeks cadence people spans para",
  T("people i should check on less often than every two weeks", rows("simo", "mouhcine"),
    ref=[bad(ans(kind="person", where="cadence > 2 weeks")),
         ans(kind="person", where="cadence > 14")]),
  T("anyone i'm supposed to see at least weekly", rows("youssef_a", "baba", "dada", "nadia", "rachid", "omar",
                                                            "zineb", "samira_b", "driss", "aicha"),
    ref=[ans(kind="person", where="cadence < 8 days")]),
  T("of those, no contact since last week", rows("omar", "zineb", "driss", "aicha"),
    ref=[ans(kind="person", within="@prev", when=W({"to": U("week", -1)}))]))

S("T19-032-P", "four turns task count photo count linked para",
  T("contacts with over two tasks attached", rows("baba", "adam"),
    ref=[ans(kind="person", where="task count > 2")]),
  T("adam's tasks", rows("homework", "fees", "goggles"),
    ref=[ans(kind="task", linked_to="$adam")]),
  T("appearing in at least three photos, who", rows("adam", "lina", "baba", "youssef_a", "salma"),
    ref=[ans(kind="person", where="photo count >= 3")]),
  T("baba photos", rows("eid_table", "eid_baba", "baba_walk", "meter"),
    ref=[ans(kind="photo", linked_to="$baba")]))

S("T19-037-P", "event description in month duration within para",
  T("this month at dr kettani's clinic or piscine anfa",
    rows("lina_vacc", "adam_checkup", "swim_0401", "swim_0408", "swim_0415", "swim_0422", "swim_0429"),
    ref=[ans(kind="event", where='description in ("Dr Kettani\'s clinic", "Piscine Anfa")', when=W(U("month", 0)))]),
  T("under 45 min among them", rows("lina_vacc", "adam_checkup"),
    ref=[ans(kind="event", within="@prev", where="duration < 45")]))

S("T19-042-P", "event named month span weekday within para",
  T("school run dates, april through this friday", rows("run_0402", "run_0407", "run_0409", "run_0414", "run_0416"),
    ref=[ans(kind="event", name="School run", when=W(span(U("month", 0, name=4), U("week", 0, weekday=5))))]),
  T("the cancelled one?", rows("run_0402"),
    ref=[ans(kind="event", within="@prev", where='status = "cancelled"')]))

S("T19-047-P", "notes spans weekday date time para",
  T("notes from last monday up until noon saturday", rows("staff_apr", "ifrane_plan", "prices", "teacher_notes"),
    ref=[ans(kind="note", when=W(span(U("week", -1, weekday=1), U("week", -1, weekday=6, time="12:00"))))]),
  T("last saturday through today, then", rows("gift_ideas", "low_sugar", "generics", "fridge_note"),
    ref=[ans(kind="note", when=W(span(U("week", -1, weekday=6), U("day", 0))))]))

S("T19-052-P", "documents spans weekday named month open star para",
  T("documents between march twelfth and last friday", rows("labs", "report_card", "cnss_mar", "bus_tickets",
                                                              "invoice_apr"),
    ref=[find(kind="document", when=W(span(D("2026-03-12"), U("week", -1, weekday=5)))), ans(rows="@prev")]),
  T("since march, in kids school", rows("report_card", "fees_invoice"),
    ref=[ans(kind="document", linked_to="$f_kids", when=W({"from": U("month", 0, name=3)}))]),
  T("kids school items older than thirty-first dec 2025 6pm", rows("vacc_card"),
    ref=[ans(kind="document", linked_to="$f_kids", when=W({"to": D("2025-12-31", "18:00")}))]),
  T("nurse always wants it, give it a star", diff(upd("vacc_card", starred=True)),
    ref=[act("star", rows="$vacc_card")]))

S("T19-064-P", "seven turns school run decline cancel ambiguous ask log balance para",
  T("school run rota note's content", rows("rota_note"),
    ref=[ans(kind="note", name="School run rota")]),
  T("thursday, do i have the school run", rows("run_0416"),
    ref=[ans(kind="event", name="School run", when=W(U("week", 0, weekday=4)))]),
  T("tell the parents by text i can't do it", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("thursday's school run is off, cancel it", diff(upd("run_0416", status="cancelled")),
    ref=[act("cancel", kind="event", name="School run", when=W(U("week", 0, weekday=4)))]),
  T("i told samira on whatsapp, log that message", ask("samira_b", "samira_a"),
    ref=[act("log", kind="person", name="Samira", args=lines(kind="message")),
         askc("which samira, bennani or alaoui?", options="$samira_b, $samira_a")]),
  T("the bennani one", diff(upd("samira_b", date=ANY)),
    ref=[act("log", rows="$samira_b", args=lines(kind="message"))]),
  T("standing with driss?", val((50, "MAD")),
    ref=[ans(op="balance", kind="person", name="Driss Lahlou")]))

S("T19-070-P", "add_to photo named undo link para",
  T("family album gets lina's cake last year", diff(link("a_family", "cake_2025")),
    ref=[act("add_to", rows="$cake_2025", args=lines(to="$a_family"))]),
  T("it's fine where it was, undo", diff(unlink("a_family", "cake_2025")),
    ref=[act("undo")]))

S("T19-075-P", "single decline out_of_scope dosage para",
  T("top metformin dosage at 70 years old?", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T19-080-P", "delete note named trashed notes restore restore window ask para",
  T("i never open books to read, get rid of it", diff(trash("books")),
    ref=[act("delete", kind="note", name="Books to read")]),
  T("deleted notes?", rows("books", "old_garde", "ramadan_menu", "old_rota"),
    ref=[ans(kind="note", trashed=True)]),
  T("kenza wants the 2025 rota, restore old night duty schedule", diff(restore("old_garde")),
    ref=[act("restore", rows="$old_garde")]),
  T("ramadan menu one too", ask(),
    ref=[find(kind="note", name="Ramadan menu", trashed=True),
         bad(act("restore", rows="$ramadan_menu")),
         askc("the ramadan menu has been in the bin since february, past 30 days, so it can't come back. write a new one?")]))

S("T19-086-P", "locker create login note reveal new para",
  T("locker: new login Lina's school portal, username lina.elamrani",
    diff(new("locker item", name="Lina's school portal", username="lina.elamrani")),
    ref=[act("create", args=lines(kind="locker item", name="Lina's school portal", type="login",
                                  username="lina.elamrani"))]),
  T("plus a locker note named Nursery gate code: 2580", diff(new("locker item", name="Nursery gate code")),
    ref=[act("create", args=lines(kind="locker item", name="Nursery gate code", type="note", notes="2580"))]),
  T("that gate code, what is it", diff(reveal=[("+2", "2580")]),
    ref=[act("reveal", rows="$c2", kind="locker item", args=lines(field="notes"))]))

S("T19-092-P", "five turns compute sum debts max settle named sum para",
  T("open debts only: what i owe against what i'm owed", vgroups({"i_owe": (1800, "MAD"), "owes_me": (3150, "MAD")}),
    ref=[comp(op="sum", field="amount", group="direction", kind="debt", where='status = "open"'), ans(value="@prev")]),
  T("largest debt of mine", val((1000, "MAD")),
    ref=[ans(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("i paid youssef back for the cash for the pharmacy till, mark it settled", diff(upd("d_youssef", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Cash for the pharmacy till")]),
  T("what's my debt total after that", val((800, "MAD")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("owed to whom", rows("d_nadia", "d_samira", "d_aicha", "d_khalid"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T19-097-P", "single ambiguous delete event ask para",
  T("nurse visit for baba, get rid of it", ask("nurse_1", "nurse_2"),
    ref=[act("delete", kind="event", name="Nurse visit for Baba"),
         find(kind="event", name="Nurse visit for Baba"),
         askc("the one on the 20th or the 27th?", options="$nurse_1, $nurse_2")]))

S("T19-A004-P", "ask-options document delete never_mind c3a para",
  T("get rid of the scan", ask("scan_41", "scan_42"),
    ref=[act("delete", kind="document", name="scan"),
         askc("Scan 0041 or Scan 0042?", options="$scan_41, $scan_42")]),
  T("wait, no idea what they are, so leave them alone", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T19-A009-P", "follow-up c3a para",
  T("who am i in debt to", rows("d_youssef", "d_khalid", "d_aicha", "d_nadia", "d_samira"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("over 150 among them", rows("d_youssef", "d_khalid", "d_samira"),
    ref=[ans(within="@prev", where="amount > 150 MAD")]),
  T("what about the others", rows("d_aicha", "d_nadia"),
    ref=[ans(within="@1", exclude="@2")]))

S("T19-B006-P", "c4b state-change settle_debt log nickname para",
  T("phone credit, rachid's paid it back", diff(upd("d_rachid", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Phone credit")]),
  T("visited baba", diff(upd("baba", date=ANY)),
    ref=[search("baba", kind="person"), act("log", rows="$baba", args=lines(kind="visit"))]))

S("T19-C004-P", "c3c compound three writes create event create task star para",
  T("sunday at 1, lunch with zineb, plus a task to bring her dessert, and she gets a star",
    diff(new("event", name=has("zineb"), date="2026-04-19T13:00"), new("task", name=has("dessert")), upd("zineb", starred=True)),
    ref=[act("create", args=lines(kind="event", name="Lunch with Zineb", date=U("week", 0, weekday=7, time="13:00")), more=True),
         act("create", args=lines(kind="task", name="Bring Zineb dessert"), more=True),
         act("star", rows="$zineb")]))

S("T19-102-P", "ask document star invoice para",
  T("invoice gets a star", ask("invoice_apr", "fees_invoice"),
    ref=[act("star", kind="document", name="invoice"),
         askc("the wholesaler invoice april or the school fees invoice term 3?", options="$invoice_apr, $fees_invoice")]),
  T("school fees", diff(upd("fees_invoice", starred=True)),
    ref=[act("star", rows="$fees_invoice")]),
  T("landlord keeps asking for the pharmacy lease, so give it a star", diff(upd("lease", starred=True)),
    ref=[act("star", kind="document", name="Pharmacy lease")]),
  T("parent-teacher meeting, friday at 5 instead", diff(upd("ptm", date="2026-04-17T17:00")),
    ref=[act("reschedule", kind="event", name="Parent-teacher meeting", args=lines(to=U("week", 0, weekday=5, time="17:00")))]))

S("T19-112-P", "ask event dentist cancel never_mind log para",
  T("dentist is off, cancel it", ask("dentist_adam", "dentist_me"),
    ref=[act("cancel", kind="event", name="Dentist"),
         askc("adam's on the 24th or yours on 7 may?", options="$dentist_adam, $dentist_me")]),
  T("forget it, dates need checking first", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("i called the paediatrician about adam's check-up, log it", diff(upd("dr_kettani", date=ANY)),
    ref=[act("log", kind="person", where='role contains "paediatrician"', args=lines(kind="call"))]),
  T("lina's vaccine at 5 instead", diff(upd("lina_vacc", date="2026-04-15T17:00")),
    ref=[act("reschedule", kind="event", name="Lina's vaccine", args=lines(to=U("day", 0, anchor="row", time="17:00")))]))

S("T19-123-P", "wifi read reveal read star para",
  T("home wifi pw, where do i keep it", rows("wifi_home"),
    ref=[ans(kind="locker item", name="Home wifi")]),
  T("cousin's here, give me the home wifi password", diff(reveal=[("wifi_home", "lina-adam-2019")]),
    ref=[act("reveal", rows="$wifi_home", args=lines(field="password"))]),
  T("pharmacy wifi code, where is it saved", rows("wifi_pharm"),
    ref=[ans(kind="locker item", name="Pharmacy wifi")]),
  T("give it a star", diff(upd("wifi_pharm", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T19-128-P", "group members balance me delete refused rename para",
  T("baba's care members?", rows("omar", "salma", "me"),
    ref=[ans(kind="person", linked_to="$baba_care")]),
  T("my standing in that group", val((90, "MAD")),
    ref=[comp(op="balance", kind="group", name="Baba's care", linked_to="$me"), ans(value="@prev")]),
  T("trip's planned differently now, so the ifrane weekend group can go, delete it", ask(),
    ref=[bad(act("delete", kind="group", name="Ifrane weekend")),
         askc("ifrane weekend still has a chalet deposit on it so it can't be deleted. keep it?")]),
  T("keep it, just call it Ifrane May", diff(upd("ifrane", name="Ifrane May")),
    ref=[act("edit", kind="group", name="Ifrane weekend", args=lines(name="Ifrane May"))]))

S("T19-133-P", "min owed typo then max then ask fuel settle never mind para",
  T("lowest amount anyone owes me, collecting the little ones befroe the weekend", val((200, "MAD")),
    ref=[ans(op="min", field="amount", kind="debt", where=OWED)]),
  T("largest, i'd say omar's glucometer one that's still unpaid",
    val((1200, "MAD")),
    ref=[ans(op="max", field="amount", kind="debt", where=OWED)]),
  T("fuel one, mark it settled", ask("d_samira", "d_driss"),
    ref=[act("settle_debt", kind="debt", name="Fuel for the school run"),
         find(kind="debt", name="Fuel for the school run"),
         askc("the 200 you owe samira or the 200 driss owes you?", options="$d_samira, $d_driss")]),
  T("leave it for now, i must check with samira and driss which of the two fuel payments really came through, asking them on firday",
    decline("never_mind"),
    ref=[dec("never_mind")]))

S("T19-140-P", "latest documents then unbounded typo then ask staff meeting never mind then sum tasks para",
  T("two newest documents", rows("scan_41", "fees_invoice", order=True),
    ref=[ans(kind="document", order="date desc", limit=2)]),
  T("erase the wohle vault", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("staff meeting at 2 instead", ask("staff_03", "staff_04", "staff_05"),
    ref=[act("reschedule", kind="event", name="Pharmacy staff meeting",
             args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         find(kind="event", name="Pharmacy staff meeting"),
         askc("march's, april's or may's?", options="$staff_03, $staff_04, $staff_05")]),
  T("stop, none of them get moved, the whole team agreed on those times already",
    decline("never_mind"),
    ref=[dec("never_mind")]),
  T("total minutes of tasks due on the twentieth, wich list doesnt matter", val(45),
    ref=[ans(op="sum", field="effort", kind="task", when=W(D("2026-04-20")), where='status = "open"')]))
