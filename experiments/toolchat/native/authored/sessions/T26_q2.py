from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T26-Q026", "body is empty read i2pat",
  T("which notes are blank", rows(),
    ref=[ans(kind="note", where="body is empty")]))

S("T26-Q027", "oldest earliest order date asc i2pat",
  T("what's my earliest note", rows("ajo_rules"),
    ref=[ans(kind="note", order="date asc", limit=1)]))

S("T26-Q028", "possessive field phrase edit focus row i2pat",
  T("who's ebere", rows("ebere"),
    ref=[ans(kind="person", name="Ebere")]),
  T("her role's dentist and orthodontist", diff(upd("ebere", role=has("orthodontist"))),
    ref=[act("edit", rows="$ebere", args="role: dentist and orthodontist")]))

S("T26-Q029", "remind me what time read event never create i2pat",
  T("remind me what time the mortgage meeting is", rows("mortgage"),
    ref=[ans(kind="event", name="mortgage")]))

S("T26-Q030", "restore photo adjective occasion i2pat",
  T("bring back the blurry one from the site visit", diff(restore("p_blurry")),
    ref=[act("restore", kind="photo", name="blurry", trashed=True)]))

S("T26-Q031", "nickname and star one turn i2pat",
  T("give garba the nickname foreman and star him", diff(upd("garba", nickname="Foreman", starred=True)),
    ref=[act("edit", rows="$garba", args="nickname: Foreman", more=True), act("star", rows="$garba")]))

S("T26-Q032", "add item to note body keep old i2pat",
  T("what's in gift ideas for mama", rows("gift_ideas"),
    ref=[ans(kind="note", name="Gift ideas for Mama")]),
  T("add a handbag to it", diff(upd("gift_ideas", body=has("gold earrings, new wrapper, a trip to Mecca fund", "handbag"))),
    ref=[act("edit", rows="$gift_ideas", args="body: gold earrings, new wrapper, a trip to Mecca fund, a handbag")]))

S("T26-Q033", "append a line keep existing separator i2pat",
  T("show me the car notes", rows("car_n"),
    ref=[ans(kind="note", name="Car notes")]),
  T("add a line, check the tyres", diff(upd("car_n", body=has("Camry due service at 90000 km, front pads worn", "check the tyres"))),
    ref=[act("edit", rows="$car_n", args="body: Camry due service at 90000 km, front pads worn, check the tyres")]))

S("T26-Q034", "rename quoted target verbatim i2pat",
  T('rename the business ideas notebook to "Side businesses"', diff(upd("biz_nb", name="Side businesses")),
    ref=[act("edit", rows="$biz_nb", args="name: Side businesses")]))

S("T26-Q035", "reveal after turn naming field i2pat",
  T("where's the cvv for my zenith visa saved", rows("visa_card"),
    ref=[ans(kind="locker item", name="Zenith Visa")]),
  T("read it out", diff(reveal=[("visa_card", "552")]),
    ref=[act("reveal", rows="$visa_card", args="field: cvv")]))

S("T26-Q036", "and when generic noun event by topic name i2pat",
  T("what do i still need for mama's 70th", rows("canopy", "aso_ebi", "caterer"),
    ref=[ans(kind="task", linked_to="$party", where="status = open")]),
  T("and when's the party", rows("mama70"),
    ref=[ans(kind="event", name="Mama's 70th")]))

S("T26-Q037", "second clause own noun resolved fresh i2pat",
  T("tick off update pension beneficiary and push the tax clearance to monday",
    diff(upd("pension", status="completed", completed=ANY), upd("tax", date="2026-11-30")),
    ref=[act("complete", rows="$pension", more=True),
         act("reschedule", rows="$tax", args=lines(to=U("week", 1, weekday=1)))]))

S("T26-Q038", "and the X one after reveal same verb i2pat",
  T("show me the home wifi password", diff(reveal=[("wifi", "bello-five-kids")]),
    ref=[act("reveal", rows="$wifi", args="field: password")]),
  T("and the site one", diff(reveal=[("wifi_site", "rumuokoro-2026")]),
    ref=[act("reveal", rows="$wifi_site", args="field: password")]))
