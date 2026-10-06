from gold import *
import json

world("T15", "2026-11-09T10:15", "Ingrid Solberg", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T15-101", "ask-options person star contrast nickname",
  T("star erik", ask("erik_n", "erik_j"),
    ref=[act("star", kind="person", name="Erik"),
         askc("Erik Nilsen or Erik Johansen?", options="$erik_n, $erik_j")]),
  T("the captain", diff(upd("erik_n", starred=True)),
    ref=[act("star", rows="$erik_n")]),
  T("and ailo as well, he saved my whole sample box when the winch failed", diff(upd("ailo", starred=True)),
    ref=[act("star", kind="person", name="Ailo")]),
  T("star mari too", diff(upd("marianne", starred=True)),
    ref=[search("Mari", kind="person"), act("star", rows="$marianne")]))

S("T15-102", "ask-options person log contrast",
  T("log a call with berg", ask("jonas", "berit", "knut"),
    ref=[act("log", kind="person", name="Berg", args="kind: call"),
         askc("Jonas, Berit or Knut?", options="$jonas, $berit, $knut")]),
  T("berit, about christmas", diff(upd("berit", date=ANY)),
    ref=[act("log", rows="$berit", args="kind: call")]),
  T("and anders rang me back, log that too", diff(upd("anders", date=ANY)),
    ref=[act("log", kind="person", name="Anders", args="kind: call")]),
  T("star berit, she had the dog all weekend", diff(upd("berit", starred=True)),
    ref=[act("star", rows="$berit")]))

S("T15-103", "ask-options person edit cadence contrast",
  T("put erik on every ten days", ask("erik_n", "erik_j"),
    ref=[act("edit", kind="person", name="Erik", args="cadence: 10"),
         askc("Erik Nilsen or Erik Johansen?", options="$erik_n, $erik_j")]),
  T("johansen", diff(upd("erik_j", cadence=10)),
    ref=[act("edit", rows="$erik_j", args="cadence: 10")]),
  T("kaja every three weeks", diff(upd("kaja", cadence=21)),
    ref=[act("edit", kind="person", name="Kaja", args="cadence: 21")]))

S("T15-104", "ask-options event cancel never-mind count reschedule at-n",
  T("cancel bouldering", ask("boulder_1110", "boulder_1117", "boulder_1215"),
    ref=[act("cancel", kind="event", name="Bouldering night"),
         find(kind="event", name="Bouldering night", when=W({"from": U("day", 0)})),
         askc("The 10th, the 17th or 15 December?", options="@prev")]),
  T("scratch that, silje says the wall's open", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how many bouldering nights are left this year", val(3),
    ref=[ans(op="count", kind="event", name="Bouldering night", when=W(span(U("day", 0), U("year", 0))))]),
  T("push the tenth to 7", diff(upd("boulder_1110", date="2026-11-10T19:00")),
    ref=[act("reschedule", kind="event", name="Bouldering night", when=W(D("2026-11-10")),
             args=lines(to=U("day", 0, anchor="row", time="19:00")))]))

S("T15-105", "ask-options event reschedule weekday at-n contrast",
  T("move the plankton meeting to thursday", ask("labmtg_1113", "labmtg_1120", "labmtg_1218"),
    ref=[act("reschedule", kind="event", name="Plankton group meeting", args=lines(to=U("week", 0, weekday=4))),
         find(kind="event", name="Plankton group meeting", when=W({"from": U("day", 0)})),
         askc("The 13th, the 20th or 18 December?", options="@prev")]),
  T("the thirteenth", diff(upd("labmtg_1113", date="2026-11-12T09:00")),
    ref=[act("reschedule", rows="$labmtg_1113", args=lines(to=U("week", 0, weekday=4)))]),
  T("and the one on the twentieth to 10", diff(upd("labmtg_1120", date="2026-11-20T10:00")),
    ref=[act("reschedule", kind="event", name="Plankton group meeting", when=W(D("2026-11-20")),
             args=lines(to=U("day", 0, anchor="row", time="10:00")))]),
  T("and december's one to 8", diff(upd("labmtg_1218", date="2026-12-18T08:00")),
    ref=[act("reschedule", kind="event", name="Plankton group meeting", when=W(D("2026-12-18")),
             args=lines(to=U("day", 0, anchor="row", time="08:00")))]))

S("T15-106", "ask-options event reschedule at-n hour contrast",
  T("move the dinner to 8", ask("erik_dinner", "jonas_bday", "bergs_1206"),
    ref=[act("reschedule", kind="event", name="dinner", args=lines(to=U("day", 0, anchor="row", time="20:00"))),
         find(kind="event", name="dinner", when=W({"from": U("day", 0)})),
         askc("Dinner with Erik and Kaja, Jonas's birthday or Berit and Knut's?", options="@prev")]),
  T("erik and kaja's", diff(upd("erik_dinner", date="2026-11-13T20:00")),
    ref=[act("reschedule", rows="$erik_dinner", args=lines(to=U("day", 0, anchor="row", time="20:00")))]),
  T("and push jonas's birthday dinner an hour", diff(upd("jonas_bday", date="2026-11-21T20:00")),
    ref=[act("reschedule", rows="$jonas_bday", args=lines(to=U("hour", 1, anchor="row")))]),
  T("star kaja too, she's cooking", diff(upd("kaja", starred=True)),
    ref=[act("star", kind="person", name="Kaja")]))

