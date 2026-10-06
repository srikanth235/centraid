from gold import *
import json

world("T09", "2026-05-13T08:05", "Hanae Okafor", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T09-C001", "c3c compound settle_debt star referential",
  T("kemi paid me for brunch, settle that and star her, she's covering the shower",
    diff(upd("d_kemi", status="settled"), upd("kemi", starred=True)),
    ref=[act("settle_debt", kind="debt", name="Brunch", more=True),
         search("kemi", kind="person"), act("star", rows="@prev")]))

S("T09-C002", "c3c compound reschedule reschedule at N bare weekday",
  T("push the florist consult to thursday at 1 and the cake tasting to saturday at 3",
    diff(upd("florist", date="2026-05-14T13:00"), upd("cake", date="2026-05-16T15:00")),
    ref=[act("reschedule", kind="event", name="Florist consult", args=lines(to=U("week", 0, weekday=4, time="13:00")), more=True),
         act("reschedule", kind="event", name="Cake tasting", args=lines(to=U("week", 0, weekday=6, time="15:00")))]))

S("T09-C003", "c3c compound complete create event",
  T("nda's done, tick it off, and book a catch up with naomi thursday at 5",
    diff(upd("nda", status="completed", completed=ANY), new("event", name=has("naomi"), date="2026-05-14T17:00")),
    ref=[act("complete", kind="task", name="NDA", more=True),
         act("create", args=lines(kind="event", name="Catch up with Naomi", date=U("week", 0, weekday=4, time="17:00")))]))

S("T09-C004", "c3c compound three writes create person add_to group star new",
  T("add Zoe Park, the new articling student, put her in bar prep and star her",
    diff(new("person", name="Zoe Park", role=ANY, starred=True), link("barprep", "new")),
    ref=[act("create", args=lines(kind="person", name="Zoe Park", role="articling student"), more=True),
         act("add_to", rows="$new", args=lines(to="$barprep"), more=True),
         act("star", rows="$new")]))

S("T09-C101", "c3c bulk delete per kind last year find multi-kind undo",
  T('delete everything from last year', diff(trash("bylaws"), trash("lso_card"), trash("proposal"), unlink("eng_album", "proposal"), trash("ring"), unlink("eng_album", "ring"), trash("dad_grill"), unlink("fam_album", "dad_grill"), trash("ada_grad"), unlink("fam_album", "ada_grad"), trash("xmas"), unlink("fam_album", "xmas")),
    ref=[find(kind="event,task,note,document,photo", when=W(U("year", -1))),
         act("delete", rows="$bylaws, $lso_card", more=True),
         act("delete", rows="$proposal, $ring, $dad_grill, $ada_grad, $xmas")]),
  T("wait undo that, i want the proposal pics", diff(restore("bylaws"), restore("lso_card"), restore("proposal"), link("eng_album", "proposal"), restore("ring"), link("eng_album", "ring"), restore("dad_grill"), link("fam_album", "dad_grill"), restore("ada_grad"), link("fam_album", "ada_grad"), restore("xmas"), link("fam_album", "xmas")),
    ref=[act("undo")]))

S("T09-C901", "c3c cell7 search miss question decline then span",
  T('is there a note about the cottage', decline("not_found"),
    ref=[search("cottage", kind="note"), dec("not_found")]),
  T('notes from the 8th to the 12th at 9pm', rows("gift_nana", "songs", "run_log"),
    ref=[ans(kind="note", when=W(span(D("2026-05-08"), D("2026-05-12", "21:00"))))]))
