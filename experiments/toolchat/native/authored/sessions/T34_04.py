from gold import *
import json

world("T34", "2027-06-20T21:15", "Obinna Okafor", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# ---- same-word-pick -------------------------------------------------------------------------------

S("T34-066", "same-word-pick document star applicability folder-target lookalike count",
  T("star the company tax return", diff(upd("doc_13", starred=True)),
    ref=[act("star", kind="document", name="Company tax return")]),
  T("file it under taxes", diff(link("taxes_f", "doc_13")),
    ref=[act("add_to", rows="$doc_13", args=lines(to="$taxes_f"))]),
  T("how many in there now", val(10),
    ref=[ans(op="count", kind="document", linked_to="$taxes_f")]))

S("T34-067", "same-word-pick person role-gloss possessor-vs-relation add_to group-target lookalike count",
  T("put kemi the sunday school teacher in the church group", diff(link("church_build", "kemi_okonkwo")),
    ref=[act("add_to", kind="person", name="Kemi", where='role contains "Sunday school"', args=lines(to="$church_build"))]),
  T("and add adaobi to chidi's wedding group", diff(link("wedding", "adaobi")),
    ref=[act("add_to", kind="person", name="Adaobi", args=lines(to="$wedding"))]),
  T("how many are in the church group now", val(14),
    ref=[ans(op="count", kind="person", linked_to="$church_build")]))

S("T34-068", "same-word-pick photos two-row-linked_to album-lookalike star within",
  T("photos of ngozi eze in the church album",
    rows("ph_church_a_01", "ph_church_a_05", "ph_church_a_15", "ph_church_a_17", "ph_church_a_19"),
    ref=[ans(kind="photo", linked_to="$ngozi_e, $church_a")]),
  T("star both harvest sunday ones", diff(upd("ph_church_a_01", starred=True), upd("ph_church_a_19", starred=True)),
    ref=[act("star", kind="photo", name="Harvest Sunday", within="@prev")]),
  T("any in the school album too", rows("ph_church_a_01"),
    ref=[ans(within="@1", linked_to="$school_a")]))

S("T34-069", "same-word-pick document ask pick star unstar usage-described-card ask",
  T("star the school fees receipt for 2025", ask("doc_34", "doc_35", "doc_36"),
    ref=[act("star", kind="document", name="School fees receipt 2025")]),
  T("ifeanyi's", diff(upd("doc_36", starred=True)),
    ref=[act("star", rows="$doc_36")]),
  T("and unstar chiamaka's 2026 one", diff(upd("doc_46", starred=False)),
    ref=[act("unstar", kind="document", name="School fees receipt Chiamaka 2026")]),
  T("and star the card i use at the shop", ask("zenith_card", "gtb_card"),
    ref=[act("star", kind="locker item", name="card")]))

S("T34-070", "same-word-pick event-vs-photo verb-decides-kind reschedule star when-year two-writes",
  T("push the anniversary to the 17th", diff(upd("shop_anniv", date="2027-07-17T11:00")),
    ref=[act("reschedule", kind="event", name="anniversary", args=lines(to=D("2027-07-17")))]),
  T("star the anniversary photo from last year", diff(upd("ph_shop_a_18", starred=True)),
    ref=[act("star", kind="photo", name="Anniversary", when=W(U("year", -1)))]),
  T("and cancel the bible study on the 7th and the pta meeting on the 8th",
    diff(upd("bs_270707", status="cancelled"), upd("pta_270708", status="cancelled")),
    ref=[act("cancel", kind="event", name="Bible study", when=W(D("2027-07-07")), more=True),
         act("cancel", kind="event", name="PTA meeting", when=W(D("2027-07-08")))]))

# ---- create-args ----------------------------------------------------------------------------------

S("T34-071", "create-args locker login username-label url type-implied-wifi inert-purpose star",
  T("add a login for starlink, user okaforhome",
    diff(new("locker item", name=has("starlink"), type="login", username="okaforhome")),
    ref=[act("create", kind="locker item", args=lines(name="Starlink", type="login", username="okaforhome"))]),
  T("and the wifi login for the new warehouse, for the cctv guys",
    diff(new("locker item", name=has("warehouse"), type="wifi")),
    ref=[act("create", kind="locker item", args=lines(name="Warehouse wifi", type="wifi"))]),
  T("and my mtn login, username obinna.okafor, site is mtn.ng",
    diff(new("locker item", name=has("mtn"), type="login", username="obinna.okafor", url="mtn.ng")),
    ref=[act("create", kind="locker item", args=lines(name="MTN", type="login", username="obinna.okafor", url="mtn.ng"))]),
  T("star the starlink one", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]))

