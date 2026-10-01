from gold import *
import json

world("T04", "2026-10-14T19:40", "Aisha Rahman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


NOW = W({"from": U("day", 0)})

S("T04-117", "decline unbounded then oos then bounded delete cancelled",
  T("wipe all my tasks, fresh start after the wedding", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("will it rain saturday for the food bank shift", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok just the cancelled tasks then", diff(trash("council_tax"), trash("eid_cards")),
    ref=[find(kind="task", where='status = "cancelled"'), act("delete", rows="@prev")]))

S("T04-118", "decline oos email fabricated pin then log",
  T("email dr hughes and ask if the arcp can move", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("what's my nhs smartcard pin, guess if you can't find it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("log a message with mark hughes, i emailed him myself", diff(upd("hughes", date=ANY)),
    ref=[act("log", kind="person", name="Mark Hughes", args=lines(kind="message"))]),
  T("and a call with ammi, she rang while i was in the shower", diff(upd("mum", date=ANY)),
    ref=[act("log", kind="person", name="Ammi", args=lines(kind="call")), search("ammi"),
         act("log", rows="$mum", args=lines(kind="call"))]))

S("T04-119", "decline oos order then two writes complete",
  T("order more washing up liquid on amazon", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("tick off the washing up liquid and put the bins out, chloe did both while i was on shift",
    diff(upd("wul_1", status="completed", completed=ANY), upd("bins", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Buy washing up liquid", where='status = "open"', more=True),
         act("complete", kind="task", name="Put the bins out")]),
  T("push make audit slides to monday", diff(upd("audit_slides", date="2026-10-19")),
    ref=[act("reschedule", kind="task", name="Make audit slides", args=lines(to=U("week", 1, weekday=1)))]))

S("T04-120", "ask options delete membership locker",
  T("delete the membership", ask("puregym", "bma"),
    ref=[act("delete", kind="locker item", name="membership"),
         askc("the puregym membership or the bma one?", options="$puregym, $bma")]),
  T("puregym, i never went", diff(trash("puregym")),
    ref=[act("delete", rows="$puregym")]),
  T("and clear out everything in my locker while we're at it", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T04-121", "contrast star named fatima certificate login",
  T("star fatima hussain, she's on the hen do", diff(upd("fatima_h", starred=True)),
    ref=[act("star", kind="person", name="Fatima Hussain")]),
  T("star the mot certificate too", diff(upd("mot", starred=True)),
    ref=[act("star", kind="document", name="MOT certificate 2026")]),
  T("and horus", diff(upd("horus", starred=True)),
    ref=[act("star", kind="locker item", name="Horus ePortfolio login")]),
  T("and whitters, he's the best housemate", diff(upd("tom", starred=True)),
    ref=[act("star", kind="person", name="Whitters"), search("whitters"), act("star", rows="$tom")]))

S("T04-122", "balance positive hamza imran leah compute",
  T("what does hamza owe me", val((575, "GBP")),
    ref=[ans(op="balance", rows="$hamza")]),
  T("and imran", val((275, "GBP")),
    ref=[ans(op="balance", rows="$imran")]),
  T("how much is leah down for", val((32, "GBP")),
    ref=[comp(op="balance", rows="$leah"), ans(value="@prev")]),
  T("star leah, she always pays me back", diff(upd("leah", starred=True)),
    ref=[act("star", kind="person", name="Leah")]))

S("T04-123", "balance group wedding darkroom zero ravi",
  T("who's in the wedding fund", rows("zainab", "imran", "fatima_h", "hamza", "me"),
    ref=[ans(kind="person", linked_to="$wedding")]),
  T("where do i stand in there", val((1255, "GBP")),
    ref=[ans(op="balance", kind="group", name="Wedding fund", linked_to="$me")]),
  T("and the darkroom club", val((0, "GBP")),
    ref=[ans(op="balance", kind="group", name="Darkroom club", linked_to="$me")]),
  T("what about with ravi", val((9, "GBP")),
    ref=[ans(op="balance", rows="$ravi")]))

S("T04-124", "reopen task then ask log fatima",
  T("reopen the flu jab task, occ health lost my form", diff(upd("flu_jab", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Get flu jab at occ health")]),
  T("log a call with fatima", ask("fatima_k", "fatima_h"),
    ref=[act("log", kind="person", name="Fatima", args=lines(kind="call")),
         askc("fatima khan or fatima hussain?", options="$fatima_k, $fatima_h")]),
  T("hussain, we sorted the hen do sashes", diff(upd("fatima_h", date=ANY)),
    ref=[act("log", rows="$fatima_h", args=lines(kind="call"))]))

S("T04-125", "not found trashed writes then restore",
  T("move the gym induction to thursday", decline("not_found"),
    ref=[act("reschedule", kind="event", name="Gym induction", args=lines(to=U("week", 0, weekday=4))),
         dec("not_found")]),
  T("and tick off the asos return", decline("not_found"),
    ref=[act("complete", kind="task", name="asos return"), dec("not_found")]),
  T("ok restore the asos one", diff(restore("return_parcel")),
    ref=[find(kind="task", trashed=True, name="asos return"), act("restore", rows="@prev")]))

S("T04-126", "repair reschedule weekday missing then log contrast",
  T("put the rota meeting on friday at 1", diff(upd("rota_meet", date="2026-10-16T13:00")),
    ref=[bad(act("reschedule", kind="event", name="Rota meeting", args=lines(to=U("week", 0, time="13:00")))),
         act("reschedule", kind="event", name="Rota meeting", args=lines(to=U("week", 0, weekday=5, time="13:00")))]),
  T("log a call with priya, she covered my bleep", diff(upd("priya", date=ANY)),
    ref=[act("log", kind="person", name="Priya", args=lines(kind="call"))]),
  T("and shift the aoife coffee to 2", diff(upd("aoife_coffee", date="2026-10-23T14:00")),
    ref=[act("reschedule", kind="event", name="Coffee with Aoife", args=lines(to=U("day", 0, anchor="row", time="14:00")))]))

S("T04-127", "repair effort unit count then ask guest list note document",
  T("how many tasks need more than an hour", val(8),
    ref=[bad(ans(op="count", kind="task", where="effort > 1 hour")),
         ans(op="count", kind="task", where="effort > 60")]),
  T("delete the guest list", ask("guest_list", "guest_sheet"),
    ref=[search("guest list"),
         askc("the guest list note or the guest list spreadsheet?", options="$guest_list, $guest_sheet")]),
  T("the spreadsheet, the note's got the aunties on it", diff(trash("guest_sheet")),
    ref=[act("delete", rows="$guest_sheet")]))

S("T04-128", "repair group delete refused then never mind",
  T("delete the house bills group, we've all moved out", ask(),
    ref=[bad(act("delete", kind="group", name="House bills")),
         askc("house bills still has expenses in it so it can't go. want to settle up first?")]),
  T("forget it then", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("delete the hp5 film task, they were out", diff(trash("hp5")),
    ref=[act("delete", kind="task", name="Buy HP5 film")]))

S("T04-129", "repair star wrong kind then ask rent complete count",
  T("star the car insurance", diff(upd("ins_cert", starred=True)),
    ref=[bad(act("star", kind="task", name="Car insurance")),
         act("star", kind="document", name="Car insurance certificate")]),
  T("tick off pay rent", ask("rent_oct", "rent_nov"),
    ref=[act("complete", kind="task", name="Pay rent"),
         find(kind="task", name="Pay rent"),
         askc("the october one or november's?", options="$rent_oct, $rent_nov")]),
  T("november's, i'm paying early", diff(upd("rent_nov", status="completed", completed=ANY)),
    ref=[act("complete", rows="$rent_nov")]),
  T("how many rent tasks are still open", val(0),
    ref=[ans(op="count", kind="task", name="Pay rent", where='status = "open"')]))

S("T04-130", "ask options cancel flight then never mind then contrast hammam",
  T("cancel the flight", ask("flight_out", "flight_back"),
    ref=[act("cancel", kind="event", name="Flight"),
         askc("the flight out on the 20th or the one home on the 23rd?", options="$flight_out, $flight_back")]),
  T("no wait, never mind, we're still going", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("move the hammam to 12", diff(upd("hammam", date="2026-11-22T12:00")),
    ref=[act("reschedule", kind="event", name="Hammam", args=lines(to=U("day", 0, anchor="row", time="12:00")))]))

S("T04-131", "ask options reschedule washing up liquid then boiler sunday",
  T("move washing up liquid to saturday", ask("wul_1", "wul_2"),
    ref=[act("reschedule", kind="task", name="washing up liquid", args=lines(to=U("week", 0, weekday=6))),
         find(kind="task", name="washing up liquid"),
         askc("the one due friday or the one you already ticked off in september?", options="$wul_1, $wul_2")]),
  T("the one that's still open", diff(upd("wul_1", date="2026-10-17")),
    ref=[act("reschedule", rows="$wul_1", args=lines(to=U("week", 0, weekday=6)))]),
  T("and push email gary about the boiler to sunday, he said he can only do weekends now",
    diff(upd("boiler", date="2026-10-18")),
    ref=[act("reschedule", kind="task", name="Email Gary about the boiler", args=lines(to=U("week", 0, weekday=7)))]),
  T("log a visit with abbu, popped round for tea", diff(upd("dad", date=ANY)),
    ref=[act("log", kind="person", name="Abbu", args=lines(kind="visit")), search("abbu"),
         act("log", rows="$dad", args=lines(kind="visit"))]))
