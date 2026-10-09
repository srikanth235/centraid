from gold import *
import json

world("T37", "2027-03-09T10:40", "Liam O'Brien", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T37-001", "chain relation group event find balance-group follow-up",
  T("who's at tonight's training from the fund", rows("tadhg"),
    ref=[find(kind="event", name="hurling training", when=W(U("day", 0))),
         ans(kind="person", linked_to="$gaa, @prev")]),
  T("what's tadhg's position in the fund", val((80, "EUR")),
    ref=[ans(op="balance", kind="group", name="Kilcorran Coaches Fund", linked_to="$tadhg")]),
  T("same for padraig", val((-10, "EUR")),
    ref=[ans(op="balance", kind="group", name="Kilcorran Coaches Fund", linked_to="$padraig")]))

S("T37-002", "list status date within narrow complete",
  T("what's left on the gaa list before the agm", rows("gaa_sliotars", "gaa_report"),
    ref=[ans(kind="task", linked_to="$gaa_list", where="status = open", when=W({"to": D("2027-03-18")}))]),
  T("just the ones under half an hour", rows("gaa_sliotars"),
    ref=[ans(within="@prev", where="effort < 30")]),
  T("tick off the sliotars on the gaa list, washed them last night", diff(upd("gaa_sliotars", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="sliotars", linked_to="$gaa_list")]),
  T("what else is still open on the gaa list this month besides the treasurer's note one", rows("gaa_minibus", "gaa_insurance", "gaa_dues"),
    ref=[ans(kind="task", linked_to="$gaa_list", where="status = open", when=W(U("month", 0)),
             exclude="$gaa_report")]))

S("T37-003", "ambiguous-read decoy reschedule date+time anchor-row",
  T("when's the dentist", rows("dentist_liam", "dentist_cian"),
    ref=[ans(kind="event", name="dentist")]),
  T("move cian's to april first at 5", diff(upd("dentist_cian", date="2027-04-01T17:00")),
    ref=[act("reschedule", kind="event", name="dentist", linked_to="$cian",
             args=lines(to=D("2027-04-01", "17:00")))]),
  T("and push my one on the 19th back a week", diff(upd("dentist_liam", date="2027-03-26T09:00")),
    ref=[act("reschedule", kind="event", name="dentist", when=W(D("2027-03-19")),
             args=lines(to=U("week", 1, anchor="row")))]))

S("T37-004", "multi-kind read complete reschedule same-time note",
  T("anything on hearing this week", rows("hearing", "hearing_aid"),
    ref=[ans(kind="event,task", name="hearing", when=W(U("week", 0)))]),
  T("tick off the moulds on the health list, got them yesterday", diff(upd("hearing_aid", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="moulds", linked_to="$health_list")]),
  T("move the hearing test on friday to thursday, same time", diff(upd("hearing", date="2027-03-11T14:00")),
    ref=[act("reschedule", kind="event", name="hearing test", when=W(U("week", 0, weekday=5)),
             args=lines(to=U("week", 0, weekday=4)))]),
  T("any notes from this year on the hearing aids", rows("hl_hearing"),
    ref=[ans(kind="note", name="hearing", when=W(U("year", 0)))]))

S("T37-005", "subtasks container narrow date-to reschedule",
  T("what's left for easter", rows("easter_lamb", "easter_eggs", "easter_beds", "easter_flowers"),
    ref=[ans(kind="task", linked_to="$easter_proj", where="status = open")]),
  T("which of those need doing by the 25th", rows("easter_lamb", "easter_flowers", "easter_eggs"),
    ref=[ans(within="@prev", when=W({"to": D("2027-03-25")}))]),
  T("push the flowers under easter back to the 26th", diff(upd("easter_flowers", date="2027-03-26")),
    ref=[act("reschedule", kind="task", name="flowers", linked_to="$easter_proj", args=lines(to=D("2027-03-26")))]))

S("T37-006", "chain event attendees group find balance-person decoy-names",
  T("who's coming to easter lunch", rows("aoife", "conor", "oisin", "maura"),
    ref=[find(kind="person", linked_to="$easter"), ans(rows="@prev")]),
  T("and who's at the april book club", rows("siobhan", "mary_k", "sean_b"),
    ref=[find(kind="event", name="book club", when=W(U("month", 0, name=4))),
         ans(kind="person", linked_to="@prev")]),
  T("what do i owe mary from book club", val((-63, "EUR")),
    ref=[ans(op="balance", kind="person", name="mary", linked_to="$bookclub")]),
  T("cancel the book club", ask("bookclub_jan", "bookclub_feb", "bookclub_mar", "bookclub_apr"),
    ref=[act("cancel", kind="event", name="book club")]))

