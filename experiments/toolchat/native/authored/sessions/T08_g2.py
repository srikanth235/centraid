from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T08-118", "edit note pin ask reunion unpin",
  T("pin the reunion note", ask("guest_ideas", "reunion_menu"),
    ref=[act("edit", kind="note", name="Reunion", args=lines(pinned="yes")),
         askc("the reunion guest list or the menu ideas?", options="$guest_ideas, $reunion_menu")]),
  T("the menu one", diff(upd("reunion_menu", pinned=True)),
    ref=[act("edit", rows="$reunion_menu", args=lines(pinned="yes"))]),
  T("and unpin the guest list", diff(upd("guest_ideas", pinned=False)),
    ref=[act("edit", kind="note", name="Reunion guest list", args=lines(pinned="no"))]),
  T("how many are pinned now", val(3),
    ref=[ans(op="count", kind="note", where="pinned = yes")]))

S("T08-119", "edit note pin contrast count repair effort unit",
  T("pin the reunion menu ideas note", diff(upd("reunion_menu", pinned=True)),
    ref=[act("edit", kind="note", name="Reunion menu ideas", args=lines(pinned="yes"))]),
  T("how many are pinned now", val(4),
    ref=[ans(op="count", kind="note", where="pinned = yes")]),
  T("tasks longer than an hour, which ones", rows("invites", "menu", "slideshow", "gutters", "nate", "osha", "taxes"),
    ref=[bad(ans(kind="task", where="effort > 1 hour")),
         ans(kind="task", where="effort > 60")]))

S("T08-120", "complete ask chapter reopen two writes",
  T("mark the chapter done", ask("nate_ch4", "nate_ch5"),
    ref=[act("complete", kind="task", name="chapter"),
         askc("the heat pump chapter or the airflow one?", options="$nate_ch4, $nate_ch5")]),
  T("heat pump, finished it last night", diff(upd("nate_ch4", status="completed", completed=ANY)),
    ref=[act("complete", rows="$nate_ch4")]),
  T("mark the airflow one done too and reopen count concession money",
    diff(upd("nate_ch5", status="completed", completed=ANY), upd("concession", status="open", completed=None)),
    ref=[act("complete", kind="task", name="Airflow chapter", more=True),
         act("reopen", kind="task", name="Count concession money")]))

S("T08-121", "complete contrast reschedule friday create overlap repair",
  T("mark the heat pump chapter done", diff(upd("nate_ch4", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Heat pump chapter")]),
  T("push the airflow chapter to friday", diff(upd("nate_ch5", date="2026-04-10")),
    ref=[act("reschedule", kind="task", name="Airflow chapter", args=lines(to=U("week", 0, weekday=5)))]),
  T("put a call with quanisha on wednesday at 7", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Call with Quanisha", date=U("week", 0, weekday=3, time="19:00")))),
         askc("wednesday at 7 clashes with the union chapter meeting. want it earlier?")]),
  T("6 then", diff(new("event", name=has("Quanisha"), date="2026-04-08T18:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Quanisha", date=U("week", 0, weekday=3, time="18:00")))]))

S("T08-122", "reschedule ask boosters meeting decline oos",
  T("move the boosters meeting to 8", ask("boost_0413", "boost_0511"),
    ref=[act("reschedule", kind="event", name="Boosters meeting", when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 0, anchor="row", time="20:00"))),
         find(kind="event", name="Boosters meeting", when=W({"from": U("day", 0)})),
         askc("the one on the 13th or the may 11th?", options="$boost_0413, $boost_0511")]),
  T("the april one", diff(upd("boost_0413", date="2026-04-13T20:00")),
    ref=[act("reschedule", rows="$boost_0413", args=lines(to=U("day", 0, anchor="row", time="20:00")))]),
  T("text marcus hill that it's moved", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("put on it, budget and car wash sign up", diff(upd("boost_0413", description="budget and car wash sign up")),
    ref=[act("edit", rows="$boost_0413", args=lines(description="budget and car wash sign up"))]))

S("T08-123", "reschedule contrast month group balance negative",
  T("move this month's boosters meeting to 8", diff(upd("boost_0413", date="2026-04-13T20:00")),
    ref=[act("reschedule", kind="event", name="Boosters meeting", when=W(U("month", 0)),
             args=lines(to=U("day", 0, anchor="row", time="20:00")))]),
  T("who's on the lanier fishing trip", rows("trey", "kevin", "reggie", "me"),
    ref=[ans(kind="person", linked_to="$fishing")]),
  T("where am i at in it", val((-27.18, "USD")),
    ref=[ans(op="balance", kind="group", name="Lanier fishing trip", linked_to="$me")]))

