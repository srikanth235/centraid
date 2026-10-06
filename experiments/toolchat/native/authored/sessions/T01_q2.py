from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T01-Q026", "oldest earliest order date asc i2pat",
  T("what's my oldest document", rows("deposit_letter"),
    ref=[ans(kind="document", order="date asc", limit=1)]))

S("T01-Q027", "name matches nothing pick listed by id i2pat",
  T("what's left on the kids list", rows("permission", "dinner_money", "boots", "tobi_passport", "reading_book", "childcare", "swim_kit"),
    ref=[ans(kind="task", linked_to="$kids_list", where="status = open")]),
  T("tick off the trip form", diff(upd("permission", status="completed", completed=ANY)),
    ref=[act("complete", rows="$permission")]))

S("T01-Q028", "numeric options in question not filter i2pat",
  T("how many long days have i got left, is it 5 or 6", val(5),
    ref=[ans(op="count", kind="event", name="Long day", where="status != cancelled", when=J({"from": U("day", 0)}))]))

S("T01-Q029", "restore photo adjective occasion i2pat",
  T("bring back the blurry one from when ada lost her tooth", diff(restore("p_blurry")),
    ref=[act("restore", kind="photo", name="blurry", trashed=True)]))

S("T01-Q030", "skip cancel event by day i2pat",
  T("skip ada's swimming on saturday", diff(upd("swim_0314", status="cancelled")),
    ref=[act("cancel", kind="event", name="swimming lesson", when=J(U("week", 0, weekday=6)))]))

S("T01-Q031", "lent me debt i_owe verbatim item i2pat",
  T("dev lent me 30 for paint brushes",
    diff(new("debt", name=has("paint brushes"), amount=30, direction="i_owe"), link("new", "dev")),
    ref=[act("create", args=lines(kind="debt", name="Paint brushes", amount="30", direction="i_owe", person="$dev"))]))

S("T01-Q032", "append line to note keep separator i2pat",
  T("what's in ada's allergy note", rows("allergy"),
    ref=[ans(kind="note", name="allergy")]),
  T("add a line to it, the pe teacher knows too",
    diff(upd("allergy", body=has("peanuts and tree nuts; epipen in red bag; school has a spare", "pe teacher knows too"))),
    ref=[act("edit", rows="$allergy", args="body: peanuts and tree nuts; epipen in red bag; school has a spare; pe teacher knows too")]))

S("T01-Q033", "append item to body i2pat",
  T("what's in mum's gift ideas note", rows("gift_ideas"),
    ref=[ans(kind="note", name="gift ideas")]),
  T("add a bottle of wine to it",
    diff(upd("gift_ideas", body=has("gele from Bisi's shop, spa day, new reading glasses", "bottle of wine"))),
    ref=[act("edit", rows="$gift_ideas", args="body: gele from Bisi's shop, spa day, new reading glasses, bottle of wine")]))

S("T01-Q034", "create name head phrase follow-up time keeps name i2pat",
  T("put a haircut in for saturday at 11, been putting it off for weeks", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Haircut", date=U("week", 0, weekday=6, time="11:00")))),
         askc("11 clashes with the worktop template visit, 11 to 12. another time?")]),
  T("half 12 then", diff(new("event", name=has("Haircut"), date="2026-03-14T12:30")),
    ref=[act("create", args=lines(kind="event", name="Haircut", date=U("week", 0, weekday=6, time="12:30")))]))

S("T01-Q035", "and when generic noun event by topic name i2pat",
  T("what's left on the hen do list", rows("hen_plan", "deposits", "games"),
    ref=[ans(kind="task", linked_to="$hen_list", where="status = open")]),
  T("and when's the party", rows("hen_class", "hen_dinner"),
    ref=[ans(kind="event", name="hen do")]))

S("T01-Q036", "the name list resolve open includes in-progress i2pat",
  T("anything left on the kitchen reno list", rows("reno", "tiles", "adhesive", "skip", "cupboards", "instalment", "paint", "plumber_quote",
                                                    "temp_kitchen", "handles"),
    ref=[ans(kind="task", linked_to="$reno_list", where="status = open")]))

S("T01-Q037", "which have person search then link within i2pat",
  T("show me the christmas album", rows("p_xmas_morning", "p_xmas_dinner", "p_bike", "p_nativity", "p_tree"),
    ref=[ans(kind="photo", linked_to="$xmas_album")]),
  T("which have callum in them", rows("p_xmas_dinner", "p_tree"),
    ref=[search("callum", kind="person"), ans(within="@1", linked_to="$callum")]))
