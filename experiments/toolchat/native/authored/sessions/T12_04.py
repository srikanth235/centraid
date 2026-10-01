from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T12-076", "seven turns week planning person count span cancel ambiguous context",
  T("what's on next week",
    rows("staff_0824", "noodle_trial", "lease_mtg", "dentist_hana", "pork_0827", "inspection", "yuki_bday",
         "swim_0829", "farm"),
    ref=[ans(kind="event", when=W(U("week", 1)))]),
  T("which of those have three or more people", rows("staff_0824", "farm"),
    ref=[ans(within="@prev", where="person count >= 3")]),
  T("and from thursday to the end of this week?",
    rows("pork_0820", "acct_aug", "dentist_me", "shun_coffee", "swim_0822", "call_0823"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=4), U("week", 0))))]),
  T("cancel the swim class on saturday, we're away", diff(upd("swim_0822", status="cancelled")),
    ref=[act("cancel", kind="event", name="swim class", when=W(U("week", 0, weekday=6)))]),
  T("and move the video call with takeshi to 9", diff(upd("call_0823", date="2026-08-23T21:00")),
    ref=[act("reschedule", kind="event", name="Video call with Takeshi",
             args=lines(to=U("day", 0, anchor="row", time="21:00"))),
         act("reschedule", rows="$call_0823", args=lines(to=U("day", 0, anchor="row", time="21:00")))]),
  T("rest of august from next monday",
    rows("staff_0824", "noodle_trial", "lease_mtg", "dentist_hana", "pork_0827", "inspection", "yuki_bday",
         "swim_0829", "farm", "boiler_fix"),
    ref=[ans(kind="event", when=W(span(U("week", 1), U("month", 0, name=8))))]),
  T("any of those cancelled", rows("swim_0829"),
    ref=[ans(within="@prev", where='status = "cancelled"')]))

S("T12-077", "five turns documents span rename unstar where trashed restore window",
  T("docs from july up to the fifth of august", rows("ito_inv", "menu_aug", "nishi_inv", "fujita_inv"),
    ref=[ans(kind="document", when=W(span(U("month", 0, name=7), D("2026-08-05"))))]),
  T("rename Ito miso invoice June to Ito invoice June", diff(upd("ito_inv", name="Ito invoice June")),
    ref=[act("edit", rows="$ito_inv", args=lines(name="Ito invoice June"))]),
  T("unstar the starred doc from this month", diff(upd("menu_aug", starred=False)),
    ref=[act("unstar", kind="document", when=W(U("month", 0)), where="starred = yes")]),
  T("did i delete the old lease 2020", rows("old_lease"),
    ref=[ans(kind="document", name="Old lease 2020"),
         ans(kind="document", name="Old lease 2020", trashed=True)]),
  T("restore it, okada wants the old terms", ask(),
    ref=[bad(act("restore", rows="$old_lease")),
         askc("it went in the bin in june, past the 30-day window, so it can't come back. want a new doc for it?")]))

S("T12-078", "six turns count photos spans star read album",
  T("hana's swim class, how many are left", val(2),
    ref=[ans(op="count", kind="event", name="swim class", when=W({"from": U("day", 0)}), where='status = "tentative"')]),
  T("who's in more than three things in my calendar", rows("daisuke", "aiko", "ryo_t", "fujita", "hana", "takeshi", "yuki"),
    ref=[ans(kind="person", where="event count > 3")]),
  T("photos of hana from fourteenth aug onwards", rows("hana_osaka"),
    ref=[ans(kind="photo", linked_to="$hana", when=W({"from": D("2026-08-14")}))]),
  T("all photos from fourteenth aug 6pm till today", rows("dotonbori", "grave", "kamukura", "boiler_p", "corn_p"),
    ref=[ans(kind="photo", when=W(span(D("2026-08-14", "18:00"), U("day", 0))))]),
  T("star dotonbori at night", diff(upd("dotonbori", starred=True)),
    ref=[act("star", rows="$dotonbori")]),
  T("what's in the osaka album", rows("castle", "hana_osaka", "dotonbori", "grave", "kamukura"),
    ref=[ans(kind="photo", linked_to="$osaka_album")]))

