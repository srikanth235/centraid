from gold import *
import json

world("T16", "2026-12-16T18:00", "Rafiq Chowdhury", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


OWED = 'direction = "owes_me" and status = "open"'
OWE = 'direction = "i_owe" and status = "open"'
LIVE = 'status = "open"'

S("T16-202", "ordinal weekend events reschedule cancel",
  T("what's on this weekend", rows("machine_service", "ptm_mim", "prod_1220", "electrician", "tea_topu", "masud_call", order=True),
    ref=[find(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))), order="date asc"), ans(rows="@prev")]),
  T("move the fourth one to monday at 11", diff(upd("electrician", date="2026-12-21T11:00")),
    ref=[act("reschedule", rows="$electrician", args=lines(to=U("week", 1, weekday=1, time="11:00")))]),
  T("cancel the last one, masud is travelling", diff(upd("masud_call", status="cancelled")),
    ref=[act("cancel", rows="$masud_call")]))

S("T16-204", "except friday tasks reschedule rest",
  T("what's due friday", rows("water_pump", "abba_meds", "salma_leave", "kitty_collect"),
    ref=[find(kind="task", when=W(U("week", 0, weekday=5)), where=LIVE), ans(rows="@prev")]),
  T("push the rest to monday, except the pump and abba's medicine",
    diff(upd("salma_leave", date="2026-12-21"), upd("kitty_collect", date="2026-12-21")),
    ref=[act("reschedule", rows="$salma_leave, $kitty_collect", args=lines(to=U("week", 1, weekday=1)))]),
  T("left for friday now", rows("water_pump", "abba_meds"),
    ref=[ans(kind="task", when=W(U("week", 0, weekday=5)), where=LIVE)]))

S("T16-205", "bare weekday at n range create",
  T("what's on wednesday to friday this week", rows("victory_lunch", "line3_review", "tutor_meet", "kit_pickup", "nets_1218", "match_uttara", "team_dinner"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=3), U("week", 0, weekday=5))))]),
  T("move the tutor meeting to friday at 6", diff(upd("tutor_meet", date="2026-12-18T18:00")),
    ref=[act("reschedule", kind="event", name="Meet Tanvir's tutor", args=lines(to=U("week", 0, weekday=5, time="18:00")))]),
  T("abba's echo test monday at 9", diff(upd("echo_test", date="2026-12-21T09:00")),
    ref=[act("reschedule", kind="event", name="Abba's echo test", args=lines(to=U("week", 1, weekday=1, time="09:00")))]),
  T("call rehana apa saturday at 5", diff(new("event", name=has("Rehana"), date="2026-12-19T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Rehana apa", date=U("week", 0, weekday=6, time="17:00")))]))

S("T16-206", "two writes settle complete then complete reschedule",
  T("paid monir for the wiring and approved salma's leave",
    diff(upd("d_monir", status="settled"), upd("salma_leave", status="completed", completed=ANY)),
    ref=[search("Monir", kind="person"), act("settle_debt", kind="debt", linked_to="$monir", more=True), act("complete", rows="$salma_leave")]),
  T("sent the bkash to rehana apa, rice sack can wait till monday",
    diff(upd("bkash", status="completed", completed=ANY), upd("rice", date="2026-12-21")),
    ref=[act("complete", rows="$bkash", more=True), act("reschedule", rows="$rice", args=lines(to=U("week", 1, weekday=1)))]))
