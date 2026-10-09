from gold import *
import json

world("T17", "2026-01-30T13:35", "Elena Petrova", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T17-101", "star ask person pick balance",
  T("star maria", ask("maria_d", "maria_k"),
    ref=[act("star", kind="person", name="Maria"),
         askc("maria dimitrova or maria koleva?", options="$maria_d, $maria_k")]),
  T("the adult one", diff(upd("maria_k", starred=True)),
    ref=[act("star", rows="$maria_k")]),
  T("what's her balance with me", val((100, "BGN")),
    ref=[ans(op="balance", rows="$maria_k")]))

S("T17-102", "star person named contrast unstar",
  T("favourite maria dimitrova, she's got the recital", diff(upd("maria_d", starred=True)),
    ref=[act("star", kind="person", name="Maria Dimitrova")]),
  T("and tsvetan", diff(upd("tsvetan", starred=True)),
    ref=[act("star", kind="person", name="Tsvetan")]),
  T("unstar mila for now", diff(upd("mila", starred=False)),
    ref=[act("unstar", kind="person", name="Mila")]))

S("T17-103", "balance negative nickname role",
  T("do i owe mila anything", val((-200, "BGN")),
    ref=[ans(op="balance", kind="person", name="Mila")]),
  T("and vesi", val((-175, "BGN")),
    ref=[search("vesi", kind="person"), ans(op="balance", rows="$vesi")]),
  T("what about the tiler", val((-300, "BGN")),
    ref=[ans(op="balance", kind="person", where='role = "tiler"')]),
  T("star him, he did a good job", diff(upd("todor", starred=True)),
    ref=[act("star", kind="person", where='role = "tiler"')]))

S("T17-104", "ask event reschedule pick contrast",
  T("move stefan picks up viktor to 7", ask("handover_0201", "handover_0208"),
    ref=[act("reschedule", kind="event", name="Stefan picks up Viktor", args=lines(to=U("day", 0, anchor="row", time="19:00"))),
         find(kind="event", name="Stefan picks up Viktor"),
         askc("the one this sunday or the one on the 8th?", options="$handover_0201, $handover_0208")]),
  T("the first", diff(upd("handover_0201", date="2026-02-01T19:00")),
    ref=[act("reschedule", rows="$handover_0201", args=lines(to=U("day", 0, anchor="row", time="19:00")))]),
  T("same for the eighth", diff(upd("handover_0208", date="2026-02-08T19:00")),
    ref=[act("reschedule", rows="$handover_0208", args=lines(to=U("day", 0, anchor="row", time="19:00")))]))

S("T17-106", "task complete where contrast read prev complete",
  T("tick off buy sheet music", diff(upd("sheet_1", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Buy sheet music", where='status = "open"')]),
  T("which electricity bill is due this week", rows("elec_01"),
    ref=[ans(kind="task", name="electricity bill", when=W(U("week", 0)))]),
  T("paid it, tick it off", diff(upd("elec_01", status="completed", completed=ANY)),
    ref=[act("complete", rows="$elec_01")]))

S("T17-107", "ask task complete where pick",
  T("paid the electricity bill", ask("elec_01", "elec_02"),
    ref=[act("complete", kind="task", name="electricity bill", where='status = "open"'),
         find(kind="task", name="electricity bill", where='status = "open"'),
         askc("january's due on the 28th or february's?", options="$elec_01, $elec_02")]),
  T("january's", diff(upd("elec_01", status="completed", completed=ANY)),
    ref=[act("complete", rows="$elec_01")]),
  T("wait scratch that, i haven't actually paid it yet", diff(upd("elec_01", status="open", completed=None)),
    ref=[act("undo")]))

S("T17-108", "document star ask pick prev contrast",
  T("star the scan", ask("scan_71", "scan_72"),
    ref=[act("star", kind="document", name="Scan"),
         askc("scan 0071 or scan 0072?", options="$scan_71, $scan_72")]),
  T("0072", diff(upd("scan_72", starred=True)),
    ref=[act("star", rows="$scan_72")]),
  T("and the other one", diff(upd("scan_71", starred=True)),
    ref=[act("star", rows="$scan_71")]))

S("T17-109", "locker star ask pick already",
  T("star dsk", diff(upd("dsk", starred=True)),
    ref=[act("star", kind="locker item", name="DSK")]),
  T("star the dsk visa card too", diff(already=["visa"]),
    ref=[act("star", kind="locker item", name="DSK Visa card"), ans(rows="$visa")]))

S("T17-110", "locker star ask pick contrast",
  T("star the licence", ask("licence", "sibelius"),
    ref=[act("star", kind="locker item", name="licence"),
         askc("the driving licence or the sibelius licence?", options="$licence, $sibelius")]),
  T("the sibelius one", diff(upd("sibelius", starred=True)),
    ref=[act("star", rows="$sibelius")]),
  T("star driving licence too", diff(upd("licence", starred=True)),
    ref=[act("star", kind="locker item", name="Driving licence")]))

S("T17-111", "star ask person pick balance",
  T("star petrov", ask("stefan", "viktor"),
    ref=[act("star", kind="person", name="Petrov")]),
  T("the ex", diff(upd("stefan", starred=True)),
    ref=[act("star", rows="$stefan")]),
  T("tally between him and me right now", val((135, "BGN")),
    ref=[ans(op="balance", rows="$stefan")]))

S("T17-112", "log ask person pick contrast nickname",
  T("log a message to koleva", ask("maria_k", "desi"),
    ref=[act("log", kind="person", name="Koleva", args=lines(kind="message")),
         askc("maria koleva or desislava koleva?", options="$maria_k, $desi")]),
  T("desi, sent her the concert times", diff(upd("desi", date=ANY)),
    ref=[act("log", rows="$desi", args=lines(kind="message"))]),
  T("and a call with vesi, we went over the tempi", diff(upd("vesi", date=ANY)),
    ref=[search("vesi", kind="person"), act("log", rows="$vesi", args=lines(kind="call"))]))

S("T17-113", "note pin ask pick count",
  T("pin the bathroom note", diff(upd("measurements", pinned=True)),
    ref=[act("edit", kind="note", name="Bathroom", args=lines(pinned="yes"))]),
  T("how many are pinned now", val(5),
    ref=[ans(op="count", kind="note", where="pinned = yes")]))

S("T17-114", "ask event cancel never_mind",
  T("cancel the recital", ask("recital", "dress_reh"),
    ref=[act("cancel", kind="event", name="recital"),
         askc("the student recital on the 21st or the dress rehearsal on the 20th?", options="$recital, $dress_reh")]),
  T("never mind, leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T17-115", "ask person star never_mind wifi read star",
  T("star ivan", ask("ivan_t", "ivan_d"),
    ref=[act("star", kind="person", name="Ivan"),
         askc("ivan todorov or ivan dimov?", options="$ivan_t, $ivan_d")]),
  T("forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("wifi code for the students", rows("wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("star it", diff(upd("wifi", starred=True)),
    ref=[act("star", rows="$wifi")]))
