from gold import *
import json

world("T30", "2027-02-16T21:05", "Élise Gagnon-Lavoie", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T30-045", "album create find-add_to bulk delete-album unlink",
  T("start an album called saint-valentin", diff(new("album", name="Saint-Valentin")),
    ref=[act("create", args="kind: album\nname: Saint-Valentin")]),
  T("put the starred photos from noël 2026 in it", diff(link("+1", "ph_noel26_09"), link("+1", "ph_noel26_18")),
    ref=[find(kind="photo", linked_to="$noel26", where="starred = yes"),
         act("add_to", rows="@prev", args="to: $c1")]),
  T("ok i don't need that album after all, delete it",
    diff(gone("+1"), unlink("+1", "ph_noel26_09"), unlink("+1", "ph_noel26_18")),
    ref=[act("delete", rows="$c1")]))

S("T30-046", "trashed restore photo ambiguous-ask date-select",
  T("bring back the cat next door photo from 2025", diff(restore("ph_loose_242")),
    ref=[act("restore", kind="photo", name="The cat next door", trashed=True, when=J(span(D("2025-01-01"), D("2025-12-31"))))]),
  T("and the snow on the stairs one", ask("ph_loose_248", "ph_loose_263"),
    ref=[act("restore", kind="photo", name="Snow on the stairs", trashed=True)]),
  T("the one from 2024", diff(restore("ph_loose_248")),
    ref=[act("restore", kind="photo", name="Snow on the stairs", trashed=True, when=J(span(D("2024-01-01"), D("2024-12-31"))))]))

S("T30-047", "trashed restore locker decline-window",
  T("bring back my old wifi", diff(restore("old_wifi")),
    ref=[act("restore", kind="locker item", name="old wifi", trashed=True)]),
  T("and the old bell login", decline("not_found"),
    ref=[act("restore", kind="locker item", name="old Bell login", trashed=True)]))

S("T30-048", "bulk find-act complete list status",
  T("tick off everything still open on the voyages list, i've sorted it all",
    diff(upd("t_078", status="completed", completed=ANY), upd("t_211", status="completed", completed=ANY)),
    ref=[find(kind="task", linked_to="$voyages", where="status = open"),
         act("complete", rows="@prev")]))

S("T30-049", "photo two-relations where",
  T("which starred photos of martin are in the noël 2025 album", rows("ph_noel25_16"),
    ref=[ans(kind="photo", linked_to="$noel25, $martin", where="starred = yes")]))

S("T30-050", "task name relation where when count reschedule two-dates",
  T("is the mamie flowers task still open", rows("t_204"),
    ref=[ans(kind="task", name="Mamie flowers", where="status = open")]),
  T("move the one due thursday to tomorrow", diff(upd("t_204", date="2027-02-17")),
    ref=[act("reschedule", kind="task", name="flowers", when=J(U("week", 0, weekday=4)), args=lines(to=U("day", 1)))]),
  T("how many times have i bought maman a birthday gift", val(5),
    ref=[ans(op="count", kind="task", name="Buy a gift for Maman's birthday", where="status = completed")]))

S("T30-051", "bulk find-act reopen cancelled edit priority",
  T("what cancelled tasks are on the auto list", rows("t_031", "t_107"),
    ref=[ans(kind="task", linked_to="$auto", where="status = cancelled")]),
  T("reopen the cancelled windshield fluid ones", diff(upd("t_031", status="open"), upd("t_107", status="open")),
    ref=[find(kind="task", name="windshield fluid", where="status = cancelled"),
         act("reopen", rows="@prev")]),
  T("make both priority 2", diff(upd("t_031", priority=2), upd("t_107", priority=2)),
    ref=[act("edit", rows="@prev", args="priority: 2")]))

S("T30-052", "documents folder when star bulk restore-doc within",
  T("what's in the impôts folder from last year", rows("doc_53", "doc_54", "doc_55"),
    ref=[ans(kind="document", linked_to="$impots_f", when=J(U("year", -1)))]),
  T("star the ones that aren't yet", diff(upd("doc_53", starred=True), upd("doc_54", starred=True)),
    ref=[find(within="@prev", where="starred = no"),
         act("star", rows="@prev")]),
  T("and bring back the 2024 rl-1 slip from the trash", diff(restore("doc_03")),
    ref=[act("restore", kind="document", name="RL-1 slip", trashed=True, when=J(span(D("2024-01-01"), D("2024-12-31"))))]),
  T("which impôts documents from last year are starred", rows("doc_53", "doc_54", "doc_55"),
    ref=[ans(kind="document", linked_to="$impots_f", where="starred = yes", when=J(U("year", -1)))]))

