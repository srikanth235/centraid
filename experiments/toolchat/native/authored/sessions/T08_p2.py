from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T08-103-P", "star ask document insurance card unstar locker contrast para",
  T("put a star on the insurance card", diff(upd("dental_card", starred=True)),
    ref=[act("star", kind="document", name="insurance card")]),
  T("union card, remove its star", diff(upd("union_card", starred=False)),
    ref=[act("unstar", kind="locker item", name="union card")]))

S("T08-107-P", "star person contrast balance negative substitution para",
  T("marcus bell gets a star", diff(upd("marcus_b", starred=True)),
    ref=[act("star", kind="person", name="Marcus Bell")]),
  T("what am i down to darnell", val((-8, "USD")),
    ref=[ans(op="balance", kind="person", name="Darnell")]),
  T("kevin?", val((-12.34, "USD")),
    ref=[ans(op="balance", kind="person", name="Kevin")]))

S("T08-110-P", "cancel event ask on-call reschedule bare weekday at N decline para",
  T("luis is covering one of my on-call shifts since we swapped, cancel that shift", ask("oncall_0410", "oncall_0424", "oncall_0508"),
    ref=[act("cancel", kind="event", name="On-call shift"),
         find(kind="event", name="On-call shift"),
         askc("which shift, the 10th, the 24th or may 8th?", options="$oncall_0410, $oncall_0424, $oncall_0508")]),
  T("24th", diff(upd("oncall_0424", status="cancelled")),
    ref=[act("cancel", rows="$oncall_0424")]),
  T("tax appointment needs to be thursday at 1 now", diff(upd("tax_appt", date="2026-04-09T13:00")),
    ref=[act("reschedule", kind="event", name="Tax appointment", args=lines(to=U("week", 0, weekday=4, time="13:00")))]),
  T("phone the dentist to confirm jalen's slot", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T08-114-P", "reveal ask login school wifi read then reveal para",
  T("my login password, what is it", ask("servicetitan", "portal", "bank_login"),
    ref=[act("reveal", kind="locker item", where='type = "login"', args=lines(field="password")),
         askc("which one, the dispatch app, the school portal or the credit union?", options="$servicetitan, $portal, $bank_login")]),
  T("school", diff(reveal=[("portal", "JJtwins2013")]),
    ref=[act("reveal", rows="$portal", args=lines(field="password"))]),
  T("wifi pw?", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("give me the wifi password", diff(reveal=[("wifi", "EaglesNest2026!")]),
    ref=[act("reveal", rows="$wifi", args=lines(field="password"))]))

S("T08-117-P", "log contrast next event reschedule prev anchor para",
  T("just spoke to tanya brooks, put it down as a call", diff(upd("tanya", date=ANY)),
    ref=[act("log", kind="person", name="Tanya Brooks", args=lines(kind="call"))]),
  T("union chapter meeting coming up next, move it to 8pm", diff(upd("union_0408", date="2026-04-08T20:00")),
    ref=[act("reschedule", kind="event", name="Union chapter meeting", when=W({"from": U("day", 0)}),
             order="date asc", limit=1, args=lines(to=U("day", 0, anchor="row", time="20:00")))]))
