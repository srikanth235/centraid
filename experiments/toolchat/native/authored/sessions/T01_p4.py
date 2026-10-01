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

S("T01-202", "ordinal cancel last ask option log",
  T("what night shifts are left", rows("night_0319", "night_0320", "night_0416", "night_0417"),
    ref=[ans(kind="event", where='description = "Ward 7 night"', when=J({"from": U("day", 0)}))]),
  T("cancel the last one, kwame's got it", diff(upd("night_0417", status="cancelled")),
    ref=[act("cancel", rows="$night_0417")]),
  T("log a call with priya", ask("priya_n", "priya_s"),
    ref=[askc("Priya Nair or Priya Shah?", options="$priya_n, $priya_s")]),
  T("second one", diff(upd("priya_s", date=ANY)),
    ref=[act("log", rows="$priya_s", args="kind: call")]))

S("T01-203", "owe direction balance settle group-me",
  T("how much am i down to kwame", val((-17, "GBP")),
    ref=[ans(op="balance", rows="$kwame")]),
  T("and zainab", val((6, "GBP")),
    ref=[ans(op="balance", rows="$zainab")]),
  T("settle my taxi one with kwame", diff(upd("d_kwame_taxi", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$kwame", where="direction = i_owe and status = open")]),
  T("my side of house bills?", val((13, "GBP")),
    ref=[search("Oluwaseun", kind="person"), ans(op="balance", kind="group", name="House Bills", linked_to="$me")]))

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

S("T01-206", "two writes settle complete log settle",
  T("paid zainab the nail money and sorted priya's charger", diff(upd("d_zainab", status="settled"),
                                                                   upd("charger", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", linked_to="$zainab", where="status = open", more=True),
         act("complete", rows="$charger")]),
  T("what do i owe now", rows("d_kwame_taxi", "d_siobhan", "d_mum_uniform"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("rang mum and kunle paid me the cake money", diff(upd("mum", date=ANY), upd("d_kunle", status="settled")),
    ref=[search("Mum", kind="person"),
         act("log", rows="$mum", args="kind: call", more=True),
         act("settle_debt", kind="debt", linked_to="$kunle", where="status = open")]))
