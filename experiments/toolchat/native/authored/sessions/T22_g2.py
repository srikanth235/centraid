from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T22-116", "star contrast payslip count docs star",
  T("star the may payslip", diff(upd("payslip_may", starred=True)),
    ref=[act("star", kind="document", name="Payslip May")]),
  T("count of starred docs right now", val(5),
    ref=[ans(op="count", kind="document", where="starred = yes")]),
  T("star the forklift licence too", diff(upd("forklift_cert", starred=True)),
    ref=[act("star", kind="document", name="Forklift licence")]),
  T("and the car registration", diff(upd("car_reg", starred=True)),
    ref=[act("star", kind="document", name="Car registration")]))

S("T22-117", "star ask person haddad log",
  T("star haddad", ask("ahmed", "samira", "nour"),
    ref=[act("star", kind="person", name="Haddad"),
         askc("ahmed, samira or nour?", options="$ahmed, $samira, $nour")]),
  T("nour", diff(upd("nour", starred=True)),
    ref=[act("star", rows="$nour")]),
  T("log a call with her too, spoke tonight", diff(upd("nour", date=ANY)),
    ref=[act("log", rows="$nour", args=lines(kind="call"))]),
  T("what does dragan owe me", val((150, "SEK")),
    ref=[ans(op="balance", kind="person", name="Dragan")]))

S("T22-118", "star contrast person unstar weekend read",
  T("star samira haddad", diff(upd("samira", starred=True)),
    ref=[act("star", kind="person", name="Samira Haddad")]),
  T("unstar ahmed, he'd hate being a favourite", diff(upd("ahmed", starred=False)),
    ref=[act("unstar", kind="person", name="Ahmed Haddad")]),
  T("will it rain at the summer house this weekend", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T22-119", "reschedule ask summer house event edit prev",
  T("move the summer house thing to 4", ask("sh_meeting", "plumber"),
    ref=[act("reschedule", kind="event", name="summer house", when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 0, anchor="row", time="16:00"))),
         askc("the co-owners meeting on sunday or the plumber on the 27th?", options="$sh_meeting, $plumber")]),
  T("the co-owners one", diff(upd("sh_meeting", date="2026-07-26T16:00")),
    ref=[act("reschedule", rows="$sh_meeting", args=lines(to=U("day", 0, anchor="row", time="16:00")))]),
  T("add on it, bring the deed and both keys", diff(upd("sh_meeting", description="bring the deed and both keys")),
    ref=[act("edit", rows="$sh_meeting", args=lines(description="bring the deed and both keys"))]))

S("T22-120", "reschedule contrast event group balance negative",
  T("move the co-owners meeting to 4", diff(upd("sh_meeting", date="2026-07-26T16:00")),
    ref=[act("reschedule", kind="event", name="Summer house co-owners meeting", args=lines(to=U("day", 0, anchor="row", time="16:00")))]),
  T("who's coming to it", rows("karin", "johan_b", "ahmed"),
    ref=[ans(kind="person", linked_to="$sh_meeting")]),
  T("what's karin's balance in the summer house group", val((-2033.33, "SEK")),
    ref=[ans(op="balance", kind="group", name="Summer house Österlen", linked_to="$karin")]))

S("T22-121", "delete ask note mamma undo scratch that",
  T("delete the mamma note", ask("gift_ideas", "meatballs"),
    ref=[act("delete", kind="note", name="mamma"),
         askc("the gift ideas or the meatballs recipe?", options="$gift_ideas, $meatballs")]),
  T("the gift ideas, i already bought it", diff(trash("gift_ideas")),
    ref=[act("delete", rows="$gift_ideas")]),
  T("scratch that", diff(restore("gift_ideas")),
    ref=[act("undo")]),
  T("and pin the meatballs recipe", diff(upd("meatballs", pinned=True)),
    ref=[act("edit", kind="note", name="Mamma's meatballs", args=lines(pinned="yes"))]))

S("T22-122", "delete contrast note trashed read restore",
  T("delete the gift ideas note for mamma", diff(trash("gift_ideas")),
    ref=[act("delete", kind="note", name="Gift ideas for Mamma")]),
  T("any notes i've deleted lately", rows("old_budget", "old_rota", "gift_ideas"),
    ref=[ans(kind="note", trashed=True)]),
  T("bring back the old budget", diff(restore("old_budget")),
    ref=[act("restore", rows="$old_budget")]))

