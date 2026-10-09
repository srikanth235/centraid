from gold import *

world("T09", "2026-05-13T08:05", "Hanae Okafor", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


OPEN = 'status = "open"'

S("T09-K001", "referent software licence renew i3skill S1",
  T("show me the adobe acrobat licence", rows("westlaw"),
    ref=[ans(kind="locker item", name="Adobe Acrobat")]),
  T("when does it renew", rows("westlaw"),
    ref=[ans(rows="$westlaw")]))

S("T09-K002", "referent count narrows effort unit i3skill S1",
  T("how many tasks are open on the bar prep list", val(5),
    ref=[ans(kind="task", op="count", linked_to="$bar_list", where=OPEN)]),
  T("how many take under 15 minutes", val(2),
    ref=[ans(kind="task", op="count", linked_to="$bar_list", where=OPEN + " and effort < 15")]))

S("T09-K003", "referent event people it i3skill S1",
  T("when's the cake tasting", rows("cake"),
    ref=[ans(kind="event", name="Cake tasting")]),
  T("who's it with", rows("dan"),
    ref=[ans(kind="person", linked_to="$cake")]))

S("T09-K004", "referent created task add to list i3skill S1",
  T("add a task call the florist about peonies", diff(new("task", name=has("florist", "peonies"))),
    ref=[act("create", args=lines(kind="task", name="Call the florist about peonies"))]),
  T("put it on the wedding list", diff(link("wed_list", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$wed_list"))]))

S("T09-K005", "referent person her log i3skill S1",
  T("when did i last talk to priya sandhu", rows("priya_s"),
    ref=[ans(kind="person", name="Priya Sandhu")]),
  T("log a call with her", diff(upd("priya_s", date=ANY)),
    ref=[act("log", rows="$priya_s", args=lines(kind="call"))]))

S("T09-K006", "referent list then the noun reschedule i3skill S1",
  T("what's open on the work admin list", rows("factum", "docket_may", "disc_outline", "nda", "cpd"),
    ref=[ans(kind="task", linked_to="$work_list", where=OPEN)]),
  T("push the outline to friday", diff(upd("disc_outline", date="2026-05-15")),
    ref=[act("reschedule", rows="$disc_outline", args=lines(to=U("week", 0, weekday=5)))]))

S("T09-K007", "referent debt she it i3skill S1",
  T("what's the veil deposit", rows("d_mom"),
    ref=[ans(kind="debt", name="Veil deposit")]),
  T("has she paid it", rows("d_mom"),
    ref=[ans(rows="$d_mom")]))

S("T09-K008", "perfect had this month i3skill S2",
  T("how many bar prep sessions have we had this month", val(2),
    ref=[ans(kind="event", op="count", name="Bar prep session", when=J({"from": U("month", 0), "to": U("day", 0)}))]))

S("T09-K009", "still in june ahead i3skill S2",
  T("is the stag and doe still in june", rows("stag_night"),
    ref=[ans(kind="event", name="Stag and doe", when=J(U("month", 0, name=6)))]))

S("T09-K010", "single day friday i3skill S2",
  T("what's on friday", rows("team_lunch", "movie"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=5)))]))

S("T09-K011", "read not write library books i3skill S3",
  T("did i return dan's library books", rows("library"),
    ref=[ans(kind="task", name="Return Dan's library books")]))

S("T09-K012", "read debt i owe marcus i3skill S3",
  T("did i pay marcus for the raptors tickets", rows("d_marcus"),
    ref=[ans(kind="debt", name="Raptors tickets")]))

S("T09-K013", "read cancelled yoga i3skill S3",
  T("was the yoga cancelled", rows("yoga"),
    ref=[ans(kind="event", name="Yoga")]))

S("T09-K014", "read then write florist deposit i3skill S3",
  T("is the florist deposit paid", rows("florist_dep"),
    ref=[ans(kind="task", name="Pay florist deposit")]),
  T("yep paid it, tick it off", diff(upd("florist_dep", status="completed", completed=ANY)),
    ref=[act("complete", rows="$florist_dep")]))

S("T09-K015", "read starred of them logins i3skill S3",
  T("what logins have i got", rows("firm_login", "lso_portal", "minted", "condo_portal"),
    ref=[ans(kind="locker item", where='type = "login"')]),
  T("which of them are starred", rows("firm_login"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T09-K016", "no invention task description search i3skill S4",
  T("mark the three quotes one done", diff(upd("repaint", status="completed", completed=ANY)),
    ref=[search("three quotes", kind="task"), act("complete", rows="$repaint")]))

S("T09-K017", "no invention event description search reschedule i3skill S4",
  T("move the superior court one to the 22nd", diff(upd("hearing", date="2026-05-22T10:00")),
    ref=[search("superior court", kind="event"),
         act("reschedule", rows="$hearing", args=lines(to=D("2026-05-22")))]))

S("T09-K018", "no invention note body search pin i3skill S4",
  T("pin the one with the rain plan", diff(upd("arbor_notes", pinned=True)),
    ref=[search("rain plan", kind="note"), act("edit", rows="$arbor_notes", args=lines(pinned="yes"))]))

S("T09-K019", "no invention note body search delete i3skill S4",
  T("delete the note about the bass after 11pm", diff(trash("noise")),
    ref=[search("bass", kind="note"), act("delete", rows="$noise")]))

S("T09-K020", "no invention role caterer log i3skill S4",
  T("log a call with the caterer", diff(upd("anton", date=ANY)),
    ref=[act("log", kind="person", where='role contains "caterer"', args=lines(kind="call"))]))

S("T09-K021", "no invention role star planner i3skill S4",
  T("star the wedding planner", diff(upd("colette", starred=True)),
    ref=[act("star", kind="person", where='role = "wedding planner"')]))

S("T09-K022", "no invention missing name ask i3skill S4",
  T("put something in my calendar for tonight", ask(),
    ref=[askc("What should the event be called, and what time?")]))

S("T09-K023", "no invention note body search read i3skill S4",
  T("which note says no shellfish", rows("menu_notes"),
    ref=[search("shellfish", kind="note"), ans(rows="$menu_notes")]))

S("T09-K024", "no invention task description search stamps i3skill S4",
  T("tick off the canada post one", diff(upd("stamps", status="completed", completed=ANY)),
    ref=[search("canada post", kind="task"), act("complete", rows="$stamps")]))

S("T09-K025", "referent event move it clock i3skill S1",
  T("when's the northvale call", rows("northvale"),
    ref=[ans(kind="event", name="Northvale")]),
  T("move it to 2", diff(upd("northvale", date="2026-05-13T14:00")),
    ref=[act("reschedule", rows="$northvale", args=lines(to=U("day", 0, anchor="row", time="14:00")))]))

S("T09-K026", "perfect since month i3skill S2",
  T("how many bar prep sessions have we done since the start of may", val(2),
    ref=[ans(kind="event", op="count", name="Bar prep session", when=J({"from": U("month", 0, name=5), "to": U("day", 0)}))]))

S("T09-K027", "read confirmed not write i3skill S3",
  T("is the dentist cleaning confirmed", rows("dentist"),
    ref=[ans(kind="event", name="Dentist cleaning")]))
