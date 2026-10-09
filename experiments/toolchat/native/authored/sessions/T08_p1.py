from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T08-006-P", "restore person window para",
  T("bring back carl pruitt", diff(restore("carl")),
    ref=[act("restore", kind="person", name="Carl Pruitt", trashed=True)]),
  T("jerome watts?", ask(),
    ref=[bad(act("restore", kind="person", name="Jerome Watts", trashed=True)),
         askc("jerome's been in the trash too long to restore. make a new contact for him?")]))

S("T08-009-P", "folder create edit new delete empty para",
  T("i want a new folder named Reunion receipts", diff(new("folder", name="Reunion receipts")),
    ref=[act("create", args=lines(kind="folder", name="Reunion receipts"))]),
  T("change its name to Reunion money", diff(upd("+1", name="Reunion money")),
    ref=[act("edit", rows="$c1", args=lines(name="Reunion money"))]),
  T("the old job folder is empty, so get rid of it", diff(gone("oldjob_f")),
    ref=[act("delete", rows="$oldjob_f")]))

S("T08-013-P", "album create delete new empty para",
  T("new album please, name it Car wash", diff(new("album", name="Car wash")),
    ref=[act("create", args=lines(kind="album", name="Car wash"))]),
  T("changed my mind, wipe that album", diff(gone("+1")),
    ref=[act("delete", rows="$c1")]),
  T("which albums have zero photos in", rows(),
    ref=[ans(kind="album", where="photo count = 0")]))

S("T08-016-P", "locker reveal prev credit union para",
  T("i'm after the credit union login", rows("bank_login"),
    ref=[ans(kind="locker item", name="Credit union login")]),
  T("its password?", diff(reveal=[("bank_login", "Truck-F150-go")]),
    ref=[act("reveal", kind="locker item", rows="@prev", args=lines(field="password"))]),
  T("locker items with any type set, which are they", rows("wifi", "servicetitan", "portal", "bank_login", "visa", "gas_card",
                                                       "gate_code", "ssn", "alarm", "pi_key", "weather_api", "passport",
                                                       "checking", "license", "office", "crypto", "costco", "union_card",
                                                       "epa_card"),
    ref=[ans(kind="locker item", where="type is set")]))

