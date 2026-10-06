from gold import *
import json

world("T20", "2026-05-28T16:10", "Matteo Ricci", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T20-101", "star ask options payslip documents then two writes",
  T("star the payslip", ask("payslip_apr", "payslip_mar"),
    ref=[act("star", kind="document", name="payslip"),
         askc("april's or march's?", options="$payslip_apr, $payslip_mar")]),
  T("april", diff(upd("payslip_apr", starred=True)),
    ref=[act("star", rows="$payslip_apr")]),
  T("and the wset certificate, plus unstar the employment contract, that one's old", diff(upd("wset", starred=True), upd("contract_work", starred=False)),
    ref=[act("star", kind="document", name="WSET 3 certificate", more=True),
         act("unstar", kind="document", name="Employment contract")]))

S("T20-102", "star ask options intesa locker then contrast strava",
  T("star the intesa one", diff(upd("intesa", starred=True)),
    ref=[act("star", kind="locker item", name="Intesa")]),
  T("and my strava login", diff(upd("strava", starred=True)),
    ref=[act("star", kind="locker item", name="Strava")]))

S("T20-103", "ask options remove marco then never mind",
  T("take marco out of the club group", ask("marco_e", "marco_l"),
    ref=[act("remove_from", kind="person", name="Marco", args=lines(from_="$club")),
         askc("marco esposito the captain or marco lombardi the mechanic?", options="$marco_e, $marco_l")]),
  T("actually never mind, they both stay", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T20-104", "ask options lorenzo add_to long",
  T("add lorenzo to casa nuova, he's helping with the van on the twentieth and paying his share", ask("lorenzo_r", "lorenzo_g"),
    ref=[act("add_to", kind="person", name="Lorenzo", args=lines(to="$casa")),
         askc("lorenzo ricci your cousin or lorenzo gallo the head chef?", options="$lorenzo_r, $lorenzo_g")]),
  T("the cousin", diff(link("casa", "lorenzo_r")),
    ref=[act("add_to", rows="$lorenzo_r", args=lines(to="$casa"))]))

S("T20-105", "ask options dentist description then star dentist role",
  T("put 'bring the x-rays' in the dentist description", ask("dentist_may", "dentist_jun"),
    ref=[act("edit", kind="event", name="Dentist", args=lines(description="bring the x-rays")),
         find(kind="event", name="Dentist"),
         askc("the one on 12 may or the june appointment?", options="$dentist_may, $dentist_jun")]),
  T("june obviously", diff(upd("dentist_jun", description="bring the x-rays")),
    ref=[act("edit", rows="$dentist_jun", args=lines(description="bring the x-rays"))]),
  T("and star the dentist herself, she fits me in a lot", diff(upd("valentina", starred=True)),
    ref=[act("star", kind="person", where='role contains "dentist"')]))

S("T20-106", "ask options francesca tasting cancel then reschedule menu tasting date",
  T("cancel the tasting with francesca", ask("tasting_fra_1", "tasting_fra_2"),
    ref=[act("cancel", kind="event", name="tasting Francesca"),
         askc("the barolo one on 6 may or the barbaresco one on 10 june?", options="$tasting_fra_1, $tasting_fra_2")]),
  T("barbaresco", diff(upd("tasting_fra_2", status="cancelled")),
    ref=[act("cancel", rows="$tasting_fra_2")]),
  T("and move the wedding menu tasting to next friday at 5", diff(upd("menu_tasting", date="2026-06-05T17:00")),
    ref=[act("reschedule", kind="event", name="Wedding menu tasting", args=lines(to=U("week", 1, weekday=5, time="17:00")))]))

S("T20-107", "ask options chianti order reschedule bare weekday then glasses",
  T("push the chianti order to monday", ask("chianti_1", "chianti_2"),
    ref=[act("reschedule", kind="task", name="Order Chianti Classico", args=lines(to=U("week", 1, weekday=1))),
         find(kind="task", name="Order Chianti Classico"),
         askc("the one due tomorrow or the april one you already did?", options="$chianti_1, $chianti_2")]),
  T("the open one", diff(upd("chianti_1", date="2026-06-01")),
    ref=[act("reschedule", rows="$chianti_1", args=lines(to=U("week", 1, weekday=1)))]),
  T("and the zalto glasses to next thursday", diff(upd("glasses", date="2026-06-04")),
    ref=[act("reschedule", kind="task", name="Order Zalto glasses", args=lines(to=U("week", 1, weekday=4)))]))

S("T20-108", "ask options pack complete then count with bad status",
  T("tick off pack, the boxes are all in", ask("pack", "pack_wine"),
    ref=[act("complete", kind="task", name="Pack"),
         askc("the kitchen or the wine collection?", options="$pack, $pack_wine")]),
  T("the kitchen", diff(upd("pack", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pack")]),
  T("how many are still open on the move list", val(6),
    ref=[bad(ans(op="count", kind="task", linked_to="$move_l", where='status = "todo"')),
         ans(op="count", kind="task", linked_to="$move_l", where='status = "open"')]))

S("T20-109", "ask options marco cadence never mind then ale",
  T("set marco to every ten days", ask("marco_e", "marco_l"),
    ref=[act("edit", kind="person", name="Marco", args=lines(cadence="10")),
         askc("marco esposito or marco lombardi?", options="$marco_e, $marco_l")]),
  T("don't bother, i'll do it later", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("just ale every two weeks then", diff(upd("ale", cadence=14)),
    ref=[act("edit", kind="person", name="Alessio Fontana", args=lines(cadence="14"))]))

S("T20-110", "ask options call reschedule to 6 then ettore earlier",
  T("move the call to 6", ask("photographer_call", "supplier_call"),
    ref=[act("reschedule", kind="event", name="Call", args=lines(to=U("day", 0, anchor="row", time="18:00"))),
         askc("the call with ettore tomorrow or the one with the montalcino supplier today?", options="$photographer_call, $supplier_call")]),
  T("the supplier one", diff(upd("supplier_call", date="2026-05-28T18:00")),
    ref=[act("reschedule", rows="$supplier_call", args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("and shift ettore's call half an hour earlier", diff(upd("photographer_call", date="2026-05-29T11:30")),
    ref=[act("reschedule", kind="event", name="Call with Ettore", args=lines(to=U("minute", -30, anchor="row")))]))

S("T20-111", "ask options lunch reschedule to 1",
  T("move the lunch to 1", ask("sunday_lunch", "nonna_bday"),
    ref=[act("reschedule", kind="event", name="lunch", args=lines(to=U("day", 0, anchor="row", time="13:00"))),
         askc("lunch at mamma's on the 24th or nonna's 90th birthday lunch on 6 june?", options="$sunday_lunch, $nonna_bday")]),
  T("nonna's, the restaurant called", diff(upd("nonna_bday", date="2026-06-06T13:00")),
    ref=[act("reschedule", rows="$nonna_bday", args=lines(to=U("day", 0, anchor="row", time="13:00")))]),
  T("and log a call with nonna, she's thrilled", diff(upd("nonna", date=ANY)),
    ref=[search("nonna", kind="person"), act("log", rows="$nonna", args=lines(kind="call"))]))

S("T20-112", "ask options note add_to tasting notes then pin",
  T("put the montalcino supplier note in tasting notes", ask("tasting_nb", "tasting25_nb"),
    ref=[find(kind="notebook", name="Tasting notes"),
         askc("tasting notes or tasting notes 2025?", options="$tasting_nb, $tasting25_nb")]),
  T("the one without a year", diff(link("tasting_nb", "supplier_n")),
    ref=[act("add_to", kind="note", name="Montalcino supplier", args=lines(to="$tasting_nb"))]),
  T("and pin it", diff(upd("supplier_n", pinned=True)),
    ref=[act("edit", kind="note", name="Montalcino supplier", args=lines(pinned="yes"))]))

S("T20-114", "balance negative andrea fede chiara positive giulia",
  T("what do i owe andrea", val((-240, "EUR")),
    ref=[ans(op="balance", rows="$andrea")]),
  T("and fede", val((-288, "EUR")),
    ref=[search("fede", kind="person"), ans(op="balance", rows="$federico")]),
  T("chiara?", val((-45, "EUR")),
    ref=[ans(op="balance", rows="$chiara")]),
  T("and giulia owes me what, all in", val((1365, "EUR")),
    ref=[ans(op="balance", rows="$giulia")]))

S("T20-115", "balance positive luca stefano davide then star",
  T("what does luca owe me", val((85, "EUR")),
    ref=[ans(op="balance", rows="$luca")]),
  T("stefano", val((100, "EUR")),
    ref=[ans(op="balance", rows="$stefano")]),
  T("and davide", val((100, "EUR")),
    ref=[ans(op="balance", rows="$davide")]),
  T("star davide, he keeps covering weekends", diff(upd("davide", starred=True)),
    ref=[act("star", rows="$davide")]),
  T("bring back pietro neri, he's coming to the wedding", diff(restore("pietro")),
    ref=[act("restore", kind="person", name="Pietro Neri", trashed=True)]))
