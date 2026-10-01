from gold import *
import json

world("T24", "2026-09-18T15:05", "Carlos Mendoza", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T24-001", "starred read unstar person where star named",
  T("who's starred", rows("elena", "rosa", "ray", "jessica", "patty", "yvonne", "tom"),
    ref=[ans(kind="person", where="starred = yes")]),
  T("take the star off the union president", diff(upd("tom", starred=False)),
    ref=[act("unstar", kind="person", where='role = "union president"')]),
  T("and star Linda Chavez, she's handling the physicals", diff(upd("linda", starred=True)),
    ref=[act("star", rows="$linda")]))

S("T24-002", "unstar person prev multi team parent",
  T("which team parents have a star on them", rows("patty", "yvonne"),
    ref=[ans(kind="person", where='starred = yes and role = "team parent"')]),
  T("unstar both, season hasn't even started", diff(upd("patty", starred=False), upd("yvonne", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T24-003", "single unstar person where",
  T("unstar whoever's the history dept chair", diff(upd("jessica", starred=False)),
    ref=[act("unstar", kind="person", where='role = "history dept chair"')]))

S("T24-004", "met literal within unstar person prev",
  T("who did i meet at UTEP", rows("elena", "ray", "jessica"),
    ref=[ans(kind="person", where='met = "UTEP"')]),
  T("just the coach", rows("ray"),
    ref=[find(kind="person", within="@prev", where='role contains "coach"'), ans(rows="@prev")]),
  T("unstar him", diff(upd("ray", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T24-005", "empty result group find miss decline not_found edit group prev",
  T("what's my fantasy football group called", decline("not_found"),
    ref=[find(kind="group", name="fantasy football"), search("fantasy football", kind="group"),
         dec("not_found")]),
  T("ok what currency is the quince group in", rows("quince_g"),
    ref=[ans(kind="group", name="quince")]),
  T("call it Ana's quinceañera gift, cousin ana hates being called cousin", diff(upd("quince_g", name="Ana's quinceañera gift")),
    ref=[act("edit", rows="@prev", args=lines(name="Ana's quinceañera gift"))]))

S("T24-006", "edit group named refused delete group ask never_mind",
  T("rename the reunion group to Reunión Juárez 2026",
    diff(upd("reunion_g", name="Reunión Juárez 2026")),
    ref=[act("edit", rows="$reunion_g", args=lines(name="Reunión Juárez 2026"))]),
  T("delete the reunion one", ask(),
    ref=[bad(act("delete", rows="$reunion_g")),
         askc("it still has the salon deposit in it, so the vault won't delete it. settle up with tio beto first?")]),
  T("no leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T24-007", "refused delete group ask settle_up undo ledger",
  T("delete the union pizza fund, we're done with it", ask(),
    ref=[bad(act("delete", rows="$union_g")),
         askc("the september pizza is still in there so it can't be deleted. want to settle up with david salazar?")]),
  T("yeah settle up with david salazar in there", diff(settle=["David Salazar"]),
    ref=[act("settle_up", rows="$david_s", args=lines(group="$union_g"))]),
  T("undo that", diff(),
    ref=[act("undo")]))

S("T24-008", "empty result group find miss decline create group add_to",
  T("who's in the carpool group", decline("not_found"),
    ref=[search("carpool", kind="group"), dec("not_found")]),
  T("fine, make one called Carpool with veronica and gilbert",
    diff(new("group", name="Carpool"), link("new", "me"), link("new", "veronica"), link("new", "gilbert")),
    ref=[act("create", args=lines(kind="group", name="Carpool"), more=True),
         act("add_to", rows="$veronica, $gilbert", args=lines(to="$new"))]))

S("T24-009", "event duration unit refused unit repair cancel named",
  T("anything next week that runs longer than two hours", rows("lucia_bday", "ref_clinic", "fb_0925", "yard_0926"),
    ref=[bad(ans(kind="event", when=U("week", 1), where="duration > 2 hours")),
         ans(kind="event", when=U("week", 1), where="duration > 120 min")]),
  T("cancel the referee clinic, micheal says its moving", diff(upd("ref_clinic", status="cancelled")),
    ref=[act("cancel", rows="$ref_clinic")]))

S("T24-010", "event status enum delete prev multi trashed restore event where",
  T("what got cancelled this month", rows("gym_0910", "elena_dinner", "game_night"),
    ref=[find(kind="event", when=U("month", 0), where='status = "cancelled"'), ans(rows="@prev")]),
  T("delete all three", diff(trash("gym_0910"), trash("elena_dinner"), trash("game_night")),
    ref=[act("delete", rows="@prev")]),
  T("what's in the calendar trash",
    rows("gym_0910", "elena_dinner", "game_night", "haircut", "car_wash", "pool_party"),
    ref=[ans(kind="event", trashed=True)]),
  T("restore the one from last tuesday, i did end up getting that haircut", diff(restore("haircut")),
    ref=[act("restore", kind="event", trashed=True, when=U("week", -1, weekday=2))]))

S("T24-011", "restore event where restore window bad answer",
  T("restore whatever i deleted from the sunday before last", diff(restore("car_wash")),
    ref=[act("restore", kind="event", trashed=True, when=U("week", -2, weekday=7))]),
  T("and the pool party at the castillos", rows("pool_party"),
    ref=[bad(act("restore", kind="event", name="Pool party at the Castillos", trashed=True)),
         ans(kind="event", name="Pool party at the Castillos", trashed=True)]))

S("T24-012", "event overlap create refused ask create delete event new",
  T("put team pizza night next thursday at 5", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Team pizza night", date=U("week", 1, weekday=4, time="17:00")))),
         askc("open gym runs till 5:30 next thursday and sofia plays at 6. friday evening instead?")]),
  T("ok friday at 6", diff(new("event", name="Team pizza night", date="2026-09-25T18:00")),
    ref=[act("create", args=lines(kind="event", name="Team pizza night", date=U("week", 1, weekday=5, time="18:00")))]),
  T("delete it, ray can't make it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T24-013", "create event delete event new",
  T("add Hudl film upload sunday 8pm", diff(new("event", name="Hudl film upload", date="2026-09-20T20:00")),
    ref=[act("create", args=lines(kind="event", name="Hudl film upload", date=U("week", 0, weekday=7, time="20:00")))]),
  T("nah delete that, ray's doing it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("and restore the Car wash fundraiser, patty moved it to october", diff(restore("car_wash")),
    ref=[act("restore", kind="event", name="Car wash fundraiser", trashed=True)]))

S("T24-014", "single count open gym from today",
  T("how many open gyms are left", val(8),
    ref=[ans(op="count", kind="event", name="Open gym", when={"from": U("day", 0)})]))

S("T24-015", "task completed list reopen task multi",
  T("what's done on the history class list", rows("packets", "syllabus"),
    ref=[ans(kind="task", linked_to="$school_l", where='status = "completed"')]),
  T("reopen Copy primary source packets and Book the bus, copier jammed and the bus company flaked",
    diff(upd("packets", status="open", completed=None), upd("bus", status="open", completed=None)),
    ref=[act("reopen", rows="$packets, $bus")]))

S("T24-016", "reopen task multi subtasks read",
  T("reopen Get quote from Sun City Sports and Send party invites",
    diff(upd("quote", status="open", completed=None), upd("invites", status="open", completed=None)),
    ref=[act("reopen", rows="$quote, $invites")]),
  T("what's under the jerseys task", rows("sizes", "quote", "jersey_money"),
    ref=[ans(kind="task", linked_to="$jerseys")]))

S("T24-017", "create task list edit new delete task new",
  T("add a task pick up trophies from sun city, next wednesday, basketball list",
    diff(new("task", name=has("trophies"), date="2026-09-23"), link("team_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Pick up trophies from Sun City", date=U("week", 1, weekday=3),
                                  list="$team_l"))]),
  T("make it priority two", diff(upd("+1", priority=2)),
    ref=[act("edit", rows="$c1", args=lines(priority=2))]),
  T("scrap it, patty's getting them", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T24-018", "create task delete task new",
  T("remind me to call the bus company monday", diff(new("task", name=has("bus company"), date="2026-09-21")),
    ref=[act("create", args=lines(kind="task", name="Call the bus company", date=U("week", 1, weekday=1)))]),
  T("delete it, jessica already called them", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T24-019", "effort literal within complete prev",
  T("quick stuff open, fifteen min or less",
    rows("ac_filter", "tryout_forms", "email_parents", "invoice_soto", "gatorade", "ink", "call_ama", "library",
         "water_09"),
    ref=[ans(kind="task", where='effort <= 15 and status = "open"')]),
  T("any of those due today", rows("email_parents"),
    ref=[find(kind="task", within="@prev", when=U("day", 0)), ans(rows="@prev")]),
  T("done, sent it at lunch", diff(upd("email_parents", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]))

S("T24-020", "priority literal within",
  T("low priority stuff, anything below a 2", rows("garage_clean", "film", "balls", "survey", "castillo_quote",
                                                  "certificate", "fence"),
    ref=[ans(kind="task", where="priority > 2")]),
  T("which of them did i cancel", rows("garage_clean", "balls", "fence"),
    ref=[ans(kind="task", within="@prev", where='status = "cancelled"')]))

S("T24-021", "task count linkcount list count",
  T("which tasks have subtasks", rows("jerseys", "trip_plan", "party"),
    ref=[ans(kind="task", where="task count > 0")]),
  T("and open stuff that isn't on any list",
    rows("call_ama", "anniv_plan", "certificate", "library", "sizes", "jersey_money", "slips", "chaperones",
         "pinata", "favors"),
    ref=[ans(kind="task", where='list count <= 0 and status = "open"')]))

S("T24-022", "four turns task spans reschedule count",
  T("basketball list stuff due between now and the twenty-third", rows("email_parents", "physicals", "roster"),
    ref=[ans(kind="task", linked_to="$team_l", when=span(U("day", 0), D("2026-09-23")))]),
  T("and from tomorrow through next wednesday on the history list", rows("grade_tests", "lesson_rev"),
    ref=[ans(kind="task", linked_to="$school_l", when=span(U("day", 1), U("week", 1, weekday=3)))]),
  T("push the revolution lesson plan to next friday", diff(upd("lesson_rev", date="2026-09-25")),
    ref=[act("reschedule", rows="$lesson_rev", args=lines(to=U("week", 1, weekday=5)))]),
  T("how many things due next friday", val(6),
    ref=[ans(op="count", kind="task", when=U("week", 1, weekday=5))]))

S("T24-023", "task spans landscaping party subtasks",
  T("landscaping list, what's due from today thru the twenty-fifth", rows("mulch", "invoice_soto", "castillo_quote"),
    ref=[ans(kind="task", linked_to="$land_l", when=span(U("day", 0), D("2026-09-25")))]),
  T("anything for lucia's party prep from tomorrow to next thursday", rows("pinata"),
    ref=[ans(kind="task", linked_to="$party", when=span(U("day", 1), U("week", 1, weekday=4)))]))

S("T24-024", "single find-only document",
  T("what's the jersey doc called again", rows("jersey_quote"),
    ref=[find(kind="document", name="jersey"), ans(rows="@prev")]))

S("T24-025", "five turns note rel time anchor pin delete note named restore note named",
  T("what did i write last night at 9", rows("ft_note"),
    ref=[ans(kind="note", when=U("day", -1, time="21:00"))]),
  T("pin it", diff(upd("ft_note", pinned=True)),
    ref=[act("edit", rows="@prev", args=lines(pinned="yes"))]),
  T("and notes from two days ago", rows("drills", "questions", "proposal_notes"),
    ref=[ans(kind="note", when=U("day", -2, anchor="today"))]),
  T("delete Discussion questions unit 2", diff(trash("questions")),
    ref=[act("delete", rows="$questions")]),
  T("hmm no restore it, jessica wants a copy", diff(restore("questions")),
    ref=[act("restore", rows="$questions")]))
