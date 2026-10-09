from gold import *
import json

world("T25", "2026-10-11T18:45", "Yuki Tanaka", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T25-K001", "decline not_found document find miss i3skill S5",
  T("where's the kayak waiver", decline("not_found"),
    ref=[find(kind="document", name="kayak waiver"), dec("not_found")]))

S("T25-K002", "decline not_found note after a read other kind hint i3skill S5",
  T("when's the parent-teacher meeting", rows("ptm"),
    ref=[ans(kind="event", name="Parent-teacher meeting")]),
  T("is there a note from the teacher about it", decline("not_found"),
    ref=[find(kind="note", name="teacher"), search("teacher", kind="note"), dec("not_found")]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T25-K101", "family word mom grandma role i3skill S6",
  T("when did i last call mom", rows("hiroko"),
    ref=[ans(kind="person", where='role contains "mom"')]),
  T("and mika's grandma", rows("sylvie"),
    ref=[ans(kind="person", where='role contains "grandma"')]))

S("T25-K102", "list word is a note name not the list kind i3skill S6",
  T("what's on the thanksgiving grocery list", rows("grocery_tg"),
    ref=[ans(kind="note", name="Thanksgiving grocery list")]),
  T("pin it", diff(upd("grocery_tg", pinned=True)),
    ref=[act("edit", rows="$grocery_tg", args=lines(pinned="yes"))]))

S("T25-K103", "list word note then which notebook i3skill S6",
  T("what's on the tremblant packing list", rows("tremblant_pack"),
    ref=[ans(kind="note", name="Tremblant packing list")]),
  T("which notebook is that in", rows("hike_nb"),
    ref=[ans(kind="notebook", linked_to="$tremblant_pack")]))

S("T25-K104", "iou debt either direction i3skill S6",
  T("any iou with nadia", rows("d_nadia"),
    ref=[ans(kind="debt", linked_to="$nadia")]),
  T("and tom", rows("d_tom"),
    ref=[ans(kind="debt", linked_to="$tom")]))

S("T25-K105", "family word brother log call i3skill S6",
  T("log a call with my brother", diff(upd("kenji", date=ANY)),
    ref=[find(kind="person", where='role contains "brother"'), act("log", rows="@prev", args=lines(kind="call"))]))

# --- S7 look then pick --------------------------------------------------------------------------

S("T25-K201", "ask then mine dentist cancel i3skill S7",
  T("cancel the dentist", ask("dentist_mika", "dentist_me"),
    ref=[act("cancel", kind="event", name="Dentist")]),
  T("mine", diff(upd("dentist_me", status="cancelled")),
    ref=[act("cancel", rows="$dentist_me")]))

S("T25-K202", "ask then not the book club one star i3skill S7",
  T("star sarah", ask("sarah_n", "sarah_c"),
    ref=[act("star", kind="person", name="Sarah")]),
  T("not the book club one", diff(upd("sarah_n", starred=True)),
    ref=[act("star", rows="$sarah_n")]))

S("T25-K203", "ask then the landlord one log i3skill S7",
  T("log a call with marc", ask("marc_g", "marc_t"),
    ref=[act("log", kind="person", name="Marc", args=lines(kind="call"))]),
  T("the landlord", diff(upd("marc_t", date=ANY)),
    ref=[act("log", rows="$marc_t", args=lines(kind="call"))]))

S("T25-K204", "pick by description debt settle i3skill S7",
  T("what does daniel owe me right now", rows("d_daniel_camp", "d_daniel_boots"),
    ref=[ans(kind="debt", linked_to="$daniel", where="status = open")]),
  T("settle the camp one, he paid", diff(upd("d_daniel_camp", status="settled")),
    ref=[act("settle_debt", rows="$d_daniel_camp")]))

S("T25-K205", "other two subtasks reschedule i3skill S7",
  T("what's under the update parenting plan task", rows("holiday_sched", "review_lawyer", "sign_plan"),
    ref=[ans(kind="task", linked_to="$plan")]),
  T("drafted the holiday schedule", diff(upd("holiday_sched", status="completed", completed=ANY)),
    ref=[act("complete", rows="$holiday_sched")]),
  T("push the other two to the 27th", diff(upd("review_lawyer", date="2026-10-27"), upd("sign_plan", date="2026-10-27")),
    ref=[find(within="@1", exclude="$holiday_sched"), act("reschedule", rows="@prev", args=lines(to=D("2026-10-27")))]))
