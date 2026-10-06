from gold import *
import json

world("T26", "2026-11-24T05:30", "Ahmed Bello", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T26-101", "gap ask event reschedule roofing weekday time",
  T("move the roofing thing to thursday at 3", ask("roof_insp", "roof_meet"),
    ref=[act("reschedule", kind="event", name="roofing", args=lines(to=U("week", 0, weekday=4, time="15:00"))),
         askc("the inspection with yemisi tomorrow or the meeting with olumide on monday?", options="$roof_insp, $roof_meet")]),
  T("olumide's one", diff(upd("roof_meet", date="2026-11-26T15:00")),
    ref=[act("reschedule", rows="$roof_meet", args=lines(to=U("week", 0, weekday=4, time="15:00")))]))

S("T26-102", "gap contrast reschedule event star already bare weekday",
  T("push the roofing inspection to friday at 10", diff(upd("roof_insp", date="2026-11-27T10:00")),
    ref=[act("reschedule", kind="event", name="Roofing inspection with Yemisi",
             args=lines(to=U("week", 0, weekday=5, time="10:00")))]),
  T("star ngozi", diff(already=["ngozi"]),
    ref=[act("star", kind="person", name="Ngozi"), ans(rows="$ngozi")]),
  T("and plastering to monday, garba's done early", diff(upd("plaster", date="2026-11-30T08:00")),
    ref=[act("reschedule", kind="event", name="Plastering starts", args=lines(to=U("week", 1, weekday=1)))]))

S("T26-103", "gap ask person star emeka multi write",
  T("star emeka", ask("emeka_n", "emeka_o"),
    ref=[act("star", kind="person", name="Emeka"),
         askc("emeka nwosu or emeka obi?", options="$emeka_n, $emeka_o")]),
  T("obi, the crane guy", diff(upd("emeka_o", starred=True)),
    ref=[act("star", rows="$emeka_o")]),
  T("log a call with segun and star him too, the handover's sorted", diff(upd("segun", date=ANY, starred=True)),
    ref=[act("log", kind="person", name="Segun Adeyemi", args=lines(kind="call"), more=True),
         act("star", kind="person", name="Segun Adeyemi")]))

S("T26-104", "gap contrast star person unstar locker count",
  T("favourite emeka nwosu", diff(upd("emeka_n", starred=True)),
    ref=[act("star", kind="person", name="Emeka Nwosu")]),
  T("and unstar the gtbank app", diff(upd("gtbank", starred=False)),
    ref=[act("unstar", kind="locker item", name="GTBank app")]),
  T("how many of my people are starred", val(5),
    ref=[ans(op="count", kind="person", where="starred = yes")]))

S("T26-105", "gap ask document star scan repair remove_from refused",
  T("star the scan", ask("scan_a", "scan_b", "passport_scan"),
    ref=[act("star", kind="document", name="scan"),
         askc("scan 1121, scan 1122 or the passport scan?", options="$scan_a, $scan_b, $passport_scan")]),
  T("the 22nd one", diff(upd("scan_b", starred=True)),
    ref=[act("star", rows="$scan_b")]),
  T("take victor out of the bonga crew kitty, he's left the rig", ask(),
    ref=[bad(act("remove_from", kind="person", name="Victor Etim", args=lines(from_="$rig_g"))),
         askc("victor still has an unsettled balance in the bonga crew kitty, so he can't come out yet. settle up with him first?")]))

