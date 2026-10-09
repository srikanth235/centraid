from gold import *

world("T05", "2026-01-20T06:40", "Priya Raman", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


OPEN = 'status = "open"'

S("T05-K001", "referent membership renew i3skill S1",
  T("what's the cult gym membership", rows("gym_card"),
    ref=[ans(kind="locker item", name="Cult gym")]),
  T("when do i need to renew it", rows("gym_card"),
    ref=[ans(rows="$gym_card")]))

S("T05-K002", "referent count narrows priority i3skill S1",
  T("how many tasks are open on the icu list", val(7),
    ref=[ans(kind="task", op="count", linked_to="$iculist", where=OPEN)]),
  T("how many are priority 1", val(2),
    ref=[ans(kind="task", op="count", linked_to="$iculist", where=OPEN + " and priority = 1")]))

S("T05-K003", "referent event people it i3skill S1",
  T("when's amma's cataract consultation", rows("cataract_1"),
    ref=[ans(kind="event", name="Amma cataract consultation")]),
  T("who's going to it", rows("amma", "rao_doc"),
    ref=[ans(kind="person", linked_to="$cataract_1")]))

S("T05-K004", "referent created task edit priority i3skill S1",
  T("add a task buy ghee for the pongal", diff(new("task", name=has("ghee"))),
    ref=[act("create", args=lines(kind="task", name="Buy ghee for the pongal"))]),
  T("set it to priority 2", diff(upd("+1", priority=2)),
    ref=[act("edit", rows="$c1", args=lines(priority=2))]))

S("T05-K005", "referent list then the noun i3skill S1",
  T("what's open on the surgery list", rows("reports", "insurance_claim", "eye_drops", "ride", "fasting"),
    ref=[ans(kind="task", linked_to="$surgerylist", where=OPEN)]),
  T("done with the drops", diff(upd("eye_drops", status="completed", completed=ANY)),
    ref=[act("complete", rows="$eye_drops")]))

S("T05-K006", "referent debt he it i3skill S1",
  T("what's the biryani bet", rows("d_suresh"),
    ref=[ans(kind="debt", name="Biryani bet")]),
  T("has he paid it", rows("d_suresh"),
    ref=[ans(rows="$d_suresh")]))

S("T05-K007", "perfect been to this month i3skill S2",
  T("how many cricket nights have i been to this month", val(1),
    ref=[ans(kind="event", op="count", name="Cricket night", when=J({"from": U("month", 0), "to": U("day", 0)}))]))

S("T05-K008", "single day friday thirtieth i3skill S2",
  T("what's on friday", rows("night_0123"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=5)))]),
  T("what about the thirtieth", rows("day_0130", "farewell"),
    ref=[ans(kind="event", when=J(D("2026-01-30")))]))

S("T05-K009", "still in february ahead i3skill S2",
  T("is the thai poosam still in february", rows("poosam"),
    ref=[ans(kind="event", name="Thai Poosam", when=J(U("month", 0, name=2)))]))

S("T05-K010", "duration hour minutes effort i3skill S2",
  T("which tasks take over an hour", rows("donor_list", "vap_poster", "passport"),
    ref=[ans(kind="task", where="effort > 60")]),
  T("and under 10 minutes", rows("water_can", "fasting"),
    ref=[ans(kind="task", where="effort < 10")]))

S("T05-K011", "cadence daily weekly i3skill S2",
  T("who's on a daily cadence", rows("amma", "appa", "karthik"),
    ref=[ans(kind="person", where="cadence = 1 days")]),
  T("and weekly", rows("paati", "divya_s", "jaya", "gopal"),
    ref=[ans(kind="person", where="cadence = 7 days")]))

S("T05-K012", "cadence two months i3skill S2",
  T("who do i only keep up with every two months", rows("anand"),
    ref=[ans(kind="person", where="cadence = 60 days")]))

S("T05-K013", "relation to event dates line i3skill S2",
  T("what's left on the temple list before the poosam", rows("volunteers", "receipts", "banner"),
    ref=[ans(kind="task", linked_to="$templelist", where=OPEN, when=J({"to": D("2026-02-01")}))]))

S("T05-K014", "read not write eb bill i3skill S3",
  T("did i pay the eb bill", rows("eb_jan", "eb_dec"),
    ref=[ans(kind="task", name="Pay EB bill")]))

S("T05-K015", "read debt pooja items i3skill S3",
  T("have i paid revathi for the pooja items", rows("d_revathi"),
    ref=[ans(kind="debt", name="Pooja items")]))

S("T05-K016", "read debt two follow i3skill S3",
  T("did karthik pay me back the visa fee", rows("d_karthik"),
    ref=[ans(kind="debt", name="Visa fee")]),
  T("and arjun's ticket", rows("d_arjun"),
    ref=[ans(kind="debt", name="Chepauk ticket")]))

S("T05-K017", "read cancelled appraisal i3skill S3",
  T("was the appraisal cancelled", rows("appraisal"),
    ref=[ans(kind="event", name="Appraisal")]))

S("T05-K018", "read then write bls i3skill S3",
  T("is the bls certificate renewed", rows("bls_cert"),
    ref=[ans(kind="task", name="Renew BLS certificate")]),
  T("fine, it's done, mark it", diff(upd("bls_cert", status="completed", completed=ANY)),
    ref=[act("complete", rows="$bls_cert")]))

S("T05-K019", "read starred of them cards i3skill S3",
  T("what cards do i have", rows("hdfc_card", "sbi_card"),
    ref=[ans(kind="locker item", where='type = "card"')]),
  T("which of them are starred", rows("hdfc_card"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T05-K020", "read returned book i3skill S3",
  T("did i return kavya's book", rows("kavya_gift"),
    ref=[ans(kind="task", name="Return Kavya's book")]))

S("T05-K021", "no invention task description search i3skill S4",
  T("tick off the corporation office one", diff(upd("tax", status="completed", completed=ANY)),
    ref=[search("corporation office", kind="task"), act("complete", rows="$tax")]))

S("T05-K022", "no invention note body search delete i3skill S4",
  T("delete the note about the biryani", diff(trash("match_bets")),
    ref=[search("biryani", kind="note"), act("delete", rows="$match_bets")]))

S("T05-K023", "no invention role house help log i3skill S4",
  T("log a message to the house help", diff(upd("selvi", date=ANY)),
    ref=[act("log", kind="person", where='role = "house help"', args=lines(kind="message"))]))

S("T05-K024", "no invention missing name ask i3skill S4",
  T("add a task for tomorrow", ask(),
    ref=[askc("What should the task be called?")]))

S("T05-K025", "no invention note body search read i3skill S4",
  T("which note says gingelly oil", rows("vathal"),
    ref=[search("gingelly oil", kind="note"), ans(rows="$vathal")]))

S("T05-K026", "referent starred row its field i3skill S1",
  T("star the hospital his login", diff(upd("his", starred=True)) if False else diff(already=["his"]),
    ref=[act("star", kind="locker item", name="Hospital HIS login"), ans(rows="$his")]),
  T("what's its username", rows("his"),
    ref=[ans(rows="$his")]))

S("T05-K027", "perfect since cue i3skill S2",
  T("how many night shifts have i already done this month", val(2),
    ref=[ans(kind="event", op="count", name="ICU night shift", when=J({"from": U("month", 0), "to": U("day", 0)}))]))

S("T05-K028", "read cancelled surgery i3skill S3",
  T("is amma's surgery cancelled", rows("cataract_2"),
    ref=[ans(kind="event", name="Amma cataract surgery")]))
