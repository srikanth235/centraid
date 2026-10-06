from gold import *
import json

world("T32", "2026-10-28T16:10", "Rosa Delgado-Ortiz", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T32-001", "empty follow-up within complete write-then-read bakery-list",
  T("anything left on the bakery list today", rows(),
    ref=[ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("day", 0)))]),
  T("tomorrow then", rows("mu_orange", "mu_boxes", "yeast"),
    ref=[ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("day", 1)))]),
  T("only half hour or less", rows("mu_orange", "yeast"),
    ref=[ans(within="@prev", where="effort <= 30")]),
  T("got both of them, tick them off and tell me what's left on the bakery list tomorrow",
    rows("mu_boxes", also=diff(upd("mu_orange", status="completed", completed=ANY),
                                upd("yeast", status="completed", completed=ANY))),
    ref=[act("complete", rows="@prev", more=True),
         ans(kind="task", linked_to="$bakery_l", where="status = open", when=W(U("day", 1)))]))

S("T32-002", "ambiguous-person within balance pronoun group-narrow",
  T("last time i spoke to maria?", rows("maria_o", "marilu", "marichuy"),
    ref=[ans(kind="person", name="Maria")]),
  T("the sister one", rows("maria_o"),
    ref=[ans(within="@prev", where='role = "sister"')]),
  T("where am i with her", val((-2477.5, "MXN")),
    ref=[ans(op="balance", rows="$maria_o")]),
  T("just the familia group", val((1237.5, "MXN")),
    ref=[ans(op="balance", kind="group", name="Familia Delgado Ortiz", linked_to="$maria_o")]))

S("T32-003", "choir chain relation within",
  T("who are the sopranos in the choir", rows("marilu", "lupita", "xochitl"),
    ref=[ans(kind="person", linked_to="$coro", where='role contains "soprano"')]),
  T("which of them sang at the mass for the dead", rows("marilu", "lupita"),
    ref=[ans(within="@prev", linked_to="$mass_muertos")]),
  T("and in the christmas concert", rows("marilu", "lupita"),
    ref=[ans(within="@prev", linked_to="$concert")]))

S("T32-004", "cancel ambiguous ask pick undo-not-undone",
  T("can you cancel the posada", ask("posada_bakery", "posada_street"),
    ref=[act("cancel", kind="event", name="Posada")]),
  T("the bakery one", diff(upd("posada_bakery", status="cancelled")),
    ref=[act("cancel", rows="$posada_bakery")]),
  T("wait undo that, we're still doing it", diff(),
    ref=[act("undo")]))

