from gold import *
import json

world("T25", "2026-10-11T18:45", "Yuki Tanaka", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


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
