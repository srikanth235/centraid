from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T16-026", "seven turns match day debts settle multi max",
  T("what's on friday", rows("nets_1218", "match_uttara", "team_dinner"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=5)))]),
  T("who's playing the uttara match", rows("sohel", "rahim_m", "imran", "babu", "jewel"),
    ref=[ans(kind="person", linked_to="$match_uttara")]),
  T("which kitty debts are open", rows("d_babu", "d_jewel"),
    ref=[ans(kind="debt", name="Kitty", where='status = "open"')]),
  T("both paid at nets this morning, settle the two", diff(upd("d_babu", status="settled"), upd("d_jewel", status="settled")),
    ref=[act("settle_debt", rows="$d_babu, $d_jewel")]),
  T("does imran owe me anything", val((1300, "BDT")),
    ref=[ans(op="balance", rows="$imran")]),
  T("what do i owe other people", rows("d_masud", "d_mizan", "d_selim", "d_monir", "d_sohel"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("biggest one of those?", rows("d_masud"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T16-027", "six turns audit linked_to all note duration ambiguous event",
  T("what's on monday", rows("buyer_audit"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=1)))]),
  T("how's the prep task for that audit", rows("audit_prep"),
    ref=[ans(kind="task", name="Prepare Line 3 for buyer audit")]),
  T("who's on it", rows("rahim_u", "jahanara"),
    ref=[ans(kind="person", linked_to="$audit_prep")]),
  T("any notes that have both of them", rows("meeting_rahim"),
    ref=[ans(kind="note", linked_to="$rahim_u, $jahanara")]),
  T("what else next week is exactly an hour long", rows("echo_test", "bank_visit", "fire_drill", "prod_1227"),
    ref=[ans(kind="event", when=W(U("week", 1)), where="duration = 60 minutes")]),
  T("shift the fire drill to thursday same time", diff(upd("fire_drill", date="2026-12-24T11:00")),
    ref=[act("reschedule", kind="event", name="Fire drill", args=lines(to=U("week", 1, weekday=4, time="11:00"))),
         act("reschedule", rows="$fire_drill", args=lines(to=U("week", 1, weekday=4, time="11:00")))]))

S("T16-028", "locker url reveal named notes in",
  T("which logins aren't on https://mail.google.com", rows("erp", "bkash_l", "dbbl"),
    ref=[ans(kind="locker item", where='type = "login" and url != "https://mail.google.com"')]),
  T("what's the bkash pin", diff(reveal=[("bkash_l", "58213")]),
    ref=[act("reveal", kind="locker item", name="bKash", args=lines(field="password"))]),
  T("and the erp one", diff(reveal=[("erp", "Line3-Target-1200")]),
    ref=[act("reveal", rows="$erp", args=lines(field="password"))]),
  T("which ones are tagged work or personal", rows("erp", "bkash_l", "sms_api"),
    ref=[ans(kind="locker item", where='notes in ("work", "personal")')]),
  T("the sms gateway's dead, delete that one", diff(trash("sms_api")),
    ref=[act("delete", rows="$sms_api")]))

S("T16-029", "locker trashed type delete prev notes",
  T("anything from the locker in the trash", rows("old_yahoo"),
    ref=[find(kind="locker item", trashed=True), ans(rows="@prev")]),
  T("what's the ssh key entry for", rows("server_key"),
    ref=[ans(kind="locker item", where='type = "ssh_key"')]),
  T("IT revoked it. delete it", diff(trash("server_key")),
    ref=[act("delete", rows="@prev")]),
  T("what's left with the work tag", rows("erp", "sms_api"),
    ref=[ans(kind="locker item", where='notes = "work"')]))

S("T16-030", "locker delete prev undo delete",
  T("show me my crypto wallet entry", rows("crypto"),
    ref=[ans(kind="locker item", where='type = "crypto_wallet"')]),
  T("masud moved it all to his own wallet, remove it", diff(trash("crypto")),
    ref=[act("delete", rows="@prev")]),
  T("wait undo, the seed words are in there", diff(restore("crypto")),
    ref=[act("undo")]))

S("T16-031", "reveal named wifi gmail",
  T("show me the home wifi password, guests here", diff(reveal=[("wifi", "mirpur-tigers-2026")]),
    ref=[act("reveal", kind="locker item", name="Home wifi", args=lines(field="password"))]),
  T("and the gmail one, tanvir needs to log in", diff(reveal=[("gmail", "Comilla-1978!")]),
    ref=[act("reveal", kind="locker item", name="Gmail", args=lines(field="password"))]))