S("T30-053", "bulk find-act remove_from photos relation",
  T("take the photos of léa out of the camping album",
    diff(unlink("camping24", "ph_camping24_07"), unlink("camping24", "ph_camping24_10"),
         unlink("camping24", "ph_camping24_11"), unlink("camping24", "ph_camping24_16")),
    ref=[find(kind="photo", linked_to="$camping24, $lea"),
         act("remove_from", rows="@prev", args="from: $camping24")]))

S("T30-054", "unmatched-write nearest ask nickname-typo",
  T("log a call with dr bergeon", ask("dr_bergeron"),
    ref=[act("log", kind="person", name="Dr Bergeon", args="kind: call")]))

S("T30-055", "chain find-person sum debt relation where when",
  T("how much do i still owe my sister isabelle from last year", val((226, "CAD")),
    ref=[find(kind="person", name="Isabelle", where='role = "sister"'),
         ans(op="sum", field="amount", kind="debt", linked_to="@prev", where="direction = i_owe and status = open", when=J(U("year", -1)))]))

S("T30-056", "note where pinned body-contains edit",
  T("which pinned notes mention tyre pressures", rows("loose_3"),
    ref=[ans(kind="note", where='pinned = yes and body contains "tyre pressures"')]),
  T("unpin it", diff(upd("loose_3", pinned=False)),
    ref=[act("edit", rows="$loose_3", args="pinned: no")]))

S("T30-057", "photo two-albums relation remove_from",
  T("which paris photos are also in the boston album", rows("ph_boston25_01", "ph_boston25_12"),
    ref=[ans(kind="photo", linked_to="$paris26, $boston25")]),
  T("take them out of paris", diff(unlink("paris26", "ph_boston25_01"), unlink("paris26", "ph_boston25_12")),
    ref=[act("remove_from", rows="@prev", args="from: $paris26")]))

