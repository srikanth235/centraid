from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
NOW = W({"from": U("day", 0)})
TOMORROW = W({"from": U("day", 1)})
THIS_WEEK = W(U("week", 0))
NEXT_MONTH = W(U("month", 1))
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
BIG2 = find(kind="debt", where=IOWE, order="amount desc", limit=2)
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T20-001-P", "person nickname contains find-only star prev para",
  T("enzo is whose nickname", rows("lorenzo_g"),
    ref=[find(kind="person", where='nickname contains "Enzo"'), ans(rows="@prev")]),
  T("he's covering my shifts during the move, so he gets a star", diff(upd("lorenzo_g", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T20-006-P", "group count person count edit group named para",
  T("people on a cadence who belong to no group", rows("mamma", "papa", "nonna", "francesca"),
    ref=[ans(kind="person", where="cadence is set and group count < 1")]),
  T("groups with under three members", rows("casa", "gift_pool"),
    ref=[ans(kind="group", where="person count < 3")]),
  T("nonna's birthday gift is now Nonna's 90th", diff(upd("gift_pool", name="Nonna's 90th")),
    ref=[act("edit", rows="$gift_pool", args=lines(name="Nonna's 90th"))]))

S("T20-012-P", "empty result note search edit para",
  T("corkage fees note, show what it says", rows("corkage_n"),
    ref=[find(kind="note", name="Corkage fees"), search("corkage", kind="note"), ans(rows="$corkage_n")]),
  T("tack on: 30 for magnums", diff(upd("corkage_n", body=has("magnums"))),
    ref=[act("edit", rows="$corkage_n", args=lines(body="25 euro a bottle, waived if they order a second. 30 for magnums"))]))

S("T20-017-P", "event weekend cancel prev multi undo cancel para",
  T("saturday or sunday this week, what's planned", rows("bike_service", "ride_0531"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]),
  T("i'll be packing, so cancel the pair", diff(upd("bike_service", status="cancelled"), upd("ride_0531", status="cancelled")),
    ref=[act("cancel", rows="@prev")]),
  T("take that back, undo", diff(),
    ref=[act("undo")]))

S("T20-023-P", "settle_up multi staff balance group para",
  T("staff dinner fund: settle up with sofia and davide", diff(settle=["Sofia Marchetti", "Davide Russo"]),
    ref=[act("settle_up", rows="$sofia, $davide", args=lines(group="$staff"))]),
  T("elena's position in that fund", val((-10, "EUR")),
    ref=[ans(op="balance", kind="group", name="Staff dinner fund", linked_to="$elena")]))

S("T20-029-P", "delete note where date linked empty restore para",
  T("the note from the nineteenth, get rid of it", diff(trash("nonna_gift_n")),
    ref=[act("delete", kind="note", when=W(D("2026-05-19")))]),
  T("do other notes talk about nonna", rows(),
    ref=[ans(kind="note", where='body contains "Nonna"')]),
  T("oops that was the gift one, restore it", diff(restore("nonna_gift_n")),
    ref=[act("restore", rows="$nonna_gift_n")]))

S("T20-035-P", "document edit prev rename para",
  T("scan 0041, what is it", rows("scan_1"),
    ref=[ans(kind="document", name="Scan 0041")]),
  T("make its name Lease annex page 1", diff(upd("scan_1", name="Lease annex page 1")),
    ref=[act("edit", rows="@prev", args=lines(name="Lease annex page 1"))]),
  T("0042 will be page 2", diff(upd("scan_2", name="Lease annex page 2")),
    ref=[act("edit", kind="document", name="Scan 0042", args=lines(name="Lease annex page 2"))]))

S("T20-040-P", "photo add_to where weekday album count para",
  T("cantina album gets last thursday's photo", diff(link("cantina_album", "tommy_p")),
    ref=[act("add_to", kind="photo", when=W(U("week", -1, weekday=4)), args=lines(to="$cantina_album"))]),
  T("albums holding at least four photos", rows("rides_album", "us_album", "cantina_album"),
    ref=[ans(kind="album", where="photo count >= 4")]))

S("T20-046-P", "locker trashed restore where para",
  T("old wifi password in the trash?", rows("old_wifi"),
    ref=[ans(kind="locker item", trashed=True, where='type = "wifi"')]),
  T("the guicciardini router's moving to the new flat, so bring that back, restore", diff(restore("old_wifi")),
    ref=[act("restore", kind="locker item", trashed=True, where='type = "wifi"')]))

S("T20-052-P", "event description empty reschedule anchor rel time para",
  T("tomorrow, events lacking a description", rows("cellar_count", "photographer_call", "aperitivo"),
    ref=[ans(kind="event", when=W(U("day", 1)), where="description is empty")]),
  T("call with ettore, one hour on", diff(upd("photographer_call", date="2026-05-29T13:00")),
    ref=[act("reschedule", rows="$photographer_call", args=lines(to={"unit": "hour", "rel": 1, "anchor": "row"}))]),
  T("tomorrow 1pm, what's booked", rows("photographer_call"),
    ref=[ans(kind="event", when=W(U("day", 1, time="13:00")))]),
  T("ettore's emailing instead, so remove it, delete", diff(trash("photographer_call")),
    ref=[act("delete", rows="@prev")]))

S("T20-058-P", "four turns task span subtasks count linked complete para",
  T("from tomorrow 8am through sunday, due tasks", rows("chianti_1", "chain", "car_tax"),
    ref=[ans(kind="task", when=W(span(U("day", 1, time="08:00"), U("week", 0))))]),
  T("exactly 3 subtasks, which task", rows("utilities"),
    ref=[ans(kind="task", where="task count = 3")]),
  T("show them", rows("enel", "gas", "internet"),
    ref=[ans(kind="task", linked_to="$utilities")]),
  T("done with call enel about the meter, tick it", diff(upd("enel", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Call Enel about the meter")]))

S("T20-062-P", "subtasks count two linked para",
  T("task carrying two subtasks", rows("wine_list"),
    ref=[ans(kind="task", where="task count = 2")]),
  T("name them", rows("list_whites", "list_print"),
    ref=[ans(kind="task", linked_to="@prev")]))

S("T20-067-P", "ambiguous lorenzo ask log para",
  T("i rang lorenzo, log it", ask("lorenzo_g", "lorenzo_r"),
    ref=[act("log", kind="person", name="Lorenzo", args=lines(kind="call")),
         askc("Lorenzo Gallo or Lorenzo Ricci?", options="$lorenzo_g, $lorenzo_r")]),
  T("the cousin", diff(upd("lorenzo_r", date=ANY)),
    ref=[act("log", rows="$lorenzo_r", args=lines(kind="call"))]),
  T("he's asking when the stag weekend is", rows("stag_weekend"),
    ref=[ans(kind="event", name="Stag weekend")]),
  T("last saturday up to tuesday, contacts i spoke with",
    rows("mamma", "papa", "marco_e", "marco_l", "stefano", "andrea", "carla", "lorenzo_g", "mauro"),
    ref=[ans(kind="person", when=W(span(U("week", -1, weekday=6), U("week", 0, weekday=2))))]))

S("T20-072-P", "single balance person para",
  T("am i in debt to andrea costa", val((-240, "EUR")),
    ref=[ans(op="balance", rows="$andrea")]))

S("T20-078-P", "five turns task count person count debt count linked_to all debt para",
  T("contacts attached to at least three tasks", rows("giulia", "federico"),
    ref=[ans(kind="person", where="task count >= 3")]),
  T("wedding list tasks involving two or more people", rows("guest_list", "wine_pairing"),
    ref=[ans(kind="task", linked_to="$wedding_l", where="person count >= 2")]),
  T("single debt with me, which contacts",
    rows("giulia", "andrea", "luca", "sofia", "davide", "federico", "chiara", "gianni", "marco_l", "elena"),
    ref=[ans(kind="person", where="debt count = 1")]),
  T("any debt shared by stefano and luca", rows(),
    ref=[ans(kind="debt", linked_to="$stefano, $luca")]),
  T("federico's, show it", rows("d_fede"),
    ref=[ans(kind="debt", linked_to="$federico")]))

S("T20-083-P", "four turns document spans date weekday date month to date to rel para",
  T("documents eleventh may through this monday", rows("venue_quote", "movers_contract", "enel_bill", "gf_ticket", "id_scan"),
    ref=[ans(kind="document", when=W(span(D("2026-05-11"), U("week", 0, weekday=1))))]),
  T("first march until the end of april?", rows("floor_plan", "payslip_mar", "tari", "lease_new"),
    ref=[ans(kind="document", when=W(span(D("2026-03-01"), U("month", 0, name=4))))]),
  T("saved earlier than 2025?", rows("contract_work", "wset", "ais_2"),
    ref=[ans(kind="document", when=W({"to": D("2024-12-31")}))]),
  T("until last month", rows("contract_work", "wset", "ais_2", "haccp", "floor_plan", "payslip_mar", "tari", "lease_new"),
    ref=[ans(kind="document", when=W({"to": U("month", -1)}))]))

S("T20-088-P", "treasurer find-only linked_to prev debt empty para",
  T("club treasurer is who", rows("bea"),
    ref=[find(kind="person", where='role contains "treasurer"'), ans(rows="@prev")]),
  T("any money from her owed to me", val((60, "EUR")),
    ref=[ans(op="balance", rows="@prev")]),
  T("every debt from april onwards, whether settled or not",
    rows("d_marco_l", "d_fede", "d_stefano_2", "d_andrea", "d_davide", "d_chiara", "d_stefano", "d_luca", "d_giulia",
         "d_sofia", "d_gianni"),
    ref=[ans(kind="debt", where="direction is set", when=W({"from": U("month", 0, name=4)}))]))

S("T20-093-P", "event overlap refused ask create read para",
  T("sunday at 8, ride with ale, book it", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Ride with Ale", date=U("week", 0, weekday=7, time="08:00")))),
         askc("the sunday club ride is 7:30 to 11:30. do the ride with ale at 12 instead?")]),
  T("ok make it 12", diff(new("event", name="Ride with Ale", date="2026-05-31T12:00")),
    ref=[act("create", args=lines(kind="event", name="Ride with Ale", date=U("week", 0, weekday=7, time="12:00")))]),
  T("what do i have sunday now", rows("ride_0531", "+1"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=7)))]),
  T("saturday through sunday 1pm?", rows("bike_service", "ride_0531", "+1"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7, time="13:00"))))]))