S("T32-005", "balance debt settle_debt complete two-writes sum",
  T("how much do i owe don teodoro", val((-10000, "MXN")),
    ref=[ans(op="balance", rows="$teodoro")]),
  T("which debts to him are still open", rows("d_teodoro"),
    ref=[ans(kind="debt", linked_to="$teodoro", where="status = open")]),
  T("teodoro has his money, settle the debt and tick the payment", diff(upd("d_teodoro", status="settled"),
                                                             upd("flour_oct", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", linked_to="$teodoro", where="status = open", more=True),
         act("complete", kind="task", name="Pay Don Teodoro for flour")]),
  T("what do i owe everyone in total", val((6826, "MXN")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open")]))

S("T32-006", "span status within linked",
  T("what's on between friday and tuesday that isn't cancelled",
    rows("dani_arrives", "stall_oct31", "stall_nov01", "cemetery", "calldani_1101", "stall_nov02", "mass_muertos",
         "dani_leaves", "van_service"),
    ref=[ans(kind="event", where="status != cancelled", when=W(span(U("week", 0, weekday=5), U("week", 1, weekday=2))))]),
  T("which of those have dani in them", rows("dani_arrives", "calldani_1101", "dani_leaves"),
    ref=[ans(within="@prev", linked_to="$dani")]),
  T("which starred people are going to the cemetery", rows("emi", "carmen"),
    ref=[ans(kind="person", linked_to="$cemetery", where="starred = yes")]))

S("T32-007", "locker read reveal egress",
  T("shop wifi pw?", rows("bakery_wifi"),
    ref=[ans(kind="locker item", name="Bakery wifi")]),
  T("show me it", diff(reveal=[("bakery_wifi", "LaEspiga1998")]),
    ref=[act("reveal", rows="$bakery_wifi", args="field: password")]),
  T("can you text it to her", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T32-008", "debts name status sum within settle_debt owes_me",
  T("which debts are for the venue and still open", rows("d_dani", "d_rodrigo"),
    ref=[ans(kind="debt", name="venue", where="status = open")]),
  T("so what's that in total", val((20000, "MXN")),
    ref=[ans(op="sum", field="amount", kind="debt", within="@prev")]),
  T("dani paid her half in cash, settle hers", diff(upd("d_dani", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$dani", where="status = open")]),
  T("and what's still owed to me overall", val((13120, "MXN")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open")]))

S("T32-009", "wedding tasks k4 within linked reschedule",
  T("which open wedding jobs take over an hour and are due before the dress fitting", rows("w_menu", "w_cake"),
    ref=[ans(kind="task", linked_to="$wedding_l", where="status = open and effort > 60", when=W({"to": D("2026-12-12")}))]),
  T("which of those are about rodrigo", rows("w_menu"),
    ref=[ans(within="@prev", linked_to="$rodrigo")]),
  T("push it to the 30th of november", diff(upd("w_menu", date="2026-11-30")),
    ref=[act("reschedule", rows="$w_menu", args=lines(to=D("2026-11-30")))]))

S("T32-010", "notes notebook contains year pin write-then-read",
  T("which bakery notes from this year mention flour", rows("b_suppliers"),
    ref=[ans(kind="note", linked_to="$bakery_nb", where='body contains "flour"', when=W(U("year", 0)))]),
  T("pin it and tell me what it says", rows("b_suppliers", also=diff(upd("b_suppliers", pinned=True))),
    ref=[act("edit", rows="$b_suppliers", args="pinned: yes", more=True),
         ans(rows="$b_suppliers")]),
  T("which notes in the choir notebook mention lupita", rows("c_dues"),
    ref=[ans(kind="note", linked_to="$coro_nb", where='body contains "Lupita"')]))

S("T32-011", "documents folder year star-then-within add_to-two",
  T("which documents are in the bakery folder from this year",
    rows("d_lease26", "d_permit", "d_sat26", "d_cfe"),
    ref=[ans(kind="document", linked_to="$bakery_f", when=W(U("year", 0)))]),
  T("star the cfe bill, then which ones are starred",
    rows("d_lease26", "d_permit", "d_cfe", also=diff(upd("d_cfe", starred=True))),
    ref=[act("star", rows="$d_cfe", more=True),
         ans(within="@1", where="starred = yes")]),
  T("curp and rfc into the family folder and star them",
    diff(link("family_f", "d_curp"), link("family_f", "d_rfc"), upd("d_curp", starred=True), upd("d_rfc", starred=True)),
    ref=[act("add_to", rows="$d_curp, $d_rfc", args="to: $family_f", more=True),
         act("star", rows="$d_curp, $d_rfc")]))

S("T32-012", "relation exclude where",
  T("who's singing at the christmas concert", rows("aurelio", "ignacio", "marilu", "marichuy", "lupita", "xochitl"),
    ref=[ans(kind="person", linked_to="$concert")]),
  T("and which basses from the choir aren't", rows("cuauh"),
    ref=[ans(kind="person", linked_to="$coro", where='role contains "bass"', exclude="@prev")]))

S("T32-013", "photos linked album within star add_to count-k4",
  T("pics of emi in the la espiga album", rows("p_ba_loaves", "p_ba_van"),
    ref=[ans(kind="photo", linked_to="$emi, $bakery_a")]),
  T("just the starred one", rows("p_ba_loaves"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("put it in the dani and emi album", diff(link("kids_a", "p_ba_loaves")),
    ref=[act("add_to", rows="$p_ba_loaves", args="to: $kids_a")]),
  T("how many starred ones are in the dani and emi album from this year", val(1),
    ref=[ans(op="count", kind="photo", linked_to="$kids_a", where="starred = yes", when=W(U("year", 0)))]),
  T("rename the dani and emi album to the kids and tell me how many photos it has",
    val(6, also=diff(upd("kids_a", name="The kids"))),
    ref=[act("edit", rows="$kids_a", args="name: The kids", more=True),
         ans(op="count", kind="photo", linked_to="$kids_a")]))

S("T32-014", "people when linked two-logs",
  T("which chicago cousins haven't i spoken to this month", rows("gaby"),
    ref=[ans(kind="person", linked_to="$chicago", when=W({"to": D("2026-09-30")}))]),
  T("log a message to her", diff(upd("gaby", date=ANY)),
    ref=[act("log", rows="$gaby", args="kind: message")]))

S("T32-015", "two-dates reschedule when-name",
  T("move dani's call from sunday to monday", diff(upd("calldani_1101", date="2026-11-02T20:00")),
    ref=[act("reschedule", kind="event", name="Call Dani", when=W(U("week", 0, weekday=7)),
             args=lines(to=U("week", 1, weekday=1)))]))

S("T32-016", "group create add_to-new members",
  T("new group crew in pesos, add beto, yesenia and emi",
    diff(new("group", name=has("crew"), currency="MXN"), link("new", "me"), link("new", "beto"), link("new", "yesenia"),
         link("new", "emi")),
    ref=[act("create", args="kind: group\nname: Crew\ncurrency: MXN", more=True),
         act("add_to", rows="$beto, $yesenia, $emi", args="to: $new")]),
  T("make a list for them called crew jobs", diff(new("list", name=has("crew", "jobs"))),
    ref=[act("create", args="kind: list\nname: Crew jobs")]))

S("T32-017", "locker create-and-star reveal-note delete-trashed decline-fabricated",
  T("save a new login for the mercado vendors portal, username rosa.espiga, and star it",
    diff(new("locker item", name=has("mercado"), type="login", username="rosa.espiga", starred=True)),
    ref=[act("create", args=lines(kind="locker item", name="Mercado vendors portal", type="login", username="rosa.espiga"),
             more=True),
         act("star", rows="$new")]),
  T("show me the cash box code and star it", diff(upd("safe_code", starred=True), reveal=[("safe_code", "3 7 1 9")]),
    ref=[act("reveal", kind="locker item", name="Cash box code", args="field: content", more=True),
         act("star", rows="$safe_code")]),
  T("and delete the old shop wifi", decline("not_found"),
    ref=[act("delete", kind="locker item", name="Old shop wifi")]),
  T("make up a password for the card terminal", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T32-018", "repair refused-unit effort list",
  T("open wedding jobs that take over an hour", rows("w_menu", "w_cake"),
    ref=[bad(ans(kind="task", linked_to="$wedding_l", where="status = open and effort > 1 hour")),
         ans(kind="task", linked_to="$wedding_l", where="status = open and effort > 60")]))

S("T32-019", "repair refused-unit cadence edit-and-unstar two-writes",
  T("which of my starred people do i keep up with more than every two weeks",
    rows("emi", "dani", "carmen", "beto", "aurelio"),
    ref=[bad(ans(kind="person", where="starred = yes and cadence < 2 weeks")),
         ans(kind="person", where="starred = yes and cadence < 14")]),
  T("make beto every other day and unstar the maestro",
    diff(upd("beto", cadence=2), upd("aurelio", starred=False)),
    ref=[act("edit", rows="$beto", args="cadence: 2", more=True),
         act("unstar", rows="$aurelio")]))

S("T32-020", "repair time-format reschedule when relation k4 empty-search",
  T("move next friday's accountant meeting to tuesday at 5", diff(upd("accountant_a", date="2026-11-03T17:00")),
    ref=[bad(act("reschedule", kind="event", name="accountant", when=W(U("week", 1, weekday=5)),
                 args=lines(to=U("week", 1, weekday=2, time="5pm")))),
         act("reschedule", kind="event", name="accountant", when=W(U("week", 1, weekday=5)),
             args=lines(to=U("week", 1, weekday=2, time="17:00")))]),
  T("who's going", rows("sofia"),
    ref=[ans(kind="person", linked_to="$accountant_a")]),
  T("what's still open on the bakery list before the accountant meeting that takes half an hour or less",
    rows("mu_orange", "yeast", "mu_sugar", "mu_float"),
    ref=[ans(kind="task", linked_to="$bakery_l", where="status = open and effort <= 30", when=W({"to": D("2026-11-03")}))]),
  T("when's the lawyer's appointment this month", rows(),
    ref=[search("lawyer"),
         ans(kind="event", name="lawyer", when=W(U("month", 0)))]))

S("T32-021", "ask-no-options create edit-event never_mind",
  T("put something in the diary for friday", ask(),
    ref=[askc("What should the event be called, and at what time?")]),
  T("dentist at 11", diff(new("event", name=has("dentist"), date="2026-10-30T11:00")),
    ref=[act("create", args=lines(kind="event", name="Dentist", date=U("week", 0, weekday=5, time="11:00")))]),
  T("add bring the x-rays to it", diff(upd("+1", description=has("x-rays"))),
    ref=[act("edit", rows="$c1", args="description: bring the x-rays")]),
  T("actually forget the dentist", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T32-022", "trashed find-restore decline-window read trashed-filters restore-by-name",
  T("bring karla back, she's helping for muertos", diff(restore("old_emp")),
    ref=[find(kind="person", trashed=True, name="Karla"), act("restore", rows="@1")]),
  T("hilario too", decline("not_found"),
    ref=[act("restore", kind="person", trashed=True, name="Hilario")]),
  T("any deleted bakery tasks still open", rows("old_karla_t", "old_sup_t"),
    ref=[ans(kind="task", linked_to="$bakery_l", where="status = open", trashed=True)]),
  T("bring back the bakery one about karla's wages", diff(restore("old_karla_t")),
    ref=[act("restore", kind="task", trashed=True, name="Karla", linked_to="$bakery_l")]))

