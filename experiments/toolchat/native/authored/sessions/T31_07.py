from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-117", "dentist physio last next reschedule-minutes cancel-count",
  T("when was the dentist before the one on the 19th", rows("dentist_ev2"),
    ref=[ans(kind="event", name="dentist", when=J({"to": D("2026-11-18")}), order="date desc", limit=1)]),
  T("and the next one", rows("dentist_ev"),
    ref=[ans(kind="event", name="dentist", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("shift it half an hour later", diff(upd("dentist_ev", date="2026-11-19T16:15")),
    ref=[act("reschedule", rows="$dentist_ev", args=lines(to=U("minute", 30, anchor="row")))]),
  T("which physio sessions are after the 12th", rows("physio_b"),
    ref=[ans(kind="event", name="physio", when=J({"from": D("2026-11-13")}))]),
  T("cancel it and tell me how many physio sessions i've got left", val(1, also=diff(upd("physio_b", status="cancelled"))),
    ref=[act("cancel", rows="$physio_b", more=True),
         ans(op="count", kind="event", name="physio", where="status != cancelled", when=J({"from": U("day", 0)}))]))

S("T31-118", "hall november after-15th find-cancel count-left reschedule-same-time",
  T("which hall games are in november after the 15th", rows("fas_1117", "fas_1124"),
    ref=[ans(kind="event", name="five-a-side hall", when=J(span(D("2026-11-16"), D("2026-11-30"))))]),
  T("cancel all of those, the hall's shut again", diff(upd("fas_1117", status="cancelled"), upd("fas_1124", status="cancelled")),
    ref=[find(kind="event", name="five-a-side hall", where="status != cancelled", when=J(span(D("2026-11-16"), D("2026-11-30")))),
         act("cancel", rows="@2")]),
  T("how many are left in the hall before christmas", val(4),
    ref=[ans(op="count", kind="event", name="five-a-side hall", where="status != cancelled", when=J(span(U("day", 0), D("2026-12-24"))))]),
  T("and push the one on the 10th to the 11th, same time", diff(upd("fas_1110", date="2026-11-11T20:00")),
    ref=[act("reschedule", kind="event", name="five-a-side hall", when=J(D("2026-11-10")), args=lines(to=D("2026-11-11")))]))

S("T31-119", "debts before november smallest biggest-besides sum-within",
  T("what i owe that dates from before november", rows("d_natalia", "d_ewa", "d_kasia", "d_ola_clean", "d_darek_pizza"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", when=J({"to": D("2026-10-31")}))]),
  T("of those, which is the lowest", rows("d_ewa"),
    ref=[ans(within="@1", order="amount asc", limit=1)]),
  T("and the biggest besides natalia's", rows("d_kasia"),
    ref=[ans(within="@1", order="amount desc", limit=1, exclude="$d_natalia")]),
  T("how much do those come to altogether", val((416, "PLN")),
    ref=[ans(op="sum", field="amount", within="@1")]))

S("T31-120", "ward jobs find-complete short undo name",
  T("tick off the open ward jobs due before the 10th that take 15 minutes or less",
    diff(upd("handover", status="completed", completed=ANY), upd("uniforms", status="completed", completed=ANY)),
    ref=[find(kind="task", linked_to="$ward_l", where="status = open and effort <= 15", when=J({"to": D("2026-11-09")})),
         act("complete", rows="@1")]),
  T("undo that", diff(upd("handover", status="open", completed=None), upd("uniforms", status="open", completed=None)),
    ref=[act("undo")]),
  T("just the scrubs one on the ward list then", diff(upd("uniforms", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="scrubs", linked_to="$ward_l")]))

S("T31-121", "people keep-up since-last-month longest next-after log left",
  T("which of the people i keep up with haven't i spoken to since last month",
    rows("james", "anna_wl", "babcia", "tata", "adrian", "anna_w"),
    ref=[ans(kind="person", where="cadence is set", when=J({"to": U("month", -1)}))]),
  T("which of those is the longest ago", rows("james"),
    ref=[ans(within="@1", order="date asc", limit=1)]),
  T("and who's next after him", rows("anna_wl"),
    ref=[ans(within="@1", order="date asc", limit=1, exclude="$james")]),
  T("log a call with her", diff(upd("anna_wl", date=ANY)),
    ref=[act("log", rows="$anna_wl", args="kind: call")]),
  T("so who's left out of those", rows("babcia", "tata", "adrian", "anna_w"),
    ref=[ans(within="@1", exclude="$james, $anna_wl")]))

S("T31-122", "photos october people find-star-within earliest-of-rest",
  T("which photos did i take in october",
    rows("p_fb_goal", "p_rent_slip", "p_bike", "p_adi_stag", "p_fb_boots", "p_ns_all", "p_ns_walk", "p_physio_ex", "p_fb_pizza", "p_ward_night"),
    ref=[ans(kind="photo", when=J(U("month", -1, name=10)))]),
  T("which of those show any people", rows("p_fb_goal", "p_adi_stag", "p_ns_all", "p_ns_walk", "p_fb_pizza", "p_ward_night"),
    ref=[ans(within="@1", where="person count >= 1")]),
  T("star the ones with babcia in", diff(upd("p_ns_walk", starred=True), upd("p_ns_all", starred=True)),
    ref=[find(kind="photo", within="@1", linked_to="$babcia"), act("star", rows="@3")]),
  T("which of the others is the earliest", rows("p_fb_goal"),
    ref=[ans(within="@1", exclude="@3", order="date asc", limit=1)]))
