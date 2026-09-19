"""Request templates per operation, written in varied registers.

Registers deliberately mixed inside every operation's list: terse ("due
today?"), chatty ("hey, could you pull up ..."), indirect ("I can never
remember when ..."), and imperative. Typos are added mechanically by the
generator rather than written in, so every template stays readable.

Templates whose wording deliberately borrows a *sibling's* frame while keeping
the discriminating cue are marked by a leading "!" and counted as sibling hard
negatives: ``tasks_about`` phrased like ``tasks_due``, ``photos_at_place``
phrased like ``photos_in_album``, and so on. The point is that surface frame
alone must not decide the label.

Placeholders are slot names resolved against ``world_synthetic``.
"""

from __future__ import annotations

TEMPLATES: dict[str, list[str]] = {
    # ------------------------------------------------------------- agenda
    "agenda_upcoming": [
        "what's on my calendar {window}",
        "anything scheduled {window}",
        "show me my schedule {window}",
        "calendar {window}?",
        "hey, can you pull up what I've got {window}",
        "do I have anything booked {window}",
        "give me the {calendar} calendar {window}",
        "I can never remember what's coming up — what do I have {window}",
        "!find everything on the calendar {window}",
        "am I free {window}",
        "run me through {window}",
    ],
    "agenda_search": [
        "when is the {event}",
        "find the {event} on my calendar",
        "look up the {event}",
        "search my calendar for the {event}",
        "what date was the {event} again",
        "do I have a {event} booked anywhere",
        "dig out the {event}",
        "!what's on the calendar about the {event}",
        "remind me when the {event} is",
        "hunt down the {event} in my diary",
    ],
    "agenda_day_context": [
        "what does {window} look like",
        "give me the full picture for {window}",
        "walk me through {window} — everything, tasks included",
        "brief me on {window}",
        "how busy am I {window}, tasks and all",
        "what's my day like {window}",
        "!everything happening {window}, including what's due",
        "rundown for {window} please",
        "summarise {window} for me",
    ],
    "people_at": [
        "who's coming to the {event}",
        "who was at the {event}",
        "guest list for the {event}?",
        "who's invited to the {event}",
        "tell me who's going to the {event}",
        "!look up the attendees of the {event}",
        "who did I sit with at the {event}",
        "who else is on the {event}",
        "attendees for the {event}",
    ],
    "agenda_create_event": [
        "put a {event} on my calendar {time}",
        "book a {event} {time}",
        "schedule the {event} for {date}",
        "add {event} {time} with {person}",
        "can you set up a {event} with {person} {date}",
        "new event: {event}, {time}",
        "pencil in the {event} for {date}",
        "I need a {event} on the calendar {date}",
        "!create a {event} {time}",
    ],
    "agenda_reschedule": [
        "move the {event} to {date}",
        "push the {event} back to {date}",
        "can we shift the {event} to {date}",
        "reschedule the {event} for {date}",
        "the {event} needs to move — make it {date}",
        "change the time of the {event} to {time}",
        "!bump the {event} to {date}",
        "shift {event} to {date} please",
    ],
    "agenda_cancel_event": [
        "cancel the {event}",
        "drop the {event} from my calendar",
        "the {event} is off, take it off",
        "delete the {event}",
        "kill the {event}",
        "we're not doing the {event} anymore, remove it",
        "!scrap the {event} on my calendar",
        "call off the {event}",
    ],
    "agenda_attendee_add": [
        "add {person} to the {event}",
        "invite {person} to the {event}",
        "can you get {person} on the {event}",
        "{person} should be at the {event} too",
        "pull {person} into the {event}",
        "!put {person} on the guest list for the {event}",
        "loop {person} into the {event}",
    ],
    # -------------------------------------------------------------- tasks
    "tasks_due": [
        "what's due {due}",
        "anything due {due}",
        "is anything overdue",
        "show me my tasks for {due}",
        "what do I need to get done {due}",
        "todo list for {due}?",
        "!what's on my list {due}",
        "am I behind on anything",
        "hey what's sitting on my plate {due}",
        "tasks {due}",
    ],
    "tasks_about": [
        "do I have any tasks about {topic}",
        "anything on my list to do with {topic}",
        "find the task about {topic}",
        "!what's on my list about {topic}",
        "is there a todo for {topic} somewhere",
        "search my tasks for {topic}",
        "did I write down anything to do about {topic}",
        "tasks mentioning {topic}",
        "any todos about {topic} kicking around",
    ],
    "tasks_by_project": [
        "what's left in the {project} project",
        "show me the {project} tasks",
        "what's outstanding under {project}",
        "!what's on my list in {project}",
        "tasks filed under {project}",
        "how much is left on {project}",
        "open items for {project}",
        "give me everything in the {project} bucket",
    ],
    "tasks_for_people": [
        "what's assigned to {person}",
        "what tasks does {person} have",
        "what are the {company} people on the hook for",
        "which todos belong to {person}",
        "!show me the tasks for the people at {company}",
        "what did I give {person} to do",
        "anything sitting with {person}",
    ],
    "tasks_add": [
        "add a task to {task}",
        "remind me to {task} by {date}",
        "new todo: {task}",
        "put {task} on my list for {date}",
        "I need to {task}, add that",
        "!create a task to {task} under {project}",
        "jot down a task to {task}",
        "can you add {task} to the {project} project",
    ],
    "tasks_complete": [
        "mark {task} done",
        "tick off {task}",
        "{task} is done",
        "I finished {task}, close it",
        "check off the {task} one",
        "!complete the task to {task}",
        "done with {task}",
    ],
    "tasks_set_due": [
        "push {task} to {date}",
        "move the {task} task to {date}",
        "change the due date on {task} to {date}",
        "{task} needs to be done by {date} instead",
        "!reschedule {task} for {date}",
        "make {task} due {date}",
        "shift the deadline for {task} to {date}",
    ],
    "tasks_assign": [
        "give {task} to {person}",
        "assign the {task} task to {person}",
        "{person} should take {task}",
        "hand {task} over to {person}",
        "!put {person} on the {task} task",
        "can {person} own {task}",
    ],
    # ------------------------------------------------------------- people
    "people_find": [
        "do I have {person} in my contacts",
        "look up {person}",
        "find {person} in my people",
        "search my contacts for {person}",
        "!who is {person}",
        "have I got a record for {person}",
        "pull up {person}",
    ],
    "people_profile": [
        "what's {person}'s email",
        "show me {person}'s details",
        "what do I have on {person}",
        "{person}'s phone number?",
        "!look up {person}'s record",
        "when is {person}'s birthday",
        "give me everything I've stored about {person}",
    ],
    "people_at_company": [
        "who do I know at {company}",
        "list my contacts at {company}",
        "anyone in my contacts from {company}",
        "!find the {company} people",
        "who's my contact at {company}",
        "everyone at {company} in my vault",
        "how many people do I know at {company}",
    ],
    "people_add": [
        "add {person} to my contacts",
        "save {person} from {company} as a contact",
        "new contact: {person}",
        "create a person record for {person}",
        "!put {person} in my people",
        "remember {person}, they're at {company}",
    ],
    "people_log_interaction": [
        "log that I {channel} {person}",
        "note that I {channel} {person} today",
        "record a call with {person}",
        "I {channel} {person} yesterday, log it",
        "!log a touchpoint with {person}",
        "mark that {person} and I spoke {date}",
    ],
    "people_add_note": [
        "add a note to {person}: they prefer mornings",
        "note on {person}: allergic to shellfish",
        "remember that {person} is moving to {place}",
        "!save a note against {person}'s record",
        "attach to {person}: kids are called Ana and Luis",
        "write on {person}'s record that they hate calls",
    ],
    # -------------------------------------------------------------- notes
    "notes_search": [
        "find my notes about {topic}",
        "do I have anything written down about {topic}",
        "search my notes for {topic}",
        "!any notes mentioning {topic}",
        "where did I write about {topic}",
        "notes on {topic}?",
        "dig up what I wrote about {topic}",
    ],
    "notes_in_notebook": [
        "what's in my {notebook} notebook",
        "show me the {notebook} notes",
        "!list the notes filed in {notebook}",
        "everything in {notebook}",
        "open my {notebook} notebook",
        "what have I got under {notebook}",
    ],
    "notes_about_people": [
        "notes linked to {person}",
        "what notes mention {person}",
        "!find my notes about the {company} people",
        "anything written down tied to {person}",
        "show me notes connected to {person}",
    ],
    "notes_create": [
        "write a note: the boiler is under warranty until March",
        "new note about {topic}",
        "jot down that {person} recommended a plumber",
        "!create a note in {notebook} about {topic}",
        "note to self: check the {topic} before renewing",
        "save a note in {notebook}: buy cable ties",
    ],
    "notes_append": [
        "add to the {note} note: they quoted 400",
        "append to {note}: follow up in a week",
        "!stick another line on the {note} note",
        "add a line to {note} saying it's paid",
        "update the {note} note with the new number",
    ],
    # ------------------------------------------------------------- photos
    "photos_of_people": [
        "photos of {person}",
        "show me pictures with {person} in them",
        "find photos with {person}",
        "!any shots of the {company} people",
        "pics of {person} and me",
        "do I have photos of {person}",
    ],
    "photos_by_date": [
        "photos from {window}",
        "show me pictures I took {window}",
        "!what photos do I have from {window}",
        "anything in my camera roll {window}",
        "pictures {window}?",
    ],
    "photos_in_album": [
        "show me the {album} album",
        "open the {album} album",
        "!what photos are in {album}",
        "everything filed under {album}",
        "pull up {album}",
    ],
    "photos_at_place": [
        "photos taken in {place}",
        "pictures from {place}",
        "!what do I have from {place}",
        "show me shots at {place}",
        "any photos from when I was in {place}",
    ],
    "photos_add_to_album": [
        "put those in the {album} album",
        "add these to {album}",
        "file the {place} photos into {album}",
        "!move those pictures into {album}",
        "stick them in {album}",
    ],
    # --------------------------------------------------------------- docs
    "docs_search": [
        "find the {doc}",
        "where is {doc}",
        "search my documents for {topic}",
        "!any documents about {topic}",
        "do I have a file for {doc}",
        "pull up {doc}",
    ],
    "docs_in_folder": [
        "what's in my {folder} folder",
        "list the documents in {folder}",
        "!show me everything filed under {folder}",
        "open the {folder} folder",
        "what have I got in {folder}",
    ],
    "docs_star": [
        "star {doc}",
        "flag the {doc} document",
        "!mark {doc} as important",
        "favourite the {doc} file",
        "star the ones in {folder}",
    ],
    "docs_move": [
        "move {doc} into {folder}",
        "file {doc} under {folder}",
        "!put the {doc} document in the {folder} folder",
        "shift {doc} over to {folder}",
    ],
    # ------------------------------------------------------------- locker
    "locker_find": [
        "what's my {service} password",
        "find my {service} login",
        "!look up the {service} entry in my locker",
        "do I have credentials for {service}",
        "get me the {service} account details",
    ],
    "locker_weak": [
        "which passwords are weak",
        "any reused logins",
        "!show me the flagged locker items",
        "what's been breached",
        "password health check",
    ],
    "locker_add": [
        "save my {service} login",
        "store a new password for {service}",
        "!add {service} to my locker",
        "put the {service} credentials in the locker",
    ],
    # -------------------------------------------------------------- tally
    "tally_balance_with": [
        "what do {person} and I owe each other",
        "where am I with {person}",
        "what's my balance with {person}",
        "!how much do the {company} people owe me",
        "am I square with {person}",
        "do I owe {person} anything",
    ],
    "tally_who_owes_me": [
        "who owes me money",
        "who do I owe",
        "!anyone got an outstanding balance with me",
        "am I owed anything by anyone",
        "list everyone I still owe",
    ],
    "tally_group_balance": [
        "show me the balances in the {group} group",
        "how does the {group} group stand",
        "!what's the split in {group}",
        "settle-up view for {group}",
        "where is everyone in {group}",
    ],
    "tally_expenses_with": [
        "list the expenses I've split with {person}",
        "what have {person} and I shared",
        "!show me every shared bill with {person}",
        "itemise what I've split with {person}",
        "which expenses involve {person}",
    ],
    "tally_add_expense": [
        "split {expense} with {person}, {amount}",
        "add an expense: {expense}, {amount}, split with {person}",
        "!log {amount} for {expense} shared with {person}",
        "I paid {amount} for {expense}, split it with {person}",
        "put {amount} of {expense} on the {group} group",
    ],
    "tally_settle_up": [
        "{person} paid me back",
        "settle up with {person}",
        "!mark the balance with {person} as cleared",
        "I squared up with {person}",
        "clear what I owe {person}",
    ],
    # ----------------------------------------------------- non-operations
    "none": [
        "book me a flight to {place}",
        "what's the weather {window}",
        "order more coffee beans",
        "play some music",
        "what's the exchange rate for pounds",
        "call me a taxi to the airport",
        "translate this into Portuguese",
        "how do I fix a dripping tap",
        "send a text to {person} saying I'm late",
        "what's the news today",
        "turn the heating up",
        "who won the cricket last night",
    ],
    "clarify": [
        "can you sort that out",
        "do the thing with the file",
        "update it",
        "add it to the list",
        "handle that for me",
        "you know the one — deal with it",
        "put that somewhere sensible",
        "change it to the other one",
        "fix the thing from earlier",
    ],
}

