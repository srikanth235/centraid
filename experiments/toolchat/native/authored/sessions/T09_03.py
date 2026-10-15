from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T09-051", "wedding morning edit reschedule ambiguous pick add_to",
  T("what's open on the wedding list and due before june", rows("florist_dep", "invites"),
    ref=[ans(kind="task", linked_to="$wed_list", when=W({"to": D("2026-05-31")}), where='status = "open"')]),
  T("send invitations, make that priority one", diff(upd("invites", priority=1)),
    ref=[act("edit", kind="task", name="Send invitations", args=lines(priority=1))]),
  T("move the cake tasting to 3pm", diff(upd("cake", date="2026-05-23T15:00")),
    ref=[act("reschedule", kind="event", name="Cake tasting", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("and the wedding planning call to 8", ask("wcall_0520", "wcall_0603"),
    ref=[find(kind="event", name="Wedding planning call", when=W({"from": U("day", 0)})),
         act("reschedule", kind="event", within="@prev", args=lines(to=U("day", 0, anchor="row", time="20:00"))),
         askc("next wednesday's call or the one on 3 june?", options="$wcall_0520, $wcall_0603")]),
  T("the next one", diff(upd("wcall_0520", date="2026-05-20T20:00")),
    ref=[act("reschedule", rows="$wcall_0520", args=lines(to=U("day", 0, anchor="row", time="20:00")))]),
  T("who's coming to the menu tasting", rows("dan", "anton"),
    ref=[ans(kind="person", linked_to="$menu")]),
  T("log a message with anton petrov, sent him our dietary list", diff(upd("anton", date=ANY)),
    ref=[act("log", kind="person", name="Anton Petrov", args=lines(kind="message"))]))

S("T09-053", "restore window event refusal restore undo",
  T("can you bring back the engagement shoot rain date", decline("not_found"),
    ref=[bad(act("restore", kind="event", name="Engagement shoot rain date", trashed=True)), dec("not_found")]),
  T("ok is the pottery class in the trash", rows("pottery"),
    ref=[ans(kind="event", name="Pottery class", trashed=True)]),
  T("restore it", diff(restore("pottery")),
    ref=[act("restore", rows="@prev")]),
  T("undo that, i'm not going", diff(trash("pottery")),
    ref=[act("undo")]),
  T("so what's on thursday", rows("checkin_0514", "cb_0514"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=4)))]))

S("T09-055", "trashed person restore undo",
  T("is greg tully in the trash", rows("greg"),
    ref=[ans(kind="person", name="Greg Tully", trashed=True)]),
  T("restore him", diff(restore("greg")),
    ref=[act("restore", rows="@prev")]),
  T("no wait undo, found his number in an old email", diff(trash("greg")),
    ref=[act("undo")]),
  T("who else is sitting in the people trash", rows("bex"),
    ref=[ans(kind="person", trashed=True, exclude="$greg")]))

S("T09-057", "folder doc count then delete nonempty folder refused ask",
  T("folders that contain just one document or none", rows("old_f"),
    ref=[ans(kind="folder", where="document count < 2")]),
  T("ok and delete the honeymoon folder, everything's booked", ask(),
    ref=[bad(act("delete", kind="folder", name="Honeymoon")),
         askc("the honeymoon folder still has the tap and alfama bookings in it. move them somewhere first?")]))

S("T09-059", "overlap create refused ask create linked reschedule",
  T("put a haircut on thursday at 7:15", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Haircut", date=U("week", 0, weekday=4, time="19:15")))),
         askc("thursday 7:15 is during the condo board meeting (7 to 8:30). after it?")]),
  T("ok make it 8:45", diff(new("event", name="Haircut", date="2026-05-14T20:45")),
    ref=[act("create", args=lines(kind="event", name="Haircut", date=U("week", 0, weekday=4, time="20:45")))]),
  T("and the team lunch, who's going", rows("ethan", "naomi"),
    ref=[ans(kind="person", linked_to="$team_lunch")]),
  T("move the team lunch to 1", diff(upd("team_lunch", date="2026-05-15T13:00")),
    ref=[act("reschedule", rows="$team_lunch", args=lines(to=U("day", 0, anchor="row", time="13:00")))]))

S("T09-061", "repair refused unit effort within sum max",
  T("tasks that'll take more than two hours that i haven't done",
    rows("factum", "disc_outline", "vows", "cpd", "mock_exam", "invites"),
    ref=[bad(ans(kind="task", where='effort > 2 hours and status = "open"')),
         ans(kind="task", where='effort > 120 and status = "open"')]),
  T("which of those land before may is out", rows("factum", "disc_outline", "mock_exam", "invites"),
    ref=[ans(within="@prev", when=W(U("month", 0)))]),
  T("prep discovery outline, push it to the twenty-fourth", diff(upd("disc_outline", date="2026-05-24")),
    ref=[act("reschedule", kind="task", name="Prep discovery outline", args=lines(to=D("2026-05-24")))]),
  T("total effort on the ones due this month", val(630),
    ref=[ans(op="sum", field="effort", kind="task", when=W(U("month", 0)), where='effort > 120 and status = "open"')]),
  T("and what's the single biggest one", val(240),
    ref=[comp(op="max", field="effort", kind="task", when=W(U("month", 0)), where='effort > 120 and status = "open"'),
         ans(value="@prev")]))

