from gold import *
def J(d):
    return json.dumps(d, separators=(",", ":"))
import json
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OWED = 'direction = "owes_me" and status = "open"'
def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T25-003-P", "person role contains within starred unstar prev para",
  T("hiking crew members?", rows("marc_g", "nadia", "tom", "elise"),
    ref=[ans(kind="person", where='role contains "hiking"')]),
  T("starred among them?", rows("nadia"),
    ref=[ans(kind="person", within="@prev", where="starred = yes")]),
  T("remove her star", diff(upd("nadia", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T25-011-P", "event person count next week delete multi para",
  T("events next week that involve at most one person",
    rows("one_on_one", "therapy_1013", "coffee_marc", "portfolio_rev", "lawyer_call", "handoff_1016",
         "mom_flight"),
    ref=[ans(kind="event", when=U("week", 1), where="person count <= 1")]),
  T("i'm moving both, so get rid of the coffee with marc and the call with the lawyer",
    diff(trash("coffee_marc"), trash("lawyer_call")),
    ref=[act("delete", rows="$coffee_marc, $lawyer_call")]))

S("T25-017-P", "restore note where trashed para",
  T("bring back the note listing milk and eggs", diff(restore("old_grocery")),
    ref=[act("restore", kind="note", trashed=True, where='body contains "milk"')]),
  T("count of notes in the trash", val(2),
    ref=[ans(op="count", kind="note", trashed=True)]))

S("T25-023-P", "single delete album named knock-on para",
  T("get rid of the Green Mountains album but keep the photos",
    diff(gone("vermont_album"), unlink("vermont_album", "burlington"), unlink("vermont_album", "waterbury"),
         unlink("vermont_album", "camels_hump")),
    ref=[act("delete", kind="album", name="Green Mountains")]))

S("T25-028-P", "person event count debt count para",
  T("in my diary, which book club people actually appear", rows("sarah_c", "ines"),
    ref=[ans(kind="person", where='met = "book club" and event count != 0')]),
  T("people i've got two or more debts with", rows("daniel"),
    ref=[ans(kind="person", where="debt count >= 2")]),
  T("Daniel Roy, where do we stand", val((444, "CAD")),
    ref=[ans(op="balance", rows="$daniel")]))

S("T25-032-P", "event status enum week duration month para",
  T("last week's events that weren't cancelled", rows("therapy_0929", "piano_0930"),
    ref=[ans(kind="event", when=U("week", -1), where="status != cancelled")]),
  T("the cancelled ones?", rows("handoff_1002", "hike_sutton"),
    ref=[ans(kind="event", when=U("week", -1), where="status = cancelled")]),
  T("this month, events lasting 120 min or more",
    rows("hike_sutton", "offsite", "thanksgiving", "book_10", "hike_tremblant", "usability", "workshop",
         "yoga_oct", "halloween_ev"),
    ref=[ans(kind="event", when=U("month", 0), where="duration >= 120")]))

S("T25-036-P", "event overlap refused ask create para",
  T("Mika's swim trial, wednesday, 4:45, half an hour, add it", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Mika's swim trial",
                                      date=U("week", 1, weekday=3, time="16:45"), duration=30))),
         askc("her piano lesson runs 4:30 to 5:15 that day. do the swim trial at 5:30 instead?")]),
  T("ok 5:30", diff(new("event", name="Mika's swim trial", date="2026-10-14T17:30")),
    ref=[act("create", args=lines(kind="event", name="Mika's swim trial", date=D("2026-10-14", "17:30"),
                                  duration=30))]))

S("T25-040-P", "task spans relative datetime month name linked para",
  T("which work list tasks fall due from tomorrow till friday 5pm", rows("onboarding", "deck", "participants", "research_plan"),
    ref=[ans(kind="task", linked_to="$work_l", when=span(U("day", 1), U("week", 1, weekday=5, time="17:00")))]),
  T("what is on the mika list from next week through end of november",
    rows("receipts_1", "field_trip", "flu_shot", "invites", "ski", "costume"),
    ref=[ans(kind="task", linked_to="$mika_l", when=span(U("week", 1), U("month", 0, name=11)))]),
  T("latest due among them", rows("ski"),
    ref=[ans(kind="task", within="@prev", order="date desc", limit=1)]))

