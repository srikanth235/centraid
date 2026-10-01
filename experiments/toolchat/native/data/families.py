"""Phrasing families: slot-bearing seed templates, one per request type.

Each family: `desc` (the gold action, for the paraphrase verifier), `reading` (the §7 intent
line; {Q} becomes '"<deciding phrase>" = ' when the template marks one with [[...]]) and seed
templates. Sonnet paraphrases families (paraphrase.py); the seeds stay in the pool.
Placeholders are UPPER-case in braces and must survive paraphrasing verbatim.
"""
from __future__ import annotations

F: dict[str, dict] = {}


def fam(fid: str, desc: str, reading: str, *templates: str) -> None:
    F[fid] = {"desc": desc, "reading": reading, "t": list(templates)}


# ---------------------------------------------------------------- reads: rows
fam("rows.frame.show", "List the {THING} (show the matching rows).", "read rows ({Q}list the rows)",
    "[[show me]] {THING}", "[[what]] {THING} do I have?", "[[list]] {THING}", "[[pull up]] {THING} please")
fam("rows.frame.any", "List the {THING} (show the matching rows, possibly none).", "read rows ({Q}list, not count)",
    "[[any]] {THING}?", "[[are there any]] {THING}?", "[[got any]] {THING}?")
fam("rows.name.task", "Show the task named {NAME}.", "read rows ({Q}show the row)",
    "[[show me]] the {NAME} task", "[[what's the status of]] {NAME}?", "[[where am I with]] the {NAME} to-do?")
fam("rows.name.event", "Show the calendar event named {NAME}.", "read rows ({Q}show the row)",
    "[[when is]] {NAME}?", "[[show me]] the {NAME} event", "[[what time is]] {NAME}?")
fam("rows.name.note", "Show the note named {NAME}.", "read rows ({Q}show the row)",
    "[[open]] my {NAME} note", "[[show me]] the note {NAME}", "[[what did I write in]] {NAME}?")
fam("rows.name.document", "Show the document named {NAME}.", "read rows ({Q}show the row)",
    "[[find]] my {NAME} document", "[[where's]] the {NAME} doc?", "[[pull up]] {NAME}")
fam("rows.name.photo", "Show the photo named {NAME}.", "read rows ({Q}show the row)",
    "[[show me]] the {NAME} photo", "[[find]] the picture called {NAME}")
fam("rows.name.person", "Show the contact named {NAME}.", "read rows ({Q}show the row)",
    "[[look up]] {NAME}", "[[what do I have on]] {NAME}?", "[[show]] {NAME}'s contact")
fam("rows.name.locker", "Show the locker entry named {NAME} (the entry itself, not its secret).",
    "read rows ({Q}the entry, not reveal)",
    "[[where's]] my {NAME} entry?", "[[find]] {NAME} in my locker", "[[do I have]] {NAME} saved?")
fam("rows.name.debt", "Show the debt named {NAME}.", "read rows ({Q}show the row)",
    "[[show me]] the {NAME} debt", "[[what's the story with]] the {NAME} IOU?")
fam("rows.name.group", "Show the group named {NAME}.", "read rows ({Q}show the row)",
    "[[show me]] the {NAME} group")
fam("rows.open", "Show everything about the {KW} {NAME}: all its facts and what it is linked to.",
    "read rows ({Q}every fact and link: open)",
    "[[tell me everything about]] {NAME}", "[[what's linked to]] the {NAME} {KW}?", "[[full details on]] {NAME}")
fam("rows.wifi", "The person types only the bare noun phrase for the wifi password, with no verb like show/tell/what is; the app shows the wifi locker entry without revealing the secret.",
    "read rows ({Q}the row, not reveal)",
    "[[wifi password]]", "[[the wifi password]]?", "[[wifi pw]] pls")
fam("rows.when.event", "List calendar events {DATE}.", "read rows ({Q}list events)",
    "[[what's on]] {DATE}?", "[[anything in my calendar]] {DATE}?", "[[what have I got on]] {DATE}")
