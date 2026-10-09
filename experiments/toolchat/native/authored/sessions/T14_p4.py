from gold import *
import json

world("T14", "2026-10-24T19:30", "Tomás Ferreira", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


LIVE = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T14-201", "both pharmacy notes pin prev count",
  T("pharmacy lists", rows("pharm_1", "pharm_2"),
    ref=[find(kind="note", name="Pharmacy list"), ans(rows="@prev")]),
  T("pin both", diff(upd("pharm_1", pinned=True), upd("pharm_2", pinned=True)),
    ref=[act("edit", rows="@1", args=lines(pinned="yes"))]),
  T("how many notes are pinned now", val(6),
    ref=[ans(op="count", kind="note", where="pinned = yes")]))

S("T14-202", "ordinal dj list complete reschedule",
  T("what's left on the dj list", rows("usb", "setlist12", "headphones", "inv_kleber_nov", "flyer_art", "bsas_setlist", order=True),
    ref=[find(kind="task", linked_to="$dj_l", where=LIVE, order="date asc"), ans(rows="@prev")]),
  T("third one to monday", diff(upd("headphones", date="2026-10-26")),
    ref=[act("reschedule", rows="$headphones", args=lines(to=U("week", 1, weekday=1)))]),
  T("and tick the first one, it's backed up", diff(upd("usb", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", within="@2", order="date asc", limit=1)]))

S("T14-204", "except debts settle rest value",
  T("who owes me money", rows("d_rafa_s", "d_guga", "d_diego", "d_thiago", "d_kleber", "d_bianca"),
    ref=[find(kind="debt", where=OWED), ans(rows="@prev")]),
  T("mark all of them paid except kleber's, he's still late",
    diff(upd("d_rafa_s", status="settled"), upd("d_guga", status="settled"), upd("d_diego", status="settled"),
         upd("d_thiago", status="settled"), upd("d_bianca", status="settled")),
    ref=[act("settle_debt", rows="$d_rafa_s, $d_guga, $d_diego, $d_thiago, $d_bianca")]),
  T("what's his debt to me come to", val((600, "BRL")),
    ref=[ans(op="balance", kind="person", name="Kleber Moura")]))

S("T14-205", "bare weekday at n range create",
  T("move the accountant to monday at 4", diff(upd("accountant", date="2026-10-26T16:00")),
    ref=[act("reschedule", kind="event", name="Meeting with the accountant", args=lines(to=U("week", 1, weekday=1, time="16:00")))]),
  T("landlord visit to friday at 9 instead", diff(upd("landlord", date="2026-10-30T09:00")),
    ref=[act("reschedule", kind="event", name="Landlord visit", args=lines(to=U("week", 1, weekday=5, time="09:00")))]),
  T("what did i have monday to wednesday this week", rows("hand_1019", "movie", "otavio_coffee", "reh_1021"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]),
  T("call mom sunday at 5", diff(new("event", name=has("Mom"), date="2026-10-25T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Mom", date=U("week", 0, weekday=7, time="17:00")))]))

S("T14-206", "two writes complete reschedule then complete cancel",
  T("paid juninho for the tyres, dashcam can wait till monday",
    diff(upd("tyre_pay", status="completed", completed=ANY), upd("dashcam", date="2026-10-26")),
    ref=[act("complete", kind="task", name="Pay Juninho for the tyres", more=True),
         act("reschedule", rows="$dashcam", args=lines(to=U("week", 1, weekday=1)))]),
  T("sent otavio his receipts and cancel the airport run, he got a lift",
    diff(upd("otavio_receipt", status="completed", completed=ANY), upd("airport_otavio", status="cancelled")),
    ref=[act("complete", rows="$otavio_receipt", more=True), act("cancel", rows="$airport_otavio")]))
