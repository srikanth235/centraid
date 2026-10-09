from gold import *
import json

world("T24", "2026-09-18T15:05", "Carlos Mendoza", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T24-K001", "decline not_found note other kind hint i3skill S5",
  T("is there a note on the booster club budget", decline("not_found"),
    ref=[ans(kind="note", name="booster club budget"), dec("not_found")]))

S("T24-K002", "decline out_of_scope email after read i3skill S5",
  T("when's the booster club meeting", rows("booster_0915", "booster_1013"),
    ref=[ans(kind="event", name="Booster club meeting")]),
  T("email david and ask him to put the jerseys on the agenda", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T24-K003", "decline travel time no field then read i3skill S5",
  T("how long is the bus ride to chamizal", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("when's the field trip", rows("chamizal"),
    ref=[ans(kind="event", name="Field trip to Chamizal")]))

S("T24-K004", "decline not_found photo search miss i3skill S5",
  T("any photos from the state tournament", decline("not_found"),
    ref=[find(kind="photo", name="state tournament"), search("tournament", kind="photo"), dec("not_found")]))

S("T24-K005", "decline pay someone then debt read i3skill S5",
  T("venmo hector what i owe him for the gas", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("what's the debt with hector about", rows("d_hector"),
    ref=[ans(kind="debt", linked_to="$hector")]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T24-K101", "family word mother uncle role i3skill S6",
  T("when did i last talk to my mother", rows("rosa"),
    ref=[ans(kind="person", where='role = "mother"')]),
  T("and my uncle", rows("beto"),
    ref=[ans(kind="person", where='role contains "uncle"')]))

S("T24-K102", "list word is a note name i3skill S6",
  T("what's on the lucia party list", rows("party_list"),
    ref=[ans(kind="note", name="Lucia party list")]),
  T("and the primary sources list", rows("sources"),
    ref=[ans(kind="note", name="Primary sources list")]))

S("T24-K103", "iou debt either direction i3skill S6",
  T("any ious with rudy", rows("d_rudy"),
    ref=[ans(kind="debt", linked_to="$rudy")]),
  T("and hector", rows("d_hector"),
    ref=[ans(kind="debt", linked_to="$hector")]))

# --- S7 look then pick --------------------------------------------------------------------------

S("T24-K201", "pick earlier game reschedule i3skill S7",
  T("when are sofia's games", rows("vb_0919", "vb_0924"),
    ref=[ans(kind="event", name="Sofia volleyball game")]),
  T("move the earlier one to 2", diff(upd("vb_0919", date="2026-09-19T14:00")),
    ref=[act("reschedule", rows="$vb_0919", args=lines(to=D("2026-09-19", "14:00")))]))

S("T24-K202", "ask then lucia's dentist cancel i3skill S7",
  T("cancel the dentist", ask("dentist_mateo", "dentist_lucia"),
    ref=[act("cancel", kind="event", name="Dentist")]),
  T("lucia's", diff(upd("dentist_lucia", status="cancelled")),
    ref=[act("cancel", rows="$dentist_lucia")]))

S("T24-K203", "ask namesakes then the union one log i3skill S7",
  T("log a call with david", ask("david_r", "david_s"),
    ref=[act("log", kind="person", name="David", args=lines(kind="call"))]),
  T("the union one", diff(upd("david_s", date=ANY)),
    ref=[act("log", rows="$david_s", args=lines(kind="call"))]))

S("T24-K204", "pick by description debt settle i3skill S7",
  T("who owes me exactly 40", rows("d_ray", "d_gilbert"),
    ref=[ans(kind="debt", where="amount = 40 USD")]),
  T("settle the one from the tournament", diff(upd("d_gilbert", status="settled")),
    ref=[act("settle_debt", rows="$d_gilbert")]))

S("T24-K205", "pick the one not over reschedule i3skill S7",
  T("when's the booster club meeting", rows("booster_0915", "booster_1013"),
    ref=[ans(kind="event", name="Booster club meeting")]),
  T("push the next one to 7", diff(upd("booster_1013", date="2026-10-13T19:00")),
    ref=[act("reschedule", rows="$booster_1013", args=lines(to=D("2026-10-13", "19:00")))]))
