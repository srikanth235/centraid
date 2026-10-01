from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T08-026", "group person count",
  T("which groups have more than four people in them", rows("reunion_g", "boosters", "union_fund"),
    ref=[ans(kind="group", where="person count > 4")]))

S("T08-027", "events next week duration reschedule named edit prev",
  T("what's next week look like", rows("boost_0413", "ptc", "prac_0414", "oil_change", "science_fair", "prac_0416",
                                      "handoff_0417", "epa", "walkthrough"),
    ref=[ans(kind="event", when=W(U("week", 1)))]),
  T("anything short, like an hour or less", rows("boost_0413", "ptc", "oil_change", "handoff_0417"),
    ref=[ans(kind="event", within="@prev", where="duration <= 60 minutes")]),
  T("move the truck oil change to 7:30", diff(upd("oil_change", date="2026-04-15T07:30")),
    ref=[act("reschedule", kind="event", name="Truck oil change", args=lines(to=U("day", 0, anchor="row", time="07:30")))]),
  T("when's jada's science fair", rows("science_fair"),
    ref=[ans(kind="event", name="science fair")]),
  T("add to it: bring the volcano on a dolly", diff(upd("science_fair", description="bring the volcano on a dolly")),
    ref=[act("edit", rows="@prev", args=lines(description="bring the volcano on a dolly"))]))