fam("rows.when.diary", "List calendar events {DATE} (diary = calendar).", "read rows ({Q}calendar events)",
    "[[what's in my diary]] {DATE}?", "[[check my diary]] for {DATE}")
fam("rows.when.task", "List tasks due {DATE}.", "read rows ({Q}list tasks by due date)",
    "[[what's due]] {DATE}?", "[[which tasks are due]] {DATE}?", "[[what do I need to get done]] {DATE}")
fam("rows.when.photo", "List photos taken {DATE}.", "read rows ({Q}list photos by date taken)",
    "[[show me photos]] from {DATE}", "[[pics]] I took {DATE}?")
fam("rows.when.note", "List notes created {DATE}.", "read rows ({Q}list notes by date)",
    "[[notes]] I wrote {DATE}", "[[which notes]] did I make {DATE}?")
fam("rows.when.document", "List documents added {DATE}.", "read rows ({Q}list documents by date)",
    "[[which documents]] did I add {DATE}?", "[[docs]] from {DATE}")
fam("rows.when.person", "List people last contacted {DATE}.", "read rows ({Q}people by last contact)",
    "[[who did I talk to]] {DATE}?", "[[who was I last in touch with]] {DATE}?")
fam("rows.linked.photo_person", "List photos of {PERSON}.", "read rows ({Q}photos linked to a person)",
    "[[photos of]] {PERSON}", "[[show me pictures with]] {PERSON} in them")
fam("rows.linked.members", "List the people in the group {GROUP} (members).", "read rows ({Q}members = people)",
    "[[who's in]] {GROUP}?", "[[members of]] {GROUP}", "[[who's part of]] the {GROUP} group?")
fam("rows.linked.notebook", "List the notes in the notebook {NOTEBOOK}.", "read rows ({Q}notes in a notebook)",
    "[[what's in]] my {NOTEBOOK} notebook?", "[[notes in]] {NOTEBOOK}")
fam("rows.linked.folder", "List the documents in the folder {FOLDER}.", "read rows ({Q}documents in a folder)",
    "[[what's in]] the {FOLDER} folder?", "[[docs in]] {FOLDER}")
fam("rows.linked.list", "List the tasks on the list {LIST}.", "read rows ({Q}tasks on a list)",
    "[[what's on]] my {LIST} list?", "[[tasks in]] {LIST}")
fam("rows.linked.album", "List the photos in the album {ALBUM}.", "read rows ({Q}photos in an album)",
    "[[show me]] the {ALBUM} album", "[[photos in]] {ALBUM}")
fam("rows.linked.event_person", "List events with {PERSON} attending.", "read rows ({Q}events linked to a person)",
    "[[when am I seeing]] {PERSON}?", "[[events with]] {PERSON}")
fam("rows.linked.task_person", "List tasks about {PERSON}.", "read rows ({Q}tasks linked to a person)",
    "[[what do I need to do for]] {PERSON}?", "[[tasks about]] {PERSON}")
fam("rows.linked.debt_person", "List debts with {PERSON}.", "read rows ({Q}debts linked to a person)",
    "[[debts with]] {PERSON}", "[[what IOUs]] do I have with {PERSON}?")
fam("rows.linked.groups_of", "List the groups {PERSON} is a member of.", "read rows ({Q}groups linked to a person)",
    "[[which groups is]] {PERSON} in?", "[[what groups]] does {PERSON} belong to?")
fam("rows.order", "List the {THING}, ordered as said, at most as many as said.", "read rows ({Q}list)",
    "[[show me]] {THING}", "[[what are]] {THING}?")
fam("rows.multi", "List tasks and calendar events whose name includes {NAME}.", "read rows ({Q}two kinds by name)",
    "[[any tasks or events]] with {NAME}?", "[[what's on my plate]] with {NAME}, tasks and calendar?")
