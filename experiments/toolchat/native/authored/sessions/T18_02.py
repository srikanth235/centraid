from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T18-026", "five turns lease folder remove_from multi refused delete ask never_mind month",
  T("what's in the lease folder", rows("lease", "bond", "condition"),
    ref=[ans(kind="document", linked_to="$lease_f")]),
  T("take the bond lodgement and condition report out, they're in the lease pdf",
    diff(unlink("lease_f", "bond"), unlink("lease_f", "condition")),
    ref=[act("remove_from", rows="$bond, $condition", args=lines(from_="$lease_f"))]),
  T("then delete the folder", ask(),
    ref=[bad(act("delete", rows="$lease_f")),
         askc("the lease agreement is still in there, so the folder can't go. what do you want to do with it?")]),
  T("nah leave it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what docs did i add in feb", rows("rev_split", "deck", "pet_ins", "budget", "guests", "invite_doc", "scan"),
    ref=[ans(kind="document", when=W(U("month", 0, name=2)))]))

S("T18-027", "coop folder remove_from multi create folder add_to new",
  T("what's in co-op admin", rows("agreement", "rev_split", "deck", "steam_contract", "grant"),
    ref=[ans(kind="document", linked_to="$coop_f")]),
  T("pull the grant application and the steam agreement out of there",
    diff(unlink("coop_f", "grant"), unlink("coop_f", "steam_contract")),
    ref=[act("remove_from", rows="$grant, $steam_contract", args=lines(from_="$coop_f"))]),
  T("make a folder called Contracts", diff(new("folder", name="Contracts")),
    ref=[act("create", args=lines(kind="folder", name="Contracts"))]),
  T("put the steam one in it", diff(link("+1", "steam_contract")),
    ref=[act("add_to", rows="$steam_contract", args=lines(to="$c1"))]))

S("T18-028", "document span date datetime star already read",
  T("what docs did i make between feb sixteenth and the twenty-fourth at 5pm", rows("rev_split", "guests", "deck"),
    ref=[ans(kind="document", when=W(span(D("2026-02-16"), D("2026-02-24", "17:00"))))]),
  T("star the pitch deck", diff(already=["deck"]),
    ref=[act("star", rows="$deck"), ans(rows="$deck")]),
  T("ok star the revenue split sheet", diff(upd("rev_split", starred=True)),
    ref=[act("star", rows="$rev_split")]))

S("T18-029", "document span date rel open to date",
  T("docs from the twentieth through this week", rows("deck", "invite_doc", "scan"),
    ref=[ans(kind="document", when=W(span(D("2026-02-20"), U("week", 0))))]),
  T("and anything from before 2025", rows("abn", "microchip"),
    ref=[find(kind="document", when=W({"to": D("2024-12-31")})), ans(rows="@prev")]))

S("T18-030", "document named month span within star count",
  T("list every doc from january to february", rows("grant", "char_sheet", "rev_split", "deck", "pet_ins",
                                                   "budget", "guests", "invite_doc", "scan"),
    ref=[ans(kind="document", when=W(span(U("month", 0, name=1), U("month", 0, name=2))))]),
  T("which of those are starred", rows("deck"),
    ref=[ans(within="@prev", kind="document", where="starred = yes")]),
  T("star the pet insurance policy too", diff(upd("pet_ins", starred=True)),
    ref=[act("star", rows="$pet_ins")]),
  T("how many starred docs have i got", val(4),
    ref=[ans(op="count", kind="document", where="starred = yes")]))

S("T18-031", "album photos unstar multi remove_from multi count",
  T("what's in shower ideas", rows("s_cake", "s_arch", "s_tess"),
    ref=[ans(kind="photo", linked_to="$shower_al")]),
  T("unstar the cake and balloon ones, chloe's already picked", diff(upd("s_cake", starred=False), upd("s_arch", starred=False)),
    ref=[act("unstar", rows="$s_cake, $s_arch")]),
  T("and take them both out of the album", diff(unlink("shower_al", "s_cake"), unlink("shower_al", "s_arch")),
    ref=[act("remove_from", rows="$s_cake, $s_arch", args=lines(from_="$shower_al"))]),
  T("how's many left in it", val(1),
    ref=[ans(op="count", kind="photo", linked_to="$shower_al")]))

