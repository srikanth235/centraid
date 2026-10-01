from gold import *
import json

world("T27", "2026-12-03T04:50", "Sophie Dubois", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T27-101", "ask person star two camilles",
  T("star camille", ask("camille_r", "camille_p"),
    ref=[act("star", kind="person", name="Camille"),
         askc("camille roux or camille petit?", options="$camille_r, $camille_p")]),
  T("petit, from the prenatal class", diff(upd("camille_p", starred=True)),
    ref=[act("star", rows="$camille_p")]))

S("T27-102", "ask task complete order flour",
  T("tick off order flour", ask("flour_a", "flour_b"),
    ref=[act("complete", kind="task", name="Order flour"),
         find(kind="task", name="Order flour"),
         askc("the one from the 1st or the one for the 8th?", options="$flour_a, $flour_b")]),
  T("the 8th, thomas confirmed it by phone", diff(upd("flour_b", status="completed", completed=ANY)),
    ref=[act("complete", rows="$flour_b")]),
  T("and tick off the vitamins too", diff(upd("vitamins", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Buy prenatal vitamins")]))

S("T27-103", "contrast complete reschedule complete star",
  T("tick off confirm butter order with matthieu, he's got it", diff(upd("butter_conf", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Confirm butter order with Matthieu")]),
  T("and push the vat one to monday", diff(upd("vat", date="2026-12-07")),
    ref=[act("reschedule", kind="task", name="File the VAT registration", args=lines(to=U("week", 1, weekday=1)))]),
  T("mark the glass recycling as done", diff(upd("glass", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Take out the glass recycling")]),
  T("star the business plan, the bank wants it again", diff(upd("bizplan", starred=True)),
    ref=[act("star", kind="document", name="Business plan")]))

S("T27-104", "ask task reschedule insurer bare weekday",
  T("push call the insurer to monday", ask("insurer_1", "insurer_2"),
    ref=[act("reschedule", kind="task", name="Call the insurer", args=lines(to=U("week", 1, weekday=1))),
         find(kind="task", name="Call the insurer"),
         askc("the open one or the one you did in november?", options="$insurer_1, $insurer_2")]),
  T("the oven one", diff(upd("insurer_1", date="2026-12-07")),
    ref=[act("reschedule", rows="$insurer_1", args=lines(to=U("week", 1, weekday=1)))]),
  T("star the oven invoice, i'll need it for the claim", diff(upd("oven_invoice", starred=True)),
    ref=[act("star", kind="document", name="Oven invoice")]),
  T("and push the paper bags order to saturday", diff(upd("bags", date="2026-12-05")),
    ref=[act("reschedule", kind="task", name="Order paper bags and boxes", args=lines(to=U("week", 0, weekday=6)))]))

S("T27-105", "ask task complete shop rent",
  T("mark the shop rent as paid", ask("rent_09", "rent_10", "rent_11", "rent_12"),
    ref=[act("complete", kind="task", name="shop rent"),
         find(kind="task", name="shop rent"),
         askc("which month's?", options="$rent_09, $rent_10, $rent_11, $rent_12")]),
  T("december's, paid it this morning", diff(upd("rent_12", status="completed", completed=ANY)),
    ref=[act("complete", rows="$rent_12")]),
  T("and star the business insurance policy, just signed it", diff(upd("insurance", starred=True)),
    ref=[act("star", kind="document", name="Business insurance policy")]))

S("T27-106", "ask document star contract then dairy",
  T("star the contract", ask("flour_contract", "dairy_contract"),
    ref=[act("star", kind="document", name="contract"),
         askc("the moulin girard one or the dairy one?", options="$flour_contract, $dairy_contract")]),
  T("the flour one", diff(upd("flour_contract", starred=True)),
    ref=[act("star", rows="$flour_contract")]),
  T("and the dairy supply one", diff(upd("dairy_contract", starred=True)),
    ref=[act("star", rows="$dairy_contract")]))

S("T27-107", "ask document rename scan never mind then rename",
  T("rename the scan to Oven warranty", ask("scan_a", "scan_b", "morpho_rep"),
    ref=[act("edit", kind="document", name="scan", args=lines(name="Oven warranty")),
         askc("scan 1123, scan 1124 or the morphology scan report?", options="$scan_a, $scan_b, $morpho_rep")]),
  T("forget it, they're fine as they are", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("rename floor plan to Shop floor plan", diff(upd("floor_plan", name="Shop floor plan")),
    ref=[act("edit", kind="document", name="Floor plan", args=lines(name="Shop floor plan"))]))

S("T27-108", "ask locker reveal wifi then star",
  T("show me the wifi password", ask("wifi_home", "wifi_shop"),
    ref=[act("reveal", kind="locker item", name="wifi", args=lines(field="password")),
         askc("the home wifi or the shop wifi?", options="$wifi_home, $wifi_shop")]),
  T("the shop one, hugo needs it", diff(reveal=[("wifi_shop", "austerlitz-7am")]),
    ref=[act("reveal", rows="$wifi_shop", args=lines(field="password"))]),
  T("star it", diff(upd("wifi_shop", starred=True)),
    ref=[act("star", rows="$wifi_shop", kind="locker item")]))

S("T27-109", "ask locker star business then contrast star",
  T("star the business one in my locker", ask("biz_visa", "biz_account"),
    ref=[act("star", kind="locker item", name="business"),
         askc("the business visa or the bakery account?", options="$biz_visa, $biz_account")]),
  T("the account", diff(upd("biz_account", starred=True)),
    ref=[act("star", rows="$biz_account")]),
  T("star the personal mastercard too", diff(upd("perso_mc", starred=True)),
    ref=[act("star", kind="locker item", name="Personal Mastercard")]),
  T("and take the star off the metro card, camille has her own now", diff(upd("metro_card", starred=False)),
    ref=[act("unstar", kind="locker item", name="Metro cash and carry card")]))

S("T27-110", "ask event reschedule inspection at-n then other",
  T("move the inspection to 10", ask("hygiene", "oven_check"),
    ref=[act("reschedule", kind="event", name="inspection", args=lines(to=U("day", 0, anchor="row", time="10:00"))),
         askc("the hygiene one on the 9th or the oven one on the 8th?", options="$hygiene, $oven_check")]),
  T("the hygiene one", diff(upd("hygiene", date="2026-12-09T10:00")),
    ref=[act("reschedule", rows="$hygiene", args=lines(to=U("day", 0, anchor="row", time="10:00")))]),
  T("and put the other one at 10 as well", diff(upd("oven_check", date="2026-12-08T10:00")),
    ref=[act("reschedule", rows="$oven_check", args=lines(to=U("day", 0, anchor="row", time="10:00")))]))

S("T27-111", "ask event reschedule scan relative hour",
  T("push the scan back an hour", ask("scan3", "morpho"),
    ref=[act("reschedule", kind="event", name="scan", args=lines(to=U("hour", 1, anchor="row"))),
         askc("the third trimester scan or the morphology scan?", options="$scan3, $morpho")]),
  T("the third trimester one, julien can't get off till 10:30", diff(upd("scan3", date="2026-12-17T10:30")),
    ref=[act("reschedule", rows="$scan3", args=lines(to=U("hour", 1, anchor="row")))]),
  T("star the morphology scan report, the midwife will ask for it", diff(upd("morpho_rep", starred=True)),
    ref=[act("star", kind="document", name="Morphology scan report")]))

S("T27-112", "ask event delete dinner then undo",
  T("delete the dinner", ask("lea_dinner", "chloe_dinner", "julien_bday"),
    ref=[act("delete", kind="event", name="dinner"),
         askc("léa's, chloé's or julien's birthday dinner?", options="$lea_dinner, $chloe_dinner, $julien_bday")]),
  T("léa's, she's cancelled on me", diff(trash("lea_dinner")),
    ref=[act("delete", rows="$lea_dinner")]),
  T("undo, she just rang and it's back on", diff(restore("lea_dinner")),
    ref=[act("undo")]))

S("T27-113", "ask event cancel flour delivery then butter",
  T("cancel the flour delivery", ask("flour_1", "flour_2"),
    ref=[act("cancel", kind="event", name="Flour delivery"),
         find(kind="event", name="Flour delivery"),
         askc("tomorrow's or the one on the 11th?", options="$flour_1, $flour_2")]),
  T("tomorrow's, the mill is snowed in", diff(upd("flour_1", status="cancelled")),
    ref=[act("cancel", rows="$flour_1")]),
  T("and cancel the butter delivery too", diff(upd("butter_del", status="cancelled")),
    ref=[act("cancel", kind="event", name="Butter delivery")]),
  T("log a call with thomas girard, told him about the snow", diff(upd("thomas_g", date=ANY)),
    ref=[act("log", kind="person", name="Thomas Girard", args=lines(kind="call"))]))

S("T27-114", "ask event delete midwife never mind then delete",
  T("delete the midwife appointment", ask("midwife_nov", "midwife_dec"),
    ref=[act("delete", kind="event", name="Midwife appointment"),
         find(kind="event", name="Midwife appointment"),
         askc("the one on the 12th of november or the 10th of december?", options="$midwife_nov, $midwife_dec")]),
  T("don't bother, i'll do it after the appointment", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("delete the morphology scan, it's ancient history", diff(trash("morpho")),
    ref=[act("delete", kind="event", name="Morphology scan")]))

S("T27-115", "ask person add_to group thomas then contrast",
  T("add thomas to the opening party kitty", ask("thomas_m", "thomas_g"),
    ref=[act("add_to", kind="person", name="Thomas", args=lines(to="$party_g")),
         askc("thomas moreau or thomas girard?", options="$thomas_m, $thomas_g")]),
  T("julien's brother", diff(link("party_g", "thomas_m")),
    ref=[act("add_to", rows="$thomas_m", args=lines(to="$party_g"))]),
  T("and add inès to baby shower gifts", diff(link("shower_g", "ines")),
    ref=[act("add_to", kind="person", name="Inès", args=lines(to="$shower_g"))]))
