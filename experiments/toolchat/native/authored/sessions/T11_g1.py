from gold import *
import json

world("T11", "2026-07-26T07:30", "Siobhan Kelly", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T11-101", "ask gaa meeting two dates find then pick reschedule anchor",
  T("move the gaa meeting to half 8", ask("gaa_0804", "gaa_0901"),
    ref=[act("reschedule", kind="event", name="GAA committee meeting", args=lines(to=U("day", 0, anchor="row", time="20:30"))),
         find(kind="event", name="GAA committee meeting", when=W({"from": U("day", 0)})),
         askc("the one on the 4th of august or the 1st of september?", options="@prev")]),
  T("august one", diff(upd("gaa_0804", date="2026-08-04T20:30")),
    ref=[act("reschedule", rows="$gaa_0804", args=lines(to=U("day", 0, anchor="row", time="20:30")))]))

S("T11-102", "ask mary star pick balance negative",
  T("star mary", ask("mary_l", "mary_c"),
    ref=[act("star", kind="person", name="Mary"),
         askc("mary lynch from the parents group or mary considine next door?", options="$mary_l, $mary_c")]),
  T("next door", diff(upd("mary_c", starred=True)),
    ref=[act("star", rows="$mary_c")]),
  T("what do i owe her", val((-12, "EUR")),
    ref=[ans(op="balance", rows="$mary_c")]))

S("T11-103", "ask june statement star pick already-so star",
  T("star the june statement", diff(upd("bank_stmt", starred=True)),
    ref=[act("star", kind="document", name="statement")]),
  T("and the house insurance policy", diff(already=["house_policy"]),
    ref=[act("star", kind="document", name="House insurance policy"), ans(rows="$house_policy")]))

S("T11-104", "ask diesel debt settle pick balance positive",
  T("mark the diesel paid", ask("d_pj", "d_mick_diesel"),
    ref=[act("settle_debt", kind="debt", name="diesel"),
         askc("the massey diesel pj owes you or the diesel you owe mick?", options="$d_pj, $d_mick_diesel")]),
  T("the massey one", diff(upd("d_pj", status="settled")),
    ref=[act("settle_debt", rows="$d_pj")]),
  T("where am i with mick now", val((145, "EUR")),
    ref=[ans(op="balance", kind="person", name="Mick Considine")]))

