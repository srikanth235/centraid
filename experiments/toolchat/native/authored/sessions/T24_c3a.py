from gold import *

world("T24", "2026-09-18T15:05", "Carlos Mendoza", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T24-A001", "ask-options person star c3a",
  T("star david", ask("david_r", "david_s"),
    ref=[act("star", kind="person", name="David"),
         askc("David Ruiz the booster club treasurer or David Salazar the union rep?", options="$david_r, $david_s")]),
  T("the union rep, he's got our backs", diff(upd("david_s", starred=True)),
    ref=[act("star", rows="$david_s")]))

S("T24-A003", "ask-options task complete c3a",
  T("tick off the order one", ask("jerseys", "pinata"),
    ref=[act("complete", kind="task", name="order"),
         askc("Order new game jerseys or Order piñata?", options="$jerseys, $pinata")]),
  T("the pinata, it came today", diff(upd("pinata", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pinata")]),
  T("and the opener one's done, tick it off", diff(upd("garage_door", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="opener")]))

S("T24-A005", "ask-options debt settle_debt c3a",
  T("settle the gas one", ask("d_hector", "d_veronica"),
    ref=[act("settle_debt", kind="debt", name="gas"),
         askc("Hector's gas money (you owe 60) or Veronica's carpool gas (she owes you 55)?", options="$d_hector, $d_veronica")]),
  T("veronica's, she gave me cash at practice", diff(upd("d_veronica", status="settled")),
    ref=[act("settle_debt", rows="$d_veronica")]))

S("T24-A006", "ask-options event cancel never_mind c3a",
  T("cancel sofia's game", ask("vb_0919", "vb_0924"),
    ref=[act("cancel", kind="event", name="Sofia volleyball game"),
         find(kind="event", name="Sofia volleyball game", when=J({"from": U("day", 0)})),
         askc("Tomorrow's game on the 19th or Thursday's on the 24th?", options="$vb_0919, $vb_0924")]),
  T("no no, don't cancel, she'd kill me", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and star rodolfo", diff(upd("rudy", starred=True)),
    ref=[act("star", kind="person", name="Rodolfo")]))

S("T24-A007", "follow-up c3a",
  T("what's open on the basketball list", rows("physicals", "jerseys", "email_parents", "roster", "tryout_forms", "film"),
    ref=[ans(kind="task", linked_to="$team_l", where="status = open")]),
  T("which of those are priority 1", rows("physicals", "jerseys"),
    ref=[ans(within="@prev", where="priority = 1")]),
  T("the rest of them", rows("email_parents", "roster", "tryout_forms", "film"),
    ref=[ans(within="@1", exclude="@2")]))

S("T24-A008", "follow-up c3a",
  T("show me next week", rows("fb_0925", "ref_clinic", "gym_0922", "dentist_mateo", "gym_0924", "yard_0926", "film_session", "lucia_bday", "vb_0924", "cond_0923", "cond_0921", "checkup"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just the gym sessions", rows("gym_0924", "gym_0922"),
    ref=[ans(within="@prev", name="gym")]),
  T("what else is on", rows("fb_0925", "ref_clinic", "dentist_mateo", "yard_0926", "cond_0921", "vb_0924", "checkup", "film_session", "cond_0923", "lucia_bday"),
    ref=[ans(within="@1", exclude="@2")]))

S("T24-A009", "follow-up c3a",
  T("which people owe me", rows("d_veronica", "d_patty", "d_gilbert", "d_marisol", "d_ray", "d_rudy"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which of those are over 50", rows("d_veronica", "d_patty", "d_rudy"),
    ref=[ans(within="@prev", where="amount > 50 USD")]),
  T("which is the biggest", rows("d_rudy"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T24-A010", "follow-up c3a",
  T("what's in the team album", rows("p_summer", "p_clinic", "p_andre", "p_team_huddle", "p_marcus", "p_press", "p_opengym"),
    ref=[ans(kind="photo", linked_to="$team_al")]),
  T("now only the starred ones", rows("p_summer", "p_opengym"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("and unstar both", diff(upd("p_summer", starred=False), upd("p_opengym", starred=False)),
    ref=[act("unstar", rows="@prev")]))
