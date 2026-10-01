from gold import *
import json

world("T12", "2026-08-18T15:45", "Kenji Watanabe", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T12-001", "events tomorrow reschedule anchor people linked",
  T("what's on tomorrow", rows("checkup", "open_day", "ito_call"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("move the ito call to 5", diff(upd("ito_call", date="2026-08-19T17:00")),
    ref=[act("reschedule", rows="$ito_call", args=lines(to=U("day", 0, anchor="row", time="17:00")))]),
  T("who's coming to the nursery open day", rows("suzuki", "hana", "yuki"),
    ref=[ans(kind="person", linked_to="$open_day")]))

S("T12-002", "single locker url is set find-only",
  T("which locker entries have a website saved", rows("pos", "tabelog", "gmail"),
    ref=[find(kind="locker item", where="url is set"), ans(rows="@prev")]))

S("T12-003", "folder document count gte linked",
  T("which folders have three or more docs in them", rows("permits_f", "tax_f", "invoices_f", "hana_f"),
    ref=[find(kind="folder", where="document count >= 3"), ans(rows="@prev")]),
  T("what's in supplier invoices", rows("nishi_inv", "fujita_inv", "ito_inv"),
    ref=[ans(kind="document", linked_to="$invoices_f")]))

S("T12-004", "list task count empty rename",
  T("any of my lists got nothing on them", rows("balcony_l"),
    ref=[find(kind="list", where="task count = 0"), ans(rows="@prev")]),
  T("rename it Balcony herbs, gonna use it for the shiso", diff(upd("balcony_l", name="Balcony herbs")),
    ref=[act("edit", rows="$balcony_l", args=lines(name="Balcony herbs"))]))

S("T12-005", "log person where nickname task named",
  T("had a call with taka about his blog", diff(upd("shun", date=ANY)),
    ref=[act("log", kind="person", where='nickname = "Taka"', args=lines(kind="call"))]),
  T("when's the interview reply due", rows("blog"),
    ref=[ans(kind="task", name="blog interview")]))

S("T12-006", "ambiguous event dentist ask reschedule weekday time",
  T("move the dentist appointment to friday 2pm", ask("dentist_me", "dentist_hana"),
    ref=[act("reschedule", kind="event", name="Dentist appointment",
             args=lines(to=U("week", 0, weekday=5, time="14:00"))),
         askc("yours on the 21st or hana's on the 26th?", options="$dentist_me, $dentist_hana")]),
  T("mine", diff(upd("dentist_me", date="2026-08-21T14:00")),
    ref=[act("reschedule", rows="$dentist_me", args=lines(to=U("week", 0, weekday=5, time="14:00")))]))

S("T12-007", "reschedule event where linked task date",
  T("push the thing with okada back an hour", diff(upd("lease_mtg", date="2026-08-25T18:00")),
    ref=[act("reschedule", kind="event", linked_to="$okada", args=lines(to=U("hour", 1, anchor="row")))]),
  T("and sign new lease to the twenty-sixth", diff(upd("lease_t", date="2026-08-26")),
    ref=[act("reschedule", kind="task", name="Sign new lease", args=lines(to=D("2026-08-26")))]))

S("T12-008", "single sum i owe",
  T("add up everything i owe", val((51600, "JPY")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T12-009", "compute count group status cancel when",
  T("how many of hana's swim classes are on vs cancelled", vgroups({"tentative": 5, "cancelled": 1}),
    ref=[comp(op="count", kind="event", name="swim class", group="status"), ans(value="@prev")]),
  T("cancel saturday's, she's got a cold", diff(upd("swim_0822", status="cancelled")),
    ref=[act("cancel", kind="event", name="swim class", when=W(U("week", 0, weekday=6)))]))

S("T12-010", "delete person multi undo delete named",
  T("delete tomoko hayashi and min-jun park, don't need them anymore", diff(trash("hayashi_t"), trash("minjun")),
    ref=[act("delete", rows="$hayashi_t, $minjun")]),
  T("wait undo that, min-jun's visiting in october", diff(restore("hayashi_t"), restore("minjun")),
    ref=[act("undo")]),
  T("just tomoko then", diff(trash("hayashi_t")),
    ref=[act("delete", rows="$hayashi_t")]))

S("T12-011", "trashed person empty recovery restore add_to group",
  T("is tetsuya mori in my contacts", rows("tetsuya"),
    ref=[ans(kind="person", name="Tetsuya Mori"),
         ans(kind="person", name="Tetsuya Mori", trashed=True)]),
  T("bring him back, he's helping at the fest", diff(restore("tetsuya")),
    ref=[act("restore", rows="$tetsuya")]),
  T("and put him in the staff kitty", diff(link("staff", "tetsuya")),
    ref=[act("add_to", rows="$tetsuya", args=lines(to="$staff"))]))

S("T12-012", "search trashed restore window refused ask create",
  T("restore sora", diff(restore("sora")),
    ref=[search("sora", kind="person"), act("restore", rows="$sora")]),
  T("kenta abe too", ask(),
    ref=[search("kenta abe", kind="person"), bad(act("restore", rows="$abe")),
         askc("kenta abe was binned back in may, too long ago to restore. add him again as a new contact?")]),
  T("yeah do that, old delivery driver", diff(new("person", name="Kenta Abe", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Kenta Abe", role="old delivery driver"))]))

S("T12-013", "single event status in enum",
  T("anything confirmed or cancelled from today on", rows("swim_0829", "expo"),
    ref=[ans(kind="event", where='status in ("confirmed", "cancelled")', when=W({"from": U("day", 0)}))]))

S("T12-014", "event duration gte month linked people",
  T("which things this month run three hours or more", rows("obon", "koji_bbq", "farm", "boiler_fix"),
    ref=[find(kind="event", when=W(U("month", 0)), where="duration >= 180 minutes"), ans(rows="@prev")]),
  T("who's coming on the farm visit in furano", rows("endo", "yuki", "hana"),
    ref=[ans(kind="person", linked_to="$farm")]))

S("T12-015", "single reschedule event where when linked",
  T("can you move tomorrow's call with ito to 11am", diff(upd("ito_call", date="2026-08-19T11:00")),
    ref=[act("reschedule", kind="event", when=W(U("day", 1)), linked_to="$ito",
             args=lines(to=U("day", 0, anchor="row", time="11:00")))]))

S("T12-016", "read multi reschedule multi anchor hour",
  T("when's hana's checkup and the nursery open day", rows("checkup", "open_day"),
    ref=[ans(rows="$checkup, $open_day")]),
  T("push both back an hour, yuki's got a call", diff(upd("checkup", date="2026-08-19T11:00"),
                                                     upd("open_day", date="2026-08-19T15:00")),
    ref=[act("reschedule", rows="$checkup, $open_day", args=lines(to=U("hour", 1, anchor="row")))]))

S("T12-017", "task tomorrow reschedule prev",
  T("anything due tomorrow", rows("call_mom"),
    ref=[ans(kind="task", when=W(U("day", 1)))]),
  T("push it to friday", diff(upd("call_mom", date="2026-08-21")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 0, weekday=5)))]))

S("T12-018", "overdue find completed empty complete prev",
  T("anything overdue", rows("receipts"),
    ref=[find(kind="task", where='completed is empty and status != "cancelled"', when=W({"to": U("day", -1)})),
         ans(rows="@prev")]),
  T("tick it off, emailed them this morning", diff(upd("receipts", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]))

S("T12-019", "near duplicate kombu tasks complete log more",
  T("when did i last order kombu", rows("kombu_jul"),
    ref=[ans(kind="task", name="Order kombu from Rishiri", where='status = "completed"')]),
  T("and the next one's due when", rows("kombu_aug"),
    ref=[ans(kind="task", name="Order kombu from Rishiri", where='status = "open"')]),
  T("done, called ogawa now. log that too",
    diff(upd("kombu_aug", status="completed", completed=ANY), upd("ogawa", date=ANY)),
    ref=[act("complete", rows="$kombu_aug", more=True),
         act("log", rows="$ogawa", args=lines(kind="call"))]))

S("T12-020", "create person log new add_to group new",
  T("add Yusuke Kondo, new part-timer starting monday", diff(new("person", name="Yusuke Kondo", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Yusuke Kondo", role="part-timer"))]),
  T("log a call with him, he rang to confirm", diff(upd("+1", date=ANY)),
    ref=[act("log", rows="$c1", args=lines(kind="call"))]),
  T("put him in the staff kitty", diff(link("staff", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$staff"))]))

S("T12-021", "complete task where linked subtasks open",
  T("dr yamada gave me the health certificate early, tick that off",
    diff(upd("nursery_cert", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", linked_to="$yamada")]),
  T("what's left on hana nursery application", rows("nursery_form", "nursery_photo"),
    ref=[ans(kind="task", linked_to="$nursery", where='status = "open"')]))

S("T12-022", "single balance person",
  T("where do i stand with daisuke", val((31200, "JPY")),
    ref=[ans(op="balance", rows="$daisuke")]))

S("T12-023", "add_to task multi list count",
  T("add fill in nursery form and get id photo for hana to the hana list",
    diff(link("hana_l", "nursery_form"), link("hana_l", "nursery_photo")),
    ref=[act("add_to", rows="$nursery_form, $nursery_photo", args=lines(to="$hana_l"))]),
  T("how many on that list", val(6),
    ref=[ans(op="count", kind="task", linked_to="$hana_l")]))

S("T12-024", "remove_from task multi list open",
  T("take the snow tire one and the shaken off the home list",
    diff(unlink("home_l", "snow_tires"), unlink("home_l", "shaken")),
    ref=[find(kind="task", linked_to="$home_l"),
         act("remove_from", rows="$snow_tires, $shaken", args=lines(from_="$home_l"))]),
  T("what's open on home", rows("aircon", "gas_aug"),
    ref=[ans(kind="task", linked_to="$home_l", where='status = "open"')]))

S("T12-025", "ambiguous locker reveal ask",
  T("show me the wifi password", ask("wifi_shop", "wifi_home"),
    ref=[act("reveal", kind="locker item", name="wifi", args=lines(field="password")),
         askc("shop wifi or home wifi?", options="$wifi_shop, $wifi_home")]),
  T("home", diff(reveal=[("wifi_home", "hana-wan-wan-24")]),
    ref=[act("reveal", rows="$wifi_home", args=lines(field="password"))]))
