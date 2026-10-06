from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T05-002-P", "event find edit prev para",
  T("amma's eye consultation date?", rows("cataract_1"),
    ref=[ans(kind="event", name="Amma cataract consultation")]),
  T("its description should include bring aadhaar and the 2024 reports", diff(upd("cataract_1", description="bring aadhaar and the 2024 reports")),
    ref=[act("edit", rows="@prev", args=lines(description="bring aadhaar and the 2024 reports"))]),
  T("amma cataract surgery, thirteenth right?", rows("cataract_2"),
    ref=[ans(kind="event", name="Amma cataract surgery")]))

S("T05-006-P", "debt settle prev para",
  T("my debts to revathi subramanian, what are they", rows("d_revathi"),
    ref=[ans(kind="debt", linked_to="$revathi", where='direction = "i_owe"')]),
  T("i settled it with her over gpay, mark it as paid", diff(upd("d_revathi", status="settled")),
    ref=[act("settle_debt", rows="@prev")]))

S("T05-011-P", "photo delete multi undo para",
  T("the blurry kolam shot and the pharmacy receipt pic can go, wipe both",
    diff(trash("blurry_kolam"), trash("receipt_pic"), unlink("pongal_al", "blurry_kolam")),
    ref=[act("delete", rows="$blurry_kolam, $receipt_pic")]),
  T("oh the receipt's needed for the insurance claim, undo it", diff(restore("blurry_kolam"), restore("receipt_pic"),
                                                              link("pongal_al", "blurry_kolam")),
    ref=[act("undo")]))

S("T05-016-P", "task edit named priority para",
  T("renew passport is urgent, it expires in june: priority one", diff(upd("passport", priority=1)),
    ref=[act("edit", kind="task", name="Renew passport", args=lines(priority=1))]),
  T("which other tasks are priority one and still open", rows("reports", "leave", "selvi_pay", "bls_cert", "insurance_claim"),
    ref=[ans(kind="task", where='priority = 1 and status = "open"', exclude="$passport")]))