S("T15-107", "ask-options task complete reopen",
  T("mark send as done, i did it before the meeting this morning", ask("send_report", "photos_silje"),
    ref=[act("complete", kind="task", name="Send"),
         askc("Send report to Hallvard or send the sauna photos to Silje?", options="$send_report, $photos_silje")]),
  T("the report one", diff(upd("send_report", status="completed", completed=ANY)),
    ref=[act("complete", rows="$send_report")]),
  T("and reopen resole deck boots, the sole came off again", diff(upd("boots", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Resole deck boots")]))

S("T15-108", "ask-options task reschedule next-weekday weekday at-n",
  T("push the report to next monday", ask("report", "send_report"),
    ref=[act("reschedule", kind="task", name="report", args=lines(to=U("week", 1, weekday=1))),
         askc("Write cruise report HV-2610 or send report to Hallvard?", options="$report, $send_report")]),
  T("the write one", diff(upd("report", date="2026-11-16")),
    ref=[act("reschedule", rows="$report", args=lines(to=U("week", 1, weekday=1)))]),
  T("move the formalin order to friday at 3", diff(upd("formalin", date="2026-11-13T15:00")),
    ref=[act("reschedule", kind="task", name="Order formalin", args=lines(to=U("week", 0, weekday=5, time="15:00")))]))

S("T15-109", "ask-options document star unstar contrast",
  T("star the insurance", diff(upd("car_ins", starred=True)),
    ref=[act("star", kind="document", name="insurance")]))

S("T15-111", "ask-options locker reveal cvv contrast",
  T("show me the card cvv", ask("visa", "mastercard"),
    ref=[act("reveal", kind="locker item", where='type = "card"', args="field: cvv"),
         askc("DNB Visa or Sparebank Mastercard?", options="$visa, $mastercard")]),
  T("dnb", diff(reveal=[("visa", "338")]),
    ref=[act("reveal", rows="$visa", args="field: cvv")]),
  T("and the mastercard cvv", diff(reveal=[("mastercard", "061")]),
    ref=[act("reveal", rows="$mastercard", args="field: cvv")]),
  T("star the dnb one, it's the one i use", diff(already=["visa"]),
    ref=[act("star", rows="$visa"), ans(rows="$visa", kind="locker item")]))

S("T15-112", "ask-options locker star unstar",
  T("star the membership", diff(upd("club_card", starred=True)),
    ref=[act("star", kind="locker item", name="membership")]))

S("T15-113", "ask-options photo star contrast",
  T("star the pusur pic", ask("p_pusur_box", "p_pusur_window", "p_pusur_vet", "p_pusur_jonas"),
    ref=[act("star", kind="photo", name="Pusur"),
         askc("Which one - in the sample box, watching the snow, at the vet or asleep on Jonas?",
              options="$p_pusur_box, $p_pusur_window, $p_pusur_vet, $p_pusur_jonas")]),
  T("asleep on jonas", diff(upd("p_pusur_jonas", starred=True)),
    ref=[act("star", rows="$p_pusur_jonas")]),
  T("and pusur at the vet", diff(upd("p_pusur_vet", starred=True)),
    ref=[act("star", kind="photo", name="Pusur at the vet")]),
  T("unstar the crew photo, it's overexposed", diff(upd("p_crew", starred=False)),
    ref=[act("unstar", kind="photo", name="Crew photo")]))

S("T15-114", "ask-options task complete order",
  T("tick off order, it arrived", ask("formalin", "firewood", "bulb"),
    ref=[act("complete", kind="task", name="Order"),
         askc("Order formalin, order firewood for the cabin or order microscope bulb?",
              options="$formalin, $firewood, $bulb")]),
  T("firewood", diff(upd("firewood", status="completed", completed=ANY)),
    ref=[act("complete", rows="$firewood")]),
  T("and the formalin's on its way, tick that too", diff(upd("formalin", status="completed", completed=ANY)),
    ref=[act("complete", rows="$formalin")]),
  T("what's on this weekend", rows("aurora", "whale_trip", "mum_call"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]))

S("T15-115", "wifi bare read reveal verb-like star",
  T("what's the wifi password", rows("home_wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("show me the wifi password", diff(reveal=[("home_wifi", "pusur-sover-mye")]),
    ref=[act("reveal", rows="$home_wifi", args="field: password")]))
