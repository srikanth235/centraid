from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# --- ask for what is missing, do it, then look at what it changed ---------------------------------------

S("T31-234", "ask-missing-album-name create album newest-photo add-to-album",
  T("make a new album", ask(),
    ref=[askc("What should the album be called?")]),
  T("summer 2026", diff(new("album", name=has("Summer 2026"))),
    ref=[act("create", kind="album", args=lines(name="Summer 2026"))]),
  T("what's the newest photo in the trips album", rows("p_tr_gdansk"),
    ref=[ans(kind="photo", linked_to="$trips_a", order="date desc", limit=1)]),
  T("put it in the summer album", diff(link("+1", "p_tr_gdansk")),
    ref=[act("add_to", rows="$p_tr_gdansk", args=lines(to="$c1"))]))

S("T31-237", "ask-missing-folder move document taxes-left older",
  T("move it to another folder", ask(),
    ref=[askc("Which document, and which folder?")]),
  T("the zus statement into the work folder", diff(link("work_f", "d_zus"), unlink("taxes_f", "d_zus")),
    ref=[act("add_to", kind="document", name="zus statement", args=lines(to="$work_f"))]),
  T("what's left in the taxes folder", rows("d_pit24", "d_pit25"),
    ref=[ans(kind="document", linked_to="$taxes_f")]),
  T("which of those is older", rows("d_pit24"),
    ref=[ans(within="@prev", order="date asc", limit=1)]))

S("T31-238", "ask-missing-date reschedule stag dinner december besides-adi",
  T("change the date", ask(),
    ref=[askc("Which one, and to when?")]),
  T("the stag planning dinner to the 5th of december, same time", diff(upd("stag_planning", date="2026-12-05T19:00")),
    ref=[act("reschedule", kind="event", name="stag planning dinner", args=lines(to=D("2026-12-05", "19:00")))]),
  T("which events are on the 4th", rows("zakopane_trip"),
    ref=[ans(kind="event", when=J(D("2026-12-04")))]),
  T("who's coming to that one besides adi", rows("natalia", "agnieszka", "basia"),
    ref=[ans(kind="person", linked_to="$zakopane_trip", exclude="$adrian")]))

S("T31-239", "ask-missing-secret create password gym star",
  T("save a password", ask(),
    ref=[askc("What is it for, and what's the password?")]),
  T("for the gym app, it's gym-4455", diff(new("locker item", name=has("Gym app"), type="password")),
    ref=[act("create", kind="locker item", args=lines(name="Gym app", type="password", password="gym-4455"))]),
  T("which passwords have i saved that aren't starred", rows("spotify_pw", "+1"),
    ref=[ans(kind="locker item", where="type = password and starred = no")]),
  T("star the gym one", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]))

# --- declines that lead somewhere ---------------------------------------------------------------------------

S("T31-240", "decline-out-of-scope recurring reminder then task sunday within-effort",
  T("remind me every sunday to wash the kit", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok just add a task, wash the kit on sunday", diff(new("task", name=has("kit"), date="2026-11-08")),
    ref=[act("create", kind="task", args=lines(name="Wash the kit", date=U("week", 0, weekday=7)))]),
  T("what's due on sunday", rows("boots", "call_kasia", "+1"),
    ref=[ans(kind="task", when=J(U("week", 0, weekday=7)))]),
  T("which of those take more than half an hour", rows("boots"),
    ref=[ans(within="@prev", where="effort > 30")]))

S("T31-241", "decline-out-of-scope share folder then contents before-2026 star",
  T("share the flat folder with kuba", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok what's in it", rows("d_lease25", "d_lease26", "d_inventory", "d_boiler"),
    ref=[ans(kind="document", linked_to="$flat_f")]),
  T("which of those are from before 2026", rows("d_lease25", "d_inventory"),
    ref=[ans(within="@prev", when=J({"to": D("2025-12-31")}))]),
  T("star them", diff(upd("d_lease25", starred=True), upd("d_inventory", starred=True)),
    ref=[act("star", rows="@2")]))

S("T31-242", "decline-out-of-scope phone mama then last-spoke log next-call",
  T("call mama for me", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok when did i last speak to mama", rows("mama"),
    ref=[ans(kind="person", name="mama")]),
  T("log a call with mama, i rang her myself just now", diff(upd("mama", date=ANY)),
    ref=[act("log", kind="person", name="mama", args="kind: call")]),
  T("and when's my next call with mama in the diary", rows("mama_1108"),
    ref=[ans(kind="event", name="call mama", order="date asc", limit=1, when=J({"from": U("day", 0)}))]))