fam("rows.trashed.list", "List the {KWS} that are in the trash.", "read rows ({Q}trashed rows; a read)",
    "[[what's in the bin]]? {KWS} only", "[[show me deleted]] {KWS}", "[[which]] {KWS} [[did I trash]]?")
fam("rows.trashed.is", "Check whether the {KW} named {NAME} is in the trash (a question; do not restore).",
    "read rows ({Q}a question about the trash, not a restore)",
    "[[is]] the {NAME} {KW} [[in the bin]]?", "[[did I delete]] the {NAME} {KW}?", "[[is]] {NAME} [[in the trash]]?")

# ---------------------------------------------------------------- reads: values
fam("value.count", "Count the {THING}.", "read value ({Q}count)",
    "[[how many]] {THING}?", "[[how many]] {THING} do I have?", "[[number of]] {THING}?")
fam("value.sum.owed_me", "Total amount of open debts owed to me.", "read value ({Q}sum of amount)",
    "[[how much]] do people owe me?", "[[what's the total]] I'm owed?")
fam("value.sum.i_owe", "Total amount of open debts I owe.", "read value ({Q}sum of amount)",
    "[[how much]] do I owe in total?", "[[what's my total]] debt to others?")
fam("value.sum.debts_when", "Total amount of debts incurred {DATE}.", "read value ({Q}sum of amount)",
    "[[how much]] did all my debts from {DATE} come to?", "[[total]] of debts {DATE}?")
fam("value.max.debt", "The largest open debt amount owed to me.", "read value ({Q}max of amount)",
    "[[what's the biggest]] amount anyone owes me?", "[[largest]] IOU owed to me?")
fam("value.max.duration", "The longest event duration {DATE}.", "read value ({Q}max of duration)",
    "[[how long is my longest]] event {DATE}?", "[[longest]] meeting {DATE}, in minutes?")
fam("value.min.effort", "The smallest effort among open tasks.", "read value ({Q}min of effort)",
    "[[what's the quickest]] open task, effort-wise?", "[[shortest]] effort on anything still open?")
fam("value.balance.person", "My balance with {PERSON} (positive = they owe me).", "read value ({Q}balance with a person)",
    "[[what's my balance with]] {PERSON}?", "[[are]] {PERSON} and I [[square]]?", "[[does]] {PERSON} [[owe me]] anything overall?")
fam("value.balance.group", "{PERSON}'s net position in the group {GROUP}.", "read value ({Q}group balance for a person)",
    "[[where does]] {PERSON} [[stand]] in {GROUP}?", "[[what's]] {PERSON}'s [[balance]] in the {GROUP} group?")
fam("group.count", "Count the {KWS}, one number per {FIELD}.", "read value ({Q}one count per group)",
    "[[how many]] {KWS} per {FIELD}?", "[[break down]] my {KWS} by {FIELD}")

# ---------------------------------------------------------------- writes
fam("create.task", "Create a task named {NEWNAME}.", "write create ({Q}new task)",
    "[[add a task]]: {NEWNAME}", "[[remind me to]] {NEWNAME}", "[[put]] {NEWNAME} [[on my to-do list]]")
fam("create.task_date", "Create a task named {NEWNAME} due {DATE}.", "write create ({Q}new task with a due date)",
    "[[add a task]] {NEWNAME} for {DATE}", "[[remind me to]] {NEWNAME} {DATE}", "[[I need to]] {NEWNAME} {DATE}, add it")
fam("create.task_effort", "Create a task named {NEWNAME} with effort {MIN} minutes.", "write create ({Q}new task)",
    "[[add]] {NEWNAME} [[as a task]], about {MIN} minutes", "[[new to-do]]: {NEWNAME}, takes {MIN} min")
fam("create.event", "Create a calendar event named {NEWNAME} at {DATE}.", "write create ({Q}new event)",
    "[[book]] {NEWNAME} {DATE}", "[[put]] {NEWNAME} [[in my calendar]] {DATE}", "[[schedule]] {NEWNAME} for {DATE}")
