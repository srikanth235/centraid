from gold import *
import json

world("T15", "2026-11-09T10:15", "Ingrid Solberg", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


OWED = 'direction = "owes_me" and status = "open"'
OWE = 'direction = "i_owe" and status = "open"'

S("T15-201", "both bills reschedule prev weekday read",
  T("which bills haven't i paid yet", rows("power_11", "cabin_el_11"),
    ref=[find(kind="task", name="Pay", where='status = "open"'), ans(rows="@prev")]),
  T("push both to friday", diff(upd("power_11", date="2026-11-13"), upd("cabin_el_11", date="2026-11-13")),
    ref=[act("reschedule", rows="@1", args=lines(to=U("week", 0, weekday=5)))]),
  T("what else is due friday", rows("report", "send_report"),
    ref=[ans(kind="task", when=W(U("week", 0, weekday=5)), exclude="$power_11, $cabin_el_11")]))

S("T15-202", "ordinal tomorrow events reschedule cancel",
  T("what's on tomorrow", rows("lunch_ingvild", "seminar", "boulder_1110", order=True),
    ref=[find(kind="event", when=W(U("day", 1)), order="date asc"), ans(rows="@prev")]),
  T("move the third one to 7", diff(upd("boulder_1110", date="2026-11-10T19:00")),
    ref=[act("reschedule", rows="$boulder_1110", args=lines(to=U("day", 0, anchor="row", time="19:00")))]),
  T("and cancel the first one, ingvild's ill", diff(upd("lunch_ingvild", status="cancelled")),
    ref=[act("cancel", rows="$lunch_ingvild")]))

S("T15-204", "except bouldering cancel rest read",
  T("bouldering nights left", rows("boulder_1110", "boulder_1117", "boulder_1215"),
    ref=[ans(kind="event", name="Bouldering night", when=W({"from": U("day", 0)}))]),
  T("cancel all of them except the december one, too much prep", diff(upd("boulder_1110", status="cancelled"), upd("boulder_1117", status="cancelled")),
    ref=[act("cancel", kind="event", rows="$boulder_1110, $boulder_1117")]),
  T("who usually comes to that one", rows("erik_j", "silje"),
    ref=[ans(kind="person", linked_to="$boulder_1215")]))

S("T15-205", "bare weekday at n range create",
  T("haircut friday at 4", diff(upd("haircut", date="2026-11-13T16:00")),
    ref=[act("reschedule", kind="event", name="Haircut", args=lines(to=U("week", 0, weekday=5, time="16:00")))]),
  T("what's on monday to wednesday this week", rows("lunch_ingvild", "seminar", "boulder_1110", "plan_1111", "kino"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]),
  T("push the bathroom tap to saturday", diff(upd("tap", date="2026-11-14")),
    ref=[act("reschedule", kind="task", name="Fix the bathroom tap", args=lines(to=U("week", 0, weekday=6)))]),
  T("dinner with silje thursday at 7", diff(new("event", name=has("Silje"), date="2026-11-12T19:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Silje", date=U("week", 0, weekday=4, time="19:00")))]))
