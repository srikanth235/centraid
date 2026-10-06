from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
def J(d):
    return json.dumps(d, separators=(",", ":"))
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
LIVE = 'status = "open"'
OWE = 'direction = "i_owe" and status = "open"'
LIVE_EV = 'status != "cancelled"'
def next_prod():
    return find(kind="event", name="Weekly production meeting", when=W({"from": U("day", 0)}), order="date asc", limit=1)
def nets():
    return find(kind="event", name="Tigers net practice", when=W({"from": U("day", 0)}))


S("T16-001-P", "trashed people restore multi restore window refused para",
  T("deleted contacts, which ones", rows("delwar", "liton", "pervez", "shahin"),
    ref=[find(kind="person", trashed=True), ans(rows="@prev")]),
  T("liton, pervez and delwar should be restored", diff(restore("liton"), restore("pervez")),
    ref=[bad(act("restore", rows="$liton, $pervez, $delwar")),
         act("restore", rows="$liton, $pervez")]),
  T("liton, how is he listed", rows("liton"),
    ref=[ans(rows="$liton")]))

S("T16-006-P", "settle_up prev group balance para",
  T("what does jahanara khatun do", rows("jahanara"),
    ref=[ans(kind="person", name="Jahanara Khatun")]),
  T("eid bonus pool: settle up with her", diff(settle=["Jahanara Khatun"]),
    ref=[act("settle_up", rows="@prev", args=lines(group="$bonus"))]),
  T("are we even now, her and me", val((0, "BDT")),
    ref=[ans(op="balance", rows="$jahanara")]))

