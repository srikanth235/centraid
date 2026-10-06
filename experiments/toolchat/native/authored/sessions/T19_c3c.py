from gold import *
import json

world("T19", "2026-04-14T20:40", "Fatima Al-Sayed", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T19-C001", "c3c compound complete create task list",
  T("called the plumber, tick that off and add pay khalid on the home list friday",
    diff(upd("sink", status="completed", completed=ANY), new("task", name=has("khalid"), date="2026-04-17"), link("home_l", "new")),
    ref=[act("complete", kind="task", name="Call the plumber about the kitchen sink", more=True),
         act("create", args=lines(kind="task", name="Pay Khalid", date=U("week", 0, weekday=5), list="$home_l"))]))

S("T19-C002", "c3c compound add_to person log referential",
  T("add rkia to baba's care group and log a call with her",
    diff(link("baba_care", "rkia"), upd("rkia", date=ANY)),
    ref=[act("add_to", kind="person", name="Rkia", args=lines(to="$baba_care"), more=True),
         act("log", rows="$rkia", args=lines(kind="call"))]))

S("T19-C003", "c3c compound edit star same document referential",
  T("rename scan 0041 to Pharmacy insurance scan and star it",
    diff(upd("scan_41", name="Pharmacy insurance scan", starred=True)),
    ref=[act("edit", kind="document", name="Scan 0041", args=lines(name="Pharmacy insurance scan"), more=True),
         act("star", rows="$scan_41")]))

S("T19-C004", "c3c compound three writes create event create task star",
  T("book lunch with zineb sunday at 1, add a task to bring her dessert and star her",
    diff(new("event", name=has("zineb"), date="2026-04-19T13:00"), new("task", name=has("dessert")), upd("zineb", starred=True)),
    ref=[act("create", args=lines(kind="event", name="Lunch with Zineb", date=U("week", 0, weekday=7, time="13:00")), more=True),
         act("create", args=lines(kind="task", name="Bring Zineb dessert"), more=True),
         act("star", rows="$zineb")]))

S("T19-C101", "c3c bulk delete per kind last year find multi-kind three kinds",
  T('get rid of everything from last year', diff(trash("harira"), trash("msemen"), trash("old_idea"), trash("books"), trash("cnss_card"), trash("vacc_card"), trash("car_ins_doc"), trash("cake_2025"), unlink("a_kids", "cake_2025"), trash("snow"), unlink("a_family", "snow")),
    ref=[find(kind="event,task,note,document,photo", when=W(U("year", -1))),
         act("delete", rows="$harira, $msemen, $old_idea, $books", more=True),
         act("delete", rows="$cnss_card, $vacc_card, $car_ins_doc", more=True),
         act("delete", rows="$cake_2025, $snow")]))

S("T19-C901", "c3c cell7 empty recovery misspelled search then span",
  T("when's the stok count", rows("stock_count"),
    ref=[find(kind="event", name="stok count"), search("stok count", kind="event"), ans(rows="$stock_count")]),
  T('notes since the start of the month up to the 9th at 8pm', rows("staff_apr", "ifrane_plan", "readings", "prices", "teacher_notes", "lina_words"),
    ref=[ans(kind="note", when=W(span(U("month", 0), D("2026-04-09", "20:00"))))]))

S("T19-C902", "c3c cell7 rejected reschedule document ask",
  T('move the pharmacy lease to friday', ask(),
    ref=[bad(act("reschedule", kind="document", name="Pharmacy lease", args=lines(to=U("week", 0, weekday=5)))), askc("documents can't be rescheduled, they keep the date they were added. did you mean a task or an event?")]))
