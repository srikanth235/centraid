from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T11-026", "five turns documents starred unstar span folder count",
  T("which docs have i starred", rows("herd_register", "loan_offer", "house_policy", "milk_june"),
    ref=[ans(kind="document", where="starred = yes")]),
  T("unstar the milk statement june, brendan has it", diff(upd("milk_june", starred=False)),
    ref=[act("unstar", kind="document", name="Milk statement June")]),
  T("what docs did i add between monday last week and friday",
    rows("fence_quote", "ai_records", "loan_offer", "tams_doc", "scc_report", "supply_agree"),
    ref=[ans(kind="document", when=W(span(U("week", -1, weekday=1), U("week", 0, weekday=5))))]),
  T("which folders have more than 2 in them", rows("herd_f", "dept_f"),
    ref=[ans(kind="folder", where="document count > 2")]),
  T("how many in herd records exactly", val(3),
    ref=[ans(op="count", kind="document", linked_to="$herd_f")]))

S("T11-027", "locker username contains url empty unstar reveal",
  T("which logins have kelly in the username", rows("aib", "creamery"),
    ref=[ans(kind="locker item", where='username contains "kelly"')]),
  T("any logins with no website saved", rows("creamery"),
    ref=[ans(kind="locker item", where='type = "login" and url is empty')]),
  T("unstar ICMSA membership", diff(upd("icmsa", starred=False)),
    ref=[act("unstar", kind="locker item", name="ICMSA membership")]),
  T("show me the creamery portal password", diff(reveal=[("creamery", "Lahinch2019")]),
    ref=[act("reveal", rows="$creamery", args=lines(field="password"))]))

