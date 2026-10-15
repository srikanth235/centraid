from gold import *
import json

world("T22", "2026-07-13T21:25", "Sven Lindqvist", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T22-102", "unstar contrast already star document",
  T("unstar my employment contract", diff(upd("contract", starred=False)),
    ref=[act("unstar", kind="document", name="Employment contract")]),
  T("star the summer house deed", diff(already=["deed"]),
    ref=[act("star", kind="document", name="Summer house deed"), ans(rows="$deed")]),
  T("and the co-ownership agreement", diff(upd("co_owner", starred=True)),
    ref=[act("star", kind="document", name="Co-ownership agreement")]),
  T("unstar the apartment contract", diff(upd("lease", starred=False)),
    ref=[act("unstar", kind="document", name="Apartment contract")]))

S("T22-107", "cancel ask swimming decline oos",
  T("cancel swimming, elias has a cold", ask("swim_1", "swim_2"),
    ref=[act("cancel", kind="event", name="Swimming lesson"),
         find(kind="event", name="Swimming lesson"),
         askc("tomorrow's lesson or the one on the 21st?", options="$swim_1, $swim_2")]),
  T("tomorrow's", diff(upd("swim_1", status="cancelled")),
    ref=[act("cancel", rows="$swim_1")]),
  T("email the pool that he's sick", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T22-109", "complete ask pay task reschedule bare weekday",
  T("paid it, tick off the pay one", ask("parking_fine", "el_07", "fee_07"),
    ref=[act("complete", kind="task", name="Pay", where='status = "open"'),
         askc("which one, the parking fine, the electricity bill or the fritids fee?", options="$parking_fine, $el_07, $fee_07")]),
  T("the fritids fee", diff(upd("fee_07", status="completed", completed=ANY)),
    ref=[act("complete", rows="$fee_07")]),
  T("move the electricity bill to friday", diff(upd("el_07", date="2026-07-17")),
    ref=[act("reschedule", kind="task", name="Pay electricity bill", where='status = "open"', args=lines(to=U("week", 0, weekday=5)))]))

S("T22-111", "reveal ask wifi star undo scratch that",
  T("show me the wifi password", ask("wifi", "wifi_sh"),
    ref=[act("reveal", kind="locker item", where='type = "wifi"', args=lines(field="password")),
         askc("home wifi or the summer house one?", options="$wifi, $wifi_sh")]),
  T("the summer house one", diff(reveal=[("wifi_sh", "osterlen-apple-7")]),
    ref=[act("reveal", rows="$wifi_sh", args=lines(field="password"))]),
  T("star it", diff(upd("wifi_sh", starred=True)),
    ref=[act("star", rows="$wifi_sh")]),
  T("scratch that", diff(upd("wifi_sh", starred=False)),
    ref=[act("undo")]))

S("T22-112", "wifi bare read contrast reveal prev bare read",
  T("what's the summer house wifi password", rows("wifi_sh"),
    ref=[ans(kind="locker item", name="Summer house wifi")]),
  T("show me it", diff(reveal=[("wifi_sh", "osterlen-apple-7")]),
    ref=[act("reveal", rows="@prev", args=lines(field="password"))]),
  T("and the home wifi pw", rows("wifi"),
    ref=[ans(kind="locker item", name="Home wifi")]))

S("T22-113", "reveal ask login fabricated",
  T("what's the password on my login", ask("bankid", "ikea_portal", "matchi"),
    ref=[act("reveal", kind="locker item", where='type = "login"', args=lines(field="password")),
         askc("which one, swedbank, the ikea portal or matchi?", options="$bankid, $ikea_portal, $matchi")]),
  T("the padel booking one", diff(reveal=[("matchi", "Torso-Lob-19")]),
    ref=[act("reveal", rows="$matchi", args=lines(field="password"))]),
  T("guess the pin for my swedbank visa, i forgot it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("star the matchi login and log a call with erik lund about the court booking",
    diff(upd("matchi", starred=True), upd("erik_l", date=ANY)),
    ref=[act("star", kind="locker item", name="Matchi padel booking", more=True),
         act("log", kind="person", name="Erik Lund", args=lines(kind="call"))]))

S("T22-114", "reveal contrast star sealed egress",
  T("show me the ikea portal password", diff(reveal=[("ikea_portal", "Gate4-Late-Shift!")]),
    ref=[act("reveal", kind="locker item", name="IKEA co-worker portal", args=lines(field="password"))]),
  T("star it", diff(upd("ikea_portal", starred=True)),
    ref=[act("star", rows="$ikea_portal")]),
  T("paste it into a message to mikael so he can log in", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))
