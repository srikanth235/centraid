from gold import *
import json

world("A", "2026-10-14T08:40", "Priya Raman", "eval")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("A-E034", "count event month",
  T("how many yoga classes did i get to last month, roughly four or five", val(5),
    ref=[ans(op="count", kind="event", name="yoga", when=W(U("month", -1)))]),
  T("and 1:1s", val(4),
    ref=[ans(op="count", kind="event", name="1:1", when=W(U("month", -1)))]),
  T("count what is still open on my plate, thirty or forty", val(33),
    ref=[ans(op="count", kind="task", where="status = open")]))

S("A-E035", "person events from-open",
  T("what's coming up with tomas", rows("venue", "bday", "parents_zoom", "cake", "diwali"),
    ref=[search("Tomas", kind="person"), ans(kind="event", linked_to="$tomas", when=W({"from": U("day", 0)}))]),
  T("just before november, i'm travelling after", rows("venue", "bday", "parents_zoom"),
    ref=[ans(within="@prev", when=W({"to": D("2026-10-31")}))]))

S("A-E036", "star unstar multi-call",
  T("who's starred, cleaning up my favourites", rows("tomas", "amma", "farah", "pooja"),
    ref=[ans(kind="person", where="starred = yes")]),
  T("unstar farah and star arjun", diff(upd("farah", starred=False), upd("arjun", starred=True)),
    ref=[act("unstar", rows="$farah", more=True), act("star", rows="$arjun")]),
  T("log a call with herrera", ask("tomas", "sofia", "ramon"),
    ref=[act("log", kind="person", name="Herrera", args="kind: call"),
         askc("Tomas, Sofia or Ramon?", options="$tomas, $sofia, $ramon")]))

S("A-E037", "nickname search star balance compute",
  T("when did i last see clo", rows("chloe"),
    ref=[find(kind="person", name="Clo"), search("Clo", kind="person"), ans(rows="$chloe")]),
  T("star her, she's my go-to for plans", diff(upd("chloe", starred=True)),
    ref=[act("star", rows="$chloe")]),
  T("what's she owe me, including the uber", val((64.76, "USD")),
    ref=[comp(op="balance", rows="$chloe"), ans(value="@prev")]))

S("A-E038", "nickname aunt role",
  T("what's gayu chithi's role again", rows("gayatri"),
    ref=[find(kind="person", name="Gayu chithi"), search("Gayu chithi", kind="person"), ans(rows="$gayatri")]),
  T("star her", diff(upd("gayatri", starred=True)),
    ref=[act("star", rows="$gayatri")]))

S("A-E039", "document move folder",
  T("put the utility bill in the taxes folder, home office deduction for this year", diff(link("taxes", "utility"), unlink("house", "utility")),
    ref=[act("add_to", rows="$utility", args="to: $taxes")]),
  T("what's in house now", rows("lease", "renters", "cartitle"),
    ref=[ans(kind="document", linked_to="$house")]))

S("A-E040", "delete document count",
  T("delete the 1099 document, i got a corrected one", diff(trash("int1099")),
    ref=[act("delete", kind="document", name="1099")]),
  T("and how many docs does taxes have now, two or three", val(2),
    ref=[ans(op="count", kind="document", linked_to="$taxes")]))

S("A-E041", "photo delete undo",
  T("delete the biscuit with the cone photo", diff(trash("bis5"), unlink("biscuit_al", "bis5")),
    ref=[act("delete", kind="photo", name="biscuit cone")]),
  T("no wait, undo", diff(restore("bis5"), link("biscuit_al", "bis5")),
    ref=[act("undo")]))

S("A-E042", "album create multi add-to",
  T("make an album called fall and put the farmers market haul and the acl crowd in it",
    diff(new("album", name=has("fall")), link("new", "lo0"), link("new", "lo1")),
    ref=[act("create", kind="album", args=lines(name="Fall"), more=True),
         act("add_to", rows="$lo0, $lo1", args="to: $new")]),
  T("how many in the fall album, two", val(2),
    ref=[ans(op="count", kind="photo", linked_to="$c1")]))

S("A-E043", "list create add-to",
  T("what lists do i have", rows("home", "work", "wedding", "errands"),
    ref=[find(kind="list"), ans(rows="@1")]),
  T("new list called trips", diff(new("list", name=has("Trips"))),
    ref=[act("create", kind="list", args=lines(name="Trips"))]),
  T("put the passport renewal on it", diff(link("+1", "passport")),
    ref=[act("add_to", rows="$passport", args="to: $c1")]))

S("A-E044", "subtasks",
  T("what's under the guest list task", rows("guests_r", "guests_h"),
    ref=[find(kind="task", linked_to="$guests"), ans(rows="@1")]),
  T("and the big bend planning one", rows("bbcabin", "bbpass"),
    ref=[ans(kind="task", linked_to="$bbplan")]))

S("A-E045", "debt create settle",
  T("kenji owes me 20 for the climbing gym, half the day pass", diff(new("debt", name=has("climbing"), amount=20, direction="owes_me"), link("new", "kenji")),
    ref=[act("create", kind="debt", args=lines(name="climbing gym", amount="20", direction="owes_me", person="$kenji"))]),
  T("he paid already, venmo this morning", diff(upd("+1", status="settled")),
    ref=[act("settle_debt", rows="$new")]))