S("T12-079", "status in trashed event recovery restore people",
  T("which august events got confirmed or called off", rows("koji_bbq", "swim_0829"),
    ref=[ans(kind="event", when=W(U("month", 0)), where='status in ("confirmed", "cancelled")')]),
  T("didn't i have a menu tasting night on saturday", rows("tasting_night"),
    ref=[ans(kind="event", name="Menu tasting night"),
         ans(kind="event", name="Menu tasting night", trashed=True)]),
  T("put it back, we're doing it after all", diff(restore("tasting_night")),
    ref=[act("restore", rows="$tasting_night")]),
  T("who was on it", rows("daisuke", "shun"),
    ref=[ans(kind="person", linked_to="$tasting_night")]))

S("T12-080", "complete task where when log where role",
  T("called mom already, tick off tomorrow's task", diff(upd("call_mom", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", when=W(U("day", 1)))]),
  T("anything else on for this week", rows("gas_aug", "kombu_aug", "aircon", "nursery_photo", "shoes"),
    ref=[ans(kind="task", when=W(U("week", 0)), where='status = "open"')]),
  T("log that call with mom", diff(upd("fumiko", date=ANY)),
    ref=[act("log", kind="person", where='role contains "mother"', args=lines(kind="call"))]))

S("T12-081", "note count supplier role linked",
  T("which suppliers have i got notes on", rows("nishiyama", "fujita", "ogawa"),
    ref=[find(kind="person", where='note count > 0 and role contains "supplier"'), ans(rows="@prev")]),
  T("and more than one?", rows("nishiyama"),
    ref=[ans(kind="person", where='note count > 1 and role contains "supplier"')]),
  T("what are they", rows("noodle_specs", "idea_tsuke"),
    ref=[ans(kind="note", linked_to="$nishiyama")]))

S("T12-082", "photo open span person count star",
  T("old photos, anything from last year or before",
    rows("opening", "wedding", "farm_p", "fest25_stall", "fest25_crowd", "hana_bday2", "hana_snow"),
    ref=[find(kind="photo", when=W({"to": U("year", -1)})), ans(rows="@prev")]),
  T("which have more than one person in them", rows("fest25_stall", "hana_bday2"),
    ref=[ans(within="@prev", where="person count > 1")]),
  T("star the festival stall one", diff(upd("fest25_stall", starred=True)),
    ref=[act("star", rows="$fest25_stall")]))

S("T12-083", "list read remove_from task multi count",
  T("what's on the seasonal menu list", rows("hiyashi", "corn", "winter_miso", "autumn_menu", "hiyashi_end", "fest_task"),
    ref=[find(kind="task", linked_to="$seasonal_l"), ans(rows="@prev")]),
  T("take the two hiyashi ones off, summer's basically over",
    diff(unlink("seasonal_l", "hiyashi"), unlink("seasonal_l", "hiyashi_end")),
    ref=[act("remove_from", rows="$hiyashi, $hiyashi_end", args=lines(from_="$seasonal_l"))]),
  T("how many left on it", val(4),
    ref=[ans(op="count", kind="task", linked_to="$seasonal_l")]))

S("T12-084", "debt amount gte within order limit",
  T("anything 5000 or more that i owe", rows("d_shun", "d_fujita", "d_emi", "d_kenta"),
    ref=[find(kind="debt", where='amount >= 5000 and direction = "i_owe" and status = "open"'), ans(rows="@prev")]),
  T("what's the smallest of those", rows("d_kenta"),
    ref=[ans(within="@prev", order="amount asc", limit=1)]))

S("T12-085", "unstar document where linked read",
  T("unstar the starred one in the insurance folder", diff(upd("shop_ins", starred=False)),
    ref=[act("unstar", kind="document", linked_to="$insurance_f", where="starred = yes")]),
  T("what's in insurance anyway", rows("shop_ins", "car_ins"),
    ref=[ans(kind="document", linked_to="$insurance_f")]))

S("T12-086", "currency neq delete group refused ask never mind",
  T("which groups use something other than yen", rows("seoul"),
    ref=[ans(kind="group", where='currency != "JPY"')]),
  T("delete the year-end party group, we're doing it at the shop",
    diff(gone("yearend"), unlink("yearend", "daisuke"), unlink("yearend", "aiko"), unlink("yearend", "mei"),
         unlink("yearend", "me")),
    ref=[act("delete", rows="$yearend")]),
  T("and the seoul one", ask(),
    ref=[bad(act("delete", rows="$seoul")),
         askc("seoul ramyeon tour still has expenses in it, so it can't be deleted. settle up with them first?")]),
  T("no leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T12-087", "repair duration hours month name delete",
  T("anything two hours or longer in september", rows("fest_setup", "fest", "expo"),
    ref=[bad(ans(kind="event", when=W(U("month", 0, name=9)), where="duration >= 2 hours")),
         ans(kind="event", when=W(U("month", 0, name=9)), where="duration >= 120 minutes")]),
  T("delete the expo one, it got cancelled", diff(trash("expo")),
    ref=[act("delete", rows="$expo")]))

S("T12-088", "create document add_to new read star",
  T("save a doc: Hana nursery acceptance letter, in the hana folder",
    diff(new("document", name="Hana nursery acceptance letter"), link("hana_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Hana nursery acceptance letter"), more=True),
         act("add_to", rows="$new", args=lines(to="$hana_f"))]),
  T("what's in the hana folder", rows("hana_ins", "hana_vax", "nursery_doc", "+1"),
    ref=[ans(kind="document", linked_to="$hana_f")]),
  T("star the new one", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]))

S("T12-089", "event person count gte next month linked",
  T("events next month with three or more people", rows("staff_0907", "fest"),
    ref=[find(kind="event", when=W(U("month", 1)), where="person count >= 3"), ans(rows="@prev")]),
  T("who's on the sapporo autumn fest stall", rows("daisuke", "aiko", "mei"),
    ref=[ans(kind="person", linked_to="$fest")]))

S("T12-090", "star photo where linked starred person count",
  T("star the pic with haruto in it", diff(upd("lanterns", starred=True)),
    ref=[act("star", kind="photo", linked_to="$haruto")]),
  T("which starred pics have nobody in them", rows("shop_front", "hiyashi_p"),
    ref=[ans(kind="photo", where="starred = yes and person count = 0")]))

S("T12-091", "task date span effort lte complete named",
  T("tasks due between the twenty-fourth and the twenty-sixth",
    rows("blog", "shifts", "temp_log", "nursery_form", "lease_t", "rent_08", "fire_ext", "hood"),
    ref=[ans(kind="task", when=W(span(D("2026-08-24"), D("2026-08-26"))))]),
  T("which take half an hour or less", rows("temp_log", "rent_08", "fire_ext"),
    ref=[ans(within="@prev", where="effort <= 30 minutes")]),
  T("tick off the fridge temperature logs, printed them", diff(upd("temp_log", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="fridge temperature logs")]))

S("T12-092", "add_to photo where linked count",
  T("put the pic with kazuo endo in menu shots, it's for the corn ramen", diff(link("menu_album", "farm_p")),
    ref=[act("add_to", kind="photo", linked_to="$endo", args=lines(to="$menu_album"))]),
  T("how many in menu shots", val(5),
    ref=[ans(op="count", kind="photo", linked_to="$menu_album")]))

S("T12-093", "completed empty open span reschedule named",
  T("what's not done yet that was due by the twentieth", rows("receipts", "call_mom", "boiler", "gas_aug"),
    ref=[ans(kind="task", where='completed is empty and status != "cancelled"', when=W({"to": D("2026-08-20")}))]),
  T("push the receipts one to friday", diff(upd("receipts", date="2026-08-21")),
    ref=[act("reschedule", kind="task", name="receipts", args=lines(to=U("week", 0, weekday=5)))]),
  T("and the boiler to the thirty-first", diff(upd("boiler", date="2026-08-31")),
    ref=[act("reschedule", rows="$boiler", args=lines(to=D("2026-08-31")))]))

S("T12-094", "create locker edit new type read",
  T("add a locker entry: Delivery tablet PIN, it's a password", diff(new("locker item", name="Delivery tablet PIN")),
    ref=[act("create", args=lines(kind="locker item", name="Delivery tablet PIN", type="password"))]),
  T("note on it: tablet lives by the register", ask(),
    ref=[bad(act("edit", rows="$c1", args=lines(notes="tablet lives by the register"))),
         askc("password entries can't hold notes. put it in the name instead, like Delivery tablet PIN (register)?")]),
  T("yeah do that", diff(upd("+1", name="Delivery tablet PIN (register)")),
    ref=[act("edit", rows="$c1", args=lines(name="Delivery tablet PIN (register)"))]),
  T("what password type entries have i got", rows("office_pc", "+1"),
    ref=[ans(kind="locker item", where='type = "password"')]))

S("T12-095", "task month name span task count within",
  T("tasks due in september or october",
    rows("fest_bowls", "nursery", "menu_photos", "fest_gas", "menu_print", "fest_task", "noren", "autumn_menu",
         "shaken", "shop_ins_t", "permit_t", "flu_shot", "winter_miso", "snow_tires"),
    ref=[find(kind="task", when=W(span(U("month", 0, name=9), U("month", 0, name=10)))), ans(rows="@prev")]),
  T("the ones with subtasks", rows("autumn_menu", "fest_task", "nursery"),
    ref=[ans(within="@prev", where="task count > 0")]))

S("T12-096", "unstar locker where url set find-only star",
  T("unstar the costco membership", diff(upd("costco", starred=False)),
    ref=[act("unstar", kind="locker item", where='type = "membership" and starred = yes')]),
  T("which locker items have a url but aren't starred", rows("tabelog", "gmail"),
    ref=[find(kind="locker item", where="url is set and starred = no"), ans(rows="@prev")]),
  T("star gmail", diff(upd("gmail", starred=True)),
    ref=[act("star", rows="$gmail")]))

S("T12-097", "trashed note body contains restore window ask never mind",
  T("did i delete a note about the reopening", rows("flyer_draft"),
    ref=[ans(kind="note", where='body contains "reopening"', trashed=True)]),
  T("get it back", ask(),
    ref=[bad(act("restore", rows="$flyer_draft")),
         askc("it's been in the bin since june, past the 30-day window, so it can't be restored. want me to start a new note?")]),
  T("nah forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T12-098", "edit notebook named read delete",
  T("rename the accounts notebook to Accounts 2026", diff(upd("accounts_nb", name="Accounts 2026")),
    ref=[act("edit", rows="$accounts_nb", args=lines(name="Accounts 2026"))]),
  T("what's in it", rows("acct_july", "acct_tax"),
    ref=[ans(kind="note", linked_to="$accounts_nb")]),
  T("delete the july takings one, it's in the spreadsheet", diff(trash("acct_july")),
    ref=[act("delete", rows="$acct_july")]))

S("T12-099", "folder document count gte find-only delete folder where",
  T("which folders have at least two docs", rows("permits_f", "tax_f", "lease_f", "invoices_f", "hana_f", "insurance_f"),
    ref=[find(kind="folder", where="document count >= 2"), ans(rows="@prev")]),
  T("any with none in?", rows("oldmenus_f"),
    ref=[find(kind="folder", where="document count = 0"), ans(rows="@prev")]),
  T("delete that one", diff(gone("oldmenus_f")),
    ref=[act("delete", kind="folder", where="document count = 0")]))

S("T12-100", "five turns list count linked ambiguous locker ask reveal",
  T("which lists have exactly four tasks", rows("hana_l"),
    ref=[ans(kind="list", where="task count = 4")]),
  T("what's on it", rows("nursery", "shoes", "flu_shot", "hana_bday"),
    ref=[ans(kind="task", linked_to="$hana_l")]),
  T("what's the shop password", ask("pos", "safe", "wifi_shop", "reg_copy"),
    ref=[act("reveal", kind="locker item", name="Shop", args=lines(field="password")),
         askc("which one: the pos login, the safe, the shop wifi or the registration copy?",
              options="$pos, $safe, $wifi_shop, $reg_copy")]),
  T("the pos login", diff(reveal=[("pos", "Miso-Butter-88")]),
    ref=[act("reveal", rows="$pos", args=lines(field="password"))]),
  T("and the jcb card number", diff(reveal=[("jcb", "3540 1122 3344 5566")]),
    ref=[act("reveal", kind="locker item", name="JCB", args=lines(field="card_number"))]))


# ---- follow-up turns: ambiguity, recoveries, date spans, write+read, longer sessions ----

X("T12-001",
  T("log a call with ryo", ask("ryo_t", "ryo_i"),
    ref=[act("log", kind="person", name="Ryo", args=lines(kind="call")),
         askc("ryo tanaka or ryo ishida?", options="$ryo_t, $ryo_i")]),
  T("tanaka", diff(upd("ryo_t", date=ANY)),
    ref=[act("log", rows="$ryo_t", args=lines(kind="call"))]),
  T("who've i been in touch with from fourteenth aug noon to the end of august",
    rows("emi", "takeshi", "aiko", "ryo_t", "kenta_s", "daisuke", "yuki"),
    ref=[ans(kind="person", when=W(span(D("2026-08-14", "12:00"), U("month", 0, name=8))))]))

X("T12-005",
  T("what's due from tomorrow to sunday", rows("call_mom", "boiler", "gas_aug", "kombu_aug", "aircon", "nursery_photo", "shoes"),
    ref=[ans(kind="task", when=W(span(D("2026-08-19"), U("week", 0, weekday=7))))]),
  T("any of those priority one", rows("boiler"),
    ref=[ans(within="@prev", where="priority = 1")]),
  T("how long's that one meant to take", val(90),
    ref=[ans(op="sum", field="effort", rows="$boiler")]))

X("T12-014",
  T("move the farm visit in furano an hour later", diff(upd("farm", date="2026-08-30T09:00")),
    ref=[act("reschedule", rows="$farm", args=lines(to=U("hour", 1, anchor="row")))]),
  T("any photos with kazuo endo", rows("farm_p"),
    ref=[ans(kind="photo", linked_to="$endo")]),
  T("and when's the corn order due", rows("corn"),
    ref=[ans(kind="task", name="corn")]))

X("T12-016",
  T("and move the staff meeting to 11", ask(),
    ref=[act("reschedule", kind="event", name="Staff meeting", args=lines(to=U("day", 0, anchor="row", time="11:00"))),
         askc("which staff meeting, next monday's?")]),
  T("yeah next monday", diff(upd("staff_0824", date="2026-08-24T11:00")),
    ref=[act("reschedule", kind="event", name="Staff meeting", when=W(U("week", 1, weekday=1)),
             args=lines(to=U("day", 0, anchor="row", time="11:00")))]),
  T("what's on next monday", rows("staff_0824", "noodle_trial"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=1)))]))

