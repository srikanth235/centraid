from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T09-026", "cadence within log balance",
  T("which contacts have a check-in cadence of a week or less", rows("dan", "mom", "dad", "ada", "aiden", "fatou"),
    ref=[ans(kind="person", where="cadence <= 7 days")]),
  T("which of those haven't i talked to since before the weekend", rows("dad"),
    ref=[ans(within="@prev", when=W({"to": U("week", -1, weekday=5)}))]),
  T("log a call with him now, hung up", diff(upd("dad", date=ANY)),
    ref=[act("log", rows="$dad", args=lines(kind="call"))]),
  T("where do i stand with dad money wise", val((-2000, "CAD")),
    ref=[ans(op="balance", rows="$dad")]),
  T("and with ada", val((-50, "CAD")),
    ref=[ans(op="balance", kind="person", name="Adaeze Okafor")]))

S("T09-027", "person date spans within",
  T("who did i talk to between may first and sunday noon", rows("dad", "priya_r", "gord", "jordan_p", "colette"),
    ref=[ans(kind="person", when=W(span(D("2026-05-01"), U("week", -1, weekday=7, time="12:00"))))]),
  T("the condo board ones", rows("gord"),
    ref=[ans(within="@prev", where='role contains "condo"')]),
  T("and who have i not been in touch with since before april", rows("hugo"),
    ref=[ans(kind="person", when=W({"to": U("month", 0, name=3)}))]),
  T("saw hugo at the gym, log it as a visit", diff(upd("hugo", date=ANY)),
    ref=[act("log", rows="$hugo", args=lines(kind="visit"))]))

S("T09-028", "person evening span count since april",
  T("who'd i talk to last night between 5 and 11", rows("dan", "ada", "aiden", "fatou"),
    ref=[ans(kind="person", when=W(span(U("day", -1, time="17:00"), U("day", -1, time="23:00"))))]),
  T("how many people have i been in touch with since april", val(17),
    ref=[ans(op="count", kind="person", when=W({"from": U("month", 0, name=4)}))]),
  T("which of them are starred", rows("dan", "mom", "ada", "margaret"),
    ref=[ans(kind="person", when=W({"from": U("month", 0, name=4)}), where="starred = yes")]))

S("T09-029", "person datetime span to month",
  T("anyone i talked to between fri 6pm and sun 5pm", rows("kemi"),
    ref=[ans(kind="person", when=W(span(U("week", -1, weekday=5, time="18:00"), U("week", -1, weekday=7, time="17:00"))))]),
  T("and who's gone quiet since before april", rows("hugo"),
    ref=[ans(kind="person", when=W({"to": U("month", 0, name=3)}))]))

