from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T29-Q001", "about word body contains i2pat",
  T("any notes about the slab", rows("karen_site2", "diary_tough"),
    ref=[ans(kind="note", where='body contains "slab"')]))

S("T29-Q002", "photos from event date plus person i2pat",
  T("what was on the 8th of august", rows("ride_0808"),
    ref=[ans(kind="event", when=J(D("2026-08-08")))]),
  T("photos of kip from that ride", rows("p_ride_ngong"),
    ref=[ans(kind="photo", linked_to="$kip", when=J(D("2026-08-08")))]))

S("T29-Q003", "how many before date from today to i2pat",
  T("how many site visits are there before the 2nd of october", val(3),
    ref=[ans(op="count", kind="event", name="site visit", when=J(span(U("day", 0), D("2026-10-02"))))]))

S("T29-Q004", "place thing password name filter wifi read i2pat",
  T("what's the kisumu house wifi password", rows("kisumu_wifi"),
    ref=[ans(kind="locker item", name="Kisumu house wifi")]))

S("T29-Q005", "what else after plan steps same parent open i2pat",
  T("what's the next step on the runda extension", rows("runda_concept"),
    ref=[ans(kind="task", linked_to="$runda", order="date asc", limit=1)]),
  T("what else", rows("runda_inv", "runda_submit", "runda_neighbours"),
    ref=[ans(kind="task", linked_to="$runda", where="status = open", exclude="@prev")]))

S("T29-Q006", "allergic note body search not tasks i2pat",
  T("add a note, brenda is allergic to shellfish", diff(new("note", name=ANY, body=has("allergic"))),
    ref=[act("create", args="kind: note\nname: Brenda allergic to shellfish\nbody: brenda is allergic to shellfish")]),
  T("what's brenda allergic to", rows("+1"),
    ref=[ans(kind="note", where='body contains "allergic"')]))

S("T29-Q007", "cadence two weeks or less often i2pat",
  T("who do i speak to every two weeks or less often", rows("otieno", "kip", "nyambura", "dennis", "gladys"),
    ref=[ans(kind="person", where="cadence >= 14 days")]))

S("T29-Q008", "events left status not cancelled from today i2pat",
  T("how many club rides are left", val(6),
    ref=[ans(op="count", kind="event", name="Club ride", where="status != cancelled", when=J({"from": U("day", 0)}))]))

S("T29-Q009", "elliptic and the role drops condition i2pat",
  T("who are my club riders", rows("kevin_m", "mwende", "juma"),
    ref=[ans(kind="person", where='role = "club rider"')]),
  T("and the clients", rows("faith", "dennis"),
    ref=[ans(kind="person", where='role = "client"')]))

S("T29-Q010", "add a note content create i2pat",
  T("add a note, ask moses about the bigger sheets", diff(new("note", name=ANY, body=has("bigger sheets"))),
    ref=[act("create", args="kind: note\nname: Moses bigger sheets\nbody: ask moses about the bigger sheets")]))

S("T29-Q011", "is there a kind none not_found ignore near hints i2pat",
  T("is there a kitchen folder", decline("not_found"),
    ref=[ans(kind="folder", name="kitchen"), dec("not_found")]))

S("T29-Q012", "let X know followup decline never reuse verb i2pat",
  T("move simba's grooming to thursday", diff(upd("groom", date="2026-09-24T11:00")),
    ref=[act("reschedule", kind="event", name="Simba grooming", args=lines(to=U("week", 0, weekday=4)))]),
  T("let tabitha know", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T29-Q013", "external service book decline i2pat",
  T("book a boda to the karen site for tomorrow", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T29-Q014", "first name matches several ask candidates i2pat",
  T("when are the site visits at karen", rows("karen_site_0929"),
    ref=[ans(kind="event", name="Site visit - Karen", when=J({"from": U("day", 0)}))]),
  T("and kevin", ask("kevin_m", "kevin_o"),
    ref=[find(kind="person", name="Kevin"), askc("Kevin Mwangi or Kevin Otieno?", options="$kevin_m, $kevin_o")]))

S("T29-Q015", "make notebook create name from topic i2pat",
  T("make a notebook for the diani trip", diff(new("notebook", name=has("Diani"))),
    ref=[act("create", args="kind: notebook\nname: Diani trip")]))

S("T29-Q016", "bare weekday this week still ahead i2pat",
  T("push the structural call to thursday", diff(upd("structural", date="2026-09-24T09:30")),
    ref=[act("reschedule", rows="$structural", args=lines(to=U("week", 0, weekday=4)))]))

S("T29-Q017", "correction turn move to Nth same time i2pat",
  T("put the vet follow-up on friday", diff(upd("vet_followup", date="2026-09-25T10:00")),
    ref=[act("reschedule", rows="$vet_followup", args=lines(to=U("week", 0, weekday=5)))]),
  T("actually no, move it to the 9th, same time", diff(upd("vet_followup", date="2026-10-09T10:00")),
    ref=[act("reschedule", rows="$vet_followup", args=lines(to=D("2026-10-09", "10:00")))]))

S("T29-Q018", "due weekday cue words in name not dates i2pat",
  T("add a task to buy flowers for sunday lunch, due friday", diff(new("task", name=has("flowers"), date="2026-09-25")),
    ref=[act("create", args=lines(kind="task", name="Buy flowers for Sunday lunch", date=U("week", 0, weekday=5)))]))

S("T29-Q019", "add one after listing container create with link i2pat",
  T("what's open on the kisumu list", rows("baba_gift", "mama_meds", "roof_quote"),
    ref=[ans(kind="task", linked_to="$kisumu_list", where="status = open")]),
  T("add one for akinyi's gift", diff(new("task", name=has("Akinyi")), link("kisumu_list", "new")),
    ref=[act("create", args="kind: task\nname: Akinyi's gift\nlist: $kisumu_list")]))

S("T29-Q020", "do them after read naming action i2pat",
  T("i'm going to tick off tomorrow's tasks, which are they", rows("karen_mockup", "mpesa_float", "chai_pay", "print_fee"),
    ref=[ans(kind="task", when=J(U("day", 1)))]),
  T("do them", diff(upd("karen_mockup", status="completed", completed=ANY), upd("mpesa_float", status="completed", completed=ANY),
                    upd("chai_pay", status="completed", completed=ANY), upd("print_fee", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]))

S("T29-Q021", "no notes description empty i2pat",
  T("which karen tasks have no notes", rows("karen", "karen_dwgs", "karen_roof", "karen_boq", "karen_tiles", "inv_faith_sep", "karen_mockup", "inv_faith_c"),
    ref=[ans(kind="task", linked_to="$karen_list", where="description is empty")]))

S("T29-Q022", "same list over named rows kind list i2pat",
  T("are the gas and the dog food on the same list", rows("home_list"),
    ref=[find(kind="task", name="gas"), find(kind="task", name="dog food"), ans(kind="list", linked_to="@1, @2")]))

S("T29-Q023", "what X stuff name across task document i2pat",
  T("what simba stuff do i have", rows("vacc_task", "vacc_cert", "dog_tag", "simba_cert"),
    ref=[ans(kind="task,document", name="Simba")]))

S("T29-Q024", "tab word debt kind i2pat",
  T("what's my tab with wambui", rows("d_wambui_wifi", "d_wambui_tokens"),
    ref=[ans(kind="debt", linked_to="$wambui")]))

S("T29-Q025", "elliptical past-tense did complete i2pat",
  T("did the kplc tokens", diff(upd("kplc", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="KPLC tokens")]))
