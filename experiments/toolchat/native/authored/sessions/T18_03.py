from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T18-052", "group count photo count already star",
  T("who's in two of my groups", rows("priya", "mei"),
    ref=[ans(kind="person", where="group count = 2")]),
  T("who's tagged in more than three photos", rows("tess", "mum"),
    ref=[ans(kind="person", where="photo count > 3")]),
  T("more than 2?", rows("tess", "mum", "bex"),
    ref=[ans(kind="person", where="photo count > 2")]),
  T("which people with a cadence did i talk to from last week to end of feb",
    rows("tess", "mum", "priya", "mei", "bex", "chloe", "nadia", "zoe"),
    ref=[ans(kind="person", when=W(span(U("week", -1), U("month", 0, name=2))), where="cadence is set")]),
  T("star the dm", diff(already=["bex"]),
    ref=[act("star", rows="$bex"), ans(rows="$bex")]))

S("T18-054", "group person count delete group knock-on refused group ask settle",
  T("which groups have exactly three people in them", rows("gdc", "ski"),
    ref=[find(kind="group", where="person count = 3"), ans(rows="@prev")]),
  T("delete the ski one, never happening", diff(gone("ski"), unlink("ski", "brooke"), unlink("ski", "zoe"), unlink("ski", "me")),
    ref=[act("delete", rows="$ski")]),
  T("and the gdc one, that trip was a year ago", ask(),
    ref=[bad(act("delete", rows="$gdc")),
         askc("GDC 2025 trip still has the Airbnb in SF on it, so it can't be deleted until everyone's square. how do you want to handle it?")]),
  T("settle up with mei in it then, she paid the airbnb", diff(settle=["Mei Lin Zhao"]),
    ref=[act("settle_up", rows="$mei", args=lines(group="$gdc"))]))

S("T18-055", "five turns event empty search miss decline description contains within reschedule weekday",
  T("when's yoga", decline("not_found"),
    ref=[ans(kind="event", name="Yoga"), search("yoga"), dec("not_found")]),
  T("what's booked at northcote vet", rows("vet_feb", "vet_apr", "vax"),
    ref=[ans(kind="event", where='description contains "Northcote"')]),
  T("just the upcoming ones", rows("vax", "vet_apr"),
    ref=[ans(within="@prev", kind="event", when=W({"from": U("day", 0)}))]),
  T("move the vaccination to thursday, same time", diff(upd("vax", date="2026-03-05T16:00")),
    ref=[act("reschedule", rows="$vax", args=lines(to=U("week", 1, weekday=4, time="16:00")))]),
  T("what does thursday look like", rows("pitch", "vax", "dnd_0305"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=4)))]))

S("T18-056", "event empty other kind recovery delete trashed reschedule anchor row time",
  T("when's the escape room thing", rows("escape"),
    ref=[ans(kind="event", name="escape room"), ans(rows="$escape")]),
  T("oh yeah we cancelled that. delete the task", diff(trash("escape")),
    ref=[act("delete", rows="$escape")]),
  T("any D&D session this thursday", rows("dnd_0305"),
    ref=[ans(kind="event", name="D&D session", when=W(U("week", 1, weekday=4)))]),
  T("move it to the night before at 7, bex has a thing", diff(upd("dnd_0305", date="2026-03-04T19:00")),
    ref=[act("reschedule", rows="$dnd_0305", args=lines(to=U("day", -1, anchor="row", time="19:00")))]))

S("T18-057", "event find anchor time cancel prev read",
  T("what have i got tomorrow at 6", rows("climb_mar"),
    ref=[find(kind="event", when=W(U("day", 1, anchor="today", time="18:00"))), ans(rows="@prev")]),
  T("cancel it, brooke hurt her finger", diff(upd("climb_mar", status="cancelled")),
    ref=[act("cancel", rows="@prev")]),
  T("when did i last see Brooke Tanner", rows("brooke"),
    ref=[ans(rows="$brooke")]))

