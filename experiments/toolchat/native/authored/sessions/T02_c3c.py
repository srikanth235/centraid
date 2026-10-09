from gold import *
import json

world("T02", "2027-06-08T11:05", "Mei-Lin Chau", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T02-C001", "c3c compound complete create two writes",
  T("tick off the hydro bill and remind me to email dana about the cover thursday",
    diff(upd("hydro", status="completed", completed=ANY), new("task", name=has("dana", "cover"), date="2027-06-10")),
    ref=[act("complete", kind="task", name="Pay hydro bill", more=True),
         act("create", args=lines(kind="task", name="Email Dana about the cover", date=U("week", 0, weekday=4)))]))

S("T02-C002", "c3c compound add_to star referential read",
  T("move my cv into portfolio and star it",
    diff(link("portfolio_f", "cv"), upd("cv", starred=True)),
    ref=[act("add_to", kind="document", name="CV", args=lines(to="$portfolio_f"), more=True),
         act("star", rows="$cv")]),
  T("what's in portfolio now", rows("portfolio_pdf", "hg_series", "editorial", "dummy", "cv"),
    ref=[ans(kind="document", linked_to="$portfolio_f")]))

S("T02-C003", "c3c compound three writes cancel reschedule create",
  T("cancel the illustrators meetup, push the dentist to friday week at 10 and book coffee with rachel thursday at 4",
    diff(upd("meetup", status="cancelled"), upd("dentist", date="2027-06-25T10:00"),
         new("event", name=has("rachel"), date="2027-06-10T16:00")),
    ref=[act("cancel", kind="event", name="Illustrators meetup", more=True),
         act("reschedule", kind="event", name="Dentist cleaning", args=lines(to=U("week", 2, weekday=5, time="10:00")), more=True),
         act("create", args=lines(kind="event", name="Coffee with Rachel", date=U("week", 0, weekday=4, time="16:00")))]))

S("T02-C004", "c3c compound delete restore separate targets",
  T("delete the fox courier dummy and bring portfolio 2024 back from the trash",
    diff(trash("dummy"), restore("old_portfolio")),
    ref=[act("delete", kind="document", name="Fox courier picture book dummy", more=True),
         act("restore", kind="document", name="Portfolio 2024", trashed=True)]))

S("T02-C101", "c3c bulk delete per kind last year two kinds",
  T('delete the photos and documents from last year', diff(trash("balance_rock"), unlink("hg_album", "balance_rock"), trash("tow_hill"), unlink("hg_album", "tow_hill"), trash("agate"), unlink("hg_album", "agate"), trash("masset"), unlink("hg_album", "masset"), trash("totem"), unlink("hg_album", "totem"), trash("ferry_pic"), unlink("hg_album", "ferry_pic"), trash("rainforest"), unlink("hg_album", "rainforest"), trash("cabin_porch"), unlink("hg_album", "cabin_porch"), trash("mina_sketch"), unlink("hg_album", "mina_sketch"), trash("eagle"), unlink("hg_album", "eagle"), trash("carving"), unlink("hg_album", "carving"), trash("tlell"), unlink("hg_album", "tlell"), trash("hg_series"), trash("lease"), trash("tenant_doc")),
    ref=[find(kind="photo", when=W(U("year", -1))),
         act("delete", rows="@prev", more=True),
         find(kind="document", when=W(U("year", -1))),
         act("delete", rows="@prev")]))

S("T02-C901", "c3c cell7 empty recovery misspelled search then span",
  T("when's the farmers markit", rows("farmers"),
    ref=[find(kind="event", name="markit"), search("farmers markit", kind="event"), ans(rows="$farmers")]),
  T("what's due between the 9th at noon and the 14th at 5pm", rows("inv_mf", "tomo_logo", "gl_colour", "soap_1", "tap", "gl_sketches", "gl_send", "clay_tools", "thankyou", "rachel_followup"),
    ref=[ans(kind="task", when=W(span(D("2027-06-09", "12:00"), D("2027-06-14", "17:00"))))]))

S("T02-C902", "c3c cell7 rejected star note ask then pin",
  T('star the crow studies note', ask(),
    ref=[bad(act("star", kind="note", name="Crow studies")), askc("notes can't be starred, only pinned. pin the crow studies note?")]),
  T('yes pin it', diff(upd("crows", pinned=True)),
    ref=[act("edit", rows="$crows", args=lines(pinned="yes"))]))