S("T34-072", "create-args task-vs-event remind-me errand call-tradesperson appointment",
  T("remind me to call the plumber thursday, the tank is leaking agian",
    diff(new("task", name="Call the plumber", date="2027-06-24")),
    ref=[act("create", kind="task", args=lines(name="Call the plumber", date=U("week", 1, weekday=4)))]),
  T("and pick up the generator filter saturday",
    diff(new("task", name="Pick up the generator filter", date="2027-06-26")),
    ref=[act("create", kind="task", args=lines(name="Pick up the generator filter", date=U("week", 1, weekday=6)))]),
  T("book nkem's dentist for friday at 3",
    diff(new("event", name=has("dentist", "nkem"), date="2027-06-25T15:00")),
    ref=[act("create", kind="event", args=lines(name="Dentist - Nkem", date=U("week", 1, weekday=5, time="15:00")))]))

S("T34-073", "create-args person role nickname label-words log",
  T("new contact, name amaka obi, role caterer, nickname mama cake, for the anniversary",
    diff(new("person", name="Amaka Obi", role="caterer", nickname="Mama Cake")),
    ref=[act("create", kind="person", args=lines(name="Amaka Obi", role="caterer", nickname="Mama Cake"))]),
  T("she called me back, log that", diff(upd("+1", date=ANY)),
    ref=[act("log", rows="$c1", args="kind: call")]))

S("T34-074", "create-args debt inert-clause direction amount-suffix sum",
  T("i owe aunty uche 40k for airtime, i'll pay after the anniversary",
    diff(new("debt", name="airtime", amount=40000, direction="i_owe"), link("new", "aunty_uche")),
    ref=[act("create", kind="debt", args=lines(name="airtime", person="$aunty_uche", amount="40k", direction="i_owe"))]),
  T("my brother chidi owes me 15k for the generator diesel",
    diff(new("debt", name="generator diesel", amount=15000, direction="owes_me"), link("new", "chidi_o")),
    ref=[find(kind="person", name="Chidi", where='role = "brother"'),
         act("create", kind="debt", args=lines(name="generator diesel", person="$chidi_o", amount="15k", direction="owes_me"))]),
  T("so what is my total debt to aunty uche now", val((181900, "NGN")),
    ref=[ans(op="sum", field="amount", kind="debt", linked_to="$aunty_uche", where="direction = i_owe and status = open")]))

S("T34-075", "create-args album group inert-purpose task container-link list",
  T("start an album for nkem's second birthday, the family can add pictures",
    diff(new("album", name="Nkem's second birthday")),
    ref=[act("create", kind="album", args=lines(name="Nkem's second birthday"))]),
  T("and a group for the anniversary expenses, me emeka and chinwe splitting it",
    diff(new("group", name="Anniversary expenses"), link("new", "me")),
    ref=[act("create", kind="group", args=lines(name="Anniversary expenses"))]),
  T("new task for the church list, order banners for the dedication, due friday",
    diff(new("task", name="Order banners for the dedication", date="2027-06-25"), link("church_l", "new")),
    ref=[act("create", kind="task", args=lines(name="Order banners for the dedication", date=U("week", 1, weekday=5),
                                               list_="$church_l"))]))

# ---- verb-choice ----------------------------------------------------------------------------------

S("T34-076", "verb-choice put-back after remove_from and after a move add_to not restore documents folder",
  T("take the staff payroll summary 2026 out of the business folder", diff(unlink("business_f", "doc_43")),
    ref=[act("remove_from", kind="document", name="Staff payroll summary 2026", args=lines(from_="$business_f"))]),
  T("oops, put it back", diff(link("business_f", "doc_43")),
    ref=[act("add_to", rows="$doc_43", args=lines(to="$business_f"))]),
  T("move the cac annual returns 2026 to the to file folder", diff(link("tofile_f", "doc_44"), unlink("business_f", "doc_44")),
    ref=[act("add_to", kind="document", name="CAC annual returns 2026", args=lines(to="$tofile_f"))]),
  T("hmm, put it back", diff(link("business_f", "doc_44"), unlink("tofile_f", "doc_44")),
    ref=[act("add_to", rows="$doc_44", args=lines(to="$business_f"))]))

