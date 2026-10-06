from gold import *
import json

world("T16", "2026-12-16T18:00", "Rafiq Chowdhury", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T16-101", "ask options rahim star pick then jahanara",
  T("star rahim", ask("rahim_u", "rahim_m"),
    ref=[act("star", kind="person", name="Rahim"),
         askc("rahim uddin the line supervisor or rahim mia the bowler?", options="$rahim_u, $rahim_m")]),
  T("the bowler", diff(upd("rahim_m", starred=True)),
    ref=[act("star", rows="$rahim_m")]),
  T("and jahanara", diff(upd("jahanara", starred=True)),
    ref=[act("star", kind="person", name="Jahanara Khatun")]))

S("T16-102", "ask options rahim balance pick then contrast balances",
  T("what does rahim owe me", ask("rahim_u", "rahim_m"),
    ref=[askc("rahim uddin or rahim mia?", options="$rahim_u, $rahim_m")]),
  T("the supervisor", val((2100, "BDT")),
    ref=[ans(op="balance", rows="$rahim_u")]),
  T("and rahim mia", val((500, "BDT")),
    ref=[ans(op="balance", kind="person", name="Rahim Mia")]),
  T("sohel?", val((-350, "BDT")),
    ref=[ans(op="balance", kind="person", name="Sohel Rana")]))

S("T16-103", "ask options karim log call never_mind then contrast",
  T("log a call with karim", ask("karim_h", "abba"),
    ref=[act("log", kind="person", name="Karim", args=lines(kind="call")),
         askc("karim hossain from hr or your abba, abdul karim?", options="$karim_h, $abba")]),
  T("forget it, i'll ring from the car", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("ok log the call with karim hossain, he rang about the bonus sheet", diff(upd("karim_h", date=ANY)),
    ref=[act("log", kind="person", name="Karim Hossain", args=lines(kind="call"))]))

S("T16-104", "ask options buyer audit event or task then contrast event",
  T("push the buyer audit a day", ask("buyer_audit", "audit_prep"),
    ref=[find(kind="event,task", name="buyer audit"),
         askc("the h&m audit itself or the prepare line 3 task?", options="$buyer_audit, $audit_prep")]),
  T("the prep task", diff(upd("audit_prep", date="2026-12-21")),
    ref=[act("reschedule", rows="$audit_prep", args=lines(to=U("day", 1, anchor="row")))]),
  T("and move the h&m buyer audit to the twenty-second at 10", diff(upd("buyer_audit", date="2026-12-22T10:00")),
    ref=[act("reschedule", kind="event", name="H&M buyer audit", args=lines(to=D("2026-12-22", "10:00")))]))

S("T16-105", "ask options abba appointment pick then contrast checkup",
  T("move abba's appointment to the 23rd", ask("echo_test", "cardio_jan"),
    ref=[act("reschedule", kind="event", name="Abba", when=W({"from": U("day", 0)}),
             args=lines(to=D("2026-12-23"))),
         askc("the echo test on the 22nd or the cardiology check-up in january?", options="$echo_test, $cardio_jan")]),
  T("the echo test", diff(upd("echo_test", date="2026-12-23T08:30")),
    ref=[act("reschedule", rows="$echo_test", args=lines(to=D("2026-12-23")))]),
  T("and push the cardiology check-up a day", diff(upd("cardio_jan", date="2027-01-15T17:00")),
    ref=[act("reschedule", kind="event", name="Cardiology check-up for Abba", when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 1, anchor="row")))]))

S("T16-106", "contrast echo test tomorrow repair time then description",
  T("move abba's echo test to tomorrow at 9", diff(upd("echo_test", date="2026-12-17T09:00")),
    ref=[bad(act("reschedule", kind="event", name="Abba's echo test", args=lines(to=U("day", 1, time="9")))),
         act("reschedule", kind="event", name="Abba's echo test", args=lines(to=U("day", 1, time="09:00")))]),
  T("put fasting, bring old reports, no food from midnight in the notes too",
    diff(upd("echo_test", description="fasting, bring old reports, no food from midnight")),
    ref=[act("edit", rows="$echo_test", args=lines(description="fasting, bring old reports, no food from midnight"))]))

