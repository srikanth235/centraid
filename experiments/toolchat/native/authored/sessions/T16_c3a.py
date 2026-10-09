from gold import *

world("T16", "2026-12-16T18:00", "Rafiq Chowdhury", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T16-A002", "ask-options task complete c3a",
  T("tick off the abba one", ask("abba_meds", "abba_reports", "phone"),
    ref=[act("complete", kind="task", name="abba"),
         askc("Refill Abba's heart medicine, Collect Abba's blood reports or Recharge Abba's phone?", options="$abba_meds, $abba_reports, $phone")]),
  T("the phone, done it just now", diff(upd("phone", status="completed", completed=ANY)),
    ref=[act("complete", rows="$phone")]))

S("T16-A003", "ask-options event reschedule c3a",
  T("push the abba appointment to monday", ask("cardio_jan", "echo_test"),
    ref=[act("reschedule", kind="event", name="abba", args=lines(to=U("week", 1, weekday=1))),
         askc("The cardiology check-up on 14 Jan or Abba's echo test on 22 Dec?", options="$cardio_jan, $echo_test")]),
  T("the echo test, i can't make tuesday", diff(upd("echo_test", date="2026-12-21T08:30")),
    ref=[act("reschedule", rows="$echo_test", args=lines(to=U("week", 1, weekday=1)))]),
  T("and the blankets one's done, tick it off", diff(upd("blanket", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="blankets")]))

S("T16-A005", "ask-options debt settle_debt c3a",
  T("settle the kitty one", ask("d_babu", "d_jewel"),
    ref=[act("settle_debt", kind="debt", name="kitty"),
         askc("Babu's kitty for November or Jewel's kitty for December?", options="$d_babu, $d_jewel")]),
  T("babu's, he paid the cash at the factory", diff(upd("d_babu", status="settled")),
    ref=[act("settle_debt", rows="$d_babu")]))

S("T16-A006", "ask-options note delete never_mind c3a",
  T("delete the eid gifts note", ask("eid24_gifts", "eid25_gifts"),
    ref=[act("delete", kind="note", name="gifts"),
         askc("Eid gifts 2024 or Eid gifts 2025?", options="$eid24_gifts, $eid25_gifts")]),
  T("no leave them, i want last year's for comparison", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and star sadia", diff(upd("mim", starred=True)),
    ref=[act("star", kind="person", name="Sadia")]))

S("T16-A007", "follow-up c3a",
  T("what's due up to friday", rows("water_pump", "balls_1", "salma_leave", "abba_meds", "phone", "bkash", "overtime", "kitty_collect"),
    ref=[ans(kind="task", when=J(span(U("day", 0), U("week", 0, weekday=5))), where="status = open")]),
  T("which of those take over 20 minutes", rows("water_pump", "balls_1"),
    ref=[ans(within="@prev", where="effort > 20")]),
  T("and the rest", rows("abba_meds", "phone", "kitty_collect", "bkash", "overtime", "salma_leave"),
    ref=[ans(within="@1", exclude="@2")]))

S("T16-A008", "follow-up c3a",
  T("what have i got next week", rows("nets_1225", "prod_1227", "wedding", "echo_test", "fire_drill", "holud", "buyer_audit", "bank_visit"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just thursday on", rows("nets_1225", "prod_1227", "wedding", "holud"),
    ref=[ans(within="@prev", when=J({"from": U("week", 1, weekday=4)}))]),
  T("drop the first two", rows("prod_1227", "wedding"),
    ref=[ans(within="@prev", exclude="$holud, $nets_1225")]))

S("T16-A009", "follow-up c3a",
  T("what am i owing", rows("d_mizan", "d_selim", "d_masud", "d_sohel", "d_monir"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("which of those are over 1000", rows("d_masud", "d_mizan"),
    ref=[ans(within="@prev", where="amount > 1000 BDT")]),
  T("and the biggest one", rows("d_masud"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T16-A010", "follow-up c3a",
  T("show me the tigers album", rows("scoreboard", "team_2026", "rahim_wickets", "nets_rain", "trophy", "tanvir_bat", "team_2025"),
    ref=[ans(kind="photo", linked_to="$tigers_album")]),
  T("any of them starred", rows("trophy", "team_2025"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("and the others", rows("team_2026", "scoreboard", "rahim_wickets", "nets_rain", "tanvir_bat"),
    ref=[ans(within="@1", exclude="@2")]))
