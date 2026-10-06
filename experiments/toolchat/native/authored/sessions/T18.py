from gold import *
import json

world("T18", "2026-03-01T11:20", "Jordan Ellis", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T18-001", "star person named add_to group knock-on person read",
  T("star Priya Raman", diff(upd("priya", starred=True)),
    ref=[act("star", rows="$priya")]),
  T("sam okafor's coming to the gdc trip thing too, add him to that group and star him",
    diff(link("gdc", "sam_o"), upd("sam_o", starred=True)),
    ref=[act("add_to", rows="$sam_o", args=lines(to="$gdc"), more=True),
         act("star", rows="$sam_o")]),
  T("who's in GDC 2025 trip", rows("priya", "mei", "sam_o", "me"),
    ref=[ans(kind="person", linked_to="$gdc")]))

S("T18-002", "star person where nickname starred read",
  T("star the person i've got down as jules", diff(upd("jules", starred=True)),
    ref=[act("star", kind="person", where='nickname = "Jules"')]),
  T("who else have i starred", rows("tess", "mum", "bex"),
    ref=[ans(kind="person", where="starred = yes", exclude="$jules")]))

S("T18-003", "nickname where log undo ledger",
  T("who's danno again", rows("dan_w"),
    ref=[ans(kind="person", where='nickname = "Danno"')]),
  T("log a visit with him, he dropped the pram round this morning", diff(upd("dan_w", date=ANY)),
    ref=[act("log", rows="$dan_w", args=lines(kind="visit"))]),
  T("undo that, it was tess who came", diff(),
    ref=[act("undo")]),
  T("who've i seen from valentine's night 6pm to the end of feb that i have a nickname for",
    rows("mum", "mei", "oliver", "bex", "jules"),
    ref=[ans(kind="person", when=W(span(D("2026-02-14", "18:00"), U("month", 0, name=2))), where="nickname is set")]))

S("T18-004", "star person where role event linked",
  T("star my accountant", diff(upd("kieran", starred=True)),
    ref=[act("star", kind="person", where='role contains "accountant"')]),
  T("when am i seeing Kieran Doyle", rows("tax_meet"),
    ref=[ans(kind="event", linked_to="$kieran")]))

S("T18-005", "settle_up prev balance",
  T("pull up marcus", rows("marcus"),
    ref=[ans(kind="person", name="Marcus")]),
  T("settle up with him for thursday d&d", diff(settle=["Marcus Webb"]),
    ref=[act("settle_up", rows="@prev", args=lines(group="$dnd"))]),
  T("so what's left between me and him", val((24, "AUD")),
    ref=[ans(op="balance", rows="$marcus")]))

S("T18-006", "settle_up prev chloe shower",
  T("chloe nguyen", rows("chloe"),
    ref=[ans(kind="person", name="Chloe Nguyen")]),
  T("can you square up with her in the shower group", diff(settle=["Chloe Nguyen"]),
    ref=[act("settle_up", rows="@prev", args=lines(group="$shower"))]))

S("T18-007", "settle_up multi dnd",
  T("settle up marcus and juliette in thursday d&d", diff(settle=["Marcus Webb", "Juliette Park"]),
    ref=[act("settle_up", rows="$marcus, $jules", args=lines(group="$dnd"))]),
  T("and tomás", diff(settle=["Tomás Herrera"]),
    ref=[act("settle_up", rows="$tomas", args=lines(group="$dnd"))]))

S("T18-008", "settle_up multi coop undo ledger",
  T("settle priya and sam okafor in the co-op", diff(settle=["Priya Raman", "Sam Okafor"]),
    ref=[act("settle_up", rows="$priya, $sam_o", args=lines(group="$coop"))]),
  T("undo that, haven't actually transferred yet", diff(),
    ref=[act("undo")]),
  T("and cancel the d&d session, bex is away", ask(),
    ref=[act("cancel", kind="event", name="D&D session"),
         askc("there's one every thursday. which week?")]))

S("T18-009", "event weekday cancel prev",
  T("what's on tuesday", rows("shower_call"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=2)))]),
  T("cancel it, chloe's sick", diff(upd("shower_call", status="cancelled")),
    ref=[act("cancel", rows="@prev")]))

S("T18-010", "event weekday named cancel prev",
  T("is the playtest night this friday on", rows("playtest_mar"),
    ref=[ans(kind="event", name="Playtest night", when=W(U("week", 1, weekday=5)))]),
  T("cancel it, half the team has covid", diff(upd("playtest_mar", status="cancelled")),
    ref=[act("cancel", rows="@prev")]),
  T("who was coming to that Playtest night", rows("priya", "sam_o", "ana"),
    ref=[ans(kind="person", linked_to="$playtest_mar")]))

S("T18-011", "delete event named day read",
  T("delete pub trivia, not going", diff(trash("trivia")),
    ref=[act("delete", kind="event", name="Pub trivia")]),
  T("what's on the tenth", rows("cake_tasting"),
    ref=[ans(kind="event", when=W(D("2026-03-10")))]))

S("T18-012", "delete event named undo delete",
  T("delete the farmers market", diff(trash("market")),
    ref=[act("delete", kind="event", name="Farmers market")]),
  T("undo, biscuit loves it", diff(restore("market")),
    ref=[act("undo")]),
  T("and cancel biscuit's vet check-up, he's fine", diff(upd("vet_apr", status="cancelled")),
    ref=[act("cancel", kind="event", name="Biscuit's vet check-up"),
         act("cancel", kind="event", name="Biscuit's vet check-up", when=W({"from": U("day", 0)}))]))

