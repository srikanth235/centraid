from gold import *
import json

world("T12", "2026-08-18T15:45", "Kenji Watanabe", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T12-101", "gap ask event reschedule anchor day",
  T("push the health inspection back a day", ask("inspection", "reinspection"),
    ref=[act("reschedule", kind="event", name="Health inspection", args=lines(to=U("day", 1, anchor="row"))),
         askc("the one on the 27th or the follow-up on the 10th?", options="$inspection, $reinspection")]),
  T("the follow-up one", diff(upd("reinspection", date="2026-09-11T14:00")),
    ref=[act("reschedule", rows="$reinspection", args=lines(to=U("day", 1, anchor="row")))]))

S("T12-102", "gap contrast reschedule event date star already weekday time",
  T("the inspection follow-up, make it the eleventh instead", diff(upd("reinspection", date="2026-09-11T14:00")),
    ref=[act("reschedule", kind="event", name="Health inspection follow-up", args=lines(to=D("2026-09-11")))]),
  T("and star hana's vaccination record", diff(already=["hana_vax"]),
    ref=[act("star", kind="document", name="Hana vaccination record"), ans(rows="$hana_vax")]),
  T("move the ito call to thursday at 4", diff(upd("ito_call", date="2026-08-20T16:00")),
    ref=[act("reschedule", kind="event", name="Miso order call with Ito",
             args=lines(to=U("week", 0, weekday=4, time="16:00")))]))

S("T12-103", "gap ask person star ryo multi write",
  T("star ryo", ask("ryo_t", "ryo_i"),
    ref=[act("star", kind="person", name="Ryo"),
         askc("ryo tanaka or ryo ishida?", options="$ryo_t, $ryo_i")]),
  T("ishida, he's covering my days off", diff(upd("ryo_i", starred=True)),
    ref=[act("star", rows="$ryo_i")]),
  T("log a call with nishiyama and star him too, the noodle trial's on", diff(upd("nishiyama", date=ANY, starred=True)),
    ref=[act("log", kind="person", name="Hiroshi Nishiyama", args=lines(kind="call"), more=True),
         act("star", kind="person", name="Hiroshi Nishiyama")]))

S("T12-104", "gap contrast star person unstar locker count",
  T("favourite tomoko hayashi, she's my beer rep", diff(upd("hayashi_t", starred=True)),
    ref=[act("star", kind="person", name="Tomoko Hayashi")]),
  T("and unstar the pos login", diff(upd("pos", starred=False)),
    ref=[act("unstar", kind="locker item", name="POS login")]),
  T("how many people have i starred", val(5),
    ref=[ans(op="count", kind="person", where="starred = yes")]))

S("T12-105", "gap ask document star lease repair remove_from refused",
  T("star the lease doc", ask("lease_2024", "lease_draft"),
    ref=[act("star", kind="document", name="lease"),
         askc("the 2024 lease or the renewal draft?", options="$lease_2024, $lease_draft")]),
  T("the renewal", diff(upd("lease_draft", starred=True)),
    ref=[act("star", rows="$lease_draft")]),
  T("take min-jun out of the seoul group, he's not coming", ask(),
    ref=[bad(act("remove_from", kind="person", name="Min-jun Park", args=lines(from_="$seoul"))),
         askc("min-jun still has an unsettled balance in the seoul group, so he can't come out yet. settle up with him first?")]))

