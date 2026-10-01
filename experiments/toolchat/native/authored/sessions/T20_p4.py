from gold import *
import json

world("T20", "2026-05-28T16:10", "Matteo Ricci", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
LEFT = 'status = "open"'

S("T20-201", "both add_to folder scans both star lorenzos",
  T("scans from yesterday", rows("scan_1", "scan_2"),
    ref=[ans(kind="document", name="Scan", when=W(U("day", -1)))]),
  T("put both in the flat papers folder", diff(link("casa_f", "scan_1"), link("casa_f", "scan_2")),
    ref=[act("add_to", rows="@prev", args=lines(to="$casa_f"))]),
  T("who's lorenzo", rows("lorenzo_r", "lorenzo_g"),
    ref=[ans(kind="person", name="Lorenzo")]),
  T("star both", diff(upd("lorenzo_r", starred=True), upd("lorenzo_g", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T20-202", "ordinal third complete relist fourth reschedule move list",
  T("what's left on the move list",
    rows("boxes", "utilities", "pack_wine", "cleaners", "address", "deposit_back"),
    ref=[ans(kind="task", linked_to="$move_l", where=LEFT)]),
  T("the third one's done, packed the wine last night", diff(upd("pack_wine", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pack_wine")]),
  T("and what's left now", rows("boxes", "utilities", "cleaners", "address", "deposit_back"),
    ref=[ans(kind="task", linked_to="$move_l", where=LEFT)]),
  T("do the fourth one monday", diff(upd("address", date="2026-06-01")),
    ref=[act("reschedule", rows="$address", args=lines(to=U("week", 1, weekday=1)))]))

S("T20-203", "owe direction positive balance negative balance settle mine sum",
  T("what does stefano owe me", val((100, "EUR")),
    ref=[ans(op="balance", rows="$stefano")]),
  T("and my side with gianni", val((-150, "EUR")),
    ref=[ans(op="balance", rows="$gianni")]),
  T("settle mine with him, paid on the spot", diff(upd("d_gianni", status="settled")),
    ref=[act("settle_debt", kind="debt", where=IOWE, linked_to="$gianni")]),
  T("what do i owe now", val((345, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]))

S("T20-204", "except cancel wine briefings then move the remaining one",
  T("wine briefings in june", rows("brief_0602", "brief_0609", "brief_0616", "brief_0623", "brief_0630"),
    ref=[ans(kind="event", name="Staff wine briefing", when=W(U("month", 0, name=6)))]),
  T("cancel them all except the sixteenth, carla's away the rest of the month",
    diff(upd("brief_0602", status="cancelled"), upd("brief_0609", status="cancelled"),
         upd("brief_0623", status="cancelled"), upd("brief_0630", status="cancelled")),
    ref=[find(within="@prev", exclude="$brief_0616"), act("cancel", rows="@prev")]),
  T("which are still on", rows("brief_0616"),
    ref=[ans(kind="event", name="Staff wine briefing", when=W(U("month", 0, name=6)), where='status != "cancelled"')]),
  T("push that one to 4", diff(upd("brief_0616", date="2026-06-16T16:00")),
    ref=[act("reschedule", rows="$brief_0616", args=lines(to=U("day", 0, anchor="row", time="16:00")))]))

S("T20-205", "bare weekday at n reschedule create relative range",
  T("move the bike service to monday", diff(upd("bike_service", date="2026-06-01T10:00")),
    ref=[act("reschedule", kind="event", name="Bike service at the club", args=lines(to=U("week", 1, weekday=1)))]),
  T("move the ettore call to 5", diff(upd("photographer_call", date="2026-05-29T17:00")),
    ref=[act("reschedule", kind="event", name="Call with Ettore", args=lines(to=U("day", 0, anchor="row", time="17:00")))]),
  T("dinner with giulia saturday at 8", diff(new("event", name=has("Giulia"), date="2026-05-30T20:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Giulia", date=U("week", 0, weekday=6, time="20:00")))]),
  T("check my calendar monday to wednesday of next week", rows("bike_service", "keys_pickup", "brief_0602", "fede_visit", "electrician_visit"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]))

S("T20-206", "two writes settle debt complete task both directions",
  T("paid fede for the chianti and ticked off the dry cleaning",
    diff(upd("d_fede", status="settled"), upd("dry_clean", status="completed", completed=ANY)),
    ref=[find(kind="debt", name="chianti"),
         act("settle_debt", kind="debt", name="Six bottles of Chianti", more=True),
         act("complete", kind="task", name="Pick up dry cleaning")]),
  T("davide sent the taxi money and i paid the car tax",
    diff(upd("d_davide", status="settled"), upd("car_tax", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="Taxi after the staff dinner", more=True),
         act("complete", kind="task", name="Pay the car tax")]),
  T("what do i owe now", rows("d_andrea", "d_chiara", "d_gianni"),
    ref=[ans(kind="debt", where=IOWE)]))
