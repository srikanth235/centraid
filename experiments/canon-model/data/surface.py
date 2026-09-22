# -*- coding: utf-8 -*-
"""AUTHORED surface inventory.

Every string in this file was written by hand for this corpus.  Nothing is
copied from the evaluation corpora (which this lane has not opened).  The
realiser in paraphrase.py assembles these clauses into whole utterances; the
frames at the bottom are whole utterances with one slot.

Registers, and what each is for:
  terse       a phone user typing four words
  natural     how a person actually says it, in full
  polite      hedged, "could you", "if you don't mind"
  spoken      dictated, with fillers and false starts
  imperative  a bare command
  elliptical  only meaningful after a previous canonical
  typo        a natural utterance with real transpositions and drops
"""

# --- board nouns ------------------------------------------------------------
# k -> the plural noun phrases, then the singular ones with a determiner.
BOARD = {
    "events": ["events", "calendar entries", "things in my calendar",
               "appointments", "diary entries"],
    "tasks": ["tasks", "to-dos", "jobs", "things on my list", "open jobs"],
    "notes": ["notes", "notes of mine", "written notes", "notebook entries"],
    "journal notes": ["journal entries", "diary entries", "journal notes"],
    "documents": ["documents", "docs", "files", "papers", "scanned papers"],
    "parties": ["people", "contacts", "people in my contacts", "names"],
    "members": ["members", "people I split with", "the people in my groups"],
    "profiles": ["profiles", "people profiles", "the profile cards"],
    "important dates": ["important dates", "key dates", "dates I keep for people",
                        "birthdays and anniversaries"],
    "contact channels": ["contact details", "numbers and addresses",
                         "phone numbers and emails", "ways to reach people"],
    "activities": ["interactions", "logged contact", "times I got in touch"],
    "obligations": ["debts", "IOUs", "money owed", "outstanding debts"],
    "photos": ["photos", "pictures", "shots", "frames", "pics"],
    "albums": ["albums", "photo albums"],
    "places": ["places", "spots", "locations"],
    "expenses": ["expenses", "charges", "spends", "things I've paid for"],
    "groups": ["groups", "shared groups", "split groups"],
    "settlements": ["settlements", "payments between us", "settle-ups"],
    "locker items": ["logins", "locker items", "saved credentials",
                     "entries in my locker"],
    "things": ["things", "stuff", "anything", "everything"],
}
SING = {
    "events": "event", "tasks": "task", "notes": "note",
    "journal notes": "journal entry", "documents": "document",
    "parties": "person", "members": "member", "profiles": "profile",
    "important dates": "date", "contact channels": "contact detail",
    "activities": "interaction", "obligations": "debt", "photos": "photo",
    "albums": "album", "places": "place", "expenses": "expense",
    "groups": "group", "settlements": "settlement", "locker items": "login",
    "things": "thing",
}

# --- `called "X"` -----------------------------------------------------------
CALLED = [
    'the {sing} called "{L}"',
    'my {sing} "{L}"',
    'the "{L}" {sing}',
    '{plural} called "{L}"',
    'anything called "{L}"',
    '{plural} with "{L}" in the name',
    'the {sing} named "{L}"',
    'whatever I called "{L}"',
]

