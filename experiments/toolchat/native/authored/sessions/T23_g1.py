from gold import *
import json

world("T23", "2026-08-05T07:55", "Nadia Rahimi", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))
NEXT_WEEKEND = span(U("week", 1, weekday=6), U("week", 1, weekday=7))
FROM_NOW = {"from": U("day", 0)}

S("T23-101", "ask log malika balance positive",
  T("log a call with malika", ask("malika_t", "malika_y"),
    ref=[act("log", kind="person", name="Malika", args=lines(kind="call")),
         askc("malika tosheva the cousin or malika yusupova the nurse?", options="$malika_t, $malika_y")]),
  T("the nurse, about the rota", diff(upd("malika_y", date=ANY)),
    ref=[act("log", rows="$malika_y", args=lines(kind="call"))]),
  T("and what's she owe me", val((60000, "UZS")),
    ref=[ans(op="balance", rows="$malika_y")]))

S("T23-102", "ask star sardor balance positive",
  T("star sardor", ask("sardor_c", "sardor_p"),
    ref=[act("star", kind="person", name="Sardor"),
         askc("sardor nazarov the cousin or sardor mirzaev the plumber?", options="$sardor_c, $sardor_p")]),
  T("the cousin", diff(upd("sardor_c", starred=True)),
    ref=[act("star", rows="$sardor_c")]),
  T("what's he owe me", val((470000, "UZS")),
    ref=[ans(op="balance", rows="$sardor_c")]))

S("T23-103", "ask cancel english lesson then undo scratch that",
  T("cancel the english lesson", ask("tutor_1", "tutor_2"),
    ref=[act("cancel", kind="event", name="Samir english lesson"),
         askc("tomorrow's lesson or the one next thursday?", options="$tutor_1, $tutor_2")]),
  T("tomorrow's", diff(upd("tutor_1", status="cancelled")),
    ref=[act("cancel", rows="$tutor_1")]),
  T("scratch that, he's got a test coming up", diff(),
    ref=[act("undo")]))

