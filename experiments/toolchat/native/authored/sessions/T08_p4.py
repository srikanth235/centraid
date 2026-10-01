from gold import *
import json

world("T08", "2026-04-06T17:50", "Deshawn Carter", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# 201 "both" after a two-row result
S("T08-201", "both dentist events reschedule hour later edit description",
  T("kids' dentist appointments?", rows("dentist_jalen", "dentist_jada"),
    ref=[ans(kind="event", name="Dentist appointment", when=W({"from": U("day", 0)}))]),
  T("push both an hour later, office is running behind", diff(upd("dentist_jalen", date="2026-04-09T16:30"), upd("dentist_jada", date="2026-04-23T16:30")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("hour", 1, anchor="row")))]),
  T("note on both, bring the dental card", diff(upd("dentist_jalen", description="Bring the dental card"), upd("dentist_jada", description="Bring the dental card")),
    ref=[act("edit", rows="$dentist_jalen, $dentist_jada", args=lines(description="Bring the dental card"))]))

# 202 ordinals after a listing, and a number picked from an ask
S("T08-202", "ordinal second reunion list complete ask pick star easter photos",
  T("reunion list?", rows("pavilion", "invites", "hotel", "menu", "shirts", "slideshow", "dues"),
    ref=[ans(kind="task", linked_to="$reunion_l")]),
  T("the second one is done", diff(upd("invites", status="completed", completed=ANY)),
    ref=[act("complete", rows="$invites")]),
  T("star the easter photo", ask("p_egg", "p_church", "p_table"),
    ref=[act("star", kind="photo", name="Easter"),
         askc("1 the egg hunt, 2 the sunday outfits or 3 the dinner table?", options="$p_egg, $p_church, $p_table")]),
  T("3 is fine", diff(upd("p_table", starred=True)),
    ref=[act("star", rows="$p_table")]))

# 203 which way the money goes
S("T08-203", "debts owe direction negative balance sum settle both signs tanya",
  T("what do i owe mama", val((-300, "USD")),
    ref=[search("mama", kind="person"), ans(op="balance", kind="person", rows="$mama")]),
  T("total they owe me", val((465.5, "USD")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("settle mine with tanya, sent her the easter money", diff(upd("d_tanya", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$tanya", where='direction = "i_owe"')]),
  T("and her side, she covered the decorations", diff(upd("d_tanya2", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$tanya", where='direction = "owes_me"')]))

# 204 everything but one
S("T08-204", "except exclude photos star reunion 2024 besides",
  T("photos from the 2024 reunion", rows("p_r24_shirts", "p_r24_grill", "p_r24_group", "p_r24_spades", "p_r24_kids"),
    ref=[ans(kind="photo", when=W(span(D("2024-07-19"), D("2024-07-21"))))]),
  T("star all of them except the shirts one", diff(upd("p_r24_grill", starred=True), upd("p_r24_group", starred=True), upd("p_r24_spades", starred=True), upd("p_r24_kids", starred=True)),
    ref=[find(kind="photo", within="@prev", exclude="$p_r24_shirts"), act("star", rows="@prev")]),
  T("which are starred now", rows("p_r24_grill", "p_r24_group", "p_r24_spades", "p_r24_kids"),
    ref=[ans(kind="photo", when=W(span(D("2024-07-19"), D("2024-07-21"))), where="starred = yes")]))

# 205 bare weekdays, "at N", a relative range
S("T08-205", "bare weekday at N haircut oil change range create friday night",
  T("haircut wednesday at 5 instead", diff(upd("haircut", date="2026-04-08T17:00")),
    ref=[act("reschedule", kind="event", name="Haircut", args=lines(to=U("week", 0, weekday=3, time="17:00")))]),
  T("and the oil change to thursday at 2", diff(upd("oil_change", date="2026-04-09T14:00")),
    ref=[act("reschedule", kind="event", name="Truck oil change", args=lines(to=U("week", 0, weekday=4, time="14:00")))]),
  T("between monday and wednesday of next week, what's the schedule", rows("boost_0413", "prac_0414", "ptc", "science_fair"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]),
  T("set up a call with dre saturday night at 8", diff(new("event", name=has("dre"), date="2026-04-11T20:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Dre", date=U("week", 0, weekday=6, time="20:00")))]))

# 206 two writes in one message
S("T08-206", "two writes settle debt complete star document",
  T("paid marcus the gas money and cleaned the gutters", diff(upd("d_marcus_b", status="settled"), upd("gutters", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="gas money", more=True),
         act("complete", kind="task", name="Clean gutters")]),
  T("gave kevin the ladder money and star the dental card", diff(upd("d_kevin", status="settled"), upd("dental_card", starred=True)),
    ref=[act("settle_debt", kind="debt", name="ladder", more=True),
         act("star", kind="document", name="Dental insurance card")]),
  T("what's my overall debt right now", val((375, "USD")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))
