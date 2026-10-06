from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
def J(d):
    return json.dumps(d, separators=(",", ":"))
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))
NEXT_WEEKEND = span(U("week", 1, weekday=6), U("week", 1, weekday=7))
X("T28-129",
  T("can you look up cheap flights to brisbane for march", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok add a task, check flight prices for brisbane, due monday",
    diff(new("task", name=has("brisbane"), date="2026-02-23")),
    ref=[act("create", args=lines(kind="task", name="Check flight prices for Brisbane", date=U("week", 1, weekday=1)))]))

S("T28-003-P", "add_to person where secretary tangi group para",
  T("the marae secretary is doing the koha list, so she joins Uncle Hohepa's tangi group",
    diff(link("tangi_g", "huia")),
    ref=[act("add_to", kind="person", where='role contains "secretary"', args=lines(to="$tangi_g"))]),
  T("where do she and i stand", val((-30, "NZD")),
    ref=[ans(op="balance", rows="$huia")]))

S("T28-007-P", "create group add_to person new delete group new para",
  T("set up a Brisbane footy tickets group", diff(new("group", name="Brisbane footy tickets"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Brisbane footy tickets"))]),
  T("rawiri goes in it", diff(link("+1", "rawiri")),
    ref=[act("add_to", rows="$rawiri", args=lines(to="$c1"))]),
  T("he's sorting the tickets himself, so get rid of it",
    diff(gone("+1"), unlink("+1", "me"), unlink("+1", "rawiri")),
    ref=[act("delete", rows="$c1")]))

S("T28-012-P", "create task delete task new undo delete para",
  T("on thursday i must ring Kevin about the lunch, add it to my tasks",
    diff(new("task", name=has("Kevin"), date="2026-02-26")),
    ref=[act("create", args=lines(kind="task", name="Ring Kevin about the lunch", date=U("week", 1, weekday=4)))]),
  T("trev's ringing him instead, so wipe it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("trev forgets everything, so undo that", diff(restore("+1")),
    ref=[act("undo")]))

S("T28-016-P", "note body literal delete note multi para",
  T("notes whose body just says tbc", rows("guest_list", "tell_rawiri"),
    ref=[ans(kind="note", where='body = "tbc"')]),
  T("i'll start them again, so get rid of both", diff(trash("guest_list"), trash("tell_rawiri")),
    ref=[act("delete", rows="$guest_list, $tell_rawiri")]),
  T("reunion planning, notes remaining?", val(2),
    ref=[ans(op="count", kind="note", linked_to="$reunion_nb")]))

S("T28-020-P", "restore document named restore window ask para",
  T("the lawyer wants to see the old will, get it back for me", diff(restore("old_will")),
    ref=[act("restore", kind="document", name="Old will", trashed=True)]),
  T("december power bill as well", ask(),
    ref=[bad(act("restore", kind="document", name="Power bill December", trashed=True)),
         askc("the december power bill was binned on 5 january, past the 30 days, so it can't come back. add it again from the email?")]),
  T("no, forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T28-024-P", "photo rel weekday within edit photo prev para",
  T("what pictures are from last saturday", rows("p_cricket", "p_working", "p_roof"),
    ref=[ans(kind="photo", when=W(U("week", -1, weekday=6)))]),
  T("which one has no people in it", rows("p_roof"),
    ref=[ans(within="@prev", where="person count = 0")]),
  T("that one's new name is Wharekai roof leak", diff(upd("p_roof", name="Wharekai roof leak")),
    ref=[act("edit", rows="@prev", args=lines(name="Wharekai roof leak"))]),
  T("marae album is where it belongs, add it", ask(),
    ref=[find(kind="album", name="marae"),
         askc("there's no marae album. make one and put the roof photo in it?")]))

S("T28-028-P", "edit album named album photo count para",
  T("Bus days album gets renamed Bus driving days", diff(upd("bus_al", name="Bus driving days")),
    ref=[act("edit", rows="$bus_al", args=lines(name="Bus driving days"))]),
  T("which album holds over five photos", rows("moko_al"),
    ref=[ans(kind="album", where="photo count > 5")]))

S("T28-034-P", "locker starred not equal star locker multi para",
  T("which logins have no star yet", rows("trust_portal", "airnz"),
    ref=[ans(kind="locker item", where='starred != yes and type = "login"')]),
  T("star them both", diff(upd("trust_portal", starred=True), upd("airnz", starred=True)),
    ref=[act("star", rows="$trust_portal, $airnz")]))

S("T28-039-P", "refused delete folder ask delete folder named para",
  T("get rid of the Pension folder", ask(),
    ref=[bad(act("delete", rows="$pension_f")),
         askc("the pension folder still has the super statement and the service certificate in it. move them out first?")]),
  T("forget the pension one, wipe Old bus stuff instead", diff(gone("oldbus_f")),
    ref=[act("delete", rows="$oldbus_f")]),
  T("empty folders, any", rows(),
    ref=[ans(kind="folder", where="document count = 0")]))

S("T28-046-P", "log undo ledger event read para",
  T("rawiri, put a call in the log", diff(upd("rawiri", date=ANY)),
    ref=[act("log", rows="$rawiri", args=lines(kind="call"))]),
  T("the call didn't connect, so undo that", diff(),
    ref=[act("undo")]),
  T("ok so Call with Rawiri, what's the date", rows("rawiri_call"),
    ref=[ans(kind="event", name="Call with Rawiri")]))

S("T28-053-P", "five turns task status enum effort literal within month reschedule compute min para",
  T("anything in progress", rows("fence", "invites", "waiata"),
    ref=[ans(kind="task", where='status = "in_progress"')]),
  T("big jobs only, taking two hours or more", rows("fence", "mattresses", "invites", "slideshow", "stones", "will"),
    ref=[ans(kind="task", where="effort >= 120")]),
  T("of the big ones, which are due from tomorrow to the end of march", rows("invites", "mattresses", "slideshow", "stones", "will"),
    ref=[ans(kind="task", when=W(span(U("day", 1), U("month", 0, name=3))), where="effort >= 120")]),
  T("the lawyer's away, so Update my will moves to thirtieth april", diff(upd("will", date="2026-04-30")),
    ref=[act("reschedule", rows="$will", args=lines(to=D("2026-04-30")))]),
  T("marae list, which job needs the least effort", val(30),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$marae_l", where='status = "open"'), ans(value="@prev")]))

S("T28-060-P", "single photo rel time today para",
  T("something i snapped at quarter past 8 this morning", rows("p_aroha"),
    ref=[ans(kind="photo", when=W(U("day", 0, time="08:15")))]))

S("T28-066-P", "note span date datetime within person count open edit note para",
  T("from the nineteenth until yesterday lunchtime, which notes", rows("doc_qs", "tshirt_sizes", "ria_qs"),
    ref=[ans(kind="note", when=W(span(D("2026-02-19"), U("day", -1, time="12:00"))))]),
  T("ones with people attached", rows("tshirt_sizes", "ria_qs"),
    ref=[ans(within="@prev", where="person count > 0")]),
  T("contents of Questions for Nanny Ria", rows("ria_qs"),
    ref=[ans(rows="$ria_qs")]),
  T("tack on and the name of koro's horse, to it", diff(upd("ria_qs", body=has("horse"))),
    ref=[act("edit", rows="$ria_qs", args=lines(
        body="who was Koro's first wife, where is the old photo box, and the name of Koro's horse"))]))

S("T28-073-P", "document from datetime span week date para",
  T("docs arriving after monday 2pm", rows("roof_quote", "draw", "itinerary", "tshirt_design",
                                                    "blood_results", "scan"),
    ref=[ans(kind="document", when=W({"from": U("week", 0, weekday=1, time="14:00")}))]),
  T("same again for last week through tuesday", rows("venue_booking", "notice", "roof_quote", "draw"),
    ref=[ans(kind="document", when=W(span(U("week", -1), U("week", 0, weekday=2))))]))

S("T28-083-P", "five turns person photo count locker type set starred not equal star locker read para",
  T("kapa haka people who appear in photos, which", rows("hine", "ana", "wiki"),
    ref=[ans(kind="person", where='photo count != 0 and role contains "kapa haka"')]),
  T("mokopuna too?", rows("manaia", "tama", "ana", "aroha_w", "nikau"),
    ref=[ans(kind="person", where='photo count != 0 and role contains "mokopuna"')]),
  T("locker entries with no star but with a type and a username set", rows("trust_portal", "airnz"),
    ref=[ans(kind="locker item", where="starred != yes and type is set and username is set")]),
  T("Air NZ Airpoints gets a star", diff(upd("airnz", starred=True)),
    ref=[act("star", rows="$airnz")]),
  T("its username?", rows("airnz"),
    ref=[ans(rows="$airnz")]))

S("T28-092-P", "five turns reunion list ambiguous ask edit list read people hangi miss search para",
  T("reunion list should be called Reunion jobs", ask("reunion_l", "reunion_cat_l"),
    ref=[act("edit", kind="list", name="Reunion", args=lines(name="Reunion jobs")),
         askc("Reunion or Reunion catering?", options="$reunion_l, $reunion_cat_l")]),
  T("the non-catering one", diff(upd("reunion_l", name="Reunion jobs")),
    ref=[act("edit", rows="$reunion_l", args=lines(name="Reunion jobs"))]),
  T("Reunion catering contents?", rows("meat", "stones", "kai_list"),
    ref=[ans(kind="task", linked_to="$reunion_cat_l")]),
  T("Sort the hāngī stones is assigned to whom", rows("pita"),
    ref=[ans(kind="person", linked_to="$stones")]),
  T("hangi trial date?", rows("hangi_trial"),
    ref=[ans(kind="event", name="hangi trial"), search("hangi trial", kind="event"), ans(rows="$hangi_trial")]))

S("T28-A004-P", "ask-options document delete never_mind c3a para",
  T("scan, get rid of it", ask("chart_scan", "scan"),
    ref=[act("delete", kind="document", name="scan"),
         askc("The whakapapa chart scan or Scan 0221?", options="$chart_scan, $scan")]),
  T("not the whakapapa chart! both stay", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T28-A008-P", "follow-up c3a para",
  T("next week's events", rows("hine_korero", "waka_0227", "aroha_bday", "wof", "kapa_0225", "cricket_0228", "gp_feb", "marae_0301", "touch_0223", "netball", "depot_lunch"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("before thursday only", rows("touch_0223", "gp_feb", "hine_korero", "wof", "kapa_0225"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=3)}))]),
  T("what comes after that", rows("cricket_0228", "marae_0301", "netball", "waka_0227", "aroha_bday", "depot_lunch"),
    ref=[ans(within="@1", exclude="@2")]))

S("T28-B004-P", "c4b state-change complete complete create contrast para",
  T("lawns mowed", diff(upd("lawns", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="lawns")]),
  T("kūmara bought", diff(upd("kumara", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="kūmara")]),
  T("i have to ring tony about the ute, add a task", diff(new("task", name=has("Tony"))),
    ref=[act("create", args=lines(kind="task", name="Ring Tony about the ute"))]))

S("T28-C004-P", "c3c compound delete restore document photo para",
  T("get rid of scan 0221, and bring the blurry haka photo back",
    diff(trash("scan"), restore("p_blurry")),
    ref=[act("delete", kind="document", name="Scan 0221", more=True),
         act("restore", kind="photo", name="blurry haka", trashed=True)]))

S("T28-104-P", "gp by description undo never mind para",
  T("i want an earlier slot, so shift the knee gp appointment to friday at 10",
    diff(upd("gp_mar", date="2026-02-27T10:00")),
    ref=[act("reschedule", kind="event", name="GP appointment with Dr Lim", where='description contains "knee"',
             args=lines(to=U("week", 1, weekday=5, time="10:00")))]),
  T("friday's full according to the clinic, undo that", diff(upd("gp_mar", date="2026-03-24T09:30")),
    ref=[act("undo")]))

S("T28-109-P", "ask options scan star unstar para",
  T("scan gets a star", ask("scan", "chart_scan"),
    ref=[act("star", kind="document", name="scan"),
         askc("scan 0221 or the whakapapa chart scan?", options="$scan, $chart_scan")]),
  T("whakapapa", diff(upd("chart_scan", starred=True)),
    ref=[act("star", rows="$chart_scan")]),
  T("the binder has the trust deed too, so remove its star", diff(upd("trust_deed", starred=False)),
    ref=[act("unstar", kind="document", name="Marae trust deed")]))

S("T28-113-P", "reveal portal reveal wifi verb wifi read star para",
  T("trust portal password, tell me", diff(reveal=[("trust_portal", "Wharekai-Roof-26")]),
    ref=[act("reveal", kind="locker item", name="Marae trust portal", args=lines(field="password"))]),
  T("give me the home wifi password, i keep forgetting it", diff(reveal=[("wifi", "kumara-patch-44")]),
    ref=[act("reveal", kind="locker item", name="Home wifi", args=lines(field="password"))]),
  T("marae wifi pw, where is it saved", rows("wifi_marae"),
    ref=[ans(kind="locker item", name="Marae wifi")]),
  T("i'm in the trust portal weekly, give it a star", diff(upd("trust_portal", starred=True)),
    ref=[act("star", kind="locker item", name="Marae trust portal")]))

S("T28-120-P", "ask options ngata log group balance positive para",
  T("i dropped off the koha, put a visit with ngata in the log", ask("pita", "tui"),
    ref=[act("log", kind="person", name="Ngata", args=lines(kind="visit")),
         askc("pita or tui?", options="$pita, $tui")]),
  T("pita's the one", diff(upd("pita", date=ANY)),
    ref=[act("log", rows="$pita", args=lines(kind="visit"))]),
  T("his standing in the tangi group?", val((675, "NZD")),
    ref=[ans(op="balance", kind="group", name="Uncle Hohepa's tangi", linked_to="$pita")]))

S("T28-124-P", "weekend duration repair reschedule at time para",
  T("this weekend, count the events lasting more than two hours", val(2),
    ref=[bad(ans(op="count", kind="event", when=W(WEEKEND), where="duration > 2 hours")),
         ans(op="count", kind="event", when=W(WEEKEND), where="duration > 120")]),
  T("monday at 11 is the new time for hemi visiting", diff(upd("hemi_visit", date="2026-02-23T11:00")),
    ref=[act("reschedule", kind="event", name="Hemi visiting from Hamilton", args=lines(to=U("week", 1, weekday=1, time="11:00")))]))