S("T16-032", "notebooks rename add_to knock-on count",
  T("what notebooks have i got", rows("factory_nb", "cricket_nb", "recipes_nb", "fund_nb", "eid24_nb", "eid25_nb"),
    ref=[ans(kind="notebook")]),
  T("what's in eid 2024", rows("eid24_gifts"),
    ref=[ans(kind="note", linked_to="$eid24_nb")]),
  T("rename it Eid archive", diff(upd("eid24_nb", name="Eid archive")),
    ref=[act("edit", rows="$eid24_nb", args=lines(name="Eid archive"))]),
  T("move eid gifts 2025 in there too", diff(link("eid24_nb", "eid25_gifts"), unlink("eid25_nb", "eid25_gifts")),
    ref=[act("add_to", rows="$eid25_gifts", args=lines(to="$eid24_nb"))]),
  T("how many notes in it", val(2),
    ref=[ans(op="count", kind="note", linked_to="$eid24_nb")]))

S("T16-033", "notebook create add_to new undo link",
  T("make a notebook Eid 2026", diff(new("notebook", name="Eid 2026")),
    ref=[act("create", args=lines(kind="notebook", name="Eid 2026"))]),
  T("move the eid bazar list note in there, i'll reuse it", diff(link("+1", "eid25_list"), unlink("eid25_nb", "eid25_list")),
    ref=[act("add_to", rows="$eid25_list", args=lines(to="$c1"))]),
  T("hmm no, undo that", diff(unlink("+1", "eid25_list"), link("eid25_nb", "eid25_list")),
    ref=[act("undo")]))

S("T16-034", "create list add_to multi",
  T("make a list Winter cup, area sport", diff(new("list", name="Winter cup", area="sport")),
    ref=[act("create", args=lines(kind="list", name="Winter cup", area="sport"))]),
  T("move book abahani ground and make the fixture list into it",
    diff(link("+1", "ground_book"), link("+1", "fixtures"), unlink("cricket_l", "ground_book"), unlink("cricket_l", "fixtures")),
    ref=[act("add_to", rows="$ground_book, $fixtures", args=lines(to="$c1"))]))

S("T16-035", "list task count create list add_to",
  T("which lists have more than five tasks on them", rows("factory_l", "home_l", "kids_l", "cricket_l"),
    ref=[ans(kind="list", where="task count > 5")]),
  T("new list Eid shopping", diff(new("list", name="Eid shopping")),
    ref=[act("create", args=lines(kind="list", name="Eid shopping"))]),
  T("put order rice sack on it", diff(link("+1", "rice"), unlink("shopping_l", "rice")),
    ref=[act("add_to", rows="$rice", args=lines(to="$c1"))]))

