from gold import *
def J(d):
    return json.dumps(d, separators=(",", ":"))
import json
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T26-016-P", "delete task where cancelled undo delete para",
  T("house build list, get rid of the cancelled one", diff(trash("bq")),
    ref=[act("delete", kind="task", linked_to="$house_l", where='status = "cancelled"')]),
  T("i might build the bq after all, undo that", diff(restore("bq")),
    ref=[act("undo")]))

S("T26-023-P", "find trashed note restore prev notebook para",
  T("old house budget note, did it end up in the trash", rows("old_budget"),
    ref=[find(kind="note", name="Old house budget", trashed=True), ans(rows="@prev")]),
  T("restore it and file it into house build", diff(restore("old_budget"), link("house_nb", "old_budget")),
    ref=[act("restore", rows="@prev", more=True),
         act("add_to", rows="$old_budget", args=lines(to="$house_nb"))]))

S("T26-028-P", "photo span weekday to datetime delete multi undo photo para",
  T("pictures i shot between last saturday and 6pm on sunday",
    rows("p_lintel", "p_windows", "p_goal", "p_team", "p_haircut", "p_sunday"),
    ref=[ans(kind="photo", when=span(U("week", -1, weekday=6), U("week", -1, weekday=7, time="18:00")))]),
  T("the sunday rice one and the barber one, get rid of both",
    diff(trash("p_sunday"), trash("p_haircut"), unlink("kids_al", "p_haircut")),
    ref=[act("delete", rows="$p_sunday, $p_haircut")]),
  T("ngozi wants them back, undo", diff(restore("p_sunday"), restore("p_haircut"), link("kids_al", "p_haircut")),
    ref=[act("undo")]))

S("T26-033-P", "album photo count delete album where para",
  T("which albums contain under four photos", rows("kemi13_al", "family_al", "football_al", "dubai_al"),
    ref=[ans(kind="album", where="photo count < 4")]),
  T("get rid of the empty one", diff(gone("dubai_al")),
    ref=[act("delete", kind="album", where="photo count = 0")]))

