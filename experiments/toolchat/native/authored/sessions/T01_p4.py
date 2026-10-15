from gold import *

world("T01", "2026-03-12T18:20", "Oluwaseun Adebayo-Clarke", "train")

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T01-201", "both followup complete reschedule",
  T("kids stuff due tmrw", rows("permission", "reading_book"),
    ref=[ans(kind="task", linked_to="$kids_list", when=J(U("day", 1)))]),
  T("done both", diff(upd("permission", status="completed", completed=ANY),
                      upd("reading_book", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]),
  T("what's due saturday", rows("boots", "card_mum"),
    ref=[ans(kind="task", when=J(U("week", 0, weekday=6)))]),
  T("push them both to sunday", diff(upd("boots", date="2026-03-15"), upd("card_mum", date="2026-03-15")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 0, weekday=7)))]))

S("T01-204", "except rest list complete reschedule",
  T("work stuff due this month", rows("fire_safety", "infection", "swap_night", "charger", "study_parking"),
    ref=[ans(kind="task", linked_to="$work_list", when=J(U("month", 0)))]),
  T("all done except the night swap", diff(upd("fire_safety", status="completed", completed=ANY),
                                           upd("infection", status="completed", completed=ANY),
                                           upd("charger", status="completed", completed=ANY),
                                           upd("study_parking", status="completed", completed=ANY)),
    ref=[find(within="@prev", exclude="$swap_night"), act("complete", rows="@prev")]),
  T("push the other one to friday", diff(upd("swap_night", date="2026-03-13")),
    ref=[act("reschedule", rows="$swap_night", args=lines(to=U("week", 0, weekday=5)))]))

S("T01-205", "weekday at-N range count reschedule create",
  T("how many long days monday to wednesday this week", val(2),
    ref=[ans(op="count", kind="event", name="long day", when=J(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]),
  T("move the plumber quote visit to monday", diff(upd("plumber_visit", date="2026-03-16T16:00")),
    ref=[act("reschedule", rows="$plumber_visit", args=lines(to=U("week", 1, weekday=1)))]),
  T("coffee with ifeoma, make it friday at 5", diff(upd("ifeoma_coffee", date="2026-03-13T17:00")),
    ref=[act("reschedule", rows="$ifeoma_coffee", args=lines(to=U("week", 0, weekday=5, time="17:00")))]),
  T("ring kunle saturday at 6", diff(new("event", name=has("kunle"), date="2026-03-14T18:00")),
    ref=[act("create", args=lines(kind="event", name="Ring Kunle", date=U("week", 0, weekday=6, time="18:00")))]))
