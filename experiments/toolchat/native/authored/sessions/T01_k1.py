from gold import *

world("T01", "2026-03-12T18:20", "Oluwaseun Adebayo-Clarke", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


OPEN = 'status = "open"'

S("T01-K001", "referent locker renew i3skill S1",
  T("what's the microsoft 365 thing", rows("office365"),
    ref=[ans(kind="locker item", name="Microsoft 365")]),
  T("when does it renew", rows("office365"),
    ref=[ans(rows="$office365")]))

S("T01-K002", "referent count narrows i3skill S1",
  T("how many tasks are open on the work list", val(7),
    ref=[ans(kind="task", op="count", linked_to="$work_list", where=OPEN)]),
  T("how many take over an hour", val(1),
    ref=[ans(kind="task", op="count", linked_to="$work_list", where=OPEN + " and effort > 60")]))

S("T01-K003", "referent event person i3skill S1",
  T("show me the plumber visit", rows("plumber_visit"),
    ref=[ans(kind="event", name="Plumber quote visit")]),
  T("who's it with", rows("neil"),
    ref=[ans(kind="person", linked_to="$plumber_visit")]))

S("T01-K004", "referent created row i3skill S1",
  T("add a task call kunle about the cake", diff(new("task", name=has("kunle", "cake"))),
    ref=[act("create", args=lines(kind="task", name="Call Kunle about the cake"))]),
  T("make it due friday", diff(upd("+1", date="2026-03-13")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 0, weekday=5)))]))

S("T01-K005", "referent the-noun folder star i3skill S1",
  T("what's in the school folder", rows("tobi_report", "ada_report", "farm_letter", "term_dates"),
    ref=[ans(kind="document", linked_to="$school_f")]),
  T("star the farm one", diff(upd("farm_letter", starred=True)),
    ref=[act("star", rows="$farm_letter")]))

S("T01-K006", "perfect tense count span i3skill S2",
  T("how many times has tobi had football training so far", val(2),
    ref=[ans(kind="event", op="count", name="football training", when=J({"to": U("day", 0)}))]))

S("T01-K007", "single day friday i3skill S2",
  T("what've i got on friday", rows("plumber_visit"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=5)))]),
  T("and on sunday", rows("match_0315", "mothering"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=7)))]))

S("T01-K008", "still in month ahead i3skill S2",
  T("is the hen do still in april", rows("hen_class", "hen_dinner"),
    ref=[ans(kind="event", name="hen do", when=J(U("month", 0, name=4)))]))

S("T01-K009", "duration units effort i3skill S2",
  T("which tasks take under half an hour", rows("adhesive", "skip", "permission", "nowtv", "card_mum", "tesco", "study_parking", "prescription"),
    ref=[ans(kind="task", where="effort < 30")]),
  T("and the ones that take two hours or more", rows("cupboards", "revalidation"),
    ref=[ans(kind="task", where="effort >= 120")]))

S("T01-K010", "relation to event find first i3skill S2",
  T("what's left on the kids list before the farm trip", rows("permission", "dinner_money", "boots", "tobi_passport", "reading_book", "swim_kit"),
    ref=[ans(kind="task", linked_to="$kids_list", where=OPEN, when=J({"to": D("2026-03-25")}))]))

S("T01-K011", "read not write debt paid i3skill S3",
  T("did i pay kwame back for the taxi", rows("d_kwame_taxi"),
    ref=[ans(kind="debt", name="taxi")]))

S("T01-K012", "read then write passport i3skill S3",
  T("is tobi's passport renewal done", rows("tobi_passport"),
    ref=[ans(kind="task", name="Renew Tobi's passport")]),
  T("not yet, but tick it off anyway, the form's in", diff(upd("tobi_passport", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tobi_passport")]))

S("T01-K013", "read starred of them i3skill S3",
  T("what logins have i got", rows("nhs_login", "nhs_mail", "parentpay", "netflix"),
    ref=[ans(kind="locker item", where='type = "login"')]),
  T("which of them are starred", rows("nhs_login"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T01-K014", "read cancelled event i3skill S3",
  T("did i cancel the date night", rows("date_night"),
    ref=[ans(kind="event", name="Date night")]))

S("T01-K015", "read booked mot i3skill S3",
  T("have i booked the mot yet", rows("book_mot"),
    ref=[ans(kind="task", name="Book MOT")]))

S("T01-K016", "no invention note body search i3skill S4",
  T("delete the note about sbar", diff(trash("handover")),
    ref=[search("sbar", kind="note"), act("delete", rows="$handover")]))

S("T01-K017", "no invention task description search i3skill S4",
  T("tick off the one about the countersign", diff(upd("tobi_passport", status="completed", completed=ANY)),
    ref=[search("countersign", kind="task"), act("complete", rows="$tobi_passport")]))

S("T01-K018", "no invention missing note body ask i3skill S4",
  T("put a note in the reno notebook", ask(),
    ref=[askc("What should the note say?")]))

S("T01-K019", "perfect month i3skill S2",
  T("how many night shifts have i had this month", val(3),
    ref=[ans(kind="event", op="count", name="night shift", when=J({"from": U("month", 0), "to": U("day", 0)}))]))
S("T01-K020", "perfect since i3skill S2",
  T("how many times has ada swum since january", val(2),
    ref=[ans(kind="event", op="count", name="swimming lesson", where='status != "cancelled"', when=J({"from": U("month", 0, name=1), "to": U("day", 0)}))]))
S("T01-K021", "perfect nothing i3skill S2",
  T("have i had any long days this week", rows("ld_0309", "ld_0310"),
    ref=[ans(kind="event", name="Long day", when=J({"from": U("week", 0), "to": U("day", 0)}))]))

S("T01-K022", "no invention role not name log call i3skill S4",
  T("log a call with the electrician", diff(upd("tomasz", date=ANY)),
    ref=[act("log", kind="person", where='role = "electrician"', args=lines(kind="call"))]))

S("T01-K023", "no invention body words search note i3skill S4",
  T("what did i write about the epipen", rows("allergy"),
    ref=[search("epipen", kind="note"), ans(rows="$allergy")]))

S("T01-K024", "no invention search then pin i3skill S4",
  T("pin the note that mentions mr and mrs quiz", diff(upd("hen_ideas", pinned=True)),
    ref=[search("mr and mrs quiz", kind="note"), act("edit", rows="$hen_ideas", args=lines(pinned="yes"))]))
