from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T14-Q001", "instead-weekday reschedule time-only i2pat",
  T("juliana's session at 10 instead on thursday", diff(upd("physio_1029", date="2026-10-29T10:00")),
    ref=[act("reschedule", kind="event", linked_to="$juliana", when=J(U("week", 1, weekday=4)),
             args=lines(to=U("day", 0, anchor="row", time="10:00")))]))

S("T14-Q002", "birthday noun name across kinds i2pat",
  T("what's coming up for larissa's birthday", rows("lari_bday", "gift_lari"),
    ref=[ans(kind="event,task", name="Larissa's birthday")]))

S("T14-Q003", "about word body contains i2pat",
  T("what notes are about losartana", rows("mae_meds_n", "pharm_1"),
    ref=[ans(kind="note", where='body contains "losartana"')]))

S("T14-Q004", "documents not-from exclude find i2pat",
  T("what documents have i saved since the start of september",
    rows("ins_policy", "fuel_rcpt", "tyre_rcpt", "echo_doc", "rx", "das_sep", "contract_cv", "contract_bsas", "rider"),
    ref=[ans(kind="document", when=J({"from": D("2026-09-01")}))]),
  T("just the ones not from the mom medical folder",
    rows("ins_policy", "fuel_rcpt", "tyre_rcpt", "das_sep", "contract_cv", "contract_bsas", "rider"),
    ref=[find(kind="document", linked_to="$mae_f"), ans(within="@1", exclude="@prev")]))

S("T14-Q005", "the one with field value read i2pat",
  T("the one with username djtomasf", rows("soundcloud"),
    ref=[ans(kind="locker item", where='username = "djtomasf"')]))

S("T14-Q006", "place thing password name filter wifi read i2pat",
  T("what's the casa wifi password", rows("wifi"),
    ref=[ans(kind="locker item", name="Casa wifi")]))

S("T14-Q007", "fresh date drops link filter i2pat",
  T("what've i got with larissa this week", rows("movie", "regina_lunch"),
    ref=[ans(kind="event", linked_to="$larissa", when=J(U("week", 0)))]),
  T("and what's on thursday the 29th", rows("physio_1029", "accountant", "fut_1029"),
    ref=[ans(kind="event", when=J(D("2026-10-29")))]))

S("T14-Q008", "bare noun across kinds ask no inherit i2pat",
  T("what's open on the dj list", rows("setlist12", "usb", "mix", "inv_kleber_nov", "headphones", "controller", "bsas_setlist", "flyer_art"),
    ref=[ans(kind="task", linked_to="$dj_l", where="status = open")]),
  T("rider", ask("rider", "rider_l"),
    ref=[askc("The technical rider document or the rider PDF in the locker?", options="$rider, $rider_l")]))

S("T14-Q009", "cadence four weeks or less often i2pat",
  T("who do i only speak to every four weeks or less often", rows("thiago", "marcos_t", "jorge", "regina", "fernanda", "priscila"),
    ref=[ans(kind="person", where="cadence >= 28 days")]))

S("T14-Q010", "remove two named rows from list i2pat",
  T("take both mei tasks off the papelada list", diff(unlink("admin_l", "das"), unlink("admin_l", "mei_decl")),
    ref=[find(kind="task", name="mei", linked_to="$admin_l"), act("remove_from", rows="@prev", args="from: $admin_l")]))

S("T14-Q011", "second clause whos left open owes_me i2pat",
  T("guga's paid me for the headphones, who's left",
    rows("d_rafa_s", "d_diego", "d_thiago", "d_kleber", "d_bianca", also=diff(upd("d_guga", status="settled"))),
    ref=[act("settle_debt", kind="debt", linked_to="$guga", where="status = open", more=True),
         ans(kind="debt", where="direction = owes_me and status = open")]))

S("T14-Q012", "add a note content create i2pat",
  T("add a note, bring the spare cables to the gig", diff(new("note", name=ANY, body=has("spare cables"))),
    ref=[act("create", args="kind: note\nname: Spare cables\nbody: bring the spare cables to the gig")]))

S("T14-Q013", "add_to destination missing ask create i2pat",
  T("put the rodizio rules note in my cardio notebook", ask(),
    ref=[askc("You don't have a cardio notebook. Create it?")]))

S("T14-Q014", "outside world order decline i2pat",
  T("order me a new usb stick on amazon", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T14-Q015", "external service book decline i2pat",
  T("book me an uber for otavio's airport run", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T14-Q016", "how-many-had so far upper bound i2pat",
  T("how many physio sessions has mom had so far", val(3),
    ref=[ans(op="count", kind="event", name="physiotherapy", when=J({"to": U("day", 0)}))]))

S("T14-Q017", "nth and mth of month same month past i2pat",
  T("what gigs did i have on the 2nd and the 16th of october", rows("kleber_1002", "kleber_1016"),
    ref=[find(kind="event", when=J(D("2026-10-02"))), find(kind="event", when=J(D("2026-10-16"))), ans(rows="@1, @2")]))

S("T14-Q018", "bare weekday nearest upcoming reschedule i2pat",
  T("push the landlord visit to tuesday", diff(upd("landlord", date="2026-10-27T10:00")),
    ref=[act("reschedule", rows="$landlord", args=lines(to=U("week", 1, weekday=2)))]))

S("T14-Q019", "list word zero lists notes i2pat",
  T("pull up the pharmacy list", rows("pharm_1", "pharm_2"),
    ref=[ans(kind="note,document", name="pharmacy list")]))

S("T14-Q020", "document by name with month no verb i2pat",
  T("mom's blood test from august", rows("blood_doc"),
    ref=[ans(kind="document", name="blood test")]))

S("T14-Q021", "add one after listing container create with link i2pat",
  T("what's open on the casa list", rows("rent_nov", "leak", "gas", "plants", "shelf"),
    ref=[ans(kind="task", linked_to="$casa_l", where="status = open")]),
  T("add one to fix the gate buzzer", diff(new("task", name=has("buzzer")), link("casa_l", "new")),
    ref=[act("create", args="kind: task\nname: Fix the gate buzzer\nlist: $casa_l")]))

S("T14-Q022", "cadence monthly or rarer i2pat",
  T("who do i see monthly or rarer", rows("thiago", "marcos_t", "jorge", "regina", "fernanda", "priscila"),
    ref=[ans(kind="person", where="cadence >= 30 days")]))

S("T14-Q023", "my short word file star not role i2pat",
  T("star my cnh", diff(upd("cnh_doc", starred=True)),
    ref=[act("star", kind="document", name="CNH")]))

S("T14-Q024", "no notes description empty i2pat",
  T("which of my dj tasks have no notes", rows("setlist12", "mix", "headphones", "controller", "bsas_setlist", "flyer_art"),
    ref=[ans(kind="task", linked_to="$dj_l", where="description is empty")]))

S("T14-Q025", "which most within prev order desc i2pat",
  T("who owes me anything", rows("d_rafa_s", "d_guga", "d_diego", "d_thiago", "d_kleber", "d_bianca"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which is the most", rows("d_kleber"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))
