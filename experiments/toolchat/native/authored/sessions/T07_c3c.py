from gold import *
import json

world("T07", "2026-03-12T12:30", "Maria Ines Quispe", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T07-C001", "c3c compound create event create task list",
  T("call with sonia friday at 3, and put a reminder on the coop list to ask about the seed order",
    diff(new("event", name=has("sonia"), date="2026-03-13T15:00"), new("task", name=has("seed", "order"), date="2026-03-13"),
         link("coop_l", "new")),
    ref=[act("create", args=lines(kind="event", name="Call with Sonia", date=U("week", 0, weekday=5, time="15:00")), more=True),
         act("create", args=lines(kind="task", name="Ask Sonia about the seed order", date=U("week", 0, weekday=5), list="$coop_l"))]))

S("T07-C002", "c3c compound settle_debt log referential",
  T("settled the lab fee with hugo, and log a call with him",
    diff(upd("d_hugo", status="settled"), upd("hugo", date=ANY)),
    ref=[act("settle_debt", kind="debt", name="Lab fee share", more=True),
         act("log", rows="$hugo", args=lines(kind="call"))]))

S("T07-C003", "c3c compound cancel complete",
  T("cancel the truck service, and mark the gas refill done",
    diff(upd("mechanic", status="cancelled"), upd("gas", status="completed", completed=ANY)),
    ref=[act("cancel", kind="event", name="Truck service at Pinto's garage", more=True),
         act("complete", kind="task", name="Refill the gas cylinder")]))

S("T07-C004", "c3c compound reopen complete",
  T("reopen the electricity bill, wrong amount, and tick off the water bill",
    diff(upd("elec_bill", status="open", completed=None), upd("water_bill", status="completed", completed=ANY)),
    ref=[act("reopen", kind="task", name="Pay the electricity bill", more=True),
         act("complete", kind="task", name="Pay the water bill")]))

S("T07-C101", "c3c bulk delete per kind name scoped last year",
  T('delete the notes and the coop dues tasks from last year', diff(trash("seed_2025"), trash("natives"), trash("chuno"), trash("ocopa"), trash("dues_10"), trash("dues_11"), trash("dues_12")),
    ref=[find(kind="note", when=W(U("year", -1))),
         act("delete", rows="@prev", more=True),
         find(kind="task", name="coop dues", when=W(U("year", -1))),
         act("delete", rows="@prev")]))

S("T07-C901", "c3c cell7 empty recovery wrong kind then span",
  T("where's the padlock code", rows("padlock"),
    ref=[find(kind="note", name="padlock code"), ans(kind="locker item", name="padlock code")]),
  T('tasks due from the 14th at 8am through next week', rows("trial_data", "rent_mar", "scout_report", "agro_title", "hugo_email", "agro_bank", "julio_gift", "water_bill", "expo_banner", "irrigation", "vale_box", "mama_pills", "agro_docs"),
    ref=[ans(kind="task", when=W(span(D("2026-03-14", "08:00"), U("week", 1))))]))

S("T07-C902", "c3c cell7 rejected delete group with expenses ask",
  T('delete the papa andina coop group', ask(),
    ref=[bad(act("delete", kind="group", name="Papa Andina coop")), askc("the coop group still has expenses in it, so it can't be deleted. settle up with everyone first?")]))
