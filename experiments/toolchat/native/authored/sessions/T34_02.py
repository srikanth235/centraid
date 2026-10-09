from gold import *
import json

world("T34", "2027-06-20T21:15", "Obinna Okafor", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T34-037", "same-first-name ask role-pick star log",
  T("star kemi", ask("kemi_okonkwo", "kemi_abdullahi", "kemi_anyanwu", "kemi_aliyu"),
    ref=[act("star", kind="person", name="Kemi")]),
  T("the kemi in estate security", diff(upd("kemi_abdullahi", starred=True)),
    ref=[act("star", kind="person", name="Kemi", where='role contains "security"')]),
  T("log a call with the sunday school kemi", diff(upd("kemi_okonkwo", date=ANY)),
    ref=[act("log", kind="person", name="Kemi", where='role contains "Sunday school"', args="kind: call")]))

S("T34-038", "ambiguous-balance model-ask foreign-currency person-decoy",
  T("how much does chidi owe me", ask("chidi_o", "chidi_a"),
    ref=[askc("Chidi Okafor or Chidi Anyanwu?", options="$chidi_o, $chidi_a")]),
  T("the brother", val((186266.65, "NGN"), (-20, "GBP")),
    ref=[ans(op="balance", kind="person", rows="$chidi_o")]),
  T("the cement one", val((156.66, "USD")),
    ref=[ans(op="balance", kind="person", rows="$chidi_a")]))

S("T34-039", "recovery documents-person year star count",
  T("kelechi's receipts from last year", rows("doc_47"),
    ref=[find(kind="document", linked_to="$kelechi", when=W(U("year", -1))),
         ans(kind="document", name="receipt Kelechi", when=W(U("year", -1)))]),
  T("star it", diff(upd("doc_47", starred=True)),
    ref=[act("star", rows="$doc_47")]),
  T("how many school fees receipts in 2025", val(3),
    ref=[ans(op="count", kind="document", name="school fees receipt", when=W(U("year", -2)))]))

