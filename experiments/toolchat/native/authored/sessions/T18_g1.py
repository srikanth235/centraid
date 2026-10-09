from gold import *
import json

world("T18", "2026-03-01T11:20", "Jordan Ellis", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


NOW = W({"from": U("day", 0)})

S("T18-101", "ask options star sam never mind then named",
  T("star sam", ask("sam_o", "sam_t"),
    ref=[act("star", kind="person", name="Sam"),
         askc("sam okafor or sam tran?", options="$sam_o, $sam_t")]),
  T("nah forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("star sam okafor, he's the artist", diff(upd("sam_o", starred=True)),
    ref=[act("star", kind="person", name="Sam Okafor")]))

S("T18-102", "ask options star agreement documents already",
  T("star the agreement", diff(upd("steam_contract", starred=True)),
    ref=[act("star", kind="document", name="agreement")]),
  T("and the lease", diff(already=["lease"]),
    ref=[act("star", rows="$lease"), ans(rows="$lease")]))

S("T18-103", "ask options star licence locker unstar deck",
  T("star the licence", ask("licence", "unity"),
    ref=[act("star", kind="locker item", name="licence"),
         askc("your victorian driver licence or the unity pro one?", options="$licence, $unity")]),
  T("unity", diff(upd("unity", starred=True)),
    ref=[act("star", rows="$unity")]),
  T("and unstar the hollow pine deck, it's sent", diff(upd("deck", starred=False)),
    ref=[act("unstar", kind="document", name="Hollow Pine pitch deck")]))

S("T18-104", "wifi bare read then reveal then star itch",
  T("what's the home wifi password", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("show me the wifi password", diff(reveal=[("wifi", "biscuit-kelpie-5")]),
    ref=[act("reveal", rows="$wifi", args=lines(field="password"))]),
  T("star itch, i use it daily now", diff(upd("itch", starred=True)),
    ref=[act("star", kind="locker item", name="itch.io")]),
  T("unstar steamworks, i'm never on it now", diff(upd("steamworks", starred=False)),
    ref=[act("unstar", kind="locker item", name="Steamworks")]))

S("T18-105", "balance positive tess oliver priya",
  T("how much does tess owe me", val((80, "AUD")),
    ref=[ans(op="balance", rows="$tess")]),
  T("and oliver", val((390, "AUD")),
    ref=[ans(op="balance", rows="$oliver")]),
  T("priya?", val((168, "AUD")),
    ref=[ans(op="balance", rows="$priya")]),
  T("star priya, she's the backbone of the co-op", diff(upd("priya", starred=True)),
    ref=[act("star", kind="person", name="Priya")]))

S("T18-106", "balance negative nadia alex bui then zero dad",
  T("what do i owe nadia", val((-60, "AUD")),
    ref=[ans(op="balance", rows="$nadia")]),
  T("and alex bui", val((-120, "AUD")),
    ref=[ans(op="balance", rows="$alex_b")]),
  T("and dad", val((0, "AUD")),
    ref=[search("dad"), ans(op="balance", rows="$dad")]))

S("T18-107", "balance group coop dnd members",
  T("who's in the co-op", rows("priya", "sam_o", "mei", "oliver", "me"),
    ref=[ans(kind="person", linked_to="$coop")]),
  T("where am i at with them", val((878, "AUD")),
    ref=[ans(op="balance", kind="group", name="Tinfoil Owl co-op", linked_to="$me")]),
  T("and the d&d lot", val((75, "AUD")),
    ref=[ans(op="balance", kind="group", name="Thursday D&D", linked_to="$me")]),
  T("star mei, she runs the whole co-op", diff(upd("mei", starred=True)),
    ref=[act("star", kind="person", name="Mei")]))

S("T18-108", "ask options move lunch then contrast vet",
  T("move lunch to 1", ask("mum_lunch", "nana_lunch"),
    ref=[act("reschedule", kind="event", name="lunch", when=NOW,
             args=lines(to=U("day", 0, anchor="row", time="13:00"))),
         askc("lunch with mum on the 8th or nana's 85th on the 12th of april?", options="$mum_lunch, $nana_lunch")]),
  T("mum's", diff(upd("mum_lunch", date="2026-03-08T13:00")),
    ref=[act("reschedule", rows="$mum_lunch", args=lines(to=U("day", 0, anchor="row", time="13:00")))]),
  T("and move the vet check-up to 11", diff(upd("vet_apr", date="2026-04-15T11:00")),
    ref=[act("reschedule", kind="event", name="vet check-up", when=NOW,
             args=lines(to=U("day", 0, anchor="row", time="11:00")))]),
  T("and bring back band practice, we're playing after all", diff(restore("band")),
    ref=[find(kind="event", trashed=True, name="Band practice"), act("restore", rows="@prev")]))

S("T18-109", "ask options biscuit appointment reschedule then undo",
  T("move biscuit's appointment to 5", ask("vet_apr", "vax"),
    ref=[act("reschedule", kind="event", name="Biscuit's", when=NOW,
             args=lines(to=U("day", 0, anchor="row", time="17:00"))),
         askc("the vaccination on wednesday or the vet check-up in april?", options="$vet_apr, $vax")]),
  T("the vaccination", diff(upd("vax", date="2026-03-04T17:00")),
    ref=[act("reschedule", rows="$vax", args=lines(to=U("day", 0, anchor="row", time="17:00")))]),
  T("actually cancel that, 4 was fine", diff(upd("vax", date="2026-03-04T16:00")),
    ref=[act("undo")]))

S("T18-110", "ask options cancel dog training then contrast climbing",
  T("cancel dog training", ask("dogclass_0307", "dogclass_0314"),
    ref=[act("cancel", kind="event", name="Dog training class", when=NOW),
         find(kind="event", name="Dog training class", when=NOW),
         askc("this saturday the 7th or the 14th?", options="$dogclass_0307, $dogclass_0314")]),
  T("the 14th", diff(upd("dogclass_0314", status="cancelled")),
    ref=[act("cancel", rows="$dogclass_0314")]),
  T("and climbing tomorrow, my fingers are wrecked", diff(upd("climb_mar", status="cancelled")),
    ref=[act("cancel", kind="event", name="Climbing with Brooke", when=W(U("day", 1)))]),
  T("restore the old epic login, the kid wants it", diff(restore("epic")),
    ref=[find(kind="locker item", trashed=True, name="old epic"), act("restore", rows="@prev")]))

S("T18-111", "ask options tick off rent then pick then undo",
  T("tick off rent", ask("rent_mar", "rent_apr"),
    ref=[act("complete", kind="task", name="Pay rent", where='status = "open"'),
         find(kind="task", name="Pay rent", where='status = "open"'),
         askc("march's or april's?", options="$rent_mar, $rent_apr")]),
  T("march", diff(upd("rent_mar", status="completed", completed=ANY)),
    ref=[act("complete", rows="$rent_mar")]),
  T("don't bother, undo that, i'll do it monday", diff(upd("rent_mar", status="open", completed=None)),
    ref=[act("undo")]))

S("T18-112", "ask options shower task friday then contrast invites monday",
  T("move the shower task to friday", ask("invites", "print_games", "playlist"),
    ref=[act("reschedule", kind="task", name="shower", args=lines(to=U("week", 1, weekday=5))),
         askc("send the invites, print the games or make the playlist?", options="$invites, $print_games, $playlist")]),
  T("the playlist", diff(upd("playlist", date="2026-03-06")),
    ref=[act("reschedule", rows="$playlist", args=lines(to=U("week", 1, weekday=5)))]),
  T("and push the invites to monday at 9, chloe wants to check the wording first",
    diff(upd("invites", date="2026-03-02T09:00")),
    ref=[act("reschedule", kind="task", name="Send shower invites", args=lines(to=U("week", 1, weekday=1, time="09:00")))]),
  T("is resume 2023 in the trash", rows("resume"),
    ref=[find(kind="document", trashed=True, name="Resume 2023"), ans(rows="@prev")]))

S("T18-113", "ask options tick off biscuit task then read list",
  T("tick off the biscuit one", ask("flea", "nails", "vax_book"),
    ref=[act("complete", kind="task", name="Biscuit"),
         askc("the flea treatment, trimming his nails or the vaccination booking?", options="$flea, $nails, $vax_book")]),
  T("nails, did them this morning", diff(upd("nails", status="completed", completed=ANY)),
    ref=[act("complete", rows="$nails")]),
  T("what's left on the biscuit list", rows("dog_food", "flea", "pet_ins_t"),
    ref=[ans(kind="task", linked_to="$dog_l", where='status = "open"')]),
  T("how many photos have i deleted", val(2),
    ref=[ans(op="count", kind="photo", trashed=True)]))
