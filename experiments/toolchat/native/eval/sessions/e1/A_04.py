from gold import *
import json

world("A", "2026-10-14T08:40", "Priya Raman", "eval")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("A-E078", "ambiguous-event narrowed-by-context cancel",
  T("is the call with arjun next week", rows("arjuncall"),
    ref=[ans(kind="event", name="call with arjun", when=W(U("week", 1)))]),
  T("push it to 9pm", diff(upd("arjuncall", date="2026-10-19T21:00")),
    ref=[act("reschedule", rows="$arjuncall", args=lines(to=U("week", 1, weekday=1, time="21:00")))]),
  T("actually cancel the call, he's travelling", diff(upd("arjuncall", status="cancelled")),
    ref=[act("cancel", kind="event", name="call"), act("cancel", rows="$arjuncall")]),
  T("is amma's weekly call still on sunday this week", rows("amma_call"),
    ref=[ans(kind="event", name="weekly call", when=W(U("week", 0, weekday=7)))]))

S("A-E079", "ambiguous-event ask description reschedule",
  T("can the dinner be at 8 instead, kitchen closes early", ask("sofia_dinner", "bday"),
    ref=[act("reschedule", kind="event", name="dinner", args=lines(to=U("day", 0, time="20:00"))),
         askc("Dinner with Sofia or Tomas's birthday dinner?", options="$sofia_dinner, $bday")]),
  T("tomas's", diff(upd("bday", date="2026-10-24T20:00")),
    ref=[act("reschedule", rows="$bday", args=lines(to=U("week", 1, weekday=6, time="20:00")))]),
  T("what time was the one with sofia", rows("sofia_dinner"),
    ref=[ans(rows="$sofia_dinner")]),
  T("what's left this weekend", rows("runclub", "venue", "amma_call", "climb"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]))

