from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T11-051", "seven turns morning today tasks complete reschedule anchor balance empty",
  T("morning. what's on today", rows("draw_0726"),
    ref=[ans(kind="event", when=W(U("day", 0)))]),
  T("and tasks due today", rows("troughs", "call_mam"),
    ref=[ans(kind="task", when=W(U("day", 0)))]),
  T("done the troughs", diff(upd("troughs", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Check the water troughs")]),
  T("move the mam one to 7 this evening", diff(upd("call_mam", date="2026-07-26T19:00")),
    ref=[act("reschedule", rows="$call_mam", args=lines(to=U("day", 0, anchor="row", time="19:00")))]),
  T("what's on tomorrow", rows("ai_call"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("kevin's coming for that, do i owe him anything", val((0, "EUR")),
    ref=[ans(op="balance", rows="$kevin")]),
  T("grand. any jobs down for him", rows(),
    ref=[ans(kind="task", linked_to="$kevin")]))

S("T11-052", "six turns debts amount unit max min order settle sum",
  T("which debts owed to me are over 100 euro", rows("d_mick_silage", "d_tadhg", "d_tom"),
    ref=[ans(kind="debt", where='amount > 100 EUR and direction = "owes_me" and status = "open"')]),
  T("and the biggest open one each way", vgroups({"i_owe": (850, "EUR"), "owes_me": (240, "EUR")}),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]),
  T("smallest each way?", vgroups({"i_owe": (12, "EUR"), "owes_me": (25, "EUR")}),
    ref=[comp(op="min", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]),
  T("who's the 12 to", rows("mary_c"),
    ref=[find(kind="debt", where='direction = "i_owe" and status = "open"', order="amount asc", limit=1),
         ans(kind="person", linked_to="@prev")]),
  T("settle it, i dropped the money over", diff(upd("d_mary_c", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Eggs and brown bread")]),
  T("total i owe now", val((1435, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T11-053", "five turns direction set ambiguous debt ask settle balance",
  T("all my open debts, both ways",
    rows("d_sean_silage", "d_mick_silage", "d_fergal", "d_eileen", "d_clodagh", "d_tadhg", "d_ger", "d_mary_c",
         "d_tom", "d_pj", "d_mick_diesel"),
    ref=[ans(kind="debt", where='status = "open" and direction is set')]),
  T("settle the silage one", ask("d_sean_silage", "d_mick_silage"),
    ref=[act("settle_debt", kind="debt", name="silage"),
         askc("the bales you owe sean or the ones mick owes you?", options="$d_sean_silage, $d_mick_silage")]),
  T("micks, he paid me after mass", diff(upd("d_mick_silage", status="settled")),
    ref=[act("settle_debt", rows="$d_mick_silage")]),
  T("so where do i stand with him", val((-95, "EUR")),
    ref=[ans(op="balance", kind="person", linked_to="$d_mick_silage")]),
  T("i'll give him the diesel money today so mark that done too", diff(upd("d_mick_diesel", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Diesel from Mick")]))

S("T11-054", "find role linked_to all debt max create task",
  T("what debts have i with the neighbour who farms", rows("d_mick_silage", "d_mick_diesel"),
    ref=[find(kind="person", where='role contains "farmer"'),
         ans(kind="debt", linked_to="@prev")]),
  T("which is bigger", val((240, "EUR")),
    ref=[ans(op="max", field="amount", within="@prev")]),
  T("add a task to chase mick for the silage money friday", diff(new("task", name=has("Mick"), date="2026-07-31")),
    ref=[act("create", args=lines(kind="task", name="Chase Mick for the silage money", date=U("week", 1, weekday=5)))]))

S("T11-055", "trashed people restore window ask delete multi",
  T("which contacts are in the trash", rows("tony", "frank"),
    ref=[ans(kind="person", trashed=True)]),
  T("restore tony egan", diff(restore("tony")),
    ref=[act("restore", rows="$tony")]),
  T("and frank", ask(),
    ref=[find(kind="person", name="Frank", trashed=True),
         bad(act("restore", rows="$frank")),
         askc("frank was binned back in may, past the 30 days, so he can't come back. add him again?")]),
  T("no leave him. actually delete tony again and pat linnane, both retired",
    diff(trash("tony"), trash("pat")),
    ref=[act("delete", rows="$tony, $pat")]))

S("T11-056", "locker type edit prev star",
  T("what's the ssh key thing in the locker", rows("ssh"),
    ref=[ans(kind="locker item", where='type = "ssh_key"')]),
  T("add a note on it that its for the parlour pc only, and star it",
    diff(upd("ssh", notes=has("parlour"), starred=True)),
    ref=[act("edit", rows="@prev", more=True, args=lines(notes="for the parlour pc only")),
         act("star", rows="@prev")]))

S("T11-057", "notes open span date within notebook count note count",
  T("notes i made since 6 yesterday morning", rows("coop_q"),
    ref=[ans(kind="note", when=W({"from": U("day", -1, time="06:00")}))]),
  T("notes from the start of last month up to the fifteenth of july",
    rows("calving", "min_jun", "min_jul", "book_list", "lame_cow", "fence_note"),
    ref=[ans(kind="note", when=W(span(U("month", -1), D("2026-07-15"))))]),
  T("any of them filed under a notebook", rows("calving", "min_jun", "min_jul", "book_list", "lame_cow"),
    ref=[ans(within="@prev", where="notebook count > 0")]),
  T("which of the gaa crowd have one note or fewer about them", rows("eileen"),
    ref=[ans(kind="person", where='role contains "GAA" and note count <= 1')]))

S("T11-058", "create task add_to new week list complete write read",
  T("add book the vet for the heifer scan, due friday week, on the farm list",
    diff(new("task", name=has("scan"), date="2026-08-07"), link("farm_l", "new")),
    ref=[act("create", more=True, args=lines(kind="task", name="Book the vet for the heifer scan", date=U("week", 2, weekday=5))),
         act("add_to", rows="$new", args=lines(to="$farm_l"))]),
  T("what's on the farm list due next week", rows("tb_prep", "herd_reg", "fence", "minerals", "fert", "nuts_08"),
    ref=[ans(kind="task", linked_to="$farm_l", when=W(U("week", 1)))]),
  T("tick off order mineral buckets and tell me what's left open for next week",
    rows("tb_prep", "herd_reg", "fence", "fert", "nuts_08",
         also=diff(upd("minerals", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Order mineral buckets", more=True),
         ans(kind="task", linked_to="$farm_l", when=W(U("week", 1)), where='status = "open"')]))

S("T11-059", "create debt balance write read log",
  T("i owe clodagh barry 18 for the swimming togs, add that and tell me where i am with her",
    val((7, "EUR"), also=diff(new("debt", name=has("togs"), amount=18, direction="i_owe"), link("new", "clodagh"))),
    ref=[act("create", more=True, args=lines(kind="debt", name="Swimming togs", person="$clodagh", amount="18",
                                             direction="i_owe")),
         ans(op="balance", rows="$clodagh")]),
  T("log a message to her as well", diff(upd("clodagh", date=ANY)),
    ref=[act("log", rows="$clodagh", args=lines(kind="message"))]))

S("T11-060", "create event span date time reschedule new",
  T("book the parlour service with the dairymaster lad for monday week at 2",
    diff(new("event", name=has("Parlour"), date="2026-08-03T14:00")),
    ref=[act("create", args=lines(kind="event", name="Parlour service", date=U("week", 2, weekday=1, time="14:00")))]),
  T("what's on from tuesday week to the thursday at 5",
    rows("coop_mtg", "gaa_0804", "dentist", "u12_0805", "vet_scan", "mart_cull"),
    ref=[ans(kind="event", when=W(span(U("week", 2, weekday=2), U("week", 2, weekday=4, time="17:00"))))]),
  T("move the parlour service to the wednesday at 10 so", diff(upd("+1", date="2026-08-05T10:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 2, weekday=3, time="10:00")))]))

S("T11-061", "task month open span completed complete reschedule",
  T("what did i get done that was due since the start of july",
    rows("nuts_07", "vet_lame_t", "silage_book", "minutes_jul", "hoof_book", "mass_card", "books_roisin"),
    ref=[ans(kind="task", when=W({"from": U("month", 0, name=7)}), where='status = "completed"')]),
  T("and what's open from july first to today", rows("esb_07", "milk_stmt", "troughs", "call_mam"),
    ref=[ans(kind="task", when=W(span(U("month", 0, name=7), U("week", 0, weekday=7))), where='status = "open"')]),
  T("paid the esb online friday", diff(upd("esb_07", status="completed", completed=ANY)),
    ref=[act("complete", rows="$esb_07")]),
  T("push the milk statement one to tomorrow at 8", diff(upd("milk_stmt", date="2026-07-27T08:00")),
    ref=[act("reschedule", rows="$milk_stmt", args=lines(to=U("day", 1, time="08:00")))]))

S("T11-062", "notes no notebook add_to multi delete",
  T("notes that aren't in a notebook", rows("quote_note", "fence_note", "cian_ideas", "orla_tips", "coop_q", "blank"),
    ref=[ans(kind="note", where="notebook count = 0")]),
  T("put fencing and orla's advice in grass budget", diff(link("grass_nb", "fence_note"), link("grass_nb", "orla_tips")),
    ref=[act("add_to", rows="$fence_note, $orla_tips", args=lines(to="$grass_nb"))]),
  T("delete the untitled one and show me what's left outside a notebook",
    rows("quote_note", "cian_ideas", "coop_q", also=diff(trash("blank"))),
    ref=[act("delete", rows="$blank", more=True),
         ans(kind="note", where="notebook count = 0")]))

S("T11-063", "five turns school list subtasks complete event reschedule",
  T("what's on the school list", rows("books", "tour_dep", "labels", "swim"),
    ref=[ans(kind="task", linked_to="$school_l")]),
  T("which of the book ones are done", rows("books_roisin"),
    ref=[ans(kind="task", linked_to="$books", where='status = "completed"')]),
  T("tick off cian's books", diff(upd("books_cian", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Cian's books")]),
  T("when's the uniform shopping", rows("uniforms"),
    ref=[ans(kind="event", name="Uniform shopping")]),
  T("shift it to friday, same slot", diff(upd("uniforms", date="2026-07-31T14:00")),
    ref=[act("reschedule", rows="$uniforms", args=lines(to=U("week", 1, weekday=5, time="14:00")))]))

S("T11-064", "docs no folder add_to prev multi create document",
  T("any docs not filed in a folder yet", rows("milk_june", "scc_report", "fence_quote", "supply_agree"),
    ref=[ans(kind="document", where="folder count = 0")]),
  T("file all of them under bank and loans",
    diff(link("bank_f", "milk_june"), link("bank_f", "scc_report"), link("bank_f", "fence_quote"),
         link("bank_f", "supply_agree")),
    ref=[act("add_to", rows="@prev", args=lines(to="$bank_f"))]),
  T("and make a new doc Co-op supply agreement signed, in department",
    diff(new("document", name="Co-op supply agreement signed"), link("dept_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Co-op supply agreement signed", folder="$dept_f"))]))

S("T11-065", "unstar document named task read",
  T("unstar house insurance policy, renewed it", diff(upd("house_policy", starred=False)),
    ref=[act("unstar", kind="document", name="House insurance policy")]),
  T("when's the house insurance task due so", rows("house_ins"),
    ref=[bad(ans(kind="task", where='name contains "house insurance"')),
         ans(kind="task", name="house insurance")]))

S("T11-066", "create event reschedule new linked people",
  T("call with liam o'dea tomorrow at 9 about the quota",
    diff(new("event", name=has("Liam"), date="2026-07-27T09:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Liam O'Dea about the quota", date=U("day", 1, time="09:00")))]),
  T("can you make that 12 instead, he's milking late", diff(upd("+1", date="2026-07-27T12:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("day", 0, anchor="row", time="12:00")))]),
  T("who's going to the co-op meeting", rows("liam", "gerry"),
    ref=[ans(kind="person", linked_to="$coop_mtg")]))

S("T11-067", "single list area set",
  T("which lists have an area on them", rows("farm_l", "house_l", "club_l", "school_l"),
    ref=[ans(kind="list", where="area is set")]))

S("T11-068", "list area set != club tasks",
  T("lists with an area that isn't farm", rows("house_l", "club_l", "school_l"),
    ref=[ans(kind="list", where='area is set and area != "farm"')]),
  T("what's on club", rows("raffle", "jerseys", "minutes_jul", "pitch", "lotto_sell"),
    ref=[ans(kind="task", linked_to="$club_l")]))

S("T11-069", "person to datetime log cadence star",
  T("who haven't i been in touch with since before noon on the first of june", rows("brendan", "gerry"),
    ref=[ans(kind="person", when=W({"to": D("2026-06-01", "12:00")}))]),
  T("log a call with gerry, rang him about the agm", diff(upd("gerry", date=ANY)),
    ref=[act("log", kind="person", name="Gerry Mulqueen", args=lines(kind="call"))]),
  T("who am i meant to ring less than every 60 days", rows("brendan", "deirdre"),
    ref=[ans(kind="person", where="cadence > 60 days")]),
  T("star brendan", diff(upd("brendan", starred=True)),
    ref=[act("star", rows="$brendan")]))

S("T11-070", "person to datetime span date weekday",
  T("anyone i last spoke to before 9pm on the seventh of july", rows("kevin", "liam", "mary_l", "clodagh", "brendan", "gerry"),
    ref=[ans(kind="person", when=W({"to": D("2026-07-07", "21:00")}))]),
  T("and who from the first of july to wednesday",
    rows("sean_h", "noreen", "fergal", "sean_m", "mick", "tom", "eileen", "ger", "deirdre", "tadhg"),
    ref=[ans(kind="person", when=W(span(D("2026-07-01"), U("week", 0, weekday=3))))]))

S("T11-071", "event spans cancel named",
  T("what's on from today to saturday",
    rows("draw_0726", "ai_call", "tb_test", "ortho", "u12_0729", "hoof", "tb_read", "noreen_coffee", "show"),
    ref=[ans(kind="event", when=W(span(U("day", 0), U("week", 1, weekday=6))))]),
  T("cancel coffee with noreen, she's sick", diff(upd("noreen_coffee", status="cancelled")),
    ref=[act("cancel", kind="event", name="Coffee with Noreen")]),
  T("what's between monday week and 6pm the wednesday", rows("coop_mtg", "gaa_0804", "dentist"),
    ref=[ans(kind="event", when=W(span(U("week", 2, weekday=1), U("week", 2, weekday=3, time="18:00"))))]))

S("T11-072", "create notebook add_to count",
  T("make a notebook called Hurling and put the present ideas for cian note in it",
    diff(new("notebook", name="Hurling"), link("new", "cian_ideas")),
    ref=[act("create", more=True, args=lines(kind="notebook", name="Hurling")),
         act("add_to", rows="$cian_ideas", args=lines(to="$new"))]),
  T("how many notebooks have i", val(6),
    ref=[ans(op="count", kind="notebook")]))

S("T11-073", "document weekday time star prev",
  T("what doc did i save friday at 10", rows("scc_report"),
    ref=[ans(kind="document", when=W(U("week", 0, weekday=5, time="10:00")))]),
  T("star it", diff(upd("scc_report", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("and the one from wednesday at half 10", rows("tams_doc"),
    ref=[ans(kind="document", when=W(U("week", 0, weekday=3, time="10:30")))]))

S("T11-074", "document open spans within delete",
  T("docs since monday", rows("loan_offer", "tams_doc", "scc_report", "supply_agree"),
    ref=[ans(kind="document", when=W({"from": U("week", 0, weekday=1)}))]),
  T("which of them are starred", rows("loan_offer"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("and since monday of last week",
    rows("fence_quote", "ai_records", "loan_offer", "tams_doc", "scc_report", "supply_agree"),
    ref=[ans(kind="document", when=W({"from": U("week", -1, weekday=1)}))]),
  T("delete the fencing quote, martin sent a new one", diff(trash("fence_quote")),
    ref=[act("delete", kind="document", name="Fencing quote from Martin")]))

S("T11-075", "photo datetime spans add_to named",
  T("photos between 7 and half 8 on the fifteenth", rows("p_tadhg_speech"),
    ref=[ans(kind="photo", when=W(span(D("2026-07-15", "19:00"), D("2026-07-15", "20:30"))))]),
  T("any photos before 6am on feb first",
    rows("p_first_calf", "p_kilkee_beach", "p_kilkee_chips", "p_pollock", "p_xmas", "p_show_2025"),
    ref=[ans(kind="photo", when=W({"to": D("2026-02-01", "06:00")}))]),
  T("add chips on the prom to family", diff(link("family_al", "p_kilkee_chips")),
    ref=[act("add_to", kind="photo", name="Chips on the prom", args=lines(to="$family_al"))]))
