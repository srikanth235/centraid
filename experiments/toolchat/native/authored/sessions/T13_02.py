from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T13-026", "six turns next week span reschedule create task reschedule new",
  T("what's on next week",
    rows("gym", "group_0907", "xrd_0908", "helen_0909", "jc_0909", "committee", "landlord", "badminton_0911", "walk",
         "mumcall_0913"),
    ref=[ans(kind="event", when=W(U("week", 1)))]),
  T("just monday to wednesday", rows("gym", "group_0907", "xrd_0908", "helen_0909", "jc_0909"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]),
  T("move supervisor meeting with helen to the day after, same time", diff(upd("helen_0909", date="2026-09-10T11:00")),
    ref=[act("reschedule", rows="$helen_0909", args=lines(to=U("day", 1, anchor="row")))]),
  T("and add a task to prep slides for it, due wednesday",
    diff(new("task", name=has("slides"), date="2026-09-09")),
    ref=[act("create", args=lines(kind="task", name="Prep slides for Helen", date=U("week", 1, weekday=3)))]),
  T("make that due tuesday", diff(upd("+1", date="2026-09-08")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 1, weekday=2)))]),
  T("what's due tuesday now", rows("+1"),
    ref=[ans(kind="task", when=W(U("week", 1, weekday=2)))]))

S("T13-027", "create task reschedule new",
  T("remind me to email raj about the detector tomorrow",
    diff(new("task", name=has("Raj", "detector"), date="2026-09-04")),
    ref=[act("create", args=lines(kind="task", name="Email Raj about the detector", date=U("day", 1)))]),
  T("no wait, friday next week", diff(upd("+1", date="2026-09-11")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 1, weekday=5)))]))

S("T13-028", "notebook notes remove_from where person count",
  T("notes in lab notebook 2025", rows("first_films", "solgel_note"),
    ref=[ans(kind="note", linked_to="$lab25")]),
  T("pull the humidity one out of it", diff(unlink("lab25", "first_films")),
    ref=[act("remove_from", kind="note", where='body contains "humidity"', args=lines(from_="$lab25")),
         act("remove_from", rows="$first_films", args=lines(from_="$lab25"))]),
  T("which notes in thesis ideas aren't tagged with anyone", rows("tolerance", "outline", "grant_note"),
    ref=[ans(kind="note", linked_to="$thesis_nb", where="person count = 0")]))

S("T13-029", "remove_from note where body in",
  T("take the tbc note out of thesis ideas", diff(unlink("thesis_nb", "grant_note")),
    ref=[act("remove_from", kind="note", linked_to="$thesis_nb", where='body = "tbc"', args=lines(from_="$thesis_nb"))]),
  T("which notes say tbc or draft", rows("seminar_note", "grant_note", "abstract_note"),
    ref=[ans(kind="note", where='body in ("tbc", "draft")')]))

S("T13-030", "edit document where time folder linked exclude",
  T("could you rename the doc i saved yesterday at 4:40 to Poster final", diff(upd("poster_v2", name="Poster final")),
    ref=[act("edit", kind="document", when=W(U("day", -1, time="16:40")), args=lines(name="Poster final"))]),
  T("which folder's it in", rows("conf_f"),
    ref=[ans(kind="folder", linked_to="$poster_v2")]),
  T("what's else in there", rows("acceptance", "hotel_booking", "poster_v2"),
    ref=[ans(kind="document", linked_to="$conf_f")]))

S("T13-031", "documents named month edit where",
  T("docs from august", rows("stipend_aug", "hotel_booking", "litrev_d3", "methods_outline", "payslip_aug"),
    ref=[ans(kind="document", when=W(U("month", 0, name=8)))]),
  T("the payslip one, rename it Payslip Aug 2026", diff(upd("payslip_aug", name="Payslip Aug 2026")),
    ref=[act("edit", kind="document", when=W(U("month", 0, name=8)), linked_to="$payslips_f",
             args=lines(name="Payslip Aug 2026"))]))