S("T09-062", "missing weekday reschedule log",
  T("move the florist consult to next thursday at noon", diff(upd("florist", date="2026-05-21T12:00")),
    ref=[act("reschedule", kind="event", name="Florist consult", args=lines(to=U("week", 1, weekday=4, time="12:00")))]),
  T("and who's the florist", rows("rachel"),
    ref=[ans(kind="person", linked_to="$florist")]),
  T("mark her called, all confirmed", diff(upd("rachel", date=ANY)),
    ref=[act("log", rows="$rachel", args=lines(kind="call"))]))

S("T09-067", "ambiguous photo unstar find-only add_to",
  T("unstar the cherry blossoms photo", diff(upd("blossom_dan", starred=False)),
    ref=[act("unstar", kind="photo", name="Cherry blossoms")]),
  T("find the engagement shoot pics", rows("eng_shoot1", "eng_shoot2"),
    ref=[find(kind="photo", name="Engagement shoot"), ans(rows="@prev")]),
  T("put both in spring 2026 as well", diff(link("spring_album", "eng_shoot1"), link("spring_album", "eng_shoot2")),
    ref=[act("add_to", rows="$eng_shoot1, $eng_shoot2", args=lines(to="$spring_album"))]))

S("T09-068", "linked_to all photo oldest already trash",
  T("photos with mom and dad both in them", rows("fam_dinner", "ada_grad", "xmas"),
    ref=[find(kind="person", where='role in ("mom", "dad")'), ans(kind="photo", linked_to="$mom, $dad")]),
  T("which is the oldest", rows("ada_grad"),
    ref=[ans(within="@prev", order="date asc", limit=1)]),
  T("star that one", diff(already=["ada_grad"]),
    ref=[act("star", rows="$ada_grad"), ans(rows="$ada_grad")]),
  T("what's in the photo trash", rows("blurry_toast", "screenshot"),
    ref=[ans(kind="photo", trashed=True)]))

S("T09-069", "photo trash restore prev album empty",
  T("anything in the photo trash", rows("blurry_toast", "screenshot"),
    ref=[ans(kind="photo", trashed=True)]),
  T("restore the toast one", diff(restore("blurry_toast")),
    ref=[find(within="@prev", name="toast", trashed=True), act("restore", rows="@prev")]),
  T("which album is it back in", rows(),
    ref=[ans(kind="album", linked_to="$blurry_toast")]))

S("T09-070", "unstar photo prev empty",
  T("starred photos in the family album", rows("ada_grad"),
    ref=[ans(kind="photo", linked_to="$fam_album", where="starred = yes")]),
  T("unstar it", diff(upd("ada_grad", starred=False)),
    ref=[act("unstar", rows="@prev")]),
  T("any family pics with nobody tagged", rows(),
    ref=[ans(kind="photo", linked_to="$fam_album", where="person count = 0")]))

S("T09-071", "delete person where delete event trash",
  T("remove the family doctor from my contacts, switched to a clinic", diff(trash("haddad")),
    ref=[act("delete", kind="person", where='role = "family doctor"')]),
  T("is the physical with dr haddad on", rows("physical"),
    ref=[ans(kind="event", name="Physical with Dr Haddad")]),
  T("delete it too", diff(trash("physical")),
    ref=[act("delete", rows="$physical")]),
  T("what's in the contacts trash", rows("greg", "bex", "haddad"),
    ref=[ans(kind="person", trashed=True)]))

S("T09-072", "delete person prev document",
  T("who's the photographer again", rows("sam_o"),
    ref=[ans(kind="person", where='role contains "photographer"')]),
  T("we went with someone else, delete him", diff(trash("sam_o")),
    ref=[act("delete", rows="@prev")]),
  T("delete the photographer contract", diff(trash("photo_contract")),
    ref=[act("delete", kind="document", name="Photographer contract")]))

S("T09-074", "create event edit new reschedule where",
  T("add a call with colette next monday 7pm", diff(new("event", name=has("Colette"), date="2026-05-18T19:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Colette", date=U("week", 1, weekday=1, time="19:00")))]),
  T("rename it Seating chart call", diff(upd("+1", name="Seating chart call")),
    ref=[act("edit", rows="$c1", args=lines(name="Seating chart call"))]),
  T("push fridays lunch thing to 12:30", diff(upd("team_lunch", date="2026-05-15T12:30")),
    ref=[act("reschedule", kind="event", when=W(U("week", 0, weekday=5)), where="person count >= 2",
             args=lines(to=U("day", 0, anchor="row", time="12:30")))]),
  T("what's on friday now", rows("team_lunch", "movie"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=5)))]))
