from gold import *


S("T21-051", "four turns nickname in debt count linked read",
  T("who are shiru and mama njeri in my contacts", rows("wanjiru", "esther"),
    ref=[ans(kind="person", where='nickname in ("Shiru", "Mama Njeri")')]),
  T("do either of them have debts on record with me", rows("esther"),
    ref=[ans(kind="person", within="@prev", where="debt count != 0")]),
  T("what's that one about", rows("d_esther"),
    ref=[ans(kind="debt", linked_to="$esther")]),
  T("is it still open?", rows("d_esther"),
    ref=[ans(kind="debt", linked_to="$esther", where='status = "settled"')]))

S("T21-052", "note count linked notebook linked_to all",
  T("which people have exactly two notes about them", rows("brian", "wanjiru", "beatrice", "kevin"),
    ref=[ans(kind="person", where="note count = 2")]),
  T("show me beatrice's", rows("loans", "chama_may"),
    ref=[ans(kind="note", linked_to="$beatrice")]),
  T("which notebook are those in", rows("chama_nb"),
    ref=[ans(kind="notebook", linked_to="@prev")]))

S("T21-053", "single nickname in",
  T("are Tabby and Fundi in my contacts", rows("tabby", "githinji"),
    ref=[ans(kind="person", where='nickname in ("Tabby", "Fundi")')]))

S("T21-054", "debt count starred linked settle_debt",
  T("any starred contacts with debts between us", rows("kevin", "alice"),
    ref=[ans(kind="person", where="starred = yes and debt count != 0")]),
  T("what's alice's one", rows("d_alice"),
    ref=[ans(kind="debt", linked_to="$alice")]),
  T("she paid me at the chama, mark it settled", diff(upd("d_alice", status="settled")),
    ref=[act("settle_debt", rows="$d_alice")]))

S("T21-055", "event duration week cancel decline",
  T("short things next week, half an hour or less", rows("brief_0608", "clinic_june"),
    ref=[ans(kind="event", when=U("week", 1), where="duration <= 30")]),
  T("cancel monday's briefing, i'm off to the zonal office", diff(upd("brief_0608", status="cancelled")),
    ref=[act("cancel", rows="$brief_0608")]),
  T("and sms the staff that it's off", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T21-056", "four turns event duration description delete named",
  T("anything tomorrow?", rows("kevin_call"),
    ref=[ans(kind="event", when=U("day", 1))]),
  T("week after next, anything an hour or shorter", rows("brief_0615"),
    ref=[ans(kind="event", when=U("week", 2), where="duration <= 60")]),
  T("which things that week have a place written down", rows("brief_0615", "survey", "mock_start", "sports_day",
                                                            "harambee_day"),
    ref=[ans(kind="event", when=U("week", 2), where="description is set")]),
  T("delete the chama retreat while you're at it, it's off", diff(trash("chama_retreat")),
    ref=[act("delete", kind="event", name="Chama retreat")]))

S("T21-057", "task count subtasks complete",
  T("show me tasks that break down into subtasks", rows("mock_tt", "appraisals"),
    ref=[ans(kind="task", where="task count != 0")]),
  T("what's open under appraisals", rows("appr_daniel", "appr_collins"),
    ref=[ans(kind="task", linked_to="$appraisals", where='status = "open"')]),
  T("tick off Appraise Daniel, did it yesterday", diff(upd("appr_daniel", status="completed", completed=ANY)),
    ref=[act("complete", rows="$appr_daniel")]))

S("T21-058", "four turns list count refused unit effort unit add_to",
  T("tasks still open that belong to no list", rows("hod_slots", "print_tt", "appr_daniel", "appr_collins", "deed",
                                              "insurance", "seedlings", "call_esther", "thesis", "pension"),
    ref=[ans(kind="task", where='list count = 0 and status = "open"')]),
  T("the ones over an hour of work", rows("deed", "seedlings", "thesis"),
    ref=[bad(ans(kind="task", within="@prev", where="effort > 1 hour")),
         ans(kind="task", within="@prev", where="effort > 60")]),
  T("from that first lot, which aren't thirty min jobs", rows("appr_daniel", "appr_collins", "deed", "seedlings",
                                                          "call_esther", "thesis"),
    ref=[ans(kind="task", within="@1", where="effort != 30 minutes")]),
  T("put brian's thesis on the home list", diff(link("home_l", "thesis")),
    ref=[act("add_to", rows="$thesis", args=lines(to="$home_l"))]))

S("T21-059", "list task count edit create task list",
  T("which lists have fewer than four tasks", rows("health_l", "garden_l"),
    ref=[ans(kind="list", where="task count < 4")]),
  T("rename garden to Shamba", diff(upd("garden_l", name="Shamba")),
    ref=[act("edit", rows="$garden_l", args=lines(name="Shamba"))]),
  T("add plant sukuma wiki to it for next saturday",
    diff(new("task", name=has("sukuma"), date="2026-06-13"), link("garden_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Plant sukuma wiki", date=U("week", 1, weekday=6),
                                  list="$garden_l"))]))

