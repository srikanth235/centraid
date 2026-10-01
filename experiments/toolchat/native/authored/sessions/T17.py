from gold import *
import json

world("T17", "2026-01-30T13:35", "Elena Petrova", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T17-001", "trashed people find-only restore multi restore window ask",
  T("who did i delete from contacts lately", rows("emil", "rositsa", "ognyan"),
    ref=[find(kind="person", trashed=True), ans(rows="@prev")]),
  T("put emil and rositsa back, emil's coming back for lessons", diff(restore("emil"), restore("rositsa")),
    ref=[act("restore", rows="$emil, $rositsa")]),
  T("ognyan too", ask(),
    ref=[find(kind="person", name="Ognyan", trashed=True),
         bad(act("restore", rows="$ognyan")),
         askc("ognyan's been in the bin since november, past the 30 days, so he can't be restored. add him again as a new contact?")]))

S("T17-002", "restore multi repair window",
  T("restore emil todorov, rositsa bakalova and ognyan kirilov", diff(restore("emil"), restore("rositsa")),
    ref=[find(kind="person", trashed=True),
         bad(act("restore", rows="$emil, $rositsa, $ognyan")),
         act("restore", rows="$emil, $rositsa")]),
  T("what's rositsa down as", rows("rositsa"),
    ref=[ans(rows="$rositsa")]))

S("T17-003", "star person named starred list",
  T("star veselina marinova", diff(upd("vesi", starred=True)),
    ref=[act("star", rows="$vesi")]),
  T("who've i got starred", rows("viktor", "radka", "mila", "sofia_a", "petar", "vesi"),
    ref=[ans(kind="person", where="starred = yes")]))

S("T17-004", "person starred != enum role contains star named multi turn",
  T("which students aren't starred", rows("maria_d", "maria_k", "ivan_t", "niki", "kalina", "boris"),
    ref=[ans(kind="person", where='starred != yes and role contains "student"')]),
  T("star Kalina Petkova, she's doing the exam", diff(upd("kalina", starred=True)),
    ref=[act("star", kind="person", name="Kalina Petkova")]),
  T("and niki too", diff(upd("niki", starred=True)),
    ref=[search("niki", kind="person"), act("star", rows="$niki")]))

S("T17-005", "nickname search group balance settle_up where",
  T("where am i with vesi on the studio rent", val((150, "BGN")),
    ref=[search("vesi", kind="person"),
         ans(op="balance", kind="group", name="Studio rent", linked_to="$vesi")]),
  T("settle up with the violinist there", diff(settle=[("Veselina Marinova", "150.00")]),
    ref=[act("settle_up", kind="person", where='role = "violinist"', args=lines(group="$studio"))]))

S("T17-006", "settle_up where balance after",
  T("settle up with my ex-husband in viktor's costs", diff(settle=[("Stefan Petrov", "60.00")]),
    ref=[act("settle_up", kind="person", where='role contains "ex-husband"', args=lines(group="$viktor_costs"))]),
  T("so where's he at in that group", val((0, "BGN")),
    ref=[ans(op="balance", kind="group", name="Viktor's costs", linked_to="$stefan")]))

