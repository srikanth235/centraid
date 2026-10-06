from gold import *
import json

world("T20", "2026-05-28T16:10", "Matteo Ricci", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T20-K001", "decline not_found other kind hint i3skill S5",
  T("when is the stag weekend", rows("stag_weekend"),
    ref=[ans(kind="event", name="Stag weekend")]),
  T("do i have a note called stag weekend", decline("not_found"),
    ref=[ans(kind="note", name="Stag weekend"), dec("not_found")]))

S("T20-K002", "decline not_found find miss i3skill S5",
  T("find me the cellar insurance doc", decline("not_found"),
    ref=[find(kind="document", name="insurance"), dec("not_found")]))

S("T20-K003", "decline not_found search then out_of_scope remind other i3skill S5",
  T("any notes about the porcini supplier", decline("not_found"),
    ref=[search("porcini", kind="note"), dec("not_found")]),
  T("remind giulia about the keys on monday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("remind me to call mauro on monday", diff(new("task", name=has("mauro"), date="2026-06-01")),
    ref=[act("create", args=lines(kind="task", name="Call Mauro", date=U("week", 1, weekday=1)))]))

S("T20-K004", "decline out_of_scope call him after read i3skill S5",
  T("when's the plumber coming", rows("plumber_visit"),
    ref=[ans(kind="event", name="Plumber")]),
  T("call nicola and ask if he can come earlier", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T20-K005", "decline weather no field then read then book i3skill S5",
  T("what's the weather doing on gran fondo day", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok when is the gran fondo", rows("gran_fondo"),
    ref=[ans(kind="event", name="Chianti gran fondo")]),
  T("book me a hotel in greve the night before", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T20-K006", "decline pay someone outside vault then balance read i3skill S5",
  T("send gianni the 150 i owe him for the packing stuff", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("where am i with gianni", val((-150, "EUR")),
    ref=[ans(op="balance", kind="person", name="Gianni")]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T20-K101", "family word mother grandmother role i3skill S6",
  T("when did i last see my mother", rows("mamma"),
    ref=[ans(kind="person", where='role = "mother"')]),
  T("and my grandmother", rows("nonna"),
    ref=[ans(kind="person", where='role = "grandmother"')]))

S("T20-K102", "iou debt either direction i3skill S6",
  T("do i have an iou with federico", rows("d_fede"),
    ref=[ans(kind="debt", linked_to="$federico")]),
  T("and with giulia", rows("d_giulia"),
    ref=[ans(kind="debt", linked_to="$giulia")]))

S("T20-K103", "a note about body search pin i3skill S6",
  T("that note about saddle height", rows("bike_fit"),
    ref=[ans(kind="note", where='body contains "saddle"')]),
  T("pin it", diff(upd("bike_fit", pinned=True)),
    ref=[act("edit", rows="$bike_fit", args=lines(pinned="yes"))]))

S("T20-K104", "family word father log call i3skill S6",
  T("log a call with my father, he rang about the movers", diff(upd("papa", date=ANY)),
    ref=[find(kind="person", where='role = "father"'), act("log", rows="@prev", args=lines(kind="call"))]))

S("T20-K105", "list word is a document name i3skill S6",
  T("is the guest list spreadsheet in the wedding folder", rows("guest_sheet"),
    ref=[ans(kind="document", name="Guest list", linked_to="$wedding_f")]))

# --- S7 look then pick --------------------------------------------------------------------------

S("T20-K201", "pick later dentist cancel i3skill S7",
  T("what dentist stuff do i have", rows("dentist_may", "dentist_jun"),
    ref=[ans(kind="event", name="Dentist")]),
  T("cancel the later one", diff(upd("dentist_jun", status="cancelled")),
    ref=[act("cancel", rows="$dentist_jun")]))

S("T20-K202", "ask then not the chef one star i3skill S7",
  T("star lorenzo", ask("lorenzo_r", "lorenzo_g"),
    ref=[act("star", kind="person", name="Lorenzo")]),
  T("not the chef one", diff(upd("lorenzo_r", starred=True)),
    ref=[act("star", rows="$lorenzo_r")]))

S("T20-K203", "other two subtasks complete i3skill S7",
  T("what's under the utilities task", rows("enel", "gas", "internet"),
    ref=[ans(kind="task", linked_to="$utilities")]),
  T("done the gas one", diff(upd("gas", status="completed", completed=ANY)),
    ref=[act("complete", rows="$gas")]),
  T("and the other two", diff(upd("enel", status="completed", completed=ANY), upd("internet", status="completed", completed=ANY)),
    ref=[find(within="@1", exclude="$gas"), act("complete", rows="@prev")]))

S("T20-K204", "earlier later tastings reschedule the later one i3skill S7",
  T("when are the tastings with francesca", rows("tasting_fra_1", "tasting_fra_2"),
    ref=[ans(kind="event", linked_to="$francesca")]),
  T("move the later one to the twelfth at three", diff(upd("tasting_fra_2", date="2026-06-12T15:00")),
    ref=[act("reschedule", rows="$tasting_fra_2", args=lines(to=D("2026-06-12", "15:00")))]))

S("T20-K205", "pick by who attends nickname reschedule i3skill S7",
  T("any events with matilde", rows("planner_meet", "menu_tasting"),
    ref=[ans(kind="event", linked_to="$matilde")]),
  T("move the one with enzo to 1pm", diff(upd("menu_tasting", date="2026-06-11T13:00")),
    ref=[act("reschedule", rows="$menu_tasting", args=lines(to=D("2026-06-11", "13:00")))]))