S("T20-099-P", "five turns trashed photos restore window ask linked_to star undo para",
  T("deleted photos?", rows("blurry_1", "blurry_2", "blurry_3"),
    ref=[find(kind="photo", trashed=True), ans(rows="@prev")]),
  T("it's the only new year one, so restore blurry fireworks", ask(),
    ref=[bad(act("restore", rows="$blurry_3")),
         askc("blurry fireworks went in the bin in february, past the 30 days, so it can't come back. restore one of the other two?")]),
  T("forget it. photos with marco esposito and stefano rinaldi together", rows("fiesole_top", "group_ride"),
    ref=[ans(kind="photo", linked_to="$marco_e, $stefano")]),
  T("club at piazza tanucci gets a star", diff(upd("group_ride", starred=True)),
    ref=[act("star", rows="$group_ride")]),
  T("take it back, undo", diff(upd("group_ride", starred=False)),
    ref=[act("undo")]))

S("T20-A008-P", "follow-up c3a para",
  T("next week, what do i have", rows("fede_visit", "ikea", "planner_meet", "ride_0607", "plumber_visit", "electrician_visit", "nonna_bday", "brief_0602", "keys_pickup"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("only those before thursday", rows("brief_0602", "electrician_visit", "fede_visit", "keys_pickup"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=3)}))]),
  T("leave off the first two", rows("brief_0602", "electrician_visit"),
    ref=[ans(within="@prev", exclude="$keys_pickup, $fede_visit")]))