S("T16-107", "ask options bills complete pick then contrast dish line",
  T("mark the bill paid", ask("gas_bill", "tv_bill", "desco_01"),
    ref=[act("complete", kind="task", name="bill", where='status = "open"'),
         askc("the titas gas bill, the dish line bill or the january desco one?", options="$gas_bill, $tv_bill, $desco_01")]),
  T("the gas one", diff(upd("gas_bill", status="completed", completed=ANY)),
    ref=[act("complete", rows="$gas_bill")]),
  T("and the dish line one too, paid it at the shop", diff(upd("tv_bill", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tv_bill")]))

S("T16-108", "contrast cricket balls after read then repair effort count",
  T("what's open on the cricket list", rows("balls_1", "ground_book", "kitty_collect"),
    ref=[ans(kind="task", linked_to="$cricket_l", where='status = "open"')]),
  T("push buy cricket balls to friday", diff(upd("balls_1", date="2026-12-18")),
    ref=[act("reschedule", rows="$balls_1", args=lines(to=U("week", 0, weekday=5)))]),
  T("how many on the factory list need more than an hour", val(3),
    ref=[bad(ans(op="count", kind="task", linked_to="$factory_l", where="effort > 1 hour")),
         ans(op="count", kind="task", linked_to="$factory_l", where="effort > 60")]))

S("T16-109", "ask options cricket balls pick then ground booking monday",
  T("push the cricket balls to friday", ask("balls_1", "balls_2"),
    ref=[act("reschedule", kind="task", name="Buy cricket balls", args=lines(to=U("week", 0, weekday=5))),
         find(kind="task", name="Buy cricket balls"),
         askc("the one due tomorrow or the november one that's done?", options="$balls_1, $balls_2")]),
  T("the one due tomorrow", diff(upd("balls_1", date="2026-12-18")),
    ref=[act("reschedule", rows="$balls_1", args=lines(to=U("week", 0, weekday=5)))]),
  T("and the ground booking to monday", diff(upd("ground_book", date="2026-12-21")),
    ref=[act("reschedule", kind="task", name="Book Abahani ground for the final", args=lines(to=U("week", 1, weekday=1)))]))

S("T16-110", "ask options abba report star pick then already prescription",
  T("star abba's report", ask("ecg", "blood_report"),
    ref=[act("star", kind="document", name="Abba's report"),
         askc("the ecg report or the blood report?", options="$ecg, $blood_report")]),
  T("the ecg", diff(upd("ecg", starred=True)),
    ref=[act("star", rows="$ecg")]),
  T("and his prescription", diff(already=["prescription"]),
    ref=[act("star", kind="document", name="Abba's prescription"), ans(rows="$prescription")]))

S("T16-111", "contrast star docs tin blood report unstar deed",
  T("star the tin certificate", diff(upd("tin", starred=True)),
    ref=[act("star", kind="document", name="TIN certificate")]),
  T("star abba's blood report too", diff(upd("blood_report", starred=True)),
    ref=[act("star", kind="document", name="Abba's blood report")]),
  T("unstar the comilla land deed, it's filed at the bank now", diff(upd("deed", starred=False)),
    ref=[act("unstar", kind="document", name="Comilla land deed")]))

S("T16-113", "ask options login reveal never_mind then contrast dbbl",
  T("show me the login password", ask("gmail", "erp", "bkash_l", "dbbl"),
    ref=[act("reveal", kind="locker item", where='type = "login"', args=lines(field="password")),
         askc("gmail, factory erp, bkash or dbbl banking?", options="$gmail, $erp, $bkash_l, $dbbl")]),
  T("no forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("ok show me the dbbl password", diff(reveal=[("dbbl", "Tigers-Pace-11")]),
    ref=[act("reveal", kind="locker item", name="DBBL internet banking", args=lines(field="password"))]))

S("T16-114", "ask options key star pick then passport",
  T("star the key", ask("server_key", "office_key"),
    ref=[act("star", kind="locker item", name="key"),
         askc("the erp server key or the office 2021 key?", options="$server_key, $office_key")]),
  T("the office one", diff(upd("office_key", starred=True)),
    ref=[act("star", rows="$office_key")]),
  T("and my passport", diff(upd("passport_l", starred=True)),
    ref=[act("star", kind="locker item", name="Bangladesh passport")]))

S("T16-115", "ask options team photo delete pick then album count",
  T("delete the team photo", ask("team_2025", "team_2026"),
    ref=[act("delete", kind="photo", name="Team photo"),
         find(kind="photo", name="Team photo"),
         askc("the 2025 one or this year's from the fifth?", options="$team_2025, $team_2026")]),
  T("the old one", diff(trash("team_2025"), unlink("tigers_album", "team_2025")),
    ref=[act("delete", rows="$team_2025")]),
  T("how many pics are left in the tigers album", val(6),
    ref=[ans(op="count", kind="photo", linked_to="$tigers_album")]))