S("T37-007", "empty-result add_to move-container document-folder where-count",
  T("what's in the to file folder", rows(),
    ref=[ans(kind="document", linked_to="$empty_f")]),
  T("put the christening invitation and the will copy in it",
    diff(link("empty_f", "christening_inv"), link("empty_f", "will_copy")),
    ref=[act("add_to", rows="$christening_inv, $will_copy", args="to: $empty_f")]),
  T("actually will goes in pension and tax",
    diff(unlink("empty_f", "will_copy"), link("pension_f", "will_copy")),
    ref=[act("add_to", rows="$will_copy", args="to: $pension_f")]),
  T("which docs from last year aren't filed", rows("passport_scan"),
    ref=[ans(kind="document", where="folder count = 0", when=W(U("year", -1)))]))

S("T37-008", "delete write-then-read folder gone count",
  T("delete the to file folder and show me what's left",
    rows("pension_f", "health_f", "gaa_f", "house_f", "travel_f", also=diff(gone("empty_f"))),
    ref=[act("delete", rows="$empty_f", more=True), ans(kind="folder")]),
  T("how many documents in house are from last year", val(2),
    ref=[ans(op="count", kind="document", linked_to="$house_f", when=W(U("year", -1)))]),
  T("and the gaa one", val(1),
    ref=[ans(op="count", kind="document", linked_to="$gaa_f", when=W(U("year", -1)))]))

S("T37-009", "two-writes star complete composed-apply undo read-after-undo",
  T("star the 2025 tax return and tick off the esb bill",
    diff(upd("tax_2025", starred=True), upd("esb_mar", status="completed", completed=ANY)),
    ref=[act("star", rows="$tax_2025", more=True), act("complete", kind="task", name="esb bill")]),
  T("undo that", diff(upd("tax_2025", starred=False), upd("esb_mar", status="open", completed=None)),
    ref=[act("undo")]),
  T("what's left on house list this month",
    rows("esb_mar", "bins_0309", "bins_0323", "garden_prune", "garden_shed", "garden_seeds"),
    ref=[ans(kind="task", linked_to="$house_list", where="status = open", when=W(U("month", 0)))]),
  T("star the 2026 house insurance and unstar the 2026 pension statement",
    diff(upd("house_ins26", starred=True), upd("pension_stmt", starred=False)),
    ref=[act("star", rows="$house_ins26", more=True), act("unstar", rows="$pension_stmt")]))

S("T37-010", "create clash composed-ask retry wrong-container decline",
  T("put coffee with gerry in the diary thursday at 11", ask("coffee_brendan"),
    ref=[act("create", args="kind: event\nname: Coffee with Gerry\n" + lines(date=U("week", 0, weekday=4, time="11:00")))]),
  T("ok make it friday", diff(new("event", name=has("coffee", "gerry"), date="2027-03-12T11:00")),
    ref=[act("create", args="kind: event\nname: Coffee with Gerry\n" + lines(date=U("week", 0, weekday=5, time="11:00")))]),
  T("add gerry to it", decline("out_of_scope"),
    ref=[act("add_to", rows="$gerry", args="to: $new")]))