X("T12-019",
  T("how many times have i paid the shop rent this year", val(7),
    ref=[ans(op="count", kind="task", name="Pay shop rent", where='status = "completed"', when=W(U("year", 0)))]),
  T("tick off august's too", diff(upd("rent_08", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay shop rent", when=W(U("month", 0)))]))

X("T12-044",
  T("notes from the start of last month till tenth aug 8pm",
    rows("acct_tax", "idea_corn", "hana_words", "fujita_prices", "acct_july", "idea_kids"),
    ref=[ans(kind="note", when=W(span(U("month", -1), D("2026-08-10", "20:00"))))]),
  T("any notes about koji nakamura", rows(),
    ref=[ans(kind="note", linked_to="$koji")]),
  T("is the concert tickets debt with him settled", rows("d_koji"),
    ref=[ans(kind="debt", name="Concert tickets")]))

X("T12-047",
  T("who was i in touch with from first june to the end of june", rows("endo", "koji", "minjun"),
    ref=[ans(kind="person", when=W(span(D("2026-06-01"), U("month", 0, name=6))))]),
  T("and on the seventeenth", rows("aiko", "ryo_t", "kenta_s"),
    ref=[ans(kind="person", when=W(D("2026-08-17")))]))

X("T12-052",
  T("how many staff meetings from third aug on, by status", vgroups({"tentative": 5}),
    ref=[comp(op="count", kind="event", name="Staff meeting", when=W({"from": D("2026-08-03")}), group="status"),
         ans(value="@prev")]),
  T("and pork deliveries in august", vgroups({"tentative": 3}),
    ref=[comp(op="count", kind="event", name="Pork delivery", when=W(U("month", 0, name=8)), group="status"),
         ans(value="@prev")]))

X("T12-060",
  T("debts from the start of this month to last sunday",
    rows("d_aiko", "d_haruto", "d_takeshi", "d_fujita", "d_emi", "d_ryo_i"),
    ref=[ans(kind="debt", when=W(span(U("month", 0), U("week", -1, weekday=7))))]),
  T("which ones do i owe", rows("d_aiko", "d_haruto", "d_fujita", "d_emi"),
    ref=[ans(within="@prev", where='direction = "i_owe"')]))

X("T12-066",
  T("what's due from twenty-seventh aug to next sunday", rows("insp_prep", "gift_yuki", "corn", "nursery_cert"),
    ref=[ans(kind="task", when=W(span(D("2026-08-27"), U("week", 1, weekday=7))))]),
  T("move buy yuki's birthday present to the twenty-sixth", diff(upd("gift_yuki", date="2026-08-26")),
    ref=[act("reschedule", rows="$gift_yuki", args=lines(to=D("2026-08-26")))]))

X("T12-073",
  T("anything open on the shop list due by the twenty-second", rows("kombu_aug"),
    ref=[ans(kind="task", linked_to="$shop_l", when=W({"to": D("2026-08-22")}), where='status = "open"')]),
  T("tick it off", diff(upd("kombu_aug", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]))

X("T12-079",
  T("anything saved about karaoke night", decline("not_found"),
    ref=[search("karaoke"), dec("not_found")]),
  T("what's happening with the ramen expo", rows("expo"),
    ref=[ans(kind="event", name="Ramen expo")]))

X("T12-081",
  T("which notebook has both the nishiyama noodle specs and the fujita price list", rows("supplier_nb"),
    ref=[ans(kind="notebook", linked_to="$noodle_specs, $fujita_prices")]),
  T("rename it Suppliers", diff(upd("supplier_nb", name="Suppliers")),
    ref=[act("edit", rows="$supplier_nb", args=lines(name="Suppliers"))]))

X("T12-083",
  T("who's at both the staff bbq and the sapporo autumn fest stall", rows("daisuke", "aiko", "mei"),
    ref=[ans(kind="person", linked_to="$staff_bbq, $fest")]),
  T("who's tagged in the staff bbq group shot", rows("daisuke", "aiko", "ryo_t", "ryo_i", "mei"),
    ref=[ans(kind="person", linked_to="$bbq_p")]))

X("T12-089",
  T("anything taken before this year",
    rows("opening", "wedding", "farm_p", "fest25_stall", "fest25_crowd", "hana_bday2", "hana_snow"),
    ref=[ans(kind="photo", when=W({"to": U("year", -1)}))]),
  T("how many is that", val(7),
    ref=[ans(op="count", within="@prev")]))

X("T12-091",
  T("docs from monday two weeks ago through august",
    rows("nishi_inv", "fujita_inv", "nursery_doc", "lease_draft", "july_receipts", "stall_permit"),
    ref=[ans(kind="document", when=W(span(U("week", -2, weekday=1), U("month", 0, name=8))))]),
  T("the one from last wednesday at 3pm, what is it", rows("lease_draft"),
    ref=[ans(kind="document", when=W(U("week", -1, weekday=3, time="15:00")))]))

X("T12-093",
  T("docs from july to the tenth", rows("ito_inv", "menu_aug", "nishi_inv", "fujita_inv", "nursery_doc"),
    ref=[ans(kind="document", when=W(span(U("month", 0, name=7), D("2026-08-10"))))]),
  T("what did i scan yesterday at 9am", rows("stall_permit"),
    ref=[ans(kind="document", when=W(U("day", -1, time="09:00")))]))

X("T12-098",
  T("notes from the start of last month to aug fifth", rows("idea_corn", "acct_tax", "hana_words", "fujita_prices", "idea_kids"),
    ref=[ans(kind="note", when=W(span(U("month", -1), D("2026-08-05"))))]),
  T("and from last week up to thursday 9pm", rows("idea_tsuke", "osaka_note"),
    ref=[ans(kind="note", when=W(span(U("week", -1), D("2026-08-13", "21:00"))))]))

X("T12-064",
  T("anything i owe from this month up to last sunday", rows("d_aiko", "d_haruto", "d_emi"),
    ref=[ans(kind="debt", when=W(span(U("month", 0), U("week", -1, weekday=7))),
             where='direction = "i_owe" and status = "open"')]))

X("T12-074",
  T("and the one from the thirteenth at 8am", rows("d_fujita"),
    ref=[ans(kind="debt", when=W(D("2026-08-13", "08:00")))]))

X("T12-072",
  T("and which are under watanabe_ramen or kenji_w", rows("pos"),
    ref=[ans(kind="locker item", where='username in ("watanabe_ramen", "kenji_w")')]))

X("T12-042",
  T("how many docs are starred vs not", vgroups({"yes": 6, "no": 11}),
    ref=[comp(op="count", kind="document", group="starred"), ans(value="@prev")]))

X("T12-028",
  T("is the old lease 2020 in the trash", rows("old_lease"),
    ref=[ans(kind="document", name="Old lease 2020", trashed=True)]),
  T("restore it", ask(),
    ref=[bad(act("restore", rows="$old_lease")),
         askc("it's been in the bin since june, past the 30-day window, so it can't come back. keep it there?")]))

X("T12-045",
  T("which contacts did i last speak to before this month",
    rows("nishiyama", "endo", "ogawa", "ito", "hayashi_t", "kimura", "okada", "koji", "minjun"),
    ref=[ans(kind="person", when=W({"to": U("month", -1)}))]),
  T("just the suppliers", rows("nishiyama", "ogawa", "ito"),
    ref=[ans(within="@prev", where='role contains "supplier"')]))

X("T12-062",
  T("from next week to the end of september, anything with three or more people",
    rows("staff_0824", "farm", "staff_0907", "fest"),
    ref=[ans(kind="event", when=W(span(U("week", 1), U("month", 0, name=9))), where="person count >= 3")]),
  T("who's going on the farm visit", rows("endo", "yuki", "hana"),
    ref=[ans(kind="person", linked_to="$farm")]))

X("T12-075",
  T("what's on from wednesday next week to the end of next week",
    rows("dentist_hana", "pork_0827", "inspection", "yuki_bday", "swim_0829", "farm"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=3), U("week", 1))))]),
  T("move yuki's birthday dinner to 7:30", diff(upd("yuki_bday", date="2026-08-28T19:30")),
    ref=[act("reschedule", rows="$yuki_bday", args=lines(to=U("day", 0, anchor="row", time="19:30")))]))

X("T12-080",
  T("what's due 1 to tenth september", rows("fest_bowls", "nursery", "menu_photos", "fest_gas", "menu_print"),
    ref=[ans(kind="task", when=W(span(D("2026-09-01"), D("2026-09-10"))))]),
  T("move shoot photos for autumn menu to the third", diff(upd("menu_photos", date="2026-09-03")),
    ref=[act("reschedule", rows="$menu_photos", args=lines(to=D("2026-09-03")))]))

X("T12-059",
  T("and what's due june through july", rows("hiyashi", "rent_06", "kombu_jul", "machine", "gas_jul", "rent_07", "rice_cooker"),
    ref=[ans(kind="task", when=W(span(U("month", 0, name=6), U("month", 0, name=7))))]))

X("T12-065",
  T("photos from first aug on",
    rows("hana_pool", "queue_p", "tsuke_p", "castle", "hana_osaka", "dotonbori", "grave", "kamukura", "boiler_p", "corn_p"),
    ref=[ans(kind="photo", when=W({"from": D("2026-08-01")}))]))

X("T12-082",
  T("and from fifteenth aug 10am till yesterday", rows("kamukura", "boiler_p", "corn_p"),
    ref=[ans(kind="photo", when=W(span(D("2026-08-15", "10:00"), U("day", -1))))]))

X("T12-034",
  T("debts from last monday to today", rows("d_aiko", "d_haruto", "d_takeshi", "d_fujita", "d_emi", "d_mei", "d_kenta"),
    ref=[ans(kind="debt", when=W(span(U("week", -1, weekday=1), U("day", 0))))]))

X("T12-048",
  T("add sato to the year-end party group", ask("aiko", "kenta_s"),
    ref=[act("add_to", kind="person", name="Sato", args=lines(to="$yearend")),
         askc("aiko sato or kenta sato the plumber?", options="$aiko, $kenta_s")]),
  T("the plumber", diff(link("yearend", "kenta_s")),
    ref=[act("add_to", rows="$kenta_s", args=lines(to="$yearend"))]))

X("T12-069",
  T("log a message from hayashi", ask("hayashi_t", "hayashi_m"),
    ref=[act("log", kind="person", name="Hayashi", args=lines(kind="message")),
         askc("tomoko the beer rep or mariko from playgroup?", options="$hayashi_t, $hayashi_m")]))

X("T12-085",
  T("cancel the pork delivery, fujita's on holiday", ask(),
    ref=[act("cancel", kind="event", name="Pork delivery from Fujita"),
         askc("which week's delivery?")]))

X("T12-092",
  T("move the accountant meeting to 3", ask("acct_may", "acct_aug"),
    ref=[act("reschedule", kind="event", name="Accountant meeting", args=lines(to=U("day", 0, anchor="row", time="15:00"))),
         askc("thursday's one, or the may one?", options="$acct_aug, $acct_may")]))

X("T12-032",
  T("junichi, next time i'm seeing him?", rows("kombu_tasting"),
    ref=[find(kind="person", name="Junichi"),
         search("junichi", kind="person"),
         ans(kind="event", linked_to="$ogawa", when=W({"from": U("day", 0)}))]))

X("T12-038",
  T("what's mei-chan's role again", rows("mei"),
    ref=[ans(kind="person", name="Mei-chan"),
         search("Mei-chan", kind="person"),
         ans(rows="$mei")]))

X("T12-096",
  T("is the old tabelog login around", rows("old_tabelog"),
    ref=[ans(kind="locker item", name="Old Tabelog login"),
         ans(kind="locker item", name="Old Tabelog login", trashed=True)]),
  T("restore it", diff(restore("old_tabelog")),
    ref=[act("restore", rows="$old_tabelog")]),
  T("undo, leave it deleted", diff(trash("old_tabelog")),
    ref=[act("undo")]))

X("T12-024",
  T("whatever happened to sell old delivery bike", rows("old_bike"),
    ref=[ans(kind="task", name="Sell old delivery bike"),
         ans(kind="task", name="Sell old delivery bike", trashed=True)]))

X("T12-017",
  T("last time i spoke with taka?", rows("shun"),
    ref=[ans(kind="person", name="Taka"),
         search("Taka", kind="person"),
         ans(rows="$shun")]))

X("T12-009",
  T("tick off buy new shoes for hana and tell me what's left on her list",
    rows("nursery", "flu_shot", "hana_bday", also=diff(upd("shoes", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Buy new shoes for Hana", more=True),
         ans(kind="task", linked_to="$hana_l", where='status = "open"')]))

X("T12-035",
  T("settle the kobe beef gift too and tell me where i am with emi",
    val((-3000, "JPY"), also=diff(upd("d_emi", status="settled"))),
    ref=[act("settle_debt", kind="debt", name="Kobe beef gift", more=True),
         ans(op="balance", rows="$emi")]))

X("T12-053",
  T("did the kombu order too, what's open this week",
    rows("call_mom", "aircon", "nursery_photo", "shoes", also=diff(upd("kombu_aug", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Order kombu from Rishiri", where='status = "open"', more=True),
         ans(kind="task", when=W(U("week", 0)), where='status = "open"')]))

X("T12-037",
  T("which logins have username watanabe_ramen or kenji.ramen@gmail.com", rows("pos", "tabelog", "gmail", "+1"),
    ref=[ans(kind="locker item", where='username in ("watanabe_ramen", "kenji.ramen@gmail.com")')]))

X("T12-020",
  T("who did i talk to from first july 9am through july", rows("ito", "kimura", "hayashi_t", "nishiyama"),
    ref=[ans(kind="person", when=W(span(D("2026-07-01", "09:00"), U("month", 0, name=7))))]))

X("T12-012",
  T("hmm undo that, he's not coming back after all", diff(trash("+1")),
    ref=[act("undo")]))

X("T12-091",
  T("checked the fire extinguishers and cleaned the hood as well, log a call with the inspector and tell me what's left under prepare for health inspection",
    rows(also=diff(upd("fire_ext", status="completed", completed=ANY), upd("hood", status="completed", completed=ANY),
                   upd("yoshida", date=ANY))),
    ref=[act("complete", kind="task", name="Check fire extinguishers", more=True),
         act("complete", kind="task", name="Deep clean the exhaust hood", more=True),
         act("log", kind="person", where='role = "health inspector"', args=lines(kind="call"), more=True),
         ans(kind="task", linked_to="$insp_prep", where='status = "open"')]))

X("T12-084",
  T("and the biggest open one each way, owed to me and owing", vgroups({"owes_me": (32000, "JPY"), "i_owe": (16500, "JPY")}),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"', group="direction"), ans(value="@prev")]))

X("T12-068",
  T("smallest open one each way?", vgroups({"owes_me": (5000, "JPY"), "i_owe": (2800, "JPY")}),
    ref=[comp(op="min", field="amount", kind="debt", where='status = "open"', group="direction"), ans(value="@prev")]))
