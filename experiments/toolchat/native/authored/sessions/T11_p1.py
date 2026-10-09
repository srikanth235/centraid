from gold import *
import json
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
def J(d):
    return json.dumps(d, separators=(",", ":"))
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
FROM_NOW = W({"from": U("day", 0)})
NEXT2 = find(kind="event", name="U12 hurling training", when=FROM_NOW, order="date asc", limit=2)
FARM = find(kind="task", linked_to="$farm_l", where=OPEN)
TOP3 = find(kind="debt", where=IOWE, order="amount desc", limit=3)


S("T11-001-P", "event weekday reschedule named create overlap refused ask para",
  T("what've i got tuesday", rows("tb_test"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=2)))]),
  T("fergal phoned, wednesday at 9 suits him better, so move it", diff(upd("tb_test", date="2026-07-29T09:00")),
    ref=[act("reschedule", rows="$tb_test", args=lines(to=U("week", 1, weekday=3, time="09:00")))]),
  T("thursday half 10, book me a call with pat about the lame ones", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Call with Pat", date=U("week", 1, weekday=4, time="10:30")))),
         askc("hoof trimming runs 10 to 1 that thursday, so half 10 clashes. after 1?")]))

S("T11-008-P", "role find log prev balance para",
  T("name of the relief milker?", rows("ger"),
    ref=[find(kind="person", where='role contains "relief"'),
         ans(rows="@prev")]),
  T("put down a visit for him, he covered saturday morning", diff(upd("ger", date=ANY)),
    ref=[act("log", rows="@prev", args=lines(kind="visit"))]),
  T("how do we stand on money, him and me", val((-180, "EUR")),
    ref=[ans(op="balance", rows="$ger")]))

S("T11-014-P", "star photo named para",
  T("U12 team photo, give it a star", diff(upd("p_u12_team", starred=True)),
    ref=[act("star", kind="photo", name="U12 team photo")]),
  T("now the team talk one of tadhgie's", diff(upd("p_tadhg_speech", starred=True)),
    ref=[act("star", kind="photo", name="team talk")]))

S("T11-020-P", "reschedule event named day read para",
  T("make coffee with noreen 3 o'clock instead", diff(upd("noreen_coffee", date="2026-07-31T15:00")),
    ref=[act("reschedule", kind="event", name="Coffee with Noreen", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("what other bookings are there that friday", rows("tb_read"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=5)), exclude="$noreen_coffee")]))

S("T11-025-P", "create document folder star new para",
  T("in herd records, new doc: Fergal's invoice July",
    diff(new("document", name="Fergal's invoice July"), link("herd_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Fergal's invoice July", folder="$herd_f"))]),
  T("brendan needs it, so give it a star", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]))

S("T11-030-P", "log named undo ledger not undone log named para",
  T("mick considine dropped by, log it as a visit", diff(upd("mick", date=ANY)),
    ref=[act("log", kind="person", name="Mick Considine", args=lines(kind="visit"))]),
  T("oops wrong one, undo it, mary not mick", diff(),
    ref=[act("undo")]),
  T("mary considine it was, log that visit instead", diff(upd("mary_c", date=ANY)),
    ref=[act("log", kind="person", name="Mary Considine", args=lines(kind="visit"))]))

S("T11-035-P", "photos month span starred != star named person count within para",
  T("pics between the start of may and the end of june",
    rows("p_comm_church", "p_comm_grans", "p_comm_family", "p_comm_cake", "p_silage1", "p_aoife_camogie",
         "p_pj_tractor", "p_cian_goal", "p_u12_team", "p_parlour"),
    ref=[ans(kind="photo", when=W(span(D("2026-05-01"), U("month", 0, name=6))))]),
  T("of that lot, what's still unstarred",
    rows("p_comm_grans", "p_comm_family", "p_comm_cake", "p_silage1", "p_aoife_camogie", "p_pj_tractor",
         "p_u12_team", "p_parlour"),
    ref=[ans(within="@prev", where="starred != yes")]),
  T("aoife's camogie final needs a star", diff(upd("p_aoife_camogie", starred=True)),
    ref=[act("star", kind="photo", name="Aoife's camogie final")]),
  T("among the unstarred ones, the ones with at most one person tagged",
    rows("p_comm_cake", "p_silage1", "p_aoife_camogie", "p_pj_tractor", "p_parlour"),
    ref=[ans(within="@2", where="person count <= 1")]))

S("T11-041-P", "single ambiguous event ask para",
  T("tb test, an hour later please", ask("tb_test", "tb_read"),
    ref=[act("reschedule", kind="event", name="TB test", args=lines(to=U("hour", 1, anchor="row"))),
         askc("the tb test on tuesday or the reading on friday?", options="$tb_test, $tb_read")]))

