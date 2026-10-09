from gold import *
import json

world("T27", "2026-12-03T04:50", "Sophie Dubois", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T27-K001", "decline not_found document other kind hint i3skill S5",
  T("is there a document for the lyon rental", decline("not_found"),
    ref=[ans(kind="document", name="Lyon rental"), dec("not_found")]))

S("T27-K002", "decline out_of_scope call after read i3skill S5",
  T("when's the oven inspection", rows("oven_check"),
    ref=[ans(kind="event", name="Oven inspection")]),
  T("call olivier and ask if he can come tuesday instead", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T27-K003", "decline weather then read then order i3skill S5",
  T("will it rain on opening day", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("what time is opening day", rows("opening"),
    ref=[ans(kind="event", name="Opening day")]),
  T("order twenty more cake boxes from the packaging site", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T27-K004", "decline not_found note find then search i3skill S5",
  T("any notes about the lyon bakery", decline("not_found"),
    ref=[find(kind="note", name="Lyon bakery"), search("lyon", kind="note"), dec("not_found")]))

S("T27-K005", "decline message then log message is a write i3skill S5",
  T("tell julien i'll be home late", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok log that i messaged him", diff(upd("julien", date=ANY)),
    ref=[act("log", rows="$julien", args=lines(kind="message"))]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T27-K101", "family word grandmother father role i3skill S6",
  T("when did i last call my grandmother", rows("odette"),
    ref=[ans(kind="person", where='role = "grandmother"')]),
  T("and my father", rows("bernard"),
    ref=[ans(kind="person", where='role contains "father"')]))

S("T27-K102", "iou debt either direction i3skill S6",
  T("any ious with chloe", rows("d_chloe", "d_chloe2"),
    ref=[ans(kind="debt", linked_to="$chloe")]),
  T("and with lea", rows("d_lea"),
    ref=[ans(kind="debt", linked_to="$lea")]))

S("T27-K103", "a note about body search pin i3skill S6",
  T("that note about the steam", rows("oven_manual"),
    ref=[ans(kind="note", where='body contains "steam"')]),
  T("pin it", diff(upd("oven_manual", pinned=True)),
    ref=[act("edit", rows="$oven_manual", args=lines(pinned="yes"))]))

# --- S7 look then pick --------------------------------------------------------------------------

S("T27-K201", "pick later midwife reschedule i3skill S7",
  T("when are my midwife appointments", rows("midwife_nov", "midwife_dec"),
    ref=[ans(kind="event", name="Midwife appointment")]),
  T("move the later one to 11", diff(upd("midwife_dec", date="2026-12-10T11:00")),
    ref=[act("reschedule", rows="$midwife_dec", args=lines(to=D("2026-12-10", "11:00")))]))

S("T27-K202", "ask then not the bakery one log i3skill S7",
  T("log a call with camille", ask("camille_r", "camille_p"),
    ref=[act("log", kind="person", name="Camille", args=lines(kind="call"))]),
  T("not the bakery one", diff(upd("camille_p", date=ANY)),
    ref=[act("log", rows="$camille_p", args=lines(kind="call"))]))

S("T27-K203", "ask then the miller one star i3skill S7",
  T("star thomas", ask("thomas_m", "thomas_g"),
    ref=[act("star", kind="person", name="Thomas")]),
  T("the miller one", diff(upd("thomas_g", starred=True)),
    ref=[act("star", rows="$thomas_g")]))

S("T27-K204", "other two subtasks complete i3skill S7",
  T("what's left under opening day prep", rows("bake_night", "display", "brief"),
    ref=[ans(kind="task", linked_to="$prep")]),
  T("i set up the display case", diff(upd("display", status="completed", completed=ANY)),
    ref=[act("complete", rows="$display")]),
  T("tick the other two as well", diff(upd("bake_night", status="completed", completed=ANY), upd("brief", status="completed", completed=ANY)),
    ref=[find(within="@1", exclude="$display"), act("complete", rows="@prev")]))

S("T27-K205", "pick by description debt settle i3skill S7",
  T("what does chloe owe me", rows("d_chloe", "d_chloe2"),
    ref=[ans(kind="debt", linked_to="$chloe")]),
  T("settle the flowers one", diff(upd("d_chloe2", status="settled")),
    ref=[act("settle_debt", rows="$d_chloe2")]))