S("T18-058", "event named month span count within dentist span reschedule",
  T("how many d&d sessions from feb through next week", val(5),
    ref=[ans(op="count", kind="event", name="D&D session", when=W(span(U("month", 0, name=2), U("week", 1))))]),
  T("which one got cancelled", rows("dnd_0212"),
    ref=[ans(kind="event", name="D&D session", when=W(span(U("month", 0, name=2), U("week", 1))),
             where='status = "cancelled"')]),
  T("any dentist stuff between next monday and the end of march", rows("dentist"),
    ref=[ans(kind="event", name="Dentist", when=W(span(U("week", 1, weekday=1), U("month", 0, name=3))))]),
  T("push it to 9:30", diff(upd("dentist", date="2026-03-17T09:30")),
    ref=[act("reschedule", rows="$dentist", args=lines(to=D("2026-03-17", "09:30")))]))

S("T18-059", "event spans linked sprint named month",
  T("anything with Brooke Tanner from next monday till end of march", rows("climb_mar", "trivia"),
    ref=[ans(kind="event", linked_to="$brooke", when=W(span(U("week", 1, weekday=1), U("month", 0, name=3))))]),
  T("and co-op sprint reviews from march to the end of next week", rows("sprint_0306"),
    ref=[ans(kind="event", name="Co-op sprint review", when=W(span(U("month", 0, name=3), U("week", 1))))]),
  T("what's the description on that", rows("sprint_0306"),
    ref=[ans(rows="@prev")]))

S("T18-060", "event duration refused 1 hour repair within",
  T("anything next week that isn't an hour long",
    rows("climb_mar", "shower_call", "vax", "dnd_0305", "sprint_0306", "playtest_mar", "mum_lunch"),
    ref=[bad(ans(kind="event", when=W(U("week", 1)), where="duration != 1 hour")),
         ans(kind="event", when=W(U("week", 1)), where="duration != 60 minutes")]),
  T("the short ones, under 45", rows("shower_call", "vax", "sprint_0306"),
    ref=[ans(within="@prev", kind="event", where="duration < 45")]))

S("T18-061", "task effort refused 1 hour repair list count",
  T("open co-op dev tasks over an hour", rows("cart", "trailer", "tutorial", "grant_report"),
    ref=[bad(ans(kind="task", linked_to="$dev_l", where='effort > 1 hour and status = "open"')),
         ans(kind="task", linked_to="$dev_l", where='effort > 60 and status = "open"')]),
  T("how many is that", val(4),
    ref=[ans(op="count", rows="@prev")]))

S("T18-062", "five turns effort equal within complete effort is empty edit",
  T("which tasks are exactly thirty mins", rows("dog_food", "invites", "print_games", "rsvps", "backstory", "licence_t", "phone_plan"),
    ref=[find(kind="task", where="effort = 30"), ans(rows="@prev")]),
  T("the ones due next week", rows("dog_food", "invites", "backstory"),
    ref=[ans(within="@prev", kind="task", when=W(U("week", 1)))]),
  T("done the dog food already", diff(upd("dog_food", status="completed", completed=ANY)),
    ref=[act("complete", rows="$dog_food")]),
  T("anything on the biscuit list with no time estimate", rows("dog_food_old", "vax_book"),
    ref=[ans(kind="task", linked_to="$dog_l", where="effort is empty")]),
  T("set the nail trim to twenty min", diff(upd("nails", effort=20)),
    ref=[act("edit", rows="$nails", args=lines(effort="20"))]))

S("T18-063", "effort is empty description is empty edit multi",
  T("open Co-op dev tasks with no description and no estimate", rows("loc", "press_kit"),
    ref=[ans(kind="task", linked_to="$dev_l", where='effort is empty and description is empty and status = "open"')]),
  T("give the press kit two hours", diff(upd("press_kit", effort=120)),
    ref=[act("edit", rows="$press_kit", args=lines(effort="120"))]),
  T("and the localisation one 45", diff(upd("loc", effort=45)),
    ref=[act("edit", rows="$loc", args=lines(effort="45"))]))

