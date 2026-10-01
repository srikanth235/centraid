from gold import *
import json

world("T02", "2027-06-08T11:05", "Mei-Lin Chau", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
LIVE = 'status = "open"'


def next_dimsum():
    return find(kind="event", name="Dim sum", when=W({"from": U("day", 0)}), order="date asc", limit=1)


def pottery_left():
    return find(kind="event", name="Pottery class", when=W({"from": U("day", 0)}))


S("T02-133", "recovery next dim sum, week min max sum durations",
  T("when's my next dim sum, mom keeps askng", rows("dimsum_jun"),
    ref=[next_dimsum(), bad(next_dimsum()), ans(within="@prev")]),
  T("what's the shortest thing on my calendar this week, need a gap for a call", val(45),
    ref=[comp(op="min", field="duration", kind="event", when=W(U("week", 0))), ans(value="@prev")]),
  T("and the longest, the one that's going to swallow my whole evening", val(180),
    ref=[comp(op="max", field="duration", kind="event", when=W(U("week", 0))), ans(value="@prev")]),
  T("total minutes for the week so far, i need to see wether i can fit a client call in", val(825),
    ref=[comp(op="sum", field="duration", kind="event", when=W(U("week", 0))), ans(value="@prev")]))

S("T02-134", "recovery twice pottery, debts max sum exclude, client min",
  T("when's my very last pottery class of the term", rows("pottery_0701"),
    ref=[pottery_left(), bad(pottery_left()), bad(pottery_left()),
         ans(within="@prev", order="date desc", limit=1)]),
  T("what's the biggest thing i owe anyone, its the khruangbin tickets right, i'm probaly forgetting a bigger one", val((95, "CAD")),
    ref=[comp(op="max", field="amount", kind="debt", where=OWE), ans(value="@prev")]),
  T("and what's everything i owe added up, leaving out the phone bill since mom said forget it", val((155.5, "CAD")),
    ref=[comp(op="sum", field="amount", kind="debt", where=OWE, exclude="$d_mom_phone"), ans(value="@prev")]),
  T("what's the quickest of my client work jobs that's got a time estimate on it", val(90),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$clientwork", where=LIVE), ans(value="@prev")]))

S("T02-135", "portfolio ask never-mind, owed min, owed max",
  T("tick off the portfolio one", ask("portfolio_site", "rachel_followup"),
    ref=[act("complete", kind="task", name="portfolio"),
         askc("Update portfolio site or Send Rachel the new portfolio PDF?", options="$portfolio_site, $rachel_followup")]),
  T("no wait, neither's done yet, i've been putting them both off since last week", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("smallest amount anyone owes me, becuase i'm deciding who's not worth chasing", val((30, "CAD")),
    ref=[comp(op="min", field="amount", kind="debt", where=OWED), ans(value="@prev")]),
  T("and the biggest, is that the maple & fern invoice or is tomo's kill fee bigger", val((850, "CAD")),
    ref=[comp(op="max", field="amount", kind="debt", where=OWED), ans(value="@prev")]))

S("T02-136", "top two owed sum, next week min max durations",
  T("add up the two biggest amounts people owe me, i want to know if i can cover the deposit", val((1150, "CAD")),
    ref=[find(kind="debt", where=OWED, order="amount desc", limit=2),
         comp(op="sum", field="amount", within="@prev"), ans(value="@prev")]),
  T("what's the shortest thing i've got next week, wondering if i can squeeze a call in", val(60),
    ref=[comp(op="min", field="duration", kind="event", when=W(U("week", 1))), ans(value="@prev")]),
  T("and the longest of those, i'm guessing squamish, its usualy a whole day", rows("squamish_jun"),
    ref=[ans(kind="event", when=W(U("week", 1)), order="duration desc", limit=1)]))

S("T02-137", "client work sum max, dim sum limit, owed min",
  T("roughly how much work time is tied up in everything still open on client work", val(570),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$clientwork", where=LIVE), ans(value="@prev")]),
  T("what's the single biggest job in there", val(480),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$clientwork", where=LIVE), ans(value="@prev")]),
  T("whens my next two dim sum things, i keep mixing up which is which, i can never rember", rows("dimsum_jun", "dimsum_grace"),
    ref=[ans(kind="event", name="Dim sum", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("what's the smalest thing i owe anyone, need to clear it before the next climbing night", val((18.5, "CAD")),
    ref=[comp(op="min", field="amount", kind="debt", where=OWE), ans(value="@prev")]))

S("T02-138", "contract ask never-mind, latest note, next week sum",
  T("delete the contract", ask("gl_contract", "mf_contract"),
    ref=[act("delete", kind="document", name="contract"),
         askc("Greenleaf mural contract or Maple & Fern contract?", options="$gl_contract, $mf_contract")]),
  T("no wait, leave them, i need both of them handy for the tax return", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("whats the newest note i've got, i think it was a quick idea i wrote at midnigt", rows("idea_crow"),
    ref=[ans(kind="note", order="date desc", limit=1)]),
  T("how much of next week is already booked up, in minutes", val(1170),
    ref=[comp(op="sum", field="duration", kind="event", when=W(U("week", 1))), ans(value="@prev")]))

S("T02-139", "wipe notes, next client tasks max, clear locker, tightest check-in",
  T("wipe all my notes, thier mostly junk and i want a fresh start", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("of the next three client work tasks due, which needs the most time", rows("tide_final"),
    ref=[find(kind="task", linked_to="$clientwork", where=LIVE, order="date asc", limit=3),
         ans(within="@prev", order="effort desc", limit=1)]),
  T("clear out the locker, i want it all gone", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("what's the shortest check-in gap i've set for anyone, i want to see who i'm meant to be calling the most", val(7),
    ref=[comp(op="min", field="cadence", kind="person"), ans(value="@prev")]))

S("T02-140", "next diary limit, wipe everything, longest coming up, old debts sum",
  T("whats coming up next in the diary, need to see if theres a call befor lunch", rows("call_marcus"),
    ref=[ans(kind="event", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("i'm sick of every bit of it so delete all my people, tasks, notes, docs, the whole vault", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("what's the longest thing i've got coming up, anything that runs over ten hours", val(650),
    ref=[comp(op="max", field="duration", kind="event", when=W({"from": U("day", 0)})), ans(value="@prev")]),
  T("total of the old debts people owe me from before this month, is it worth chasing them all", val((225, "CAD")),
    ref=[comp(op="sum", field="amount", kind="debt", when=W({"to": U("month", -1)}), where=OWED), ans(value="@prev")]))

S("T02-141", "last invoice limit, renew ask never-mind, smallest estimate",
  T("which is the last invoice due this month", rows("inv_gl_final"),
    ref=[ans(kind="task", name="Invoice", when=W(U("month", 0)), order="date desc", limit=1)]),
  T("tick off renew", ask("adobe_renew", "tenant_ins"),
    ref=[act("complete", kind="task", name="Renew"),
         askc("Renew Adobe subscription or Renew tenant insurance?", options="$adobe_renew, $tenant_ins")]),
  T("hm actually i haven't done either of them, leave it, i keep mixing up the appointmnt", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's the smallest time estimate on anything i've still got to do", val(15),
    ref=[comp(op="min", field="effort", kind="task", where=LIVE), ans(value="@prev")]))

S("T02-142", "tokyo prep limit, cancel ask never-mind, wipe photos",
  T("whih two tokyo prep jobs are due first", rows("insurance", "jr_pass"),
    ref=[ans(kind="task", linked_to="$tokyoprep", where=LIVE, order="date asc", limit=2)]),
  T("cancel the pottery", ask("pottery_0610", "pottery_0617", "pottery_0624", "pottery_0701"),
    ref=[act("cancel", kind="event", name="Pottery class"),
         find(kind="event", name="Pottery class", when=W({"from": U("day", 0)})),
         askc("Which class, the 10th, 17th, 24th or 1st?", options="@prev")]),
  T("hang on, yuki just texted that the studio's fine, so leave it all as it is", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("i want a fresh start, so delete all my photos and albums and every note and document, everythng", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))
