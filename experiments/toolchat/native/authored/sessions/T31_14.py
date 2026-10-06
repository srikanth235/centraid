from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# --- ask for the missing piece, then do it ---------------------------------------------------------

S("T31-188", "ask-missing-notebook-name create notebook",
  T("start a new notebook", ask(),
    ref=[askc("What should the notebook be called?")]),
  T("travel plans", diff(new("notebook", name=has("Travel plans"))),
    ref=[act("create", kind="notebook", args=lines(name="Travel plans"))]))

S("T31-189", "ask-missing-folder-name create folder",
  T("make a new folder", ask(),
    ref=[askc("What should the folder be called?")]),
  T("receipts", diff(new("folder", name=has("Receipts"))),
    ref=[act("create", kind="folder", args=lines(name="Receipts"))]))

S("T31-190", "ask-appointment-details create dentist december",
  T("book an appointment", ask(),
    ref=[askc("What kind of appointment, and when?")]),
  T("dentist on the 3rd of december at 4", diff(new("event", name=has("Dentist"), date="2026-12-03T16:00")),
    ref=[act("create", kind="event", args=lines(name="Dentist", date=D("2026-12-03", "16:00")))]))

S("T31-191", "ask-how-many-of-what count admin open",
  T("how many are there", ask(),
    ref=[askc("How many of what?")]),
  T("open tasks on the admin list", val(9),
    ref=[ans(op="count", kind="task", linked_to="$admin_l", where="status = open")]))

S("T31-192", "ask-when-is-it cpr course read",
  T("when is it", ask(),
    ref=[askc("When is what?")]),
  T("the cpr course", rows("cpr_course"),
    ref=[ans(kind="event", name="cpr course")]))

S("T31-193", "ask-add-contact create person gp",
  T("add a contact", ask(),
    ref=[askc("Who is it, and what should I save about them?")]),
  T("dr nowak, my new gp", diff(new("person", name=has("Nowak"), role=has("gp"))),
    ref=[act("create", kind="person", args=lines(name="Dr Nowak", role="gp"))]))

# --- declines, then a read --------------------------------------------------------------------------

S("T31-194", "decline-out-of-scope call dentist then next",
  T("call the dentist and ask for an earlier slot", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("when is the dentist booked for then", rows("dentist_ev"),
    ref=[ans(kind="event", name="dentist", order="date asc", limit=1, when=J({"from": U("day", 0)}))]))

S("T31-195", "decline-out-of-scope order flowers then task",
  T("order flowers for mama's birthday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("is there a task about the flowers already", rows("tata_birthday"),
    ref=[ans(kind="task", name="flowers")]))

S("T31-196", "decline-out-of-scope translate note then read",
  T("translate the boiler instructions into english", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("just show me the note then", rows("n_boiler"),
    ref=[ans(kind="note", name="boiler instructions")]))