fam("create.event_dur", "Create a calendar event named {NEWNAME} at {DATE} lasting {MIN} minutes.", "write create ({Q}new event)",
    "[[add]] {NEWNAME} {DATE} [[to my calendar]], {MIN} minutes", "[[block]] {MIN} min for {NEWNAME} {DATE}")
fam("create.note", "Create a note titled {NEWNAME} with the text {BODY}.", "write create ({Q}new note)",
    "[[make a note]] called {NEWNAME}: {BODY}", "[[jot down]] {NEWNAME} - {BODY}", "[[new note]] {NEWNAME}, body: {BODY}")
fam("create.person", "Create a contact named {NEWNAME}.", "write create ({Q}new person)",
    "[[add]] {NEWNAME} [[to my contacts]]", "[[save]] {NEWNAME} [[as a contact]]")
fam("create.person_role", "Create a contact named {NEWNAME} whose role is {ROLE}.", "write create ({Q}new person)",
    "[[add]] {NEWNAME}, my {ROLE}, [[to contacts]]", "[[new contact]]: {NEWNAME} ({ROLE})")
fam("create.person_nick", "Create a contact named {NEWNAME} whose nickname is {NICK}.", "write create ({Q}new person)",
    "[[add]] {NEWNAME} [[to my contacts]], goes by {NICK}", "[[new contact]]: {NEWNAME}, nickname {NICK}")
fam("create.person_cadence", "Create a contact named {NEWNAME} with a check-in cadence of {DAYS} days.",
    "write create ({Q}new person)",
    "[[add]] {NEWNAME} [[as a contact]] and remind me to check in every {DAYS} days",
    "[[new contact]] {NEWNAME}, check-in cadence {DAYS} days")
fam("create.event_desc", "Create a calendar event named {NEWNAME} at {DATE} with the description {DESC}.",
    "write create ({Q}new event)",
    "[[put]] {NEWNAME} [[in my calendar]] {DATE}, note: {DESC}", "[[schedule]] {NEWNAME} {DATE} - {DESC}")
fam("create.task_priority", "Create a task named {NEWNAME} with priority {PRIO} (1 is highest).",
    "write create ({Q}new task)",
    "[[add a task]] {NEWNAME}, priority {PRIO}", "[[new to-do]]: {NEWNAME} (priority {PRIO})")
fam("create.task_desc", "Create a task named {NEWNAME} with the description {DESC}.", "write create ({Q}new task)",
    "[[add a task]] {NEWNAME} with the note {DESC}", "[[remind me to]] {NEWNAME} - details: {DESC}")
fam("create.locker_login", "Save a new login entry named {NEWNAME} with username {USER} and website {URL}.",
    "write create ({Q}new login)",
    "[[save a login]] {NEWNAME}: username {USER}, site {URL}", "[[add]] {NEWNAME} [[to the locker]], user {USER} at {URL}")
fam("create.locker_notes", "Save a new locker entry named {NEWNAME} of type {TYPE} with the notes {NOTES}.",
    "write create ({Q}new locker item)",
    "[[save]] a {TYPE} entry {NEWNAME} [[in my locker]], notes: {NOTES}", "[[add]] {NEWNAME} ({TYPE}) [[to the locker]] - {NOTES}")
fam("create.list_area", "Create a new task list named {NEWNAME} in the area {AREA}.", "write create ({Q}new list)",
    "[[make a list]] called {NEWNAME} under {AREA}", "[[new list]] {NEWNAME}, area {AREA}")
fam("create.debt_owes_me", "Record a new debt in which {PERSON} owes ME (the speaker) {AMOUNT} for {REASON}; the wording must make clear that the other person is the one who owes.", "write create ({Q}new debt, they owe me)",
    "{PERSON} [[owes me]] {AMOUNT} for {REASON}", "[[note that]] {PERSON} [[owes me]] {AMOUNT} ({REASON})")
