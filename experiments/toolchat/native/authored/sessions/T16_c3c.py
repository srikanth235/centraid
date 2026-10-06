from gold import *
import json

world("T16", "2026-12-16T18:00", "Rafiq Chowdhury", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T16-C001", "c3c compound delete create event at N",
  T("delete the jersey pickup and put a new one in friday at 5",
    diff(trash("kit_pickup"), new("event", name=has("jersey"), date="2026-12-18T17:00")),
    ref=[act("delete", kind="event", name="Collect new jerseys", more=True),
         act("create", args=lines(kind="event", name="Collect new jerseys", date=U("week", 0, weekday=5, time="17:00")))]))

S("T16-C002", "c3c compound edit reschedule event same target",
  T("rename the tea with topu to Chai with Topu and push it to 6",
    diff(upd("tea_topu", name="Chai with Topu", date="2026-12-20T18:00")),
    ref=[act("edit", kind="event", name="Tea with Topu", args=lines(name="Chai with Topu"), more=True),
         act("reschedule", rows="$tea_topu", args=lines(to=U("day", 0, anchor="row", time="18:00")))]))

S("T16-C003", "c3c compound star add_to photo",
  T("star the sunset from the roof and put it in the family album",
    diff(upd("sunset_roof", starred=True), link("family_album", "sunset_roof")),
    ref=[act("star", kind="photo", name="Sunset from the roof", more=True),
         act("add_to", rows="$sunset_roof", args=lines(to="$family_album"))]))

S("T16-C004", "c3c compound three writes complete settle_debt log",
  T("overtime list is in, tick it off, settle selim's cng fare and log a call with masud",
    diff(upd("overtime", status="completed", completed=ANY), upd("d_selim", status="settled"), upd("masud", date=ANY)),
    ref=[act("complete", kind="task", name="overtime list", more=True),
         act("settle_debt", kind="debt", name="CNG fare to Gazipur", more=True),
         act("log", kind="person", name="Masud", args=lines(kind="call"))]))

S("T16-C101", "c3c bulk delete per kind before this year find multi-kind",
  T('delete everything before this year', diff(trash("eid24_gifts"), trash("eid25_gifts"), trash("eid25_list"), trash("deed"), trash("mutation"), trash("appointment"), trash("tin"), trash("team_2025"), unlink("tigers_album", "team_2025"), trash("victory_2025"), unlink("victory_album", "victory_2025"), trash("old_team")),
    ref=[find(kind="event,task,note,document,photo", when=W({"to": U("year", -1)})),
         act("delete", rows="$eid24_gifts, $eid25_gifts, $eid25_list", more=True),
         act("delete", rows="$deed, $mutation, $appointment, $tin", more=True),
         act("delete", rows="$team_2025, $victory_2025, $old_team")]))

S("T16-C901", "c3c cell7 empty recovery act none search miss then span",
  T('cancel the board meeting', decline("not_found"),
    ref=[act("cancel", kind="event", name="board meeting"), search("board meeting", kind="event"), dec("not_found")]),
  T('photos from the start of the month to the 5th at 4pm', rows("scoreboard", "rahim_wickets"),
    ref=[ans(kind="photo", when=W(span(U("month", 0), D("2026-12-05", "16:00"))))]))

S("T16-C902", "c3c cell7 rejected person starred then undo create",
  T('add Dr Anwar Sheikh, the new dentist, and star him', diff(new("person", name="Dr Anwar Sheikh", role=ANY, starred=True)),
    ref=[bad(act("create", args=lines(kind="person", name="Dr Anwar Sheikh", role="dentist", starred="yes"))), act("create", args=lines(kind="person", name="Dr Anwar Sheikh", role="dentist"), more=True), act("star", rows="$new")]),
  T("can you undo that, i don't need a dentist", diff(trash("+1")),
    ref=[act("undo")]))

S("T16-C903", "c3c cell7 rejected priority word then undo after create",
  T('add a task to pay the generator man, high priority, due friday', diff(new("task", name="Pay the generator man", date="2026-12-18", priority=1)),
    ref=[bad(act("create", args=lines(kind="task", name="Pay the generator man", date=U("week", 0, weekday=5), priority="high"))), act("create", args=lines(kind="task", name="Pay the generator man", date=U("week", 0, weekday=5), priority=1))]),
  T('can you undo that, he already got paid', diff(trash("+1")),
    ref=[act("undo")]))