S("T13-032", "documents since monday trashed doc restore window refused",
  T("any docs added since monday", rows("litrev_d3", "payslip_aug", "poster_v2", "boarding"),
    ref=[ans(kind="document", when=W({"from": U("week", 0, weekday=1)}))]),
  T("did i delete my old cv", rows("old_cv"),
    ref=[find(kind="document", name="Old CV"), ans(rows="$old_cv")]),
  T("can you put it back", rows("old_cv"),
    ref=[bad(act("restore", rows="$old_cv")), ans(rows="$old_cv")]))

S("T13-033", "documents month to datetime span within folder",
  T("documents from the start of july through to 10pm on 5 aug",
    rows("deposit_cert", "inventory", "stipend_jul", "acceptance", "payslip_jul", "hotel_booking"),
    ref=[ans(kind="document", when=W(span(U("month", 0, name=7), D("2026-08-05", "22:00"))))]),
  T("which of those are tenancy ones", rows("deposit_cert", "inventory"),
    ref=[ans(within="@prev", linked_to="$tenancy_f")]))

S("T13-034", "photos datetime to weekday album count",
  T("pics from movie night, twenty-first aug 7pm on, through last sunday",
    rows("p_movie", "p_suya", "p_whiteboard", "p_garden", "p_seun", "p_bbq", "p_meter", "p_films"),
    ref=[ans(kind="photo", when=W(span(D("2026-08-21", "19:00"), U("week", -1, weekday=7))))]),
  T("and of those, which haven't made it into an album", rows("p_whiteboard", "p_seun", "p_meter"),
    ref=[ans(within="@prev", where="album count = 0")]),
  T("and the ones that are", rows("p_movie", "p_suya", "p_garden", "p_bbq", "p_films"),
    ref=[ans(within="@1", where="album count != 0")]))

S("T13-035", "photos open to weekday person count",
  T("starred photos from before last monday",
    rows("p_mum_kitchen", "p_family", "p_committee", "p_kinder", "p_graduation"),
    ref=[ans(kind="photo", when=W({"to": U("week", -1, weekday=1)}), where="starred = yes")]),
  T("the group shots, three or more people", rows("p_family", "p_committee"),
    ref=[ans(within="@prev", where="person count >= 3")]))

S("T13-036", "photos datetime date open star",
  T("photos from 8pm on the twenty-first of aug to the twenty-second", rows("p_movie", "p_suya"),
    ref=[find(kind="photo", when=W(span(D("2026-08-21", "20:00"), D("2026-08-22")))), ans(rows="@prev")]),
  T("who's in the crowd one", rows("chinedu", "tunde"),
    ref=[ans(kind="person", linked_to="$p_movie")]),
  T("open suya at the social", rows("p_suya"),
    ref=[opn("$p_suya"), ans(rows="$p_suya")]),
  T("star that", diff(upd("p_suya", starred=True)),
    ref=[act("star", rows="$p_suya")]))

S("T13-037", "open event reschedule",
  T("tell me everything about the landlord inspection", rows("landlord"),
    ref=[opn("$landlord"), ans(rows="$landlord")]),
  T("gary rang, he can only do 2pm. move it, log the call, cancel badminton that evening and show me that friday",
    rows("landlord", "badminton_0911",
         also=diff(upd("landlord", date="2026-09-11T14:00"), upd("gary", date=ANY),
                   upd("badminton_0911", status="cancelled"))),
    ref=[act("reschedule", rows="$landlord", args=lines(to=U("day", 0, anchor="row", time="14:00")), more=True),
         act("log", rows="$gary", args=lines(kind="call"), more=True),
         act("cancel", kind="event", name="Badminton at the Armitage", when=W(U("week", 1, weekday=5)), more=True),
         ans(kind="event", when=W(U("week", 1, weekday=5)))]))