fam("create.debt_i_owe", "Record a new debt in which I (the speaker) owe {PERSON} {AMOUNT} for {REASON}; the wording must make clear that the speaker is the one who owes.", "write create ({Q}new debt, I owe)",
    "[[I owe]] {PERSON} {AMOUNT} for {REASON}", "[[log that I owe]] {PERSON} {AMOUNT}, {REASON}")
fam("create.locker", "Save a new locker entry named {NEWNAME} of type {TYPE}.", "write create ({Q}new locker item)",
    "[[save]] a {TYPE} entry called {NEWNAME} [[in my locker]]", "[[add]] {NEWNAME} [[to the locker]] as a {TYPE}")
fam("create.group", "Create a group named {NEWNAME} with currency {CUR}.", "write create ({Q}new group)",
    "[[start a group]] {NEWNAME} in {CUR}", "[[create]] a {CUR} [[group]] called {NEWNAME}")
fam("create.container", "Create a new {KW} named {NEWNAME}.", "write create ({Q}new container)",
    "[[make]] a new {KW} called {NEWNAME}", "[[create]] {KW} {NEWNAME}", "[[new]] {KW}: {NEWNAME}")
fam("create.document", "Add a document named {NEWNAME}.", "write create ({Q}new document)",
    "[[add a document]] called {NEWNAME}", "[[save]] {NEWNAME} [[as a new doc]]")
fam("edit.rename", "Rename the {KW} {NAME} to {NEWNAME}.", "write edit ({Q}rename)",
    "[[rename]] the {NAME} {KW} to {NEWNAME}", "[[change the name of]] {NAME} to {NEWNAME}", "[[call]] the {NAME} {KW} {NEWNAME} [[instead]]")
fam("edit.field", "Set the {FIELDWORD} of the {KW} {NAME} to {VALUE}.", "write edit ({Q}set a field)",
    "[[set]] the {FIELDWORD} of {NAME} to {VALUE}", "[[change]] {NAME}'s {FIELDWORD} to {VALUE}", "[[make]] the {NAME} {KW}'s {FIELDWORD} {VALUE}")
fam("edit.status_progress", "Set the task {NAME} to in progress.", "write edit ({Q}status in_progress)",
    "[[I've started]] {NAME}", "[[mark]] {NAME} [[as in progress]]", "[[I'm working on]] the {NAME} task now")
fam("edit.pin", "Pin the note {NAME}.", "write edit ({Q}pinned yes)",
    "[[pin]] my {NAME} note", "[[keep]] {NAME} [[at the top]] (pin it)")
fam("reschedule.abs", "Move the {KW} {NAME} to {DATE}.", "write reschedule ({Q}new date)",
    "[[move]] {NAME} to {DATE}", "[[push]] the {NAME} {KW} to {DATE}", "[[reschedule]] {NAME} for {DATE}")
fam("reschedule.shift", "Move the {KW} {NAME} {DATE} (relative to its current time).", "write reschedule ({Q}relative to the row)",
    "[[move]] {NAME} {DATE}", "[[shift]] the {NAME} {KW} {DATE}", "[[can you make]] {NAME} {DATE}?")
fam("complete", "Mark the task {NAME} as completed.", "write complete ({Q}finish) · not: read",
    "[[mark]] {NAME} [[as done]]", "[[tick off]] {NAME}", "[[I finished]] {NAME}", "{NAME} [[is done]]")
fam("reopen", "Reopen the completed task {NAME}.", "write reopen ({Q}back to open)",
    "[[reopen]] {NAME}", "[[I'm not actually done with]] {NAME}, [[put it back]]", "[[unmark]] {NAME} as done")
fam("cancel", "Cancel the calendar event {NAME}.", "write cancel ({Q}cancel the event)",
    "[[cancel]] {NAME}", "[[call off]] the {NAME}", "{NAME} [[isn't happening]] any more, cancel it")
