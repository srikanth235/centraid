from gold import *
import json

world("T29", "2026-09-23T18:10", "Achieng Odhiambo", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T29-K001", "decline not_found photos other kinds hint i3skill S5",
  T("any photos from the diani weekend", decline("not_found"),
    ref=[find(kind="photo", name="diani"), search("diani", kind="photo"), dec("not_found")]))

S("T29-K002", "decline order external after read i3skill S5",
  T("when's baba's birthday lunch", rows("baba_bday"),
    ref=[ans(kind="event", name="Baba's birthday lunch")]),
  T("order a cake from the bakery for it", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T29-K003", "decline weather then read saturday i3skill S5",
  T("will it rain at karura on saturday", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("what's on saturday", rows("coffee_kevin", "vet_vacc", "ride_0926"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=6)))]))

S("T29-K004", "decline email then log message is a write i3skill S5",
  T("email faith the revised drawings", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("log that i messaged her", diff(upd("faith", date=ANY)),
    ref=[act("log", rows="$faith", args=lines(kind="message"))]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T29-K101", "family word dad aunt role i3skill S6",
  T("when did i last call dad", rows("baba"),
    ref=[ans(kind="person", where='role = "dad"')]),
  T("and my aunt", rows("aunt_atieno"),
    ref=[ans(kind="person", where='role = "aunt"')]))

S("T29-K102", "iou debt both directions same person i3skill S6",
  T("any ious with wambui", rows("d_wambui_wifi", "d_wambui_tokens"),
    ref=[ans(kind="debt", linked_to="$wambui")]),
  T("and with kip", rows("d_kip"),
    ref=[ans(kind="debt", linked_to="$kip")]))

S("T29-K103", "a note about body search then what else in notebook i3skill S6",
  T("that note about the chimney", rows("karen_site3"),
    ref=[ans(kind="note", where='body contains "chimney"')]),
  T("what else is in that notebook", rows("karen_site1", "karen_site2", "runda_site1", "steel_prices", "planning_checklist"),
    ref=[ans(kind="note", linked_to="$site_nb", exclude="$karen_site3")]))

S("T29-K104", "family word brother log coffee i3skill S6",
  T("log a coffee with my brother", diff(upd("otieno", date=ANY)),
    ref=[find(kind="person", where='role = "brother"'), act("log", rows="@prev", args=lines(kind="coffee"))]))
