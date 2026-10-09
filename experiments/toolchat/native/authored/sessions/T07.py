from gold import *
import json

world("T07", "2026-03-12T12:30", "Maria Ines Quispe", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T07-001", "events tomorrow edit description span count",
  T("what's on tmrw", rows("seed_delivery", "land_tax"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("the seed one, note that sonia brings 40 sacks", diff(upd("seed_delivery", description="Sonia brings 40 sacks")),
    ref=[act("edit", rows="$seed_delivery", args=lines(description="Sonia brings 40 sacks"))]),
  T("and from saturday to sunday night?", rows("asm_0314", "mass_0315", "vcall_0315"),
    ref=[ans(kind="event", when=W(span(U("day", 2), U("week", 0, weekday=7))))]),
  T("how many rehearsals are left from 7 tonight on", val(7),
    ref=[ans(op="count", kind="event", name="Choir rehearsal", when=W({"from": U("day", 0, time="19:00")}))]))

S("T07-002", "balance two rosas repair ask",
  T("how much do i owe rosa", ask("rosa_m", "rosa_c"),
    ref=[bad(ans(op="balance", kind="person", name="Rosa")),
         askc("rosa mamani from the coop or rosa condori from the choir?", options="$rosa_m, $rosa_c")]),
  T("the choir one", val((50, "PEN")),
    ref=[ans(op="balance", rows="$rosa_c")]))

S("T07-003", "tasks priority edit prev",
  T("what's urgent, priority one or 2", rows("fung_1", "seed_pay", "rent_mar", "scout_report", "expo_samples", "sunat", "vale_fees", "insurance"),
    ref=[ans(kind="task", where='priority <= 2 and status = "open"')]),
  T("the loan paperwork one, what's left under it", rows("agro_bank", "agro_title"),
    ref=[find(kind="task", name="Agrobanco loan"), ans(kind="task", linked_to="@prev", where='status = "open"')]),
  T("drop the whole loan thing to priority two, patricia gave us another week", diff(upd("agro_docs", priority=2)),
    ref=[act("edit", rows="$agro_docs", args=lines(priority=2))]))

S("T07-004", "note ambiguous seed order ask pick",
  T("add canchan 5 more sacks to the seed order note", ask("seed_2025", "seed_2026"),
    ref=[find(kind="note", name="Seed order"),
         askc("this year's seed order in field notes or last september's in the coop notebook?", options="$seed_2025, $seed_2026")]),
  T("this years obviously", diff(upd("seed_2026", body="Canchan 30 sacks, Unica 10, Amarilla Tumbay 6; Sonia wants half up front")),
    ref=[opn("$seed_2026"), act("edit", rows="$seed_2026", args=lines(body="Canchan 30 sacks, Unica 10, Amarilla Tumbay 6; Sonia wants half up front"))]),
  T("pin it too", diff(upd("seed_2026", pinned=True)),
    ref=[act("edit", rows="$seed_2026", args=lines(pinned="yes"))]))

S("T07-005", "single wifi reveal where",
  T("show me the wifi password, the plumber wants it", diff(reveal=[("wifi", "chacra-huasao-58")]),
    ref=[act("reveal", kind="locker item", where='type = "wifi"', args=lines(field="password"))]))

S("T07-008", "choir remove_from where soprano balance",
  T("carmen's leaving the choir group, take her out", diff(unlink("choir_g", "carmen")),
    ref=[act("remove_from", kind="person", name="carmen", linked_to="$choir_g", args=lines(from_="$choir_g"))]),
  T("who's left in it", rows("rosa_c", "lucia", "jaime", "alfredo", "me"),
    ref=[ans(kind="person", linked_to="$choir_g")]),
  T("where does lucia stand in there", val((-10, "PEN")),
    ref=[ans(op="balance", kind="group", name="San Blas choir", linked_to="$lucia")]))

S("T07-009", "photos album count unstar named",
  T("which photos are in more than one album", rows("h_huayro", "h_pachamanca", "h_vale", "c_xmas", "e_ribbon"),
    ref=[ans(kind="photo", where="album count >= 2")]),
  T("unstar the huayro close-up", diff(upd("h_huayro", starred=False)),
    ref=[act("unstar", kind="photo", name="Huayro close-up")]),
  T("and the ribbon one", diff(upd("e_ribbon", starred=False)),
    ref=[act("unstar", rows="$e_ribbon")]))

S("T07-010", "restore task multi trashed",
  T("what tasks did i delete lately", rows("poster", "manure", "senasa"),
    ref=[ans(kind="task", trashed=True)]),
  T("bring back the first two", diff(restore("poster"), restore("manure")),
    ref=[act("restore", rows="$poster, $manure")]),
  T("and the senasa one", ask(),
    ref=[find(kind="task", name="SENASA", trashed=True),
         bad(act("restore", rows="$senasa")),
         askc("the senasa task has been in the bin since january, too long to restore. want me to make it again as a new task?")]))

S("T07-011", "events multi edit description",
  T("next two rehearsals", rows("reh_0318", "reh_0325"),
    ref=[ans(kind="event", name="Choir rehearsal", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("put 'bring holy week scores' on both", diff(upd("reh_0318", description="bring holy week scores"),
                                                 upd("reh_0325", description="bring holy week scores")),
    ref=[act("edit", rows="$reh_0318, $reh_0325", args=lines(description="bring holy week scores"))]))

S("T07-012", "tasks add_to multi list",
  T("put the hugo email and the inia bulletin on the farm list", diff(link("farm_l", "hugo_email"), link("farm_l", "bulletin")),
    ref=[act("add_to", rows="$hugo_email, $bulletin", args=lines(to="$farm_l"))]),
  T("what on it is over an hour", rows("scout_report", "trial_data", "storehouse"),
    ref=[ans(kind="task", linked_to="$farm_l", where='effort > 60 and status = "open"')]))

S("T07-013", "task where reschedule linked",
  T("what's on my plate for hugo", rows("hugo_email", "trial_data"),
    ref=[ans(kind="task", linked_to="$hugo")]),
  T("push the email one to next tuesday 9am", diff(upd("hugo_email", date="2026-03-17T09:00")),
    ref=[act("reschedule", kind="task", linked_to="$hugo", where="effort < 30",
             args=lines(to=U("week", 1, weekday=2, time="09:00")))]),
  T("anything else due that tuesday", rows("agro_bank", "agro_title"),
    ref=[ans(kind="task", when=W(U("week", 1, weekday=2)), exclude="$hugo_email")]))

S("T07-014", "notes remove_from where pinned coop",
  T("pinned notes in the coop notebook?", rows("prices"),
    ref=[ans(kind="note", linked_to="$coop_nb", where="pinned = yes")]),
  T("take it out of that notebook, it belongs to nothing", diff(unlink("coop_nb", "prices")),
    ref=[act("remove_from", kind="note", linked_to="$coop_nb", where="pinned = yes", args=lines(from_="$coop_nb"))]),
  T("so which notes have no notebook", rows("frost", "julio_gifts", "hugo_qs", "prices"),
    ref=[ans(kind="note", where="notebook count = 0")]))

S("T07-015", "search miss not_found",
  T("where did i put the quinoa price sheet", decline("not_found"),
    ref=[search("quinoa price"), dec("not_found")]))

S("T07-016", "person delete named create",
  T("delete benito quispe, he changed his number and moved for good", diff(trash("benito")),
    ref=[act("delete", kind="person", name="Benito Quispe")]),
  T("add his wife instead, Maribel Quispe, cousin in Santiago", diff(new("person", name="Maribel Quispe", role=has("cousin"))),
    ref=[act("create", args=lines(kind="person", name="Maribel Quispe", role="cousin in Santiago"))]),
  T("undo, i'll do it later", diff(trash("+1")),
    ref=[act("undo")]))

S("T07-017", "documents folder count date",
  T("what documents have no folder at all", rows("dni_scan", "seed_receipt"),
    ref=[ans(kind="document", where="folder count <= 0")]),
  T("what did i save on the tenth", rows("seed_receipt"),
    ref=[ans(kind="document", when=W(D("2026-03-10")))]),
  T("move it into coop papers", diff(link("coop_f", "seed_receipt")),
    ref=[act("add_to", rows="$seed_receipt", args=lines(to="$coop_f"))]),
  T("any empty folders", rows("tax_f"),
    ref=[ans(kind="folder", where="document count = 0")]),
  T("is there a doc called tax receipts somewhere", decline("not_found"),
    ref=[find(kind="document", name="tax receipts"), search("tax receipts", kind="document"), dec("not_found")]))

S("T07-018", "locker star prev url",
  T("which login has the url sunat.gob.pe", rows("sunat_login"),
    ref=[ans(kind="locker item", where='url contains "sunat.gob.pe"')]),
  T("what logins have i got", rows("agro_login", "sunat_login", "gmail"),
    ref=[find(kind="locker item", where='type = "login"'), ans(rows="@prev")]),
  T("star the gmail one", diff(upd("gmail", starred=True)),
    ref=[act("star", rows="$gmail")]))

S("T07-019", "restore photo where",
  T("i deleted a photo of the lesions by accident on monday, get it back", diff(restore("blurry")),
    ref=[act("restore", kind="photo", trashed=True, when=W(U("week", 0, weekday=1)))]),
  T("what albums is it in", rows(),
    ref=[ans(kind="album", linked_to="$blurry")]))

S("T07-020", "open row agrobanco meeting",
  T("tell me everything about the agrobanco meeting next week", rows("agro_0319"),
    ref=[find(kind="event", name="Meeting with Agrobanco", when=W(U("week", 1))), opn("$agro_0319"), ans(rows="$agro_0319")]),
  T("who's coming", rows("patricia", "teodoro"),
    ref=[ans(kind="person", linked_to="$agro_0319")]),
  T("move it an hour later", diff(upd("agro_0319", date="2026-03-19T11:00")),
    ref=[act("reschedule", rows="$agro_0319", args=lines(to=U("hour", 1, anchor="row")))]),
  T("note on it: bring the loan folder and the land title", diff(upd("agro_0319", description="bring the loan folder and the land title")),
    ref=[act("edit", rows="$agro_0319", args=lines(description="bring the loan folder and the land title"))]))

S("T07-021", "debts direction amount compute max",
  T("who do i owe", rows("d_wilber", "d_carla", "d_efrain", "d_sonia", "d_lucia", "d_hugo"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("the small ones, under 50 soles", rows("d_wilber", "d_lucia"),
    ref=[ans(kind="debt", within="@prev", where="amount < 50 PEN")]),
  T("what's the biggest i owe", val((350, "PEN")),
    ref=[ans(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("and total", val((645, "PEN")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T07-022", "list where edit empty result recovery",
  T("could you rename the church list to Coro San Blas", diff(upd("choir_l", name="Coro San Blas")),
    ref=[find(kind="list", name="church"),
         act("edit", kind="list", where='area = "church"', args=lines(name="Coro San Blas"))]),
  T("lists that aren't farm stuff", rows("coop_l", "home_l", "choir_l", "vale_l"),
    ref=[ans(kind="list", where='area != "farm"')]))

S("T07-023", "event overlap repair reschedule",
  T("book a call with hugo next wednesday at 7pm", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Call with Hugo", date=U("week", 1, weekday=3, time="19:00")))),
         askc("next wednesday 7pm clashes with choir rehearsal. another time?")]),
  T("ok thursday at 4", diff(new("event", name="Call with Hugo", date="2026-03-19T16:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Hugo", date=U("week", 1, weekday=4, time="16:00")))]))

S("T07-024", "group person count delete empty group",
  T("which groups have two people or fewer", rows("family_g", "quito_g", "pisac_g", "raffle_g"),
    ref=[ans(kind="group", where="person count <= 3")]),
  T("delete the raffle fund one, we never used it", diff(gone("raffle_g"), unlink("raffle_g", "carmen"), unlink("raffle_g", "jaime"),
                                                         unlink("raffle_g", "me")),
    ref=[act("delete", rows="$raffle_g")]),
  T("and the coop group while you're at it", decline("unbounded_destruction", "not_found"),
    ref=[bad(act("delete", rows="$coop_g")), dec("unbounded_destruction")]))

S("T07-025", "people group count task count",
  T("who's in two or more of my groups", rows("teodoro", "nilda", "fortunata", "carmen", "jaime"),
    ref=[find(kind="person", where="group count >= 2"), ans(within="@prev", exclude="$me")]),
  T("and who has at least two tasks tied to them", rows("valeria", "hugo", "teodoro", "efrain"),
    ref=[ans(kind="person", where="task count >= 2")]))
