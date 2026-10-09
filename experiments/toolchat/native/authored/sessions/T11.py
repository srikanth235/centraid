from gold import *
import json

world("T11", "2026-07-26T07:30", "Siobhan Kelly", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T11-001", "event weekday reschedule named create overlap refused ask",
  T("what's on tuesday", rows("tb_test"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=2)))]),
  T("fergal rang, he wants it wednesday at 9 instead", diff(upd("tb_test", date="2026-07-29T09:00")),
    ref=[act("reschedule", rows="$tb_test", args=lines(to=U("week", 1, weekday=3, time="09:00")))]),
  T("put in a call with pat thursday at half 10 to go over the lame ones", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Call with Pat", date=U("week", 1, weekday=4, time="10:30")))),
         askc("hoof trimming runs 10 to 1 that thursday, so half 10 clashes. after 1?")]))

S("T11-002", "single complete task named",
  T("tick off send herd register to fergal, emailed it last night",
    diff(upd("herd_reg", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Send herd register to Fergal")]))

S("T11-004", "kid events linked reschedule anchor log named",
  T("what's aoife got coming up", rows("ortho", "show", "uniforms", "kilkee"),
    ref=[ans(kind="event", linked_to="$aoife", when=W({"from": U("day", 0)}))]),
  T("the orthodontist, who's that with", rows("aoife", "emer"),
    ref=[ans(kind="person", linked_to="$ortho")]),
  T("move it to 4, she has camogie till half 3", diff(upd("ortho", date="2026-07-29T16:00")),
    ref=[act("reschedule", rows="$ortho", args=lines(to=U("day", 0, anchor="row", time="16:00")))]),
  T("log a message to emer keating so", diff(upd("emer", date=ANY)),
    ref=[act("log", kind="person", name="Emer Keating", args=lines(kind="message"))]))

S("T11-005", "create person delete new linked",
  T("add a contact Paudie Hegarty, reseeding contractor", diff(new("person", name="Paudie Hegarty", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Paudie Hegarty", role="reseeding contractor"))]),
  T("ah no, orla says it's his brother does it. delete him", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("who's on the reseed job", rows("orla"),
    ref=[ans(kind="person", linked_to="$reseed")]))

S("T11-006", "trashed task empty recovery restore reschedule",
  T("what happened the yard light task", rows("yard_light"),
    ref=[ans(kind="task", name="yard light"),
         ans(kind="task", name="yard light", trashed=True)]),
  T("put it back and make it due friday week", diff(restore("yard_light")),
    ref=[act("restore", rows="$yard_light", more=True),
         act("reschedule", rows="$yard_light", args=lines(to=U("week", 2, weekday=5)))]))

S("T11-008", "role find log prev balance",
  T("who's the relief milker", rows("ger"),
    ref=[find(kind="person", where='role contains "relief"'),
         ans(rows="@prev")]),
  T("he did saturday morning for me, log a visit", diff(upd("ger", date=ANY)),
    ref=[act("log", rows="@prev", args=lines(kind="visit"))]),
  T("and where am i with him money wise", val((-180, "EUR")),
    ref=[ans(op="balance", rows="$ger")]))

S("T11-009", "role linked_to all debt",
  T("who's the mart manager", rows("tom"),
    ref=[find(kind="person", where='role contains "mart"'),
         ans(rows="@prev")]),
  T("has he paid me that weanling deposit", rows("d_tom"),
    ref=[ans(kind="debt", linked_to="@prev")]))

S("T11-010", "task tomorrow reschedule where effort",
  T("what's due tomorrow", rows("tb_prep", "tb_pen", "tb_tags", "herd_reg", "vet_calves"),
    ref=[ans(kind="task", when=W(U("day", 1)))]),
  T("the ten min one there, push it to tuesday", diff(upd("vet_calves", date="2026-07-28")),
    ref=[act("reschedule", kind="task", when=W(U("day", 1)), where="effort <= 10",
             args=lines(to=U("week", 1, weekday=2)))]))

S("T11-011", "create debt balance",
  T("gerry mulqueen owes me 40 for the co-op dinner tickets",
    diff(new("debt", name=has("dinner"), amount=40, direction="owes_me"), link("new", "gerry")),
    ref=[act("create", args=lines(kind="debt", name="Co-op dinner tickets", person="$gerry", amount="40",
                                  direction="owes_me"))]),
  T("what's his balance now", val((40, "EUR")),
    ref=[ans(op="balance", rows="$gerry")]))

S("T11-013", "ambiguous debt ask settle open debts",
  T("mark the silage bales paid", ask("d_sean_silage", "d_mick_silage"),
    ref=[act("settle_debt", kind="debt", name="silage bales"),
         askc("the 850 you owe sean mahon, or the 240 mick owes you?", options="$d_sean_silage, $d_mick_silage")]),
  T("the one i owe sean", diff(upd("d_sean_silage", status="settled")),
    ref=[act("settle_debt", rows="$d_sean_silage")]),
  T("what's left outstanding on my side", rows("d_fergal", "d_eileen", "d_ger", "d_mary_c", "d_mick_diesel"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T11-014", "star photo named",
  T("star the U12 team photo", diff(upd("p_u12_team", starred=True)),
    ref=[act("star", kind="photo", name="U12 team photo")]),
  T("and tadhgie's team talk one", diff(upd("p_tadhg_speech", starred=True)),
    ref=[act("star", kind="photo", name="team talk")]))

S("T11-015", "create event reschedule new list linked",
  T("put in a meeting with joe griffin about the herd insurance thursday at 2",
    diff(new("event", name=has("Joe"), date="2026-07-30T14:00")),
    ref=[act("create", args=lines(kind="event", name="Meeting with Joe Griffin", date=U("week", 1, weekday=4, time="14:00")))]),
  T("friday at 3 suits him better", diff(upd("+1", date="2026-07-31T15:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 1, weekday=5, time="15:00")))]),
  T("is renew herd insurance on a list", rows("paper_l"),
    ref=[ans(kind="list", linked_to="$herd_ins")]))

S("T11-016", "wifi read edit locker prev",
  T("wifi password?", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("rename it Farmhouse wifi 5G, new router came", diff(upd("wifi", name="Farmhouse wifi 5G")),
    ref=[act("edit", rows="@prev", args=lines(name="Farmhouse wifi 5G"))]))

S("T11-017", "note body literal body != linked",
  T("which notes did i leave as tbc", rows("lotto_rules", "blank"),
    ref=[ans(kind="note", where='body = "tbc"')]),
  T("and the gaa minutes ones that actually have something in them", rows("min_jun", "min_jul"),
    ref=[ans(kind="note", linked_to="$gaa_nb", where='body != "tbc"')]))

S("T11-019", "event named ambiguous person act resolve by context",
  T("when's the second cut silage", rows("silage2"),
    ref=[ans(kind="event", name="Second cut silage")]),
  T("log a call with sean, he confirmed it", diff(upd("sean_m", date=ANY)),
    ref=[find(kind="person", name="Sean"),
         act("log", rows="$sean_m", args=lines(kind="call"))]))

S("T11-020", "reschedule event named day read",
  T("move coffee with noreen to 3", diff(upd("noreen_coffee", date="2026-07-31T15:00")),
    ref=[act("reschedule", kind="event", name="Coffee with Noreen", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("anything else booked for that friday", rows("tb_read"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=5)), exclude="$noreen_coffee")]))

S("T11-021", "single search hit misspelled find-only",
  T("what's deirdre quinlavin's job", rows("deirdre"),
    ref=[search("quinlavin", kind="person"),
         ans(rows="@prev")]))

S("T11-022", "create notebook add_to note multi count where",
  T("new notebook called Bulk tank", diff(new("notebook", name="Bulk tank")),
    ref=[act("create", args=lines(kind="notebook", name="Bulk tank"))]),
  T("move the bulk tank quotes note and orla's advice into it", diff(link("+1", "quote_note"), link("+1", "orla_tips")),
    ref=[act("add_to", rows="$quote_note, $orla_tips", args=lines(to="$c1"))]),
  T("how many notes aren't in any notebook", val(4),
    ref=[ans(op="count", kind="note", where="notebook count = 0")]))

S("T11-023", "event linked span rel weekday",
  T("anything with fergal between now and next friday", rows("tb_test", "tb_read"),
    ref=[ans(kind="event", linked_to="$fergal", when=W(span(U("day", 0), U("week", 1, weekday=5))))]),
  T("and after that", rows("vet_scan"),
    ref=[ans(kind="event", linked_to="$fergal", when=W({"from": U("week", 2, weekday=1)}))]))

S("T11-024", "documents weekday add_to prev folder",
  T("what docs came in on friday", rows("scc_report", "supply_agree"),
    ref=[ans(kind="document", when=W(U("week", 0, weekday=5)))]),
  T("both of those are for brendan, stick them in bank and loans",
    diff(link("bank_f", "scc_report"), link("bank_f", "supply_agree")),
    ref=[act("add_to", rows="@prev", args=lines(to="$bank_f"))]))

S("T11-025", "create document folder star new",
  T("save a doc Fergal's invoice July in herd records",
    diff(new("document", name="Fergal's invoice July"), link("herd_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Fergal's invoice July", folder="$herd_f"))]),
  T("star it, need it for brendan", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]))
