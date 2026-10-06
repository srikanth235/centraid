from gold import *
import json

world("D", "2026-12-20T19:40", "Marisol Reyes-Kapoor", "eval")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("D-E054", "long tasks before-trip complete reschedule compute",
  T("what do i still need to do before we fly", rows("tk366", "pack_gdl", "tamales", "passports_d", "recital_flowers", "oof", "tk742", "nanny_pay"),
    ref=[ans(kind="task", where="status = open", when=W(span(U("day", 0), D("2026-12-22"))))]),
  T("how long is the packing one", val(120),
    ref=[comp(op="max", field="effort", kind="task", name="pack guadalajara"), ans(value="@prev")]),
  T("tick off the out of office, did it at work", diff(upd("oof", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="out-of-office")]),
  T("got the flowers too, dev picked them up on the way home", diff(upd("recital_flowers", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="flowers")]),
  T("push rosa's pay to the twenty-third", diff(upd("nanny_pay", date="2026-12-23")),
    ref=[act("reschedule", kind="task", name="pay rosa", args=lines(to=D("2026-12-23")))]),
  T("what's still left for tomorrow, so i know how late tonight will be", rows("pack_gdl", "tamales", "passports_d", "tk742"),
    ref=[ans(kind="task", where="status = open", when=W(U("day", 1)))]))

S("D-E055", "subtasks reschedule complete count note",
  T("what are the pieces of gabi's surprise plan", rows("gabi_video", "gabi_venue"),
    ref=[find(kind="task", name="surprise"), ans(kind="task", linked_to="$gabi_gift")]),
  T("book the restaurant is due friday", diff(upd("gabi_venue", date="2026-12-25")),
    ref=[act("reschedule", rows="$gabi_venue", args=lines(to=U("week", 1, weekday=5)))]),
  T("got all the video messages", diff(upd("gabi_video", status="completed", completed=ANY)),
    ref=[act("complete", rows="$gabi_video")]),
  T("how many steps are left", val(1),
    ref=[ans(op="count", kind="task", linked_to="$gabi_gift", where="status = open")]),
  T("note for the party, slideshow at 9 and mariachi at 10", diff(new("note", body=has("mariachi"))),
    ref=[act("create", args=lines(kind="note", name="Note for the party", body="slideshow at 9 and mariachi at 10"))]))

S("D-E056", "person-linked events month",
  T("what's on with mamá this month", rows("call_mama152", "call_mama154", "xmas_eve", "call_mama155"),
    ref=[search("Mamá", kind="person"), ans(kind="event", linked_to="$mama", when=W(U("month", 0)))]),
  T("only the calls, leave the dinner out of it", rows("call_mama152", "call_mama154", "call_mama155"),
    ref=[ans(within="@prev", name="call")]))

S("D-E057", "log twice",
  T("just got off the phone with gabi", rows("gabi", also=diff(upd("gabi", date=ANY))),
    ref=[search("Gabi", kind="person"), act("log", rows="$gabi", args="kind: call", more=True), ans(rows="$gabi")]),
  T("log a call with liz too, she was on the line", diff(upd("liz", date=ANY)),
    ref=[search("Liz", kind="person"), act("log", rows="$liz", args="kind: call")]))

S("D-E058", "trash people restore-refused locker",
  T("who's in the trash, a few contacts from the spring", rows("pp10", "pp151", "pp152"),
    ref=[ans(kind="person", trashed=True)]),
  T("the shah one is a doctor right", rows("pp151"),
    ref=[ans(rows="$pp151")]),
  T("bring her back", decline("out_of_scope", "not_found"),
    ref=[bad(act("restore", rows="$pp151")), dec("out_of_scope")]),
  T("what about the old comcast login", rows("old_login"),
    ref=[ans(kind="locker item", name="comcast", where="type = login", trashed=True)]),
  T("never mind it's fine", decline("never_mind"),
    ref=[dec("never_mind")]))

S("D-E059", "delete person undo",
  T("delete the sam hernandez contact", diff(trash("pp43")),
    ref=[act("delete", kind="person", name="sam hernandez")]),
  T("oops that was the wrong sam, undo", diff(restore("pp43")),
    ref=[act("undo")]),
  T("it's sam martinez i mean, the babysitter we don't use anymore", diff(trash("pp6")),
    ref=[act("delete", kind="person", name="sam martinez")]))

S("D-E060", "group create add remove delete undo",
  T("make a group called ski buddies", diff(new("group", name="Ski Buddies"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Ski Buddies"))]),
  T("add liz and dev to it, they're sharing the cabin", diff(link("+1", "liz"), link("+1", "dev")),
    ref=[act("add_to", rows="$liz, $dev", args="to: $c1")]),
  T("take dev back out", diff(unlink("+1", "dev")),
    ref=[act("remove_from", rows="$dev", args="from: $c1")]),
  T("ok delete the group", diff(gone("+1"), unlink("+1", "me"), unlink("+1", "liz")),
    ref=[act("delete", rows="$c1")]),
  T("undo", diff(),
    ref=[act("undo")]))

S("D-E061", "album create add delete star",
  T("make an album called nochebuena", diff(new("album", name="Nochebuena")),
    ref=[act("create", args=lines(kind="album", name="Nochebuena"))]),
  T("add the posada photo to it", diff(link("+1", "posada_25")),
    ref=[act("add_to", kind="photo", name="posada", args="to: $c1")]),
  T("delete the album", diff(gone("+1"), unlink("+1", "posada_25")),
    ref=[act("delete", rows="$c1")]),
  T("star the posada photo while we're at it, it's my favourite", diff(upd("posada_25", starred=True)),
    ref=[act("star", kind="photo", name="posada")]))

S("D-E062", "list move task",
  T("move the backsplash tile job to the home list", diff(unlink("reno_l", "backsplash"), link("home_l", "backsplash")),
    ref=[act("add_to", kind="task", name="backsplash", args="to: $home_l")]),
  T("how many are left on the kitchen reno", val(4),
    ref=[ans(op="count", kind="task", linked_to="$reno_l", where='status in ("open", "in_progress")')]))

S("D-E063", "event reschedule description rename",
  T("move the posada to 8:30pm, we have to feed the kids", diff(upd("posada", date="2026-12-23T20:30")),
    ref=[act("reschedule", kind="event", name="posada", args=lines(to=U("week", 1, weekday=3, time="20:30")))]),
  T("put bring the cash box on the winter fair", diff(upd("winter_fair", description=has("cash box"))),
    ref=[act("edit", kind="event", name="winter fair", args="description: bring the cash box")]),
  T("call the walkthrough cabinet day", diff(upd("reno_meeting", name="Cabinet day")),
    ref=[act("edit", kind="event", name="walkthrough", args="name: Cabinet day")]))

S("D-E064", "photo star unstar already-so",
  T("star arun's first goal", diff(already=["arun_goal"]),
    ref=[act("star", kind="photo", name="first goal"), ans(rows="$arun_goal")]),
  T("unstar the churro in the snow one, it's blurry", diff(upd("churro_snow", starred=False)),
    ref=[act("unstar", kind="photo", name="churro snow")]))

S("D-E065", "person edit cadence role",
  T("set sunita to every ten days, 14 is too long between calls", diff(upd("sunita", cadence=10)),
    ref=[act("edit", kind="person", name="sunita", args="cadence: 10")]),
  T("rosa is also our house cleaner now", diff(upd("nanny", role="house cleaner")),
    ref=[act("edit", kind="person", name="rosa", args="role: house cleaner")]))
