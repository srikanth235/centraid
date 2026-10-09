from gold import *
import json

world("T25", "2026-10-11T18:45", "Yuki Tanaka", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T25-101", "ask three review tasks reschedule pick balance positive",
  T("push the review to friday", ask("review_lawyer", "research_plan", "deck"),
    ref=[act("reschedule", kind="task", name="review", args=lines(to=U("week", 1, weekday=5))),
         askc("review plan with lawyer, review priya's research plan or the portfolio review deck?",
              options="$review_lawyer, $research_plan, $deck")]),
  T("priya's, she's out thursday", diff(upd("research_plan", date="2026-10-16")),
    ref=[act("reschedule", rows="$research_plan", args=lines(to=U("week", 1, weekday=5)))]),
  T("how much does priya owe me", val((12, "CAD")),
    ref=[ans(op="balance", kind="person", name="Priya Raman")]))

S("T25-102", "ask scans star pick add_to folder",
  T("star the scan", ask("scan_a", "scan_b"),
    ref=[act("star", kind="document", name="Scan"),
         askc("scan 0142 or scan 0143?", options="$scan_a, $scan_b")]),
  T("0143", diff(upd("scan_b", starred=True)),
    ref=[act("star", rows="$scan_b")]),
  T("file it in scans", diff(link("scans_f", "scan_b")),
    ref=[act("add_to", rows="$scan_b", args=lines(to="$scans_f"))]))

