from gold import *
import json

world("T11", "2026-07-26T07:30", "Siobhan Kelly", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# 201 "both" after a two-row result (the subtasks of one task)
S("T11-201", "both subtasks complete prev name school books",
  T("what's left under the school books one", rows("books_aoife", "books_cian"),
    ref=[find(kind="task", name="school books"), ans(kind="task", linked_to="@prev", where='status = "open"')]),
  T("ordered them online", diff(upd("books_aoife", status="completed", completed=ANY), upd("books_cian", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]),
  T("did roisin's get done", rows("books_roisin"),
    ref=[ans(kind="task", name="Roisin's books")]))

# 202 ordinals after a listing, and a number picked from an ask
S("T11-202", "ordinal third club list reschedule bare weekday ask pick star photo",
  T("club list?", rows("minutes_jul", "raffle", "pitch", "jerseys", "lotto_sell"),
    ref=[ans(kind="task", linked_to="$club_l")]),
  T("the third one, push it to friday", diff(upd("pitch", date="2026-07-31")),
    ref=[act("reschedule", rows="$pitch", args=lines(to=U("week", 1, weekday=5)))]),
  T("star the communion photo", ask("p_comm_family", "p_comm_cake"),
    ref=[act("star", kind="photo", name="communion"),
         askc("1 all of you at the communion or 2 the cake?", options="$p_comm_family, $p_comm_cake")]),
  T("2 is grand", diff(upd("p_comm_cake", starred=True)),
    ref=[act("star", rows="$p_comm_cake")]))

# 203 which way the money goes (mick owes me and i owe mick)
S("T11-203", "debts owe direction negative balance mick both ways settle mine settle",
  T("what do i owe sean mahon", val((-850, "EUR")),
    ref=[ans(op="balance", kind="person", name="Sean Mahon")]),
  T("and where am i with mick", val((145, "EUR")),
    ref=[ans(op="balance", kind="person", name="Mick Considine")]),
  T("settle mine with him, gave him the diesel money at mass", diff(upd("d_mick_diesel", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$mick", where='direction = "i_owe"')]),
  T("tadhg paid the jersey deposit, clear his", diff(upd("d_tadhg", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$tadhg")]))

# 204 everything but one, by its date
S("T11-204", "except exclude date ordinal u12 training cancel count",
  T("u12 training in august", rows("u12_0805", "u12_0812", "u12_0819", "u12_0826"),
    ref=[ans(kind="event", name="U12 hurling training", when=W(U("month", 0, name=8)))]),
  T("cancel them all except the twelfth", diff(upd("u12_0805", status="cancelled"), upd("u12_0819", status="cancelled"), upd("u12_0826", status="cancelled")),
    ref=[find(kind="event", within="@prev", exclude="$u12_0812"), act("cancel", rows="@prev")]),
  T("how many are left then", val(2),
    ref=[ans(op="count", kind="event", name="U12 hurling training", when=W({"from": U("day", 0)}), where='status != "cancelled"')]))

# 205 bare weekdays, "at N", a relative range (today is a Sunday)
S("T11-205", "bare weekday at N gp dentist range next week create friday night",
  T("move the gp to friday at 4", diff(upd("gp", date="2026-07-31T16:00")),
    ref=[search("gp", kind="event"),
         act("reschedule", kind="event", name="GP check-up", args=lines(to=U("week", 1, weekday=5, time="16:00")))]),
  T("and roisin's dentist to thursday at 5", diff(upd("dentist", date="2026-07-30T17:00")),
    ref=[act("reschedule", kind="event", name="Roisin's dentist", args=lines(to=U("week", 1, weekday=4, time="17:00")))]),
  T("anything booked from monday to wednesday of next week", rows("ai_call", "tb_test", "ortho", "u12_0729"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]),
  T("put date night with declan in for friday night at 7", diff(new("event", name=has("declan"), date="2026-07-31T19:00")),
    ref=[act("create", args=lines(kind="event", name="Date night with Declan", date=U("week", 1, weekday=5, time="19:00")))]))

# 206 two writes in one message
S("T11-206", "two writes settle debt complete star locker item",
  T("paid ger for the relief milking and i ordered the mineral buckets", diff(upd("d_ger", status="settled"), upd("minerals", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="Relief milking", more=True),
         act("complete", kind="task", name="Order mineral buckets")]),
  T("heifers are penned and star the gate codes", diff(upd("tb_pen", status="completed", completed=ANY), upd("gates", starred=True)),
    ref=[act("complete", kind="task", name="Pen the heifers", more=True),
         act("star", kind="locker item", name="Gate codes")]),
  T("what do i owe all told now", val((1267, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))
