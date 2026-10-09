from gold import *
import json

world("T08", "2026-04-06T17:50", "Deshawn Carter", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T08-001", "list area contains",
  T("which of my lists are family stuff", rows("reunion_l", "school_l"),
    ref=[ans(kind="list", where='area contains "family"')]))

S("T08-002", "task reschedule prev ambiguous timesheet",
  T("when's the recovery tank thing due", rows("recovery_tank"),
    ref=[ans(kind="task", name="recovery tank")]),
  T("push it to tmrw at 7am", diff(upd("recovery_tank", date="2026-04-07T07:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("day", 1, time="07:00")))]),
  T("same for submit timesheet", diff(upd("ts_apr", date="2026-04-07T07:00")),
    ref=[act("reschedule", kind="task", name="Submit timesheet", args=lines(to=U("day", 1, time="07:00"))),
         act("reschedule", kind="task", name="Submit timesheet", where='status = "open"',
             args=lines(to=U("day", 1, time="07:00")))]),
  T("so what's due tmrw", rows("restock", "bigmama_meds", "recovery_tank", "ts_apr"),
    ref=[ans(kind="task", when=W(U("day", 1)))]))

S("T08-003", "person met cadence when-to",
  T("who in eagles boosters didn't i meet thru eastside eagles", rows("tasha", "me"),
    ref=[ans(kind="person", linked_to="$boosters", where='met != "Eastside Eagles"')]),
  T("who am i supposed to check in with every two weeks or more", rows("mama", "bigmama", "tanya", "dre", "keisha", "monique", "tasha"),
    ref=[ans(kind="person", where="cadence <= 14")]),
  T("which of them haven't i heard from since last monday", rows("bigmama", "dre"),
    ref=[ans(kind="person", within="@prev", when=W({"to": U("week", -1, weekday=1)}))]))

S("T08-004", "delete person named restore",
  T("delete sheila grant, she left the company", diff(trash("sheila")),
    ref=[act("delete", kind="person", name="Sheila Grant")]),
  T("wait she's dispatching till friday, put her back", diff(restore("sheila")),
    ref=[act("restore", rows="$sheila")]))

S("T08-005", "trashed person restore window ask create",
  T("is jerome the barber in my contacts", rows("jerome"),
    ref=[find(kind="person", name="Jerome"), ans(kind="person", name="Jerome", trashed=True)]),
  T("bring him back", ask(),
    ref=[bad(act("restore", rows="$jerome")),
         askc("he was deleted back in january, past the 30 day window so he can't be restored. want me to add him fresh?")]),
  T("yea do that, Jerome Watts, barber", diff(new("person", name="Jerome Watts", role="barber")),
    ref=[act("create", args=lines(kind="person", name="Jerome Watts", role="barber"))]))

S("T08-006", "restore person window",
  T("restore carl pruitt", diff(restore("carl")),
    ref=[act("restore", kind="person", name="Carl Pruitt", trashed=True)]),
  T("and jerome watts", ask(),
    ref=[bad(act("restore", kind="person", name="Jerome Watts", trashed=True)),
         askc("jerome's been in the trash too long to restore. make a new contact for him?")]))

S("T08-007", "remove_from person multi delete empty group",
  T("take brandon lee and omar haddad out of the practice carpool, they got another ride",
    diff(unlink("carpool", "brandon"), unlink("carpool", "omar")),
    ref=[act("remove_from", rows="$brandon, $omar", args=lines(from_="$carpool"))]),
  T("who's left in it", rows("tasha", "me"),
    ref=[ans(kind="person", linked_to="$carpool")]),
  T("and fantasy league 2025 can go, nobody uses it", diff(gone("fantasy"), unlink("fantasy", "trey"), unlink("fantasy", "kevin"),
                                                  unlink("fantasy", "me")),
    ref=[act("delete", rows="$fantasy")]))

S("T08-008", "refused group delete ask never_mind",
  T("get rid of the boosters group", ask(),
    ref=[bad(act("delete", rows="$boosters")),
         askc("it still has expenses in it so it can't be deleted. want to settle up with everyone first?")]),
  T("nah leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T08-009", "folder create edit new delete empty",
  T("make a folder called Reunion receipts", diff(new("folder", name="Reunion receipts")),
    ref=[act("create", args=lines(kind="folder", name="Reunion receipts"))]),
  T("call it Reunion money", diff(upd("+1", name="Reunion money")),
    ref=[act("edit", rows="$c1", args=lines(name="Reunion money"))]),
  T("and delete the old job folder, nothing in it", diff(gone("oldjob_f")),
    ref=[act("delete", rows="$oldjob_f")]))

S("T08-010", "refused folder delete linked docs",
  T("delete the truck folder", ask(),
    ref=[bad(act("delete", rows="$truck_f")),
         askc("the truck folder still has documents in it, so it can't go. want me to list them?")]),
  T("ya what's in there", rows("title", "ins_card", "rego"),
    ref=[ans(kind="document", linked_to="$truck_f")]))

S("T08-011", "event overlap create ask",
  T("put dinner with trey in the diary thursday at 6", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Dinner with Trey", date=U("week", 0, weekday=4, time="18:00")))),
         askc("thursday at 6 clashes with football practice. want it at 8 instead?")]),
  T("yea 8", diff(new("event", name=has("Trey"), date="2026-04-09T20:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Trey", date=U("week", 0, weekday=4, time="20:00")))]),
  T("what's thursday look like", rows("dentist_jalen", "prac_0409", "+1"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=4)))]))

S("T08-012", "event overlap create",
  T("add a side job at the franklins saturday 9am", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Side job at the Franklins", date=U("week", 0, weekday=6, time="09:00")))),
         askc("you've got your haircut at 9 saturday. pick another time?")]),
  T("10 then", diff(new("event", name=has("Franklins"), date="2026-04-11T10:00")),
    ref=[act("create", args=lines(kind="event", name="Side job at the Franklins", date=U("week", 0, weekday=6, time="10:00")))]))

