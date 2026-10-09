from gold import *

world("T22", "2026-07-13T21:25", "Sven Lindqvist", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T22-A002", "ask-options event reschedule c3a",
  T("move elias's swimming lesson to 6", ask("swim_1", "swim_2"),
    ref=[act("reschedule", kind="event", name="Swimming lesson for Elias", args=lines(to=U("day", 0, anchor="row", time="18:00"))),
         find(kind="event", name="Swimming lesson for Elias", when=J({"from": U("day", 0)})),
         askc("Tomorrow the 14th or next Tuesday the 21st?", options="$swim_1, $swim_2")]),
  T("the 21st, he has camp tomorrow", diff(upd("swim_2", date="2026-07-21T18:00")),
    ref=[act("reschedule", rows="$swim_2", args=lines(to=U("day", 0, anchor="row", time="18:00")))]))

S("T22-A003", "ask-options task complete c3a",
  T("tick off the schedule one", ask("aug_schedule", "send_sched"),
    ref=[act("complete", kind="task", name="schedule"),
         askc("Shift schedule for August or Send schedule to Johan?", options="$aug_schedule, $send_sched")]),
  T("sending it, johan has it now", diff(upd("send_sched", status="completed", completed=ANY)),
    ref=[act("complete", rows="$send_sched")]),
  T("and the dishwasher one's done, tick it off", diff(upd("dishwasher", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="dishwasher")]))

S("T22-A004", "ask-options photo delete never_mind c3a",
  T("delete the beach photo", ask("p_ribersborg", "p_bridge"),
    ref=[act("delete", kind="photo", name="beach"),
         askc("Ribersborg beach or the Öresund bridge from the beach?", options="$p_ribersborg, $p_bridge")]),
  T("actually no, keep them, they're from our first date", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T22-A006", "ask-options locker_item star never_mind c3a",
  T("star the wifi", ask("wifi", "wifi_sh"),
    ref=[act("star", kind="locker item", name="wifi"),
         askc("The home wifi or the summer house wifi?", options="$wifi, $wifi_sh")]),
  T("actually don't bother, i never look at either", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and star lennart", diff(upd("lennart", starred=True)),
    ref=[act("star", kind="person", name="Lennart")]))

S("T22-A007", "follow-up c3a",
  T("what's still open on the home list", rows("dishwasher", "el_07", "parking_fine", "smoke_alarm", "car_insurance"),
    ref=[ans(kind="task", linked_to="$home_l", where="status = open")]),
  T("is any of that coming due this week", rows("dishwasher", "smoke_alarm"),
    ref=[ans(within="@prev", when=J(U("week", 0)))]))

S("T22-A008", "follow-up c3a",
  T("show me everything between now and friday", rows("micke_coffee", "jonas_talk", "samira_call", "safety_walk", "leads_0715", "knee", "camp_pickup", "padel_0714", "linnea_1on1", "padel_doubles", "swim_1"),
    ref=[ans(kind="event", when=J(span(U("day", 0), U("week", 0, weekday=5))))]),
  T("just up to wednesday", rows("padel_0714", "micke_coffee", "swim_1", "samira_call", "knee", "safety_walk", "leads_0715"),
    ref=[ans(within="@prev", when=J({"to": U("week", 0, weekday=3)}))]),
  T("the rest of them", rows("padel_doubles", "jonas_talk", "camp_pickup", "linnea_1on1"),
    ref=[ans(within="@1", exclude="@2")]))

S("T22-A009", "follow-up c3a",
  T("what am i owing", rows("d_david", "d_gunnar", "d_karin", "d_mats", "d_fatima"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("those but not the coffee", rows("d_gunnar", "d_karin", "d_david", "d_mats"),
    ref=[ans(within="@prev", exclude="$d_fatima")]),
  T("which is the biggest", rows("d_karin"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T22-A010", "follow-up c3a",
  T("what's in the elias album", rows("p_bike", "p_wreath", "p_bday7", "p_swim", "p_cinema", "p_camp", "p_gotcha"),
    ref=[ans(kind="photo", linked_to="$elias_al")]),
  T("which of those have a star", rows("p_wreath", "p_camp", "p_bday7", "p_gotcha"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("and the others", rows("p_bike", "p_cinema", "p_swim"),
    ref=[ans(within="@1", exclude="@2")]))
