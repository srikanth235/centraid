from gold import *
import json

world("T11", "2026-07-26T07:30", "Siobhan Kelly", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T11-C001", "c3c compound edit pin delete notes",
  T("pin the lame cow note and delete the untitled one",
    diff(upd("lame_cow", pinned=True), trash("blank")),
    ref=[act("edit", kind="note", name="Lame cow", args=lines(pinned="yes"), more=True),
         act("delete", kind="note", name="Untitled")]))

S("T11-C002", "c3c compound add_to add_to separate targets",
  T("file the scc report under herd records and the fencing quote under department",
    diff(link("herd_f", "scc_report"), link("dept_f", "fence_quote")),
    ref=[act("add_to", kind="document", name="SCC report", args=lines(to="$herd_f"), more=True),
         act("add_to", kind="document", name="Fencing quote", args=lines(to="$dept_f"))]))

S("T11-C101", "c3c bulk delete per kind last year find multi-kind",
  T('wipe everything from last year', diff(trash("tb_cert"), trash("house_policy"), trash("farm_policy"), trash("p_kilkee_beach"), unlink("kilkee_al", "p_kilkee_beach"), trash("p_kilkee_chips"), unlink("kilkee_al", "p_kilkee_chips"), trash("p_pollock"), unlink("kilkee_al", "p_pollock"), trash("p_xmas"), unlink("family_al", "p_xmas"), trash("p_show_2025")),
    ref=[find(kind="event,task,note,document,photo", when=W(U("year", -1))),
         act("delete", rows="$tb_cert, $house_policy, $farm_policy", more=True),
         act("delete", rows="$p_kilkee_beach, $p_kilkee_chips, $p_pollock, $p_xmas, $p_show_2025")]))

S("T11-C901", "c3c cell7 empty recovery wrong kind",
  T("where's my herd register", rows("herd_register"),
    ref=[find(kind="note", name="herd register"), ans(kind="document", name="herd register")]),
  T("what's on from the 28th at 9am to the end of next week", rows("tb_read", "noreen_coffee", "hoof", "u12_0729", "tb_test", "show", "draw_0802", "ortho", "mass"),
    ref=[ans(kind="event", when=W(span(D("2026-07-28", "09:00"), U("week", 1))))]))
