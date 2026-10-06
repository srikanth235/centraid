from gold import *
import json

world("T22", "2026-07-13T21:25", "Sven Lindqvist", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T22-K001", "decline not_found photos other kind hint i3skill S5",
  T("any photos from the kayak trip", decline("not_found"),
    ref=[find(kind="photo", name="kayak"), search("kayak", kind="photo"), dec("not_found")]))

S("T22-K002", "decline out_of_scope call after read i3skill S5",
  T("when's elias's next dentist", rows("dentist_aug"),
    ref=[ans(kind="event", name="Dentist for Elias", when=W({"from": U("day", 0)}))]),
  T("call the clinic and push it a week", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T22-K003", "decline no field distance then read i3skill S5",
  T("how far is the summer house from here", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("when do we drive down", rows("drive_osterlen"),
    ref=[ans(kind="event", name="Drive to Österlen")]))

S("T22-K004", "decline email then read note i3skill S5",
  T("email jonas the notes from last week", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("what notes do i have from jonas", rows("jonas_notes"),
    ref=[ans(kind="note", name="Notes from Jonas")]))

S("T22-K005", "decline text then log message is a write i3skill S5",
  T("text ahmed that i'm running late tonight", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok log that i messaged him", diff(upd("ahmed", date=ANY)),
    ref=[act("log", rows="$ahmed", args=lines(kind="message"))]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T22-K101", "family word father role i3skill S6",
  T("when did i last talk to my father", rows("lennart"),
    ref=[ans(kind="person", where='role contains "father"')]))

S("T22-K102", "iou debt either direction i3skill S6",
  T("do i have an iou with karin", rows("d_karin"),
    ref=[ans(kind="debt", linked_to="$karin")]),
  T("and samira", rows("d_samira"),
    ref=[ans(kind="debt", linked_to="$samira")]))

S("T22-K103", "a note about body search pin i3skill S6",
  T("any note about the hall cupboard", rows("wifi_summer"),
    ref=[ans(kind="note", where='body contains "cupboard"')]),
  T("pin it", diff(upd("wifi_summer", pinned=True)),
    ref=[act("edit", rows="$wifi_summer", args=lines(pinned="yes"))]))

# --- S7 look then pick --------------------------------------------------------------------------

S("T22-K201", "pick later picnic cancel i3skill S7",
  T("when are the parents network picnics", rows("picnic_jun", "picnic_aug"),
    ref=[ans(kind="event", name="Parents network picnic")]),
  T("cancel the later one", diff(upd("picnic_aug", status="cancelled")),
    ref=[act("cancel", rows="$picnic_aug")]))

S("T22-K202", "ask then the warehouse one log call i3skill S7",
  T("log a call with johan", ask("johan_b", "johan_n"),
    ref=[act("log", kind="person", name="Johan", args=lines(kind="call"))]),
  T("the warehouse one", diff(upd("johan_n", date=ANY)),
    ref=[act("log", rows="$johan_n", args=lines(kind="call"))]))

S("T22-K203", "series ask then the second one cancel i3skill S7",
  T("cancel swimming", ask("swim_1", "swim_2"),
    ref=[act("cancel", kind="event", name="Swimming lesson for Elias")]),
  T("just the second one", diff(upd("swim_2", status="cancelled")),
    ref=[act("cancel", rows="$swim_2")]))

S("T22-K204", "other two subtasks reschedule i3skill S7",
  T("what's under the shift schedule task", rows("holiday_req", "licences", "send_sched"),
    ref=[ans(kind="task", linked_to="$aug_schedule")]),
  T("i did the licences check", diff(upd("licences", status="completed", completed=ANY)),
    ref=[act("complete", rows="$licences")]),
  T("push the other two to friday", diff(upd("holiday_req", date="2026-07-17"), upd("send_sched", date="2026-07-17")),
    ref=[find(within="@1", exclude="$licences"), act("reschedule", rows="@prev", args=lines(to=U("week", 0, weekday=5)))]))

S("T22-K205", "pick by description debt settle i3skill S7",
  T("which debts are exactly 250", rows("d_tobias", "d_hanna", "d_mats"),
    ref=[ans(kind="debt", where="amount = 250 SEK")]),
  T("settle the one for the balls, tobbe paid", diff(upd("d_tobias", status="settled")),
    ref=[act("settle_debt", rows="$d_tobias")]))