S("T08-013", "album create delete new empty",
  T("make an album called Car wash", diff(new("album", name="Car wash")),
    ref=[act("create", args=lines(kind="album", name="Car wash"))]),
  T("eh never mind delete that album", diff(gone("+1")),
    ref=[act("delete", rows="$c1")]),
  T("any albums with nothing in them", rows(),
    ref=[ans(kind="album", where="photo count = 0")]))

S("T08-014", "locker create star new",
  T("save the garage keypad code 5582 in the locker as a note, call it Garage keypad",
    diff(new("locker item", name="Garage keypad", type="note")),
    ref=[act("create", args=lines(kind="locker item", name="Garage keypad", type="note", notes="5582"))]),
  T("star it so i can find it quick", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("what have i got starred in there", rows("wifi", "visa", "union_card", "+1"),
    ref=[ans(kind="locker item", where="starred = yes")]))

S("T08-015", "wifi read reveal prev",
  T("what's the wifi called in my locker", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("show me the password", diff(reveal=[("wifi", "EaglesNest2026!")]),
    ref=[act("reveal", kind="locker item", rows="@prev", args=lines(field="password"))]))

S("T08-016", "locker reveal prev credit union",
  T("pull up the credit union login", rows("bank_login"),
    ref=[ans(kind="locker item", name="Credit union login")]),
  T("what's the password on it", diff(reveal=[("bank_login", "Truck-F150-go")]),
    ref=[act("reveal", kind="locker item", rows="@prev", args=lines(field="password"))]),
  T("and which locker things have a type at all", rows("wifi", "servicetitan", "portal", "bank_login", "visa", "gas_card",
                                                       "gate_code", "ssn", "alarm", "pi_key", "weather_api", "passport",
                                                       "checking", "license", "office", "crypto", "costco", "union_card",
                                                       "epa_card"),
    ref=[ans(kind="locker item", where="type is set")]))

S("T08-017", "list edit prev",
  T("what area is the union list under", rows("union_l"),
    ref=[ans(rows="$union_l")]),
  T("change it to union", diff(upd("union_l", area="union")),
    ref=[act("edit", rows="@prev", args=lines(area="union"))]))

S("T08-018", "notebook delete knock-on",
  T("anything in my scratch notebook", rows(),
    ref=[ans(kind="note", linked_to="$scratch_nb")]),
  T("ok then delete that notebook", diff(gone("scratch_nb")),
    ref=[act("delete", rows="$scratch_nb")]),
  T("and the boosters notebook", diff(gone("boosters_nb"), unlink("boosters_nb", "concession_prices"),
                                     unlink("boosters_nb", "carwash_plan")),
    ref=[act("delete", rows="$boosters_nb")]))

S("T08-019", "notebook delete knock-on union",
  T("i don't need the union notebook anymore, delete it", diff(gone("union_nb"), unlink("union_nb", "grievance_notes"),
                                                             unlink("union_nb", "contract_q")),
    ref=[act("delete", rows="$union_nb")]),
  T("did the grievance timeline note survive", rows("grievance_notes"),
    ref=[ans(kind="note", name="Grievance timeline")]))

S("T08-020", "add_to note where undo link",
  T("the note that mentions andouille, put it in the reunion notebook",
    diff(link("reunion_nb", "gumbo"), unlink("recipes_nb", "gumbo")),
    ref=[act("add_to", kind="note", where='body contains "andouille"', args=lines(to="$reunion_nb"))]),
  T("undo that", diff(link("recipes_nb", "gumbo"), unlink("reunion_nb", "gumbo")),
    ref=[act("undo")]))

S("T08-021", "add_to note prev remove_from prev",
  T("which note has my side job tune-up prices", rows("side_jobs"),
    ref=[ans(kind="note", where='body contains "tune-up"')]),
  T("put it in hvac notes", diff(link("hvac_nb", "side_jobs")),
    ref=[act("add_to", rows="@prev", args=lines(to="$hvac_nb"))]),
  T("hmm no take it back out", diff(unlink("hvac_nb", "side_jobs")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$hvac_nb"))]))

S("T08-022", "remove_from note prev",
  T("which notebook is jalen's allergies in", rows("allergy"),
    ref=[ans(kind="note", name="Jalen's allergies")]),
  T("take it out of there, i want it loose", diff(unlink("kids_nb", "allergy")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$kids_nb"))]))

S("T08-023", "star document prev unstar multi",
  T("find the pavilion contract", rows("pavilion_contract"),
    ref=[ans(kind="document", name="Pavilion")]),
  T("star that", diff(upd("pavilion_contract", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("and unstar W-2 2025 and the truck insurance card", diff(upd("w2", starred=False), upd("ins_card", starred=False)),
    ref=[find(kind="document", where="starred = yes"), act("unstar", rows="$w2, $ins_card")]))

S("T08-024", "ambiguous document star ask",
  T("star my lease", ask("lease25", "lease26"),
    ref=[act("star", kind="document", name="lease"),
         askc("the 2025 lease or the 2026 one?", options="$lease25, $lease26")]),
  T("the new one", diff(upd("lease26", starred=True)),
    ref=[act("star", rows="$lease26")]))

S("T08-025", "ambiguous document delete",
  T("delete the report card", ask("rc_jalen", "rc_jada"),
    ref=[act("delete", kind="document", name="report card"),
         askc("jalen's or jada's?", options="$rc_jalen, $rc_jada")]),
  T("jalens, i printed it", diff(trash("rc_jalen")),
    ref=[act("delete", rows="$rc_jalen")]))