fam("delete", "Delete (move to trash) the {KW} {NAME}.", "write delete ({Q}to the trash)",
    "[[delete]] the {NAME} {KW}", "[[bin]] {NAME}", "[[get rid of]] the {KW} {NAME}", "[[trash]] {NAME}")
fam("restore", "Restore the {KW} {NAME} from the trash.", "write restore ({Q}back from the trash)",
    "[[restore]] the {NAME} {KW}", "[[bring back]] {NAME} [[from the bin]]", "[[undelete]] {NAME}")
fam("star", "Star (favourite) the {KW} {NAME}.", "write star ({Q}star)",
    "[[star]] {NAME}", "[[favourite]] the {NAME} {KW}", "[[mark]] {NAME} [[as a favourite]]")
fam("unstar", "Unstar the {KW} {NAME}.", "write unstar ({Q}remove the star)",
    "[[unstar]] {NAME}", "[[take]] {NAME} [[off my favourites]]", "[[remove the star from]] the {NAME} {KW}")
fam("add_to", "Add the {KW} {NAME} to the {CKW} {CONTAINER}.", "write add_to ({Q}add to a container)",
    "[[add]] {NAME} [[to]] {CONTAINER}", "[[put]] the {NAME} {KW} [[in]] {CONTAINER}", "[[file]] {NAME} [[under]] {CONTAINER}")
fam("remove_from", "Remove the {KW} {NAME} from the {CKW} {CONTAINER}.", "write remove_from ({Q}out of a container)",
    "[[take]] {NAME} [[out of]] {CONTAINER}", "[[remove]] the {NAME} {KW} [[from]] {CONTAINER}")
fam("log", "Log a {LOGKIND} with {PERSON}.", "write log ({Q}log an interaction)",
    "[[log a]] {LOGKIND} [[with]] {PERSON}", "[[I just had a]] {LOGKIND} with {PERSON}, log it", "[[record]] {LOGKIND} with {PERSON}")
fam("settle_up", "Settle up {PERSON}'s balance in the group {GROUP}.", "write settle_up ({Q}settle the group balance)",
    "[[settle up with]] {PERSON} in {GROUP}", "{PERSON} and I [[are square]] on {GROUP} now, settle it")
fam("settle_debt", "Mark the debt {NAME} as settled.", "write settle_debt ({Q}debt paid)",
    "[[settle]] the {NAME} debt", "the {NAME} IOU [[is paid]]", "[[mark]] {NAME} [[as paid back]]")
fam("reveal", "Reveal the {FIELDWORD} of the locker entry {NAME}.", "write reveal ({Q}show the secret)",
    "[[show me]] the {FIELDWORD} for {NAME}", "[[what's the]] {FIELDWORD} [[of]] {NAME}?", "[[reveal]] {NAME}'s {FIELDWORD}")
fam("bulk.complete", "Mark every task due {DATE} as completed.", "write complete ({Q}every matching task)",
    "[[mark]] everything due {DATE} [[as done]]", "[[tick off]] all tasks due {DATE}", "[[I finished]] all of {DATE}'s tasks")
fam("bulk.star", "Star every photo of {PERSON}.", "write star ({Q}every matching photo)",
    "[[star]] all the photos of {PERSON}", "[[favourite]] every picture with {PERSON}")
fam("bulk.delete", "Delete every photo taken {DATE}.", "write delete ({Q}every matching photo)",
    "[[delete]] all photos from {DATE}", "[[bin]] every picture I took {DATE}")

# ---------------------------------------------------------------- multi-step
fam("multi.two", "Do both: {ACT1}; and {ACT2}.", "write, two changes ({Q}two writes)",
    "{ACT1} [[and]] {ACT2}", "{ACT1}, [[then]] {ACT2}", "{ACT1}. [[Also]] {ACT2}")
