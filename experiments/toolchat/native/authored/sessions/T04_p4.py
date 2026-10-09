from gold import *
import json

world("T04", "2026-10-14T19:40", "Aisha Rahman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T04-201", "both followup star reschedule anchor-row",
  T("which fatimas", rows("fatima_k", "fatima_h"),
    ref=[ans(kind="person", name="Fatima")]),
  T("star both", diff(upd("fatima_k", starred=True), upd("fatima_h", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("wedding planning calls coming up", rows("wcall_1022", "wcall_1104"),
    ref=[ans(kind="event", name="wedding planning call", when=W({"from": U("day", 0)}))]),
  T("both an hour later", diff(upd("wcall_1022", date="2026-10-22T20:00"), upd("wcall_1104", date="2026-11-04T20:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("hour", 1, anchor="row")))]))

S("T04-202", "ordinal date-pick ask-option third cancel reschedule",
  T("food bank shifts left this month", rows("fb_1017", "fb_1024", "fb_1031"),
    ref=[ans(kind="event", name="food bank shift", when=W({"from": U("day", 0), "to": U("month", 0)}))]),
  T("cancel the twenty-fourth one, i'm away", diff(upd("fb_1024", status="cancelled")),
    ref=[act("cancel", rows="$fb_1024")]),
  T("push darkroom night back an hour", ask("dark_1015", "dark_1029", "dark_1112"),
    ref=[find(kind="event", name="darkroom night", when=W({"from": U("day", 0)})),
         askc("The 15th, the 29th or 12 November?", options="@prev")]),
  T("3 is fine", diff(upd("dark_1112", date="2026-11-12T19:30")),
    ref=[act("reschedule", rows="$dark_1112", args=lines(to=U("hour", 1, anchor="row")))]))


S("T04-203", "owe direction group-me balance settle_debt sum",
  T("my side of the istanbul hen do?", val((16200, "TRY")),
    ref=[search("Aisha", kind="person"), ans(op="balance", kind="group", name="Istanbul hen do", linked_to="$me")]),
  T("what do i owe james", val((-15.5, "GBP")),
    ref=[ans(op="balance", kind="person", name="James O'Connor")]),
  T("paid him back for the vending machine dinner", diff(upd("d_james", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$james", where="status = open")]),
  T("and what do they owe me in total", val((306.3, "GBP")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open")]))

S("T04-204", "except rest tomorrow complete read",
  T("what's due tomorrow", rows("boiler", "develop", "bins"),
    ref=[ans(kind="task", when=W(U("day", 1)))]),
  T("all done bar the whitby rolls", diff(upd("boiler", status="completed", completed=ANY),
                                          upd("bins", status="completed", completed=ANY)),
    ref=[find(within="@prev", exclude="$develop"), act("complete", rows="@prev")]),
  T("what's still open for tomorrow", rows("develop"),
    ref=[ans(kind="task", where="status = open", when=W(U("day", 1)))]))

S("T04-205", "weekday at-N range reschedule create",
  T("what was on monday to wednesday this week", rows("ld_1012", "ld_1013", "leah_dinner"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]),
  T("dinner with leah, make it saturday at 8", diff(upd("leah_dinner", date="2026-10-17T20:00")),
    ref=[act("reschedule", rows="$leah_dinner", args=lines(to=U("week", 0, weekday=6, time="20:00")))]),
  T("dentist, make it 4pm on monday", diff(upd("dentist", date="2026-10-19T16:00")),
    ref=[act("reschedule", rows="$dentist", args=lines(to=U("week", 1, weekday=1, time="16:00")))]),
  T("call auntie nasreen thursday at 5", diff(new("event", name=has("nasreen"), date="2026-10-15T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call Auntie Nasreen", date=U("week", 0, weekday=4, time="17:00")))]))

S("T04-206", "two writes settle_debt complete log",
  T("paid fatima h for the decorations and sent pete my november availability",
    diff(upd("d_fatima_h", status="settled"), upd("fb_rota", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="decorations", more=True),
         act("complete", rows="$fb_rota")]),
  T("what do i owe now", rows("d_tom", "d_james", "d_dad"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("rang ammi and paid abbu back the car deposit", diff(upd("mum", date=ANY), upd("d_dad", status="settled")),
    ref=[search("Ammi", kind="person"),
         act("log", rows="$mum", args="kind: call", more=True),
         act("settle_debt", kind="debt", name="car deposit")]))
