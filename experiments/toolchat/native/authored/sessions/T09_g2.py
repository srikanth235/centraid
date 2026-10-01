from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))
NEXT_WEEKEND = span(U("week", 1, weekday=6), U("week", 1, weekday=7))
FROM_NOW = {"from": U("day", 0)}

S("T09-121", "balance group positive weekend read",
  T("where am i in the wedding party group", val((35, "CAD")),
    ref=[find(kind="person", linked_to="$wparty"),
         ans(op="balance", kind="group", name="Wedding party", linked_to="$me")]),
  T("and the condo board one", val((67.5, "CAD")),
    ref=[ans(op="balance", kind="group", name="Condo board", linked_to="$me")]),
  T("rename the wedding party group to Bridal party", diff(upd("wparty", name="Bridal party")),
    ref=[act("edit", kind="group", name="Wedding party", args=lines(name="Bridal party"))]))

S("T09-122", "balance negative dad star fabricated_secret",
  T("how much do i owe my dad", val((-2000, "CAD")),
    ref=[ans(op="balance", kind="person", where='role = "dad"')]),
  T("star him", diff(upd("dad", starred=True)),
    ref=[act("star", kind="person", where='role = "dad"')]),
  T("log a visit with him, saw him sunday", diff(upd("dad", date=ANY)),
    ref=[act("log", kind="person", where='role = "dad"', args=lines(kind="visit"))]),
  T("come up with a good password for my rsvp site login and save it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T09-123", "balance kemi star weekend cancel log multi",
  T("what does kemi owe me", val((102.5, "CAD")),
    ref=[search("kemi", kind="person"), ans(op="balance", rows="$kemi")]),
  T("star her", diff(upd("kemi", starred=True)),
    ref=[act("star", rows="$kemi")]),
  T("cancel the spin class this weekend and log a call with mom, she rang about the fitting",
    diff(upd("spin_0516", status="cancelled"), upd("mom", date=ANY)),
    ref=[act("cancel", kind="event", name="Spin class", when=W(WEEKEND), more=True),
         act("log", kind="person", where='role = "mom"', args=lines(kind="call"))]))

S("T09-124", "star document already-so unbounded",
  T("star the alfama booking", diff(upd("alfama", starred=True)),
    ref=[act("star", kind="document", name="Alfama apartment booking")]),
  T("how many docs are in the wedding folder", val(5),
    ref=[ans(op="count", kind="document", linked_to="$wed_f")]),
  T("and the tap one", diff(already=["tap_booking"]),
    ref=[act("star", kind="document", name="TAP flight booking"), ans(rows="$tap_booking")]),
  T("i want a blank vault, delete the lot", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T09-125", "multi star unstar document not_found",
  T("star the photographer contract and unstar the reserve fund study",
    diff(upd("photo_contract", starred=True), upd("reserve_study", starred=False)),
    ref=[act("star", kind="document", name="Photographer contract", more=True),
         act("unstar", kind="document", name="Reserve fund study 2026")]),
  T("and the petrov quote", diff(upd("petrov_quote", starred=True)),
    ref=[act("star", kind="document", name="Petrov Kitchen quote")]),
  T("number of docs with a star on them", val(4),
    ref=[ans(op="count", kind="document", where="starred = yes")]),
  T("cancel my pottery class", decline("not_found"),
    ref=[find(kind="event", name="Pottery class"), dec("not_found")]))

S("T09-126", "contrast star membership reopen",
  T("star the cyclebar membership", diff(upd("cyclebar", starred=True)),
    ref=[act("star", kind="locker item", name="Cyclebar membership")]),
  T("reopen the thank you cards from the engagement party, never sent them",
    diff(upd("thanks_old", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="thank you cards", where='status = "completed"')]))

S("T09-127", "ask star membership never_mind",
  T("star the membership", ask("cyclebar", "costco"),
    ref=[act("star", kind="locker item", name="membership"),
         askc("the cyclebar membership or the costco one?", options="$cyclebar, $costco")]),
  T("forget it, i'll do it at the gym", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("star the home wifi then", diff(upd("wifi", starred=True)),
    ref=[act("star", kind="locker item", name="Home wifi")]))

S("T09-128", "ask cancel planning call next weekend",
  T("cancel the wedding planning call", ask("wcall_0520", "wcall_0603"),
    ref=[find(kind="event", name="Wedding planning call", when=W(FROM_NOW)),
         act("cancel", kind="event", within="@prev"),
         askc("next wednesday's call or the one on 3 june?", options="$wcall_0520, $wcall_0603")]),
  T("the june one", diff(upd("wcall_0603", status="cancelled")),
    ref=[act("cancel", rows="$wcall_0603")]),
  T("what's on next weekend", rows("spin_0523", "cake", "dinner_0524"),
    ref=[ans(kind="event", when=W(NEXT_WEEKEND))]),
  T("push the cake tasting back an hour", diff(upd("cake", date="2026-05-23T15:00")),
    ref=[act("reschedule", kind="event", name="Cake tasting", args=lines(to=U("hour", 1, anchor="row")))]))

S("T09-129", "ask complete thank-you never_mind out_of_scope",
  T("mark the thank you cards done", ask("thanks_new", "thanks_old"),
    ref=[act("complete", kind="task", name="thank you cards"),
         find(kind="task", name="thank you cards"),
         askc("the one due 30 june or the engagement party one from february?", options="$thanks_new, $thanks_old")]),
  T("don't bother, dan's doing them", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's the weather looking like saturday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T09-130", "ask reschedule checkin at_n repair",
  T("move the check-in with margaret to 5", ask("checkin_0514", "checkin_0528"),
    ref=[act("reschedule", kind="event", name="Check-in with Margaret", args=lines(to=U("day", 0, anchor="row", time="17:00"))),
         find(kind="event", name="Check-in with Margaret"),
         askc("tomorrow's or the one on the 28th?", options="$checkin_0514, $checkin_0528")]),
  T("thursday's", diff(upd("checkin_0514", date="2026-05-14T17:00")),
    ref=[act("reschedule", rows="$checkin_0514", args=lines(to=U("day", 0, anchor="row", time="17:00")))]),
  T("and the northvale call to 2", diff(upd("northvale", date="2026-05-13T14:00")),
    ref=[bad(act("reschedule", kind="event", name="Northvale", args=lines(to={"time": "14:00"}))),
         act("reschedule", kind="event", name="Northvale", args=lines(to=U("day", 0, anchor="row", time="14:00")))]))

S("T09-131", "ask add_to photo never_mind contrast cancel by date",
  T("put the engagement shoot pic in the family album", ask("eng_shoot1", "eng_shoot2"),
    ref=[act("add_to", kind="photo", name="engagement shoot", args=lines(to="$fam_album")),
         askc("the distillery one or the one by the lake?", options="$eng_shoot1, $eng_shoot2")]),
  T("never mind, i'll do it from my phone", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("cancel the planning call on the third", diff(upd("wcall_0603", status="cancelled")),
    ref=[act("cancel", kind="event", name="Wedding planning call", when=W(D("2026-06-03")))]))

S("T09-132", "ask reveal portal contrast reveal",
  T("show me the portal password", ask("lso_portal", "condo_portal"),
    ref=[act("reveal", kind="locker item", name="portal", args=lines(field="password")),
         askc("the lso portal login or the mercer resident portal?", options="$lso_portal, $condo_portal")]),
  T("the condo one", diff(reveal=[("condo_portal", "lobbyplants22")]),
    ref=[act("reveal", rows="$condo_portal", kind="locker item", args=lines(field="password"))]),
  T("and the lso portal password", diff(reveal=[("lso_portal", "Barrister2024!")]),
    ref=[act("reveal", rows="$lso_portal", kind="locker item", args=lines(field="password"))]))

S("T09-133", "ask reschedule condo board meeting then photo add_to by name",
  T("move the condo board meeting to 7:30", ask("cb_0514", "cb_0611"),
    ref=[find(kind="event", name="Condo board meeting", when=W(FROM_NOW)),
         act("reschedule", kind="event", within="@prev", args=lines(to=U("day", 0, anchor="row", time="19:30"))),
         askc("tomorrow's or the one on 11 june?", options="$cb_0514, $cb_0611")]),
  T("tomorrow's", diff(upd("cb_0514", date="2026-05-14T19:30")),
    ref=[act("reschedule", rows="$cb_0514", args=lines(to=U("day", 0, anchor="row", time="19:30")))]),
  T("put the engagement one by the lake in the family album", diff(link("fam_album", "eng_shoot2")),
    ref=[act("add_to", kind="photo", name="lake", args=lines(to="$fam_album"))]))

S("T09-134", "contrast log treasurer complete restore refused",
  T("log a message with priya, the treasurer one, sent her the agm notice", diff(upd("priya_s", date=ANY)),
    ref=[act("log", kind="person", where='role contains "treasurer"', args=lines(kind="message"))]),
  T("tick off circulate agm notice", diff(upd("agm_notice", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Circulate AGM notice")]),
  T("bring bex back, i found her number in an old email", decline("not_found"),
    ref=[bad(act("restore", kind="person", name="Bex Thornton", trashed=True)), dec("not_found")]))

S("T09-135", "contrast complete read weekday at_n out_of_scope",
  T("mark the open thank you cards task done", diff(upd("thanks_new", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="thank you cards", where='status = "open"')]),
  T("move movie night to saturday at 8", diff(upd("movie", date="2026-05-16T20:00")),
    ref=[act("reschedule", kind="event", name="Movie night", args=lines(to=U("week", 0, weekday=6, time="20:00")))]),
  T("look up if the arbor room allows sparklers", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))
