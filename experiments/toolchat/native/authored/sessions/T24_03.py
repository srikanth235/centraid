from gold import *


S("T24-051", "four turns ambiguous david ask log debt count balance",
  T("log a call with david", ask("david_r", "david_s"),
    ref=[act("log", kind="person", name="David", args=lines(kind="call")),
         askc("david ruiz from the boosters or david salazar from the union?", options="$david_r, $david_s")]),
  T("the union one", diff(upd("david_s", date=ANY)),
    ref=[act("log", rows="$david_s", args=lines(kind="call"))]),
  T("which team parents have a debt going with me", rows("patty", "gilbert", "yvonne", "veronica"),
    ref=[ans(kind="person", where='debt count > 0 and role = "team parent"')]),
  T("and where am i with david salazar", val((-43.75, "USD")),
    ref=[comp(op="balance", rows="$david_s"), ans(value="@prev")]))

S("T24-052", "ambiguous dentist cancel ask options pick",
  T("cancel the dentist", ask("dentist_mateo", "dentist_lucia"),
    ref=[act("cancel", kind="event", name="Dentist"),
         askc("mateo's on the 22nd or lucia's on oct 6?", options="$dentist_mateo, $dentist_lucia")]),
  T("mateo's, he has a scrimmage", diff(upd("dentist_mateo", status="cancelled")),
    ref=[act("cancel", rows="$dentist_mateo")]),
  T("what's on with Sandra Villalobos", rows("dentist_lucia"),
    ref=[ans(kind="event", linked_to="$sandra", where='status != "cancelled"')]))

S("T24-053", "ambiguous volleyball resolved by earlier turn reschedule count",
  T("when's sofia's next away game", rows("vb_0924"),
    ref=[find(kind="event", name="Sofia volleyball game", where='description contains "away"'), ans(rows="@prev")]),
  T("move the volleyball game to 6:30", diff(upd("vb_0924", date="2026-09-24T18:30")),
    ref=[act("reschedule", kind="event", name="Sofia volleyball game", args=lines(to=D("2026-09-24", "18:30"))),
         act("reschedule", rows="$vb_0924", args=lines(to=D("2026-09-24", "18:30")))]),
  T("how many games has she got this month", val(2),
    ref=[ans(op="count", kind="event", name="Sofia volleyball game", when=U("month", 0))]))

S("T24-054", "ambiguous garza star ask",
  T("star garza", ask("rudy", "marisol"),
    ref=[act("star", kind="person", name="Garza"),
         askc("rudy or marisol?", options="$rudy, $marisol")]),
  T("marisol, she's doing lucia's party with me", diff(upd("marisol", starred=True)),
    ref=[act("star", rows="$marisol")]))

