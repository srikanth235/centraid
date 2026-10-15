from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T10-052", "locker username ne read",
  T("logins that aren't under bashir.haddad52@gmail.com", rows("sanad", "lichess", "arab_bank"),
    ref=[ans(kind="locker item", where='type = "login" and username != "bashir.haddad52@gmail.com"')]),
  T("what's the url for arab bank online", rows("arab_bank"),
    ref=[ans(rows="$arab_bank")]))

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
    ref=[bad(act("restore", kind="task", name="umrah", trashed=True)),
         askc("it's been in the bin more than 30 days so it can't come back. make it again?")]),
  T("yes, due end of august, on the travel list",
    diff(new("task", name="Book Umrah package", date="2026-08-31"), link("travel_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Book Umrah package", date=D("2026-08-31"), list="$travel_l"))]),
  T("what's on the travel list", rows("flight", "passport", "visa", "+1"),
    ref=[ans(kind="task", linked_to="$travel_l")]))

S("T10-074", "met in star",
  T("anyone i met in amman or london", rows("karim", "nabil", "huda", "khaled_s"),
    ref=[find(kind="person", where='met in ("Amman", "London")'), ans(rows="@prev")]))

S("T10-075", "trashed photos restore window multi repair",
  T("which photos have i deleted", rows("trash_selfie", "trash_menu", "trash_old"),
    ref=[find(kind="photo", trashed=True), ans(rows="@prev")]),
  T("restore all of them", diff(restore("trash_selfie"), restore("trash_menu")),
    ref=[bad(act("restore", rows="$trash_selfie, $trash_menu, $trash_old")),
         act("restore", rows="$trash_selfie, $trash_menu")]))