# --- field words ------------------------------------------------------------
FIELD = {
    "summary": ["title", "name"], "title": ["title", "name"],
    "display_name": ["name"], "name": ["name"], "label": ["label"],
    "description": ["description", "notes on it"],
    "dtstart": ["start time", "start"], "dtend": ["finish time", "end"],
    "due_at": ["due date", "deadline"], "completed_at": ["date I ticked it off"],
    "created_at": ["date it was added"], "updated_at": ["last edit"],
    "captured_at": ["date it was taken"], "spent_on": ["date it was spent"],
    "paid_on": ["date it was paid"], "incurred_on": ["date it started"],
    "settled_at": ["date it was settled"],
    "last_contacted_at": ["last time I was in touch"],
    "password_set_at": ["date the password was set"],
    "birth_date": ["date of birth"], "month_day": ["day it falls on"],
    "next_occurrence": ["next time it comes round"],
    "reminder_on": ["reminder date"], "started_at": ["start"],
    "ended_at": ["end"], "archived_at": ["date it was archived"],
    "deleted_at": ["date it was deleted"],
    "status": ["status"], "priority": ["priority"],
    "effort_min": ["effort", "how long it takes"],
    "duration_s": ["length"], "remind_before_min": ["reminder lead time"],
    "amount_minor": ["amount"], "currency": ["currency"],
    "category": ["category"], "split_method": ["split"],
    "cadence_days": ["cadence", "how often I should call"],
    "role": ["role"], "nickname": ["nickname"], "met": ["how we met"],
    "folder": ["folder"], "starred": ["starred flag"],
    "favorite": ["favourite flag"], "pinned": ["pinned flag"],
    "format": ["format"], "language": ["language"],
    "byte_size": ["file size"], "width": ["width"], "height": ["height"],
    "geo_lat": ["latitude"], "geo_lng": ["longitude"], "tz": ["timezone"],
    "type": ["type"], "username": ["username"], "url": ["site"],
    "compromised": ["compromised flag"], "reason": ["reason"],
    "location_place_id": ["place"], "organizer_party_id": ["organiser"],
    "owner_party_id": ["owner"], "author_party_id": ["author"],
    "creator_party_id": ["person who took it"], "actor_party_id": ["person"],
    "paid_by": ["person who paid"], "from_party": ["payer"],
    "to_party": ["payee"], "group_id": ["group"],
    "parent_task_id": ["parent task"], "parent_place_id": ["parent place"],
    "place_id": ["place"], "album": ["album"],
    "album_titles": ["albums it's in"], "notebooks": ["notebook"],
    "owed_to_them": ["owed-to-them flag"], "owed_to_me": ["owed-to-me flag"],
    "is_preferred": ["preferred flag"], "value": ["value"],
    "sequence": ["revision"],
}

# --- windows ----------------------------------------------------------------
WINDOW = {
    "today": ["today"],
    "tomorrow": ["tomorrow"],
    "yesterday": ["yesterday"],
    "this week": ["this week"],
    "last week": ["last week"],
    "next week": ["next week"],
    "this weekend": ["this weekend", "at the weekend"],
    "last weekend": ["last weekend", "over the weekend just gone"],
    "this month": ["this month"],
    "last month": ["last month"],
    "next month": ["next month"],
    "before now": ["already overdue", "past their date", "overdue"],
    "recently": ["recently", "lately", "in the last few days"],
    "{DATE}": ["on {DATE}"],
    "{MONTH}": ["in {MONTH}", "during {MONTH}"],
    "{RANGE}": ["between {RANGE}", "over {RANGE}"],
    "next 3 days": ["in the next three days", "over the next three days"],
    "next 2 weeks": ["in the next fortnight", "over the next couple of weeks"],
    "next 2 months": ["in the next couple of months", "over the next two months"],
}
ANCHORED_WORDS = ['while we\'re between "{EVENT1}" and "{EVENT2}"',
                  'for the stretch from "{EVENT1}" to "{EVENT2}"',
                  'between the "{EVENT1}" and the "{EVENT2}"']

# --- enum values ------------------------------------------------------------
VALUE = {
    "open": ["open", "still open", "not done yet"],
    "completed": ["done", "finished", "ticked off"],
    "cancelled": ["cancelled", "called off"],
    "confirmed": ["confirmed", "definitely happening"],
    "tentative": ["pencilled in", "only tentative"],
    "markdown": ["markdown"], "plain": ["plain text"],
    "person": ["actual people", "people rather than organisations"],
    "organisation": ["organisations", "companies"],
    "family": ["family"], "friend": ["friends"],
    "colleague": ["work people", "colleagues"],
    "acquaintance": ["acquaintances"],
    "phone": ["phone numbers"], "email": ["email addresses"],
    "address": ["postal addresses"],
    "GBP": ["in pounds"], "EUR": ["in euros"], "USD": ["in dollars"],
    "equal": ["split evenly"], "shares": ["split by shares"],
    "exact": ["split by exact amounts"],
    "groceries": ["groceries"], "transport": ["travel"],
    "utilities": ["bills"], "supplies": ["supplies"], "fees": ["fees"],
    "en": ["in English"], "fr": ["in French"], "de": ["in German"],
    "login": ["logins"], "card": ["cards"], "note": ["secure notes"],
    "identity": ["identity records"],
}

