from gold import *
import json

world("T28", "2026-02-21T12:00", "Wiremu Tane", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T28-001", "add_to person named group members read",
  T("put Tui Ngata in the marae koha fund, she's helping moana with the books",
    diff(link("marae_g", "tui")),
    ref=[act("add_to", rows="$tui", args=lines(to="$marae_g"))]),
  T("how many in that group", val(6),
    ref=[ans(op="count", kind="person", linked_to="$marae_g")]))

S("T28-002", "add_to person named count value",
  T("add Trevor Wilson to Tarawera fishing", diff(link("fish_g", "trev")),
    ref=[act("add_to", rows="$trev", args=lines(to="$fish_g"))]),
  T("how many of us in it", val(5),
    ref=[ans(op="count", kind="person", linked_to="$fish_g")]),
  T("and is the fishing trip on or did we cancel", rows("fishing"),
    ref=[find(kind="event", name="fishing"), ans(rows="@prev")]))

S("T28-003", "add_to person where secretary tangi group",
  T("add the marae secretary to Uncle Hohepa's tangi group, she's doing the koha list",
    diff(link("tangi_g", "huia")),
    ref=[act("add_to", kind="person", where='role contains "secretary"', args=lines(to="$tangi_g"))]),
  T("what's my balance with her", val((-30, "NZD")),
    ref=[ans(op="balance", rows="$huia")]))

S("T28-004", "add_to person where mechanic bus group",
  T("can you put the mechanic in bus depot old boys, tony drove the 11 back in the day",
    diff(link("bus_g", "tony")),
    ref=[act("add_to", kind="person", where='role contains "mechanic"', args=lines(to="$bus_g"))]),
  T("and when's the depot lunch", rows("depot_lunch"),
    ref=[find(kind="event", name="depot lunch"), ans(rows="@prev")]))

S("T28-005", "group person count delete group where",
  T("which of my groups have three people or fewer", rows("bus_g"),
    ref=[ans(kind="group", where="person count <= 3")]),
  T("delete the three person one, we meet at the RSA",
    diff(gone("bus_g"), unlink("bus_g", "kevin"), unlink("bus_g", "trev"), unlink("bus_g", "me")),
    ref=[act("delete", kind="group", where="person count = 3")]))

S("T28-006", "delete group where linked empty read",
  T("get rid of the group trev is in, never used it",
    diff(gone("bus_g"), unlink("bus_g", "kevin"), unlink("bus_g", "trev"), unlink("bus_g", "me")),
    ref=[act("delete", kind="group", linked_to="$trev")]),
  T("is kevin in any groups", rows(),
    ref=[ans(kind="group", linked_to="$kevin")]))

