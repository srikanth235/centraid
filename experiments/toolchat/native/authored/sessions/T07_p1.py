from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T07-001-P", "events tomorrow edit description span count para",
  T("tomorrow's plan?", rows("seed_delivery", "land_tax"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("seed one: jot down sonia brings 40 sacks", diff(upd("seed_delivery", description="Sonia brings 40 sacks")),
    ref=[act("edit", rows="$seed_delivery", args=lines(description="Sonia brings 40 sacks"))]),
  T("saturday through sunday night, what's on", rows("asm_0314", "mass_0315", "vcall_0315"),
    ref=[ans(kind="event", when=W(span(U("day", 2), U("week", 0, weekday=7))))]),
  T("rehearsals remaining from 7 tonight, count", val(7),
    ref=[ans(op="count", kind="event", name="Choir rehearsal", when=W({"from": U("day", 0, time="19:00")}))]))

S("T07-008-P", "choir remove_from where soprano balance para",
  T("remove carmen from the choir group, she's leaving", diff(unlink("choir_g", "carmen")),
    ref=[act("remove_from", kind="person", name="carmen", linked_to="$choir_g", args=lines(from_="$choir_g"))]),
  T("remaining members?", rows("rosa_c", "lucia", "jaime", "alfredo", "me"),
    ref=[ans(kind="person", linked_to="$choir_g")]),
  T("lucia's balance in the choir group?", val((-10, "PEN")),
    ref=[ans(op="balance", kind="group", name="San Blas choir", linked_to="$lucia")]))

S("T07-013-P", "task where reschedule linked para",
  T("tasks involving hugo?", rows("hugo_email", "trial_data"),
    ref=[ans(kind="task", linked_to="$hugo")]),
  T("the email one should move to next tuesday 9am", diff(upd("hugo_email", date="2026-03-17T09:00")),
    ref=[act("reschedule", kind="task", linked_to="$hugo", where="effort < 30",
             args=lines(to=U("week", 1, weekday=2, time="09:00")))]),
  T("what other things are due that tuesday", rows("agro_bank", "agro_title"),
    ref=[ans(kind="task", when=W(U("week", 1, weekday=2)), exclude="$hugo_email")]))

S("T07-019-P", "restore photo where para",
  T("monday i deleted a photo of the lesions by mistake, restore it", diff(restore("blurry")),
    ref=[act("restore", kind="photo", trashed=True, when=W(U("week", 0, weekday=1)))]),
  T("albums containing it?", rows(),
    ref=[ans(kind="album", linked_to="$blurry")]))

S("T07-023-P", "event overlap repair reschedule para",
  T("next wednesday at 7pm i want a call with hugo in the diary", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Call with Hugo", date=U("week", 1, weekday=3, time="19:00")))),
         askc("next wednesday 7pm clashes with choir rehearsal. another time?")]),
  T("how about thursday at 4", diff(new("event", name="Call with Hugo", date="2026-03-19T16:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Hugo", date=U("week", 1, weekday=4, time="16:00")))]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T07-028-P", "album find delete prev empty add_to para",
  T("expo album, locate it", rows("expo_al"),
    ref=[find(kind="album", name="Expo"), ans(rows="@prev")]),
  T("the pics are in harvest anyway, so wipe it",
    diff(gone("expo_al"), unlink("expo_al", "e_stand"), unlink("expo_al", "e_ribbon")),
    ref=[act("delete", rows="@prev")]),
  T("stand photo, in some album?", rows(),
    ref=[ans(kind="album", linked_to="$e_stand")]),
  T("harvest 2025 is where it goes", diff(link("harvest_al", "e_stand")),
    ref=[act("add_to", rows="$e_stand", args=lines(to="$harvest_al"))]))

S("T07-034-P", "notes date spans linked_to all add_to note para",
  T("notes written between the first at 9am and the ninth at 6pm",
    rows("raffle_notes", "seed_2026", "soil_notes", "loan_notes", "julio_gifts", "vale_courses", "prices"),
    ref=[ans(kind="note", when=W(span(D("2026-03-01", "09:00"), D("2026-03-09", "18:00"))))]),
  T("notes mentioning teodoro and rosa mamani together", rows("feb_min"),
    ref=[ans(kind="note", linked_to="$teodoro, $rosa_m")]),
  T("field notes should hold the note about the frost", diff(link("field_nb", "frost")),
    ref=[act("add_to", kind="note", name="Thoughts after the frost", args=lines(to="$field_nb"))]),
  T("notes dated before january ended", rows("natives", "chuno", "ocopa", "huancaina", "trial_plan", "seating", "seed_2025"),
    ref=[ans(kind="note", when=W({"to": U("month", 0, name=1)}))]))

