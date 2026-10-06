from gold import *

import json

world("T34", "2027-06-20T21:15", "Obinna Okafor", "train")

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T34-003-P", "group-event-chain empty members para",
  T("of the church building fund, which people showed up to last year's harvest thanksgiving", rows("pastor", "funmi", "deacon"),
    ref=[find(kind="event", name="harvest thanksgiving", when=W(U("year", -1))),
         ans(kind="person", linked_to="$church_build, $harvest_2026")]),
  T("umunna group members at the village christmas in 2025?", rows("daddy"),
    ref=[find(kind="event", name="Christmas in the village", when=W(U("year", -2))),
         ans(kind="person", linked_to="$village, $village_25")]),
  T("care fund membership, mama nnukwu included?", rows(),
    ref=[ans(kind="person", name="Mama Nnukwu", linked_to="$mama_care")]),
  T("so who's in it", rows("me", "chidi_o", "ngozi_o", "aunty_uche", "blessing"),
    ref=[ans(kind="person", linked_to="$mama_care")]))

S("T34-007-P", "ambiguous-write ask date-pick still-on substitution para",
  T("bible study's off, cancel it", ask("bs_270623", "bs_270707", "bs_270721"),
    ref=[act("cancel", kind="event", name="Bible study")]),
  T("7th one", diff(upd("bs_270707", status="cancelled")),
    ref=[act("cancel", kind="event", name="Bible study", when=W(D("2027-07-07")))]),
  T("bible studies still going ahead?", rows("bs_270623", "bs_270721"),
    ref=[ans(kind="event", name="Bible study", where="status != cancelled", when=W({"from": U("day", 0)}))]),
  T("july, any sunday services", rows("ss_270704", "ss_270711", "ss_270718", "ss_270725"),
    ref=[ans(kind="event", name="Sunday service", where="status != cancelled", when=W(U("month", 0, name=7)))]))

S("T34-011-P", "notes notebook body-contains year pin create para",
  T("which of my church notes bring up the offering", rows("ch_1", "ch_2", "ch_3", "ch_4", "ch_5", "ch_6"),
    ref=[ans(kind="note", linked_to="$church_nb", where='body contains "offering"')]),
  T("only last year's", rows("ch_5", "ch_6"),
    ref=[ans(within="@prev", when=W(U("year", -1)))]),
  T("put a pin on the later one", diff(upd("ch_6", pinned=True)),
    ref=[act("edit", rows="$ch_6", args="pinned: yes")]),
  T("stash a note in the church notebook, hall dedication is the 26th of september",
    diff(new("note", name=has("hall dedication"), body=has("26th")), link("church_nb", "new")),
    ref=[act("create", kind="note", args=lines(name="hall dedication", body="hall dedication is the 26th of september", notebook="$church_nb"))]))

S("T34-015-P", "folder write-read count within-date ambiguous-write pick para",
  T("to file folder goes, then show the folders that remain",
    rows("taxes_f", "business_f", "school_f", "church_f", "house_f", "health_f", "family_f", "vehicles_f", "insurance_f",
         "banking_f", also=diff(gone("tofile_f"))),
    ref=[act("delete", kind="folder", name="To file", more=True), ans(kind="folder")]),
  T("business folder, document count?", val(14),
    ref=[ans(op="count", kind="document", linked_to="$business_f")]),
  T("those dated earlier than 2025?", rows("doc_04", "doc_05", "doc_06", "doc_17", "doc_18"),
    ref=[ans(within="@prev", when=W({"to": D("2024-12-31")}))]),
  T("supplier price list gets a star", ask("doc_06", "doc_18", "doc_33", "doc_45", "doc_60"),
    ref=[act("star", kind="document", name="supplier price list")]),
  T("2023's", diff(upd("doc_06", starred=True)),
    ref=[act("star", rows="$doc_06")]))