S("T11-046-P", "debt date span rel para",
  T("anything in debts from the twelfth of july", rows("d_sean_silage"),
    ref=[ans(kind="debt", when=W(D("2026-07-12")))]),
  T("now the open ones only, june through to last week",
    rows("d_sean_silage", "d_mick_silage", "d_fergal", "d_eileen", "d_clodagh", "d_tom", "d_pj", "d_mick_diesel"),
    ref=[ans(kind="debt", when=W(span(U("month", -1), U("week", -1))), where='status = "open"')]),
  T("and wednesday until 5 on friday", rows("d_tadhg", "d_mary_c"),
    ref=[ans(kind="debt", when=W(span(U("week", 0, weekday=3), U("week", 0, weekday=5, time="17:00"))))]))

S("T11-052-P", "six turns debts amount unit max min order settle sum para",
  T("debts people owe me that top 100 euro", rows("d_mick_silage", "d_tadhg", "d_tom"),
    ref=[ans(kind="debt", where='amount > 100 EUR and direction = "owes_me" and status = "open"')]),
  T("largest open one in each direction", vgroups({"i_owe": (850, "EUR"), "owes_me": (240, "EUR")}),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]),
  T("and the lowest of each", vgroups({"i_owe": (12, "EUR"), "owes_me": (25, "EUR")}),
    ref=[comp(op="min", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]),
  T("who do i owe the 12 to", rows("mary_c"),
    ref=[find(kind="debt", where='direction = "i_owe" and status = "open"', order="amount asc", limit=1),
         ans(kind="person", linked_to="@prev")]),
  T("money's been dropped over, mark it settled", diff(upd("d_mary_c", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Eggs and brown bread")]),
  T("so what do i owe all together now", val((1435, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T11-057-P", "notes open span date within notebook count note count para",
  T("what did i jot down since 6 yesterday morning", rows("coop_q"),
    ref=[ans(kind="note", when=W({"from": U("day", -1, time="06:00")}))]),
  T("start of last month to the fifteenth of july, which notes",
    rows("calving", "min_jun", "min_jul", "book_list", "lame_cow", "fence_note"),
    ref=[ans(kind="note", when=W(span(U("month", -1), D("2026-07-15"))))]),
  T("are some sitting in a notebook", rows("calving", "min_jun", "min_jul", "book_list", "lame_cow"),
    ref=[ans(within="@prev", where="notebook count > 0")]),
  T("gaa people with a single note or none about them", rows("eileen"),
    ref=[ans(kind="person", where='role contains "GAA" and note count <= 1')]))

S("T11-063-P", "five turns school list subtasks complete event reschedule para",
  T("tasks on the school list?", rows("books", "tour_dep", "labels", "swim"),
    ref=[ans(kind="task", linked_to="$school_l")]),
  T("book ones, which have been finished", rows("books_roisin"),
    ref=[ans(kind="task", linked_to="$books", where='status = "completed"')]),
  T("cian's books are sorted, mark them complete", diff(upd("books_cian", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Cian's books")]),
  T("what time is the uniform shopping", rows("uniforms"),
    ref=[ans(kind="event", name="Uniform shopping")]),
  T("make it friday, same time slot", diff(upd("uniforms", date="2026-07-31T14:00")),
    ref=[act("reschedule", rows="$uniforms", args=lines(to=U("week", 1, weekday=5, time="14:00")))]))

S("T11-068-P", "list area set != club tasks para",
  T("lists where the area is set and it's not farm", rows("house_l", "club_l", "school_l"),
    ref=[ans(kind="list", where='area is set and area != "farm"')]),
  T("tasks under club", rows("raffle", "jerseys", "minutes_jul", "pitch", "lotto_sell"),
    ref=[ans(kind="task", linked_to="$club_l")]))

S("T11-073-P", "document weekday time star prev para",
  T("friday 10 o'clock, which document did i save", rows("scc_report"),
    ref=[ans(kind="document", when=W(U("week", 0, weekday=5, time="10:00")))]),
  T("give it a star", diff(upd("scc_report", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("wednesday half 10 one?", rows("tams_doc"),
    ref=[ans(kind="document", when=W(U("week", 0, weekday=3, time="10:30")))]))

S("T11-078-P", "six turns notes open span body != notebook count empty already pinned dead end para",
  T("which notes came after 6am on the twentieth", rows("blank", "quote_note", "orla_tips", "coop_q"),
    ref=[ans(kind="note", when=W({"from": D("2026-07-20", "06:00")}))]),
  T("only those not marked tbc", rows("quote_note", "orla_tips", "coop_q"),
    ref=[ans(within="@prev", where='body != "tbc"')]),
  T("do any belong to a notebook", rows(),
    ref=[ans(kind="note", within="@prev", where="notebook count > 0")]),
  T("now start of last month through the first of july", rows("min_jun", "calving", "book_list"),
    ref=[ans(kind="note", when=W(span(U("month", -1), D("2026-07-01"))))]),
  T("calving one should be pinned", rows("calving", also=diff(already=["calving"])),
    ref=[act("edit", rows="$calving", args=lines(pinned="yes")),
         ans(rows="$calving")]),
  T("got anything on the solar panels in notes", decline("not_found"),
    ref=[ans(kind="note", name="solar panels"),
         search("solar panels"),
         dec("not_found")]))

S("T11-083-P", "single ask without options para",
  T("accounts meeting needs shifting", ask(),
    ref=[askc("to when?")]))

S("T11-089-P", "group currency delete group dead end other kind para",
  T("euro groups, what are they", rows("lotto", "juvenile", "tour", "silage_coop", "tanker"),
    ref=[ans(kind="group", where='currency = "EUR"')]),
  T("get rid of the silage co-op one, it never got used",
    diff(gone("silage_coop"), unlink("silage_coop", "mick"), unlink("silage_coop", "sean_m"),
         unlink("silage_coop", "me")),
    ref=[act("delete", kind="group", name="Silage co-op 2025")]),
  T("what day is the NCT on", rows("nct"),
    ref=[find(kind="event", name="NCT"),
         ans(rows="$nct")]))

S("T11-094-P", "five turns find-only date reschedule where month span effort complete para",
  T("what falls due on the first of august", rows("raffle", "swim", "nuts_08"),
    ref=[find(kind="task", when=W(D("2026-08-01"))),
         ans(rows="@prev")]),
  T("club's one needs to go to monday week", diff(upd("raffle", date="2026-08-03")),
    ref=[act("reschedule", kind="task", when=W(D("2026-08-01")), linked_to="$club_l",
             args=lines(to=U("week", 2, weekday=1)))]),
  T("july first up to next monday, tasks still not done",
    rows("esb_07", "milk_stmt", "troughs", "call_mam", "tb_prep", "tb_pen", "tb_tags", "herd_reg", "vet_calves"),
    ref=[ans(kind="task", when=W(span(U("month", 0, name=7), U("week", 1, weekday=1))), where='status = "open"')]),
  T("among those, the ones taking fifteen mins tops", rows("esb_07", "call_mam", "herd_reg", "vet_calves"),
    ref=[ans(within="@prev", where="effort <= 15")]),
  T("esb one's been paid, tick it", diff(upd("esb_07", status="completed", completed=ANY)),
    ref=[act("complete", rows="$esb_07")]))

S("T11-099-P", "ambiguous person star ask para",
  T("give sean a star", ask("sean_m", "sean_h"),
    ref=[act("star", kind="person", name="Sean"),
         askc("sean mahon the contractor or sean hehir from the club?", options="$sean_m, $sean_h")]),
  T("the club chairman, hehir", diff(upd("sean_h", starred=True)),
    ref=[act("star", rows="$sean_h")]))

S("T11-A005-P", "ask-options note delete never_mind c3a para",
  T("committee minutes, get rid of them", ask("min_jun", "min_jul"),
    ref=[act("delete", kind="note", name="committee minutes"),
         askc("The June minutes or the July ones?", options="$min_jun, $min_jul")]),
  T("hang on, keep them, secretary wants both copies", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T11-B001-P", "c3b superlative event next three training count para",
  T("upcoming three u12 trainings", rows("u12_0729", "u12_0805", "u12_0812", order=True),
    ref=[ans(kind="event", name="U12 hurling training", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("total left, how many", val(5),
    ref=[ans(op="count", kind="event", name="U12 hurling training", when=W({"from": U("day", 0)}))]))

S("T11-C002-P", "c3c compound add_to add_to separate targets para",
  T("scc report goes into herd records, fencing quote into department",
    diff(link("herd_f", "scc_report"), link("dept_f", "fence_quote")),
    ref=[act("add_to", kind="document", name="SCC report", args=lines(to="$herd_f"), more=True),
         act("add_to", kind="document", name="Fencing quote", args=lines(to="$dept_f"))]))

S("T11-103-P", "ask june statement star pick already-so star para",
  T("june statement, star it", diff(upd("bank_stmt", starred=True)),
    ref=[act("star", kind="document", name="statement")]),
  T("house insurance policy next", diff(already=["house_policy"]),
    ref=[act("star", kind="document", name="House insurance policy"), ans(rows="$house_policy")]))

S("T11-108-P", "repair balance two sean ask pick balance substitution para",
  T("sean, what do i owe him", ask("sean_m", "sean_h"),
    ref=[bad(ans(op="balance", kind="person", name="Sean")),
         askc("sean mahon the silage man or sean hehir from the club?", options="$sean_m, $sean_h")]),
  T("mahon?", val((-850, "EUR")),
    ref=[ans(op="balance", rows="$sean_m")]),
  T("hehir?", val((-20, "EUR")),
    ref=[ans(op="balance", rows="$sean_h")]))

S("T11-113-P", "ask login username reveal pick para",
  T("password for the IE5512890 login, give it to me", ask("icbf", "agfood"),
    ref=[act("reveal", kind="locker item", where='username = "IE5512890"', args=lines(field="password")),
         askc("icbf herd account or agfood.ie? both use that username", options="$icbf, $agfood")]),
  T("the icbf one", diff(reveal=[("icbf", "Friesian214!")]),
    ref=[act("reveal", rows="$icbf", args=lines(field="password"))]))