S("T26-106", "gap contrast star document count decline unbounded",
  T("star scan 1121", diff(upd("scan_a", starred=True)),
    ref=[act("star", kind="document", name="Scan 1121")]),
  T("how many documents carry a star at the moment", val(4),
    ref=[ans(op="count", kind="document", where="starred = yes")]),
  T("wipe all my documents, starting fresh", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T26-107", "gap ask document delete payslip repair restore window not_found",
  T("delete the payslip, hr sent a corrected one", ask("payslip_oct", "payslip_sep"),
    ref=[act("delete", kind="document", name="Payslip"),
         askc("october's or september's?", options="$payslip_oct, $payslip_sep")]),
  T("september's", diff(trash("payslip_sep")),
    ref=[act("delete", rows="$payslip_sep")]),
  T("bring back the old rig selfie", decline("not_found"),
    ref=[bad(act("restore", kind="photo", name="Old rig selfie", trashed=True)), dec("not_found")]))

S("T26-108", "gap contrast delete document star already multi write unstar",
  T("delete the october payslip, i've printed it", diff(trash("payslip_oct")),
    ref=[act("delete", kind="document", name="Payslip October")]),
  T("and star the passport scan", diff(already=["passport_scan"]),
    ref=[act("star", kind="document", name="Passport scan"), ans(rows="$passport_scan")]),
  T("star the zenith savings and unstar gtbank", diff(upd("savings", starred=True), upd("gtbank", starred=False)),
    ref=[act("star", kind="locker item", name="Zenith savings account", more=True),
         act("unstar", kind="locker item", name="GTBank app")]))

S("T26-109", "gap ask locker star zenith never mind",
  T("star the zenith one", diff(upd("savings", starred=True)),
    ref=[act("star", kind="locker item", name="Zenith")]),
  T("star the builder contract", diff(upd("builder_contract", starred=True)),
    ref=[act("star", kind="document", name="Builder contract")]))

S("T26-110", "gap ask photo star kemi repair edit field",
  T("star the kemi pic", diff(upd("p_kemi_friends", starred=True)),
    ref=[act("star", kind="photo", name="Kemi")]),
  T("make the gate motor task 3 hours", diff(upd("gate", effort=180)),
    ref=[bad(act("edit", kind="task", name="gate motor", args=lines(duration="3 hours"))),
         act("edit", kind="task", name="gate motor", args=lines(effort="180"))]))

S("T26-112", "gap contrast delete task date undo never mind balance positive restore",
  T("delete the old diesel one from the fifteenth, it's done and i don't want it cluttering the home list",
    diff(trash("diesel_1")),
    ref=[act("delete", kind="task", name="Buy diesel for generator", when=W(D("2026-11-15")))]),
  T("cancel that, i want it for the fuel log", diff(restore("diesel_1")),
    ref=[act("undo")]),
  T("where do i stand with garba", val((15000, "NGN")),
    ref=[ans(op="balance", kind="person", name="Garba")]),
  T("bring back the sell old generator task", diff(restore("old_gen")),
    ref=[act("restore", kind="task", name="Sell old generator", trashed=True)]))

S("T26-113", "gap ask event cancel dentist not_found search count",
  T("cancel the dentist", ask("dentist_femi", "dentist_kemi"),
    ref=[act("cancel", kind="event", name="Dentist"),
         askc("femi's on thursday or kemi's on the 3rd?", options="$dentist_femi, $dentist_kemi")]),
  T("femi's, the clinic called", diff(upd("dentist_femi", status="cancelled")),
    ref=[act("cancel", rows="$dentist_femi")]),
  T("move the tailor fitting to friday", decline("not_found"),
    ref=[search("tailor fitting", kind="event"), dec("not_found")]),
  T("tell me how many events i called off this month", val(3),
    ref=[ans(op="count", kind="event", where='status = "cancelled"', when=W(U("month", 0)))]))

S("T26-114", "gap contrast cancel event balance negative decline unbounded",
  T("cancel femi's dentist, we're travelling", diff(upd("dentist_femi", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dentist for Femi")]),
  T("what's my balance with victor", val((-45000, "NGN")),
    ref=[ans(op="balance", kind="person", name="Victor")]),
  T("clear everything off my calendar, starting over", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T26-115", "gap ask balance kunle",
  T("where do i stand with kunle", ask("kunle_b", "kunle_a"),
    ref=[find(kind="person", name="Kunle"),
         askc("kunle bello or kunle adeyemi?", options="$kunle_b, $kunle_a")]),
  T("bello, the cousin", val((-100000, "NGN")),
    ref=[ans(op="balance", rows="$kunle_b")]),
  T("and olumide", val((-250000, "NGN")),
    ref=[ans(op="balance", kind="person", name="Olumide")]),
  T("log a call with olumide, he rang about the labour money", diff(upd("olumide", date=ANY)),
    ref=[act("log", kind="person", name="Olumide Sanni", args=lines(kind="call"))]))