S("T34-019-P", "decline-text note next para",
  T("pastor sam should hear by text that i'm missing bible study", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("then keep a record, i'm missing bible study this wednesday",
    diff(new("note", name=has("bible study"), body=has("missing"))),
    ref=[act("create", kind="note", args=lines(name="missing bible study", body="i'm missing bible study this wednesday"))]),
  T("july's bible studies?", rows("bs_270707", "bs_270721"),
    ref=[ans(kind="event", name="bible study", when=W(U("month", 0, name=7)))]))

S("T34-023-P", "search-role log relation-name para",
  T("last time i spoke to the accountant", rows("chinwe"),
    ref=[search("accountant", kind="person"), ans(rows="$chinwe")]),
  T("she just rang, so log it", diff(upd("chinwe", date=ANY)),
    ref=[act("log", rows="$chinwe", args="kind: call")]),
  T("tax meetings with her so far?", rows("oo_004", "oo_066", "oo_077", "oo_080", "oo_083"),
    ref=[ans(kind="event", name="tax", linked_to="$chinwe")]))

S("T34-027-P", "history last-one exclude count-year para",
  T("generator's last service date?", rows("gen_270608"),
    ref=[ans(kind="event", name="generator service", order="date desc", limit=1)]),
  T("and before that?", rows("gen_270309"),
    ref=[ans(kind="event", name="generator service", exclude="@prev", order="date desc", limit=1)]),
  T("last year's service count for it?", val(4),
    ref=[ans(op="count", kind="event", name="generator service", when=W(U("year", -1)))]))

S("T34-031-P", "oldest-open order-limit complete count para",
  T("oldest open mama nnukwu drugs task?", rows("drug_250908"),
    ref=[ans(kind="task", name="Mama Nnukwu's drugs", where="status = open", order="date asc", limit=1)]),
  T("bought them back then, so mark it done", diff(upd("drug_250908", status="completed", completed=ANY)),
    ref=[act("complete", rows="$drug_250908")]),
  T("remaining open ones, how many", val(2),
    ref=[ans(op="count", kind="task", name="Mama Nnukwu's drugs", where="status = open")]))

S("T34-036-P", "trashed-tasks restore-two window add_to-move para",
  T("deleted tasks, list them", rows("t_003", "t_009", "t_014", "t_022", "t_033", "t_046", "t_058", "t_071"),
    ref=[ans(kind="task", trashed="true")]),
  T("textbooks and insurance need to come back", diff(restore("t_003"), restore("t_009")),
    ref=[act("restore", rows="$t_003, $t_009")]),
  T("reply to pastor sam too", diff(restore("t_014")),
    ref=[act("restore", rows="$t_014")]),
  T("the money list should hold the insurance one", diff(link("money", "t_009"), unlink("health_l", "t_009")),
    ref=[act("add_to", rows="$t_009", args="to: $money")]))

S("T34-039-P", "recovery documents-person year star count para",
  T("last year's receipts of kelechi's", rows("doc_47"),
    ref=[find(kind="document", linked_to="$kelechi", when=W(U("year", -1))),
         ans(kind="document", name="receipt Kelechi", when=W(U("year", -1)))]),
  T("give it a star", diff(upd("doc_47", starred=True)),
    ref=[act("star", rows="$doc_47")]),
  T("school fees receipt count for 2025", val(3),
    ref=[ans(op="count", kind="document", name="school fees receipt", when=W(U("year", -2)))]))

S("T34-043-P", "two-writes complete reschedule list-week same-time para",
  T("generator man's paid as of this morning, tick it, and shift the dstv payment to the 14th, same time",
    diff(upd("genman_270703", status="completed", completed=ANY), upd("dstv_270711", date="2027-07-14")),
    ref=[act("complete", kind="task", name="generator man", more=True),
         act("reschedule", kind="task", name="dstv", when=W(U("month", 0, name=7)), args=lines(to=D("2027-07-14")))]),
  T("house list items outstanding through the 4th", rows("dsl_270622", "blz_270628", "nepa_270702"),
    ref=[ans(kind="task", linked_to="$house", when=W(span(U("day", 0), D("2027-07-04"))))]),
  T("diesel, thursday, same time", diff(upd("dsl_270622", date="2027-06-24T08:00")),
    ref=[act("reschedule", kind="task", name="Buy diesel", where="status = open", args=lines(to=U("week", 1, weekday=4)))]))

S("T34-047-P", "bulk find-then-cancel month name-where para",
  T("all cement deliveries in july are off, cancel them",
    diff(upd("sd_270705", status="cancelled"), upd("sd_270719", status="cancelled")),
    ref=[find(kind="event", name="cement delivery", where="status != cancelled", when=W(U("month", 0, name=7))),
         act("cancel", rows="@1")]))

S("T34-051-P", "recovery photos-group relation delete-photo para",
  T("chidi's wedding photos with mummy in them",
    rows("ph_wedding_a_09", "ph_wedding_a_16", "ph_wedding_a_17", "ph_wedding_a_19", "ph_wedding_a_20"),
    ref=[find(kind="photo", linked_to="$mummy, $wedding"),
         ans(kind="photo", linked_to="$mummy, $wedding_a")]),
  T("cake 2 from the wedding album, get rid of that photo", diff(trash("ph_wedding_a_09"), unlink("wedding_a", "ph_wedding_a_09")),
    ref=[act("delete", kind="photo", name="Cake 2", linked_to="$wedding_a")]))

S("T34-055-P", "ambiguous-write reschedule anchor-row date-pick para",
  T("pta meeting needs to go back a day, same time", ask("pta_270708"),
    ref=[act("reschedule", kind="event", name="PTA meeting", args=lines(to=U("day", 1, anchor="row")))]),
  T("8th's", diff(upd("pta_270708", date="2027-07-09T17:30")),
    ref=[act("reschedule", kind="event", name="PTA meeting", when=W(D("2027-07-08")),
             args=lines(to=U("day", 1, anchor="row")))]))

S("T34-059-P", "write-then-read star locker ambiguous-reveal wifi pick para",
  T("passport gets a star, then list the starred locker items",
    rows("gtb_login", "gtb_acct", "home_wifi", "gate_code", "sage", "passport_o",
         also=diff(upd("passport_o", starred=True))),
    ref=[act("star", kind="locker item", name="Passport", more=True),
         ans(kind="locker item", where="starred = yes")]),
  T("wifi password, show me", ask("home_wifi", "shop_wifi"),
    ref=[act("reveal", kind="locker item", name="wifi", args="field: password")]),
  T("shop one", diff(reveal=[("shop_wifi", "OshodiCement25")]),
    ref=[act("reveal", rows="$shop_wifi", args="field: password")]))

S("T34-063-P", "delete find-then-delete event-where document-year decline-unbounded count-trash para",
  T("2023's cancelled haircut at the barber, delete it", diff(trash("oo_042")),
    ref=[find(kind="event", name="Haircut at the barber", where="status = cancelled", when=W(U("year", -4))),
         act("delete", rows="@prev")]),
  T("same for the bank statement summary from 2024", diff(trash("doc_27")),
    ref=[bad(find(kind="document", name="Bank statement summary", where="date = 2024")),
         find(kind="document", name="Bank statement summary", when=W(U("year", -3))),
         act("delete", rows="@prev")]),
  T("finished pay generator man tasks on the house list from 2023, wipe them too",
    diff(trash("genman_230603"), trash("genman_230703"), trash("genman_230803"), trash("genman_230903"),
         trash("genman_231003"), trash("genman_231103"), trash("genman_231203")),
    ref=[find(kind="task", name="Pay generator man", linked_to="$house", where="status = completed", when=W(U("year", -4))),
         act("delete", rows="@prev")]),
  T("trash task count now?", val(15),
    ref=[ans(op="count", kind="task", trashed="true")]),
  T("clear out all my notes", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("only the diary entry older than june", diff(trash("loose_1")),
    ref=[find(kind="note", name="diary entry", when=W({"to": D("2027-05-31")})),
         act("delete", rows="@prev")]))

S("T34-067-P", "same-word-pick person role-gloss possessor-vs-relation add_to group-target lookalike count para",
  T("kemi the sunday school teacher needs adding to the church group", diff(link("church_build", "kemi_okonkwo")),
    ref=[act("add_to", kind="person", name="Kemi", where='role contains "Sunday school"', args=lines(to="$church_build"))]),
  T("chidi's wedding group should include adaobi", diff(link("wedding", "adaobi")),
    ref=[act("add_to", kind="person", name="Adaobi", args=lines(to="$wedding"))]),
  T("church group headcount now?", val(14),
    ref=[ans(op="count", kind="person", linked_to="$church_build")]))

S("T34-071-P", "create-args locker login username-label url type-implied-wifi inert-purpose star para",
  T("starlink login, user okaforhome, save it",
    diff(new("locker item", name=has("starlink"), type="login", username="okaforhome")),
    ref=[act("create", kind="locker item", args=lines(name="Starlink", type="login", username="okaforhome"))]),
  T("new warehouse wifi login as well, the cctv guys need it",
    diff(new("locker item", name=has("warehouse"), type="wifi")),
    ref=[act("create", kind="locker item", args=lines(name="Warehouse wifi", type="wifi"))]),
  T("my mtn login, with username obinna.okafor on mtn.ng",
    diff(new("locker item", name=has("mtn"), type="login", username="obinna.okafor", url="mtn.ng")),
    ref=[act("create", kind="locker item", args=lines(name="MTN", type="login", username="obinna.okafor", url="mtn.ng"))]),
  T("starlink one gets a star", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]))

S("T34-075-P", "create-args album group inert-purpose task container-link list para",
  T("create an album called nkem's second birthday where the family can add pictures",
    diff(new("album", name="Nkem's second birthday")),
    ref=[act("create", kind="album", args=lines(name="Nkem's second birthday"))]),
  T("anniversary expenses group too, me emeka and chinwe splitting it",
    diff(new("group", name="Anniversary expenses"), link("new", "me")),
    ref=[act("create", kind="group", args=lines(name="Anniversary expenses"))]),
  T("church list needs a task, order banners for the dedication, due friday",
    diff(new("task", name="Order banners for the dedication", date="2027-06-25"), link("church_l", "new")),
    ref=[act("create", kind="task", args=lines(name="Order banners for the dedication", date=U("week", 1, weekday=5),
                                               list_="$church_l"))]))

S("T34-079-P", "verb-choice reschedule make-it-hour no-wait-weekday not-undo bare-attribute edit-duration para",
  T("next friday's stocktake, change it to wednesday", diff(upd("st_270625", date="2027-06-23T16:00")),
    ref=[act("reschedule", kind="event", name="stocktake", when=W(U("week", 1, weekday=5)), args=lines(to=U("week", 1, weekday=3)))]),
  T("3 instead", diff(upd("st_270625", date="2027-06-23T15:00")),
    ref=[act("reschedule", rows="$st_270625", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("actually thursday", diff(upd("st_270625", date="2027-06-24T15:00")),
    ref=[act("reschedule", rows="$st_270625", args=lines(to=U("week", 1, weekday=4)))]),
  T("two hours long please", diff(upd("st_270625", duration=120)),
    ref=[act("edit", rows="$st_270625", args="duration: 120")]))

S("T34-083-P", "stop-signals never_mind start-of-message after a read then normal write para",
  T("this week's open items on the business list", rows("t_159", "cem_270620"),
    ref=[ans(kind="task", linked_to="$business_l", where="status = open", when=W(U("week", 0)))]),
  T("i'll handle the roofing sheets today, never mind that one", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("paid the cement supplier, mark it complete", diff(upd("cem_270620", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="cement supplier", where="status = open")]))

S("T34-087-P", "set-answers role-exact in-law-namesake within group para",
  T("cousins, list them",
    rows("nneka_salami", "efosa_aniekwe", "abubakar_usman", "chisom_onwuka", "chukwuemeka", "lanre_madu", "onyinye_okeke",
         "somto_ibekwe", "yetunde_ogunleye"),
    ref=[ans(kind="person", where='role = "cousin"')]),
  T("the cousins group members among them?", rows("chukwuemeka", "chisom_onwuka", "onyinye_okeke"),
    ref=[ans(within="@prev", linked_to="$cousins")]))

S("T34-091-P", "container-link-read list-name-collision parent-narrow within linked_to, then in-progress edit para",
  T("church list items still open", rows("church_hall_3", "tithe_270701", "church_hall_1", "church_hall_2", "church_hall"),
    ref=[ans(kind="task", linked_to="$church_l", where="status = open")]),
  T("the hall dedication ones among them?", rows("church_hall_3", "church_hall_1", "church_hall_2"),
    ref=[ans(within="@prev", linked_to="$church_hall")]),
  T("supplier has started the plaque, so set it to in progress", diff(upd("church_hall_1", status="in_progress")),
    ref=[act("edit", rows="$church_hall_1", args="status: in_progress")]))

S("T34-095-P", "container-link-read parent-task done-subtasks theme-word-is-list within order para",
  T("finished parts of the house repaint?",
    rows("house_paint_1", "house_paint_2", "house_paint_3", "house_paint_4", "house_paint_5"),
    ref=[ans(kind="task", linked_to="$house_paint", where="status = completed")]),
  T("i forget which one was last", rows("house_paint_5"),
    ref=[ans(within="@prev", order="date desc", limit=1)]))

S("T34-099-P", "stray-condition by-name-write inert-purpose-clause complete star, no-body-on-notebooks para",
  T("chinwe's waiting, so mark pay staff salaries done",
    diff(upd("sal_270625", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay staff salaries", where="status = open")]),
  T("visa form needs ifeanyi's 2026 fees receipt, star it", diff(upd("doc_48", starred=True)),
    ref=[act("star", kind="document", name="fees receipt Ifeanyi 2026")]),
  T("egusi recipe, which notebook", rows("kitchen_nb"),
    ref=[bad(ans(kind="notebook", where='body contains "egusi"')),
         opn("$rec_2"), ans(rows="$kitchen_nb")]))