S("T34-040", "recovery photos-group relation where star-all count",
  T("aunty uche's photos from the first week of the london trip i havent starred",
    rows("ph_london_a_02", "ph_london_a_03", "ph_london_a_05", "ph_london_a_07"),
    ref=[find(kind="photo", linked_to="$aunty_uche, $london", where="starred = no", when=W(span(D("2026-08-01"), D("2026-08-07")))),
         ans(kind="photo", linked_to="$aunty_uche, $london_a", where="starred = no", when=W(span(D("2026-08-01"), D("2026-08-07"))))]),
  T("star them all",
    diff(upd("ph_london_a_02", starred=True), upd("ph_london_a_03", starred=True), upd("ph_london_a_05", starred=True),
         upd("ph_london_a_07", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("and how many are adaobi's", val(5),
    ref=[ans(op="count", kind="photo", linked_to="$adaobi, $london_a")]))

S("T34-041", "recovery tasks-group open complete",
  T("what's still open for the diesel pool next week", rows("dsl_270622"),
    ref=[find(kind="task", linked_to="$diesel_pool", where="status = open", when=W(U("week", 1))),
         ans(kind="task", name="diesel", where="status = open", when=W(U("week", 1)))]),
  T("tick off the diesel, got it this evening", diff(upd("dsl_270622", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Buy diesel", where="status = open")]))

S("T34-042", "history last-one exclude count-since cancelled",
  T("when was the last residents meeting we called off", rows("ra_250712"),
    ref=[ans(kind="event", name="Residents meeting", where="status = cancelled", order="date desc", limit=1)]),
  T("and the residents meeting before that", rows("ra_250208"),
    ref=[ans(kind="event", name="Residents meeting", where="status = cancelled", exclude="@prev", order="date desc", limit=1)]),
  T("how many residents meetings were called off since the start of 2025", val(3),
    ref=[ans(op="count", kind="event", name="Residents meeting", where="status = cancelled",
             when=W({"from": D("2025-01-01")}))]))

S("T34-043", "two-writes complete reschedule list-week same-time",
  T("paid the generator man this morning, and move the dstv payment to the 14th, same time",
    diff(upd("genman_270703", status="completed", completed=ANY), upd("dstv_270711", date="2027-07-14")),
    ref=[act("complete", kind="task", name="generator man", more=True),
         act("reschedule", kind="task", name="dstv", when=W(U("month", 0, name=7)), args=lines(to=D("2027-07-14")))]),
  T("what's left on the house list up to the 4th", rows("dsl_270622", "blz_270628", "nepa_270702"),
    ref=[ans(kind="task", linked_to="$house", when=W(span(U("day", 0), D("2027-07-04"))))]),
  T("push the diesel to thursday, same time", diff(upd("dsl_270622", date="2027-06-24T08:00")),
    ref=[act("reschedule", kind="task", name="Buy diesel", where="status = open", args=lines(to=U("week", 1, weekday=4)))]))

S("T34-044", "trashed people restore two window",
  T("who's in the trash",
    rows("ezinne_akpan", "folasade_ekwueme", "ekaette_odili", "ayodele_bello", "damilola_obi"),
    ref=[ans(kind="person", trashed="true")]),
  T("bring back the driver and the neighbour", diff(restore("folasade_ekwueme"), restore("ekaette_odili")),
    ref=[act("restore", rows="$folasade_ekwueme, $ekaette_odili")]),
  T("and the teacher", decline("not_found"),
    ref=[act("restore", rows="$ezinne_akpan")]))

S("T34-045", "chain event-then-people group relation year",
  T("who from greenfield pta was at chiamaka's school concert in 2025", rows("principal"),
    ref=[find(kind="event", name="School concert Chiamaka", when=W(U("year", -2))),
         ans(kind="person", linked_to="$pta, $oo_028")]))

S("T34-046", "compute sum relation direction open",
  T("total tunde balogun still owes me", val((172800, "NGN")),
    ref=[comp(op="sum", field="amount", kind="debt", linked_to="$tunde_b", where="direction = owes_me and status = open"),
         ans(value="@prev")]))

S("T34-047", "bulk find-then-cancel month name-where",
  T("cancel every cement delivery in july",
    diff(upd("sd_270705", status="cancelled"), upd("sd_270719", status="cancelled")),
    ref=[find(kind="event", name="cement delivery", where="status != cancelled", when=W(U("month", 0, name=7))),
         act("cancel", rows="@1")]))

S("T34-048", "search role find-only decoy",
  T("when did i last see the tailor", rows("adaeze_opara", "garba_emenike"),
    ref=[search("tailor", kind="person"), ans(rows="@prev")]))

S("T34-049", "decline fabricated-secret",
  T("make up a new wifi password for the shop and save it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T34-050", "recovery documents-person span unstar",
  T("what receipts are there for chiamaka between 2024 and 2025", rows("doc_19", "doc_34"),
    ref=[find(kind="document", linked_to="$chiamaka", when=W(span(D("2024-01-01"), D("2025-12-31")))),
         ans(kind="document", name="receipt Chiamaka", when=W(span(D("2024-01-01"), D("2025-12-31"))))]),
  T("unstar chiamaka's receipt", ask("doc_19", "doc_46"),
    ref=[act("unstar", kind="document", name="receipt Chiamaka")]))

S("T34-051", "recovery photos-group relation delete-photo",
  T("photos of mummy from chidi's wedding",
    rows("ph_wedding_a_09", "ph_wedding_a_16", "ph_wedding_a_17", "ph_wedding_a_19", "ph_wedding_a_20"),
    ref=[find(kind="photo", linked_to="$mummy, $wedding"),
         ans(kind="photo", linked_to="$mummy, $wedding_a")]),
  T("delete cake 2 from the wedding album", diff(trash("ph_wedding_a_09"), unlink("wedding_a", "ph_wedding_a_09")),
    ref=[act("delete", kind="photo", name="Cake 2", linked_to="$wedding_a")]))

S("T34-052", "recovery tasks-group list open reschedule",
  T("whats open on the village side before august", rows("t_043", "t_064", "t_117"),
    ref=[find(kind="task", linked_to="$village", where="status = open", when=W({"to": D("2027-07-31")})),
         ans(kind="task", linked_to="$village_l", where="status = open", when=W({"to": D("2027-07-31")}))]),
  T("push the village trip flights to july 20th", diff(upd("t_117", date="2027-07-20")),
    ref=[act("reschedule", kind="task", name="village trip flights", where="status = open", args=lines(to=D("2027-07-20")))]))

S("T34-053", "recovery notes-task empty body-contains notebook year",
  T("any notes on the solar job", rows(),
    ref=[find(kind="note", linked_to="$solar"),
         ans(kind="note", where='body contains "solar"')]),
  T("which house notes before 2025 mention the generator", rows("hn_1", "hn_2"),
    ref=[ans(kind="note", linked_to="$house_nb", where='body contains "generator"', when=W({"to": D("2024-12-31")}))]))

S("T34-054", "two-writes star unstar within follow-up",
  T("chiamaka's fee receipts", rows("doc_07", "doc_19", "doc_34", "doc_46"),
    ref=[ans(kind="document", name="receipt Chiamaka")]),
  T("star the 2025 one and unstar the 2026 one", diff(upd("doc_34", starred=True), upd("doc_46", starred=False)),
    ref=[act("star", rows="$doc_34", more=True), act("unstar", rows="$doc_46")]),
  T("which receipts are starred now", rows("doc_19", "doc_34"),
    ref=[ans(within="@1", where="starred = yes")]))

S("T34-055", "ambiguous-write reschedule anchor-row date-pick",
  T("push the pta meeting back a day, same time", ask("pta_270708"),
    ref=[act("reschedule", kind="event", name="PTA meeting", args=lines(to=U("day", 1, anchor="row")))]),
  T("the 8th one", diff(upd("pta_270708", date="2027-07-09T17:30")),
    ref=[act("reschedule", kind="event", name="PTA meeting", when=W(D("2027-07-08")),
             args=lines(to=U("day", 1, anchor="row")))]))

S("T34-056", "model-ask create event day",
  T("put something in the diary for friday", ask(),
    ref=[askc("What is it called, and what time?")]),
  T("fees follow-up with the principal at 3",
    diff(new("event", name=has("fees"), date="2027-06-25T15:00")),
    ref=[act("create", kind="event", args=lines(name="Fees follow-up with the principal", date=D("2027-06-25", "15:00")))]))
