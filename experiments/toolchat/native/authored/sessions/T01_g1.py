from gold import *

world("T01", "2026-03-12T18:20", "Oluwaseun Adebayo-Clarke", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T01-101", "ask-options person log contrast",
  T("rang priya on my break", ask("priya_n", "priya_s"),
    ref=[act("log", kind="person", name="Priya", args="kind: call"),
         askc("Priya Nair or Priya Shah?", options="$priya_n, $priya_s")]),
  T("nair, about the rota", diff(upd("priya_n", date=ANY)),
    ref=[act("log", rows="$priya_n", args="kind: call")]),
  T("and gemma rang me back after", diff(upd("gemma", date=ANY)),
    ref=[act("log", kind="person", name="Gemma", args="kind: call")]),
  T("star priya nair too, she's covered so many of my shifts", diff(upd("priya_n", starred=True)),
    ref=[act("star", rows="$priya_n")]))

S("T01-102", "ask-options person star nickname contrast",
  T("star jess", ask("jess_w", "jess_o"),
    ref=[act("star", kind="person", name="Jess"),
         askc("Jess Whitfield or Jess Okoro?", options="$jess_w, $jess_o")]),
  T("okoro, chi's cousin", diff(upd("jess_o", starred=True)),
    ref=[act("star", rows="$jess_o")]),
  T("favourite gaz as well, he's been good", diff(upd("gary", starred=True)),
    ref=[search("Gaz", kind="person"), act("star", rows="$gary")]))

S("T01-103", "ask-options event reschedule at-n contrast",
  T("move tobi's training to 6", ask("training_0318", "training_0325"),
    ref=[act("reschedule", kind="event", name="Tobi football training", args=lines(to=U("day", 0, anchor="row", time="18:00"))),
         find(kind="event", name="Tobi football training", when=J({"from": U("day", 0)})),
         askc("The 18th or the 25th?", options="@prev")]),
  T("the 25th", diff(upd("training_0325", date="2026-03-25T18:00")),
    ref=[act("reschedule", rows="$training_0325", args=lines(to=D("2026-03-25", "18:00")))]),
  T("and cal's five a side on the 24th, push it to 9", diff(upd("fiveaside_0324", date="2026-03-24T21:00")),
    ref=[act("reschedule", kind="event", name="Callum 5-a-side", when=J(D("2026-03-24")),
             args=lines(to=U("day", 0, anchor="row", time="21:00")))]),
  T("and star dean, the coach", diff(upd("dean", starred=True)),
    ref=[act("star", kind="person", name="Dean")]))

S("T01-104", "ask-options event cancel never-mind count",
  T("cancel cal's 5-a-side, his knee's bad", ask("fiveaside_0317", "fiveaside_0324"),
    ref=[act("cancel", kind="event", name="Callum 5-a-side"),
         find(kind="event", name="Callum 5-a-side", when=J({"from": U("day", 0)})),
         askc("Tuesday 17th or Tuesday 24th?", options="@prev")]),
  T("forget it, he says he'll play through it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how many long days have i got left this month", val(3),
    ref=[ans(op="count", kind="event", name="Long day", when=J(span(U("day", 0), U("month", 0))))]),
  T("push the sixteenth one to tuesday", diff(upd("ld_0316", date="2026-03-17T07:30")),
    ref=[act("reschedule", kind="event", name="Long day", when=J(D("2026-03-16")),
             args=lines(to=U("week", 1, weekday=2)))]))

S("T01-105", "ask-options event reschedule hour at-n contrast",
  T("push the hen do back an hour", ask("hen_class", "hen_dinner"),
    ref=[act("reschedule", kind="event", name="Hen do", args=lines(to=U("hour", 1, anchor="row"))),
         askc("The cocktail class or the dinner?", options="$hen_class, $hen_dinner")]),
  T("dinner", diff(upd("hen_dinner", date="2026-04-25T20:30")),
    ref=[act("reschedule", rows="$hen_dinner", args=lines(to=U("hour", 1, anchor="row")))]),
  T("and the flight home to 7", diff(upd("flight_home", date="2026-04-11T19:00")),
    ref=[act("reschedule", kind="event", name="Flight home", args=lines(to=U("day", 0, anchor="row", time="19:00")))]))