S("T07-040-P", "document create unstar new folder prev para",
  T("starred and filed in the loan folder: a new doc called Agrobanco approval letter",
    diff(new("document", name="Agrobanco approval letter", starred=True), link("loan_f", "new")),
    ref=[act("create", more=True, args=lines(kind="document", name="Agrobanco approval letter", folder="$loan_f")),
         act("star", rows="$new")]),
  T("it's just the draft, so remove its star", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]),
  T("starred items in that folder?", rows("title"),
    ref=[ans(kind="document", linked_to="$loan_f", where="starred = yes")]))

S("T07-046-P", "task reschedule anchor edit undo field para",
  T("irrigation check should slip two days", diff(upd("irrigation", date="2026-03-16")),
    ref=[act("reschedule", kind="task", name="irrigation", args=lines(to=U("day", 2, anchor="row")))]),
  T("efrain's doing it since he knows the channel, put that in the notes", diff(upd("irrigation", description="Efrain is doing it, he knows the channel")),
    ref=[act("edit", rows="$irrigation", args=lines(description="Efrain is doing it, he knows the channel"))]),
  T("undo what you just did", diff(upd("irrigation", description=None)),
    ref=[act("undo")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T07-059-P", "note ambiguous seed order pin move undo link para",
  T("seed order note gets pinned", ask("seed_2025", "seed_2026"),
    ref=[act("edit", kind="note", name="Seed order", args=lines(pinned="yes")),
         find(kind="note", name="Seed order"),
         askc("the one from last september or this month's?", options="$seed_2025, $seed_2026")]),
  T("september's, the old one", diff(upd("seed_2025", pinned=True)),
    ref=[act("edit", rows="$seed_2025", args=lines(pinned="yes"))]),
  T("also put it in field notes", diff(unlink("coop_nb", "seed_2025"), link("field_nb", "seed_2025")),
    ref=[act("add_to", rows="$seed_2025", args=lines(to="$field_nb"))]),
  T("scrap the last step, undo it", diff(link("coop_nb", "seed_2025"), unlink("field_nb", "seed_2025")),
    ref=[act("undo")]))

S("T07-067-P", "misspelled search recover log tasks reschedule para",
  T("last time i saw efrain cahuana?", rows("efrain"),
    ref=[ans(kind="person", name="Cahuana"), search("cahuana", kind="person"), ans(rows="$efrain")]),
  T("he dropped by, record a visit", diff(upd("efrain", date=ANY)),
    ref=[act("log", rows="$efrain", args=lines(kind="visit"))]),
  T("his tasks?", rows("irrigation", "scout_report"),
    ref=[ans(kind="task", linked_to="$efrain")]),
  T("scouting report slips three days", diff(upd("scout_report", date="2026-03-19")),
    ref=[act("reschedule", rows="$scout_report", args=lines(to=U("day", 3, anchor="row")))]),
  T("people silent since before february", rows("fortunata", "ana", "raul"),
    ref=[ans(kind="person", when=W({"to": U("month", -2)}))]))

S("T07-071-P", "mass cancel already palm sunday para",
  T("choir mass this sunday, on?", rows("mass_0315"),
    ref=[ans(kind="event", name="Sunday mass", when=W(U("week", 0)))]),
  T("mass is off since padre alfredo is away: cancel it", diff(upd("mass_0315", status="cancelled")),
    ref=[act("cancel", rows="$mass_0315")]),
  T("not sure that stuck, cancel it again", diff(already=["mass_0315"]),
    ref=[act("cancel", rows="$mass_0315"), ans(rows="$mass_0315")]),
  T("palm sunday procession time?", rows("palm"),
    ref=[ans(kind="event", name="Palm Sunday procession")]),
  T("who's taking part?", rows("alfredo"),
    ref=[ans(kind="person", linked_to="$palm")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T07-076-P", "people met within group count log task count para",
  T("which contacts did i first meet at the coop assembly", rows("teodoro", "rosa_m", "efrain", "wilber"),
    ref=[ans(kind="person", where='met = "Coop assembly"')]),
  T("among them, those in at least two groups", rows("teodoro"),
    ref=[ans(kind="person", within="@prev", where="group count >= 2")]),
  T("teodoro apaza and i spoke, put that in the log as a call", diff(upd("teodoro", date=ANY)),
    ref=[act("log", kind="person", name="Teodoro Apaza", args=lines(kind="call"))]),
  T("people with at least two tasks tied to them", rows("valeria", "hugo", "teodoro", "efrain"),
    ref=[ans(kind="person", where="task count >= 2")]))

S("T07-081-P", "note remove_from where notebook count add_to named write read para",
  T("pinned note leaves the choir notebook", diff(unlink("choir_nb", "repertoire")),
    ref=[act("remove_from", kind="note", linked_to="$choir_nb", where="pinned = yes", args=lines(from_="$choir_nb"))]),
  T("notes outside any notebook, count", val(4),
    ref=[ans(op="count", kind="note", where="notebook count = 0")]),
  T("things to ask hugo goes into field notes, then list field notes",
    rows("seed_2026", "blight_log", "trial_plan", "soil_notes", "rain", "natives", "hugo_qs", also=diff(link("field_nb", "hugo_qs"))),
    ref=[act("add_to", kind="note", name="Things to ask Hugo", args=lines(to="$field_nb"), more=True),
         ans(kind="note", linked_to="$field_nb")]))

S("T07-086-P", "list empty recovery edit where area tasks para",
  T("family list's new name is Vale", diff(upd("vale_l", name="Vale")),
    ref=[find(kind="list", name="family"),
         act("edit", kind="list", where='area = "family"', args=lines(name="Vale"))]),
  T("lists outside the church and farm areas", rows("coop_l", "home_l", "vale_l"),
    ref=[ans(kind="list", where='area != "church" and area != "farm"')]),
  T("vale's open tasks", rows("rent_mar", "vale_box", "vale_fees", "vale_laptop"),
    ref=[ans(kind="task", linked_to="$vale_l", where='status = "open"')]),
  T("pay valeria's tuition is now due on the twenty-fifth", diff(upd("vale_fees", date="2026-03-25")),
    ref=[act("reschedule", kind="task", name="Pay Valeria's tuition", args=lines(to=D("2026-03-25")))]),
  T("valeria's rent this month?", rows("rent_mar"),
    ref=[ans(kind="task", name="Pay Valeria's rent", when=W(U("month", 0)))]))

S("T07-091-P", "photo spans linked already ask para",
  T("photos between first march and this monday", rows("rainbow", "t_spray", "v_lab", "t_flowers"),
    ref=[ans(kind="photo", when=W(span(D("2026-03-01"), U("week", 0, weekday=1))))]),
  T("january to last sunday, how many photos", val(15),
    ref=[ans(op="count", kind="photo", when=W(span(U("month", 0, name=1), U("week", -1, weekday=7))))]),
  T("valeria's photos dated before first feb at 8am", rows("h_vale"),
    ref=[ans(kind="photo", linked_to="$valeria", when=W({"to": D("2026-02-01", "08:00")}))]),
  T("give it a star", diff(already=["h_vale"]),
    ref=[act("star", rows="$h_vale"), ans(rows="$h_vale")]),
  T("soil lab photo gets a star as well", diff(upd("v_lab", starred=True)),
    ref=[act("star", kind="photo", name="soil lab")]))

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T07-A002-P", "ask-options event reschedule c3a para",
  T("marco thing should be friday", ask("marco_call", "marco_visit"),
    ref=[act("reschedule", kind="event", name="marco", args=lines(to=U("week", 0, weekday=5))),
         askc("The video call with Marco today or his visit to the plots on 17 Apr?", options="$marco_call, $marco_visit")]),
  T("i'm out in the field today, it's the call", diff(upd("marco_call", date="2026-03-13T16:00")),
    ref=[act("reschedule", rows="$marco_call", args=lines(to=U("week", 0, weekday=5)))]))

S("T07-A006-P", "ask-options note delete c3a para",
  T("seed order note, wipe it", ask("seed_2025", "seed_2026"),
    ref=[act("delete", kind="note", name="Seed order"),
         find(kind="note", name="Seed order"),
         askc("The 2025 seed order or the 2026 one?", options="$seed_2025, $seed_2026")]),
  T("that season's over, so 2025's goes", diff(trash("seed_2025")),
    ref=[act("delete", rows="$seed_2025")]),
  T("luis gets a star", diff(upd("luis", starred=True)),
    ref=[act("star", kind="person", name="Luis")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

OPEN = 'status = "open"'

OWED = 'direction = "owes_me" and status = "open"'

S("T07-B004-P", "c4b state-change complete task create contrast para",
  T("water bill is paid", diff(upd("water_bill", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="water bill")]),
  T("report's done as well", diff(upd("scout_report", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="report")]),
  T("gas company call about the cylinder needs adding as a task", diff(new("task", name=has("gas"))),
    ref=[act("create", args=lines(kind="task", name="Call the gas company about the cylinder"))]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T07-102-P", "star treasurer where unstar balance prev para",
  T("coop treasurer gets a star", diff(upd("rosa_m", starred=True)),
    ref=[act("star", kind="person", where='role contains "treasurer"')]),
  T("teodoro isn't really a favourite anymore, remove his star", diff(upd("teodoro", starred=False)),
    ref=[act("unstar", kind="person", name="Teodoro")]),
  T("her debt to me?", val((20, "PEN")),
    ref=[ans(op="balance", rows="$rosa_m")]))

S("T07-107-P", "bill task complete ask pick reopen long para",
  T("bill task is done", diff(upd("water_bill", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="bill")]),
  T("the payment bounced yesterday and the bank says try again after the weekend, which means the electricity one is open again",
    diff(upd("elec_bill", status="open", completed=None)),
    ref=[act("reopen", rows="$elec_bill")]))

S("T07-111-P", "february bill doc star ask pick multi star unstar para",
  T("february bill gets a star", ask("water_doc", "elec_doc"),
    ref=[act("star", kind="document", name="bill February"),
         askc("water bill february or electricity bill february?", options="$water_doc, $elec_doc")]),
  T("the electricity one", diff(upd("elec_doc", starred=True)),
    ref=[act("star", rows="$elec_doc")]),
  T("coop register gets a star, statutes lose theirs",
    diff(upd("register", starred=True), upd("statutes", starred=False)),
    ref=[act("star", kind="document", name="Coop register", more=True),
         act("unstar", kind="document", name="Coop statutes")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T07-116-P", "seed receipt cross kind delete ask pick undo never_mind para",
  T("seed receipt can go, wipe it", ask("seed_receipt", "receipt_pic"),
    ref=[askc("the receipt document from sonia or the photo of it?", options="$seed_receipt, $receipt_pic")]),
  T("photo", diff(trash("receipt_pic")),
    ref=[act("delete", rows="$receipt_pic")]),
  T("changed my mind, put it back", diff(restore("receipt_pic")),
    ref=[act("undo")]))

S("T07-121-P", "gmail agrobanco reveal named not_found task para",
  T("gmail's password?", diff(reveal=[("gmail", "huayro-rojo-77")]),
    ref=[act("reveal", kind="locker item", name="Gmail", args=lines(field="password"))]),
  T("agrobanco's too", diff(reveal=[("agro_login", "Papa-Andina-40k")]),
    ref=[act("reveal", kind="locker item", name="Agrobanco", args=lines(field="password"))]),
  T("tractor rental task, wipe it", decline("not_found"),
    ref=[find(kind="task", name="tractor rental"), search("tractor rental", kind="task"), dec("not_found")]),
  T("also need a task about looking for a tractor rental, friday", diff(new("task", name=has("tractor"), date="2026-03-13")),
    ref=[act("create", args=lines(kind="task", name="Look for a tractor rental", date=U("week", 0, weekday=5)))]))

S("T07-126-P", "group balance coop efrain wilber para",
  T("efrain's balance in the coop?", val((-200, "PEN")),
    ref=[ans(op="balance", kind="group", name="coop", linked_to="$efrain")]),
  T("wilber?", val((-400, "PEN")),
    ref=[ans(op="balance", kind="group", name="coop", linked_to="$wilber")]),
  T("efrain visited the plots this morning, log it as a visit", diff(upd("efrain", date=ANY)),
    ref=[act("log", rows="$efrain", args=lines(kind="visit"))]))
