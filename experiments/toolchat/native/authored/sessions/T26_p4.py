from gold import *

world("T26", "2026-11-24T05:30", "Ahmed Bello", "train")

# 201 both / all of them
S("T26-201", "p4 both prev task reschedule complete weekday",
  T("what's due friday", rows("gate", "roofing"),
    ref=[ans(kind="task", when=U("week", 0, weekday=5))]),
  T("push both to saturday", diff(upd("gate", date="2026-11-28"), upd("roofing", date="2026-11-28")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 0, weekday=6)))]),
  T("tobi and kemi's school fees tasks", rows("fees_tobi", "fees_kemi"),
    ref=[ans(kind="task", name="school fees")]),
  T("done both, paid online", diff(upd("fees_tobi", status="completed", completed=ANY), upd("fees_kemi", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]))

# 202 ordinal / positional
S("T26-202", "p4 ordinal event weekend reschedule sunday substitution",
  T("what's on this weekend", rows("site_1128", "football_1128", "aisha_visit", "beach", "ajo_1129"),
    ref=[ans(kind="event", when={"from": U("week", 0, weekday=6), "to": U("week", 0, weekday=7)}, order="date asc")]),
  T("move the second one to 5", diff(upd("football_1128", date="2026-11-28T17:00")),
    ref=[act("reschedule", rows="$football_1128", args=lines(to=D("2026-11-28", "17:00")))]),
  T("and sunday", rows("beach", "ajo_1129"),
    ref=[ans(kind="event", when=U("week", 0, weekday=7), order="date asc")]),
  T("last one to 5:30", diff(upd("ajo_1129", date="2026-11-29T17:30")),
    ref=[act("reschedule", rows="$ajo_1129", args=lines(to=U("day", 0, anchor="row", time="17:30")))]))

# 204 except / besides
S("T26-204", "p4 except exclude person log task delete",
  T("who are my cousins", rows("kunle_b", "bayo", "funmi", "sade", "ibrahim"),
    ref=[ans(kind="person", where='role contains "cousin"')]),
  T("log a call with all of them except ibrahim", diff(upd("kunle_b", date=ANY), upd("bayo", date=ANY), upd("funmi", date=ANY), upd("sade", date=ANY)),
    ref=[find(kind="person", within="@prev", exclude="$ibrahim"), act("log", rows="@prev", args=lines(kind="call"))]),
  T("what electricity bill tasks are there", rows("power_08", "power_09", "power_10", "power_11"),
    ref=[ans(kind="task", name="electricity bill")]),
  T("delete all of them except the november one", diff(trash("power_08"), trash("power_09"), trash("power_10")),
    ref=[find(kind="task", within="@prev", exclude="$power_11"), act("delete", rows="@prev")]))

# 205 bare weekdays and at N
S("T26-205", "p4 weekday at-N reschedule create range task",
  T("car service to friday at 2", diff(upd("car_service", date="2026-11-27T14:00")),
    ref=[act("reschedule", kind="event", name="Car service at Sunday's", args=lines(to=U("week", 0, weekday=5, time="14:00")))]),
  T("aisha's visit to sunday at 6", diff(upd("aisha_visit", date="2026-11-29T18:00")),
    ref=[act("reschedule", kind="event", name="Aisha visiting", args=lines(to=U("week", 0, weekday=7, time="18:00")))]),
  T("what's due monday to wednesday this week", rows("blocks_count", "phone", "power_11"),
    ref=[ans(kind="task", when=span(U("week", 0, weekday=1), U("week", 0, weekday=3)))]),
  T("call yemisi friday at 5, put it in the diary", diff(new("event", name=has("yemisi"), date="2026-11-27T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Yemisi", date=U("week", 0, weekday=5, time="17:00")))]))

# 206 two writes in one message