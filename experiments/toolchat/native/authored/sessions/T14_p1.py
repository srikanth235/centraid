from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
LIVE = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
OWE = 'direction = "i_owe" and status = "open"'
LIVE_EV = 'status != "cancelled"'
def next_kleber():
    return find(kind="event", name="DJ set at Bar do Kleber", when=W({"from": U("day", 0)}), order="date asc", limit=1)
def rehearsals():
    return find(kind="event", name="Collective rehearsal", when=W({"from": U("day", 0)}))
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))
NEXT_WEEKEND = span(U("week", 1, weekday=6), U("week", 1, weekday=7))
def J(d):
    return json.dumps(d, separators=(",", ":"))
IOWE = 'direction = "i_owe" and status = "open"'


S("T14-001-P", "five turns baile tonight complete para",
  T("what've i got tonight", rows("baile_12"),
    ref=[ans(kind="event", when=W(U("day", 0)))]),
  T("lineup for it, who", rows("nath", "guga", "marcos_o", "rafa_m", "ana_paula"),
    ref=[ans(kind="person", linked_to="$baile_12")]),
  T("setlist for baile #12, finished or not", rows("setlist12"),
    ref=[ans(kind="task", name="Finish setlist for Baile #12")]),
  T("yes it's finished, mark it complete", diff(upd("setlist12", status="completed", completed=ANY)),
    ref=[act("complete", rows="$setlist12")]),
  T("i backed up usb sticks at lunch, tick it off", diff(upd("usb", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Back up USB sticks")]))

S("T14-006-P", "compute min debts group direction para",
  T("lowest open amount in both directions, my debts against what's owed me",
    vgroups({"owes_me": (40, "BRL"), "i_owe": (35, "BRL")}),
    ref=[comp(op="min", field="amount", kind="debt", where='status = "open"', group="direction"), ans(value="@prev")]),
  T("35 one, which person", rows("d_wesley"),
    ref=[ans(kind="debt", where='status = "open" and direction = "i_owe" and amount = 35 BRL')]))

S("T14-012-P", "event create reschedule new overlap para",
  T("next friday 3pm, set up a b2b rehearsal with guga", diff(new("event", name=has("rehearsal"), date="2026-10-30T15:00")),
    ref=[act("create", args=lines(kind="event", name="B2B rehearsal with Guga", date=U("week", 1, weekday=5, time="15:00")))]),
  T("one hour later for it", diff(upd("+1", date="2026-10-30T16:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("hour", 1, anchor="row")))]),
  T("and what else does that friday hold", rows("kleber_1030"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=5)), exclude="$c1")]))

S("T14-017-P", "edit note named ambiguous note para",
  T("pharmacy list note needs 'extension cord for the booth' added", ask("pharm_1", "pharm_2"),
    ref=[act("edit", kind="note", name="Pharmacy list", args=lines(body="extension cord for the booth")),
         find(kind="note", name="Pharmacy list"),
         askc("there are two pharmacy list notes, the one in mom's health or the loose one?", options="$pharm_1, $pharm_2")]),
  T("wait, wrong place. body of the setlist baile #twelve note is where it goes",
    diff(upd("set12", body=has("extension cord"))),
    ref=[opn("$set12"),
         act("edit", kind="note", name="Setlist Baile #12",
             args=lines(body="open with baile funk edits, 128 into amapiano, close with Tim Maia. extension cord for the booth"))]))

S("T14-022-P", "star photo multi para",
  T("give stars to nath and guga in the booth plus the collective group photo",
    diff(upd("b11_booth", starred=True), upd("b11_team", starred=True)),
    ref=[act("star", rows="$b11_booth, $b11_team")]),
  T("starred photos, count?", val(7),
    ref=[ans(op="count", kind="photo", where="starred = yes")]))

S("T14-030-P", "locker create star unstar new para",
  T("create a locker entry Serato login with username djtomasf, and give it a star",
    diff(new("locker item", name="Serato login", username="djtomasf", starred=True)),
    ref=[act("create", more=True, args=lines(kind="locker item", name="Serato login", type="login", username="djtomasf")),
         act("star", rows="$new")]),
  T("nah remove the star again, barely use serato", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]),
  T("starred logins?", rows("uber_login"),
    ref=[ans(kind="locker item", where='type = "login" and starred = yes')]))

S("T14-035-P", "find ambiguous note ask delete para",
  T("pharmacy list is done with, delete it", ask("pharm_1", "pharm_2"),
    ref=[find(kind="note", name="Pharmacy list"),
         act("delete", kind="note", name="Pharmacy list"),
         askc("two of them: the one in mom's health or the loose one?", options="$pharm_1, $pharm_2")]),
  T("loose", diff(trash("pharm_2")),
    ref=[act("delete", rows="$pharm_2")]))

S("T14-040-P", "photo count eq para",
  T("contacts appearing in two photos exactly", rows("nath", "rafa_m", "thiago", "wesley"),
    ref=[find(kind="person", where="photo count = 2"), ans(rows="@prev")]),
  T("wesley santos's photos?", rows("football", "haircut_p"),
    ref=[ans(kind="photo", linked_to="$wesley")]))

S("T14-047-P", "debt amount empty status in para",
  T("debts with the amount left blank", rows(),
    ref=[ans(kind="debt", where="amount is empty")]),
  T("all my debts to others, settled or open", rows("d_junior", "d_nath", "d_patricia", "d_larissa", "d_wesley", "d_marcos_t"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status in ("open", "settled")')]))

S("T14-052-P", "person datetime span log settle_up para",
  T("tuesday 6pm to thursday, who've i spoken with", rows("patricia", "rafa_m", "nath", "mae", "thiago"),
    ref=[find(kind="person", when=W(span(U("week", 0, weekday=2, time="18:00"), U("week", 0, weekday=4)))), ans(rows="@prev")]),
  T("mother, sister or cousin among them?", rows("patricia", "mae", "thiago"),
    ref=[ans(within="@prev", where='role in ("sister", "mother", "cousin")')]),
  T("rang patrícia again, record it", diff(upd("patricia", date=ANY)),
    ref=[act("log", rows="$patricia", args=lines(kind="call"))]),
  T("patrícia ferreira, settle up in mãe's medical bills too", diff(settle=[("Patrícia Ferreira", "50.00")]),
    ref=[act("settle_up", rows="$patricia", args=lines(group="$mae_g"))]))

S("T14-058-P", "overdue write+read reschedule empty para",
  T("overdue items?", rows("rating", "gas"),
    ref=[ans(kind="task", when=W({"to": U("day", -1)}), where='status = "open"')]),
  T("gas done, what is still overdue after that", rows("rating", also=diff(upd("gas", status="completed", completed=ANY))),
    ref=[act("complete", rows="$gas", more=True),
         ans(kind="task", when=W({"to": U("day", -1)}), where='status = "open"')]),
  T("check uber rating dispute should be monday", diff(upd("rating", date="2026-10-26")),
    ref=[act("reschedule", rows="$rating", args=lines(to=U("week", 1, weekday=1)))]),
  T("overdue ones now, any", rows(),
    ref=[ans(kind="task", when=W({"to": U("day", -1)}), where='status = "open"')]))

S("T14-064-P", "document august span folder remove undo link para",
  T("docs between august and sept twentieth", rows("blood_doc", "das_aug", "ins_policy", "rx", "das_sep"),
    ref=[find(kind="document", when=W(span(U("month", 0, name=8), D("2026-09-20")))), ans(rows="@prev")]),
  T("das august receipt sits in what folder", rows("mei_f"),
    ref=[ans(kind="folder", linked_to="$das_aug")]),
  T("das august receipt shouldn't be in mei taxes, remove it", diff(unlink("mei_f", "das_aug")),
    ref=[act("remove_from", rows="$das_aug", args=lines(from_="$mei_f"))]),
  T("it belongs there after all, undo", diff(link("mei_f", "das_aug")),
    ref=[act("undo")]),
  T("mei taxes, document count?", val(3),
    ref=[ans(op="count", kind="document", linked_to="$mei_f")]))

S("T14-069-P", "debt last friday within settle prev undo ledger para",
  T("debts dated last friday", rows("d_rafa_s", "d_kleber"),
    ref=[ans(kind="debt", when=W(U("week", -1, weekday=5)))]),
  T("kleber's one", rows("d_kleber"),
    ref=[ans(within="@prev", linked_to="$kleber")]),
  T("he's paid up, mark it settled", diff(upd("d_kleber", status="settled")),
    ref=[act("settle_debt", rows="@prev")]),
  T("the pix bounced, so undo it", diff(),
    ref=[act("undo")]))

S("T14-075-P", "document create star unstar new para",
  T("gig contracts gets a new doc, Niceto tech sheet, and give it a star",
    diff(new("document", name="Niceto tech sheet", starred=True), link("contracts_f", "new")),
    ref=[act("create", more=True, args=lines(kind="document", name="Niceto tech sheet", folder="$contracts_f")),
         act("star", rows="$new")]),
  T("guga's got the final one, so remove that star", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]))

S("T14-086-P", "weekend status set duration set reschedule ambiguous ask para",
  T("this weekend, anything confirmed or tentative", rows("baile_12", "regina_lunch"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))), where="status is set")]),
  T("duration of lunch with larissa's parents", rows("regina_lunch"),
    ref=[ans(kind="event", name="Lunch with Larissa's parents")]),
  T("next weekend, events that have a duration set", rows("landlord", "lunch_mae"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=6), U("week", 1, weekday=7))), where="duration is set")]),
  T("dj set at bar do kleber should start at 11pm", ask("kleber_1030", "kleber_1113"),
    ref=[find(kind="event", name="DJ set at Bar do Kleber", when=W({"from": U("day", 0)})),
         act("reschedule", kind="event", name="DJ set at Bar do Kleber", args=lines(to=U("day", 0, anchor="row", time="23:00"))),
         askc("next friday's or the one on nov 13?", options="$kleber_1030, $kleber_1113")]))

