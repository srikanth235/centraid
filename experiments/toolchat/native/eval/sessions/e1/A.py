from gold import *
import json

world("A", "2026-10-14T08:40", "Priya Raman", "eval")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("A-E001", "diary reschedule follow-up",
  T("what's in the diary today, need to fit a half hour call in somewhere before the plumber comes", rows("plumber", "haircut"),
    ref=[ans(kind="event", when=W(U("day", 0)))]),
  T("and tomorrow?", rows("oneonone10", "pottery"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("push the haircut to 6", diff(upd("haircut", date="2026-10-14T18:00")),
    ref=[act("reschedule", rows="$haircut", args=lines(to=U("day", 0, time="18:00")))]))

S("A-E002", "tasks week complete",
  T("what's due this week, trying to plan around the wedding stuff and the plumber visit on wednesday",
    rows("faucet", "dogfood", "amazon", "roadmap", "review_luis", "drycleaning", "callamma", "ammapkg", "vetbill", "plants"),
    ref=[ans(kind="task", when=W(U("week", 0)))]),
  T("tick off the faucet, marco came by and fixed it this morning before work", diff(upd("faucet", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="faucet")]),
  T("what's left for today till the end of the day", rows(),
    ref=[ans(kind="task", when=W(U("day", 0)), where='status = "open"')]))

S("A-E003", "ambiguous-person log ask follow-up",
  T("log a call with meera", ask("meera_i", "meera_s"),
    ref=[act("log", kind="person", name="Meera", args="kind: call"),
         askc("Meera Iyer or Meera Shah?", options="$meera_i, $meera_s")]),
  T("the yoga one", diff(upd("meera_s", date=ANY)),
    ref=[act("log", rows="$meera_s", args="kind: call")]),
  T("when did i last talk to the other one", rows("meera_i"),
    ref=[ans(rows="$meera_i")]))

S("A-E004", "debts list sum settle",
  T("who owes me money that i haven't been paid back yet, want to chase", rows("acltix", "concert", "arjun_gift", "farah_book"),
    ref=[ans(kind="debt", where='direction = owes_me and status = open')]),
  T("what's the total on those", val((212.99, "USD")),
    ref=[ans(op="sum", field="amount", within="@prev")]),
  T("kenji paid me back for the concert", diff(upd("concert", status="settled")),
    ref=[act("settle_debt", kind="debt", name="concert")]))

S("A-E005", "wifi reveal egress",
  T("home wifi pw?", rows("wifi"),
    ref=[ans(kind="locker item", name="Home wifi")]),
  T("show me, i'm at the router", diff(reveal=[("wifi", "biscuit-2208")]),
    ref=[act("reveal", rows="$wifi", args="field: password")]),
  T("text it to tomas so he can log in too", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("A-E006", "create-task add-to list follow-up",
  T("add a task, call the florist, due friday", diff(new("task", name=has("florist"), date="2026-10-16")),
    ref=[act("create", kind="task", args=lines(name="Call the florist", date=U("week", 0, weekday=5)))]),
  T("put it on the wedding list, that's where the rest of the wedding stuff lives", diff(link("wedding", "+1")),
    ref=[act("add_to", rows="$new", args="to: $wedding")]))

S("A-E007", "notebook notes pinned delete count",
  T("what's in my recipes notebook", rows("r1", "r2", "r3", "r4", "r5"),
    ref=[find(kind="note", linked_to="$recipes"), ans(rows="@1")]),
  T("which one's pinned", rows("r3"),
    ref=[ans(within="@prev", where="pinned = yes")]),
  T("delete the green chutney note", diff(trash("r4")),
    ref=[act("delete", kind="note", name="green chutney")]),
  T("count the recipes still in the notebook", val(4),
    ref=[ans(op="count", kind="note", linked_to="$recipes")]))

S("A-E008", "documents folder star",
  T("which starred docs are in the taxes folder", rows("w2form", "return"),
    ref=[ans(kind="document", linked_to="$taxes", where="starred = yes")]),
  T("star the 1099 too", diff(upd("int1099", starred=True)),
    ref=[act("star", kind="document", name="1099")]),
  T("which docs are starred now", rows("w2form", "int1099", "return", "lease", "passportscan"),
    ref=[ans(kind="document", where="starred = yes")]))

S("A-E009", "photos album people",
  T("photos from big bend with kenji in them, for his birthday card", rows("bb4", "bb5"),
    ref=[search("Kenji", kind="person"), ans(kind="photo", linked_to="$kenji, $bigbend_al")]),
  T("star the river one", diff(upd("bb5", starred=True)),
    ref=[act("star", rows="$bb5")]),
  T("any photos just floating loose, no album", rows("lo0", "lo1", "lo2", "lo3", "lo4", "lo5", "lo7", "lo8", "lo9"),
    ref=[ans(kind="photo", where="album count = 0")]))

S("A-E010", "group balance settle undo",
  T("where am i in big bend, did i overpay for the cabin", val((391.46, "USD")),
    ref=[search("Priya Raman", kind="person"), ans(op="balance", kind="group", name="Big Bend Trip", linked_to="$me")]),
  T("and jordan", val((-160.54, "USD")),
    ref=[ans(op="balance", kind="group", name="Big Bend Trip", linked_to="$jordan_b")]),
  T("settle up with him, he's in town till sunday", diff(settle=[("Jordan Blake", "110.40")]),
    ref=[act("settle_up", rows="$jordan_b", args="group: $bigbend")]),
  T("undo it, his payment hasn't landed", diff(),
    ref=[act("undo")]))

S("A-E011", "trashed task restore read",
  T("does the library books task still exist or did i get rid of it", rows("library"),
    ref=[find(kind="task", name="library books"), ans(kind="task", name="library books", trashed=True)]),
  T("bring it back, they're due soon", diff(restore("library")),
    ref=[act("restore", kind="task", name="library books", trashed=True)]),
  T("what's still open on errands besides that", rows("library", "dogfood", "amazon", "carreg", "drycleaning", "passphotos", "gift", "ammapkg", "vetbill"),
    ref=[ans(kind="task", linked_to="$errands", where="status = open")]))

S("A-E012", "create event undo recreate",
  T("lunch with olivia thursday at 1, the place near her office", diff(new("event", name=has("olivia"), date="2026-10-15T13:00")),
    ref=[act("create", kind="event", args=lines(name="Lunch with Olivia", date=U("week", 0, weekday=4, time="13:00")))]),
  T("undo that, she can't do thursday or the one after", diff(trash("+1")),
    ref=[act("undo")]),
  T("friday then", diff(new("event", name=has("olivia"), date="2026-10-16T13:00")),
    ref=[act("create", kind="event", args=lines(name="Lunch with Olivia", date=U("week", 0, weekday=5, time="13:00")))]))

S("A-E013", "create-person star",
  T("new contact naveen rao, cousin, met at the wedding expo",
    diff(new("person", name=has("Naveen"), role="cousin")),
    ref=[bad(act("create", kind="person", args=lines(name="Naveen Rao", role="cousin", met="wedding expo"))),
         act("create", kind="person", args=lines(name="Naveen Rao", role="cousin"))]),
  T("star him and log a coffee we had after the expo, we talked for ages", diff(upd("+1", starred=True, date=ANY)),
    ref=[act("star", rows="$new", more=True), act("log", rows="$new", args="kind: coffee")]))

S("A-E014", "list narrow reschedule",
  T("what's on errands that i haven't done yet", rows("dogfood", "amazon", "carreg", "drycleaning", "passphotos", "gift", "ammapkg", "vetbill"),
    ref=[ans(kind="task", linked_to="$errands", where="status = open")]),
  T("any of those due before the weekend, because saturday and sunday are gone so i want them done", rows("dogfood", "amazon", "drycleaning", "vetbill"),
    ref=[ans(within="@prev", when=W({"to": U("week", 0, weekday=5)}))]),
  T("move dry cleaning to friday, i can't get there thursday", diff(upd("drycleaning", date="2026-10-16")),
    ref=[act("reschedule", rows="$drycleaning", args=lines(to=U("week", 0, weekday=5)))]))

S("A-E015", "effort filter followup",
  T("any quick tasks under half an hour, got a gap before lunch", rows("dogfood", "amazon", "halfmarathon"),
    ref=[bad(ans(kind="task", where="effort < 0.5 hours")), ans(kind="task", where="effort < 30")]),
  T("which are due up to sunday", rows("dogfood", "amazon"),
    ref=[ans(within="@prev", when=W({"to": U("week", 0, weekday=7)}))]))

S("A-E016", "priority filter",
  T("what's top priority that i haven't finished, need to triage", rows("rent11", "roadmap", "carreg", "deposit", "passport"),
    ref=[bad(ans(kind="task", where='priority = "high" and status in ("open", "in_progress")')),
         ans(kind="task", where='priority = 1 and status in ("open", "in_progress")')]),
  T("which one's the longest job, need to block out a full afternoon or two for it", rows("roadmap"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]))

S("A-E017", "reopen already-so",
  T("reopen the plants task, i forgot and they're dying", diff(upd("plants", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="plants")]),
  T("is there any rent still open", rows("rent11"),
    ref=[ans(kind="task", name="pay rent", where="status = open")]),
  T("reopen pay rent, the transfer bounced", ask(),
    ref=[act("reopen", kind="task", name="pay rent"), askc("Which month's rent?")]),
  T("september's", diff(upd("rent9", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="pay rent", when=W(U("month", -1)))]))

S("A-E018", "note create rename pin",
  T("note called vet questions, ask about the chicken allergy and flea meds",
    diff(new("note", name=has("vet"), body=has("flea"))),
    ref=[act("create", kind="note", args=lines(name="Vet questions", body="ask about the chicken allergy and flea meds"))]),
  T("rename it to biscuit questions", diff(upd("+1", name=has("Biscuit", "questions"))),
    ref=[act("edit", rows="$new", args="name: Biscuit questions")]),
  T("pin it so it stays on top", diff(upd("+1", pinned=True)),
    ref=[act("edit", rows="$new", args="pinned: yes")]))

S("A-E019", "cancel event substitution undo-refused",
  T("cancel climbing on sunday, kenji's got a bad shoulder", diff(upd("climb", status="cancelled")),
    ref=[act("cancel", kind="event", name="climbing", when=W(U("week", 0, weekday=7)))]),
  T("and saturday's run, the first one", diff(upd("runclub", status="cancelled")),
    ref=[act("cancel", kind="event", name="run", when=W(U("week", 0, weekday=6)))]),
  T("undo that, he can make it", diff(),
    ref=[act("undo")]))

S("A-E020", "reschedule event time repair-by-user",
  T("move yoga next tuesday to 7, work's running late", diff(upd("yoga11", date="2026-10-20T19:00")),
    ref=[act("reschedule", kind="event", name="yoga", when=W(U("week", 1, weekday=2)),
             args=lines(to=U("week", 1, weekday=2, time="19:00")))]),
  T("hm too late, half six", diff(upd("yoga11", date="2026-10-20T18:30")),
    ref=[act("reschedule", rows="$yoga11", args=lines(to=U("week", 1, weekday=2, time="18:30")))]),
  T("what about yoga the week after, the second one", rows("yoga12"),
    ref=[ans(kind="event", name="yoga", when=W(U("week", 2)))]))

S("A-E021", "note body filter pin",
  T("which note mentions chicken", rows("biscuitnotes"),
    ref=[ans(kind="note", where='body contains "chicken"')]),
  T("pin that one", diff(upd("biscuitnotes", pinned=True)),
    ref=[act("edit", rows="$biscuitnotes", args="pinned: yes")]),
  T("what's pinned now across all my notes", rows("r3", "wd4", "giftideas", "packing", "biscuitnotes"),
    ref=[ans(kind="note", where="pinned = yes")]),
  T("pin the ideas one too", ask("w1", "wd3"),
    ref=[act("edit", kind="note", name="ideas", args="pinned: yes"),
         askc("Offsite agenda ideas or Mehndi night ideas?", options="$w1, $wd3")]))

S("A-E022", "locker logins reveal",
  T("which sites have i got logins for, doing a password cleanup so i can delete the dead ones", rows("netflix", "chase", "spotify", "router"),
    ref=[ans(kind="locker item", where="type = login")]),
  T("read me the netflix password", diff(reveal=[("netflix", "tacos&dosa")]),
    ref=[act("reveal", rows="$netflix", args="field: password")]),
  T("and which email is that under", rows("netflix"),
    ref=[ans(rows="$netflix")]))

S("A-E023", "locker create star",
  T("add planet fitness to the locker, it's a membership",
    diff(new("locker item", name=has("Planet", "Fitness"), type="membership")),
    ref=[act("create", kind="locker item", args=lines(name="Planet Fitness", type="membership"))]),
  T("star it", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$new")]))

S("A-E024", "folder create add-to filter",
  T("make a wedding folder", diff(new("folder", name=has("Wedding"))),
    ref=[act("create", kind="folder", args=lines(name="Wedding"))]),
  T("put the venue contract and the marriage license checklist in it, they're both wedding stuff",
    diff(link("+1", "venuecontract"), link("+1", "marriagelic")),
    ref=[act("add_to", rows="$venuecontract, $marriagelic", args="to: $c1")]),
  T("are there loose documents anywhere", rows(),
    ref=[ans(kind="document", where="folder count = 0")]))

S("A-E025", "folder delete refused ask",
  T("delete the work folder, i'm reorganising everything", ask(),
    ref=[bad(act("delete", kind="folder", name="Work")),
         askc("Work still holds three documents. Move them out first?")]))

S("A-E026", "trash read restore note photo",
  T("what's in the trash, i think i binned something by mistake last week",
    rows("library", "biketire", "oldgrocery", "lo6", "oldgym", "craig", "derek", "oldlease"),
    ref=[ans(kind="person,task,note,document,photo,locker item", trashed=True)]),
  T("restore the old grocery list", diff(restore("oldgrocery")),
    ref=[act("restore", rows="$oldgrocery")]),
  T("and the blurry photo", diff(restore("lo6")),
    ref=[act("restore", kind="photo", name="blurry", trashed=True)]))

S("A-E027", "decline out-of-scope never-mind",
  T("what's the weather tomorrow, we might hike for two hours", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("book a table at uchi saturday for four of us", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("nvm", decline("never_mind"),
    ref=[dec("never_mind")]))

S("A-E028", "unbounded-destruction narrow delete",
  T("clear out all my notes, i want a fresh start", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("just the garage sale inventory", diff(trash("garagesale")),
    ref=[act("delete", kind="note", name="garage sale inventory")]))

S("A-E029", "ambiguous-person ask description star",
  T("when did i last talk to rachel", ask("rachel_k", "rachel_g"),
    ref=[askc("Rachel Kim or Rachel Goldberg?", options="$rachel_k, $rachel_g")]),
  T("the wedding planner", rows("rachel_g"),
    ref=[ans(rows="$rachel_g")]),
  T("star her, she's on speed dial", diff(upd("rachel_g", starred=True)),
    ref=[act("star", rows="$rachel_g")]))

S("A-E030", "person balance sum compute",
  T("what's arjun's balance with me", val((52, "USD")),
    ref=[comp(op="balance", rows="$arjun"), ans(value="@prev")]),
  T("and kenji", val((158, "USD")),
    ref=[comp(op="balance", kind="person", name="Kenji"), ans(value="@prev")]),
  T("add up everything i'm on the hook for", val((234.4, "USD")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = i_owe and status = open')]))

S("A-E031", "album create add-to count",
  T("make an album called acl for the festival pics", diff(new("album", name=has("ACL"))),
    ref=[act("create", kind="album", args=lines(name="ACL"))]),
  T("put the acl crowd photo in it", diff(link("+1", "lo1")),
    ref=[act("add_to", rows="$lo1", args="to: $c1")]),
  T("and how many pics does it hold now, just the one", val(1),
    ref=[ans(op="count", kind="photo", linked_to="$c1")]))

S("A-E032", "settle-debt list",
  T("bev's plant sitting is settled, i paid her yesterday in cash at her place", diff(upd("bev_plants", status="settled")),
    ref=[act("settle_debt", kind="debt", name="plant sitting")]),
  T("what do i still owe people from before this month", rows("uber", "magazine", "jordan_gas"),
    ref=[ans(kind="debt", where='direction = i_owe and status = open', when=W({"to": D("2026-09-30")}))]))

S("A-E033", "group create add-to",
  T("new group for the bridal shower, we'll split costs in dollars among six of us", diff(new("group", name=has("Bridal", "Shower"), currency="USD"), link("new", "me")),
    ref=[act("create", kind="group", args=lines(name="Bridal Shower", currency="USD"))]),
  T("add pooja and rachel kim, they're co-hosting", diff(link("+1", "pooja"), link("+1", "rachel_k")),
    ref=[act("add_to", rows="$pooja, $rachel_k", args="to: $c1")]))