S("T01-106", "ask-options event cancel reschedule long-message",
  T("cancel parents evening", ask("pe_tobi", "pe_ada"),
    ref=[act("cancel", kind="event", name="Parents evening"),
         askc("Tobi's or Ada's?", options="$pe_tobi, $pe_ada")]),
  T("ada's", diff(upd("pe_ada", status="cancelled")),
    ref=[act("cancel", rows="$pe_ada")]),
  T("mrs kaur asked if tobi's can be at half 5 instead, sort that", diff(upd("pe_tobi", date="2026-03-17T17:30")),
    ref=[act("reschedule", rows="$pe_tobi", args=lines(to=U("day", 0, anchor="row", time="17:30")))]),
  T("oh and ada's eye test is booked, tick it", diff(upd("eye_test", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Book Ada's eye test")]))

S("T01-107", "ask-options task complete reschedule next-weekday",
  T("tick off the e-learning", ask("fire_safety", "infection"),
    ref=[act("complete", kind="task", name="e-learning"),
         askc("Fire safety or infection control?", options="$fire_safety, $infection")]),
  T("infection control, did it on shift", diff(upd("infection", status="completed", completed=ANY)),
    ref=[act("complete", rows="$infection")]),
  T("push the fire safety one to next friday", diff(upd("fire_safety", date="2026-03-20")),
    ref=[act("reschedule", kind="task", name="Fire safety", args=lines(to=U("week", 1, weekday=5)))]),
  T("actually i just did it, tick it off", diff(upd("fire_safety", status="completed", completed=ANY)),
    ref=[act("complete", rows="$fire_safety")]))

S("T01-108", "ask-options task complete reopen",
  T("tick off return, handed it back today", ask("charger", "reading_book"),
    ref=[act("complete", kind="task", name="Return"),
         askc("Priya's charger or Ada's reading book?", options="$charger, $reading_book")]),
  T("the charger", diff(upd("charger", status="completed", completed=ANY)),
    ref=[act("complete", rows="$charger")]),
  T("reopen arrange electrician, the first fix got pushed", diff(upd("electrician", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Arrange electrician")]))

S("T01-109", "ask-options document star unstar",
  T("star the autumn report", ask("tobi_report", "ada_report"),
    ref=[act("star", kind="document", name="autumn report"),
         askc("Tobi's or Ada's?", options="$tobi_report, $ada_report")]),
  T("ada's", diff(upd("ada_report", starred=True)),
    ref=[act("star", rows="$ada_report")]),
  T("unstar the lisbon flight booking, all checked in", diff(upd("flight_booking", starred=False)),
    ref=[act("unstar", kind="document", name="Lisbon flight booking")]),
  T("and the nmc registration one", diff(already=["nmc_cert"]),
    ref=[act("star", kind="document", name="NMC registration confirmation"), ans(rows="$nmc_cert")]))

S("T01-110", "ask-options document star contrast",
  T("star the insurance one", ask("home_ins", "car_renewal"),
    ref=[act("star", kind="document", name="insurance"),
         askc("Home insurance 2026 or the car insurance renewal notice?", options="$home_ins, $car_renewal")]),
  T("car", diff(upd("car_renewal", starred=True)),
    ref=[act("star", rows="$car_renewal")]),
  T("and the p60", diff(upd("p60", starred=True)),
    ref=[act("star", kind="document", name="P60")]))

S("T01-111", "ask-options locker star already-so unstar",
  T("star the wifi", ask("home_wifi", "mum_wifi"),
    ref=[act("star", kind="locker item", name="wifi"),
         askc("Home wifi or Mum's wifi?", options="$home_wifi, $mum_wifi")]),
  T("mum's", diff(upd("mum_wifi", starred=True)),
    ref=[act("star", rows="$mum_wifi")]))

S("T01-112", "wifi bare read reveal verb-like star",
  T("wifi pw", rows("home_wifi", "mum_wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("mum's, i'm round there. show me the wifi password", diff(reveal=[("mum_wifi", "Folake1958")]),
    ref=[act("reveal", rows="$mum_wifi", args="field: password")]))

S("T01-113", "ask-options task complete reschedule weekday at-n",
  T("tick off order, it's arrived", ask("tiles", "adhesive", "tesco"),
    ref=[act("complete", kind="task", name="Order"),
         askc("Order tiles, tile adhesive and grout, or Tesco delivery?", options="$tiles, $adhesive, $tesco")]),
  T("the tiles", diff(upd("tiles", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tiles")]),
  T("and move tesco delivery to friday at 7", diff(upd("tesco", date="2026-03-13T19:00")),
    ref=[act("reschedule", kind="task", name="Order Tesco delivery", args=lines(to=U("week", 0, weekday=5, time="19:00")))]),
  T("book skip's done as well", diff(upd("skip", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Book skip")]))

S("T01-114", "ask-options photo star unstar",
  T("star the old kitchen photo", ask("p_sink", "p_cupboards", "p_floor"),
    ref=[act("star", kind="photo", name="Old kitchen"),
         askc("Sink wall, cupboards or floor?", options="$p_sink, $p_cupboards, $p_floor")]),
  T("sink wall", diff(upd("p_sink", starred=True)),
    ref=[act("star", rows="$p_sink")]))

S("T01-115", "ask-options event cancel never-mind weekend",
  T("cancel the flight", ask("flight_out", "flight_home"),
    ref=[act("cancel", kind="event", name="Flight"),
         askc("Flight to Lisbon on the 4th or the flight home on the 11th?", options="$flight_out, $flight_home")]),
  T("scratch that, we're still going", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's on this weekend", rows("swim_0314", "worktop_visit", "match_0315", "mothering"),
    ref=[ans(kind="event", when=J(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]))
