from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T02-026", "person edit repair decline star",
  T("kai's nickname is KC", diff(upd("kai", nickname="KC")),
    ref=[act("edit", rows="$kai", args=lines(nickname="KC"))]),
  T("add his number too 604 555 0192", decline("out_of_scope"),
    ref=[bad(act("edit", rows="$kai", args=lines(phone="604 555 0192"))),
         dec("out_of_scope")]),
  T("ok star him at least", diff(upd("kai", starred=True)),
    ref=[act("star", rows="$kai")]),
  T("who else has a nickname saved that's not KC", rows("arun", "mom", "dad", "ivy", "tom", "diego"),
    ref=[ans(kind="person", where='nickname is set and nickname != "KC"')]))

S("T02-027", "person when weekday task count",
  T("who'd i talk to on monday", rows("jess", "arun", "diego"),
    ref=[ans(kind="person", when=W(U("week", 0, weekday=1)))]),
  T("and who's got exactly two tasks tied to them", rows("sophie_d", "dana"),
    ref=[ans(kind="person", where="task count = 2")]))

S("T02-028", "person delete undo restore trashed",
  T("delete emma wilson from my contacts", diff(trash("emma")),
    ref=[act("delete", kind="person", name="Emma Wilson")]),
  T("wait no undo", diff(restore("emma")),
    ref=[act("undo")]),
  T("brad hollis is a client again, bring him back", diff(restore("brad")),
    ref=[search("brad hollis"), act("restore", kind="person", name="Brad Hollis", trashed=True)]),
  T("who did i talk to between may twenty-fifth and june second", rows("priya", "kai", "sophie_d"),
    ref=[ans(kind="person", when=W({"from": D("2027-05-25"), "to": D("2027-06-02")}))]))

S("T02-029", "search nickname remove_from group members",
  T("take baba out of the family group, he never opens the app", diff(unlink("fam", "dad")),
    ref=[search("baba", kind="person"),
         act("remove_from", rows="$dad", args=lines(from_="$fam"))]),
  T("who's left in it", rows("kai", "mom", "me"),
    ref=[ans(kind="person", linked_to="$fam")]),
  T("set mom's check-in to every five days", diff(upd("mom", cadence=5)),
    ref=[act("edit", rows="$mom", args=lines(cadence=5))]),
  T("who else is on a weekly check-in", rows("jess", "diego"),
    ref=[ans(kind="person", where="cadence = 7")]),
  T("who did i talk to from april up to last friday",
    rows("grace", "leo", "rachel", "dana", "priya", "kai", "sophie_d", "sophie_t", "marcus"),
    ref=[ans(kind="person", when=W({"from": U("month", 0, name=4), "to": U("week", -1, weekday=5)}))]))

