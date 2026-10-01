from gold import *
import json

world("T13", "2026-09-03T22:10", "Amara Nwosu", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = W(span(U("week", 0, weekday=6), U("week", 0, weekday=7)))

S("T13-101", "ask person star two toms",
  T("star tom", ask("tom_h", "tom_b"),
    ref=[act("star", kind="person", name="Tom"),
         askc("tom hargreaves or tom bennett?", options="$tom_h, $tom_b")]),
  T("hargreaves, the housemate", diff(upd("tom_h", starred=True)),
    ref=[act("star", rows="$tom_h")]))

S("T13-102", "ask event reschedule journal club at-n",
  T("move the journal club to 5", ask("jc_0909", "jc_0930"),
    ref=[act("reschedule", kind="event", name="Journal club",
             args=lines(to=U("day", 0, anchor="row", time="17:00"))),
         find(kind="event", name="Journal club"),
         askc("the one on the 9th or the 30th?", options="$jc_0909, $jc_0930")]),
  T("the 9th, i'm presenting that one", diff(upd("jc_0909", date="2026-09-09T17:00")),
    ref=[act("reschedule", rows="$jc_0909", args=lines(to=U("day", 0, anchor="row", time="17:00")))]))

S("T13-103", "contrast journal club prev decides reschedule",
  T("when's the next journal club", rows("jc_0909"),
    ref=[ans(kind="event", name="Journal club", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("make it 5 instead, i need the extra hour to set up", diff(upd("jc_0909", date="2026-09-09T17:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("day", 0, anchor="row", time="17:00")))]),
  T("and push the sem training to 10", diff(upd("sem", date="2026-09-04T10:00")),
    ref=[act("reschedule", kind="event", name="SEM training", args=lines(to=U("day", 0, anchor="row", time="10:00")))]))

S("T13-104", "ask document star stipend near duplicates",
  T("star the stipend statement", ask("stipend_aug", "stipend_jul"),
    ref=[act("star", kind="document", name="Stipend statement"),
         askc("august or july?", options="$stipend_aug, $stipend_jul")]),
  T("august", diff(upd("stipend_aug", starred=True)),
    ref=[act("star", rows="$stipend_aug")]),
  T("and july's", diff(upd("stipend_jul", starred=True)),
    ref=[act("star", rows="$stipend_jul")]))

S("T13-105", "ask locker star monzo unstar",
  T("star monzo", ask("monzo", "monzo_acct"),
    ref=[act("star", kind="locker item", name="Monzo"),
         askc("the monzo card or the current account?", options="$monzo, $monzo_acct")]),
  T("the account", diff(upd("monzo_acct", starred=True)),
    ref=[act("star", rows="$monzo_acct")]),
  T("take the star off the card, i never use it", diff(upd("monzo", starred=False)),
    ref=[act("unstar", rows="$monzo")]),
  T("and star the gtbank card", diff(upd("gtbank", starred=True)),
    ref=[act("star", kind="locker item", name="GTBank")]))

S("T13-106", "ask event cancel supervisor meeting then log",
  T("cancel the supervisor meeting", ask("helen_0826", "helen_0909"),
    ref=[act("cancel", kind="event", name="Supervisor meeting with Helen"),
         find(kind="event", name="Supervisor meeting with Helen"),
         askc("the one on the 26th or the 9th?", options="$helen_0826, $helen_0909")]),
  T("the 9th, she's away at a conference", diff(upd("helen_0909", status="cancelled")),
    ref=[act("cancel", rows="$helen_0909")]),
  T("log a message to helen, told her it's off", diff(upd("helen", date=ANY)),
    ref=[act("log", kind="person", name="Helen", args=lines(kind="message"))]))

S("T13-107", "ask task delete timesheet then undo",
  T("delete the timesheet task", ask("ts_aug", "ts_sep", "ts_jul"),
    ref=[act("delete", kind="task", name="timesheet"),
         find(kind="task", name="timesheet"),
         askc("august, september or the july one?", options="$ts_aug, $ts_sep, $ts_jul")]),
  T("august, i did it on paper", diff(trash("ts_aug")),
    ref=[act("delete", rows="$ts_aug")]),
  T("actually undo, i still have to submit it", diff(restore("ts_aug")),
    ref=[act("undo")]))

S("T13-108", "balance person emeka priya chinedu",
  T("what do i owe emeka", val((-20, "GBP")),
    ref=[ans(op="balance", kind="person", name="Emeka")]),
  T("and does priya owe me anything", val((27, "GBP")),
    ref=[ans(op="balance", kind="person", name="Priya")]),
  T("chinedu?", val((94, "GBP")),
    ref=[ans(op="balance", kind="person", name="Chinedu")]),
  T("star chinedu, he's been solid about it", diff(upd("chinedu", starred=True)),
    ref=[act("star", kind="person", name="Chinedu")]))

S("T13-109", "balance group house priya coffee",
  T("am i up or down in the house kitty", val((107, "GBP")),
    ref=[find(kind="person", linked_to="$house"),
         ans(op="balance", kind="group", name="House bills kitty", linked_to="$me")]),
  T("and priya", val((-49, "GBP")),
    ref=[ans(op="balance", kind="group", name="House bills kitty", linked_to="$priya")]),
  T("what about me in the lab coffee fund", val((-8.8, "GBP")),
    ref=[ans(op="balance", kind="group", name="Lab coffee fund", linked_to="$me")]))

S("T13-110", "wifi password read then reveal",
  T("where's the wifi password saved", rows("wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("show me the wifi password", diff(reveal=[("wifi", "fallowfield-4-life")]),
    ref=[act("reveal", rows="$wifi", args=lines(field="password"))]),
  T("star the wifi one, everyone asks me for it", diff(upd("wifi", starred=True)),
    ref=[act("star", rows="$wifi")]))

S("T13-111", "star already unstar nickname star person",
  T("star helen", diff(already=["helen"]),
    ref=[act("star", kind="person", name="Helen Carter"), ans(kind="person", name="Helen Carter")]),
  T("unstar chichi, she's fine without", diff(upd("chiamaka", starred=False)),
    ref=[search("Chichi", kind="person"), act("unstar", rows="$chiamaka")]),
  T("star wei, he's covered for my xrd bookings twice this month", diff(upd("wei", starred=True)),
    ref=[act("star", kind="person", name="Wei")]))

S("T13-112", "decline out of scope weather then task",
  T("what's the weather like in manchester tomorrow", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("add a task take my umbrella to the lab, for tomorrow",
    diff(new("task", name=has("umbrella"), date="2026-09-04")),
    ref=[act("create", args=lines(kind="task", name="Take my umbrella to the lab", date=U("day", 1)))]),
  T("how many tasks have i got due tomorrow", val(4),
    ref=[ans(op="count", kind="task", when=W(U("day", 1)))]))

S("T13-113", "reopen task then reschedule bare weekday",
  T("reopen calibrate the furnace, it's drifted again", diff(upd("furnace", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Calibrate the furnace")]),
  T("due friday", diff(upd("furnace", date="2026-09-04")),
    ref=[act("reschedule", rows="$furnace", args=lines(to=U("week", 0, weekday=5)))]),
  T("and how many open tasks on the lab list now", val(6),
    ref=[ans(op="count", kind="task", linked_to="$lab_l", where='status = "open"')]))

S("T13-114", "weekend count cancel wifi code",
  T("how many things are on this weekend", val(3),
    ref=[ans(op="count", kind="event", when=WEEKEND)]),
  T("cancel the house meeting this weekend, kasia's away and we can't do it without her",
    diff(upd("house_meeting", status="cancelled")),
    ref=[act("cancel", kind="event", name="House meeting", when=WEEKEND)]),
  T("do i have the wifi code saved anywhere", rows("wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("log a call with mummy, she rang about the flight", diff(upd("mum", date=ANY)),
    ref=[act("log", kind="person", name="Mummy", args=lines(kind="call")), search("Mummy", kind="person"),
         act("log", rows="$mum", args=lines(kind="call"))]))

S("T13-115", "decline sealed egress reveal card number star doc",
  T("paste my monzo card number into a text to tom", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("just show me the card number", diff(reveal=[("monzo", "9087")]),
    ref=[act("reveal", rows="$monzo", args=lines(field="card_number"))]),
  T("and star my nigerian passport scan", diff(upd("passport_scan", starred=True)),
    ref=[act("star", kind="document", name="Nigerian passport scan")]),
  T("unstar the brp scan while you're there", diff(upd("brp_scan", starred=False)),
    ref=[act("unstar", kind="document", name="BRP card scan")]))
