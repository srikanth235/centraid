from gold import *
import json

world("T06", "2026-02-07T23:15", "Lukas Brandt", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T06-201", "both followup settle_debt reschedule anchor-row",
  T("what's kalle into me for", rows("d_kalle_beer", "d_kalle_strings"),
    ref=[search("Kalle", kind="person"), ans(kind="debt", linked_to="$kalle", where="status = open")]),
  T("he paid both", diff(upd("d_kalle_beer", status="settled"), upd("d_kalle_strings", status="settled")),
    ref=[act("settle_debt", rows="@prev")]),
  T("greta mixing sessions coming up", rows("mix_greta1", "mix_greta2", "mix_greta3"),
    ref=[ans(kind="event", name="mixing session", when=W({"from": U("day", 0)}))]),
  T("push all three an hour later", diff(upd("mix_greta1", date="2026-02-09T11:00"), upd("mix_greta2", date="2026-02-16T11:00"),
                                        upd("mix_greta3", date="2026-03-02T11:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("hour", 1, anchor="row")))]))

S("T06-202", "ordinal third last reschedule complete",
  T("band rehearsals coming up", rows("reh_0210", "reh_0217", "reh_0224", "reh_0303", "reh_0310", "reh_0317", "reh_0324", "reh_0331"),
    ref=[ans(kind="event", name="band rehearsal", when=W({"from": U("day", 0)}))]),
  T("start the third one at 6 instead", diff(upd("reh_0224", date="2026-02-24T18:00")),
    ref=[act("reschedule", rows="$reh_0224", args=lines(to=D("2026-02-24", "18:00")))]),
  T("open festival jobs", rows("pa_quotes", "stage_plot", "crew_shirts", "crew_rota"),
    ref=[ans(kind="task", linked_to="$festlist", where="status = open")]),
  T("last one's already done", diff(upd("crew_rota", status="completed", completed=ANY)),
    ref=[act("complete", rows="$crew_rota")]))

S("T06-203", "owe direction balance settle_debt group-me",
  T("am i into olli for anything", val((-90, "EUR")),
    ref=[search("Olli", kind="person"), ans(op="balance", rows="$olli")]),
  T("and paul", val((60, "EUR")),
    ref=[ans(op="balance", kind="person", name="Paul Zimmer")]),
  T("paid lena back for the cables", diff(upd("d_lena_cables", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$lena", where="status = open")]),
  T("my side of the band fund?", val((45.5, "EUR")),
    ref=[search("Lukas", kind="person"), ans(op="balance", kind="group", name="Kaeltewelle band fund", linked_to="$me")]))

S("T06-204", "except rest reschedule weekday read",
  T("what's due monday to wednesday next week", rows("kuhn_heat", "call_sophie", "snake", "vat", "in_ears"),
    ref=[ans(kind="task", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]),
  T("push all of them to friday except the vat return",
    diff(upd("kuhn_heat", date="2026-02-13"), upd("call_sophie", date="2026-02-13"), upd("snake", date="2026-02-13"),
         upd("in_ears", date="2026-02-13")),
    ref=[find(within="@prev", exclude="$vat"), act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=5)))]),
  T("what's left monday to wednesday", rows("vat"),
    ref=[ans(kind="task", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]))

S("T06-205", "weekday at-N range reschedule create",
  T("what did i have monday to wednesday this week", rows("reh_0203", "coffee_ines"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]),
  T("dentist needs to be monday 4pm instead", diff(upd("dentist", date="2026-02-09T16:00")),
    ref=[act("reschedule", rows="$dentist", args=lines(to=U("week", 1, weekday=1, time="16:00")))]),
  T("bike repair with yusuf, make it sunday at 10", diff(upd("bike", date="2026-02-08T10:00")),
    ref=[act("reschedule", rows="$bike", args=lines(to=U("week", 0, weekday=7, time="10:00")))]),
  T("call mama tuesday at 5", diff(new("event", name=has("mama"), date="2026-02-10T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call Mama", date=U("week", 1, weekday=2, time="17:00")))]))

S("T06-206", "two writes settle_debt complete log",
  T("paid olli the mic money and replaced the xlr cables",
    diff(upd("d_olli_mic", status="settled"), upd("xlr", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="mic money", more=True),
         act("complete", rows="$xlr")]),
  T("what do i owe now", rows("d_jonask_bvg", "d_lena_cables", "d_ines_prints", "d_greta_dinner"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("gave ines the print money and rang mama", diff(upd("d_ines_prints", status="settled"), upd("ute", date=ANY)),
    ref=[search("Mama", kind="person"),
         act("settle_debt", kind="debt", name="gig photo prints", more=True),
         act("log", rows="$ute", args="kind: call")]))
