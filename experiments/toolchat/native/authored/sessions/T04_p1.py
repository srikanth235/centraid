from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T04-001-P", "events tomorrow reschedule edit para",
  T("what've i got lined up tomorrow", rows("rota_meet", "dark_1015"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("rota thing should be at half 1 instead", diff(upd("rota_meet", date="2026-10-15T13:30")),
    ref=[act("reschedule", rows="$rota_meet", args=lines(to=U("day", 1, time="13:30")))]))

S("T04-005-P", "car loan tasks order limit complete para",
  T("which car loan payments haven't i done", rows("loan_10"),
    ref=[ans(kind="task", name="Car loan payment", where='status = "open"')]),
  T("october's one went through early, mark it complete", diff(upd("loan_10", status="completed", completed=ANY)),
    ref=[act("complete", rows="$loan_10")]),
  T("the asos return is in the trash, bring it back", diff(restore("return_parcel")),
    ref=[find(kind="task", trashed=True), act("restore", rows="$return_parcel")]),
  T("sunday lunch should be at 2", ask("lunch_1018", "lunch_1115", "lunch_nasreen"),
    ref=[act("reschedule", kind="event", name="Sunday lunch", when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         find(kind="event", name="Sunday lunch", when=W({"from": U("day", 0)})),
         askc("this sunday at mum and dad's, 15 nov, or the one with auntie nasreen?",
              options="$lunch_1018, $lunch_1115, $lunch_nasreen")]))

S("T04-013-P", "decline out_of_scope search flight edit para",
  T("how's istanbul's weather looking in november", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok, flight times?", rows("flight_out", "flight_back"),
    ref=[search("flight", kind="event"), ans(rows="$flight_out, $flight_back")]))

S("T04-018-P", "wifi bare read reveal star para",
  T("pw for the house wifi", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("read out the house wifi to me", diff(reveal=[("wifi", "headingley-hotpot-9")]),
    ref=[act("reveal", rows="$wifi", args=lines(field="password"))]))

S("T04-023-P", "count since month para",
  T("amu night shifts i've worked since september, count them", val(6),
    ref=[ans(op="count", kind="event", name="Night shift AMU",
             when=W({"from": U("month", 0, name=9), "to": U("day", 0)}))]),
  T("bring back the gym induction, since craig's back on", diff(restore("gym")),
    ref=[act("restore", kind="event", name="Gym induction", trashed=True)]),
  T("count long days between the first and end of the month", val(7),
    ref=[ans(op="count", kind="event", name="Long day AMU", when=W({"from": D("2026-10-01"), "to": U("month", 0)}))]),
  T("same count for today until the end of november", val(6),
    ref=[ans(op="count", kind="event", name="Long day AMU", when=W({"from": U("day", 0), "to": U("month", 0, name=11)}))]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T04-028-P", "group ambiguous find delete multi linked_to all para",
  T("we're on splitwise, so the house group is redundant: wipe it", ask("house", "house_party"),
    ref=[find(kind="group", name="House"),
         act("delete", kind="group", within="@prev"),
         askc("house bills or house party?", options="$house, $house_party")]),
  T("the house party one, plus secret santa",
    diff(gone("house_party"), gone("santa"),
         unlink("house_party", "chloe"), unlink("house_party", "tom"), unlink("house_party", "leah"),
         unlink("house_party", "ravi"), unlink("house_party", "me"),
         unlink("santa", "chloe"), unlink("santa", "tom"), unlink("santa", "leah"), unlink("santa", "me")),
    ref=[act("delete", rows="$house_party, $santa")]),
  T("groups containing chloe and tom both", rows("house"),
    ref=[ans(kind="group", linked_to="$chloe, $tom")]))

S("T04-034-P", "folders document count delete prev undo create add_to para",
  T("folders holding more than three documents", rows("wed_f", "work_f"),
    ref=[ans(kind="folder", where="document count > 3")]),
  T("empty ones?", rows("scans_f", "receipts_f"),
    ref=[ans(kind="folder", where="document count = 0")]),
  T("wipe them", diff(gone("scans_f"), gone("receipts_f")),
    ref=[act("delete", rows="@prev")]),
  T("undo that", diff(),
    ref=[act("undo")]),
  T("ok, new folder Payslips, and payslip september goes inside",
    diff(new("folder", name="Payslips"), link("new", "payslip")),
    ref=[act("create", more=True, args=lines(kind="folder", name="Payslips")),
         act("add_to", kind="document", name="Payslip September", args=lines(to="$new"))]),
  T("payslips contents now?", rows("payslip"),
    ref=[ans(kind="document", linked_to="$c1")]))

S("T04-038-P", "photo count star where album edit multi para",
  T("people appearing in four or more photos", rows("zainab"),
    ref=[ans(kind="person", where="photo count >= 4")]),
  T("the photo with no album and nobody tagged gets a star", diff(upd("car_pic", starred=True)),
    ref=[act("star", kind="photo", where="album count = 0 and person count = 0 and starred = no")]),
  T("both the wedding prep and istanbul hen do albums should be called Zainab 2026",
    diff(upd("wed_album", name="Zainab 2026"), upd("ist_album", name="Zainab 2026")),
    ref=[act("edit", rows="$wed_album, $ist_album", args=lines(name="Zainab 2026"))]))

S("T04-043-P", "locker empty result not_found create star unstar new para",
  T("disney plus login details?", decline("not_found"),
    ref=[ans(kind="locker item", name="Disney plus"), dec("not_found")]),
  T("all locker items of type login", rows("nhsmail", "horus"),
    ref=[ans(kind="locker item", where='type = "login"')]),
  T("new login entry for disney plus, username aisha.r92@gmail.com",
    diff(new("locker item", name="Disney plus", type="login")),
    ref=[act("create", args=lines(kind="locker item", name="Disney plus", type="login", username="aisha.r92@gmail.com"))]),
  T("give it a star", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$new")]),
  T("i barely watch it, so the disney one loses its star", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]))

S("T04-048-P", "notebook notes create delete restore new para",
  T("food bank notebook contents?", rows("fb_rules", "fb_hampers"),
    ref=[ans(kind="note", linked_to="$fb_nb")]),
  T("a new note in that notebook: ask pete about borrowing the church van for hampers",
    diff(new("note", name=has("van"), body=has("Pete")), link("fb_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Church van", body="ask Pete about borrowing the church van for hampers",
                                  notebook="$fb_nb"))]),
  T("pete said no, so wipe that note", diff(trash("+1")),
    ref=[act("delete", rows="$new")]),
  T("ugh, pete's changed his mind, so bring it back", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T04-055-P", "trashed photos album count para",
  T("photos in the trash?", rows("screenshot", "blurry"),
    ref=[ans(kind="photo", trashed=True)]),
  T("restore the blurry darkroom shot", diff(restore("blurry")),
    ref=[act("restore", rows="$blurry")]),
  T("photos that aren't in any album yet", rows("house_dinner", "ward_cake", "sunrise", "leah_selfie", "car_pic", "blurry"),
    ref=[ans(kind="photo", where="album count = 0")]))

S("T04-061-P", "write then read subtasks reopen para",
  T("childhood photos are found, so what remains on the speech",
    rows("speech_practise", also=diff(upd("speech_photos", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Dig out childhood photos for speech", more=True),
         ans(kind="task", linked_to="$speech", where='status = "open"')]),
  T("the first draft task needs reopening, zainab vetoed half", diff(upd("speech_draft", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="First draft of speech")]))

S("T04-070-P", "event create span note read repair add_to para",
  T("darkroom session on sat twenty-fourth, 7 till 10, put it in",
    diff(new("event", name=has("darkroom"), date="2026-10-24T19:00", duration=180)),
    ref=[act("create", args=lines(kind="event", name="Darkroom session",
                                  date={"from": D("2026-10-24", "19:00"), "to": D("2026-10-24", "22:00")}))]),
  T("test strip pic belongs in whitby", diff(link("whitby_album", "test_strip")),
    ref=[bad(act("add_to", kind="photo", name="Test strip", args=lines(album="$whitby_album"))),
         act("add_to", kind="photo", name="Test strip", args=lines(to="$whitby_album"))]),
  T("people i know from the photo co-op", rows("owen"),
    ref=[ans(kind="person", where='met contains "Photo Co-op"')]),
  T("als course should happen in december instead", ask("als_1", "als_2"),
    ref=[act("reschedule", kind="event", name="ALS course", args=lines(to=U("month", 1))),
         askc("day 1 or day 2? or both?", options="$als_1, $als_2")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T04-078-P", "find trashed task restore prev reschedule para",
  T("return the asos parcel: did i delete it", rows("return_parcel"),
    ref=[find(kind="task", name="Return the ASOS parcel", trashed=True), ans(rows="@prev")]),
  T("bring it back", diff(restore("return_parcel")),
    ref=[act("restore", rows="@prev")]),
  T("make the asos parcel return due this saturday", diff(upd("return_parcel", date="2026-10-17")),
    ref=[act("reschedule", rows="$return_parcel", args=lines(to=U("week", 0, weekday=6)))]))

S("T04-084-P", "person time point named month span group count edit prev para",
  T("last night at half 9, who was i messaging", rows("zainab"),
    ref=[ans(kind="person", when=W(U("day", -1, time="21:30")))]),
  T("talked to from september up to the fifth of october, who",
    rows("dad", "imran", "fatima_k", "sana", "hughes", "leah", "owen"),
    ref=[ans(kind="person", when=W({"from": U("month", 0, name=9), "to": D("2026-10-05")}))]),
  T("those not belonging to any group", rows("dad", "fatima_k", "hughes"),
    ref=[ans(kind="person", within="@prev", where="group count < 1")]),
  T("set a three week catch up for all three of them", diff(upd("dad", cadence=21), upd("fatima_k", cadence=21), upd("hughes", cadence=21)),
    ref=[act("edit", rows="@prev", args=lines(cadence=21))]))

S("T04-088-P", "events count date time span description in edit where para",
  T("count of events between 7pm tomorrow and the end of next week", val(14),
    ref=[ans(op="count", kind="event", when=W({"from": U("day", 1, time="19:00"), "to": U("week", 1)}))]),
  T("bundobust or jet2 ls893 anywhere?", rows("leah_dinner", "flight_out"),
    ref=[ans(kind="event", where='description in ("Bundobust", "Jet2 LS893")')]),
  T("seat 14C goes on the jet2 one", diff(upd("flight_out", description="Jet2 LS893, seat 14C")),
    ref=[act("edit", kind="event", where='description contains "Jet2"', args=lines(description="Jet2 LS893, seat 14C"))]))

S("T04-098-P", "locker membership delete trashed restore multi empty result reveal para",
  T("membership entries in the locker?", rows("puregym", "bma"),
    ref=[ans(kind="locker item", where='type = "membership"')]),
  T("puregym finally cancelled, wipe that entry", diff(trash("puregym")),
    ref=[act("delete", rows="$puregym")]),
  T("locker trash contents?", rows("santander", "netflix", "puregym"),
    ref=[ans(kind="locker item", trashed=True)]),
  T("bring back the old santander login and the old netflix login but not the gym", diff(restore("santander"), restore("netflix")),
    ref=[act("restore", rows="$santander, $netflix")]),
  T("mum's wifi password?", rows("wifi"),
    ref=[ans(kind="locker item", name="Mum's wifi"), ans(kind="locker item", where='type = "wifi"')]),
  T("read out house wifi", diff(reveal=[("wifi", "headingley-hotpot-9")]),
    ref=[act("reveal", rows="$wifi", args=lines(field="password"))]))

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T04-A003-P", "ask-options photo star c3a para",
  T("the print gets a star", ask("print_abbey", "print_pier"),
    ref=[act("star", kind="photo", name="print"),
         askc("The 8x10 Abbey print or the pier print, split grade?", options="$print_abbey, $print_pier")]),
  T("the pier one", diff(upd("print_pier", starred=True)),
    ref=[act("star", rows="$print_pier")]),
  T("honour one is complete as well, tick it", diff(upd("speech", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="honour")]))

S("T04-A008-P", "follow-up c3a para",
  T("next week's agenda", rows("yoga_1024", "aoife_coffee", "wcall_1022", "cake", "fb_1024", "grand_round", "night_1020", "night_1019", "car_service", "lunch_nasreen"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("keep just the post-thursday ones", rows("aoife_coffee", "lunch_nasreen", "yoga_1024", "cake", "fb_1024"),
    ref=[ans(within="@prev", when=J({"from": U("week", 1, weekday=5)}))]),
  T("without the first pair", rows("lunch_nasreen", "yoga_1024", "cake"),
    ref=[ans(within="@prev", exclude="$aoife_coffee, $fb_1024")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

OPEN = 'status = "open"'

OWED = 'direction = "owes_me" and status = "open"'

S("T04-B003-P", "c3b superlative task effort latest due count para",
  T("which open task needs the most effort", rows("als_prep"),
    ref=[ans(kind="task", where=OPEN, order="effort desc", limit=1)]),
  T("open task with the latest due date", rows("gmc_fee"),
    ref=[ans(kind="task", where=OPEN, order="date desc", limit=1)]),
  T("total open tasks", val(32),
    ref=[ans(op="count", kind="task", where=OPEN)]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

NOW = W({"from": U("day", 0)})

WEEKEND = W(span(U("week", 0, weekday=6), U("week", 0, weekday=7)))

NEXT_WEEKEND = W(span(U("week", 1, weekday=6), U("week", 1, weekday=7)))

S("T04-103-P", "ask options star certificate documents unstar para",
  T("certificate gets a star", ask("ins_cert", "mot", "als_cert"),
    ref=[act("star", kind="document", name="certificate"),
         askc("car insurance, the mot or your ils certificate?", options="$ins_cert, $mot, $als_cert")]),
  T("the mot one", diff(upd("mot", starred=True)),
    ref=[act("star", rows="$mot")]),
  T("deposit's paid, so oakwood hall contract loses its star", diff(upd("venue_contract", starred=False)),
    ref=[act("unstar", kind="document", name="Oakwood Hall contract")]))

S("T04-107-P", "balance negative james owen abbu nickname search para",
  T("is there anything i owe james", val((-15.5, "GBP")),
    ref=[ans(op="balance", rows="$james")]),
  T("what about owen", val((-9, "GBP")),
    ref=[ans(op="balance", rows="$owen")]),
  T("and abbu, how do i stand there", val((-500, "GBP")),
    ref=[search("abbu"), ans(op="balance", rows="$dad")]))

S("T04-112-P", "ask options reveal card number then cvv para",
  T("tell me my card number", ask("monzo", "amex"),
    ref=[act("reveal", kind="locker item", name="card", args=lines(field="card_number")),
         askc("the monzo debit card or the amex?", options="$monzo, $amex")]),
  T("amex", diff(reveal=[("amex", "3714 496353 98431")]),
    ref=[act("reveal", rows="$amex", args=lines(field="card_number"))]),
  T("cvv?", diff(reveal=[("amex", "7781")]),
    ref=[act("reveal", rows="$amex", args=lines(field="cvv"))]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

NOW = W({"from": U("day", 0)})

S("T04-118-P", "decline oos email fabricated pin then log para",
  T("write to dr hughes by email asking whether the arcp can move", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("guess my nhs smartcard pin if it isn't stored, what is it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("i emailed mark hughes myself, note it as a message", diff(upd("hughes", date=ANY)),
    ref=[act("log", kind="person", name="Mark Hughes", args=lines(kind="message"))]),
  T("ammi rang while i was in the shower, count that as a call too", diff(upd("mum", date=ANY)),
    ref=[act("log", kind="person", name="Ammi", args=lines(kind="call")), search("ammi"),
         act("log", rows="$mum", args=lines(kind="call"))]))

S("T04-122-P", "balance positive hamza imran leah compute para",
  T("hamza's debt to me?", val((575, "GBP")),
    ref=[ans(op="balance", rows="$hamza")]),
  T("imran?", val((275, "GBP")),
    ref=[ans(op="balance", rows="$imran")]),
  T("leah's balance with me", val((32, "GBP")),
    ref=[comp(op="balance", rows="$leah"), ans(value="@prev")]),
  T("leah always pays me back, so she gets a star", diff(upd("leah", starred=True)),
    ref=[act("star", kind="person", name="Leah")]))