# Context-dependent templates: the label is a function of previous_operation.
# ``{op}`` in a rule means "the label is whatever the previous operation was"
# (a continuation with a changed slot).
CONTINUATION_TEMPLATES = [
    "and what about {window}",
    "what about {due}",
    "and {company}?",
    "just the ones from {window}",
    "only the ones in {notebook}",
    "and the {group} group",
    "same thing for {window}",
    "now do {window}",
    "what about {person}",
]

# (template, {previous_operation: label}) --- follow-ups whose operation
# depends on what was just run.
DEPENDENT_TEMPLATES: list[tuple[str, dict[str, str]]] = [
    (
        "only the ones with {person}",
        {
            "people_at": "people_profile",
            "photos_in_album": "photos_of_people",
            "photos_by_date": "photos_of_people",
            "photos_at_place": "photos_of_people",
            "notes_search": "notes_about_people",
            "notes_in_notebook": "notes_about_people",
            "tasks_due": "tasks_for_people",
            "tasks_by_project": "tasks_for_people",
        },
    ),
    (
        "just the ones with {person} in them",
        {
            "photos_in_album": "photos_of_people",
            "photos_by_date": "photos_of_people",
            "photos_at_place": "photos_of_people",
            "notes_search": "notes_about_people",
        },
    ),
    (
        "which of those are {person}'s",
        {
            "tasks_due": "tasks_for_people",
            "tasks_by_project": "tasks_for_people",
            "tasks_about": "tasks_for_people",
            "people_at_company": "people_profile",
        },
    ),
    (
        "mark the first one done",
        {"tasks_due": "tasks_complete", "tasks_about": "tasks_complete", "tasks_by_project": "tasks_complete"},
    ),
    (
        "tick off the last one",
        {"tasks_due": "tasks_complete", "tasks_about": "tasks_complete", "tasks_by_project": "tasks_complete"},
    ),
    (
        "push the last one to {date}",
        {"tasks_due": "tasks_set_due", "tasks_about": "tasks_set_due", "tasks_by_project": "tasks_set_due"},
    ),
    (
        "give the second one to {person}",
        {"tasks_due": "tasks_assign", "tasks_about": "tasks_assign", "tasks_by_project": "tasks_assign"},
    ),
    (
        "assign that first one to {person}",
        {"tasks_due": "tasks_assign", "tasks_by_project": "tasks_assign"},
    ),
    (
        "star the second one",
        {"docs_in_folder": "docs_star", "docs_search": "docs_star"},
    ),
    (
        "move the first one into {folder}",
        {"docs_in_folder": "docs_move", "docs_search": "docs_move"},
    ),
    (
        "put the first two in the {album} album",
        {
            "photos_of_people": "photos_add_to_album",
            "photos_by_date": "photos_add_to_album",
            "photos_in_album": "photos_add_to_album",
            "photos_at_place": "photos_add_to_album",
        },
    ),
    (
        "file those under {album}",
        {"photos_of_people": "photos_add_to_album", "photos_by_date": "photos_add_to_album"},
    ),
    (
        "log that I {channel} the last one",
        {"people_at_company": "people_log_interaction", "people_find": "people_log_interaction", "people_at": "people_log_interaction"},
    ),
    (
        "show me the last one's details",
        {"people_at_company": "people_profile", "people_find": "people_profile", "people_at": "people_profile"},
    ),
    (
        "and what do they owe me",
        {"people_at": "tally_balance_with", "people_at_company": "tally_balance_with"},
    ),
    (
        "what's assigned to them",
        {"people_at": "tasks_for_people", "people_at_company": "tasks_for_people"},
    ),
    (
        "any photos of them",
        {"people_at": "photos_of_people", "people_at_company": "photos_of_people"},
    ),
    (
        "book an intro call with them {date}",
        {"people_at_company": "agenda_create_event", "people_find": "agenda_create_event"},
    ),
    (
        "now show me the tasks about it",
        {"notes_search": "tasks_about", "agenda_search": "tasks_about", "docs_search": "tasks_about"},
    ),
    (
        "who's going to it",
        {"agenda_search": "people_at", "agenda_upcoming": "people_at"},
    ),
    (
        "add a task to prep for it, due {date}",
        {"agenda_search": "tasks_add", "agenda_upcoming": "tasks_add", "agenda_day_context": "tasks_add"},
    ),
    (
        "cancel it",
        {"agenda_search": "agenda_cancel_event", "agenda_upcoming": "agenda_cancel_event"},
    ),
    (
        "move it to {date}",
        {"agenda_search": "agenda_reschedule", "agenda_upcoming": "agenda_reschedule"},
    ),
    (
        "add {person} to it",
        {"agenda_search": "agenda_attendee_add", "agenda_upcoming": "agenda_attendee_add"},
    ),
]