S("T28-007", "create group add_to person new delete group new",
  T("new group Brisbane footy tickets", diff(new("group", name="Brisbane footy tickets"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Brisbane footy tickets"))]),
  T("add rawiri to it", diff(link("+1", "rawiri")),
    ref=[act("add_to", rows="$rawiri", args=lines(to="$c1"))]),
  T("delete it, he's sorting the tickets himself",
    diff(gone("+1"), unlink("+1", "me"), unlink("+1", "rawiri")),
    ref=[act("delete", rows="$c1")]))

S("T28-008", "create group delete group new list groups",
  T("make a group called Regionals van", diff(new("group", name="Regionals van"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Regionals van"))]),
  T("hmm no scrap that group, the kura is paying for the van", diff(gone("+1"), unlink("+1", "me")),
    ref=[act("delete", rows="$new")]),
  T("which groups have i got in aussie dollars", rows("brisbane_g"),
    ref=[ans(kind="group", where='currency contains "AUD"')]))

S("T28-009", "trashed event restore prev read",
  T("is the tyre change in the trash", rows("tyre"),
    ref=[ans(kind="event", name="Tyre change", trashed=True)]),
  T("put it back, tony never did them", diff(restore("tyre")),
    ref=[act("restore", rows="@prev")]))

S("T28-010", "trashed event restore prev undo restore",
  T("what events have i deleted this month", rows("tyre"),
    ref=[ans(kind="event", trashed=True, when=W(U("month", 0)))]),
  T("restore that", diff(restore("tyre")),
    ref=[act("restore", rows="@prev")]),
  T("undo, no, it was done at the WOF", diff(trash("tyre")),
    ref=[act("undo")]))

S("T28-011", "create task list delete task new",
  T("add a task Pick up the hāngī baskets, due friday, on reunion catering",
    diff(new("task", name="Pick up the hāngī baskets", date="2026-02-27"), link("reunion_cat_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Pick up the hāngī baskets", date=U("week", 1, weekday=5),
                                  list="$reunion_cat_l"))]),
  T("no delete that, ngaire's bringing them", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T28-012", "create task delete task new undo delete",
  T("remind me to ring Kevin about the lunch on thursday",
    diff(new("task", name=has("Kevin"), date="2026-02-26")),
    ref=[act("create", args=lines(kind="task", name="Ring Kevin about the lunch", date=U("week", 1, weekday=4)))]),
  T("delete it, trev's ringing him", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("undo that, trev forgets everything", diff(restore("+1")),
    ref=[act("undo")]))

S("T28-013", "trashed task restore prev complete",
  T("did i delete the library books one", rows("library"),
    ref=[ans(kind="task", name="library books", trashed=True)]),
  T("restore it", diff(restore("library")),
    ref=[act("restore", rows="@prev")]),
  T("and tick it off, aroha took them back", diff(upd("library", status="completed", completed=ANY)),
    ref=[act("complete", rows="$library")]))

S("T28-014", "trashed task list restore prev",
  T("anything from the home list in the trash", rows("garage"),
    ref=[ans(kind="task", linked_to="$home_l", trashed=True)]),
  T("bring it back, gotta do it before the reunion", diff(restore("garage")),
    ref=[act("restore", rows="@prev")]),
  T("what's open on home",
    rows("lawns", "spouting", "smoke", "insurance", "tap", "mara", "power_02", "power_03", "garage"),
    ref=[ans(kind="task", linked_to="$home_l", where='status = "open"')]))

S("T28-015", "delete note multi pinned read",
  T("delete Doctor questions and Things to tell Rawiri, sorted both",
    diff(trash("doc_qs"), trash("tell_rawiri")),
    ref=[act("delete", rows="$doc_qs, $tell_rawiri")]),
  T("what's pinned", rows("marae_rules", "waiata_list", "whakapapa", "speech"),
    ref=[ans(kind="note", where="pinned = yes")]))

S("T28-016", "note body literal delete note multi",
  T("which notes say tbc", rows("guest_list", "tell_rawiri"),
    ref=[ans(kind="note", where='body = "tbc"')]),
  T("delete both, i'll start them again", diff(trash("guest_list"), trash("tell_rawiri")),
    ref=[act("delete", rows="$guest_list, $tell_rawiri")]),
  T("how many notes left in reunion planning", val(2),
    ref=[ans(op="count", kind="note", linked_to="$reunion_nb")]))

S("T28-017", "trashed notes restore note multi",
  T("show me the notes i've deleted", rows("old_koha", "xmas_menu", "reunion_2023"),
    ref=[ans(kind="note", trashed=True)]),
  T("restore Old koha list and Christmas menu", diff(restore("old_koha"), restore("xmas_menu")),
    ref=[act("restore", rows="$old_koha, $xmas_menu")]),
  T("and the 2023 one?", ask(),
    ref=[find(kind="note", name="2023", trashed=True),
         bad(act("restore", rows="$reunion_2023")),
         askc("the 2023 reunion notes went in the bin back in december, too long ago to bring back. want me to start a fresh note?")]))

S("T28-018", "restore note multi undo restore",
  T("the notes i wrote in december, did i delete them", rows("old_koha", "xmas_menu"),
    ref=[ans(kind="note", trashed=True, when=W(span(D("2025-12-01"), D("2025-12-31"))))]),
  T("get them both back", diff(restore("old_koha"), restore("xmas_menu")),
    ref=[act("restore", rows="$old_koha, $xmas_menu")]),
  T("actually undo, leave em", diff(trash("old_koha"), trash("xmas_menu")),
    ref=[act("undo")]))

S("T28-019", "restore document named folder read",
  T("restore Old will", diff(restore("old_will")),
    ref=[act("restore", kind="document", name="Old will", trashed=True)]),
  T("which folder is it in", rows("whanau_f"),
    ref=[ans(kind="folder", linked_to="$old_will")]),
  T("what's else in there", rows("chart_scan", "notice", "old_will"),
    ref=[ans(kind="document", linked_to="$whanau_f")]))

S("T28-020", "restore document named restore window ask",
  T("i need the old will back, the lawyer wants to see it", diff(restore("old_will")),
    ref=[act("restore", kind="document", name="Old will", trashed=True)]),
  T("and the december power bill too", ask(),
    ref=[bad(act("restore", kind="document", name="Power bill December", trashed=True)),
         askc("the december power bill was binned on 5 january, past the 30 days, so it can't come back. add it again from the email?")]),
  T("nah leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T28-021", "star document where week folder",
  T("star whatever i put in the reunion folder this week", diff(upd("tshirt_design", starred=True)),
    ref=[act("star", kind="document", linked_to="$reunion_f", when=W(U("week", 0)))]),
  T("how many starred docs have i got", val(4),
    ref=[ans(op="count", kind="document", where="starred = yes")]))

S("T28-022", "star document where yesterday",
  T("the doc i saved yesterday, star it", diff(upd("blood_results", starred=True)),
    ref=[act("star", kind="document", when=W(U("day", -1)))]),
  T("what folder's that in", rows("health_f"),
    ref=[ans(kind="folder", linked_to="$blood_results")]))

S("T28-023", "photo rel time unit edit photo prev",
  T("the photo from yesterday at half four", rows("p_waka"),
    ref=[ans(kind="photo", when=W(U("day", -1, time="16:30")))]),
  T("call it Manaia on Lake Rotorua", diff(upd("p_waka", name="Manaia on Lake Rotorua")),
    ref=[act("edit", rows="@prev", args=lines(name="Manaia on Lake Rotorua"))]))

S("T28-024", "photo rel weekday within edit photo prev",
  T("pics from last saturday", rows("p_cricket", "p_working", "p_roof"),
    ref=[ans(kind="photo", when=W(U("week", -1, weekday=6)))]),
  T("the one with nobody in it", rows("p_roof"),
    ref=[ans(within="@prev", where="person count = 0")]),
  T("rename that to Wharekai roof leak", diff(upd("p_roof", name="Wharekai roof leak")),
    ref=[act("edit", rows="@prev", args=lines(name="Wharekai roof leak"))]),
  T("put it in the marae album", ask(),
    ref=[find(kind="album", name="marae"),
         askc("there's no marae album. make one and put the roof photo in it?")]))

S("T28-025", "restore photo where weekday trashed",
  T("i deleted a photo from last saturday by mistake, restore it", diff(restore("p_dup")),
    ref=[act("restore", kind="photo", trashed=True, when=W(U("week", -1, weekday=6)))]),
  T("oh its the duplicate. delete it again", diff(trash("p_dup")),
    ref=[act("delete", rows="$p_dup")]))
