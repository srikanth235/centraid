from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T04-051", "compute group status narrowing sum effort",
  T("breakdown of the wedding prep list by status",
    vgroups({"open": 5, "in_progress": 2, "completed": 2}),
    ref=[comp(op="count", group="status", kind="task", linked_to="$wedlist"), ans(value="@prev")]),
  T("which ones haven't i even started", rows("favours", "caterer_nums", "rsvps", "playlist", "seating"),
    ref=[ans(kind="task", linked_to="$wedlist", where='status = "open"')]),
  T("how many wedding jobs are due from next week to end of next month", val(5),
    ref=[ans(op="count", kind="task", linked_to="$wedlist", when=W({"from": U("week", 1), "to": U("month", 1)}))]),
  T("which one was the bombay mix thing", rows("favours"),
    ref=[ans(kind="task", where='description contains "Bombay"')]))

S("T04-052", "min max debts find person",
  T("smallest amount someone owes me", val((12.8, "GBP")),
    ref=[ans(op="min", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("and the most i owe anyone", val((500, "GBP")),
    ref=[ans(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("who to", rows("dad"),
    ref=[find(kind="debt", where='direction = "i_owe" and status = "open"', order="amount desc", limit=1),
         ans(kind="person", linked_to="@prev")]),
  T("anyone with a nickname i check in with fortnightly", rows("dad"),
    ref=[ans(kind="person", where="nickname is set and cadence = 14")]))

S("T04-053", "find linked_to reschedule week span act when anchor hour",
  T("move my next darkroom night with owen to wednesday next week", diff(upd("dark_1015", date="2026-10-21T18:30")),
    ref=[search("owen", kind="person"),
         find(kind="event", linked_to="$owen", when=W({"from": U("day", 0)}), order="date asc", limit=1),
         act("reschedule", rows="$dark_1015", args=lines(to=U("week", 1, weekday=3)))]),
  T("what's the rest of this week look like",
    rows("leah_dinner", "rota_meet", "ld_1016", "fitting_1", "fb_1017", "lunch_1018"),
    ref=[ans(kind="event", when=W({"from": U("day", 0), "to": U("week", 0, weekday=7)}))]),
  T("push sunday lunch back an hour", diff(upd("lunch_1018", date="2026-10-18T14:00")),
    ref=[act("reschedule", kind="event", name="Sunday lunch", args=lines(to=U("hour", 1, anchor="row"))),
         act("reschedule", kind="event", name="Sunday lunch", when=W(U("week", 0, weekday=7)),
             args=lines(to=U("hour", 1, anchor="row")))]),
  T("anything an hour or less from friday to end of next week", rows("grand_round", "car_service", "wcall_1022", "aoife_coffee", "yoga_1024"),
    ref=[ans(kind="event", when=W({"from": U("week", 0, weekday=5), "to": U("week", 1)}), where="duration <= 60")]))

S("T04-054", "weekend within exclude cancel",
  T("what have i got this weekend", rows("fitting_1", "fb_1017", "lunch_1018"),
    ref=[ans(kind="event", when=W({"from": U("week", 0, weekday=6), "to": U("week", 0, weekday=7)}))]),
  T("cancel all that except lunch at mum's, i'm wrecked",
    diff(upd("fitting_1", status="cancelled"), upd("fb_1017", status="cancelled")),
    ref=[find(within="@prev", exclude="$lunch_1018"), act("cancel", rows="$fb_1017, $fitting_1")]),
  T("anything cancelled before this week", rows("supervisor", "fb_1003", "pub_quiz", "yoga_1010"),
    ref=[ans(kind="event", when=W({"to": U("week", -1)}), where='status = "cancelled"')]),
  T("and from monday to the thirtieth, anything at the photo co-op", rows("dark_1029"),
    ref=[ans(kind="event", when=W({"from": U("week", 1, weekday=1), "to": D("2026-10-30")}),
             where='description contains "Co-op"')]))

S("T04-055", "trashed photos album count",
  T("what photos have i deleted", rows("screenshot", "blurry"),
    ref=[ans(kind="photo", trashed=True)]),
  T("bring blurry darkroom shot back", diff(restore("blurry")),
    ref=[act("restore", rows="$blurry")]),
  T("loose pics, the ones i never sorted into an album", rows("house_dinner", "ward_cake", "sunrise", "leah_selfie", "car_pic", "blurry"),
    ref=[ans(kind="photo", where="album count = 0")]))

S("T04-056", "act linked_to complete when week cancel date",
  T("rang auntie nasreen, tick that off. anything else due this week",
    rows("boiler", "bins", "wul_1", "tins", "develop", "rota_swap", "fb_rota",
         also=diff(upd("call_nasreen", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", linked_to="$nasreen", more=True),
         ans(kind="task", when=W(U("week", 0)), where='status = "open"')]),
  T("and cancel darkroom on the twenty-ninth, i'm on call", diff(upd("dark_1029", status="cancelled")),
    ref=[act("cancel", kind="event", name="Darkroom night"),
         act("cancel", kind="event", name="Darkroom night", when=W(D("2026-10-29")))]))

S("T04-057", "act within act where complete",
  T("what's on the istanbul list", rows("lira", "passport_check", "sashes", "evisa", "airport_parking"),
    ref=[ans(kind="task", linked_to="$istlist")]),
  T("sashes are ordered", diff(upd("sashes", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", within="@prev", name="sashes")]))

S("T04-058", "not_found then substitute",
  T("when's my smear test", decline("not_found"),
    ref=[search("smear"), dec("not_found")]),
  T("fine when's the dentist", rows("dentist"),
    ref=[ans(kind="event", name="Dentist")]),
  T("log a call with dr sharma, i rebooked", diff(upd("sharma", date=ANY)),
    ref=[act("log", rows="$sharma", args=lines(kind="call"))]),
  T("how many long days have i got down before december", val(11),
    ref=[ans(op="count", kind="event", name="Long day AMU", when=W({"to": U("month", 0, name=11)}))]))

S("T04-059", "person delete trashed restore both",
  T("delete bilal akhtar, he's blocked me", diff(trash("bilal")),
    ref=[act("delete", kind="person", name="Bilal Akhtar")]),
  T("who's in the people trash", rows("craig", "bilal"),
    ref=[ans(kind="person", trashed=True)]),
  T("ugh restore them both, mum says be nice", diff(restore("craig"), restore("bilal")),
    ref=[act("restore", rows="$craig, $bilal")]),
  T("who's my dentist again", rows("sharma"),
    ref=[ans(kind="person", where='role = "dentist"')]))

S("T04-060", "photo ask star unstar",
  T("star the harbour pic", ask("harbour", "gulls"),
    ref=[act("star", kind="photo", name="harbour"),
         askc("whitby harbour boats or gulls over the harbour?", options="$harbour, $gulls")]),
  T("whitby harbour boats", diff(upd("harbour", starred=True)),
    ref=[act("star", rows="$harbour")]))

S("T04-061", "write then read subtasks reopen",
  T("found the childhood photos, what's left on the speech",
    rows("speech_practise", also=diff(upd("speech_photos", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Dig out childhood photos for speech", more=True),
         ans(kind="task", linked_to="$speech", where='status = "open"')]),
  T("reopen the first draft one, zainab vetoed half of it", diff(upd("speech_draft", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="First draft of speech")]))

S("T04-062", "cancel then attendees decline",
  T("cancel cake tasting, the bakery's shut. who do i need to tell",
    rows("zainab", "hamza", also=diff(upd("cake", status="cancelled"))),
    ref=[act("cancel", kind="event", name="Cake tasting", more=True),
         ans(kind="person", linked_to="$cake")]),
  T("whatsapp them for me", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T04-063", "note body contains edit",
  T("which of my notes mention insulin", rows("dka", "hyperkal"),
    ref=[ans(kind="note", where='body contains "insulin"')]),
  T("biryani?", rows("menu_notes"),
    ref=[ans(kind="note", where='body contains "biryani"')]),
  T("add seekh kebabs to menu ideas",
    diff(upd("menu_notes", body="lamb karahi, chicken biryani, gulab jamun, no prawns (Hamza allergic), seekh kebabs")),
    ref=[opn("$menu_notes"), act("edit", rows="$menu_notes",
             args=lines(body="lamb karahi, chicken biryani, gulab jamun, no prawns (Hamza allergic), seekh kebabs"))]))

S("T04-064", "nickname is set starred star person",
  T("who've i got nicknames for", rows("mum", "dad", "nasreen", "tom", "dan", "kev"),
    ref=[ans(kind="person", where="nickname is set")]),
  T("which of them are starred", rows("mum"),
    ref=[ans(kind="person", within="@prev", where="starred = yes")]),
  T("star abbu too", diff(upd("dad", starred=True)),
    ref=[search("abbu", kind="person"), act("star", rows="$dad")]))

S("T04-065", "link counts ask photo",
  T("whose face appears in 3 or more of my photos", rows("zainab", "mum", "dad", "ravi", "owen"),
    ref=[ans(kind="person", where="photo count >= 3")]),
  T("and which albums have over 5 pics", rows("whitby_album", "fam_album"),
    ref=[ans(kind="album", where="photo count > 5")]),
  T("put the one of owen in darkroom prints", ask("fish_chips", "owen_cam", "enlarger"),
    ref=[act("add_to", kind="photo", linked_to="$owen", args=lines(to="$dark_album")),
         askc("fish and chips at the magpie, owen with the mamiya, or the durst enlarger?",
              options="$fish_chips, $owen_cam, $enlarger")]))

S("T04-066", "empty containers delete",
  T("any empty folders", rows("scans_f", "receipts_f"),
    ref=[ans(kind="folder", where="document count = 0")]),
  T("notebooks?", rows("old_nb"),
    ref=[ans(kind="notebook", where="note count = 0")]),
  T("delete all three", diff(gone("scans_f"), gone("receipts_f"), gone("old_nb")),
    ref=[act("delete", rows="$scans_f, $receipts_f", more=True), act("delete", rows="$old_nb")]))

S("T04-067", "compute name group trashed",
  T("how many food bank shifts are on vs cancelled", vgroups({"tentative": 9, "cancelled": 1}),
    ref=[comp(op="count", group="status", kind="event", name="Food bank shift"), ans(value="@prev")]),
  T("how many tasks in the trash, by status", vgroups({"open": 2}),
    ref=[comp(op="count", group="status", kind="task", trashed=True), ans(value="@prev")]),
  T("how many events have i got from first nov through december", val(26),
    ref=[ans(op="count", kind="event", when=W({"from": D("2026-11-01"), "to": U("month", 0, name=12)}))]),
  T("and how many food bank shifts did i actually do from september up to the tenth", val(3),
    ref=[ans(op="count", kind="event", name="Food bank shift", where='status != "cancelled"',
             when=W({"from": U("month", 0, name=9), "to": D("2026-10-10")}))]))

S("T04-068", "compute rows within exclude",
  T("list every debt open",
    rows("d_chloe", "d_tom", "d_zainab", "d_leah", "d_james", "d_dad", "d_fatima_k", "d_fatima_h", "d_aoife", "d_sana"),
    ref=[ans(kind="debt", where='status = "open"')]),
  T("split that by direction", vgroups({"owes_me": (306.3, "GBP"), "i_owe": (584, "GBP")}),
    ref=[comp(op="sum", field="amount", group="direction", rows="@prev"), ans(value="@prev")]),
  T("same without dad's, that's a long term thing", vgroups({"owes_me": (306.3, "GBP"), "i_owe": (84, "GBP")}),
    ref=[search("dad"), find(kind="debt", linked_to="$dad"),
         comp(op="sum", field="amount", group="direction", kind="debt", where='status = "open"', exclude="$d_dad"),
         ans(value="@prev")]),
  T("wipe all my debts, fresh start", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T04-069", "search nicknames log both decline",
  T("had tea at ammi and abbu's, log a visit with both", diff(upd("mum", date=ANY), upd("dad", date=ANY)),
    ref=[search("ammi", kind="person"), search("abbu", kind="person"),
         act("log", rows="$mum, $dad", args=lines(kind="visit"))]),
  T("and text imran the photos from today", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T04-070", "event create span note read repair add_to",
  T("book a darkroom session sat twenty-fourth 7 till 10",
    diff(new("event", name=has("darkroom"), date="2026-10-24T19:00", duration=180)),
    ref=[act("create", args=lines(kind="event", name="Darkroom session",
                                  date={"from": D("2026-10-24", "19:00"), "to": D("2026-10-24", "22:00")}))]),
  T("put the test strip pic in whitby", diff(link("whitby_album", "test_strip")),
    ref=[bad(act("add_to", kind="photo", name="Test strip", args=lines(album="$whitby_album"))),
         act("add_to", kind="photo", name="Test strip", args=lines(to="$whitby_album"))]),
  T("who did i meet through the photo co-op", rows("owen"),
    ref=[ans(kind="person", where='met contains "Photo Co-op"')]),
  T("move the als course to december", ask("als_1", "als_2"),
    ref=[act("reschedule", kind="event", name="ALS course", args=lines(to=U("month", 1))),
         askc("day 1 or day 2? or both?", options="$als_1, $als_2")]))

S("T04-071", "subtask create linked ask rent",
  T("add a subtask under the speech: time it, under five mins",
    diff(new("task", name=has("time it")), link("speech", "new")),
    ref=[act("create", args=lines(kind="task", name="Time it, under 5 mins", parent="$speech"))]),
  T("what subtasks has it got", rows("speech_draft", "speech_photos", "speech_practise", "+1"),
    ref=[ans(kind="task", linked_to="$speech")]),
  T("and paid the rent, mark it", ask("rent_oct", "rent_nov"),
    ref=[act("complete", kind="task", name="Pay rent"),
         find(kind="task", name="Pay rent"),
         askc("october's (already done) or november's?", options="$rent_oct, $rent_nov")]))

S("T04-072", "month name narrowing priority",
  T("what's due in november",
    rows("caterer_nums", "lira", "airport_parking", "reflections", "cbd", "als_prep", "gmc_fee", "rent_nov", "hampers",
         "car_ins", "imran_gift", "seating", "speech_practise"),
    ref=[ans(kind="task", when=W(U("month", 0, name=11)))]),
  T("any of them high priority", rows("caterer_nums", "cbd", "rent_nov", "car_ins"),
    ref=[ans(kind="task", within="@prev", where="priority >= 1 and priority <= 2")]),
  T("which of those take over an hour", rows("seating", "als_prep", "reflections"),
    ref=[ans(kind="task", within="@1", where="effort > 60")]),
  T("how many per priority in that lot", vgroups({"none": 3}),
    ref=[comp(op="count", group="priority", within="@prev"), ans(value="@prev")]))

S("T04-073", "count last month repair kind",
  T("how many car loan payments went out last month", val(1),
    ref=[ans(op="count", kind="task", name="Car loan payment", where='status = "completed"', when=W(U("month", -1)))]),
  T("what's my gmc certificate number", rows("gmc"),
    ref=[bad(ans(kind="gmc", name="GMC number")),
         ans(kind="locker item", name="GMC certificate")]),
  T("reopen september's actually, it bounced", diff(upd("loan_09", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Car loan payment"),
         act("reopen", kind="task", name="Car loan payment", when=W(U("month", -1)))]),
  T("and my gmc online password, guess from my usual ones", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T04-074", "hour unit create minute anchor",
  T("remind me in two hrs to text kev about the brakes", diff(new("task", name=has("kev"), date="2026-10-14T21:40")),
    ref=[act("create", args=lines(kind="task", name="Text Kev about the brakes", date=U("hour", 2)))]))

S("T04-075", "since january count from month",
  T("how many loan payments have i made since jan", val(9),
    ref=[ans(op="count", kind="task", name="Car loan payment", where='status = "completed"',
             when=W({"from": U("month", 0, name=1)}))]),
  T("when does the following one fall due", rows("loan_10"),
    ref=[ans(kind="task", name="Car loan payment", where='status = "open"')]),
  T("make it priority one, i always forget", diff(upd("loan_10", priority=1)),
    ref=[act("edit", rows="$loan_10", args=lines(priority=1))]))