S("T05-022-P", "search hit event linked_to all para",
  T("events involving both divya s and jaya", rows("night_0109", "night_0110", "night_0123", "night_0124",
                                                         "night_0127", "night_0128", "night_0206", "night_0207", "farewell"),
    ref=[ans(kind="event", linked_to="$divya_s, $jaya")]),
  T("only from today onwards", rows("night_0123", "night_0124", "night_0127", "night_0128", "night_0206", "night_0207",
                                  "farewell"),
    ref=[ans(within="@prev", when=W({"from": U("day", 0)}))]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T05-028-P", "groups person count balance compute para",
  T("groups whose member count isn't three", rows("cricket_g", "carpool", "dubai_g", "farewell_g"),
    ref=[ans(kind="group", where="person count != 3")]),
  T("carpool members?", rows("divya_s", "jaya", "ramesh_d", "me"),
    ref=[ans(kind="person", linked_to="$carpool")]),
  T("my balance there?", val((740, "INR")),
    ref=[comp(op="balance", kind="group", name="Night shift carpool", linked_to="$me"), ans(value="@prev")]))

S("T05-034-P", "documents no folder para",
  T("documents sitting outside any folder", rows("aadhaar", "pan"),
    ref=[ans(kind="document", where="folder count != 1")]),
  T("both go into medical for", diff(link("med_f", "aadhaar"), link("med_f", "pan")),
    ref=[act("add_to", rows="@prev", args=lines(to="$med_f"))]),
  T("no wait, undo", diff(unlink("med_f", "aadhaar"), unlink("med_f", "pan")),
    ref=[act("undo")]))

S("T05-039-P", "person dates span para",
  T("people i've been in touch with from the fifteenth on", rows("amma", "appa", "karthik", "paati", "divya_s", "sowmya",
                                                   "ramesh_d"),
    ref=[ans(kind="person", when=W({"from": D("2026-01-15"), "to": U("week", 0, weekday=7)}))]),
  T("december through to the tenth noon, same question", rows("meena", "rajan", "kavya", "arjun", "farhan"),
    ref=[ans(kind="person", when=W({"from": U("month", -1, name=12), "to": D("2026-01-10", "12:00")}))]))

S("T05-044-P", "notes up to last month para",
  T("notes written until the end of last month, how many", val(7),
    ref=[ans(op="count", kind="note", when=W({"to": U("month", -1)}))]),
  T("until last sunday instead", val(20),
    ref=[ans(op="count", kind="note", when=W({"to": U("week", -1, weekday=7)}))]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T05-057-P", "delete group refused members balance delete empty group para",
  T("trip's postponed, so the dubai trip group goes: wipe it", ask(),
    ref=[bad(act("delete", kind="group", name="Dubai trip")),
         askc("the dubai trip group still has expenses in it, so it can't be deleted. settle up first or keep it?")]),
  T("ok keep it. its members?", rows("karthik", "harish", "anand", "me"),
    ref=[ans(kind="person", linked_to="$dubai_g")]),
  T("my balance in there?", val((450, "AED")),
    ref=[comp(op="balance", kind="group", name="Dubai trip", linked_to="$me"), ans(value="@prev")]),
  T("farhan farewell gift group, we're doing cash so wipe it", diff(gone("farewell_g"), unlink("farewell_g", "me")),
    ref=[act("delete", kind="group", name="Farhan farewell gift")]),
  T("group count?", val(5),
    ref=[ans(op="count", kind="group")]))

S("T05-062-P", "note restore multi undo restore para",
  T("notes in the trash?", rows("adai", "old_roster", "old_shopping", "hindi_words"),
    ref=[ans(kind="note", trashed=True)]),
  T("the december roster and the adai batter one come back", diff(restore("old_roster"), restore("adai")),
    ref=[act("restore", rows="$old_roster, $adai")]),
  T("i don't need either, so undo that", diff(trash("old_roster"), trash("adai")),
    ref=[act("undo")]),
  T("recipes contents then?", rows("vathal", "pongal_r", "rasam"),
    ref=[ans(kind="note", linked_to="$recipes_nb")]))

S("T05-067-P", "album delete create add photo para",
  T("farhan's leaving, so the ICU team album gets wiped for now, i'll redo it after",
    diff(gone("icu_al"), unlink("icu_al", "icu_xmas"), unlink("icu_al", "night_team"), unlink("icu_al", "nurses_day"),
         unlink("icu_al", "farhan_pic")),
    ref=[act("delete", kind="album", name="ICU team")]),
  T("new album, Farhan farewell", diff(new("album", name="Farhan farewell")),
    ref=[act("create", args=lines(kind="album", name="Farhan farewell"))]),
  T("farhan's last night shift pic goes in there", diff(link("+1", "farhan_pic")),
    ref=[act("add_to", kind="photo", name="Farhan's last night shift", args=lines(to="$new"))]))

S("T05-071-P", "tasks today empty tomorrow edit named add_to prev para",
  T("today's to-do list", rows(),
    ref=[ans(kind="task", when=W(U("day", 0)))]),
  T("tomorrow?", rows("water_can", "projector", "reports"),
    ref=[ans(kind="task", when=W(U("day", 1)))]),
  T("order water cans takes ten mins and should be priority three", diff(upd("water_can", effort=10, priority=3)),
    ref=[act("edit", kind="task", name="Order water cans", args=lines(effort=10, priority=3))]),
  T("tomorrow's tasks lacking a priority", rows("projector"),
    ref=[ans(kind="task", when=W(U("day", 1)), where="priority is empty")]),
  T("home list is where it belongs", diff(unlink("cricketlist", "projector"), link("homelist", "projector")),
    ref=[act("add_to", rows="@prev", args=lines(to="$homelist"))]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T05-076-P", "people last contacted nickname cadence log para",
  T("people whose last contact was back in december", rows("meena", "rajan", "kavya", "arjun"),
    ref=[ans(kind="person", when=W(U("month", -1, name=12)))]),
  T("rang kavya narayanan, so note it as a call", diff(upd("kavya", date=ANY)),
    ref=[act("log", kind="person", name="Kavya Narayanan", args=lines(kind="call"))]),
  T("starred people without a saved nickname", rows("divya_s"),
    ref=[ans(kind="person", where="starred = yes and nickname is empty")]),
  T("kapaleeshwarar people who don't have a weekly check in", rows("revathi"),
    ref=[ans(kind="person", where='met contains "Kapaleeshwarar" and cadence != 7 days')]),
  T("revathi subramanian should be on weekly too", diff(upd("revathi", cadence=7)),
    ref=[act("edit", rows="$revathi", args=lines(cadence=7))]),
  T("last contact between november and first dec 9am, who", rows("anand"),
    ref=[ans(kind="person", when=W({"from": U("month", -1, name=11), "to": D("2025-12-01", "09:00")}))]),
  T("spoke to him last night too, log it as a call", diff(upd("anand", date=ANY)),
    ref=[act("log", rows="$anand", args=lines(kind="call"))]))

S("T05-082-P", "notes count up to recovery search para",
  T("note count as of last friday", val(19),
    ref=[ans(op="count", kind="note", when=W({"to": U("week", -1, weekday=5)}))]),
  T("same before this month began", val(7),
    ref=[ans(op="count", kind="note", when=W({"to": U("month", -1)}))]),
  T("router reset note, bring it up", rows("wifi_n"),
    ref=[find(kind="note", name="Router reset"), search("reset", kind="note"), ans(rows="@prev")]))

S("T05-086-P", "locker username empty type not restore para",
  T("card entries in the locker lacking a username", rows("hdfc_card", "sbi_card"),
    ref=[ans(kind="locker item", where='type = "card" and username is empty')]),
  T("locker items, all but the memberships", rows("his", "tnnmc_login", "hdfc_card", "sbi_card", "wifi",
                                                        "locker_combo", "aadhaar_id", "upi_pin", "pi_key", "maps_key",
                                                        "passport_item", "sbi_acct", "licence", "office", "wazirx",
                                                        "pan_item"),
    ref=[ans(kind="locker item", where='type != "membership"')]),
  T("sbi credit card gets a star", diff(upd("sbi_card", starred=True)),
    ref=[act("star", kind="locker item", name="SBI credit card")]),
  T("locker trash empty or not", rows("netflix"),
    ref=[ans(kind="locker item", trashed=True)]),
  T("the gang wants the netflix login again, bring it back", diff(restore("netflix")),
    ref=[act("restore", rows="$netflix")]))

S("T05-096-P", "search find-only miss pin write read para",
  T("noradrenaline note, where is it", rows("noradr"),
    ref=[search("noradrenaline", kind="note"), ans(rows="@prev")]),
  T("heparin notes?", decline("not_found"),
    ref=[search("heparin", kind="note"), dec("not_found")]),
  T("RASS note then", rows("sedation"),
    ref=[search("rass", kind="note"), ans(rows="@prev")]),
  T("RASS scoring gets pinned, then count the pinned notes",
    val(5, also=diff(upd("sedation", pinned=True))),
    ref=[act("edit", kind="note", name="RASS scoring", args=lines(pinned="yes"), more=True),
         ans(op="count", kind="note", where="pinned = yes")]))

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T05-A008-P", "follow-up c3a para",
  T("people i owe money to", rows("d_jaya", "d_divya_s", "d_revathi", "d_ramesh_mama", "d_appa"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("all but the scooty one", rows("d_ramesh_mama", "d_divya_s", "d_revathi", "d_jaya"),
    ref=[ans(within="@prev", exclude="$d_appa")]),
  T("largest of them?", rows("d_ramesh_mama"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

OPEN = 'status = "open"'

IOWE = 'direction = "i_owe" and status = "open"'

S("T05-B003-P", "c3b superlative debt biggest sum smallest para",
  T("largest debt i owe?", rows("d_appa"),
    ref=[ans(kind="debt", where=IOWE, order="amount desc", limit=1)]),
  T("sum of everything i owe", val((18570, "INR")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]),
  T("smallest among those", rows("d_jaya"),
    ref=[ans(kind="debt", where=IOWE, order="amount asc", limit=1)]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T05-C901-P", "c3c cell7 empty recovery wrong kind then debt amount para",
  T("sbi card, where did i keep it", rows("sbi_card"),
    ref=[find(kind="document", name="sbi card"), ans(kind="locker item", name="sbi card")]),
  T("debts from 1000 upwards", rows("d_karthik", "d_arjun", "d_appa", "d_ramesh_mama"),
    ref=[ans(kind="debt", where="amount >= 1000")]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))

CRIC = "Cricket night at Vicky's"

S("T05-104-P", "ask locker star membership para",
  T("membership card gets a star", ask("gym_card", "library"),
    ref=[act("star", kind="locker item", where='type = "membership"'),
         askc("the cult gym membership or the connemara library card?", options="$gym_card, $library")]),
  T("library", diff(upd("library", starred=True)),
    ref=[act("star", rows="$library")]),
  T("cult gym one also gets a star, it's lapsed but i want the number", diff(upd("gym_card", starred=True)),
    ref=[act("star", kind="locker item", name="Cult gym")]),
  T("hospital login loses its star, i know it by heart", diff(upd("his", starred=False)),
    ref=[act("unstar", kind="locker item", name="Hospital HIS login")]))

S("T05-108-P", "ask event cancel never_mind para",
  T("temple committee meeting needs cancelling", ask("tc_0124", "tc_0207"),
    ref=[act("cancel", kind="event", name="Temple committee meeting", when=W({"from": U("day", 0)})),
         find(kind="event", name="Temple committee meeting", when=W({"from": U("day", 0)})),
         askc("saturday's meeting on the 24th or the one on 7 feb?", options="$tc_0124, $tc_0207")]),
  T("hold off, i'll check with gopal first", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("gopal agreed, now cancel the saturday one", diff(upd("tc_0124", status="cancelled")),
    ref=[act("cancel", kind="event", name="Temple committee meeting", when=W(U("week", 0, weekday=6)))]))

S("T05-115-P", "ask locker reveal login para",
  T("login password, show it", ask("his", "tnnmc_login"),
    ref=[act("reveal", kind="locker item", where='type = "login"', args=lines(field="password")),
         askc("the hospital HIS login or the tnnmc portal login?", options="$his, $tnnmc_login")]),
  T("tnnmc", diff(reveal=[("tnnmc_login", "nurse@2021")]),
    ref=[act("reveal", rows="$tnnmc_login", args=lines(field="password"))]),
  T("hospital login's password too", diff(reveal=[("his", "Bed4-Vent!26")]),
    ref=[act("reveal", kind="locker item", name="Hospital HIS login", args=lines(field="password"))]),
  T("passport entry gets a star too", diff(upd("passport_item", starred=True)),
    ref=[act("star", kind="locker item", name="Passport")]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T05-120-P", "wifi read trashed locker restore star para",
  T("guests' wifi pw, what is it", rows("wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("netflix login, did it get trashed", rows("netflix"),
    ref=[ans(kind="locker item", name="Netflix", trashed=True)]),
  T("the cricket gang uses it, so restore it", diff(restore("netflix")),
    ref=[act("restore", rows="$netflix")]),
  T("aadhaar scan gets a star", diff(upd("aadhaar", starred=True)),
    ref=[act("star", kind="document", name="Aadhaar scan")]))

S("T05-126-P", "balance jaya group not_found trashed event para",
  T("jaya's balance in the carpool group?", val((-780, "INR")),
    ref=[ans(op="balance", kind="group", name="Night shift carpool", linked_to="$jaya")]),
  T("vet appointment date?", decline("not_found"),
    ref=[search("vet"), dec("not_found")]),
  T("yoga class should be on friday", decline("not_found"),
    ref=[act("reschedule", kind="event", name="Yoga class", args=lines(to=U("week", 0, weekday=5))),
         dec("not_found")]),
  T("icu locker code gets a star", diff(upd("locker_combo", starred=True)),
    ref=[act("star", kind="locker item", name="ICU locker code")]))
