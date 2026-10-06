from gold import *
import json

world("T13", "2026-09-03T22:10", "Amara Nwosu", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T13-C001", "c3c compound create document add_to new",
  T("save a doc called Poster final pdf and put it in conference",
    diff(new("document", name="Poster final pdf"), link("conf_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Poster final pdf"), more=True),
         act("add_to", rows="$new", args=lines(to="$conf_f"))]))

S("T13-C002", "c3c compound cancel reschedule at N bare weekday",
  T("cancel the gym induction and move the dentist to friday at 9",
    diff(upd("gym", status="cancelled"), upd("dentist", date="2026-09-04T09:00")),
    ref=[act("cancel", kind="event", name="Gym induction", more=True),
         act("reschedule", kind="event", name="Dentist appointment", args=lines(to=U("week", 0, weekday=5, time="09:00")))]))

S("T13-C003", "c3c compound complete edit",
  T("loo roll is bought, tick it off, and rename the broadband task to Switch broadband provider",
    diff(upd("loo_roll", status="completed", completed=ANY), upd("broadband", name="Switch broadband provider")),
    ref=[act("complete", kind="task", name="Buy toilet roll for the house", more=True),
         act("edit", kind="task", name="Sort out the broadband switch", args=lines(name="Switch broadband provider"))]))

S("T13-C004", "c3c compound settle_debt create task",
  T("tom h paid his takeaway money so settle that, and remind me friday to ask kasia about the router money",
    diff(upd("d_tom_h", status="settled"), new("task", name=has("kasia", "router"), date="2026-09-04")),
    ref=[act("settle_debt", kind="debt", name="Takeaway", more=True),
         act("create", args=lines(kind="task", name="Ask Kasia about the router money", date=U("week", 0, weekday=5)))]))

S("T13-C101", "c3c bulk delete per kind before year find multi-kind",
  T('clear out everything before 2025', diff(trash("cas"), trash("visa_letter"), trash("studentship"), trash("p_graduation")),
    ref=[find(kind="event,task,note,document,photo", when=W({"to": D("2024-12-31")})),
         act("delete", rows="$cas, $visa_letter, $studentship", more=True),
         act("delete", rows="$p_graduation")]))

S("T13-C901", "c3c cell7 empty recovery trashed read then span",
  T('is the pub quiz still in the calendar', rows("pub_quiz"),
    ref=[find(kind="event", name="pub quiz"), ans(kind="event", name="pub quiz", trashed=True)]),
  T("what's due from today until the 10th at 6pm", rows("loo_roll", "send_mum", "rota", "xrd_book", "bins", "hall", "xrd_book_lukas", "jc_slides", "abstract", "garri", "xrd_analyse", "logo", "precursors", "reply_aunty"),
    ref=[ans(kind="task", when=W(span(U("day", 0), D("2026-09-10", "18:00"))))]))

S("T13-C902", "c3c cell7 rejected add_to missing to",
  T('put the boarding pass in conference', diff(link("conf_f", "boarding")),
    ref=[bad(act("add_to", kind="document", name="Boarding pass")), act("add_to", kind="document", name="Boarding pass", args=lines(to="$conf_f"))]))