S("T22-123", "delete ask photo beach never mind count",
  T("delete the beach pic", ask("p_ribersborg", "p_bridge"),
    ref=[act("delete", kind="photo", name="beach"),
         askc("ribersborg beach or the öresund bridge one?", options="$p_ribersborg, $p_bridge")]),
  T("never mind, leave them", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how many photos are in the elias album", val(7),
    ref=[ans(op="count", kind="photo", linked_to="$elias_al")]))

S("T22-124", "unstar ask locker swedbank star fabricated",
  T("unstar swedbank", ask("bankid", "visa"),
    ref=[act("unstar", kind="locker item", name="Swedbank"),
         askc("the swedbank login or the visa card?", options="$bankid, $visa")]),
  T("the visa", diff(upd("visa", starred=False)),
    ref=[act("unstar", rows="$visa")]),
  T("star the staff locker code", diff(upd("locker_pin", starred=True)),
    ref=[act("star", kind="locker item", name="Staff locker code")]),
  T("the code's old, make up a new one for it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T22-125", "log ask person kim star already",
  T("log a call with kim", ask("david", "lena"),
    ref=[act("log", kind="person", name="Kim", args=lines(kind="call")),
         askc("david or lena?", options="$david, $lena")]),
  T("david, we sorted the berlin flights", diff(upd("david", date=ANY)),
    ref=[act("log", rows="$david", args=lines(kind="call"))]),
  T("make sure he's starred", diff(already=["david"]),
    ref=[act("star", rows="$david"), ans(rows="$david")]))

S("T22-126", "log contrast person message decline oos",
  T("log a call with lena kim", diff(upd("lena", date=ANY)),
    ref=[act("log", kind="person", name="Lena Kim", args=lines(kind="call"))]),
  T("log a message to jonas about the file", diff(upd("jonas", date=ANY)),
    ref=[act("log", kind="person", name="Jonas", args=lines(kind="message"))]),
  T("text jonas that we'll be ten minutes late thursday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T22-127", "reschedule the weekend repair date count weekend",
  T("move fix the dishwasher to the weekend, ahmed's off saturday and can help", diff(upd("dishwasher", date="2026-07-18")),
    ref=[act("reschedule", kind="task", name="Fix the dishwasher", args=lines(to=U("week", 0, weekday=6)))]),
  T("and water karin's plants tomorrow", diff(upd("plants", date="2026-07-14")),
    ref=[bad(act("reschedule", kind="task", name="Water Karin's plants", args=lines(to={"rel": 1}))),
         act("reschedule", kind="task", name="Water Karin's plants", args=lines(to=U("day", 1)))]),
  T("how many tasks are due this weekend", val(2),
    ref=[ans(op="count", kind="task", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]))

S("T22-128", "effort unit repair not found trashed not found",
  T("anything that takes over three hours", rows("fence", "sauna", "onboard"),
    ref=[bad(ans(kind="task", where="effort > 3 hours")),
         ans(kind="task", where="effort > 180")]),
  T("move the padel trial session to friday", decline("not_found"),
    ref=[find(kind="event", name="Padel trial"), dec("not_found")]),
  T("delete the sailing lesson", decline("not_found"),
    ref=[search("sailing lesson"), dec("not_found")]),
  T("mark buy sunscreen done and push buy charcoal to friday, i'm passing ica on friday anyway",
    diff(upd("sunscreen", status="completed", completed=ANY), upd("charcoal", date="2026-07-17")),
    ref=[act("complete", kind="task", name="Buy sunscreen", more=True),
         act("reschedule", kind="task", name="Buy charcoal", args=lines(to=U("week", 0, weekday=5)))]))

S("T22-129", "restore window refused never mind unbounded",
  T("restore rikard ahl", ask(),
    ref=[bad(act("restore", kind="person", name="Rikard Ahl", trashed=True)),
         askc("rikard was deleted back in may, past the 30 days so i can't restore him. want me to add him as a new contact?")]),
  T("forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("delete everything", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T22-130", "create overlap repair ask decline weekend read unbounded",
  T("add a haircut thursday at 6", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Haircut", date=U("week", 0, weekday=4, time="18:00")))),
         askc("thursday at 6 clashes with doubles practice with erik. want it at 7?")]),
  T("7 then", diff(new("event", name="Haircut", date="2026-07-16T19:00")),
    ref=[act("create", args=lines(kind="event", name="Haircut", date=U("week", 0, weekday=4, time="19:00")))]),
  T("anything next weekend", rows("mamma70", "sh_meeting"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=6), U("week", 1, weekday=7))))]),
  T("wipe all my photos", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))
