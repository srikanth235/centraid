from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-172", "search-role goalkeeper star starred-football",
  T("who's the goalkeeper", rows("tomek_m"),
    ref=[search("goalkeeper", kind="person"), ans(rows="@1")]),
  T("star him", diff(upd("tomek_m", starred=True)),
    ref=[act("star", rows="$tomek_m")]),
  T("which of the tuesday football lot are starred now", rows("marcin_l", "tomek_m"),
    ref=[ans(kind="person", where='met = "Tuesday football" and starred = yes')]))

S("T31-173", "search-role barber next-haircut delete restore",
  T("who's the barber", rows("barber"),
    ref=[search("barber", kind="person"), ans(rows="@1")]),
  T("when's my next haircut with him", rows("barber_ev"),
    ref=[ans(kind="event", linked_to="$barber", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("delete it, i'll go to someone else", diff(trash("barber_ev")),
    ref=[act("delete", rows="$barber_ev")]),
  T("no wait, bring the haircut back", diff(restore("barber_ev")),
    ref=[find(kind="event", name="haircut", trashed=True), act("restore", rows="@4")]))

S("T31-174", "search-role doctor tasks-about create-note add-to-notebook",
  T("who's the doctor on the ward", rows("przemek"),
    ref=[search("doctor", kind="person"), ans(rows="@1")]),
  T("which tasks are about him", rows("cpr_prep"),
    ref=[ans(kind="task", linked_to="$przemek")]),
  T("new note: pump training questions, ask przemek about the december date. put it in ward notes",
    diff(new("note", name=has("pump training"), body=has("przemek")), link("ward_nb", "new")),
    ref=[act("create", kind="note", args=lines(name="Pump training questions", body="ask przemek about the december date"), more=True),
         act("add_to", rows="$new", args=lines(to="$ward_nb"))]))

S("T31-175", "search-role grandmother name-day-lunch tasks-about",
  T("who's my grandmother", rows("babcia"),
    ref=[search("grandmother", kind="person"), ans(rows="@1")]),
  T("when's her name day lunch", rows("babcia_name_day"),
    ref=[ans(kind="event", linked_to="$babcia", name="name day")]),
  T("and what tasks are there about her", rows("babcia_gift"),
    ref=[ans(kind="task", linked_to="$babcia")]))

S("T31-176", "search-role physio next-session one-after exclude",
  T("who's the physio", rows("physio"),
    ref=[search("physio", kind="person"), ans(rows="@1")]),
  T("when's my next session with her", rows("physio_a"),
    ref=[ans(kind="event", linked_to="$physio", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("and the one after that", rows("physio_b"),
    ref=[ans(kind="event", linked_to="$physio", order="date asc", limit=1, when=J({"from": U("day", 0)}), exclude="$physio_a")]))

S("T31-182", "trash-notes restore shopping-list draft-still-in",
  T("what's in the notes trash", rows("old_draft", "old_note"),
    ref=[ans(kind="note", trashed=True)]),
  T("bring the old shopping list back", diff(restore("old_note")),
    ref=[find(kind="note", name="old shopping list", trashed=True), act("restore", rows="@2")]),
  T("is the draft to the landlord still in there", rows("old_draft"),
    ref=[ans(kind="note", name="draft", trashed=True)]))

S("T31-183", "trash-photos restore add-to-album",
  T("show me the photos i've thrown out", rows("p_screen", "p_blurry"),
    ref=[ans(kind="photo", trashed=True)]),
  T("bring back the blurry one", diff(restore("p_blurry")),
    ref=[find(kind="photo", name="blurry", trashed=True), act("restore", rows="@2")]),
  T("file it in the football album, it's from the game", diff(link("football_a", "p_blurry")),
    ref=[act("add_to", rows="$p_blurry", args=lines(to="$football_a"))]))

S("T31-184", "trash-documents restore folder-contents",
  T("list the documents i've thrown away", rows("d_old_inv", "d_old_lease"),
    ref=[ans(kind="document", trashed=True)]),
  T("bring back the podgorze lease", diff(restore("d_old_lease")),
    ref=[find(kind="document", name="podgorze", trashed=True), act("restore", rows="@2")]),
  T("what's in the flat folder now", rows("d_lease25", "d_lease26", "d_inventory", "d_boiler", "d_old_lease"),
    ref=[ans(kind="document", linked_to="$flat_f")]))

S("T31-185", "ambiguous-pit star pick-2024 starred-taxes",
  T("star the pit-37", ask("d_pit25", "d_pit24"),
    ref=[act("star", kind="document", name="pit-37")]),
  T("the 2024 one", diff(upd("d_pit24", starred=True)),
    ref=[act("star", rows="$d_pit24")]),
  T("which documents have i starred in the taxes folder", rows("d_pit24"),
    ref=[ans(kind="document", linked_to="$taxes_f", where="starred = yes")]))

S("T31-186", "ambiguous-flight delete pick restore",
  T("delete the flight", ask("london_flight", "london_back"),
    ref=[act("delete", kind="event", name="flight")]),
  T("the one back from london", diff(trash("london_back")),
    ref=[act("delete", rows="$london_back")]),
  T("bring the flight back", diff(restore("london_back")),
    ref=[find(kind="event", name="flight", trashed=True), act("restore", rows="@1")]))

S("T31-187", "ambiguous-physio edit-duration pick knee",
  T("make the physio 60 minutes long", ask("physio_a", "physio_b", "physio_c"),
    ref=[act("edit", kind="event", name="physio", args="duration: 60")]),
  T("the knee one", diff(upd("physio_c", duration=60)),
    ref=[act("edit", rows="$physio_c", args="duration: 60")]))