S("T14-096-P", "six turns ambiguous folder refused delete move para",
  T("car folder, get rid of it", ask("car_docs_f", "car_pool_f"),
    ref=[act("delete", kind="folder", name="car"),
         askc("car documents or car pool receipts?", options="$car_docs_f, $car_pool_f")]),
  T("pool receipts", ask(),
    ref=[bad(act("delete", rows="$car_pool_f")),
         askc("it still has the fuel receipts and the tyre invoice in it. move them to car documents first?")]),
  T("yes shift them across, remove the folder, then list car documents",
    rows("crlv", "cnh_doc", "ins_policy", "fuel_rcpt", "tyre_rcpt",
         also=diff(unlink("car_pool_f", "fuel_rcpt"), unlink("car_pool_f", "tyre_rcpt"), link("car_docs_f", "fuel_rcpt"),
                   link("car_docs_f", "tyre_rcpt"), gone("car_pool_f"))),
    ref=[find(kind="document", linked_to="$car_pool_f"),
         act("add_to", rows="@prev", args=lines(to="$car_docs_f"), more=True),
         act("delete", rows="$car_pool_f", more=True),
         ans(kind="document", linked_to="$car_docs_f")]),
  T("scans to sort has nothing in it, right? delete that as well", diff(gone("empty_f")),
    ref=[act("delete", rows="$empty_f")]),
  T("folder count now?", val(5),
    ref=[ans(op="count", kind="folder")]))