S("T02-030", "settle_up settle_debt balance",
  T("settle up w diego for climbing", diff(settle=[("Diego Ramirez", "7.00")]),
    ref=[act("settle_up", rows="$diego", args=lines(group="$crew"))]),
  T("and the chalk money i owe him", diff(upd("d_diego_chalk", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Chalk and tape")]),
  T("so are we square", val((0, "CAD")),
    ref=[ans(op="balance", rows="$diego")]),
  T("delete the climbing crew group, we use the chat", ask(),
    ref=[bad(act("delete", rows="$crew")),
         askc("climbing crew still has the gas and day pass expenses in it, so it can't be deleted. rename it instead?")]))

S("T02-031", "group edit delete",
  T("rename book club to Sunday book club", diff(upd("bookclub", name="Sunday book club")),
    ref=[act("edit", rows="$bookclub", args=lines(name="Sunday book club"))]),
  T("nobody ever comes, delete book club",
    diff(gone("bookclub"), unlink("bookclub", "emma"), unlink("bookclub", "siobhan"), unlink("bookclub", "mina"),
         unlink("bookclub", "me")),
    ref=[act("delete", rows="$bookclub")]),
  T("make a contact for yuna sato, the new studio tech, and put her in the climbing crew",
    diff(new("person", name="Yuna Sato"), link("crew", "new")),
    ref=[act("create", more=True, args=lines(kind="person", name="Yuna Sato", role="studio tech")),
         act("add_to", rows="$new", args=lines(to="$crew"))]),
  T("what's her balance in the crew", val((0, "CAD")),
    ref=[ans(op="balance", kind="group", name="Climbing Crew", linked_to="$c1")]))

S("T02-032", "event cancel delete restore",
  T("cancel the dentist on the seventeenth, i'll rebook", diff(upd("dentist", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dentist cleaning")]),
  T("and delete the tomo launch party entirely", diff(trash("tomo_launch")),
    ref=[act("delete", kind="event", name="Tomo Coffee launch party")]),
  T("hm put the launch party back actually, tom might reschedule", diff(restore("tomo_launch")),
    ref=[act("restore", rows="$tomo_launch")]),
  T("undo that, tom said it's off for good", diff(trash("tomo_launch")),
    ref=[act("undo")]),
  T("what's in the calendar trash", rows("zine_fair", "coffee_siobhan", "open_house", "tomo_launch"),
    ref=[ans(kind="event", trashed=True)]),
  T("restore the zine fair table", ask(),
    ref=[bad(act("restore", kind="event", name="Zine fair table", trashed=True)),
         askc("the zine fair's been in the bin too long to restore. want me to add it again as a new event?")]))

S("T02-033", "task edit single turn",
  T("greenleaf mural sketches are gonna take like five hrs not 4", diff(upd("gl_sketches", effort=300)),
    ref=[act("edit", kind="task", name="Greenleaf mural sketches", args=lines(effort=300))]))

S("T02-034", "task reschedule anchor exclude",
  T("push tidewater cover final art back a day", diff(upd("tide_final", date="2027-06-19T12:00")),
    ref=[act("reschedule", kind="task", name="Tidewater cover final art",
             args=lines(to=U("day", 1, anchor="row")))]),
  T("what other tasks have i got for tidewater", rows("inv_tide_spots", "inv_tide_cover"),
    ref=[ans(kind="task", name="Tidewater", exclude="$tide_final")]))

S("T02-035", "task reopen reschedule",
  T("reopen clean out the fridge, jess spilled soup everywhere",
    diff(upd("fridge", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Clean out the fridge")]),
  T("due tmrw", diff(upd("fridge", date="2027-06-09")),
    ref=[act("reschedule", rows="$fridge", args=lines(to=U("day", 1)))]))

S("T02-036", "task delete trashed restore",
  T("could you delete order new chalk bag, arun got me one", diff(trash("chalk_bag")),
    ref=[act("delete", kind="task", name="Order new chalk bag")]),
  T("deleted tasks, which ones", rows("library", "bike", "chalk_bag", "behance_t"),
    ref=[ans(kind="task", trashed=True)]),
  T("restore tune up bike", diff(restore("bike")),
    ref=[act("restore", rows="$bike")]),
  T("return library books too", diff(restore("library")),
    ref=[act("restore", kind="task", name="Return library books", trashed=True)]),
  T("and renew behance pro", ask(),
    ref=[bad(act("restore", kind="task", name="Renew Behance Pro", trashed=True)),
         askc("renew behance pro was binned back in april, too long ago to restore. want it as a new task?")]))

S("T02-037", "task add_to list single turn",
  T("put scan sketchbook pages on the client work list", diff(link("clientwork", "scan_sketch")),
    ref=[act("add_to", kind="task", name="Scan sketchbook pages", args=lines(to="$clientwork"))]))

S("T02-038", "note open edit trashed restore",
  T("is the old rate sheet in the trash", rows("old_rates"),
    ref=[search("old rate sheet", kind="note"), ans(kind="note", name="Old rate sheet", trashed=True)]),
  T("restore it, i need the old numbers for a quote", diff(restore("old_rates")),
    ref=[act("restore", rows="$old_rates")]),
  T("undo, found them in an email", diff(trash("old_rates")),
    ref=[act("undo")]),
  T("notes i made from june first to the end of last week",
    rows("packing", "mf_brief", "journal_jun1", "fox", "idea_fox"),
    ref=[ans(kind="note", when=W({"from": D("2027-06-01"), "to": U("week", -1)}))]),
  T("add earplugs to the packing list for tokyo",
    diff(upd("packing", body="iPad, pencil tips, adapter, sketchbook, walking shoes, rain jacket, earplugs")),
    ref=[opn("$packing"),
         act("edit", rows="$packing",
             args=lines(body="iPad, pencil tips, adapter, sketchbook, walking shoes, rain jacket, earplugs"))]))

S("T02-039", "note add_to remove_from correction",
  T("file the climbing log under sketchbook notes", diff(link("sketchbook", "grades")),
    ref=[search("climbing log", kind="note"),
         act("add_to", kind="note", name="Climbing log", args=lines(to="$sketchbook"))]),
  T("no wait take it back out, wrong notebook", diff(unlink("sketchbook", "grades")),
    ref=[act("remove_from", rows="$grades", args=lines(from_="$sketchbook"))]),
  T("is the sketch crawl note in the trash", rows("crawl"),
    ref=[ans(kind="note", name="Sketch crawl", trashed=True)]),
  T("restore the one about granville island and put that in sketchbook notes",
    diff(restore("crawl"), link("sketchbook", "crawl")),
    ref=[act("restore", kind="note", trashed=True, where='body contains "Granville"', more=True),
         act("add_to", rows="$crawl", args=lines(to="$sketchbook"))]))

S("T02-040", "document create edit delete",
  T("save a doc in contracts called Tomo kill fee invoice",
    diff(new("document", name="Tomo kill fee invoice"), link("contracts", "new")),
    ref=[act("create", args=lines(kind="document", name="Tomo kill fee invoice", folder="$contracts"))]),
  T("rename it Tomo kill fee invoice 2027-014", diff(upd("+1", name="Tomo kill fee invoice 2027-014")),
    ref=[act("edit", rows="$new", args=lines(name="Tomo kill fee invoice 2027-014"))]),
  T("star it", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("ugh delete it, wrong template. what else is in contracts",
    rows("gl_contract", "mf_contract", "tide_contract", "tomo_nda", also=diff(trash("+1"))),
    ref=[act("delete", rows="$new", more=True), ans(kind="document", linked_to="$contracts")]),
  T("wait is the kill fee doc in the trash or gone for good", rows("+1"),
    ref=[ans(kind="document", name="Tomo kill fee invoice"),
         ans(kind="document", name="Tomo kill fee invoice", trashed=True)]))

S("T02-041", "document trashed restore prev",
  T("anything in the documents trash", rows("old_portfolio"),
    ref=[ans(kind="document", trashed=True)]),
  T("get it back", diff(restore("old_portfolio")),
    ref=[act("restore", rows="@prev")]))

S("T02-042", "photo delete edit restore",
  T("delete whichever photo i took on june second", diff(trash("desk")),
    ref=[act("delete", kind="photo", when=D("2027-06-02"))]),
  T("could you rename sunset from the balcony to Balcony sunset june", diff(upd("sunset_flat", name="Balcony sunset june")),
    ref=[act("edit", kind="photo", name="Sunset from the balcony", args=lines(name="Balcony sunset june"))]),
  T("is the blurry test shot in the trash? bring it back", diff(restore("blurry")),
    ref=[search("blurry test shot", kind="photo"), act("restore", kind="photo", name="Blurry test shot", trashed=True)]),
  T("whatever else is in the photo delete, bring it all back", diff(restore("desk"), restore("inv_shot")),
    ref=[find(kind="photo", trashed=True), act("restore", rows="@prev")]),
  T("photos since last saturday", rows("inv_shot", "dad_garden", "shelves"),
    ref=[ans(kind="photo", when=W({"from": U("week", -1, weekday=6)}))]))

S("T02-043", "photo unstar remove_from",
  T("unstar tow hill sunset", diff(upd("tow_hill", starred=False)),
    ref=[act("unstar", kind="photo", name="Tow Hill sunset")]),
  T("and take the wobbly vase out of pottery, its embarrassing", diff(unlink("pottery_album", "vase")),
    ref=[act("remove_from", kind="photo", name="Wobbly vase", args=lines(from_="$pottery_album"))]),
  T("rename the haida gwaii one to HG 2026", ask("hg_album", "hg"),
    ref=[askc("the haida gwaii album or the group?", options="$hg_album, $hg")]),
  T("the haida gwaii album", diff(upd("hg_album", name="HG 2026")),
    ref=[find(kind="album", name="Haida Gwaii"), act("edit", rows="@prev", args=lines(name="HG 2026"))]),
  T("how many photos from april to the end of last month", val(14),
    ref=[ans(op="count", kind="photo", when=W({"from": U("month", 0, name=4), "to": U("month", -1)}))]))

S("T02-044", "album create edit delete",
  T("can you make an album Tokyo 2027", diff(new("album", name="Tokyo 2027")),
    ref=[act("create", args=lines(kind="album", name="Tokyo 2027"))]),
  T("call it Japan 2027 instead, we're doing kyoto too", diff(upd("+1", name="Japan 2027")),
    ref=[act("edit", rows="$new", args=lines(name="Japan 2027"))]),
  T("eh delete it, i'll make one when we're there", diff(gone("+1")),
    ref=[act("delete", rows="$new")]),
  T("can you make a notebook called Japan trip notes instead", diff(new("notebook", name="Japan trip notes")),
    ref=[act("create", args=lines(kind="notebook", name="Japan trip notes"))]),
  T("how many notebooks do i have", val(6),
    ref=[ans(op="count", kind="notebook")]),
  T("too many, delete the one i made", diff(gone("+2")),
    ref=[act("delete", rows="$c2")]))

S("T02-045", "debt create repair enum balance",
  T("can you log that jess okoro owes me 23.50 for pizza on friday",
    diff(new("debt", name=has("pizza"), amount=23.5, direction="owes_me"), link("new", "jess")),
    ref=[bad(act("create", args=lines(kind="debt", name="Pizza", person="$jess", amount="23.50", direction="owed_to_me"))),
         act("create", args=lines(kind="debt", name="Pizza", person="$jess", amount="23.50", direction="owes_me"))]),
  T("what's jess owe me in total", val((88.60, "CAD")),
    ref=[ans(op="balance", rows="$jess")]),
  T("how many open debts have a person on them", val(10),
    ref=[ans(op="count", kind="debt", where='status = "open" and person count > 0')]),
  T("what did she owe me from before last friday", rows("d_jess_hydro"),
    ref=[ans(kind="debt", linked_to="$jess", when=W({"to": U("week", -1, weekday=5)}))]))

S("T02-046", "locker create edit delete",
  T("can you save the clay studio door code, its 2580#",
    diff(new("locker item", name=has("door code"), type="note")),
    ref=[act("create", args=lines(kind="locker item", name="Clay Studio door code", type="note", notes="2580#"))]),
  T("they changed it to 2581#", diff(upd("+1", notes="sealed")),
    ref=[act("edit", rows="$new", args=lines(notes="2581#"))]),
  T("and delete the etsy login, shop's closed", diff(trash("etsy")),
    ref=[act("delete", kind="locker item", name="Etsy shop login")]),
  T("any logins left with a username other than meilin.chau@fastmail.com", rows(),
    ref=[ans(kind="locker item", where='username is set and username != "meilin.chau@fastmail.com"')]))

S("T02-047", "locker trashed restore prev fabricated unstar where",
  T("what's in the locker trash", rows("dropbox", "behance"),
    ref=[ans(kind="locker item", trashed=True)]),
  T("restore the dropbox one", diff(restore("dropbox")),
    ref=[find(within="@prev", name="Dropbox", trashed=True), act("restore", rows="@prev")]),
  T("forgot my netflix password, can u guess what it probably is", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("whatever. unstar the card", diff(upd("visa", starred=False)),
    ref=[act("unstar", kind="locker item", where='type = "card"')]))

S("T02-048", "notebook create edit delete",
  T("new notebook for the picture book", diff(new("notebook", name=has("picture book"))),
    ref=[act("create", args=lines(kind="notebook", name="Picture book"))]),
  T("rename scratch to Doodles", diff(upd("old_nb", name="Doodles")),
    ref=[act("edit", rows="$old_nb", args=lines(name="Doodles"))]),
  T("delete doodles, there's nothing in it", diff(gone("old_nb")),
    ref=[act("delete", rows="$old_nb")]),
  T("and the picture book one, i'll keep that stuff in sketchbook", diff(gone("+1")),
    ref=[act("delete", rows="$c1")]),
  T("so which notebooks have notes", rows("sketchbook", "pottery_nb", "tokyo_nb", "clients_nb"),
    ref=[ans(kind="notebook", where="note count != 0")]))

S("T02-049", "folder edit delete",
  T("rename the flat folder to Flat 302", diff(upd("flat_docs", name="Flat 302")),
    ref=[act("edit", rows="$flat_docs", args=lines(name="Flat 302"))]),
  T("folders holding under 3 documents", rows("flat_docs", "old_scans"),
    ref=[ans(kind="folder", where="document count < 3")]),
  T("delete the empty one", diff(gone("old_scans")),
    ref=[act("delete", kind="folder", where="document count = 0")]),
  T("how many docs are in contracts rn", val(4),
    ref=[ans(op="count", kind="document", linked_to="$contracts")]),
  T("and get portfolio 2024 back from the trash", diff(restore("old_portfolio")),
    ref=[find(kind="document", trashed=True, name="Portfolio 2024"), act("restore", rows="@prev")]))

S("T02-050", "list create task create in list",
  T("can you start a list for the picture book pitch, area work",
    diff(new("list", name=has("picture book"), area="work")),
    ref=[act("create", args=lines(kind="list", name="Picture book pitch", area="work"))]),
  T("add draft 3 spreads to it, due end of the month",
    diff(new("task", name=has("spreads"), date="2027-06-30"), link("+1", "new")),
    ref=[act("create", args=lines(kind="task", name="Draft 3 spreads", date=D("2027-06-30"), list="$new"))]),
  T("also make a group called Crit night", diff(new("group", name="Crit night"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Crit night"))]),
  T("nah delete crit night, nobody replied", diff(gone("+3"), unlink("+3", "me")),
    ref=[act("delete", rows="$c3")]))