S("T16-036", "role empty edit cadence starred within",
  T("who's in my contacts with no role", rows("anwar", "faruk", "me", "topu"),
    ref=[find(kind="person", where="role is empty"), ans(rows="@prev")]),
  T("faruk is the security guard at gate 2", diff(upd("faruk", role=has("security"))),
    ref=[act("edit", rows="$faruk", args=lines(role="security guard, gate 2"))]),
  T("anwar is my uncle in comilla", diff(upd("anwar", role=has("Comilla"))),
    ref=[act("edit", rows="$anwar", args=lines(role="uncle, Comilla"))]),
  T("who am i meant to keep up with but not every week", rows("rehana", "masud", "mizan", "karim_h", "rubina", "sharmin"),
    ref=[ans(kind="person", where="cadence != 7")]),
  T("any starred in that lot", rows("rehana"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T16-037", "task count photo count linked tasks log",
  T("who has tasks tied to them but no photos", rows("rehana", "karim_h", "kamal", "monir"),
    ref=[find(kind="person", where="task count != 0 and photo count < 1"), ans(rows="@prev")]),
  T("what's on karim hosain", rows("bonus_sheet", "hr_check"),
    ref=[find(kind="person", name="Karim Hosain"), search("karim hosain", kind="person"),
         ans(kind="task", linked_to="$karim_h")]),
  T("the rates one, when's that due", rows("hr_check"),
    ref=[ans(rows="$hr_check")]),
  T("spoke to him, log the call", diff(upd("karim_h", date=ANY)),
    ref=[act("log", rows="$karim_h", args=lines(kind="call"))]))

S("T16-038", "starred people photo count unstar",
  T("who have i starred", rows("nasrin", "abba", "amma", "rehana", "kamal", "sohel"),
    ref=[ans(kind="person", where="starred = yes")]),
  T("which of those have no photos", rows("rehana", "kamal"),
    ref=[ans(within="@prev", where="photo count < 1")]),
  T("unstar kamal bhai, he's work not family", diff(upd("kamal", starred=False)),
    ref=[act("unstar", rows="$kamal")]))

S("T16-039", "group currency empty inr",
  T("any groups with no currency set", rows(),
    ref=[ans(kind="group", where="currency is empty")]),
  T("which one's in rupees", rows("kolkata"),
    ref=[ans(kind="group", where='currency = "INR"')]))

S("T16-040", "task status empty person count description",
  T("tasks that have had their status left blank", rows(),
    ref=[ans(kind="task", where="status is empty")]),
  T("on the factory list, which open ones aren't linked to anyone", rows("needle_log", "overtime", "ppe", "target_chart"),
    ref=[ans(kind="task", linked_to="$factory_l", where='person count < 1 and status = "open"')]),
  T("the needle one, what does it say", rows("needle_log"),
    ref=[ans(rows="$needle_log")]),
  T("which tasks mention line 5", rows("needle_log"),
    ref=[ans(kind="task", where='description contains "Line 5"')]))

S("T16-041", "notes pinned person count from linked_to all",
  T("pinned notes?", rows("line3_targets", "batting", "pitha_recipe"),
    ref=[ans(kind="note", where="pinned = yes")]),
  T("unpin bhapa pitha", diff(upd("pitha_recipe", pinned=False)),
    ref=[act("edit", rows="$pitha_recipe", args=lines(pinned="no"))]),
  T("in factory floor, which notes have at most one person on them",
    rows("bonus_rates", "operators", "line3_targets", "audit_list", "rahim_feedback"),
    ref=[ans(kind="note", linked_to="$factory_nb", where="person count <= 1")]),
  T("notes since last week", rows("audit_list", "meeting_rahim", "batting", "comilla_trip", "uttara_scout", "fund_dec", "rahim_feedback"),
    ref=[ans(kind="note", when=W({"from": U("week", -1)}))]),
  T("any that mention both sohel and jewel", rows("batting"),
    ref=[ans(kind="note", linked_to="$sohel, $jewel")]))

S("T16-042", "photo album count ambiguous star album count delete",
  T("photos sitting in more than one album", rows("tanvir_bat", "wedding_group", "team_2026", "victory_lunch_p"),
    ref=[ans(kind="photo", where="album count > 1")]),
  T("star the team photo", diff(upd("team_2026", starred=True)),
    ref=[act("star", kind="photo", name="Team photo"),
         act("star", rows="$team_2026")]),
  T("which albums have under 3 pics", rows("empty_album", "wedding_album"),
    ref=[ans(kind="album", where="photo count < 3")]),
  T("delete the empty one", diff(gone("empty_album")),
    ref=[act("delete", kind="album", where="photo count = 0")]))

S("T16-043", "ambiguous photo ask unstar album count",
  T("unstar team photo", ask("team_2025", "team_2026"),
    ref=[act("unstar", kind="photo", name="Team photo"),
         find(kind="photo", name="Team photo"),
         askc("last year's team photo or the one from the dhanmondi match?", options="$team_2025, $team_2026")]),
  T("last year's", diff(upd("team_2025", starred=False)),
    ref=[act("unstar", rows="$team_2025")]),
  T("which pics are in more than one album", rows("tanvir_bat", "wedding_group", "team_2026", "victory_lunch_p"),
    ref=[ans(kind="photo", where="album count > 1")]))

S("T16-044", "album photo count remove_from photo where count",
  T("albums with fewer than three photos", rows("empty_album", "wedding_album"),
    ref=[ans(kind="album", where="photo count < 3")]),
  T("what's in salma's wedding", rows("salma_stage", "wedding_group"),
    ref=[ans(kind="photo", linked_to="$wedding_album")]),
  T("take out the one that's already in another album too", diff(unlink("wedding_album", "wedding_group")),
    ref=[act("remove_from", kind="photo", linked_to="$wedding_album", where="album count > 1",
             args=lines(from_="$wedding_album"))]),
  T("photo total in that album right now", val(1),
    ref=[ans(op="count", kind="photo", linked_to="$wedding_album")]))

S("T16-045", "remove_from photo where month linked",
  T("family album pics from september?", rows("arif_bday"),
    ref=[ans(kind="photo", linked_to="$family_album", when=W(U("month", 0, name=9)))]),
  T("take september's out of family, farzana wants it separate", diff(unlink("family_album", "arif_bday")),
    ref=[act("remove_from", kind="photo", linked_to="$family_album", when=W(U("month", 0, name=9)),
             args=lines(from_="$family_album"))]),
  T("what pics have i got of arif", rows("arif_bday", "family_dinner"),
    ref=[find(kind="photo", linked_to="$arif"), ans(rows="@prev")]))

S("T16-046", "five turns event dates description cancelled reschedule",
  T("everything in january", rows("nets_0101", "match_final", "prod_0103", "bonus_meet", "nets_0108", "rehana_visit", "pitha",
                                  "prod_0110", "cardio_jan", "nets_0115", "prod_0117", "coxs_trip", "nets_0122", "prod_0124", "nets_0129"),
    ref=[ans(kind="event", when=W(U("month", 1, name=1)))]),
  T("from this friday through next week, what's at the indoor stadium", rows("nets_1218", "match_uttara", "nets_1225"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=5), U("week", 1))), where='description = "Mirpur indoor stadium"')]),
  T("november up to fifth dec, what got cancelled", rows("nets_1120", "doctor_amma"),
    ref=[ans(kind="event", when=W(span(U("month", 0, name=11), D("2026-12-05"))), where='status = "cancelled"')]),
  T("move the electrician for the meter to twenty-third dec 4pm", diff(upd("electrician", date="2026-12-23T16:00")),
    ref=[act("reschedule", kind="event", name="Electrician for the meter", args=lines(to=D("2026-12-23", "16:00")))]),
  T("so the twenty-third has what", rows("fire_drill", "electrician"),
    ref=[ans(kind="event", when=W(D("2026-12-23")))]))

