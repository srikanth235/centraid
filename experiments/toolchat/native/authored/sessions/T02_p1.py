from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T02-001-P", "events reschedule edit follow-up para",
  T("tomorrow's plans?", rows("call_marcus"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("shift it to 11", diff(upd("call_marcus", date="2027-06-09T11:00")),
    ref=[act("reschedule", rows="$call_marcus", args=lines(to=U("day", 1, time="11:00")))]),
  T("in the description, write bring the colour roughs",
    diff(upd("call_marcus", description="bring the colour roughs")),
    ref=[act("edit", rows="$call_marcus", args=lines(description="bring the colour roughs"))]),
  T("wed noon till saturday, what other stuff is there",
    rows("mf_kickoff", "pottery_0610", "portfolio_review", "farmers", "gallery"),
    ref=[ans(kind="event", when=W({"from": U("week", 0, weekday=3, time="12:00"), "to": U("week", 0, weekday=6)}))]),
  T("events this week whose description is set but isn't the standard pottery line", rows("call_marcus", "mf_kickoff"),
    ref=[ans(kind="event", when=W(U("week", 0)),
             where='description is set and description != "wheel throwing, Clay Studio on Main"')]))

S("T02-005-P", "invoices narrowing order limit complete para",
  T("open invoices, list them", rows("inv_gl_final", "inv_mf", "inv_tide_cover"),
    ref=[search("invoice", kind="task"), ans(kind="task", name="Invoice", where='status = "open"')]),
  T("earliest due date among them?", rows("inv_mf"),
    ref=[ans(within="@prev", order="date asc", limit=1)]),
  T("this morning i sent it, so mark it complete", diff(upd("inv_mf", status="completed", completed=ANY)),
    ref=[act("complete", rows="$inv_mf")]))

S("T02-010-P", "ambiguity ask then pick anchor row para",
  T("change dim sum to 12", ask("dimsum_jun", "dimsum_grace"),
    ref=[act("reschedule", kind="event", name="Dim sum", when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 0, anchor="row", time="12:00"))),
         askc("which dim sum, with your parents on sunday or with grace on the 20th?",
              options="$dimsum_jun, $dimsum_grace")]),
  T("my parents' one", diff(upd("dimsum_jun", date="2027-06-13T12:00")),
    ref=[act("reschedule", rows="$dimsum_jun", args=lines(to=U("day", 0, anchor="row", time="12:00")))]),
  T("lunch with grace, still happening?", rows("dimsum_grace"),
    ref=[ans(kind="event", name="Lunch with Grace"), search("grace", kind="event"), ans(rows="$dimsum_grace")]))

