from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T19-Q026", "remind me what time read event never create i2pat",
  T("remind me what time the parent-teacher meeting is", rows("ptm"),
    ref=[ans(kind="event", name="Parent-teacher meeting")]))

S("T19-Q027", "restore photo adjective occasion i2pat",
  T("restore the blurry one from the beach day", diff(restore("blurry")),
    ref=[act("restore", kind="photo", name="blurry", trashed=True)]))

S("T19-Q028", "skip cancel event by day i2pat",
  T("skip adam's swimming on wednesday", diff(upd("swim_0415", status="cancelled")),
    ref=[act("cancel", kind="event", name="swimming lesson", when=J(U("week", 0, weekday=3)))]))

S("T19-Q029", "add item to note body keep old i2pat",
  T("what's in the generics note", rows("generics"),
    ref=[ans(kind="note", name="Generics to push")]),
  T("add losartan to it", diff(upd("generics", body=has("metformin, amlodipine, omeprazole", "losartan"))),
    ref=[act("edit", rows="$generics", args="body: metformin, amlodipine, omeprazole, losartan")]))

S("T19-Q030", "append a line keep separator i2pat",
  T("show me the vaccine fridge log", rows("fridge_note"),
    ref=[ans(kind="note", name="Vaccine fridge log")]),
  T("add a line, 4.5 at 11pm", diff(upd("fridge_note", body=has("4.2 at 9am, 4.8 at 6pm", "4.5 at 11pm"))),
    ref=[act("edit", rows="$fridge_note", args="body: 4.2 at 9am, 4.8 at 6pm, 4.5 at 11pm")]))

S("T19-Q031", "append text keeps existing i2pat",
  T("what's in the wholesaler prices note", rows("prices"),
    ref=[ans(kind="note", name="Wholesaler prices")]),
  T("add alcohol swabs 25 to it", diff(upd("prices", body=has("strips 165 a box, lancets 40, pen needles 90", "alcohol swabs 25"))),
    ref=[act("edit", rows="$prices", args="body: strips 165 a box, lancets 40, pen needles 90, alcohol swabs 25")]))

S("T19-Q032", "reveal after turn naming field i2pat",
  T("where's the cvv for my visa debit card saved", rows("visa"),
    ref=[ans(kind="locker item", name="Visa debit card")]),
  T("read it out", diff(reveal=[("visa", "731")]),
    ref=[act("reveal", rows="$visa", args="field: cvv")]))

S("T19-Q033", "and when generic noun event by topic name i2pat",
  T("what's left for lina's birthday party", rows("cake", "invites"),
    ref=[ans(kind="task", linked_to="$party_plan", where="status = open")]),
  T("and when's the party", rows("lina_party"),
    ref=[ans(kind="event", name="Lina's birthday party")]))

S("T19-Q034", "the name list resolve open includes in-progress i2pat",
  T("anything left on the baba list", rows("insulin", "strips", "glucose_log_t", "shoes", "reimburse"),
    ref=[ans(kind="task", linked_to="$baba_l", where="status = open")]))

S("T19-Q035", "and the X one after reveal same verb i2pat",
  T("show me the home wifi password", diff(reveal=[("wifi_home", "lina-adam-2019")]),
    ref=[act("reveal", rows="$wifi_home", args="field: password")]),
  T("and the pharmacy one", diff(reveal=[("wifi_pharm", "Maarif-Pharma-5G")]),
    ref=[act("reveal", rows="$wifi_pharm", args="field: password")]))
