from gold import *
import json

world("T30", "2027-02-16T21:05", "Élise Gagnon-Lavoie", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T30-138", "decline-out-of-scope read document name",
  T("forward the notice of assessment to my accountant", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("which notice of assessment documents do i have", rows("doc_02", "doc_28", "doc_54"),
    ref=[ans(kind="document", name="notice of assessment")]))

S("T30-139", "compute group role where met events status when",
  T("what roles are the ruelle people and how many of each", vgroups({"landlord's cousin": 5, "neighbour": 13, "ruelle verte volunteer": 5}),
    ref=[comp(op="count", kind="person", group="role", where='met = "ruelle verte"'),
         ans(value="@prev")]),
  T("and events by status this year", vgroups({"cancelled": 1, "tentative": 83}),
    ref=[comp(op="count", kind="event", group="status", when=J(U("year", 0))),
         ans(value="@prev")]))

S("T30-140", "trashed read restore photo name",
  T("pull up everything i've thrown out of the photos, i think the bike rack one is in there", rows("ph_loose_242", "ph_loose_245", "ph_loose_248", "ph_loose_252", "ph_loose_255", "ph_loose_259", "ph_loose_263", "ph_loose_268"),
    ref=[ans(kind="photo", trashed=True)]),
  T("bring the bike rack one back from the trash", diff(restore("ph_loose_245")),
    ref=[act("restore", kind="photo", name="Bike rack", trashed=True)]))

S("T30-141", "ambiguous-ask log person role-select husband",
  T("log a visit with mathieu, we spent half the afternoon together", ask("mathieu", "mathieu_caron", "mathieu_dubois", "mathieu_ouellet"),
    ref=[act("log", kind="person", name="Mathieu", args="kind: visit")]),
  T("my husband", diff(upd("mathieu", date=ANY)),
    ref=[act("log", kind="person", name="Mathieu", where='role = "husband"', args="kind: visit")]))

S("T30-142", "empty-recovery search vacation event order-limit",
  T("when's the next vacation", rows(),
    ref=[search("vacation"),
         ans(kind="event", name="vacation", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("what about the most recent trip we took", rows("paris_26"),
    ref=[ans(kind="event", name="trip", when=J({"to": U("day", 0)}), order="date desc", limit=1)]))

S("T30-143", "decline-out-of-scope read event when",
  T("i'm calling my cousin in paris tonight, what time is it there right now", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok when's the next hockey game", rows("hg_270220"),
    ref=[ans(kind="event", name="Hockey game", when=J({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T30-144", "documents find-act star unstar count where when",
  T("star the insurance papers from last year", diff(upd("doc_56", starred=True), upd("doc_57", starred=True), upd("doc_58", starred=True)),
    ref=[find(kind="document", name="insurance", when=J(U("year", -1))),
         act("star", rows="@prev")]),
  T("and unstar the starred ones from 2024", diff(upd("doc_01", starred=False), upd("doc_10", starred=False), upd("doc_19", starred=False)),
    ref=[find(kind="document", where="starred = yes", when=J(U("year", -3))),
         act("unstar", rows="@prev")]),
  T("so how many documents are starred at this point", val(7),
    ref=[ans(op="count", kind="document", where="starred = yes")]))

S("T30-145", "star two-writes person where read empty",
  T("star mamie and pépère, they're the ones i call the most", diff(upd("mamie", starred=True), upd("pepere", starred=True)),
    ref=[act("star", rows="$mamie", more=True),
         act("star", rows="$pepere")]),
  T("are the mother-in-law and father-in-law starred now", rows("mamie", "pepere"),
    ref=[ans(kind="person", where='starred = yes and role in ("mother-in-law", "father-in-law")')]),
  T("and my sister or my brother", rows(),
    ref=[ans(kind="person", where='starred = yes and role in ("sister", "brother")')]))

S("T30-146", "find-act add_to photo linked where person",
  T("put martin's starred photos from noël 2025 in the cabane album", diff(link("cabane_a", "ph_noel25_16")),
    ref=[find(kind="photo", linked_to="$noel25, $martin", where="starred = yes"),
         act("add_to", rows="@prev", args="to: $cabane_a")]))