S("T09-030", "event duration person count span already ask decline",
  T("anything coming up that's longer than three hours",
    rows("elevator", "games", "discovery", "firm_party", "stag_night", "bachelorette", "reception"),
    ref=[ans(kind="event", when=W({"from": U("day", 0)}), where="duration > 180")]),
  T("which of those has nobody attached", rows("elevator"),
    ref=[ans(within="@prev", where="person count < 1")]),
  T("what's on from today till next wed 9am",
    rows("northvale", "checkin_0514", "cb_0514", "team_lunch", "movie", "spin_0516", "fitting_1", "yoga",
         "siobhan_coffee", "hearing", "elevator", "bp_0519"),
    ref=[ans(kind="event", when=W(span(U("day", 0), U("week", 1, weekday=3, time="09:00"))))]),
  T("yoga in the park is off, cancel it", diff(already=["yoga"]),
    ref=[act("cancel", kind="event", name="Yoga in the park"), ans(rows="$yoga")]),
  T("move the fitting to 2", ask("fitting_1", "fitting_2"),
    ref=[act("reschedule", kind="event", name="Dress fitting", args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         find(kind="event", name="Dress fitting"),
         askc("this saturday's fitting or the one on 20 june?", options="$fitting_1, $fitting_2")]),
  T("nvm leave it, ada will sort it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T09-031", "count from next week group members",
  T("how many bar prep sessions are left from next week on", val(3),
    ref=[ans(op="count", kind="event", name="Bar prep session", when=W({"from": U("week", 1)}))]),
  T("and condo board meetings from next month on", val(1),
    ref=[ans(op="count", kind="event", name="Condo board meeting", when=W({"from": U("month", 1)}))]),
  T("who's in the bar prep group again", rows("aiden", "fatou", "mateo", "jordan_p", "me"),
    ref=[ans(kind="person", linked_to="$barprep")]),
  T("what's due in june", rows("thanks_new", "headcount", "playlist", "reserve", "dryer", "fees_06"),
    ref=[ans(kind="task", when=W(U("month", 0, name=6)))]),
  T("just the wedding ones", rows("thanks_new", "headcount", "playlist"),
    ref=[ans(within="@prev", linked_to="$wed_list")]))

S("T09-032", "task june name month",
  T("anything on the condo list due in june", rows("reserve"),
    ref=[ans(kind="task", linked_to="$condo_list", when=W(U("month", 0, name=6)))]),
  T("push it a week to the twelfth", diff(upd("reserve", date="2026-06-12")),
    ref=[act("reschedule", rows="$reserve", args=lines(to=D("2026-06-12")))]))

S("T09-033", "task date span effort complete",
  T("what's due between the eighteenth and the twenty-second",
    rows("stamps", "mark_essays", "ethics_hypo", "gl_rsvp", "florist_dep", "invites"),
    ref=[ans(kind="task", when=W(span(D("2026-05-18"), D("2026-05-22"))))]),
  T("which of those take over an hour", rows("mark_essays", "invites"),
    ref=[ans(within="@prev", where="effort > 60")]),
  T("tick off the essays one, did them last night", diff(upd("mark_essays", status="completed", completed=ANY)),
    ref=[act("complete", rows="$mark_essays")]))

S("T09-034", "task month to datetime",
  T("everything due from the start of may up to friday 5pm that i haven't finished",
    rows("nda", "index_fatou", "gl_plus", "f_facts", "blazer", "library", "boardroom", "call_nana", "f_cite"),
    ref=[ans(kind="task", when=W(span(U("month", 0, name=5), U("week", 0, weekday=5, time="17:00"))),
             where='status = "open"')]))

S("T09-035", "task month to weekday reschedule",
  T("work admin stuff due from may first to this sunday", rows("nda", "factum"),
    ref=[ans(kind="task", linked_to="$work_list", when=W(span(U("month", 0, name=5), U("week", 0, weekday=7))))]),
  T("push the nda review to friday, margaret's fine with it", diff(upd("nda", date="2026-05-15")),
    ref=[act("reschedule", rows="$nda", args=lines(to=U("week", 0, weekday=5)))]))

S("T09-036", "note spans pin",
  T("notes i wrote since the sunday before last at 8pm up to today",
    rows("seating", "brightline", "timing", "agm_agenda", "songs", "gift_nana", "run_log"),
    ref=[ans(kind="note", when=W(span(U("week", -2, weekday=7, time="20:00"), U("week", 0, weekday=3))))]),
  T("pin the brightline one", diff(upd("brightline", pinned=True)),
    ref=[act("edit", rows="$brightline", args=lines(pinned="yes"))]),
  T("bar prep notes from march eighth 7pm through april", rows("ethics", "civpro", "fam_law"),
    ref=[ans(kind="note", linked_to="$bar_nb", when=W(span(D("2026-03-08", "19:00"), U("month", 0, name=4))))]))

S("T09-037", "documents this week star span add_to",
  T("docs i added this week", rows("brightline_factum", "agm_draft", "invite_proof"),
    ref=[ans(kind="document", when=W(U("week", 0)))]),
  T("star the agm notice draft", diff(upd("agm_draft", starred=True)),
    ref=[act("star", kind="document", name="AGM notice draft")]),
  T("what did i save between last monday and this monday at noon", rows("noa", "guest_sheet", "mockup"),
    ref=[ans(kind="document", when=W(span(U("week", -1, weekday=1), U("week", 0, weekday=1, time="12:00"))))]),
  T("put the wedding website mockup in the wedding folder", diff(link("wed_f", "mockup")),
    ref=[act("add_to", kind="document", name="Wedding website mockup", args=lines(to="$wed_f"))]))

S("T09-038", "documents weekday span folder count",
  T("which docs did i add between last monday and this monday", rows("noa", "guest_sheet", "mockup", "invite_proof"),
    ref=[ans(kind="document", when=W(span(U("week", -1, weekday=1), U("week", 0, weekday=1))))]),
  T("which of them are actually in a folder", rows("noa", "guest_sheet", "invite_proof"),
    ref=[ans(within="@prev", where="folder count >= 1")]))

S("T09-039", "document date+time point",
  T("what was the doc i saved at 9:40 last night", rows("agm_draft"),
    ref=[ans(kind="document", when=W(U("day", -1, time="21:40")))]))

S("T09-040", "photo span person count album add_to",
  T("pics from april first through last month that have people in them",
    rows("court", "fitting_ada", "veil", "marcus_rugby", "nana_tea", "fam_dinner", "bp_pizza", "blossom_dan"),
    ref=[ans(kind="photo", when=W(span(D("2026-04-01"), U("month", -1))), where="person count != 0")]),
  T("is the rugby one in an album", rows(),
    ref=[ans(kind="album", linked_to="$marcus_rugby")]),
  T("add it to spring 2026", diff(link("spring_album", "marcus_rugby")),
    ref=[act("add_to", rows="$marcus_rugby", args=lines(to="$spring_album"))]),
  T("hmm undo, doesn't really fit there", diff(unlink("spring_album", "marcus_rugby")),
    ref=[act("undo")]))

S("T09-041", "photo from date delete undo",
  T("any photos since may first",
    rows("tulips", "noise_meter", "bp_tabs", "condo_lobby", "priya_coffee", "kemi_brunch_pic", "run_pic", "desk"),
    ref=[ans(kind="photo", when=W({"from": D("2026-05-01")}))]),
  T("delete the decibel one, that complaint is closed", diff(trash("noise_meter")),
    ref=[act("delete", kind="photo", name="Decibel reading 1804")]),
  T("ugh undo, gord wants it for the file", diff(restore("noise_meter")),
    ref=[act("undo")]))

S("T09-042", "photo count since april album to weekday",
  T("how many photos have i taken since april", val(20),
    ref=[ans(op="count", kind="photo", when=W({"from": U("month", 0, name=4)}))]),
  T("what's in the bar prep crew album up to the sunday before last", rows("bp_board", "bp_pizza"),
    ref=[ans(kind="photo", linked_to="$bar_album", when=W({"to": U("week", -2, weekday=7)}))]))

S("T09-043", "debt spans amount direction settle sum",
  T("what ious came up from the start of last month to may fifth",
    rows("d_ada", "d_marcus", "d_priya_s", "d_aiden", "d_jordan_l", "d_mom", "d_fatou", "d_ada2"),
    ref=[ans(kind="debt", when=W(span(U("month", -1), D("2026-05-05"))))]),
  T("which of those are 30 bucks or less", rows("d_priya_s", "d_jordan_l", "d_fatou", "d_ada2"),
    ref=[ans(within="@prev", where="amount <= 30 CAD")]),
  T("settle the one with fatou, paid her back at session", diff(upd("d_fatou", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Tabs for my binder")]),
  T("wait undo that, i paid her for the pizza not the tabs", diff(),
    ref=[act("undo")]),
  T("any new ones this month", rows("d_kemi", "d_priya_r", "d_ethan", "d_fatou", "d_ada2"),
    ref=[ans(kind="debt", when=W({"from": U("month", 0)}))]),
  T("which of those am i the one paying", rows("d_ethan", "d_fatou"),
    ref=[ans(within="@prev", where='direction in ("i_owe")')]),
  T("and the biggest thing i owe anyone", val((2000, "CAD")),
    ref=[ans(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T09-044", "debt from week direction in",
  T("any ious from this week", rows("d_ethan"),
    ref=[ans(kind="debt", when=W({"from": U("week", 0)}))]),
  T("what do i owe people", val((2106.5, "CAD")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction in ("i_owe") and status = "open"')]))

S("T09-045", "locker username url star multi",
  T("which logins use hokafor", rows("firm_login", "lso_portal"),
    ref=[ans(kind="locker item", where='username = "hokafor"')]),
  T("anything with lso.ca in the url", rows("lso_portal"),
    ref=[ans(kind="locker item", where='url contains "lso.ca"')]),
  T("star that and the minted account", diff(upd("lso_portal", starred=True), upd("minted", starred=True)),
    ref=[act("star", rows="$lso_portal, $minted")]),
  T("which login's on hanae.okafor@gmail.com", rows("minted"),
    ref=[ans(kind="locker item", where='username = "hanae.okafor@gmail.com"')]),
  T("send the minted password to ada so she can check the order", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T09-046", "locker url contains reveal",
  T("what's my login for the condo portal", rows("condo_portal"),
    ref=[ans(kind="locker item", where='url contains "condoportal"')]),
  T("show me the password", diff(reveal=[("condo_portal", "lobbyplants22")]),
    ref=[act("reveal", rows="$condo_portal", args=lines(field="password"))]))

S("T09-047", "group person count delete group",
  T("show groups that have a headcount of five or higher", rows("wparty", "barprep"),
    ref=[ans(kind="group", where="person count >= 5")]),
  T("delete the stag and doe group and start a fresh one called Stag night with the same guys",
    diff(gone("stag"), unlink("stag", "marcus"), unlink("stag", "jordan_l"), unlink("stag", "me"),
         new("group", name="Stag night"), link("new", "me"), link("new", "marcus"), link("new", "jordan_l")),
    ref=[find(kind="person", linked_to="$stag"),
         act("delete", kind="group", name="Stag and doe", more=True),
         act("create", more=True, args=lines(kind="group", name="Stag night")),
         act("add_to", rows="$marcus, $jordan_l", args=lines(to="$new"))]))

S("T09-048", "list area in open",
  T("lists for home or condo stuff", rows("home_list", "condo_list"),
    ref=[ans(kind="list", where='area in ("home", "condo")')]),
  T("what's open on the condo one", rows("agm_notice", "reserve", "repaint"),
    ref=[ans(kind="task", linked_to="$condo_list", where='status = "open"')]),
  T("which vendors do i actually have something booked with", rows("colette", "tariq"),
    ref=[ans(kind="person", where='role contains "wedding" and event count != 0')]),
  T("who have i written notes about", rows("dan", "hugo", "nana", "kemi", "margaret", "ravi", "dad", "gord"),
    ref=[ans(kind="person", where="note count != 0")]))

S("T09-049", "debt count balance",
  T("anyone with more than one iou", rows("ada"),
    ref=[ans(kind="person", where="debt count > 1")]),
  T("where am i at with her overall, with the group stuff", val((-50, "CAD")),
    ref=[ans(op="balance", rows="$ada")]))

S("T09-050", "effort under task count",
  T("quick jobs under fifteen min i haven't done", rows("index_fatou", "boardroom", "florist_dep", "smoke", "stamps"),
    ref=[ans(kind="task", where='effort < 15 and status = "open"')]),
  T("which tasks have subtasks", rows("guest_list", "factum"),
    ref=[ans(kind="task", where="task count != 0")]),
  T("what's left under the factum", rows("f_facts", "f_cite"),
    ref=[ans(kind="task", linked_to="$factum", where='status = "open"')]))
