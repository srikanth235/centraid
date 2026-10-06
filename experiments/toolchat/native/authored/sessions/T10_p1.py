from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T10-001-P", "events tomorrow reschedule linked task reschedule para",
  T("my day tomorrow, what's in it", rows("ac_service", "call_layla_0620"),
    ref=[find(kind="event", when=W(U("day", 1))), ans(rows="@prev")]),
  T("make the ac guy's visit 12 instead", diff(upd("ac_service", date="2026-06-20T12:00")),
    ref=[act("reschedule", rows="$ac_service", args=lines(to=U("day", 1, time="12:00")))]),
  T("video call with layla, who's on it", rows("layla", "lina"),
    ref=[ans(kind="person", linked_to="$call_layla_0620")]),
  T("he'll do it after, so service the air conditioner now belongs on monday", diff(upd("ac", date="2026-06-22")),
    ref=[act("reschedule", kind="task", name="Service the air conditioner", args=lines(to=U("week", 1, weekday=1)))]))

S("T10-006-P", "trashed event empty recovery restore date para",
  T("i thought lunch with jamal was in my calendar, is it", rows("jamal_lunch"),
    ref=[ans(kind="event", name="Lunch with Jamal"),
         ans(kind="event", name="Lunch with Jamal", trashed=True)]),
  T("he rang again, so restore it", diff(restore("jamal_lunch")),
    ref=[act("restore", rows="$jamal_lunch")]),
  T("other things that thursday", rows("abu_fadi_coffee"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=4)), exclude="$jamal_lunch")]))

S("T10-011-P", "ambiguous person log ask para",
  T("note a call i had with sami", ask("sami_h", "sami_k"),
    ref=[act("log", kind="person", name="Sami", args=lines(kind="call")),
         askc("sami haddad your grandson or sami khoury from chess?", options="$sami_h, $sami_k")]),
  T("the grandson one", diff(upd("sami_h", date=ANY)),
    ref=[act("log", rows="$sami_h", args=lines(kind="call"))]))

S("T10-016-P", "locker edit where starred para",
  T("got a new router, so the wifi entry becomes Home wifi 5G", diff(upd("wifi", name="Home wifi 5G")),
    ref=[act("edit", kind="locker item", where='type = "wifi"', args=lines(name="Home wifi 5G"))]),
  T("starred locker items?", rows("gmail", "visa_card", "jea"),
    ref=[find(kind="locker item", where="starred = yes"), ans(rows="@prev")]))

S("T10-022-P", "trashed photos restore multi para",
  T("list my deleted pics", rows("trash_selfie", "trash_menu", "trash_old"),
    ref=[find(kind="photo", trashed=True), ans(rows="@prev")]),
  T("selfie and menu should be restored", diff(restore("trash_selfie"), restore("trash_menu")),
    ref=[act("restore", rows="$trash_selfie, $trash_menu")]))

