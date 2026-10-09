from gold import *

world("T24", "2026-09-18T15:05", "Carlos Mendoza", "train")

# 201 both / all of them
S("T24-201", "p4 both prev task reschedule star person weekday",
  T("what's due tomorrow", rows("garage_door", "mulch"),
    ref=[ans(kind="task", when=U("day", 1))]),
  T("push both to monday", diff(upd("garage_door", date="2026-09-21"), upd("mulch", date="2026-09-21")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]),
  T("who are my landscaping clients", rows("barbara", "javier"),
    ref=[ans(kind="person", where='role = "landscaping client"')]),
  T("star them both", diff(upd("barbara", starred=True), upd("javier", starred=True)),
    ref=[act("star", rows="@prev")]))

# 202 ordinal / positional
S("T24-202", "p4 ordinal event cancel reschedule list relist",
  T("varsity conditioning coming up", rows("cond_0921", "cond_0923", "cond_0928", "cond_0930"),
    ref=[ans(kind="event", name="Varsity conditioning", when={"from": U("day", 0)})]),
  T("cancel the third one, i've got the union thing", diff(upd("cond_0928", status="cancelled")),
    ref=[act("cancel", rows="$cond_0928")]),
  T("what's still on", rows("cond_0921", "cond_0923", "cond_0930"),
    ref=[ans(kind="event", name="Varsity conditioning", when={"from": U("day", 0)}, where='status != "cancelled"')]),
  T("last one to 7am", diff(upd("cond_0930", date="2026-09-30T07:00")),
    ref=[act("reschedule", rows="$cond_0930", args=lines(to=U("day", 0, anchor="row", time="07:00")))]))

# 203 owe direction
S("T24-203", "p4 owe direction debt settle_debt both signs",
  T("what do i owe", rows("d_hector", "d_david_s", "d_beto", "d_kim", "d_lupe"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("and what they owe me", rows("d_ray", "d_rudy", "d_patty", "d_gilbert", "d_marisol", "d_veronica"),
    ref=[ans(kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("settle mine with kim, it was only coffee", diff(upd("d_kim", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$kim", where='direction = "i_owe" and status = "open"')]),
  T("and gilbert's, he paid me at practice", diff(upd("d_gilbert", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$gilbert", where='direction = "owes_me" and status = "open"')]))

# 204 except / besides
S("T24-204", "p4 except exclude task reschedule complete list",
  T("what's due monday", rows("sizes", "physicals", "grade_tests", "slips", "gatorade", "invoice_soto"),
    ref=[ans(kind="task", when=U("week", 1, weekday=1))]),
  T("push all of them to tuesday except the grade tests", 
    diff(upd("sizes", date="2026-09-22"), upd("physicals", date="2026-09-22"), upd("slips", date="2026-09-22"),
         upd("gatorade", date="2026-09-22"), upd("invoice_soto", date="2026-09-22")),
    ref=[find(kind="task", within="@prev", exclude="$grade_tests"),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=2)))]),
  T("what's on groceries", rows("gatorade", "cake", "ink"),
    ref=[ans(kind="task", linked_to="$shop_l")]),
  T("check off all of them but the cake", diff(upd("gatorade", status="completed", completed=ANY), upd("ink", status="completed", completed=ANY)),
    ref=[find(kind="task", within="@prev", exclude="$cake"),
         act("complete", rows="@prev")]))

# 205 bare weekdays and at N
S("T24-205", "p4 weekday at-N reschedule create range event",
  T("move coffee with ray to monday at 5", diff(upd("ray_coffee", date="2026-09-21T17:00")),
    ref=[act("reschedule", kind="event", name="Coffee with Ray", args=lines(to=U("week", 1, weekday=1, time="17:00")))]),
  T("call with beto to saturday at 10", diff(upd("beto_call", date="2026-09-19T10:00")),
    ref=[act("reschedule", kind="event", name="Call with Tío Beto", args=lines(to=U("week", 0, weekday=6, time="10:00")))]),
  T("what did i have monday to wednesday this week", rows("cond_0914", "gym_0915", "booster_0915", "cond_0916", "union_09"),
    ref=[ans(kind="event", when=span(U("week", 0, weekday=1), U("week", 0, weekday=3)))]),
  T("put dinner with elena in the diary friday night at 8", diff(new("event", name=has("dinner", "elena"), date="2026-09-18T20:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Elena", date=U("week", 0, weekday=5, time="20:00")))]))

# 206 two writes in one message
S("T24-206", "p4 two writes settle_debt complete direction balance",
  T("ray paid me back for lunch and i sent the soto invoice", diff(upd("d_ray", status="settled"), upd("invoice_soto", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", linked_to="$ray", where='direction = "owes_me" and status = "open"', more=True),
         act("complete", kind="task", name="Send invoice to Soto")]),
  T("gave hector the gas money and bought the mulch", diff(upd("d_hector", status="settled"), upd("mulch", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", linked_to="$hector", where='direction = "i_owe" and status = "open"', more=True),
         act("complete", kind="task", name="mulch")]),
  T("what's hector's balance now", val((30, "USD")),
    ref=[ans(op="balance", kind="person", name="Hector Ramos")]))
