from gold import *
import json

world("T05", "2026-01-20T06:40", "Priya Raman", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T05-C001", "c3c compound settle_debt complete",
  T("gave jaya the canteen money, and tick off the projector return",
    diff(upd("d_jaya", status="settled"), upd("projector", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="Canteen dinner", more=True),
         act("complete", kind="task", name="Return the projector")]))

S("T05-C002", "c3c compound three writes move photo remove_from add_to star",
  T("move the biryani pic from cricket nights to family and star it",
    diff(unlink("cricket_al", "biryani"), link("family_al", "biryani"), upd("biryani", starred=True)),
    ref=[act("remove_from", kind="photo", name="Biryani", args=lines(from_="$cricket_al"), more=True),
         act("add_to", rows="$biryani", args=lines(to="$family_al"), more=True),
         act("star", rows="$biryani")]))

S("T05-C003", "c3c compound reopen reschedule same target",
  T("chepauk tickets fell through, reopen that and put it on friday",
    diff(upd("tickets", status="open", completed=None, date="2026-01-23")),
    ref=[act("reopen", kind="task", name="Book Chepauk tickets", more=True),
         act("reschedule", rows="$tickets", args=lines(to=U("week", 0, weekday=5)))]))

S("T05-C004", "c3c compound create event create task",
  T("put lunch with meena chithi in the diary saturday at 1 and remind me to buy her sweets friday",
    diff(new("event", name=has("meena"), date="2026-01-24T13:00"), new("task", name=has("sweets"), date="2026-01-23")),
    ref=[act("create", args=lines(kind="event", name="Lunch with Meena chithi", date=U("week", 0, weekday=6, time="13:00")), more=True),
         act("create", args=lines(kind="task", name="Buy sweets for Meena chithi", date=U("week", 0, weekday=5)))]))

S("T05-C101", "c3c bulk delete per kind name scoped last year",
  T('delete all the LIC premium payments and cricket nights from last year', diff(trash("lic_07"), trash("lic_08"), trash("lic_09"), trash("lic_10"), trash("lic_11"), trash("lic_12"), trash("cric_1123"), trash("cric_1228")),
    ref=[find(kind="task", name="LIC premium", when=W(U("year", -1))),
         act("delete", rows="@prev", more=True),
         find(kind="event", name="cricket night", when=W(U("year", -1))),
         act("delete", rows="@prev")]))

S("T05-C901", "c3c cell7 empty recovery wrong kind then debt amount",
  T("where's my sbi card", rows("sbi_card"),
    ref=[find(kind="document", name="sbi card"), ans(kind="locker item", name="sbi card")]),
  T('any debts of 1000 or more', rows("d_karthik", "d_arjun", "d_appa", "d_ramesh_mama"),
    ref=[ans(kind="debt", where="amount >= 1000")]))

S("T05-C902", "c3c cell7 rejected log kind",
  T('log a meeting with muthu', diff(upd("muthu", date=ANY)),
    ref=[bad(act("log", kind="person", name="Muthu", args=lines(kind="meeting"))), act("log", kind="person", name="Muthu", args=lines(kind="visit"))]),
  T('debts from last monday to the 18th at 6pm', rows("d_revathi", "d_arjun", "d_divya_s", "d_ramesh_mama"),
    ref=[ans(kind="debt", when=W(span(U("week", -1, weekday=1), D("2026-01-18", "18:00"))))]))