S("T18-014", "create task day complete new read",
  T("remind me to email rhys the build link tomorrow",
    diff(new("task", name=has("Rhys"), date="2026-03-02")),
    ref=[act("create", args=lines(kind="task", name="Email Rhys the build link", date=U("day", 1)))]),
  T("eh did it now. done", diff(upd("+1", status="completed", completed=ANY)),
    ref=[act("complete", rows="$c1")]),
  T("what else is due tomorrow", rows("ci", "dog_food", "bins", "inv_draft"),
    ref=[ans(kind="task", when=W(U("day", 1)), exclude="$c1")]))

S("T18-015", "reopen prev smoke alarm",
  T("did i do the smoke alarm test", rows("smoke"),
    ref=[ans(kind="task", name="smoke alarm")]),
  T("reopen it, its beeping", diff(upd("smoke", status="open", completed=None)),
    ref=[act("reopen", rows="@prev")]))

S("T18-016", "reopen prev save bug reschedule",
  T("the save corruption bug, is that done?", rows("save_bug"),
    ref=[ans(kind="task", name="save corruption bug")]),
  T("reopen it, priya found another repro", diff(upd("save_bug", status="open", completed=None)),
    ref=[act("reopen", rows="@prev")]),
  T("due wednesday", diff(upd("save_bug", date="2026-03-04")),
    ref=[act("reschedule", rows="$save_bug", args=lines(to=U("week", 1, weekday=3)))]))

S("T18-017", "create note notebook",
  T("new note in shower planning: gift pool, chloe's collecting 20 bucks each for the pram",
    diff(new("note", name=has("Gift pool"), body=has("pram")), link("shower_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Gift pool", body="Chloe's collecting 20 each for the pram",
                                  notebook="$shower_nb"))]))

S("T18-018", "create note loose pin new read",
  T("jot down biscuit ate a sock, watch him tonight",
    diff(new("note", name=has("sock"))),
    ref=[act("create", args=lines(kind="note", name="Biscuit ate a sock", body="watch him tonight"))]),
  T("pin that", diff(upd("+1", pinned=True)),
    ref=[act("edit", rows="$c1", args=lines(pinned="yes"))]),
  T("what's pinned now", rows("npcs", "core_loop", "+1"),
    ref=[ans(kind="note", where="pinned = yes")]))

S("T18-019", "edit note multi pin",
  T("pin the shower theme and shower food notes", diff(upd("theme", pinned=True), upd("food", pinned=True)),
    ref=[act("edit", rows="$theme, $food", args=lines(pinned="yes"))]))

S("T18-020", "notebook read edit note multi",
  T("what's in campaign notes", rows("recap", "npcs", "loot", "wren"),
    ref=[ans(kind="note", linked_to="$camp_nb")]),
  T("pin the recap and the loot one, need them thursday", diff(upd("recap", pinned=True), upd("loot", pinned=True)),
    ref=[act("edit", rows="$recap, $loot", args=lines(pinned="yes"))]),
  T("and the dungeon map note?", rows("m_map"),
    ref=[ans(kind="note", name="dungeon map"), search("map"), ans(rows="$m_map")]))

S("T18-021", "edit document named add_to folder",
  T("rename Scan 27 Feb to Vet invoice Feb", diff(upd("scan", name="Vet invoice Feb")),
    ref=[act("edit", rows="$scan", args=lines(name="Vet invoice Feb"))]),
  T("and file it in biscuit", diff(link("dog_f", "scan")),
    ref=[act("add_to", rows="$scan", args=lines(to="$dog_f"))]),
  T("where's the pet insurance renewal doc, is that in there too", rows("pet_ins"),
    ref=[ans(kind="document", name="pet insurance renewal"), search("pet insurance", kind="document"),
         ans(rows="$pet_ins")]))

S("T18-022", "edit document named rename",
  T("call the Invitation draft 'Shower invitation v2'", diff(upd("invite_doc", name="Shower invitation v2")),
    ref=[act("edit", rows="$invite_doc", args=lines(name="Shower invitation v2"))]))

S("T18-023", "delete document where weekday undo delete",
  T("delete the doc i scanned on friday", diff(trash("scan")),
    ref=[act("delete", kind="document", when=W(U("week", 0, weekday=5)))]),
  T("wait undo, that's the vet invoice", diff(restore("scan")),
    ref=[act("undo")]))

S("T18-024", "delete document where folder count",
  T("delete the unfiled doc from thursday night", diff(trash("invite_doc")),
    ref=[act("delete", kind="document", when=W(U("week", 0, weekday=4)), where="folder count = 0")]),
  T("which docs are loose", rows("scan", "char_sheet"),
    ref=[find(kind="document", where="folder count = 0"), ans(rows="@prev")]))

S("T18-025", "document find add_to prev create folder",
  T("find my character sheet", rows("char_sheet"),
    ref=[ans(kind="document", name="Character sheet")]),
  T("put it in the shower folder. wait no, lease. no. ugh put it in old contracts", diff(link("old_f", "char_sheet")),
    ref=[act("add_to", rows="@prev", args=lines(to="$old_f"))]))
