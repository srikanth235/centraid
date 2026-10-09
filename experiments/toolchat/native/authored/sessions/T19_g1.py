from gold import *
import json

world("T19", "2026-04-14T20:40", "Fatima Al-Sayed", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))

S("T19-101", "ask locker unstar card",
  T("unstar the card", ask("visa", "ordre_card"),
    ref=[act("unstar", kind="locker item", name="card"),
         askc("the visa debit card or the pharmacists' order card?", options="$visa, $ordre_card")]),
  T("the visa", diff(upd("visa", starred=False)),
    ref=[act("unstar", rows="$visa")]),
  T("and unstar the pharmacists' order card too", diff(upd("ordre_card", starred=False)),
    ref=[act("unstar", kind="locker item", name="Pharmacists' order card")]),
  T("unstar cnss online and star the wholesaler portal, that's the one i use daily now",
    diff(upd("cnss_online", starred=False), upd("portal", starred=True)),
    ref=[act("unstar", kind="locker item", name="CNSS online", more=True),
         act("star", kind="locker item", name="Wholesaler portal")]))

S("T19-102", "ask document star invoice",
  T("star the invoice", ask("invoice_apr", "fees_invoice"),
    ref=[act("star", kind="document", name="invoice"),
         askc("the wholesaler invoice april or the school fees invoice term 3?", options="$invoice_apr, $fees_invoice")]),
  T("the school fees one", diff(upd("fees_invoice", starred=True)),
    ref=[act("star", rows="$fees_invoice")]),
  T("and star the pharmacy lease, the landlord keeps asking for it", diff(upd("lease", starred=True)),
    ref=[act("star", kind="document", name="Pharmacy lease")]),
  T("move the parent-teacher meeting to friday at 5", diff(upd("ptm", date="2026-04-17T17:00")),
    ref=[act("reschedule", kind="event", name="Parent-teacher meeting", args=lines(to=U("week", 0, weekday=5, time="17:00")))]))

S("T19-103", "ask document star cnss statement",
  T("star the cnss statement", ask("cnss_mar", "cnss_feb"),
    ref=[act("star", kind="document", name="CNSS statement"),
         askc("the march statement or the february one?", options="$cnss_mar, $cnss_feb")]),
  T("march", diff(upd("cnss_mar", starred=True)),
    ref=[act("star", rows="$cnss_mar")]),
  T("and february's too", diff(upd("cnss_feb", starred=True)),
    ref=[act("star", kind="document", name="CNSS statement February")]),
  T("bring the school fees payment forward to thursday", diff(upd("fees", date="2026-04-16")),
    ref=[act("reschedule", kind="task", name="Pay school fees for term 3", args=lines(to=U("week", 0, weekday=4)))]))

S("T19-104", "ask document scan never_mind already-so star",
  T("star the scan", ask("scan_41", "scan_42"),
    ref=[act("star", kind="document", name="Scan"),
         askc("scan 0041 from today or scan 0042 from the 11th?", options="$scan_41, $scan_42")]),
  T("scratch that, i'll rename them first", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("star the pharmacy licence", diff(already=["licence_doc"]),
    ref=[act("star", kind="document", name="Pharmacy licence"), ans(rows="$licence_doc")]),
  T("delete the yoga class, i'm not going back", diff(trash("yoga")),
    ref=[act("delete", kind="event", name="Yoga class")]))

S("T19-105", "ask people star samira",
  T("star samira", ask("samira_b", "samira_a"),
    ref=[act("star", kind="person", name="Samira"),
         askc("samira bennani, rayan's mum, or samira alaoui, ines's mum?", options="$samira_b, $samira_a")]),
  T("ines's mum", diff(upd("samira_a", starred=True)),
    ref=[act("star", rows="$samira_a")]),
  T("and bennani too, and log a message with her about the monday run rota",
    diff(upd("samira_b", starred=True, date=ANY)),
    ref=[act("star", kind="person", name="Samira Bennani", more=True),
         act("log", kind="person", name="Samira Bennani", args=lines(kind="message"))]),
  T("move adam's swimming lesson tomorrow to 5", diff(upd("swim_0415", date="2026-04-15T17:00")),
    ref=[act("reschedule", kind="event", name="Adam's swimming lesson", when=W(U("day", 1)),
             args=lines(to=U("day", 0, anchor="row", time="17:00")))]))

S("T19-106", "ask event nurse visit reschedule at-N",
  T("move the nurse visit to 7", ask("nurse_1", "nurse_2"),
    ref=[act("reschedule", kind="event", name="Nurse visit for Baba", when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 0, anchor="row", time="19:00"))),
         find(kind="event", name="Nurse visit for Baba", when=W({"from": U("day", 0)})),
         askc("the one on monday the 20th or monday the 27th?", options="$nurse_1, $nurse_2")]),
  T("the 27th", diff(upd("nurse_2", date="2026-04-27T19:00")),
    ref=[act("reschedule", rows="$nurse_2", args=lines(to=U("day", 0, anchor="row", time="19:00")))]),
  T("and baba's podiatrist to 6, it's right after my shift and the traffic is bad", diff(upd("podiatrist", date="2026-04-17T18:00")),
    ref=[act("reschedule", kind="event", name="Podiatrist for Baba", args=lines(to=U("day", 0, anchor="row", time="18:00")))]))

