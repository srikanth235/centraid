from gold import *


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T33-027", "role-search log empty-day exclude",
  T("called the dentist about the 22nd, log it", diff(upd("dentist", date=ANY)),
    ref=[search("dentist", kind="person"),
         act("log", rows="$dentist", args="kind: call")]),
  T("anything else on the 22nd", rows(),
    ref=[ans(kind="event", when=J(D("2026-12-22")), exclude="$dentist_ev")]))

S("T33-028", "rina nickname month-events open-tasks reschedule",
  T("what's on for ate rina this month", rows("permit_visit", "babysit_ma"),
    ref=[ans(kind="event", linked_to="$rina", when=J(U("month", 0)))]),
  T("her open tasks due before christmas eve", rows("permit_a", "rina_gift"),
    ref=[ans(kind="task", linked_to="$rina", where="status = open", when=J({"to": D("2026-12-24")}))]),
  T("tick off rina's bonus envelope", diff(upd("rina_gift", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="bonus envelope", linked_to="$rina")]))

S("T33-029", "ask-missing-content create-note",
  T("add a note", ask(),
    ref=[askc("What should the note say?")]),
  T("call it cny shopping, red packets, cookies", diff(new("note", name=has("cny", "shopping"), body=has("red packets"))),
    ref=[act("create", kind="note", args="name: CNY shopping\nbody: red packets, cookies")]))

