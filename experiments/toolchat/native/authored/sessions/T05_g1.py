from gold import *
import json

world("T05", "2026-01-20T06:40", "Priya Raman", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))
CRIC = "Cricket night at Vicky's"

S("T05-101", "ask people star unstar",
  T("star ramesh", ask("ramesh_mama", "ramesh_d"),
    ref=[act("star", kind="person", name="Ramesh"),
         askc("ramesh iyer your uncle or ramesh babu the driver?", options="$ramesh_mama, $ramesh_d")]),
  T("the driver", diff(upd("ramesh_d", starred=True)),
    ref=[act("star", rows="$ramesh_d")]),
  T("unstar the sale deed, it's safe in the house folder", diff(upd("sale_deed", starred=False)),
    ref=[act("unstar", kind="document", name="House sale deed")]),
  T("total people with a star on them right now", val(4),
    ref=[ans(op="count", kind="person", where="starred = yes")]))

S("T05-102", "event attendees star log pronoun",
  T("who's coming to the movie on sunday", rows("divya_k"),
    ref=[ans(kind="person", linked_to="$movie")]),
  T("star her", diff(upd("divya_k", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("and log a call with her, she rang this morning", diff(upd("divya_k", date=ANY)),
    ref=[act("log", rows="$divya_k", args=lines(kind="call"))]))

S("T05-103", "ask people log visit",
  T("log a visit with divya, she came over for tea", ask("divya_s", "divya_k"),
    ref=[act("log", kind="person", name="Divya", args=lines(kind="visit")),
         askc("divya srinivasan from the icu or divya krishnan from the cricket gang?", options="$divya_s, $divya_k")]),
  T("the cricket one", diff(upd("divya_k", date=ANY)),
    ref=[act("log", rows="$divya_k", args=lines(kind="visit"))]),
  T("star nandini rao and log a call with kavya narayanan, she's been asking about the school reunion",
    diff(upd("nandini", starred=True), upd("kavya", date=ANY)),
    ref=[act("star", kind="person", name="Nandini Rao", more=True),
         act("log", kind="person", name="Kavya Narayanan", args=lines(kind="call"))]))

S("T05-104", "ask locker star membership",
  T("star my membership card", ask("gym_card", "library"),
    ref=[act("star", kind="locker item", where='type = "membership"'),
         askc("the cult gym membership or the connemara library card?", options="$gym_card, $library")]),
  T("library", diff(upd("library", starred=True)),
    ref=[act("star", rows="$library")]),
  T("star the cult gym one too, lapsed but i want the number", diff(upd("gym_card", starred=True)),
    ref=[act("star", kind="locker item", name="Cult gym")]),
  T("unstar the hospital login, i know it by heart", diff(upd("his", starred=False)),
    ref=[act("unstar", kind="locker item", name="Hospital HIS login")]))

S("T05-105", "ask document star receipt unstar",
  T("star the receipt", ask("tax_receipt", "eb_receipt"),
    ref=[act("star", kind="document", name="receipt"),
         askc("the property tax receipt 2025 or the EB bill receipt december?", options="$tax_receipt, $eb_receipt")]),
  T("the december one", diff(upd("eb_receipt", starred=True)),
    ref=[act("star", rows="$eb_receipt")]),
  T("unstar the pan card scan, don't need it up top", diff(upd("pan", starred=False)),
    ref=[act("unstar", kind="document", name="PAN card scan")]),
  T("star the property tax one and unstar the december one, i got them mixed up",
    diff(upd("tax_receipt", starred=True), upd("eb_receipt", starred=False)),
    ref=[act("star", kind="document", name="Property tax receipt 2025", more=True),
         act("unstar", kind="document", name="EB bill receipt December")]))

S("T05-106", "carpool driver star pronoun balance",
  T("who's the carpool driver", rows("ramesh_d"),
    ref=[ans(kind="person", linked_to="$carpool", where='role contains "driver"')]),
  T("star him", diff(upd("ramesh_d", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("what do i owe ramesh babu, i think i paid the last fuel share in cash", val((-100, "INR")),
    ref=[ans(op="balance", kind="person", name="Ramesh Babu")]),
  T("and unstar karthik, he's not a priority", diff(upd("karthik", starred=False)),
    ref=[act("unstar", kind="person", name="Karthik")]))

S("T05-107", "ask people star rao out_of_scope",
  T("star rao", ask("rao_doc", "nandini"),
    ref=[act("star", kind="person", name="Rao"),
         askc("dr prakash rao the eye doctor or nandini rao from school?", options="$rao_doc, $nandini")]),
  T("the eye doctor", diff(upd("rao_doc", starred=True)),
    ref=[act("star", rows="$rao_doc")]),
  T("what's the weather like tomorrow", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("star nirmala madam", diff(upd("nirmala", starred=True)),
    ref=[act("star", kind="person", name="Nirmala")]))

S("T05-108", "ask event cancel never_mind",
  T("cancel the temple committee meeting", ask("tc_0124", "tc_0207"),
    ref=[act("cancel", kind="event", name="Temple committee meeting", when=W({"from": U("day", 0)})),
         find(kind="event", name="Temple committee meeting", when=W({"from": U("day", 0)})),
         askc("saturday's meeting on the 24th or the one on 7 feb?", options="$tc_0124, $tc_0207")]),
  T("forget it, i'll ask gopal first", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("ok gopal's fine with it, cancel the saturday one", diff(upd("tc_0124", status="cancelled")),
    ref=[act("cancel", kind="event", name="Temple committee meeting", when=W(U("week", 0, weekday=6)))]))

S("T05-109", "event cancel reschedule two writes weekend",
  T("cancel the temple committee meeting on the 7th and push the accounts review to friday at 5",
    diff(upd("tc_0207", status="cancelled"), upd("accounts", date="2026-01-23T17:00")),
    ref=[act("cancel", kind="event", name="Temple committee meeting", when=W(D("2026-02-07")), more=True),
         act("reschedule", kind="event", name="Temple accounts review",
             args=lines(to=U("week", 0, weekday=5, time="17:00")))]),
  T("what's on this weekend", rows("tc_0124", "night_0124", "movie", "cric_0125"),
    ref=[ans(kind="event", when=W(WEEKEND))]),
  T("cancel the movie this weekend, divya's busy", diff(upd("movie", status="cancelled")),
    ref=[act("cancel", kind="event", name="Movie", when=W(WEEKEND))]),
  T("and push the electrician to friday at 10", diff(upd("electrician", date="2026-01-23T10:00")),
    ref=[act("reschedule", kind="event", name="Electrician visit", args=lines(to=U("week", 0, weekday=5, time="10:00")))]))

S("T05-110", "ask event reschedule cricket",
  T("push the cricket night to 3", ask("cric_0125", "cric_0208"),
    ref=[act("reschedule", kind="event", name=CRIC, when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 0, anchor="row", time="15:00"))),
         find(kind="event", name=CRIC, when=W({"from": U("day", 0)})),
         askc("this sunday the 25th or the one on 8 feb?", options="$cric_0125, $cric_0208")]),
  T("the 25th one", diff(upd("cric_0125", date="2026-01-25T15:00")),
    ref=[act("reschedule", rows="$cric_0125", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("how many cricket nights are coming up", val(2),
    ref=[ans(op="count", kind="event", name=CRIC, when=W({"from": U("day", 0)}))]))

S("T05-111", "event next reschedule count cancelled out_of_scope",
  T("when's the next cricket night", rows("cric_0125"),
    ref=[ans(kind="event", name=CRIC, when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("push it to 3, vicky's got guests over till lunch and i'm on nights before", diff(upd("cric_0125", date="2026-01-25T15:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("how many have been cancelled so far", val(1),
    ref=[ans(op="count", kind="event", name=CRIC, where='status = "cancelled"')]),
  T("who won the ranji match yesterday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T05-113", "ask task volunteers reschedule weekday",
  T("push the volunteers task to friday", ask("volunteers", "vol_call", "vol_print"),
    ref=[search("volunteer", kind="task"),
         askc("the thai poosam volunteer list, calling the college volunteers or printing the badges?",
              options="$volunteers, $vol_call, $vol_print")]),
  T("the badges one", diff(upd("vol_print", date="2026-01-23")),
    ref=[act("reschedule", rows="$vol_print", args=lines(to=U("week", 0, weekday=5)))]),
  T("and the call one to thursday at 9", diff(upd("vol_call", date="2026-01-22T09:00")),
    ref=[act("reschedule", kind="task", name="Call the college volunteers",
             args=lines(to=U("week", 0, weekday=4, time="09:00")))]),
  T("star the volunteer rota doc", diff(upd("volunteer_doc", starred=True)),
    ref=[act("star", kind="document", name="Volunteer rota Thai Poosam")]))

S("T05-115", "ask locker reveal login",
  T("show me the login password", ask("his", "tnnmc_login"),
    ref=[act("reveal", kind="locker item", where='type = "login"', args=lines(field="password")),
         askc("the hospital HIS login or the tnnmc portal login?", options="$his, $tnnmc_login")]),
  T("the tnnmc one", diff(reveal=[("tnnmc_login", "nurse@2021")]),
    ref=[act("reveal", rows="$tnnmc_login", args=lines(field="password"))]),
  T("and the hospital one's password", diff(reveal=[("his", "Bed4-Vent!26")]),
    ref=[act("reveal", kind="locker item", name="Hospital HIS login", args=lines(field="password"))]),
  T("star the passport entry too", diff(upd("passport_item", starred=True)),
    ref=[act("star", kind="locker item", name="Passport")]))
