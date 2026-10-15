from gold import *
import json

world("T28", "2026-02-21T12:00", "Wiremu Tane", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))
NEXT_WEEKEND = span(U("week", 1, weekday=6), U("week", 1, weekday=7))

S("T28-104", "gp by description undo never mind",
  T("get me in earlier, push the knee gp appointment to friday at 10",
    diff(upd("gp_mar", date="2026-02-27T10:00")),
    ref=[act("reschedule", kind="event", name="GP appointment with Dr Lim", where='description contains "knee"',
             args=lines(to=U("week", 1, weekday=5, time="10:00")))]),
  T("scratch that, the clinic says friday's full", diff(upd("gp_mar", date="2026-03-24T09:30")),
    ref=[act("undo")]))

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

S("T28-115", "unstar full name star passport",
  T("unstar the asb visa", diff(upd("visa", starred=False)),
    ref=[act("unstar", kind="locker item", name="ASB Visa")]),
  T("star my passport", diff(upd("passport_l", starred=True)),
    ref=[act("star", kind="locker item", name="passport")]))
