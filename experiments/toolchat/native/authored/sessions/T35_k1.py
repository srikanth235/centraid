from gold import *
import json

world("T35", "2026-11-12T19:20", "Freya Lindqvist", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T35-K001", "decline not_found document find miss i3skill S5",
  T("where's the sailmaker invoice", decline("not_found"),
    ref=[find(kind="document", name="sailmaker invoice"), dec("not_found")]))

S("T35-K002", "decline out_of_scope email after read i3skill S5",
  T("when's the tax meeting", rows("tax_meeting"),
    ref=[ans(kind="event", name="Tax")]),
  T("email elin the figures before then", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T35-K003", "decline weather then read flight then check in i3skill S5",
  T("what's the weather in bergen on the 23rd", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("when's my flight to bergen", rows("fly_bergen"),
    ref=[ans(kind="event", name="Flight to Bergen")]),
  T("check me in online", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T35-K004", "decline whatsapp then log call is a write i3skill S5",
  T("whatsapp mamma that we land at ten", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("log that i called mamma", diff(upd("mamma", date=ANY)),
    ref=[act("log", rows="$mamma", args=lines(kind="call"))]))

S("T35-K005", "decline not_found note other kinds hint i3skill S5",
  T("where's my dive log", decline("not_found"),
    ref=[ans(kind="note", name="dive log"), dec("not_found")]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T35-K101", "family word dad mum role i3skill S6",
  T("when did i last talk to dad", rows("pappa"),
    ref=[ans(kind="person", where='role = "dad"')]),
  T("and mum", rows("mamma"),
    ref=[ans(kind="person", where='role = "mum"')]))

S("T35-K102", "iou debt either direction i3skill S6",
  T("any iou with trond", rows("d_trond"),
    ref=[ans(kind="debt", linked_to="$trond")]),
  T("and bjorn", rows("d_bjorn"),
    ref=[ans(kind="debt", linked_to="$bjorn")]))

S("T35-K103", "diary entry means note i3skill S6",
  T("show me my diary entries", rows("diary_ski", "diary_whale"),
    ref=[ans(kind="note", name="Diary entry")]),
  T("which one mentions the fjord", rows("diary_whale"),
    ref=[ans(kind="note", within="@prev", where='body contains "fjord"')]))

# --- S7 look then pick --------------------------------------------------------------------------

S("T35-K201", "ask then jonas's dentist cancel i3skill S7",
  T("cancel the dentist", ask("dentist", "dentist_jonas"),
    ref=[act("cancel", kind="event", name="Dentist")]),
  T("jonas's", diff(upd("dentist_jonas", status="cancelled")),
    ref=[act("cancel", rows="$dentist_jonas")]))

S("T35-K202", "ask then the colleague one log i3skill S7",
  T("log a call with lars", ask("lars_h", "lars_e"),
    ref=[act("log", kind="person", name="Lars", args=lines(kind="call"))]),
  T("the colleague", diff(upd("lars_e", date=ANY)),
    ref=[act("log", rows="$lars_e", args=lines(kind="call"))]))

S("T35-K203", "pick later dinner reschedule i3skill S7",
  T("when's dinner with astrid", rows("dinner_astrid_old", "dinner_astrid"),
    ref=[ans(kind="event", name="Dinner with Astrid")]),
  T("push the later one to 8", diff(upd("dinner_astrid", date="2026-11-21T20:00")),
    ref=[act("reschedule", rows="$dinner_astrid", args=lines(to=D("2026-11-21", "20:00")))]))

S("T35-K204", "other two subtasks reschedule i3skill S7",
  T("what's left under the cod survey", rows("cod_gear", "cod_echo", "cod_crew", "cod_risk"),
    ref=[ans(kind="task", linked_to="$cod")]),
  T("ordered the gear and calibrated the echosounder", diff(upd("cod_gear", status="completed", completed=ANY), upd("cod_echo", status="completed", completed=ANY)),
    ref=[act("complete", rows="$cod_gear, $cod_echo")]),
  T("push the other two to the fifth of january", diff(upd("cod_crew", date="2027-01-05"), upd("cod_risk", date="2027-01-05")),
    ref=[find(within="@1", exclude="$cod_gear, $cod_echo"), act("reschedule", rows="@prev", args=lines(to=D("2027-01-05")))]))

S("T35-K205", "ask namesakes then i meant my mum log i3skill S7",
  T("log a visit with ingrid", ask("ingrid_m", "mamma"),
    ref=[act("log", kind="person", name="Ingrid", args=lines(kind="visit"))]),
  T("i meant my mum", diff(upd("mamma", date=ANY)),
    ref=[act("log", rows="$mamma", args=lines(kind="visit"))]))
