from gold import *

world("T25", "2026-10-11T18:45", "Yuki Tanaka", "train")


S("T25-001", "single event day read",
  T("what's on tomorrow", rows("thanksgiving"),
    ref=[ans(kind="event", when=U("day", 1))]))

S("T25-002", "person where starred unstar prev",
  T("which of my starred people are from work", rows("jess"),
    ref=[ans(kind="person", where='starred = yes and met = "work"')]),
  T("unstar her", diff(upd("jess", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T25-003", "person role contains within starred unstar prev",
  T("who's in the hiking crew", rows("marc_g", "nadia", "tom", "elise"),
    ref=[ans(kind="person", where='role contains "hiking"')]),
  T("any of them starred?", rows("nadia"),
    ref=[ans(kind="person", within="@prev", where="starred = yes")]),
  T("take the star off", diff(upd("nadia", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T25-004", "create person star unstar new",
  T("add Lea Fontaine to contacts, she's the mom of mika's best friend",
    diff(new("person", name="Lea Fontaine", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Lea Fontaine", role="mom of Mika's best friend"))]),
  T("star her", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("hmm no unstar, i'll barely talk to her", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]))

S("T25-005", "create person star unstar new already star",
  T("new contact Omar Haddad, nadia's husband", diff(new("person", name="Omar Haddad", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Omar Haddad", role="Nadia's husband"))]),
  T("star him", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("wait no, unstar him. i meant nadia", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]),
  T("ok star Nadia Haddad", diff(already=["nadia"]), rows("nadia"),
    ref=[act("star", kind="person", name="Nadia Haddad"), ans(rows="$nadia")]))

S("T25-006", "create group add_to edit new",
  T("make a group for ski season with daniel",
    diff(new("group", name=has("Ski")), link("new", "me"), link("new", "daniel")),
    ref=[act("create", args=lines(kind="group", name="Ski season"), more=True),
         act("add_to", rows="$daniel", args=lines(to="$new"))]),
  T("rename it Mika ski season", diff(upd("+1", name="Mika ski season")),
    ref=[act("edit", rows="$c1", args=lines(name="Mika ski season"))]))

S("T25-007", "four turns create group usd edit new add_to members",
  T("new group NYC trip, in US dollars", diff(new("group", name="NYC trip", currency="USD"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="NYC trip", currency="USD"))]),
  T("call it NYC in december", diff(upd("+1", name="NYC in December")),
    ref=[act("edit", rows="$c1", args=lines(name="NYC in December"))]),
  T("add nadia and jess", diff(link("+1", "nadia"), link("+1", "jess")),
    ref=[act("add_to", rows="$nadia, $jess", args=lines(to="$c1"))]),
  T("who's in it now", rows("me", "nadia", "jess"),
    ref=[ans(kind="person", linked_to="$c1")]))

S("T25-008", "single delete group named knock-on",
  T("delete the Lumen lunch club group, nobody uses it",
    diff(gone("lunch_club"), unlink("lunch_club", "olivier"), unlink("lunch_club", "priya"),
         unlink("lunch_club", "jess"), unlink("lunch_club", "me")),
    ref=[act("delete", kind="group", name="Lumen lunch club")]))

S("T25-009", "refused delete group ask delete group named",
  T("delete the vermont weekend group", ask(),
    ref=[bad(act("delete", kind="group", name="Vermont weekend")),
         askc("it still has the airbnb and the dinner in it, so it can't be deleted. settle it up first?")]),
  T("nah leave it. get rid of the halloween party fund",
    diff(gone("halloween"), unlink("halloween", "me")),
    ref=[act("delete", kind="group", name="Halloween party fund")]))

S("T25-010", "delete event multi named",
  T("delete the halloween party and the bike tune-up, not doing either",
    diff(trash("halloween_ev"), trash("bike_tune")),
    ref=[act("delete", rows="$halloween_ev, $bike_tune")]))

S("T25-011", "event person count next week delete multi",
  T("next week, what's on with one person or fewer",
    rows("one_on_one", "therapy_1013", "coffee_marc", "portfolio_rev", "lawyer_call", "handoff_1016",
         "mom_flight"),
    ref=[ans(kind="event", when=U("week", 1), where="person count <= 1")]),
  T("drop the coffee with marc and the call with the lawyer, moving both",
    diff(trash("coffee_marc"), trash("lawyer_call")),
    ref=[act("delete", rows="$coffee_marc, $lawyer_call")]))

S("T25-012", "trashed event read restore prev",
  T("is movie night in the trash?", rows("movie_night"),
    ref=[ans(kind="event", name="Movie night", trashed=True)]),
  T("put it back, rachel wants to", diff(restore("movie_night")),
    ref=[act("restore", rows="@prev")]))

S("T25-013", "trashed event find restore prev restore window",
  T("what events did i delete", rows("drinks_kevin", "movie_night", "pottery"),
    ref=[find(kind="event", trashed=True), ans(rows="@prev")]),
  T("the pottery one, bring it back", ask(),
    ref=[bad(act("restore", rows="$pottery")),
         askc("pottery class went to the bin on aug 20, past the 30 days, so it can't come back. want me to add it again as a new event?")]),
  T("no. the drinks with kevin one", diff(restore("drinks_kevin")),
    ref=[act("restore", kind="event", name="Drinks with Kevin", trashed=True)]))

S("T25-014", "single delete task named",
  T("delete Plan November hike route, marc is doing it", diff(trash("route")),
    ref=[act("delete", kind="task", name="Plan November hike route")]))

S("T25-015", "list tasks delete task multi",
  T("what's on my errands list", rows("dry_clean", "groceries", "library", "pharmacy"),
    ref=[ans(kind="task", linked_to="$errands_l")]),
  T("delete Pick up dry cleaning and Return library books, mom did both", diff(trash("dry_clean"), trash("library")),
    ref=[act("delete", rows="$dry_clean, $library")]))

S("T25-016", "single delete note where",
  T("delete whichever note mentions the modem", diff(trash("modem")),
    ref=[act("delete", kind="note", where='body contains "modem"')]))

S("T25-017", "restore note where trashed",
  T("the note with milk and eggs, restore it", diff(restore("old_grocery")),
    ref=[act("restore", kind="note", trashed=True, where='body contains "milk"')]),
  T("how many deleted notes have i got", val(2),
    ref=[ans(op="count", kind="note", trashed=True)]))

S("T25-018", "document folder count delete prev",
  T("show docs that aren't filed anywhere", rows("camp_receipt", "boots_receipt", "scan_a", "scan_b", "passport_app"),
    ref=[ans(kind="document", where="folder count <= 0")]),
  T("the scans from friday, show me those", rows("scan_a", "scan_b"),
    ref=[ans(kind="document", within="@prev", when=U("week", 0, weekday=5))]),
  T("delete them, blank pages", diff(trash("scan_a"), trash("scan_b")),
    ref=[act("delete", rows="@prev")]))

S("T25-019", "create document delete restore new",
  T("save a doc called Custody calendar 2027", diff(new("document", name="Custody calendar 2027")),
    ref=[act("create", args=lines(kind="document", name="Custody calendar 2027"))]),
  T("delete it, josee is sending the real one", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("hm no restore it, i'll keep my draft", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

S("T25-020", "remove_from document multi count",
  T("take Lease 2026 and Renters insurance out of the apartment folder",
    diff(unlink("apt_f", "lease"), unlink("apt_f", "insurance")),
    ref=[act("remove_from", rows="$lease, $insurance", args=lines(from_="$apt_f"))]),
  T("what's left in it", rows("move_in"),
    ref=[ans(kind="document", linked_to="$apt_f")]))

S("T25-021", "photo named delete prev",
  T("the rainy saturday pic?", rows("rainy"),
    ref=[ans(kind="photo", name="Rainy Saturday")]),
  T("delete it", diff(trash("rainy")),
    ref=[act("delete", rows="@prev")]))

S("T25-022", "album photos span remove_from prev",
  T("anything in the hikes album from the vermont weekend", rows("camels_hump"),
    ref=[ans(kind="photo", linked_to="$hikes_album", when=span(D("2026-08-21"), D("2026-08-23")))]),
  T("take it out of hikes, it's already in vermont", diff(unlink("hikes_album", "camels_hump")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$hikes_album"))]))

S("T25-023", "single delete album named knock-on",
  T("delete the Green Mountains album, photos stay",
    diff(gone("vermont_album"), unlink("vermont_album", "burlington"), unlink("vermont_album", "waterbury"),
         unlink("vermont_album", "camels_hump")),
    ref=[act("delete", kind="album", name="Green Mountains")]))

S("T25-024", "locker named read delete prev",
  T("the crypto wallet in my locker, what's that", rows("crypto"),
    ref=[ans(kind="locker item", name="crypto wallet")]),
  T("delete it, there's nothing in it", diff(trash("crypto")),
    ref=[act("delete", rows="@prev")]))

S("T25-025", "single star locker where",
  T("star the wifi one in my locker", diff(upd("wifi", starred=True)),
    ref=[act("star", kind="locker item", where='type = "wifi"')]))