S("T18-032", "biscuit album february remove_from multi undo link",
  T("biscuit album pics from feb", rows("b_couch", "b_class", "b_bday", "b_vet", "b_creek"),
    ref=[ans(kind="photo", linked_to="$biscuit_al", when=W(U("month", 0, name=2)))]),
  T("take the vet one and the training class one out", diff(unlink("biscuit_al", "b_vet"), unlink("biscuit_al", "b_class")),
    ref=[act("remove_from", rows="$b_vet, $b_class", args=lines(from_="$biscuit_al"))]),
  T("undo that", diff(link("biscuit_al", "b_vet"), link("biscuit_al", "b_class")),
    ref=[act("undo")]))

S("T18-033", "photos open from datetime star multi unstar multi",
  T("pics since thursday 5pm", rows("screenshot", "m_map", "whiteboard", "b_creek"),
    ref=[ans(kind="photo", when=W({"from": U("week", 0, weekday=4, time="17:00")}))]),
  T("star the battle map and the whiteboard one", diff(upd("m_map", starred=True), upd("whiteboard", starred=True)),
    ref=[act("star", rows="$m_map, $whiteboard")]),
  T("nah unstar both", diff(upd("m_map", starred=False), upd("whiteboard", starred=False)),
    ref=[act("unstar", rows="$m_map, $whiteboard")]))

S("T18-034", "linked_to all photos tess mum within starred",
  T("photos with both tess and mum in them", rows("xmas", "markets", "baking"),
    ref=[search("mum", kind="person"), ans(kind="photo", linked_to="$tess, $mum")]),
  T("which of those are starred", rows("xmas"),
    ref=[ans(within="@prev", kind="photo", where="starred = yes")]),
  T("star the markets one, want it for the shower slideshow", diff(upd("markets", starred=True)),
    ref=[act("star", rows="$markets")]))

S("T18-035", "linked_to all photos bex marcus star read",
  T("any pics with bex and marcus together", rows("m_party", "m_tpk"),
    ref=[search("bex", kind="person"), ans(kind="photo", linked_to="$bex, $marcus")]),
  T("star the lineup one", diff(upd("m_party", starred=True)),
    ref=[act("star", rows="$m_party")]),
  T("what's starred in d&d minis", rows("m_dragon", "m_tpk", "m_party"),
    ref=[ans(kind="photo", linked_to="$minis_al", where="starred = yes")]))

S("T18-037", "photo person count zero month delete named",
  T("feb photos with nobody tagged in them",
    rows("b_couch", "b_class", "b_creek", "m_dragon", "s_cake", "s_arch", "yarra", "whiteboard", "receipt_p", "screenshot"),
    ref=[find(kind="photo", when=W(U("month", 0, name=2)), where="person count = 0"), ans(rows="@prev")]),
  T("delete the pizza receipt", diff(trash("receipt_p")),
    ref=[act("delete", kind="photo", name="Pizza receipt")]))

S("T18-038", "photo person count one tag add",
  T("which pics have exactly one person tagged", rows("pax_rhys", "pax_ana", "m_map", "s_tess", "v4", "zoe_rumi", "b_vet"),
    ref=[ans(kind="photo", where="person count = 1")]),
  T("how many of those are from this year", val(5),
    ref=[ans(op="count", within="@prev", kind="photo", when=W(U("year", 0)))]))

S("T18-039", "album photo count empty album delete",
  T("which albums have more than four photos", rows("biscuit_al", "pax_al"),
    ref=[find(kind="album", where="photo count > 4"), ans(rows="@prev")]),
  T("and are any empty", rows("tassie_al"),
    ref=[ans(kind="album", where="photo count = 0")]),
  T("delete that one, trip's off", diff(gone("tassie_al")),
    ref=[act("delete", rows="$tassie_al")]))

S("T18-040", "locker edit named notes",
  T("update the notes on Northside Boulders membership: renews in july",
    diff(upd("gym", notes=has("July"))),
    ref=[act("edit", rows="$gym", args=lines(notes="renews in July"))]))

S("T18-041", "locker edit named rename wifi reveal",
  T("rename Home wifi to Brunswick wifi", diff(upd("wifi", name="Brunswick wifi")),
    ref=[act("edit", rows="$wifi", args=lines(name="Brunswick wifi"))]),
  T("what's the password on it, nadia needs it", diff(reveal=[("wifi", "biscuit-kelpie-5")]),
    ref=[act("reveal", rows="$wifi", args=lines(field="password"))]))

