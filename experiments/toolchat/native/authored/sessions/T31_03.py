from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-053", "sum owed last month four-constraints",
  T("how much do i still owe from last month", val((212, "PLN")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open",
             when=J(U("month", -1)))]))

S("T31-054", "count flat tasks this week four-constraints compute",
  T("how many flat tasks are due this week that i haven't done", val(3),
    ref=[comp(op="count", kind="task", linked_to="$flat_l", where="status = open", when=J(U("week", 0))),
         ans(value="@prev")]))

S("T31-055", "ambiguous delete pay rent pick",
  T("delete the pay rent task", ask("rent_sep", "rent_oct", "rent_nov"),
    ref=[act("delete", kind="task", name="pay rent")]),
  T("the september one", diff(trash("rent_sep")),
    ref=[act("delete", kind="task", name="pay rent", when=J(U("month", -1, name=9)))]),
  T("no wait, bring back the pay rent one", diff(restore("rent_sep")),
    ref=[find(kind="task", name="pay rent", trashed=True), act("restore", rows="@1")]))

S("T31-056", "refused remove member balance settle-up",
  T("take ola out of flat bills", ask("ola", "flat_bills"),
    ref=[act("remove_from", rows="$ola", args=lines(from_="$flat_bills"))]),
  T("ok settle up with her first", diff(upd("ola", balance=ANY)),
    ref=[act("settle_up", rows="$ola", args=lines(group="$flat_bills"))]))

S("T31-057", "did-you-mean delete event confirm",
  T("get rid of the haircut with wojciech", ask("barber_ev"),
    ref=[act("delete", kind="event", name="haircut wojciech")]),
  T("yes that one", diff(trash("barber_ev")),
    ref=[act("delete", rows="$barber_ev")]),
  T("actually bring the haircut back, i'll keep it", diff(restore("barber_ev")),
    ref=[find(kind="event", name="haircut", trashed=True), act("restore", rows="@1")]))

S("T31-058", "group delete refused expenses rename",
  T("get rid of the london christmas group", ask(),
    ref=[act("delete", kind="group", name="London Christmas")]),
  T("ok rename it to london 2026 then", diff(upd("london", name="London 2026")),
    ref=[act("edit", rows="$london", args=lines(name="London 2026"))]))

S("T31-059", "not-found event decline out-of-scope star event",
  T("cancel the vet appointment on friday", decline("not_found"),
    ref=[act("cancel", kind="event", name="vet appointment", when=J(U("week", 0, weekday=5)))]),
  T("star the cpr course", decline("out_of_scope"),
    ref=[act("star", kind="event", name="cpr course")]))

S("T31-060", "folder delete ask never-mind starred-before-year",
  T("delete the health folder", ask("d_nfz", "d_vacc", "d_physio_plan"),
    ref=[act("delete", kind="folder", name="Health")]),
  T("never mind", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("unstar whatever in the work folder is starred and from before 2025", diff(upd("d_licence", starred=False)),
    ref=[act("unstar", kind="document", linked_to="$work_f", where="starred = yes", when=J({"to": D("2024-12-31")}))]))

S("T31-061", "create clash ask retime sunday-read",
  T("put coffee with kuba in sunday at 12", ask("league_1108"),
    ref=[act("create", kind="event", args=lines(name="Coffee with Kuba", date=D("2026-11-08", "12:00")))]),
  T("sunday at 4 then", diff(new("event", name=has("Kuba"), date="2026-11-08T16:00")),
    ref=[act("create", kind="event", args=lines(name="Coffee with Kuba", date=D("2026-11-08", "16:00")))]),
  T("how's my sunday looking", rows("league_1108", "brunch_adi", "+1", "mama_1108", "kasia_call"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=7)))]))

