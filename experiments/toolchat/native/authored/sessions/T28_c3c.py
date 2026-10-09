from gold import *
import json

world("T28", "2026-02-21T12:00", "Wiremu Tane", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T28-C001", "c3c compound create event create task evening",
  T("set up a hui with pita tuesday at 7 and add a task to write the agenda",
    diff(new("event", name=has("pita"), date="2026-02-24T19:00"), new("task", name=has("agenda"))),
    ref=[act("create", args=lines(kind="event", name="Hui with Pita", date=U("week", 1, weekday=2, time="19:00")), more=True),
         act("create", args=lines(kind="task", name="Write the agenda"))]))

S("T28-C002", "c3c compound settle_debt cancel",
  T("paid ria the groceries money so settle it, and cancel the bus depot reunion lunch",
    diff(upd("d_ria", status="settled"), upd("depot_lunch", status="cancelled")),
    ref=[act("settle_debt", kind="debt", name="Groceries", more=True),
         act("cancel", kind="event", name="Bus depot reunion lunch")]))

S("T28-C003", "c3c compound three writes add_to add_to star",
  T("put the brisbane itinerary in house and the netball draw in whanau, and star the itinerary",
    diff(link("house_f", "itinerary"), link("whanau_f", "draw"), upd("itinerary", starred=True)),
    ref=[act("add_to", kind="document", name="Brisbane flight itinerary", args=lines(to="$house_f"), more=True),
         act("add_to", kind="document", name="Netball draw", args=lines(to="$whanau_f"), more=True),
         act("star", rows="$itinerary")]))

S("T28-C004", "c3c compound delete restore document photo",
  T("delete scan 0221 and restore the blurry haka photo",
    diff(trash("scan"), restore("p_blurry")),
    ref=[act("delete", kind="document", name="Scan 0221", more=True),
         act("restore", kind="photo", name="blurry haka", trashed=True)]))

S("T28-C901", "c3c cell7 empty recovery nickname search then date time",
  T("what's nanny ria's role", rows("ria"),
    ref=[find(kind="person", name="Nanny Ria"), search("nanny ria", kind="person"), ans(rows="$ria")]),
  T('what did i add on the 20th at 3.45pm', rows("blood_results"),
    ref=[ans(kind="document", when=W(D("2026-02-20", "15:45")))]))

S("T28-C902", "c3c cell7 rejected cancel on task then edit status",
  T('cancel the kitchen tap job', diff(upd("tap", status="cancelled")),
    ref=[bad(act("cancel", kind="task", name="Fix the kitchen tap")), act("edit", kind="task", name="Fix the kitchen tap", args=lines(status="cancelled"))]))