S("T12-106", "gap contrast star document count decline unbounded",
  T("star the fire safety certificate", diff(upd("fire_cert", starred=True)),
    ref=[act("star", kind="document", name="Fire safety certificate")]),
  T("how many starred docs is that now", val(7),
    ref=[ans(op="count", kind="document", where="starred = yes")]),
  T("delete all my notes, fresh start", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T12-107", "gap ask document rename insurance repair restore window not_found",
  T("rename the insurance doc, add 2026 on the end", ask("shop_ins", "car_ins", "hana_ins"),
    ref=[find(kind="document", name="insurance"),
         askc("which one: the shop policy, the car certificate or hana's health card?",
              options="$shop_ins, $car_ins, $hana_ins")]),
  T("car", diff(upd("car_ins", name="Car insurance certificate 2026")),
    ref=[act("edit", rows="$car_ins", args=lines(name="Car insurance certificate 2026"))]),
  T("and bring the old stove pickup back", decline("not_found"),
    ref=[bad(act("restore", kind="event", name="Old stove pickup", trashed=True)), dec("not_found")]))

S("T12-108", "gap contrast rename document star already multi write unstar",
  T("rename the august menu doc to September menu", diff(upd("menu_aug", name="September menu")),
    ref=[act("edit", kind="document", name="August menu", args=lines(name="September menu"))]),
  T("and star it", diff(already=["menu_aug"]),
    ref=[act("star", rows="$menu_aug"), ans(rows="$menu_aug")]),
  T("star gmail and unstar the costco one", diff(upd("gmail", starred=True), upd("costco", starred=False)),
    ref=[act("star", kind="locker item", name="Gmail", more=True),
         act("unstar", kind="locker item", name="Costco membership")]))

S("T12-109", "gap ask document unstar permit never mind",
  T("unstar the permit doc", ask("hygiene", "stall_permit"),
    ref=[act("unstar", kind="document", name="permit"),
         askc("the food hygiene permit or the fest stall permit?", options="$hygiene, $stall_permit")]),
  T("forget it, i'll do it later", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("star the nursery application form instead", diff(upd("nursery_doc", starred=True)),
    ref=[act("star", kind="document", name="Nursery application form")]))

S("T12-110", "gap ask locker star pos repair edit field",
  T("star the pos one", ask("pos", "pos_key"),
    ref=[act("star", kind="locker item", name="POS"),
         askc("the shop pos login or the pos server key?", options="$pos, $pos_key")]),
  T("server key", diff(upd("pos_key", starred=True)),
    ref=[act("star", rows="$pos_key")]),
  T("make the aircon filter task 45", diff(upd("aircon", effort=45)),
    ref=[bad(act("edit", kind="task", name="air conditioner filter", args=lines(duration="45"))),
         act("edit", kind="task", name="air conditioner filter", args=lines(effort="45"))]))

S("T12-111", "gap ask task delete gas bill never mind",
  T("delete the gas bill task", ask("gas_aug", "gas_jul"),
    ref=[act("delete", kind="task", name="Pay gas bill"),
         askc("august's, due the 20th, or july's that's already paid?", options="$gas_aug, $gas_jul")]),
  T("actually never mind, leave them both", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("done with the shift schedule though, tick it", diff(upd("shifts", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="September shift schedule")]))

S("T12-112", "gap contrast delete task month undo never mind balance negative",
  T("delete the july kombu order, it's done and dusted and i don't want it cluttering the list", diff(trash("kombu_jul")),
    ref=[act("delete", kind="task", name="Order kombu from Rishiri", when=W(U("month", 0, name=7)))]),
  T("cancel that, i still need it", diff(restore("kombu_jul")),
    ref=[act("undo")]),
  T("how much do i owe fujita", val((-12000, "JPY")),
    ref=[ans(op="balance", kind="person", name="Fujita")]),
  T("bring back the aprons task from the trash, i never ordered them", diff(restore("aprons")),
    ref=[act("restore", kind="task", name="Order new aprons", trashed=True)]))

S("T12-113", "gap ask event cancel coffee not_found search",
  T("cancel the coffee, something came up", ask("haruto_coffee", "shun_coffee"),
    ref=[act("cancel", kind="event", name="Coffee"),
         askc("coffee with haruto today at 5 or with shun on friday?", options="$haruto_coffee, $shun_coffee")]),
  T("haruto's one", diff(upd("haruto_coffee", status="cancelled")),
    ref=[act("cancel", rows="$haruto_coffee")]),
  T("push the vet appointment to friday", decline("not_found"),
    ref=[search("vet appointment", kind="event"), dec("not_found")]),
  T("how many cancelled events have i got this month now", val(3),
    ref=[ans(op="count", kind="event", where='status = "cancelled"', when=W(U("month", 0)))]))

S("T12-114", "gap contrast cancel event balance positive decline unbounded",
  T("cancel coffee with shun on friday, he's got a meeting", diff(upd("shun_coffee", status="cancelled")),
    ref=[act("cancel", kind="event", name="Coffee with Shun", when=W(U("week", 0, weekday=5)))]),
  T("where do i stand with mei", val((8000, "JPY")),
    ref=[ans(op="balance", kind="person", name="Mei")]),
  T("wipe my whole calendar, fresh start", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T12-115", "gap ask balance sato",
  T("where do i stand with sato", ask("aiko", "kenta_s"),
    ref=[find(kind="person", name="Sato"),
         askc("aiko sato or kenta sato?", options="$aiko, $kenta_s")]),
  T("aiko", val((200, "JPY")),
    ref=[ans(op="balance", rows="$aiko")]),
  T("and kenta", val((-6800, "JPY")),
    ref=[ans(op="balance", rows="$kenta_s")]),
  T("log a message from aiko, she texted about weekend shifts", diff(upd("aiko", date=ANY)),
    ref=[act("log", rows="$aiko", args=lines(kind="message"))]))
