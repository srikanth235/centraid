from gold import *


S("T24-026", "album photo count edit album multi count empty album",
  T("which albums have exactly three photos", rows("lucia_al", "juarez_al", "yards_al"),
    ref=[ans(kind="album", where="photo count = 3")]),
  T("rename Landscaping jobs and Rudy's yards both to Yard work, same thing",
    diff(upd("land_al", name="Yard work"), upd("yards_al", name="Yard work")),
    ref=[act("edit", rows="$land_al, $yards_al", args=lines(name="Yard work"))]),
  T("does Banquet 2026 have anything in it yet", val(0),
    ref=[ans(op="count", kind="photo", linked_to="$banquet_al")]))

S("T24-027", "edit album multi count albums",
  T("can you call the lucia and juárez 2025 albums Family archive, i'm cleaning up",
    diff(upd("lucia_al", name="Family archive"), upd("juarez_al", name="Family archive")),
    ref=[act("edit", rows="$lucia_al, $juarez_al", args=lines(name="Family archive"))]),
  T("how many albums do i have", val(7),
    ref=[ans(op="count", kind="album")]))

S("T24-028", "delete photo where knock-on photo undo photo star",
  T("what's in the landscaping jobs album", rows("p_whit_before", "p_whit_after", "p_soto_front", "p_sprinkler"),
    ref=[ans(kind="photo", linked_to="$land_al")]),
  T("delete the one from the twenty-ninth", diff(trash("p_soto_front"), unlink("land_al", "p_soto_front"),
                                        unlink("yards_al", "p_soto_front")),
    ref=[act("delete", kind="photo", linked_to="$land_al", when=D("2026-08-29"))]),
  T("wait no undo, rudy uses that one for his flyers", diff(restore("p_soto_front"), link("land_al", "p_soto_front"),
                                                            link("yards_al", "p_soto_front")),
    ref=[act("undo")]),
  T("star it then", diff(upd("p_soto_front", starred=True)),
    ref=[find(kind="photo", name="Soto front yard"),
         act("star", rows="$p_soto_front")]))

S("T24-029", "photo weekday delete photo where knock-on photo undo",
  T("pics from last saturday", rows("p_whit_before", "p_whit_after", "p_sprinkler"),
    ref=[ans(kind="photo", when=U("week", -1, weekday=6))]),
  T("delete the one hector's in", diff(trash("p_whit_after"), unlink("land_al", "p_whit_after")),
    ref=[act("delete", kind="photo", when=U("week", -1, weekday=6), linked_to="$hector")]),
  T("undo that", diff(restore("p_whit_after"), link("land_al", "p_whit_after")),
    ref=[act("undo")]))

S("T24-030", "photo month remove_from photo where count",
  T("family album pics from september", rows("p_ama", "p_vb", "p_bbq", "p_play"),
    ref=[ans(kind="photo", linked_to="$fam_al", when=U("month", 0, name=9))]),
  T("take the one from the tenth out of family, it's in lucia's already", diff(unlink("fam_al", "p_play")),
    ref=[act("remove_from", kind="photo", linked_to="$fam_al", when=D("2026-09-10"), args=lines(from_="$fam_al"))]),
  T("how many left in family", val(6),
    ref=[ans(op="count", kind="photo", linked_to="$fam_al")]))

S("T24-031", "remove_from photo where create album add_to new",
  T("take whatever's in the basketball album from the las cruces clinic day, aug twenty-second, out of it",
    diff(unlink("team_al", "p_clinic")),
    ref=[act("remove_from", kind="photo", linked_to="$team_al", when=D("2026-08-22"), args=lines(from_="$team_al"))]),
  T("put it in a new album called Coaching clinics", diff(new("album", name="Coaching clinics"), link("new", "p_clinic")),
    ref=[act("create", args=lines(kind="album", name="Coaching clinics"), more=True),
         act("add_to", rows="$p_clinic", args=lines(to="$new"))]))

