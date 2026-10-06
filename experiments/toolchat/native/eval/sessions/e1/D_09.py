from gold import *
import json

world("D", "2026-12-20T19:40", "Marisol Reyes-Kapoor", "eval")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("D-E129", "ambiguous-note ask delete trashed restore",
  T("delete the flan note, there are way too many of them", ask("nn19", "nn20", "nn21", "nn22"),
    ref=[act("delete", kind="note", name="flan"),
         askc("Which one: Flan, 2, 3 or 4?", options="$nn19, $nn20, $nn21, $nn22")]),
  T("flan 3", diff(trash("nn21")),
    ref=[act("delete", rows="$nn21")]),
  T("any deleted notes?", rows("nn21"),
    ref=[ans(kind="note", trashed=True)]),
  T("put it back", diff(restore("nn21")),
    ref=[act("restore", rows="$nn21")]),
  T("flan notes total now?", val(4),
    ref=[ans(op="count", kind="note", name="flan")]))

S("D-E130", "trash photos count restore-refused",
  T("how many photos are in the trash", val(16),
    ref=[ans(op="count", kind="photo", trashed=True)]),
  T("is img_4034 one of them", rows("ph344"),
    ref=[ans(kind="photo", name="img_4034", trashed=True)]),
  T("restore it, the school form needs that one", decline("out_of_scope", "not_found"),
    ref=[bad(act("restore", rows="$ph344")), dec("out_of_scope")]),
  T("ok forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("D-E131", "reno docs folder unstar empty reschedule",
  T("show me the kitchen renovation contract, the starred one", rows("reno_contract"),
    ref=[ans(kind="document", name="kitchen renovation contract", where="starred = yes")]),
  T("what else is in the reno folder", rows("dc50", "dc51", "dc52", "dc53", "dc54", "dc55", "dc56"),
    ref=[ans(kind="document", linked_to="$reno_f", exclude="$reno_contract")]),
  T("unstar the contract", diff(upd("reno_contract", starred=False)),
    ref=[act("unstar", rows="$reno_contract")]),
  T("any starred docs in there now", rows(),
    ref=[ans(kind="document", linked_to="$reno_f", where="starred = yes")]),
  T("is the permit due in january, the town needs it first", rows("permit"),
    ref=[find(kind="event", name="kitchen permit"), ans(kind="task", name="kitchen permit", when=W(U("month", 1)))]),
  T("push it to friday week", diff(upd("permit", date="2027-01-01")),
    ref=[act("reschedule", rows="$permit", args=lines(to=U("week", 2, weekday=5)))]))

S("D-E132", "group members balance settle",
  T("book club members, for the invite to the next one", rows("me", "liz", "pp40", "pp41", "pp42"),
    ref=[ans(kind="person", linked_to="$bookclub")]),
  T("what's my number for that one", val((-138.4, "USD")),
    ref=[search("Marisol", kind="person"), ans(op="balance", kind="group", name="Montclair Book Club", linked_to="$me")]),
  T("and liz", val((108.49, "USD")),
    ref=[ans(op="balance", kind="group", name="Montclair Book Club", linked_to="$liz")]),
  T("settle up with liz there", diff(upd("liz", balance=ANY)),
    ref=[act("settle_up", rows="$liz", args="group: $bookclub")]),
  T("how much does she owe me overall now", val((-246.13, "USD")),
    ref=[ans(op="balance", rows="$liz")]),
  T("which groups am i in with her", rows("beach", "bookclub", "gabi_bday", "ski", "dinner"),
    ref=[ans(kind="group", linked_to="$liz")]))

S("D-E133", "contacts week log star cadence count",
  T("which of my starred contacts have i been in touch with this week", rows("dev", "mama", "gabi", "nanny"),
    ref=[ans(kind="person", when=W(U("week", 0)), where="starred = yes")]),
  T("log a call with sunita", rows("sunita", also=diff(upd("sunita", date=ANY))),
    ref=[act("log", kind="person", name="sunita", args="kind: call", more=True), ans(kind="person", name="sunita")]),
  T("star her, she's going to be calling a lot now", diff(upd("sunita", starred=True)),
    ref=[act("star", rows="$sunita")]),
  T("make it weekly with her, 14 days is too slow", diff(upd("sunita", cadence=7)),
    ref=[act("edit", rows="$sunita", args="cadence: 7")]),
  T("who's on a weekly cadence now", rows("mama", "papa", "gabi", "sunita"),
    ref=[ans(kind="person", where="cadence <= 7 days")]),
  T("and who's starred and has a cadence", rows("mama", "gabi", "sunita", "liz"),
    ref=[ans(kind="person", where="starred = yes and cadence is set")]),
  T("how many people have a cadence", val(6),
    ref=[ans(op="count", kind="person", where="cadence is set")]))

S("D-E134", "locker reveal star wifi-ask",
  T("read me the school portal password", diff(reveal=[("school_portal", "Lulu&Arun")]),
    ref=[act("reveal", kind="locker item", name="school portal", args="field: password")]),
  T("and the alarm code", diff(reveal=[("alarm_d", "garage keypad")]),
    ref=[act("reveal", kind="locker item", name="alarm code", args="field: content")]),
  T("star the guest wifi, we keep needing it for visitors", diff(upd("guest_wifi_d", starred=True)),
    ref=[act("star", kind="locker item", name="guest wifi")]),
  T("tell me the wifi password", ask("wifi_lk", "guest_wifi_d", "mom_wifi"),
    ref=[find(kind="locker item", name="wifi"), askc("Which one: Home, Guest or Mamá's?", options="@1")]),
  T("guest", diff(reveal=[("guest_wifi_d", "welcome-montclair")]),
    ref=[act("reveal", rows="$guest_wifi_d", args="field: password")]))

S("D-E135", "person group balances settle",
  T("where do i stand with liz", val((-295.52, "USD")),
    ref=[ans(op="balance", rows="$liz")]),
  T("in gabi's 40th group", val((-0.45, "USD")),
    ref=[ans(op="balance", kind="group", name="Gabi's 40th", linked_to="$liz")]),
  T("and the supper club", val((134.03, "USD")),
    ref=[ans(op="balance", kind="group", name="Supper Club", linked_to="$liz")]),
  T("settle up with her in the supper club", diff(upd("liz", balance=ANY)),
    ref=[act("settle_up", rows="$liz", args="group: $dinner")]))

S("D-E136", "albums empty add count",
  T("which albums do i have", rows("al_lbi", "al_gdl25", "al_kids", "al_soccer", "al_ballet", "al_xmas25", "al_vt", "al_reno", "al_pets", "al_bday", "al_school"),
    ref=[ans(kind="album")]),
  T("which are empty", rows("al_kids", "al_school"),
    ref=[ans(within="@prev", where="photo count = 0")]),
  T("put the churro snow photo in the kids one", diff(link("al_kids", "churro_snow")),
    ref=[act("add_to", kind="photo", name="churro snow", args="to: $al_kids")]),
  T("kids album photo count now", val(1),
    ref=[ans(op="count", kind="photo", linked_to="$al_kids")]))

S("D-E137", "folder create move rename count",
  T("make a folder called archive", diff(new("folder", name="Archive")),
    ref=[act("create", args=lines(kind="folder", name="Archive"))]),
  T("move the 2024 pay stub in there", diff(unlink("work_f", "dc29"), link("+1", "dc29")),
    ref=[act("add_to", kind="document", name="pay stub 2024", args="to: $c1")]),
  T("call the folder old paperwork instead", diff(upd("+1", name="Old paperwork")),
    ref=[act("edit", rows="$c1", args="name: Old paperwork")]),
  T("doc count for it", val(1),
    ref=[ans(op="count", kind="document", linked_to="$c1")]))

S("D-E138", "list create move count rename",
  T("make a list called garage", diff(new("list", name="Garage")),
    ref=[act("create", args=lines(kind="list", name="Garage"))]),
  T("put organize garage in it", diff(unlink("home_l", "tk143"), link("+1", "tk143")),
    ref=[find(kind="task", name="organize garage", where="status = open"), act("add_to", rows="$tk143", args="to: $c1")]),
  T("how many tasks are in the garage list", val(1),
    ref=[ans(op="count", kind="task", linked_to="$c1")]),
  T("rename it to workshop", diff(upd("+1", name="Workshop")),
    ref=[act("edit", rows="$c1", args="name: Workshop")]))

S("D-E139", "event edit rename duration reschedule log",
  T("what's the date night next week, we need a sitter", rows("date_night"),
    ref=[ans(kind="event", name="date night", when=W(U("week", 1)))]),
  T("rename it to dinner with dev", diff(upd("date_night", name="Dinner with Dev")),
    ref=[act("edit", rows="$date_night", args="name: Dinner with Dev")]),
  T("make it two hours", diff(upd("date_night", duration=120)),
    ref=[act("edit", rows="$date_night", args="duration: 120")]),
  T("move it to 8", diff(upd("date_night", date="2026-12-27T20:00")),
    ref=[act("reschedule", rows="$date_night", args=lines(to=U("week", 1, weekday=7, time="20:00")))]),
  T("log a call with dev about it, he said yes", diff(upd("dev", date=ANY)),
    ref=[act("log", kind="person", name="dev kapoor", args="kind: call")]))

S("D-E140", "decline mix completed list",
  T("can you book the restaurant for gabi's party", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("wipe everything in my photos", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("fine, just what's finished on the christmas list", rows("cards", "mama_gift"),
    ref=[ans(kind="task", linked_to="$xmas_l", where="status = completed")]),
  T("how many is that", val(2),
    ref=[ans(op="count", kind="task", linked_to="$xmas_l", where="status = completed")]))
