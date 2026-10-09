from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-166", "ambiguous-person log visit two marcins pick captain",
  T("log a visit with marcin", ask("marcin_l", "marcin_b"),
    ref=[act("log", kind="person", name="marcin", args="kind: visit")]),
  T("the five-a-side captain", diff(upd("marcin_l", date=ANY)),
    ref=[act("log", kind="person", name="marcin", where='role contains "captain"', args="kind: visit")]))

S("T31-167", "ambiguous-task reopen pay rent two done pick september",
  T("reopen pay rent", ask("rent_sep", "rent_oct"),
    ref=[act("reopen", kind="task", name="pay rent")]),
  T("the september one", diff(upd("rent_sep", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="pay rent", when=J(U("month", -1, name=9)))]))

S("T31-168", "ambiguous-person star agnieszka two pick zakopane",
  T("star agnieszka", ask("agnieszka", "agnieszka_n"),
    ref=[act("star", kind="person", name="agnieszka")]),
  T("the one i met in zakopane", diff(upd("agnieszka", starred=True)),
    ref=[act("star", kind="person", name="agnieszka", where='met = "Zakopane"')]))

S("T31-169", "ambiguous-event delete night shift swap two pick october",
  T("delete the night shift swap", ask("night_swap", "night_swap_old"),
    ref=[act("delete", kind="event", name="night shift swap")]),
  T("the one in october", diff(trash("night_swap_old")),
    ref=[act("delete", kind="event", name="night shift swap", when=J(U("month", -1, name=10)))]),
  T("bring the swap shift back", diff(restore("night_swap_old")),
    ref=[find(kind="event", name="swap", trashed=True), act("restore", rows="@1")]))

S("T31-170", "ambiguous-event cancel dentist past and coming pick nineteenth",
  T("cancel the dentist", ask("dentist_ev", "dentist_ev2"),
    ref=[act("cancel", kind="event", name="dentist")]),
  T("the one on the 19th", diff(upd("dentist_ev", status="cancelled")),
    ref=[act("cancel", kind="event", name="dentist", when=J(D("2026-11-19")))]))

S("T31-171", "ambiguous-note pin diary entry two pick patient",
  T("pin the diary entry", ask("n_diary_shift", "n_diary_good"),
    ref=[act("edit", kind="note", name="diary entry", args="pinned: yes")]),
  T("the one where i lost a patient", diff(upd("n_diary_shift", pinned=True)),
    ref=[act("edit", kind="note", name="diary entry", where='body contains "patient"', args="pinned: yes")]))
