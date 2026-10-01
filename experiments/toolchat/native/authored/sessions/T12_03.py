from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T12-051", "five turns debt named balance photos within star prev",
  T("obon flight share, has takeshi paid me back yet", rows("d_takeshi"),
    ref=[ans(kind="debt", name="Obon flight share")]),
  T("what's my balance with him", val((30500, "JPY")),
    ref=[ans(op="balance", rows="$takeshi")]),
  T("pics with him in them", rows("hana_osaka", "grave", "kamukura"),
    ref=[ans(kind="photo", linked_to="$takeshi")]),
  T("which of those have yuki too", rows("grave"),
    ref=[ans(within="@prev", linked_to="$yuki")]),
  T("star it", diff(upd("grave", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T12-052", "subtasks task count ambiguous event ask reschedule",
  T("what's under prepare for health inspection", rows("fire_ext", "hood", "temp_log"),
    ref=[ans(kind="task", linked_to="$insp_prep")]),
  T("which tasks have more than 2 subtasks", rows("insp_prep", "autumn_menu", "fest_task", "nursery"),
    ref=[ans(kind="task", where="task count > 2")]),
  T("move the health inspection to 3pm", ask("inspection", "reinspection"),
    ref=[act("reschedule", kind="event", name="Health inspection", args=lines(to=U("day", 0, anchor="row", time="15:00"))),
         askc("the inspection on the 27th or the follow-up on 10 september?", options="$inspection, $reinspection")]),
  T("twenty-seventh", diff(upd("inspection", date="2026-08-27T15:00")),
    ref=[act("reschedule", rows="$inspection", args=lines(to=U("day", 0, anchor="row", time="15:00")))]))

S("T12-053", "effort lte within week ambiguous resolved by context",
  T("what open stuff takes twenty mins or less",
    rows("call_mom", "gas_aug", "kombu_aug", "nursery_photo", "temp_log", "fire_ext", "corn", "hiyashi_end",
         "fest_bowls", "rent_08"),
    ref=[ans(kind="task", where='effort <= 20 minutes and status = "open"')]),
  T("which of them fall this week", rows("call_mom", "gas_aug", "kombu_aug", "nursery_photo"),
    ref=[ans(within="@prev", when=W(U("week", 0)))]),
  T("paid the gas bill, tick it", diff(upd("gas_aug", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay gas bill"),
         act("complete", rows="$gas_aug")]))

S("T12-054", "document date spans weekday time star",
  T("what docs came in from monday last week to the end of this month",
    rows("nursery_doc", "lease_draft", "july_receipts", "stall_permit"),
    ref=[ans(kind="document", when=W(span(U("week", -1, weekday=1), U("month", 0, name=8))))]),
  T("the one from last friday at half 10, what is it", rows("july_receipts"),
    ref=[ans(kind="document", when=W(U("week", -1, weekday=5, time="10:30")))]),
  T("star that", diff(upd("july_receipts", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("and what did i add yesterday at 9", rows("stall_permit"),
    ref=[ans(kind="document", when=W(U("day", -1, time="09:00")))]))

S("T12-055", "single delete person multi named",
  T("delete kenta sato and akira yoshida, done with both", diff(trash("kenta_s"), trash("yoshida")),
    ref=[act("delete", rows="$kenta_s, $yoshida")]))

S("T12-056", "five turns people linked all create note add_to new read",
  T("nursery open day tomorrow, who's going", rows("suzuki", "hana", "yuki"),
    ref=[ans(kind="person", linked_to="$open_day")]),
  T("and to hana's checkup?", rows("yamada", "hana", "yuki"),
    ref=[ans(kind="person", linked_to="$checkup")]),
  T("so who's at both", rows("hana", "yuki"),
    ref=[ans(kind="person", linked_to="$open_day, $checkup")]),
  T("note in hana diary: Nap mats - ask if we bring our own",
    diff(new("note", name=has("Nap"), body=has("bring")), link("hana_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Nap mats", body="ask if we bring our own"), more=True),
         act("add_to", rows="$new", args=lines(to="$hana_nb"))]),
  T("what's in hana diary", rows("hana_words", "hana_allergy", "nursery_q", "+1"),
    ref=[ans(kind="note", linked_to="$hana_nb")]))

S("T12-057", "note notebook count counts list add_to",
  T("how many of my notes are filed in a notebook", val(17),
    ref=[ans(op="count", kind="note", where="notebook count >= 1")]),
  T("and loose ones?", val(4),
    ref=[ans(op="count", kind="note", where="notebook count = 0")]),
  T("which are they", rows("osaka_note", "lease_note", "staff_note", "gift_note"),
    ref=[find(kind="note", where="notebook count = 0"), ans(rows="@prev")]),
  T("put lease renewal points into accounts", diff(link("accounts_nb", "lease_note")),
    ref=[act("add_to", rows="$lease_note", args=lines(to="$accounts_nb"))]))

S("T12-058", "remove_from note named undo link",
  T("what's in accounts", rows("acct_july", "acct_tax"),
    ref=[ans(kind="note", linked_to="$accounts_nb")]),
  T("take consumption tax notes out of it", diff(unlink("accounts_nb", "acct_tax")),
    ref=[act("remove_from", rows="$acct_tax", args=lines(from_="$accounts_nb"))]),
  T("hmm no, undo", diff(link("accounts_nb", "acct_tax")),
    ref=[act("undo")]))

S("T12-059", "task count find-only subtasks within reschedule multi",
  T("which of my tasks have subtasks", rows("insp_prep", "autumn_menu", "fest_task", "nursery"),
    ref=[find(kind="task", where="task count > 0"), ans(rows="@prev")]),
  T("what's under the autumn fest stall one", rows("fest_permit", "fest_gas", "fest_bowls"),
    ref=[ans(kind="task", linked_to="$fest_task")]),
  T("which of those aren't done", rows("fest_gas", "fest_bowls"),
    ref=[ans(within="@prev", where="completed is empty")]),
  T("push both to the fourth of september", diff(upd("fest_gas", date="2026-09-04"), upd("fest_bowls", date="2026-09-04")),
    ref=[act("reschedule", rows="$fest_gas, $fest_bowls", args=lines(to=D("2026-09-04")))]))

S("T12-060", "log person where role linked task event",
  T("log a call with the landlord", diff(upd("okada", date=ANY)),
    ref=[act("log", kind="person", where='role = "landlord"', args=lines(kind="call"))]),
  T("what's on my list with him", rows("lease_t"),
    ref=[ans(kind="task", linked_to="$okada")]),
  T("and when's the meeting with shigeru okada", rows("lease_mtg"),
    ref=[ans(kind="event", linked_to="$okada")]))

S("T12-061", "note body contains pin notebook pinned",
  T("which notes mention kombu", rows("shio_tare", "kombu_order"),
    ref=[find(kind="note", where='body contains "kombu"'), ans(rows="@prev")]),
  T("and garlic", rows("miso_blend", "idea_corn"),
    ref=[ans(kind="note", where='body contains "garlic"')]),
  T("pin the miso blend one", diff(upd("miso_blend", pinned=True)),
    ref=[act("edit", rows="$miso_blend", args=lines(pinned="yes"))]),
  T("what's pinned in broth recipes", rows("tonkotsu", "miso_blend"),
    ref=[ans(kind="note", linked_to="$broth_nb", where="pinned = yes")]))

S("T12-062", "reschedule event where when linked named when",
  T("can fujita come at 9 instead on thursday", diff(upd("pork_0820", date="2026-08-20T09:00")),
    ref=[act("reschedule", kind="event", when=W(U("week", 0, weekday=4)), linked_to="$fujita",
             args=lines(to=U("day", 0, anchor="row", time="09:00")))]),
  T("is the accountant meeting that day on", rows("acct_aug"),
    ref=[ans(kind="event", name="Accountant meeting", when=W(U("week", 0, weekday=4)))]))

S("T12-063", "note spans within notebook count delete",
  T("notes from the start of last month to the twelfth",
    rows("fujita_prices", "hana_words", "idea_corn", "idea_tsuke", "idea_kids", "acct_july", "acct_tax", "osaka_note"),
    ref=[ans(kind="note", when=W(span(U("month", -1), D("2026-08-12"))))]),
  T("only the ones filed in a notebook",
    rows("fujita_prices", "hana_words", "idea_corn", "idea_tsuke", "idea_kids", "acct_july", "acct_tax"),
    ref=[ans(within="@prev", where="notebook count >= 1")]),
  T("notes from last week up to friday noon", rows("idea_tsuke", "osaka_note"),
    ref=[ans(kind="note", when=W(span(U("week", -1), D("2026-08-14", "12:00"))))]),
  T("delete the osaka one, trip's done", diff(trash("osaka_note")),
    ref=[act("delete", rows="$osaka_note")]))

S("T12-064", "settle debt named empty answer log",
  T("extra pork bones, settle that, paid fujita at the delivery", diff(upd("d_fujita", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Extra pork bones")]),
  T("anything else open with makoto fujita", rows(),
    ref=[ans(kind="debt", linked_to="$fujita", where='status = "open"')]),
  T("log the call too", diff(upd("fujita", date=ANY)),
    ref=[act("log", rows="$fujita", args=lines(kind="call"))]))

S("T12-065", "photo album count add_to named more delete",
  T("which pics aren't in any album",
    rows("boiler_p", "corn_p", "hana_noodles", "lanterns", "beer_p", "farm_p", "opening", "wedding", "receipt_p"),
    ref=[find(kind="photo", where="album count = 0"), ans(rows="@prev")]),
  T("put the corn test in menu shots and the boiler one in shop",
    diff(link("menu_album", "corn_p"), link("shop_album", "boiler_p")),
    ref=[act("add_to", rows="$corn_p", args=lines(to="$menu_album"), more=True),
         act("add_to", rows="$boiler_p", args=lines(to="$shop_album"))]),
  T("and delete the costco receipt", diff(trash("receipt_p")),
    ref=[act("delete", rows="$receipt_p")]))

S("T12-066", "task named reschedule prev anchor month name",
  T("when's the car inspection due", rows("shaken"),
    ref=[ans(kind="task", name="Car inspection")]),
  T("move it a week later", diff(upd("shaken", date="2026-09-25")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 1, anchor="row")))]),
  T("what's due in september",
    rows("fest_bowls", "nursery", "menu_photos", "fest_gas", "menu_print", "fest_task", "noren", "autumn_menu",
         "shaken", "shop_ins_t", "permit_t"),
    ref=[ans(kind="task", when=W(U("month", 0, name=9)))]))

S("T12-067", "photo person count within album",
  T("photos with more than two people in them", rows("bbq_p", "noodle_class"),
    ref=[find(kind="photo", where="person count > 2"), ans(rows="@prev")]),
  T("and with exactly 2", rows("hana_osaka", "hana_bday2", "grave", "kamukura", "gwangjang", "fest25_stall", "hana_grandma"),
    ref=[find(kind="photo", where="person count = 2"), ans(rows="@prev")]),
  T("the osaka album ones", rows("hana_osaka", "grave", "kamukura"),
    ref=[ans(within="@prev", linked_to="$osaka_album")]))

S("T12-068", "debt amount gte literal within",
  T("debts of 10000 yen or more", rows("d_takeshi", "d_shun", "d_daisuke", "d_fujita"),
    ref=[find(kind="debt", where="amount >= 10000"), ans(rows="@prev")]),
  T("which of those do i owe", rows("d_shun", "d_fujita"),
    ref=[ans(within="@prev", where='direction = "i_owe"')]))

S("T12-069", "debt status enum settle named",
  T("which debts are settled", rows("d_koji", "d_nishiyama"),
    ref=[find(kind="debt", where='status = "settled"'), ans(rows="@prev")]),
  T("and what's open that people owe me", rows("d_takeshi", "d_daisuke", "d_mei", "d_ryo_i"),
    ref=[ans(kind="debt", where='status = "open" and direction = "owes_me"')]),
  T("mei paid the uniform deposit back today", diff(upd("d_mei", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Uniform deposit")]))

S("T12-070", "create person log new undo ledger read new",
  T("add a contact: Satoshi Ueda, egg supplier from Chitose", diff(new("person", name="Satoshi Ueda", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Satoshi Ueda", role="egg supplier, Chitose"))]),
  T("log a visit, he dropped samples off", diff(upd("+1", date=ANY)),
    ref=[act("log", rows="$c1", args=lines(kind="visit"))]),
  T("undo that, it was yesterday actually", diff(),
    ref=[act("undo")]),
  T("what's his role saved as", rows("+1"),
    ref=[ans(rows="$c1")]))

S("T12-071", "list tasks add_to multi count",
  T("what's on the paperwork list", rows("tax", "receipts", "shop_ins_t", "lease_t", "permit_t"),
    ref=[ans(kind="task", linked_to="$paper_l")]),
  T("add the car inspection and the snow tires to it",
    diff(link("paper_l", "shaken"), link("paper_l", "snow_tires"), unlink("home_l", "shaken"), unlink("home_l", "snow_tires")),
    ref=[act("add_to", rows="$shaken, $snow_tires", args=lines(to="$paper_l"))]),
  T("how many open on it", val(7),
    ref=[ans(op="count", kind="task", linked_to="$paper_l", where='status = "open"')]))

S("T12-072", "locker username in star",
  T("which logins use kenji.ramen@gmail.com or watanabe_ramen", rows("pos", "tabelog", "gmail"),
    ref=[ans(kind="locker item", where='username in ("kenji.ramen@gmail.com", "watanabe_ramen")')]),
  T("star the tabelog one", diff(upd("tabelog", starred=True)),
    ref=[act("star", rows="$tabelog")]))

S("T12-073", "repair cadence weeks within person span log event",
  T("who do i check in with every eight weeks or less often", rows("emi", "endo", "ogawa", "hayashi_t", "kimura"),
    ref=[bad(ans(kind="person", where="cadence >= 8 weeks")),
         ans(kind="person", where="cadence >= 56")]),
  T("which of them did i talk to from fifteenth july through july", rows("kimura", "hayashi_t"),
    ref=[ans(within="@prev", when=W(span(D("2026-07-15"), U("month", 0, name=7))))]),
  T("log a call with kimura, sorted the tax stuff", diff(upd("kimura", date=ANY)),
    ref=[act("log", rows="$kimura", args=lines(kind="call"))]),
  T("when's my next accountant meeting", rows("acct_aug"),
    ref=[ans(kind="event", name="Accountant meeting", when=W({"from": U("day", 0)}))]))

S("T12-074", "debt status span sum within",
  T("open debts from last monday till today", rows("d_aiko", "d_haruto", "d_takeshi", "d_fujita", "d_emi", "d_mei", "d_kenta"),
    ref=[ans(kind="debt", where='status = "open"', when=W(span(U("week", -1, weekday=1), U("day", 0))))]),
  T("add them up", val((72100, "JPY")),
    ref=[ans(op="sum", field="amount", within="@prev")]))

S("T12-075", "reschedule event multi minutes today exclude",
  T("coffee with haruto and coffee with shun, push both half an hour",
    diff(upd("haruto_coffee", date="2026-08-18T17:30"), upd("shun_coffee", date="2026-08-21T15:30")),
    ref=[act("reschedule", rows="$haruto_coffee, $shun_coffee", args=lines(to=U("minute", 30, anchor="row")))]),
  T("what else is on today", rows("shift_plan", "haruto_coffee"),
    ref=[ans(kind="event", when=W(U("day", 0)))]),
  T("who's on the fest setup besides haruto", rows("daisuke"),
    ref=[ans(kind="person", linked_to="$fest_setup", exclude="$haruto")]))