S("T24-055", "four turns ambiguous complete narrow effort literal complete named",
  T("mark Mow Mrs. Whitfield's lawn done", diff(upd("mow_2", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Mow Mrs. Whitfield's lawn")]),
  T("what's left on the landscaping list", rows("mulch", "invoice_soto", "trimmer", "castillo_quote"),
    ref=[ans(kind="task", linked_to="$land_l", where='status = "open"')]),
  T("which of those are twenty min or less", rows("invoice_soto", "trimmer"),
    ref=[ans(kind="task", within="@prev", where="effort <= 20")]),
  T("Send invoice to Soto, did it", diff(upd("invoice_soto", status="completed", completed=ANY)),
    ref=[act("complete", rows="$invoice_soto")]))

S("T24-056", "single ask without options",
  T("add something to my diary for next week", ask(),
    ref=[askc("sure, what is it and which day?")]))

S("T24-057", "empty result debt find miss recover settle_debt",
  T("the uber debt with ray, how much was it", val((40, "USD")),
    ref=[find(kind="debt", name="Uber"), search("uber", kind="debt"), find(kind="debt", linked_to="$ray"),
         ans(op="max", field="amount", within="@prev")]),
  T("settle it, he paid me back at practice", diff(upd("d_ray", status="settled")),
    ref=[act("settle_debt", rows="$d_ray")]))

S("T24-058", "empty result debt amount != unit compute max group",
  T("the babysitting money with lupe, how much", rows("d_lupe"),
    ref=[find(kind="debt", name="babysitting"), search("babysitting", kind="debt"), find(kind="debt", linked_to="$lupe"),
         ans(rows="@prev")]),
  T("oh right. which open debts aren't 40 bucks",
    rows("d_rudy", "d_hector", "d_patty", "d_david_s", "d_beto", "d_marisol", "d_kim", "d_lupe", "d_veronica"),
    ref=[ans(kind="debt", where='amount != 40 USD and status = "open"')]),
  T("biggest open one each way", vgroups({"owes_me": (320, "USD"), "i_owe": (150, "USD")}),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]))

S("T24-059", "debt status is empty date spans",
  T("any debts with no status on them", rows(),
    ref=[ans(kind="debt", where="status is empty")]),
  T("debts from sept first to the twelfth", rows("d_ray", "d_rudy", "d_hector", "d_patty", "d_kim"),
    ref=[ans(kind="debt", when=span(D("2026-09-01"), D("2026-09-12")))]),
  T("and aug fifteenth to the end of august", rows("d_gilbert", "d_beto"),
    ref=[ans(kind="debt", when=span(D("2026-08-15"), U("month", 0, name=8)))]))

S("T24-060", "debt month to weekday span status is empty",
  T("from the start of september up to last friday, what debts came up", rows("d_ray", "d_hector", "d_patty", "d_kim"),
    ref=[ans(kind="debt", when=span(U("month", 0, name=9), U("week", -1, weekday=5)))]),
  T("any of them missing a status", rows(),
    ref=[ans(kind="debt", within="@prev", where="status is empty")]))

S("T24-061", "debt open span amount != compute min group",
  T("debts from before this month", rows("d_gilbert", "d_beto", "d_yvonne", "d_jessica", "d_lupe"),
    ref=[ans(kind="debt", when={"to": U("month", -1)})]),
  T("which of those weren't 40 dollars", rows("d_beto", "d_yvonne", "d_jessica", "d_lupe"),
    ref=[ans(kind="debt", within="@prev", where="amount != 40 USD")]),
  T("smallest each way", vgroups({"owes_me": (30, "USD"), "i_owe": (45, "USD")}),
    ref=[comp(op="min", field="amount", within="@prev", group="direction"), ans(value="@prev")]))

S("T24-062", "debt open span date span",
  T("debts up to last week",
    rows("d_gilbert", "d_beto", "d_yvonne", "d_jessica", "d_lupe", "d_ray", "d_rudy", "d_hector", "d_patty", "d_kim"),
    ref=[ans(kind="debt", when={"to": U("week", -1)})]),
  T("how many between the first and the tenth", val(3),
    ref=[ans(op="count", kind="debt", when=span(D("2026-09-01"), D("2026-09-10")))]))

S("T24-063", "debt date month span weekday span compute balance",
  T("debts between july first and end of august", rows("d_yvonne", "d_gilbert", "d_beto"),
    ref=[ans(kind="debt", when=span(D("2026-07-01"), U("month", 0, name=8)))]),
  T("and from september till last wednesday", rows("d_patty", "d_hector", "d_kim"),
    ref=[ans(kind="debt", when=span(U("month", 0, name=9), U("week", -1, weekday=3)))]),
  T("what's my balance with Patricia Nuñez", val((120, "USD")),
    ref=[comp(op="balance", rows="$patty"), ans(value="@prev")]))

S("T24-064", "four turns cadence note count person month span log nickname",
  T("who am i supposed to check on every two weeks or less often",
    rows("rudy", "marisol", "beto", "linda", "frank", "jessica", "david_r", "gilbert", "david_s", "kim", "lupe"),
    ref=[ans(kind="person", where="cadence >= 14")]),
  T("of those people, who has zero notes on them", rows("beto", "linda", "frank", "jessica", "gilbert", "lupe"),
    ref=[ans(kind="person", within="@prev", where="note count <= 0")]),
  T("who'd i last talk to sometime from july through august", rows("micheal", "marisol", "beto", "tom"),
    ref=[ans(kind="person", when=span(U("month", -2), U("month", 0, name=8)))]),
  T("log a call with tío beto, talked this morning", diff(upd("beto", date=ANY)),
    ref=[act("log", rows="$beto", args=lines(kind="call"))]))

S("T24-065", "cadence literal person month span",
  T("anyone on a monthly check-in or longer", rows("marisol", "beto", "frank", "kim", "lupe"),
    ref=[bad(ans(kind="person", where="cadence >= 4 weeks")), ans(kind="person", where="cadence >= 30")]),
  T("who've i been in touch with from two months back to the end of july", rows("micheal"),
    ref=[ans(kind="person", when=span(U("month", -2), U("month", 0, name=7)))]))

S("T24-066", "debt count note count balance",
  T("anyone on the landscaping side i've got a debt with", rows("hector"),
    ref=[ans(kind="person", where='debt count > 0 and role contains "landscaping"')]),
  T("which landscaping people have one note or less", rows("hector", "barbara", "javier"),
    ref=[ans(kind="person", where='role contains "landscaping" and note count <= 1')]),
  T("where do i stand with hector", val((-30, "USD")),
    ref=[ans(op="balance", rows="$hector")]))

S("T24-068", "four turns event person count status open span duration count",
  T("next week, which events have fewer than two people on them",
    rows("cond_0921", "film_session", "gym_0922", "cond_0923", "gym_0924", "vb_0924", "fb_0925", "ref_clinic"),
    ref=[ans(kind="event", when=U("week", 1), where="person count < 2")]),
  T("anything cancelled before this week", rows("gym_0910", "elena_dinner", "game_night"),
    ref=[ans(kind="event", when={"to": U("week", -1)}, where='status = "cancelled"')]),
  T("up to yesterday, what ran longer than 180 min",
    rows("staff_dev", "coach_clinic", "yard_0829", "yard_0905", "yard_0912"),
    ref=[ans(kind="event", when={"to": U("day", -1)}, where="duration > 180 min")]),
  T("and how many of them were rudy's landscaping jobs", val(3),
    ref=[ans(op="count", kind="event", within="@prev", name="Landscaping job")]))

S("T24-069", "event month span count name cancel",
  T("how many things in the diary for sept and oct", val(58),
    ref=[ans(op="count", kind="event", when=span(U("month", 0, name=9), U("month", 0, name=10)))]),
  T("the booster club meetings in there", rows("booster_0915", "booster_1013"),
    ref=[ans(kind="event", name="Booster club meeting", when=span(U("month", 0, name=9), U("month", 0, name=10)))]),
  T("cancel the october one, we're doing it on zoom", diff(upd("booster_1013", status="cancelled")),
    ref=[act("cancel", rows="$booster_1013")]))

S("T24-070", "event date span ambiguous ask options cancel",
  T("what's on between the twenty-sixth and the thirtieth",
    rows("yard_0926", "ref_clinic", "lucia_bday", "cond_0928", "gym_0929", "bargaining", "cond_0930"),
    ref=[ans(kind="event", when=span(D("2026-09-26"), D("2026-09-30")))]),
  T("get me off football game duty", ask("fb_0911", "fb_0925"),
    ref=[act("cancel", kind="event", name="Football game duty"),
         find(kind="event", name="Football game duty"),
         askc("there's the 11th and the 25th, which one?", options="$fb_0911, $fb_0925")]),
  T("next friday's", diff(upd("fb_0925", status="cancelled")),
    ref=[act("cancel", rows="$fb_0925")]))

S("T24-071", "four turns photo datetime people photo open span weekday span count",
  T("the pic from 5:25pm yesterday", rows("p_team_huddle"),
    ref=[ans(kind="photo", when=U("day", -1, time="17:25"))]),
  T("who's in it", rows("ray", "marcus", "andre"),
    ref=[ans(kind="person", linked_to="$p_team_huddle")]),
  T("photos since monday", rows("p_sunset", "p_marcus", "p_union", "p_whiteboard", "p_jersey", "p_andre",
                                "p_team_huddle"),
    ref=[ans(kind="photo", when={"from": U("week", 0)})]),
  T("how many from last saturday through this week", val(13),
    ref=[ans(op="count", kind="photo", when=span(U("week", -1, weekday=6), U("week", 0)))]))

S("T24-072", "photo datetime add_to named",
  T("which photo did i take at 7:10am on the twelfth", rows("p_whit_before"),
    ref=[ans(kind="photo", when=D("2026-09-12", "07:10"))]),
  T("add it to rudy's yards", diff(link("yards_al", "p_whit_before")),
    ref=[act("add_to", rows="$p_whit_before", args=lines(to="$yards_al"))]))

S("T24-074", "document datetime span open span star named",
  T("docs saved from 6pm on the fourteenth until today", rows("tourney", "slip_doc", "jersey_quote"),
    ref=[ans(kind="document", when=span(D("2026-09-14", "18:00"), U("day", 0)))]),
  T("and anything from before september", rows("roster_doc", "syllabus_doc", "bylaws", "home_ins", "inv_soto"),
    ref=[ans(kind="document", when={"to": U("month", 0, name=8)})]),
  T("star Union bylaws", diff(upd("bylaws", starred=True)),
    ref=[act("star", rows="$bylaws")]))

S("T24-075", "document datetime rel span open month span folder",
  T("anything in team from 7am sep first through last week", rows("physicals_doc"),
    ref=[ans(kind="document", linked_to="$team_f", when=span(D("2026-09-01", "07:00"), U("week", -1)))]),
  T("union folder stuff from before september", rows("bylaws"),
    ref=[ans(kind="document", linked_to="$union_f", when={"to": U("month", 0, name=8)})]))
