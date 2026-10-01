from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T27-076", "six turns task person count folder refused ask write then read",
  T("opening day tasks that have someone attached", rows("sign", "flyers", "prep"),
    ref=[ans(kind="task", linked_to="$open_l", where="person count != 0")]),
  T("Pick up the shop sign, who's that with", rows("karim"),
    ref=[ans(kind="person", linked_to="$sign")]),
  T("log a message to Karim Mansouri, told him we'll come at 9", diff(upd("karim", date=ANY)),
    ref=[act("log", rows="$karim", args=lines(kind="message"))]),
  T("delete the Shop folder, i'm refiling everything", ask(),
    ref=[bad(act("delete", kind="folder", name="Shop")),
         askc("the shop folder still holds the lease, the insurance policy and the kbis extract, so it can't be deleted. move them out first?")]),
  T("no leave it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("Write the menu boards is done. what's open on Opening day",
    rows("sign", "till_float", "flyers", also=diff(upd("menu_boards", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Write the menu boards", more=True),
         ans(kind="task", linked_to="$open_l", where='status = "open"')]))

S("T27-077", "home task person count debt settle prev",
  T("home list tasks that involve someone else", rows("boiler", "nursery"),
    ref=[ans(kind="task", linked_to="$home_l", where="person count != 0")]),
  T("who's on Paint the nursery", rows("julien", "thomas_m"),
    ref=[ans(kind="person", linked_to="$nursery")]),
  T("what do i owe thomas for the paint", rows("d_thomas"),
    ref=[ans(kind="debt", linked_to="$thomas_m")]),
  T("settle it, sent him the money", diff(upd("d_thomas", status="settled")),
    ref=[act("settle_debt", rows="@prev")]))

S("T27-078", "six turns note month span person count pinned edit multi empty note search count",
  T("notes from november up to last sunday that mention at most one person",
    rows("lamination", "kouign", "praline", "midwife_q", "butter_notes", "choc_notes", "baby_names", "oven_manual",
         "baby_shopping"),
    ref=[ans(kind="note", when=W(span(U("month", 0, name=11), U("week", -1, weekday=7))), where="person count <= 1")]),
  T("which of them are pinned", rows("lamination"),
    ref=[ans(within="@prev", where="pinned = yes")]),
  T("unpin Croissant lamination and pin Kouign-amann instead",
    diff(upd("lamination", pinned=False), upd("kouign", pinned=True)),
    ref=[act("edit", rows="$lamination", args=lines(pinned="no"), more=True),
         act("edit", rows="$kouign", args=lines(pinned="yes"))]),
  T("where's my praline tart note", rows("praline"),
    ref=[find(kind="note", name="Praline tart"), search("praline", kind="note"), ans(rows="$praline")]),
  T("add 180 degrees for 25 min to it", diff(upd("praline", body=has("25 min"))),
    ref=[act("edit", rows="$praline", args=lines(body="pink pralines from Saint-Genix, 180 degrees for 25 min"))]),
  T("how many notes in Recipes", val(4),
    ref=[ans(op="count", kind="note", linked_to="$recipes_nb")]))

S("T27-079", "note month span weekday pinned body edit undo field",
  T("pinned notes from october up to monday last week", rows("layout", "lamination"),
    ref=[ans(kind="note", when=W(span(U("month", 0, name=10), U("week", -1, weekday=1))), where="pinned = yes")]),
  T("what does Shop layout say", rows("layout"),
    ref=[ans(rows="$layout")]),
  T("change it to display case left, till by the door, bench by the window",
    diff(upd("layout", body="display case left, till by the door, bench by the window")),
    ref=[act("edit", rows="$layout", args=lines(body="display case left, till by the door, bench by the window"))]),
  T("undo that, camille wants the bench outside", diff(upd("layout", body="display case left, till by the door")),
    ref=[act("undo")]))

S("T27-080", "pregnancy notes person count body edit",
  T("pregnancy notes with at most one person linked", rows("midwife_q", "kicks"),
    ref=[ans(kind="note", linked_to="$preg_nb", where="person count <= 1")]),
  T("what's in the Baby kicks log", rows("kicks"),
    ref=[ans(kind="note", name="Baby kicks log")]),
  T("add: and around 11pm", diff(upd("kicks", body=has("11pm"))),
    ref=[act("edit", rows="$kicks", args=lines(body="most active after coffee, and around 11pm"))]),
  T("pay the electricity bill is done btw", diff(upd("elec_12", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay the electricity bill"),
         act("complete", kind="task", name="Pay the electricity bill", where='status = "open"')]))

S("T27-081", "note month to month body literal person log",
  T("notes i wrote in september or october", rows("layout", "flour_notes", "sign_words", "lease_points"),
    ref=[ans(kind="note", when=W(span(U("month", 0, name=9), U("month", 0, name=10))))]),
  T("the one that says exactly no rent increase for three years", rows("lease_points"),
    ref=[ans(kind="note", where='body = "no rent increase for 3 years"')]),
  T("who's it linked to", rows("karim"),
    ref=[ans(kind="person", linked_to="$lease_points")]),
  T("log a call with him, he confirmed it in writing", diff(upd("karim", date=ANY)),
    ref=[act("log", rows="$karim", args=lines(kind="call"))]))

S("T27-082", "supplier notes month span find-only body notebook count",
  T("Supplier notes from october to november", rows("flour_notes", "butter_notes", "choc_notes"),
    ref=[ans(kind="note", linked_to="$sup_nb", when=W(span(U("month", 0, name=10), U("month", 0, name=11))))]),
  T("which one mentions guanaja", rows("choc_notes"),
    ref=[find(kind="note", where='body contains "Guanaja"'), ans(rows="@prev")]),
  T("which notebooks have three or more notes", rows("recipes_nb", "plans_nb", "preg_nb", "sup_nb"),
    ref=[ans(kind="notebook", where="note count >= 3")]))

S("T27-083", "five turns note anchor time edit body midwife ambiguous ask reschedule",
  T("what did i write last night at 22:15", rows("opening_menu"),
    ref=[ans(kind="note", when=W(U("day", -1, anchor="today", time="22:15")))]),
  T("and the night before, same time", rows("rota"),
    ref=[ans(kind="note", when=W(U("day", -2, anchor="today", time="22:15")))]),
  T("add pain aux raisins to the Opening day menu", diff(upd("opening_menu", body=has("pain aux raisins"))),
    ref=[find(kind="note", name="Opening day menu"),
         act("edit", rows="$opening_menu",
             args=lines(body="croissants, kouign-amann, praline brioche, baguette tradition, pain aux raisins"))]),
  T("move the midwife appointment to 9", ask("midwife_nov", "midwife_dec"),
    ref=[act("reschedule", kind="event", name="Midwife appointment", args=lines(to=U("day", 0, anchor="row", time="09:00"))),
         find(kind="event", name="Midwife appointment"),
         askc("the one on 12 november or next thursday's?", options="$midwife_nov, $midwife_dec")]),
  T("next thursday obviously", diff(upd("midwife_dec", date="2026-12-10T09:00")),
    ref=[act("reschedule", rows="$midwife_dec", args=lines(to=U("day", 0, anchor="row", time="09:00")))]))

S("T27-084", "note anchor time people edit body",
  T("the note from two days ago at 22:15, what's in it", rows("rota"),
    ref=[ans(kind="note", when=W(U("day", -2, anchor="today", time="22:15")))]),
  T("who's tagged on it", rows("nadia", "hugo", "ines"),
    ref=[ans(kind="person", linked_to="$rota")]),
  T("swap it round, hugo at the front and inès shaping", diff(upd("rota", body="Nadia on ovens, Hugo at the front, Inès shaping")),
    ref=[act("edit", rows="$rota", args=lines(body="Nadia on ovens, Hugo at the front, Inès shaping"))]))

S("T27-085", "document span datetime month unfiled add_to multi count",
  T("docs added from tenth nov midday to the end of november",
    rows("insurance", "blood", "loan", "scan_a", "scan_b", "oven_invoice", "leave_cert"),
    ref=[ans(kind="document", when=W(span(D("2026-11-10", "12:00"), U("month", 0, name=11))))]),
  T("which of those aren't filed", rows("scan_a", "scan_b"),
    ref=[ans(within="@prev", where="folder count = 0")]),
  T("they're the oven warranty, put both in Suppliers", diff(link("sup_f", "scan_a"), link("sup_f", "scan_b")),
    ref=[act("add_to", rows="@prev", args=lines(to="$sup_f"))]),
  T("how many in suppliers", val(5),
    ref=[ans(op="count", kind="document", linked_to="$sup_f")]))

S("T27-086", "document span datetime month lease date duration empty",
  T("docs from fifteenth october 11am to the end of october", rows("kbis", "floor_plan", "flour_contract"),
    ref=[ans(kind="document", when=W(span(D("2026-10-15", "11:00"), U("month", 0, name=10))))]),
  T("wasn't the Shop lease that day too", rows("lease"),
    ref=[ans(kind="document", name="Shop lease")]),
  T("unrelated but do any of my events have no length on them", rows(),
    ref=[ans(kind="event", where="duration is empty")]),
  T("cancel the test bake on monday, the new flour isn't in", diff(upd("bake_1207", status="cancelled")),
    ref=[act("cancel", kind="event", name="Test bake"),
         act("cancel", kind="event", name="Test bake", when=W(U("week", 1, weekday=1)))]))

S("T27-087", "document open end datetime rename add_to undo link",
  T("docs since twenty-fourth nov 6pm", rows("scan_b", "leave_cert", "menu_draft"),
    ref=[ans(kind="document", when=W({"from": D("2026-11-24", "18:00")}))]),
  T("rename Scan 1124 to Oven warranty", diff(upd("scan_b", name="Oven warranty")),
    ref=[act("edit", rows="$scan_b", args=lines(name="Oven warranty"))]),
  T("and put it in suppliers", diff(link("sup_f", "scan_b")),
    ref=[act("add_to", rows="$scan_b", args=lines(to="$sup_f"))]),
  T("undo that, it goes in Shop", diff(unlink("sup_f", "scan_b")),
    ref=[act("undo")]))

S("T27-088", "filed docs open end folder count folder of loan paris folder refused trashed doc",
  T("filed docs from eighteenth nov noon onwards", rows("loan", "leave_cert", "oven_invoice"),
    ref=[ans(kind="document", when=W({"from": D("2026-11-18", "12:00")}), where="folder count >= 1")]),
  T("which folder's the loan in", rows("bank_f"),
    ref=[ans(kind="folder", linked_to="$loan")]),
  T("delete the Old Paris folder", ask(),
    ref=[bad(act("delete", kind="folder", name="Old Paris")),
         askc("old paris still holds the paris rental contract, which is in the trash and too old to restore, so the folder has to stay. rename it Archive instead?")]),
  T("ok yes, rename it archive", diff(upd("paris_f", name="Archive")),
    ref=[act("edit", rows="$paris_f", args=lines(name="Archive"))]),
  T("star the insurance certificate and the kbis, then show me my starred docs",
    rows("lease", "loan", "partnership", "insurance", "kbis",
         also=diff(upd("insurance", starred=True), upd("kbis", starred=True))),
    ref=[act("star", kind="document", name="Insurance certificate"), search("insurance", kind="document"),
         act("star", rows="$insurance, $kbis", more=True), ans(kind="document", where="starred = yes")]))


S("T27-089", "photo span weekday day person count add_to write then read",
  T("photos from last saturday to yesterday",
    rows("p_bump28", "p_xmas", "p_lea", "p_market", "p_stroller", "p_croissants", "p_receipt", "p_case", "p_praline",
         "p_team", "p_menu"),
    ref=[ans(kind="photo", when=W(span(U("week", -1, weekday=6), U("day", -1))))]),
  T("ones with over two people in the frame", rows("p_praline", "p_team"),
    ref=[ans(within="@prev", where="person count > 2")]),
  T("add Team with aprons to the Opening day album and show me what's in it",
    rows("p_team", also=diff(link("opening_al", "p_team"))),
    ref=[act("add_to", rows="$p_team", args=lines(to="$opening_al"), more=True),
         ans(kind="photo", linked_to="$opening_al")]))

S("T27-090", "photo span weekday starred unstar person date",
  T("starred photos from last monday up to the day before yesterday", rows("p_bump28", "p_croissants"),
    ref=[ans(kind="photo", when=W(span(U("week", -1, weekday=1), U("day", -2))), where="starred = yes")]),
  T("unstar bump at 28 weeks", diff(upd("p_bump28", starred=False)),
    ref=[act("unstar", rows="$p_bump28")]),
  T("who did i see on the twenty-eighth", rows("lea", "aurelie"),
    ref=[ans(kind="person", when=W(D("2026-11-28")))]),
  T("add lunch with léa on sunday", ask(),
    ref=[askc("what time sunday? you've got dinner with her at 7:30 already.")]))

S("T27-091", "photo since monday delete undo delete yesterday photo",
  T("photos since monday", rows("p_croissants", "p_receipt", "p_case", "p_praline", "p_team", "p_menu"),
    ref=[ans(kind="photo", when=W({"from": U("week", 0, weekday=1)}))]),
  T("delete the Flour receipt one", diff(trash("p_receipt")),
    ref=[act("delete", rows="$p_receipt")]),
  T("no wait undo, sandrine needs it", diff(restore("p_receipt")),
    ref=[act("undo")]),
  T("pics i shot yesterday", rows("p_menu"),
    ref=[ans(kind="photo", when=W(U("day", -1)))]))

S("T27-092", "photo since last friday no album julien",
  T("photos since last friday that aren't in any album", rows("p_stroller", "p_xmas", "p_lea", "p_receipt", "p_menu", "p_team"),
    ref=[ans(kind="photo", when=W({"from": U("week", -1, weekday=5)}), where="album count = 0")]),
  T("which have julien moreau in", rows("p_stroller", "p_xmas"),
    ref=[ans(within="@prev", linked_to="$julien")]),
  T("log a visit with camille", ask("camille_r", "camille_p"),
    ref=[act("log", kind="person", name="Camille", args=lines(kind="visit")),
         askc("camille roux or camille petit?", options="$camille_r, $camille_p")]),
  T("roux, she came by the flat", diff(upd("camille_r", date=ANY)),
    ref=[act("log", rows="$camille_r", args=lines(kind="visit"))]))

S("T27-093", "six turns debt span date weekday amount literal settle debt margaux balance settle up",
  T("debts from fifteenth nov up to last sunday", rows("d_max", "d_margaux", "d_thomas", "d_sarah"),
    ref=[ans(kind="debt", when=W(span(D("2026-11-15"), U("week", -1, weekday=7))))]),
  T("which are open and thirty or less", rows("d_max", "d_margaux"),
    ref=[ans(within="@prev", where='status = "open" and amount <= 30')]),
  T("settle Pizza night, max paid", diff(upd("d_max", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Pizza night")]),
  T("and margaux's yoga class one?", rows("d_margaux"),
    ref=[ans(kind="debt", name="Yoga class")]),
  T("where am i with her", val((17, "EUR")),
    ref=[comp(op="balance", rows="$margaux"), ans(value="@prev")]),
  T("settle up with her in the Prenatal group", diff(settle=["Margaux Fontaine"]),
    ref=[act("settle_up", rows="$margaux", args=lines(group="$prenatal_g"))]))

S("T27-094", "debt span date weekday owe compute max min balance",
  T("what do i owe from first october to monday last week", rows("d_lea", "d_camille", "d_antoine", "d_thomas", "d_matthieu"),
    ref=[ans(kind="debt", when=W(span(D("2026-10-01"), U("week", -1, weekday=1))), where='direction = "i_owe"')]),
  T("biggest one still open", val((1500, "EUR")),
    ref=[comp(op="max", field="amount", within="@prev", where='status = "open"'), ans(value="@prev")]),
  T("and the smallest", val((60, "EUR")),
    ref=[comp(op="min", field="amount", within="@1", where='status = "open"'), ans(value="@prev")]),
  T("where am i with antoine mercier all in", val((-1900, "EUR")),
    ref=[comp(op="balance", rows="$antoine"), ans(value="@prev")]))

S("T27-095", "debt span datetime person count settle debt",
  T("debts between fourteenth nov 9am and twenty-fourth nov 6pm", rows("d_chloe", "d_max", "d_margaux", "d_thomas", "d_sarah"),
    ref=[ans(kind="debt", when=W(span(D("2026-11-14", "09:00"), D("2026-11-24", "18:00"))))]),
  T("which of those have a person on them and are over 40", rows("d_chloe", "d_thomas"),
    ref=[ans(within="@prev", where="person count != 0 and amount > 40")]),
  T("settle concert tickets", diff(upd("d_chloe", status="settled")),
    ref=[act("settle_debt", rows="$d_chloe")]))

S("T27-096", "debt span datetime sum balance max",
  T("debts logged from tuesday 8am till", rows("d_chloe2", "d_hugo", "d_nadia"),
    ref=[ans(kind="debt", when=W(span(U("week", 0, weekday=2, time="08:00"), U("minute", 0))))]),
  T("how much is that all together", val((57, "EUR")),
    ref=[comp(op="sum", field="amount", rows="@prev"), ans(value="@prev")]),
  T("what's chloé's balance with me", val((70, "EUR"), (-30, "GBP")),
    ref=[comp(op="balance", rows="$chloe"), ans(value="@prev")]),
  T("biggest open debt anyone owes me", val((45, "EUR")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "owes_me" and status = "open"'),
         ans(value="@prev")]),
  T("settle nadia's takeaway lunch and hugo's knife sharpening, both paid me in cash",
    diff(upd("d_nadia", status="settled"), upd("d_hugo", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Takeaway lunch"), search("lunch", kind="debt"),
         act("settle_debt", rows="$d_nadia", more=True), act("settle_debt", kind="debt", name="Knife sharpening")]))

S("T27-097", "debt open start date amount literal currency not eur",
  T("debts from before november", rows("d_lea", "d_antoine"),
    ref=[ans(kind="debt", when=W({"to": D("2026-10-31")}))]),
  T("any debts at all of 30 or under", rows("d_chloe2", "d_max", "d_hugo", "d_margaux", "d_nadia"),
    ref=[ans(kind="debt", where="amount <= 30")]),
  T("groups that use some other currency than euros?", rows("geneva_g", "london_g"),
    ref=[ans(kind="group", where='currency != "EUR"')]),
  T("the london trip group, who's in it", rows("chloe", "maxime", "me"),
    ref=[find(kind="group", name="London trip"), search("london", kind="group"), ans(kind="person", linked_to="$london_g")]))

S("T27-098", "debt open start date person count ask remind",
  T("open debts from before tenth november", rows("d_lea", "d_camille", "d_antoine"),
    ref=[ans(kind="debt", when=W({"to": D("2026-11-10")}), where='status = "open"')]),
  T("of those, the ones over 100 with someone on them", rows("d_lea", "d_camille", "d_antoine"),
    ref=[ans(within="@prev", where="person count != 0 and amount > 100")]),
  T("remind me to pay antoine back", ask(),
    ref=[askc("when do you want to be reminded? i'll add it as a task due that day.")]))

S("T27-099", "six turns locker type empty starred reveal sealed egress create undo create",
  T("locker items with no type set", rows(),
    ref=[ans(kind="locker item", where="type is empty")]),
  T("which are starred then", rows("bank_login", "biz_visa", "metro_card"),
    ref=[ans(kind="locker item", where="starred = yes")]),
  T("what's the Crédit Agricole password", diff(reveal=[("bank_login", "Fournil-Levain-42")]),
    ref=[act("reveal", rows="$bank_login", args=lines(field="password"))]),
  T("send it to julien", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("add a locker entry Crèche portal, login", diff(new("locker item", name="Crèche portal", type="login")),
    ref=[act("create", args=lines(kind="locker item", name="Crèche portal", type="login"))]),
  T("undo, they haven't given us an account yet", diff(trash("+1")),
    ref=[act("undo")]))

S("T27-100", "single locker type empty",
  T("is anything in the locker missing its type", rows(),
    ref=[ans(kind="locker item", where="type is empty")]))
