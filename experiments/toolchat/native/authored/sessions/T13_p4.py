from gold import *
import json

world("T13", "2026-09-03T22:10", "Amara Nwosu", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T13-201", "both xrd sessions reschedule prev linked",
  T("xrd sessions coming up", rows("xrd_0908", "xrd_0915"),
    ref=[find(kind="event", name="XRD session", when=W({"from": U("day", 0)})), ans(rows="@prev")]),
  T("push both to 3", diff(upd("xrd_0908", date="2026-09-08T15:00"), upd("xrd_0915", date="2026-09-15T15:00")),
    ref=[act("reschedule", rows="@1", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("who's coming to them", rows("raj"),
    ref=[ans(kind="person", linked_to="$xrd_0908, $xrd_0915")]))

S("T13-202", "ordinal house list reschedule complete",
  T("what's still open on the house list", rows("loo_roll", "rota", "bins", "broadband", "rent_10", order=True),
    ref=[find(kind="task", linked_to="$house_l", where='status = "open"', order="date asc"), ans(rows="@prev")]),
  T("push the second one to monday", diff(upd("rota", date="2026-09-07")),
    ref=[act("reschedule", rows="$rota", args=lines(to=U("week", 1, weekday=1)))]),
  T("tick the first one, got it at aldi", diff(upd("loo_roll", status="completed", completed=ANY)),
    ref=[act("complete", rows="$loo_roll")]))

S("T13-203", "owe direction balance settle debt both signs",
  T("do i owe emeka", val((-20, "GBP")),
    ref=[ans(op="balance", kind="person", name="Emeka Obi")]),
  T("and what does tj owe me", val((22, "GBP")),
    ref=[search("TJ", kind="person"), ans(op="balance", rows="$tunde")]),
  T("settle mine with emeka", diff(upd("d_emeka", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$emeka")]))

S("T13-204", "except weekend tasks reschedule rest",
  T("what's due this weekend", rows("abstract", "send_mum", "garri", "bins", "rota"),
    ref=[find(kind="task", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))), where='status = "open"'), ans(rows="@prev")]),
  T("push all of them to monday except the mum one",
    diff(upd("abstract", date="2026-09-07"), upd("garri", date="2026-09-07"),
         upd("bins", date="2026-09-07T20:00"), upd("rota", date="2026-09-07")),
    ref=[act("reschedule", rows="$abstract, $garri, $bins, $rota", args=lines(to=U("week", 1, weekday=1)))]),
  T("the rest can wait till tuesday", diff(upd("send_mum", date="2026-09-08")),
    ref=[act("reschedule", kind="task", name="mum", args=lines(to=U("week", 1, weekday=2)))]))

S("T13-205", "bare weekday at n range create",
  T("landlord inspection to friday at 5", diff(upd("landlord", date="2026-09-04T17:00")),
    ref=[act("reschedule", kind="event", name="Landlord inspection", args=lines(to=U("week", 0, weekday=5, time="17:00")))]),
  T("what was on monday to wednesday this week", rows("group_0831", "gp"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]),
  T("coffee with seun, monday at 4", diff(upd("seun_coffee", date="2026-09-07T16:00")),
    ref=[act("reschedule", kind="event", name="Coffee with Seun", args=lines(to=U("week", 1, weekday=1, time="16:00")))]),
  T("call aunty ngozi saturday at 5", diff(new("event", name=has("Aunty Ngozi"), date="2026-09-05T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Aunty Ngozi", date=U("week", 0, weekday=6, time="17:00")))]))

S("T13-206", "two writes settle debt complete then complete reschedule",
  T("paid priya for the cinema and printed the flyers", diff(upd("d_priya", status="settled"), upd("print_flyers", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", linked_to="$priya", more=True), act("complete", kind="task", name="Print 200 flyers")]),
  T("sent mum the money, glovebox clean can go to tuesday", diff(upd("send_mum", status="completed", completed=ANY), upd("glovebox", date="2026-09-08")),
    ref=[act("complete", rows="$send_mum", more=True), act("reschedule", rows="$glovebox", args=lines(to=U("week", 1, weekday=2)))]))