S("T31-062", "two marcins star exclude next-event ambiguous unstar role",
  T("which marcins are starred", rows("marcin_l"),
    ref=[ans(kind="person", name="marcin", where="starred = yes")]),
  T("star the other one", diff(upd("marcin_b", starred=True)),
    ref=[act("star", kind="person", name="marcin", exclude="$marcin_l")]),
  T("when's the next five-a-side", rows("fas_1110"),
    ref=[ans(kind="event", name="five-a-side", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("unstar marcin", ask("marcin_l", "marcin_b"),
    ref=[act("unstar", kind="person", name="marcin")]),
  T("the nurse", diff(upd("marcin_b", starred=False)),
    ref=[act("unstar", kind="person", name="marcin", where='role contains "nurse"')]))


S("T31-063", "money round-up group-compute biggest settle-write-read sum-within create-debt",
  T("give me both totals, owed and owing", vgroups({"i_owe": (546, "PLN"), "owes_me": (200, "PLN")}),
    ref=[comp(op="sum", field="amount", kind="debt", where="status = open", group="direction"),
         ans(value="@1")]),
  T("what's the largest amount i owe anyone", rows("d_natalia"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount desc", limit=1)]),
  T("settled that one this morning, and what do i still owe",
    rows("d_kuba_gas", "d_ola_clean", "d_darek_pizza", "d_marcin_hall", "d_ewa", "d_kasia",
         also=diff(upd("d_natalia", status="settled"))),
    ref=[act("settle_debt", rows="$d_natalia", more=True),
         ans(kind="debt", where="direction = i_owe and status = open")]),
  T("which of those are from last month", rows("d_kasia", "d_ola_clean", "d_darek_pizza"),
    ref=[ans(within="@prev", when=J(U("month", -1)))]),
  T("and what's the total of those", val((212, "PLN")),
    ref=[ans(op="sum", field="amount", within="@prev")]),
  T("ola's cleaning one is paid, mark it and tell me where i stand with her now",
    val((62, "PLN"), also=diff(upd("d_ola_clean", status="settled"))),
    ref=[act("settle_debt", kind="debt", linked_to="$ola", where="direction = i_owe", more=True),
         ans(op="balance", rows="$ola")]),
  T("kuba owes me 30 for the cinema, and what's he got open with me in total",
    val((50, "PLN"), also=diff(new("debt", name=has("cinema")), link("new", "kuba"))),
    ref=[act("create", kind="debt", args=lines(name="cinema", person="$kuba", amount="30", direction="owes_me"),
             more=True),
         comp(op="sum", field="amount", kind="debt", linked_to="$kuba", where="direction = owes_me and status = open"),
         ans(value="@prev")]))

S("T31-064", "december football cancel-find-act write-read league darek cancelled",
  T("cancel the five-a-side games in december, the hall's shut",
    diff(upd("fas_1201", status="cancelled"), upd("fas_1208", status="cancelled"), upd("fas_1215", status="cancelled")),
    ref=[find(kind="event", name="five-a-side", when=J(U("month", 0, name=12))), act("cancel", rows="@1")]),
  T("which ones are left in the hall this month", rows("fas_1110", "fas_1117", "fas_1124"),
    ref=[ans(kind="event", name="five-a-side hall", when=J(span(U("day", 0), D("2026-11-30"))))]),
  T("move the 24th one to the 25th same time, and who's down for it",
    rows("marcin_l", "tomek_m", "piotr", also=diff(upd("fas_1124", date="2026-11-25T20:00"))),
    ref=[act("reschedule", rows="$fas_1124", args=lines(to=D("2026-11-25")), more=True),
         ans(kind="person", linked_to="$fas_1124")]),
  T("any league matches in december with darek", rows("league_1206"),
    ref=[ans(kind="event", name="league match", linked_to="$darek", when=J(U("month", 0, name=12)))]),
  T("cancel it and show me what league matches are left with him",
    rows("league_1108", "league_1122", also=diff(upd("league_1206", status="cancelled"))),
    ref=[act("cancel", rows="$league_1206", more=True),
         ans(kind="event", name="league match", linked_to="$darek", where="status != cancelled",
             when=J({"from": U("day", 1)}))]),
  T("and the cancelled ones this season", rows("league_1018", "league_1206"),
    ref=[ans(kind="event", name="league match", where="status = cancelled")]))

S("T31-065", "nowy sacz photos find-star within add-to create-album write-read",
  T("star all the unstarred photos in the nowy sacz album",
    diff(upd("p_ns_mama", starred=True), upd("p_ns_tata", starred=True), upd("p_ns_babcia", starred=True),
         upd("p_ns_walk", starred=True), upd("p_ns_all", starred=True)),
    ref=[find(kind="photo", linked_to="$family_a", where="starred = no"), act("star", rows="@1")]),
  T("which of those have babcia in", rows("p_ns_babcia", "p_ns_walk", "p_ns_all"),
    ref=[ans(within="@1", linked_to="$babcia")]),
  T("put those in trips 2026 as well", diff(link("trips_a", "p_ns_babcia"), link("trips_a", "p_ns_walk"), link("trips_a", "p_ns_all")),
    ref=[act("add_to", rows="@2", args=lines(to="$trips_a"))]),
  T("make a new album called babcia and put them there too",
    diff(new("album", name=has("Babcia")), link("new", "p_ns_babcia"), link("new", "p_ns_walk"), link("new", "p_ns_all")),
    ref=[act("create", kind="album", args=lines(name="Babcia"), more=True),
         act("add_to", rows="@2", args=lines(to="$new"))]),
  T("take the church walk one back out of the babcia album", diff(unlink("+1", "p_ns_walk")),
    ref=[act("remove_from", rows="$p_ns_walk", args=lines(from_="$c1"))]))