S("T08-124", "delete ask timesheet undo scratch that repair attendees",
  T("delete the timesheet task", ask("ts_mar", "ts_apr"),
    ref=[act("delete", kind="task", name="Submit timesheet"),
         find(kind="task", name="Submit timesheet"),
         askc("the march one that's done or the april one that's still open?", options="$ts_mar, $ts_apr")]),
  T("the done one", diff(trash("ts_mar")),
    ref=[act("delete", rows="$ts_mar")]),
  T("scratch that, i need march for the records", diff(restore("ts_mar")),
    ref=[act("undo")]),
  T("what's jalen got this week", rows("prac_0407", "dentist_jalen", "prac_0409"),
    ref=[bad(ans(kind="event", where='attendees contains "Jalen"')),
         ans(kind="event", linked_to="$jalen", when=W(U("week", 0)))]))

S("T08-125", "star ask report card unstar star two writes",
  T("star the report card", ask("rc_jalen", "rc_jada"),
    ref=[act("star", kind="document", name="report card"),
         askc("jalen's or jada's?", options="$rc_jalen, $rc_jada")]),
  T("jada's, she made honor roll", diff(upd("rc_jada", starred=True)),
    ref=[act("star", rows="$rc_jada")]),
  T("unstar the custody agreement and star the storage unit gate code",
    diff(upd("custody_doc", starred=False), upd("gate_code", starred=True)),
    ref=[act("unstar", kind="document", name="Custody agreement", more=True),
         act("star", kind="locker item", name="Storage unit gate code")]),
  T("star the pavilion rental contract too", diff(upd("pavilion_contract", starred=True)),
    ref=[act("star", kind="document", name="Pavilion rental contract")]))

S("T08-126", "star contrast report card locker decline not found",
  T("star jalen's report card", diff(upd("rc_jalen", starred=True)),
    ref=[act("star", kind="document", name="Jalen report card")]),
  T("star the house alarm code too", diff(upd("alarm", starred=True)),
    ref=[act("star", kind="locker item", name="House alarm code")]),
  T("how many locker things are starred now", val(4),
    ref=[ans(op="count", kind="locker item", where="starred = yes")]),
  T("delete the water heater task", decline("not_found"),
    ref=[search("water heater"), dec("not_found")]))

S("T08-127", "star person balance group members balance",
  T("star quanisha", diff(upd("quanisha", starred=True)),
    ref=[act("star", kind="person", name="Quanisha")]),
  T("what does she owe me all in", val((49.1, "USD")),
    ref=[ans(op="balance", rows="$quanisha")]),
  T("who's in the union dinner fund", rows("darnell", "vic", "marcus_b", "luis", "me"),
    ref=[ans(kind="person", linked_to="$union_fund")]),
  T("where am i at in it", val((40, "USD")),
    ref=[ans(op="balance", kind="group", name="Union dinner fund", linked_to="$me")]))

S("T08-128", "star nickname search balance unstar nickname",
  T("star dre", diff(upd("dre", starred=True)),
    ref=[search("Dre", kind="person"), act("star", rows="@prev")]),
  T("what does he owe me", val((205, "USD")),
    ref=[ans(op="balance", rows="$dre")]),
  T("take the star off mama", diff(upd("mama", starred=False)),
    ref=[act("unstar", kind="person", where='nickname = "Mama"')]))

S("T08-129", "reschedule task weekend long count weekend",
  T("push the gutters to this weekend, landlord's not doing it after all and i've got the ladder",
    diff(upd("gutters", date="2026-04-11")),
    ref=[act("reschedule", kind="task", name="Clean gutters", args=lines(to=U("week", 0, weekday=6)))]),
  T("how many things are due this weekend", val(4),
    ref=[ans(op="count", kind="task", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]))

S("T08-130", "reschedule ask union meeting next weekend at N",
  T("push the union chapter meeting to thursday at 8", ask("union_0408", "union_0513"),
    ref=[act("reschedule", kind="event", name="Union chapter meeting", args=lines(to=U("week", 0, weekday=4, time="20:00"))),
         find(kind="event", name="Union chapter meeting"),
         askc("the one this wednesday or the may 13th?", options="$union_0408, $union_0513")]),
  T("this week's", diff(upd("union_0408", date="2026-04-09T20:00")),
    ref=[act("reschedule", rows="$union_0408", args=lines(to=U("week", 0, weekday=4, time="20:00")))]),
  T("make the walkthrough 3 instead", diff(upd("walkthrough", date="2026-04-18T15:00")),
    ref=[act("reschedule", kind="event", name="Pavilion walkthrough", args=lines(to=U("day", 0, anchor="row", time="15:00")))]))

S("T08-131", "decline unbounded oos unbounded",
  T("clear out my whole vault", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("will it rain saturday, i want to do the gutters", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("wipe all my tasks", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T08-132", "restore window refused never mind not found",
  T("bring back the cancel gym membership task", ask(),
    ref=[bad(act("restore", kind="task", name="Cancel gym membership", trashed=True)),
         askc("that one's been in the trash since february, past the 30 days so it can't come back. want a fresh one?")]),
  T("nah forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("reschedule the chiropractor to friday", decline("not_found"),
    ref=[search("chiropractor"), dec("not_found")]))
