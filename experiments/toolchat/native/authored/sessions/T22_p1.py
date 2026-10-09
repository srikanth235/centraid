from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
def J(d):
    return json.dumps(d, separators=(",", ":"))
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T22-004-P", "group person count edit group named count para",
  T("groups holding over five people, which are they", rows("padel_g", "fika_g"),
    ref=[ans(kind="group", where="person count > 5")]),
  T("call the fika fund one Late shift fika", diff(upd("fika_g", name="Late shift fika")),
    ref=[act("edit", rows="$fika_g", args=lines(name="Late shift fika"))]),
  T("number of people in that group", val(6),
    ref=[ans(op="count", kind="person", linked_to="$fika_g")]))

S("T22-013-P", "delete task where list read para",
  T("on the summer house repairs list, get rid of the task that got cancelled", diff(trash("sauna")),
    ref=[act("delete", kind="task", linked_to="$shr_l", where='status = "cancelled"')]),
  T("what's still there on that list", rows("roof_tile", "shutters"),
    ref=[ans(kind="task", linked_to="$shr_l")]))

S("T22-018-P", "create note edit note new delete note new para",
  T("new note, Party seating, with Mamma next to Pappa, Elias by Karin",
    diff(new("note", name="Party seating", body=has("Elias"))),
    ref=[act("create", args=lines(kind="note", name="Party seating", body="Mamma next to Pappa, Elias by Karin"))]),
  T("also seat samira next to nour", diff(upd("+1", body=has("Samira"))),
    ref=[act("edit", rows="$c1", args=lines(body="Mamma next to Pappa, Elias by Karin, Samira next to Nour"))]),
  T("karin's doing the seating herself, so get rid of the note", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T22-023-P", "remove_from document where folder read para",
  T("in june i filed stuff in the IKEA folder, pull it back out", diff(unlink("work_f", "payslip_jun")),
    ref=[act("remove_from", kind="document", linked_to="$work_f", when=W(U("month", 0, name=6)),
             args=lines(from_="$work_f"))]),
  T("what remains in there now", rows("contract", "payslip_may", "forklift_cert"),
    ref=[ans(kind="document", linked_to="$work_f")]))

S("T22-028-P", "person group count debt count para",
  T("which people are in at least two of my groups", rows("ahmed", "karin", "david", "lena", "me"),
    ref=[ans(kind="person", where="group count > 1")]),
  T("padel people i have no debts with in either direction", rows("erik_l"),
    ref=[ans(kind="person", where='debt count < 1 and role contains "padel"')]),
  T("he's the organiser, right?", rows("erik_l"),
    ref=[ans(rows="$erik_l")]))

S("T22-033-P", "event person count week anchor tomorrow para",
  T("next week, which things have no one else attending", rows("car_service", "drive_osterlen"),
    ref=[ans(kind="event", when=W(U("week", 1)), where="person count = 0")]),
  T("what about tomorrow then", rows("safety_walk", "swim_1", "padel_0714", "samira_call"),
    ref=[ans(kind="event", when=W(U("day", 1, anchor="today")))]))

S("T22-038-P", "event open to date linked ordinal reschedule people para",
  T("before september, all the things that include david", rows("picnic_jun", "picnic_aug", "kayak"),
    ref=[ans(kind="event", linked_to="$david", when=W({"to": D("2026-09-01")}))]),
  T("make the second picnic start at 12", diff(upd("picnic_aug", date="2026-08-16T12:00")),
    ref=[act("reschedule", rows="$picnic_aug", args=lines(to=U("day", 0, anchor="row", time="12:00")))]),
  T("who's attending that one", rows("maria", "david", "lena"),
    ref=[ans(kind="person", linked_to="$picnic_aug")]))

S("T22-042-P", "task list count add_to task count empty para",
  T("prioritised tasks that aren't on a list", rows("scanners", "party", "agency", "passport", "guest_room"),
    ref=[ans(kind="task", where="priority is set and list count != 1")]),
  T("the scanners one belongs on the warehouse list, add it there", diff(link("work_l", "scanners")),
    ref=[act("add_to", rows="$scanners", args=lines(to="$work_l"))]),
  T("is it true Shift schedule for August has under 3 subtasks", rows(),
    ref=[ans(kind="task", name="Shift schedule for August", where="task count < 3")]))

S("T22-048-P", "note weekday already pin para",
  T("list the notes i wrote on last thursday", rows("racking_note", "lineup"),
    ref=[ans(kind="note", when=W(U("week", -1, weekday=4)))]),
  T("lineup one should be pinned", diff(already=["lineup"]),
    ref=[act("edit", rows="$lineup", args=lines(pinned="yes")), ans(rows="$lineup")]),
  T("pin the other note as well", diff(upd("racking_note", pinned=True)),
    ref=[act("edit", kind="note", within="@1", where="pinned = no", args=lines(pinned="yes"))]))

S("T22-054-P", "document open to year within starred para",
  T("docs dated earlier than this year, which are they", rows("lease", "contract", "forklift_cert", "adoption_decision", "birth_cert",
                                                 "deed", "co_owner", "car_reg"),
    ref=[ans(kind="document", when=W({"to": U("year", -1)}))]),
  T("among them, starred ones?", rows("lease", "contract", "adoption_decision", "deed"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T22-058-P", "album photo count edit album prev count para",
  T("any album that's empty of photos", rows("crayfish_al"),
    ref=[ans(kind="album", where="photo count = 0")]),
  T("new name for it, Crayfish party 2026", diff(upd("crayfish_al", name="Crayfish party 2026")),
    ref=[act("edit", rows="@prev", args=lines(name="Crayfish party 2026"))]),
  T("total album count", val(7),
    ref=[ans(op="count", kind="album")]))

S("T22-063-P", "create locker delete restore new restore window ask para",
  T("locker needs my Malmö city library card, type membership, add it",
    diff(new("locker item", name=has("library"), type="membership")),
    ref=[act("create", args=lines(kind="locker item", name="Malmö city library", type="membership"))]),
  T("get rid of it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("wait, i do use it, restore it", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]),
  T("restore the Old Tele2 login as well", ask(),
    ref=[bad(act("restore", kind="locker item", name="Old Tele2 login", trashed=True)),
         askc("the tele2 login was binned on 10 may, more than 30 days ago, so it can't be restored. save it again as a new login?")]))

S("T22-068-P", "list task count ambiguous list resolved count para",
  T("lists holding at most three tasks", rows("shr_l", "shop_l"),
    ref=[ans(kind="list", where="task count <= 3")]),
  T("summer house one, switch its area to maintenance", diff(upd("shr_l", area="maintenance")),
    ref=[act("edit", kind="list", name="Summer house", args=lines(area="maintenance")),
         act("edit", rows="$shr_l", args=lines(area="maintenance"))]),
  T("shopping, how many tasks", val(3),
    ref=[ans(op="count", kind="task", linked_to="$shop_l")]))

S("T22-073-P", "debt span named month datetime open to date para",
  T("from june to friday noon, which debts fall in that window", rows("d_karin", "d_david", "d_erik", "d_micke", "d_gunnar", "d_johan_b"),
    ref=[ans(kind="debt", when=W(span(U("month", 0, name=6), U("week", -1, weekday=5, time="12:00"))))]),
  T("before the first of june, any debts", rows("d_samira", "d_lena"),
    ref=[ans(kind="debt", when=W({"to": D("2026-06-01")}))]))

S("T22-078-P", "single note notebook count linked person para",
  T("which of the notes tied to Birgitta Lindqvist sit in a notebook", rows("meatballs"),
    ref=[ans(kind="note", linked_to="$birgitta", where="notebook count > 0")]))

S("T22-086-P", "five turns note weekday day time unpin multi undo knock-on note from weekday para",
  T("last night's 22:10 note", rows("inv_plan"),
    ref=[ans(kind="note", when=W(U("day", -1, time="22:10")))]),
  T("and notes from last thursday?", rows("racking_note", "lineup"),
    ref=[ans(kind="note", when=W(U("week", -1, weekday=4)))]),
  T("League lineup and Late shift rota, take their pins off", diff(upd("lineup", pinned=False), upd("late_rota", pinned=False)),
    ref=[act("edit", rows="$lineup, $late_rota", args=lines(pinned="no"))]),
  T("undo it", diff(upd("lineup", pinned=True), upd("late_rota", pinned=True)),
    ref=[act("undo")]),
  T("any notes dated last wednesday onward",
    rows("appraisal_notes", "racking_note", "lineup", "gift_ideas", "camp_info", "inv_plan", "speech_draft"),
    ref=[ans(kind="note", when=W({"from": U("week", -1, weekday=3)}))]))

S("T22-091-P", "seven turns picnic ambiguous ask cancel create people restore window ask never mind para",
  T("picnic date?", rows("picnic_jun", "picnic_aug"),
    ref=[ans(kind="event", name="picnic")]),
  T("maria says it's off, so call it off", ask("picnic_jun", "picnic_aug"),
    ref=[act("cancel", kind="event", name="Parents network picnic"),
         find(kind="event", name="Parents network picnic"),
         askc("june's or the one on 16 august?", options="$picnic_jun, $picnic_aug")]),
  T("obviously august's", diff(upd("picnic_aug", status="cancelled")),
    ref=[act("cancel", rows="$picnic_aug")]),
  T("instead, put Picnic at Pildammsparken down for twenty-third aug at 11",
    diff(new("event", name="Picnic at Pildammsparken", date="2026-08-23T11:00")),
    ref=[act("create", args=lines(kind="event", name="Picnic at Pildammsparken", date=D("2026-08-23", "11:00")))]),
  T("the old one, who was coming", rows("maria", "david", "lena"),
    ref=[ans(kind="person", linked_to="$picnic_aug")]),
  T("bring back the Padel trial session from april too", ask(),
    ref=[bad(act("restore", kind="event", name="Padel trial session", trashed=True)),
         askc("the padel trial session was deleted on 1 may, past the 30 days, so it can't be restored. add it again?")]),
  T("nope never mind", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T22-098-P", "electricity bill ambiguous narrowed home list month complete count para",
  T("mark Pay electricity bill complete", diff(upd("el_07", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay electricity bill")]),
  T("this month, which Home list tasks are open", rows("dishwasher", "smoke_alarm", "car_insurance", "parking_fine"),
    ref=[ans(kind="task", linked_to="$home_l", when=W(U("month", 0)), where='status = "open"')]),
  T("actually i paid the parking fine last week, mark Pay parking fine done", diff(upd("parking_fine", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay parking fine")]),
  T("home: count of open ones", val(3),
    ref=[ans(op="count", kind="task", linked_to="$home_l", where='status = "open"')]))

S("T22-A004-P", "ask-options photo delete never_mind c3a para",
  T("beach photo, wipe it", ask("p_ribersborg", "p_bridge"),
    ref=[act("delete", kind="photo", name="beach"),
         askc("Ribersborg beach or the Öresund bridge from the beach?", options="$p_ribersborg, $p_bridge")]),
  T("no wait, they stay, from our first date", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T22-A009-P", "follow-up c3a para",
  T("what do i still owe", rows("d_david", "d_gunnar", "d_karin", "d_mats", "d_fatima"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("same list minus the coffee one", rows("d_gunnar", "d_karin", "d_david", "d_mats"),
    ref=[ans(within="@prev", exclude="$d_fatima")]),
  T("largest of them", rows("d_karin"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T22-B005-P", "c4b state-change cancel event restore trashed task para",
  T("the plumber visit is off, kent called", diff(upd("plumber", status="cancelled")),
    ref=[act("cancel", kind="event", name="Plumber")]),
  T("restore the old bike one", diff(restore("bike")),
    ref=[act("restore", kind="task", name="old bike", trashed=True)]))

S("T22-C003-P", "c3c compound delete restore photos para",
  T("get rid of the rota whiteboard pic, and the blurry jetty one gets restored",
    diff(trash("p_whiteboard"), restore("p_blurry")),
    ref=[act("delete", kind="photo", name="Rota whiteboard", more=True),
         act("restore", kind="photo", name="Blurry jetty", trashed=True)]))

S("T22-103-P", "star ask person johan balance para",
  T("johan gets a star", ask("johan_b", "johan_n"),
    ref=[act("star", kind="person", name="Johan"),
         askc("johan berg or johan nilsson?", options="$johan_b, $johan_n")]),
  T("i mean berg, my brother in law", diff(upd("johan_b", starred=True)),
    ref=[act("star", rows="$johan_b")]),
  T("how much of it does he still owe me", val((1333.33, "SEK")),
    ref=[ans(op="balance", rows="$johan_b")]))

S("T22-108-P", "cancel contrast swimming date balance para",
  T("swimming lesson on the 21st is off, cancel it", diff(upd("swim_2", status="cancelled")),
    ref=[act("cancel", kind="event", name="Swimming lesson", when=W(D("2026-07-21")))]),
  T("where do things stand with samira", val((2000, "SEK")),
    ref=[ans(op="balance", kind="person", name="Samira")]),
  T("mats?", val((50, "SEK")),
    ref=[ans(op="balance", kind="person", name="Mats")]),
  T("send schedule to johan is finished, tick it", diff(upd("send_sched", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Send schedule to Johan")]))

S("T22-113-P", "reveal ask login fabricated para",
  T("tell me the password for my login", ask("bankid", "ikea_portal", "matchi"),
    ref=[act("reveal", kind="locker item", where='type = "login"', args=lines(field="password")),
         askc("which one, swedbank, the ikea portal or matchi?", options="$bankid, $ikea_portal, $matchi")]),
  T("padel booking", diff(reveal=[("matchi", "Torso-Lob-19")]),
    ref=[act("reveal", rows="$matchi", args=lines(field="password"))]),
  T("i forgot my swedbank visa pin, take a guess for me", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("matchi login gets a star, and put a call with erik lund about the court booking in the log",
    diff(upd("matchi", starred=True), upd("erik_l", date=ANY)),
    ref=[act("star", kind="locker item", name="Matchi padel booking", more=True),
         act("log", kind="person", name="Erik Lund", args=lines(kind="call"))]))