S("T13-038", "debts last month status amount unit",
  T("debts from last month", rows("d_tom_h", "d_priya", "d_kasia", "d_wei", "d_seun", "d_lukas", "d_tunde"),
    ref=[ans(kind="debt", when=W(U("month", -1)))]),
  T("only the ones not settled", rows("d_tom_h", "d_priya", "d_kasia", "d_wei", "d_tunde"),
    ref=[ans(within="@prev", where='status != "settled"')]),
  T("and 20 quid or more", rows("d_kasia", "d_wei", "d_tunde"),
    ref=[ans(within="@prev", where="amount >= 20 GBP")]),
  T("smallest of those?", rows("d_tunde"),
    ref=[ans(within="@prev", order="amount asc", limit=1)]))

S("T13-039", "debts span month named max",
  T("who did i lend money to from two months ago through august",
    rows("d_chinedu", "d_tom_h", "d_kasia", "d_seun", "d_lukas", "d_tunde"),
    ref=[ans(kind="debt", when=W(span(U("month", -2), U("month", 0, name=8))), where='direction = "owes_me"')]),
  T("biggest of those", rows("d_chinedu"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T13-040", "debts weekday span sum",
  T("anything i borrowed or lent between last monday and this wednesday",
    rows("d_tom_h", "d_wei", "d_tom_b", "d_fatima", "d_emeka", "d_lukas", "d_tunde"),
    ref=[ans(kind="debt", when=W(span(U("week", -1, weekday=1), U("week", 0, weekday=3))))]),
  T("total of what i owe in that lot", val((50, "GBP")),
    ref=[ans(op="sum", field="amount", within="@prev", where='direction = "i_owe"')]))

S("T13-041", "groups currency members balance decline five turns",
  T("which groups aren't in pounds", rows("family", "lisbon"),
    ref=[ans(kind="group", where='currency != "GBP"')]),
  T("the euro one?", rows("lisbon"),
    ref=[ans(kind="group", where='currency contains "EUR"')]),
  T("who's in it", rows("wei", "fatima", "me"),
    ref=[ans(kind="person", linked_to="$lisbon")]),
  T("where am i in it", val((-116, "EUR")),
    ref=[ans(op="balance", kind="group", name="Lisbon conference", linked_to="$me")]),
  T("send wei 50 euros from my monzo", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T13-042", "cadence unit contacted before weekday log",
  T("who've i set to catch up with every two weeks or less often",
    rows("dad", "obinna", "aunty_ngozi", "nkechi", "helen", "tom_b", "fatima", "chinedu", "ngozi_e", "seun", "daniel"),
    ref=[ans(kind="person", where="cadence >= 14 days")]),
  T("which of them haven't i spoken to since before last monday",
    rows("dad", "aunty_ngozi", "nkechi", "ngozi_e", "seun", "daniel"),
    ref=[ans(within="@prev", when=W({"to": U("week", -1, weekday=1)}))]),
  T("log a call with dad, spoke earlier", diff(upd("dad", date=ANY)),
    ref=[act("log", rows="$dad", args=lines(kind="call"))]))

S("T13-043", "met is set refused unit repair",
  T("who have i got a 'met' note for",
    rows("mum", "dad", "nkechi", "tom_h", "priya", "kasia", "helen", "lukas", "seun", "daniel", "hassan"),
    ref=[ans(kind="person", where="met is set")]),
  T("which of those am i meant to talk to more often than every two weeks", rows("mum"),
    ref=[bad(ans(within="@prev", where="cadence < 2 weeks")), ans(within="@prev", where="cadence < 14 days")]))

S("T13-044", "contacted since date role not log named",
  T("who've i talked to since first sept", rows("chiamaka", "tom_h", "priya", "wei", "tom_b", "fatima", "emeka"),
    ref=[ans(kind="person", when=W({"from": D("2026-09-01")}))]),
  T("not counting housemates", rows("chiamaka", "wei", "tom_b", "fatima", "emeka"),
    ref=[ans(within="@prev", where='role != "housemate"')]),
  T("log a message with obinna nwosu too, texted him", diff(upd("obinna", date=ANY)),
    ref=[act("log", kind="person", name="Obinna Nwosu", args=lines(kind="message"))]))

S("T13-045", "contacted since datetime",
  T("who've i been in touch with since yesterday 6pm", rows("tom_h", "priya", "wei"),
    ref=[ans(kind="person", when=W({"from": U("day", -1, time="18:00")}))]),
  T("since tuesday 9am?", rows("chiamaka", "tom_b", "emeka", "fatima", "tom_h", "priya", "wei"),
    ref=[ans(kind="person", when=W({"from": U("week", 0, weekday=2, time="09:00")}))]),
  T("log a call with tom", ask("tom_h", "tom_b"),
    ref=[act("log", kind="person", name="Tom", args=lines(kind="call")),
         askc("tom hargreaves or tom bennett?", options="$tom_h, $tom_b")]),
  T("bennett, about the kettle money", diff(upd("tom_b", date=ANY)),
    ref=[act("log", rows="$tom_b", args=lines(kind="call"))]))

S("T13-046", "tasks subtasks effort completed",
  T("which tasks are broken into subtasks", rows("litrev", "methods", "flyer"),
    ref=[ans(kind="task", where="task count >= 1")]),
  T("anything open that's over two hours of work", rows("summarise", "figures", "solgel"),
    ref=[ans(kind="task", where='effort > 120 and status = "open"')]),
  T("what's due this month that's already done", rows("rent_09"),
    ref=[ans(kind="task", when=W(U("month", 0)), where="completed is set")]))

S("T13-047", "tasks date to datetime within list",
  T("what's due between saturday and sunday 8pm",
    rows("abstract", "send_mum", "garri", "rota", "bins", "xrd_analyse"),
    ref=[ans(kind="task", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7, time="20:00"))))]),
  T("which of those are house ones", rows("rota", "bins"),
    ref=[ans(within="@prev", linked_to="$house_l")]))