S("T18-042", "locker delete multi",
  T("delete itch.io and the old eth wallet from the locker", diff(trash("itch"), trash("eth")),
    ref=[act("delete", rows="$itch, $eth")]))

S("T18-043", "four turns logins delete multi undo restore delete named",
  T("show me every login i've got stored", rows("steamworks", "itch", "github", "mygov"),
    ref=[ans(kind="locker item", where='type = "login"')]),
  T("get rid of github and itch", diff(trash("github"), trash("itch")),
    ref=[act("delete", rows="$github, $itch")]),
  T("undo, need github for the ci", diff(restore("github"), restore("itch")),
    ref=[act("undo")]),
  T("just itch then", diff(trash("itch")),
    ref=[act("delete", rows="$itch")]))

S("T18-044", "locker read reveal prev",
  T("where's my laptop login", rows("laptop"),
    ref=[ans(kind="locker item", name="Laptop login")]),
  T("what's the password", diff(reveal=[("laptop", "Glass-Orchard-7")]),
    ref=[act("reveal", rows="@prev", kind="locker item", args=lines(field="password"))]))

S("T18-045", "locker find reveal prev code",
  T("find my github login", rows("github"),
    ref=[ans(kind="locker item", name="GitHub")]),
  T("gimme the 2fa code on it, new laptop", diff(reveal=[("github", "JBSW-Y3DP-EHPK")]),
    ref=[act("reveal", rows="@prev", kind="locker item", args=lines(field="code"))]),
  T("change the github password to something stronger while you're at it", ask(),
    ref=[askc("what do you want the new password to be?")]))

S("T18-046", "notebook where note count read delete where",
  T("any notebooks with nothing in them", rows("jam_nb"),
    ref=[find(kind="notebook", where="note count = 0"), ans(rows="@prev")]),
  T("delete whichever notebook is empty", diff(gone("jam_nb")),
    ref=[act("delete", kind="notebook", where="note count = 0")]))

S("T18-047", "delete notebook where undo notebook not undone",
  T("clear out any notebook that has no notes", diff(gone("jam_nb")),
    ref=[act("delete", kind="notebook", where="note count = 0")]),
  T("hmm undo that", diff(),
    ref=[act("undo")]),
  T("fine. make a new one called Jam ideas 2026", diff(new("notebook", name="Jam ideas 2026")),
    ref=[act("create", args=lines(kind="notebook", name="Jam ideas 2026"))]))

S("T18-048", "edit list where area rename read",
  T("rename the pets list to Biscuit stuff", diff(upd("dog_l", name="Biscuit stuff")),
    ref=[act("edit", kind="list", where='area = "pets"', args=lines(name="Biscuit stuff"))]),
  T("what's open on biscuit stuff", rows("dog_food", "flea", "pet_ins_t", "nails"),
    ref=[ans(kind="task", linked_to="$dog_l", where='status = "open"')]),
  T("move the co-op sprint review to 4pm", ask(),
    ref=[act("reschedule", kind="event", name="Co-op sprint review", args=lines(to=U("hour", 1, anchor="row"))),
         askc("it's every friday, which one do you mean?")]))

S("T18-049", "edit list where area is set",
  T("the list tagged hobby, change its area to games", diff(upd("dnd_l", area="games")),
    ref=[act("edit", kind="list", where='area = "hobby"', args=lines(area="games"))]),
  T("which lists have an area at all", rows("dev_l", "shower_l", "dog_l", "dnd_l"),
    ref=[find(kind="list", where="area is set"), ans(rows="@prev")]))

S("T18-050", "list area is set empty area read",
  T("lists without an area", rows("home_l", "admin_l"),
    ref=[find(kind="list", where="area is empty"), ans(rows="@prev")]),
  T("and the ones with one", rows("dev_l", "shower_l", "dog_l", "dnd_l"),
    ref=[ans(kind="list", where="area is set")]),
  T("set admin's area to life admin", diff(upd("admin_l", area="life admin")),
    ref=[act("edit", rows="$admin_l", args=lines(area="life admin"))]),
  T("do i have anything about a pottery class", decline("not_found"),
    ref=[search("pottery"), dec("not_found")]))