# --- boolean columns --------------------------------------------------------
FLAG_TRUE = {
    "pinned": ["pinned", "that I've pinned"],
    "starred": ["starred", "that I starred"],
    "favorite": ["favourited", "that I marked as favourites"],
    "compromised": ["flagged as compromised", "that got breached"],
    "is_preferred": ["set as the preferred one"],
    "owed_to_them": ["where I'm the one who owes"],
}
FLAG_FALSE = {
    "pinned": ["not pinned", "that I never pinned"],
    "starred": ["unstarred", "I haven't starred"],
    "favorite": ["not favourited", "I never marked as favourites"],
    "compromised": ["not flagged as compromised"],
    "is_preferred": ["not the preferred one"],
    "owed_to_them": ["where they owe me"],
}

# --- Field Cmp Field --------------------------------------------------------
PAIR = {
    ("completed_at", "due_at", "="): [
        "I finished exactly on the deadline",
        "that landed bang on the due date",
        "I got done on the day they were due",
        "where I hit the deadline to the day",
        "that came in dead on time",
        "I closed out on the date I'd set",
    ],
    ("completed_at", "due_at", ">"): [
        "I finished late",
        "that slipped past the deadline",
        "I only got to after they were due",
        "that ran over",
        "where I missed the date I'd set",
        "I was late on",
    ],
    ("password_set_at", "created_at", "="): [
        "I've never rotated the password on",
        "still on the original password",
        "where the password is the one I set when I made it",
        "I've never changed the password for",
        "that are still on their first password",
        "where the password has never been touched",
    ],
    ("password_set_at", "created_at", ">"): [
        "where I have rotated the password",
        "I've changed the password on since",
        "that have had a password change",
        "where the password isn't the original",
        "I've refreshed the password for",
        "that got a new password at some point",
    ],
    ("updated_at", "created_at", "="): [
        "I've never edited",
        "still in their first draft",
        "that I wrote once and never went back to",
        "untouched since I made them",
        "where I've not changed a word",
        "that are exactly as I first saved them",
    ],
    ("updated_at", "created_at", ">"): [
        "I've edited since",
        "that I've gone back to",
        "I've revised at least once",
        "that have been changed since I made them",
        "where I've been in and edited",
        "that aren't in their original state",
    ],
    ("width", "height", "="): [
        "that are square",
        "shot square",
        "with equal sides",
        "in a square crop",
        "that came out square",
        "where the width and the height match",
    ],
    ("width", "height", ">"): [
        "in landscape",
        "shot wide",
        "that are wider than they are tall",
        "in a landscape crop",
        "taken the long way round",
        "that came out landscape",
    ],
}