S("T08-028", "remove_from person prev debt count",
  T("who's omar again", rows("omar"),
    ref=[ans(kind="person", name="Omar")]),
  T("take him out of the carpool", diff(unlink("carpool", "omar")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$carpool"))]),
  T("who in the practice carpool do i not have any debts with", rows("tasha", "brandon", "me"),
    ref=[ans(kind="person", linked_to="$carpool", where="debt count <= 0")]))

S("T08-029", "task create edit new add_to remove_from named",
  T("add a task to buy a new shop vac, thirty min", diff(new("task", name=has("shop vac"), effort=30)),
    ref=[act("create", args=lines(kind="task", name="Buy a new shop vac", effort=30))]),
  T("make it priority two and put in the notes: wet/dry, 12 gallon",
    diff(upd("+1", priority=2, description="wet/dry, 12 gallon")),
    ref=[act("edit", rows="$c1", args=lines(priority=2, description="wet/dry, 12 gallon"))]),
  T("put the truck tire rotation on the house list", diff(link("house_l", "tires")),
    ref=[act("add_to", kind="task", name="tires rotated", args=lines(to="$house_l"))]),
  T("and take clean gutters off it, landlord's handling that", diff(unlink("house_l", "gutters")),
    ref=[act("remove_from", kind="task", name="Clean gutters", args=lines(from_="$house_l"))]))

S("T08-030", "task priority subtasks",
  T("what's lower than priority two on my plate", rows("dues", "nate", "cleats", "registration", "garage", "manifold", "proposal"),
    ref=[ans(kind="task", where="priority > 2")]),
  T("which of those have no subtasks", rows("dues", "cleats", "registration", "garage", "manifold", "proposal"),
    ref=[ans(kind="task", within="@prev", where="task count = 0")]))

S("T08-031", "task list count effort",
  T("how many tasks are on a list", val(36),
    ref=[ans(op="count", kind="task", where="list count > 0")]),
  T("on the work list which ones aren't thirty min jobs", rows("nate", "ts_apr", "osha"),
    ref=[ans(kind="task", linked_to="$work_l", where="effort != 30 minutes")]))

S("T08-032", "notes since date notebook count",
  T("notes i made since the twenty-ninth at noon", rows("shirt_notes", "franklin", "gift_ideas", "prayer"),
    ref=[ans(kind="note", when=W(span(D("2026-03-29", "12:00"), U("day", 0))))]),
  T("and which of these sit in a notebook", rows("shirt_notes", "franklin"),
    ref=[ans(kind="note", within="@prev", where="notebook count != 0")]))

S("T08-033", "notes span pin",
  T("what notes did i write between march fifteenth 8pm and last sunday",
    rows("custody", "heat_pump", "jada_sizes", "fishing_list", "carwash_plan", "shirt_notes", "prayer", "gift_ideas", "franklin"),
    ref=[ans(kind="note", when=W(span(D("2026-03-15", "20:00"), U("week", -1, weekday=7))))]),
  T("pin the prayer list", diff(upd("prayer", pinned=True)),
    ref=[act("edit", kind="note", name="Prayer list", args=lines(pinned="yes"))]))

S("T08-034", "documents date star",
  T("what docs did i add on march twentieth", rows("rc_jalen", "rc_jada"),
    ref=[ans(kind="document", when=W(D("2026-03-20")))]),
  T("star jada's", diff(upd("rc_jada", starred=True)),
    ref=[act("star", kind="document", name="Jada report card")]),
  T("what did i save last monday at 5:45", rows("lease26"),
    ref=[ans(kind="document", when=W(U("week", -1, weekday=1, time="17:45")))]),
  T("anything else that day", rows(),
    ref=[ans(kind="document", when=W(D("2026-03-30")), exclude="$lease26")]))

S("T08-035", "documents since weekday folder count",
  T("documents added from last monday onwards", rows("lease26", "invoice", "trip_form"),
    ref=[ans(kind="document", when=W(span(U("week", -1, weekday=1), U("day", 0))))]),
  T("which of them are filed in a folder", rows("lease26", "trip_form"),
    ref=[ans(kind="document", within="@prev", where="folder count > 0")]))

S("T08-036", "documents span linked_to prev",
  T("anything saved between last wednesday and april fifth", rows("invoice", "trip_form"),
    ref=[ans(kind="document", when=W(span(U("week", -1, weekday=3), D("2026-04-05"))))]),
  T("do i have a reunion folder", rows("reunion_f"),
    ref=[ans(kind="folder", name="Reunion")]),
  T("what's in it", rows("pavilion_contract", "hotel_quote"),
    ref=[ans(kind="document", linked_to="@prev")]))

S("T08-037", "photo person count",
  T("pics in easter 2026 with one person in them", rows("p_ham"),
    ref=[ans(kind="photo", linked_to="$easter_album", where="person count = 1")]))

S("T08-038", "photo span unstar where",
  T("what pics did i take easter sunday up to 4pm", rows("p_church", "p_egg", "p_ham"),
    ref=[ans(kind="photo", when=W(span(D("2026-04-05"), D("2026-04-05", "16:00"))))]),
  T("unstar the starred one out of those", diff(upd("p_church", starred=False)),
    ref=[act("unstar", kind="photo", within="@prev", where="starred = yes")]),
  T("what's starred in the easter album", rows("p_bigmama"),
    ref=[ans(kind="photo", linked_to="$easter_album", where="starred = yes")]))

S("T08-039", "photo span unstar linked",
  T("photos from new years thru march", rows("p_band", "p_rooftop", "p_coil", "p_minisplit", "p_practice", "p_fair",
                                            "p_gutter", "p_van", "p_union", "p_selfie"),
    ref=[ans(kind="photo", when=W(span(D("2026-01-01"), U("month", 0, name=3))))]),
  T("unstar whatever's starred in the fishing album", diff(upd("p_bass", starred=False)),
    ref=[act("unstar", kind="photo", linked_to="$fishing_album", where="starred = yes")]))

S("T08-040", "photo count month spans",
  T("how many pics did i take feb through march", val(10),
    ref=[ans(op="count", kind="photo", when=W(span(U("month", 0, name=2), U("month", 0, name=3))))]),
  T("and everything before this week?", val(31),
    ref=[ans(op="count", kind="photo", when=W({"to": U("week", -1)}))]))

S("T08-041", "debts since direction amount",
  T("debts since march twenty-first at noon", rows("d_luis", "d_marcus_b", "d_tanya", "d_quanisha", "d_tanya2"),
    ref=[ans(kind="debt", when=W({"from": D("2026-03-21", "12:00")}))]),
  T("which of those aren't people owing me", rows("d_marcus_b", "d_tanya"),
    ref=[ans(kind="debt", within="@prev", where='direction != "owes_me"')]),
  T("any under 50 bucks", rows("d_marcus_b"),
    ref=[ans(kind="debt", within="@prev", where="amount <= 50")]))

S("T08-042", "debts month span sum",
  T("what debts came up from last month thru april", rows("d_trey", "d_kevin", "d_dre", "d_monique", "d_luis", "d_marcus_b",
                                                         "d_quanisha", "d_coach", "d_tanya", "d_tanya2"),
    ref=[ans(kind="debt", when=W(span(U("month", -1), U("month", 0, name=4))))]),
  T("sum the amounts i owe in that batch", val((135, "USD")),
    ref=[ans(op="sum", field="amount", kind="debt", within="@prev", where='direction = "i_owe" and status = "open"')]))

S("T08-043", "people last contacted spans",
  T("who'd i talk to between march first and march thirty-first", rows("bigmama", "reggie", "dre", "keisha", "marcus_h", "quanisha",
                                                         "darnell", "kevin", "trey"),
    ref=[ans(kind="person", when=W(span(D("2026-03-01"), D("2026-03-31"))))]),
  T("and from april first at noon till today", rows("mama", "tanya", "monique", "marcus_b", "coach_t", "luis", "pastor", "tasha"),
    ref=[ans(kind="person", when=W(span(D("2026-04-01", "12:00"), U("day", 0))))]))

S("T08-044", "people month span event count",
  T("who did i last hear from back in jan or feb", rows("bev", "vic"),
    ref=[ans(kind="person", when=W(span(U("month", 0, name=1), U("month", 0, name=2))))]),
  T("which of them have no events with me", rows("vic"),
    ref=[ans(kind="person", within="@prev", where="event count = 0")]))

S("T08-045", "person note count",
  T("which people have exactly one note about them", rows("bev", "dre", "darnell", "mike", "mama", "monique", "jalen",
                                                          "trey", "marcus_h"),
    ref=[ans(kind="person", where="note count = 1")]))

S("T08-046", "events span person count",
  T("anything between now and the fourteenth with other people coming", rows("prac_0407", "union_0408", "dentist_jalen",
                                                                       "prac_0409", "rcall_0412", "boost_0413", "ptc",
                                                                       "prac_0414"),
    ref=[ans(kind="event", when=W(span(U("day", 0), D("2026-04-14"))), where="person count != 0")]))

S("T08-047", "practice count span last",
  T("how many spring football practice days left from next week through may", val(10),
    ref=[ans(op="count", kind="event", name="Spring football practice", when=W(span(U("week", 1), U("month", 0, name=5))))]),
  T("when's the last one", rows("prac_0514"),
    ref=[ans(kind="event", name="Spring football practice", order="date desc", limit=1)]))

S("T08-048", "folder then linked_to prev",
  T("find my work certs folder", rows("certs_f"),
    ref=[ans(kind="folder", name="Work certs")]),
  T("what's in it", rows("epa_cert", "union_contract"),
    ref=[ans(kind="document", linked_to="@prev")]))

S("T08-049", "folder document count",
  T("which folders actually have stuff in them", rows("taxes_f", "truck_f", "school_f", "reunion_f", "certs_f", "house_f"),
    ref=[ans(kind="folder", where="document count != 0")]))

S("T08-050", "locker url",
  T("which of my logins aren't https://dispatch.peachtreecomfort.com", rows("portal", "bank_login"),
    ref=[ans(kind="locker item", where='type = "login" and url != "https://dispatch.peachtreecomfort.com"')]),
  T("what's the username on the school one", rows("portal"),
    ref=[ans(rows="$portal")]))
