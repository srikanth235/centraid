from gold import *
import json

world("T01", "2026-03-12T18:20", "Oluwaseun Adebayo-Clarke", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T01-C001", "c3c compound three writes create add_to star new",
  T("new doc Boiler service receipt, file it in house and star it",
    diff(new("document", name="Boiler service receipt", starred=True), link("house_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Boiler service receipt"), more=True),
         act("add_to", rows="$new", args=lines(to="$house_f"), more=True),
         act("star", rows="$new")]))

S("T01-C002", "c3c compound complete reschedule separate targets",
  T("tiles are ordered, tick that off, and push booking the skip to next monday",
    diff(upd("tiles", status="completed", completed=ANY), upd("skip", date="2026-03-16")),
    ref=[act("complete", kind="task", name="Order tiles", more=True),
         act("reschedule", kind="task", name="Book skip", args=lines(to=U("week", 1, weekday=1)))]))

S("T01-C003", "c3c compound cancel create task referential",
  T("cancel the kids dentist and add a task to rebook it friday week",
    diff(upd("dentist", status="cancelled"), new("task", name=has("rebook", "dentist"), date="2026-03-27")),
    ref=[act("cancel", kind="event", name="Kids dentist", more=True),
         act("create", args=lines(kind="task", name="Rebook kids dentist", date=U("week", 2, weekday=5)))]),
  T("when's it due", rows("+1"),
    ref=[ans(rows="$new")]))

S("T01-C004", "c3c compound settle_debt complete",
  T("callum paid me his half of the skip, and i've booked the skip as well",
    diff(upd("d_callum", status="settled"), upd("skip", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="his half of the skip", more=True),
         act("complete", kind="task", name="Book skip")]))

S("T01-C101", "c3c bulk delete per kind last november month find multi-kind",
  T('delete everything from last november', diff(trash("drug_calc"), trash("ghic"), trash("p_engagement"), unlink("chi_album", "p_engagement"), trash("p_ring"), unlink("chi_album", "p_ring"), trash("p_girls"), unlink("chi_album", "p_girls"), trash("p_bday_cake"), unlink("kids_album", "p_bday_cake")),
    ref=[find(kind="event,task,note,document,photo", when=W(U("month", -1, name=11))),
         act("delete", rows="$drug_calc", more=True),
         act("delete", rows="$ghic", more=True),
         act("delete", rows="$p_engagement, $p_ring, $p_girls, $p_bday_cake")]))

S("T01-C901", "c3c cell7 empty recovery wrong kind then span",
  T("where's my passport", rows("passport"),
    ref=[find(kind="document", name="passport"), ans(kind="locker item", name="Passport")]),
  T('docs added from the 1st at 9am to the 10th', rows("farm_letter"),
    ref=[ans(kind="document", when=W(span(D("2026-03-01", "09:00"), D("2026-03-10"))))]))

S("T01-C902", "c3c cell7 rejected edit date then delete empty folder",
  T('put the skip booking on tuesday', diff(upd("skip", date="2026-03-17")),
    ref=[bad(act("edit", kind="task", name="Book skip", args=lines(date="tuesday"))), act("reschedule", kind="task", name="Book skip", args=lines(to=U("week", 1, weekday=2)))]),
  T('can you delete the car folder too', diff(gone("car_f")),
    ref=[act("delete", kind="folder", name="Car")]))