S("T11-028", "create task list remove_from new add_to new",
  T("add fix the calf pen gate to the farm list, due wednesday",
    diff(new("task", name=has("gate"), date="2026-07-29"), link("farm_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Fix the calf pen gate", date=U("week", 1, weekday=3), list="$farm_l"))]),
  T("hmm take it off the farm list", diff(unlink("farm_l", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$farm_l"))]),
  T("put it on house instead, declan's doing it", diff(link("house_l", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$house_l"))]))

S("T11-029", "knock-on list edit add_to moves task read",
  T("rename the paperwork list to Office and move renew house insurance onto it",
    diff(upd("paper_l", name="Office"), link("paper_l", "house_ins"), unlink("house_l", "house_ins")),
    ref=[act("edit", kind="list", name="Paperwork", more=True, args=lines(name="Office")),
         act("add_to", kind="task", name="Renew house insurance", args=lines(to="$paper_l"))]),
  T("what's on it now", rows("receipts", "herd_ins", "nitrates", "milk_stmt", "biss", "house_ins"),
    ref=[ans(kind="task", linked_to="$paper_l")]))

S("T11-030", "log named undo ledger not undone log named",
  T("log a visit from mick considine", diff(upd("mick", date=ANY)),
    ref=[act("log", kind="person", name="Mick Considine", args=lines(kind="visit"))]),
  T("undo that, it was mary not mick", diff(),
    ref=[act("undo")]),
  T("log it for mary considine", diff(upd("mary_c", date=ANY)),
    ref=[act("log", kind="person", name="Mary Considine", args=lines(kind="visit"))]))

S("T11-031", "single group currency literal",
  T("which groups are in sterling", rows("chelt"),
    ref=[ans(kind="group", where='currency = "GBP"')]))

S("T11-032", "ambiguous group act ask edit",
  T("rename the gaa group to GAA lotto 2026", ask("lotto", "juvenile"),
    ref=[act("edit", kind="group", name="GAA", args=lines(name="GAA lotto 2026")),
         askc("the club lotto or the juvenile fundraiser?", options="$lotto, $juvenile")]),
  T("the lotto one", diff(upd("lotto", name="GAA lotto 2026")),
    ref=[act("edit", rows="$lotto", args=lines(name="GAA lotto 2026"))]))

S("T11-033", "ambiguous group delete refused ask never mind",
  T("delete the gaa group", ask("lotto", "juvenile"),
    ref=[act("delete", kind="group", name="GAA"),
         askc("which one, the club lotto or the juvenile fundraiser?", options="$lotto, $juvenile")]),
  T("the juvenile one, the fundraiser's over", ask(),
    ref=[bad(act("delete", rows="$juvenile")),
         askc("it still has the cones and the bag pack float in it, so it can't be deleted. leave it?")]),
  T("leave it so", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T11-034", "add_to photo named undo link add_to count",
  T("add PJ on the old Massey to the farm album", diff(link("farm_al", "p_pj_tractor")),
    ref=[act("add_to", kind="photo", name="PJ on the old Massey", args=lines(to="$farm_al"))]),
  T("no undo that, put it in family instead", diff(unlink("farm_al", "p_pj_tractor"), link("family_al", "p_pj_tractor")),
    ref=[act("undo", more=True),
         act("add_to", rows="$p_pj_tractor", args=lines(to="$family_al"))]),
  T("how many in family", val(6),
    ref=[ans(op="count", kind="photo", linked_to="$family_al")]))

S("T11-035", "photos month span starred != star named person count within",
  T("photos from the start of may to the end of june",
    rows("p_comm_church", "p_comm_grans", "p_comm_family", "p_comm_cake", "p_silage1", "p_aoife_camogie",
         "p_pj_tractor", "p_cian_goal", "p_u12_team", "p_parlour"),
    ref=[ans(kind="photo", when=W(span(D("2026-05-01"), U("month", 0, name=6))))]),
  T("which of those haven't i starred",
    rows("p_comm_grans", "p_comm_family", "p_comm_cake", "p_silage1", "p_aoife_camogie", "p_pj_tractor",
         "p_u12_team", "p_parlour"),
    ref=[ans(within="@prev", where="starred != yes")]),
  T("star aoife's camogie final", diff(upd("p_aoife_camogie", starred=True)),
    ref=[act("star", kind="photo", name="Aoife's camogie final")]),
  T("of the unstarred ones which have one person or nobody in them",
    rows("p_comm_cake", "p_silage1", "p_aoife_camogie", "p_pj_tractor", "p_parlour"),
    ref=[ans(within="@2", where="person count <= 1")]))

S("T11-036", "unstar locker named starred read",
  T("unstar the aib debit card and tell me what's starred in the locker",
    rows("aib", "icmsa", also=diff(upd("debit", starred=False))),
    ref=[act("unstar", kind="locker item", name="AIB debit card", more=True),
         ans(kind="locker item", where="starred = yes")]),
  T("what's the long number on that card, need it for the co-op", diff(reveal=[("debit", "4921 5566 0034 7781")]),
    ref=[act("reveal", rows="$debit", args=lines(field="card_number"))]))

S("T11-037", "trashed task restore window ask create",
  T("is the slurry spreader task in the trash", rows("spreader"),
    ref=[ans(kind="task", name="slurry spreader", trashed=True)]),
  T("restore it, a lad from Scariff might want it", ask(),
    ref=[bad(act("restore", rows="$spreader")),
         askc("it's been in the bin since may, past the 30 days, so it can't come back. make a new task?")]),
  T("yeah, due end of august, farm list",
    diff(new("task", name=has("spreader"), date="2026-08-31"), link("farm_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Sell the old slurry spreader", date=D("2026-08-31"), list="$farm_l"))]))

S("T11-038", "note dead end trashed restore window ask create add_to",
  T("where's my grazing plan from last year", rows("old_grazing"),
    ref=[ans(kind="note", name="Grazing plan"),
         ans(kind="note", name="Grazing plan", trashed=True)]),
  T("get it back", ask(),
    ref=[bad(act("restore", rows="$old_grazing")),
         askc("it was binned on june 10th, past the 30 days, so it can't come back. start a fresh one?")]),
  T("yeah new note Grazing plan 2026, paddocks 1-16 on a 21 day rotation",
    diff(new("note", name="Grazing plan 2026", body=has("21 day"))),
    ref=[act("create", args=lines(kind="note", name="Grazing plan 2026", body="paddocks 1-16 on a 21 day rotation"))]),
  T("put it in grass budget", diff(link("grass_nb", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$grass_nb"))]))

S("T11-039", "trashed notes restore window multi repair restore add_to",
  T("deleted notes?", rows("old_grazing", "quiz_qs"),
    ref=[ans(kind="note", trashed=True)]),
  T("put the pair back from the trash", diff(restore("quiz_qs")),
    ref=[bad(act("restore", rows="$old_grazing, $quiz_qs")),
         act("restore", rows="$quiz_qs")]),
  T("stick the quiz one in gaa minutes", diff(link("gaa_nb", "quiz_qs")),
    ref=[act("add_to", rows="$quiz_qs", args=lines(to="$gaa_nb"))]))

S("T11-040", "create person log new span person delete new",
  T("add Sinead Talty, aoife's camogie coach, and log a message to her",
    diff(new("person", name="Sinead Talty", date=ANY)),
    ref=[act("create", more=True, args=lines(kind="person", name="Sinead Talty", role="camogie coach")),
         act("log", rows="$new", args=lines(kind="message"))]),
  T("who did i talk to from thursday at 12 up to saturday", rows("orla", "mam", "mary_c", "pj", "declan"),
    ref=[ans(kind="person", when=W(span(U("week", 0, weekday=4, time="12:00"), U("week", 0, weekday=6))))]),
  T("delete sinead, wrong number", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T11-041", "single ambiguous event ask",
  T("push the tb test back an hour", ask("tb_test", "tb_read"),
    ref=[act("reschedule", kind="event", name="TB test", args=lines(to=U("hour", 1, anchor="row"))),
         askc("the tb test on tuesday or the reading on friday?", options="$tb_test, $tb_read")]))

S("T11-042", "photo bin restore undo restore",
  T("what's in the photo trash", rows("p_blurry", "p_old_yard", "p_selfie"),
    ref=[ans(kind="photo", trashed=True)]),
  T("restore the selfie at the mart", diff(restore("p_selfie")),
    ref=[act("restore", rows="$p_selfie")]),
  T("undo, it's awful", diff(trash("p_selfie")),
    ref=[act("undo")]))

S("T11-043", "met empty edit multi",
  T("the gaa people with no met filled in", rows("sean_h", "eileen"),
    ref=[ans(kind="person", where='met is empty and role contains "GAA"')]),
  T("put clubhouse as met for both", diff(upd("sean_h", met="clubhouse"), upd("eileen", met="clubhouse")),
    ref=[act("edit", rows="$sean_h, $eileen", args=lines(met="clubhouse"))]))

S("T11-044", "event date time duration person count within",
  T("what's on at 9 on friday", rows("tb_read"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=5, time="09:00")))]),
  T("long ones next week, two hours or more", rows("tb_test", "hoof", "tb_read", "show"),
    ref=[bad(ans(kind="event", when=W(U("week", 1)), where="duration >= 2 hours")),
         ans(kind="event", when=W(U("week", 1)), where="duration >= 120")]),
  T("which of them have more than one person going", rows("show"),
    ref=[ans(within="@prev", where="person count > 1")]))

S("T11-045", "status != enum role log prev sum debt",
  T("u12 training this month that wasn't cancelled", rows("u12_0701", "u12_0715", "u12_0722", "u12_0729"),
    ref=[ans(kind="event", name="U12 training", when=W(U("month", 0)), where='status != "cancelled"')]),
  T("who's the coach again", rows("tadhg"),
    ref=[find(kind="person", where='role contains "coach"'),
         ans(rows="@prev")]),
  T("log a message to him, told him cian's off wednesday", diff(upd("tadhg", date=ANY)),
    ref=[act("log", rows="@prev", args=lines(kind="message"))]),
  T("how much does he owe me for jerseys", val((150, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", linked_to="$tadhg")]))

S("T11-046", "debt date span rel",
  T("any debts from the twelfth of july", rows("d_sean_silage"),
    ref=[ans(kind="debt", when=W(D("2026-07-12")))]),
  T("and the open ones from june through last week",
    rows("d_sean_silage", "d_mick_silage", "d_fergal", "d_eileen", "d_clodagh", "d_tom", "d_pj", "d_mick_diesel"),
    ref=[ans(kind="debt", when=W(span(U("month", -1), U("week", -1))), where='status = "open"')]),
  T("what about from wednesday up to 5 on friday", rows("d_tadhg", "d_mary_c"),
    ref=[ans(kind="debt", when=W(span(U("week", 0, weekday=3), U("week", 0, weekday=5, time="17:00"))))]))

S("T11-047", "task span priority set task count complete named",
  T("anything with a priority due between aug first and the end of next month",
    rows("bulk_tank", "calf_shed", "house_ins", "jerseys", "books", "cian_present"),
    ref=[ans(kind="task", when=W(span(D("2026-08-01"), U("month", 1))), where="priority is set")]),
  T("which of them have two or fewer subtasks", rows("calf_shed", "house_ins", "jerseys", "cian_present"),
    ref=[ans(within="@prev", where="task count <= 2")]),
  T("complete sort jerseys for the u12s, tadhg got them", diff(upd("jerseys", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Sort jerseys for the U12s")]))

S("T11-048", "find miss search miss decline multi-kind",
  T("have i a task about the milk quota", decline("not_found"),
    ref=[find(kind="task", name="milk quota"),
         search("milk quota"),
         dec("not_found")]),
  T("ok anything about the co-op", rows("coop_mtg", "coop_q"),
    ref=[ans(kind="task,event,note", name="co-op")]))

S("T11-049", "group members balance settle_up",
  T("who's in the cheltenham group", rows("declan", "noreen", "pj", "me"),
    ref=[ans(kind="person", linked_to="$chelt")]),
  T("where's noreen in it", val((-280, "GBP")),
    ref=[ans(op="balance", kind="group", name="Cheltenham 2026", linked_to="$noreen")]),
  T("she gave me the cash, settle her up", diff(settle=["Noreen Kelly"]),
    ref=[act("settle_up", rows="$noreen", args=lines(group="$chelt"))]),
  T("and declan kelly's?", val((360, "GBP")),
    ref=[ans(op="balance", kind="group", name="Cheltenham 2026", linked_to="$declan")]))

S("T11-050", "task linked reschedule where edit",
  T("what's martin down for", rows("fence"),
    ref=[ans(kind="task", linked_to="$martin")]),
  T("he can't do tuesday, push that job to thursday", diff(upd("fence", date="2026-07-30")),
    ref=[act("reschedule", kind="task", linked_to="$martin", args=lines(to=U("week", 1, weekday=4)))]),
  T("put a note on it that he's bringing the post driver", diff(upd("fence", description=has("post driver"))),
    ref=[act("edit", rows="$fence", args=lines(description="Martin bringing the post driver"))]))