S("T02-015-P", "ask then never_mind para",
  T("tasks for mom, list them", rows("mom_gift"),
    ref=[ans(kind="task", name="Mom")]),
  T("auntie ivy, any tasks", rows("thankyou"),
    ref=[search("auntie ivy"), ans(kind="task", linked_to="$ivy")]),
  T("forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T02-020-P", "folder create document add_to para",
  T("i need a folder named Fox book", diff(new("folder", name="Fox book")),
    ref=[act("create", args=lines(kind="folder", name="Fox book"))]),
  T("stick the book dummy inside it",
    diff(unlink("portfolio_f", "dummy"), link("+1", "dummy")),
    ref=[act("add_to", kind="document", name="Fox courier picture book dummy", args=lines(to="$new"))]),
  T("album for the fox book, exists yet?", ask(),
    ref=[ans(kind="album", name="Fox"),
         askc("no fox album yet, just the folder and the dummy. want me to make one?")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T02-026-P", "person edit repair decline star para",
  T("call kai KC from now on", diff(upd("kai", nickname="KC")),
    ref=[act("edit", rows="$kai", args=lines(nickname="KC"))]),
  T("his phone number is 604 555 0192, save that too", decline("out_of_scope"),
    ref=[bad(act("edit", rows="$kai", args=lines(phone="604 555 0192"))),
         dec("out_of_scope")]),
  T("fine, he gets a star then", diff(upd("kai", starred=True)),
    ref=[act("star", rows="$kai")]),
  T("which other people have a nickname that isn't KC", rows("arun", "mom", "dad", "ivy", "tom", "diego"),
    ref=[ans(kind="person", where='nickname is set and nickname != "KC"')]))

S("T02-032-P", "event cancel delete restore para",
  T("the dentist on the seventeenth, cancel it, i'll rebook", diff(upd("dentist", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dentist cleaning")]),
  T("tomo launch party, wipe it completely", diff(trash("tomo_launch")),
    ref=[act("delete", kind="event", name="Tomo Coffee launch party")]),
  T("tom might reschedule, so on reflection restore the launch party", diff(restore("tomo_launch")),
    ref=[act("restore", rows="$tomo_launch")]),
  T("tom said it's definitely off, so undo that", diff(trash("tomo_launch")),
    ref=[act("undo")]),
  T("calendar trash contents?", rows("zine_fair", "coffee_siobhan", "open_house", "tomo_launch"),
    ref=[ans(kind="event", trashed=True)]),
  T("zine fair table needs to come back out of the trash", ask(),
    ref=[bad(act("restore", kind="event", name="Zine fair table", trashed=True)),
         askc("the zine fair's been in the bin too long to restore. want me to add it again as a new event?")]))

S("T02-040-P", "document create edit delete para",
  T("new document Tomo kill fee invoice, file it in contracts",
    diff(new("document", name="Tomo kill fee invoice"), link("contracts", "new")),
    ref=[act("create", args=lines(kind="document", name="Tomo kill fee invoice", folder="$contracts"))]),
  T("its name should be Tomo kill fee invoice 2027-014", diff(upd("+1", name="Tomo kill fee invoice 2027-014")),
    ref=[act("edit", rows="$new", args=lines(name="Tomo kill fee invoice 2027-014"))]),
  T("give it a star", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("wrong template, so wipe it. then what else is in contracts",
    rows("gl_contract", "mf_contract", "tide_contract", "tomo_nda", also=diff(trash("+1"))),
    ref=[act("delete", rows="$new", more=True), ans(kind="document", linked_to="$contracts")]),
  T("the kill fee doc: trashed or permanently gone?", rows("+1"),
    ref=[ans(kind="document", name="Tomo kill fee invoice"),
         ans(kind="document", name="Tomo kill fee invoice", trashed=True)]))

S("T02-045-P", "debt create repair enum balance para",
  T("jess okoro owes me 23.50 for pizza on friday, put that in as a debt",
    diff(new("debt", name=has("pizza"), amount=23.5, direction="owes_me"), link("new", "jess")),
    ref=[bad(act("create", args=lines(kind="debt", name="Pizza", person="$jess", amount="23.50", direction="owed_to_me"))),
         act("create", args=lines(kind="debt", name="Pizza", person="$jess", amount="23.50", direction="owes_me"))]),
  T("jess's total debt to me?", val((88.60, "CAD")),
    ref=[ans(op="balance", rows="$jess")]),
  T("number of open debts linked to a person?", val(10),
    ref=[ans(op="count", kind="debt", where='status = "open" and person count > 0')]),
  T("her debts to me dating from before last friday", rows("d_jess_hydro"),
    ref=[ans(kind="debt", linked_to="$jess", when=W({"to": U("week", -1, weekday=5)}))]))

S("T02-050-P", "list create task create in list para",
  T("picture book pitch needs its own list, area work",
    diff(new("list", name=has("picture book"), area="work")),
    ref=[act("create", args=lines(kind="list", name="Picture book pitch", area="work"))]),
  T("draft 3 spreads goes on it, due end of the month",
    diff(new("task", name=has("spreads"), date="2027-06-30"), link("+1", "new")),
    ref=[act("create", args=lines(kind="task", name="Draft 3 spreads", date=D("2027-06-30"), list="$new"))]),
  T("also, a new group: Crit night", diff(new("group", name="Crit night"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Crit night"))]),
  T("nobody replied, so crit night can be wiped", diff(gone("+3"), unlink("+3", "me")),
    ref=[act("delete", rows="$c3")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T02-055-P", "find trashed restore multi album count anchor para",
  T("the blurry pic and the invoice screenshot, restore both", diff(restore("blurry"), restore("inv_shot")),
    ref=[find(kind="photo", trashed=True), act("restore", rows="$blurry, $inv_shot")]),
  T("which photos sit in no album",
    rows("desk", "jess_cat", "tomo_mock", "sunset_flat", "blurry", "shelves", "inv_shot"),
    ref=[ans(kind="photo", where="album count = 0")]),
  T("two days ago's photos?", rows("dad_garden"),
    ref=[ans(kind="photo", when=W(U("day", -2, anchor="today")))]))

S("T02-063-P", "where contains empty result para",
  T("notes where ramen comes up", rows("tokyo_food"),
    ref=[ans(kind="note", where='body contains "ramen"')]),
  T("and matcha?", rows(),
    ref=[ans(kind="note", where='body contains "matcha"')]),
  T("the olympic village note should come back from the trash and go into sketchbook notes",
    diff(restore("crawl"), link("sketchbook", "crawl")),
    ref=[act("restore", kind="note", trashed=True, where='body contains "Olympic Village"', more=True),
         act("add_to", rows="$crawl", args=lines(to="$sketchbook"))]),
  T("tack matcha at ippodo onto the tokyo food list", diff(upd("tokyo_food", body="Fuunji tsukemen, Afuri yuzu ramen, depachika at Isetan, tamagoyaki at Tsukiji, matcha at Ippodo")),
    ref=[opn("$tokyo_food"),
         act("edit", rows="$tokyo_food",
             args=lines(body="Fuunji tsukemen, Afuri yuzu ramen, depachika at Isetan, tamagoyaki at Tsukiji, matcha at Ippodo"))]),
  T("notes created from june onwards", rows("packing", "mf_brief", "journal_jun1", "fox", "idea_fox", "idea_crow"),
    ref=[ans(kind="note", when=W({"from": U("month", 0, name=6)}))]))

S("T02-068-P", "compute rows within exclude para",
  T("all open debts, list them", rows("d_mf", "d_tomo", "d_arun_tix", "d_sophie_taxi", "d_diego_chalk",
                                              "d_kai_books", "d_priya_sushi", "d_mom_phone", "d_carlos"),
    ref=[ans(kind="debt", where='status = "open"')]),
  T("break that down by direction", vgroups({"owes_me": (1375, "CAD"), "i_owe": (215.5, "CAD")}),
    ref=[comp(op="sum", field="amount", group="direction", rows="@prev"), ans(value="@prev")]),
  T("redo that excluding the tomo kill fee, it's never getting paid",
    vgroups({"owes_me": (1075, "CAD"), "i_owe": (215.5, "CAD")}),
    ref=[comp(op="sum", field="amount", group="direction", kind="debt", where='status = "open"', exclude="$d_tomo"),
         ans(value="@prev")]),
  T("open debts above 200 CAD", rows("d_mf", "d_tomo"),
    ref=[ans(kind="debt", where='status = "open" and amount > 200 CAD')]),
  T("open debts predating last friday",
    rows("d_mf", "d_arun_tix", "d_sophie_taxi", "d_diego_chalk", "d_kai_books", "d_priya_sushi", "d_mom_phone", "d_carlos"),
    ref=[ans(kind="debt", where='status = "open"', when=W({"to": U("week", -1, weekday=5)}))]))

S("T02-073-P", "count last month invoices repair kind para",
  T("last month's invoice count, the ones i sent", val(2),
    ref=[search("invoice", kind="task"),
         ans(op="count", kind="task", name="Invoice", where='status = "completed"', when=W(U("month", -1)))]),
  T("gst number?", rows("gst_no"),
    ref=[ans(kind="locker item", name="GST number")]),
  T("anything written before mid march, notes only", rows("palette_hg", "gesture", "rates", "kiln", "wheel_tips"),
    ref=[ans(kind="note", when=W({"to": D("2027-03-15")}))]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T02-078-P", "locker edit read reveal code para",
  T("hive membership renews in october, put that in its note",
    diff(upd("hive", notes="member 55821, renews October")),
    ref=[opn("$hive"),
         act("edit", kind="locker item", name="The Hive membership", args=lines(notes="member 55821, renews October"))]),
  T("adobe login url?", rows("adobe"),
    ref=[ans(kind="locker item", name="Adobe login")]),
  T("fastmail login's 2fa code, hand it over", diff(reveal=[("gmail", "JBSWY3DPEHPK3PXP")]),
    ref=[act("reveal", kind="locker item", name="Fastmail login", args=lines(field="code"))]))

S("T02-085-P", "repair create kind param para",
  T("task needed: renew the hive membership by sept first",
    diff(new("task", name=has("hive"), date="2027-09-01")),
    ref=[bad(C("act", verb="create", args=lines(name="Renew the Hive membership", date=D("2027-09-01")))),
         act("create", args=lines(kind="task", name="Renew the Hive membership", date=D("2027-09-01")))]),
  T("make it priority three, ten minutes", diff(upd("+1", priority=3, effort=10)),
    ref=[act("edit", rows="$new", args=lines(priority=3, effort=10))]))

S("T02-090-P", "locker where contains starred para",
  T("logins with a fastmail username", rows("adobe", "gmail"),
    ref=[ans(kind="locker item", where='username contains "fastmail"')]),
  T("which are starred", rows("adobe"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("jess wants my fastmail password, drop it in the flat group chat", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T02-096-P", "ask kinds pick reschedule para",
  T("change the call to 3", ask("call_marcus", "tap"),
    ref=[askc("the call with marcus tomorrow or the task to call ben?", options="$call_marcus, $tap")]),
  T("marcus", diff(upd("call_marcus", date="2027-06-09T15:00")),
    ref=[act("reschedule", rows="$call_marcus", args=lines(to=U("day", 0, anchor="row", time="15:00")))]))

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T02-A002-P", "ask-options task complete c3a para",
  T("invoice has been sent, so complete it", ask("inv_mf", "inv_gl_final", "inv_tide_cover"),
    ref=[act("complete", kind="task", name="invoice"),
         askc("Maple & Fern 0412, Greenleaf final or Tidewater cover?", options="$inv_mf, $inv_gl_final, $inv_tide_cover")]),
  T("greenleaf one", diff(upd("inv_gl_final", status="completed", completed=ANY)),
    ref=[act("complete", rows="$inv_gl_final")]))

S("T02-A007-P", "follow-up c3a para",
  T("taxes folder contents?", rows("gst_letter", "receipts", "t2125", "noa"),
    ref=[ans(kind="document", linked_to="$taxes")]),
  T("which of those are 2026 ones", rows("noa", "receipts", "t2125"),
    ref=[ans(within="@prev", name="2026")]),
  T("stars for the first two", diff(upd("receipts", starred=True), upd("t2125", starred=True)),
    ref=[act("star", rows="$receipts, $t2125")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

OPEN = 'status = "open"'

OWED = 'direction = "owes_me" and status = "open"'

S("T02-B003-P", "c3b superlative task quickest latest due count para",
  T("open task with the least effort?", rows("glaze_order"),
    ref=[ans(kind="task", where=OPEN, order="effort asc", limit=1)]),
  T("open task count?", val(30),
    ref=[ans(op="count", kind="task", where=OPEN)]),
  T("open task due furthest out?", rows("tenant_ins"),
    ref=[ans(kind="task", where=OPEN, order="date desc", limit=1)]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T02-C002-P", "c3c compound add_to star referential read para",
  T("cv goes into portfolio and gets a star",
    diff(link("portfolio_f", "cv"), upd("cv", starred=True)),
    ref=[act("add_to", kind="document", name="CV", args=lines(to="$portfolio_f"), more=True),
         act("star", rows="$cv")]),
  T("portfolio contents now?", rows("portfolio_pdf", "hg_series", "editorial", "dummy", "cv"),
    ref=[ans(kind="document", linked_to="$portfolio_f")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T02-105-P", "contrast pottery named day repair edit multi write para",
  T("thursday's pottery should start an hour later", diff(upd("pottery_0610", date="2027-06-10T19:30")),
    ref=[bad(act("reschedule", kind="event", name="Pottery class", when=W(U("week", 0, weekday=4)),
                 args=lines(to={"time": "19:30"}))),
         act("reschedule", kind="event", name="Pottery class", when=W(U("week", 0, weekday=4)),
             args=lines(to=U("hour", 1, anchor="row")))]),
  T("pottery description to read wheel throwing, clay studio on main, bring an apron", diff(upd("pottery_0610", description="wheel throwing, Clay Studio on Main, bring an apron")),
    ref=[act("edit", rows="$pottery_0610", args=lines(description="wheel throwing, Clay Studio on Main, bring an apron"))]),
  T("mark the leaky tap task done, plus pick up clay tools should be friday",
    diff(upd("tap", status="completed", completed=ANY), upd("clay_tools", date="2027-06-11")),
    ref=[act("complete", kind="task", name="Call Ben about the leaky tap", more=True),
         act("reschedule", kind="task", name="Pick up clay tools", args=lines(to=U("week", 0, weekday=5)))]))

S("T02-113-P", "ask options chau log never_mind then contrast full name para",
  T("i phoned chau, log it", ask("kai", "mom", "dad"),
    ref=[act("log", kind="person", name="Chau", args=lines(kind="call")),
         askc("kai, linda or henry?", options="$kai, $mom, $dad")]),
  T("skip it, i'll text them myself", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("henry chau came for sunday lunch, log that as a visit instead", diff(upd("dad", date=ANY)),
    ref=[act("log", kind="person", name="Henry Chau", args=lines(kind="visit"))]),
  T("kai gets a star too", diff(upd("kai", starred=True)),
    ref=[act("star", kind="person", name="Kai Chau")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T02-118-P", "ask options login password never_mind then contrast fastmail reveal para",
  T("login password, show it", ask("adobe", "gmail", "etsy"),
    ref=[act("reveal", kind="locker item", where='type = "login"', args=lines(field="password")),
         askc("adobe, fastmail or etsy?", options="$adobe, $gmail, $etsy")]),
  T("leave it, i'll dig it up myself", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("show me the fastmail login's password instead", diff(reveal=[("gmail", "tealfog88")]),
    ref=[act("reveal", kind="locker item", name="Fastmail login", args=lines(field="password"))]))