S("T21-060", "single locker notes",
  T("which locker items are marked school", rows("tsc_portal", "nemis", "server_key"),
    ref=[ans(kind="locker item", where='notes = "school"')]))

S("T21-061", "locker notes type sealed_egress read",
  T("school logins in the locker", rows("tsc_portal", "nemis"),
    ref=[ans(kind="locker item", where='notes = "school" and type = login')]),
  T("email the nemis password to collins, he's doing the census", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("fine what's the username on it", rows("nemis"),
    ref=[ans(rows="$nemis")]))

S("T21-062", "single debt person count empty",
  T("any debts with nobody attached to them?", rows(),
    ref=[ans(kind="debt", where="person count <= 0")]))

S("T21-063", "compute max effort status",
  T("biggest job by effort, open vs in progress", vgroups({"open": 240, "in_progress": 300}),
    ref=[comp(op="max", field="effort", kind="task", where='status in ("open", "in_progress")', group="status"),
         ans(value="@prev")]),
  T("which is the 300 one", rows("appraisals"),
    ref=[ans(kind="task", where='effort = 300 and status = "in_progress"')]),
  T("and the smallest open job?", val(5),
    ref=[ans(op="min", field="effort", kind="task", where='status = "open"')]))

S("T21-064", "balance min search",
  T("where do i stand with mary achieng", val((1500, "KES")),
    ref=[ans(op="balance", rows="$mary_a")]),
  T("smallest debt i owe anyone", val((500, "KES")),
    ref=[ans(op="min", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("who's that to", rows("susan"),
    ref=[find(kind="debt", where='direction = "i_owe" and status = "open"', order="amount asc", limit=1),
         ans(kind="person", linked_to="@prev")]))

S("T21-065", "star multi find",
  T("star Collins Omondi and Janet Akinyi, they carried the book fair", diff(upd("collins", starred=True), upd("janet", starred=True)),
    ref=[act("star", rows="$collins, $janet")]),
  T("who's starred now, just the teachers", rows("mary_w", "collins", "janet"),
    ref=[ans(kind="person", where='starred = yes and role contains "teacher"')]),
  T("find the Mwangi family members", rows("kevin", "brian", "naomi", "me"),
    ref=[find(kind="person", linked_to="$family"), ans(rows="@prev")]),
  T("log a message with naomi, sent her the grad plan", diff(upd("naomi", date=ANY)),
    ref=[act("log", rows="$naomi", args=lines(kind="message"))]))

S("T21-066", "create group undo create",
  T("start a group Heads conference Mombasa", diff(new("group", name="Heads conference Mombasa"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Heads conference Mombasa"))]),
  T("undo that, the county is paying for it all", diff(gone("+1"), unlink("+1", "me")),
    ref=[act("undo")]))

S("T21-067", "group where rename count",
  T("rename the group that has six of us in it to Tumaini women's chama",
    diff(upd("chama", name="Tumaini women's chama")),
    ref=[act("edit", kind="group", where="person count >= 6", args=lines(name="Tumaini women's chama"))]),
  T("and which groups have four or fewer", rows("harambee", "bom_tea", "family", "grad_trip"),
    ref=[ans(kind="group", where="person count <= 4")]))

S("T21-068", "reopen task where yesterday knock-on reschedule",
  T("reopen the task i ticked off yesterday, the airtime didn't go through",
    diff(upd("airtime", status="open", completed=None)),
    ref=[act("reopen", kind="task", when=U("day", -1), where='status = "completed"')]),
  T("due today then", diff(upd("airtime", date="2026-06-06")),
    ref=[act("reschedule", rows="$airtime", args=lines(to=U("day", 0)))]),
  T("anything else due today?", rows("contrib"),
    ref=[ans(kind="task", when=U("day", 0), exclude="$airtime")]))

S("T21-069", "delete task named undo delete",
  T("delete Check pension statement, TSC sorted it", diff(trash("pension")),
    ref=[act("delete", kind="task", name="Check pension statement")]),
  T("hmm actually undo, i want to check it myself", diff(restore("pension")),
    ref=[act("undo")]),
  T("and restore Sell the old sofa, a buyer called", ask(),
    ref=[bad(act("restore", kind="task", name="Sell the old sofa", trashed=True)),
         askc("that task was binned on 1 april, past the 30 days, so it can't come back. add it again as a new task?")]))

S("T21-070", "trashed note restore window refused find delete prev",
  T("is the old chama minutes note in the trash", rows("old_minutes"),
    ref=[ans(kind="note", name="Old chama minutes", trashed=True)]),
  T("bring it back", decline("not_found"),
    ref=[bad(act("restore", rows="$old_minutes")),
         dec("not_found")]),
  T("ok what about router notes, is that around", rows("wifi_note"),
    ref=[ans(kind="note", name="Router notes")]),
  T("delete it, we changed to a new provider", diff(trash("wifi_note")),
    ref=[act("delete", rows="@prev")]))

S("T21-071", "create document edit new star",
  T("new doc: Parents day programme", diff(new("document", name="Parents day programme")),
    ref=[act("create", args=lines(kind="document", name="Parents day programme"))]),
  T("make it Parents' day programme 2026", diff(upd("+1", name="Parents' day programme 2026")),
    ref=[act("edit", rows="$c1", args=lines(name="Parents' day programme 2026"))]),
  T("and star it", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("is Old shop lease in the trash? restore it", diff(restore("old_lease")),
    ref=[act("restore", kind="document", name="Old shop lease", trashed=True)]))

S("T21-072", "document find delete multi prev",
  T("docs in the medical folder", rows("bp_chart", "sha_letter"),
    ref=[ans(kind="document", linked_to="$medical_f")]),
  T("both are old copies, delete them", diff(trash("bp_chart"), trash("sha_letter")),
    ref=[act("delete", rows="@prev")]),
  T("is the medical folder empty", val(0),
    ref=[ans(op="count", kind="document", linked_to="$medical_f")]))

S("T21-073", "remove_from document named add_to",
  T("take the survey map out of land", diff(unlink("land_f", "survey_map")),
    ref=[act("remove_from", rows="$survey_map", args=lines(from_="$land_f"))]),
  T("put it in old receipts", diff(link("receipts_f", "survey_map")),
    ref=[act("add_to", rows="$survey_map", args=lines(to="$receipts_f"))]),
  T("undo that, keep it loose", diff(unlink("receipts_f", "survey_map")),
    ref=[act("undo")]))

S("T21-074", "photo search edit prev add_to prev",
  T("find the photo of the broken gutter", rows("gutter_p"),
    ref=[ans(kind="photo", name="gutter")]),
  T("call it Grade 3 gutter", diff(upd("gutter_p", name="Grade 3 gutter")),
    ref=[act("edit", rows="@prev", args=lines(name="Grade 3 gutter"))]),
  T("and put it in school events", diff(link("school_album", "gutter_p")),
    ref=[act("add_to", rows="@prev", args=lines(to="$school_album"))]))

S("T21-075", "album where rename album count",
  T("the album that has nothing in it, rename it to Brian graduation 2026",
    diff(upd("mombasa_album", name="Brian graduation 2026")),
    ref=[act("edit", kind="album", where="photo count = 0", args=lines(name="Brian graduation 2026"))]),
  T("add the gown fitting photo to it", diff(link("mombasa_album", "gown_fitting")),
    ref=[act("add_to", kind="photo", name="Brian in his gown", args=lines(to="$mombasa_album"))]),
  T("how many photos are in the graduations album", val(2),
    ref=[ans(op="count", kind="photo", linked_to="$grad_album")]))