S("T25-044-P", "document spans datetime relative weekday para",
  T("from sept twenty-first 1pm through this week, which docs came in",
    rows("nda", "plan_draft", "passport_app", "boots_receipt", "trip_form", "scan_a", "scan_b"),
    ref=[ans(kind="document", when=span(D("2026-09-21", "13:00"), U("week", 0)))]),
  T("how about oct second 8pm up to thursday", rows("passport_app", "boots_receipt", "trip_form"),
    ref=[ans(kind="document", when=span(D("2026-10-02", "20:00"), U("week", 0, weekday=4)))]),
  T("passport one gets a star", diff(upd("passport_app", starred=True)),
    ref=[act("star", rows="$passport_app")]))

S("T25-048-P", "create task undo create para",
  T("tomorrow i have to buy cranberry sauce, put that on my to-do's", diff(new("task", name=has("cranberry"), date="2026-10-12")),
    ref=[act("create", args=lines(kind="task", name="Buy cranberry sauce", date=U("day", 1)))]),
  T("mom bought some already, undo it", diff(trash("+1")),
    ref=[act("undo")]))

S("T25-054-P", "five turns book club ambiguous ask log balance settle_up para",
  T("is book club happening next week", rows("book_10"),
    ref=[ans(kind="event", name="Book club", when=U("week", 1))]),
  T("coffee with sarah, put it in the log", ask("sarah_c", "sarah_n"),
    ref=[act("log", kind="person", name="Sarah", args=lines(kind="coffee")),
         askc("sarah cohen or sarah nguyen?", options="$sarah_c, $sarah_n")]),
  T("sarah cohen", diff(upd("sarah_c", date=ANY)),
    ref=[act("log", rows="$sarah_c", args=lines(kind="coffee"))]),
  T("where do she and i stand", val((-12, "CAD")),
    ref=[comp(op="balance", rows="$sarah_c"), ans(value="@prev")]),
  T("in the Book club kitty, settle up with her", diff(settle=["Sarah Cohen"]),
    ref=[act("settle_up", rows="$sarah_c", args=lines(group="$bookclub"))]))

S("T25-060-P", "four turns create notebook edit new note month add_to para",
  T("i want a notebook named Tremblant 2026", diff(new("notebook", name="Tremblant 2026")),
    ref=[act("create", args=lines(kind="notebook", name="Tremblant 2026"))]),
  T("its name should be Tremblant trip", diff(upd("+1", name="Tremblant trip")),
    ref=[act("edit", rows="$c1", args=lines(name="Tremblant trip"))]),
  T("notes i wrote in october",
    rows("s11_thoughts", "tremblant_pack", "talking_points", "one_on_one_n", "ped_questions", "grocery_tg",
         "ski_note"),
    ref=[ans(kind="note", when=U("month", 0, name=10))]),
  T("the new notebook gets Tremblant packing list", diff(unlink("hike_nb", "tremblant_pack"), link("+1", "tremblant_pack")),
    ref=[act("add_to", rows="$tremblant_pack", args=lines(to="$c1"))]))

S("T25-066-P", "restore note where month trashed read para",
  T("bring back the note from september that i deleted", diff(restore("old_grocery")),
    ref=[act("restore", kind="note", trashed=True, when=U("month", 0, name=9))]),
  T("Anniversary ideas, is it in the trash as well", rows("anniv_note"),
    ref=[ans(kind="note", name="Anniversary ideas", trashed=True)]))

S("T25-073-P", "empty result locker search delete prev para",
  T("is there a gym card in the locker", rows("climbing"),
    ref=[find(kind="locker item", name="gym card"), search("gym", kind="locker item"), ans(rows="$climbing")]),
  T("i cancelled it, so get rid of it", diff(trash("climbing")),
    ref=[act("delete", rows="@prev")]))

S("T25-084-P", "five turns event count month open span datetime reschedule ambiguous ask para",
  T("piano lessons from november on, how many", val(3),
    ref=[ans(op="count", kind="event", name="Piano lesson", when={"from": U("month", 0, name=11)})]),
  T("oct fourteenth until 3pm on the fifteenth, what do i have", rows("coffee_marc", "pediatrician", "piano_1014", "portfolio_rev"),
    ref=[ans(kind="event", when=span(D("2026-10-14"), D("2026-10-15", "15:00")))]),
  T("Coffee with Marc needs to start at 8:30 now", diff(upd("coffee_marc", date="2026-10-14T08:30")),
    ref=[act("reschedule", rows="$coffee_marc", args=lines(to=D("2026-10-14", "08:30")))]),
  T("that one's with which marc", rows("marc_g"),
    ref=[ans(kind="person", linked_to="$coffee_marc")]),
  T("handoff at 6pm instead", ask(),
    ref=[act("reschedule", kind="event", name="Mika handoff", args=lines(to=U("hour", 1, anchor="row"))),
         askc("which friday's handoff?")]))