S("T18-064", "task person count within description empty",
  T("open Baby shower tasks with at most one person on them", rows("balloons", "baby_gift", "playlist", "print_games", "chairs"),
    ref=[ans(kind="task", linked_to="$shower_l", where='person count <= 1 and status = "open"')]),
  T("which of those don't have a description", rows("balloons", "baby_gift", "playlist", "print_games", "chairs"),
    ref=[ans(within="@prev", kind="task", where="description is empty")]),
  T("put on the print games one that nadia's printing them, she has a printer",
    diff(upd("print_games", description=has("Nadia"))),
    ref=[act("edit", rows="$print_games", args=lines(description="Nadia's printing them"))]))

S("T18-065", "task spans datetime weekday date named month priority",
  T("what's due between tomorrow 9am and friday", rows("ci", "dog_food", "bins", "inv_draft", "cart", "invites", "inv_ok", "slice", "trailer", "flea", "backstory", "snacks", "tutorial"),
    ref=[ans(kind="task", when=W(span(U("day", 1, time="09:00"), U("week", 1, weekday=5))))]),
  T("and from friday 6pm to the tenth", rows("tutorial", "tap", "phone_plan", "balloons", "zoe_book"),
    ref=[ans(kind="task", when=W(span(U("week", 1, weekday=5, time="18:00"), D("2026-03-10"))))]),
  T("anything priority one due by end of march", rows("invites", "slice", "trailer", "tax"),
    ref=[find(kind="task", when=W({"to": U("month", 0, name=3)}), where="priority = 1"), ans(rows="@prev")]))

S("T18-066", "task spans again person count read",
  T("what have i got due from monday 8am to wednesday", rows("ci", "dog_food", "bins", "inv_draft", "cart", "invites", "inv_ok", "slice", "trailer"),
    ref=[ans(kind="task", when=W(span(U("week", 1, weekday=1, time="08:00"), U("week", 1, weekday=3))))]),
  T("which of them have nobody else on them", rows("dog_food", "bins", "inv_draft", "cart"),
    ref=[ans(within="@prev", kind="task", where="person count <= 0")]),
  T("and from the second at noon to the fifth", rows("ci", "dog_food", "bins", "inv_draft", "cart", "invites", "inv_ok", "slice", "trailer", "flea", "backstory", "snacks"),
    ref=[ans(kind="task", when=W(span(D("2026-03-02", "12:00"), D("2026-03-05"))))]),
  T("how many open tasks are due before april", val(29),
    ref=[ans(op="count", kind="task", when=W({"to": U("month", 0, name=3)}), where='status = "open"')]))

S("T18-067", "trashed tasks find-only restore window refused ask create",
  T("which tasks have i deleted lately", rows("library", "gym_cancel", "jam_prep"),
    ref=[find(kind="task", trashed=True), ans(rows="@prev")]),
  T("restore the gym one", ask(),
    ref=[bad(act("restore", rows="$gym_cancel")),
         askc("that one's been in the bin since early january, past the 30 days, so it can't come back. want me to add it again as a new task?")]),
  T("yeah do that", diff(new("task", name="Cancel old gym membership")),
    ref=[act("create", args=lines(kind="task", name="Cancel old gym membership"))]))

S("T18-068", "restore window refused never_mind restore trashed reschedule",
  T("bring back prep jam starter project", ask(),
    ref=[bad(act("restore", kind="task", name="Prep jam starter project", trashed=True)),
         askc("it was binned in january, more than 30 days ago, so it can't be restored. recreate it?")]),
  T("nah don't bother", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what about return library books", diff(restore("library")),
    ref=[act("restore", kind="task", name="Return library books", trashed=True)]),
  T("due saturday", diff(upd("library", date="2026-03-07")),
    ref=[act("reschedule", rows="$library", args=lines(to=U("week", 1, weekday=6)))]))

