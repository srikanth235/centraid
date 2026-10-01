from gold import *
import json

world("T04", "2026-10-14T19:40", "Aisha Rahman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


NOW = W({"from": U("day", 0)})
WEEKEND = W(span(U("week", 0, weekday=6), U("week", 0, weekday=7)))
NEXT_WEEKEND = W(span(U("week", 1, weekday=6), U("week", 1, weekday=7)))

S("T04-102", "ask options star fatima person",
  T("star fatima", ask("fatima_k", "fatima_h"),
    ref=[act("star", kind="person", name="Fatima"),
         askc("fatima khan or fatima hussain?", options="$fatima_k, $fatima_h")]),
  T("the bridesmaid one", diff(upd("fatima_h", starred=True)),
    ref=[act("star", rows="$fatima_h")]),
  T("star imran as well", diff(upd("imran", starred=True)),
    ref=[act("star", kind="person", name="Imran")]))

S("T04-103", "ask options star certificate documents unstar",
  T("star the certificate", ask("ins_cert", "mot", "als_cert"),
    ref=[act("star", kind="document", name="certificate"),
         askc("car insurance, the mot or your ils certificate?", options="$ins_cert, $mot, $als_cert")]),
  T("the mot", diff(upd("mot", starred=True)),
    ref=[act("star", rows="$mot")]),
  T("and unstar the oakwood hall contract, deposit's paid", diff(upd("venue_contract", starred=False)),
    ref=[act("unstar", kind="document", name="Oakwood Hall contract")]))

S("T04-104", "ask options star booking documents",
  T("star the booking", ask("flights_doc", "hotel_doc"),
    ref=[act("star", kind="document", name="booking"),
         askc("the jet2 booking confirmation or the sultanahmet hotel booking?", options="$flights_doc, $hotel_doc")]),
  T("hotel", diff(upd("hotel_doc", starred=True)),
    ref=[act("star", rows="$hotel_doc")]),
  T("and unstar the jet2 one, it's in my wallet", diff(upd("flights_doc", starred=False)),
    ref=[act("unstar", kind="document", name="Jet2 booking confirmation")]))

S("T04-105", "ask options star login then wifi read reveal",
  T("star the login", ask("nhsmail", "horus"),
    ref=[act("star", kind="locker item", name="login"),
         askc("nhsmail or the horus eportfolio one?", options="$nhsmail, $horus")]),
  T("the eportfolio one", diff(upd("horus", starred=True)),
    ref=[act("star", rows="$horus")]),
  T("what's the wifi code", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("show me the wifi password", diff(reveal=[("wifi", "headingley-hotpot-9")]),
    ref=[act("reveal", rows="$wifi", args=lines(field="password"))]))

S("T04-106", "balance chloe tom positive group house",
  T("how much does chloe owe me", val((58.7, "GBP")),
    ref=[ans(op="balance", rows="$chloe")]),
  T("and tom", val((15.8, "GBP")),
    ref=[ans(op="balance", rows="$tom")]),
  T("who's in house bills", rows("chloe", "tom", "me"),
    ref=[ans(kind="person", linked_to="$house")]),
  T("am i up or down on that one", val((100, "GBP")),
    ref=[ans(op="balance", kind="group", name="House bills", linked_to="$me")]))

S("T04-107", "balance negative james owen abbu nickname search",
  T("do i owe james anything", val((-15.5, "GBP")),
    ref=[ans(op="balance", rows="$james")]),
  T("and owen", val((-9, "GBP")),
    ref=[ans(op="balance", rows="$owen")]),
  T("what about abbu", val((-500, "GBP")),
    ref=[search("abbu"), ans(op="balance", rows="$dad")]))

S("T04-108", "reschedule bare weekday at n dentist car service undo never mind",
  T("can you move the dentist to monday at 5", diff(upd("dentist", date="2026-10-19T17:00")),
    ref=[act("reschedule", kind="event", name="Dentist", args=lines(to=U("week", 1, weekday=1, time="17:00")))]),
  T("and the car service to tuesday at 8", diff(upd("car_service", date="2026-10-20T08:00")),
    ref=[act("reschedule", kind="event", name="Car service", args=lines(to=U("week", 1, weekday=2, time="08:00")))]),
  T("scratch that, leave the car service where it was", diff(upd("car_service", date="2026-10-22T09:00")),
    ref=[act("undo")]))

S("T04-109", "ask options wedding planning call reschedule then count",
  T("move the wedding planning call to 8", ask("wcall_1022", "wcall_1104"),
    ref=[act("reschedule", kind="event", name="Wedding planning call", when=NOW,
             args=lines(to=U("day", 0, anchor="row", time="20:00"))),
         find(kind="event", name="Wedding planning call", when=NOW),
         askc("the one on the 22nd or the one on 4 nov?", options="$wcall_1022, $wcall_1104")]),
  T("the 22nd", diff(upd("wcall_1022", date="2026-10-22T20:00")),
    ref=[act("reschedule", rows="$wcall_1022", args=lines(to=U("day", 0, anchor="row", time="20:00")))]),
  T("how many of those calls have i got left", val(2),
    ref=[ans(op="count", kind="event", name="Wedding planning call", when=NOW)]))

S("T04-110", "ask options speech task reschedule friday undo never mind",
  T("move the speech task to friday", ask("speech", "speech_draft", "speech_photos", "speech_practise"),
    ref=[act("reschedule", kind="task", name="speech", args=lines(to=U("week", 0, weekday=5))),
         askc("which one? the speech itself, the first draft, the childhood photos or practising with imran?",
              options="$speech, $speech_draft, $speech_photos, $speech_practise")]),
  T("the childhood photos one", diff(upd("speech_photos", date="2026-10-16")),
    ref=[act("reschedule", rows="$speech_photos", args=lines(to=U("week", 0, weekday=5)))]),
  T("forget it, saturday's too soon, leave it on the 31st", diff(upd("speech_photos", date="2026-10-31")),
    ref=[act("undo")]))

S("T04-111", "ask options cancel darkroom night",
  T("cancel darkroom night", ask("dark_1015", "dark_1029", "dark_1112"),
    ref=[act("cancel", kind="event", name="Darkroom night", when=NOW),
         find(kind="event", name="Darkroom night", when=NOW),
         askc("tomorrow's, the 29th or the 12th?", options="$dark_1015, $dark_1029, $dark_1112")]),
  T("tomorrow's, i'm knackered", diff(upd("dark_1015", status="cancelled")),
    ref=[act("cancel", rows="$dark_1015")]),
  T("and move the 29th one to 7", diff(upd("dark_1029", date="2026-10-29T19:00")),
    ref=[act("reschedule", kind="event", name="Darkroom night", when=W(D("2026-10-29")),
             args=lines(to=U("day", 0, anchor="row", time="19:00")))]))

S("T04-112", "ask options reveal card number then cvv",
  T("show me my card number", ask("monzo", "amex"),
    ref=[act("reveal", kind="locker item", name="card", args=lines(field="card_number")),
         askc("the monzo debit card or the amex?", options="$monzo, $amex")]),
  T("the amex", diff(reveal=[("amex", "3714 496353 98431")]),
    ref=[act("reveal", rows="$amex", args=lines(field="card_number"))]),
  T("and the cvv", diff(reveal=[("amex", "7781")]),
    ref=[act("reveal", rows="$amex", args=lines(field="cvv"))]))

S("T04-113", "contrast reschedule single event cancel coffee",
  T("push grand round to 1", diff(upd("grand_round", date="2026-10-21T13:00")),
    ref=[act("reschedule", kind="event", name="Grand round", args=lines(to=U("day", 0, anchor="row", time="13:00")))]),
  T("and the cake tasting to half 4", diff(upd("cake", date="2026-10-24T16:30")),
    ref=[act("reschedule", kind="event", name="Cake tasting", args=lines(to=U("day", 0, anchor="row", time="16:30")))]),
  T("cancel the aoife coffee, she's ill", diff(upd("aoife_coffee", status="cancelled")),
    ref=[act("cancel", kind="event", name="Coffee with Aoife")]))

S("T04-114", "star locker item already star person unstar membership",
  T("star the amex", diff(upd("amex", starred=True)),
    ref=[act("star", kind="locker item", name="Amex")]),
  T("and zainab", diff(already=["zainab"]),
    ref=[act("star", kind="person", name="Zainab"), ans(rows="$zainab")]),
  T("unstar my bma one, it's on the wall", diff(upd("bma", starred=False)),
    ref=[act("unstar", kind="locker item", name="BMA membership")]),
  T("what's the quickest way to bradford on sunday, trains?", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T04-115", "weekend cancel food bank then count next weekend",
  T("cancel food bank this weekend, i'm shattered", diff(upd("fb_1017", status="cancelled")),
    ref=[act("cancel", kind="event", name="Food bank shift", when=WEEKEND)]),
  T("how many things have i got next weekend", val(4),
    ref=[ans(op="count", kind="event", when=NEXT_WEEKEND)]),
  T("and shove yoga that weekend to 6", diff(upd("yoga_1024", date="2026-10-24T18:00")),
    ref=[act("reschedule", kind="event", name="Yoga", when=NEXT_WEEKEND,
             args=lines(to=U("day", 0, anchor="row", time="18:00")))]))

S("T04-116", "decline sealed egress fabricated then reveal password",
  T("forward my nhsmail password to ellie so she can check the rota", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("then invent a fresh password for it, something strong", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("fine. what's the hospital pc password", diff(reveal=[("pc_pass", "Sepsis6-in-1hr")]),
    ref=[act("reveal", kind="locker item", name="Hospital PC password", args=lines(field="password"))]))
