from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T10-051", "single debt direction empty",
  T("any debts where i never put down who owes who", rows(),
    ref=[ans(kind="debt", where="direction is empty")]))

S("T10-052", "locker username ne read",
  T("logins that aren't under bashir.haddad52@gmail.com", rows("sanad", "lichess", "arab_bank"),
    ref=[ans(kind="locker item", where='type = "login" and username != "bashir.haddad52@gmail.com"')]),
  T("what's the url for arab bank online", rows("arab_bank"),
    ref=[ans(rows="$arab_bank")]))

S("T10-053", "locker url in star multi",
  T("which saved logins are for https://lichess.org or https://sanad.gov.jo", rows("lichess", "sanad"),
    ref=[ans(kind="locker item", where='url in ("https://lichess.org", "https://sanad.gov.jo")')]),
  T("star the pair of them", diff(upd("lichess", starred=True), upd("sanad", starred=True)),
    ref=[act("star", rows="$lichess, $sanad")]))

S("T10-054", "folder doc count lte linked read",
  T("folders that have either one document or nothing", rows("scans_f", "misc_f", "travel_f"),
    ref=[ans(kind="folder", where="document count <= 1")]),
  T("what's in old scans", rows("school_certs"),
    ref=[ans(kind="document", linked_to="$scans_f")]))

