from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T21-Q026", "tab word debt kind i2pat",
  T("what's my tab with githinji", rows("d_githinji"),
    ref=[ans(kind="debt", linked_to="$githinji")]))

S("T21-Q027", "elliptical past-tense did complete i2pat",
  T("did the gas cylinder", diff(upd("gas", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="gas cylinder")]))

S("T21-Q028", "ordinal of series third row reschedule i2pat",
  T("what are the next four staff briefings", rows("brief_0608", "brief_0615", "brief_0622", "brief_0629"),
    ref=[ans(kind="event", name="Staff briefing", when=J({"from": U("day", 0)}), order="date asc", limit=4)]),
  T("push the 3rd one to 8", diff(upd("brief_0622", date="2026-06-22T08:00")),
    ref=[act("reschedule", rows="$brief_0622", args=lines(to=U("day", 0, anchor="row", time="08:00")))]))

S("T21-Q029", "settle phrase on read debt row i2pat",
  T("what do i owe beatrice", rows("d_beatrice"),
    ref=[ans(kind="debt", linked_to="$beatrice", where="status = open")]),
  T("ok i paid her just now", diff(upd("d_beatrice", status="settled")),
    ref=[act("settle_debt", rows="$d_beatrice")]))

S("T21-Q030", "possessive field phrase edit focus row i2pat",
  T("who's moses", rows("moses"),
    ref=[ans(kind="person", name="Moses")]),
  T("his role's boda rider and delivery guy", diff(upd("moses", role=has("delivery"))),
    ref=[act("edit", rows="$moses", args="role: boda rider and delivery guy")]))

S("T21-Q031", "add after in body insert position i2pat",
  T("what's in the shiru term 2 note", rows("shiru_term"),
    ref=[ans(kind="note", name="Shiru term 2")]),
  T("add science slipping after maths improving", diff(upd("shiru_term", body=has("maths improving, science slipping, needs a new geometry set"))),
    ref=[act("edit", rows="$shiru_term", args="body: maths improving, science slipping, needs a new geometry set")]))

S("T21-Q032", "different day make it carried name plus person i2pat",
  T("lunch with rose on the 11th at 1", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Lunch with Rose", date=D("2026-06-11", "13:00")))),
         askc("that clashes with your lunch with mary at 1. another day or time?")]),
  T("different day, make it the 12th", diff(new("event", name=has("Lunch with Rose"), date="2026-06-12T13:00")),
    ref=[act("create", args=lines(kind="event", name="Lunch with Rose", date=D("2026-06-12", "13:00")))]))

S("T21-Q033", "nickname and star one turn i2pat",
  T("give rose the nickname tailor rose and star her", diff(upd("rose", nickname="Tailor Rose", starred=True)),
    ref=[act("edit", rows="$rose", args="nickname: Tailor Rose", more=True), act("star", rows="$rose")]))

S("T21-Q034", "edit append quoted text verbatim separator i2pat",
  T("what's in the graduation plan note", rows("grad_plan"),
    ref=[ans(kind="note", name="Graduation plan")]),
  T('add "bring the camera" to it', diff(upd("grad_plan", body=has("leave Nakuru 6am, Kevin drives, lunch at the hotel", "bring the camera"))),
    ref=[act("edit", rows="$grad_plan", args="body: leave Nakuru 6am, Kevin drives, lunch at the hotel, bring the camera")]))

S("T21-Q035", "multi-field edit unit conversion i2pat",
  T("the gutter job takes 3 hours and make it priority 1", diff(upd("gutter", effort=180, priority=1)),
    ref=[act("edit", rows="$gutter", args="effort: 180\npriority: 1")]))

S("T21-Q036", "rename quoted target verbatim i2pat",
  T('rename the diary notebook to "Journal 2019"', diff(upd("diary_nb", name="Journal 2019")),
    ref=[act("edit", rows="$diary_nb", args="name: Journal 2019")]))

S("T21-Q037", "whos in X event and group membership i2pat",
  T("who's in chama", rows("me", "alice", "mary_a", "beatrice", "rose", "susan"),
    ref=[ans(kind="person", linked_to="$chama")]))

S("T21-Q038", "pick row containing all words among carried i2pat",
  T("what's open on the school list", rows("mock_tt", "term_report", "arrears", "ribbons", "obs_g4", "appraisals", "gutter", "tsc", "feeding"),
    ref=[ans(kind="task", linked_to="$school_l", where="status = open")]),
  T("tick off sports day ribbons", diff(upd("ribbons", status="completed", completed=ANY)),
    ref=[act("complete", rows="$ribbons")]))

S("T21-Q039", "second clause own noun resolved fresh i2pat",
  T("tick off submit tsc returns and push the car service to friday",
    diff(upd("tsc", status="completed", completed=ANY), upd("car_service", date="2026-06-12T08:00")),
    ref=[act("complete", kind="task", name="Submit TSC returns", where="status = open", more=True),
         act("reschedule", kind="event", name="Car service", args=lines(to=U("week", 1, weekday=5)))]))