S("T33-030", "unbounded-decline bounded-delete-apply-all undo-restore",
  T("wipe all my tasks", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("all the finished ones on money list",
    diff(trash("fee_oct"), trash("fee_nov"), trash("utilities_nov"), trash("starhub")),
    ref=[find(kind="task", linked_to="$money_l", where="status = completed"),
         act("delete", rows="@prev")]),
  T("undo that", diff(restore("fee_oct"), restore("fee_nov"), restore("utilities_nov"), restore("starhub")),
    ref=[act("undo")]))

S("T33-031", "search-empty-recovery body-contains notebook",
  T("did i write anything down about the ikea order for kenji's curtains", rows(),
    ref=[search("ikea"),
         ans(kind="note", where='body contains "ikea"')]),
  T("any tutor saved for him", rows(),
    ref=[search("tutor"),
         ans(kind="person", name="tutor")]),
  T("which recipes mention kaya", rows("rc_kaya"),
    ref=[ans(kind="note", linked_to="$recipes_nb", where='body contains "kaya"')]))

S("T33-032", "two-wifi ask reveal-pick fabricated-decline",
  T("show me the wifi password", ask("home_wifi", "penang_wifi"),
    ref=[act("reveal", kind="locker item", name="wifi", args="field: password")]),
  T("the one in penang", diff(reveal=[("penang_wifi", "LimFamily1957")]),
    ref=[act("reveal", rows="$penang_wifi", args="field: password")]),
  T("come up with a strong password for the nas login", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T33-033", "locker star find-then-restore past-window-decline",
  T("star the nas ssh key", diff(upd("nas_ssh", starred=ANY)),
    ref=[act("star", kind="locker item", name="ssh key")]),
  T("bring back my old posb login", diff(restore("old_login")),
    ref=[find(kind="locker item", name="posb login", trashed="true"),
         act("restore", rows="@prev")]),
  T("and the old hdb wifi", decline("not_found"),
    ref=[find(kind="locker item", name="hdb wifi", trashed="true"),
         act("restore", rows="@prev")]))

S("T33-034", "two-writes star-unstar people starred-read",
  T("star pa and unstar ma", diff(upd("pa", starred=ANY), upd("ma", starred=ANY)),
    ref=[act("star", rows="$pa", more="true"),
         act("unstar", rows="$ma")]),
  T("starred people in the penang fund", rows("pa", "mei"),
    ref=[ans(kind="person", linked_to="$penang", where="starred = yes")]))

S("T33-035", "create-event two-writes-one-row wrong-container-decline",
  T("dinner with celine thursday at 7:30", diff(new("event", name=has("celine"), date="2026-12-17T19:30")),
    ref=[act("create", kind="event", args="name: Dinner with Celine\ndate: " + J(U("week", 1, weekday=4, time="19:30")))]),
  T("make it two hours, start at 8", diff(upd("+1", duration=120, date="2026-12-17T20:00")),
    ref=[act("edit", rows="$c1", args="duration: 120", more="true"),
         act("reschedule", rows="$c1", args=lines(to=U("week", 1, weekday=4, time="20:00")))]),
  T("invite celine to it", decline("out_of_scope"),
    ref=[act("add_to", rows="$celine", args="to: $c1")]))

S("T33-036", "find-then-add_to whole-result count-three narrow-date",
  T("stick all the tasks that aren't on a list into the money list",
    diff(link("money_l", "pay_priya"), link("money_l", "pay_jiahui"), link("money_l", "pay_weijie"), link("money_l", "pay_junhao")),
    ref=[bad(find(kind="task", where="list is empty and status = open")),
         find(kind="task", where="list count = 0 and status = open"),
         act("add_to", rows="@prev", args="to: $money_l")]),
  T("how many open ones does money have now that are due this month", val(8),
    ref=[ans(op="count", kind="task", linked_to="$money_l", where="status = open", when=J(U("month", 0)))]),
  T("which of those are due by the 15th", rows("fee_dec", "pay_priya", "pay_jiahui", "pay_weijie"),
    ref=[ans(within="@prev", when=J({"to": D("2026-12-15")}))]))

S("T33-037", "create-person repair-met star-log-two-writes colleagues-starred",
  T("add jason tan from work, new colleague", diff(new("person", name=has("jason", "tan"), role="colleague")),
    ref=[bad(act("create", kind="person", args="name: Jason Tan\nrole: colleague\nmet: work")),
         act("create", kind="person", args="name: Jason Tan\nrole: colleague")]),
  T("star him and log a coffee with him", diff(upd("+1", starred=ANY, date=ANY)),
    ref=[act("star", rows="$c1", more="true"),
         act("log", rows="$c1", args="kind: coffee")]),
  T("which of my colleagues are starred", rows("+1"),
    ref=[ans(kind="person", where='role = "colleague" and starred = yes')]))

S("T33-038", "create-group add-members search-role search-empty-recovery group-balance",
  T("new group osaka trip, in yen", diff(new("group", name=has("osaka"), currency="JPY"), link("new", "me")),
    ref=[act("create", kind="group", args="name: Osaka Trip\ncurrency: JPY")]),
  T("add my wife and okaasan to it", diff(link("+1", "mei"), link("+1", "okaasan")),
    ref=[search("wife", kind="person"),
         act("add_to", rows="$mei, $okaasan", args="to: $c1")]),
  T("did i save an osaka hotel anywhere", rows(),
    ref=[search("hotel"),
         ans(kind="document", name="hotel")]),
  T("how am i doing in the osaka group", val((0, "JPY")),
    ref=[search("hiro", kind="person"),
         ans(op="balance", kind="group", name="osaka trip", linked_to="$me")]))

S("T33-039", "create-album add_to-two-rows delete-album-unlink",
  T("make an album called swim days and put kenji's first swim class and the bubbles photo in it",
    diff(new("album", name=has("swim", "days")), link("new", "p_k_swim"), link("new", "p_k_bubbles")),
    ref=[search("bubbles", kind="photo"),
         act("create", kind="album", args="name: Swim days", more="true"),
         act("add_to", rows="$p_k_swim, $p_k_bubbles", args="to: $new")]),
  T("actually get rid of the album", diff(gone("+1"), unlink("+1", "p_k_swim"), unlink("+1", "p_k_bubbles")),
    ref=[act("delete", rows="$c1")]))

S("T33-040", "trashed-docs restore past-window-decline",
  T("any documents i deleted from before this year", rows("d_old_permit", "d_old_quote"),
    ref=[ans(kind="document", trashed="true", when=J({"to": U("year", -1)}))]),
  T("bring back rina's 2024 permit", diff(restore("d_old_permit")),
    ref=[find(kind="document", name="rina's work permit 2024", trashed="true"),
         act("restore", rows="@prev")]),
  T("and the old renovation quote", decline("not_found"),
    ref=[find(kind="document", name="old renovation quote", trashed="true"),
         act("restore", rows="@prev")]))

S("T33-041", "kenji count-five ordinal reschedule delete",
  T("how many open kenji tasks are over half an hour this month", val(2),
    ref=[bad(ans(op="count", kind="task", linked_to="$kenji_l", where="status = open and effort > half an hour", when=J(U("month", 0)))),
         ans(op="count", kind="task", linked_to="$kenji_l", where="status = open and effort > 30", when=J(U("month", 0)))]),
  T("which ones", rows("k_concert", "k_photos"),
    ref=[ans(rows="@prev")]),
  T("tick off the first one, the costume's done", diff(upd("k_concert", status="completed", completed=ANY)),
    ref=[act("complete", rows="$k_concert")]),
  T("and delete the other one, i'll do it online", diff(trash("k_photos")),
    ref=[act("delete", rows="$k_photos")]))

S("T33-042", "swim before-christmas ordinal-cancel undo",
  T("which swim lessons that aren't cancelled are coming up before christmas", rows("swim_1212", "swim_1219"),
    ref=[bad(ans(kind="event", name="toddler swim", where="status != cancelled and date <= 2026-12-24")),
         ans(kind="event", name="toddler swim", where="status != cancelled", when=J(span(U("day", 0), D("2026-12-24"))))]),
  T("cancel the second one", diff(upd("swim_1219", status="cancelled")),
    ref=[act("cancel", rows="$swim_1219")]),
  T("undo that, mei's feeling better", diff(),
    ref=[act("undo")]))

S("T33-043", "bare-plural ask all-three pay-tasks monday",
  T("which pay tasks are still due monday", rows("pay_david", "pay_priya", "pay_jiahui"),
    ref=[ans(kind="task", name="pay", where="status = open", when=J(U("week", 1, weekday=1)))]),
  T("push the pay tasks to tuesday", ask("pay_david", "pay_priya", "pay_jiahui"),
    ref=[act("reschedule", kind="task", name="pay", when=J(U("week", 1, weekday=1)), args=lines(to=U("week", 1, weekday=2)))]),
  T("all three", diff(upd("pay_david", date="2026-12-15"), upd("pay_priya", date="2026-12-15"), upd("pay_jiahui", date="2026-12-15")),
    ref=[act("reschedule", rows="$pay_david, $pay_priya, $pay_jiahui", args=lines(to=U("week", 1, weekday=2)))]))

S("T33-044", "create-debt balance settle-debt-by-link",
  T("ravi owes me 20 for grab ride", diff(new("debt", name=has("grab"), amount=20, direction="owes_me"), link("new", "ravi")),
    ref=[act("create", kind="debt", args="name: grab ride\namount: 20\ndirection: owes_me\nperson: $ravi")]),
  T("so what's his total with me now", val((162.5, "SGD")),
    ref=[ans(op="balance", kind="person", name="ravi")]),
  T("settle the hotpot one", diff(upd("d_ravi", status="settled")),
    ref=[act("settle_debt", kind="debt", name="hotpot", linked_to="$ravi")]))

S("T33-046", "two-dates move-lunch read-day",
  T("move tuesday's lunch with david to thursday at 1", diff(upd("lunch_david", date="2026-12-17T13:00")),
    ref=[act("reschedule", kind="event", name="lunch with david", when=J(U("week", 1, weekday=2)),
             args=lines(to=U("week", 1, weekday=4, time="13:00")))]),
  T("what's on thursday now", rows("ped_a", "lunch_david"),
    ref=[ans(kind="event", when=J(U("week", 1, weekday=4)))]))

S("T33-045", "find-event-then-tasks four-constraints kind-less-read complete rename-by-date",
  T("which kenji tasks under half an hour are still open before the sprouts concert",
    rows("k_vacc", "k_teacher", "k_diapers"),
    ref=[find(kind="event", name="christmas concert"),
         ans(kind="task", linked_to="$kenji_l", where="status = open and effort < 30", when=J({"to": D("2026-12-18")}))]),
  T("what's still due friday", rows("lift_quote", "k_concert", "k_teacher", "cc_bill", "w_review"),
    ref=[ans(kind="task", where="status = open", when=J(U("week", 1, weekday=5)))]),
  T("tick off the thank-you card in the kenji list", diff(upd("k_teacher", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="thank-you card", linked_to="$kenji_l")]),
  T("rename friday's costume task to costume with antlers", diff(upd("k_concert", name=has("antlers"))),
    ref=[act("edit", kind="task", name="costume", when=J(U("week", 1, weekday=5)), args="name: Make Kenji's reindeer costume with antlers")]))

S("T33-047", "okaasan-calls next-empty create count-since",
  T("when's the next okaasan call", rows(),
    ref=[ans(kind="event", name="call okaasan", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("put one in tomorrow at 8:30", diff(new("event", name=has("okaasan"), date="2026-12-13T20:30")),
    ref=[act("create", kind="event", args="name: Call Okaasan\ndate: " + J(U("day", 1, time="20:30")))]),
  T("how many calls with her since october that weren't cancelled", val(9),
    ref=[ans(op="count", kind="event", name="call okaasan", where="status != cancelled", when=J({"from": U("month", 0, name=10)}))]))

S("T33-048", "repair-unit-hour empty-read work-list two-writes undo-both",
  T("any home tasks over an hour", rows(),
    ref=[bad(ans(kind="task", linked_to="$home_l", where="effort > 1 hour")),
         ans(kind="task", linked_to="$home_l", where="effort > 60")]),
  T("and on the work list, due before christmas", rows("w_review", "w_handover"),
    ref=[ans(kind="task", linked_to="$work_l", where="effort > 60", when=J({"to": D("2026-12-24")}))]),
  T("tick off the self-review and push the handover doc to the 21st",
    diff(upd("w_review", status="completed", completed=ANY), upd("w_handover", date="2026-12-21")),
    ref=[act("complete", rows="$w_review", more="true"),
         act("reschedule", rows="$w_handover", args=lines(to=D("2026-12-21")))]),
  T("undo that", diff(upd("w_review", status="open", completed=ANY), upd("w_handover", date="2026-12-22")),
    ref=[act("undo")]))

S("T33-049", "photos two-writes star-unstar album-starred count-three delete-photo",
  T("star the lobby lights photo and unstar the one of kenji at one day old",
    diff(upd("p_c_lobby", starred=ANY), upd("p_k_born", starred=ANY)),
    ref=[act("star", rows="$p_c_lobby", more="true"),
         act("unstar", rows="$p_k_born")]),
  T("which of the parc vista events photos from this year are starred now", rows("p_c_ndp", "p_c_lobby"),
    ref=[ans(kind="photo", linked_to="$condo_a", where="starred = yes", when=J(U("year", 0)))]),
  T("count my starred photos that are in albums", val(7),
    ref=[ans(op="count", kind="photo", where="starred = yes and album count >= 1")]),
  T("delete the pool pump photo in parc vista events", diff(trash("p_c_pump"), unlink("condo_a", "p_c_pump")),
    ref=[act("delete", kind="photo", name="pool pump", linked_to="$condo_a")]))

S("T33-050", "notes rename-by-month delete-by-month trashed-read restore",
  T("rename the november diary entry to bad week", diff(upd("diary_tired", name="Diary entry - bad week")),
    ref=[act("edit", kind="note", name="diary entry", when=J(U("month", 0, name=11)), args="name: Diary entry - bad week")]),
  T("and delete the october one", diff(trash("diary_happy")),
    ref=[act("delete", kind="note", name="diary entry", when=J(U("month", 0, name=10)))]),
  T("what's in the trash from this year, notes only", rows("old_note", "old_draft", "diary_happy"),
    ref=[ans(kind="note", trashed="true", when=J(U("year", 0)))]),
  T("put the old shopping list back", diff(restore("old_note")),
    ref=[find(kind="note", name="old shopping list", trashed="true"),
         act("restore", rows="@prev")]))

S("T33-051", "documents star-two unstar rename folder-read",
  T("star the november minutes and the 2026 budget", diff(upd("d_minutes_nov", starred=ANY), upd("d_budget26", starred=ANY)),
    ref=[act("star", rows="$d_minutes_nov, $d_budget26")]),
  T("which docs in the condo folder are starred now", rows("d_sp25", "d_budget27", "d_minutes_nov", "d_budget26"),
    ref=[ans(kind="document", linked_to="$condo_f", where="starred = yes")]),
  T("unstar the old agreement in the condo folder", diff(upd("d_sp25", starred=ANY)),
    ref=[act("unstar", kind="document", name="agreement", linked_to="$condo_f")]),
  T("rename the 2026 budget to condo budget 2026 final", diff(upd("d_budget26", name="Condo budget 2026 final")),
    ref=[act("edit", rows="$d_budget26", args="name: Condo budget 2026 final")]))
