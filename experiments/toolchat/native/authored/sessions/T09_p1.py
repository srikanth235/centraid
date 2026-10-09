from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T09-001-P", "priority where edit multi reschedule para",
  T("tasks sitting at priority three and below", rows("ethics_hypo", "nda", "vows", "cpd", "passport_name"),
    ref=[ans(kind="task", where="priority >= 3")]),
  T("ethics hypos and the nda should both go to priority 2", diff(upd("ethics_hypo", priority=2), upd("nda", priority=2)),
    ref=[act("edit", rows="$ethics_hypo, $nda", args=lines(priority=2))]),
  T("what remains at 3 and below then", rows("vows", "cpd", "passport_name"),
    ref=[ans(kind="task", where="priority >= 3")]),
  T("vows now due aug eighth", diff(upd("vows", date="2026-08-08")),
    ref=[act("reschedule", rows="$vows", args=lines(to=D("2026-08-08")))]))

S("T09-004-P", "delete person prev cancel para",
  T("my dentist's name?", rows("lisa"),
    ref=[ans(kind="person", where='role = "dentist"')]),
  T("new clinic coming, so she can be wiped from contacts", diff(trash("lisa")),
    ref=[act("delete", rows="@prev")]),
  T("the cleaning on the twenty-sixth is off as well, cancel it", diff(upd("dentist", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dentist cleaning")]))

S("T09-008-P", "reschedule event where para",
  T("tomorrow's short meeting should start at 4:30 instead", diff(upd("checkin_0514", date="2026-05-14T16:30")),
    ref=[act("reschedule", kind="event", when=W(U("day", 1)), where="duration < 60",
             args=lines(to=U("day", 1, time="16:30")))]),
  T("who is it with", rows("margaret"),
    ref=[ans(kind="person", linked_to="$checkin_0514")]))

S("T09-014-P", "create note remove_from new para",
  T("add a note to condo board saying ask ravi about the parking garage sealant",
    diff(new("note", name=has("sealant")), link("condo_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Parking garage sealant", body="ask Ravi about the parking garage sealant",
                                  notebook="$condo_nb"))]),
  T("this doesn't belong in the board notebook, remove it from there", diff(unlink("condo_nb", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$condo_nb"))]))

S("T09-017-P", "trashed photo restore prev para",
  T("blurry toast pic, in the trash?", rows("blurry_toast"),
    ref=[ans(kind="photo", name="Blurry toast photo", trashed=True)]),
  T("bring it back", diff(restore("blurry_toast")),
    ref=[act("restore", rows="@prev")]))

S("T09-022-P", "create list edit new para",
  T("Bachelorette list, wedding area, create it", diff(new("list", name="Bachelorette", area="wedding")),
    ref=[act("create", args=lines(kind="list", name="Bachelorette", area="wedding"))]),
  T("actually its area is travel", diff(upd("+1", area="travel")),
    ref=[act("edit", rows="$c1", args=lines(area="travel"))]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T09-027-P", "person date spans within para",
  T("talked to anyone from may first until sunday noon? who", rows("dad", "priya_r", "gord", "jordan_p", "colette"),
    ref=[ans(kind="person", when=W(span(D("2026-05-01"), U("week", -1, weekday=7, time="12:00"))))]),
  T("just the condo board people", rows("gord"),
    ref=[ans(within="@prev", where='role contains "condo"')]),
  T("people i haven't contacted since before april", rows("hugo"),
    ref=[ans(kind="person", when=W({"to": U("month", 0, name=3)}))]),
  T("ran into hugo at the gym, record a visit", diff(upd("hugo", date=ANY)),
    ref=[act("log", rows="$hugo", args=lines(kind="visit"))]))

S("T09-030-P", "event duration person count span already ask decline para",
  T("upcoming events lasting over three hours",
    rows("elevator", "games", "discovery", "firm_party", "stag_night", "bachelorette", "reception"),
    ref=[ans(kind="event", when=W({"from": U("day", 0)}), where="duration > 180")]),
  T("those with no people attached", rows("elevator"),
    ref=[ans(within="@prev", where="person count < 1")]),
  T("today through next wed 9am, what's on",
    rows("northvale", "checkin_0514", "cb_0514", "team_lunch", "movie", "spin_0516", "fitting_1", "yoga",
         "siobhan_coffee", "hearing", "elevator", "bp_0519"),
    ref=[ans(kind="event", when=W(span(U("day", 0), U("week", 1, weekday=3, time="09:00"))))]),
  T("cancel yoga in the park, it's off", diff(already=["yoga"]),
    ref=[act("cancel", kind="event", name="Yoga in the park"), ans(rows="$yoga")]),
  T("fitting should be at 2", ask("fitting_1", "fitting_2"),
    ref=[act("reschedule", kind="event", name="Dress fitting", args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         find(kind="event", name="Dress fitting"),
         askc("this saturday's fitting or the one on 20 june?", options="$fitting_1, $fitting_2")]),
  T("forget it, ada's handling it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T09-035-P", "task month to weekday reschedule para",
  T("work admin items due may first through this sunday", rows("nda", "factum"),
    ref=[ans(kind="task", linked_to="$work_list", when=W(span(U("month", 0, name=5), U("week", 0, weekday=7))))]),
  T("margaret's ok with it, so the nda review moves to friday", diff(upd("nda", date="2026-05-15")),
    ref=[act("reschedule", rows="$nda", args=lines(to=U("week", 0, weekday=5)))]))

S("T09-040-P", "photo span person count album add_to para",
  T("photos with people in, from april first through last month",
    rows("court", "fitting_ada", "veil", "marcus_rugby", "nana_tea", "fam_dinner", "bp_pizza", "blossom_dan"),
    ref=[ans(kind="photo", when=W(span(D("2026-04-01"), U("month", -1))), where="person count != 0")]),
  T("any album holding the rugby one", rows(),
    ref=[ans(kind="album", linked_to="$marcus_rugby")]),
  T("spring 2026 should have it too", diff(link("spring_album", "marcus_rugby")),
    ref=[act("add_to", rows="$marcus_rugby", args=lines(to="$spring_album"))]),
  T("it doesn't fit there, so undo", diff(unlink("spring_album", "marcus_rugby")),
    ref=[act("undo")]))

S("T09-045-P", "locker username url star multi para",
  T("logins with the username hokafor", rows("firm_login", "lso_portal"),
    ref=[ans(kind="locker item", where='username = "hokafor"')]),
  T("url containing lso.ca, which entries", rows("lso_portal"),
    ref=[ans(kind="locker item", where='url contains "lso.ca"')]),
  T("give that one and the minted account stars", diff(upd("lso_portal", starred=True), upd("minted", starred=True)),
    ref=[act("star", rows="$lso_portal, $minted")]),
  T("hanae.okafor@gmail.com is the username of which login", rows("minted"),
    ref=[ans(kind="locker item", where='username = "hanae.okafor@gmail.com"')]),
  T("ada needs to check the order, so message her the minted password", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T09-048-P", "list area in open para",
  T("lists in the home or condo area", rows("home_list", "condo_list"),
    ref=[ans(kind="list", where='area in ("home", "condo")')]),
  T("condo list's open tasks", rows("agm_notice", "reserve", "repaint"),
    ref=[ans(kind="task", linked_to="$condo_list", where='status = "open"')]),
  T("wedding vendors that have an event booked with me", rows("colette", "tariq"),
    ref=[ans(kind="person", where='role contains "wedding" and event count != 0')]),
  T("people that have notes about them", rows("dan", "hugo", "nana", "kemi", "margaret", "ravi", "dad", "gord"),
    ref=[ans(kind="person", where="note count != 0")]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T09-053-P", "restore window event refusal restore undo para",
  T("engagement shoot rain date needs restoring", decline("not_found"),
    ref=[bad(act("restore", kind="event", name="Engagement shoot rain date", trashed=True)), dec("not_found")]),
  T("pottery class, trashed?", rows("pottery"),
    ref=[ans(kind="event", name="Pottery class", trashed=True)]),
  T("bring it back", diff(restore("pottery")),
    ref=[act("restore", rows="@prev")]),
  T("i'm not going after all, undo that", diff(trash("pottery")),
    ref=[act("undo")]),
  T("thursday's events then?", rows("checkin_0514", "cb_0514"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=4)))]))

S("T09-058-P", "delete group with expenses refused balance para",
  T("exam's in june, so the bar prep study group can be wiped", ask(),
    ref=[bad(act("delete", kind="group", name="Bar prep study group")),
         askc("it still has expenses in it, so it can't be deleted. want to see balances first?")]),
  T("yes, what's my balance there", val((103, "CAD")),
    ref=[find(kind="person", linked_to="$barprep"),
         ans(op="balance", kind="group", name="Bar prep study group", linked_to="$me")]),
  T("also, folders with no documents?", rows("old_f"),
    ref=[ans(kind="folder", where="document count < 1")]))

S("T09-061-P", "repair refused unit effort within sum max para",
  T("open tasks needing more than two hours of effort",
    rows("factum", "disc_outline", "vows", "cpd", "mock_exam", "invites"),
    ref=[bad(ans(kind="task", where='effort > 2 hours and status = "open"')),
         ans(kind="task", where='effort > 120 and status = "open"')]),
  T("among them, ones due within this month", rows("factum", "disc_outline", "mock_exam", "invites"),
    ref=[ans(within="@prev", when=W(U("month", 0)))]),
  T("prep discovery outline is now due the twenty-fourth", diff(upd("disc_outline", date="2026-05-24")),
    ref=[act("reschedule", kind="task", name="Prep discovery outline", args=lines(to=D("2026-05-24")))]),
  T("sum of effort for this month's due ones", val(630),
    ref=[ans(op="sum", field="effort", kind="task", when=W(U("month", 0)), where='effort > 120 and status = "open"')]),
  T("largest single effort among them", val(240),
    ref=[comp(op="max", field="effort", kind="task", when=W(U("month", 0)), where='effort > 120 and status = "open"'),
         ans(value="@prev")]))

S("T09-067-P", "ambiguous photo unstar find-only add_to para",
  T("cherry blossoms photo loses its star", diff(upd("blossom_dan", starred=False)),
    ref=[act("unstar", kind="photo", name="Cherry blossoms")]),
  T("engagement shoot pics, locate them", rows("eng_shoot1", "eng_shoot2"),
    ref=[find(kind="photo", name="Engagement shoot"), ans(rows="@prev")]),
  T("both belong in spring 2026 too", diff(link("spring_album", "eng_shoot1"), link("spring_album", "eng_shoot2")),
    ref=[act("add_to", rows="$eng_shoot1, $eng_shoot2", args=lines(to="$spring_album"))]))

S("T09-071-P", "delete person where delete event trash para",
  T("family doctor is no longer needed since i moved to a clinic: delete from contacts", diff(trash("haddad")),
    ref=[act("delete", kind="person", where='role = "family doctor"')]),
  T("physical with dr haddad, still on?", rows("physical"),
    ref=[ans(kind="event", name="Physical with Dr Haddad")]),
  T("wipe that as well", diff(trash("physical")),
    ref=[act("delete", rows="$physical")]),
  T("contacts trash contents?", rows("greg", "bex", "haddad"),
    ref=[ans(kind="person", trashed=True)]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T09-076-P", "week ahead within priority effort complete subtasks para",
  T("next week's due items", rows("stamps", "mark_essays", "ethics_hypo", "gl_rsvp", "florist_dep", "invites"),
    ref=[ans(kind="task", when=W(U("week", 1)))]),
  T("those at priority three and below", rows("ethics_hypo"),
    ref=[ans(within="@prev", where="priority >= 3")]),
  T("any taking under fifteen minutes", rows("stamps", "florist_dep"),
    ref=[ans(within="@1", where="effort < 15")]),
  T("all done: buy stamps, the smoke detector battery and dan's library books. what's still open this week",
    rows("index_fatou", "nda", "gl_plus", "f_facts", "blazer", "boardroom", "f_cite", "call_nana",
         also=diff(upd("stamps", status="completed", completed=ANY), upd("smoke", status="completed", completed=ANY),
                   upd("library", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Buy stamps", more=True),
         act("complete", kind="task", name="Replace smoke detector battery", more=True),
         act("complete", kind="task", name="Return Dan's library books", more=True),
         ans(kind="task", when=W(U("week", 0)), where='status = "open"')]),
  T("unfinished tasks with subtasks under them", rows("guest_list", "factum"),
    ref=[ans(kind="task", where='task count != 0 and status = "open"')]),
  T("completed subtask count under finalize guest list", val(1),
    ref=[ans(op="count", kind="task", linked_to="$guest_list", where='status = "completed"')]),
  T("earliest due open subtask under it", rows("gl_plus"),
    ref=[ans(kind="task", linked_to="$guest_list", where='status = "open"', order="date asc", limit=1)]))

S("T09-091-P", "create list edit new edit folder list multi ask para",
  T("create a Thank-yous list for the wedding area", diff(new("list", name="Thank-yous", area="wedding")),
    ref=[act("create", args=lines(kind="list", name="Thank-yous", area="wedding"))]),
  T("its new name: Thank-you notes", diff(upd("+1", name="Thank-you notes")),
    ref=[act("edit", rows="$c1", args=lines(name="Thank-you notes"))]),
  T("honeymoon folder and honeymoon list are both called Lisbon 2026 from now",
    diff(upd("hm_f", name="Lisbon 2026"), upd("hm_list", name="Lisbon 2026")),
    ref=[act("edit", rows="$hm_f, $hm_list", args=lines(name="Lisbon 2026"))]),
  T("lisbon list contents?", rows("sintra", "adaptor", "flights", "pastel"),
    ref=[ans(kind="task", linked_to="$hm_list")]),
  T("then the things we discussed go on the thank-you one", ask(),
    ref=[askc("which tasks should go on the thank-you notes list?")]))

S("T09-094-P", "area in remove_from where write+read reschedule ask para",
  T("lists with area travel or wedding", rows("wed_list", "hm_list"),
    ref=[ans(kind="list", where='area in ("travel", "wedding")')]),
  T("completed task leaves the honeymoon list, then show what remains there",
    rows("sintra", "adaptor", "pastel", also=diff(unlink("hm_list", "flights"))),
    ref=[act("remove_from", kind="task", linked_to="$hm_list", where='status = "completed"', args=lines(from_="$hm_list"),
             more=True),
         ans(kind="task", linked_to="$hm_list")]),
  T("buy a travel adapter should be due july first", diff(upd("adaptor", date="2026-07-01")),
    ref=[act("reschedule", kind="task", name="travel adapter", args=lines(to=D("2026-07-01"))),
         act("reschedule", kind="task", name="Buy travel adaptor", args=lines(to=D("2026-07-01")))]),
  T("the sintra one needs moving too", ask(),
    ref=[askc("to when?")]))

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T09-A003-P", "ask-options event reschedule c3a para",
  T("tasting next friday would suit me better", ask("cake", "menu"),
    ref=[act("reschedule", kind="event", name="tasting", args=lines(to=U("week", 1, weekday=5))),
         askc("The cake tasting on the 23rd or the menu tasting at Petrov Kitchen on 6 June?", options="$cake, $menu")]),
  T("menu", diff(upd("menu", date="2026-05-22T17:00")),
    ref=[act("reschedule", rows="$menu", args=lines(to=U("week", 1, weekday=5)))]),
  T("finalize one is finished, mark it", diff(upd("guest_list", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="finalize")]))

S("T09-A007-P", "follow-up c3a para",
  T("this week's events", rows("fitting_1", "yoga", "checkin_0514", "northvale", "spin_0516", "movie", "cb_0514", "team_lunch", "bp_0512", "siobhan_coffee"),
    ref=[ans(kind="event", when=J(U("week", 0)))]),
  T("thursday only", rows("checkin_0514", "cb_0514"),
    ref=[ans(within="@prev", when=J(U("week", 0, weekday=4)))]),
  T("friday's?", rows("movie", "team_lunch"),
    ref=[ans(within="@1", when=J(U("week", 0, weekday=5)))]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

OPEN = 'status = "open"'

IOWE = 'direction = "i_owe" and status = "open"'

OWED = 'direction = "owes_me" and status = "open"'

S("T09-B003-P", "c3b superlative debt top 3 sum biggest owed para",
  T("three biggest debts owed to me", rows("d_mom", "d_ada", "d_kemi", order=True),
    ref=[ans(kind="debt", where=OWED, order="amount desc", limit=3)]),
  T("sum of what they owe me", val((527.5, "CAD")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWED)]),
  T("my largest debt?", rows("d_dad"),
    ref=[ans(kind="debt", where=IOWE, order="amount desc", limit=1)]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T09-C101-P", "c3c bulk delete per kind last year find multi-kind undo para",
  T("clear out everything dated last year", diff(trash("bylaws"), trash("lso_card"), trash("proposal"), unlink("eng_album", "proposal"), trash("ring"), unlink("eng_album", "ring"), trash("dad_grill"), unlink("fam_album", "dad_grill"), trash("ada_grad"), unlink("fam_album", "ada_grad"), trash("xmas"), unlink("fam_album", "xmas")),
    ref=[find(kind="event,task,note,document,photo", when=W(U("year", -1))),
         act("delete", rows="$bylaws, $lso_card", more=True),
         act("delete", rows="$proposal, $ring, $dad_grill, $ada_grad, $xmas")]),
  T("i need the proposal pics, undo that", diff(restore("bylaws"), restore("lso_card"), restore("proposal"), link("eng_album", "proposal"), restore("ring"), link("eng_album", "ring"), restore("dad_grill"), link("fam_album", "dad_grill"), restore("ada_grad"), link("fam_album", "ada_grad"), restore("xmas"), link("fam_album", "xmas")),
    ref=[act("undo")]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))

FROM_NOW = {"from": U("day", 0)}

S("T09-108-P", "ask cancel dinner then undo scratch that para",
  T("dinner at mom and dad's needs cancelling", ask("dinner_0426", "dinner_0524"),
    ref=[act("cancel", kind="event", name="Dinner at Mom and Dad's"),
         find(kind="event", name="Dinner at Mom and Dad's"),
         askc("the one on 26 april or the one on the 24th?", options="$dinner_0426, $dinner_0524")]),
  T("24th", diff(upd("dinner_0524", status="cancelled")),
    ref=[act("cancel", rows="$dinner_0524")]),
  T("mom's already cooking, so undo that", diff(),
    ref=[act("undo")]))
