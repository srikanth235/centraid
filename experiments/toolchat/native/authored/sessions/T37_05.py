from gold import *
import json

world("T37", "2027-03-09T10:40", "Liam O'Brien", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# ---- container-link-reads: a read over a named container, filtered by the link --------------------------------------

S("T37-091", "container-link-read parent-task garden purpose-carried notebook-album-collision then within-when then notebook",
  T("what's left for the garden this month", rows("garden_prune", "garden_shed", "garden_seeds"),
    ref=[ans(kind="task", linked_to="$garden_proj", where="status = open", when=W(U("month", 0)))]),
  T("just the ones due this week", rows("garden_prune", "garden_seeds"),
    ref=[ans(within="@prev", when=W(U("week", 0)))]),
  T("what's in the garden notebook", rows("gd_roses", "gd_veg"),
    ref=[ans(kind="note", linked_to="$garden_nb")]))

S("T37-092", "container-link-read album name-word collision garden-party within-starred repair substitution album then name-filter",
  T("what's in the garden album", rows("p_gd_roses", "p_gd_shed", "p_gd_daffs", "p_gd_veg", "p_gd_frost"),
    ref=[ans(kind="photo", linked_to="$garden_album")]),
  T("which of those are starred", rows("p_gd_daffs"),
    ref=[bad(ans(within="@prev", where="favourite = yes")),
         ans(within="@prev", where="starred = yes")]),
  T("and what's in the christmas album",
    rows("p_bos_fenway", "p_bos_dec", "p_bos_northend", "p_bos_snow", "p_bos_kath", "p_bos_harbour"),
    ref=[ans(kind="photo", linked_to="$boston_album")]),
  T("and any photos with garden in the name", rows("p_nuala"),
    ref=[ans(kind="photo", name="garden")]))

S("T37-093", "container-link-read person-link events dr-prasad then within-upcoming",
  T("what have i got with dr prasad", rows("cardio", "cardio_bloods", "cardio_old"),
    ref=[ans(kind="event", linked_to="$dr_prasad")]),
  T("just the ones still to come", rows("cardio", "cardio_bloods"),
    ref=[ans(within="@prev", when=W({"from": U("day", 0)}))]))

S("T37-094", "container-link-read owner groups-i-am-in count then within person-count",
  T("how many groups am i in", val(6),
    ref=[ans(op="count", kind="group", linked_to="$me")]),
  T("which of those have more than four people", rows("bookclub", "gaa"),
    ref=[bad(ans(within="@prev", where="member count > 4")),
         ans(within="@prev", where="person count > 4")]))

S("T37-095", "container-link-read list-vs-folder-vs-notebook health status then within-linked_to person substitution then by-date",
  T("what's left on health", rows("hearing_aid", "bp_log", "knee_ex", "eye_form", "rx_apr"),
    ref=[ans(kind="task", linked_to="$health_list", where="status = open")]),
  T("which of those are about dr nolan", rows("rx_apr"),
    ref=[ans(within="@prev", linked_to="$dr_nolan")]),
  T("and colm", rows("hearing_aid"),
    ref=[ans(within="@1", linked_to="$audio")]),
  T("and what's left on the family list by the 20th", rows("aoife_key"),
    ref=[ans(kind="task", linked_to="$family_list", where="status = open", when=W({"to": D("2027-03-20")}))]))

# ---- stray-or-operator-conditions: an inert clause or a noun that is not a condition --------------------------------

S("T37-096", "stray-condition inert-reason-clause members then met-contains then met-contains side-clause",
  T("who's in the boston group because i'm doing the christmas cards", rows("me", "declan", "kathleen", "jack"),
    ref=[ans(kind="person", linked_to="$boston")]),
  T("who did i meet at the book club", rows("mary_k", "sean_b", "siobhan"),
    ref=[ans(kind="person", where='met contains "book club"')]),
  T("and the gaa crowd, i'm ringing them about the agm", rows("tadhg", "caoimhe", "padraig", "sean_m", "eoin"),
    ref=[ans(kind="person", where='met contains "GAA"')]))

S("T37-097", "stray-condition body-contains note then by-name star inert-purpose",
  T("which notes mention the hse grant", rows("hl_hearing"),
    ref=[ans(kind="note", where='body contains "HSE"')]),
  T("can you star the hospital letter, i need it for the clinic", diff(upd("hospital_letter", starred=True)),
    ref=[act("star", kind="document", name="hospital letter")]))

S("T37-098", "stray-condition description-contains event then inert side clause",
  T("which events say anything about the treasurer", rows("gaa_agm"),
    ref=[ans(kind="event", where='description contains "treasurer"')]),
  T("when's the april book club, i'll bring the wine", rows("bookclub_apr"),
    ref=[ans(kind="event", name="book club", when=W(U("month", 0, name=4)))]))

S("T37-099", "stray-condition photos no-description inert then role-looking noun task then exact role",
  T("photos of cian from this year, for nana's card",
    rows("p_cian_goal", "p_wed_minding", "p_cian_hurl", "p_cian_snow"),
    ref=[ans(kind="photo", linked_to="$cian", when=W(U("year", 0)))]),
  T("when's the treasurer's note due", rows("gaa_report"),
    ref=[ans(kind="task", name="treasurer's note")]),
  T("who's my gp, need to book a check-up", rows("dr_nolan"),
    ref=[ans(kind="person", where='role = "GP"')]))

S("T37-100", "stray-condition by-name writes inert reason clause complete reschedule then direction-looking noun then effort",
  T("tick off the blood pressure log, wrote it up over my tea",
    diff(upd("bp_log", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="blood pressure log")]),
  T("push the gp check-up to the 17th because i've a meeting that morning", diff(upd("gp", date="2027-03-17T09:30")),
    ref=[act("reschedule", kind="event", name="gp check-up", args=lines(to=D("2027-03-17")))]),
  T("how much is the baby gear loan", val((200, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", name="baby gear loan")]),
  T("which open tasks are left that take longer than an hour", rows("camino_boots", "book_next"),
    ref=[ans(kind="task", where="status = open and effort > 60")]))

# ---- date-window-reads: date phrases in reads and counts, each span form in both tenses ---------------------------------

S("T37-101", "date-window before-X closed-future then open-to-past count then open-to-future tasks then closed-past",
  T("what's on before friday that isn't cancelled", rows("training_0309", "grandkids_0310", "coffee_brendan"),
    ref=[ans(kind="event", where="status != cancelled", when=W(span(U("day", 0), U("week", 0, weekday=4))))]),
  T("how many physio sessions did i get to before march", val(3),
    ref=[ans(op="count", kind="event", name="physio", where="status != cancelled",
             when=W({"to": D("2027-02-28")}))]),
  T("which open tasks are due before the 12th", rows("bins_0309", "knee_ex", "book_pay", "gaa_sliotars"),
    ref=[ans(kind="task", where="status = open", when=W({"to": D("2027-03-11")}))]),
  T("what did i do before the 5th this month, not the cancelled one", rows("physio_0301", "grandkids_0303", "bookclub_mar"),
    ref=[ans(kind="event", where="status != cancelled", when=W({"from": U("month", 0), "to": D("2027-03-04")}))]))

S("T37-102", "date-window named-month point-future then point-past count then or-earlier past then or-earlier future",
  T("what have i got on in april",
    rows("bookclub_apr", "calldec_0404", "training_0406", "grandkids_0407", "eyes", "fly_dublin", "mass_baptism"),
    ref=[ans(kind="event", when=W(U("month", 0, name=4)))]),
  T("how many calls with dec did i have in february", val(3),
    ref=[ans(op="count", kind="event", name="call declan", where="status != cancelled",
             when=W(U("month", 0, name=2)))]),
  T("which documents did i add in 2025 or earlier", rows("tax_2024", "will_copy"),
    ref=[ans(kind="document", when=W({"to": U("year", -2)}))]),
  T("which tasks are due on the 12th or earlier",
    rows("bins_0309", "knee_ex", "book_pay", "gaa_sliotars", "garden_seeds", "hearing_aid", "aoife_key"),
    ref=[ans(kind="task", where="status = open", when=W({"to": D("2027-03-12")}))]))

S("T37-103", "date-window ordinal past-tense the-4th substitution the-7th then past-perfect count from-on then last-year",
  T("what was on the 4th", rows("bookclub_mar"),
    ref=[ans(kind="event", when=W(D("2027-03-04")))]),
  T("and the 7th", rows("calldec_0307"),
    ref=[ans(kind="event", when=W(D("2027-03-07")))]),
  T("how many calls with dec have i had from february on", val(4),
    ref=[ans(op="count", kind="event", name="call declan", where="status != cancelled",
             when=W({"from": U("month", 0, name=2), "to": U("day", 0)}))]),
  T("which documents did i add last year",
    rows("pension_stmt25", "house_ins26", "boiler_cert", "boston_tickets", "tax_2025", "passport_scan", "gaa_constitution"),
    ref=[ans(kind="document", when=W(U("year", -1)))]))

S("T37-104", "date-window ordinal future-tense then from-on open-span count future then closed-future then until-closed",
  T("anything on the 4th", rows("calldec_0404"),
    ref=[ans(kind="event", when=W(D("2027-04-04")))]),
  T("how many things have i got on from the 22nd on", val(23),
    ref=[bad(ans(op="count", kind="event", when=W({"from": {"unit": "day"}}))),
         ans(op="count", kind="event", when=W({"from": D("2027-03-22")}))]),
  T("how many things have i got on from the 22nd on this month", val(14),
    ref=[ans(op="count", kind="event", when=W({"from": D("2027-03-22"), "to": U("month", 0)}))]),
  T("what's on from now until friday", rows("training_0309", "grandkids_0310", "coffee_brendan", "hearing"),
    ref=[ans(kind="event", when=W(span(U("day", 0), U("week", 0, weekday=5))))]))

S("T37-105", "date-window two-years-ago year-arithmetic then duration-where not-when future repair then time-of-day pick then duration past",
  T("tax return from two years ago", rows("tax_2024"),
    ref=[ans(kind="document", name="tax return", when=W(U("year", -2)))]),
  T("what's on this month that runs longer than two hours, not counting the cancelled ones",
    rows("grandkids_0303", "grandkids_0310", "grandkids_0317", "grandkids_0324", "grandkids_0331", "stpat",
         "stpat_dinner", "golf_outing", "dinner_nuala", "easter"),
    ref=[bad(ans(kind="event", where="duration > 2 hours and status != cancelled", when=W(U("month", 0)))),
         ans(kind="event", where="duration > 120 and status != cancelled", when=W(U("month", 0)))]),
  T("just the evening ones", rows("stpat_dinner", "dinner_nuala"),
    ref=[ans(rows="$stpat_dinner, $dinner_nuala")]),
  T("which events did i go to last month that ran longer than two hours",
    rows("grandkids_0203", "grandkids_0210", "golf_old", "grandkids_0224"),
    ref=[ans(kind="event", where="duration > 120 and status != cancelled", when=W(U("month", -1)))]))

# ---- mixed: one each --------------------------------------------------------------------------------------------------

S("T37-106", "mixed rename quoted-span notebook",
  T('can you rename the gaa notebook to "Club Business", the old name is too plain',
    diff(upd("gaa_nb", name="Club Business")),
    ref=[act("edit", kind="notebook", name="gaa notebook", args="name: Club Business")]))

S("T37-107", "mixed body-append note edit jot-down open-then-edit",
  T("what does the u12 squad note say", rows("gaa_u12"),
    ref=[opn("$gaa_u12"), ans(rows="$gaa_u12")]),
  T("jot down that the new bibs come friday on the u12 note",
    diff(upd("gaa_u12", body=has("twenty two players", "bibs"))),
    ref=[act("edit", rows="$gaa_u12",
             args="body: twenty two players, six new this year, Eoin's lad is the best with the hurl, new bibs come friday")]))

S("T37-108", "mixed settle_up amount person group repair-missing-group",
  T("settle 20 with padraig in the fund", diff(upd("padraig", balance=ANY), settle=[("Padraig Fahy", "20.00")]),
    ref=[bad(act("settle_up", rows="$padraig", args="amount: 20")),
         act("settle_up", rows="$padraig", args="group: $gaa\namount: 20")]))

S("T37-109", "mixed kind-word read jot-down notes photos tasks same-topic knee",
  T("what did i jot down about the knee", rows("hl_knee"),
    ref=[ans(kind="note", name="knee")]),
  T("and photos", rows("p_physio"),
    ref=[ans(kind="photo", name="knee")]),
  T("and tasks", rows("knee_ex"),
    ref=[ans(kind="task", name="knee")]))

S("T37-110", "mixed weekday-and-clock write reschedule create then make-it-hour reschedule then make-it-minutes edit",
  T("can you move the gp check-up to monday at 4", diff(upd("gp", date="2027-03-15T16:00")),
    ref=[act("reschedule", kind="event", name="gp check-up", args=lines(to=U("week", 1, weekday=1, time="16:00")))]),
  T("and put a call with dec in the diary thursday at 7", diff(new("event", name=has("dec"), date="2027-03-11T19:00")),
    ref=[act("create", args="kind: event\nname: Call with Dec\n" + lines(date=U("week", 0, weekday=4, time="19:00")))]),
  T("make it an hour later", diff(upd("+1", date="2027-03-11T20:00")),
    ref=[act("reschedule", rows="$new", args=lines(to=U("hour", 1, anchor="row")))]),
  T("make it 45 minutes", diff(upd("+1", duration=45)),
    ref=[act("edit", rows="$new", args="duration: 45")]))
