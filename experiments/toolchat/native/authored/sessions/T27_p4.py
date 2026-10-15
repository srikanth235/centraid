from gold import *

world("T27", "2026-12-03T04:50", "Sophie Dubois", "train")

# 201 both / all of them
# 202 ordinal / positional
S("T27-202", "p4 ordinal event cancel reschedule class relist",
  T("prenatal classes from now on", rows("class_1208", "class_1215", "class_1222", "class_1229", "class_0105", "class_0112", "class_0119", "class_0126"),
    ref=[ans(kind="event", name="Prenatal class", when={"from": U("day", 0)}, order="date asc")]),
  T("cancel the third one, christmas week", diff(upd("class_1222", status="cancelled")),
    ref=[act("cancel", rows="$class_1222")]),
  T("what's left after that", rows("class_1208", "class_1215", "class_1229", "class_0105", "class_0112", "class_0119", "class_0126"),
    ref=[ans(kind="event", name="Prenatal class", when={"from": U("day", 0)}, where='status != "cancelled"', order="date asc")]),
  T("last one to 6", diff(upd("class_0126", date="2027-01-26T18:00")),
    ref=[act("reschedule", rows="$class_0126", args=lines(to=U("day", 0, anchor="row", time="18:00")))]))

# 204 except / besides
S("T27-204", "p4 except exclude task reschedule note pin date",
  T("what's due on the eleventh", rows("menu_boards", "till_float", "bake_night", "brief"),
    ref=[ans(kind="task", when=D("2026-12-11"))]),
  T("move all of them to the tenth except the croissants one", diff(upd("menu_boards", date="2026-12-10"), upd("till_float", date="2026-12-10"), upd("brief", date="2026-12-10")),
    ref=[find(kind="task", within="@prev", exclude="$bake_night"),
         act("reschedule", rows="@prev", args=lines(to=D("2026-12-10")))]),
  T("what's in bakery plans", rows("layout", "prices", "rota", "opening_menu"),
    ref=[ans(kind="note", linked_to="$plans_nb")]),
  T("pin the rest but not the shop layout", diff(upd("prices", pinned=True), upd("rota", pinned=True), upd("opening_menu", pinned=True)),
    ref=[find(kind="note", within="@prev", exclude="$layout"), act("edit", rows="@prev", args=lines(pinned="yes"))]))

# 205 bare weekdays and at N
S("T27-205", "p4 weekday at-N reschedule create range event",
  T("oven inspection to monday at 10", diff(upd("oven_check", date="2026-12-07T10:00")),
    ref=[act("reschedule", kind="event", name="Oven inspection", args=lines(to=U("week", 1, weekday=1, time="10:00")))]),
  T("dinner with léa to saturday at 8", diff(upd("lea_dinner", date="2026-12-05T20:00")),
    ref=[act("reschedule", kind="event", name="Dinner with Léa", args=lines(to=U("week", 0, weekday=6, time="20:00")))]),
  T("anything in the diary monday to wednesday this week", rows("bake_1130", "yoga", "class_1201"),
    ref=[ans(kind="event", when=span(U("week", 0, weekday=1), U("week", 0, weekday=3)))]),
  T("put a call with sandrine in the diary friday at 5", diff(new("event", name=has("sandrine"), date="2026-12-04T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Sandrine", date=U("week", 0, weekday=5, time="17:00")))]))

# 206 two writes in one message