S("A-E080", "trashed restore refused create star unstar read",
  T("bring craig back, reunion's in two weeks", decline("not_found"),
    ref=[bad(act("restore", kind="person", name="craig", trashed=True)), dec("not_found")]),
  T("ok add him again as a new contact, craig nolan, ex-colleague", diff(new("person", name=has("Craig", "Nolan"), role="ex-colleague")),
    ref=[act("create", kind="person", args=lines(name="Craig Nolan", role="ex-colleague"))]),
  T("star him", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$new")]),
  T("wait unstar him, wrong guy", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$new")]),
  T("what's derek hall's role", rows("derek"),
    ref=[find(kind="person", name="derek hall"), ans(kind="person", name="derek hall", trashed=True)]))

S("A-E081", "photos person search narrow unstar delete",
  T("any starred pics of tomas", rows("bb4", "en0"),
    ref=[search("Tomas", kind="person"), ans(kind="photo", linked_to="$tomas", where="starred = yes")]),
  T("just the ones from big bend", rows("bb4"),
    ref=[ans(within="@prev", linked_to="$bigbend_al")]),
  T("unstar the group one, it's blurry", diff(upd("bb4", starred=False)),
    ref=[act("unstar", rows="$bb4")]),
  T("delete the roadrunner photo", diff(trash("bb8"), unlink("bigbend_al", "bb8")),
    ref=[act("delete", kind="photo", name="roadrunner")]))

S("A-E082", "empty-recovery nickname log balance star",
  T("coffee with miss bev, log it", diff(upd("bev", date=ANY)),
    ref=[find(kind="person", name="Miss Bev"), search("Miss Bev", kind="person"),
         act("log", rows="$bev", args="kind: coffee")]),
  T("do i owe her anything", val((-25, "USD")),
    ref=[comp(op="balance", rows="$bev"), ans(value="@prev")]),
  T("gayu chithi, when did i last call her", rows("gayatri"),
    ref=[find(kind="person", name="Gayu chithi"), search("Gayu chithi", kind="person"), ans(rows="$gayatri")]),
  T("star her, she's family", diff(upd("gayatri", starred=True)),
    ref=[act("star", rows="$gayatri")]))

S("A-E083", "trashed tasks restore read",
  T("list the tasks i got rid of recently", rows("library", "biketire"),
    ref=[ans(kind="task", trashed=True)]),
  T("bring back the bike one, i never actually fixed it", diff(restore("biketire")),
    ref=[act("restore", rows="$biketire")]),
  T("is it open", rows("biketire"),
    ref=[ans(rows="$biketire")]),
  T("tick it off, got it fixed yesterday", diff(upd("biketire", status="completed", completed=ANY)),
    ref=[act("complete", rows="$biketire")]))

S("A-E084", "birthday planning undo long",
  T("what do i have going for tomas's birthday this month", rows("bday", "gift"),
    ref=[ans(kind="event,task", name="birthday", when=W(U("month", 0)))]),
  T("what were the gift ideas again", rows("giftideas"),
    ref=[ans(kind="note", name="gift ideas")]),
  T("got the camera, tick off the gift", diff(upd("gift", status="completed", completed=ANY)),
    ref=[act("complete", rows="$gift")]),
  T("bump the birthday dinner to 8pm, uchi had a cancellation and 8 is the only slot they have left", diff(upd("bday", date="2026-10-24T20:00")),
    ref=[act("reschedule", kind="event", name="birthday dinner", args=lines(to=U("week", 1, weekday=6, time="20:00")))]),
  T("no, undo that, they only had half seven", diff(upd("bday", date="2026-10-24T19:30")),
    ref=[act("undo")]),
  T("who's coming to it, for the headcount", rows("tomas"),
    ref=[ans(kind="person", linked_to="$bday")]))

S("A-E085", "morning chat long reschedule delete add-to",
  T("what's my day look like", rows("plumber", "haircut"),
    ref=[ans(kind="event", when=W(U("day", 0)))]),
  T("and tasks", rows("faucet"),
    ref=[ans(kind="task", when=W(U("day", 0)))]),
  T("plumber's running late, push him to 3", diff(upd("plumber", date="2026-10-14T15:00")),
    ref=[act("reschedule", rows="$plumber", args=lines(to=U("day", 0, time="15:00")))]),
  T("haircut's still at half five today right", rows("haircut"),
    ref=[ans(kind="event", name="haircut", when=W(U("day", 0)))]),
  T("move that to tomorrow same time", diff(upd("haircut", date="2026-10-15T17:30")),
    ref=[act("reschedule", rows="$haircut", args=lines(to=U("day", 1, time="17:30")))]),
  T("delete the dry cleaning task, bev's picking it up for me", diff(trash("drycleaning")),
    ref=[act("delete", kind="task", name="dry cleaning")]),
  T("move the faucet task over to errands, it's really a shop trip and not a home repair thing", diff(link("errands", "faucet"), unlink("home", "faucet")),
    ref=[act("add_to", kind="task", name="faucet", args="to: $errands")]))

S("A-E086", "write-read narrow complete",
  T("mark the faucet done and tell me what else is due this week",
    rows("dogfood", "amazon", "review_luis", "drycleaning", "callamma", "ammapkg", "vetbill",
         also=diff(upd("faucet", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="faucet", more=True),
         ans(kind="task", when=W(U("week", 0)), where="status = open")]),
  T("which of those are under 30 min", rows("dogfood", "amazon"),
    ref=[ans(within="@prev", where="effort < 30")]),
  T("do both, i'll grab them", diff(upd("dogfood", status="completed", completed=ANY), upd("amazon", status="completed", completed=ANY)),
    ref=[act("complete", rows="$dogfood, $amazon")]))

S("A-E087", "find-only count reschedule",
  T("tasks longer than 60 min", rows("garage", "roadmap", "slides", "ammaalbum"),
    ref=[find(kind="task", where="effort > 60"), ans(rows="@1")]),
  T("how many is that, four", val(4),
    ref=[ans(op="count", within="@prev")]),
  T("push the garage one to next saturday, weather's bad this weekend", diff(upd("garage", date="2026-10-24")),
    ref=[act("reschedule", rows="$garage", args=lines(to=U("week", 1, weekday=6)))]))

S("A-E088", "ambiguous-locker reveal ask",
  T("show me the wifi password", ask("wifi", "officewifi"),
    ref=[act("reveal", kind="locker item", name="wifi", args="field: password"),
         askc("Home wifi or Office wifi?", options="$wifi, $officewifi")]),
  T("home", diff(reveal=[("wifi", "biscuit-2208")]),
    ref=[act("reveal", rows="$wifi", args="field: password")]),
  T("and the office one", diff(reveal=[("officewifi", "Welcome2026!")]),
    ref=[act("reveal", rows="$officewifi", args="field: password")]))

S("A-E089", "reveal nothing decline types",
  T("show me the aws key, the deploy goes out at five", decline("not_found"),
    ref=[bad(act("reveal", kind="locker item", name="aws", args="field: password")), dec("not_found")]),
  T("is the aws one an api credential", rows("aws"),
    ref=[ans(kind="locker item", name="aws", where="type = api_credential")]),
  T("any other api credentials saved anywhere", rows(),
    ref=[ans(kind="locker item", where="type = api_credential", exclude="$aws")]))

S("A-E090", "star locker cross-kind",
  T("star my passport, renewal due by end of year", diff(upd("passportlk", starred=True)),
    ref=[act("star", kind="locker item", name="passport")]),
  T("when does it expire", rows("passportlk"),
    ref=[ans(rows="$passportlk")]),
  T("is the passport renewal still open or did i finish", rows("passport"),
    ref=[ans(kind="task", name="renew passport", where="status = open")]),
  T("which starred docs are in travel", rows("passportscan"),
    ref=[ans(kind="document", linked_to="$travel", where="starred = yes")]))

S("A-E091", "ambiguous-task delete ask undo",
  T("delete the guest list, we're starting over", ask("guests", "guests_r", "guests_h"),
    ref=[act("delete", kind="task", name="guest list"),
         askc("The main guest list or one of the two sides?", options="$guests, $guests_r, $guests_h")]),
  T("just the raman side", diff(trash("guests_r")),
    ref=[act("delete", rows="$guests_r")]),
  T("wait i need that, undo", diff(restore("guests_r")),
    ref=[act("undo")]),
  T("how many parts does the guest list have, two", val(2),
    ref=[ans(op="count", kind="task", linked_to="$guests")]))

S("A-E092", "member removal refused ask settle",
  T("take arjun off the potluck group, he can't make it", ask(),
    ref=[bad(act("remove_from", rows="$arjun", args="from: $potluck")),
         askc("Arjun still has an open balance in the potluck. Settle up first?")]),
  T("yes settle up first", diff(settle=[("Arjun Raman", "12.00")]),
    ref=[act("settle_up", rows="$arjun", args="group: $potluck")]),
  T("now take him off", ask(),
    ref=[bad(act("remove_from", rows="$arjun", args="from: $potluck")),
         askc("Arjun still owes others in the potluck, so he can't be removed yet. Leave him in?")]),
  T("fine, leave him, what's nikhil's balance in it", val((56, "USD")),
    ref=[ans(op="balance", kind="group", name="Diwali Potluck", linked_to="$nikhil")]))

S("A-E093", "documents month folder delete rename",
  T("what did i add to documents this month, for the wedding", rows("perfreview", "venuecontract", "marriagelic"),
    ref=[ans(kind="document", when=W(U("month", 0)))]),
  T("is the venue contract in a folder", rows(),
    ref=[ans(kind="folder", linked_to="$venuecontract")]),
  T("delete it, the draft is superseded", diff(trash("venuecontract")),
    ref=[act("delete", rows="$venuecontract")]),
  T("rename the marriage license checklist to license todo, shorter is better", diff(upd("marriagelic", name="License todo")),
    ref=[act("edit", rows="$marriagelic", args="name: License todo")]))

S("A-E094", "rename notebooks",
  T("rename the work notes notebook to job", diff(upd("worknotes", name="Job")),
    ref=[act("edit", rows="$worknotes", args="name: Job")]),
  T("so what's the note count there", val(4),
    ref=[ans(op="count", kind="note", linked_to="$worknotes")]),
  T("and call recipes cooking", diff(upd("recipes", name="Cooking")),
    ref=[act("edit", rows="$recipes", args="name: Cooking")]))
