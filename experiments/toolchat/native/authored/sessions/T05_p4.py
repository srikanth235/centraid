from gold import *
import json

world("T05", "2026-01-20T06:40", "Priya Raman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T05-201", "both followup log complete",
  T("which divyas do i know", rows("divya_s", "divya_k"),
    ref=[ans(kind="person", name="Divya")]),
  T("rang both just now", diff(upd("divya_s", date=ANY), upd("divya_k", date=ANY)),
    ref=[act("log", rows="@prev", args="kind: call")]),
  T("what's due tomorrow", rows("water_can", "projector", "reports"),
    ref=[ans(kind="task", when=W(U("day", 1)))]),
  T("sorted all three, tick them", diff(upd("water_can", status="completed", completed=ANY),
                                        upd("projector", status="completed", completed=ANY),
                                        upd("reports", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]))

S("T05-202", "ordinal last third weekend cancel reschedule",
  T("night shifts coming up", rows("night_0123", "night_0124", "night_0127", "night_0128", "night_0206", "night_0207"),
    ref=[ans(kind="event", name="night shift", when=W({"from": U("day", 0)}))]),
  T("cancel the last one, sowmya's swapping me", diff(upd("night_0207", status="cancelled")),
    ref=[act("cancel", rows="$night_0207")]),
  T("anything on this weekend", rows("tc_0124", "night_0124", "movie", "cric_0125"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]),
  T("third one's at 11 now", diff(upd("movie", date="2026-01-25T11:00")),
    ref=[act("reschedule", rows="$movie", args=lines(to=U("week", 0, weekday=7, time="11:00")))]))

S("T05-203", "owe direction balance settle_debt group-me",
  T("what do i owe ramesh mama", val((-2000, "INR")),
    ref=[search("Ramesh mama", kind="person"), ans(op="balance", rows="$ramesh_mama")]),
  T("and arjun?", val((1500, "INR")),
    ref=[ans(op="balance", kind="person", name="Arjun Menon")]),
  T("paid mama back for the train tickets", diff(upd("d_ramesh_mama", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$ramesh_mama", where="status = open")]),
  T("my side of the carpool?", val((740, "INR")),
    ref=[search("Priya Raman", kind="person"), ans(op="balance", kind="group", name="Night shift carpool", linked_to="$me")]))

S("T05-204", "except rest reschedule weekday read",
  T("home list stuff due this week", rows("water_can", "gas", "flowers_1", "eb_jan"),
    ref=[ans(kind="task", linked_to="$homelist", when=W(U("week", 0)))]),
  T("shove all of them to saturday except the eb bill",
    diff(upd("water_can", date="2026-01-24"), upd("gas", date="2026-01-24"), upd("flowers_1", date="2026-01-24")),
    ref=[find(within="@prev", exclude="$eb_jan"), act("reschedule", rows="@prev", args=lines(to=U("week", 0, weekday=6)))]),
  T("what's on the home list saturday", rows("water_can", "gas", "flowers_1"),
    ref=[ans(kind="task", linked_to="$homelist", when=W(U("week", 0, weekday=6)))]))

S("T05-205", "weekday at-N range reschedule create",
  T("what do i have monday to wednesday this week", rows("appraisal", "day_0120", "day_0121"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]),
  T("move the dentist to friday at 4", diff(upd("dentist_ev", date="2026-01-23T16:00")),
    ref=[act("reschedule", rows="$dentist_ev", args=lines(to=U("week", 0, weekday=5, time="16:00")))]),
  T("coffee with kavya, saturday at 5 instead", diff(upd("kavya_coffee", date="2026-01-24T17:00")),
    ref=[act("reschedule", rows="$kavya_coffee", args=lines(to=U("week", 0, weekday=6, time="17:00")))]),
  T("ring meena chithi friday at 5", diff(new("event", name=has("meena"), date="2026-01-23T17:00")),
    ref=[act("create", args=lines(kind="event", name="Ring Meena chithi", date=U("week", 0, weekday=5, time="17:00")))]))

S("T05-206", "two writes settle_debt complete log",
  T("paid jaya the canteen money and ordered the water cans",
    diff(upd("d_jaya", status="settled"), upd("water_can", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="canteen dinner", more=True),
         act("complete", rows="$water_can")]),
  T("what do i owe now", rows("d_divya_s", "d_ramesh_mama", "d_appa", "d_revathi"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("gave revathi the pooja money and rang appa", diff(upd("d_revathi", status="settled"), upd("appa", date=ANY)),
    ref=[search("Appa", kind="person"),
         act("settle_debt", kind="debt", name="pooja items", more=True),
         act("log", rows="$appa", args="kind: call")]))
