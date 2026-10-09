from gold import *
import json

world("T26", "2026-11-24T05:30", "Ahmed Bello", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T26-C001", "c3c compound restore delete photos",
  T("bring back the duplicate goal shot and delete the under-11 team photo",
    diff(restore("p_dup_goal"), trash("p_team"), unlink("football_al", "p_team")),
    ref=[act("restore", kind="photo", name="Duplicate goal shot", trashed=True, more=True),
         act("delete", kind="photo", name="Under-11 team photo")]))

S("T26-C002", "c3c compound three writes create person add_to group log",
  T("add Kelechi Anyanwu, the new electrician, to the bonga crew kitty and log a call with him",
    diff(new("person", name="Kelechi Anyanwu", role=ANY, date=ANY), link("rig_g", "new")),
    ref=[act("create", args=lines(kind="person", name="Kelechi Anyanwu", role="electrician"), more=True),
         act("add_to", rows="$new", args=lines(to="$rig_g"), more=True),
         act("log", rows="$new", args=lines(kind="call"))]))

S("T26-C003", "c3c compound reschedule edit events at N",
  T("move the dentist for femi to friday at 10 and rename the car service to Brake check",
    diff(upd("dentist_femi", date="2026-11-27T10:00"), upd("car_service", name="Brake check")),
    ref=[act("reschedule", kind="event", name="Dentist for Femi", args=lines(to=U("week", 0, weekday=5, time="10:00")), more=True),
         act("edit", kind="event", name="Car service", args=lines(name="Brake check"))]))

S("T26-C004", "c3c compound reopen create task",
  T("reopen the sand payment, they say it's short, and add a task to call okonkwo friday",
    diff(upd("sand", status="open", completed=None), new("task", name=has("okonkwo"), date="2026-11-27")),
    ref=[act("reopen", kind="task", name="Pay for sand delivery", more=True),
         act("create", args=lines(kind="task", name="Call Okonkwo", date=U("week", 0, weekday=5)))]))

S("T26-C901", "c3c cell7 empty recovery wrong kind",
  T("where's the survey plan", rows("survey"),
    ref=[find(kind="note", name="survey plan"), ans(kind="document", name="survey plan")]),
  T('notes from last monday to the 22nd at 9pm', rows("kemi_school", "anniv_n", "tobi_waec", "solar_biz", "gift_ideas", "party_menu", "socket_plan", "guest_list", "roof_quotes"),
    ref=[ans(kind="note", when=W(span(U("week", -1, weekday=1), D("2026-11-22", "21:00"))))]))
