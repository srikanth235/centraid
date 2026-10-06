from gold import *
import json
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
LIVE = 'status = "open"'
OWE = 'direction = "i_owe" and status = "open"'
def next_group():
    return find(kind="event", name="Lab group meeting", when=W({"from": U("day", 0)}), order="date asc", limit=1)
def badminton():
    return find(kind="event", name="Badminton", when=W(span(U("day", 0), U("month", 0))))
WEEKEND = W(span(U("week", 0, weekday=6), U("week", 0, weekday=7)))
def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T13-001-P", "events tomorrow reschedule linked para",
  T("what've i got tmrw", rows("sem", "wei_xrd", "badminton_0904"),
    ref=[find(kind="event", when=W(U("day", 1))), ans(rows="@prev")]),
  T("wei one, make it 3 instead", diff(upd("wei_xrd", date="2026-09-04T15:00")),
    ref=[act("reschedule", rows="$wei_xrd", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("sem training, who's in charge of it", rows("sandra"),
    ref=[ans(kind="person", linked_to="$sem")]))

S("T13-006-P", "find role log prev linked para",
  T("the xrd facility contact, name?", rows("raj"),
    ref=[find(kind="person", where='role contains "XRD"'), ans(rows="@prev")]),
  T("note down a message with him, it was about beam hours", diff(upd("raj", date=ANY)),
    ref=[act("log", rows="@prev", args=lines(kind="message"))]),
  T("tasks tied to him?", rows("xrd_book", "xrd_book_lukas"),
    ref=[ans(kind="task", linked_to="$raj")]))

S("T13-012-P", "restore person named trashed recovery para",
  T("need kevin marsh for the deposit, restore him to my contacts", diff(restore("kevin")),
    ref=[act("restore", kind="person", name="Kevin Marsh"), act("restore", rows="$kevin")]),
  T("and what does he do", rows("kevin"),
    ref=[ans(rows="$kevin")]))

S("T13-017-P", "find photo add_to prev star prev para",
  T("xrd machine photo, where is it", rows("p_xrd"),
    ref=[find(kind="photo", name="XRD machine"), ans(rows="@prev")]),
  T("lab life album should have it", diff(link("lab_al", "p_xrd")),
    ref=[act("add_to", rows="@prev", args=lines(to="$lab_al"))]),
  T("give it a star too", diff(upd("p_xrd", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T13-022-P", "find doc unstar prev trashed document para",
  T("tenancy agreement, has it got a star", rows("tenancy26"),
    ref=[find(kind="document", name="Tenancy agreement"), ans(rows="@prev")]),
  T("take its star off", diff(upd("tenancy26", starred=False)),
    ref=[act("unstar", rows="@prev")]),
  T("i thought a 2025 version existed as well", rows("tenancy25"),
    ref=[find(kind="document", name="Tenancy agreement 2025"),
         ans(kind="document", name="Tenancy agreement 2025", trashed=True)]))

S("T13-029-P", "remove_from note where body in para",
  T("thesis ideas shouldn't have the tbc note, pull it out", diff(unlink("thesis_nb", "grant_note")),
    ref=[act("remove_from", kind="note", linked_to="$thesis_nb", where='body = "tbc"', args=lines(from_="$thesis_nb"))]),
  T("notes whose text is tbc or draft?", rows("seminar_note", "grant_note", "abstract_note"),
    ref=[ans(kind="note", where='body in ("tbc", "draft")')]))

S("T13-034-P", "photos datetime to weekday album count para",
  T("photos starting twenty-first aug 7pm movie night, up to last sunday",
    rows("p_movie", "p_suya", "p_whiteboard", "p_garden", "p_seun", "p_bbq", "p_meter", "p_films"),
    ref=[ans(kind="photo", when=W(span(D("2026-08-21", "19:00"), U("week", -1, weekday=7))))]),
  T("of those, the ones in no album yet", rows("p_whiteboard", "p_seun", "p_meter"),
    ref=[ans(within="@prev", where="album count = 0")]),
  T("and those sitting in an album?", rows("p_movie", "p_suya", "p_garden", "p_bbq", "p_films"),
    ref=[ans(within="@1", where="album count != 0")]))

S("T13-039-P", "debts span month named max para",
  T("lent money from two months ago through august, to whom",
    rows("d_chinedu", "d_tom_h", "d_kasia", "d_seun", "d_lukas", "d_tunde"),
    ref=[ans(kind="debt", when=W(span(U("month", -2), U("month", 0, name=8))), where='direction = "owes_me"')]),
  T("largest one among them", rows("d_chinedu"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T13-045-P", "contacted since datetime para",
  T("contacts i've spoken to after yesterday 6pm", rows("tom_h", "priya", "wei"),
    ref=[ans(kind="person", when=W({"from": U("day", -1, time="18:00")}))]),
  T("make it tuesday 9am onwards", rows("chiamaka", "tom_b", "emeka", "fatima", "tom_h", "priya", "wei"),
    ref=[ans(kind="person", when=W({"from": U("week", 0, weekday=2, time="09:00")}))]),
  T("record a call to tom", ask("tom_h", "tom_b"),
    ref=[act("log", kind="person", name="Tom", args=lines(kind="call")),
         askc("tom hargreaves or tom bennett?", options="$tom_h, $tom_b")]),
  T("tom bennett, we talked kettle money", diff(upd("tom_b", date=ANY)),
    ref=[act("log", rows="$tom_b", args=lines(kind="call"))]))

S("T13-052-P", "seven turns nigsoc upcoming members write read log subtasks para",
  T("upcoming nigsoc events?", rows("committee", "freshers"),
    ref=[ans(kind="event", name="NigSoc", when=W({"from": U("day", 0)}))]),
  T("freshers welcome attendees, who", rows("chinedu", "emeka", "seun"),
    ref=[ans(kind="person", linked_to="$freshers")]),
  T("nigsoc list, which are still open", rows("hall", "jollof", "flyer", "fees"),
    ref=[ans(kind="task", linked_to="$nigsoc_l", where='status = "open"')]),
  T("hall is booked so complete it, then what's still open",
    rows("jollof", "flyer", "fees", also=diff(upd("hall", status="completed", completed=ANY))),
    ref=[act("complete", rows="$hall", more=True),
         ans(kind="task", linked_to="$nigsoc_l", where='status = "open"')]),
  T("i phoned chinedu, put that call down", diff(upd("chinedu", date=ANY)),
    ref=[act("log", rows="$chinedu", args=lines(kind="call"))]),
  T("flyer task, its subtasks?", rows("logo", "print_flyers"),
    ref=[ans(kind="task", linked_to="$flyer")]),
  T("emeka gave me the logo already, so tick the logo one", diff(upd("logo", status="completed", completed=ANY)),
    ref=[act("complete", rows="$logo")]))

S("T13-058-P", "lists task count move task undo link para",
  T("lists with something on them", rows("thesis_l", "lab_l", "house_l", "nigsoc_l", "personal_l", "shopping_l"),
    ref=[ans(kind="list", where="task count != 0")]),
  T("buy eu plug adapter belongs on personal, not shopping",
    diff(unlink("shopping_l", "adapter"), link("personal_l", "adapter")),
    ref=[act("remove_from", rows="$adapter", args=lines(from_="$shopping_l"), more=True),
         act("add_to", rows="$adapter", args=lines(to="$personal_l"))]),
  T("actually revert that, undo", diff(link("shopping_l", "adapter"), unlink("personal_l", "adapter")),
    ref=[act("undo")]))

S("T13-063-P", "folder linked_to all add_to multi empty folders delete prev para",
  T("stipend statement august plus stipend statement july, which folder holds them", rows("funding_f"),
    ref=[ans(kind="folder", linked_to="$stipend_aug, $stipend_jul")]),
  T("payslip july and payslip august go in that folder as well",
    diff(unlink("payslips_f", "payslip_jul"), unlink("payslips_f", "payslip_aug"),
         link("funding_f", "payslip_jul"), link("funding_f", "payslip_aug")),
    ref=[act("add_to", rows="$payslip_jul, $payslip_aug", args=lines(to="$funding_f"))]),
  T("folders with nothing in them?", rows("payslips_f", "coursework_f"),
    ref=[find(kind="folder", where="document count = 0"), ans(rows="@prev")]),
  T("get rid of those two", diff(gone("payslips_f"), gone("coursework_f")),
    ref=[act("delete", rows="@prev")]))

S("T13-069-P", "locker empty answer starred card unstar prev para",
  T("logins lacking a username?", rows(),
    ref=[ans(kind="locker item", where='type = "login" and username is empty')]),
  T("starred card, which one", rows("monzo"),
    ref=[find(kind="locker item", where='type = "card" and starred = yes'), ans(rows="@prev")]),
  T("remove its star", diff(upd("monzo", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T13-074-P", "event status empty cancelled delete undo para",
  T("diary entries missing a status", rows(),
    ref=[ans(kind="event", where="status is empty")]),
  T("cancelled ones?", rows("group_0831", "gp", "diamond"),
    ref=[ans(kind="event", where='status = "cancelled"')]),
  T("gp one is pointless, delete it", diff(trash("gp")),
    ref=[act("delete", rows="$gp")]),
  T("put that back, undo", diff(restore("gp")),
    ref=[act("undo")]))

S("T13-079-P", "groups linked_to all delete group currency contains para",
  T("groups containing priya menon and daniel mensah both", rows("walkers"),
    ref=[ans(kind="group", linked_to="$priya, $daniel")]),
  T("we never use it, get rid of it",
    diff(gone("walkers"), unlink("walkers", "priya"), unlink("walkers", "daniel"), unlink("walkers", "me")),
    ref=[act("delete", rows="$walkers")]),
  T("naira groups?", rows("family"),
    ref=[ans(kind="group", where='currency contains "NGN"')]))

S("T13-086-P", "photo counts spans refused date repair album count latest para",
  T("photo count, first aug midday through this monday", val(14),
    ref=[ans(op="count", kind="photo", when=W(span(D("2026-08-01", "12:00"), U("week", 0, weekday=1))))]),
  T("before last monday, how many photos sit in an album", val(15),
    ref=[bad(ans(op="count", kind="photo", when=W({"to": {"unit": "week", "weekday": 1}}), where="album count != 0")),
         ans(op="count", kind="photo", when=W({"to": U("week", -1, weekday=1)}), where="album count != 0")]),
  T("latest photo not in any album, which", rows("p_ticket"),
    ref=[ans(kind="photo", where="album count = 0", order="date desc", limit=1)]))

S("T13-091-P", "five turns debts last month sums status amount ask settle para",
  T("total lent out last month?", val((120.5, "GBP")),
    ref=[ans(op="sum", field="amount", kind="debt", when=W(U("month", -1)), where='direction = "owes_me"')]),
  T("minus whatever got repaid", val((85.5, "GBP")),
    ref=[ans(op="sum", field="amount", kind="debt", when=W(U("month", -1)),
             where='direction = "owes_me" and status != "settled"')]),
  T("any of those 20 quid or above", rows("d_kasia", "d_tunde"),
    ref=[ans(kind="debt", when=W(U("month", -1)),
             where='direction = "owes_me" and status != "settled" and amount >= 20 GBP')]),
  T("tom's debt, mark it settled", ask("tom_h", "tom_b"),
    ref=[find(kind="person", name="Tom"), askc("tom hargreaves or tom bennett?", options="$tom_h, $tom_b")]),
  T("tom hargreaves", diff(upd("d_tom_h", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$tom_h")]))

S("T13-096-P", "decline out of scope search miss not found para",
  T("reserve saturday at the nigerian place on oxford road", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("barclays card cvv?", decline("not_found"),
    ref=[search("Barclays"), dec("not_found")]))

S("T13-A001-P", "ask-options event reschedule c3a para",
  T("journal club moves to next friday", ask("jc_0909", "jc_0930"),
    ref=[act("reschedule", kind="event", name="Journal club", args=lines(to=U("week", 1, weekday=5))),
         find(kind="event", name="Journal club", when=J({"from": U("day", 0)})),
         askc("The one on 9 Sept or the one on 30 Sept?", options="$jc_0909, $jc_0930")]),
  T("i'm presenting on the 9th, that one", diff(upd("jc_0909", date="2026-09-11T16:00")),
    ref=[act("reschedule", rows="$jc_0909", args=lines(to=U("week", 1, weekday=5)))]))

S("T13-A007-P", "follow-up c3a para",
  T("anyone owing me", rows("d_kasia", "d_chinedu", "d_tom_b", "d_nkechi", "d_tom_h", "d_tunde", "d_fatima"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("over 20 among them", rows("d_nkechi", "d_kasia", "d_tunde", "d_chinedu"),
    ref=[ans(within="@prev", where="amount > 20 GBP")]),
  T("what else is there", rows("d_tom_h", "d_tom_b", "d_fatima"),
    ref=[ans(within="@1", exclude="@2")]))

S("T13-B005-P", "c4b state-change cancel event restore trashed task para",
  T("landlord inspection is off, gary called", diff(upd("landlord", status="cancelled")),
    ref=[act("cancel", kind="event", name="Landlord inspection")]),
  T("window latch one, restore it", diff(restore("latch")),
    ref=[act("restore", kind="task", name="window latch", trashed=True)]))

S("T13-C003-P", "c3c compound complete edit para",
  T("rename the broadband task to Switch broadband provider, and loo roll's been bought so complete that",
    diff(upd("loo_roll", status="completed", completed=ANY), upd("broadband", name="Switch broadband provider")),
    ref=[act("complete", kind="task", name="Buy toilet roll for the house", more=True),
         act("edit", kind="task", name="Sort out the broadband switch", args=lines(name="Switch broadband provider"))]))

S("T13-101-P", "ask person star two toms para",
  T("tom gets a star", ask("tom_h", "tom_b"),
    ref=[act("star", kind="person", name="Tom"),
         askc("tom hargreaves or tom bennett?", options="$tom_h, $tom_b")]),
  T("the housemate one, hargreaves", diff(upd("tom_h", starred=True)),
    ref=[act("star", rows="$tom_h")]))

S("T13-106-P", "ask event cancel supervisor meeting then log para",
  T("supervisor meeting is off", ask("helen_0826", "helen_0909"),
    ref=[act("cancel", kind="event", name="Supervisor meeting with Helen"),
         find(kind="event", name="Supervisor meeting with Helen"),
         askc("the one on the 26th or the 9th?", options="$helen_0826, $helen_0909")]),
  T("she's at a conference, so the 9th", diff(upd("helen_0909", status="cancelled")),
    ref=[act("cancel", rows="$helen_0909")]),
  T("helen got a message from me saying it's off, log it", diff(upd("helen", date=ANY)),
    ref=[act("log", kind="person", name="Helen", args=lines(kind="message"))]))

S("T13-112-P", "decline out of scope weather then task para",
  T("manchester tomorrow, rain or shine", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("new task for tomorrow: take my umbrella to the lab",
    diff(new("task", name=has("umbrella"), date="2026-09-04")),
    ref=[act("create", args=lines(kind="task", name="Take my umbrella to the lab", date=U("day", 1)))]),
  T("tomorrow's due tasks, how many", val(4),
    ref=[ans(op="count", kind="task", when=W(U("day", 1)))]))