S("T11-105", "ask u12 trainings find never_mind",
  T("cancel the hurling training", ask("u12_0729", "u12_0805", "u12_0812", "u12_0819", "u12_0826"),
    ref=[act("cancel", kind="event", name="U12 hurling training"),
         find(kind="event", name="U12 hurling training", when=W({"from": U("day", 0)})),
         askc("which one? wednesday the 29th, or one of the august ones?", options="@prev")]),
  T("never mind", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T11-106", "ask insurance renewals reschedule date count",
  T("push the insurance renewal to the twentieth", ask("house_ins", "herd_ins"),
    ref=[act("reschedule", kind="task", name="insurance", args=lines(to=D("2026-08-20"))),
         askc("renew house insurance (15 aug) or renew herd insurance (1 sept)?", options="$house_ins, $herd_ins")]),
  T("house one", diff(upd("house_ins", date="2026-08-20")),
    ref=[act("reschedule", rows="$house_ins", args=lines(to=D("2026-08-20")))]),
  T("bring the herd one forward to friday week", diff(upd("herd_ins", date="2026-08-07")),
    ref=[act("reschedule", kind="task", name="Renew herd insurance", args=lines(to=U("week", 2, weekday=5)))]))

S("T11-107", "ask aib unstar locker pick star",
  T("unstar the aib one", ask("aib", "debit"),
    ref=[act("unstar", kind="locker item", name="AIB"),
         askc("aib online banking or the aib debit card?", options="$aib, $debit")]),
  T("the card", diff(upd("debit", starred=False)),
    ref=[act("unstar", rows="$debit")]),
  T("and star the icbf login instead", diff(upd("icbf", starred=True)),
    ref=[act("star", kind="locker item", name="ICBF herd account")]))

S("T11-108", "repair balance two sean ask pick balance substitution",
  T("how much do i owe sean", ask("sean_m", "sean_h"),
    ref=[bad(ans(op="balance", kind="person", name="Sean")),
         askc("sean mahon the silage man or sean hehir from the club?", options="$sean_m, $sean_h")]),
  T("mahon", val((-850, "EUR")),
    ref=[ans(op="balance", rows="$sean_m")]),
  T("and hehir", val((-20, "EUR")),
    ref=[ans(op="balance", rows="$sean_h")]))

S("T11-109", "ask mary log coffee never_mind",
  T("log a coffee with mary", ask("mary_l", "mary_c"),
    ref=[act("log", kind="person", name="Mary", args=lines(kind="coffee")),
         askc("mary lynch or mary considine?", options="$mary_l, $mary_c")]),
  T("forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T11-110", "ask fence cross-kind delete photo",
  T("delete the fence one", ask("fence", "p_fence", "fence_quote"),
    ref=[search("fence"),
         askc("the fix the paddock fence task, the broken fence photo or the fencing quote from martin?", options="@prev")]),
  T("the photo", diff(trash("p_fence")),
    ref=[act("delete", rows="$p_fence")]),
  T("and star the fencing quote", diff(upd("fence_quote", starred=True)),
    ref=[act("star", kind="document", name="Fencing quote from Martin")]))

S("T11-111", "ask teagasc at-n pick decided lotto draw tonight",
  T("move the teagasc thing to 2", ask("teagasc_grp", "farm_walk"),
    ref=[act("reschedule", kind="event", name="Teagasc", args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         askc("the discussion group on the 23rd or the farm walk on the 20th of august?", options="$teagasc_grp, $farm_walk")]),
  T("farm walk", diff(upd("farm_walk", date="2026-08-20T14:00")),
    ref=[act("reschedule", rows="$farm_walk", args=lines(to=U("day", 0, anchor="row", time="14:00")))]),
  T("and tonight's lotto draw, push it to half 9", diff(upd("draw_0726", date="2026-07-26T21:30")),
    ref=[act("reschedule", kind="event", name="Club lotto draw", when=W(U("day", 0)),
             args=lines(to=U("day", 0, time="21:30")))]))

S("T11-112", "ask cian birthday event or task pick reschedule date",
  T("move cian's birthday to the 16th", ask("cian_party", "cian_present"),
    ref=[search("cian birthday"),
         askc("the birthday party on the 9th or the birthday present task?", options="$cian_party, $cian_present")]),
  T("the party, 2 o'clock", diff(upd("cian_party", date="2026-08-16T14:00")),
    ref=[act("reschedule", rows="$cian_party", args=lines(to=D("2026-08-16", "14:00")))]))

S("T11-113", "ask login username reveal pick",
  T("show me the password for the IE5512890 login", ask("icbf", "agfood"),
    ref=[act("reveal", kind="locker item", where='username = "IE5512890"', args=lines(field="password")),
         askc("icbf herd account or agfood.ie? both use that username", options="$icbf, $agfood")]),
  T("icbf", diff(reveal=[("icbf", "Friesian214!")]),
    ref=[act("reveal", rows="$icbf", args=lines(field="password"))]))

S("T11-114", "ask milk docs star never_mind",
  T("star the milk one", diff(upd("supply_agree", starred=True)),
    ref=[act("star", kind="document", name="milk")]))

S("T11-115", "wifi code read reveal star locker",
  T("what's our wifi code", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("show me the wifi password, mam is here", diff(reveal=[("wifi", "hurling-cian-2015")]),
    ref=[act("reveal", rows="@prev", args=lines(field="password"))]),
  T("star that one", diff(upd("wifi", starred=True)),
    ref=[act("star", rows="$wifi")]))
