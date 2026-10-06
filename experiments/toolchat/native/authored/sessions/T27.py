from gold import *
import json

world("T27", "2026-12-03T04:50", "Sophie Dubois", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T27-001", "unstar person multi starred read role empty",
  T("unstar Camille Roux and Chloé Bernard, my favourites are a mess", diff(upd("camille_r", starred=False), upd("chloe", starred=False)),
    ref=[act("unstar", rows="$camille_r, $chloe")]),
  T("who's left with a star", rows("julien", "helene", "lea"),
    ref=[ans(kind="person", where="starred = yes")]),
  T("and who have i never put a role on", rows("aurelie", "gaspard", "zoe", "me"),
    ref=[ans(kind="person", where="role is empty")]),
  T("and julien's starred right? star him if not", diff(already=["julien"]),
    ref=[act("star", rows="$julien"), ans(rows="$julien")]))

S("T27-002", "unstar person multi cadence set",
  T("take the stars off hélène and léa", diff(upd("helene", starred=False), upd("lea", starred=False)),
    ref=[act("unstar", rows="$helene, $lea")]),
  T("who have i set a check-in rhythm for",
    rows("helene", "bernard", "odette", "lea", "claire", "camille_r", "antoine", "sandrine", "thomas_g", "sarah", "chloe"),
    ref=[ans(kind="person", where="cadence is set")]))

S("T27-003", "add_to person named group count knock-on",
  T("who's in the Opening party kitty", rows("nadia", "hugo", "ines", "me"),
    ref=[ans(kind="person", linked_to="$party_g")]),
  T("add Zoé Lemaire, she's helping with the balloons", diff(link("party_g", "zoe")),
    ref=[act("add_to", rows="$zoe", args=lines(to="$party_g"))]),
  T("how many is that", val(5),
    ref=[ans(op="count", kind="person", linked_to="$party_g")]))

S("T27-004", "add_to person named shower group",
  T("can you add maxime to baby shower gifts", diff(link("shower_g", "maxime")),
    ref=[act("add_to", rows="$maxime", args=lines(to="$shower_g"))]))

S("T27-005", "delete group named knock-on undo not undone",
  T("delete the Opening party kitty, we're using the till money",
    diff(gone("party_g"), unlink("party_g", "nadia"), unlink("party_g", "hugo"), unlink("party_g", "ines"),
         unlink("party_g", "me")),
    ref=[act("delete", kind="group", name="Opening party kitty")]),
  T("undo that", diff(),
    ref=[act("undo")]))

S("T27-006", "delete group named refused non-empty ask",
  T("which groups are in something other than euros", rows("geneva_g", "london_g"),
    ref=[ans(kind="group", where='currency != "EUR"')]),
  T("delete the geneva one, the fair got cancelled", ask(),
    ref=[bad(act("delete", kind="group", name="Geneva pastry fair")),
         askc("the geneva group still has the stand fee in it, so it can't be deleted. rename it instead?")]),
  T("ok then delete Baby shower gifts, léa is doing it herself",
    diff(gone("shower_g"), unlink("shower_g", "lea"), unlink("shower_g", "chloe"), unlink("shower_g", "me")),
    ref=[act("delete", kind="group", name="Baby shower gifts")]))

S("T27-007", "delete group prev find-only person count",
  T("the group with four of us in it, what's that called", rows("party_g"),
    ref=[find(kind="group", where="person count = 4"), ans(rows="@prev")]),
  T("get rid of it", diff(gone("party_g"), unlink("party_g", "nadia"), unlink("party_g", "hugo"),
                          unlink("party_g", "ines"), unlink("party_g", "me")),
    ref=[act("delete", rows="@prev")]))

S("T27-008", "delete group prev search",
  T("the shower group", rows("shower_g"),
    ref=[find(kind="group", name="shower"), ans(rows="@prev")]),
  T("who's in it", rows("lea", "chloe", "me"),
    ref=[ans(kind="person", linked_to="@prev")]),
  T("delete that group, i'll sort gifts with léa directly",
    diff(gone("shower_g"), unlink("shower_g", "lea"), unlink("shower_g", "chloe"), unlink("shower_g", "me")),
    ref=[act("delete", rows="@1")]))

S("T27-009", "restore event where trashed week",
  T("i deleted something for next monday by mistake, put it back", diff(restore("sign_maker")),
    ref=[act("restore", kind="event", trashed=True, when=W(U("week", 1, weekday=1)))]),
  T("what's on monday then", rows("bake_1207", "sign_maker"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=1)))]))

S("T27-010", "restore event where trashed last saturday undo restore",
  T("bring back the event from last saturday that i deleted", diff(restore("neighbours")),
    ref=[act("restore", kind="event", trashed=True, when=W(U("week", -1, weekday=6)))]),
  T("actually no, undo", diff(trash("neighbours")),
    ref=[act("undo")]))

