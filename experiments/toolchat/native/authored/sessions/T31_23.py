from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# --- counts that narrow one condition at a time, then the write on what is left -------------------------------------

S("T31-277", "values-narrowing people cadence not-starred hospital then star",
  T("how many people have i got a cadence set for", val(13),
    ref=[ans(op="count", kind="person", where="cadence is set")]),
  T("and how many of them aren't starred", val(7),
    ref=[ans(op="count", kind="person", where="cadence is set and starred = no")]),
  T("how many of those do i know from university hospital", val(3),
    ref=[ans(op="count", kind="person", where='cadence is set and starred = no and met = "University Hospital"')]),
  T("star the ones from university hospital", diff(upd("anna_w", starred=True), upd("ewa", starred=True), upd("marcin_b", starred=True)),
    ref=[find(kind="person", where='cadence is set and starred = no and met = "University Hospital"'), act("star", rows="@4")]))

S("T31-278", "values-narrowing tasks about-someone short december then push",
  T("how many open tasks are about someone", val(20),
    ref=[ans(op="count", kind="task", where="status = open and person count >= 1")]),
  T("and how many of those take under half an hour", val(7),
    ref=[ans(op="count", kind="task", where="status = open and person count >= 1 and effort < 30")]),
  T("how many of those are due before december", val(7),
    ref=[ans(op="count", kind="task", where="status = open and person count >= 1 and effort < 30", when=J({"to": D("2026-11-30")}))]),
  T("push the open tasks about someone that take under 10 minutes to tuesday",
    diff(upd("pay_ola", date="2026-11-10"), upd("pay_kuba", date="2026-11-10"), upd("physio_book", date="2026-11-10"),
         upd("pay_pizza", date="2026-11-10"), upd("pay_marta", date="2026-11-10")),
    ref=[find(kind="task", where="status = open and person count >= 1 and effort < 10"),
         act("reschedule", rows="@4", args=lines(to=U("week", 1, weekday=2)))]))
