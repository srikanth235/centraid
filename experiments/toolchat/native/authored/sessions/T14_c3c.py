from gold import *
import json

world("T14", "2026-10-24T19:30", "Tomás Ferreira", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T14-C001", "c3c compound cancel create event referential rebook",
  T("cancel the landlord visit and put it again on monday at 10",
    diff(upd("landlord", status="cancelled"), new("event", name="Landlord visit", date="2026-10-26T10:00")),
    ref=[act("cancel", kind="event", name="Landlord visit", more=True),
         act("create", args=lines(kind="event", name="Landlord visit", date=U("week", 1, weekday=1, time="10:00")))]))

S("T14-C002", "c3c compound complete reschedule next weekday",
  T("mom's heart meds are bought, tick them off, and push the grab rail install to next saturday",
    diff(upd("mae_meds", status="completed", completed=ANY), upd("mae_rail", date="2026-10-31")),
    ref=[act("complete", kind="task", name="Buy Mom's heart meds", more=True),
         act("reschedule", kind="task", name="Install grab rail in Mom's bathroom", args=lines(to=U("week", 1, weekday=6)))]))

S("T14-C003", "c3c compound settle_debt star referential",
  T("kleber paid the 16 oct gig fee, settle it and star him",
    diff(upd("d_kleber", status="settled"), upd("kleber", starred=True)),
    ref=[act("settle_debt", kind="debt", name="Gig fee 16 Oct", more=True),
         act("star", rows="$kleber")]))

S("T14-C004", "c3c compound three writes settle_debt log star referential",
  T("paid patricia the echo share, settle it, log a message with her and star her",
    diff(upd("d_patricia", status="settled"), upd("patricia", date=ANY, starred=True)),
    ref=[act("settle_debt", kind="debt", name="Echo share", more=True),
         act("log", kind="person", name="Patrícia", args=lines(kind="message"), more=True),
         act("star", rows="$patricia")]))

S("T14-C101", "c3c bulk delete per kind last year find multi-kind empty read",
  T('delete everything from last year', diff(trash("ipva_25"), trash("old_contacts"), trash("cnh_doc"), trash("mei_cert")),
    ref=[find(kind="event,task,note,document,photo", when=W(U("year", -1))),
         act("delete", rows="$ipva_25", more=True),
         act("delete", rows="$old_contacts", more=True),
         act("delete", rows="$cnh_doc, $mei_cert")]),
  T("anything left from last year", rows(),
    ref=[ans(kind="event,task,note,document,photo", when=W(U("year", -1)))]))

S("T14-C901", "c3c cell7 empty recovery misspelled search then span",
  T("when's the car inspektion", rows("vistoria"),
    ref=[find(kind="event", name="inspektion"), search("car inspektion", kind="event"), ans(rows="$vistoria")]),
  T("what's on from the start of next week to the 1st at 6pm", rows("oil", "blood_work", "airport_otavio", "hand_1026", "reh_1028", "fut_1029", "landlord", "accountant", "kleber_1030", "lunch_mae", "physio_1029"),
    ref=[ans(kind="event", when=W(span(U("week", 1), D("2026-11-01", "18:00"))))]))

S("T14-C902", "c3c cell7 rejected delete folder with documents then delete empty one",
  T('delete the car documents folder', ask(),
    ref=[bad(act("delete", kind="folder", name="Car documents")), askc("car documents still has 3 documents in it, so it can't be deleted. move them first?")]),
  T('ok just delete the empty one', diff(gone("empty_f")),
    ref=[act("delete", kind="folder", where="document count = 0")]))
