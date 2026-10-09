from gold import *
import json

world("T35", "2026-11-12T19:20", "Freya Lindqvist", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T35-026", "find-only exclude when status complete reschedule",
  T("open seilklubb tasks due before the agm besides the receipts one", rows("kitty_sheet", "agm_report"),
    ref=[find(kind="task", linked_to="$klubb_list", where="status = open", when=J({"to": D("2026-11-28")}), exclude="$kitty_receipts"),
         ans(rows="@prev")]),
  T("tick off the spreadsheet one that's due on the 26th, tuva's got it now", diff(upd("kitty_sheet", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="spreadsheet", when=D("2026-11-26"))]),
  T("and push the treasurer's note to monday", diff(upd("agm_report", date="2026-11-16")),
    ref=[act("reschedule", rows="$agm_report", args=lines(to=U("week", 1, weekday=1)))]))

S("T35-027", "count name month status",
  T("how many lab meetings in october weren't cancelled", val(3),
    ref=[ans(op="count", kind="event", name="lab meeting", when=J(U("month", 0, name=10)), where="status != cancelled")]),
  T("same for the wednesday races in september", val(4),
    ref=[ans(op="count", kind="event", name="wednesday race", when=J(U("month", 0, name=9)), where="status != cancelled")]))

S("T35-028", "group balance me compute search",
  T("where do i stand in the kiel week 2026 group", val((63.5, "EUR")),
    ref=[search("Freya", kind="person"),
         comp(op="balance", kind="group", name="Kiel Week 2026", linked_to="$me"), ans(value="@prev")]),
  T("and the lab coffee club", val((32, "NOK")),
    ref=[comp(op="balance", kind="group", name="Lab Coffee Club", linked_to="$me"), ans(value="@prev")]),
  T("what about tuva in the seilforening kitty group", val((-1080, "NOK")),
    ref=[comp(op="balance", kind="group", name="Seilforening Kitty", linked_to="$tuva"), ans(value="@prev")]),
  T("how many people are in the lab coffee club", val(5),
    ref=[ans(op="count", kind="person", linked_to="$lab_coffee")]),
  T("and sigrid's position in the lab coffee club", val((-308, "NOK")),
    ref=[ans(op="balance", kind="group", name="Lab Coffee Club", linked_to="$sigrid")]))

