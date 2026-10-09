from gold import *
import json

world("T20", "2026-05-28T16:10", "Matteo Ricci", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T20-001", "person nickname contains find-only star prev",
  T("who's got enzo as a nickname", rows("lorenzo_g"),
    ref=[find(kind="person", where='nickname contains "Enzo"'), ans(rows="@prev")]),
  T("star him, he's covering my shifts during the move", diff(upd("lorenzo_g", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T20-002", "single person cadence",
  T("who am i supposed to see every week or more", rows("mamma", "papa", "nonna", "carla", "lorenzo_g", "marco_e"),
    ref=[ans(kind="person", where="cadence <= 7")]))

S("T20-003", "person date log undo ledger",
  T("who did i talk to on the twenty-sixth", rows("carla", "lorenzo_g", "mauro"),
    ref=[ans(kind="person", when=W(D("2026-05-26")))]),
  T("log a call with mauro de luca, sorted the key handover", diff(upd("mauro", date=ANY)),
    ref=[act("log", kind="person", name="Mauro De Luca", args=lines(kind="call"))]),
  T("undo that, it was giulia who called him", diff(),
    ref=[act("undo")]))

S("T20-004", "person span rel date count",
  T("everyone i spoke with between last week and monday, list them",
    rows("federico", "elena", "rosa", "sofia", "mamma", "papa", "marco_e", "marco_l", "stefano", "andrea"),
    ref=[ans(kind="person", when=W(span(U("week", -1), U("week", 0, weekday=1))))]),
  T("how many is that", val(10),
    ref=[ans(op="count", rows="@prev")]))

S("T20-006", "group count person count edit group named",
  T("anyone i try to keep up with that isn't in any group", rows("mamma", "papa", "nonna", "francesca"),
    ref=[ans(kind="person", where="cadence is set and group count < 1")]),
  T("which groups have fewer than three people", rows("casa", "gift_pool"),
    ref=[ans(kind="group", where="person count < 3")]),
  T("rename nonna's birthday gift to Nonna's 90th", diff(upd("gift_pool", name="Nonna's 90th")),
    ref=[act("edit", rows="$gift_pool", args=lines(name="Nonna's 90th"))]))

S("T20-008", "debt count linked_to all settle_debt",
  T("anyone with two debts on the books", rows("stefano"),
    ref=[ans(kind="person", where="debt count = 2")]),
  T("what are they", rows("d_stefano", "d_stefano_2"),
    ref=[ans(kind="debt", linked_to="@prev")]),
  T("settle the gran fondo one, he paid me back on sunday", diff(upd("d_stefano", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Gran fondo entry")]))

S("T20-009", "ambiguous notebook pick edit count",
  T("rename the tasting notes notebook to Tasting notes 2026", diff(upd("tasting_nb", name="Tasting notes 2026")),
    ref=[act("edit", kind="notebook", name="Tasting notes", args=lines(name="Tasting notes 2026")),
         act("edit", rows="$tasting_nb", args=lines(name="Tasting notes 2026"))]),
  T("how many notes in it", val(4),
    ref=[ans(op="count", kind="note", linked_to="$tasting_nb")]))

S("T20-010", "ambiguous notebook ask delete undo not undone",
  T("delete the tasting notes notebook", ask("tasting_nb", "tasting25_nb"),
    ref=[act("delete", kind="notebook", name="Tasting notes"),
         askc("there are two: Tasting notes and Tasting notes 2025. which one?", options="$tasting_nb, $tasting25_nb")]),
  T("the 2025 one", diff(gone("tasting25_nb"), unlink("tasting25_nb", "chianti_2025"), unlink("tasting25_nb", "nebbiolo_2025")),
    ref=[act("delete", rows="$tasting25_nb")]),
  T("hm undo", diff(),
    ref=[act("undo")]))

S("T20-011", "empty result note search miss decline read",
  T("find my note about the sagrantino", decline("not_found"),
    ref=[find(kind="note", name="Sagrantino"), search("sagrantino", kind="note"), dec("not_found")]),
  T("ok the rosato one", rows("rosato"),
    ref=[ans(kind="note", name="Rosato")]))

S("T20-012", "empty result note search edit",
  T("what's in my corkage fees note", rows("corkage_n"),
    ref=[find(kind="note", name="Corkage fees"), search("corkage", kind="note"), ans(rows="$corkage_n")]),
  T("add: 30 for magnums", diff(upd("corkage_n", body=has("magnums"))),
    ref=[act("edit", rows="$corkage_n", args=lines(body="25 euro a bottle, waived if they order a second. 30 for magnums"))]))

S("T20-013", "restore window document refused ask never_mind",
  T("can you bring back the arno traslochi quote, want to compare prices", ask(),
    ref=[bad(act("restore", kind="document", name="Movers quote Arno Traslochi", trashed=True)),
         askc("that quote went in the bin on 5 april, past the 30 days, so it can't come back. add a note with their price instead?")]),
  T("nah forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T20-014", "trashed documents restore window restore add_to",
  T("documents i've thrown in the trash", rows("old_lease", "old_quote"),
    ref=[find(kind="document", trashed=True), ans(rows="@prev")]),
  T("restore the second one", ask(),
    ref=[bad(act("restore", rows="$old_quote")),
         askc("the arno traslochi quote is past the 30-day window, it can't be restored. want the lease via romana back instead?")]),
  T("yes the lease", diff(restore("old_lease")),
    ref=[act("restore", kind="document", name="Lease Via Romana", trashed=True)]),
  T("put it in archive", diff(link("archive_f", "old_lease")),
    ref=[act("add_to", rows="$old_lease", args=lines(to="$archive_f"))]))

S("T20-015", "cancelled events delete multi undo knock-on",
  T("which events have i cancelled", rows("ride_0510", "night_ride", "plumber_visit", "ride_0621"),
    ref=[find(kind="event", where='status = "cancelled"'), ans(rows="@prev")]),
  T("delete the first two", diff(trash("ride_0510"), trash("night_ride")),
    ref=[act("delete", rows="$ride_0510, $night_ride")]),
  T("wait no, undo", diff(restore("ride_0510"), restore("night_ride")),
    ref=[act("undo")]))

S("T20-016", "event delete prev undo",
  T("what's on saturday", rows("bike_service"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=6)))]),
  T("delete it, marco's doing the service after sunday's ride", diff(trash("bike_service")),
    ref=[act("delete", rows="@prev")]),
  T("ugh undo, he can't sunday", diff(restore("bike_service")),
    ref=[act("undo")]))

S("T20-017", "event weekend cancel prev multi undo cancel",
  T("anything on saturday or sunday this week", rows("bike_service", "ride_0531"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]),
  T("cancel both, i'll be packing", diff(upd("bike_service", status="cancelled"), upd("ride_0531", status="cancelled")),
    ref=[act("cancel", rows="@prev")]),
  T("undo that", diff(),
    ref=[act("undo")]))

S("T20-018", "single cancel event multi named",
  T("cancel aperitivo with andrea and the call with ettore, i'm sick",
    diff(upd("aperitivo", status="cancelled"), upd("photographer_call", status="cancelled")),
    ref=[act("cancel", rows="$aperitivo, $photographer_call")]))

S("T20-019", "reopen task named reschedule",
  T("reopen measure windows for curtains, giulia says i got the bedroom wrong",
    diff(upd("curtains", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Measure windows for curtains")]),
  T("due saturday", diff(upd("curtains", date="2026-05-30")),
    ref=[act("reschedule", rows="$curtains", args=lines(to=U("week", 0, weekday=6)))]))

S("T20-021", "ambiguous task reopen narrowed count",
  T("reopen order chianti classico, fede shorted us two cases", diff(upd("chianti_2", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Order Chianti Classico"),
         act("reopen", kind="task", name="Order Chianti Classico", where='status = "completed"')]),
  T("how many open on the cantina list", val(5),
    ref=[ans(op="count", kind="task", linked_to="$cantina_l", where='status = "open"')]))

S("T20-022", "settle_up multi club",
  T("stefano and luca owe me for the jerseys, settle both up in the club",
    diff(settle=["Stefano Rinaldi", "Luca Colombo"]),
    ref=[act("settle_up", rows="$stefano, $luca", args=lines(group="$club"))]),
  T("and bea?", diff(settle=["Beatrice Galli"]),
    ref=[act("settle_up", rows="$bea", args=lines(group="$club"))]))

S("T20-023", "settle_up multi staff balance group",
  T("settle up with sofia and davide in the staff dinner fund", diff(settle=["Sofia Marchetti", "Davide Russo"]),
    ref=[act("settle_up", rows="$sofia, $davide", args=lines(group="$staff"))]),
  T("where's elena at in that fund", val((-10, "EUR")),
    ref=[ans(op="balance", kind="group", name="Staff dinner fund", linked_to="$elena")]))

S("T20-024", "create person star new",
  T("add a contact: Irene Santoro, sommelier at Enoteca Pinchiorri",
    diff(new("person", name="Irene Santoro", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Irene Santoro", role="sommelier, Enoteca Pinchiorri"))]),
  T("star her", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]))

S("T20-025", "single compute min debt",
  T("smallest thing i owe someone?", val((45, "EUR")),
    ref=[comp(op="min", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'),
         ans(value="@prev")]))
