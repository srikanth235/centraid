from gold import *
import json

world("T16", "2026-12-16T18:00", "Rafiq Chowdhury", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T16-001", "trashed people restore multi restore window refused",
  T("who have i deleted from my contacts", rows("delwar", "liton", "pervez", "shahin"),
    ref=[find(kind="person", trashed=True), ans(rows="@prev")]),
  T("bring back liton, pervez and delwar", diff(restore("liton"), restore("pervez")),
    ref=[bad(act("restore", rows="$liton, $pervez, $delwar")),
         act("restore", rows="$liton, $pervez")]),
  T("what's liton down as", rows("liton"),
    ref=[ans(rows="$liton")]))

S("T16-002", "restore window person ask create",
  T("can you restore delwar hossain, need him for the old deposit", ask(),
    ref=[bad(act("restore", kind="person", name="Delwar Hossain", trashed=True)),
         askc("delwar's been in the bin since september, past the 30 days, so he can't come back. add him as a new contact?")]),
  T("ya add him again, old landlord", diff(new("person", name="Delwar Hossain", role=has("landlord"))),
    ref=[act("create", args=lines(kind="person", name="Delwar Hossain", role="old landlord"))]))

S("T16-003", "create person delete new restore new",
  T("add Hasan Ali, new line chief on line 5", diff(new("person", name="Hasan Ali", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Hasan Ali", role="line chief, Line 5"))]),
  T("wrong guy, delete him", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("no wait kamal bhai says he's joining after all. bring him back", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

S("T16-004", "create person delete restore new undo restore",
  T("save a contact Rina Akter, sewing operator, line 3", diff(new("person", name="Rina Akter", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Rina Akter", role="sewing operator, Line 3"))]),
  T("she left after two days. delete her", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("oh she came back today actually, restore her", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]),
  T("hmm no undo that, hr says it was her cousin", diff(trash("+1")),
    ref=[act("undo")]))

S("T16-005", "balance person settle_up named",
  T("where do i stand with sohel", val((-350, "BDT")),
    ref=[ans(op="balance", rows="$sohel")]),
  T("settle up with him in the tigers kitty", diff(settle=["Sohel Rana"]),
    ref=[act("settle_up", rows="$sohel", args=lines(group="$tigers"))]))

S("T16-006", "settle_up prev group balance",
  T("jahanara khatun, what's her role again", rows("jahanara"),
    ref=[ans(kind="person", name="Jahanara Khatun")]),
  T("settle up with her for the eid bonus pool", diff(settle=["Jahanara Khatun"]),
    ref=[act("settle_up", rows="@prev", args=lines(group="$bonus"))]),
  T("so we're square now, me and her?", val((0, "BDT")),
    ref=[ans(op="balance", rows="$jahanara")]))

S("T16-007", "cancel event named day read",
  T("cancel tea with topu, he's down with fever", diff(upd("tea_topu", status="cancelled")),
    ref=[act("cancel", kind="event", name="Tea with Topu")]),
  T("what's left on sunday", rows("prod_1220", "electrician", "tea_topu", "masud_call"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=7)))]))

S("T16-008", "event overlap refused ask create cancel new",
  T("put dinner with kamal bhai friday 8pm", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Dinner with Kamal bhai", date=U("week", 0, weekday=5, time="20:00")))),
         askc("the tigers team dinner is 8 to 10 that friday. another night?")]),
  T("saturday 8 then", diff(new("event", name="Dinner with Kamal bhai", date="2026-12-19T20:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Kamal bhai", date=U("week", 0, weekday=6, time="20:00")))]),
  T("ugh he called it off. cancel it", diff(upd("+1", status="cancelled")),
    ref=[act("cancel", rows="$c1")]))

S("T16-009", "create event day read cancel new",
  T("add Tigers committee meeting jan third at 7pm", diff(new("event", name="Tigers committee meeting", date="2027-01-03T19:00")),
    ref=[act("create", args=lines(kind="event", name="Tigers committee meeting", date=D("2027-01-03", "19:00")))]),
  T("what's on that day", rows("prod_0103", "+1"),
    ref=[ans(kind="event", when=W(D("2027-01-03")))]),
  T("call off the committee one, sohel can't come", diff(upd("+1", status="cancelled")),
    ref=[act("cancel", rows="$c1")]))

S("T16-012", "reopen named reschedule prev",
  T("reopen help mim with science fair project, teacher wants changes",
    diff(upd("science_fair", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Help Mim with science fair project")]),
  T("due this saturday", diff(upd("science_fair", date="2026-12-19")),
    ref=[act("reschedule", rows="$science_fair", args=lines(to=U("week", 0, weekday=6)))]))

S("T16-013", "ambiguous reopen narrowed",
  T("reopen buy cricket balls, half the last lot were duds", diff(upd("balls_2", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Buy cricket balls"),
         act("reopen", kind="task", name="Buy cricket balls", where='status = "completed"')]),
  T("how many open tasks on the cricket list", val(4),
    ref=[ans(op="count", kind="task", linked_to="$cricket_l", where='status = "open"')]))

S("T16-014", "create task list remove_from new read",
  T("add task Buy stumps, cricket list, by friday",
    diff(new("task", name="Buy stumps", date="2026-12-18"), link("cricket_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Buy stumps", date=U("week", 0, weekday=5), list="$cricket_l"))]),
  T("sohel's getting them actually. take it off the list", diff(unlink("cricket_l", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$cricket_l"))]),
  T("what's on the cricket list", rows("balls_1", "balls_2", "jerseys", "ground_book", "fixtures", "kitty_collect"),
    ref=[ans(kind="task", linked_to="$cricket_l")]))

S("T16-015", "create task remove_from new add_to undo link",
  T("new task: pay Monir for the fan wiring, home list",
    diff(new("task", name=has("Monir"), ), link("home_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Pay Monir for the fan wiring", list="$home_l"))]),
  T("hmm put it on shopping instead", diff(unlink("home_l", "+1"), link("shopping_l", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$home_l"), more=True),
         act("add_to", rows="$c1", args=lines(to="$shopping_l"))]),
  T("undo, home was right", diff(link("home_l", "+1"), unlink("shopping_l", "+1")),
    ref=[act("undo")]))

S("T16-016", "note read edit prev",
  T("show me my feedback for rahim note", rows("rahim_feedback"),
    ref=[ans(kind="note", name="Feedback for Rahim")]),
  T("add that he covered line 5 on saturday too",
    diff(upd("rahim_feedback", body=has("Line 5"))),
    ref=[act("edit", rows="@prev",
             args=lines(body="good on output, needs to handle absences earlier. covered Line 5 on Saturday too"))]))

S("T16-017", "note find edit prev rename",
  T("any notes on uttara", rows("uttara_scout"),
    ref=[ans(kind="note", name="Uttara")]),
  T("call it Uttara Strikers scouting", diff(upd("uttara_scout", name="Uttara Strikers scouting")),
    ref=[act("edit", rows="@prev", args=lines(name="Uttara Strikers scouting"))]),
  T("and pin it before saturday", diff(upd("uttara_scout", pinned=True)),
    ref=[act("edit", rows="$uttara_scout", args=lines(pinned="yes"))]))

S("T16-018", "notebook notes remove_from multi delete notebook",
  T("what's in the eid 2025 notebook", rows("eid25_gifts", "eid25_list"),
    ref=[ans(kind="note", linked_to="$eid25_nb")]),
  T("take both out", diff(unlink("eid25_nb", "eid25_gifts"), unlink("eid25_nb", "eid25_list")),
    ref=[act("remove_from", rows="$eid25_gifts, $eid25_list", args=lines(from_="$eid25_nb"))]),
  T("and delete the notebook", diff(gone("eid25_nb")),
    ref=[act("delete", rows="$eid25_nb")]))

S("T16-019", "single remove_from note multi",
  T("pull bonus rates and the new operators note out of the factory floor notebook",
    diff(unlink("factory_nb", "bonus_rates"), unlink("factory_nb", "operators")),
    ref=[find(kind="note", linked_to="$factory_nb"),
         act("remove_from", rows="$bonus_rates, $operators", args=lines(from_="$factory_nb"))]))

S("T16-020", "document where rename multi",
  T("any docs without a folder", rows("tax_return", "bus_tickets", "tigers_fixtures", "scan_a", "scan_b"),
    ref=[find(kind="document", where="folder count = 0"), ans(rows="@prev")]),
  T("scan 0012 and scan 0013 are the two pages of tanvir's registration form, name them that",
    diff(upd("scan_a", name="Tanvir's registration form"), upd("scan_b", name="Tanvir's registration form")),
    ref=[act("edit", rows="$scan_a, $scan_b", args=lines(name="Tanvir's registration form"))]),
  T("and put both in school", diff(link("school_f", "scan_a"), link("school_f", "scan_b")),
    ref=[act("add_to", rows="$scan_a, $scan_b", args=lines(to="$school_f"))]))

S("T16-021", "document anchor time find prev",
  T("the doc i saved last night at 10, what was it", rows("bus_tickets"),
    ref=[find(kind="document", when=W(U("day", -1, anchor="today", time="22:00"))), ans(rows="@prev")]),
  T("star it, need it on the twenty-first", diff(upd("bus_tickets", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T16-022", "add_to document named folder count",
  T("put the tax return 2026 in the bank folder", diff(link("bank_f", "tax_return")),
    ref=[act("add_to", rows="$tax_return", args=lines(to="$bank_f"))]),
  T("how many docs in bank", val(3),
    ref=[ans(op="count", kind="document", linked_to="$bank_f")]))

S("T16-023", "add_to document named delete folder refused ask",
  T("file the green line e-ticket under misc", diff(link("misc_f", "bus_tickets")),
    ref=[act("add_to", rows="$bus_tickets", args=lines(to="$misc_f"))]),
  T("delete the misc folder, i don't need it", ask(),
    ref=[bad(act("delete", rows="$misc_f")),
         askc("misc still has the green line e-ticket in it, so it can't be deleted. take the ticket out first?")]),
  T("leave it then", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T16-024", "document folder month remove_from prev multi",
  T("anything in medical from november", rows("ecg", "prescription"),
    ref=[ans(kind="document", linked_to="$medical_f", when=W(U("month", 0, name=11)))]),
  T("pull those out of medical, abba wants his own file", diff(unlink("medical_f", "ecg"), unlink("medical_f", "prescription")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$medical_f"))]),
  T("make a folder Abba's file and put them in", diff(new("folder", name="Abba's file"), link("new", "ecg"), link("new", "prescription")),
    ref=[act("create", args=lines(kind="folder", name="Abba's file"), more=True),
         act("add_to", rows="$ecg, $prescription", args=lines(to="$new"))]))

S("T16-025", "unstar photo where today",
  T("unstar the starred photo i took this morning", diff(upd("victory_flag", starred=False)),
    ref=[act("unstar", kind="photo", when=W(U("day", 0)), where="starred = yes")]),
  T("which pics from today are starred", rows(),
    ref=[ans(kind="photo", when=W(U("day", 0)), where="starred = yes")]))