# --- link walks -------------------------------------------------------------
# (outer, inner) -> phrasings; {inner} is the inner noun phrase.
WALK = {
    ("tasks", "tasks"): ["the sub-tasks of {inner}", "the steps under {inner}",
                         "the sub-jobs of {inner}"],
    ("expenses", "groups"): ["the expenses in {inner}", "the charges on {inner}",
                             "the spends in {inner}"],
    ("groups", "expenses"): ["the group {inner} belongs to",
                             "the group behind {inner}"],
    ("members", "groups"): ["the people in {inner}", "the members of {inner}",
                            "everyone in {inner}"],
    ("groups", "members"): ["the groups {inner} is in",
                            "the groups {inner} shares with me"],
    ("settlements", "groups"): ["the settle-ups in {inner}",
                                "the payments made in {inner}"],
    ("expenses", "members"): ["the expenses {inner} paid for",
                              "the charges {inner} covered"],
    ("photos", "albums"): ["the photos in {inner}", "the frames inside {inner}",
                           "the pictures in {inner}"],
    ("albums", "photos"): ["the albums {inner} is in",
                           "the album {inner} sits in"],
    ("photos", "places"): ["the photos from {inner}", "the pictures taken at {inner}",
                           "the shots at {inner}"],
    ("places", "photos"): ["the place {inner} was taken",
                           "the spot behind {inner}"],
    ("profiles", "parties"): ["the profile for {inner}",
                              "the profile card for {inner}"],
    ("parties", "profiles"): ["the people behind {inner}",
                              "the contacts behind {inner}"],
    ("important dates", "parties"): ["the dates I keep for {inner}",
                                     "the important dates for {inner}",
                                     "the birthdays for {inner}"],
    ("parties", "important dates"): ["the people behind {inner}",
                                     "the contacts {inner} belong to"],
    ("contact channels", "parties"): ["the contact details for {inner}",
                                      "the numbers for {inner}",
                                      "the ways to reach {inner}"],
    ("parties", "contact channels"): ["the people behind {inner}",
                                      "the contacts {inner} belong to"],
    ("activities", "parties"): ["my logged contact with {inner}",
                                "the interactions with {inner}"],
    ("parties", "activities"): ["the people on {inner}",
                                "the contacts behind {inner}"],
    ("obligations", "parties"): ["the debts with {inner}",
                                 "the money outstanding with {inner}",
                                 "the IOUs with {inner}"],
    ("parties", "obligations"): ["the people on {inner}",
                                 "the contacts behind {inner}"],
    ("journal notes", "parties"): ["the journal entries about {inner}",
                                   "my diary entries about {inner}"],
    ("parties", "journal notes"): ["the people {inner} are about",
                                   "the contacts behind {inner}"],
    ("notes", "parties"): ["the notes {inner} wrote",
                           "the notes filed under {inner}"],
    ("parties", "notes"): ["the authors of {inner}",
                           "the people who wrote {inner}"],
    ("events", "parties"): ["the events with {inner} on them",
                            "the diary entries {inner} are coming to"],
    ("parties", "events"): ["the people at {inner}",
                            "the people coming to {inner}",
                            "everyone on {inner}"],
    ("tasks", "parties"): ["the jobs {inner} own",
                           "the tasks assigned to {inner}"],
    ("parties", "tasks"): ["the owners of {inner}",
                           "the people {inner} belong to"],
    ("documents", "parties"): ["the papers filed by {inner}",
                               "the documents from {inner}"],
    ("photos", "parties"): ["the photos taken by {inner}",
                            "the pictures with {inner} in them"],
    ("parties", "photos"): ["the people in {inner}",
                            "the faces in {inner}"],
}

# --- refs -------------------------------------------------------------------
REF_WORDS = {
    "it": ["it", "that"],
    "that one": ["that one", "that particular one", "the one you just showed me"],
    "them": ["them", "those", "that lot", "those ones"],
    "the other one": ["the other one", "the other"],
    "the earlier one": ["the earlier one", "the one before that",
                        "the one from a couple of questions back"],
    "the last thing I added": ["the one I just added", "the thing I just made",
                               "what I just created"],
    "the 2nd one": ["the second one", "number two", "the second in that list"],
    "the 3rd one": ["the third one", "number three"],
}

# --- ordering / limit -------------------------------------------------------
ORDER = {
    "asc": ["sorted by {field}", "in {field} order", "earliest {field} first",
            "ordered by {field}, smallest first"],
    "desc": ["sorted by {field}, biggest first", "in reverse {field} order",
             "latest {field} first", "newest by {field} first"],
}
FIRST = ["the first {n}", "just the top {n}", "only {n} of", "the first {n} of"]

