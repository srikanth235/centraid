from gold import *
import json

world("T09", "2026-05-13T08:05", "Hanae Okafor", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))
FROM_NOW = {"from": U("day", 0)}

S("T09-106", "ask star document draft near-miss star",
  T("star the draft", ask("agm_draft", "brightline_factum"),
    ref=[act("star", kind="document", name="draft"),
         askc("the agm notice draft or the brightline factum draft?", options="$agm_draft, $brightline_factum")]),
  T("the factum one", diff(upd("brightline_factum", starred=True)),
    ref=[act("star", rows="$brightline_factum")]),
  T("and the t4", diff(upd("t4", starred=True)),
    ref=[act("star", kind="document", name="T4 2025")]))

S("T09-107", "ask log priya balance negative",
  T("log a call with priya", ask("priya_r", "priya_s"),
    ref=[act("log", kind="person", name="Priya", args=lines(kind="call")),
         askc("priya raman or priya sandhu?", options="$priya_r, $priya_s")]),
  T("the condo one, went over the agm", diff(upd("priya_s", date=ANY)),
    ref=[act("log", rows="$priya_s", args=lines(kind="call"))]),
  T("what's my balance with her", val((-15, "CAD")),
    ref=[ans(op="balance", rows="$priya_s")]))

S("T09-108", "ask cancel dinner then undo scratch that",
  T("cancel the dinner at mom and dad's", ask("dinner_0426", "dinner_0524"),
    ref=[act("cancel", kind="event", name="Dinner at Mom and Dad's"),
         find(kind="event", name="Dinner at Mom and Dad's"),
         askc("the one on 26 april or the one on the 24th?", options="$dinner_0426, $dinner_0524")]),
  T("the 24th", diff(upd("dinner_0524", status="cancelled")),
    ref=[act("cancel", rows="$dinner_0524")]),
  T("scratch that, mom's already cooking", diff(),
    ref=[act("undo")]))

