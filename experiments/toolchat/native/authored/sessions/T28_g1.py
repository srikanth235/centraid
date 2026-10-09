from gold import *
import json

world("T28", "2026-02-21T12:00", "Wiremu Tane", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))
NEXT_WEEKEND = span(U("week", 1, weekday=6), U("week", 1, weekday=7))

S("T28-101", "ask options hui reschedule balance positive",
  T("push the reunion hui to march 15 at 2", ask("hui_feb", "hui_mar"),
    ref=[act("reschedule", kind="event", name="Reunion planning hui", args=lines(to=D("2026-03-15", "14:00"))),
         find(kind="event", name="Reunion planning hui"),
         askc("the one on feb 8 or the one on mar 8?", options="$hui_feb, $hui_mar")]),
  T("the march one", diff(upd("hui_mar", date="2026-03-15T14:00")),
    ref=[act("reschedule", rows="$hui_mar", args=lines(to=D("2026-03-15", "14:00")))]),
  T("how much does kiri owe me", val((140, "NZD")),
    ref=[ans(op="balance", rows="$kiri")]))

S("T28-103", "ask options gp reschedule balance negative",
  T("move the gp to friday at 10", ask("gp_feb", "gp_mar"),
    ref=[act("reschedule", kind="event", name="gp",
             args=lines(to=U("week", 1, weekday=5, time="10:00"))),
         find(kind="event", name="gp"),
         askc("the blood pressure one on the 24th or the knee one on march 24?", options="$gp_feb, $gp_mar")]),
  T("the 24th one, the knee can wait", diff(upd("gp_feb", date="2026-02-27T10:00")),
    ref=[act("reschedule", rows="$gp_feb", args=lines(to=U("week", 1, weekday=5, time="10:00")))]),
  T("what do i owe hemi tane", val((-220, "NZD")),
    ref=[ans(op="balance", rows="$hemi_t")]))

S("T28-104", "gp by description undo never mind",
  T("get me in earlier, push the knee gp appointment to friday at 10",
    diff(upd("gp_mar", date="2026-02-27T10:00")),
    ref=[act("reschedule", kind="event", name="GP appointment with Dr Lim", where='description contains "knee"',
             args=lines(to=U("week", 1, weekday=5, time="10:00")))]),
  T("scratch that, the clinic says friday's full", diff(upd("gp_mar", date="2026-03-24T09:30")),
    ref=[act("undo")]))

S("T28-105", "ask options power bill complete balance positive",
  T("tick the power bill", ask("power_02", "power_03"),
    ref=[act("complete", kind="task", name="Pay the power bill"),
         find(kind="task", name="Pay the power bill"),
         askc("the february one or the march one?", options="$power_02, $power_03")]),
  T("february", diff(upd("power_02", status="completed", completed=ANY)),
    ref=[act("complete", rows="$power_02")]),
  T("and what does moana owe me for the koha tin", val((65, "NZD")),
    ref=[ans(op="balance", rows="$moana")]))

