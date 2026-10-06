from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T04-Q001", "instead-weekday reschedule time-only i2pat",
  T("dress fitting with zainab at 3 instead on saturday", diff(upd("fitting_1", date="2026-10-17T15:00")),
    ref=[act("reschedule", kind="event", linked_to="$zainab", when=J(U("week", 0, weekday=6)),
             args=lines(to=U("day", 0, anchor="row", time="15:00")))]))

S("T04-Q002", "birthday noun name across kinds i2pat",
  T("what's on for imran's birthday", rows("imran_bday", "imran_gift"),
    ref=[ans(kind="event,task", name="birthday")]))

S("T04-Q003", "single-day list evening within-prev i2pat",
  T("what've i got on tomorrow", rows("rota_meet", "dark_1015"),
    ref=[ans(kind="event", when=J(U("day", 1)))]),
  T("just the evening", rows("dark_1015"),
    ref=[ans(within="@prev", when=J({"from": U("day", 1, time="18:00")}))]))

S("T04-Q004", "documents not-from exclude find i2pat",
  T("what documents have i saved since the start of august",
    rows("caterer_quote", "guest_sheet", "invite_proof", "rota_doc", "audit_doc", "tenancy", "payslip"),
    ref=[ans(kind="document", when=J({"from": D("2026-08-01")}))]),
  T("just the ones not from the wedding folder", rows("rota_doc", "audit_doc", "tenancy", "payslip"),
    ref=[find(kind="document", linked_to="$wed_f"), ans(within="@1", exclude="@prev")]))

S("T04-Q005", "the one with field value read i2pat",
  T("the one with username arahman", rows("horus"),
    ref=[ans(kind="locker item", where='username = "arahman"')]))

S("T04-Q006", "debts settled status-only i2pat",
  T("which ious have been settled", rows("d_imran", "d_ellie", "d_owen"),
    ref=[ans(kind="debt", where="status = settled")]))

S("T04-Q007", "fresh date drops link filter i2pat",
  T("what've i got with zainab on saturday", rows("fitting_1"),
    ref=[ans(kind="event", linked_to="$zainab", when=J(U("week", 0, weekday=6)))]),
  T("and what's on the 24th", rows("fb_1024", "cake", "yoga_1024"),
    ref=[ans(kind="event", when=J(D("2026-10-24")))]))

S("T04-Q008", "bare noun across kinds ask no inherit i2pat",
  T("what's open on the house list", rows("rent_nov", "boiler", "wul_1", "bins"),
    ref=[ans(kind="task", linked_to="$houselist", where="status = open")]),
  T("boiler", ask("boiler", "d_tom"),
    ref=[askc("The boiler email task or the boiler callout debt?", options="$boiler, $d_tom")]))

S("T04-Q009", "possessive role fiance i2pat",
  T("who's zainab's fiance", rows("hamza"),
    ref=[ans(kind="person", where='role = "Zainab\'s fiance"')]))

S("T04-Q010", "remove two named rows from list i2pat",
  T("take the two mehndi tasks off the wedding prep list",
    diff(unlink("wedlist", "mehndi_outfit"), unlink("wedlist", "playlist")),
    ref=[find(kind="task", name="mehndi", linked_to="$wedlist"), act("remove_from", rows="@prev", args="from: $wedlist")]))

S("T04-Q011", "second clause whos left open owes_me i2pat",
  T("chloe's paid me for the takeaway, so who's left",
    rows("d_zainab", "d_leah", "d_fatima_k", "d_aoife", "d_sana", also=diff(upd("d_chloe", status="settled"))),
    ref=[act("settle_debt", kind="debt", linked_to="$chloe", where="status = open", more=True),
         ans(kind="debt", where="direction = owes_me and status = open")]))

S("T04-Q012", "generic group word ask candidates i2pat",
  T("add ravi to the house group", ask("house", "house_party"),
    ref=[askc("House bills or House party?", options="$house, $house_party")]))

S("T04-Q013", "add_to destination missing ask create i2pat",
  T("put the sepsis six note in my cardiology notebook", ask(),
    ref=[askc("You don't have a cardiology notebook. Create it?")]))

S("T04-Q014", "outside world book decline i2pat",
  T("can you call mahmood catering and ask about halal options", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T04-Q015", "world knowledge out_of_scope i2pat",
  T("what's the best time of day to visit the grand bazaar", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T04-Q016", "how-many-had so far upper bound i2pat",
  T("how many food bank shifts have i had so far", val(3),
    ref=[ans(op="count", kind="event", name="food bank shift", where="status != cancelled", when=J({"to": U("day", 0)}))]))

S("T04-Q017", "nth and mth of month same month past i2pat",
  T("what was on the 3rd and the 10th of october", rows("fb_1003", "fb_1010", "yoga_1010"),
    ref=[find(kind="event", when=J(D("2026-10-03"))), find(kind="event", when=J(D("2026-10-10"))), ans(rows="@1, @2")]))

S("T04-Q018", "offset from another row date absolute i2pat",
  T("add post the invites to my tasks a week before the cake tasting",
    diff(new("task", name=has("invites"), date="2026-10-17")),
    ref=[act("create", args=lines(kind="task", name="Post the invites", date=D("2026-10-17")))]))

S("T04-Q019", "list word zero lists notes docs i2pat",
  T("pull up the guest list", rows("guest_list", "guest_sheet"),
    ref=[ans(kind="note,document", name="guest list")]))

S("T04-Q020", "document by name with month no verb i2pat",
  T("my payslip from september", rows("payslip"),
    ref=[ans(kind="document", name="payslip")]))

S("T04-Q021", "cadence monthly or less often i2pat",
  T("who do i only catch up with monthly or less often", rows("nasreen", "fatima_k", "aoife"),
    ref=[ans(kind="person", where="cadence >= 30 days")]))

S("T04-Q022", "cadence three weeks or rarer i2pat",
  T("anyone i see every three weeks or less often", rows("nasreen", "fatima_k", "sana", "leah", "aoife"),
    ref=[ans(kind="person", where="cadence >= 21 days")]))

S("T04-Q023", "my short word file move not role i2pat",
  T("move my payslip into the work folder", diff(link("work_f", "payslip")),
    ref=[act("add_to", kind="document", name="payslip", args="to: $work_f")]))

S("T04-Q024", "when do we leave flight event i2pat",
  T("when do we leave for istanbul", rows("flight_out"),
    ref=[ans(kind="event", name="flight", when=J({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T04-Q025", "which most within prev order desc i2pat",
  T("what's left on the wedding prep list", rows("speech", "favours", "caterer_nums", "rsvps", "mehndi_outfit", "playlist", "seating"),
    ref=[ans(kind="task", linked_to="$wedlist", where="status = open")]),
  T("which one takes the most time", rows("speech"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]))