S("T37-011", "name+link+when documents year substitution star",
  T("tax docs in the pension folder from last year", rows("tax_2025"),
    ref=[ans(kind="document", name="tax", linked_to="$pension_f", when=W(U("year", -1)))]),
  T("and the year before", rows("tax_2024"),
    ref=[ans(kind="document", name="tax", linked_to="$pension_f", when=W(U("year", -2)))]),
  T("star that one", diff(upd("tax_2024", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("which pension statements are starred", rows("pension_stmt"),
    ref=[ans(kind="document", name="pension statement", where="starred = yes")]),
  T("star the 2025 one too and show me which tax docs are starred in the pension folder now",
    rows("tax_2024", "tax_2025", also=diff(upd("tax_2025", starred=True))),
    ref=[act("star", rows="$tax_2025", more=True),
         ans(kind="document", name="tax", linked_to="$pension_f", where="starred = yes")]))

S("T37-012", "debts link person settle_debt sum",
  T("any debts with tadhg from this year", rows("d_tadhg"),
    ref=[ans(kind="debt", linked_to="$tadhg", when=W(U("year", 0)))]),
  T("and padraig", rows("d_padraig"),
    ref=[ans(kind="debt", linked_to="$padraig", when=W(U("year", 0)))]),
  T("settle padraig's minibus debt, paid him in cash", diff(upd("d_padraig", status="settled")),
    ref=[act("settle_debt", kind="debt", name="minibus", linked_to="$padraig")]),
  T("what do i owe in total now", val((261.5, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open")]))


S("T37-013", "photos link-all when narrow exclude add_to",
  T("photos of cian this year in the grandchildren album",
    rows("p_cian_goal", "p_wed_minding", "p_cian_hurl", "p_cian_snow"),
    ref=[bad(ans(kind="photo", linked_to="$cian, $grand_album", when=W({"unit": "year"}))),
         ans(kind="photo", linked_to="$cian, $grand_album", when=W(U("year", 0)))]),
  T("just the starred ones", rows("p_cian_goal"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("who else is in that one", rows("aoife"),
    ref=[ans(kind="person", linked_to="$p_cian_goal", exclude="$cian")]),
  T("put it in the hurling album too", diff(link("hurl_album", "p_cian_goal")),
    ref=[act("add_to", rows="$p_cian_goal", args="to: $hurl_album")]),
  T("and starred ones from last year in the grandchildren album", rows("p_saoirse_bday", "p_oisin_first"),
    ref=[ans(kind="photo", linked_to="$grand_album", where="starred = yes", when=W(U("year", -1)))]))

S("T37-014", "photos album month trashed restore-window decline find restore",
  T("starred photos in the hurling album from february", rows("p_hurl_team"),
    ref=[ans(kind="photo", linked_to="$hurl_album", where="starred = yes", when=W(U("month", 0, name=2)))]),
  T("is the receipt screenshot still around", rows("p_receipt"),
    ref=[ans(kind="photo", name="receipt")]),
  T("bring it back", decline("not_found"),
    ref=[act("restore", rows="$p_receipt")]),
  T("same for the blurry one", diff(restore("p_blurry")),
    ref=[find(kind="photo", name="blurry", trashed=True), act("restore", rows="@prev")]))

S("T37-015", "events name month where-not-cancelled substitution within-when reschedule same-time",
  T("physio sessions in february except the cancelled one", rows("physio_0201", "physio_0208", "physio_0222"),
    ref=[ans(kind="event", name="physio", when=W(U("month", 0, name=2)), where="status != cancelled")]),
  T("and this month", rows("physio_0301", "physio_0308", "physio_0315", "physio_0322", "physio_0329", "physio_review"),
    ref=[ans(kind="event", name="physio", when=W(U("month", 0)), where="status != cancelled")]),
  T("which of those are still to come", rows("physio_0315", "physio_0322", "physio_0329", "physio_review"),
    ref=[ans(within="@prev", when=W({"from": U("day", 1)}))]),
  T("push the physio review on the 30th to the first of april, same time", diff(upd("physio_review", date="2027-04-01T10:00")),
    ref=[act("reschedule", kind="event", name="physio review", when=W(D("2027-03-30")), args=lines(to=D("2027-04-01")))]),
  T("how many physio sessions by status this year", vgroups({"tentative": 9, "cancelled": 1}),
    ref=[comp(op="count", kind="event", name="physio", group="status", when=W(U("year", 0))), ans(value="@prev")]))

S("T37-016", "decoy-events cardiology next order-limit reschedule same-time",
  T("when's the next cardiology clinic", rows("cardio"),
    ref=[ans(kind="event", name="cardiology clinic", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("and the bloods before it", rows("cardio_bloods"),
    ref=[ans(kind="event", name="bloods")]),
  T("push the cardiology clinic on the 24th to the 25th, same time", diff(upd("cardio", date="2027-03-25T11:00")),
    ref=[act("reschedule", kind="event", name="cardiology clinic", when=W(D("2027-03-24")), args=lines(to=D("2027-03-25")))]))

S("T37-017", "next one-after exclude order-limit attendees log",
  T("when's the next hurling match", rows("hurling_match"),
    ref=[ans(kind="event", name="hurling match", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("and the one after", rows("hurling_match2"),
    ref=[ans(kind="event", name="hurling match", when=W({"from": U("day", 0)}), order="date asc", limit=1,
             exclude="@prev")]),
  T("who's going to that", rows("tadhg"),
    ref=[ans(kind="person", linked_to="$hurling_match2")]),
  T("rang tadhg about the team, log it", diff(upd("tadhg", date="2027-03-09T10:40")),
    ref=[act("log", rows="$tadhg", args="kind: call")]),
  T("cancel the hurling match", ask("hurling_match", "hurling_match2"),
    ref=[act("cancel", kind="event", name="hurling match")]))

S("T37-018", "superlatives longest shortest order-limit week",
  T("longest thing this week that isn't cancelled", rows("grandkids_0310"),
    ref=[ans(kind="event", when=W(U("week", 0)), where="status != cancelled", order="duration desc", limit=1)]),
  T("and the shortest", rows("calldec_0314"),
    ref=[ans(kind="event", when=W(U("week", 0)), where="status != cancelled", order="duration asc", limit=1)]),
  T("who's at the long one", rows("cian", "saoirse"),
    ref=[ans(kind="person", linked_to="$grandkids_0310")]),
  T("and the biggest one next week that isn't cancelled", rows("golf_outing"),
    ref=[ans(kind="event", when=W(U("week", 1)), where="status != cancelled", order="duration desc", limit=1)]))

S("T37-019", "group-balance-me person-sub group-members photos-link-all",
  T("where do i stand in the boston group", val((-43.34, "USD")),
    ref=[ans(op="balance", kind="group", name="Boston Trip", linked_to="$me")]),
  T("and dec?", val((16.67, "USD")),
    ref=[ans(op="balance", kind="group", name="Boston Trip", linked_to="$declan")]),
  T("who's in the boston group", rows("me", "declan", "kathleen", "jack"),
    ref=[find(kind="person", linked_to="$boston"), ans(rows="@prev")]),
  T("photos with dec from the boston album on the 28th", rows("p_bos_dec", "p_bos_northend"),
    ref=[ans(kind="photo", linked_to="$declan, $boston_album", when=W(D("2026-12-28")))]))


S("T37-020", "bulk delete cap composed-ask yes-confirm read-after",
  T("delete all the finished tasks", ask(),
    ref=[act("delete", kind="task", where="status = completed")]),
  T("yes go ahead",
    diff(trash("esb_nov"), trash("esb_jan"), trash("esb_mar_old"), trash("rx_dec"), trash("rx_jan"), trash("rx_feb"),
         trash("rx_mar"), trash("bins_0112"), trash("bins_0126"), trash("bins_0209"), trash("bins_0223"),
         trash("easter_menu"), trash("camino_credentials"), trash("garden_bulbs"), trash("gaa_dues_old"),
         trash("gaa_vests"), trash("flu_jab")),
    ref=[act("delete", kind="task", where="status = completed")]),
  T("what's still open on the house list for march",
    rows("esb_mar", "bins_0309", "bins_0323", "garden_prune", "garden_shed", "garden_seeds"),
    ref=[ans(kind="task", linked_to="$house_list", where="status = open", when=W(U("month", 0, name=3)))]),
  T("how many tasks by status on the house list this month", vgroups({"open": 6}),
    ref=[comp(op="count", kind="task", group="status", linked_to="$house_list", when=W(U("month", 0))),
         ans(value="@prev")]))

S("T37-021", "series composed-apply ambiguous-open near-spelling trashed-target decline",
  T("i ordered the repeat prescription this morning, tick it off",
    diff(upd("rx_apr", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="repeat prescription")]),
  T("and the bins", ask("bins_0309", "bins_0323"),
    ref=[act("complete", kind="task", name="bins")]),
  T("the one for tonight", diff(upd("bins_0309", status="completed", completed=ANY)),
    ref=[act("complete", rows="$bins_0309")]),
  T("mark the hearing aid mulds done", diff(upd("hearing_aid", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="hearing aid mulds")]),
  T("and tick off fix the garden gate", decline("not_found"),
    ref=[act("complete", kind="task", name="garden gate")]))

S("T37-022", "bare-plural ask ordinal-pick cancel-by-date cancelled-reschedule ask",
  T("push the physio sessions to friday",
    ask("physio_0201", "physio_0208", "physio_0215", "physio_0222", "physio_0301", "physio_0308", "physio_0315",
        "physio_0322", "physio_0329", "physio_review"),
    ref=[act("reschedule", kind="event", name="physio", args=lines(to=U("week", 0, weekday=5)))]),
  T("i meant next monday's", diff(upd("physio_0315", date="2027-03-12T10:00")),
    ref=[act("reschedule", rows="$physio_0315", args=lines(to=U("week", 0, weekday=5)))]),
  T("and cancel the call with dec on the 14th", diff(upd("calldec_0314", status="cancelled")),
    ref=[act("cancel", kind="event", name="call declan", when=W(D("2027-03-14")))]),
  T("put last week's training back on thursday", ask("training_0302"),
    ref=[act("reschedule", kind="event", name="hurling training", when=W(U("week", -1)),
             args=lines(to=U("week", 0, weekday=4)))]))

S("T37-023", "decline out-of-scope text edit description decline weather",
  T("text aoife that i'll be late for the minding", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("put running late in the description of tomorrow's minding",
    diff(upd("grandkids_0310", description="running late")),
    ref=[act("edit", kind="event", name="minding cian and saoirse", when=W(U("day", 1)),
             args="description: running late")]),
  T("what's the weather doing on wednesday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T37-024", "ambiguous-write ask never-mind then read",
  T("move the dentist to thursday at 3", ask("dentist_liam", "dentist_cian"),
    ref=[act("reschedule", kind="event", name="dentist", args=lines(to=U("week", 0, weekday=4, time="15:00")))]),
  T("nah forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("when's the hearing test", rows("hearing"),
    ref=[ans(kind="event", name="hearing test")]))

S("T37-025", "group members value-group refused-remove ask settle_up remove_from",
  T("who's in the golf society pot", rows("me", "gerry", "brendan", "sean_m"),
    ref=[find(kind="person", linked_to="$golf"), ans(rows="@prev")]),
  T("where do i stand in it", val((100, "EUR")),
    ref=[ans(op="balance", kind="group", name="Golf Society Pot", linked_to="$me")]),
  T("take the gaa sean out of the golf group", ask("sean_m", "golf"),
    ref=[act("remove_from", kind="person", name="sean", linked_to="$gaa", args="from: $golf")]),
  T("settle up with him in the golf pot", diff(settle=[("Sean Murphy", "70.00")]),
    ref=[act("settle_up", rows="$sean_m", args="group: $golf")]),
  T("now take him out", diff(unlink("golf", "sean_m")),
    ref=[act("remove_from", rows="$sean_m", args="from: $golf")]))

S("T37-026", "group members remove delete-empty-group unlinks undo-not-undone",
  T("who's on the camino group", rows("me", "gerry", "tadhg"),
    ref=[find(kind="person", linked_to="$camino"), ans(rows="@prev")]),
  T("take tadhg off it, his knee's not up to it", diff(unlink("camino", "tadhg")),
    ref=[act("remove_from", rows="$tadhg", args="from: $camino")]),
  T("and delete the group, we're paying cash", diff(gone("camino"), unlink("camino", "gerry"), unlink("camino", "me")),
    ref=[act("delete", rows="$camino")]),
  T("undo that", diff(),
    ref=[act("undo")]))

S("T37-027", "create group add_to-several members create-debt links",
  T("start a salthill walkers group in euro",
    diff(new("group", name="Salthill Walkers", currency="EUR"), link("new", "me")),
    ref=[act("create", args="kind: group\nname: Salthill Walkers\ncurrency: EUR")]),
  T("put nuala and gerry in it", diff(link("+1", "nuala"), link("+1", "gerry")),
    ref=[act("add_to", rows="$nuala, $gerry", args="to: $new")]),
  T("who's in it", rows("me", "nuala", "gerry"),
    ref=[find(kind="person", linked_to="$c1"), ans(rows="@prev")]),
  T("nuala owes me 12 for the lotto",
    diff(new("debt", name=has("lotto"), amount=12, direction="owes_me"), link("new", "nuala")),
    ref=[act("create", args="kind: debt\nname: lotto\namount: 12\ndirection: owes_me\nperson: $nuala")]))

S("T37-028", "create person star log-visit created-row-followups",
  T("add frank hanley, nuala's husband",
    diff(new("person", name="Frank Hanley", role=has("husband"))),
    ref=[act("create", args="kind: person\nname: Frank Hanley\nrole: Nuala's husband")]),
  T("star him", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$new")]),
  T("popped round for tea, log a visit with him", diff(upd("+1", date="2027-03-09T10:40")),
    ref=[act("log", rows="$new", args="kind: visit")]))
