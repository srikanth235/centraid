from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T03-051", "compute group status cancelled delete",
  T("breakdown of the school list by status", vgroups({"open": 7, "in_progress": 2, "completed": 2, "cancelled": 1}),
    ref=[comp(op="count", group="status", kind="task", linked_to="$school"), ans(value="@prev")]),
  T("which one got cancelled", rows("invig_swap"),
    ref=[ans(kind="task", linked_to="$school", where='status = "cancelled"')]),
  T("delete swap invigilation with pedro", diff(trash("invig_swap")),
    ref=[act("delete", rows="$invig_swap")]))

S("T03-052", "min max find person",
  T("smallest amount anyone owes me", val((10, "EUR")),
    ref=[ans(op="min", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("biggest one on my side?", val((150, "EUR")),
    ref=[ans(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("who's that to", rows("marta"),
    ref=[find(kind="debt", where='direction = "i_owe" and status = "open"', order="amount desc", limit=1),
         ans(kind="person", linked_to="@prev")]))

S("T03-053", "find linked_to reschedule exclude confirm",
  T("move my next thing with bruno to 9pm", diff(upd("miguel_dinner", date="2026-10-16T21:00")),
    ref=[find(kind="event", linked_to="$bruno", when=W({"from": U("day", 0)}), order="date asc", limit=1),
         act("reschedule", rows="$miguel_dinner", args=lines(to=U("day", 0, anchor="row", time="21:00")))]),
  T("what else have i got with him", rows("classico"),
    ref=[ans(kind="event", linked_to="$bruno", when=W({"from": U("day", 0)}), exclude="$miguel_dinner")]),
  T("put tickets sorted in the notes for fc porto vs benfica", diff(upd("classico", description="tickets sorted")),
    ref=[act("edit", rows="$classico", args=lines(description="tickets sorted"))]))

S("T03-054", "weekend act within exclude count tentative",
  T("what's the weekend look like", rows("match_1017", "anniv", "handover_1018"),
    ref=[ans(kind="event", when=W({"from": U("week", 0, weekday=6), "to": U("week", 0, weekday=7)}))]),
  T("cancel all of it except dinner w jo, tiago's sick and staying at inês's",
    diff(upd("match_1017", status="cancelled"), upd("handover_1018", status="cancelled")),
    ref=[find(within="@prev", exclude="$anniv"), act("cancel", rows="@prev")]),
  T("how many things are actually on next week, tentative or confirmed", val(9),
    ref=[ans(op="count", kind="event", when=W(U("week", 1)), where='status in ("tentative", "confirmed")')]))

S("T03-055", "find trashed restore link count album create add_to",
  T("bring back cancel gym membership, i deleted it", diff(restore("gym")),
    ref=[find(kind="task", trashed=True), act("restore", rows="$gym")]),
  T("which photos aren't in any album", rows("whiteboard", "setup", "receipt_pic", "douro", "silver_tree", "foz"),
    ref=[ans(kind="photo", where="album count = 0")]),
  T("make an album School and put the whiteboard and titration ones in it",
    diff(new("album", name="School"), link("new", "whiteboard"), link("new", "setup")),
    ref=[act("create", more=True, args=lines(kind="album", name="School")),
         act("add_to", rows="$whiteboard, $setup", args=lines(to="$new"))]))

S("T03-056", "act linked_to write read cancel date",
  T("tick off the task for inês, sent the receipts. what's due this week",
    rows("luisa_budget", "boiler", "bibs_1015", "lab_10a", "first_aid", "trip_form", "kitty_collect", "joana_gift",
         "moodle", "tap", also=diff(upd("ines_receipts", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", linked_to="$ines", more=True),
         ans(kind="task", when=W(U("week", 0)), where='status in ("open", "in_progress")')]),
  T("and cancel training on the twenty-second, pavilion's taken", diff(upd("train_1022", status="cancelled")),
    ref=[act("cancel", kind="event", name="Futsal training", when=W(D("2026-10-22")))]))

S("T03-057", "act within ambiguity where",
  T("what's on the futsal list", rows("kitty_collect", "jerseys", "pavilion", "schedule_print", "first_aid", "ref_form",
                                     "bibs_0917", "bibs_0924", "bibs_1001", "bibs_1008", "bibs_1015"),
    ref=[ans(kind="task", linked_to="$futsal")]),
  T("first aid kit's restocked", diff(upd("first_aid", status="completed", completed=ANY)),
    ref=[act("complete", within="@prev", name="first aid")]),
  T("and i did wash training bibs", diff(upd("bibs_1015", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Wash training bibs"),
         act("complete", kind="task", name="Wash training bibs", where='status = "open"')]))

S("T03-058", "not_found substitute anchor hour",
  T("when's my barber appt", decline("not_found"),
    ref=[search("barber"), dec("not_found")]),
  T("ok when's the dentist check-up", rows("dentist"),
    ref=[ans(kind="event", name="Dentist check-up")]),
  T("move it an hour earlier", diff(upd("dentist", date="2026-11-04T08:00")),
    ref=[act("reschedule", rows="$dentist", args=lines(to=U("hour", -1, anchor="row")))]))

S("T03-059", "repair unshown row note edit",
  T("what's in my francesinha sauce note", rows("francesinha"),
    ref=[bad(opn("#99")), ans(kind="note", name="Francesinha sauce")]),
  T("add 2 cloves of garlic before the reduce bit",
    diff(upd("francesinha", body="beer, tomato, piri-piri, bay leaf, a shot of port, 2 cloves of garlic, reduce 40 minutes")),
    ref=[act("edit", rows="$francesinha",
             args=lines(body="beer, tomato, piri-piri, bay leaf, a shot of port, 2 cloves of garlic, reduce 40 minutes"))]))

S("T03-060", "ask photo pick star unstar",
  T("star the morro pic", ask("morro", "boat"),
    ref=[act("star", kind="photo", name="Morro"),
         askc("the beach at morro or the boat to morro?", options="$morro, $boat")]),
  T("boat to morro", diff(upd("boat", starred=True)),
    ref=[act("star", rows="$boat")]),
  T("and unstar sunset in barra", diff(upd("sunset_barra", starred=False)),
    ref=[act("unstar", kind="photo", name="Sunset in Barra")]))

S("T03-061", "where met role log multi",
  T("who do i know from feup", rows("miguel", "bruno"),
    ref=[ans(kind="person", where='met contains "FEUP"')]),
  T("and the colleagues", rows("pedro_a", "ana_rita", "nuno"),
    ref=[ans(kind="person", where='role contains "colleague"')]),
  T("log a coffee with all three, had one in the staff room",
    diff(upd("pedro_a", date=ANY), upd("ana_rita", date=ANY), upd("nuno", date=ANY)),
    ref=[act("log", rows="$pedro_a, $ana_rita, $nuno", args=lines(kind="coffee"))]))

S("T03-062", "where cadence nickname star",
  T("who am i meant to talk to at least weekly", rows("joana", "tiago", "ines", "graca", "pedro_a", "vitor"),
    ref=[ans(kind="person", where="cadence <= 7")]),
  T("which of them have a nickname", rows("joana", "graca", "vitor"),
    ref=[ans(kind="person", within="@prev", where="nickname is set")]),
  T("star vitinha", diff(upd("vitor", starred=True)),
    ref=[search("vitinha", kind="person"), act("star", rows="$vitor")]))

S("T03-063", "note where body pinned edit",
  T("which notes mention hydrogen peroxide", rows("toothpaste"),
    ref=[ans(kind="note", where='body contains "peroxide"')]),
  T("unpin elephant toothpaste", diff(upd("toothpaste", pinned=False)),
    ref=[act("edit", kind="note", name="Elephant toothpaste", args=lines(pinned="no"))]),
  T("what's still pinned", rows("lineup", "meds"),
    ref=[ans(kind="note", where="pinned = yes")]))

S("T03-064", "where link counts ask photo",
  T("who's in three or more of my pics", rows("tiago", "joana", "marta", "vitor", "graca"),
    ref=[ans(kind="person", where="photo count >= 3")]),
  T("and albums with more than 10", rows("brasil_album"),
    ref=[ans(kind="album", where="photo count > 10")]),
  T("star the one of thiago", ask("moqueca_pic", "thiago_pic"),
    ref=[find(kind="photo", linked_to="$thiago_o"),
         askc("moqueca night or the one on the terrace?", options="$moqueca_pic, $thiago_pic")]))

S("T03-065", "where container counts delete both",
  T("any empty folders", rows("scans_f"),
    ref=[ans(kind="folder", where="document count = 0")]),
  T("notebooks?", rows("old_nb"),
    ref=[ans(kind="notebook", where="note count = 0")]),
  T("delete old stuff and scans 2019", diff(gone("scans_f"), gone("old_nb")),
    ref=[act("delete", rows="$scans_f", more=True), act("delete", rows="$old_nb")]))

S("T03-066", "compute trashed restore complete",
  T("how much stuff is in the task delete, by status", vgroups({"open": 4}),
    ref=[comp(op="count", group="status", kind="task", trashed=True), ans(value="@prev")]),
  T("restore cancel gym membership", diff(restore("gym")),
    ref=[act("restore", kind="task", name="Cancel gym membership", trashed=True)]),
  T("and tick it off, cancelled it at the desk yesterday", diff(upd("gym", status="completed", completed=ANY)),
    ref=[act("complete", rows="$gym")]))

S("T03-067", "compute rows exclude where",
  T("every debt that's open", rows("d_balls", "d_books", "d_concert", "d_nuno", "d_glasses", "d_classico",
                                         "d_cones", "d_padel", "d_pharmacy", "d_fee"),
    ref=[ans(kind="debt", where='status = "open"')]),
  T("split by direction", vgroups({"owes_me": (179.4, "EUR"), "i_owe": (282.4, "EUR")}),
    ref=[comp(op="sum", field="amount", group="direction", rows="@prev"), ans(value="@prev")]),
  T("same but leave out mãe's pharmacy thing", vgroups({"owes_me": (140.9, "EUR"), "i_owe": (282.4, "EUR")}),
    ref=[bad(comp(op="sum", field="amount", group="direction", kind="debt", where='status = "open"', exclude="$d_pharmacy")),
         search("pharmacy", kind="debt"),
         comp(op="sum", field="amount", group="direction", kind="debt", where='status = "open"', exclude="$d_pharmacy"),
         ans(value="@prev")]))

S("T03-068", "search log multi-row decline",
  T("had lunch at mãe's, log a visit w her and teresa", diff(upd("graca", date=ANY), upd("teresa", date=ANY)),
    ref=[search("mãe", kind="person"), act("log", rows="$graca, $teresa", args=lines(kind="visit"))]),
  T("and text marta that i've paid for the glasses", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T03-069", "event create span note read repair add_to",
  T("book team photos sat after the match, 11:30 to 12",
    diff(new("event", name=has("photo"), date="2026-10-17T11:30", duration=30)),
    ref=[act("create", args=lines(kind="event", name="Team photos",
                                  date={"from": D("2026-10-17", "11:30"), "to": D("2026-10-17", "12:00")}))]),
  T("what's the starting five", rows("lineup"),
    ref=[ans(kind="note", name="Starting five")]),
  T("put the team photo in tiago's album", diff(link("tiago_album", "team_pic")),
    ref=[bad(act("add_to", kind="photo", name="Team photo 2026-27", args=lines(album="$tiago_album"))),
         act("add_to", kind="photo", name="Team photo 2026-27", args=lines(to="$tiago_album"))]))

S("T03-070", "subtask create linked complete",
  T("add a subtask under plan tiago's party: buy balloons",
    diff(new("task", name=has("balloons")), link("party", "new")),
    ref=[act("create", args=lines(kind="task", name="Buy balloons", parent="$party"))]),
  T("what's under it now", rows("invites", "cake", "bowling", "+1"),
    ref=[ans(kind="task", linked_to="$party")]),
  T("did send party invites today", diff(upd("invites", status="completed", completed=ANY)),
    ref=[act("complete", rows="$invites")]))

S("T03-071", "month name narrowing priority",
  T("what's due in november", rows("slides", "scripts_11", "service", "party", "gift", "cake", "run", "car_ins", "mae_irs"),
    ref=[ans(kind="task", when=W(U("month", 0, name=11)))]),
  T("any of those high priority", rows("slides", "gift"),
    ref=[ans(kind="task", within="@prev", where="priority >= 1 and priority <= 2")]))

S("T03-072", "count last month repair reveal",
  T("how many tasks due last month did i actually get done", val(5),
    ref=[ans(op="count", kind="task", when=W(U("month", -1)), where='status = "completed"')]),
  T("what's the caixa debit card number", diff(reveal=[("cgd_card", "4176 5500 1234 8890")]),
    ref=[bad(act("reveal", kind="card", name="Caixa debit card", args=lines(field="card_number"))),
         act("reveal", kind="locker item", name="Caixa debit card", args=lines(field="card_number"))]))

S("T03-073", "hour create minute anchor when weekday",
  T("remind me in an hour to text inês about sunday",
    diff(new("task", name=has("inês"), date="2026-10-14T22:10")),
    ref=[act("create", args=lines(kind="task", name="Text Inês about Sunday", date=U("hour", 1)))]),
  T("and push tiago to inês's half an hour later", diff(upd("handover_1018", date="2026-10-18T18:30")),
    ref=[act("reschedule", kind="event", name="Tiago to Inês's", when=W(U("week", 0, weekday=7)),
             args=lines(to=U("minute", 30, anchor="row")))]))

S("T03-074", "year unit narrowing linked",
  T("photos from last year", rows("bday10", "xmas"),
    ref=[ans(kind="photo", when=W(U("year", -1)))]),
  T("which one's got mãe in it", rows("xmas"),
    ref=[search("mãe", kind="person"), ans(kind="photo", within="@1", linked_to="$graca")]))

S("T03-075", "date spans mixed ends",
  T("mãe stuff from monday to the thirtieth", rows("physio_1019", "cardio_fu", "physio_1026"),
    ref=[ans(kind="event", name="Mãe", when=W({"from": U("week", 1, weekday=1), "to": D("2026-10-30")}))]),
  T("and from first nov till the end of that month",
    rows("physio_1102", "mae_eyes", "physio_1109", "cardio_echo", "physio_1116", "physio_1123"),
    ref=[ans(kind="event", name="Mãe", when=W({"from": D("2026-11-01"), "to": U("month", 1)}))]),
  T("anything cancelled since the third up to next sunday", rows("train_1008", "physio_1012", "futsal_parents"),
    ref=[ans(kind="event", when=W({"from": D("2026-10-03"), "to": U("week", 1, weekday=7)}), where='status = "cancelled"')]))


X("T03-051",
  T("of the 3 biggest open jobs by effort, how many have i started", vgroups({"open": 3}),
    ref=[comp(op="count", group="status", kind="task", where='status in ("open", "in_progress")', order="effort desc", limit=3),
         ans(value="@prev")]))

X("T03-052",
  T("paid mãe's glasses, my half back today", diff(upd("d_glasses", status="settled")),
    ref=[act("settle_debt", rows="$d_glasses")]))

X("T03-054",
  T("and bring back the padel w ricky i deleted", diff(restore("padel")),
    ref=[search("padel", kind="event"), act("restore", kind="event", name="Padel with Ricky", trashed=True)]))

X("T03-055",
  T("which lists are under work", rows("school"),
    ref=[ans(kind="list", where='area = "work"')]))


X("T03-057",
  T("which bibs ones did i do from september to the tenth", rows("bibs_0917", "bibs_0924", "bibs_1001", "bibs_1008"),
    ref=[ans(kind="task", name="Wash training bibs", where="completed is set",
             when=W({"from": U("month", 0, name=9), "to": D("2026-10-10")}))]))


X("T03-059",
  T("any other notes with garlic", rows("francesinha"),
    ref=[ans(kind="note", where='body contains "garlic"')]),
  T("log a call w ana", ask("ana_rita", "ana_lopes"),
    ref=[act("log", kind="person", name="Ana", args=lines(kind="call")),
         askc("ana rita or dra. lopes?", options="$ana_rita, $ana_lopes")]))

X("T03-060",
  T("what other pics are starred, from last year up to august", rows("farol", "capoeira", "mae_bday", "boat"),
    ref=[ans(kind="photo", where="starred = yes", when=W({"from": U("year", -1), "to": U("month", 0, name=8)}))]))

X("T03-061",
  T("and who's zé again", rows("ze"),
    ref=[ans(kind="person", where='nickname = "Zé"')]))


X("T03-063",
  T("make up a password that looks like my old solinca one, i forgot it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

X("T03-064",
  T("with thiago on the terrace", diff(upd("thiago_pic", starred=True)),
    ref=[act("star", rows="$thiago_pic")]))


X("T03-066",
  T("which of mãe's list is done, from july up to this friday", rows("scripts_07", "scripts_08", "scripts_09", "scripts_10"),
    ref=[ans(kind="task", linked_to="$mae_list", where="completed is set",
             when=W({"from": U("month", 0, name=7), "to": U("week", 0, weekday=5)}))]))

X("T03-067",
  T("how much are the open ones over 50 all together", val((277.4, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", where='amount > 50 EUR and status = "open"')]))


X("T03-069",
  T("lists with more than five things on them that aren't work", rows("home", "futsal", "mae_list"),
    ref=[ans(kind="list", where='task count > 5 and area != "work"')]))


X("T03-071",
  T("break those down by status", vgroups({"open": 8, "in_progress": 1}),
    ref=[comp(op="count", group="status", within="@1"), ans(value="@prev")]),
  T("what's in the blood one", ask("mae_bloods", "bloods_doc", "bp_log"),
    ref=[askc("the blood tests on friday, the september results or the blood pressure log?",
              options="$mae_bloods, $bloods_doc, $bp_log")]))



X("T03-074",
  T("delete the kickoff bbq, it's done", diff(trash("bbq")),
    ref=[act("delete", kind="event", name="Futsal season kickoff BBQ")]),
  T("hm restore it, i want the list of who came", diff(restore("bbq")),
    ref=[act("restore", rows="$bbq")]))

X("T03-075",
  T("nvm", decline("never_mind"),
    ref=[dec("never_mind")]))

X("T03-053",
  T("which of my things from monday to end of october have no notes",
    rows("dept_1021", "lab_training", "ptm", "expo", "match_1024", "match_1031", "ipo_ev", "ortho", "school_trip", "dept_1028", "marta_lunch"),
    ref=[ans(kind="event", where="description is empty",
             when=W({"from": U("week", 1, weekday=1), "to": U("month", 0, name=10)}))]))

X("T03-056",
  T("is anyone saved as ricky", rows("ricardo"),
    ref=[ans(kind="person", where='nickname = "Ricky"')]))

X("T03-051",
  T("which school jobs are tied to someone", rows("luisa_budget", "inventory", "slides"),
    ref=[ans(kind="task", linked_to="$school", where="person count >= 1")]))

X("T03-052",
  T("and the smallest one i owe", val((20, "EUR")),
    ref=[comp(op="min", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'),
         ans(value="@prev")]),
  T("which debt is exactly 20 euros", rows("d_padel"),
    ref=[ans(kind="debt", where="amount = 20 EUR")]))

X("T03-057",
  T("futsal jobs with notes apart from the kitty one", rows("jerseys"),
    ref=[ans(kind="task", linked_to="$futsal", where='description is set and description != "10 euros per kid"')]))

X("T03-061",
  T("set the mechanic's role to mechanic, Oficina Correia", diff(upd("ze", role="mechanic, Oficina Correia")),
    ref=[act("edit", kind="person", where='role = "mechanic"', args=lines(role="mechanic, Oficina Correia"))]),
  T("anyone with sr in their nickname", rows("armando"),
    ref=[ans(kind="person", where='nickname contains "Sr"')]))

X("T03-064",
  T("who's in more than 5 pics", rows("tiago", "joana", "marta"),
    ref=[ans(kind="person", where="photo count > 5")]))

X("T03-071",
  T("mãe blood results september", rows("bloods_doc"),
    ref=[ans(rows="$bloods_doc")]),
  T("star it and the echo report", diff(upd("bloods_doc", starred=True), upd("echo_report", starred=True)),
    ref=[search("echo", kind="document"), act("star", rows="$bloods_doc, $echo_report")]))