S("T08-021-P", "add_to note prev remove_from prev para",
  T("my side job tune-up prices are in which note", rows("side_jobs"),
    ref=[ans(kind="note", where='body contains "tune-up"')]),
  T("stick it into hvac notes", diff(link("hvac_nb", "side_jobs")),
    ref=[act("add_to", rows="@prev", args=lines(to="$hvac_nb"))]),
  T("wrong place, pull it out again", diff(unlink("hvac_nb", "side_jobs")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$hvac_nb"))]))

S("T08-025-P", "ambiguous document delete para",
  T("the report card has to go, wipe it", ask("rc_jalen", "rc_jada"),
    ref=[act("delete", kind="document", name="report card"),
         askc("jalen's or jada's?", options="$rc_jalen, $rc_jada")]),
  T("jalen's report card, already printed it", diff(trash("rc_jalen")),
    ref=[act("delete", rows="$rc_jalen")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T08-030-P", "task priority subtasks para",
  T("show tasks that rank lower than priority two", rows("dues", "nate", "cleats", "registration", "garage", "manifold", "proposal"),
    ref=[ans(kind="task", where="priority > 2")]),
  T("of those, the ones with nothing under them", rows("dues", "cleats", "registration", "garage", "manifold", "proposal"),
    ref=[ans(kind="task", within="@prev", where="task count = 0")]))

S("T08-034-P", "documents date star para",
  T("documents i added on march twentieth", rows("rc_jalen", "rc_jada"),
    ref=[ans(kind="document", when=W(D("2026-03-20")))]),
  T("jada's one, star it", diff(upd("rc_jada", starred=True)),
    ref=[act("star", kind="document", name="Jada report card")]),
  T("last monday at 5:45, what was saved", rows("lease26"),
    ref=[ans(kind="document", when=W(U("week", -1, weekday=1, time="17:45")))]),
  T("what else was there that day", rows(),
    ref=[ans(kind="document", when=W(D("2026-03-30")), exclude="$lease26")]))

S("T08-038-P", "photo span unstar where para",
  T("photos from easter sunday, up to 4pm only", rows("p_church", "p_egg", "p_ham"),
    ref=[ans(kind="photo", when=W(span(D("2026-04-05"), D("2026-04-05", "16:00"))))]),
  T("among them, take the star off the one that has it", diff(upd("p_church", starred=False)),
    ref=[act("unstar", kind="photo", within="@prev", where="starred = yes")]),
  T("easter album, which ones carry a star", rows("p_bigmama"),
    ref=[ans(kind="photo", linked_to="$easter_album", where="starred = yes")]))

S("T08-044-P", "people month span event count para",
  T("people whose last contact was in jan or feb", rows("bev", "vic"),
    ref=[ans(kind="person", when=W(span(U("month", 0, name=1), U("month", 0, name=2))))]),
  T("of those, who hasn't got any events with me", rows("vic"),
    ref=[ans(kind="person", within="@prev", where="event count = 0")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T08-053-P", "find miss other kind delete cancelled para",
  T("fish fry task, due when", rows("fish_fry"),
    ref=[find(kind="task", name="fish fry"), ans(rows="$fish_fry")]),
  T("ah, it was cancelled anyway, so clear it out", diff(trash("fish_fry")),
    ref=[act("delete", rows="$fish_fry")]),
  T("since march, what other things were cancelled", rows("movie", "softball"),
    ref=[ans(kind="event", where='status = "cancelled"', when=W({"from": U("month", 0, name=3)}))]))

S("T08-057-P", "delete person where restore named delete para",
  T("wipe the dentist from my contacts, we've switched offices", diff(trash("dr_shah")),
    ref=[act("delete", kind="person", where='role = "dentist"')]),
  T("dentist appointments, still happening?", rows("dentist_jalen", "dentist_jada"),
    ref=[ans(kind="event", name="Dentist appointment")]),
  T("scratch that, the dentist stays: restore him", diff(restore("dr_shah")),
    ref=[act("restore", kind="person", where='role = "dentist"', trashed=True)]),
  T("also Gloria Nunez can be wiped, there's a new property manager", diff(trash("gloria")),
    ref=[act("delete", kind="person", name="Gloria Nunez")]),
  T("any tasks of mine with her on them", rows("dishwasher"),
    ref=[ans(kind="task", linked_to="$gloria")]))

S("T08-060-P", "boosters group balance settle debt undo para",
  T("list the people in eagles boosters", rows("marcus_h", "quanisha", "coach_t", "tasha", "me"),
    ref=[ans(kind="person", linked_to="$boosters")]),
  T("money-wise, how do i stand there", val((93.8, "USD")),
    ref=[ans(op="balance", kind="group", name="Eagles boosters", linked_to="$me")]),
  T("quanisha dawson and i need settling up", diff(settle=[("Quanisha Dawson", "30.6")]),
    ref=[act("settle_up", rows="$quanisha", args=lines(group="$boosters"))]),
  T("isn't there raffle cash she owes me as well", rows("d_quanisha"),
    ref=[ans(kind="debt", linked_to="$quanisha")]),
  T("that one's been paid, mark it", diff(upd("d_quanisha", status="settled")),
    ref=[act("settle_debt", rows="@prev")]),
  T("next boosters meeting is when", rows("boost_0413"),
    ref=[ans(kind="event", name="Boosters meeting", when=W({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T08-066-P", "restore undo restore para",
  T("the old pay stub shouldn't be in the trash, restore it", diff(restore("paystub")),
    ref=[act("restore", kind="document", name="Old pay stub", trashed=True)]),
  T("ignore that, undo what you just did", diff(trash("paystub")),
    ref=[act("undo")]))

S("T08-070-P", "boosters debt count event count reunion note count para",
  T("eagles boosters people i don't have any debt with", rows("marcus_h", "tasha", "me"),
    ref=[ans(kind="person", linked_to="$boosters", where="debt count <= 0")]),
  T("out of those, exactly one event together with whom", rows("tasha"),
    ref=[ans(kind="person", within="@prev", where="event count = 1")]),
  T("reunion committee members that have just one note about them", rows("dre", "bev"),
    ref=[ans(kind="person", linked_to="$reunion_g", where="note count = 1")]))

S("T08-074-P", "notes spans notebook count para",
  T("notes written between march tenth at 9am and last friday", rows("contract_q", "grievance_notes", "custody", "heat_pump", "jada_sizes",
                                                        "fishing_list", "carwash_plan", "shirt_notes", "prayer",
                                                        "gift_ideas", "franklin"),
    ref=[ans(kind="note", when=W(span(D("2026-03-10", "09:00"), U("week", -1, weekday=5))))]),
  T("of them, the ones sitting in a notebook", rows("contract_q", "grievance_notes", "custody", "heat_pump", "jada_sizes",
                                                  "carwash_plan", "shirt_notes", "franklin"),
    ref=[ans(kind="note", within="@prev", where="notebook count != 0")]),
  T("and since the second at 6pm, anything newer", rows("franklin"),
    ref=[ans(kind="note", when=W(span(D("2026-04-02", "18:00"), U("day", 0))))]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T08-079-P", "debts amount since direction settle para",
  T("what do i owe that's under 40", rows("d_kevin", "d_marcus_b"),
    ref=[ans(kind="debt", where='direction = "i_owe" and amount <= 40')]),
  T("from april first at 9am on, which ones aren't owed to me", rows("d_marcus_b", "d_tanya"),
    ref=[ans(kind="debt", when=W({"from": D("2026-04-01", "09:00")}), where='direction != "owes_me"')]),
  T("sunday i paid tanya back for the Easter groceries, mark it settled", diff(upd("d_tanya", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Easter groceries")]))

S("T08-084-P", "house tasks span ambiguous filter reschedule anchor para",
  T("due from april till the twentieth, house list stuff", rows("filter_apr", "rent_apr", "dishwasher", "gutters"),
    ref=[ans(kind="task", linked_to="$house_l", when=W(span(U("month", 0, name=4), D("2026-04-20"))))]),
  T("reschedule change furnace filter for tomorrow, 8am", diff(upd("filter_apr", date="2026-04-07T08:00")),
    ref=[act("reschedule", kind="task", name="Change furnace filter", args=lines(to=U("day", 1, time="08:00"))),
         act("reschedule", kind="task", name="Change furnace filter", where='status = "open"',
             args=lines(to=U("day", 1, time="08:00")))]),
  T("dishwasher call, two days later and make it 10", diff(upd("dishwasher", date="2026-04-10T10:00")),
    ref=[act("reschedule", kind="task", name="dishwasher", args=lines(to=U("day", 2, anchor="row", time="10:00")))]),
  T("who is it with", rows("gloria"),
    ref=[ans(kind="person", linked_to="$dishwasher")]),
  T("this morning i spoke with her, log that as a call too", diff(upd("gloria", date=ANY)),
    ref=[act("log", rows="$gloria", args=lines(kind="call"))]))

S("T08-089-P", "album create delete new folder create edit new para",
  T("create a Reunion 2026 album", diff(new("album", name="Reunion 2026")),
    ref=[act("create", args=lines(kind="album", name="Reunion 2026"))]),
  T("forget it, the old album stays in use, so get rid of the new one", diff(gone("+1")),
    ref=[act("delete", rows="$c1")]),
  T("also a folder named Union stuff, please", diff(new("folder", name="Union stuff")),
    ref=[act("create", args=lines(kind="folder", name="Union stuff"))]),
  T("on second thought, name it Union paperwork", diff(upd("+2", name="Union paperwork")),
    ref=[act("edit", rows="$c2", args=lines(name="Union paperwork"))]),
  T("Union contract 2024-2027 belongs in there, add it", diff(link("+2", "union_contract"), unlink("certs_f", "union_contract")),
    ref=[act("add_to", kind="document", name="Union contract", args=lines(to="$c2"))]))

S("T08-092-P", "trashed event past window note restore para",
  T("what day is the fantasy draft", rows("draft"),
    ref=[find(kind="event", name="Fantasy draft"), ans(kind="event", name="Fantasy draft", trashed=True)]),
  T("restore it to my diary", ask(),
    ref=[bad(act("restore", rows="$draft")),
         askc("that one's been in the trash over 30 days so it can't come back. want me to make a new one?")]),
  T("nah leave it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("is the old minisplit quote note still anywhere", rows("old_quote"),
    ref=[find(kind="note", name="minisplit quote"), ans(kind="note", name="minisplit quote", trashed=True)]),
  T("bring that one back", diff(restore("old_quote")),
    ref=[act("restore", rows="$old_quote")]))

S("T08-095-P", "recovery doc via photo add_to folder para",
  T("franklin invoice photo, where is it", rows("invoice"),
    ref=[find(kind="photo", name="Franklin invoice"), ans(rows="$invoice")]),
  T("the taxes folder is where it goes", diff(link("taxes_f", "invoice")),
    ref=[act("add_to", rows="$invoice", args=lines(to="$taxes_f"))]),
  T("taxes 2025 contents?", rows("w2", "f1099", "return24", "invoice"),
    ref=[ans(kind="document", linked_to="$taxes_f")]))

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T08-A002-P", "ask-options task complete c3a para",
  T("dues is sent, mark it done", ask("dues", "union_dues"),
    ref=[act("complete", kind="task", name="dues"),
         askc("Collect reunion dues or Pay union dues?", options="$dues, $union_dues")]),
  T("union", diff(upd("union_dues", status="completed", completed=ANY)),
    ref=[act("complete", rows="$union_dues")]))

S("T08-A007-P", "follow-up c3a para",
  T("this week's due list", rows("restock", "bigmama_meds", "w2_upload", "field_trip", "recovery_tank", "dishwasher", "ts_apr", "call_bev", "filter_apr", "budget_email", "lunch", "cleats"),
    ref=[ans(kind="task", when=J(U("week", 0)), where="status = open")]),
  T("which take less than 20 minutes", rows("ts_apr", "lunch", "filter_apr"),
    ref=[ans(within="@prev", where="effort < 20")]),
  T("and the rest of them?", rows("restock", "bigmama_meds", "w2_upload", "recovery_tank", "field_trip", "dishwasher", "call_bev", "budget_email", "cleats"),
    ref=[ans(within="@1", exclude="@2")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

OPEN = 'status = "open"'

IOWE = 'direction = "i_owe" and status = "open"'

OWED = 'direction = "owes_me" and status = "open"'

S("T08-B002-P", "c3b superlative note latest document oldest count para",
  T("most recent note", rows("franklin"),
    ref=[ans(kind="note", order="date desc", limit=1)]),
  T("oldest document on file?", rows("epa_cert"),
    ref=[ans(kind="document", order="date asc", limit=1)]),
  T("total document count?", val(19),
    ref=[ans(op="count", kind="document")]))

S("T08-B005-P", "c4b state-change cancel event restore trashed note para",
  T("shop's shut saturday, the haircut is off - cancel it", diff(upd("haircut", status="cancelled")),
    ref=[act("cancel", kind="event", name="Haircut")]),
  T("restore the old minisplit quote", diff(restore("old_quote")),
    ref=[act("restore", kind="note", name="minisplit quote", trashed=True)]))
