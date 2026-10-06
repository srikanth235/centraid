from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T29-Q026", "body is empty read i2pat",
  T("which notes have nothing written in them", rows(),
    ref=[ans(kind="note", where="body is empty")]))

S("T29-Q027", "settle phrase on read debt row i2pat",
  T("what does juma owe me", rows("d_juma_chai"),
    ref=[ans(kind="debt", linked_to="$juma", where="status = open")]),
  T("he's paid, sort it", diff(upd("d_juma_chai", status="settled")),
    ref=[act("settle_debt", rows="$d_juma_chai")]))

S("T29-Q028", "possessive field phrase edit focus row i2pat",
  T("who's dennis", rows("dennis"),
    ref=[ans(kind="person", name="Dennis")]),
  T("his nickname's Denno", diff(upd("dennis", nickname="Denno")),
    ref=[act("edit", rows="$dennis", args="nickname: Denno")]))

S("T29-Q029", "remind me what time read event never create i2pat",
  T("remind me what time the vaccination is", rows("vet_vacc"),
    ref=[ans(kind="event", name="vaccination")]))

S("T29-Q030", "different day make it carried name plus person i2pat",
  T("dinner with ian on friday at 7:30", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Dinner with Ian", date=U("week", 0, weekday=5, time="19:30")))),
         askc("that clashes with dinner with wambs at 7:30. another day or time?")]),
  T("different day, make it saturday", diff(new("event", name=has("Dinner with Ian"), date="2026-09-26T19:30")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Ian", date=U("week", 0, weekday=6, time="19:30")))]))

S("T29-Q031", "nickname and star one turn i2pat",
  T("give naomi the nickname bride and star her", diff(upd("naomi", nickname="Bride", starred=True)),
    ref=[act("edit", rows="$naomi", args="nickname: Bride", more=True), act("star", rows="$naomi")]))

S("T29-Q032", "add item to note body keep old i2pat",
  T("what's in the chapati note", rows("chapati"),
    ref=[ans(kind="note", name="Chapati")]),
  T("add salt to it", diff(upd("chapati", body=has("flour, warm water, oil, rest an hour, fold three times", "salt"))),
    ref=[act("edit", rows="$chapati", args="body: flour, warm water, oil, rest an hour, fold three times, salt")]))

S("T29-Q033", "multi-field edit unit conversion i2pat",
  T("the roof truss detail takes 2 hours and make it priority 1", diff(upd("karen_roof", effort=120, priority=1)),
    ref=[act("edit", rows="$karen_roof", args="effort: 120\npriority: 1")]))

S("T29-Q034", "rename quoted target verbatim i2pat",
  T('rename the kitchen notebook to "Home cooking"', diff(upd("kitchen_nb", name="Home cooking")),
    ref=[act("edit", rows="$kitchen_nb", args="name: Home cooking")]))

S("T29-Q035", "reveal after turn naming field i2pat",
  T("where's the cvv for my kcb card saved", rows("kcb_card"),
    ref=[ans(kind="locker item", name="KCB debit card")]),
  T("read it out", diff(reveal=[("kcb_card", "731")]),
    ref=[act("reveal", rows="$kcb_card", args="field: cvv")]))

S("T29-Q036", "pick row containing all words among carried i2pat",
  T("what's open on the club list", rows("kit_order", "kitty_report", "kitty_dues", "race_reg", "kitty_receipts", "agm_agenda", "bike_service"),
    ref=[ans(kind="task", linked_to="$club_list", where="status = open")]),
  T("tick off the jersey chase", diff(upd("kit_order", status="completed", completed=ANY)),
    ref=[act("complete", rows="$kit_order")]))

S("T29-Q037", "second clause own noun resolved fresh i2pat",
  T("complete the mpesa float task and push the dog tag order to monday",
    diff(upd("mpesa_float", status="completed", completed=ANY), upd("dog_tag", date="2026-09-28")),
    ref=[act("complete", rows="$mpesa_float", more=True),
         act("reschedule", rows="$dog_tag", args=lines(to=U("week", 1, weekday=1)))]))

S("T29-Q038", "and the X one after reveal same verb i2pat",
  T("show me the flat wifi password", diff(reveal=[("flat_wifi", "SimbaTheDog#1")]),
    ref=[act("reveal", rows="$flat_wifi", args="field: password")]),
  T("and the kisumu one", diff(reveal=[("kisumu_wifi", "Milimani2026")]),
    ref=[act("reveal", rows="$kisumu_wifi", args="field: password")]))