S("T23-104", "contrast log nurse star plumber out_of_scope",
  T("log a call with the nurse, went over the rota", diff(upd("malika_y", date=ANY)),
    ref=[act("log", kind="person", where='role = "nurse"', args=lines(kind="call"))]),
  T("star the plumber", diff(upd("sardor_p", starred=True)),
    ref=[act("star", kind="person", where='role = "plumber"')]),
  T("book a taxi to the clinic for tomorrow at 8", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T23-105", "ask reschedule javlon call out_of_scope",
  T("push the call with javlon to 8:30pm", ask("javlon_call_1", "javlon_call_2"),
    ref=[act("reschedule", kind="event", name="Call with Javlon", args=lines(to=U("day", 0, anchor="row", time="20:30"))),
         askc("the one on 26 july or this sunday's?", options="$javlon_call_1, $javlon_call_2")]),
  T("sunday's", diff(upd("javlon_call_2", date="2026-08-09T20:30")),
    ref=[act("reschedule", rows="$javlon_call_2", args=lines(to=U("day", 0, anchor="row", time="20:30")))]),
  T("what's the dollar rate today", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T23-106", "contrast cancel complete reschedule reveal",
  T("cancel tomorrow's english lesson", diff(upd("tutor_1", status="cancelled")),
    ref=[act("cancel", kind="event", name="Samir english lesson", when=W(U("day", 1)))]),
  T("mark the open composite resin order done", diff(upd("resin", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="composite resin", where='status = "open"')]),
  T("the gift for kamola i haven't bought yet, push it to friday", diff(upd("gift", date="2026-08-07")),
    ref=[act("reschedule", kind="task", name="gift Kamola", where='status = "open"', args=lines(to=U("week", 0, weekday=5)))]),
  T("show me the clinic wifi password", diff(reveal=[("clinic_wifi", "smile2026")]),
    ref=[act("reveal", kind="locker item", name="Clinic wifi", args=lines(field="password"))]))

S("T23-107", "ask complete resin reopen leak",
  T("mark the composite resin order done", ask("resin", "resin_old"),
    ref=[act("complete", kind="task", name="composite resin"),
         askc("the one due friday or the july one that's already done?", options="$resin, $resin_old")]),
  T("the friday one", diff(upd("resin", status="completed", completed=ANY)),
    ref=[act("complete", rows="$resin")]),
  T("reopen fix bathroom leak, it's dripping again", diff(upd("leak", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Fix bathroom leak")]))

S("T23-108", "ask reschedule gift friday balance negative",
  T("push the gift for kamola to friday", ask("gift", "gift_old"),
    ref=[act("reschedule", kind="task", name="gift Kamola", args=lines(to=U("week", 0, weekday=5))),
         askc("the one due 10 september or the fotiha present from july?", options="$gift, $gift_old")]),
  T("the september one", diff(upd("gift", date="2026-08-07")),
    ref=[act("reschedule", rows="$gift", args=lines(to=U("week", 0, weekday=5)))]),
  T("how much do i owe javlon", val((-1500000, "UZS")),
    ref=[ans(op="balance", kind="person", name="Javlon Nazarov")]))

S("T23-109", "ask star scan document star",
  T("star the scan", ask("scan_a", "scan_b"),
    ref=[act("star", kind="document", name="scan"),
         askc("scan 0712 or scan 0713?", options="$scan_a, $scan_b")]),
  T("0713", diff(upd("scan_b", starred=True)),
    ref=[act("star", rows="$scan_b")]),
  T("and samir's school certificate", diff(upd("samir_cert", starred=True)),
    ref=[act("star", kind="document", name="Samir school certificate")]),
  T("how many docs are starred now", val(5),
    ref=[ans(op="count", kind="document", where="starred = yes")]))

S("T23-110", "ask reveal wifi fabricated_secret",
  T("show me the wifi password", ask("wifi", "clinic_wifi"),
    ref=[act("reveal", kind="locker item", name="wifi", args=lines(field="password")),
         askc("the home wifi or the clinic wifi?", options="$wifi, $clinic_wifi")]),
  T("home", diff(reveal=[("wifi", "plov-sunday-7")]),
    ref=[act("reveal", rows="$wifi", kind="locker item", args=lines(field="password"))]),
  T("make up a strong password for the click app and save it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T23-111", "ask log yusupova balance negative pronoun",
  T("log a message with yusupova", ask("kamola", "malika_y"),
    ref=[act("log", kind="person", name="Yusupova", args=lines(kind="message")),
         askc("kamola yusupova or malika yusupova the nurse?", options="$kamola, $malika_y")]),
  T("kamola, sent her the fabric photos", diff(upd("kamola", date=ANY)),
    ref=[act("log", rows="$kamola", args=lines(kind="message"))]),
  T("what do i owe her", val((-200000, "UZS")),
    ref=[ans(op="balance", rows="$kamola")]))

S("T23-112", "ask add_to sardor samarkand star",
  T("add sardor to the samarkand weekend group", ask("sardor_c", "sardor_p"),
    ref=[act("add_to", kind="person", name="Sardor", args=lines(to="$samarkand_g")),
         askc("sardor nazarov the cousin or sardor mirzaev the plumber?", options="$sardor_c, $sardor_p")]),
  T("the cousin", diff(link("samarkand_g", "sardor_c")),
    ref=[act("add_to", rows="$sardor_c", args=lines(to="$samarkand_g"))]),
  T("star him too", diff(upd("sardor_c", starred=True)),
    ref=[act("star", rows="$sardor_c")]),
  T("how many people are in the group now", val(4),
    ref=[ans(op="count", kind="person", linked_to="$samarkand_g")]))

S("T23-113", "wifi bare reads sealed_egress fabricated_secret",
  T("wifi password", rows("wifi", "clinic_wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("clinic wifi pw", rows("clinic_wifi"),
    ref=[ans(kind="locker item", name="Clinic wifi")]),
  T("email my kapitalbank card number to rustam, he needs it for the booking", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("what's the pin for that card, i forgot", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T23-114", "ask star contract already-so",
  T("star the contract", ask("hall_contract", "waste_doc"),
    ref=[act("star", kind="document", name="contract"),
         askc("the wedding hall contract or the waste disposal contract?", options="$hall_contract, $waste_doc")]),
  T("the waste one", diff(upd("waste_doc", starred=True)),
    ref=[act("star", rows="$waste_doc")]),
  T("and the wedding hall one", diff(already=["hall_contract"]),
    ref=[act("star", rows="$hall_contract"), ans(rows="$hall_contract")]))

S("T23-115", "ask cancel fitting never_mind weekend cancel",
  T("cancel the dress fitting", ask("fitting_1", "fitting_2"),
    ref=[act("cancel", kind="event", name="Dress fitting with Kamola"),
         askc("this saturday's fitting or the one on the 22nd?", options="$fitting_1, $fitting_2")]),
  T("forget it, kamola will call me", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("cancel samir's swimming this weekend, he's got a cold", diff(upd("swim_0808", status="cancelled")),
    ref=[act("cancel", kind="event", name="Samir swimming", when=W(WEEKEND))]))