S("A-E046", "log then delete task",
  T("called amma just now", diff(upd("amma", date=ANY)),
    ref=[search("Amma", kind="person"), act("log", rows="$amma", args="kind: call")]),
  T("delete the feedback to farah task, it's moot now", diff(trash("feedback")),
    ref=[act("delete", kind="task", name="feedback farah")]))

S("A-E047", "event delete ask create",
  T("scrap the dinner with sofia, she's sick", diff(trash("sofia_dinner")),
    ref=[act("delete", rows="$sofia_dinner")]),
  T("what's on saturday, anything clashing in the second half", rows("runclub", "venue"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=6)))]),
  T("set up a call with dana about the promo", ask(),
    ref=[askc("What day and time?")]),
  T("monday at 11", diff(new("event", name=has("dana"), date="2026-10-19T11:00")),
    ref=[act("create", kind="event", args=lines(name="Call with Dana", date=U("week", 1, weekday=1, time="11:00")))]))

S("A-E048", "overlap refusal ask",
  T("book a dentist cleaning tuesday at 3, school run's in the morning so the afternoon works best", ask(),
    ref=[bad(act("create", kind="event", args=lines(name="Dentist cleaning", date=U("week", 1, weekday=2, time="15:00")))),
         askc("Dr. Cho is already at 3 that day. Another time?")]),
  T("4 then", diff(new("event", name=has("cleaning"), date="2026-10-20T16:00")),
    ref=[act("create", kind="event", args=lines(name="Dentist cleaning", date=U("week", 1, weekday=2, time="16:00")))]))

S("A-E049", "duration filter repair",
  T("events longer than 3 hours, looking for the big days", rows("bigbend_ev", "acl", "offsite", "diwali"),
    ref=[bad(ans(kind="event", where="duration > 3 hours")),
         ans(kind="event", where="duration > 180")]))

S("A-E050", "event description",
  T("which event has a reservation note", rows("bday"),
    ref=[ans(kind="event", where='description contains "reservation"')]),
  T("what's it under", rows("bday"),
    ref=[ans(rows="$bday")]))

S("A-E051", "tasks about person",
  T("what's still open for amma before december", rows("callamma", "ammapkg", "ammaalbum"),
    ref=[search("Amma", kind="person"), ans(kind="task", linked_to="$amma", where="status = open")]),
  T("which is the biggest job of those", rows("ammaalbum"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]),
  T("push it to the twentieth", diff(upd("ammaalbum", date="2026-10-20")),
    ref=[bad(act("reschedule", rows="$ammaalbum", args="to: 2026-10-20")),
         act("reschedule", rows="$ammaalbum", args=lines(to=D("2026-10-20")))]))

S("A-E052", "event person move",
  T("when's amma's weekly call this week, sunday as usual", rows("amma_call"),
    ref=[ans(kind="event", name="weekly call", when=W(U("week", 0)))]),
  T("move it to nine", diff(upd("amma_call", date="2026-10-18T09:00")),
    ref=[act("reschedule", rows="$amma_call", args=lines(to=U("week", 0, weekday=7, time="09:00")))]))

S("A-E053", "ordinal 1:1 reschedule",
  T("which 1:1s do i have coming up, need to clear some of them before the offsite week", rows("oneonone10", "oneonone11", "oneonone12", "oneonone13", "oneonone14", "oneonone15", "oneonone16"),
    ref=[ans(kind="event", name="1:1", when=W({"from": U("day", 0)}))]),
  T("push the second one to 11, dana's out earlier that day so mornings are better", diff(upd("oneonone11", date="2026-10-22T11:00")),
    ref=[act("reschedule", rows="$oneonone11", args=lines(to=D("2026-10-22", "11:00")))]))

S("A-E054", "ambiguous-task complete ask",
  T("tick off the guest list", ask("guests", "guests_r", "guests_h"),
    ref=[act("complete", kind="task", name="guest list"),
         askc("Which one: the main guest list, the Raman side or the Herrera side?", options="$guests, $guests_r, $guests_h")]),
  T("the herrera side", diff(upd("guests_h", status="completed", completed=ANY)),
    ref=[act("complete", rows="$guests_h")]))

S("A-E055", "dentist event vs person",
  T("when's my dentist this month", rows("dentist"),
    ref=[ans(kind="event", name="dentist", when=W(U("month", 0)))]),
  T("who is the dentist, need the name for a form", rows("cho"),
    ref=[search("dentist", kind="person"), ans(rows="$cho")]),
  T("put in a follow up with cho, she asked for one after the cleaning", ask(),
    ref=[askc("What day and time?")]),
  T("april 14th at 9", diff(new("event", name=has("follow", "cho"), date="2027-04-14T09:00")),
    ref=[act("create", kind="event", args=lines(name="Follow up with Dr. Cho", date=D("2027-04-14", "09:00")))]))

S("A-E056", "plumber push",
  T("who's the plumber, i lost his number", rows("marco"),
    ref=[search("plumber", kind="person"), ans(rows="$marco")]),
  T("when's he coming", rows("plumber"),
    ref=[ans(kind="event", linked_to="$marco", when=W({"from": U("day", 0)}))]),
  T("he's stuck, push it to 3", diff(upd("plumber", date="2026-10-14T15:00")),
    ref=[act("reschedule", rows="$plumber", args=lines(to=U("day", 0, time="15:00")))]))
