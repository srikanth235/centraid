from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T31-K001", "decline not_found photos other kinds hint i3skill S5",
  T("any photos from the stag do", decline("not_found"),
    ref=[find(kind="photo", name="stag do"), search("stag", kind="photo"), dec("not_found")]))

S("T31-K002", "decline not_found locker item other kind hint i3skill S5",
  T("what's my gym membership number", decline("not_found"),
    ref=[ans(kind="locker item", name="gym membership"), dec("not_found")]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T31-K101", "family word dad mum role i3skill S6",
  T("when did i last talk to dad", rows("tata"),
    ref=[ans(kind="person", where='role = "dad"')]),
  T("and mum", rows("mama"),
    ref=[ans(kind="person", where='role = "mum"')]))

S("T31-K102", "list word is a document and a task name i3skill S6",
  T("is the flat inventory list in the flat folder", rows("d_inventory"),
    ref=[ans(kind="document", name="Flat inventory list", linked_to="$flat_f")]),
  T("when's the zakopane packing list due", rows("zak_pack"),
    ref=[ans(kind="task", name="Zakopane packing list")]))

S("T31-K103", "iou debt both directions same person i3skill S6",
  T("any ious with kuba", rows("d_kuba_gas", "d_kuba_net"),
    ref=[ans(kind="debt", linked_to="$kuba")]),
  T("and darek", rows("d_darek_pizza"),
    ref=[ans(kind="debt", linked_to="$darek")]))

S("T31-K104", "diary entry means note i3skill S6",
  T("show my diary entries", rows("n_diary_shift", "n_diary_good"),
    ref=[ans(kind="note", name="Diary entry")]),
  T("which one mentions pizza", rows("n_diary_good"),
    ref=[ans(kind="note", within="@prev", where='body contains "pizza"')]))

# --- S7 look then pick --------------------------------------------------------------------------

S("T31-K201", "pick later dentist reschedule i3skill S7",
  T("when's my dentist", rows("dentist_ev", "dentist_ev2"),
    ref=[ans(kind="event", name="Dentist check-up")]),
  T("push the later one to 4", diff(upd("dentist_ev", date="2026-11-19T16:00")),
    ref=[act("reschedule", rows="$dentist_ev", args=lines(to=D("2026-11-19", "16:00")))]))

S("T31-K202", "ask then the nurse one log i3skill S7",
  T("log a call with marcin", ask("marcin_l", "marcin_b"),
    ref=[act("log", kind="person", name="Marcin", args=lines(kind="call"))]),
  T("the nurse", diff(upd("marcin_b", date=ANY)),
    ref=[act("log", rows="$marcin_b", args=lines(kind="call"))]))

S("T31-K203", "ask then not the friend star i3skill S7",
  T("star anna", ask("anna_w", "anna_wl"),
    ref=[act("star", kind="person", name="Anna")]),
  T("not the friend", diff(upd("anna_w", starred=True)),
    ref=[act("star", rows="$anna_w")]))

S("T31-K204", "other two subtasks reschedule i3skill S7",
  T("what's left under the london christmas trip", rows("london_gifts", "london_pounds", "london_pack"),
    ref=[ans(kind="task", linked_to="$london_trip")]),
  T("bought the presents", diff(upd("london_gifts", status="completed", completed=ANY)),
    ref=[act("complete", rows="$london_gifts")]),
  T("move the other two to the 13th", diff(upd("london_pounds", date="2026-11-13"), upd("london_pack", date="2026-11-13")),
    ref=[find(within="@1", exclude="$london_gifts"), act("reschedule", rows="@prev", args=lines(to=D("2026-11-13")))]))

S("T31-K205", "pick the second one cancel i3skill S7",
  T("when's the shoulder physio", rows("physio_a", "physio_b"),
    ref=[ans(kind="event", name="Physio - shoulder")]),
  T("cancel the second one", diff(upd("physio_b", status="cancelled")),
    ref=[act("cancel", rows="$physio_b")]))