S("T19-107", "event next nurse reschedule undo never_mind balance find",
  T("when's baba's next nurse visit", rows("nurse_1"),
    ref=[ans(kind="event", name="Nurse visit for Baba", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("push it to 7", diff(upd("nurse_1", date="2026-04-20T19:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("day", 0, anchor="row", time="19:00")))]),
  T("never mind, keep it at 6", diff(upd("nurse_1", date="2026-04-20T18:00")),
    ref=[act("undo")]),
  T("what do i owe the plumber, i never paid him properly for the sink", val((-350, "MAD")),
    ref=[find(kind="person", where='role contains "plumber"'), ans(op="balance", rows="@prev")]))

S("T19-108", "ask task insurance renewal reschedule",
  T("push the insurance renewal to next friday", ask("insurance_ph", "car_ins"),
    ref=[search("insurance", kind="task"),
         askc("the pharmacy insurance or the car insurance renewal?", options="$insurance_ph, $car_ins")]),
  T("the car one", diff(upd("car_ins", date="2026-04-24")),
    ref=[act("reschedule", rows="$car_ins", args=lines(to=U("week", 1, weekday=5)))]),
  T("and the pharmacy one to the 28th", diff(upd("insurance_ph", date="2026-04-28")),
    ref=[act("reschedule", kind="task", name="Renew pharmacy insurance", args=lines(to=D("2026-04-28")))]),
  T("how many open tasks are on the pharmacy list", val(9),
    ref=[ans(op="count", kind="task", linked_to="$pharm_l", where='status = "open"')]))

S("T19-109", "ask task cnss complete",
  T("mark the cnss one done", ask("cnss_claims", "reimburse"),
    ref=[act("complete", kind="task", name="CNSS"),
         askc("sending the claims batch or filing baba's reimbursement?", options="$cnss_claims, $reimburse")]),
  T("the batch, sent it after lunch", diff(upd("cnss_claims", status="completed", completed=ANY)),
    ref=[act("complete", rows="$cnss_claims")]),
  T("and the reimbursement filing too", diff(upd("reimburse", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="File Baba's CNSS reimbursement")]),
  T("reopen the claims batch, the portal bounced it", diff(upd("cnss_claims", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Send CNSS claims batch")]))

S("T19-110", "ask task rota reschedule weekday",
  T("push the rota to friday", ask("rota", "rota_mail"),
    ref=[act("reschedule", kind="task", name="rota", args=lines(to=U("week", 0, weekday=5))),
         askc("the may staff rota or sending the school run rota?", options="$rota, $rota_mail")]),
  T("the school run one, the parents need it earlier", diff(upd("rota_mail", date="2026-04-17")),
    ref=[act("reschedule", rows="$rota_mail", args=lines(to=U("week", 0, weekday=5)))]),
  T("and the staff one to next monday at 9", diff(upd("rota", date="2026-04-20T09:00")),
    ref=[act("reschedule", kind="task", name="Make the May staff rota",
             args=lines(to=U("week", 1, weekday=1, time="09:00")))]),
  T("call the plumber about the kitchen sink is done", diff(upd("sink", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Call the plumber about the kitchen sink")]))

S("T19-111", "ask locker reveal login",
  T("show me the login password, the one i need for the portals on my phone", ask("gmail", "portal", "cnss_online"),
    ref=[act("reveal", kind="locker item", where='type = "login"', args=lines(field="password")),
         askc("gmail, the wholesaler portal or cnss online?", options="$gmail, $portal, $cnss_online")]),
  T("cnss", diff(reveal=[("cnss_online", "Baba-Care-850")]),
    ref=[act("reveal", rows="$cnss_online", args=lines(field="password"))]),
  T("and the wholesaler portal one", diff(reveal=[("portal", "Strips-165-box")]),
    ref=[act("reveal", kind="locker item", name="Wholesaler portal", args=lines(field="password"))]),
  T("star the wholesaler portal", diff(upd("portal", starred=True)),
    ref=[act("star", kind="locker item", name="Wholesaler portal")]))

S("T19-112", "ask event dentist cancel never_mind log",
  T("cancel the dentist", ask("dentist_adam", "dentist_me"),
    ref=[act("cancel", kind="event", name="Dentist"),
         askc("adam's on the 24th or yours on 7 may?", options="$dentist_adam, $dentist_me")]),
  T("never mind, i'll check the dates first", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("log a call with the paediatrician, asked about adam's check-up", diff(upd("dr_kettani", date=ANY)),
    ref=[act("log", kind="person", where='role contains "paediatrician"', args=lines(kind="call"))]),
  T("and move lina's vaccine to 5", diff(upd("lina_vacc", date="2026-04-15T17:00")),
    ref=[act("reschedule", kind="event", name="Lina's vaccine", args=lines(to=U("day", 0, anchor="row", time="17:00")))]))

S("T19-113", "ask people log youssef",
  T("log a call with youssef", ask("youssef_a", "youssef_b"),
    ref=[act("log", kind="person", name="Youssef", args=lines(kind="call")),
         askc("youssef el amrani or youssef berrada from the wholesaler?", options="$youssef_a, $youssef_b")]),
  T("the wholesaler rep", diff(upd("youssef_b", date=ANY)),
    ref=[act("log", rows="$youssef_b", args=lines(kind="call"))]),
  T("and one with youssef el amrani, he rang about dinner", diff(upd("youssef_a", date=ANY)),
    ref=[act("log", kind="person", name="Youssef El Amrani", args=lines(kind="call"))]),
  T("unstar youssef el amrani, the starred list is crowded", diff(upd("youssef_a", starred=False)),
    ref=[act("unstar", kind="person", name="Youssef El Amrani")]))

S("T19-114", "ask cross-kind cnss star locker document",
  T("star baba's cnss", ask("cnss_card", "baba_cnss_l"),
    ref=[search("baba cnss"),
         askc("baba's cnss card in documents or baba's cnss number in the locker?", options="$cnss_card, $baba_cnss_l")]),
  T("the number", diff(upd("baba_cnss_l", starred=True)),
    ref=[act("star", rows="$baba_cnss_l")]),
  T("the card too", diff(upd("cnss_card", starred=True)),
    ref=[act("star", kind="document", name="Baba's CNSS card")]))

S("T19-115", "ask event meeting cancel weekend read write",
  T("cancel the meeting, i can't make it", ask("ptm", "berrada_meet", "council", "staff_05"),
    ref=[act("cancel", kind="event", name="meeting", when=W({"from": U("day", 0)})),
         askc("the parent-teacher meeting, youssef berrada, the pharmacists' council or the staff meeting in may?",
              options="$ptm, $berrada_meet, $council, $staff_05")]),
  T("the wholesaler one", diff(upd("berrada_meet", status="cancelled")),
    ref=[act("cancel", rows="$berrada_meet")]),
  T("what's on this weekend", rows("stock_count", "garde_0418"),
    ref=[ans(kind="event", when=W(WEEKEND))]),
  T("cancel the night duty this weekend, kenza's swapping with me", diff(upd("garde_0418", status="cancelled")),
    ref=[act("cancel", kind="event", name="Night duty at the pharmacy", when=W(WEEKEND))]))