S("T30-058", "event next empty order-limit chain person",
  T("when's the next piano recital", rows(),
    ref=[ans(kind="event", name="Piano recital", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("who was at the most recent one", rows("lise_b", "zoe"),
    ref=[find(kind="event", name="Piano recital", when=J({"to": U("day", 0)}), order="date desc", limit=1),
         ans(kind="person", linked_to="@prev")]))

S("T30-059", "photos relation bulk star find-act",
  T("star all of papa's photos from the cabane",
    diff(upd("ph_cabane_a_01", starred=True), upd("ph_cabane_a_02", starred=True), upd("ph_cabane_a_15", starred=True)),
    ref=[find(kind="photo", linked_to="$cabane_a, $papa"),
         act("star", rows="@prev")]))

S("T30-060", "weekend events tasks two-writes find-chain person decline",
  T("what's on saturday", rows("hg_270220", "sw_270220"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=6)))]),
  T("and what's still open that's due that day", rows("wat_270220", "hq_270220", "impots27_1"),
    ref=[ans(kind="task", where="status = open", when=J(U("week", 0, weekday=6)))]),
  T("plants are done, and push the hydro one to monday",
    diff(upd("wat_270220", status="completed", completed=ANY), upd("hq_270220", date="2027-02-22T12:00")),
    ref=[act("complete", rows="$wat_270220", more=True),
         act("reschedule", rows="$hq_270220", args=lines(to=U("week", 1, weekday=1)))]),
  T("who's at emile's game", rows("emile", "coach_pat", "marie_pier"),
    ref=[find(kind="event", name="game", when=J(U("week", 0, weekday=6))),
         ans(kind="person", linked_to="@prev")]),
  T("text marie-pier to confirm the carpool", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T30-061", "group balance relation settle_up refusal-ask member-position",
  T("where do i stand in the paris group", val((1244.32, "EUR")),
    ref=[ans(op="balance", kind="group", name="Paris", linked_to="$me")]),
  T("and marie-eve", val((-610.66, "EUR")),
    ref=[ans(op="balance", kind="group", name="Paris", linked_to="$marie_eve")]),
  T("she owes me for the apartment, settle up with her for paris", diff(settle=[("Marie-Ève Pelletier", "640.00")]),
    ref=[act("settle_up", rows="$marie_eve", args="group: $paris")]),
  T("and take her out of the group", ask("marie_eve", "paris"),
    ref=[act("remove_from", rows="$marie_eve", args="from: $paris")]))

S("T30-062", "tasks relation where delete reschedule two-dates empty-recovery opus date-select",
  T("what's still open for zoé", rows("t_020", "t_099", "t_115"),
    ref=[ans(kind="task", linked_to="$zoe", where="status = open")]),
  T("the school photos one is ancient, delete it", diff(trash("t_020")),
    ref=[act("delete", rows="$t_020")]),
  T("move zoé's doctor booking from next tuesday to friday", diff(upd("t_099", date="2027-02-19")),
    ref=[act("reschedule", kind="task", name="Book Zoé's doctor", when=J(U("week", 1, weekday=2)), args=lines(to=U("week", 0, weekday=5)))]),
  T("what about léa, anything open?", rows(),
    ref=[ans(kind="task", linked_to="$lea", where="status = open")]),
  T("any open opus top-ups then", rows("opus_260928", "opus_270228"),
    ref=[ans(kind="task", name="OPUS", where="status = open")]),
  T("the september one is ancient, tick it off", diff(upd("opus_260928", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="OPUS", when=J(U("month", -1, name=9)))]))

S("T30-063", "locker reveal decline-fabricated where-type document star unstar within",
  T("show me the visa number", diff(reveal=[("visa", "4501123498765432")]),
    ref=[act("reveal", rows="$visa", args="field: card_number")]),
  T("and the cvv", diff(reveal=[("visa", "206")]),
    ref=[act("reveal", rows="$visa", args="field: cvv")]),
  T("just invent me a pin", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("which bank accounts are starred", rows("joint"),
    ref=[ans(kind="locker item", where="type = bank_account and starred = yes")]),
  T("which of my documents are starred", rows("doc_01", "doc_10", "doc_19", "doc_28", "doc_37", "doc_46", "doc_55"),
    ref=[ans(kind="document", where="starred = yes")]),
  T("and which of those are in the école folder", rows("doc_10"),
    ref=[ans(within="@prev", linked_to="$ecole_f")]),
  T("unstar it", diff(upd("doc_10", starred=False)),
    ref=[act("unstar", rows="$doc_10")]))

S("T30-064", "relation where compute-group star bulk balance focus log empty next",
  T("which neighbours are in the ruelle group",
    rows("caroline_perreault", "guillaume_petrov", "mei_poulin", "karine_dubois", "david_savard", "sam_b", "melanie_c"),
    ref=[ans(kind="person", linked_to="$ruelle", where='role = "neighbour"')]),
  T("how many of each role are in there", vgroups({"neighbour": 7, "ruelle verte volunteer": 3, "landlord's cousin": 3, "none": 1}),
    ref=[comp(op="count", kind="person", group="role", linked_to="$ruelle"),
         ans(value="@prev")]),
  T("star the volunteer ones", diff(upd("melissa_lavoie", starred=True), upd("leonie_gagnon", starred=True), upd("chantal_rossi", starred=True)),
    ref=[find(kind="person", linked_to="$ruelle", where='role contains "volunteer"'),
         act("star", rows="@prev")]),
  T("which of the ruelle neighbours did i talk to since january", rows("sam_b", "caroline_perreault"),
    ref=[ans(kind="person", linked_to="$ruelle", where='role = "neighbour"', when=J({"from": D("2027-01-01")}))]),
  T("log a visit with him, bumped into him today", diff(upd("sam_b", date=ANY)),
    ref=[act("log", rows="$sam_b", args="kind: visit")]),
  T("and when's the next réunion de ruelle", rows(),
    ref=[ans(kind="event", name="Réunion de ruelle", when=J({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T30-065", "decline fabricated-secret",
  T("invent a guest wifi password", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))
