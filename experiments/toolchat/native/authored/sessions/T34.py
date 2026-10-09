from gold import *
import json

world("T34", "2027-06-20T21:15", "Obinna Okafor", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T34-001", "next recurring decoy relation complete",
  T("when's the next cement delivery", rows("sd_270621"),
    ref=[ans(kind="event", name="cement delivery", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("who's coming with it", rows("chidi_a", "emeka_n", "musa"),
    ref=[ans(kind="person", linked_to="$sd_270621")]),
  T("is the cement supplier payment still open", rows("cem_270620"),
    ref=[ans(kind="task", name="cement supplier", where="status = open")]),
  T("tick it off, paid it this afternoon", diff(upd("cem_270620", status="completed", completed=ANY)),
    ref=[act("complete", rows="$cem_270620")]))

S("T34-002", "empty-recovery history count follow-up",
  T("any sunday services cancelled last year", rows(),
    ref=[ans(kind="event", name="Sunday service", where="status = cancelled", when=W(U("year", -1)))]),
  T("and the year before", rows("ss_250126"),
    ref=[ans(kind="event", name="Sunday service", where="status = cancelled", when=W(U("year", -2)))]),
  T("how many in 2024", val(4),
    ref=[ans(op="count", kind="event", name="Sunday service", where="status = cancelled", when=W(U("year", -3)))]),
  T("which ones", rows("ss_240107", "ss_240128", "ss_240317", "ss_240818"),
    ref=[ans(within="@prev")]))

S("T34-003", "group-event-chain empty members",
  T("who from the church building fund was at last year's harvest thanksgiving", rows("pastor", "funmi", "deacon"),
    ref=[find(kind="event", name="harvest thanksgiving", when=W(U("year", -1))),
         ans(kind="person", linked_to="$church_build, $harvest_2026")]),
  T("and who from the umunna group was at the village christmas in 2025", rows("daddy"),
    ref=[find(kind="event", name="Christmas in the village", when=W(U("year", -2))),
         ans(kind="person", linked_to="$village, $village_25")]),
  T("is mama nnukwu in the care fund", rows(),
    ref=[ans(kind="person", name="Mama Nnukwu", linked_to="$mama_care")]),
  T("who is in it then", rows("me", "chidi_o", "ngozi_o", "aunty_uche", "blessing"),
    ref=[ans(kind="person", linked_to="$mama_care")]))

S("T34-004", "subtasks reschedule anchor-row order-limit",
  T("what's left on the solar job", rows("solar_5", "solar_6", "solar_7"),
    ref=[ans(kind="task", linked_to="$solar", where="status = open")]),
  T("the one due soonest", rows("solar_5"),
    ref=[ans(within="@prev", order="date asc", limit=1)]),
  T("push it back a week", diff(upd("solar_5", date="2027-07-19")),
    ref=[act("reschedule", rows="$solar_5", args=lines(to=U("week", 1, anchor="row")))]),
  T("and the generator sale to the end of august", diff(upd("solar_7", date="2027-08-31")),
    ref=[act("reschedule", rows="$solar_7", args=lines(to=D("2027-08-31")))]))

S("T34-005", "photos relation album star add_to within",
  T("photos of daddy chief in the village christmas 2026 album",
    rows("ph_village26_01", "ph_village26_02", "ph_village26_04", "ph_village26_06", "ph_village26_08", "ph_village26_14",
         "ph_village26_16", "ph_village26_19"),
    ref=[ans(kind="photo", linked_to="$daddy, $village26")]),
  T("star the arrival ones", diff(upd("ph_village26_01", starred=True), upd("ph_village26_19", starred=True)),
    ref=[act("star", rows="$ph_village26_01, $ph_village26_19")]),
  T("which of them are also in the shop album", rows("ph_village26_01"),
    ref=[ans(within="@1", linked_to="$shop_a")]),
  T("add the sunset one to it", diff(link("shop_a", "ph_village26_06")),
    ref=[act("add_to", rows="$ph_village26_06", args="to: $shop_a")]))

S("T34-006", "debts relation date person-decoy settle_debt balance",
  T("which of my brother chidi's debts are from last year", rows("debt_29", "debt_36"),
    ref=[ans(kind="debt", linked_to="$chidi_o", when=W(U("year", -1)))]),
  T("the one he owes me", rows("debt_36"),
    ref=[ans(within="@prev", where="direction = owes_me")]),
  T("settle that one, he paid me cash", diff(upd("debt_36", status="settled")),
    ref=[act("settle_debt", rows="$debt_36")]),
  T("what's his balance now", val((51766.65, "NGN"), (-20, "GBP")),
    ref=[ans(op="balance", kind="person", rows="$chidi_o")]))

S("T34-007", "ambiguous-write ask date-pick still-on substitution",
  T("cancel the bible study", ask("bs_270623", "bs_270707", "bs_270721"),
    ref=[act("cancel", kind="event", name="Bible study")]),
  T("the one on the 7th", diff(upd("bs_270707", status="cancelled")),
    ref=[act("cancel", kind="event", name="Bible study", when=W(D("2027-07-07")))]),
  T("which bible studies are still on", rows("bs_270623", "bs_270721"),
    ref=[ans(kind="event", name="Bible study", where="status != cancelled", when=W({"from": U("day", 0)}))]),
  T("and the sunday services in july", rows("ss_270704", "ss_270711", "ss_270718", "ss_270725"),
    ref=[ans(kind="event", name="Sunday service", where="status != cancelled", when=W(U("month", 0, name=7)))]))

S("T34-008", "person-decoy star log last-seen relation year",
  T("star chidi, the cement one", diff(upd("chidi_a", starred=True)),
    ref=[act("star", rows="$chidi_a")]),
  T("log a call with tunde, the estate chairman", diff(upd("tunde_b", date=ANY)),
    ref=[act("log", kind="person", name="Tunde", where='role contains "chairman"', args="kind: call")]),
  T("when did i last see the other tunde", rows("tunde_k"),
    ref=[ans(kind="person", rows="$tunde_k")]),
  T("which site visits with him were in 2024", rows("oo_104", "oo_069", "oo_019"),
    ref=[ans(kind="event", name="site visit", linked_to="$tunde_k", when=W(U("year", -3)))]))

S("T34-009", "locker reveal egress starred-type",
  T("what's the gate code", diff(reveal=[("gate_code", "7788")]),
    ref=[act("reveal", rows="$gate_code", args="field: content")]),
  T("and the safe's?", diff(reveal=[("gate_code", "4120")]),
    ref=[act("reveal", rows="$gate_code", args="field: content")]),
  T("text both to mallam yusuf", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("which of my starred ones are logins or cards", rows("gtb_login"),
    ref=[ans(kind="locker item", where='starred = yes and type in ("login", "card")')]))

S("T34-010", "trashed find restore window count",
  T("what docs did i delete", rows("doc_03", "doc_16", "doc_29", "doc_42"),
    ref=[ans(kind="document", trashed="true")]),
  T("bring back the payroll one", diff(restore("doc_16")),
    ref=[act("restore", rows="$doc_16")]),
  T("and the personal tax return", decline("not_found"),
    ref=[act("restore", rows="$doc_29")]),
  T("the 2023 paye one too", diff(restore("doc_03")),
    ref=[act("restore", rows="$doc_03")]),
  T("count what remains there", val(2),
    ref=[ans(op="count", kind="document", trashed="true")]))

S("T34-011", "notes notebook body-contains year pin create",
  T("what do my church notes say about the offering", rows("ch_1", "ch_2", "ch_3", "ch_4", "ch_5", "ch_6"),
    ref=[ans(kind="note", linked_to="$church_nb", where='body contains "offering"')]),
  T("last year's ones only", rows("ch_5", "ch_6"),
    ref=[ans(within="@prev", when=W(U("year", -1)))]),
  T("pin the later one", diff(upd("ch_6", pinned=True)),
    ref=[act("edit", rows="$ch_6", args="pinned: yes")]),
  T("and make a note in there, hall dedication is the 26th of september",
    diff(new("note", name=has("hall dedication"), body=has("26th")), link("church_nb", "new")),
    ref=[act("create", kind="note", args=lines(name="hall dedication", body="hall dedication is the 26th of september", notebook="$church_nb"))]))

S("T34-012", "documents series star unstar add_to",
  T("chiamaka's school fees receipts", rows("doc_07", "doc_19", "doc_34", "doc_46"),
    ref=[ans(kind="document", name="school fees receipt Chiamaka")]),
  T("star the 2025 one", diff(upd("doc_34", starred=True)),
    ref=[act("star", rows="$doc_34")]),
  T("and unstar 2024", diff(upd("doc_19", starred=False)),
    ref=[act("unstar", rows="$doc_19")]),
  T("put the 2024 company tax return in the taxes folder", diff(link("taxes_f", "doc_13")),
    ref=[act("add_to", rows="$doc_13", args="to: $taxes_f")]))

S("T34-013", "group-balance member-refusal settle_up",
  T("where do i stand in the residents group", val((230297.58, "NGN")),
    ref=[ans(op="balance", kind="group", name="residents", linked_to="$me")]),
  T("and the diesel pool", val((13761.84, "NGN")),
    ref=[ans(op="balance", kind="group", name="diesel pool", linked_to="$me")]),
  T("take obiora yakubu out of the diesel pool", ask("obiora_yakubu", "diesel_pool"),
    ref=[act("remove_from", kind="person", name="Obiora Yakubu", args="from: $diesel_pool")]),
  T("ok settle up with him in there first", diff(settle=[("Obiora Yakubu", "60666.68")]),
    ref=[act("settle_up", rows="$obiora_yakubu", args="group: $diesel_pool")]))

S("T34-014", "series open overdue complete count-year",
  T("which nepa payments are still open", rows("nepa_250117", "nepa_270212", "nepa_270702"),
    ref=[ans(kind="task", name="Pay NEPA", where="status = open")]),
  T("any of them overdue", rows("nepa_250117", "nepa_270212"),
    ref=[ans(within="@prev", when=W({"to": U("day", 0)}))]),
  T("tick off the february one", diff(upd("nepa_270212", status="completed", completed=ANY)),
    ref=[act("complete", rows="$nepa_270212")]),
  T("how many have i paid so far this year", val(13),
    ref=[ans(op="count", kind="task", name="Pay NEPA", where="status = completed", when=W(U("year", 0)))]))

S("T34-015", "folder write-read count within-date ambiguous-write pick",
  T("delete the to file folder and tell me what folders i've got left",
    rows("taxes_f", "business_f", "school_f", "church_f", "house_f", "health_f", "family_f", "vehicles_f", "insurance_f",
         "banking_f", also=diff(gone("tofile_f"))),
    ref=[act("delete", kind="folder", name="To file", more=True), ans(kind="folder")]),
  T("how many documents in business", val(14),
    ref=[ans(op="count", kind="document", linked_to="$business_f")]),
  T("which of those are from before 2025", rows("doc_04", "doc_05", "doc_06", "doc_17", "doc_18"),
    ref=[ans(within="@prev", when=W({"to": D("2024-12-31")}))]),
  T("star the supplier price list", ask("doc_06", "doc_18", "doc_33", "doc_45", "doc_60"),
    ref=[act("star", kind="document", name="supplier price list")]),
  T("the 2023 one", diff(upd("doc_06", starred=True)),
    ref=[act("star", rows="$doc_06")]))

S("T34-016", "two-writes undo redo-one",
  T("i paid the diesel and the salaries already, tick both",
    diff(upd("dsl_270622", status="completed", completed=ANY), upd("sal_270625", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Buy diesel", where="status = open", more=True),
         act("complete", kind="task", name="salaries", where="status = open")]),
  T("undo that", diff(upd("dsl_270622", status="open", completed=None), upd("sal_270625", status="open", completed=None)),
    ref=[act("undo")]),
  T("just the diesel one, the salaries aren't paid yet", diff(upd("dsl_270622", status="completed", completed=ANY)),
    ref=[act("complete", rows="$dsl_270622")]))

S("T34-017", "create-clash ask create wrong-container decline day",
  T("put a meeting with chinwe on monday at half seven", ask("sd_270621"),
    ref=[act("create", kind="event", args=lines(name="Meeting with Chinwe", date=D("2027-06-21", "07:30")))]),
  T("make it ten then", diff(new("event", name=has("chinwe"), date="2027-06-21T10:00")),
    ref=[act("create", kind="event", args=lines(name="Meeting with Chinwe", date=D("2027-06-21", "10:00")))]),
  T("and add chinwe to it", decline("out_of_scope"),
    ref=[act("add_to", rows="$chinwe", args="to: $c1")]),
  T("what's on monday now", rows("sd_270621", "+1"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=1)))]))

S("T34-018", "model-ask create note add_to body-contains",
  T("add a note", ask(),
    ref=[askc("What should the note say?")]),
  T("buy cables and a surge protector for the solar guys",
    diff(new("note", name=has("cables"), body=has("surge"))),
    ref=[act("create", kind="note", args=lines(name="buy cables and a surge protector", body="buy cables and a surge protector for the solar guys"))]),
  T("put it in the house notes", diff(link("house_nb", "+1")),
    ref=[act("add_to", rows="$c1", args="to: $house_nb")]),
  T("which house notes mention the generator", rows("hn_1", "hn_2", "hn_3", "hn_4"),
    ref=[ans(kind="note", linked_to="$house_nb", where='body contains "generator"')]))

S("T34-019", "decline-text note next",
  T("text pastor sam that i'm missing bible study", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("fine, note that i'm missing bible study this wednesday",
    diff(new("note", name=has("bible study"), body=has("missing"))),
    ref=[act("create", kind="note", args=lines(name="missing bible study", body="i'm missing bible study this wednesday"))]),
  T("what bible studies are there in july", rows("bs_270707", "bs_270721"),
    ref=[ans(kind="event", name="bible study", when=W(U("month", 0, name=7)))]))

S("T34-020", "repair effort-unit open-tasks within list complete",
  T("open tasks over an hour", rows("t_008", "t_043", "t_084"),
    ref=[bad(ans(kind="task", where="status = open and effort > 1 hour")),
         ans(kind="task", where="status = open and effort > 60 minutes")]),
  T("and which are quick, ten minutes or less", rows("nepa_250117", "nepa_270212", "nepa_270702", "t_042", "t_089"),
    ref=[ans(kind="task", where="status = open and effort <= 10 minutes")]),
  T("which of those are on the house list", rows("nepa_250117", "nepa_270212", "nepa_270702"),
    ref=[ans(within="@prev", linked_to="$house")]),
  T("tick off the february one", diff(upd("nepa_270212", status="completed", completed=ANY)),
    ref=[act("complete", rows="$nepa_270212")]))

S("T34-021", "bulk find-then-cancel undo-not-undone reschedule-cancelled two-dates",
  T("cancel the bible studies in july", diff(upd("bs_270707", status="cancelled"), upd("bs_270721", status="cancelled")),
    ref=[find(kind="event", name="bible study", when=W(U("month", 0, name=7))), act("cancel", rows="@1")]),
  T("undo that", diff(),
    ref=[act("undo")]),
  T("actually move the one on the 7th to the 14th instead", ask("bs_270707"),
    ref=[act("reschedule", kind="event", name="bible study", when=W(D("2027-07-07")), args=lines(to=D("2027-07-14")))]))

S("T34-022", "bulk find-then-star photos count where-linked month",
  T("star all the photos of mummy in the wedding album from november",
    diff(upd("ph_wedding_a_09", starred=True), upd("ph_wedding_a_16", starred=True), upd("ph_wedding_a_17", starred=True),
         upd("ph_wedding_a_19", starred=True), upd("ph_wedding_a_20", starred=True)),
    ref=[find(kind="photo", linked_to="$mummy, $wedding_a", when=W(U("month", -1, name=11))), act("star", rows="@1")]),
  T("how many starred photos are in that album now", val(5),
    ref=[ans(op="count", kind="photo", linked_to="$wedding_a", where="starred = yes")]))

S("T34-023", "search-role log relation-name",
  T("my accountant, last contact?", rows("chinwe"),
    ref=[search("accountant", kind="person"), ans(rows="$chinwe")]),
  T("log it, she just rang", diff(upd("chinwe", date=ANY)),
    ref=[act("log", rows="$chinwe", args="kind: call")]),
  T("which meetings did we have about tax", rows("oo_004", "oo_066", "oo_077", "oo_080", "oo_083"),
    ref=[ans(kind="event", name="tax", linked_to="$chinwe")]))

S("T34-024", "debt superlative sum direction",
  T("which debt owed to me is the smallest", rows("debt_39"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open", order="amount asc", limit=1)]),
  T("and the largest i owe", rows("debt_38"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount desc", limit=1)]),
  T("how much do i owe altogether", val((527100, "NGN")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open")]))

S("T34-025", "decline-unbounded bulk-ask bounded",
  T("delete all my tasks", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("ok just the finished ones from 2023", ask(),
    ref=[act("delete", kind="task", where="status = completed", when=W(U("year", -4)))]))

S("T34-026", "empty-recovery relation trashed restore",
  T("any photos of kelechi in the shop album", rows(),
    ref=[ans(kind="photo", linked_to="$kelechi, $shop_a")]),
  T("what about the school one", rows("ph_school_a_05", "ph_school_a_09", "ph_school_a_11", "ph_school_a_17"),
    ref=[ans(kind="photo", linked_to="$kelechi, $school_a")]),
  T("any of him in the trash", rows("ph_loose_245"),
    ref=[ans(kind="photo", linked_to="$kelechi", trashed="true")]),
  T("bring it back", diff(restore("ph_loose_245")),
    ref=[act("restore", rows="$ph_loose_245")]))

S("T34-027", "history last-one exclude count-year",
  T("when was the generator last serviced", rows("gen_270608"),
    ref=[ans(kind="event", name="generator service", order="date desc", limit=1)]),
  T("and the time before that", rows("gen_270309"),
    ref=[ans(kind="event", name="generator service", exclude="@prev", order="date desc", limit=1)]),
  T("how many times was it serviced last year", val(4),
    ref=[ans(op="count", kind="event", name="generator service", when=W(U("year", -1)))]))

S("T34-028", "single count name-when",
  T("how many calls with aunty uche are in the diary for june", val(3),
    ref=[ans(op="count", kind="event", name="Call Aunty Uche", when=W(U("month", 0, name=6)))]))

S("T34-029", "count-year within-before",
  T("how many pta meetings did we have in 2026", val(8),
    ref=[ans(op="count", kind="event", name="PTA meeting", when=W(U("year", -1)))]),
  T("which of those were before may", rows("pta_260108", "pta_260212", "pta_260312"),
    ref=[ans(within="@prev", when=W({"to": D("2026-04-30")}))]))

S("T34-030", "count-cancelled-year which",
  T("how many cement deliveries were cancelled in 2024", val(2),
    ref=[ans(op="count", kind="event", name="cement delivery", where="status = cancelled", when=W(U("year", -3)))]),
  T("which ones", rows("sd_240429", "sd_240930"),
    ref=[ans(within="@prev")]))

S("T34-031", "oldest-open order-limit complete count",
  T("what's the oldest mama nnukwu drugs task still open", rows("drug_250908"),
    ref=[ans(kind="task", name="Mama Nnukwu's drugs", where="status = open", order="date asc", limit=1)]),
  T("tick it off, i bought them back then", diff(upd("drug_250908", status="completed", completed=ANY)),
    ref=[act("complete", rows="$drug_250908")]),
  T("how many are still open", val(2),
    ref=[ans(op="count", kind="task", name="Mama Nnukwu's drugs", where="status = open")]))

S("T34-032", "last-one name-decoy create",
  T("when was kelechi's last dentist", rows("oo_032"),
    ref=[ans(kind="event", name="dentist Kelechi", order="date desc", limit=1)]),
  T("and chiamaka's", rows("oo_086"),
    ref=[ans(kind="event", name="dentist Chiamaka", order="date desc", limit=1)]),
  T("book kelechi another one for thursday the 1st of july at ten",
    diff(new("event", name=has("Dentist", "Kelechi"), date="2027-07-01T10:00")),
    ref=[act("create", kind="event", args=lines(name="Dentist - Kelechi", date=D("2027-07-01", "10:00")))]))

S("T34-033", "near-spelling star-applied log pronoun",
  T("star dr ifee", diff(upd("dr_ify", starred=True)),
    ref=[act("star", kind="person", name="Dr Ifee")]),
  T("and log a call with her, just spoke", diff(upd("dr_ify", date=ANY)),
    ref=[act("log", rows="$dr_ify", args="kind: call")]))

S("T34-034", "reschedule two-dates same-time span",
  T("move friday's stocktake to thursday, same time", diff(upd("st_270625", date="2027-06-24T16:00")),
    ref=[act("reschedule", kind="event", name="stocktake", when=W(U("week", 1, weekday=5)),
             args=lines(to=U("week", 1, weekday=4)))]),
  T("and monday's cement delivery to tuesday, same time", diff(upd("sd_270621", date="2027-06-22T07:00")),
    ref=[act("reschedule", kind="event", name="cement delivery", when=W(U("week", 1, weekday=1)),
             args=lines(to=U("week", 1, weekday=2)))]),
  T("what's on from tuesday to thursday now", rows("sd_270621", "bs_270623", "st_270625"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=2), U("week", 1, weekday=4))))]))

S("T34-036", "trashed-tasks restore-two window add_to-move",
  T("what tasks have i deleted", rows("t_003", "t_009", "t_014", "t_022", "t_033", "t_046", "t_058", "t_071"),
    ref=[ans(kind="task", trashed="true")]),
  T("bring back the textbooks one and the insurance one", diff(restore("t_003"), restore("t_009")),
    ref=[act("restore", rows="$t_003, $t_009")]),
  T("and the reply to pastor sam", diff(restore("t_014")),
    ref=[act("restore", rows="$t_014")]),
  T("put the insurance one in the money list", diff(link("money", "t_009"), unlink("health_l", "t_009")),
    ref=[act("add_to", rows="$t_009", args="to: $money")]))

S("T34-035", "long relation within create-two list-date reschedule-new",
  T("who's coming to the shop anniversary", rows("daddy", "emeka_n", "chinwe", "musa", "chidi_a"),
    ref=[ans(kind="person", linked_to="$shop_anniv")]),
  T("which of them are in the staff group", rows("emeka_n", "musa", "chinwe"),
    ref=[ans(within="@prev", linked_to="$staff")]),
  T("add a task to order the cake, due the 28th", diff(new("task", name=has("cake"), date="2027-06-28")),
    ref=[act("create", kind="task", args=lines(name="order the cake", date=D("2027-06-28")))]),
  T("and one to confirm the caterers by friday", diff(new("task", name=has("caterers"), date="2027-06-25")),
    ref=[act("create", kind="task", args=lines(name="confirm the caterers", date=U("week", 1, weekday=5)))]),
  T("what's due on the business list before the anniversary", rows("cem_270620", "sal_270625"),
    ref=[ans(kind="task", linked_to="$business_l", where="status = open", when=W(span(U("day", 0), D("2027-07-02"))))]),
  T("push the cake one to the 30th", diff(upd("+1", date="2027-06-30")),
    ref=[act("reschedule", rows="$c1", args=lines(to=D("2027-06-30")))]))