S("T14-A001-P", "ask-options event cancel c3a para",
  T("set at kleber's is off", ask("kleber_1030", "kleber_1113"),
    ref=[act("cancel", kind="event", name="DJ set at Bar do Kleber"),
         find(kind="event", name="DJ set at Bar do Kleber", when=J({"from": U("day", 0)})),
         askc("The one on 30 Oct or the one on 13 Nov?", options="$kleber_1030, $kleber_1113")]),
  T("i'm in sampa on the 30th so the 13th", diff(upd("kleber_1113", status="cancelled")),
    ref=[act("cancel", rows="$kleber_1113")]))

S("T14-A008-P", "follow-up c3a para",
  T("what i owe, list it", rows("d_wesley", "d_junior", "d_nath", "d_marcos_t", "d_patricia"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("same list minus the haircut", rows("d_marcos_t", "d_patricia", "d_junior", "d_nath"),
    ref=[ans(within="@prev", exclude="$d_wesley")]),
  T("largest of them", rows("d_junior"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T14-B004-P", "c4b state-change complete complete create contrast para",
  T("juninho's tyres, paid", diff(upd("tyre_pay", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Juninho tyres")]),
  T("otavio got his receipts from me", diff(upd("otavio_receipt", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="receipts")]),
  T("new task, call jhonatan about the wash", diff(new("task", name=has("Jhonatan"))),
    ref=[act("create", args=lines(kind="task", name="Call Jhonatan about the wash"))]))

S("T14-C002-P", "c3c compound complete reschedule next weekday para",
  T("grab rail install goes to next saturday, and tick off mom's heart meds, they're bought",
    diff(upd("mae_meds", status="completed", completed=ANY), upd("mae_rail", date="2026-10-31")),
    ref=[act("complete", kind="task", name="Buy Mom's heart meds", more=True),
         act("reschedule", kind="task", name="Install grab rail in Mom's bathroom", args=lines(to=U("week", 1, weekday=6)))]))

S("T14-C902-P", "c3c cell7 rejected delete folder with documents then delete empty one para",
  T("car documents folder, remove it", ask(),
    ref=[bad(act("delete", kind="folder", name="Car documents")), askc("car documents still has 3 documents in it, so it can't be deleted. move them first?")]),
  T("fine, only the empty one then", diff(gone("empty_f")),
    ref=[act("delete", kind="folder", where="document count = 0")]))

S("T14-106-P", "ask options marcos star balance negative para",
  T("marcos gets a star", ask("marcos_o", "marcos_t"),
    ref=[act("star", kind="person", name="Marcos"),
         askc("marcos oliveira the dj or marcos tavares the mechanic?", options="$marcos_o, $marcos_t")]),
  T("the mechanic one", diff(upd("marcos_t", starred=True)),
    ref=[act("star", rows="$marcos_t")]),
  T("what do i still owe him", val((-250, "BRL")),
    ref=[ans(op="balance", rows="$marcos_t")]))

S("T14-111-P", "ask options cardiology cancel never mind undo para",
  T("mom's cardiology appointment is off", ask("cardio_sep", "cardio_nov"),
    ref=[act("cancel", kind="event", name="Mom's cardiology appointment"),
         find(kind="event", name="Mom's cardiology appointment"),
         askc("the one on sep 15 or the one on nov 3?", options="$cardio_sep, $cardio_nov")]),
  T("dra helena's away that day, so november", diff(upd("cardio_nov", status="cancelled")),
    ref=[act("cancel", rows="$cardio_nov")]),
  T("she messaged, she's back, so undo that", diff(),
    ref=[act("undo")]))

S("T14-116-P", "weekend cancel next weekend count refused unit para",
  T("regina this weekend, lunch is off, cancel what i've got with her", diff(upd("regina_lunch", status="cancelled")),
    ref=[act("cancel", kind="event", linked_to="$regina", when=W(WEEKEND))]),
  T("next weekend, count of things longer than two hours", val(1),
    ref=[bad(ans(op="count", kind="event", when=W(NEXT_WEEKEND), where="duration > 2 hours")),
         ans(op="count", kind="event", when=W(NEXT_WEEKEND), where="duration > 120")]))

S("T14-123-P", "ask options campos log out of scope para",
  T("told campos we're coming sunday, log that message", ask("larissa", "regina"),
    ref=[act("log", kind="person", name="Campos", args=lines(kind="message")),
         askc("larissa or regina?", options="$larissa, $regina")]),
  T("regina, about lunch at one", diff(upd("regina", date=ANY)),
    ref=[act("log", rows="$regina", args=lines(kind="message"))]),
  T("find cheap flights to buenos aires for december", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))