# --- verb glosses -----------------------------------------------------------
# gloss -> imperative phrasings; {NP} is the anchor noun phrase.
VERB = {
    "create": {
        "tasks": ['add a task called "{TASK}"', 'put "{TASK}" on my list',
                  'new to-do: "{TASK}"', 'remind me to do "{TASK}"'],
        "events": ['put "{EVENT}" in the diary for {DATETIME}',
                   'book "{EVENT}" for {DATETIME}',
                   'add an event "{EVENT}" at {DATETIME}'],
        "notes": ['start a note called "{NOTE}"', 'new note: "{NOTE}"',
                  'make me a note titled "{NOTE}"'],
        "documents": ['file a document called "{DOC}"', 'add "{DOC}" to my documents'],
        "parties": ['add "{PERSON}" to my contacts', 'new contact: "{PERSON}"',
                    'save "{PERSON}" as a person'],
        "albums": ['make an album called "{ALBUM}"', 'new photo album "{ALBUM}"'],
        "expenses": ['log "{EXPENSE}" for {AMOUNT}', 'add an expense "{EXPENSE}", {AMOUNT}'],
        "groups": ['start a group called "{GROUP}"', 'new split group "{GROUP}"'],
        "locker items": ['save a login called "{LOCKER}"',
                         'add "{LOCKER}" to my locker'],
    },
    "create_due": {
        "tasks": ['add "{TASK}" due {DATE}', 'new task "{TASK}", deadline {DATE}',
                  'remind me to do "{TASK}" by {DATE}'],
    },
    "reschedule": ["move {NP} to {DATE}", "push {NP} to {DATE}",
                   "shift {NP} out to {DATE}", "{NP} needs to be {DATE}",
                   "can we do {NP} on {DATE} instead"],
    "shift": ["shift {NP} by {DURATION}", "nudge {NP} along {DURATION}"],
    "resize": ["make {NP} a {EFFORT} minute job", "set the effort on {NP} to {EFFORT}"],
    "rename": ['rename {NP}', 'call {NP} something else', 'retitle {NP}'],
    "complete": ["tick {NP} off", "mark {NP} done", "{NP} is finished",
                 "I've done {NP}", "close out {NP}"],
    "reopen": ["reopen {NP}", "put {NP} back on the list", "{NP} isn't actually done"],
    "destroy": ["delete {NP}", "get rid of {NP}", "bin {NP}", "throw {NP} away",
                "remove {NP}"],
    "restore": ["put {NP} back", "undelete {NP}", "restore {NP}",
                "bring {NP} back out of the bin"],
    "cancel": ["cancel {NP}", "call {NP} off", "{NP} is off"],
    "accept": ["accept {NP}", "say yes to {NP}", "RSVP yes to {NP}"],
    "move": ["move {NP}", "refile {NP}", "put {NP} somewhere else"],
    "star": ["star {NP}", "flag {NP}", "pin {NP} to the top"],
    "unstar": ["unstar {NP}", "take the star off {NP}"],
    "favourite": ["favourite {NP}", "mark {NP} as a favourite", "heart {NP}"],
    "unfavourite": ["unfavourite {NP}", "take {NP} out of my favourites"],
    "addalbum": ['put {NP} in "{ALBUM}"', 'add {NP} to the "{ALBUM}" album'],
    "removealbum": ['take {NP} out of "{ALBUM}"',
                    'remove {NP} from the "{ALBUM}" album'],
    "setplace": ['say {NP} was taken at "{PLACE}"', 'tag {NP} as "{PLACE}"'],
    "archive": ["archive {NP}", "shelve {NP}", "put {NP} away"],
    "cadence": ["set my cadence for {NP} to {CADENCE} days",
                "remind me about {NP} every {CADENCE} days"],
    "log": ["log that I was in touch with {NP} on {DATE}",
            "note down that I spoke to {NP} on {DATE}"],
    "adddate": ['add "{DATELABEL}" on {MONTHDAY} for {NP}',
                'keep {MONTHDAY} as {NP}\'s "{DATELABEL}"'],
    "journal": ['write a journal entry "{NOTE}" about {NP}',
                'add "{NOTE}" to my journal for {NP}'],
    "debt": ['note that {NP} owes me {AMOUNT} for "{REASON}"',
             'add a {AMOUNT} debt with {NP} for "{REASON}"'],
    "settle": ["settle up with {NP}", "square up with {NP}", "mark {NP} as paid"],
    "amend": ["change {NP}", "fix {NP}", "correct {NP}"],
    "categorise": ['file {NP} under "{CATEGORY}"', 'categorise {NP} as "{CATEGORY}"'],
    "memo": ['add a memo to {NP}', 'stick a note on {NP}'],
    "addmember": ['add "{PERSON}" to {NP}', 'put "{PERSON}" in {NP}'],
    "removemember": ['take "{PERSON}" out of {NP}', 'drop "{PERSON}" from {NP}'],
    "nudge": ["nudge everyone in {NP}", "chase {NP} up"],
    "cover": ["set the cover of {NP}", "use that photo as the cover of {NP}"],
}