S("T09-109", "contrast cancel next dinner out_of_scope",
  T("cancel the dinner at mom and dad's on the 24th, they're away", diff(upd("dinner_0524", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dinner at Mom and Dad's", when=W(D("2026-05-24")))]),
  T("book me a table at kaiseki yu-zen for obaachan's birthday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T09-110", "ask reschedule factum monday email decline",
  T("push the factum to monday", ask("factum", "f_cite"),
    ref=[act("reschedule", kind="task", name="factum", args=lines(to=U("week", 1, weekday=1))),
         askc("the whole brightline factum or just the cite-check?", options="$factum, $f_cite")]),
  T("just the cite check", diff(upd("f_cite", date="2026-05-18")),
    ref=[act("reschedule", rows="$f_cite", args=lines(to=U("week", 1, weekday=1)))]),
  T("email margaret that the cite check is slipping to monday, i'm buried in discovery prep",
    decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T09-111", "contrast reschedule subtasks sunday saturday",
  T("push the cite check to sunday", diff(upd("f_cite", date="2026-05-17")),
    ref=[act("reschedule", kind="task", name="Cite-check the factum", args=lines(to=U("week", 0, weekday=7)))]),
  T("and the statement of facts to saturday", diff(upd("f_facts", date="2026-05-16")),
    ref=[act("reschedule", rows="$f_facts", args=lines(to=U("week", 0, weekday=6)))]),
  T("reopen case law research, i missed the appeal cases", diff(upd("f_research", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Case law research")]))

S("T09-112", "ask star jordan pick star",
  T("star jordan", ask("jordan_l", "jordan_p"),
    ref=[act("star", kind="person", name="Jordan"),
         askc("jordan lee or jordan park?", options="$jordan_l, $jordan_p")]),
  T("the groomsman", diff(upd("jordan_l", starred=True)),
    ref=[act("star", rows="$jordan_l")]),
  T("and marcus", diff(upd("marcus", starred=True)),
    ref=[act("star", kind="person", name="Marcus Bell")]),
  T("unstar mom, she's not a wedding thing", diff(upd("mom", starred=False)),
    ref=[act("unstar", kind="person", where='role = "mom"')]))

S("T09-113", "contrast star jordan multi star unstar",
  T("star jordan lee and unstar daniel, he's on top enough already",
    diff(upd("jordan_l", starred=True), upd("dan", starred=False)),
    ref=[act("star", kind="person", name="Jordan Lee", more=True),
         act("unstar", kind="person", name="Daniel")]),
  T("how many people are starred now", val(4),
    ref=[ans(op="count", kind="person", where="starred = yes")]),
  T("jordan's uber home, he paid me back", diff(upd("d_jordan_l", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Uber home")]))

S("T09-114", "ask star lso locker unstar",
  T("star the lso one", ask("lso_portal", "lso_doc"),
    ref=[act("star", kind="locker item", name="LSO"),
         askc("the lso portal login or the lso member number?", options="$lso_portal, $lso_doc")]),
  T("the login", diff(upd("lso_portal", starred=True)),
    ref=[act("star", rows="$lso_portal")]),
  T("unstar the vpn one", diff(upd("firm_login", starred=False)),
    ref=[act("unstar", kind="locker item", name="Whitlock Brennan VPN")]),
  T("star the social insurance number one instead", diff(upd("sin", starred=True)),
    ref=[act("star", kind="locker item", name="Social insurance number")]))

S("T09-115", "contrast star locker unbounded",
  T("star the lso portal login", diff(upd("lso_portal", starred=True)),
    ref=[act("star", kind="locker item", name="LSO portal login")]),
  T("and the mercer portal, i use it most", diff(upd("condo_portal", starred=True)),
    ref=[act("star", kind="locker item", name="Mercer resident portal")]),
  T("delete all my locker items, i'm switching to a new password manager", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T09-116", "wifi bare read then reveal card repair",
  T("home wifi pw", rows("wifi"),
    ref=[ans(kind="locker item", name="Home wifi")]),
  T("show me the wifi password", diff(reveal=[("wifi", "mercer-1207-sakura")]),
    ref=[act("reveal", rows="$wifi", kind="locker item", args=lines(field="password"))]),
  T("and the visa number", diff(reveal=[("visa", "4520 8812 3371 0094")]),
    ref=[bad(act("reveal", kind="locker item", name="TD Visa", args=lines(field="password"))),
         act("reveal", kind="locker item", name="TD Visa", args=lines(field="card_number"))]),
  T("and the cvv", diff(reveal=[("visa", "318")]),
    ref=[act("reveal", rows="$visa", kind="locker item", args=lines(field="cvv"))]))

S("T09-117", "wifi bare sealed_egress fabricated_secret",
  T("wifi password?", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("email the visa number to marcus, he's booking the tickets", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("what's my visa pin, i can never remember it", decline("not_found"),
    ref=[search("visa"), dec("not_found")]))

S("T09-118", "balance positive three people cadence repair",
  T("how much does aiden owe me", val((49, "CAD")),
    ref=[ans(op="balance", rows="$aiden")]),
  T("and fatou", val((12, "CAD")),
    ref=[ans(op="balance", rows="$fatou")]),
  T("mateo?", val((32, "CAD")),
    ref=[ans(op="balance", rows="$mateo")]),
  T("who do i check in with less often than every two weeks", rows("siobhan", "priya_s", "hugo"),
    ref=[bad(ans(kind="person", where="cadence > 2 weeks")),
         ans(kind="person", where="cadence > 14 days")]),
  T("log a call with hugo, told him about the seating", diff(upd("hugo", date=ANY)),
    ref=[act("log", kind="person", name="Hugo Mensah", args=lines(kind="call"))]))

S("T09-119", "balance negative two settle debt",
  T("what do i owe ethan", val((-14, "CAD")),
    ref=[ans(op="balance", rows="$ethan")]),
  T("and marcus", val((-165, "CAD")),
    ref=[ans(op="balance", rows="$marcus")]),
  T("paid ethan back for the sushi, settle it", diff(upd("d_ethan", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Late night sushi")]))

S("T09-120", "ask balance jordan pick star pronoun",
  T("what does jordan owe me", ask("jordan_l", "jordan_p"),
    ref=[search("jordan", kind="person"),
         askc("jordan lee or jordan park?", options="$jordan_l, $jordan_p")]),
  T("lee", val((25, "CAD")),
    ref=[ans(op="balance", rows="$jordan_l")]),
  T("star him", diff(upd("jordan_l", starred=True)),
    ref=[act("star", rows="$jordan_l")]),
  T("log a visit with him, he dropped by", diff(upd("jordan_l", date=ANY)),
    ref=[act("log", rows="$jordan_l", args=lines(kind="visit"))]))