S("T16-047", "overdue complete priority span completed to month",
  T("what's overdue", rows("tv_bill"),
    ref=[ans(kind="task", when=W({"to": U("day", -1)}), where='status = "open"')]),
  T("paid the dish line on sunday, tick it", diff(upd("tv_bill", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tv_bill")]),
  T("priority one stuff due from the twentieth through january", rows("audit_prep", "dps", "bonus_sheet", "admission"),
    ref=[ans(kind="task", when=W(span(D("2026-12-20"), U("month", 1, name=1))), where="priority = 1")]),
  T("what did i finish that was due by end of november",
    rows("science_fair", "overtime_nov", "balls_2", "desco_08", "desco_09", "desco_10", "desco_11", "bua_10", "bua_11"),
    ref=[ans(kind="task", when=W({"to": U("month", 0, name=11)}), where='status = "completed"')]))

S("T16-048", "task date time span within",
  T("what's due between thursday 9am and saturday 6pm", rows("bkash", "overtime", "balls_1", "water_pump", "abba_meds", "salma_leave", "kitty_collect", "rice", "needle_log"),
    ref=[ans(kind="task", when=W(span(U("week", 0, weekday=4, time="09:00"), U("week", 0, weekday=6, time="18:00"))))]),
  T("which of those are on the factory list", rows("overtime", "needle_log"),
    ref=[ans(within="@prev", linked_to="$factory_l")]))

S("T16-049", "single debt span weekday datetime",
  T("anything owed from last monday all the way to monday at noon", rows("d_imran", "d_mizan", "d_sohel", "d_selim"),
    ref=[ans(kind="debt", when=W(span(U("week", -1, weekday=1), U("week", 0, weekday=1, time="12:00"))))]))

S("T16-050", "six turns debt create datetime rel time sum span min",
  T("lent selim 200 today for his kid's medicine",
    diff(new("debt", name=has("medicine"), amount=200, direction="owes_me"), link("new", "selim")),
    ref=[act("create", args=lines(kind="debt", name="Medicine for Selim's kid", person="$selim", amount="200",
                                  direction="owes_me"))]),
  T("and imran took 300 off me last night, cash for imran",
    diff(new("debt", amount=300, direction="owes_me"), link("new", "imran")),
    ref=[act("create", args=lines(kind="debt", name="Cash for Imran", person="$imran", amount="300",
                                  direction="owes_me"))]),
  T("how much does imran owe me altogether", val((1100, "BDT")),
    ref=[ans(op="sum", field="amount", kind="debt", linked_to="$imran", where='status = "open"')]),
  T("debts from november through fifth dec", rows("d_babu", "d_masud", "d_shafiq", "d_jewel", "d_farzana"),
    ref=[ans(kind="debt", when=W(span(U("month", 0, name=11), D("2026-12-05"))))]),
  T("any settled in there", rows("d_farzana"),
    ref=[ans(within="@prev", where='status = "settled"')]),
  T("what's the tiniest debt anyone has with me", val((200, "BDT")),
    ref=[ans(op="min", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]))
