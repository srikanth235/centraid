from gold import *
import json

world("D", "2026-12-20T19:40", "Marisol Reyes-Kapoor", "eval")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("D-E039", "flights name description reschedule date",
  T("when are the flights coming up, both the outbound and the return", rows("flight_gdl", "flight_home"),
    ref=[ans(kind="event", name="flight", when=W({"from": U("day", 0)}))]),
  T("which one is ua 1511", rows("flight_gdl"),
    ref=[ans(within="@prev", where='description contains "UA 1511"')]),
  T("move the flight home to the third", diff(upd("flight_home", date="2027-01-03T13:40")),
    ref=[act("reschedule", rows="$flight_home", args=lines(to=D("2027-01-03")))]))

S("D-E040", "reschedule evening undo",
  T("push posada to 8", diff(upd("posada", date="2026-12-23T20:00")),
    ref=[act("reschedule", kind="event", name="posada", args=lines(to=U("week", 1, weekday=3, time="20:00")))]),
  T("hm no leave it at 7, undo", diff(upd("posada", date="2026-12-23T19:00")),
    ref=[act("undo")]))

S("D-E041", "week list person-linked events",
  T("what's on next week", rows("dentist_kids", "standup154", "recital", "flight_gdl", "ev360", "soccer_prac120", "ballet120", "posada", "xmas_eve", "ev96", "call_mama155", "date_night"),
    ref=[ans(kind="event", when=W(U("week", 1)))]),
  T("what's lucia got on next week, for the drop-offs", rows("dentist_kids", "recital", "ballet120"),
    ref=[search("Lucia", kind="person"), ans(kind="event", linked_to="$lucia", when=W(U("week", 1)))]),
  T("and arun", rows("dentist_kids", "soccer_prac120"),
    ref=[ans(kind="event", linked_to="$arun", when=W(U("week", 1)))]))

S("D-E042", "tasks this week open",
  T("what was due this week that i didn't finish", rows("fair_volunteers", "tk750", "tk366"),
    ref=[ans(kind="task", when=W(U("week", 0)), where="status = open")]),
  T("push the volunteers thank-you to wednesday", diff(upd("fair_volunteers", date="2026-12-23")),
    ref=[act("reschedule", kind="task", name="thank volunteers", args=lines(to=U("week", 1, weekday=3)))]))

S("D-E043", "person counts compute",
  T("how many neighbors do i have saved", val(11),
    ref=[comp(op="count", kind="person", where='role = "neighbor"'), ans(value="@prev")]),
  T("how many are starred", val(30),
    ref=[ans(op="count", kind="person", where="starred = yes")]),
  T("and how many do i have a cadence for", val(6),
    ref=[ans(op="count", kind="person", where="cadence is set")]))

S("D-E044", "note create move notebook",
  T("jot down gabi wants cajeta and tequila for her party", diff(new("note", body=has("cajeta"))),
    ref=[act("create", args=lines(kind="note", name="gabi wants cajeta and tequila", body="gabi wants cajeta and tequila for her party"))]),
  T("put it in the travel notebook and pin it", diff(link("travel_nb", "+1"), upd("+1", pinned=True)),
    ref=[act("add_to", rows="$c1", args="to: $travel_nb", more=True), act("edit", rows="$c1", args="pinned: yes")]))

S("D-E045", "debts top ordinal settle",
  T("my three biggest open debts", rows("db32", "db60", "db17"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount desc", limit=3)]),
  T("the second one, paid back last night by transfer", diff(upd("db60", status="settled")),
    ref=[act("settle_debt", rows="$db60")]))

S("D-E046", "ambiguous-person ask pick log",
  T("log a call with sam, we talked about the carpool", ask("pp6", "pp43", "pp62", "pp91", "pp109"),
    ref=[act("log", kind="person", name="sam", args="kind: call"),
         askc("Which Sam: Martinez, Hernandez, Dubois, Novak or Ali?", options="$pp6, $pp43, $pp62, $pp91, $pp109")]),
  T("the book club one", diff(upd("pp91", date=ANY)),
    ref=[act("log", rows="$pp91", args="kind: call")]))

S("D-E047", "delete restore event read",
  T("get rid of the home depot run from the seventh", diff(trash("ev225")),
    ref=[act("delete", kind="event", name="home depot run", when=W(D("2026-12-07")))]),
  T("wait bring it back, we did go on the seventh, keep it", diff(restore("ev225")),
    ref=[act("restore", rows="$ev225")]),
  T("is it on the calendar again", rows("ev225"),
    ref=[ans(kind="event", name="home depot run", when=W(D("2026-12-07")))]))

S("D-E048", "empty results last-one",
  T("any vet visits next week, the dog's been scratching all day", rows(),
    ref=[ans(kind="event", name="vet", when=W(U("week", 1)))]),
  T("this month then", rows(),
    ref=[ans(kind="event", name="vet", when=W(U("month", 0)))]),
  T("when was the last one", rows("ev350"),
    ref=[ans(kind="event", name="vet", when=W({"to": U("day", 0)}), order="date desc", limit=1)]))

S("D-E049", "note search",
  T("what did i write about ski tips since october, something about waxing", rows("nn63"),
    ref=[ans(kind="note", name="ski tips", when=W({"from": D("2026-10-01")}))]),
  T("and the one about passports", rows("nn64", "nn65", "nn66"),
    ref=[ans(kind="note", name="passport")]))

S("D-E050", "star document folder add-many",
  T("star the 2026 home warranty, that's the one i'll need for the dishwasher claim", diff(upd("dc5", starred=True)),
    ref=[act("star", kind="document", name="home warranty 2026")]),
  T("put all the home warranty docs in the insurance folder", diff(unlink("house_f", "dc3"), unlink("house_f", "dc4"), unlink("house_f", "dc5"),
                                                 link("insurance_f", "dc3"), link("insurance_f", "dc4"), link("insurance_f", "dc5")),
    ref=[find(kind="document", name="home warranty"), act("add_to", rows="@1", args="to: $insurance_f")]))

S("D-E051", "star unstar locker",
  T("star the amex", diff(upd("amex_d", starred=True)),
    ref=[act("star", kind="locker item", name="amex")]),
  T("unstar the home wifi and star the guest one, we know the home one by heart now", diff(upd("wifi_lk", starred=False), upd("guest_wifi_d", starred=True)),
    ref=[act("unstar", kind="locker item", name="home wifi", more=True), act("star", kind="locker item", name="guest wifi")]),
  T("any starred logins left, or are they all just the cards", rows(),
    ref=[ans(kind="locker item", where="type = login and starred = yes")]))

S("D-E052", "locker create star",
  T("add a new login for hulu", diff(new("locker item", name="Hulu", type="login")),
    ref=[act("create", args=lines(kind="locker item", name="Hulu", type="login"))]),
  T("star it and set the username to marisol.rk", diff(upd("+1", starred=True, username="marisol.rk")),
    ref=[act("star", rows="$c1", more=True), act("edit", rows="$c1", args="username: marisol.rk")]))

S("D-E053", "decline scope unbounded",
  T("what's the weather in guadalajara", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("delete all my tasks", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("fine just the ones i already finished, keep the open", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))