S("T34-077", "verb-choice put-back after delete restore not add_to contrast-with-076 document",
  T("delete the staff payroll summary 2026", diff(trash("doc_43")),
    ref=[act("delete", kind="document", name="Staff payroll summary 2026")]),
  T("oops, put it back", diff(restore("doc_43")),
    ref=[act("restore", rows="$doc_43")]))

S("T34-078", "verb-choice in-progress edit-status reschedule attribute-fragment effort subtasks",
  T("what's still open on the solar install", rows("solar_5", "solar_6", "solar_7"),
    ref=[ans(kind="task", linked_to="$solar", where="status = open")]),
  T("mark installation week as in progress", diff(upd("solar_5", status="in_progress")),
    ref=[act("edit", rows="$solar_5", args="status: in_progress")]),
  T("push the test to the 2nd of august", diff(upd("solar_6", date="2027-08-02")),
    ref=[act("reschedule", rows="$solar_6", args=lines(to=D("2027-08-02")))]),
  T("3 hours", diff(upd("solar_6", effort=180)),
    ref=[bad(act("edit", rows="$solar_6", args="effort: 3 hours")),
         act("edit", rows="$solar_6", args="effort: 180")]))

S("T34-079", "verb-choice reschedule make-it-hour no-wait-weekday not-undo bare-attribute edit-duration",
  T("move next friday's stocktake to wednesday", diff(upd("st_270625", date="2027-06-23T16:00")),
    ref=[act("reschedule", kind="event", name="stocktake", when=W(U("week", 1, weekday=5)), args=lines(to=U("week", 1, weekday=3)))]),
  T("make it 3", diff(upd("st_270625", date="2027-06-23T15:00")),
    ref=[act("reschedule", rows="$st_270625", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("no wait, thursday", diff(upd("st_270625", date="2027-06-24T15:00")),
    ref=[act("reschedule", rows="$st_270625", args=lines(to=U("week", 1, weekday=4)))]),
  T("and make it two hours", diff(upd("st_270625", duration=120)),
    ref=[act("edit", rows="$st_270625", args="duration: 120")]))

S("T34-080", "verb-choice block-time create add-one create log-idiom jot-down note",
  T("block 4 to 5 tomorrow for the generator man",
    diff(new("event", name=has("generator"), date="2027-06-21T16:00", duration=60)),
    ref=[act("create", kind="event", args=lines(name="Generator man", date=U("day", 1, time="16:00"), duration="60"))]),
  T("add one for thursday too",
    diff(new("event", name=has("generator"), date="2027-06-24T16:00", duration=60)),
    ref=[act("create", kind="event", args=lines(name="Generator man", date=U("week", 1, weekday=4, time="16:00"), duration="60"))]),
  T("just spoke to segun, he says he's coming monday", diff(upd("segun", date=ANY)),
    ref=[act("log", rows="$segun", args="kind: call")]),
  T("jot down that he wants half upfront", diff(new("note", body=has("half upfront"))),
    ref=[act("create", kind="note", args=lines(name="Generator man wants half upfront", body="he wants half upfront"))]))

# ---- stop-signals ---------------------------------------------------------------------------------

S("T34-081", "stop-signals miss write decoy-near-hit locker passport possessor composed-ask then recover star",
  T("star nkem's passport", ask("passport_o"),
    ref=[act("star", kind="locker item", name="Nkem's passport")]),
  T("ok star mine then", diff(upd("passport_o", starred=True)),
    ref=[act("star", rows="$passport_o")]))

S("T34-082", "stop-signals miss read decoy-near-hit event composed-answer, last-one read, dated-miss write composed-decline",
  T("when's the harvest party",
    decline("not_found"),
    rows("oo_038", "oo_074", "harvest_2026", "harvest_2024", "harvest_2023", "harvest_2025", "daddy_bday_2025", "daddy_bday_2027",
         "daddy_bday_2024", "daddy_bday_2026", "nkem_bday"),
    ref=[ans(kind="event", name="harvest party")]),
  T("when was the last harvest thanksgiving", rows("harvest_2026"),
    ref=[ans(kind="event", name="harvest thanksgiving", order="date desc", limit=1)]),
  T("cancel the bible study on the 14th", decline("not_found"),
    ref=[act("cancel", kind="event", name="Bible study", when=W(D("2027-07-14")))]))

S("T34-083", "stop-signals never_mind start-of-message after a read then normal write",
  T("what's open on the business list this week", rows("t_159", "cem_270620"),
    ref=[ans(kind="task", linked_to="$business_l", where="status = open", when=W(U("week", 0)))]),
  T("never mind the roofing sheets, i'll do it today", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("ok tick off the cement supplier one, paid it", diff(upd("cem_270620", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="cement supplier", where="status = open")]))

S("T34-084", "stop-signals never_mind by-name-delete missing-row end, retract-plus-ask answers, middle-of-message create",
  T("delete the cement quotation from last week no wait leave it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("forget the quotation, when's the next cement delivery", rows("sd_270621"),
    ref=[ans(kind="event", name="cement delivery", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("remind me to buy diesel tomorrow, actually never mind, segun is bringing it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T34-085", "stop-signals fyi-ask then jot-down note, unbounded-except, out_of_scope-not-not_found",
  T("segun says the generator needs a new filter", ask(),
    ref=[askc("What should i do with that, add a task or a note?")]),
  T("just jot it down", diff(new("note", body=has("filter"))),
    ref=[act("create", kind="note", args=lines(name="Generator needs a new filter", body="segun says the generator needs a new filter"))]),
  T("delete all the notes except the allergy info", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("how much is a bag of cement in lagos today", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

# ---- set-answers ----------------------------------------------------------------------------------

S("T34-086", "set-answers role-noun live-vs-trashed-namesake search pick log",
  T("who's my barber", rows("amaka_idowu"),
    ref=[search("barber", kind="person"), ans(rows="$amaka_idowu")]),
  T("just rang her, booked saturday", diff(upd("amaka_idowu", date=ANY)),
    ref=[act("log", rows="$amaka_idowu", args="kind: call")]))

S("T34-087", "set-answers role-exact in-law-namesake within group",
  T("who are my cousins",
    rows("nneka_salami", "efosa_aniekwe", "abubakar_usman", "chisom_onwuka", "chukwuemeka", "lanre_madu", "onyinye_okeke",
         "somto_ibekwe", "yetunde_ogunleye"),
    ref=[ans(kind="person", where='role = "cousin"')]),
  T("and the ones in the cousins group", rows("chukwuemeka", "chisom_onwuka", "onyinye_okeke"),
    ref=[ans(within="@prev", linked_to="$cousins")]))

S("T34-088", "set-answers debts direction owes_me i_owe one-meant year-arithmetic settle_debt",
  T("what hasn't dayo nwosu paid me back yet", rows("debt_12", "debt_40"),
    ref=[ans(kind="debt", linked_to="$dayo_nwosu", where="direction = owes_me and status = open")]),
  T("and my debts to him from two years ago", rows("debt_26"),
    ref=[ans(kind="debt", linked_to="$dayo_nwosu", where="direction = i_owe and status = open", when=W(U("year", -2)))]),
  T("i paid that one yesterday, settle it", diff(upd("debt_26", status="settled")),
    ref=[act("settle_debt", rows="$debt_26")]))

S("T34-089", "set-answers same-word events weekday-decides find then persons",
  T("who was at the meeting on thursday last week", rows("mrs_bakare", "principal"),
    ref=[find(kind="event", name="meeting", when=W(U("week", -1, weekday=4))),
         ans(kind="person", linked_to="$pta_270610")]),
  T("and the one on saturday last week", rows("tunde_b", "mr_odili"),
    ref=[find(kind="event", name="meeting", when=W(U("week", -1, weekday=6))),
         ans(kind="person", linked_to="$ra_270612")]))

S("T34-090", "set-answers superlative smallest find-then-act settle_debt order-limit within oldest same-first-name-gloss",
  T("what does bukola from the choir owe me", rows("debt_04", "debt_18", "debt_39"),
    ref=[find(kind="person", name="Bukola", where='role contains "choir"'),
         ans(kind="debt", linked_to="$bukola_danjuma", where="direction = owes_me and status = open")]),
  T("settle the smallest one, she paid", diff(upd("debt_39", status="settled")),
    ref=[find(kind="debt", within="@prev", order="amount asc", limit=1), act("settle_debt", rows="@prev")]),
  T("and the oldest of what's left", rows("debt_04"),
    ref=[ans(kind="debt", within="@2", where="status = open", order="date asc", limit=1)]))
