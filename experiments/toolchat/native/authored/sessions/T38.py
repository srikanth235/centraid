from gold import *
import json

world("T38", "2027-05-12T20:15", "Nour Al-Sayed", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T38-001", "friday-lunch cancelled year follow-up cancel count",
  T("which friday lunches got cancelled this year", rows("fl_270212", "fl_270507"),
    ref=[ans(kind="event", name="Friday lunch", where="status = cancelled", when=J(U("year", 0)))]),
  T("and last year", rows("fl_260522", "fl_260612", "fl_260703", "fl_261218"),
    ref=[ans(kind="event", name="Friday lunch", where="status = cancelled", when=J(U("year", -1)))]),
  T("cancel next friday's, the kids have exams", diff(upd("fl_270521", status="cancelled")),
    ref=[act("cancel", kind="event", name="Friday lunch", where="status != cancelled",
             when=J(U("week", 1, weekday=5)))]),
  T("so how many friday lunches have we dropped this year", val(3),
    ref=[ans(op="count", kind="event", name="Friday lunch", where="status = cancelled", when=J(U("year", 0)))]))

S("T38-002", "friday-lunch mansaf description month attendees add-person decline",
  T("which friday lunch in june has the mansaf note", rows("fl_270618"),
    ref=[ans(kind="event", name="Friday lunch", where='description contains "mansaf"', when=J(U("month", 0, name=6)))]),
  T("who's coming to it", rows("baba", "mama", "yazan", "dana"),
    ref=[ans(kind="person", linked_to="@prev")]),
  T("put me down for it too", decline("out_of_scope"),
    ref=[act("add_to", kind="person", name="Nour Al-Sayed", args="to: $fl_270618")]))