# --- count over the walk ----------------------------------------------------
# (counted kind, the kind being filtered) -> {"=": [...], ">": [...]}.
# `{N}` is the number.  Authored per edge because the idiom is the edge's:
# a place has SHOTS FROM it, a group has SPENDS ON it, a person has DEBTS with.
COUNTWALK = {
    ("tasks", "tasks"): {
        "=": ["broken into exactly {N} steps", "with just {N} sub-jobs under them",
              "that split into {N} pieces"],
        ">": ["broken into more than {N} steps", "with more than {N} sub-jobs hanging off",
              "that sprawl into over {N} pieces"]},
    ("expenses", "groups"): {
        "=": ["with exactly {N} spends on them", "where only {N} things got charged",
              "carrying just {N} charges"],
        ">": ["with more than {N} spends on them", "where over {N} things got charged",
              "carrying more than {N} charges"]},
    ("groups", "expenses"): {
        "=": ["that sit in exactly {N} groups", "filed under just {N} groups"],
        ">": ["that sit in more than {N} groups", "filed under over {N} groups",
              "spanning more than {N} groups"]},
    ("members", "groups"): {
        "=": ["with exactly {N} people in them", "that are just the {N} of us",
              "with a membership of {N}"],
        ">": ["with more than {N} people in them", "bigger than {N} of us",
              "where there are over {N} members"]},
    ("groups", "members"): {
        "=": ["who share exactly {N} groups with me", "in just {N} of my groups"],
        ">": ["who share more than {N} groups with me", "in over {N} of my groups",
              "turning up in more than {N} groups"]},
    ("settlements", "groups"): {
        "=": ["where we've squared up exactly {N} times", "with just {N} settle-ups on record"],
        ">": ["where we've squared up more than {N} times", "with over {N} settle-ups on record",
              "that we've settled more than {N} times"]},
    ("expenses", "members"): {
        "=": ["who've paid for exactly {N} things", "who've covered just {N} charges"],
        ">": ["who've paid for more than {N} things", "who've covered over {N} charges",
              "who keep paying — more than {N} times"]},
    ("photos", "albums"): {
        "=": ["holding exactly {N} frames", "with only {N} pictures in them",
              "that are just {N} shots long"],
        ">": ["holding more than {N} frames", "with over {N} pictures in them",
              "that run past {N} shots"]},
    ("albums", "photos"): {
        "=": ["that sit in exactly {N} albums", "filed in just {N} albums"],
        ">": ["that sit in more than {N} albums", "filed in over {N} albums",
              "that I've put in more than {N} albums"]},
    ("photos", "places"): {
        "=": ["I've got exactly {N} shots from", "with only {N} frames taken there",
              "where I only took {N} pictures"],
        ">": ["I've got more than {N} shots from", "with over {N} frames taken there",
              "where I kept shooting — more than {N} pictures"]},
    ("places", "photos"): {
        "=": ["pinned to exactly {N} places", "tagged with just {N} locations"],
        ">": ["pinned to more than {N} places", "tagged with over {N} locations"]},
    ("profiles", "parties"): {
        "=": ["with exactly {N} profile cards", "carrying just {N} profiles"],
        ">": ["with more than {N} profile cards", "carrying over {N} profiles",
              "that have picked up more than {N} profiles"]},
    ("parties", "profiles"): {
        "=": ["attached to exactly {N} contacts", "belonging to just {N} people"],
        ">": ["attached to more than {N} contacts", "belonging to over {N} people"]},
    ("important dates", "parties"): {
        "=": ["I keep exactly {N} dates for", "with just {N} dates in their card",
              "where I've noted {N} dates"],
        ">": ["I keep more than {N} dates for", "with over {N} dates in their card",
              "whose card is stuffed — more than {N} dates"]},
    ("parties", "important dates"): {
        "=": ["that belong to exactly {N} people", "shared by just {N} contacts"],
        ">": ["that belong to more than {N} people", "shared by over {N} contacts"]},
    ("contact channels", "parties"): {
        "=": ["I've got exactly {N} ways to reach", "with just {N} numbers on file",
              "where I've only saved {N} contact details"],
        ">": ["I've got more than {N} ways to reach", "with over {N} numbers on file",
              "who have more than {N} contact details saved"]},
    ("parties", "contact channels"): {
        "=": ["used by exactly {N} people", "shared between just {N} contacts"],
        ">": ["used by more than {N} people", "shared between over {N} contacts"]},
    ("activities", "parties"): {
        "=": ["I've been in touch with exactly {N} times", "with just {N} logged contacts"],
        ">": ["I've been in touch with more than {N} times", "with over {N} logged contacts",
              "who I keep calling — more than {N} times"]},
    ("parties", "activities"): {
        "=": ["involving exactly {N} people", "with just {N} names on them"],
        ">": ["involving more than {N} people", "with over {N} names on them"]},
    ("obligations", "parties"): {
        "=": ["I've got exactly {N} debts with", "with just {N} IOUs outstanding",
              "where there are {N} things unsettled"],
        ">": ["I've got more than {N} debts with", "with over {N} IOUs outstanding",
              "where it's piling up — more than {N} unsettled"]},
    ("parties", "obligations"): {
        "=": ["between exactly {N} people", "with just {N} people on them"],
        ">": ["between more than {N} people", "with over {N} people on them"]},
    ("journal notes", "parties"): {
        "=": ["I've written exactly {N} journal entries about",
              "with just {N} diary entries against their name"],
        ">": ["I've written more than {N} journal entries about",
              "with over {N} diary entries against their name",
              "who fill my journal — more than {N} entries"]},
    ("parties", "journal notes"): {
        "=": ["about exactly {N} people", "naming just {N} contacts"],
        ">": ["about more than {N} people", "naming over {N} contacts"]},
    ("notes", "parties"): {
        "=": ["who've written exactly {N} notes", "with just {N} notes to their name"],
        ">": ["who've written more than {N} notes", "with over {N} notes to their name"]},
    ("parties", "notes"): {
        "=": ["credited to exactly {N} authors", "written by just {N} people"],
        ">": ["credited to more than {N} authors", "written by over {N} people"]},
    ("events", "parties"): {
        "=": ["I'm seeing at exactly {N} things", "with just {N} dates in the diary",
              "who turn up {N} times in my calendar"],
        ">": ["I'm seeing at more than {N} things", "with over {N} dates in the diary",
              "who turn up more than {N} times in my calendar"]},
    ("parties", "events"): {
        "=": ["with exactly {N} people coming", "that are just the {N} of us",
              "where only {N} names are on the invite"],
        ">": ["with more than {N} people coming", "bigger than {N} of us",
              "where over {N} names are on the invite"]},
    ("tasks", "parties"): {
        "=": ["holding exactly {N} jobs", "who own just {N} tasks"],
        ">": ["holding more than {N} jobs", "who own over {N} tasks",
              "who are carrying more than {N} jobs"]},
    ("parties", "tasks"): {
        "=": ["owned by exactly {N} people", "assigned to just {N} names"],
        ">": ["owned by more than {N} people", "assigned to over {N} names"]},
    ("documents", "parties"): {
        "=": ["who've filed exactly {N} papers", "with just {N} documents to their name"],
        ">": ["who've filed more than {N} papers", "with over {N} documents to their name"]},
    ("photos", "parties"): {
        "=": ["who show up in exactly {N} pictures", "in just {N} frames"],
        ">": ["who show up in more than {N} pictures", "in over {N} frames",
              "who are all over the roll — more than {N} frames"]},
    ("parties", "photos"): {
        "=": ["with exactly {N} faces in them", "showing just {N} people"],
        ">": ["with more than {N} faces in them", "showing over {N} people",
              "crowded — more than {N} people in shot"]},
}