S("T18-069", "note datetime edit note spans within notebook count",
  T("the note i wrote thursday 11:30pm", rows("recap"),
    ref=[ans(kind="note", when=W(U("week", 0, weekday=4, time="23:30")))]),
  T("add that the grey pilgrim is the lich", diff(upd("recap", body=has("lich"))),
    ref=[act("edit", rows="$recap", args=lines(body="party split at the crypt, Wren lost the amulet. the Grey Pilgrim is the lich"))]),
  T("notes from last monday up to the twenty-fourth", rows("levels", "loot", "pt_feedback", "gift_ideas", "climb_log", "pitch_notes"),
    ref=[ans(kind="note", when=W(span(U("week", -1, weekday=1), D("2026-02-24"))))]),
  T("and the ones that are in no notebook?", rows("gift_ideas", "climb_log"),
    ref=[ans(within="@prev", kind="note", where="notebook count = 0")]))

S("T18-070", "note span weekday datetime open compute count loose",
  T("monday to wednesday noon, which notes", rows("climb_log", "pitch_notes", "tax_q"),
    ref=[ans(kind="note", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3, time="12:00"))))]),
  T("open Questions for Kieran", rows("tax_q"),
    ref=[opn("$tax_q"), ans(rows="$tax_q")]),
  T("how many loose notes have i got, not in any notebook", val(6),
    ref=[comp(op="count", kind="note", where="notebook count = 0"), ans(value="@prev")]))

S("T18-071", "five turns ambiguous debt ask settle weekday sum settle",
  T("settle the pizza debt", ask("d_marcus_pizza", "d_jules_pizza"),
    ref=[act("settle_debt", kind="debt", name="Pizza"),
         find(kind="debt", name="Pizza"),
         askc("there are two pizza ones: marcus owes you 24, you owe jules 18. which?", options="$d_marcus_pizza, $d_jules_pizza")]),
  T("the one marcus owes me", diff(upd("d_marcus_pizza", status="settled")),
    ref=[act("settle_debt", rows="$d_marcus_pizza")]),
  T("what debts came up on thursday", rows("d_jules_pizza", "d_bex"),
    ref=[ans(kind="debt", when=W(U("week", 0, weekday=4)))]),
  T("how much do i owe out of those", val((18, "AUD")),
    ref=[ans(op="sum", field="amount", within="@prev", kind="debt", where='direction = "i_owe"')]),
  T("paid jules back now, settle it", diff(upd("d_jules_pizza", status="settled")),
    ref=[act("settle_debt", rows="$d_jules_pizza")]))

S("T18-072", "ambiguous debt narrowed anchor direction in compute max",
  T("mark the pizza debt settled, i paid jules last night", diff(upd("d_jules_pizza", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Pizza"),
         act("settle_debt", kind="debt", name="Pizza", where='direction = "i_owe"')]),
  T("anything lent or borrowed two days ago", rows("d_priya"),
    ref=[ans(kind="debt", when=W(U("day", -2, anchor="today")))]),
  T("all the open ones either way over 50 bucks", rows("d_tess_cake", "d_nadia", "d_ollie", "d_zoe", "d_alex", "d_bex"),
    ref=[ans(kind="debt", where='direction in ("owes_me", "i_owe") and amount > 50 and status = "open"')]),
  T("biggest one?", val((150, "AUD")),
    ref=[ans(op="max", field="amount", within="@prev")]))

S("T18-074", "debt span last monday weekday direction in",
  T("list the debts running last monday up through this wednesday", rows("d_nadia", "d_marcus_pizza", "d_tess_cake", "d_chloe"),
    ref=[find(kind="debt", when=W(span(U("week", -1, weekday=1), U("week", 0, weekday=3)))), ans(rows="@prev")]),
  T("the ones i owe", rows("d_nadia", "d_chloe"),
    ref=[ans(within="@prev", kind="debt", where='direction = "i_owe"')]))

S("T18-075", "debt anchor yesterday settle undo ledger",
  T("did i borrow anything yesterday", rows("d_alex"),
    ref=[ans(kind="debt", when=W(U("day", -1, anchor="today")))]),
  T("paid alex this morning, settle it", diff(upd("d_alex", status="settled")),
    ref=[act("settle_debt", rows="$d_alex")]),
  T("undo that, transfer bounced", diff(),
    ref=[act("undo")]))