S("T38-003", "clinic-list open before-event effort within complete reschedule two-dates",
  T("open tasks on the clinic list due before the anniversary party",
    rows("sup_240805", "sup_250310", "bak_270512", "sup_270517", "licence27_3", "t_048", "licence27_4"),
    ref=[ans(kind="task", linked_to="$clinic_l", where="status = open", when=J({"to": D("2027-06-03")}))]),
  T("which of those take under half an hour", rows("sup_240805", "sup_250310", "bak_270512", "sup_270517"),
    ref=[ans(within="@prev", where="effort < 30")]),
  T("tick off the backup one", diff(upd("bak_270512", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Back up patient records", linked_to="$clinic_l")]),
  T("move the supplies order from monday to tuesday and show me what the clinic has that day",
    rows("sup_270517", "licence27_3", also=diff(upd("sup_270517", date="2027-05-18T09:00"))),
    ref=[act("reschedule", kind="task", name="Order clinic supplies", when=J(U("week", 1, weekday=1)),
             args=lines(to=U("week", 1, weekday=2)), more=True),
         ans(kind="task", linked_to="$clinic_l", when=J(U("week", 1, weekday=2)))]))

S("T38-004", "building-fund committee role balance group-narrowed",
  T("which of the building fund lot are on the committee", rows("shireen_barghouti", "tamara_nimri"),
    ref=[find(kind="person", linked_to="$building", where='role contains "committee"'), ans(rows="@prev")]),
  T("where am i with shireen", val((136, "JOD")),
    ref=[ans(op="balance", kind="person", rows="$shireen_barghouti")]),
  T("just the building fund one", val((-65, "JOD")),
    ref=[ans(op="balance", kind="group", name="Abdoun Building Fund", linked_to="$shireen_barghouti")]))

S("T38-005", "layla decoys ask role log pharma-rep group",
  T("log a call with layla", ask("layla_h", "layla_n", "layla_q"),
    ref=[act("log", kind="person", name="Layla", args="kind: call")]),
  T("the cousin", diff(upd("layla_h", date=ANY)),
    ref=[act("log", kind="person", name="Layla", where='role = "cousin"', args="kind: call")]),
  T("when did i last speak to the pharma rep layla", rows("layla_q"),
    ref=[ans(kind="person", name="Layla", where='role = "pharma rep"')]),
  T("which group is she in", rows("dubai"),
    ref=[ans(kind="group", linked_to="$layla_q")]))

S("T38-006", "notes notebook body-contains year pin pinned",
  T("notes in clinic admin from 2025 on that mention rasha",
    rows("cl_4", "cl_5", "cl_6", "cl_7", "cl_8", "cl_9", "cl_10"),
    ref=[ans(kind="note", linked_to="$clinic_nb", where='body contains "Rasha"', when=J({"from": D("2025-01-01")}))]),
  T("just last year's", rows("cl_7", "cl_8", "cl_9", "cl_10"),
    ref=[ans(within="@prev", when=J(U("year", -1)))]),
  T("pin the latest one", diff(upd("cl_10", pinned=True)),
    ref=[act("edit", rows="$cl_10", args="pinned: yes")]),
  T("what's pinned in that notebook now", rows("cl_1", "cl_10"),
    ref=[ans(kind="note", linked_to="$clinic_nb", where="pinned = yes")]))

S("T38-007", "photos person album when starred",
  T("photos of yazan in the aqaba album", rows("ph_aqaba_a_01", "ph_aqaba_a_02", "ph_aqaba_a_06", "ph_aqaba_a_08",
                                              "ph_aqaba_a_09"),
    ref=[search("Yazan", kind="person"), ans(kind="photo", linked_to="$yazan, $aqaba_a")]),
  T("just the ones from the first day", rows("ph_aqaba_a_01", "ph_aqaba_a_02", "ph_aqaba_a_06"),
    ref=[ans(within="@prev", when=J(D("2026-05-08")))]))

S("T38-008", "documents same-name folder year star",
  T("staff payroll summary 2024 in tax", rows("doc_008"),
    ref=[ans(kind="document", name="Staff payroll summary 2024", linked_to="$taxf")]),
  T("star it", diff(upd("doc_008", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("and the other one with that name", rows("doc_004"),
    ref=[ans(kind="document", name="Staff payroll summary 2024", exclude="@prev")]))

S("T38-009", "call-teta cancelled year empty-substitution reschedule",
  T("which of the thursday calls to teta got cancelled this year", rows("ct_270422"),
    ref=[ans(kind="event", name="Call Teta", where="status = cancelled", when=J(U("year", 0)))]),
  T("and the 27th", rows(),
    ref=[ans(kind="event", name="Call Teta", where="status = cancelled", when=J(D("2027-05-27")))]),
  T("so push the 27th one to 8pm, she's at the clinic till late", diff(upd("ct_270527", date="2027-05-27T20:00")),
    ref=[act("reschedule", kind="event", name="Call Teta", when=J(D("2027-05-27")),
             args=lines(to=D("2027-05-27", "20:00")))]))

S("T38-010", "swim-class count cancelled next order-limit reschedule anchor",
  T("how many of dana's swim classes got cancelled back in 2025", val(2),
    ref=[ans(op="count", kind="event", name="Dana's swim class", where="status = cancelled", when=J(U("year", -2)))]),
  T("when's the next one that's still on", rows("dsw_270518"),
    ref=[ans(kind="event", name="Dana's swim class", where="status != cancelled", when=J({"from": U("day", 0)}),
             order="date asc", limit=1)]),
  T("push it an hour later and tell me what's on that day",
    rows("dsw_270518", also=diff(upd("dsw_270518", date="2027-05-18T17:30"))),
    ref=[act("reschedule", kind="event", name="Dana's swim class", when=J(U("week", 1, weekday=2)),
             args=lines(to=U("hour", 1, anchor="row")), more=True),
         ans(kind="event", when=J(U("week", 1, weekday=2)))]))

S("T38-011", "weekend eid attendees last-year both relation chain",
  T("what's on this weekend that baba is part of",
    rows("csm_270516", "eid_a27"),
    ref=[bad(ans(kind="event", linked_to="$baba", when=J({"from": {"weekday": 6}, "to": {"weekday": 7}}))),
         ans(kind="event", linked_to="$baba", when=J(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]),
  T("who's going to the eid lunch besides baba", rows("teta", "ammo_fadi"),
    ref=[ans(kind="person", linked_to="$eid_a27", exclude="$baba")]),
  T("and who went to last year's one", rows("teta", "ammo_fadi"),
    ref=[find(kind="event", name="Eid al-Adha lunch at Teta's", when=J(U("year", -1))),
         ans(kind="person", linked_to="@prev")]),
  T("who was at both", rows("teta", "ammo_fadi"),
    ref=[ans(kind="person", linked_to="$eid_a27, $eid_a26")]))

S("T38-012", "anniversary group event starred exclude reschedule decline-text",
  T("which starred people from the staff lunch group are coming to the anniversary party", rows("rasha"),
    ref=[ans(kind="person", linked_to="$clinic_lunch, $clinic_anniv", where="starred = yes")]),
  T("and everyone else in that group besides her", rows("ahmad", "mahmoud", "um_ali", "dr_sami", "me"),
    ref=[ans(kind="person", linked_to="$clinic_lunch", exclude="$rasha")]),
  T("move the party to 7pm and tell me who's coming",
    rows("baba", "rasha", "ahmad", "mahmoud", "dr_sami", also=diff(upd("clinic_anniv", date="2027-06-03T19:00"))),
    ref=[act("reschedule", rows="$clinic_anniv", args=lines(to=D("2027-06-03", "19:00")), more=True),
         ans(kind="person", linked_to="$clinic_anniv")]),
  T("text them all the new time", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T38-013", "wifi read reveal egress trashed restore",
  T("what's the wifi password", rows("home_wifi", "clinic_wifi", "teta_wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("show me the clinic one", diff(reveal=[("clinic_wifi", "SweifiehClinic#9")]),
    ref=[act("reveal", rows="$clinic_wifi", args="field: password")]),
  T("whatsapp it to rasha", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("what was the old clinic wifi i deleted", rows("old_wifi"),
    ref=[ans(kind="locker item", name="wifi", trashed=True)]),
  T("bring it back", diff(restore("old_wifi")),
    ref=[act("restore", rows="$old_wifi")]))

S("T38-014", "locker reveal note-secret card starred type-in",
  T("what's the clinic alarm code", diff(reveal=[("alarm", "7410")]),
    ref=[act("reveal", rows="$alarm", args="field: content")]),
  T("and the number on the clinic card", diff(reveal=[("clinic_card", "5412750098761234")]),
    ref=[act("reveal", rows="$clinic_card", args="field: card_number")]),
  T("which starred locker items are logins or bank accounts", rows("arab_bank", "joint_acct"),
    ref=[ans(kind="locker item", where='starred = yes and type in ("login", "bank_account")')]))

S("T38-015", "locker trashed restore window find",
  T("what did i delete from the locker", rows("old_wifi", "old_login"),
    ref=[ans(kind="locker item", trashed=True)]),
  T("bring back the old wifi", diff(restore("old_wifi")),
    ref=[act("restore", rows="$old_wifi")]),
  T("and the old zain login", decline("not_found"),
    ref=[find(kind="locker item", name="Old Zain login", trashed=True), act("restore", rows="$old_login")]))

S("T38-016", "repair person create-met star cadence",
  T("add a new contact, salma kayed, a physio i met at the clinic",
    diff(new("person", name="Salma Kayed", role="physio", met="clinic")),
    ref=[bad(act("create", args=lines(kind="person", name="Salma Kayed", role="physio", met="clinic"))),
         act("create", args=lines(kind="person", name="Salma Kayed", role="physio"), more=True),
         act("edit", rows="$new", args="met: clinic")]),
  T("star her", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$new")]),
  T("keep in touch with her about once a fortnight", diff(upd("+1", cadence=14)),
    ref=[act("edit", rows="$c1", args="cadence: 14")]))

S("T38-017", "group refusal ask balance narrowed settle_up",
  T("take rula out of saturday football", ask("rula_halaby", "football"),
    ref=[act("remove_from", kind="person", name="Rula Halaby", args="from: $football")]),
  T("what's my balance with her", val((-22.5, "JOD")),
    ref=[ans(op="balance", kind="person", rows="$rula_halaby")]),
  T("just the football one", val((67.5, "JOD")),
    ref=[ans(op="balance", kind="group", name="Saturday Football", linked_to="$rula_halaby")]),
  T("settle up with her in football", diff(settle=[("Rula Halaby", "22.500")]),
    ref=[act("settle_up", rows="$rula_halaby", args="group: $football")]))

S("T38-018", "group delete refused ask rename delete-empty unlink",
  T("delete the dubai expo group", ask(),
    ref=[act("delete", kind="group", name="Dubai Medical Expo 2026")]),
  T("ok just rename it to dubai expo", diff(upd("dubai", name="Dubai Expo")),
    ref=[act("edit", rows="$dubai", args="name: Dubai Expo")]),
  T("and the umrah one can go, nothing in it",
    diff(gone("umrah"), unlink("umrah", "baba"), unlink("umrah", "mama"), unlink("umrah", "teta"),
         unlink("umrah", "me")),
    ref=[act("delete", kind="group", name="Umrah Fund 2028")]))

S("T38-019", "near-names hussam husam role star unstar name-where",
  T("star hussam, the neighbour", diff(upd("hussam", starred=True)),
    ref=[act("star", kind="person", name="Hussam", where='role = "neighbour"')]),
  T("and husam, the uni friend", diff(upd("husam", starred=True)),
    ref=[act("star", kind="person", name="Husam", where='role = "friend"')]),
  T("which khourys are starred", rows("hussam", "husam", "salem_khoury"),
    ref=[ans(kind="person", name="Khoury", where="starred = yes")]),
  T("unstar salem", diff(upd("salem_khoury", starred=False)),
    ref=[act("unstar", kind="person", name="Salem", where="starred = yes")]))

S("T38-020", "debts person year within status direction settle_debt",
  T("my cousin omar's debts from 2024", rows("debt_01", "debt_05", "debt_06"),
    ref=[ans(kind="debt", linked_to="$omar_k", when=J(U("year", -3)))]),
  T("which are still open", rows("debt_06"),
    ref=[ans(within="@prev", where="status = open")]),
  T("and is there anything open going the other way", rows("debt_32"),
    ref=[ans(kind="debt", linked_to="$omar_k", where="direction = i_owe and status = open")]),
  T("settle the pharmacy one with him", diff(upd("debt_32", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$omar_k", where="direction = i_owe and status = open")]))

S("T38-021", "debts superlatives biggest smallest sum order-limit",
  T("which debt of mine is the largest one still open", rows("debt_26"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount desc", limit=1)]),
  T("and the smallest", rows("debt_32"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount asc", limit=1)]),
  T("and how much of what i owe is from last year", val((334.5, "JOD")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open", when=J(U("year", -1)))]))

S("T38-022", "event create clash ask create reschedule",
  T("put a dentist for dana on thursday at 7pm", ask("ct_270513"),
    ref=[act("create", args=lines(kind="event", name="Dentist - Dana", date=D("2027-05-13", "19:00")))]),
  T("make it 8 then", diff(new("event", name="Dentist - Dana", date="2027-05-13T20:00")),
    ref=[act("create", args=lines(kind="event", name="Dentist - Dana", date=D("2027-05-13", "20:00")))]),
  T("actually move it to friday morning at 9", diff(upd("+1", date="2027-05-14T09:00")),
    ref=[act("reschedule", rows="$new", args=lines(to=U("week", 0, weekday=5, time="09:00")))]))

S("T38-023", "event edit duration week-weekday morning span",
  T("make this sunday's staff meeting an hour long", diff(upd("csm_270516", duration=60)),
    ref=[bad(act("edit", kind="event", name="Clinic staff meeting", when=J(U("week", 0, weekday=7)), args="duration: 1 hour")),
         act("edit", kind="event", name="Clinic staff meeting", when=J(U("week", 0, weekday=7)), args="duration: 60")]),
  T("what else is on sunday morning", rows(),
    ref=[ans(kind="event", when=J(span(U("week", 0, weekday=7, time="06:00"), U("week", 0, weekday=7, time="11:59"))),
             exclude="$csm_270516")]))

S("T38-024", "tasks trashed restore find still-in-trash",
  T("bring back the heater at teta's task i deleted", diff(restore("t_009")),
    ref=[find(kind="task", name="Fix the heater at Teta's", trashed=True), act("restore", rows="$t_009")]),
  T("and the eid sweets one", diff(restore("t_003")),
    ref=[find(kind="task", name="Buy Eid sweets for the family", trashed=True), act("restore", rows="$t_003")]),
  T("what tasks are still sitting in the bin", rows("t_058", "t_046", "t_014", "t_022", "t_033", "t_071"),
    ref=[ans(kind="task", trashed=True)]))
