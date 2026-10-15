from gold import *
import json

world("T06", "2026-02-07T23:15", "Lukas Brandt", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T06-202", "ordinal third last reschedule complete",
  T("band rehearsals coming up", rows("reh_0210", "reh_0217", "reh_0224", "reh_0303", "reh_0310", "reh_0317", "reh_0324", "reh_0331"),
    ref=[ans(kind="event", name="band rehearsal", when=W({"from": U("day", 0)}))]),
  T("start the third one at 6 instead", diff(upd("reh_0224", date="2026-02-24T18:00")),
    ref=[act("reschedule", rows="$reh_0224", args=lines(to=D("2026-02-24", "18:00")))]),
  T("open festival jobs", rows("pa_quotes", "stage_plot", "crew_shirts", "crew_rota"),
    ref=[ans(kind="task", linked_to="$festlist", where="status = open")]),
  T("last one's already done", diff(upd("crew_rota", status="completed", completed=ANY)),
    ref=[act("complete", rows="$crew_rota")]))

S("T06-205", "weekday at-N range reschedule create",
  T("what did i have monday to wednesday this week", rows("reh_0203", "coffee_ines"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]),
  T("dentist needs to be monday 4pm instead", diff(upd("dentist", date="2026-02-09T16:00")),
    ref=[act("reschedule", rows="$dentist", args=lines(to=U("week", 1, weekday=1, time="16:00")))]),
  T("bike repair with yusuf, make it sunday at 10", diff(upd("bike", date="2026-02-08T10:00")),
    ref=[act("reschedule", rows="$bike", args=lines(to=U("week", 0, weekday=7, time="10:00")))]),
  T("call mama tuesday at 5", diff(new("event", name=has("mama"), date="2026-02-10T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call Mama", date=U("week", 1, weekday=2, time="17:00")))]))
