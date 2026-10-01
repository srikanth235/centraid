from gold import *
import json

world("T03", "2026-10-14T21:10", "Rafael Duarte Silva", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = {"from": U("week", 0, weekday=6), "to": U("week", 0, weekday=7)}

S("T03-102", "star ask person pick balance",
  T("star pedro", ask("pedro_a", "pedro_c"),
    ref=[act("star", kind="person", name="Pedro"),
         askc("pedro almeida or pedro costa?", options="$pedro_a, $pedro_c")]),
  T("the futsal one", diff(upd("pedro_c", starred=True)),
    ref=[act("star", rows="$pedro_c")]),
  T("how much does he owe me", val((33, "EUR")),
    ref=[ans(op="balance", rows="$pedro_c")]))

S("T03-103", "star person contrast nickname unstar",
  T("favourite ana rita", diff(upd("ana_rita", starred=True)),
    ref=[act("star", kind="person", name="Ana Rita")]),
  T("and dra lopes", diff(upd("ana_lopes", starred=True)),
    ref=[act("star", rows="$ana_lopes")]),
  T("unstar mae", diff(upd("graca", starred=False)),
    ref=[search("Mãe", kind="person"), act("unstar", rows="$graca")]))

S("T03-104", "balance negative person nickname",
  T("do i owe inês anything", val((-67.4, "EUR")),
    ref=[ans(op="balance", kind="person", name="Inês")]),
  T("and miguel", val((-13.6, "EUR")),
    ref=[ans(op="balance", kind="person", name="Miguel")]),
  T("ricky?", val((-7.2, "EUR")),
    ref=[search("ricky", kind="person"), ans(op="balance", rows="$ricardo")]),
  T("star him", diff(upd("ricardo", starred=True)),
    ref=[act("star", rows="$ricardo")]))

S("T03-105", "ask event reschedule pick contrast",
  T("move tiago to inês's to 7", ask("handover_1018", "handover_1101"),
    ref=[act("reschedule", kind="event", name="Tiago to Inês's", args=lines(to=U("day", 0, anchor="row", time="19:00"))),
         askc("the one this sunday or the one on 1 nov?", options="$handover_1018, $handover_1101")]),
  T("the one this sunday", diff(upd("handover_1018", date="2026-10-18T19:00")),
    ref=[act("reschedule", rows="$handover_1018", args=lines(to=U("day", 0, anchor="row", time="19:00")))]),
  T("same for the november one", diff(upd("handover_1101", date="2026-11-01T19:00")),
    ref=[act("reschedule", rows="$handover_1101", args=lines(to=U("day", 0, anchor="row", time="19:00")))]))

S("T03-106", "ask task delete pick undo",
  T("delete pay edp bill", ask("edp_sep", "edp_oct"),
    ref=[act("delete", kind="task", name="Pay EDP bill"),
         askc("the paid september one or the october one?", options="$edp_sep, $edp_oct")]),
  T("october", diff(trash("edp_oct")),
    ref=[act("delete", rows="$edp_oct")]),
  T("hm no, undo", diff(restore("edp_oct")),
    ref=[act("undo")]))

S("T03-107", "task read delete contrast ask reschedule pick",
  T("which edp bill is still open", rows("edp_oct"),
    ref=[ans(kind="task", name="Pay EDP bill", where='status = "open"')]),
  T("delete that one", diff(trash("edp_oct")),
    ref=[act("delete", rows="$edp_oct")]),
  T("push the mark 9 tests to friday", ask("mark_9b", "mark_9c"),
    ref=[act("reschedule", kind="task", name="Mark 9", args=lines(to=U("week", 0, weekday=5))),
         askc("9B or 9C?", options="$mark_9b, $mark_9c")]),
  T("9c", diff(upd("mark_9c", date="2026-10-16")),
    ref=[act("reschedule", rows="$mark_9c", args=lines(to=U("week", 0, weekday=5)))]))

S("T03-108", "document star ask pick already",
  T("star the tiago doc", ask("enrolment", "vaccines"),
    ref=[act("star", kind="document", name="Tiago"),
         askc("the school enrolment or the vaccination record?", options="$enrolment, $vaccines")]),
  T("vaccines", diff(upd("vaccines", starred=True)),
    ref=[act("star", rows="$vaccines")]),
  T("and the tenancy contract", diff(already=["lease"]),
    ref=[act("star", kind="document", name="Tenancy contract"), ans(rows="$lease")]),
  T("star the cv too", diff(upd("cv", starred=True)),
    ref=[act("star", kind="document", name="CV")]))

S("T03-109", "locker star ask pick",
  T("star the key", ask("ssh", "api", "pavilion_code"),
    ref=[act("star", kind="locker item", name="key"),
         askc("the lab server key, the pubchem api key or the pavilion key box?", options="$ssh, $api, $pavilion_code")]),
  T("the pavilion one", diff(upd("pavilion_code", starred=True)),
    ref=[act("star", rows="$pavilion_code")]),
  T("how many locker things have a star", val(3),
    ref=[ans(op="count", kind="locker item", where="starred = yes")]))

S("T03-110", "wifi read star reveal",
  T("wifi pw", rows("wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("star it", diff(upd("wifi", starred=True)),
    ref=[act("star", rows="$wifi")]),
  T("ok show me the wifi password", diff(reveal=[("wifi", "francesinha-2026")]),
    ref=[act("reveal", rows="$wifi", args=lines(field="password"))]))

S("T03-111", "wifi code read star router reveal",
  T("the guests want the wifi code", rows("wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("star the router admin", diff(upd("router", starred=True)),
    ref=[act("star", kind="locker item", name="Router admin")]),
  T("what's the router password", diff(reveal=[("router", "meo-admin-4471")]),
    ref=[act("reveal", rows="$router", args=lines(field="password"))]))

S("T03-112", "ask event cancel never_mind",
  T("cancel the cardiology", ask("cardio_fu", "cardio_echo"),
    ref=[act("cancel", kind="event", name="cardiology"),
         askc("the follow-up on the 20th or the echo on 10 nov?", options="$cardio_fu, $cardio_echo")]),
  T("never mind, i'll ring the hospital first", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T03-113", "ask document delete never_mind",
  T("delete the conference doc", ask("conf_reg", "abstract_doc"),
    ref=[act("delete", kind="document", name="Conference"),
         askc("the registration or the abstract?", options="$conf_reg, $abstract_doc")]),
  T("scratch that", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T03-114", "reschedule undo never_mind delete contrast",
  T("put mãe's physio on the 19th to 4", diff(upd("physio_1019", date="2026-10-19T16:00")),
    ref=[act("reschedule", kind="event", name="Mãe physio", when=W(D("2026-10-19")),
             args=lines(to=U("day", 0, anchor="row", time="16:00")))]),
  T("cancel that, she prefers three", diff(upd("physio_1019", date="2026-10-19T15:00")),
    ref=[act("undo")]),
  T("delete the conference registration, it's a dupe", diff(trash("conf_reg")),
    ref=[act("delete", kind="document", name="Conference registration")]),
  T("how many docs are left in school", val(3),
    ref=[ans(op="count", kind="document", linked_to="$school_f")]))

S("T03-115", "ask person star never_mind",
  T("star ana", ask("ana_rita", "ana_lopes"),
    ref=[act("star", kind="person", name="Ana"),
         askc("ana rita or ana lopes?", options="$ana_rita, $ana_lopes")]),
  T("forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("ok how much does ana rita owe me", val((58.1, "EUR")),
    ref=[ans(op="balance", rows="$ana_rita")]))

S("T03-116", "decline out_of_scope read weekday reschedule",
  T("book a table at cantinho for saturday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("what's on saturday then", rows("match_1017", "anniv"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=6)))]),
  T("push the match to 11", diff(upd("match_1017", date="2026-10-17T11:00")),
    ref=[act("reschedule", rows="$match_1017", args=lines(to=U("day", 0, anchor="row", time="11:00")))]),
  T("and cancel training thursday", diff(upd("train_1015", status="cancelled")),
    ref=[act("cancel", kind="event", name="Futsal training", when=W(U("week", 0, weekday=4)))]))
