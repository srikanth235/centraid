from gold import *
import json

world("C", "2027-02-01T07:50", "Hana Sato", "eval")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("C-E043", "trashed person find restore-refused create",
  T("what was kyle the recruiter's role again, he messaged me twice around the end of november", rows("recruiter"),
    ref=[find(kind="person", name="Kyle"),
         ans(rows="$recruiter")]),
  T("bring him back", decline("out_of_scope"),
    ref=[bad(act("restore", rows="$recruiter")),
         dec("out_of_scope")]),
  T("fine, and delete sam ferreira from my contacts, we switched vets", diff(trash("vet")),
    ref=[act("delete", kind="person", name="Sam Ferreira")]))

S("C-E044", "trashed note find restore-refused create",
  T("what did the moving boxes note say, the one from the end of november", rows("oldnote_c"),
    ref=[find(kind="note", name="moving boxes"),
         ans(kind="note", name="moving boxes", trashed=True)]),
  T("restore it, i need that number", decline("out_of_scope"),
    ref=[bad(act("restore", rows="$oldnote_c")),
         dec("out_of_scope")]),
  T("ok new note then, moving boxes, 23 boxes total", diff(new("note", name=has("moving", "boxes"), body=has("23"))),
    ref=[act("create", args="kind: note\nname: Moving boxes\nbody: 23 boxes total")]))

S("C-E045", "trashed multi-kind list restore",
  T("what's in the trash, everything from the last couple of months", rows("recruiter", "chris", "trashed_t", "oldnote_c", "old_c", "trash_ph"),
    ref=[ans(kind="person,event,task,note,document,photo,locker item", trashed=True)]),
  T("restore the yoga one", diff(restore("trashed_t")),
    ref=[act("restore", kind="task", trashed=True, name="yoga")]),
  T("and the screenshot", diff(restore("trash_ph")),
    ref=[act("restore", kind="photo", trashed=True, name="screenshot")]),
  T("what's left in there", rows("recruiter", "chris", "oldnote_c", "old_c"),
    ref=[ans(kind="person,event,task,note,document,photo,locker item", trashed=True)]))

S("C-E046", "event delete read restore reschedule",
  T("delete the valentine's dinner, we're away that weekend", diff(trash("valentines")),
    ref=[act("delete", kind="event", name="Valentine's dinner")]),
  T("anything on the fourteenth", rows(),
    ref=[ans(kind="event", when=W(D("2027-02-14")))]),
  T("actually we're back, bring it back", diff(restore("valentines")),
    ref=[act("restore", kind="event", trashed=True, name="Valentine's dinner")]),
  T("make it eight in the evening", diff(upd("valentines", date="2027-02-14T20:00")),
    ref=[act("reschedule", rows="$valentines", args=lines(to=D("2027-02-14", "20:00")))]))

