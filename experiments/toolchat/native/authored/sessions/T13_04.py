from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T13-076", "five turns ambiguous event ask reschedule multi effort edit exclude",
  T("reschedule journal club to 3pm", ask("jc_0909", "jc_0930"),
    ref=[act("reschedule", kind="event", name="Journal club", args=lines(to=U("day", 0, anchor="row", time="15:00"))),
         find(kind="event", name="Journal club"),
         askc("the one on the 9th or the 30th?", options="$jc_0909, $jc_0930")]),
  T("both", diff(upd("jc_0909", date="2026-09-09T15:00"), upd("jc_0930", date="2026-09-30T15:00")),
    ref=[act("reschedule", rows="$jc_0909, $jc_0930", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("how long did i give prepare journal club slides", rows("jc_slides"),
    ref=[ans(kind="task", name="Prepare journal club slides")]),
  T("bump it to three hours", diff(upd("jc_slides", effort=180)),
    ref=[act("edit", rows="$jc_slides", args=lines(effort=180))]),
  T("anything else on the lab list over two hours", rows("xrd_analyse"),
    ref=[ans(kind="task", linked_to="$lab_l", where="effort > 120", exclude="$jc_slides")]))

S("T13-077", "five turns ambiguous task ask complete reschedule undo field",
  T("submit demonstrator timesheet - done", ask("ts_aug", "ts_sep"),
    ref=[act("complete", kind="task", name="Submit demonstrator timesheet"),
         find(kind="task", name="Submit demonstrator timesheet"),
         askc("august's or september's?", options="$ts_aug, $ts_sep")]),
  T("august", diff(upd("ts_aug", status="completed", completed=ANY)),
    ref=[act("complete", rows="$ts_aug")]),
  T("when's the september one due", rows("ts_sep"),
    ref=[ans(rows="$ts_sep")]),
  T("move it to the twenty-eighth", diff(upd("ts_sep", date="2026-09-28")),
    ref=[act("reschedule", rows="$ts_sep", args=lines(to=D("2026-09-28")))]),
  T("actually undo that", diff(upd("ts_sep", date="2026-09-30")),
    ref=[act("undo")]))

S("T13-078", "ambiguous notebook ask never mind count",
  T("can you delete the lab notebook", ask("lab25", "lab26"),
    ref=[act("delete", kind="notebook", name="Lab notebook"),
         askc("lab notebook 2025 or lab notebook 2026?", options="$lab25, $lab26")]),
  T("hmm neither, forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how many notes are in lab notebook 2025", val(2),
    ref=[ans(op="count", kind="note", linked_to="$lab25")]))

S("T13-079", "groups linked_to all delete group currency contains",
  T("which groups are priya menon and daniel mensah both in", rows("walkers"),
    ref=[ans(kind="group", linked_to="$priya, $daniel")]),
  T("delete it, we never use it",
    diff(gone("walkers"), unlink("walkers", "priya"), unlink("walkers", "daniel"), unlink("walkers", "me")),
    ref=[act("delete", rows="$walkers")]),
  T("which groups are in naira", rows("family"),
    ref=[ans(kind="group", where='currency contains "NGN"')]))

S("T13-080", "refused group delete ask never mind",
  T("delete the lab coffee fund", ask(),
    ref=[bad(act("delete", kind="group", name="Lab coffee fund")),
         askc("it still has expenses in it, so it can't be deleted. settle everyone up first?")]),
  T("nah leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T13-081", "refused folder delete ask trashed doc restore add_to",
  T("delete the tenancy folder, i'm moving out next june", ask(),
    ref=[bad(act("delete", kind="folder", name="Tenancy")),
         askc("it still has documents in it. want me to move them out first?")]),
  T("no leave it. is tenancy agreement 2025 in the trash", rows("tenancy25"),
    ref=[find(kind="document", name="Tenancy agreement 2025"), ans(rows="$tenancy25")]),
  T("restore it", diff(restore("tenancy25")),
    ref=[act("restore", rows="$tenancy25")]),
  T("and put it in the tenancy folder", diff(link("tenancy_f", "tenancy25")),
    ref=[act("add_to", rows="$tenancy25", args=lines(to="$tenancy_f"))]))

S("T13-082", "refused unit effort date span subtasks completed count",
  T("what's due between tomorrow and wednesday 5pm that'll take more than an hour", rows("xrd_analyse", "jc_slides"),
    ref=[bad(ans(kind="task", when=W(span(U("day", 1), U("week", 1, weekday=3, time="17:00"))), where="effort > 1 hour")),
         ans(kind="task", when=W(span(U("day", 1), U("week", 1, weekday=3, time="17:00"))), where="effort > 60")]),
  T("any of those split into subtasks", rows(),
    ref=[ans(within="@prev", where="task count >= 1")]),
  T("which tasks due this week have i already done", rows("rent_09"),
    ref=[ans(kind="task", when=W(U("week", 0)), where="completed is set")]),
  T("how many have i ticked off", val(13),
    ref=[ans(op="count", kind="task", where="completed is set")]))

S("T13-083", "five turns task counts date spans named months before datetime complete",
  T("how many things are due from the twentieth through october", val(11),
    ref=[ans(op="count", kind="task", when=W(span(D("2026-09-20"), U("month", 0, name=10))))]),
  T("from december?", val(0),
    ref=[ans(op="count", kind="task", when=W({"from": U("month", 0, name=12)}))]),
  T("november then", val(2),
    ref=[ans(op="count", kind="task", when=W({"from": U("month", 0, name=11)}))]),
  T("what's open and due before saturday midday",
    rows("ts_aug", "xrd_book", "loo_roll", "reply_aunty", "abstract", "send_mum", "garri"),
    ref=[ans(kind="task", when=W({"to": U("week", 0, weekday=6, time="12:00")}), where='status = "open"')]),
  T("reply to aunty ngozi is done", diff(upd("reply_aunty", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Reply to Aunty Ngozi")]))

S("T13-084", "six turns documents dates counts ambiguous rename miss search",
  T("anything i saved at 4:40 yesterday afternoon", rows("poster_v2"),
    ref=[ans(kind="document", when=W(U("day", -1, time="16:40")))]),
  T("how many docs did i add in july", val(5),
    ref=[ans(op="count", kind="document", when=W(U("month", 0, name=7)))]),
  T("and since last wednesday", val(5),
    ref=[ans(op="count", kind="document", when=W({"from": U("week", -1, weekday=3)}))]),
  T("list the ones from the start of august up to the twenty-eighth, 9am",
    rows("hotel_booking", "methods_outline", "stipend_aug"),
    ref=[ans(kind="document", when=W(span(U("month", 0, name=8), D("2026-08-28", "09:00"))))]),
  T("rename the stipend statement to Stipend Aug 2026", diff(upd("stipend_aug", name="Stipend Aug 2026")),
    ref=[act("edit", kind="document", name="Stipend statement", args=lines(name="Stipend Aug 2026")),
         act("edit", rows="$stipend_aug", args=lines(name="Stipend Aug 2026"))]),
  T("where's my brp letter", rows("brp_scan"),
    ref=[find(kind="document", name="BRP letter"), search("BRP"), ans(rows="$brp_scan")]))

S("T13-085", "five turns photos span people ask album add_to count",
  T("pics from 9am on the twenty-ninth aug to the thirtieth", rows("p_bbq", "p_meter"),
    ref=[ans(kind="photo", when=W(span(D("2026-08-29", "09:00"), D("2026-08-30"))))]),
  T("which have people in them", rows("p_bbq"),
    ref=[ans(within="@prev", where="person count >= 1")]),
  T("put the meter one in an album", ask(),
    ref=[askc("which album?")]),
  T("house", diff(link("house_al", "p_meter")),
    ref=[act("add_to", rows="$p_meter", args=lines(to="$house_al"))]),
  T("how many in house", val(4),
    ref=[ans(op="count", kind="photo", linked_to="$house_al")]))

S("T13-086", "photo counts spans refused date repair album count latest",
  T("how many photos from first aug midday up to this monday", val(14),
    ref=[ans(op="count", kind="photo", when=W(span(D("2026-08-01", "12:00"), U("week", 0, weekday=1))))]),
  T("and of the ones before last monday, how many are in an album", val(15),
    ref=[bad(ans(op="count", kind="photo", when=W({"to": {"unit": "week", "weekday": 1}}), where="album count != 0")),
         ans(op="count", kind="photo", when=W({"to": U("week", -1, weekday=1)}), where="album count != 0")]),
  T("what's the latest photo that isn't in any album", rows("p_ticket"),
    ref=[ans(kind="photo", where="album count = 0", order="date desc", limit=1)]))

S("T13-087", "people counts since cadence before weekday log prev multi",
  T("how many people have i been in touch with since the first", val(7),
    ref=[ans(op="count", kind="person", when=W({"from": D("2026-09-01")}))]),
  T("and since 6pm yesterday", val(3),
    ref=[ans(op="count", kind="person", when=W({"from": U("day", -1, time="18:00")}))]),
  T("who's on a fortnightly or longer cadence that i haven't contacted since before last monday",
    rows("dad", "aunty_ngozi", "nkechi", "ngozi_e", "seun", "daniel"),
    ref=[ans(kind="person", where="cadence >= 14 days", when=W({"to": U("week", -1, weekday=1)}))]),
  T("log a message for all of them, sent a group text",
    diff(upd("dad", date=ANY), upd("aunty_ngozi", date=ANY), upd("nkechi", date=ANY), upd("ngozi_e", date=ANY),
         upd("seun", date=ANY), upd("daniel", date=ANY)),
    ref=[act("log", rows="@prev", args=lines(kind="message"))]))

S("T13-088", "five turns role not met count note count ambiguous person ask log",
  T("who on the nigsoc committee isn't the president", rows("ngozi_e", "emeka", "tunde", "seun", "me"),
    ref=[ans(kind="person", linked_to="$nigsoc", where='role != "NigSoc president"')]),
  T("how many people have i got a 'met' for", val(11),
    ref=[ans(op="count", kind="person", where="met is set")]),
  T("anyone with three or more notes about them", rows("mum", "wei"),
    ref=[ans(kind="person", where="note count >= 3")]),
  T("log a call with ngozi", ask("ngozi_e", "aunty_ngozi"),
    ref=[act("log", kind="person", name="Ngozi", args=lines(kind="call")),
         askc("ngozi eze or aunty ngozi?", options="$ngozi_e, $aunty_ngozi")]),
  T("the treasurer", diff(upd("ngozi_e", date=ANY)),
    ref=[act("log", rows="$ngozi_e", args=lines(kind="call"))]))

S("T13-089", "five turns all day weekday overlap refused ask create body in",
  T("any all-day things the week after next", rows("chichi_bday"),
    ref=[ans(kind="event", when=W(U("week", 2)), where="duration is empty")]),
  T("what about next friday", rows(),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=5)), where="duration is empty")]),
  T("add a call with raj on tuesday at 3pm", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Call with Raj", date=U("week", 1, weekday=2, time="15:00")))),
         askc("you've got the xrd session 2-4 that day. 4pm instead?")]),
  T("yeah 4", diff(new("event", name="Call with Raj", date="2026-09-08T16:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Raj", date=U("week", 1, weekday=2, time="16:00")))]),
  T("how many notes say tbc or draft", val(3),
    ref=[ans(op="count", kind="note", where='body in ("tbc", "draft")')]))

S("T13-090", "notes span no people delete pin named",
  T("notes from last week up to yesterday noon that aren't about anyone", rows("seminar_note"),
    ref=[ans(kind="note", when=W(span(U("week", -1), U("day", -1, time="12:00"))), where="person count = 0")]),
  T("delete it, it's empty", diff(trash("seminar_note")),
    ref=[act("delete", rows="$seminar_note")]),
  T("pin tolerance factor idea", diff(upd("tolerance", pinned=True)),
    ref=[act("edit", kind="note", name="Tolerance factor idea", args=lines(pinned="yes"))]))

S("T13-091", "five turns debts last month sums status amount ask settle",
  T("how much did i lend out last month", val((120.5, "GBP")),
    ref=[ans(op="sum", field="amount", kind="debt", when=W(U("month", -1)), where='direction = "owes_me"')]),
  T("not counting what's been paid back", val((85.5, "GBP")),
    ref=[ans(op="sum", field="amount", kind="debt", when=W(U("month", -1)),
             where='direction = "owes_me" and status != "settled"')]),
  T("which of those were 20 quid or more", rows("d_kasia", "d_tunde"),
    ref=[ans(kind="debt", when=W(U("month", -1)),
             where='direction = "owes_me" and status != "settled" and amount >= 20 GBP')]),
  T("settle tom's", ask("tom_h", "tom_b"),
    ref=[find(kind="person", name="Tom"), askc("tom hargreaves or tom bennett?", options="$tom_h, $tom_b")]),
  T("hargreaves", diff(upd("d_tom_h", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$tom_h")]))

S("T13-092", "debts spans substitution nickname log recovery search",
  T("what did i borrow from two months ago to the end of august", rows("d_obinna", "d_priya", "d_wei"),
    ref=[ans(kind="debt", when=W(span(U("month", -2), U("month", 0, name=8))), where='direction = "i_owe"')]),
  T("and between last tuesday and wednesday this week?", rows("d_wei", "d_emeka"),
    ref=[ans(kind="debt", when=W(span(U("week", -1, weekday=2), U("week", 0, weekday=3))), where='direction = "i_owe"')]),
  T("had coffee with seun yesterday, log it", diff(upd("seun", date=ANY)),
    ref=[act("log", kind="person", name="Seun", args=lines(kind="coffee")), search("Seun", kind="person"),
         act("log", rows="$seun", args=lines(kind="coffee"))]))

S("T13-093", "compute sum grouped locker notes decline fabricated reveal",
  T("last month, how much went out vs came in, by direction", vgroups({"i_owe": (42, "GBP"), "owes_me": (120.5, "GBP")}),
    ref=[comp(op="sum", field="amount", group="direction", kind="debt", when=W(U("month", -1))), ans(value="@prev")]),
  T("which locker things say renews january", rows("rsc", "iom3"),
    ref=[ans(kind="locker item", where='notes = "renews January"')]),
  T("make me up a strong password for the new router", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("fine, what's my zotero password", diff(reveal=[("zotero_login", "halide-films-4")]),
    ref=[act("reveal", rows="$zotero_login", args=lines(field="password"))]))

S("T13-094", "six turns lisbon ask create event write read star",
  T("when do i fly to lisbon", rows("lisbon_out"),
    ref=[ans(kind="event", name="Flight to Lisbon")]),
  T("add a taxi to the airport that morning", ask(),
    ref=[askc("what time should the taxi be?")]),
  T("5am, 45 mins", diff(new("event", name=has("Taxi"), date="2026-09-20T05:00")),
    ref=[act("create", args=lines(kind="event", name="Taxi to the airport", date=D("2026-09-20", "05:00"), duration=45))]),
  T("mark buy eu plug adapter done and tell me what's left on shopping",
    rows("garri", also=diff(upd("adapter", status="completed", completed=ANY))),
    ref=[act("complete", rows="$adapter", more=True), ans(kind="task", linked_to="$shopping_l", where='status = "open"')]),
  T("what's in the conference folder", rows("acceptance", "hotel_booking", "poster_v2"),
    ref=[ans(kind="document", linked_to="$conf_f")]),
  T("star lisbon hotel booking", diff(upd("hotel_booking", starred=True)),
    ref=[act("star", rows="$hotel_booking")]))

S("T13-095", "five turns ambiguous rent narrowed write list undo field",
  T("pay rent - done", diff(upd("rent_10", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay rent"),
         act("complete", kind="task", name="Pay rent", where='status = "open"')]),
  T("what's left on the house list", rows("loo_roll", "broadband", "bins", "rota"),
    ref=[ans(kind="task", linked_to="$house_l", where='status = "open"')]),
  T("put the bins out and write the new cleaning rota are done too",
    diff(upd("bins", status="completed", completed=ANY), upd("rota", status="completed", completed=ANY)),
    ref=[act("complete", rows="$bins, $rota")]),
  T("undo", diff(upd("bins", status="open", completed=None), upd("rota", status="open", completed=None)),
    ref=[act("undo")]),
  T("just the bins then", diff(upd("bins", status="completed", completed=ANY)),
    ref=[act("complete", rows="$bins")]))

S("T13-096", "decline out of scope search miss not found",
  T("book a table at the nigerian place on oxford road for saturday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("what's the cvv on my barclays card", decline("not_found"),
    ref=[search("Barclays"), dec("not_found")]))

S("T13-097", "find miss search miss decline find other kind recovery linked",
  T("when's my swimming lesson", decline("not_found"),
    ref=[find(kind="event", name="swimming"), search("swimming"), dec("not_found")]),
  T("ok the kinder scout task, when's that", rows("walk"),
    ref=[find(kind="task", name="Kinder Scout"), ans(rows="$walk")]),
  T("who's coming", rows("daniel", "priya"),
    ref=[ans(kind="person", linked_to="$walk")]))

S("T13-098", "single ask without options create",
  T("add dinner with nkechi uzor to the diary", ask(),
    ref=[askc("when's the dinner?")]))

S("T13-099", "single ambiguous event ask",
  T("move lab group meeting to 11", ask(),
    ref=[act("reschedule", kind="event", name="Lab group meeting", args=lines(to=U("day", 0, anchor="row", time="11:00"))),
         askc("which week's lab group meeting?")]))

S("T13-100", "seven turns thesis list subtasks reschedule sum already create",
  T("what's on the thesis list", rows("litrev", "methods", "figures", "review_form"),
    ref=[ans(kind="task", linked_to="$thesis_l")]),
  T("which have subtasks", rows("litrev", "methods"),
    ref=[ans(within="@prev", where="task count >= 1")]),
  T("subtasks of draft literature review chapter", rows("summarise", "zotero", "send_helen"),
    ref=[ans(kind="task", linked_to="$litrev")]),
  T("move fix citations in zotero to saturday", diff(upd("zotero", date="2026-09-05")),
    ref=[act("reschedule", rows="$zotero", args=lines(to=U("week", 0, weekday=6)))]),
  T("how much time's left on those subtasks altogether", val(340),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$litrev", where='status = "open"')]),
  T("star the masters graduation photo", rows("p_graduation", also=diff(already=["p_graduation"])),
    ref=[act("star", kind="photo", name="Masters graduation"), ans(rows="$p_graduation")]),
  T("remind me to email helen the draft on the thirtieth",
    diff(new("task", name=has("Helen", "draft"), date="2026-09-30")),
    ref=[act("create", args=lines(kind="task", name="Email Helen the draft", date=D("2026-09-30")))]))
