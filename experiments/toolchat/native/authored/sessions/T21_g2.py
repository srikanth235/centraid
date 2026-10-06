from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T21-116", "bom meeting cancel ask pick undo never_mind",
  T("cancel the bom meeting", ask("bom_may", "bom_june"),
    ref=[act("cancel", kind="event", name="BOM meeting"),
         find(kind="event", name="BOM meeting"),
         askc("the one on 13 may or the one on 10 june?", options="$bom_may, $bom_june")]),
  T("june's", diff(upd("bom_june", status="cancelled")),
    ref=[act("cancel", rows="$bom_june")]),
  T("scratch that, it's still on", diff(),
    ref=[act("undo")]))

S("T21-117", "bom next cancel finance committee create clash repair",
  T("cancel the next bom meeting", diff(upd("bom_june", status="cancelled")),
    ref=[act("cancel", kind="event", name="BOM meeting", when=W({"from": U("day", 0)}))]),
  T("and the finance committee too", diff(upd("bom_fin", status="cancelled")),
    ref=[act("cancel", kind="event", name="BOM finance committee")]),
  T("add a meeting with the fundi monday at 7:30", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Meeting with the fundi", date=U("week", 1, weekday=1, time="07:30")))),
         askc("monday 7:30 clashes with the staff briefing. want it at 8 instead?")]))

S("T21-118", "kevin events reschedule ask pick sunday at 1 undo never_mind",
  T("push the kevin thing to next sunday at 1", ask("kevin_call", "kevin_visit"),
    ref=[act("reschedule", kind="event", name="Kevin", args=lines(to=U("week", 1, weekday=7, time="13:00"))),
         askc("the call tomorrow night or kevin and naomi visiting next saturday?", options="$kevin_call, $kevin_visit")]),
  T("the visit", diff(upd("kevin_visit", date="2026-06-14T13:00")),
    ref=[act("reschedule", rows="$kevin_visit", args=lines(to=U("week", 1, weekday=7, time="13:00")))]),
  T("cancel that, keep it on saturday", diff(upd("kevin_visit", date="2026-06-13T12:00")),
    ref=[act("undo")]))

S("T21-119", "kevin naomi visit prev reschedule star",
  T("when do kevin and naomi visit", rows("kevin_visit"),
    ref=[ans(kind="event", name="Kevin and Naomi visiting")]),
  T("move it to next sunday at 1", diff(upd("kevin_visit", date="2026-06-14T13:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=7, time="13:00")))]),
  T("and star naomi", diff(upd("naomi", starred=True)),
    ref=[act("star", kind="person", name="Naomi")]),
  T("wifi pw in the locker?", rows("wifi"),
    ref=[ans(kind="locker item", name="wifi")]))

S("T21-120", "peter balance ask pick log",
  T("what does peter owe me", ask("peter_k", "peter_o"),
    ref=[find(kind="person", name="Peter"),
         askc("peter kariuki from the BOM or peter otieno from church?", options="$peter_k, $peter_o")]),
  T("the bom chairman", val((450, "KES")),
    ref=[ans(op="balance", rows="$peter_k")]),
  T("log a call with him, we talked about the agenda", diff(upd("peter_k", date=ANY)),
    ref=[act("log", rows="$peter_k", args=lines(kind="call"))]),
  T("star the other peter too", diff(upd("peter_o", starred=True)),
    ref=[act("star", rows="$peter_o")]))

S("T21-121", "balance named kevin fundi search joseph weather weekend",
  T("what do i owe kevin", val((-7000, "KES")),
    ref=[ans(op="balance", kind="person", name="Kevin")]),
  T("and fundi?", val((-4500, "KES")),
    ref=[search("fundi", kind="person"), ans(op="balance", rows="@prev")]),
  T("joseph?", val((-650, "KES")),
    ref=[ans(op="balance", kind="person", name="Joseph")]),
  T("what's the weather in nakuru this weekend", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T21-122", "balance alice mary susan family group",
  T("how do i stand with alice", val((3000, "KES")),
    ref=[ans(op="balance", kind="person", name="Alice")]),
  T("and mary achieng", val((1500, "KES")),
    ref=[ans(op="balance", kind="person", name="Mary Achieng")]),
  T("susan?", val((-500, "KES")),
    ref=[ans(op="balance", kind="person", name="Susan")]),
  T("where does brian stand in the family", val((-4000, "KES")),
    ref=[ans(op="balance", kind="group", name="Mwangi family", linked_to="$brian")]),
  T("how many chama meetings are left this year", val(3),
    ref=[ans(op="count", kind="event", name="Chama meeting", when=W({"from": U("day", 0)}))]))

S("T21-125", "fees documents star ask pick unstar",
  T("star the fees doc", ask("fee_structure", "arrears_list", "shiru_receipt"),
    ref=[act("star", kind="document", name="fee"),
         askc("fee structure 2026, the fees arrears list or shiru's fee receipt?",
              options="$fee_structure, $arrears_list, $shiru_receipt")]),
  T("the arrears one", diff(upd("arrears_list", starred=True)),
    ref=[act("star", rows="$arrears_list")]),
  T("unstar the chama constitution", diff(upd("chama_const", starred=False)),
    ref=[act("unstar", kind="document", name="Chama constitution")]),
  T("star the survey map though", diff(upd("survey_map", starred=True)),
    ref=[act("star", kind="document", name="Survey map")]))

S("T21-127", "this weekend read create date repair saturday",
  T("what's on this weekend", rows("chama_06", "kevin_call"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]),
  T("remind me to carry the ledger to the chama meeting, saturday", diff(new("task", name=has("ledger"), date="2026-06-06")),
    ref=[bad(act("create", args=lines(kind="task", name="Carry the ledger to the chama meeting", date={"weekday": 6}))),
         act("create", args=lines(kind="task", name="Carry the ledger to the chama meeting", date=U("week", 0, weekday=6)))]),
  T("any tasks sitting in the trash", rows("curtains", "sofa"),
    ref=[ans(kind="task", trashed=True)]),
  T("restore the curtains one", diff(restore("curtains")),
    ref=[act("restore", rows="$curtains")]))

S("T21-128", "wifi read reveal prev fabricated",
  T("do i have the wifi password saved", rows("wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("read it out", diff(reveal=[("wifi", "flamingo-2026")]),
    ref=[act("reveal", rows="$wifi", kind="locker item", args=lines(field="password"))]),
  T("make up a new guest wifi password", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("empty everything out of the vault, starting from zero", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T21-129", "delete all decline sms matatu cadence repair",
  T("delete all my events", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("send an sms to the parents about the fees deadline", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("book me a matatu to nyeri for friday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("who do i check in with less often than every two weeks", rows("naomi", "daniel", "rev_kiprono", "rose"),
    ref=[bad(ans(kind="person", where="cadence > 2 weeks")),
         ans(kind="person", where="cadence > 14 days")]))

S("T21-130", "trashed hair appointment not_found wifi code old minutes past window clear vault education",
  T("move the hair appointment to friday", decline("not_found"),
    ref=[find(kind="event", name="Hair appointment"), find(kind="event", name="Hair appointment", trashed=True),
         dec("not_found")]),
  T("tell me the wifi password, the technician is at the gate", diff(reveal=[("wifi", "flamingo-2026")]),
    ref=[act("reveal", kind="locker item", where='type = "wifi"', args=lines(field="password"))]),
  T("bring back the old chama minutes", ask(),
    ref=[bad(act("restore", kind="note", name="Old chama minutes", trashed=True)),
         askc("those minutes have been in the bin since march, too long to restore. want me to start a new note instead?")]),
  T("who is the cabinet secretary for education", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))
