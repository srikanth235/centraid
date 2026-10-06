from gold import *
import json

world("T21", "2026-06-06T09:00", "Grace Mwangi", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T21-C001", "c3c compound create person log referential",
  T("add Dr Eunice Wekesa, the eye doctor, and log a visit with her",
    diff(new("person", name="Dr Eunice Wekesa", role=ANY, date=ANY)),
    ref=[act("create", args=lines(kind="person", name="Dr Eunice Wekesa", role="eye doctor"), more=True),
         act("log", rows="$new", args=lines(kind="visit"))]))

S("T21-C002", "c3c compound reopen reschedule separate targets",
  T("reopen appraise janet, i need to redo it, and push appraise daniel to monday",
    diff(upd("appr_janet", status="open", completed=None), upd("appr_daniel", date="2026-06-08")),
    ref=[act("reopen", kind="task", name="Appraise Janet", more=True),
         act("reschedule", kind="task", name="Appraise Daniel", args=lines(to=U("week", 1, weekday=1)))]))

S("T21-C003", "c3c compound three writes reschedule reschedule cancel at N",
  T("move lunch with mary to friday at 1 and the plot survey to monday at 10, and cancel the car service",
    diff(upd("lunch_mary", date="2026-06-12T13:00"), upd("survey", date="2026-06-08T10:00"), upd("car_service", status="cancelled")),
    ref=[act("reschedule", kind="event", name="Lunch with Mary", args=lines(to=U("week", 1, weekday=5, time="13:00")), more=True),
         act("reschedule", kind="event", name="Plot survey with Wycliffe", args=lines(to=U("week", 1, weekday=1, time="10:00")), more=True),
         act("cancel", kind="event", name="Car service")]))

S("T21-C004", "c3c compound three writes star unstar add_to documents",
  T("star the survey map, unstar the title deed and put the tsc payslip in the receipts folder",
    diff(upd("survey_map", starred=True), upd("title", starred=False), link("receipts_f", "tsc_payslip")),
    ref=[act("star", kind="document", name="Survey map", more=True),
         act("unstar", kind="document", name="title deed", more=True),
         act("add_to", kind="document", name="TSC payslip", args=lines(to="$receipts_f"))]))

S("T21-C901", "c3c cell7 empty recovery nickname search then span",
  T('is shiru starred', rows("wanjiru"),
    ref=[find(kind="person", name="Shiru"), search("shiru", kind="person"), ans(rows="@prev")]),
  T('events from the start of the week to the 12th at 6pm', rows("chama_06", "kevin_call", "brief_0608", "harambee_plan", "choir_0604", "dentist_shiru", "lunch_mary", "brief_0601", "budget_joseph", "choir_0611", "bom_june", "clinic_june"),
    ref=[ans(kind="event", when=W(span(U("week", 0), D("2026-06-12", "18:00"))))]))

S("T21-C902", "c3c cell7 rejected create event clash ask",
  T('book a call with kevin monday at 5', ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Call with Kevin", date=U("week", 1, weekday=1, time="17:00")))), askc("monday at 5 clashes with the harambee planning meeting from 5 to 6. another time?")]))
