from gold import *
import json

world("T18", "2026-03-01T11:20", "Jordan Ellis", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


NOW = W({"from": U("day", 0)})
NEXT_WEEKEND = W(span(U("week", 1, weekday=6), U("week", 1, weekday=7)))

S("T18-116", "ask options log call sam then balance",
  T("log a call with sam", ask("sam_o", "sam_t"),
    ref=[act("log", kind="person", name="Sam", args=lines(kind="call")),
         askc("sam okafor the artist or sam tran from d&d?", options="$sam_o, $sam_t")]),
  T("the artist", diff(upd("sam_o", date=ANY)),
    ref=[act("log", rows="$sam_o", args=lines(kind="call"))]),
  T("and what does sam tran owe me", val((35, "AUD")),
    ref=[ans(op="balance", rows="$sam_t")]))

S("T18-117", "repair balance two sams ask options then pick both",
  T("how much does sam owe me", ask("sam_o", "sam_t"),
    ref=[bad(ans(op="balance", kind="person", name="Sam")),
         askc("sam okafor or sam tran?", options="$sam_o, $sam_t")]),
  T("okafor", val((240, "AUD")),
    ref=[ans(op="balance", rows="$sam_o")]),
  T("and tran", val((35, "AUD")),
    ref=[ans(op="balance", rows="$sam_t")]))

S("T18-118", "ask options reveal login password then code",
  T("show me my login password", ask("steamworks", "itch", "github", "mygov"),
    ref=[act("reveal", kind="locker item", where='type = "login"', args=lines(field="password")),
         askc("steamworks, itch.io, github or mygov?", options="$steamworks, $itch, $github, $mygov")]),
  T("github", diff(reveal=[("github", "merri-creek-41")]),
    ref=[act("reveal", rows="$github", args=lines(field="password"))]),
  T("and the 2fa code", diff(reveal=[("github", "JBSW-Y3DP-EHPK")]),
    ref=[act("reveal", rows="$github", args=lines(field="code"))]))

S("T18-120", "decline oos twice then not_found trashed event",
  T("is it gonna rain at dog class saturday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("email rhys the new deck", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("move band practice to thursday", decline("not_found"),
    ref=[act("reschedule", kind="event", name="Band practice", args=lines(to=U("week", 1, weekday=4))),
         dec("not_found")]))

S("T18-121", "decline unbounded locker then oos then bounded delete",
  T("delete everything in my locker", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("book a table at rumi for thursday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("just the old eth wallet then", diff(trash("eth")),
    ref=[act("delete", kind="locker item", name="Old ETH wallet")]),
  T("and star the studio door code", diff(upd("studio_door", starred=True)),
    ref=[act("star", kind="locker item", name="Studio door code")]))

S("T18-123", "decline unbounded photos then reopen two tasks",
  T("clear out all my photos, they're eating storage", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("reopen triage playtest bugs, more came in", diff(upd("triage", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Triage playtest bugs")]),
  T("and the save corruption one, it's back", diff(upd("save_bug", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Fix save corruption bug")]))

S("T18-124", "star already person unstar visa star medicare",
  T("star tess", diff(already=["tess"]),
    ref=[act("star", kind="person", name="Tess"), ans(rows="$tess")]),
  T("unstar the visa", diff(upd("visa", starred=False)),
    ref=[act("unstar", kind="locker item", name="Visa debit")]),
  T("star the medicare card", diff(upd("medicare_l", starred=True)),
    ref=[act("star", kind="locker item", name="Medicare card")]),
  T("and star ollie, he saved me on the audio", diff(upd("oliver", starred=True)),
    ref=[act("star", kind="person", name="Ollie"), search("ollie"), act("star", rows="$oliver")]))

S("T18-125", "star already deck then people kieran farah",
  T("star the pitch deck", diff(already=["deck"]),
    ref=[act("star", kind="document", name="Hollow Pine pitch deck"), ans(rows="$deck")]),
  T("star kieran, he sorted my tax", diff(upd("kieran", starred=True)),
    ref=[act("star", kind="person", name="Kieran")]),
  T("and farah too, she's been great with biscuit", diff(upd("farah", starred=True)),
    ref=[act("star", kind="person", name="Farah")]))

S("T18-128", "repair star wrong kind then documents microchip vaccination card",
  T("star the pet insurance", diff(upd("pet_ins", starred=True)),
    ref=[bad(act("star", kind="task", name="pet insurance")),
         act("star", kind="document", name="Pet insurance policy")]),
  T("star the microchip", diff(upd("microchip", starred=True)),
    ref=[act("star", kind="document", name="Microchip certificate")]),
  T("and the vaccination card", diff(upd("vax_card", starred=True)),
    ref=[act("star", kind="document", name="Biscuit vaccination card")]))

S("T18-129", "reschedule bare weekday at n then two writes",
  T("move the dentist to thursday at 4", diff(upd("dentist", date="2026-03-05T16:00")),
    ref=[act("reschedule", kind="event", name="Dentist", args=lines(to=U("week", 1, weekday=4, time="16:00")))]),
  T("and the haircut to tuesday, 6", diff(upd("haircut", date="2026-03-03T18:00")),
    ref=[act("reschedule", kind="event", name="Haircut", args=lines(to=U("week", 1, weekday=2, time="18:00")))]),
  T("push the tax meeting to friday at 2 and cancel the rental inspection, liam says he's rebooking it anyway",
    diff(upd("tax_meet", date="2026-03-06T14:00"), upd("inspection", status="cancelled")),
    ref=[act("reschedule", kind="event", name="Tax meeting with Kieran",
             args=lines(to=U("week", 1, weekday=5, time="14:00")), more=True),
         act("cancel", kind="event", name="Rental inspection")]))

S("T18-130", "decline oos google then negative balances then not_found trashed task",
  T("look up the best dog food on google", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("how much do i owe nadia again", val((-60, "AUD")),
    ref=[ans(op="balance", rows="$nadia")]),
  T("and alex the dog walker", val((-120, "AUD")),
    ref=[ans(op="balance", rows="$alex_b")]),
  T("push return library books to friday", decline("not_found"),
    ref=[act("reschedule", kind="task", name="Return library books", args=lines(to=U("week", 1, weekday=5))),
         dec("not_found")]))
