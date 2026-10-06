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

S("T09-052", "condo evening balance repair pick settle complete",
  T("when's the next condo board meeting", rows("cb_0514"),
    ref=[ans(kind="event", name="Condo board meeting", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("who's in the board group", rows("priya_s", "gord", "linh", "me"),
    ref=[ans(kind="person", linked_to="$condo")]),
  T("how much do i owe priya", val((-15, "CAD")),
    ref=[ans(op="balance", rows="$priya_s")]),
  T("settle up with her in the condo group", diff(settle=[("Priya Sandhu", "7.5")]),
    ref=[act("settle_up", rows="$priya_s", args=lines(group="$condo"))]),
  T("what's open on the condo list", rows("agm_notice", "reserve", "repaint"),
    ref=[ans(kind="task", linked_to="$condo_list", where='status = "open"')]),
  T("circulate agm notice is done, mark it", diff(upd("agm_notice", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Circulate AGM notice")]))

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

S("T09-054", "restore window ski balance star",
  T("did i delete the blue mountain ski weekend", rows("ski"),
    ref=[ans(kind="event", name="Blue Mountain", trashed=True)]),
  T("restore it, hugo wants the dates", decline("not_found"),
    ref=[bad(act("restore", kind="event", name="Blue Mountain", trashed=True)), dec("not_found")]),
  T("fine. what's my balance with hugo mensah", val((0, "CAD")),
    ref=[ans(op="balance", kind="person", name="Hugo Mensah")]),
  T("star him while you're at it", diff(upd("hugo", starred=True)),
    ref=[act("star", rows="$hugo")]))

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

S("T09-058", "delete group with expenses refused balance",
  T("delete the bar prep study group, exam's in june", ask(),
    ref=[bad(act("delete", kind="group", name="Bar prep study group")),
         askc("it still has expenses in it, so it can't be deleted. want to see balances first?")]),
  T("yeah where am i at in it", val((103, "CAD")),
    ref=[find(kind="person", linked_to="$barprep"),
         ans(op="balance", kind="group", name="Bar prep study group", linked_to="$me")]),
  T("ok and any folders with nothing in them", rows("old_f"),
    ref=[ans(kind="folder", where="document count < 1")]))

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

S("T09-060", "overlap create refused create balance",
  T("book drinks with marcus thursday at 7", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Drinks with Marcus", date=U("week", 0, weekday=4, time="19:00")))),
         askc("thursday at 7 you've got the condo board meeting till 8:30. another time?")]),
  T("friday 5:30 then", diff(new("event", name=has("Marcus"), date="2026-05-15T17:30")),
    ref=[act("create", args=lines(kind="event", name="Drinks with Marcus", date=U("week", 0, weekday=5, time="17:30")))]),
  T("overall, what does my debt to him come to", val((-165, "CAD")),
    ref=[ans(op="balance", kind="person", name="Marcus Bell")]))

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

S("T09-065", "search two priyas ask balance settle",
  T("how much does priya owe me", ask("priya_r", "priya_s"),
    ref=[search("priya", kind="person"),
         askc("priya raman or priya sandhu from the condo board?", options="$priya_r, $priya_s")]),
  T("raman", val((138, "CAD")),
    ref=[ans(op="balance", rows="$priya_r")]),
  T("she paid me back for the coffee and pastries", diff(upd("d_priya_r", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Coffee and pastries")]),
  T("so what's she at", val((120, "CAD")),
    ref=[ans(op="balance", rows="$priya_r")]))

S("T09-066", "ambiguous jordan add_to group log cadence empty",
  T("add jordan to the stag and doe group", diff(link("stag", "jordan_p")),
    ref=[act("add_to", kind="person", name="Jordan", args=lines(to="$stag"))]),
  T("so who's in the stag and doe group", rows("marcus", "jordan_l", "jordan_p", "me"),
    ref=[ans(kind="person", linked_to="$stag")]),
  T("log a message with jordan lee, texted him the address", diff(upd("jordan_l", date=ANY)),
    ref=[act("log", kind="person", name="Jordan Lee", args=lines(kind="message"))]),
  T("which articling students have i not set a check-in for", rows("mateo"),
    ref=[ans(kind="person", where='role contains "articling" and cadence is empty')]))

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

S("T09-073", "create person remove_from new delete new",
  T("add nina castillo, new articling student, to the bar prep group",
    diff(new("person", name="Nina Castillo"), link("barprep", "new")),
    ref=[act("create", more=True, args=lines(kind="person", name="Nina Castillo", role="articling student")),
         act("add_to", rows="$new", args=lines(to="$barprep"))]),
  T("hm she's in the other cohort, take her out", diff(unlink("barprep", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$barprep"))]),
  T("and delete her contact", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

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
