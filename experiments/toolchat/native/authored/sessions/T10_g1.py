from gold import *
import json

world("T10", "2026-06-19T14:20", "Bashir Haddad", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = {"from": U("week", 0, weekday=6), "to": U("week", 0, weekday=7)}

S("T10-101", "ask options document star unstar",
  T("star the deed", ask("deed_house", "deed_land", "deed_scan"),
    ref=[askc("house deed, land deed or the copy in the locker?", options="$deed_house, $deed_land, $deed_scan")]),
  T("the madaba one", diff(upd("deed_land", starred=True)),
    ref=[act("star", rows="$deed_land")]),
  T("and unstar the fund ledger, ziad's got his own copy", diff(upd("fund_ledger", starred=False)),
    ref=[act("unstar", kind="document", name="Fund ledger")]),
  T("put the old uk visa copy back in my docs", diff(restore("old_visa")),
    ref=[act("restore", kind="document", name="Old UK visa copy", trashed=True)]))

S("T10-102", "contrast star document context multi",
  T("when did i scan the madaba deed", rows("deed_land"),
    ref=[ans(kind="document", name="Land deed Madaba")]),
  T("star the deed", diff(upd("deed_land", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("star the echocardiogram report and the blood test results may too",
    diff(upd("echo", starred=True), upd("blood_may", starred=True)),
    ref=[act("star", rows="$echo, $blood_may")]))

S("T10-103", "ask options person add_to count",
  T("add khaled to the aqaba trip", ask("khaled_o", "khaled_s"),
    ref=[act("add_to", kind="person", name="Khaled", args=lines(to="$aqaba")),
         askc("khaled omari or khaled sweidan the pharmacist?", options="$khaled_o, $khaled_s")]),
  T("omari, he's driving down with jamal", diff(link("aqaba", "khaled_o")),
    ref=[act("add_to", rows="$khaled_o", args=lines(to="$aqaba"))]),
  T("how many of us is that", val(5),
    ref=[ans(op="count", kind="person", linked_to="$aqaba")]))

S("T10-104", "contrast add_to person context star",
  T("who was the pharmacist again", rows("khaled_s"),
    ref=[ans(kind="person", where='role contains "pharmacist"')]),
  T("add khaled to the aqaba trip, he's got a car", diff(link("aqaba", "khaled_s")),
    ref=[act("add_to", rows="@prev", args=lines(to="$aqaba"))]),
  T("star him", diff(upd("khaled_s", starred=True)),
    ref=[act("star", rows="$khaled_s")]))

S("T10-105", "ask options person add_to group",
  T("put sami on the eid group, he's coming this year", ask("sami_h", "sami_k"),
    ref=[act("add_to", kind="person", name="Sami", args=lines(to="$eid")),
         askc("sami haddad your grandson or sami khoury from chess?", options="$sami_h, $sami_k")]),
  T("haddad, the kid", diff(link("eid", "sami_h")),
    ref=[act("add_to", rows="$sami_h", args=lines(to="$eid"))]),
  T("and layla", diff(link("eid", "layla")),
    ref=[act("add_to", kind="person", name="Layla", args=lines(to="$eid"))]),
  T("and get the balcony door task back, the carpenter cancelled", diff(restore("balcony")),
    ref=[find(kind="task", name="balcony door", trashed=True), act("restore", rows="$balcony")]))

S("T10-106", "contrast add_to person context balance",
  T("who are omar's boys", rows("zaid", "sami_h"),
    ref=[ans(kind="person", where='role contains "Omar"')]),
  T("put sami on the eid group", diff(link("eid", "sami_h")),
    ref=[act("add_to", rows="$sami_h", args=lines(to="$eid"))]),
  T("does huda owe me anything", val((101, "JOD")),
    ref=[ans(op="balance", kind="person", name="Huda Haddad")]))

S("T10-107", "ask options person log long balance",
  T("khalil came by this morning with some bread from the bakery, log that as a visit", ask("khalil", "umm_khalil"),
    ref=[act("log", kind="person", name="Khalil", args=lines(kind="visit")),
         askc("khalil masri from the committee or samira khalil next door?", options="$khalil, $umm_khalil")]),
  T("next door", diff(upd("umm_khalil", date=ANY)),
    ref=[act("log", rows="$umm_khalil", args=lines(kind="visit"))]),
  T("what's her balance", val((8, "JOD")),
    ref=[ans(op="balance", rows="$umm_khalil")]),
  T("she paid me, settle it", diff(upd("d_umm_khalil", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Bread from the bakery")]))

S("T10-108", "contrast log person description balance star",
  T("khalil from the committee rang, log a call", diff(upd("khalil", date=ANY)),
    ref=[act("log", kind="person", name="Khalil Masri", args=lines(kind="call"))]),
  T("what's his balance", val((25, "JOD")),
    ref=[ans(op="balance", rows="$khalil")]),
  T("and star him", diff(upd("khalil", starred=True)),
    ref=[act("star", rows="$khalil")]),
  T("how many debts are still open", val(9),
    ref=[ans(op="count", kind="debt", where='status = "open"')]))

S("T10-109", "ask options locker star unstar",
  T("star the bank one", ask("arab_bank", "visa_card", "cairo_amman"),
    ref=[act("star", kind="locker item", name="bank"),
         askc("arab bank online, the arab bank visa or your cairo amman account?", options="$arab_bank, $visa_card, $cairo_amman")]),
  T("the online one", diff(upd("arab_bank", starred=True)),
    ref=[act("star", rows="$arab_bank")]),
  T("and unstar the visa", diff(upd("visa_card", starred=False)),
    ref=[act("unstar", rows="$visa_card")]))

S("T10-110", "ask options locker star wifi read",
  T("star the licence", ask("driving", "office_lic"),
    ref=[act("star", kind="locker item", name="licence"),
         askc("the driving licence or the office 365 one?", options="$driving, $office_lic")]),
  T("the office one", diff(upd("office_lic", starred=True)),
    ref=[act("star", rows="$office_lic")]),
  T("wifi password", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]))

S("T10-111", "contrast star locker unstar",
  T("star the arab bank online one", diff(upd("arab_bank", starred=True)),
    ref=[act("star", kind="locker item", name="Arab Bank online")]),
  T("and the driving licence", diff(upd("driving", starred=True)),
    ref=[act("star", kind="locker item", name="Driving licence")]),
  T("unstar gmail, i only use it on the phone now", diff(upd("gmail", starred=False)),
    ref=[act("unstar", kind="locker item", name="Gmail")]),
  T("how many are starred in there now", val(4),
    ref=[ans(op="count", kind="locker item", where="starred = yes")]))

S("T10-112", "ask options task reschedule weekday fabricated",
  T("push the call task to tuesday", ask("leak", "call_dana"),
    ref=[act("reschedule", kind="task", name="Call", args=lines(to=U("week", 1, weekday=2))),
         askc("call hani about the leak or call dana about the berlin visit?", options="$leak, $call_dana")]),
  T("dana's", diff(upd("call_dana", date="2026-06-23")),
    ref=[act("reschedule", rows="$call_dana", args=lines(to=U("week", 1, weekday=2)))]),
  T("what's the pin for my visa, guess if you can't find it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("and push the gas cylinder to thursday", diff(upd("gas", date="2026-06-25")),
    ref=[act("reschedule", kind="task", name="Order gas cylinder", args=lines(to=U("week", 1, weekday=4)))]))

S("T10-113", "contrast reschedule task weekend read",
  T("push the call to dana to tuesday", diff(upd("call_dana", date="2026-06-23")),
    ref=[act("reschedule", kind="task", name="Call Dana", args=lines(to=U("week", 1, weekday=2)))]),
  T("and the hani call to tomorrow", diff(upd("leak", date="2026-06-20")),
    ref=[act("reschedule", kind="task", name="Call Hani", args=lines(to=U("day", 1)))]),
  T("what's on this weekend", rows("ac_service", "call_layla_0620", "call_omar_kids"),
    ref=[ans(kind="event", when=W(WEEKEND))]))

S("T10-114", "ask options cross-kind delete never mind out_of_scope",
  T("delete the knee exercises", ask("knee_ex", "knee"),
    ref=[askc("the knee exercises task or the note?", options="$knee_ex, $knee")]),
  T("forget it, i still need both", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("will it rain in amman this weekend", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T10-115", "ask options cross-kind edit never mind reopen",
  T("rename the blood test to Al-Borg blood test", ask("blood_test", "blood_may"),
    ref=[askc("the blood test appointment or the may results document?", options="$blood_test, $blood_may")]),
  T("scratch that, leave it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("reopen the may fund statement, ziad found a mistake", diff(upd("statement_may", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Prepare fund statement for May")]))