S("C-E047", "locker create edit star type",
  T("save my gym membership, planet fitness", diff(new("locker item", name=has("planet"), type="membership")),
    ref=[act("create", args="kind: locker item\nname: Planet Fitness\ntype: membership")]),
  T("member number is 88213, put that in the notes", diff(upd("+1", notes=has("88213"))),
    ref=[act("edit", rows="$c1", args="notes: member number 88213")]),
  T("star it", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("which ones are memberships, just the two or three that i pay for", rows("miles", "+1"),
    ref=[ans(kind="locker item", where="type = membership")]),
  T("actually delete the planet fitness one, scrap that entry completely", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("C-E048", "locker edit username reveal note-content",
  T("what's the chase username, the bank locked me out again", rows("chase_c"),
    ref=[ans(kind="locker item", name="Chase")]),
  T("change it to hsato2", diff(upd("chase_c", username="hsato2")),
    ref=[act("edit", rows="$chase_c", args="username: hsato2")]),
  T("read me the building door code", diff(reveal=[("door", "front door 4C")]),
    ref=[act("reveal", kind="locker item", name="door code", args="field: content")]),
  T("and star the n26 account, the berlin one i check every week", diff(upd("n26", starred=True)),
    ref=[act("star", kind="locker item", name="N26")]))

S("C-E049", "locker delete restore reveal",
  T("get rid of the visa card entry", diff(trash("visa_c")),
    ref=[act("delete", kind="locker item", name="Visa card")]),
  T("no wait, bring it back", diff(restore("visa_c")),
    ref=[act("restore", kind="locker item", trashed=True, name="Visa card")]),
  T("how many entries are in the locker", val(10),
    ref=[ans(op="count", kind="locker item")]))

S("C-E050", "locker passport identity starred",
  T("when does my passport expire", rows("passport_jp"),
    ref=[search("passport", kind="locker item"), ans(rows="@prev")]),
  T("star my card, the one i use at the shops", ask("greencard_lk", "visa_c"),
    ref=[act("star", kind="locker item", name="card"),
         find(kind="locker item", name="card"),
         askc("Green card or Visa card?", options="@prev")]),
  T("unstar the home wifi, it's cluttering my favourites", diff(upd("wifi_c", starred=False)),
    ref=[act("unstar", kind="locker item", name="Home wifi")]))

S("C-E051", "debt create balance person",
  T("dev bought my coffee, so i owe him six dollars", diff(new("debt", name=has("coffee"), amount=6, direction="i_owe"), link("new", "dev")),
    ref=[act("create", args="kind: debt\nname: coffee\namount: 6\ndirection: i_owe\nperson: $dev")]),
  T("so where am i with dev now", val((-57, "USD")),
    ref=[ans(op="balance", kind="person", rows="$dev")]),
  T("what do i owe people", rows("dev_rope", "anna_lessons", "+1"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]))

S("C-E052", "debt settle sum max",
  T("alex paid me for the shoes, who's left", rows("sophie_tix", "priya_lunch", also=diff(upd("alexm_shoes", status="settled"))),
    ref=[act("settle_debt", kind="debt", name="shoes", more=True),
         ans(kind="debt", where="direction = owes_me and status = open")]),
  T("and what do i owe", rows("dev_rope", "anna_lessons"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("total owed to me, the whole lot up to now", val((91.75, "USD")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open")]),
  T("and the biggest one of those, how much", val((75, "USD")),
    ref=[comp(op="max", field="amount", kind="debt", where="direction = owes_me and status = open"),
         ans(value="@prev")]))

S("C-E053", "balance multi-currency group settle_up",
  T("where am i with lukas", val((12000, "JPY"), (26, "GBP"), (872.6, "USD")),
    ref=[ans(op="balance", kind="person", name="Lukas")]),
  T("just the household one", val((-872.6, "USD")),
    ref=[ans(op="balance", kind="group", name="Home", linked_to="$lukas")]),
  T("settle that up, he just transferred it", diff(settle=[("Lukas Brandt", "872.60")]),
    ref=[act("settle_up", rows="$lukas", args="group: $home")]))

S("C-E054", "events cancel undo-not-undone read",
  T("cancel the vet, mochi's better so there's no need", diff(upd("vet_ev", status="cancelled")),
    ref=[act("cancel", kind="event", name="vet")]),
  T("and the call tonight with okaasan", diff(upd("okaasan_call", status="cancelled")),
    ref=[act("cancel", kind="event", name="okaasan")]),
  T("no wait, undo that", diff(),
    ref=[act("undo")]),
  T("what's still on today", rows("okaasan_call"),
    ref=[ans(kind="event", when=W(U("day", 0)))]))

S("C-E055", "event duration where description edit",
  T("which things this week run longer than an hour", rows("climb13", "interviews"),
    ref=[ans(kind="event", where="duration > 60", when=W(U("week", 0)))]),
  T("what's the vet one for, the upcoming appointment i mean", rows("vet_ev"),
    ref=[ans(kind="event", name="vet", when=W({"from": U("day", 0)}))]),
  T("change it to say dental cleaning plus booster", diff(upd("vet_ev", description=has("booster"))),
    ref=[act("edit", rows="$vet_ev", args="description: Mochi the cat, dental cleaning plus booster")]))
