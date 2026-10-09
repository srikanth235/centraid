from gold import *
import json

world("T22", "2026-07-13T21:25", "Sven Lindqvist", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T22-C001", "c3c compound settle_debt complete",
  T("paid karin back for the ferry, settle that and tick off the share transfer",
    diff(upd("d_karin", status="settled"), upd("sh_share", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="Ferry tickets", more=True),
         act("complete", kind="task", name="Transfer summer house share to Karin")]))

S("T22-C002", "c3c compound log settle_debt nickname search",
  T("log a coffee with micke and settle his canteen lunch, he paid me cash",
    diff(upd("mikael", date=ANY), upd("d_micke", status="settled")),
    ref=[search("micke", kind="person"), act("log", rows="@prev", args=lines(kind="coffee"), more=True),
         act("settle_debt", kind="debt", name="Lunch at the canteen")]))

S("T22-C003", "c3c compound delete restore photos",
  T("delete the rota whiteboard pic and bring back the blurry jetty one",
    diff(trash("p_whiteboard"), restore("p_blurry")),
    ref=[act("delete", kind="photo", name="Rota whiteboard", more=True),
         act("restore", kind="photo", name="Blurry jetty", trashed=True)]))

S("T22-C004", "c3c compound three writes settle_debt complete reschedule",
  T("gunnar's ladder and paint money is paid so settle it, tick off the charcoal and push the hose to saturday",
    diff(upd("d_gunnar", status="settled"), upd("charcoal", status="completed", completed=ANY), upd("hose", date="2026-07-18")),
    ref=[act("settle_debt", kind="debt", name="Ladder and paint", more=True),
         act("complete", kind="task", name="Buy charcoal", more=True),
         act("reschedule", kind="task", name="Buy new garden hose", args=lines(to=U("week", 0, weekday=6)))]))

S("T22-C901", "c3c cell7 empty recovery no_link",
  T("what's on for the summer house group", rows("sh_meeting", "plumber"),
    ref=[find(kind="event", linked_to="$sommarhus"), ans(kind="event", name="summer house", when=W({"from": U("day", 0)}))]),
  T('tasks due from the 14th at 8am to august', rows("scanners", "dishwasher", "el_07", "fritids_form", "balls", "charcoal", "aug_schedule", "party", "cake", "inv_prep", "sick_report", "shutters", "speech", "hose", "smoke_alarm", "backpack", "agency", "car_insurance", "photos_nour", "sh_share", "licences", "plants", "court_1", "fee_07", "roof_tile", "mamma_gift", "send_sched", "holiday_req"),
    ref=[ans(kind="task", when=W(span(D("2026-07-14", "08:00"), U("month", 0, name=8))))]))
