from gold import *
import json

world("T15", "2026-11-09T10:15", "Ingrid Solberg", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T15-C001", "c3c compound add_to person group star referential",
  T("add anders to the cabin share group and star him",
    diff(link("cabin", "anders"), upd("anders", starred=True)),
    ref=[act("add_to", kind="person", name="Anders", args=lines(to="$cabin"), more=True),
         act("star", rows="$anders")]))

S("T15-C002", "c3c compound complete delete tasks",
  T("tick off the cat food and delete the snow shovel one, dad's lending me his",
    diff(upd("cat_food", status="completed", completed=ANY), trash("snow_shovel")),
    ref=[act("complete", kind="task", name="Buy cat food for Pusur", more=True),
         act("delete", kind="task", name="Buy a new snow shovel")]))

S("T15-C003", "c3c compound cancel reschedule event task bare weekday",
  T("cancel the vet check for pusur and push the cat food to friday",
    diff(upd("vet_1112", status="cancelled"), upd("cat_food", date="2026-11-13")),
    ref=[act("cancel", kind="event", name="Vet check for Pusur", more=True),
         act("reschedule", kind="task", name="Buy cat food for Pusur", args=lines(to=U("week", 0, weekday=5)))]))

S("T15-C004", "c3c compound three writes restore add_to unstar",
  T("bring back the cruise plan v1 doc, file it in cruise reports and unstar the stcw one, it's expired",
    diff(restore("plan_v1"), link("reports_f", "plan_v1"), upd("stcw", starred=False)),
    ref=[act("restore", kind="document", name="Cruise plan HV-2611 v1", trashed=True, more=True),
         act("add_to", rows="$plan_v1", args=lines(to="$reports_f"), more=True),
         act("unstar", kind="document", name="STCW")]))

S("T15-C901", "c3c cell7 empty recovery wrong kind then note count",
  T("where's the cabin share agreement", rows("cabin_agreement"),
    ref=[find(kind="note", name="cabin share agreement"), ans(kind="document", name="cabin share agreement")]),
  T('count the notes that belong to some notebook', val(14),
    ref=[ans(op="count", kind="note", where="notebook count >= 1")]))
