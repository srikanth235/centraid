from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T28-051", "seven turns reunion hui ambiguous ask reschedule people task person count completed empty subtasks complete",
  T("when's the Reunion planning hui", rows("hui_feb", "hui_mar"),
    ref=[ans(kind="event", name="Reunion planning hui")]),
  T("move it to 3pm", ask("hui_feb", "hui_mar"),
    ref=[act("reschedule", kind="event", name="Reunion planning hui", args=lines(to=U("day", 0, anchor="row", time="15:00"))),
         find(kind="event", name="Reunion planning hui"),
         askc("the one on 8 february or the one on 8 march?", options="$hui_feb, $hui_mar")]),
  T("march, the feb one's been", diff(upd("hui_mar", date="2026-03-08T15:00")),
    ref=[act("reschedule", rows="$hui_mar", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("who's coming to that", rows("hemi_t", "mere", "kiri", "ria"),
    ref=[ans(kind="person", linked_to="$hui_mar")]),
  T("stuff on the Reunion list with nobody on it that isn't done yet", rows("invites", "chart"),
    ref=[ans(kind="task", linked_to="$reunion_l", where="person count < 1 and completed is empty")]),
  T("what's under the invites one", rows("inv_aus", "inv_fb", "inv_kaum"),
    ref=[ans(kind="task", linked_to="$invites")]),
  T("Post on the whānau Facebook page is done", diff(upd("inv_fb", status="completed", completed=ANY)),
    ref=[act("complete", rows="$inv_fb")]))

S("T28-052", "six turns person anchor span weekday within starred ambiguous hemi ask log event",
  T("people i met or spoke to yesterday", rows("mere", "ria"),
    ref=[ans(kind="person", when=W(U("day", -1, anchor="today")))]),
  T("and since last friday", rows("kiri", "moana", "hemi_r", "hemi_t", "hine", "ngaire", "sam", "mere", "ria"),
    ref=[ans(kind="person", when=W(span(U("week", -1, weekday=5), U("day", -1))))]),
  T("just the starred ones", rows("hine", "mere", "ria"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("log a visit with hemi", ask("hemi_t", "hemi_r"),
    ref=[act("log", kind="person", name="Hemi", args=lines(kind="visit")),
         askc("hemi tane or hemi rangi?", options="$hemi_t, $hemi_r")]),
  T("my boy", diff(upd("hemi_t", date=ANY)),
    ref=[act("log", rows="$hemi_t", args=lines(kind="visit"))]),
  T("when's he next coming over", rows("hemi_visit"),
    ref=[ans(kind="event", name="Hemi visiting from Hamilton")]))

S("T28-053", "five turns task status enum effort literal within month reschedule compute min",
  T("what's in progress", rows("fence", "invites", "waiata"),
    ref=[ans(kind="task", where='status = "in_progress"')]),
  T("and the big jobs, two hours or more", rows("fence", "mattresses", "invites", "slideshow", "stones", "will"),
    ref=[ans(kind="task", where="effort >= 120")]),
  T("the big ones due between tomorrow and the end of march", rows("invites", "mattresses", "slideshow", "stones", "will"),
    ref=[ans(kind="task", when=W(span(U("day", 1), U("month", 0, name=3))), where="effort >= 120")]),
  T("push Update my will to thirtieth april, the lawyer's away", diff(upd("will", date="2026-04-30")),
    ref=[act("reschedule", rows="$will", args=lines(to=D("2026-04-30")))]),
  T("what's the smallest job on the marae list, effort wise", val(30),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$marae_l", where='status = "open"'), ans(value="@prev")]))

S("T28-054", "event span date named month within duration reschedule people",
  T("what's on from monday through to the end of feb",
    rows("hine_korero", "touch_0223", "gp_feb", "wof", "kapa_0225", "aroha_bday", "depot_lunch", "waka_0227",
         "cricket_0228", "netball"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), U("month", 0, name=2))))]),
  T("which of those go longer than an hour and a half", rows("kapa_0225", "aroha_bday", "depot_lunch", "cricket_0228", "netball"),
    ref=[ans(within="@prev", where="duration > 90")]),
  T("Aroha's birthday dinner, make it 6:30", diff(upd("aroha_bday", date="2026-02-26T18:30")),
    ref=[act("reschedule", rows="$aroha_bday", args=lines(to=U("day", 0, anchor="row", time="18:30")))]),
  T("how many coming again", val(5),
    ref=[ans(op="count", kind="person", linked_to="$aroha_bday")]))

S("T28-056", "single event status set weekend",
  T("anything this weekend with a status on it", rows("cricket_0221", "hemi_visit", "rawiri_call"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))), where="status is set")]))

