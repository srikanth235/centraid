from gold import *
import json

world("T25", "2026-10-11T18:45", "Yuki Tanaka", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T25-C001", "c3c compound delete edit documents",
  T("delete scan 0143 and rename scan 0142 to Mika passport photo spec",
    diff(trash("scan_b"), upd("scan_a", name="Mika passport photo spec")),
    ref=[act("delete", kind="document", name="Scan 0143", more=True),
         act("edit", kind="document", name="Scan 0142", args=lines(name="Mika passport photo spec"))]))

S("T25-C002", "c3c compound log create task bare weekday",
  T("log a message with gabrielle and add a task to return her book on friday",
    diff(upd("gab", date=ANY), new("task", name=has("return", "book"), date="2026-10-16")),
    ref=[act("log", kind="person", name="Gabrielle", args=lines(kind="message"), more=True),
         act("create", args=lines(kind="task", name="Return Gabrielle's book", date=U("week", 1, weekday=5)))]))

S("T25-C003", "c3c compound add_to list complete",
  T("put hang the gallery wall on the someday list and tick off the faucet fix, plumber came",
    diff(link("someday_l", "gallery"), unlink("home_l", "gallery"), upd("faucet", status="completed", completed=ANY)),
    ref=[act("add_to", kind="task", name="Hang the gallery wall", args=lines(to="$someday_l"), more=True),
         act("complete", kind="task", name="Fix the bathroom faucet")]))

S("T25-C004", "c3c compound three writes complete create log",
  T("flu shot is booked, tick that off, add a task to send the form to caron friday and log a message with her",
    diff(upd("flu_shot", status="completed", completed=ANY), new("task", name=has("caron", "form"), date="2026-10-16"),
         upd("caron", date=ANY)),
    ref=[act("complete", kind="task", name="Book Mika's flu shot", more=True),
         act("create", args=lines(kind="task", name="Send the form to Caron", date=U("week", 1, weekday=5)), more=True),
         act("log", rows="$caron", args=lines(kind="message"))]))

S("T25-C901", "c3c cell7 empty recovery nickname search",
  T("who's gaby", rows("gab"),
    ref=[find(kind="person", name="Gaby"), search("gaby", kind="person"), ans(rows="$gab")]),
  T('the note from the 10th at 7.30am', rows("grocery_tg"),
    ref=[ans(kind="note", when=W(D("2026-10-10", "07:30")))]))