S("T10-055", "create person delete new",
  T("add Faisal Momani, the new eye doctor at Al-Khalidi", diff(new("person", name="Faisal Momani", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Faisal Momani", role="eye doctor, Al-Khalidi"))]),
  T("ah no, dr rania's clinic does eyes too. delete him", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("so the book eye test task, when is it", rows("eye_test"),
    ref=[ans(kind="task", name="Book eye test")]))

S("T10-056", "find ambiguous person ask star",
  T("star sami", ask("sami_h", "sami_k"),
    ref=[find(kind="person", name="Sami"),
         act("star", kind="person", name="Sami"),
         askc("your grandson sami haddad or sami khoury from the club?", options="$sami_h, $sami_k")]),
  T("khoury", diff(upd("sami_k", starred=True)),
    ref=[act("star", rows="$sami_k")]),
  T("and what's he down for coming up", rows("chess_0623", "chess_0630", "chess_0707", "chess_0714", "chess_0721",
                                              "chess_0728", "tournament"),
    ref=[ans(kind="event", linked_to="$sami_k", when=W({"from": U("day", 0)}))]))

S("T10-057", "trashed events restore linked",
  T("anything in the trash from the calendar", rows("jamal_lunch", "tank_clean"),
    ref=[find(kind="event", trashed=True), ans(rows="@prev")]),
  T("put the jamal one back", diff(restore("jamal_lunch")),
    ref=[act("restore", rows="$jamal_lunch")]),
  T("who's on it", rows("jamal"),
    ref=[ans(kind="person", linked_to="$jamal_lunch")]),
  T("and when did i last actually talk to him", rows("jamal"),
    ref=[ans(rows="$jamal")]),
  T("put a phone call with him on the record, confirming it", diff(upd("jamal", date=ANY)),
    ref=[act("log", rows="$jamal", args=lines(kind="call"))]))

S("T10-058", "note create add_to new pin undo",
  T("new note Tile colours: light grey floor, white walls, check with Ziad. put it in the mosque fund notebook",
    diff(new("note", name=has("Tile colours"), body=has("grey")), link("mosque_nb", "new")),
    ref=[act("create", more=True, args=lines(kind="note", name="Tile colours", body="light grey floor, white walls, check with Ziad")),
         act("add_to", rows="$new", args=lines(to="$mosque_nb"))]),
  T("pin that note", diff(upd("+1", pinned=True)),
    ref=[act("edit", rows="$c1", args=lines(pinned="yes"))]),
  T("how many are pinned in that notebook", val(2),
    ref=[ans(op="count", kind="note", linked_to="$mosque_nb", where="pinned = yes")]))

S("T10-059", "find ambiguous album rename",
  T("rename the eid album to Eid 2026", ask("fitr_album", "adha_album"),
    ref=[find(kind="album", name="Eid"),
         act("edit", kind="album", name="Eid", args=lines(name="Eid 2026")),
         askc("the eid al-fitr one or eid al-adha?", options="$fitr_album, $adha_album")]),
  T("adha", diff(upd("adha_album", name="Eid 2026")),
    ref=[act("edit", rows="$adha_album", args=lines(name="Eid 2026"))]))

S("T10-060", "refused group delete ask never mind",
  T("delete the mosque renovation fund group, ziad keeps it all in excel", ask(),
    ref=[bad(act("delete", rows="$mosque")),
         askc("it still has expenses in it so the vault won't delete it. settle up and leave it?")]),
  T("leave it then", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T10-061", "group members remove multi delete group",
  T("who's in the old building committee", rows("adel", "umm_khalil", "me"),
    ref=[ans(kind="person", linked_to="$building")]),
  T("take adel and umm khalil out", diff(unlink("building", "adel"), unlink("building", "umm_khalil")),
    ref=[act("remove_from", rows="$adel, $umm_khalil", args=lines(from_="$building"))]),
  T("and get rid of the group", diff(gone("building"), unlink("building", "me")),
    ref=[act("delete", rows="$building")]))

S("T10-062", "locker username ne within",
  T("any logins not under bhaddad", rows("gmail", "sanad", "lichess"),
    ref=[find(kind="locker item", where='type = "login" and username != "bhaddad"'), ans(rows="@prev")]),
  T("which of them are starred", rows("gmail"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T10-063", "folder read star document multi",
  T("what's in the mosque fund folder", rows("tile_quote", "fund_ledger", "carpet_inv"),
    ref=[ans(kind="document", linked_to="$mosque_f")]),
  T("star the tile quote and the carpet invoice, ziad needs them",
    diff(upd("tile_quote", starred=True), upd("carpet_inv", starred=True)),
    ref=[act("star", rows="$tile_quote, $carpet_inv")]))

S("T10-064", "refused folder delete move then delete",
  T("delete the old scans folder", ask(),
    ref=[bad(act("delete", kind="folder", name="Old scans")),
         askc("the school certificates are still in it. move them somewhere first?")]),
  T("move them to property deeds and then delete it",
    diff(unlink("scans_f", "school_certs"), link("deeds_f", "school_certs"), gone("scans_f")),
    ref=[find(kind="document", linked_to="$scans_f"),
         act("add_to", rows="@prev", args=lines(to="$deeds_f"), more=True),
         act("delete", kind="folder", name="Old scans")]),
  T("what's in property deeds", rows("deed_house", "deed_land", "school_certs"),
    ref=[ans(kind="document", linked_to="$deeds_f")]))

S("T10-065", "tournament five turns subtasks complete reschedule",
  T("when's the amman open chess tournament", rows("tournament"),
    ref=[ans(kind="event", name="Amman open chess tournament")]),
  T("who's playing", rows("tariq", "sami_k", "faris", "mounir"),
    ref=[ans(kind="person", linked_to="$tournament")]),
  T("what's under prepare tournament pairings", rows("pair_list", "pair_print"),
    ref=[ans(kind="task", linked_to="$pairings")]),
  T("print score sheets is done", diff(upd("pair_print", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pair_print")]),
  T("and move confirm player list to monday", diff(upd("pair_list", date="2026-06-22")),
    ref=[act("reschedule", rows="$pair_list", args=lines(to=U("week", 1, weekday=1)))]))

S("T10-066", "log where nickname debt",
  T("umm khalil brought bread round, log a visit", diff(upd("umm_khalil", date=ANY)),
    ref=[act("log", kind="person", where='nickname = "Umm Khalil"', args=lines(kind="visit"))]),
  T("how's the bread from the bakery debt looking", rows("d_umm_khalil"),
    ref=[ans(kind="debt", linked_to="$umm_khalil")]),
  T("forget it, mark it settled", diff(upd("d_umm_khalil", status="settled")),
    ref=[act("settle_debt", rows="$d_umm_khalil")]),
  T("wait undo that, she insists on paying", diff(),
    ref=[act("undo")]))

S("T10-067", "unstar photo multi starred",
  T("unstar the eid table at nabil's and the club trophy 2025 pic",
    diff(upd("fitr_table", starred=False), upd("chess_trophy", starred=False)),
    ref=[act("unstar", rows="$fitr_table, $chess_trophy")]),
  T("what's still starred", rows("adha_family", "yousef_bike", "aqaba_sea", "jasmine_p", "umm_rami", "wedding_old"),
    ref=[ans(kind="photo", where="starred = yes")]))

S("T10-068", "locker url in reveal",
  T("have i got anything saved for https://mail.google.com or https://online.arabbank.jo", rows("gmail", "arab_bank"),
    ref=[ans(kind="locker item", where='url in ("https://mail.google.com", "https://online.arabbank.jo")')]),
  T("show me the bank ones password", diff(reveal=[("arab_bank", "Madaba-Land-9")]),
    ref=[act("reveal", rows="$arab_bank", args=lines(field="password"))]))

S("T10-069", "locker edit where passport task",
  T("add renew before the london trip to my passport entry", diff(upd("passport_l", notes="renew before the london trip")),
    ref=[act("edit", kind="locker item", where='type = "passport"', args=lines(notes="renew before the london trip"))]))

S("T10-070", "single reschedule task named",
  T("move pay property tax to july fifth", diff(upd("prop_tax", date="2026-07-05")),
    ref=[act("reschedule", kind="task", name="Pay property tax", args=lines(to=D("2026-07-05")))]))

S("T10-071", "restore window task ask create",
  T("bring back the umrah task", ask(),
    ref=[bad(act("restore", kind="task", name="Book Umrah package", trashed=True)),
         askc("it's been in the bin more than 30 days so it can't come back. make it again?")]),
  T("yes, due end of august, on the travel list",
    diff(new("task", name="Book Umrah package", date="2026-08-31"), link("travel_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Book Umrah package", date=D("2026-08-31"), list="$travel_l"))]),
  T("what's on the travel list", rows("flight", "passport", "visa", "+1"),
    ref=[ans(kind="task", linked_to="$travel_l")]))

S("T10-072", "reschedule task multi anchor week",
  T("when's the ablution area renovation due", rows("ablution"),
    ref=[ans(kind="task", name="Ablution area renovation")]),
  T("what's left under it", rows("tiles", "plumber", "taps"),
    ref=[ans(kind="task", linked_to="$ablution")]),
  T("push choose tiles and order taps back a week each", diff(upd("tiles", date="2026-07-02"), upd("taps", date="2026-07-22")),
    ref=[act("reschedule", rows="$tiles, $taps", args=lines(to=U("week", 1, anchor="row")))]))

S("T10-073", "six turns lina visit",
  T("when's lina landing", rows("airport_lina"),
    ref=[ans(kind="event", name="Pick up Lina from the airport")]),
  T("who's going to pick up lina from the airport", rows("lina", "abu_ahmad"),
    ref=[ans(kind="person", linked_to="$airport_lina")]),
  T("what's abu ahmad's actual name, i always forget", rows("abu_ahmad"),
    ref=[ans(kind="person", where='nickname = "Abu Ahmad"')]),
  T("and the dinner after, who's coming", rows("lina", "layla", "karim"),
    ref=[find(kind="event", name="Dinner with Lina and Layla"), ans(kind="person", linked_to="@prev")]),
  T("have i sorted layla's birthday gift", rows("layla_gift"),
    ref=[ans(kind="task", name="Buy birthday gift for Layla")]),
  T("not yet. make it due the first and priority one", diff(upd("layla_gift", date="2026-07-01", priority=1)),
    ref=[act("reschedule", rows="$layla_gift", args=lines(to=D("2026-07-01")), more=True),
         act("edit", rows="$layla_gift", args=lines(priority=1))]))

S("T10-074", "met in star",
  T("anyone i met in amman or london", rows("karim", "nabil", "huda", "khaled_s"),
    ref=[find(kind="person", where='met in ("Amman", "London")'), ans(rows="@prev")]))

S("T10-075", "trashed photos restore window multi repair",
  T("which photos have i deleted", rows("trash_selfie", "trash_menu", "trash_old"),
    ref=[find(kind="photo", trashed=True), ans(rows="@prev")]),
  T("restore all of them", diff(restore("trash_selfie"), restore("trash_menu")),
    ref=[bad(act("restore", rows="$trash_selfie, $trash_menu, $trash_old")),
         act("restore", rows="$trash_selfie, $trash_menu")]))