S("T16-013-P", "ambiguous reopen narrowed para",
  T("half the last lot were duds, so reopen buy cricket balls", diff(upd("balls_2", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Buy cricket balls"),
         act("reopen", kind="task", name="Buy cricket balls", where='status = "completed"')]),
  T("cricket list open task count?", val(4),
    ref=[ans(op="count", kind="task", linked_to="$cricket_l", where='status = "open"')]))

S("T16-019-P", "single remove_from note multi para",
  T("factory floor notebook shouldn't have bonus rates or the new operators note, pull them out",
    diff(unlink("factory_nb", "bonus_rates"), unlink("factory_nb", "operators")),
    ref=[find(kind="note", linked_to="$factory_nb"),
         act("remove_from", rows="$bonus_rates, $operators", args=lines(from_="$factory_nb"))]))

S("T16-024-P", "document folder month remove_from prev multi para",
  T("medical's november documents?", rows("ecg", "prescription"),
    ref=[ans(kind="document", linked_to="$medical_f", when=W(U("month", 0, name=11)))]),
  T("abba wants his own file, so take those out of medical", diff(unlink("medical_f", "ecg"), unlink("medical_f", "prescription")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$medical_f"))]),
  T("new folder Abba's file, drop them in", diff(new("folder", name="Abba's file"), link("new", "ecg"), link("new", "prescription")),
    ref=[act("create", args=lines(kind="folder", name="Abba's file"), more=True),
         act("add_to", rows="$ecg, $prescription", args=lines(to="$new"))]))

S("T16-029-P", "locker trashed type delete prev notes para",
  T("locker items in the trash?", rows("old_yahoo"),
    ref=[find(kind="locker item", trashed=True), ans(rows="@prev")]),
  T("ssh key entry, what's that", rows("server_key"),
    ref=[ans(kind="locker item", where='type = "ssh_key"')]),
  T("IT revoked it, so get rid of it", diff(trash("server_key")),
    ref=[act("delete", rows="@prev")]),
  T("what's left tagged work", rows("erp", "sms_api"),
    ref=[ans(kind="locker item", where='notes = "work"')]))

S("T16-035-P", "list task count create list add_to para",
  T("lists carrying over five tasks", rows("factory_l", "home_l", "kids_l", "cricket_l"),
    ref=[ans(kind="list", where="task count > 5")]),
  T("create a list called Eid shopping", diff(new("list", name="Eid shopping")),
    ref=[act("create", args=lines(kind="list", name="Eid shopping"))]),
  T("order rice sack goes on it", diff(link("+1", "rice"), unlink("shopping_l", "rice")),
    ref=[act("add_to", rows="$rice", args=lines(to="$c1"))]))

S("T16-040-P", "task status empty person count description para",
  T("tasks with no status set", rows(),
    ref=[ans(kind="task", where="status is empty")]),
  T("factory list open tasks nobody's attached to", rows("needle_log", "overtime", "ppe", "target_chart"),
    ref=[ans(kind="task", linked_to="$factory_l", where='person count < 1 and status = "open"')]),
  T("needle one's text?", rows("needle_log"),
    ref=[ans(rows="$needle_log")]),
  T("tasks whose description has line 5", rows("needle_log"),
    ref=[ans(kind="task", where='description contains "Line 5"')]))

S("T16-045-P", "remove_from photo where month linked para",
  T("september photos in the family album", rows("arif_bday"),
    ref=[ans(kind="photo", linked_to="$family_album", when=W(U("month", 0, name=9)))]),
  T("farzana wants it separate, so remove september's from family", diff(unlink("family_album", "arif_bday")),
    ref=[act("remove_from", kind="photo", linked_to="$family_album", when=W(U("month", 0, name=9)),
             args=lines(from_="$family_album"))]),
  T("arif's photos?", rows("arif_bday", "family_dinner"),
    ref=[find(kind="photo", linked_to="$arif"), ans(rows="@prev")]))

S("T16-056-P", "refused delete group ask delete empty group para",
  T("cox's bazar trip group can go, we're paying cash, delete it", ask(),
    ref=[bad(act("delete", rows="$coxs")),
         askc("it still has the hotel advance in it, so it can't be deleted. settle up with masud and shafiq first?")]),
  T("keep it. factory picnic 2025 is long done, delete that one",
    diff(gone("picnic"), unlink("picnic", "kamal"), unlink("picnic", "rubina"), unlink("picnic", "me")),
    ref=[act("delete", rows="$picnic")]),
  T("which groups are left now", rows("fund", "tigers", "bonus", "coxs", "kolkata"),
    ref=[ans(kind="group")]),
  T("shafiq's standing in the cox's one", val((-3000, "BDT")),
    ref=[ans(op="balance", kind="group", name="Cox's Bazar trip", linked_to="$shafiq")]))

S("T16-061-P", "list area in find count para",
  T("work or sport lists", rows("factory_l", "cricket_l"),
    ref=[find(kind="list", where='area in ("work", "sport")'), ans(rows="@prev")]),
  T("cricket one, open count", val(3),
    ref=[ans(op="count", kind="task", linked_to="$cricket_l", where='status = "open"')]))

S("T16-067-P", "photo spans unstar where yesterday para",
  T("photos last month up to the first of dec", rows("abba_amma", "tanvir_bat", "fire_drill_p", "salma_stage", "wedding_group", "mim_prize"),
    ref=[ans(kind="photo", when=W(span(U("month", -1), D("2026-12-01"))))]),
  T("fifth dec 1pm through last saturday?",
    rows("rahim_wickets", "scoreboard", "team_2026", "new_machines", "tutor_note", "receipt_balls", "rickshaw", "winter_market"),
    ref=[ans(kind="photo", when=W(span(D("2026-12-05", "13:00"), U("week", -1, weekday=6))))]),
  T("yesterday's starred photo, take its star off", diff(upd("fog", starred=False)),
    ref=[act("unstar", kind="photo", when=W(U("day", -1)), where="starred = yes")]))

S("T16-072-P", "notes span linked from within pinned para",
  T("last month through end of december, family fund notes", rows("fund_dec"),
    ref=[ans(kind="note", linked_to="$fund_nb", when=W(span(U("month", -1), U("month", 0, name=12))))]),
  T("people on that note", rows("shafiq"),
    ref=[ans(kind="person", linked_to="$fund_dec")]),
  T("notes from last month onwards", rows("bonus_rates", "abba_diet", "operators", "tanvir_marks", "line3_targets", "pitha_recipe",
                                       "gift_ideas", "audit_list", "meeting_rahim", "batting", "comilla_trip", "uttara_scout",
                                       "fund_dec", "rahim_feedback"),
    ref=[ans(kind="note", when=W({"from": U("month", -1)}))]),
  T("pinned ones among them", rows("line3_targets", "pitha_recipe", "batting"),
    ref=[ans(within="@prev", where="pinned = yes")]))

S("T16-077-P", "six turns karim ambiguous ask star subtasks spans para",
  T("karim gets a star", diff(upd("karim_h", starred=True)),
    ref=[act("star", kind="person", name="Karim")]),
  T("Eid bonus sheet for Line 3, its subtasks", rows("attendance", "hr_check", "bonus_sign"),
    ref=[ans(kind="task", linked_to="$bonus_sheet")]),
  T("of those, due twenty-eighth dec through january", rows("attendance", "hr_check", "bonus_sign"),
    ref=[ans(kind="task", linked_to="$bonus_sheet", when=W(span(D("2026-12-28"), U("month", 1, name=1))))]),
  T("open ones due by end of november", rows(),
    ref=[ans(kind="task", when=W({"to": U("month", 0, name=11)}), where='status = "open"')]),
  T("and before today?", rows("tv_bill"),
    ref=[ans(kind="task", when=W({"to": U("day", -1)}), where='status = "open"')]))

S("T16-083-P", "single find-only task count para",
  T("contacts with tasks attached",
    rows("monir", "rehana", "amma", "tanvir", "mim", "abba", "karim_h", "kamal", "rahim_u", "jahanara", "salma", "babu",
         "jewel", "sohel", "shafiq"),
    ref=[find(kind="person", where="task count != 0"), ans(rows="@prev")]))

S("T16-089-P", "locker notes in url reveal code para",
  T("work or personal entries in the locker whose url isn't https://www.bkash.com", rows("erp", "sms_api"),
    ref=[ans(kind="locker item", where='notes in ("work", "personal") and url != "https://www.bkash.com"')]),
  T("Factory ERP password, give it to me", diff(reveal=[("erp", "Line3-Target-1200")]),
    ref=[act("reveal", kind="locker item", name="Factory ERP", args=lines(field="password"))]))

S("T16-094-P", "seven turns coaching fee ambiguous kids tasks create add_to para",
  T("done: pay tanvir's coaching fee, tick it", diff(upd("tanvir_fee_jan", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay Tanvir's coaching fee")]),
  T("kids school, what else is still open", rows("mim_books", "admission"),
    ref=[ans(kind="task", linked_to="$kids_l", where='status = "open"')]),
  T("who's attached to Tanvir's college admission form", rows("tanvir"),
    ref=[ans(kind="person", linked_to="$admission")]),
  T("note with his marks", rows("tanvir_marks"),
    ref=[ans(kind="note", linked_to="$tanvir")]),
  T("tanvirs results day, what date", rows("tanvir_result"),
    ref=[find(kind="event", name="tanvirs results day"), search("tanvir result", kind="event"), ans(rows="$tanvir_result")]),
  T("new task Buy sweets for Tanvir's result, due on thirtieth dec", diff(new("task", name="Buy sweets for Tanvir's result", date="2026-12-30")),
    ref=[act("create", args=lines(kind="task", name="Buy sweets for Tanvir's result", date=D("2026-12-30")))]),
  T("stick it on kids school", diff(link("kids_l", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$kids_l"))]))

S("T16-100-P", "seven turns overlap ask create day already cancel new duration para",
  T("seventeenth dec at 2:30pm, schedule Meeting with Karim bhai about the bonus", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Meeting with Karim bhai about the bonus", date=D("2026-12-17", "14:30")))),
         askc("the line 3 efficiency review runs 2 to 3 that day. 3pm instead?")]),
  T("make it 3pm", diff(new("event", name="Meeting with Karim bhai about the bonus", date="2026-12-17T15:00")),
    ref=[act("create", args=lines(kind="event", name="Meeting with Karim bhai about the bonus", date=D("2026-12-17", "15:00")))]),
  T("thursday now, what's on", rows("line3_review", "+1", "kit_pickup", "tutor_meet"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=4)))]),
  T("Collect new jerseys is off, cancel it", diff(already=["kit_pickup"]),
    ref=[act("cancel", kind="event", name="Collect new jerseys"), ans(rows="$kit_pickup")]),
  T("karim's on leave, so that meeting goes too, cancel it", diff(upd("+1", status="cancelled")),
    ref=[act("cancel", rows="$c1")]),
  T("thursday items lasting exactly an hour", rows("line3_review", "kit_pickup", "+1"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=4)), where="duration = 60 minutes")]),
  T("Meet Tanvir's tutor, what is it about", rows("tutor_meet"),
    ref=[ans(kind="event", name="Meet Tanvir's tutor")]))

S("T16-A007-P", "follow-up c3a para",
  T("due through friday?", rows("water_pump", "balls_1", "salma_leave", "abba_meds", "phone", "bkash", "overtime", "kitty_collect"),
    ref=[ans(kind="task", when=J(span(U("day", 0), U("week", 0, weekday=5))), where="status = open")]),
  T("those needing more than 20 minutes", rows("water_pump", "balls_1"),
    ref=[ans(within="@prev", where="effort > 20")]),
  T("what about the other ones", rows("abba_meds", "phone", "kitty_collect", "bkash", "overtime", "salma_leave"),
    ref=[ans(within="@1", exclude="@2")]))

S("T16-B002-P", "c3b superlative task biggest count due last para",
  T("biggest open job?", rows("audit_prep"),
    ref=[ans(kind="task", where=OPEN, order="effort desc", limit=1)]),
  T("open count on my list", val(31),
    ref=[ans(op="count", kind="task", where=OPEN)]),
  T("latest due open one", rows("passport"),
    ref=[ans(kind="task", where=OPEN, order="date desc", limit=1)]))

S("T16-C003-P", "c3c compound star add_to photo para",
  T("family album gets the sunset from the roof, and give that one a star",
    diff(upd("sunset_roof", starred=True), link("family_album", "sunset_roof")),
    ref=[act("star", kind="photo", name="Sunset from the roof", more=True),
         act("add_to", rows="$sunset_roof", args=lines(to="$family_album"))]))

S("T16-C903-P", "c3c cell7 rejected priority word then undo after create para",
  T("friday deadline, high priority, new task to pay the generator man", diff(new("task", name="Pay the generator man", date="2026-12-18", priority=1)),
    ref=[bad(act("create", args=lines(kind="task", name="Pay the generator man", date=U("week", 0, weekday=5), priority="high"))), act("create", args=lines(kind="task", name="Pay the generator man", date=U("week", 0, weekday=5), priority=1))]),
  T("he's been paid already, undo it", diff(trash("+1")),
    ref=[act("undo")]))

S("T16-105-P", "ask options abba appointment pick then contrast checkup para",
  T("abba's appointment, the 23rd instead", ask("echo_test", "cardio_jan"),
    ref=[act("reschedule", kind="event", name="Abba", when=W({"from": U("day", 0)}),
             args=lines(to=D("2026-12-23"))),
         askc("the echo test on the 22nd or the cardiology check-up in january?", options="$echo_test, $cardio_jan")]),
  T("echo test", diff(upd("echo_test", date="2026-12-23T08:30")),
    ref=[act("reschedule", rows="$echo_test", args=lines(to=D("2026-12-23")))]),
  T("cardiology check-up one day later", diff(upd("cardio_jan", date="2027-01-15T17:00")),
    ref=[act("reschedule", kind="event", name="Cardiology check-up for Abba", when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 1, anchor="row")))]))

S("T16-111-P", "contrast star docs tin blood report unstar deed para",
  T("tin certificate, star it", diff(upd("tin", starred=True)),
    ref=[act("star", kind="document", name="TIN certificate")]),
  T("abba's blood report also gets a star", diff(upd("blood_report", starred=True)),
    ref=[act("star", kind="document", name="Abba's blood report")]),
  T("comilla land deed is at the bank now, take its star off", diff(upd("deed", starred=False)),
    ref=[act("unstar", kind="document", name="Comilla land deed")]))

S("T16-117-P", "ask options begum add_to family fund pick then contrast rehana para",
  T("family fund needs begum in it", ask("amma", "rehana", "salma"),
    ref=[act("add_to", kind="person", name="Begum", args=lines(to="$fund")),
         askc("rokeya begum, rehana begum or salma begum?", options="$amma, $rehana, $salma")]),
  T("amma it is", diff(link("fund", "amma")),
    ref=[act("add_to", rows="$amma", args=lines(to="$fund"))]),
  T("rehana begum as well", diff(link("fund", "rehana")),
    ref=[act("add_to", kind="person", name="Rehana Begum", args=lines(to="$fund"))]),
  T("salma's been great on line 3, give her a star", diff(upd("salma", starred=True)),
    ref=[act("star", kind="person", name="Salma Begum")]))