fam("multi.same", "Apply the same change to both: {VERBPHRASE} {NAME} and {NAME2}.", "write, one verb on two rows ({Q}both)",
    "{VERBPHRASE} {NAME} [[and]] {NAME2}", "{VERBPHRASE} [[both]] {NAME} and {NAME2}")
fam("multi.act_answer", "Mark the task {NAME} done, then list the open tasks due {DATE}.", "write then read ({Q}act, then answer)",
    "[[mark]] {NAME} done [[and tell me what's left]] {DATE}", "{NAME} is finished - [[what else is still open]] {DATE}?")

# ---------------------------------------------------------------- dialogue
fam("settle.pick", "(Answering the assistant's question about which one) the one called {CHOICE}.", "answer to my question ({Q}settles it)",
    "[[the]] {CHOICE} one", "{CHOICE}", "[[I meant]] {CHOICE}", "[[sorry]], {CHOICE}")
fam("never_mind", "(After the assistant asked which one) the person drops the request.", "drop ({Q}never mind)",
    "[[never mind]]", "[[forget it]]", "[[actually don't worry]] about it", "[[nvm]]")
fam("undo", "Undo the changes made in the previous turn.", "write undo ({Q}revert the previous turn)",
    "[[undo that]]", "[[I didn't mean that]], undo", "[[wait]], [[revert]] that")
fam("follow.narrow", "Of the rows just shown, only the ones {COND}.", "read rows ({Q}narrow the last result)",
    "[[just]] the ones {COND}", "[[only]] those {COND}?", "[[filter that to]] the ones {COND}")
fam("follow.subst", "Same question as before, but for {NEWVAL} instead.", "same read, one slot replaced ({Q}substitution)",
    "[[and]] {NEWVAL}?", "[[what about]] {NEWVAL}?", "[[same for]] {NEWVAL}")
fam("follow.also", "Same change as before, also applied to {NAME}.", "same write, new target ({Q}correction adds)",
    "[[oh and]] {NAME} too", "[[also]] {NAME}", "[[same for]] {NAME}")

# ---------------------------------------------------------------- declines (category families: the paraphraser
# writes NEW requests of the same category; the verifier checks the category)
CATEGORY = {"decline.out_of_scope", "decline.destroy", "decline.egress", "decline.fabricate"}
fam("decline.out_of_scope", "A request about something outside the person's own vault data (web facts, bookings, "
    "devices, general chat); the app declines as out of scope.", "decline ({Q}outside the vault)",
    "book me a flight to Lisbon", "what's the weather tomorrow", "write me a poem about autumn",
    "translate good morning into Japanese", "order a pizza", "what's the capital of Peru", "play some jazz",
    "how do I fix a flat tyre", "set an alarm for 6am", "call an uber", "tell me a joke",
    "who won the match last night", "recommend a good sci-fi novel", "turn off the living room lights")
fam("decline.destroy", "Delete everything of a whole category, or the whole vault, with no specific target "
    "(unbounded destruction); the app declines.", "decline ({Q}unbounded destruction)",
    "delete everything in my vault", "wipe all my notes", "erase every photo I have", "clear out all my contacts",
    "delete all my documents", "nuke the whole calendar", "remove every task, all of them")
fam("decline.egress", "Send or post a stored secret (password, card, login details) of {NAME} outside the vault "
    "(sealed egress); the app declines.", "decline ({Q}a secret leaves the vault)",
    "email my {NAME} password to my brother", "text the {NAME} details to my landlord",
    "post my {NAME} password in the family group chat", "send {NAME} to my work email")
fam("decline.fabricate", "Make up or guess a secret for {NAME} that is not stored (fabricated secret); the app declines.",
    "decline ({Q}would invent a secret)",
    "make up a password for {NAME} and save it as the real one", "guess the PIN for {NAME}",
    "just invent a card number for {NAME}", "fill in a fake password for {NAME}")
