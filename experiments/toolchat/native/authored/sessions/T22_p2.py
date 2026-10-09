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
BIG2 = find(kind="debt", where=IOWE, order="amount desc", limit=2)
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

S("T22-133-P", "min owed typo then max then ask parents picnic later never mind para",
  T("i want to chase the little ones tomorrow by message, so what's the smallest debt owed to me",
    val((120, "SEK")),
    ref=[ans(op="min", field="amount", kind="debt", where=OWED)]),
  T("biggest one next, probably samira's train tickets she hasn't paid yet",
    val((2000, "SEK")),
    ref=[ans(op="max", field="amount", kind="debt", where=OWED)]),
  T("picnic should start at 12 instead", ask("picnic_jun", "picnic_aug"),
    ref=[act("reschedule", kind="event", name="Parents network picnic",
             args=lines(to=U("day", 0, anchor="row", time="12:00"))),
         find(kind="event", name="Parents network picnic"),
         askc("the one on the 14th of june or the one on the 16th of august?", options="$picnic_jun, $picnic_aug")]),
  T("forget it, the park booking is fixed according to maria, neither picnic can shift, i'll ask thursday",
    decline("never_mind"),
    ref=[dec("never_mind")]))

S("T22-138-P", "oldest debt typo then unbounded debts then max owed then min duration para",
  T("of what i still owe, which debt is the oldest", rows("d_david"),
    ref=[ans(kind="debt", where=IOWE, order="date asc", limit=1)]),
  T("wipe every debt plus the groups, the money side should be totally empty",
    decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("which single amount do i owe the most on, the one to pay first",
    val((1200, "SEK")),
    ref=[ans(op="max", field="amount", kind="debt", where=IOWE)]),
  T("what's my briefest event", val(30),
    ref=[ans(op="min", field="duration", kind="event")]))