S("T28-106", "power bill by month reopen balance positive",
  T("tick the power bill for february", diff(upd("power_02", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay the power bill", when=W(U("month", 0, name=2)))]),
  T("reopen the kai list, ngaire changed the menu", diff(upd("kai_list", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Write the kai list")]),
  T("how much does kevin owe me for the petrol", val((40, "NZD")),
    ref=[ans(op="balance", rows="$kevin")]))

S("T28-107", "ask options fix tasks reschedule undo never mind",
  T("push the fix job to next monday", ask("fence", "tap", "piupiu"),
    ref=[act("reschedule", kind="task", name="Fix", args=lines(to=U("week", 1, weekday=1))),
         askc("the back fence, the kitchen tap or ana's piupiu?", options="$fence, $tap, $piupiu")]),
  T("the tap", diff(upd("tap", date="2026-02-23")),
    ref=[act("reschedule", rows="$tap", args=lines(to=U("week", 1, weekday=1)))]),
  T("and ana's piupiu, same day", diff(upd("piupiu", date="2026-02-23")),
    ref=[act("reschedule", rows="$piupiu", args=lines(to=U("week", 1, weekday=1)))]),
  T("cancel that, ana's is sorted, undo the piupiu", diff(upd("piupiu", date="2026-03-10")),
    ref=[act("undo")]))

S("T28-108", "ask options hemi star both balance negative",
  T("star hemi", ask("hemi_t", "hemi_r"),
    ref=[act("star", kind="person", name="Hemi"),
         askc("hemi tane your son or hemi rangi the committee chair?", options="$hemi_t, $hemi_r")]),
  T("the chair", diff(upd("hemi_r", starred=True)),
    ref=[act("star", rows="$hemi_r")]),
  T("star hemi tane too, he's my boy", diff(upd("hemi_t", starred=True)),
    ref=[act("star", kind="person", name="Hemi Tane")]),
  T("what do i owe whaea hine", val((-30, "NZD")),
    ref=[search("whaea hine", kind="person"), ans(op="balance", rows="$hine")]))

S("T28-109", "ask options scan star unstar",
  T("star the scan", ask("scan", "chart_scan"),
    ref=[act("star", kind="document", name="scan"),
         askc("scan 0221 or the whakapapa chart scan?", options="$scan, $chart_scan")]),
  T("the whakapapa one", diff(upd("chart_scan", starred=True)),
    ref=[act("star", rows="$chart_scan")]),
  T("unstar the trust deed, the binder has it too", diff(upd("trust_deed", starred=False)),
    ref=[act("unstar", kind="document", name="Marae trust deed")]))

S("T28-110", "ask options notice star already",
  T("star the notice", ask("rates_notice", "notice"),
    ref=[act("star", kind="document", name="notice"),
         askc("the council rates notice or uncle hohepa's funeral notice?", options="$rates_notice, $notice")]),
  T("the funeral one", diff(upd("notice", starred=True)),
    ref=[act("star", rows="$notice")]),
  T("star the house insurance policy too", diff(already=["policy"]),
    ref=[act("star", kind="document", name="House insurance policy"), ans(rows="$policy")]))

S("T28-111", "star by full name count starred docs",
  T("star scan 0221", diff(upd("scan", starred=True)),
    ref=[act("star", kind="document", name="Scan 0221")]),
  T("star the funeral notice", diff(upd("notice", starred=True)),
    ref=[act("star", kind="document", name="Uncle Hohepa's funeral notice")]),
  T("how many starred docs now", val(5),
    ref=[ans(op="count", kind="document", where="starred = yes")]))

S("T28-112", "ask options marae password reveal wifi read star",
  T("what's the marae password", ask("trust_portal", "alarm", "wifi_marae"),
    ref=[find(kind="locker item", name="Marae"),
         askc("the trust portal login, the alarm code or the marae wifi?", options="$trust_portal, $alarm, $wifi_marae")]),
  T("the trust portal", diff(reveal=[("trust_portal", "Wharekai-Roof-26")]),
    ref=[act("reveal", rows="$trust_portal", args=lines(field="password"))]),
  T("and the home wifi pw", rows("wifi"),
    ref=[ans(kind="locker item", name="Home wifi")]),
  T("star the marae wifi too, the kids ask for it", diff(upd("wifi_marae", starred=True)),
    ref=[act("star", kind="locker item", name="Marae wifi")]))

S("T28-113", "reveal portal reveal wifi verb wifi read star",
  T("what's the trust portal password", diff(reveal=[("trust_portal", "Wharekai-Roof-26")]),
    ref=[act("reveal", kind="locker item", name="Marae trust portal", args=lines(field="password"))]),
  T("i keep forgetting it, the home wifi password please", diff(reveal=[("wifi", "kumara-patch-44")]),
    ref=[act("reveal", kind="locker item", name="Home wifi", args=lines(field="password"))]),
  T("where's the marae wifi pw", rows("wifi_marae"),
    ref=[ans(kind="locker item", name="Marae wifi")]),
  T("star the trust portal, i'm in there weekly", diff(upd("trust_portal", starred=True)),
    ref=[act("star", kind="locker item", name="Marae trust portal")]))

S("T28-114", "ask options asb unstar balance negative",
  T("unstar asb", ask("asb", "visa"),
    ref=[act("unstar", kind="locker item", name="ASB"),
         askc("the asb online banking login or the asb visa?", options="$asb, $visa")]),
  T("the visa, it's in the wallet app now", diff(upd("visa", starred=False)),
    ref=[act("unstar", rows="$visa")]),
  T("what do i owe pita", val((-275, "NZD")),
    ref=[ans(op="balance", rows="$pita")]))

S("T28-115", "unstar full name star passport",
  T("unstar the asb visa", diff(upd("visa", starred=False)),
    ref=[act("unstar", kind="locker item", name="ASB Visa")]),
  T("star my passport", diff(upd("passport_l", starred=True)),
    ref=[act("star", kind="locker item", name="passport")]))
