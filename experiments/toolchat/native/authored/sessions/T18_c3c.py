from gold import *
import json

world("T18", "2026-03-01T11:20", "Jordan Ellis", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T18-C001", "c3c compound complete edit rename",
  T("tick off the ci build and rename the cart physics one to Fix cart wheel physics",
    diff(upd("ci", status="completed", completed=ANY), upd("cart", name="Fix cart wheel physics")),
    ref=[act("complete", kind="task", name="Fix the CI build", more=True),
         act("edit", kind="task", name="Fix cart physics", args=lines(name="Fix cart wheel physics"))]))

S("T18-C002", "c3c compound add_to star photo",
  T("put the tess and mum baking pic in shower ideas and star it",
    diff(link("shower_al", "baking"), upd("baking", starred=True)),
    ref=[act("add_to", kind="photo", name="Tess and Mum baking", args=lines(to="$shower_al"), more=True),
         act("star", rows="$baking")]))

S("T18-C003", "c3c compound delete restore documents",
  T("delete the 27 feb scan and bring back the old resume",
    diff(trash("scan"), restore("resume")),
    ref=[act("delete", kind="document", name="Scan 27 Feb", more=True),
         act("restore", kind="document", name="Resume 2023", trashed=True)]))

S("T18-C101", "c3c bulk delete per kind last year where starred keep photos",
  T('delete my notes from last year and the photos too, but not the starred ones', diff(trash("wren"), trash("dal"), trash("treats"), trash("b_snow"), unlink("biscuit_al", "b_snow"), trash("pax_crowd"), unlink("pax_al", "pax_crowd"), trash("pax_rhys"), unlink("pax_al", "pax_rhys"), trash("pax_ana"), unlink("pax_al", "pax_ana"), trash("baking"), trash("nana_cake")),
    ref=[find(kind="note", when=W(U("year", -1))),
         act("delete", rows="@prev", more=True),
         find(kind="photo", when=W(U("year", -1)), where="starred = no"),
         act("delete", rows="@prev")]))

S("T18-C901", "c3c cell7 empty recovery wrong kind",
  T("where's the vaccination card", rows("vax_card"),
    ref=[find(kind="photo", name="vaccination card"), ans(kind="document", name="vaccination card")]),
  T("who've i talked to from the start of last month to the 25th at 8pm", rows("nadia", "chloe", "marcus", "brooke", "mum", "zoe", "rhys", "oliver", "dan_w", "dad"),
    ref=[ans(kind="person", when=W(span(U("month", -1), D("2026-02-25", "20:00"))))]))
