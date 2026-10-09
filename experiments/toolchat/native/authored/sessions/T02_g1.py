from gold import *
import json

world("T02", "2027-06-08T11:05", "Mei-Lin Chau", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T02-103", "ask options review reschedule never_mind then contrast",
  T("move the review to thursday at 3", ask("tide_review", "portfolio_review"),
    ref=[act("reschedule", kind="event", name="review", when=W({"from": U("day", 0)}),
             args=lines(to=U("week", 0, weekday=4, time="15:00"))),
         askc("the tidewater cover review or the portfolio review with rachel?", options="$tide_review, $portfolio_review")]),
  T("forget it, leave them both", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("ok just push the portfolio review to monday at 4", diff(upd("portfolio_review", date="2027-06-14T16:00")),
    ref=[act("reschedule", kind="event", name="Portfolio review with Rachel",
             args=lines(to=U("week", 1, weekday=1, time="16:00")))]))

S("T02-104", "ask options pottery hour later pick then cancel july",
  T("push pottery back an hour", ask("pottery_0610", "pottery_0617", "pottery_0624", "pottery_0701"),
    ref=[act("reschedule", kind="event", name="Pottery class", when=W({"from": U("day", 0)}),
             args=lines(to=U("hour", 1, anchor="row"))),
         find(kind="event", name="Pottery class", when=W({"from": U("day", 0)})),
         askc("which one? thursday the 10th, the 17th, the 24th or the 1st of july", options="$pottery_0610, $pottery_0617, $pottery_0624, $pottery_0701")]),
  T("this thursday's", diff(upd("pottery_0610", date="2027-06-10T19:30")),
    ref=[act("reschedule", rows="$pottery_0610", args=lines(to=U("hour", 1, anchor="row")))]),
  T("and cancel the july one, studio's closed for the holiday", diff(upd("pottery_0701", status="cancelled")),
    ref=[act("cancel", kind="event", name="Pottery class", when=W(U("month", 0, name=7)))]),
  T("how many classes are left now", val(3),
    ref=[ans(op="count", kind="event", name="Pottery class", when=W({"from": U("day", 0)}),
             where='status != "cancelled"')]))

S("T02-105", "contrast pottery named day repair edit multi write",
  T("push thursday's pottery back an hour", diff(upd("pottery_0610", date="2027-06-10T19:30")),
    ref=[bad(act("reschedule", kind="event", name="Pottery class", when=W(U("week", 0, weekday=4)),
                 args=lines(to={"time": "19:30"}))),
         act("reschedule", kind="event", name="Pottery class", when=W(U("week", 0, weekday=4)),
             args=lines(to=U("hour", 1, anchor="row")))]),
  T("make the pottery description wheel throwing, clay studio on main, bring an apron", diff(upd("pottery_0610", description="wheel throwing, Clay Studio on Main, bring an apron")),
    ref=[act("edit", rows="$pottery_0610", args=lines(description="wheel throwing, Clay Studio on Main, bring an apron"))]),
  T("also tick off the leaky tap task and move pick up clay tools to friday",
    diff(upd("tap", status="completed", completed=ANY), upd("clay_tools", date="2027-06-11")),
    ref=[act("complete", kind="task", name="Call Ben about the leaky tap", more=True),
         act("reschedule", kind="task", name="Pick up clay tools", args=lines(to=U("week", 0, weekday=5)))]))

S("T02-109", "ask options tidewater complete then contrast invoice",
  T("mark the tidewater cover one done", ask("inv_tide_cover", "tide_final"),
    ref=[act("complete", kind="task", name="Tidewater cover"),
         askc("the invoice or the final art?", options="$inv_tide_cover, $tide_final")]),
  T("the final art, uploaded it this morning", diff(upd("tide_final", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tide_final")]),
  T("and the invoice for it, tick that off too", diff(upd("inv_tide_cover", status="completed", completed=ANY)),
    ref=[act("complete", rows="$inv_tide_cover")]),
  T("and push the tomo logo revisions to friday", diff(upd("tomo_logo", date="2027-06-11")),
    ref=[act("reschedule", kind="task", name="Tomo Coffee logo revisions", args=lines(to=U("week", 0, weekday=5)))]))

S("T02-110", "ask options sketches reschedule monday then contrast colour",
  T("move the sketches to monday", ask("gl_sketches", "gl_send"),
    ref=[act("reschedule", kind="task", name="sketches", args=lines(to=U("week", 1, weekday=1))),
         askc("the mural sketches or the send sketches to marcus subtask?", options="$gl_sketches, $gl_send")]),
  T("the main one", diff(upd("gl_sketches", date="2027-06-14")),
    ref=[act("reschedule", rows="$gl_sketches", args=lines(to=U("week", 1, weekday=1)))]),
  T("colour studies to friday", diff(upd("gl_colour", date="2027-06-11")),
    ref=[act("reschedule", kind="task", name="Colour studies", args=lines(to=U("week", 0, weekday=5)))]),
  T("and change the main one's description to three options, 1:20 scale, sending monday morning",
    diff(upd("gl_sketches", description="three options, 1:20 scale, sending monday morning")),
    ref=[act("edit", rows="$gl_sketches", args=lines(description="three options, 1:20 scale, sending monday morning"))]))

S("T02-111", "ask options sophie star pick then unstar mom",
  T("star sophie", ask("sophie_t", "sophie_d"),
    ref=[act("star", kind="person", name="Sophie"),
         askc("sophie tran or sophie delacroix?", options="$sophie_t, $sophie_d")]),
  T("the art director", diff(upd("sophie_d", starred=True)),
    ref=[act("star", rows="$sophie_d")]),
  T("and take the star off mom, she's fine without it", diff(upd("mom", starred=False)),
    ref=[search("mom", kind="person"), act("unstar", rows="$mom")]),
  T("what's my starred people total at the moment", val(3),
    ref=[ans(op="count", kind="person", where="starred = yes")]))

S("T02-112", "balance sophie delacroix then star her then tom mina",
  T("how much does sophie delacroix owe me", val((850, "CAD")),
    ref=[ans(op="balance", kind="person", name="Sophie Delacroix")]),
  T("star her", diff(upd("sophie_d", starred=True)),
    ref=[act("star", rows="$sophie_d")]),
  T("and tom?", val((300, "CAD")),
    ref=[ans(op="balance", kind="person", name="Tom Nguyen")]),
  T("mina park", val((258, "CAD")),
    ref=[ans(op="balance", kind="person", name="Mina Park")]))

S("T02-113", "ask options chau log never_mind then contrast full name",
  T("log a call with chau", ask("kai", "mom", "dad"),
    ref=[act("log", kind="person", name="Chau", args=lines(kind="call")),
         askc("kai, linda or henry?", options="$kai, $mom, $dad")]),
  T("don't bother, i'll just text them", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("actually log a visit with henry chau, sunday lunch", diff(upd("dad", date=ANY)),
    ref=[act("log", kind="person", name="Henry Chau", args=lines(kind="visit"))]),
  T("star kai while you're at it", diff(upd("kai", starred=True)),
    ref=[act("star", kind="person", name="Kai Chau")]))

S("T02-114", "balance negative positive mixed group repair",
  T("what do i owe mom", val((-60, "CAD")),
    ref=[search("mom", kind="person"), ans(op="balance", rows="$mom")]),
  T("and diego", val((-11.5, "CAD")),
    ref=[ans(op="balance", kind="person", name="Diego Ramirez")]),
  T("arun pillai?", val((123, "CAD")),
    ref=[ans(op="balance", kind="person", name="Arun Pillai")]),
  T("where's nadia at in the crew group", val((-37, "CAD")),
    ref=[bad(ans(op="balance", kind="group", name="Climbing Crew")),
         ans(op="balance", kind="group", name="Climbing Crew", linked_to="$nadia")]))

S("T02-115", "balance carlos then debt create then balance negative",
  T("how much does carlos owe me", val((75, "CAD")),
    ref=[ans(op="balance", kind="person", name="Carlos Mendes")]),
  T("log that i owe him 150 for the amp",
    diff(new("debt", name=has("amp"), amount=150, direction="i_owe"), link("new", "carlos")),
    ref=[act("create", args=lines(kind="debt", name="Amp", person="$carlos", amount="150", direction="i_owe"))]),
  T("so where do we stand now", val((-75, "CAD")),
    ref=[ans(op="balance", kind="person", name="Carlos Mendes")]),
  T("also mark the hydro bill paid", diff(upd("hydro", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay hydro bill")]))

S("T02-116", "ask options licence star pick then door code",
  T("star the licence", ask("procreate", "clipstudio", "licence"),
    ref=[act("star", kind="locker item", name="licence"),
         askc("procreate, clip studio or your driver's licence?", options="$procreate, $clipstudio, $licence")]),
  T("the driver's one", diff(upd("licence", starred=True)),
    ref=[act("star", rows="$licence")]),
  T("and the studio door code", diff(upd("door", starred=True)),
    ref=[act("star", kind="locker item", name="Studio door code")]))

S("T02-117", "contrast star passport hive unstar adobe",
  T("star my passport", diff(upd("passport", starred=True)),
    ref=[act("star", kind="locker item", name="Passport")]),
  T("and the hive membership", diff(upd("hive", starred=True)),
    ref=[act("star", kind="locker item", name="The Hive membership")]),
  T("unstar the adobe login, i changed it", diff(upd("adobe", starred=False)),
    ref=[act("unstar", kind="locker item", name="Adobe login")]),
  T("how many locker things are starred now", val(3),
    ref=[ans(op="count", kind="locker item", where="starred = yes")]))