S("T25-103", "ask licence locker star never_mind",
  T("star the licence", ask("dl", "fonts"),
    ref=[act("star", kind="locker item", name="licence"),
         askc("your driver's licence or the font licence?", options="$dl, $fonts")]),
  T("never mind", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T25-104", "ask receipts documents delete pick balance negative",
  T("delete the receipt", ask("camp_receipt", "boots_receipt"),
    ref=[act("delete", kind="document", name="receipt"),
         askc("summer camp receipt or winter boots receipt?", options="$camp_receipt, $boots_receipt")]),
  T("camp one", diff(trash("camp_receipt")),
    ref=[act("delete", rows="$camp_receipt")]),
  T("what do i owe kenji", val((-300, "CAD")),
    ref=[ans(op="balance", kind="person", name="Kenji Tanaka")]))

S("T25-105", "ask roy log message pick balance pronoun",
  T("log a message to roy", ask("daniel", "sylvie", "mika"),
    ref=[act("log", kind="person", name="Roy", args=lines(kind="message")),
         askc("daniel roy, sylvie roy or mika?", options="$daniel, $sylvie, $mika")]),
  T("daniel, about saturday", diff(upd("daniel", date=ANY)),
    ref=[act("log", rows="$daniel", args=lines(kind="message"))]),
  T("what's his balance", val((444, "CAD")),
    ref=[ans(op="balance", rows="$daniel")]))

S("T25-106", "ask vermont event or group edit search pick",
  T("rename vermont weekend to Burlington weekend", ask("vermont_trip", "vermont"),
    ref=[search("vermont weekend"),
         askc("the vermont weekend trip on the calendar or the vermont weekend group?", options="$vermont_trip, $vermont")]),
  T("the group", diff(upd("vermont", name="Burlington weekend")),
    ref=[act("edit", rows="$vermont", args=lines(name="Burlington weekend"))]))

S("T25-107", "ask onboarding cross-kind delete never_mind",
  T("delete the onboarding one", ask("onboarding", "onboarding_ideas"),
    ref=[search("onboarding"),
         askc("the finish onboarding flow mockups task or the onboarding flow ideas note?", options="$onboarding, $onboarding_ideas")]),
  T("never mind, leave both", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T25-108", "ask book club cancel find never_mind",
  T("cancel book club, i'm wrecked", ask("book_10", "book_11", "book_12"),
    ref=[act("cancel", kind="event", name="Book club"),
         find(kind="event", name="Book club", when=W({"from": U("day", 0)})),
         askc("thursday the 15th, the 19th of november or the 17th of december?", options="@prev")]),
  T("scratch that", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T25-109", "ask therapy at-n pick anchor decided by date hour later",
  T("move therapy to 1", ask("therapy_1013", "therapy_1027", "therapy_1110"),
    ref=[act("reschedule", kind="event", name="Therapy", args=lines(to=U("day", 0, anchor="row", time="13:00"))),
         find(kind="event", name="Therapy", when=W({"from": U("day", 0)})),
         askc("which one? tuesday the 13th, the 27th or the 10th of november?", options="@prev")]),
  T("the 27th", diff(upd("therapy_1027", date="2026-10-27T13:00")),
    ref=[act("reschedule", rows="$therapy_1027", args=lines(to=U("day", 0, anchor="row", time="13:00")))]),
  T("and put the one on the 10th of november back an hour", diff(upd("therapy_1110", date="2026-11-10T13:00")),
    ref=[act("reschedule", kind="event", name="Therapy", when=W(D("2026-11-10")),
             args=lines(to=U("hour", 1, anchor="row")))]))

S("T25-110", "ask orford photos star pick already-so star",
  T("star the orford one", diff(upd("orford_ridge", starred=True)),
    ref=[act("star", kind="photo", name="Orford")]),
  T("and the group shot", diff(already=["orford_group"]),
    ref=[act("star", rows="$orford_group"), ans(rows="$orford_group")]))

S("T25-111", "ask daniel half debts settle_debt pick balance",
  T("mark daniel's half paid", ask("d_daniel_camp", "d_daniel_boots"),
    ref=[act("settle_debt", kind="debt", name="Half"),
         askc("half of summer camp (180) or half of winter boots (64.50)?", options="$d_daniel_camp, $d_daniel_boots")]),
  T("the camp, he e-transferred it", diff(upd("d_daniel_camp", status="settled")),
    ref=[act("settle_debt", rows="$d_daniel_camp")]),
  T("so what's daniel's balance now", val((264, "CAD")),
    ref=[ans(op="balance", kind="person", name="Daniel Roy")]))

S("T25-112", "ask tanaka add_to group never_mind",
  T("add tanaka to the halloween party fund", ask("mika", "hiroko", "kenji"),
    ref=[act("add_to", kind="person", name="Tanaka", args=lines(to="$halloween")),
         askc("mika, hiroko or kenji?", options="$mika, $hiroko, $kenji")]),
  T("forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T25-113", "ask mom pickup event or task reschedule pick already-so star",
  T("push pick up mom to tuesday", ask("mom_arrives", "pharmacy"),
    ref=[search("pick up mom"),
         askc("the airport pickup event from yesterday or the pick up mom's prescription task?", options="$mom_arrives, $pharmacy")]),
  T("the prescription", diff(upd("pharmacy", date="2026-10-13")),
    ref=[act("reschedule", rows="$pharmacy", args=lines(to=U("week", 1, weekday=2)))]),
  T("star hiroko", diff(already=["hiroko"]),
    ref=[act("star", kind="person", name="Hiroko Tanaka"), ans(rows="$hiroko")]))

S("T25-114", "ask summit photos delete pick count album",
  T("delete the summit pic", ask("hilaire_summit", "camels_hump"),
    ref=[act("delete", kind="photo", name="summit"),
         askc("saint-hilaire summit or camel's hump summit?", options="$hilaire_summit, $camels_hump")]),
  T("saint-hilaire one", diff(trash("hilaire_summit"), unlink("hikes_album", "hilaire_summit")),
    ref=[act("delete", rows="$hilaire_summit")]),
  T("how many photos are in hikes now", val(4),
    ref=[ans(op="count", kind="photo", linked_to="$hikes_album")]),
  T("star the fall colours pic", diff(upd("fall_colours", starred=True)),
    ref=[act("star", kind="photo", name="Fall colours")]))

S("T25-115", "wifi pw read reveal star locker",
  T("what's the wifi pw", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("show me the wifi password, mom's asking", diff(reveal=[("wifi", "tanuki-plateau-9")]),
    ref=[act("reveal", rows="@prev", args=lines(field="password"))]),
  T("star that one", diff(upd("wifi", starred=True)),
    ref=[act("star", rows="$wifi")]))
