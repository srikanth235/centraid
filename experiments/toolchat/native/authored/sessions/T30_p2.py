from gold import *
import json
def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T30-126-P", "documents find-act star unstar undo count relation where when para",
  T("give the 2025 maison documents stars", diff(upd("doc_40", starred=True), upd("doc_39", starred=True), upd("doc_41", starred=True)),
    ref=[find(kind="document", linked_to="$maison_f", when=J(U("year", -2))),
         act("star", rows="@prev")]),
  T("the two from 2024 as well", diff(upd("doc_15", starred=True), upd("doc_14", starred=True)),
    ref=[find(kind="document", linked_to="$maison_f", when=J(U("year", -3))),
         act("star", rows="@prev")]),
  T("count of starred documents at the moment", val(12),
    ref=[ans(op="count", kind="document", where="starred = yes")]),
  T("the two maison documents from 2024 lose their stars again", diff(upd("doc_15", starred=False), upd("doc_14", starred=False)),
    ref=[find(kind="document", linked_to="$maison_f", where="starred = yes", when=J(U("year", -3))),
         act("unstar", rows="@prev")]),
  T("undo it", diff(upd("doc_15", starred=True), upd("doc_14", starred=True)),
    ref=[act("undo")]))

S("T30-130-P", "ambiguous-ask photo delete date-select para",
  T("the neighbour's cat keeps showing up everywhere, get rid of the cat next door photo", ask("ph_loose_257", "ph_loose_287", "ph_loose_272"),
    ref=[act("delete", kind="photo", name="The cat next door")]),
  T("2024's", diff(trash("ph_loose_272")),
    ref=[act("delete", kind="photo", name="The cat next door", when=J(U("year", -3)))]))

S("T30-135-P", "write-read log person read name para",
  T("put a call with maman in the log, and when did i last talk to papa", rows("papa", also=diff(upd("maman", date=ANY))),
    ref=[act("log", rows="$maman", args="kind: call", more=True),
         ans(kind="person", name="Papa")]),
  T("mamie?", rows("mamie"),
    ref=[ans(kind="person", name="Mamie")]))

S("T30-140-P", "trashed read restore photo name para",
  T("what have i thrown out of the photos, i think the bike rack one is there", rows("ph_loose_242", "ph_loose_245", "ph_loose_248", "ph_loose_252", "ph_loose_255", "ph_loose_259", "ph_loose_263", "ph_loose_268"),
    ref=[ans(kind="photo", trashed=True)]),
  T("get the bike rack one out of the trash", diff(restore("ph_loose_245")),
    ref=[act("restore", kind="photo", name="Bike rack", trashed=True)]))

S("T30-144-P", "documents find-act star unstar count where when para",
  T("last year's insurance papers get stars", diff(upd("doc_56", starred=True), upd("doc_57", starred=True), upd("doc_58", starred=True)),
    ref=[find(kind="document", name="insurance", when=J(U("year", -1))),
         act("star", rows="@prev")]),
  T("remove stars from the starred ones from 2024", diff(upd("doc_01", starred=False), upd("doc_10", starred=False), upd("doc_19", starred=False)),
    ref=[find(kind="document", where="starred = yes", when=J(U("year", -3))),
         act("unstar", rows="@prev")]),
  T("how many starred documents are there by now", val(7),
    ref=[ans(op="count", kind="document", where="starred = yes")]))
