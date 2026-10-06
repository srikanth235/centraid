from gold import *

import json

world("T37", "2027-03-09T10:40", "Liam O'Brien", "train")

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T37-103-P", "date-window ordinal past-tense the-4th substitution the-7th then past-perfect count from-on then last-year para",
  T("events on the 4th?", rows("bookclub_mar"),
    ref=[ans(kind="event", when=W(D("2027-03-04")))]),
  T("7th?", rows("calldec_0307"),
    ref=[ans(kind="event", when=W(D("2027-03-07")))]),
  T("calls with dec since february began, count", val(4),
    ref=[ans(op="count", kind="event", name="call declan", where="status != cancelled",
             when=W({"from": U("month", 0, name=2), "to": U("day", 0)}))]),
  T("last year's added documents",
    rows("pension_stmt25", "house_ins26", "boiler_cert", "boston_tickets", "tax_2025", "passport_scan", "gaa_constitution"),
    ref=[ans(kind="document", when=W(U("year", -1)))]))

S("T37-107-P", "mixed body-append note edit jot-down open-then-edit para",
  T("u12 squad note contents?", rows("gaa_u12"),
    ref=[opn("$gaa_u12"), ans(rows="$gaa_u12")]),
  T("add to the u12 note that the new bibs come friday",
    diff(upd("gaa_u12", body=has("twenty two players", "bibs"))),
    ref=[act("edit", rows="$gaa_u12",
             args="body: twenty two players, six new this year, Eoin's lad is the best with the hurl, new bibs come friday")]))