S("T17-007", "create person add_to group settle_up new amount",
  T("add Iva Ruseva, new alto in the choir", diff(new("person", name="Iva Ruseva", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Iva Ruseva", role="choir alto"))]),
  T("put her in the chamber choir fund", diff(link("choir_fund", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$choir_fund"))]),
  T("she gave me 15 for her share of the copies, settle her up", diff(upd("+1", balance=ANY), settle=[("Iva Ruseva", "15.00")]),
    ref=[act("settle_up", rows="$c1", args=lines(group="$choir_fund", amount="15"))]))

S("T17-008", "create person more add_to settle_up new",
  T("new contact galya mincheva, cellist, she's sharing the studio from feb. add her to studio rent too",
    diff(new("person", name="Galya Mincheva", role=ANY), link("studio", "new")),
    ref=[act("create", args=lines(kind="person", name="Galya Mincheva", role="cellist"), more=True),
         act("add_to", rows="$new", args=lines(to="$studio"))]),
  T("does she owe anything there yet? settle her up if so", diff(already=["+1"]),
    ref=[act("settle_up", kind="person", rows="$c1", args=lines(group="$studio")), ans(rows="$c1")]))

S("T17-009", "cancel event where tomorrow read",
  T("cancel tomorrow's coffee, mila's got flu", diff(upd("coffee_mila", status="cancelled")),
    ref=[act("cancel", kind="event", when=W(U("day", 1)))]),
  T("anything else on saturday", rows(),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=6)), exclude="$coffee_mila")]))

S("T17-010", "cancel event where description",
  T("cancel the tosca night, mila can't get off work", diff(upd("opera", status="cancelled")),
    ref=[act("cancel", kind="event", where='description contains "Tosca"')]),
  T("who's coming to mama's birthday dinner", rows("radka", "mila", "viktor"),
    ref=[ans(kind="person", linked_to="$mama_bday")]))

S("T17-011", "events next week cancel multi",
  T("what's on next week", rows("walkthrough", "vesi_reh", "ivan_0202", "ptm", "choir_0203", "dentist_v", "maria_0204",
                               "sectional", "vesi_exam", "maria_k_lesson", "tiles_delivery", "kalina_lesson",
                               "basket_feb", "handover_0208"),
    ref=[ans(kind="event", when=W(U("week", 1)))]),
  T("cancel the alto sectional and kalina's lesson, i'll be wrecked after the exam",
    diff(upd("sectional", status="cancelled"), upd("kalina_lesson", status="cancelled")),
    ref=[act("cancel", rows="$sectional, $kalina_lesson")]))

S("T17-012", "cancel prev multi span",
  T("maria's away from feb sixteenth to the end of the month. cancel her lessons in that stretch",
    diff(upd("maria_0218", status="cancelled"), upd("maria_0225", status="cancelled")),
    ref=[find(kind="event", name="Maria's lesson", when=W(span(D("2026-02-16"), D("2026-02-28")))),
         act("cancel", rows="@prev")]),
  T("how many of her lessons are left in feb", val(2),
    ref=[ans(op="count", kind="event", name="Maria's lesson", when=W(U("month", 0, name=2)), where='status != "cancelled"')]))

S("T17-013", "complete task prev",
  T("when's the tiler deposit due", rows("tiler_deposit"),
    ref=[ans(kind="task", name="tiler deposit")]),
  T("paid it this morning, tick it off", diff(upd("tiler_deposit", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]))

S("T17-014", "complete task prev subtasks",
  T("anything about the shower cabin", rows("shower"),
    ref=[ans(kind="task", name="shower cabin")]),
  T("picked one yesterday, mark it done", diff(upd("shower", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]),
  T("what's open under the bathroom renovation", rows("tiler_deposit"),
    ref=[ans(kind="task", linked_to="$bathroom", where='status = "open"')]))

S("T17-015", "reopen task where reschedule",
  T("the maths tutor quit, reopen that one on viktor's list", diff(upd("maths_tutor", status="open", completed=None)),
    ref=[act("reopen", kind="task", linked_to="$viktor_l", where='status = "completed"')]),
  T("due next friday", diff(upd("maths_tutor", date="2026-02-06")),
    ref=[act("reschedule", rows="$maths_tutor", args=lines(to=U("week", 1, weekday=5)))]))

S("T17-016", "single reopen task where",
  T("the ink i got was the wrong cartridge, reopen the done thing on my shopping list",
    diff(upd("ink", status="open", completed=None)),
    ref=[act("reopen", kind="task", linked_to="$shopping_l", where='status = "completed"')]))

S("T17-017", "list read remove_from task multi",
  T("what's on the renovation list", rows("bathroom", "kitchen_quote", "sockets", "paint", "cover_piano", "clear_bath", "permit"),
    ref=[ans(kind="task", linked_to="$reno_l")]),
  T("take the kitchen quote and the paint off it, that's spring stuff",
    diff(unlink("reno_l", "kitchen_quote"), unlink("reno_l", "paint")),
    ref=[act("remove_from", rows="$kitchen_quote, $paint", args=lines(from_="$reno_l"))]))

S("T17-018", "remove_from task multi shopping count",
  T("take buy metronome batteries and buy printer ink off the shopping list",
    diff(unlink("shopping_l", "batteries"), unlink("shopping_l", "ink")),
    ref=[act("remove_from", rows="$batteries, $ink", args=lines(from_="$shopping_l"))]),
  T("how's many left on it", val(2),
    ref=[ans(op="count", kind="task", linked_to="$shopping_l")]))

S("T17-019", "create note edit new pin",
  T("new note recital snacks: juice and banitsa for 20 kids",
    diff(new("note", name=has("Recital", "snacks"), body=ANY)),
    ref=[act("create", args=lines(kind="note", name="Recital snacks", body="juice and banitsa for 20 kids"))]),
  T("make that 25 kids, the parents are coming too", diff(upd("+1", body=has("25"))),
    ref=[act("edit", rows="$c1", args=lines(body="juice and banitsa for 25 kids"))]),
  T("pin it", diff(upd("+1", pinned=True)),
    ref=[act("edit", rows="$c1", args=lines(pinned="yes"))]))

S("T17-020", "create note edit new",
  T("note for mitko questions: grout colour, where the boiler goes",
    diff(new("note", name=has("Mitko"), body=ANY)),
    ref=[act("create", args=lines(kind="note", name="Questions for Mitko", body="grout colour, where the boiler goes"))]),
  T("add the extractor fan to it", diff(upd("+1", body=has("extractor"))),
    ref=[act("edit", rows="$c1", args=lines(body="grout colour, where the boiler goes, the extractor fan"))]))

S("T17-021", "create document folder star",
  T("save a doc Shower cabin invoice in renovation", diff(new("document", name="Shower cabin invoice"), link("reno_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Shower cabin invoice", folder="$reno_f"))]),
  T("count of docs inside that folder", val(5),
    ref=[ans(op="count", kind="document", linked_to="$reno_f")]))

S("T17-022", "create document ask without options",
  T("can you add a document called Viktor's summer schedule", diff(new("document", name="Viktor's summer schedule")),
    ref=[act("create", args=lines(kind="document", name="Viktor's summer schedule"))]),
  T("and remind me about it", ask(),
    ref=[askc("sure, when should i remind you, and should it be a task?")]))

S("T17-023", "delete document named unfiled",
  T("delete scan 0071, it's a duplicate", diff(trash("scan_71")),
    ref=[act("delete", rows="$scan_71")]),
  T("what's not in any folder", rows("brahms_score", "warranty", "scan_72"),
    ref=[ans(kind="document", where="folder count = 0")]))

S("T17-024", "delete document named undo",
  T("delete the flat floor plan, mitko sent a newer one", diff(trash("floor_plan")),
    ref=[act("delete", kind="document", name="Flat floor plan")]),
  T("oh no undo that, i need it for the kitchen", diff(restore("floor_plan")),
    ref=[act("undo")]))

S("T17-025", "find-only unfiled docs add_to where",
  T("which docs aren't filed anywhere", rows("brahms_score", "warranty", "scan_71", "scan_72"),
    ref=[find(kind="document", where="folder count = 0"), ans(rows="@prev")]),
  T("put the starred one in students", diff(link("students_f", "brahms_score")),
    ref=[act("add_to", kind="document", where="folder count = 0 and starred = yes", args=lines(to="$students_f"))]))