# Top-ups, so no edge is thinner than three glosses per comparator.
for _key, _op, _text in [
    (('groups', 'expenses'), '=', 'charged to exactly {N} groups'),
    (('groups', 'members'), '=', 'who are in exactly {N} of my groups'),
    (('settlements', 'groups'), '=', 'with exactly {N} payments made in them'),
    (('expenses', 'members'), '=', 'who got the bill exactly {N} times'),
    (('albums', 'photos'), '=', 'that show up in exactly {N} albums'),
    (('places', 'photos'), '=', 'with exactly {N} places pinned to them'),
    (('places', 'photos'), '=', "where I've tagged only {N} spots"),
    (('places', 'photos'), '>', 'with more than {N} places pinned to them'),
    (('profiles', 'parties'), '=', "who've got exactly {N} profiles on file"),
    (('parties', 'profiles'), '=', 'held by exactly {N} contacts'),
    (('parties', 'profiles'), '=', 'sitting under just {N} names'),
    (('parties', 'profiles'), '>', 'held by more than {N} contacts'),
    (('parties', 'important dates'), '=', 'kept for exactly {N} people'),
    (('parties', 'important dates'), '=', 'noted against just {N} names'),
    (('parties', 'important dates'), '>', 'kept for more than {N} people'),
    (('parties', 'contact channels'), '=', 'saved against exactly {N} people'),
    (('parties', 'contact channels'), '=', 'sitting on just {N} contact cards'),
    (('parties', 'contact channels'), '>', 'saved against more than {N} people'),
    (('activities', 'parties'), '=', "who I've logged exactly {N} contacts with"),
    (('parties', 'activities'), '=', 'logged against exactly {N} people'),
    (('parties', 'activities'), '=', 'with exactly {N} people in the room'),
    (('parties', 'activities'), '>', 'logged against more than {N} people'),
    (('parties', 'obligations'), '=', 'owed between exactly {N} people'),
    (('parties', 'obligations'), '=', 'sitting between just {N} names'),
    (('parties', 'obligations'), '>', 'owed between more than {N} people'),
    (('journal notes', 'parties'), '=', "who I've journalled about exactly {N} times"),
    (('parties', 'journal notes'), '=', 'written about exactly {N} people'),
    (('parties', 'journal notes'), '=', 'that name exactly {N} contacts'),
    (('parties', 'journal notes'), '>', 'written about more than {N} people'),
    (('notes', 'parties'), '=', 'with exactly {N} notes filed under them'),
    (('notes', 'parties'), '=', "who've put down exactly {N} notes"),
    (('notes', 'parties'), '>', 'with more than {N} notes filed under them'),
    (('parties', 'notes'), '=', 'with exactly {N} names on the byline'),
    (('parties', 'notes'), '=', 'penned by exactly {N} people'),
    (('parties', 'notes'), '>', 'with more than {N} names on the byline'),
    (('tasks', 'parties'), '=', 'with exactly {N} jobs on their plate'),
    (('parties', 'tasks'), '=', 'sitting with exactly {N} owners'),
    (('parties', 'tasks'), '=', "on exactly {N} people's plates"),
    (('parties', 'tasks'), '>', 'sitting with more than {N} owners'),
    (('documents', 'parties'), '=', 'with exactly {N} papers filed under them'),
    (('documents', 'parties'), '=', "who've lodged exactly {N} documents"),
    (('documents', 'parties'), '>', 'with more than {N} papers filed under them'),
    (('photos', 'parties'), '=', 'caught on camera exactly {N} times'),
    (('parties', 'photos'), '=', 'with exactly {N} people in shot'),
]:
    COUNTWALK[_key][_op].append(_text)
del _key, _op, _text