S("T28-057", "photo span weekday weekday within starred people star photo",
  T("photos from friday to last sunday",
    rows("p_sunset", "p_geyser", "p_cricket", "p_working", "p_roof", "p_kumara"),
    ref=[ans(kind="photo", when=W(span(U("week", -1, weekday=5), U("week", -1, weekday=7))))]),
  T("the starred ones", rows("p_cricket"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("who's in it", rows("tama"),
    ref=[ans(kind="person", linked_to="$p_cricket")]),
  T("star Working bee crew", diff(upd("p_working", starred=True)),
    ref=[act("star", rows="$p_working")]))

S("T28-058", "photo span named month date within starred edit photo named",
  T("pics from january up to waitangi day",
    rows("p_moko_all", "p_fishing", "p_hine", "p_ro", "p_dawn", "p_hangi_w", "p_flags"),
    ref=[ans(kind="photo", when=W(span(U("month", 0, name=1), D("2026-02-06"))))]),
  T("any of them starred", rows("p_moko_all", "p_ro", "p_dawn"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("rename Dawn service to Waitangi dawn service 2026", diff(upd("p_dawn", name="Waitangi dawn service 2026")),
    ref=[act("edit", rows="$p_dawn", args=lines(name="Waitangi dawn service 2026"))]))

S("T28-059", "photo span weekday weekday people description",
  T("photos tuesday to thursday this week", rows("p_school", "p_practice", "p_tshirt"),
    ref=[ans(kind="photo", when=W(span(U("week", 0, weekday=2), U("week", 0, weekday=4))))]),
  T("how many people in the one at practice", val(2),
    ref=[ans(op="count", kind="person", linked_to="$p_practice")]))

S("T28-060", "single photo rel time today",
  T("the photo from this morning at quarter past 8", rows("p_aroha"),
    ref=[ans(kind="photo", when=W(U("day", 0, time="08:15")))]))

S("T28-061", "debt span date named month amount unit within settle debt",
  T("debts since valentines day", rows("d_moana", "d_kiri", "d_rawiri", "d_ngaire", "d_ria", "d_sam"),
    ref=[ans(kind="debt", when=W(span(D("2026-02-14"), U("month", 0, name=2))))]),
  T("the small ones, 50 bucks or under", rows("d_moana", "d_ria", "d_sam"),
    ref=[ans(within="@prev", where="amount <= 50 NZD")]),
  T("and of those, which ones am i the one owing", rows("d_ria", "d_sam"),
    ref=[ans(within="@prev", where='direction = "i_owe"')]),
  T("paid nanny ria back for the Groceries, settle that one", diff(upd("d_ria", status="settled")),
    ref=[act("settle_debt", rows="$d_ria")]))

S("T28-062", "debt span date named month compute max person count empty",
  T("debts from first jan to the end of january", rows("d_kevin", "d_hemi", "d_huia"),
    ref=[ans(kind="debt", when=W(span(D("2026-01-01"), U("month", 0, name=1))))]),
  T("biggest one i owe anyone", val((300, "NZD")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'),
         ans(value="@prev")]),
  T("any debts not tied to a person", rows(),
    ref=[ans(kind="debt", where="person count < 1")]))

S("T28-064", "single debt open to datetime",
  T("any debts from before the end of january", rows("d_kevin", "d_hemi", "d_dave", "d_huia"),
    ref=[ans(kind="debt", when=W({"to": D("2026-01-31", "23:00")}))]))

S("T28-065", "debt span datetime week open to datetime person count",
  T("debts from tuesday noon last week to sunday", rows("d_trev", "d_pita", "d_moana"),
    ref=[ans(kind="debt", when=W(span(U("week", -1, weekday=2, time="12:00"), U("week", -1))))]),
  T("and anything up to wednesday midday",
    rows("d_kevin", "d_hemi", "d_dave", "d_huia", "d_mere", "d_trev"),
    ref=[ans(kind="debt", when=W({"to": U("week", -1, weekday=3, time="12:00")}))]),
  T("do any of them have nobody on them", rows(),
    ref=[ans(within="@prev", where="person count < 1")]))

S("T28-066", "note span date datetime within person count open edit note",
  T("notes from the nineteenth till yesterday lunchtime", rows("doc_qs", "tshirt_sizes", "ria_qs"),
    ref=[ans(kind="note", when=W(span(D("2026-02-19"), U("day", -1, time="12:00"))))]),
  T("which have people on them", rows("tshirt_sizes", "ria_qs"),
    ref=[ans(within="@prev", where="person count > 0")]),
  T("what's in Questions for Nanny Ria", rows("ria_qs"),
    ref=[ans(rows="$ria_qs")]),
  T("add and the name of koro's horse", diff(upd("ria_qs", body=has("horse"))),
    ref=[act("edit", rows="$ria_qs", args=lines(
        body="who was Koro's first wife, where is the old photo box, and the name of Koro's horse"))]))

S("T28-067", "note person count body not equal pin",
  T("notes with more than two people linked", rows("hui_notes", "regionals_note"),
    ref=[ans(kind="note", where="person count > 2")]),
  T("reunion planning notes that aren't tbc", rows("budget", "hangi_plan"),
    ref=[ans(kind="note", linked_to="$reunion_nb", where='body != "tbc"')]),
  T("pin the Hāngī plan", diff(upd("hangi_plan", pinned=True)),
    ref=[act("edit", rows="$hangi_plan", args=lines(pinned="yes"))]))

S("T28-068", "note span named months pinned unpin",
  T("pinned notes from january and february", rows("waiata_list", "speech"),
    ref=[ans(kind="note", when=W(span(U("month", 0, name=1), U("month", 0, name=2))), where="pinned = yes")]),
  T("unpin the speech one, the tangi's done", diff(upd("speech", pinned=False)),
    ref=[act("edit", rows="$speech", args=lines(pinned="no"))]))

S("T28-069", "note span named months span dates open",
  T("notes from december through january", rows("pudding", "boilup", "ngata_line", "reo", "waiata_list"),
    ref=[ans(kind="note", when=W(span(U("month", -1, name=12), U("month", 0, name=1))))]),
  T("and between the first and the ninth of feb", rows("hui_notes", "budget", "guest_list"),
    ref=[ans(kind="note", when=W(span(D("2026-02-01"), D("2026-02-09"))))]),
  T("the budget one, what's it say", rows("budget"),
    ref=[ans(rows="$budget")]))

S("T28-071", "document from datetime within folder count edit document",
  T("docs saved since thursday 8pm", rows("tshirt_design", "blood_results", "scan"),
    ref=[ans(kind="document", when=W({"from": U("week", 0, weekday=4, time="20:00")}))]),
  T("which aren't in a folder", rows("scan"),
    ref=[ans(within="@prev", where="folder count = 0")]),
  T("rename Scan 0221 to Hāngī quote from Ngaire", diff(upd("scan", name="Hāngī quote from Ngaire")),
    ref=[act("edit", rows="$scan", args=lines(name="Hāngī quote from Ngaire"))]))

S("T28-072", "document span month date starred empty",
  T("docs from the start of last month up to the tenth", rows("super", "rates_notice", "power_jan", "minutes_doc",
                                                             "venue_booking", "notice"),
    ref=[ans(kind="document", when=W(span(U("month", -1), D("2026-02-10"))))]),
  T("any of them starred", rows(),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T28-073", "document from datetime span week date",
  T("what docs have come in since monday 2pm", rows("roof_quote", "draw", "itinerary", "tshirt_design",
                                                    "blood_results", "scan"),
    ref=[ans(kind="document", when=W({"from": U("week", 0, weekday=1, time="14:00")}))]),
  T("last week through tuesday, same filter", rows("venue_booking", "notice", "roof_quote", "draw"),
    ref=[ans(kind="document", when=W(span(U("week", -1), U("week", 0, weekday=2))))]))

S("T28-074", "five turns person met empty span named month datetime event count log balance",
  T("which of my weekly people haven't got a met place saved", rows("mere", "ria", "hine"),
    ref=[ans(kind="person", where="met is empty and cadence = 7")]),
  T("who'd i talk to between the start of jan and wednesday at noon", rows("kevin", "huia", "rawiri", "trev"),
    ref=[ans(kind="person", when=W(span(U("month", 0, name=1), U("week", -1, weekday=3, time="12:00"))))]),
  T("which of them are on more than 3 events", rows("huia"),
    ref=[ans(within="@prev", where="event count > 3")]),
  T("messaged Huia Morgan about the minutes, log it", diff(upd("huia", date=ANY)),
    ref=[act("log", rows="$huia", args=lines(kind="message"))]),
  T("where am i at with her money wise", val((-30, "NZD")),
    ref=[comp(op="balance", rows="$huia"), ans(value="@prev")]))

S("T28-075", "person span weekday met set date time log",
  T("who did i speak to since monday",
    rows("hemi_r", "hemi_t", "hine", "ngaire", "sam", "mere", "ria", "aroha"),
    ref=[ans(kind="person", when=W(span(U("week", 0, weekday=1), U("day", 0))))]),
  T("which of them turn up in my photos", rows("hemi_r", "hemi_t", "hine", "mere", "ria", "aroha"),
    ref=[ans(within="@prev", where="photo count != 0")]),
  T("who did i catch up with at half 7 on wednesday", rows("hemi_t"),
    ref=[ans(kind="person", when=W(U("week", 0, weekday=3, time="19:30")))]),
  T("rang him again this morning, log a call", diff(upd("hemi_t", date=ANY)),
    ref=[act("log", rows="$hemi_t", args=lines(kind="call"))]))
