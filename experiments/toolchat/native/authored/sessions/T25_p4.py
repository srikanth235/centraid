from gold import *

world("T25", "2026-10-11T18:45", "Yuki Tanaka", "train")

# 201 both / all of them
# 202 ordinal / positional
S("T25-202", "p4 ordinal event cancel reschedule handoff relist",
  T("mika's handoffs from now on", rows("handoff_1016", "handoff_1023", "handoff_1030", "handoff_1106", "handoff_1113", "handoff_1120", "handoff_1127"),
    ref=[ans(kind="event", name="Mika handoff", when={"from": U("day", 0)}, order="date asc")]),
  T("cancel the fifth one, daniel has her that weekend", diff(upd("handoff_1113", status="cancelled")),
    ref=[act("cancel", rows="$handoff_1113")]),
  T("so what's left", rows("handoff_1016", "handoff_1023", "handoff_1030", "handoff_1106", "handoff_1120", "handoff_1127"),
    ref=[ans(kind="event", name="Mika handoff", when={"from": U("day", 0)}, where='status != "cancelled"', order="date asc")]),
  T("last one to 6", diff(upd("handoff_1127", date="2026-11-27T18:00")),
    ref=[act("reschedule", rows="$handoff_1127", args=lines(to=U("day", 0, anchor="row", time="18:00")))]))

# 204 except / besides
S("T25-204", "p4 except exclude document star task reschedule weekday",
  T("what's in mika's school folder", rows("report_card", "trip_form", "school_cal"),
    ref=[ans(kind="document", linked_to="$school_f")]),
  T("star all of them except the report card", diff(upd("trip_form", starred=True), upd("school_cal", starred=True)),
    ref=[find(kind="document", within="@prev", exclude="$report_card"), act("star", rows="@prev")]),
  T("what's due wednesday", rows("onboarding", "export_assets", "radiator", "thank_you"),
    ref=[ans(kind="task", when=U("week", 1, weekday=3))]),
  T("push everything but the onboarding one to thursday",
    diff(upd("export_assets", date="2026-10-15"), upd("radiator", date="2026-10-15"), upd("thank_you", date="2026-10-15")),
    ref=[find(kind="task", within="@prev", exclude="$onboarding"),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=4)))]))

# 205 bare weekdays and at N
S("T25-205", "p4 weekday at-N reschedule create photo range",
  T("call with the lawyer to thursday at 4", diff(upd("lawyer_call", date="2026-10-15T16:00")),
    ref=[act("reschedule", kind="event", name="Call with the lawyer", args=lines(to=U("week", 1, weekday=4, time="16:00")))]),
  T("coffee with marc to tuesday at 8", diff(upd("coffee_marc", date="2026-10-13T08:00")),
    ref=[act("reschedule", kind="event", name="Coffee with Marc", args=lines(to=U("week", 1, weekday=2, time="08:00")))]),
  T("photos from monday to wednesday this week", rows("sunset", "whiteboard", "boots_p", "sticky"),
    ref=[ans(kind="photo", when=span(U("week", 0, weekday=1), U("week", 0, weekday=3)))]),
  T("put a call with mom in the diary tuesday at 7", diff(new("event", name=has("call", "mom"), date="2026-10-13T19:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Mom", date=U("week", 1, weekday=2, time="19:00")))]))

# 206 two writes in one message