S("T20-B005-P", "c4b state-change cancel event restore trashed task para",
  T("electrician visit at the new flat is off, piero cancelled", diff(upd("electrician_visit", status="cancelled")),
    ref=[act("cancel", kind="event", name="Electrician")]),
  T("helmet one, restore it", diff(restore("helmet")),
    ref=[act("restore", kind="task", name="helmet", trashed=True)]))

S("T20-C002-P", "c3c compound complete cancel para",
  T("cancel the bike service, and tick off dry cleaning, it's picked up",
    diff(upd("dry_clean", status="completed", completed=ANY), upd("bike_service", status="cancelled")),
    ref=[act("complete", kind="task", name="Pick up dry cleaning", more=True),
         act("cancel", kind="event", name="Bike service at the club")]))

S("T20-C902-P", "c3c cell7 rejected restore past window ask para",
  T("arno movers quote, restore it", ask(),
    ref=[bad(act("restore", kind="document", name="arno movers quote", trashed=True)), askc("the arno movers quote was deleted more than 30 days ago, so the vault can't bring it back. want to make a new document instead?")]))

S("T20-105-P", "ask options dentist description then star dentist role para",
  T("dentist description should say 'bring the x-rays'", ask("dentist_may", "dentist_jun"),
    ref=[act("edit", kind="event", name="Dentist", args=lines(description="bring the x-rays")),
         find(kind="event", name="Dentist"),
         askc("the one on 12 may or the june appointment?", options="$dentist_may, $dentist_jun")]),
  T("obviously june", diff(upd("dentist_jun", description="bring the x-rays")),
    ref=[act("edit", rows="$dentist_jun", args=lines(description="bring the x-rays"))]),
  T("she fits me in a lot, so the dentist herself gets a star", diff(upd("valentina", starred=True)),
    ref=[act("star", kind="person", where='role contains "dentist"')]))

S("T20-110-P", "ask options call reschedule to 6 then ettore earlier para",
  T("call at 6 instead", ask("photographer_call", "supplier_call"),
    ref=[act("reschedule", kind="event", name="Call", args=lines(to=U("day", 0, anchor="row", time="18:00"))),
         askc("the call with ettore tomorrow or the one with the montalcino supplier today?", options="$photographer_call, $supplier_call")]),
  T("supplier", diff(upd("supplier_call", date="2026-05-28T18:00")),
    ref=[act("reschedule", rows="$supplier_call", args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("ettore's call, half an hour sooner", diff(upd("photographer_call", date="2026-05-29T11:30")),
    ref=[act("reschedule", kind="event", name="Call with Ettore", args=lines(to=U("minute", -30, anchor="row")))]))