S("T35-029", "locker logins reveal fabricated",
  T("which logins have i got saved that aren't starred", rows("uit_login", "tromso_kraft"),
    ref=[ans(kind="locker item", where="type = login and starred = no")]),
  T("the university one, what's the username", rows("uit_login"),
    ref=[ans(within="@prev", name="university")]),
  T("show me the password", diff(reveal=[("uit_login", "Otolith-Cod2026")]),
    ref=[act("reveal", rows="$uit_login", args="field: password")]),
  T("make me a new one for the elvia account", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T35-030", "repair cadence unit within date log",
  T("cadence longer than 2 weeks", rows("bjorn", "elin"),
    ref=[bad(ans(kind="person", where="cadence > 2 weeks")), ans(kind="person", where="cadence > 14 days")]),
  T("which of them did i talk to before september", rows("elin"),
    ref=[ans(within="@prev", when=J({"to": D("2026-08-31")}))]),
  T("log a call with her", diff(upd("elin", date=ANY)),
    ref=[act("log", rows="$elin", args="kind: call")]))

S("T35-031", "folder docs find-only delete ask never-mind star",
  T("what's in the club folder from this year", rows("club_constitution", "club_budget", "club_accounts"),
    ref=[find(kind="document", linked_to="$club_f", when=J(U("year", 0))), ans(rows="@prev")]),
  T("delete that folder", ask("club_constitution", "club_budget", "club_accounts", "boat_reg"),
    ref=[act("delete", rows="$club_f")]),
  T("no leave it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("star the budget and the accounts", diff(upd("club_budget", starred=True), upd("club_accounts", starred=True)),
    ref=[act("star", rows="$club_budget, $club_accounts")]))

S("T35-032", "ambiguous log nickname answer-line",
  T("log a call with lars", ask("lars_h", "lars_e"),
    ref=[act("log", kind="person", name="lars", args="kind: call")]),
  T("the commodore", diff(upd("lars_h", date=ANY)),
    ref=[act("log", rows="$lars_h", args="kind: call")]))

S("T35-033", "edit effort priority linked where",
  T("make the poster task 45 minutes", diff(upd("poster", effort=45)),
    ref=[act("edit", rows="$poster", args="effort: 45")]),
  T("and the sampling gear one an hour", diff(upd("cod_gear", effort=60)),
    ref=[act("edit", rows="$cod_gear", args="effort: 60")]),
  T("all the cod subtasks over an hour should be priority 2", diff(upd("cod_risk", priority=2)),
    ref=[act("edit", kind="task", linked_to="$cod", where="effort > 60 minutes", args="priority: 2")]))

S("T35-034", "star photos person year undo linked",
  T("star all of jonas's photos from this year",
    diff(upd("p_jonas_birthday", starred=True), upd("p_jonas_goal", starred=True), upd("p_jonas_kitchen", starred=True)),
    ref=[find(kind="photo", linked_to="$jonas", when=J(U("year", 0))), act("star", rows="@prev")]),
  T("undo that", diff(upd("p_jonas_birthday", starred=False), upd("p_jonas_goal", starred=False), upd("p_jonas_kitchen", starred=False)),
    ref=[act("undo")]),
  T("just the one with astrid in it", diff(upd("p_jonas_birthday", starred=True)),
    ref=[act("star", kind="photo", linked_to="$jonas, $astrid")]))

S("T35-035", "add_to notes notebook count compute",
  T("put the polar night plans note in the house notebook", diff(link("house_nb", "polar_notes")),
    ref=[act("add_to", rows="$polar_notes", args="to: $house_nb")]),
  T("and the christmas ideas one too", diff(link("house_nb", "xmas_ideas")),
    ref=[act("add_to", rows="$xmas_ideas", args="to: $house_nb")]),
  T("how many in there now", val(5),
    ref=[comp(op="count", kind="note", linked_to="$house_nb"), ans(value="@prev")]))

S("T35-036", "ambiguous star document answer-line",
  T("star the passport scan", ask("passport_scan", "jonas_passport"),
    ref=[act("star", kind="document", name="passport scan")]),
  T("mine, not jonas's", diff(upd("passport_scan", starred=True)),
    ref=[act("star", rows="$passport_scan")]))

S("T35-037", "restore person window log",
  T("bring back camilla roth", diff(restore("old_builder")),
    ref=[find(kind="person", name="camilla roth", trashed=True), act("restore", rows="@prev")]),
  T("and the old broker, svein", decline("not_found"),
    ref=[find(kind="person", name="svein", trashed=True), act("restore", rows="@prev")]),
  T("log a call with camilla, she rang about the roof", diff(upd("old_builder", date=ANY)),
    ref=[act("log", rows="$old_builder", args="kind: call")]))

S("T35-038", "restore task reschedule what-else exclude",
  T("restore the gutter task", diff(restore("old_gutter")),
    ref=[find(kind="task", name="gutter", trashed=True), act("restore", rows="@prev")]),
  T("due next saturday", diff(upd("old_gutter", date="2026-11-21")),
    ref=[act("reschedule", rows="$old_gutter", args=lines(to=U("week", 1, weekday=6)))]),
  T("what else is due that weekend", rows("heat_pump"),
    ref=[ans(kind="task", where="status = open", when=J(span(U("week", 1, weekday=6), U("week", 1, weekday=7))), exclude="$old_gutter")]))

S("T35-039", "debt sum exclude compute rows-superlative",
  T("how much do i owe", val((7870, "NOK")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open")]),
  T("without the shrink-wrap one", val((4070, "NOK")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open", exclude="$d_trond")]),
  T("and what's owed to me", val((4740, "NOK")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open")]),
  T("who's the biggest one", rows("d_bjorn"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open", order="amount desc", limit=1)]))

S("T35-040", "notes body month find-only pin",
  T("notes from november that mention ethics", rows("lab_meeting2"),
    ref=[ans(kind="note", where='body contains "ethics"', when=J(U("month", 0, name=11)))]),
  T("which notebook is that in", rows("lab_nb"),
    ref=[find(kind="notebook", linked_to="$lab_meeting2"), ans(rows="@prev")]),
  T("pin it", diff(upd("lab_meeting2", pinned=True)),
    ref=[act("edit", rows="$lab_meeting2", args="pinned: yes")]))

S("T35-041", "count name-where delete undo date-narrow",
  T("how many mortgage payments have i ticked off", val(4),
    ref=[ans(op="count", kind="task", name="pay mortgage", where="status = completed")]),
  T("delete those, they're clutter", diff(trash("mortgage_aug"), trash("mortgage_sep"), trash("mortgage_oct"), trash("mortgage_nov")),
    ref=[find(kind="task", name="pay mortgage", where="status = completed"), act("delete", rows="@prev")]),
  T("undo that", diff(restore("mortgage_aug"), restore("mortgage_sep"), restore("mortgage_oct"), restore("mortgage_nov")),
    ref=[act("undo")]),
  T("ok just the ones before october", diff(trash("mortgage_aug"), trash("mortgage_sep")),
    ref=[find(kind="task", name="pay mortgage", where="status = completed", when=J({"to": D("2026-09-30")})), act("delete", rows="@prev")]))

S("T35-042", "create group add_to remove_from linked-new",
  T("make a group for the christmas presents with mamma, pappa and astrid",
    diff(new("group", name=has("christmas"), currency="NOK"), link("new", "me"), link("new", "mamma"), link("new", "pappa"), link("new", "astrid")),
    ref=[act("create", args="kind: group\nname: Christmas Presents\ncurrency: NOK", more=True),
         act("add_to", rows="$mamma, $pappa, $astrid", args="to: $new")]),
  T("who's in it", rows("me", "mamma", "pappa", "astrid"),
    ref=[find(kind="person", linked_to="$c1"), ans(rows="@prev")]),
  T("take pappa out, it's a surprise", diff(unlink("+1", "pappa")),
    ref=[act("remove_from", rows="$pappa", args="from: $c1")]))

S("T35-043", "ambiguous delete note restore",
  T("delete the diary entry", ask("diary_ski", "diary_whale"),
    ref=[act("delete", kind="note", name="diary entry")]),
  T("the one about the humpbacks", diff(trash("diary_whale")),
    ref=[act("delete", rows="$diary_whale")]),
  T("actually bring it back", diff(restore("diary_whale")),
    ref=[act("restore", rows="$diary_whale")]))

S("T35-044", "ask missing event create",
  T("add an event", ask(),
    ref=[askc("What's the event and when is it?")]),
  T("dinner with kjersti saturday at 7", diff(new("event", name=has("kjersti"), date="2026-11-14T19:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Kjersti", date=U("week", 0, weekday=6, time="19:00")))]))

S("T35-045", "events name month next",
  T("handovers in december", rows("handover_1211"),
    ref=[ans(kind="event", name="jonas handover", when=J(U("month", 0, name=12)))]),
  T("when's the next one", rows("handover_1113"),
    ref=[ans(kind="event", name="jonas handover", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("who from the marine lab is at the cod team meeting tomorrow", rows("sigrid", "ola", "lars_e"),
    ref=[find(kind="person", linked_to="$cod_team", where='met = "marine lab"'), ans(rows="@prev")]))

DONE_BEFORE_NOV = ["mortgage_aug", "mortgage_sep", "mortgage_oct", "fridge_0821", "fridge_0904", "fridge_0918", "fridge_1002",
                   "fridge_1016", "fridge_1030", "cod_vessel", "cod_permits", "grant_old", "sample_log_old", "lab_safety",
                   "winter_tiller", "winter_sails", "race_prizes", "jonas_fees_old", "elec_bill_old", "book_flights"]

S("T35-046", "repair unit find-only exclude two-writes compute within-order",
  T("open lab tasks over an hour due before the symposium, not counting the manuscript review", rows("grant_progress", "cod_echo"),
    ref=[bad(find(kind="task", linked_to="$lab_list", where="status = open and effort > 1 hour",
                  when=J({"to": D("2026-12-02")}), exclude="$review_paper")),
         find(kind="task", linked_to="$lab_list", where="status = open and effort > 60 minutes",
              when=J({"to": D("2026-12-02")}), exclude="$review_paper"),
         ans(rows="@prev")]),
  T("push the manuscript review to next friday and tick off the sample log",
    diff(upd("review_paper", date="2026-11-20"), upd("sample_log", status="completed", completed=ANY)),
    ref=[act("reschedule", rows="$review_paper", args=lines(to=U("week", 1, weekday=5)), more=True),
         act("complete", kind="task", name="sample log")]),
  T("anything due next friday that's open and under an hour", rows("cod_gear"),
    ref=[ans(kind="task", where="status = open and effort < 60 minutes", when=J(U("week", 1, weekday=5)))]),
  T("tick that off, ordered it this afternoon", diff(upd("cod_gear", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]),
  T("how much time is left on the cod survey subtasks", val(360),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$cod", where="status = open")]),
  T("which one is the shortest", rows("cod_crew"),
    ref=[ans(within="@prev", order="effort asc", limit=1)]))

S("T35-047", "ask missing person log",
  T("log a call", ask(),
    ref=[askc("Who did you call?")]))

S("T35-048", "count status effort date",
  T("how many open tasks over an hour are due before december", val(3),
    ref=[ans(op="count", kind="task", where="status = open and effort > 60 minutes", when=J({"to": D("2026-11-30")}))]))

S("T35-049", "trashed locker delete not-found",
  T("delete the old telenor login", decline("not_found"),
    ref=[act("delete", kind="locker item", name="old telenor login")]))

S("T35-050", "bulk cap ask yes delete find",
  T("clear out all the finished tasks from before november", ask(),
    ref=[find(kind="task", where="status = completed", when=J({"to": D("2026-10-31")})), act("delete", rows="@prev")]),
  T("yes go ahead", diff(*[trash(k) for k in DONE_BEFORE_NOV]),
    ref=[act("delete", rows="@1")]))
