from gold import *
import json

world("T17", "2026-01-30T13:35", "Elena Petrova", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T17-C001", "c3c compound delete add_to documents",
  T("delete scan 0071 and file scan 0072 in the students folder",
    diff(trash("scan_71"), link("students_f", "scan_72")),
    ref=[act("delete", kind="document", name="Scan 0071", more=True),
         act("add_to", kind="document", name="Scan 0072", args=lines(to="$students_f"))]))

S("T17-C003", "c3c compound log reschedule at N bare weekday",
  T("log a call with mitko and push the walkthrough to tuesday at 10",
    diff(upd("mitko", date=ANY), upd("walkthrough", date="2026-02-03T10:00")),
    ref=[search("mitko", kind="person"), act("log", rows="@prev", args=lines(kind="call"), more=True),
         act("reschedule", kind="event", name="Walkthrough with Mitko", args=lines(to=U("week", 1, weekday=2, time="10:00")))]))

S("T17-C101", "c3c bulk delete per kind name scoped last year",
  T('delete all the choir rehearsals and electricity bills from last year', diff(trash("choir_1202"), trash("choir_1209"), trash("choir_1216"), trash("choir_1223"), trash("choir_1230"), trash("elec_10"), trash("elec_11"), trash("elec_12")),
    ref=[find(kind="event", name="choir rehearsal", when=W(U("year", -1))),
         act("delete", rows="@prev", more=True),
         find(kind="task", name="electricity bill", when=W(U("year", -1))),
         act("delete", rows="@prev")]))

S("T17-C901", "c3c cell7 search miss command decline then span",
  T('find kazoo', decline("not_found"),
    ref=[search("kazoo"), dec("not_found")]),
  T("what's on from the 31st at noon until next friday", rows("maria_0204", "handover_0201", "vesi_reh", "tiles_delivery", "sectional", "dentist_v", "maria_k_lesson", "ptm", "choir_0203", "vesi_exam", "walkthrough", "kalina_lesson", "ivan_0202"),
    ref=[ans(kind="event", when=W(span(D("2026-01-31", "12:00"), U("week", 1, weekday=5))))]))

S("T17-C902", "c3c cell7 rejected edit unknown field",
  T("put the venue in the recital event, it's the music school hall", diff(upd("recital", description=has("music school"))),
    ref=[bad(act("edit", kind="event", name="Student recital", args=lines(location="music school hall"))), act("edit", kind="event", name="Student recital", args=lines(description="music school hall"))]))
