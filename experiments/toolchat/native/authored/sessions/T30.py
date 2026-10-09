from gold import *
import json

world("T30", "2027-02-16T21:05", "Élise Gagnon-Lavoie", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T30-001", "ambiguous-ask recurring-task complete follow-up date-pick",
  T("recycling's done, bins are out", ask("rec_260528", "rec_270218"),
    ref=[act("complete", kind="task", name="Take out recycling")]),
  T("this week's", diff(upd("rec_270218", status="completed", completed=ANY)),
    ref=[act("complete", rows="$rec_270218")]),
  T("and the compost, that's done too", ask("cmp_250303", "cmp_250602", "cmp_270215"),
    ref=[act("complete", kind="task", name="Take out compost")]),
  T("yesterday's", diff(upd("cmp_270215", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Take out compost", when=J(U("day", -1)))]))

S("T30-002", "relation-chain event group follow-up decline log",
  T("who from the hockey team was at last year's quebec tournament", rows("coach_pat", "marie_pier"),
    ref=[find(kind="event", name="quebec tournament", when=J(U("year", -1))),
         ans(kind="person", linked_to="$hockey_atome, @prev")]),
  T("which of them are starred", rows("coach_pat"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("text him that i'm bringing snacks saturday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("fine, just log that i called him instead", diff(upd("coach_pat", date=ANY)),
    ref=[act("log", rows="$coach_pat", args="kind: call")]))

S("T30-003", "same-name read description balance",
  T("who's sam", rows("sam_b", "sam_n"),
    ref=[ans(kind="person", name="Sam")]),
  T("where am i with sam the colleague", val((46, "CAD")),
    ref=[ans(op="balance", kind="person", name="Sam", where='role = "colleague"')]),
  T("and the neighbour one", val((-17.84, "CAD")),
    ref=[ans(op="balance", kind="person", name="Sam", where='role = "neighbour"')]))

S("T30-004", "marie-cluster within relation balance",
  T("who are the maries", rows("marie_claude", "marie_pier", "marie_eve"),
    ref=[ans(kind="person", name="Marie")]),
  T("which of them is on the hockey team", rows("marie_pier"),
    ref=[ans(within="@prev", linked_to="$hockey_atome")]),
  T("where am i with her", val((194.68, "CAD")),
    ref=[ans(op="balance", rows="$marie_pier")]))

S("T30-005", "list month status focus-pick decoy-name complete",
  T("budget stuff due this month that's still open", rows("impots27_1", "hq_270220", "t_106"),
    ref=[ans(kind="task", linked_to="$budget", where="status = open", when=J(U("month", 0)))]),
  T("gathered the rl-1 slips", diff(upd("impots27_1", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Gather the RL-1 slips")]),
  T("so what's left there", rows("hq_270220", "t_106"),
    ref=[ans(within="@1", where="status = open")]))

S("T30-006", "ambiguous-ask recurring date-select delete-old find-act",
  T("hydro's paid, tick it", ask("hq_250420", "hq_261020", "hq_270220"),
    ref=[act("complete", kind="task", name="Pay Hydro-Québec")]),
  T("the saturday one", diff(upd("hq_270220", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay Hydro-Québec", when=J(U("week", 0, weekday=6)))]),
  T("get rid of the other two hydro ones, they're ancient", diff(trash("hq_250420"), trash("hq_261020")),
    ref=[find(kind="task", name="Pay Hydro-Québec", where="status = open"),
         act("delete", rows="@prev")]))

S("T30-007", "subtasks container status within create-subtask completed",
  T("what's left on the 2026 impôts", rows("impots27_1", "impots27_2", "impots27_3"),
    ref=[ans(kind="task", linked_to="$impots27", where="status = open")]),
  T("which of those are due before march", rows("impots27_1"),
    ref=[ans(within="@prev", when=J({"to": D("2027-02-28")}))]),
  T("add a subtask for that, get the notice of assessment, march twelfth",
    diff(new("task", name="Get the notice of assessment", date="2027-03-12"), link("impots27", "new")),
    ref=[act("create", args=lines(kind="task", name="Get the notice of assessment", parent="$impots27", date=D("2027-03-12")))]),
  T("and what did i finish on the 2025 one", rows("impots_1", "impots_2", "impots_3", "impots_4", "impots_5"),
    ref=[ans(kind="task", linked_to="$impots", where="status = completed")]))

S("T30-008", "event description order-limit next last task log two-writes",
  T("when did maman most recently bring up papa's knee", rows("cm_270207"),
    ref=[ans(kind="event", name="Call maman", where='description contains "knee"', when=J({"to": U("day", 0)}), order="date desc", limit=1)]),
  T("and the next time she'll want to", rows("cm_270221"),
    ref=[ans(kind="event", name="Call maman", where='description contains "knee"', when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("is there still a task open about it", rows("t_060"),
    ref=[ans(kind="task", name="knee", where="status = open")]),
  T("called papa just now, so tick that off and log it",
    diff(upd("t_060", status="completed", completed=ANY), upd("papa", date=ANY)),
    ref=[act("complete", kind="task", name="Call Papa about his knee", where="status = open", more=True),
         act("log", rows="$papa", args="kind: call")]))

S("T30-009", "relation event person span cancel reschedule same-time read-back",
  T("what's zoé got till sunday", rows("pl_270217", "sw_270220"),
    ref=[ans(kind="event", linked_to="$zoe", when=J(span(U("day", 0), U("week", 0, weekday=7))))]),
  T("cancel saturday's swim, she's got a cold", diff(upd("sw_270220", status="cancelled")),
    ref=[act("cancel", kind="event", name="Swim class", when=J(U("week", 0, weekday=6)))]),
  T("and push piano to thursday, same time", diff(upd("pl_270217", date="2027-02-18T16:30")),
    ref=[act("reschedule", rows="$pl_270217", args=lines(to=U("week", 0, weekday=4)))]),
  T("so what's on thursday", rows("pl_270217"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=4)))]))

S("T30-010", "event relation order-limit description exclude person",
  T("when's emile's next game", rows("hg_270220"),
    ref=[ans(kind="event", name="game", linked_to="$emile", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("any away games coming up", rows(),
    ref=[ans(kind="event", name="game", where='description contains "away"', when=J({"from": U("day", 0)}))]),
  T("what was the latest away game then", rows("hg_270206"),
    ref=[ans(kind="event", name="game", where='description contains "away"', when=J({"to": U("day", 0)}), order="date desc", limit=1)]),
  T("who else was there besides emile", rows("coach_pat", "marie_pier"),
    ref=[ans(kind="person", linked_to="$hg_270206", exclude="$emile")]))

S("T30-011", "balance role-where debts relation within settle_debt amount",
  T("where am i with my sister isabelle", val((-599, "CAD"), (3.75, "USD")),
    ref=[ans(op="balance", kind="person", name="Isabelle", where='role = "sister"')]),
  T("which debts do i still owe her", rows("debt_02", "debt_08", "debt_14", "debt_20", "debt_26", "debt_32", "debt_38"),
    ref=[ans(kind="debt", linked_to="$isabelle", where="direction = i_owe and status = open")]),
  T("just last year's", rows("debt_26", "debt_32", "debt_38"),
    ref=[ans(within="@prev", when=J(U("year", -1)))]),
  T("settle the 170 one, paid her this morning", diff(upd("debt_26", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$isabelle", where="amount = 170")]))

S("T30-012", "debts relation when focus-pick settle_debt open within where",
  T("what are lucie boucher's debts from before 2026", rows("debt_04", "debt_10", "debt_16"),
    ref=[ans(kind="debt", linked_to="$lucie_boucher", when=J({"to": D("2025-12-31")}))]),
  T("she paid the movie tickets", diff(upd("debt_04", status="settled")),
    ref=[act("settle_debt", kind="debt", name="movie tickets")]),
  T("and what does she still owe", rows("debt_10", "debt_16", "debt_28", "debt_34", "debt_40"),
    ref=[ans(kind="debt", linked_to="$lucie_boucher", where="status = open")]),
  T("any over a hundred", rows("debt_10", "debt_16", "debt_40"),
    ref=[ans(within="@prev", where="amount > 100")]))

S("T30-013", "event order-limit create edit reschedule focus date-earlier",
  T("when was my most recent optometrist appointment", rows("oo_042"),
    ref=[ans(kind="event", name="Optometrist", when=J({"to": U("day", 0)}), order="date desc", limit=1)]),
  T("book another one for next tuesday at 10", diff(new("event", name=has("Optometrist"), date="2027-02-23T10:00")),
    ref=[act("create", args=lines(kind="event", name="Optometrist", date=U("week", 1, weekday=2, time="10:00")))]),
  T("forty minutes, like last time", diff(upd("+1", duration=40)),
    ref=[act("edit", rows="$c1", args="duration: 40")]),
  T("no wait, make it friday at 10", diff(upd("+1", date="2027-02-19T10:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 0, weekday=5, time="10:00")))]))

S("T30-014", "trashed restore task decline-window trash-read",
  T("i deleted the glasses renewal by mistake, bring it back", diff(restore("t_003")),
    ref=[act("restore", kind="task", name="glasses", trashed=True)]),
  T("and the property tax one", diff(restore("t_009")),
    ref=[act("restore", kind="task", name="property tax", trashed=True)]),
  T("other tasks in the trash", rows("t_014", "t_022", "t_033", "t_046", "t_058", "t_071"),
    ref=[ans(kind="task", trashed=True)]),
  T("bring back the winter boots one", diff(restore("t_014")),
    ref=[act("restore", kind="task", name="winter boots", trashed=True)]),
  T("and the savings one from november", decline("not_found"),
    ref=[act("restore", kind="task", name="savings account", trashed=True)]))

S("T30-015", "trashed restore person decline-window",
  T("bring camille lévesque back, i deleted her by accident", diff(restore("camille_levesque")),
    ref=[act("restore", kind="person", name="Camille Lévesque", trashed=True)]),
  T("and étienne nguyen", diff(restore("etienne_nguyen")),
    ref=[act("restore", kind="person", name="Étienne Nguyen", trashed=True)]),
  T("and hugo gosselin from the class gift group", decline("not_found"),
    ref=[act("restore", kind="person", name="Hugo Gosselin", trashed=True)]))

S("T30-016", "document folder relation add_to move count within name",
  T("what's in the assurances folder", rows("doc_04", "doc_05", "doc_06", "doc_30", "doc_31", "doc_32", "doc_56", "doc_57", "doc_58"),
    ref=[ans(kind="document", linked_to="$assurances_f")]),
  T("the report card doesn't belong there, it's émile's, move it to école",
    diff(unlink("assurances_f", "doc_04"), link("ecole_f", "doc_04")),
    ref=[act("add_to", kind="document", name="report card", linked_to="$assurances_f", args="to: $ecole_f")]),
  T("how many report cards are in école now", val(9),
    ref=[ans(op="count", kind="document", name="report card", linked_to="$ecole_f")]),
  T("which of those are émile's", rows("doc_04", "doc_08", "doc_34", "doc_60"),
    ref=[ans(within="@prev", name="Émile")]))

S("T30-017", "document folder-count add_to star two-writes where when",
  T("any documents with no folder", rows("doc_13"),
    ref=[ans(kind="document", where="folder count = 0")]),
  T("file it under maison and star it", diff(link("maison_f", "doc_13"), upd("doc_13", starred=True)),
    ref=[act("add_to", rows="$doc_13", args="to: $maison_f", more=True),
         act("star", rows="$doc_13")]),
  T("and which maison documents are from 2025", rows("doc_39", "doc_40", "doc_41"),
    ref=[ans(kind="document", linked_to="$maison_f", when=J(span(D("2025-01-01"), D("2025-12-31"))))]))

S("T30-018", "photo album person relation within star add_to",
  T("photos of léa in the camping album", rows("ph_camping24_07", "ph_camping24_10", "ph_camping24_11", "ph_camping24_16"),
    ref=[ans(kind="photo", linked_to="$camping24, $lea")]),
  T("just the starred ones", rows("ph_camping24_07"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("put that one in zoé's birthday album", diff(link("zoe8", "ph_camping24_07")),
    ref=[act("add_to", rows="$ph_camping24_07", args="to: $zoe8")]))

S("T30-019", "note notebook relation body-contains within when edit",
  T("which hockey recaps mention 3 goals", rows("hk_4", "hk_8"),
    ref=[ans(kind="note", name="Hockey recap", where='body contains "3 goals"')]),
  T("last year's only", rows("hk_8"),
    ref=[ans(within="@prev", when=J(U("year", -1)))]),
  T("add that coach pat wants more shooting practice too", diff(upd("hk_8", body=has("shooting"))),
    ref=[opn("$hk_8"),
         act("edit", rows="$hk_8", args="body: Game recap - Émile played defense, 3 goals, coach Pat wants more backward skating and more shooting practice. Next practice Tuesday at six thirty.")]))

S("T30-020", "locker wifi read reveal egress where-type star",
  T("wifi pw?", rows("home_wifi", "maman_wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("the home one, show me", diff(reveal=[("home_wifi", "ChezNousRosemont27")]),
    ref=[act("reveal", rows="$home_wifi", args="field: password")]),
  T("text it to mathieu", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("which logins are starred", rows("desjardins"),
    ref=[ans(kind="locker item", where="type = login and starred = yes")]))

S("T30-021", "event create clash-ask retry undo read",
  T("put a dentist for zoé wednesday at quarter to five", ask("pl_270217"),
    ref=[act("create", args=lines(kind="event", name="Dentist for Zoé", date=U("week", 0, weekday=3, time="16:45")))]),
  T("ok make it 5", diff(new("event", name=has("Dentist"), date="2027-02-17T17:00")),
    ref=[act("create", args=lines(kind="event", name="Dentist for Zoé", date=U("week", 0, weekday=3, time="17:00")))]),
  T("actually undo that, mat's taking her tomorrow", diff(trash("+1")),
    ref=[act("undo")]),
  T("what's on wednesday then", rows("oo_038", "oo_029", "pl_270217"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=3)))]))

S("T30-022", "person read cadence edit log visit",
  T("when did i last talk to maman", rows("maman"),
    ref=[ans(kind="person", name="Maman")]),
  T("who do i keep in touch with every week or more", rows("mathieu", "lea", "emile", "zoe", "maman", "marie_eve"),
    ref=[ans(kind="person", where="cadence <= 7")]),
  T("put pépère on every three weeks", diff(upd("pepere", cadence=21)),
    ref=[act("edit", kind="person", name="Pépère", args="cadence: 21")]),
  T("and log that i visited him today", diff(upd("pepere", date=ANY)),
    ref=[act("log", rows="$pepere", args="kind: visit")]))