S("T10-025-P", "task read add_to prev para",
  T("print photos for omar, due when", rows("print_omar"),
    ref=[ans(kind="task", name="Print photos for Omar")]),
  T("home list is where it goes", diff(link("home_l", "print_omar")),
    ref=[act("add_to", rows="@prev", args=lines(to="$home_l"))]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T10-040-P", "find-only delete person prev complete para",
  T("plumber, locate him", rows("hani"),
    ref=[find(kind="person", where='role = "plumber"'), ans(rows="@prev")]),
  T("retired now, so wipe him from contacts", diff(trash("hani")),
    ref=[act("delete", rows="@prev")]),
  T("leak call task: finished", diff(upd("leak", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Call Hani about the kitchen leak")]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T10-055-P", "create person delete new para",
  T("new contact: Faisal Momani, eye doctor at Al-Khalidi", diff(new("person", name="Faisal Momani", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Faisal Momani", role="eye doctor, Al-Khalidi"))]),
  T("dr rania's clinic does eyes too, so wipe him again", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("book eye test task, due date then?", rows("eye_test"),
    ref=[ans(kind="task", name="Book eye test")]))

S("T10-059-P", "find ambiguous album rename para",
  T("eid album's new name: Eid 2026", ask("fitr_album", "adha_album"),
    ref=[find(kind="album", name="Eid"),
         act("edit", kind="album", name="Eid", args=lines(name="Eid 2026")),
         askc("the eid al-fitr one or eid al-adha?", options="$fitr_album, $adha_album")]),
  T("the adha one", diff(upd("adha_album", name="Eid 2026")),
    ref=[act("edit", rows="$adha_album", args=lines(name="Eid 2026"))]))

S("T10-064-P", "refused folder delete move then delete para",
  T("old scans folder can go, wipe it", ask(),
    ref=[bad(act("delete", kind="folder", name="Old scans")),
         askc("the school certificates are still in it. move them somewhere first?")]),
  T("property deeds takes them, then the folder gets deleted",
    diff(unlink("scans_f", "school_certs"), link("deeds_f", "school_certs"), gone("scans_f")),
    ref=[find(kind="document", linked_to="$scans_f"),
         act("add_to", rows="@prev", args=lines(to="$deeds_f"), more=True),
         act("delete", kind="folder", name="Old scans")]),
  T("property deeds contents?", rows("deed_house", "deed_land", "school_certs"),
    ref=[ans(kind="document", linked_to="$deeds_f")]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T10-076-P", "linked_to all album count add_to undo photo span para",
  T("album containing both the eid video call screenshot and yousef's kg graduation, which one", rows("grand_album"),
    ref=[find(kind="photo", name="Yousef's KG graduation"),
         ans(kind="album", linked_to="$adha_call, $yousef_grad")]),
  T("its photo count?", val(6),
    ref=[ans(op="count", kind="photo", linked_to="$grand_album")]),
  T("layla's school play goes into eid al-adha 2026 too", diff(link("adha_album", "layla_school")),
    ref=[act("add_to", rows="$layla_school", args=lines(to="$adha_album"))]),
  T("it wasn't eid, so undo that", diff(unlink("adha_album", "layla_school")),
    ref=[act("undo")]),
  T("photos between first june and last sunday",
    rows("chess_board", "dump_receipt", "yousef_grad", "dump_meter", "blur_1", "layla_school", "mosque_tiles", "mosque_dome"),
    ref=[ans(kind="photo", when=W(span(D("2026-06-01"), U("week", -1, weekday=7))))]))

S("T10-078-P", "task read add_to prev para",
  T("yousef's bicycle, due date?", rows("bike"),
    ref=[ans(kind="task", name="bicycle")]),
  T("home list gets it as well", diff(link("home_l", "bike")),
    ref=[act("add_to", rows="@prev", args=lines(to="$home_l"))]))

S("T10-087-P", "empty recovery trashed task restore window never mind para",
  T("wasn't there a task about selling the mercedes", rows("mercedes"),
    ref=[ans(kind="task", name="Sell the old Mercedes"),
         ans(kind="task", name="Sell the old Mercedes", trashed=True)]),
  T("bring it back please", ask(),
    ref=[bad(act("restore", rows="$mercedes")),
         askc("it's been in the bin over 30 days, so it can't be restored. want a new task for it?")]),
  T("never mind, nabil's neighbour bought it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T10-090-P", "album photo count delete multi para",
  T("albums holding at most two photos", rows("dump_album", "blurry_album"),
    ref=[find(kind="album", where="photo count <= 2"), ans(rows="@prev")]),
  T("those two can go, wipe them",
    diff(gone("dump_album"), gone("blurry_album"), unlink("dump_album", "dump_receipt"), unlink("dump_album", "dump_meter"),
         unlink("blurry_album", "blur_1"), unlink("blurry_album", "blur_2")),
    ref=[act("delete", rows="$dump_album, $blurry_album")]))

S("T10-095-P", "find note body literal add_to notes span para",
  T("note whose body reads chess class for kids at the mosque, locate it", rows("idea"),
    ref=[find(kind="note", where='body = "chess class for kids at the mosque"'), ans(rows="@prev")]),
  T("mosque fund gets it", diff(link("mosque_nb", "idea")),
    ref=[act("add_to", rows="$idea", args=lines(to="$mosque_nb"))]),
  T("notes written tenth june 6pm through the end of june", rows("tile_specs", "reminder", "bp_june", "tourney_notes", "idea"),
    ref=[ans(kind="note", when=W(span(D("2026-06-10", "18:00"), U("month", 0, name=6))))]),
  T("first may noon and later, notes", rows("italian", "grandkids_sizes", "fund_may", "knee", "gift_list", "rook_end", "tile_specs", "reminder", "bp_june", "tourney_notes", "idea"),
    ref=[ans(kind="note", when=W({"from": D("2026-05-01", "12:00")}))]))

S("T10-099-P", "five turns photo spans within star para",
  T("photos dated before march", rows("wedding_old", "umm_rami", "yousef_bike", "aqaba_boat", "aqaba_sea", "aqaba_fish", "chess_trophy", "layla_chess", "zaid_sami_snow"),
    ref=[ans(kind="photo", when=W({"to": U("month", 0, name=2)}))]),
  T("grandkids' only", rows("yousef_bike", "layla_chess", "zaid_sami_snow"),
    ref=[ans(within="@prev", linked_to="$grand_album")]),
  T("photos up to first jan 2025 as well", rows("wedding_old", "umm_rami"),
    ref=[ans(kind="photo", when=W({"to": D("2025-01-01")}))]),
  T("photos on eid al-fitr day, 1pm onwards", rows("fitr_table", "fitr_huda"),
    ref=[ans(kind="photo", when=W(span(D("2026-03-20", "13:00"), D("2026-03-20"))))]),
  T("huda's gets a star", diff(upd("fitr_huda", starred=True)),
    ref=[act("star", rows="$fitr_huda")]))

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T10-A003-P", "ask-options event reschedule never_mind c3a para",
  T("aqaba drive should start at 8", ask("aqaba_drive", "aqaba_back"),
    ref=[act("reschedule", kind="event", name="aqaba", args=lines(to=U("day", 0, anchor="row", time="08:00"))),
         askc("Drive to Aqaba on 9 July or the drive back on 12 July?", options="$aqaba_drive, $aqaba_back")]),
  T("leave the trip, abu fadi is driving with me", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("inspection one is complete, tick it", diff(upd("inspection", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="inspection")]))

S("T10-A006-P", "follow-up c3a para",
  T("next week's events", rows("huda_visit", "dentist", "call_yousef_0628", "nabil_lunch_0626", "tournament", "physio_0622", "chess_0623", "site_visit", "blood_test", "abu_fadi_coffee", "lecture"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("only the pre-wednesday ones", rows("huda_visit", "lecture", "physio_0622", "site_visit", "blood_test", "chess_0623"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=2)}))]),
  T("without the first pair", rows("site_visit", "lecture", "blood_test", "chess_0623"),
    ref=[ans(within="@prev", exclude="$physio_0622, $huda_visit")]))

S("T10-A009-P", "follow-up c3a para",
  T("pension folder contents?", rows("pension_june", "pension_may", "eng_cert", "pension_letter"),
    ref=[ans(kind="document", linked_to="$pension_f")]),
  T("starred ones among them", rows("pension_letter"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("remove its star", diff(upd("pension_letter", starred=False)),
    ref=[act("unstar", rows="@prev")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

IOWE = 'direction = "i_owe" and status = "open"'

OWED = 'direction = "owes_me" and status = "open"'

S("T10-B004-P", "c4b state-change complete complete create contrast para",
  T("adel's dish is paid for", diff(upd("sat_task", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Adel dish")]),
  T("ordered the gas cylinder", diff(upd("gas", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="gas cylinder")]),
  T("task needed to tell abu ahmad about the airport run", diff(new("task", name=has("airport"))),
    ref=[act("create", args=lines(kind="task", name="Tell Abu Ahmad about the airport run"))]))

S("T10-B006-P", "c4b state-change settle_debt log nickname para",
  T("got the chess book money from walid", diff(upd("d_walid", status="settled")),
    ref=[act("settle_debt", kind="debt", name="chess book")]),
  T("rang umm tareq back", diff(upd("huda", date=ANY)),
    ref=[search("umm tareq", kind="person"), act("log", rows="$huda", args=lines(kind="call"))]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

WEEKEND = {"from": U("week", 0, weekday=6), "to": U("week", 0, weekday=7)}

S("T10-101-P", "ask options document star unstar para",
  T("deed gets a star", ask("deed_house", "deed_land", "deed_scan"),
    ref=[askc("house deed, land deed or the copy in the locker?", options="$deed_house, $deed_land, $deed_scan")]),
  T("madaba's", diff(upd("deed_land", starred=True)),
    ref=[act("star", rows="$deed_land")]),
  T("ziad has his own copy, so fund ledger loses its star", diff(upd("fund_ledger", starred=False)),
    ref=[act("unstar", kind="document", name="Fund ledger")]),
  T("old uk visa copy should come back to my docs", diff(restore("old_visa")),
    ref=[act("restore", kind="document", name="Old UK visa copy", trashed=True)]))

S("T10-104-P", "contrast add_to person context star para",
  T("pharmacist's name?", rows("khaled_s"),
    ref=[ans(kind="person", where='role contains "pharmacist"')]),
  T("khaled has a car, so he joins the aqaba trip", diff(link("aqaba", "khaled_s")),
    ref=[act("add_to", rows="@prev", args=lines(to="$aqaba"))]),
  T("give him a star", diff(upd("khaled_s", starred=True)),
    ref=[act("star", rows="$khaled_s")]))

S("T10-107-P", "ask options person log long balance para",
  T("this morning khalil brought some bread from the bakery, log it as a visit", ask("khalil", "umm_khalil"),
    ref=[act("log", kind="person", name="Khalil", args=lines(kind="visit")),
         askc("khalil masri from the committee or samira khalil next door?", options="$khalil, $umm_khalil")]),
  T("the one next door", diff(upd("umm_khalil", date=ANY)),
    ref=[act("log", rows="$umm_khalil", args=lines(kind="visit"))]),
  T("her balance?", val((8, "JOD")),
    ref=[ans(op="balance", rows="$umm_khalil")]),
  T("she's paid me, so settle it", diff(upd("d_umm_khalil", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Bread from the bakery")]))

S("T10-109-P", "ask options locker star unstar para",
  T("bank one gets a star", ask("arab_bank", "visa_card", "cairo_amman"),
    ref=[act("star", kind="locker item", name="bank"),
         askc("arab bank online, the arab bank visa or your cairo amman account?", options="$arab_bank, $visa_card, $cairo_amman")]),
  T("online", diff(upd("arab_bank", starred=True)),
    ref=[act("star", rows="$arab_bank")]),
  T("visa loses its star", diff(upd("visa_card", starred=False)),
    ref=[act("unstar", rows="$visa_card")]))