S("T27-011", "restore event multi trashed find",
  T("what events are in the trash", rows("neighbours", "sign_maker", "handover"),
    ref=[ans(kind="event", trashed=True)]),
  T("restore the neighbours tasting and the sign maker meeting", diff(restore("neighbours"), restore("sign_maker")),
    ref=[act("restore", rows="$neighbours, $sign_maker")]),
  T("and the flat handover", ask(),
    ref=[find(kind="event", name="handover", trashed=True),
         bad(act("restore", rows="$handover")),
         askc("the old flat handover was binned on 1 october, past the 30 days, so it can't come back. add it again as a new event?")]),
  T("no it's done anyway", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T27-012", "restore event multi named",
  T("restore Tasting for the neighbours and Meeting with the sign maker", diff(restore("neighbours"), restore("sign_maker")),
    ref=[find(kind="event", trashed=True), act("restore", rows="$neighbours, $sign_maker")]))

S("T27-013", "delete task prev cancelled multi",
  T("any cancelled tasks lying around", rows("apprentice2", "mixer2"),
    ref=[ans(kind="task", where='status = "cancelled"')]),
  T("delete both", diff(trash("apprentice2"), trash("mixer2")),
    ref=[act("delete", rows="@prev")]),
  T("what's in the task trash", rows("apprentice2", "mixer2", "old_mixer", "babymoon", "paris_gym"),
    ref=[ans(kind="task", trashed=True)]),
  T("restore Cancel the Paris gym, i haven't done it", ask(),
    ref=[bad(act("restore", rows="$paris_gym")),
         askc("that one was binned on 10 october, past the 30-day window, so it can't be restored. add it as a new task?")]))

S("T27-015", "restore task where list trashed",
  T("bring back everything i deleted from the home list", diff(restore("old_mixer")),
    ref=[act("restore", kind="task", trashed=True, linked_to="$home_l")]),
  T("and mark it done, hugo bought it", diff(upd("old_mixer", status="completed", completed=ANY)),
    ref=[act("complete", rows="$old_mixer")]))

S("T27-016", "restore task where date trashed restore window",
  T("the task that was due on fifteenth november, did i delete it", rows("babymoon"),
    ref=[ans(kind="task", when=W(D("2026-11-15")), trashed=True)]),
  T("restore it, we might go", diff(restore("babymoon")),
    ref=[act("restore", kind="task", trashed=True, when=W(D("2026-11-15")))]),
  T("push it to the nineteenth", diff(upd("babymoon", date="2026-12-19")),
    ref=[act("reschedule", rows="$babymoon", args=lines(to=D("2026-12-19")))]))

S("T27-017", "create note delete note new",
  T("note: ask Olivier if the steam valve needs descaling",
    diff(new("note", name=ANY, body=has("steam valve"))),
    ref=[act("create", args=lines(kind="note", name="Steam valve", body="ask Olivier if the steam valve needs descaling"))]),
  T("never mind, delete it, he's coming tuesday", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T27-018", "create note notebook delete note new count",
  T("add a note Brioche timing to Recipes: proof 2h at 26 degrees",
    diff(new("note", name="Brioche timing", body=has("26 degrees")), link("recipes_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Brioche timing", body="proof 2h at 26 degrees",
                                  notebook="$recipes_nb"))]),
  T("hmm nadia already wrote this up, delete it", diff(trash("+1")),
    ref=[act("delete", rows="$new")]),
  T("recipe count in it now", val(4),
    ref=[ans(op="count", kind="note", linked_to="$recipes_nb")]))

S("T27-019", "create note delete restore note new",
  T("new note Till closing: count the float, lock the back door, alarm on",
    diff(new("note", name="Till closing", body=has("float"))),
    ref=[act("create", args=lines(kind="note", name="Till closing", body="count the float, lock the back door, alarm on"))]),
  T("delete it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("wait no i need that, restore it", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

S("T27-020", "restore note new pinned",
  T("jot down Hospital bag list: pyjamas, snacks, phone charger",
    diff(new("note", name="Hospital bag list", body=has("charger"))),
    ref=[act("create", args=lines(kind="note", name="Hospital bag list", body="pyjamas, snacks, phone charger"))]),
  T("delete that, julien made one on his phone", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("his got lost lol. bring mine back", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]),
  T("and pin it", diff(upd("+1", pinned=True)),
    ref=[act("edit", rows="$c1", args=lines(pinned="yes"))]))

S("T27-021", "delete document multi unfiled folder count",
  T("delete scan 1123 and scan 1124, they were blank", diff(trash("scan_a"), trash("scan_b")),
    ref=[act("delete", rows="$scan_a, $scan_b")]))

S("T27-022", "delete document multi named",
  T("delete Menu draft and Floor plan, camille has the final versions", diff(trash("menu_draft"), trash("floor_plan")),
    ref=[act("delete", rows="$menu_draft, $floor_plan")]))

S("T27-023", "star document named starred docs",
  T("star the Kbis extract, the bank keeps asking for it", diff(upd("kbis", starred=True)),
    ref=[act("star", kind="document", name="Kbis extract")]),
  T("which docs are starred and filed somewhere", rows("lease", "loan", "partnership", "kbis"),
    ref=[ans(kind="document", where="starred = yes and folder count >= 1")]))

S("T27-024", "star document named undo field",
  T("star Maternity leave certificate", diff(upd("leave_cert", starred=True)),
    ref=[act("star", kind="document", name="Maternity leave certificate")]),
  T("undo, wrong one", diff(upd("leave_cert", starred=False)),
    ref=[act("undo")]),
  T("i meant the blood test results", diff(upd("blood", starred=True)),
    ref=[act("star", kind="document", name="Blood test results")]))

S("T27-025", "edit photo where yesterday rename",
  T("rename yesterday's photo to Menu board final", diff(upd("p_menu", name="Menu board final")),
    ref=[act("edit", kind="photo", when=W(U("day", -1)), args=lines(name="Menu board final"))]),
  T("and star it", diff(upd("p_menu", starred=True)),
    ref=[act("star", rows="$p_menu")]))