S("T25-089-P", "single decline unbounded_destruction para",
  T("clear out all of my photos", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T25-098-P", "three turns find miss search decline overlap ask never_mind para",
  T("any vet appointment on the horizon", decline("not_found"),
    ref=[find(kind="event", name="vet"), search("vet", kind="event"), dec("not_found")]),
  T("put Flu shot clinic in for oct fourteenth at 9", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Flu shot clinic", date=D("2026-10-14", "09:00"),
                                      duration=30))),
         askc("mika's pediatrician checkup is 9 to 9:40 that morning and covers the flu shot. still add it?")]),
  T("ah, then forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T25-A003-P", "ask-options task complete never_mind c3a para",
  T("parenting plan one is done, tick it", ask("plan", "sign_plan"),
    ref=[act("complete", kind="task", name="parenting plan"),
         askc("Update parenting plan or Sign final parenting plan?", options="$plan, $sign_plan")]),
  T("actually nothing's signed yet, leave both alone", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("holiday one is finished, mark it", diff(upd("holiday_sched", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="holiday")]))

S("T25-A008-P", "follow-up c3a para",
  T("next week, what's on", rows("mom_flight", "piano_1014", "handoff_1016", "hike_tremblant", "thanksgiving", "portfolio_rev", "therapy_1013", "book_10", "lawyer_call", "pediatrician", "one_on_one", "coffee_marc"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just until wednesday", rows("one_on_one", "pediatrician", "therapy_1013", "coffee_marc", "piano_1014", "thanksgiving"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=3)}))]),
  T("thursday onwards", rows("book_10", "portfolio_rev", "mom_flight", "lawyer_call", "handoff_1016", "hike_tremblant"),
    ref=[ans(within="@1", exclude="@2")]))

S("T25-B005-P", "c4b state-change cancel event restore trashed task para",
  T("mom's flight home got cancelled by the airline", diff(upd("mom_flight", status="cancelled")),
    ref=[act("cancel", kind="event", name="flight")]),
  T("restore the couch one", diff(restore("couch")),
    ref=[act("restore", kind="task", name="couch", trashed=True)]))

S("T25-C003-P", "c3c compound add_to list complete para",
  T("hang the gallery wall goes on the someday list, and the faucet fix is done since the plumber came",
    diff(link("someday_l", "gallery"), unlink("home_l", "gallery"), upd("faucet", status="completed", completed=ANY)),
    ref=[act("add_to", kind="task", name="Hang the gallery wall", args=lines(to="$someday_l"), more=True),
         act("complete", kind="task", name="Fix the bathroom faucet")]))

S("T25-103-P", "ask licence locker star never_mind para",
  T("licence gets a star", ask("dl", "fonts"),
    ref=[act("star", kind="locker item", name="licence"),
         askc("your driver's licence or the font licence?", options="$dl, $fonts")]),
  T("forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T25-108-P", "ask book club cancel find never_mind para",
  T("i'm wrecked, so book club is off, cancel it", ask("book_10", "book_11", "book_12"),
    ref=[act("cancel", kind="event", name="Book club"),
         find(kind="event", name="Book club", when=W({"from": U("day", 0)})),
         askc("thursday the 15th, the 19th of november or the 17th of december?", options="@prev")]),
  T("forget that one", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T25-113-P", "ask mom pickup event or task reschedule pick already-so star para",
  T("pick up mom should be tuesday", ask("mom_arrives", "pharmacy"),
    ref=[search("pick up mom"),
         askc("the airport pickup event from yesterday or the pick up mom's prescription task?", options="$mom_arrives, $pharmacy")]),
  T("prescription one", diff(upd("pharmacy", date="2026-10-13")),
    ref=[act("reschedule", rows="$pharmacy", args=lines(to=U("week", 1, weekday=2)))]),
  T("hiroko gets a star", diff(already=["hiroko"]),
    ref=[act("star", kind="person", name="Hiroko Tanaka"), ans(rows="$hiroko")]))

S("T25-118-P", "decline unbounded then bounded delete unstar star docs para",
  T("i can't look at them, so wipe every task i have", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("narrow that down to done tasks on the mika list", diff(trash("boots"), trash("lunchbox"), trash("receipts_2")),
    ref=[find(kind="task", linked_to="$mika_l", where='status = "completed"'), act("delete", rows="@prev")]),
  T("winter boots receipt loses its star", diff(upd("boots_receipt", starred=False)),
    ref=[act("unstar", kind="document", name="Winter boots receipt")]),
  T("parenting plan draft gets a star", diff(upd("plan_draft", starred=True)),
    ref=[act("star", kind="document", name="Parenting plan draft")]))
