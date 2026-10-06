from gold import *
import json

world("T02", "2027-06-08T11:05", "Mei-Lin Chau", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T02-201", "both all-three followup reschedule unstar",
  T("which invoices haven't gone out yet", rows("inv_mf", "inv_tide_cover", "inv_gl_final"),
    ref=[ans(kind="task", name="invoice", where="status = open")]),
  T("push all three to next friday", diff(upd("inv_mf", date="2027-06-18"), upd("inv_tide_cover", date="2027-06-18"),
                                          upd("inv_gl_final", date="2027-06-18")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=5)))]),
  T("starred docs", rows("portfolio_pdf", "gl_contract", "itinerary"),
    ref=[ans(kind="document", where="starred = yes")]),
  T("unstar them all", diff(upd("portfolio_pdf", starred=False), upd("gl_contract", starred=False),
                            upd("itinerary", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T02-203", "owe direction balance settle_debt sum",
  T("what do i owe diego", val((-11.5, "CAD")),
    ref=[ans(op="balance", kind="person", name="Diego Ramirez")]),
  T("and kai?", val((217.5, "CAD")),
    ref=[ans(op="balance", kind="person", name="Kai Chau")]),
  T("sent mom the phone money", diff(upd("d_mom_phone", status="settled")),
    ref=[search("mom", kind="person"), act("settle_debt", kind="debt", linked_to="$mom", where="direction = i_owe and status = open")]),
  T("what do they owe me all in", val((1375, "CAD")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open")]))

S("T02-204", "except rest pottery cancel count",
  T("pottery classes left in june", rows("pottery_0610", "pottery_0617", "pottery_0624"),
    ref=[ans(kind="event", name="pottery class", when=W({"from": U("day", 0), "to": D("2027-06-30")}))]),
  T("cancel all of them except the 17th, going away", diff(upd("pottery_0610", status="cancelled"), upd("pottery_0624", status="cancelled")),
    ref=[find(within="@prev", exclude="$pottery_0617"), act("cancel", rows="@prev")]),
  T("so how many classes do i still have", val(2),
    ref=[ans(op="count", kind="event", name="pottery class", where="status != cancelled", when=W({"from": U("day", 0)}))]))

S("T02-205", "weekday at-N range reschedule create",
  T("what did i have monday to wednesday this week", rows("climb_0607", "call_marcus"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]),
  T("push the tomo logo thing to thursday", diff(upd("tomo_logo", date="2027-06-10")),
    ref=[act("reschedule", rows="$tomo_logo", args=lines(to=U("week", 0, weekday=4)))]),
  T("marcus call, make it thursday at 4", diff(upd("call_marcus", date="2027-06-10T16:00")),
    ref=[act("reschedule", rows="$call_marcus", args=lines(to=U("week", 0, weekday=4, time="16:00")))]),
  T("drinks with mina friday at 6", diff(new("event", name=has("drinks", "mina"), date="2027-06-11T18:00")),
    ref=[act("create", args=lines(kind="event", name="Drinks with Mina", date=U("week", 0, weekday=5, time="18:00")))]))

S("T02-206", "two writes settle_debt complete log",
  T("paid priya for the sushi and ordered the celadon glaze",
    diff(upd("d_priya_sushi", status="settled"), upd("glaze_order", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", linked_to="$priya", where="status = open", more=True),
         act("complete", rows="$glaze_order")]),
  T("what do i owe now", rows("d_arun_tix", "d_diego_chalk", "d_mom_phone"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("called mama and gave diego the chalk money", diff(upd("mom", date=ANY), upd("d_diego_chalk", status="settled")),
    ref=[search("Mama", kind="person"),
         act("log", rows="$mom", args="kind: call", more=True),
         act("settle_debt", kind="debt", linked_to="$diego", where="status = open")]))
