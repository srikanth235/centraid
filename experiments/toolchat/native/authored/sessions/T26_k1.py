from gold import *
import json

world("T26", "2026-11-24T05:30", "Ahmed Bello", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T26-K001", "decline not_found document other kinds hint i3skill S5",
  T("where's my aso ebi receipt", decline("not_found"),
    ref=[find(kind="document", name="aso ebi receipt"), dec("not_found")]))

S("T26-K002", "decline not_found document after a read i3skill S5",
  T("when's the dentist for femi", rows("dentist_femi"),
    ref=[ans(kind="event", name="Dentist for Femi")]),
  T("and his x-ray report", decline("not_found"),
    ref=[ans(kind="document", name="x-ray report"), dec("not_found")]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T26-K101", "family word mother sister role i3skill S6",
  T("when did i last talk to my mother", rows("mama"),
    ref=[ans(kind="person", where='role contains "mother"')]),
  T("and my sister", rows("aisha"),
    ref=[ans(kind="person", where='role contains "sister"')]))

S("T26-K102", "list word is a note name not the list kind i3skill S6",
  T("open the guest list for mama's 70th", rows("guest_list"),
    ref=[ans(kind="note", name="Guest list for Mama's 70th")]),
  T("and the party menu", rows("party_menu"),
    ref=[ans(kind="note", name="Party menu")]))

S("T26-K103", "iou debt either direction i3skill S6",
  T("any ious with bayo", rows("d_bayo"),
    ref=[ans(kind="debt", linked_to="$bayo")]),
  T("and with victor", rows("d_victor"),
    ref=[ans(kind="debt", linked_to="$victor")]))

S("T26-K104", "a note about body search then which notebook i3skill S6",
  T("that note about the soakaway", rows("archi_n"),
    ref=[ans(kind="note", where='body contains "soakaway"')]),
  T("which notebook is it in", rows("house_nb"),
    ref=[ans(kind="notebook", linked_to="$archi_n")]))

# --- S7 look then pick --------------------------------------------------------------------------

S("T26-K201", "ask then kemi's dentist cancel i3skill S7",
  T("cancel the dentist", ask("dentist_femi", "dentist_kemi"),
    ref=[act("cancel", kind="event", name="Dentist")]),
  T("kemi's", diff(upd("dentist_kemi", status="cancelled")),
    ref=[act("cancel", rows="$dentist_kemi")]))

S("T26-K202", "ask then not the cousin one log i3skill S7",
  T("log a call with kunle", ask("kunle_b", "kunle_a"),
    ref=[act("log", kind="person", name="Kunle", args=lines(kind="call"))]),
  T("not the cousin", diff(upd("kunle_a", date=ANY)),
    ref=[act("log", rows="$kunle_a", args=lines(kind="call"))]))

S("T26-K203", "ask then the crane operator star i3skill S7",
  T("star emeka", ask("emeka_n", "emeka_o"),
    ref=[act("star", kind="person", name="Emeka")]),
  T("the crane operator", diff(upd("emeka_o", starred=True)),
    ref=[act("star", rows="$emeka_o")]))

S("T26-K204", "other two subtasks reschedule i3skill S7",
  T("what's under wire the new house", rows("cables", "db_board", "sockets"),
    ref=[ans(kind="task", linked_to="$wiring")]),
  T("marked the socket positions", diff(upd("sockets", status="completed", completed=ANY)),
    ref=[act("complete", rows="$sockets")]),
  T("push the other two to friday", diff(upd("cables", date="2026-11-27"), upd("db_board", date="2026-11-27")),
    ref=[find(within="@1", exclude="$sockets"), act("reschedule", rows="@prev", args=lines(to=U("week", 0, weekday=5)))]))

S("T26-K205", "pick the one for kemi complete i3skill S7",
  T("what school fees are still open", rows("fees_tobi", "fees_kemi"),
    ref=[ans(kind="task", name="school fees", where="status = open")]),
  T("tick off the one for kemi", diff(upd("fees_kemi", status="completed", completed=ANY)),
    ref=[act("complete", rows="$fees_kemi")]))
