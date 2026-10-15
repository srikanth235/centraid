from gold import *

world("T02", "2027-06-08T11:05", "Mei-Lin Chau", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T02-A001", "ask-options event reschedule c3a",
  T("can we move the flight to 9am", ask("flight_out", "flight_back"),
    ref=[act("reschedule", kind="event", name="flight", args=lines(to=U("day", 0, anchor="row", time="09:00"))),
         askc("The flight out to Tokyo on the 14th or the one back on the 28th?", options="$flight_out, $flight_back")]),
  T("the one back", diff(upd("flight_back", date="2027-07-28T09:00")),
    ref=[act("reschedule", rows="$flight_back", args=lines(to=U("day", 0, anchor="row", time="09:00")))]))

S("T02-A002", "ask-options task complete c3a",
  T("mark the invoice as done, it's sent", ask("inv_mf", "inv_gl_final", "inv_tide_cover"),
    ref=[act("complete", kind="task", name="invoice"),
         askc("Maple & Fern 0412, Greenleaf final or Tidewater cover?", options="$inv_mf, $inv_gl_final, $inv_tide_cover")]),
  T("greenleaf", diff(upd("inv_gl_final", status="completed", completed=ANY)),
    ref=[act("complete", rows="$inv_gl_final")]))

S("T02-A004", "ask-options document delete never_mind c3a",
  T("get rid of the insurance doc", ask("ins_policy", "tenant_doc"),
    ref=[act("delete", kind="document", name="insurance"),
         askc("The travel insurance quote or the tenant insurance policy?", options="$ins_policy, $tenant_doc")]),
  T("hm no, i might need both. leave them", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T02-A101", "ask-options locker_item star c3a",
  T("mark the licence as a favourite", ask("procreate", "clipstudio", "licence"),
    ref=[act("star", kind="locker item", name="licence"),
         askc("Procreate licence, Clip Studio licence or your driver's licence?", options="$procreate, $clipstudio, $licence")]))

S("T02-A006", "follow-up c3a",
  T("what's still open on the client work list", rows("inv_gl_final", "gst_q2", "inv_tide_cover", "tide_final", "tomo_logo", "inv_mf"),
    ref=[ans(kind="task", linked_to="$clientwork", where="status = open")]),
  T("any that'll take longer than an hour each", rows("tide_final", "tomo_logo"),
    ref=[ans(within="@prev", where="effort > 60")]),
  T("and everything else", rows("inv_gl_final", "inv_tide_cover", "inv_mf", "gst_q2"),
    ref=[ans(within="@1", exclude="@2")]))

S("T02-A007", "follow-up c3a",
  T("what's in the taxes folder", rows("gst_letter", "receipts", "t2125", "noa"),
    ref=[ans(kind="document", linked_to="$taxes")]),
  T("any of them from 2026", rows("noa", "receipts", "t2125"),
    ref=[ans(within="@prev", name="2026")]),
  T("star the first two", diff(upd("receipts", starred=True), upd("t2125", starred=True)),
    ref=[act("star", rows="$receipts, $t2125")]))

S("T02-A009", "follow-up c3a",
  T("what's in the pottery album", rows("test_tiles", "yuki_demo", "vase", "first_bowl", "celadon_mug", "kiln_open"),
    ref=[ans(kind="photo", linked_to="$pottery_album")]),
  T("which of those are starred", rows("celadon_mug"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("star the rest", diff(upd("first_bowl", starred=True), upd("kiln_open", starred=True), upd("test_tiles", starred=True), upd("yuki_demo", starred=True), upd("vase", starred=True)),
    ref=[find(kind="photo", within="@1", exclude="@2"), act("star", rows="@prev")]))
