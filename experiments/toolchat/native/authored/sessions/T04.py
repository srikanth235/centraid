from gold import *
import json

world("T04", "2026-10-14T19:40", "Aisha Rahman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T04-001", "events tomorrow reschedule edit",
  T("what's on tmrw", rows("rota_meet", "dark_1015"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("push the rota one to half 1", diff(upd("rota_meet", date="2026-10-15T13:30")),
    ref=[act("reschedule", rows="$rota_meet", args=lines(to=U("day", 1, time="13:30")))]))

S("T04-002", "balance person ambiguity fatima",
  T("how much do i owe fatima", ask("fatima_k", "fatima_h"),
    ref=[bad(ans(op="balance", kind="person", name="Fatima")),
         askc("fatima khan or fatima hussain?", options="$fatima_k, $fatima_h")]),
  T("hussain, the bridesmaid one", val((-85, "GBP"), (3300, "TRY")),
    ref=[ans(op="balance", rows="$fatima_h")]),
  T("paid her for the decorations yday", diff(upd("d_fatima_h", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Hen do decorations")]),
  T("who've i got saved as abbu", rows("dad"),
    ref=[ans(kind="person", where='nickname = "Abbu"')]))

S("T04-003", "group members group balance",
  T("who's in the hen do group", rows("zainab", "fatima_h", "sana", "aoife", "me"),
    ref=[ans(kind="person", linked_to="$hen")]),
  T("where am i at in it", val((16200, "TRY")),
    ref=[ans(op="balance", kind="group", name="Istanbul hen do", linked_to="$me")]),
  T("settle up with sana in there", diff(settle=[("Sana Akhtar", "3300")]),
    ref=[act("settle_up", rows="$sana", args=lines(group="$hen"))]),
  T("move the flight to the afternoon", ask("flight_out", "flight_back"),
    ref=[act("reschedule", kind="event", name="Flight", args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         askc("the flight out on the 20th or the one home on the 23rd?", options="$flight_out, $flight_back")]))

S("T04-004", "repair date reschedule linked people",
  T("move the car service to next thurs at 8", diff(upd("car_service", date="2026-10-22T08:00")),
    ref=[bad(act("reschedule", kind="event", name="Car service at Barker Motors",
                 args=lines(to=U("week", 1, time="08:00")))),
         act("reschedule", kind="event", name="Car service at Barker Motors",
             args=lines(to=U("week", 1, weekday=4, time="08:00")))]),
  T("who's that with again", rows("kev"),
    ref=[ans(kind="person", linked_to="$car_service")]),
  T("anything next week that runs over ten hrs", rows("night_1019", "night_1020"),
    ref=[ans(kind="event", when=W(U("week", 1)), where="duration > 600")]),
  T("how many nights from next monday through november", val(5),
    ref=[ans(op="count", kind="event", name="Night shift AMU",
             when=W({"from": U("week", 1, weekday=1), "to": U("month", 0, name=11)}))]))

S("T04-005", "car loan tasks order limit complete",
  T("car loan payments to do", rows("loan_10"),
    ref=[ans(kind="task", name="Car loan payment", where='status = "open"')]),
  T("paid octobers early, tick it", diff(upd("loan_10", status="completed", completed=ANY)),
    ref=[act("complete", rows="$loan_10")]),
  T("get the asos return back out of the trash", diff(restore("return_parcel")),
    ref=[find(kind="task", trashed=True), act("restore", rows="$return_parcel")]),
  T("push sunday lunch to 2", ask("lunch_1018", "lunch_1115", "lunch_nasreen"),
    ref=[act("reschedule", kind="event", name="Sunday lunch", when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         find(kind="event", name="Sunday lunch", when=W({"from": U("day", 0)})),
         askc("this sunday at mum and dad's, 15 nov, or the one with auntie nasreen?",
              options="$lunch_1018, $lunch_1115, $lunch_nasreen")]))

S("T04-006", "misspelled search log",
  T("when did i last see aoif", rows("aoife"),
    ref=[ans(kind="person", name="Aoife")]),
  T("log a coffee with her", diff(upd("aoife", date=ANY)),
    ref=[act("log", rows="$aoife", args=lines(kind="coffee"))]),
  T("who's on weekly catch ups", rows("mum", "zainab", "chloe"),
    ref=[ans(kind="person", where="cadence <= 7")]),
  T("and who've i got down as auntie something", rows("nasreen"),
    ref=[ans(kind="person", where='nickname contains "Auntie"')]))

S("T04-007", "decline sealed_egress reveal card",
  T("send my monzo card number to zainab for the florist", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("ok show it to me", diff(reveal=[("monzo", "5355 7700 1234 8841")]),
    ref=[act("reveal", kind="locker item", name="Monzo debit card", args=lines(field="card_number"))]))

S("T04-008", "note create notebook pin",
  T("new note in medicine: AKI - stop nephrotoxics, fluid balance chart, repeat U&E in 6h",
    diff(new("note", name=has("AKI"), body=has("nephrotoxics")), link("med_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="AKI", body="stop nephrotoxics, fluid balance chart, repeat U&E in 6h",
                                  notebook="$med_nb"))]))

S("T04-009", "cancelled food bank count from",
  T("did a food bank shift get cancelled", rows("fb_1003"),
    ref=[ans(kind="event", name="Food bank shift", where='status = "cancelled"')]),
  T("how many have i got left before xmas", val(6),
    ref=[ans(op="count", kind="event", name="Food bank shift",
             when=W({"from": U("day", 0), "to": D("2026-12-24")}), where='status != "cancelled"')]),
  T("any of the upcoming ones actually confirmed", rows(),
    ref=[ans(kind="event", name="Food bank shift", when=W({"from": U("day", 0)}), where='status = "confirmed"')]),
  T("what got cancelled since the first", rows("fb_1003", "yoga_1010", "pub_quiz"),
    ref=[ans(kind="event", when=W({"from": D("2026-10-01")}), where='status = "cancelled"')]))

S("T04-010", "ambiguity dress fitting runtime pick",
  T("move the dress fitting to 3", ask("fitting_1", "fitting_2"),
    ref=[act("reschedule", kind="event", name="Dress fitting with Zainab", args=lines(to=U("day", 0, anchor="row", time="15:00"))),
         find(kind="event", name="Dress fitting with Zainab"),
         askc("this saturday's fitting or the one on 14 nov?", options="$fitting_1, $fitting_2")]),
  T("this sat one", diff(upd("fitting_1", date="2026-10-17T15:00")),
    ref=[act("reschedule", rows="$fitting_1", args=lines(to=U("day", 0, anchor="row", time="15:00")))]))

S("T04-011", "decline unbounded then bounded bulk delete",
  T("clear out every task i have, starting over", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("fine. delete the car loan payment ones already paid",
    diff(*[trash(f"loan_{m:02d}") for m in range(1, 10)]),
    ref=[find(kind="task", name="Car loan payment", where='status = "completed"'),
         act("delete", rows="@prev")]),
  T("show me the pay rent tasks", rows("rent_oct", "rent_nov"),
    ref=[ans(kind="task", name="Pay rent")]))

S("T04-012", "document star already unstar",
  T("star the jet2 booking confirmation", diff(already=["flights_doc"]),
    ref=[act("star", kind="document", name="Jet2 booking confirmation"), ans(rows="$flights_doc")]))

S("T04-013", "decline out_of_scope search flight edit",
  T("what's the weather in istanbul in november", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok what time do we fly", rows("flight_out", "flight_back"),
    ref=[search("flight", kind="event"), ans(rows="$flight_out, $flight_back")]))

S("T04-014", "task create list reschedule",
  T("add get a travel adaptor to the istanbul list, due next fri",
    diff(new("task", name=has("adaptor"), date="2026-10-23"), link("istlist", "new")),
    ref=[act("create", args=lines(kind="task", name="Get a travel adaptor", date=U("week", 1, weekday=5),
                                  list="$istlist"))]),
  T("thirteenth nov is fine", diff(upd("+1", date="2026-11-13")),
    ref=[act("reschedule", rows="$new", args=lines(to=D("2026-11-13")))]))

S("T04-015", "tasks for person never_mind",
  T("what have i got to do for auntie nasreen", rows("call_nasreen"),
    ref=[search("auntie nasreen", kind="person"), ans(kind="task", linked_to="$nasreen")]),
  T("eh forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T04-016", "photos person star already add_to",
  T("pics with ravi patel in", rows("pier", "fish_chips", "print_pier"),
    ref=[ans(kind="photo", linked_to="$ravi")]),
  T("star the pier one", ask("pier", "print_pier"),
    ref=[act("star", kind="photo", name="pier"),
         askc("the photo on the pier or the darkroom print of it?", options="$pier, $print_pier")]))

S("T04-017", "debts owed to me order limit sum settle",
  T("who owes me money", rows("d_chloe", "d_zainab", "d_leah", "d_fatima_k", "d_aoife", "d_sana"),
    ref=[ans(kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("biggest?", val((142, "GBP")),
    ref=[ans(op="max", field="amount", within="@prev")]))

S("T04-018", "wifi bare read reveal star",
  T("house wifi pw", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("show me house wifi", diff(reveal=[("wifi", "headingley-hotpot-9")]),
    ref=[act("reveal", rows="$wifi", args=lines(field="password"))]))

S("T04-019", "person create add_to group balance",
  T("maryam iqbal is coming to istanbul too, add her to the group",
    diff(new("person", name="Maryam Iqbal"), link("hen", "new")),
    ref=[act("create", more=True, args=lines(kind="person", name="Maryam Iqbal")),
         act("add_to", rows="$new", args=lines(to="$hen"))]),
  T("what's her balance there", val((0, "TRY")),
    ref=[ans(op="balance", kind="group", name="Istanbul hen do", linked_to="$new")]))

S("T04-020", "folder create document add_to",
  T("make a folder called Mehndi", diff(new("folder", name="Mehndi")),
    ref=[act("create", args=lines(kind="folder", name="Mehndi"))]))

S("T04-021", "event create next day",
  T("when's coffee with aoife", rows("aoife_coffee"),
    ref=[ans(kind="event", name="Coffee with Aoife")]),
  T("book lunch w leah the day after, 1pm",
    diff(new("event", name=has("lunch", "leah"), date="2026-10-24T13:00")),
    ref=[bad(act("create", args=lines(kind="event", name="Lunch with Leah", date=U("day", 1, anchor="row", time="13:00")))),
         act("create", args=lines(kind="event", name="Lunch with Leah", date=D("2026-10-24", "13:00")))]))

S("T04-022", "repair where when status in",
  T("what needs doing before sunday",
    rows("boiler", "bins", "wul_1", "tins", "develop", "rota_swap", "call_nasreen", "fb_rota"),
    ref=[bad(ans(kind="task", where='due <= "2026-10-18" and status = "open"')),
         ans(kind="task", when=W({"to": U("week", 0, weekday=7)}), where='status = "open"')]),
  T("push email gary about the boiler to monday", diff(upd("boiler", date="2026-10-19")),
    ref=[act("reschedule", rows="$boiler", args=lines(to=U("week", 1, weekday=1)))]),
  T("and put develop the whitby rolls on the house list, the tank's in our bathroom", diff(link("houselist", "develop")),
    ref=[act("add_to", kind="task", name="Develop the Whitby rolls", args=lines(to="$houselist"))]),
  T("delete buy washing up liquid", ask("wul_1", "wul_2"),
    ref=[act("delete", kind="task", name="Buy washing up liquid"),
         find(kind="task", name="Buy washing up liquid"),
         askc("the open one due friday or the one you already ticked off?", options="$wul_1, $wul_2")]))

S("T04-023", "count since month",
  T("how many amu night shifts have i done since september", val(6),
    ref=[ans(op="count", kind="event", name="Night shift AMU",
             when=W({"from": U("month", 0, name=9), "to": U("day", 0)}))]),
  T("restore the gym induction, craig's back on", diff(restore("gym")),
    ref=[act("restore", kind="event", name="Gym induction", trashed=True)]),
  T("how many long days from the first till end of the month", val(7),
    ref=[ans(op="count", kind="event", name="Long day AMU", when=W({"from": D("2026-10-01"), "to": U("month", 0)}))]),
  T("and from today to the end of november", val(6),
    ref=[ans(op="count", kind="event", name="Long day AMU", when=W({"from": U("day", 0), "to": U("month", 0, name=11)}))]))

S("T04-024", "group create add_to ask",
  T("start a group for mum and dads anniversary present", diff(new("group", name=has("anniversary")), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Mum and Dad's anniversary present"))]),
  T("add zainab and imran", diff(link("+1", "zainab"), link("+1", "imran")),
    ref=[act("add_to", rows="$zainab, $imran", args=lines(to="$new"))]),
  T("and fatima", ask("fatima_k", "fatima_h"),
    ref=[act("add_to", kind="person", name="Fatima", args=lines(to="$c1")),
         askc("fatima khan or fatima hussain?", options="$fatima_k, $fatima_h")]))

S("T04-025", "list edit area open count",
  T("move the food bank list under community", diff(upd("fblist", area="community")),
    ref=[act("edit", rows="$fblist", args=lines(area="community"))]),
  T("what's open on food bank", rows("tins", "tesco", "hampers", "fb_rota"),
    ref=[ans(kind="task", linked_to="$fblist", where='status = "open"')]),
  T("who's on a monthly check-in", rows("nasreen", "fatima_k", "aoife"),
    ref=[ans(kind="person", where="cadence = 30")]),
  T("star the pic of zainab", ask("venue_hall", "fabric", "ring", "engagement"),
    ref=[find(kind="photo", linked_to="$zainab"),
         askc("which one, the ballroom, the fabric swatches, her ring or the engagement party?",
              options="$venue_hall, $fabric, $ring, $engagement")]))

S("T04-101", "single document span rel rel",
  T("which docs came in during august and september",
    rows("audit_doc", "caterer_quote", "guest_sheet", "invite_proof", "payslip", "rota_doc", "tenancy"),
    ref=[ans(kind="document", when=W({"from": U("month", -2), "to": U("month", -1)}))]))
