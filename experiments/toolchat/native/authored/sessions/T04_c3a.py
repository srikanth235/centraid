from gold import *

world("T04", "2026-10-14T19:40", "Aisha Rahman", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T04-A001", "ask-options event reschedule c3a",
  T("push the tasting to saturday", ask("cake", "menu"),
    ref=[act("reschedule", kind="event", name="tasting", args=lines(to=U("week", 0, weekday=6))),
         askc("The cake tasting on the 24th or the menu tasting at Mahmood Catering on 1 Nov?", options="$cake, $menu")]),
  T("the cake one", diff(upd("cake", date="2026-10-17T14:00")),
    ref=[act("reschedule", rows="$cake", args=lines(to=U("week", 0, weekday=6)))]))

S("T04-A002", "ask-options task complete c3a",
  T("tick off the audit", ask("audit", "audit_slides"),
    ref=[act("complete", kind="task", name="audit"),
         askc("Finish sepsis audit or Make audit slides?", options="$audit, $audit_slides")]),
  T("slides, sent them to dr okafor", diff(upd("audit_slides", status="completed", completed=ANY)),
    ref=[act("complete", rows="$audit_slides")]))

S("T04-A003", "ask-options photo star c3a",
  T("star the print", ask("print_abbey", "print_pier"),
    ref=[act("star", kind="photo", name="print"),
         askc("The 8x10 Abbey print or the pier print, split grade?", options="$print_abbey, $print_pier")]),
  T("pier", diff(upd("print_pier", starred=True)),
    ref=[act("star", rows="$print_pier")]),
  T("and the honour one's done, tick it off", diff(upd("speech", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="honour")]))

S("T04-A005", "ask-options debt settle_debt c3a",
  T("settle the deposit one", ask("d_zainab", "d_dad"),
    ref=[act("settle_debt", kind="debt", name="deposit"),
         askc("Zainab's lehenga fabric deposit (she owes you 85) or the car deposit help from your dad (you owe 500)?", options="$d_zainab, $d_dad")]),
  T("zainab, she paid me back at the fitting", diff(upd("d_zainab", status="settled")),
    ref=[act("settle_debt", rows="$d_zainab")]))

S("T04-A006", "ask-options event cancel c3a",
  T("cancel the wedding planning call", ask("wcall_1022", "wcall_1104"),
    ref=[act("cancel", kind="event", name="wedding planning call"),
         find(kind="event", name="wedding planning call", when=J({"from": U("day", 0)})),
         askc("The one on 22 Oct or the one on 4 Nov?", options="$wcall_1022, $wcall_1104")]),
  T("the 4th, zainab's away", diff(upd("wcall_1104", status="cancelled")),
    ref=[act("cancel", rows="$wcall_1104")]),
  T("and star tariq", diff(upd("dad", starred=True)),
    ref=[act("star", kind="person", name="Tariq")]))

S("T04-A101", "ask-options person star c3a",
  T("favourite rahman", ask("dad", "imran"),
    ref=[act("star", kind="person", name="Rahman"),
         askc("Tariq Rahman your dad or Imran Rahman your brother?", options="$dad, $imran")]))

S("T04-A007", "follow-up c3a",
  T("what's due in the next few days this week", rows("tins", "fb_rota", "develop", "bins", "wul_1", "boiler", "call_nasreen", "rota_swap"),
    ref=[ans(kind="task", when=J(U("week", 0)), where="status = open")]),
  T("any of those over an hour", rows("tins", "develop"),
    ref=[ans(within="@prev", where="effort > 60")]),
  T("and everything else", rows("bins", "wul_1", "boiler", "call_nasreen", "fb_rota", "rota_swap"),
    ref=[ans(within="@1", exclude="@2")]))

S("T04-A008", "follow-up c3a",
  T("what's on next week", rows("yoga_1024", "aoife_coffee", "wcall_1022", "cake", "fb_1024", "grand_round", "night_1020", "night_1019", "car_service", "lunch_nasreen"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("now only the ones after thursday", rows("aoife_coffee", "lunch_nasreen", "yoga_1024", "cake", "fb_1024"),
    ref=[ans(within="@prev", when=J({"from": U("week", 1, weekday=5)}))]),
  T("drop the first two", rows("lunch_nasreen", "yoga_1024", "cake"),
    ref=[ans(within="@prev", exclude="$aoife_coffee, $fb_1024")]))

S("T04-A009", "follow-up c3a",
  T("what's left on the wedding prep list", rows("caterer_nums", "speech", "mehndi_outfit", "playlist", "rsvps", "favours", "seating"),
    ref=[ans(kind="task", linked_to="$wedlist", where="status = open")]),
  T("which of those are in progress", rows("mehndi_outfit", "speech"),
    ref=[ans(within="@prev", where="status = in_progress")]),
  T("and the others", rows("caterer_nums", "rsvps", "favours", "playlist", "seating"),
    ref=[ans(within="@1", exclude="@2")]))

S("T04-A010", "follow-up c3a",
  T("what's in the whitby album", rows("gulls", "harbour", "steps", "fish_chips", "owen_cam", "abbey", "whalebone", "pier"),
    ref=[ans(kind="photo", linked_to="$whitby_album")]),
  T("which are starred", rows("abbey"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it", diff(upd("abbey", starred=False)),
    ref=[act("unstar", rows="@prev")]))