S("T24-032", "create document folder remove_from document new add_to",
  T("new doc Scrimmage waiver in the team folder", diff(new("document", name="Scrimmage waiver"), link("team_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Scrimmage waiver", folder="$team_f"))]),
  T("hmm take it out of team, the office keeps those", diff(unlink("team_f", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$team_f"))]),
  T("put it in school", diff(link("school_f", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$school_f"))]),
  T("undo, the office wants it loose", diff(unlink("school_f", "+1")),
    ref=[act("undo")]))

S("T24-033", "create document remove_from document new",
  T("make a document Whitfield October invoice in landscaping invoices",
    diff(new("document", name="Whitfield October invoice"), link("land_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Whitfield October invoice", folder="$land_f"))]),
  T("pull it back out, rudy does the invoices for october", diff(unlink("land_f", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$land_f"))]))

S("T24-034", "folder count delete document where find-only trashed restore document prev",
  T("documents outside all folders", rows("scan", "vax", "receipt"),
    ref=[ans(kind="document", where="folder count < 1")]),
  T("delete the one from the thirteenth", diff(trash("receipt")),
    ref=[act("delete", kind="document", where="folder count < 1", when=D("2026-09-13"))]),
  T("is there an old roster in the doc trash", rows("old_roster"),
    ref=[find(kind="document", name="roster", trashed=True), ans(rows="@prev")]),
  T("bring it back, need last year's heights", diff(restore("old_roster")),
    ref=[act("restore", rows="@prev")]))

S("T24-035", "delete document where undo delete",
  T("delete the unfiled scan from last saturday", diff(trash("scan")),
    ref=[act("delete", kind="document", when=U("week", -1, weekday=6), where="folder count = 0")]),
  T("undo, i haven't checked what it is", diff(restore("scan")),
    ref=[act("undo")]))

S("T24-036", "find-only trashed document restore document prev",
  T("any team docs sitting in the trash", rows("old_roster"),
    ref=[find(kind="document", linked_to="$team_f", trashed=True), ans(rows="@prev")]),
  T("restore it", diff(restore("old_roster")),
    ref=[act("restore", rows="@prev")]),
  T("hm undo, ray has last year's roster", diff(trash("old_roster")),
    ref=[act("undo")]))

S("T24-037", "folder document count edit folder where document datetime span",
  T("any empty folders", rows("old_f"),
    ref=[ans(kind="folder", where="document count = 0")]),
  T("rename the empty one to Taxes", diff(upd("old_f", name="Taxes")),
    ref=[act("edit", kind="folder", where="document count = 0", args=lines(name="Taxes"))]),
  T("docs from 8am on the twelfth to noon on the thirteenth", rows("inv_whit", "scan", "receipt"),
    ref=[ans(kind="document", when=span(D("2026-09-12", "08:00"), D("2026-09-13", "12:00")))]))

S("T24-038", "edit folder where add_to document named",
  T("the folder with no docs in it, call it Receipts", diff(upd("old_f", name="Receipts")),
    ref=[act("edit", kind="folder", where="document count < 1", args=lines(name="Receipts"))]),
  T("and move Receipt Home Depot in there", diff(link("old_f", "receipt")),
    ref=[act("add_to", rows="$receipt", args=lines(to="$old_f"))]))

S("T24-039", "find-only notebook note count edit notebook prev",
  T("which notebook is empty", rows("ideas_nb"),
    ref=[find(kind="notebook", where="note count < 1"), ans(rows="@prev")]),
  T("rename it Scouting reports", diff(upd("ideas_nb", name="Scouting reports")),
    ref=[act("edit", rows="@prev", args=lines(name="Scouting reports"))]),
  T("number of notebooks holding under four notes", val(4),
    ref=[ans(op="count", kind="notebook", where="note count < 4")]))

S("T24-040", "find notebook linked_to edit notebook prev",
  T("which notebook is my soto quote in", rows("land_nb"),
    ref=[find(kind="note", name="Soto quote"), search("Soto", kind="note"), ans(kind="notebook", linked_to="$soto_note")]),
  T("rename that notebook Rudy's crew", diff(upd("land_nb", name="Rudy's crew")),
    ref=[act("edit", rows="@prev", args=lines(name="Rudy's crew"))]))

S("T24-041", "locker type enum delete locker where undo delete",
  T("what crypto stuff have i got in the locker", rows("coinbase"),
    ref=[ans(kind="locker item", where='type = "crypto_wallet"')]),
  T("delete it, it's worth like 4 bucks", diff(trash("coinbase")),
    ref=[act("delete", kind="locker item", where='type = "crypto_wallet"')]),
  T("undo that, elena says keep it", diff(restore("coinbase")),
    ref=[act("undo")]))

S("T24-042", "delete locker where star locker named",
  T("delete my ssh key entry, the old server is gone", diff(trash("server_key")),
    ref=[act("delete", kind="locker item", where='type = "ssh_key"')]),
  T("star Texas driver license", diff(upd("license", starred=True)),
    ref=[act("star", rows="$license")]))

S("T24-043", "single star locker named",
  T("star the Gym alarm code, i need it every morning at 6", diff(upd("gym_alarm", starred=True)),
    ref=[act("star", kind="locker item", name="Gym alarm code")]))

S("T24-044", "locker notes in reveal",
  T("locker stuff tagged school or union", rows("district", "aft_card"),
    ref=[ans(kind="locker item", where='notes in ("school", "union")')]),
  T("what's the password on the district portal", diff(reveal=[("district", "Chamizal-1963!")]),
    ref=[act("reveal", rows="$district", args=lines(field="password"))]))

S("T24-045", "locker notes in within type star prev",
  T("which locker items are tagged personal or union", rows("venmo", "savings", "aft_card"),
    ref=[ans(kind="locker item", where='notes in ("personal", "union")')]),
  T("which of those is a membership", rows("aft_card"),
    ref=[find(kind="locker item", within="@prev", where='type = "membership"'), ans(rows="@prev")]),
  T("star it", diff(upd("aft_card", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T24-046", "four turns note person count note spans delete note named",
  T("notes about exactly two people", rows("proposal_notes", "soto_note", "party_list"),
    ref=[ans(kind="note", where="person count = 2")]),
  T("notes from august through the fifth of sept", rows("caldo", "sources", "vb_sched", "bargain_dates", "mulch_note"),
    ref=[ans(kind="note", when=span(U("month", 0, name=8), D("2026-09-05")))]),
  T("and from sept first to 6pm on the twelfth", rows("vb_sched", "bargain_dates", "mulch_note", "press", "chamizal_facts",
                                              "survey_qs", "whitfield_note", "car_note"),
    ref=[ans(kind="note", when=span(U("month", 0, name=9), D("2026-09-12", "18:00")))]),
  T("delete Car maintenance, it's all in the glovebox", diff(trash("car_note")),
    ref=[act("delete", kind="note", name="Car maintenance")]))

S("T24-047", "five turns trashed note restore note named restore window ask create undo create",
  T("did i delete my old practice plan", rows("old_plan"),
    ref=[ans(kind="note", name="Old practice plan", trashed=True)]),
  T("restore Old practice plan", diff(restore("old_plan")),
    ref=[act("restore", kind="note", name="Old practice plan", trashed=True)]),
  T("and Summer camp ideas", ask(),
    ref=[bad(act("restore", kind="note", name="Summer camp ideas", trashed=True)),
         askc("that one went in the bin on july 1, past the 30 days, so it can't come back. want a fresh note?")]),
  T("yes same name, shooting camp for middle schoolers",
    diff(new("note", name="Summer camp ideas", body=has("shooting camp"))),
    ref=[act("create", args=lines(kind="note", name="Summer camp ideas", body="shooting camp for middle schoolers"))]),
  T("undo, ray already wrote it up", diff(trash("+1")),
    ref=[act("undo")]))

S("T24-048", "note person count rel time",
  T("which notes have only one person on them",
    rows("zone", "ft_note", "drills", "practice_plan", "survey_qs", "whitfield_note", "caldo", "enchiladas",
         "gift_elena", "vb_sched"),
    ref=[ans(kind="note", where="person count = 1")]),
  T("what did i write the day before yesterday at 6:45 in the morning", rows("questions"),
    ref=[ans(kind="note", when=U("day", -2, time="06:45"))]))

S("T24-049", "note anchor linked person pin prev",
  T("notes from a week ago today", rows("survey_qs"),
    ref=[find(kind="note", when=U("day", -7, anchor="today")), ans(rows="@prev")]),
  T("pin it", diff(upd("survey_qs", pinned=True)),
    ref=[act("edit", rows="@prev", args=lines(pinned="yes"))]),
  T("who's on that note", rows("kim"),
    ref=[ans(kind="person", linked_to="$survey_qs")]))

S("T24-050", "five turns person weekday span role != event count log prev",
  T("anyone i spoke with on thursday last week", rows("linda"),
    ref=[ans(kind="person", when=U("week", -1, weekday=4))]),
  T("and monday to wednesday this week", rows("javier", "david_r", "yvonne", "patty", "david_s"),
    ref=[ans(kind="person", when=span(U("week", 0, weekday=1), U("week", 0, weekday=3)))]),
  T("of those who's not a team parent", rows("javier", "david_r", "david_s"),
    ref=[ans(kind="person", within="@prev", where='role != "team parent"')]),
  T("which of them is on exactly 2 events", rows("david_r"),
    ref=[ans(kind="person", within="@prev", where="event count = 2")]),
  T("log a call with him, talked about the concession stand", diff(upd("david_r", date=ANY)),
    ref=[act("log", rows="@prev", args=lines(kind="call"))]))
