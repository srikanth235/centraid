from gold import *

world("T27", "2026-12-03T04:50", "Sophie Dubois", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T27-A001", "ask-options person star c3a",
  T("star thomas", ask("thomas_m", "thomas_g"),
    ref=[act("star", kind="person", name="Thomas"),
         askc("Thomas Moreau, Julien's brother, or Thomas Girard the miller?", options="$thomas_m, $thomas_g")]),
  T("girard, the miller. we'd be lost without his flour", diff(upd("thomas_g", starred=True)),
    ref=[act("star", rows="$thomas_g")]))

S("T27-A002", "ask-options event reschedule c3a",
  T("push the flour delivery to 8", ask("flour_1", "flour_2"),
    ref=[act("reschedule", kind="event", name="Flour delivery", args=lines(to=U("day", 0, anchor="row", time="08:00"))),
         find(kind="event", name="Flour delivery", when=J({"from": U("day", 0)})),
         askc("Tomorrow the 4th or the one on the 11th?", options="$flour_1, $flour_2")]),
  T("the 11th", diff(upd("flour_2", date="2026-12-11T08:00")),
    ref=[act("reschedule", rows="$flour_2", args=lines(to=U("day", 0, anchor="row", time="08:00")))]))

S("T27-A003", "ask-options task complete c3a",
  T("tick off the opening one", ask("prep", "guests"),
    ref=[act("complete", kind="task", name="opening"),
         askc("Opening day prep or Plan the soft opening guest list?", options="$prep, $guests")]),
  T("the guest list, finalised it last night", diff(upd("guests", status="completed", completed=ANY)),
    ref=[act("complete", rows="$guests")]),
  T("and the boards one's done, tick it off", diff(upd("menu_boards", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="boards")]))

S("T27-A004", "ask-options document delete never_mind c3a",
  T("delete the contract", ask("flour_contract", "dairy_contract"),
    ref=[act("delete", kind="document", name="contract"),
         askc("The Moulin Girard contract or the dairy supply contract?", options="$flour_contract, $dairy_contract")]),
  T("oh god no, i need both. leave them", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T27-A006", "ask-options note delete never_mind c3a",
  T("delete the opening note", ask("prices", "rota", "opening_menu"),
    ref=[act("delete", kind="note", name="opening"),
         askc("Opening prices, Opening week rota or Opening day menu?", options="$prices, $rota, $opening_menu")]),
  T("wait no, i need all three for saturday", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and star odette", diff(upd("odette", starred=True)),
    ref=[act("star", kind="person", name="Odette")]))

S("T27-A007", "follow-up c3a",
  T("what's open on the opening day list", rows("prep", "flyers", "sign", "menu_boards", "till_float"),
    ref=[ans(kind="task", linked_to="$open_l", where="status = open")]),
  T("which of those are priority 1", rows("prep"),
    ref=[ans(within="@prev", where="priority = 1")]),
  T("and the rest", rows("flyers", "till_float", "sign", "menu_boards"),
    ref=[ans(within="@1", exclude="@2")]))

S("T27-A008", "follow-up c3a",
  T("what's on next week", rows("partners_1211", "opening", "midwife_dec", "bake_1207", "hygiene", "flour_2", "class_1208", "oven_check", "soft_open", "workshop"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just the ones before wednesday", rows("oven_check", "class_1208", "bake_1207"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=2)}))]),
  T("what else is on", rows("partners_1211", "opening", "midwife_dec", "workshop", "hygiene", "flour_2", "soft_open"),
    ref=[ans(within="@1", exclude="@2")]))

S("T27-A009", "follow-up c3a",
  T("who do i owe", rows("d_camille", "d_thomas", "d_antoine", "d_lea"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("which of those are over 100", rows("d_camille", "d_antoine", "d_lea"),
    ref=[ans(within="@prev", where="amount > 100 EUR")]),
  T("which is the biggest", rows("d_antoine"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T27-A010", "follow-up c3a",
  T("what's in the bakes album", rows("p_croissants", "p_scoring", "p_praline", "p_burnt", "p_kouign"),
    ref=[ans(kind="photo", linked_to="$bakes_al")]),
  T("which of those are starred", rows("p_croissants"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it now", diff(upd("p_croissants", starred=False)),
    ref=[act("unstar", rows="@prev")]))
