from gold import *
import json

world("T29", "2026-09-23T18:10", "Achieng Odhiambo", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T29-060", "home-list count person-count bulk-reschedule undo narrow-week find-bulk",
  T("how many open tasks on the home list are due before october and aren't about anyone", val(5),
    ref=[ans(op="count", kind="task", linked_to="$home_list", where="status = open and person count = 0",
             when=J({"to": D("2026-09-30")}))]),
  T("push those to next friday",
    diff(upd("mpesa_float", date="2026-10-02"), upd("kplc", date="2026-10-02"), upd("dog_food", date="2026-10-02"),
         upd("gas", date="2026-10-02"), upd("flat_fix", date="2026-10-02")),
    ref=[find(kind="task", linked_to="$home_list", where="status = open and person count = 0",
              when=J({"to": D("2026-09-30")})),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=5)))]),
  T("undo that",
    diff(upd("mpesa_float", date="2026-09-24"), upd("kplc", date="2026-09-26"), upd("dog_food", date="2026-09-27"),
         upd("gas", date="2026-09-28"), upd("flat_fix", date="2026-09-30")),
    ref=[act("undo")]),
  T("only this week's ones",
    diff(upd("mpesa_float", date="2026-10-02"), upd("kplc", date="2026-10-02"), upd("dog_food", date="2026-10-02")),
    ref=[find(kind="task", linked_to="$home_list", where="status = open and person count = 0", when=J(U("week", 0))),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=5)))]))

S("T29-062", "calendar ambiguous-event cancel call next-week role-narrow",
  T("cancel the call next week", ask("structural", "berlin_call"),
    ref=[act("cancel", kind="event", name="call", when=J(U("week", 1)))]),
  T("the lena one", diff(upd("berlin_call", status="cancelled")),
    ref=[act("cancel", kind="event", name="call", linked_to="$lena")]))

S("T29-063", "trash restore note photo date-narrow",
  T("put the scratch list back", diff(restore("old_todo")),
    ref=[act("restore", kind="note", name="scratch list", trashed=True)]),
  T("and the blurry photo, the one from the 2nd", diff(restore("p_blurry")),
    ref=[act("restore", kind="photo", name="blurry", when=J(D("2026-09-02")), trashed=True)]))

S("T29-064", "photos docs trash bulk-star september count-person-count exclude archive past-window restore search-miss ambiguous-note pin",
  T("star everything in the karen site album from september that isn't starred",
    diff(upd("p_site_cols", starred=True), upd("p_site_slab", starred=True), upd("p_site_rain", starred=True),
         upd("p_site_visit", starred=True), upd("p_site_truss", starred=True)),
    ref=[find(kind="photo", linked_to="$site_album", where="starred = no", when=J(U("month", 0, name=9))),
         act("star", rows="@prev")]),
  T("how many of the starred ones have somebody in them", val(5),
    ref=[ans(op="count", kind="photo", where="starred = yes and person count >= 1")]),
  T("put the club docs from this year in the archive folder except the constitution",
    diff(link("archive_f", "club_budget"), unlink("club_f", "club_budget"),
         link("archive_f", "jersey_quote"), unlink("club_f", "jersey_quote")),
    ref=[find(kind="document", linked_to="$club_f", when=J(U("year", 0)), exclude="$club_constitution"),
         act("add_to", rows="@prev", args="to: $archive_f")]),
  T("pin the karen meeting note in site notes", ask("karen_site1", "karen_site2", "karen_site3"),
    ref=[act("edit", kind="note", name="karen meeting", linked_to="$site_nb", args="pinned: yes")]),
  T("yesterday's one", diff(upd("karen_site3", pinned=True)),
    ref=[act("edit", kind="note", name="karen meeting", when=J(U("day", -1)), args="pinned: yes")]),
  T("and the old quote template, bring it back", decline("not_found"),
    ref=[act("restore", kind="document", name="old quote template", trashed=True)]),
  T("bring back the meeting with rose from august", diff(restore("old_meet")),
    ref=[act("restore", kind="event", name="meeting with rose", when=J(U("month", 0, name=8)), trashed=True)]),
  T("and rose wanjala herself, she's a client again", diff(restore("old_client")),
    ref=[act("restore", kind="person", name="rose wanjala", trashed=True)]),
  T("any photos from the lamu trip in august", rows(),
    ref=[search("lamu"), ans(kind="photo", name="lamu", when=J(U("month", 0, name=8)))]),
  T("karen site electrician?", rows(),
    ref=[search("electrician"), ans(kind="person", name="electrician")]))

# follow-up turns appended to sessions of the earlier files (their own turns stay as they are)
X("T29-040",
  T("and how many of those take half an hour or more", val(3),
    ref=[ans(op="count", kind="task", where="status = open and effort >= 30 minutes", when=J(U("week", 0)))]))

X("T29-046",
  T("now push the rest of the home tasks due this week to monday",
    diff(upd("mpesa_float", date="2026-09-28"), upd("kplc", date="2026-09-28")),
    ref=[find(kind="task", linked_to="$home_list", where="status = open", when=J(U("week", 0))),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]))

X("T29-047",
  T("and move the faith design review to monday", ask("client_faith", "client_faith2"),
    ref=[act("reschedule", kind="event", name="design review", linked_to="$faith",
             args=lines(to=U("week", 1, weekday=1)))]))

X("T29-026",
  T("any airport transfer booked for the 22nd", rows(),
    ref=[search("transfer"), ans(kind="event", name="transfer", when=J(D("2026-10-22")))]))

X("T29-053",
  T("next doctor's appointment?", rows(),
    ref=[search("doctor"), ans(kind="event", name="doctor", when=J({"from": U("day", 0)}), order="date asc", limit=1)]))

X("T29-037",
  T("and my old safaricom login, bring it back", diff(restore("old_login")),
    ref=[act("restore", kind="locker item", name="safaricom login", trashed=True)]))
