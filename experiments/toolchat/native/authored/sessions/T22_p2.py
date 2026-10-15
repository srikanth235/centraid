from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
NOW = W({"from": U("day", 0)})
TOMORROW = W({"from": U("day", 1)})
THIS_WEEK = W(U("week", 0))
THIS_MONTH = W(U("month", 0))
NEXT3 = find(kind="event", when=NOW, order="date asc", limit=3)

S("T22-118-P", "star contrast person unstar weekend read para",
  T("samira haddad gets a star", diff(upd("samira", starred=True)),
    ref=[act("star", kind="person", name="Samira Haddad")]),
  T("ahmed would hate being a favourite, remove his star", diff(upd("ahmed", starred=False)),
    ref=[act("unstar", kind="person", name="Ahmed Haddad")]),
  T("weather at the summer house this weekend, will it rain", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T22-123-P", "delete ask photo beach never mind count para",
  T("beach pic, get rid of it", ask("p_ribersborg", "p_bridge"),
    ref=[act("delete", kind="photo", name="beach"),
         askc("ribersborg beach or the öresund bridge one?", options="$p_ribersborg, $p_bridge")]),
  T("forget it, they stay", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("elias album photo count", val(7),
    ref=[ans(op="count", kind="photo", linked_to="$elias_al")]))

S("T22-128-P", "effort unit repair not found trashed not found para",
  T("which jobs run past three hours", rows("fence", "sauna", "onboard"),
    ref=[bad(ans(kind="task", where="effort > 3 hours")),
         ans(kind="task", where="effort > 180")]),
  T("shift the padel trial session to friday", decline("not_found"),
    ref=[find(kind="event", name="Padel trial"), dec("not_found")]),
  T("get rid of the sailing lesson", decline("not_found"),
    ref=[search("sailing lesson"), dec("not_found")]),
  T("tick off buy sunscreen, and buy charcoal moves to friday as i'm at ica that day",
    diff(upd("sunscreen", status="completed", completed=ANY), upd("charcoal", date="2026-07-17")),
    ref=[act("complete", kind="task", name="Buy sunscreen", more=True),
         act("reschedule", kind="task", name="Buy charcoal", args=lines(to=U("week", 0, weekday=5)))]))