S("T26-038-P", "locker type in star prev para",
  T("locker entries of type membership or document", rows("gym_card", "ogsp"),
    ref=[ans(kind="locker item", where='type in ("membership", "document")')]),
  T("star them both", diff(upd("gym_card", starred=True), upd("ogsp", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T26-042-P", "single count document folder count para",
  T("how many documents are filed in some folder", val(14),
    ref=[ans(op="count", kind="document", where="folder count > 0")]))

S("T26-048-P", "create person star unstar new para",
  T("put Hauwa Garba in my contacts, mama's 70th is being done by her as the caterer", diff(new("person", name="Hauwa Garba", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Hauwa Garba", role="caterer"))]),
  T("give her a star", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("stars are for family only, so unstar her", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]))

S("T26-060-P", "events person count status in duration within para",
  T("this week's events involving over three people, include cancelled ones", rows("ajo_1129"),
    ref=[ans(kind="event", where='person count > 3 and status in ("tentative", "cancelled")', when=U("week", 0))]),
  T("this month, which events run three hours or longer", rows("kemi_bday", "anniversary", "aisha_visit", "beach"),
    ref=[ans(kind="event", where="duration >= 180 minutes", when=U("month", 0))]),
  T("cancelled among them?", rows("beach"),
    ref=[ans(kind="event", within="@prev", where='status = "cancelled"')]))

S("T26-067-P", "document span datetime month add_to folder read para",
  T("thirtieth september 8am up to the end of october, which docs came in", rows("payslip_sep", "medical_form", "payslip_oct"),
    ref=[ans(kind="document", when=span(D("2026-09-30", "08:00"), U("month", 0, name=10)))]),
  T("Offshore medical form goes into offshore work", diff(link("rig_f", "medical_form")),
    ref=[act("add_to", kind="document", name="Offshore medical form", args=lines(to="$rig_f"))]),
  T("offshore work contents?", rows("contract", "payslip_oct", "payslip_sep", "roster", "medical_form"),
    ref=[ans(kind="document", linked_to="$rig_f")]))

S("T26-088-P", "locker notes set star named reveal wifi decline egress para",
  T("which locker entries carry notes", rows("gtbank", "portal", "gate_code", "nas", "passport", "savings", "office",
                                        "gym_card", "ogsp"),
    ref=[ans(kind="locker item", where="notes is set")]),
  T("Office 365 gets a star", diff(upd("office", starred=True)),
    ref=[act("star", kind="locker item", name="Office 365")]),
  T("i need the password to the home wifi for a new laptop", diff(reveal=[("wifi", "bello-five-kids")]),
    ref=[act("reveal", kind="locker item", name="Home wifi", args=lines(field="password"))]),
  T("send it to garba by text", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T26-094-P", "task miss search reschedule ask without options create event para",
  T("pull up the WAEC registration task", rows("waec"),
    ref=[find(kind="task", name="WAEC registration"), search("WAEC", kind="task"), ans(rows="@prev")]),
  T("make it the tenth instead", diff(upd("waec", date="2026-12-10")),
    ref=[act("reschedule", rows="$waec", args=lines(to=D("2026-12-10")))]),
  T("put in a meeting with the architect as well", ask(),
    ref=[askc("when should the meeting with yemisi be?")]),
  T("thursday at 4pm", diff(new("event", name=has("architect"), date="2026-11-26T16:00")),
    ref=[act("create", args=lines(kind="event", name="Meeting with the architect",
                                  date=U("week", 0, weekday=4, time="16:00")))]))

S("T26-098-P", "payslip ambiguous ask star edit document named add_to para",
  T("payslip gets a star", ask("payslip_sep", "payslip_oct"),
    ref=[act("star", kind="document", name="Payslip"),
         askc("september or october payslip?", options="$payslip_sep, $payslip_oct")]),
  T("october's", diff(upd("payslip_oct", starred=True)),
    ref=[act("star", rows="$payslip_oct")]),
  T("Scan 1121 should be called Plot survey receipt", diff(upd("scan_a", name="Plot survey receipt")),
    ref=[act("edit", kind="document", name="Scan 1121", args=lines(name="Plot survey receipt"))]),
  T("then it goes into house build", diff(link("house_f", "scan_a")),
    ref=[act("add_to", rows="$scan_a", args=lines(to="$house_f"))]))

S("T26-A003-P", "ask-options task complete c3a para",
  T("school fees are done, tick them off", ask("fees_tobi", "fees_kemi"),
    ref=[act("complete", kind="task", name="school fees"),
         askc("Pay Tobi's school fees or Pay Kemi's school fees?", options="$fees_tobi, $fees_kemi")]),
  T("tobi's one, paid this morning", diff(upd("fees_tobi", status="completed", completed=ANY)),
    ref=[act("complete", rows="$fees_tobi")]),
  T("mark the replace one finished", diff(upd("inverter", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="replace")]))

S("T26-A008-P", "follow-up c3a para",
  T("next week's schedule", rows("mama70", "medical", "site_1205", "vaccination", "plaster", "roof_meet", "football_1205", "parents_day", "dentist_kemi"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("limit it to before thursday", rows("roof_meet", "medical", "vaccination", "plaster"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=3)}))]),
  T("thursday onward then", rows("mama70", "parents_day", "dentist_kemi", "site_1205", "football_1205"),
    ref=[ans(within="@1", exclude="@2")]))

S("T26-B005-P", "c4b state-change cancel event restore trashed task para",
  T("kemi's appointment was cancelled by the dentist", diff(upd("dentist_kemi", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dentist Kemi")]),
  T("the old generator one needs to come back", diff(restore("old_gen")),
    ref=[act("restore", kind="task", name="old generator", trashed=True)]))

S("T26-C003-P", "c3c compound reschedule edit events at N para",
  T("friday at 10 is the new slot for the dentist for femi, and call the car service Brake check",
    diff(upd("dentist_femi", date="2026-11-27T10:00"), upd("car_service", name="Brake check")),
    ref=[act("reschedule", kind="event", name="Dentist for Femi", args=lines(to=U("week", 0, weekday=5, time="10:00")), more=True),
         act("edit", kind="event", name="Car service", args=lines(name="Brake check"))]))

S("T26-103-P", "gap ask person star emeka multi write para",
  T("emeka gets a star", ask("emeka_n", "emeka_o"),
    ref=[act("star", kind="person", name="Emeka"),
         askc("emeka nwosu or emeka obi?", options="$emeka_n, $emeka_o")]),
  T("the crane guy, obi", diff(upd("emeka_o", starred=True)),
    ref=[act("star", rows="$emeka_o")]),
  T("handover's sorted, put a call with segun in the log and star him as well", diff(upd("segun", date=ANY, starred=True)),
    ref=[act("log", kind="person", name="Segun Adeyemi", args=lines(kind="call"), more=True),
         act("star", kind="person", name="Segun Adeyemi")]))

S("T26-108-P", "gap contrast delete document star already multi write unstar para",
  T("october payslip is printed, so get rid of it", diff(trash("payslip_oct")),
    ref=[act("delete", kind="document", name="Payslip October")]),
  T("passport scan gets a star too", diff(already=["passport_scan"]),
    ref=[act("star", kind="document", name="Passport scan"), ans(rows="$passport_scan")]),
  T("zenith savings gets a star, gtbank loses its star", diff(upd("savings", starred=True), upd("gtbank", starred=False)),
    ref=[act("star", kind="locker item", name="Zenith savings account", more=True),
         act("unstar", kind="locker item", name="GTBank app")]))

S("T26-113-P", "gap ask event cancel dentist not_found search count para",
  T("dentist is off, cancel it", ask("dentist_femi", "dentist_kemi"),
    ref=[act("cancel", kind="event", name="Dentist"),
         askc("femi's on thursday or kemi's on the 3rd?", options="$dentist_femi, $dentist_kemi")]),
  T("the femi one, the clinic phoned", diff(upd("dentist_femi", status="cancelled")),
    ref=[act("cancel", rows="$dentist_femi")]),
  T("tailor fitting should be friday", decline("not_found"),
    ref=[search("tailor fitting", kind="event"), dec("not_found")]),
  T("this month, count of events i called off", val(3),
    ref=[ans(op="count", kind="event", where='status = "cancelled"', when=W(U("month", 0)))]))