S("T13-048", "tasks date to named month priority substitution",
  T("anything high priority due from the fifteenth through october", rows("litrev", "flights", "figures", "review_form"),
    ref=[ans(kind="task", when=W(span(D("2026-09-15"), U("month", 0, name=10))), where="priority <= 2")]),
  T("and from november on?", rows("methods", "brp"),
    ref=[ans(kind="task", when=W({"from": U("month", 0, name=11)}), where="priority <= 2")]))

S("T13-049", "tasks open before datetime complete multi",
  T("anything due before sunday 8pm i haven't done",
    rows("ts_aug", "xrd_book", "loo_roll", "reply_aunty", "abstract", "send_mum", "garri", "rota", "bins"),
    ref=[ans(kind="task", when=W({"to": U("week", 0, weekday=7, time="20:00")}), where='status = "open"')]),
  T("mark toilet roll and garri done, got both at aldi",
    diff(upd("loo_roll", status="completed", completed=ANY), upd("garri", status="completed", completed=ANY)),
    ref=[act("complete", rows="$loo_roll, $garri")]))

S("T13-050", "notes week to datetime pinned edit multi",
  T("notes i wrote from last week up to yesterday noon",
    rows("anneal", "helen_fb", "min_aug", "house_rules", "lisbon_tips", "freshers_note", "call_note", "seminar_note",
         "xrd_notes"),
    ref=[ans(kind="note", when=W(span(U("week", -1), U("day", -1, time="12:00"))))]),
  T("which are pinned", rows("anneal"),
    ref=[ans(within="@prev", where="pinned = yes")]),
  T("unpin that and pin the xrd peaks one instead",
    diff(upd("anneal", pinned=False), upd("xrd_notes", pinned=True)),
    ref=[act("edit", rows="$anneal", args=lines(pinned="no"), more=True),
         act("edit", rows="$xrd_notes", args=lines(pinned="yes"))]),
  T("what's pinned now", rows("outline", "jollof_note", "xrd_notes"),
    ref=[ans(kind="note", where="pinned = yes")]))
