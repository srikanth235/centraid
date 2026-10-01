# v8 skill inventory

Generated from [`skills.json`](skills.json) by `python3 v8/skillscore.py --md v8/SKILLS.md` — edit the JSON, not this file.

The v8 skill inventory. Training data is built skill by skill with a coverage floor per skill; each run is judged per skill by v8/skillscore.py over v8/dev_skills.json. Example phrasings here were written for this file (a different world from the eval corpora) and MAY be used as training seeds.

- **J** marks a judgement skill: asking back (the runtime's clarify, reached with `done` or a call over an ambiguous set) is an acceptable outcome.
- **dev** is how many dev-90 turns need the skill ([`dev_skills.json`](dev_skills.json), measurement only). Calls follow [`../TOOLS.md`](../TOOLS.md).
- The example phrasings were written for this inventory in their own world (Omar, Lena, Kofi, Sofia, the Lisbon trip, House Bills); none is taken from `suite`, `blind`, `holdout` or `registers`, and each was checked against them for near-copies.

| group | skills | what it covers |
| --- | --: | --- |
| [copy](#copy) | 5 | Copying spans from the message into calls: names, anchor words, titles, numbers, dates. |
| [route](#route) | 8 | Kind routing: the question's form decides which kind of row answers it. |
| [filter](#filter) | 4 | Field filters on a set: open/overdue, field values, numeric comparisons, the trash. |
| [link](#link) | 5 | Link walks from one row to its related rows. |
| [time](#time) | 5 | Time windows, relative shifts, which date field a window applies to, ordering by time. |
| [num](#num) | 6 | Number answers: count, sum, one row's amount, dtstart of, group balance, owed_*. |
| [follow](#follow) | 5 | Follow-ups that refine, extend, switch or resume the conversation's current set. |
| [handle](#handle) | 4 | Row handles: reading the #n shown, ordinals, rows from several turns back, `them` and multi-row. |
| [write](#write) | 12 | One skill per write verb (verbs of one call shape share a skill). |
| [compose](#compose) | 5 | Composing writes: look-then-write, bulk, `A then B`, corrections, undo. |
| [judge](#judge) | 6 | Judgement: ask on real ambiguity, say nothing, refuse by reason. |
| **total** | **65** |  |

## copy

Copying spans from the message into calls: names, anchor words, titles, numbers, dates.

### `copy.name` · dev 28

Copy a proper name (person, place, group, album, trip) letter for letter into `called`/`search`; never respell, shorten or swap it for a similar word.

Calls: `search "Omar Haddad"` · `(parties) called "Omar Haddad"` · `(notes) called "Alfama"`

- “find Omar Haddad” → `search "Omar Haddad"` · `answer #1`
- “anything about Alfama in my notes?” → `answer (notes) called "Alfama"`
- “show me the Garden 2026 album” → `answer (albums) called "Garden 2026"`
- “which people share the House Bills group with me?” → `search "House Bills"` · `answer (members of (#1)) that (party_id is not me)`

### `copy.anchor` · dev 46

Pick the matching word(s) out of a descriptive phrase: the head noun(s) a row's title would carry, dropping my/the/thing/stuff, verbs and filler.

Calls: `(things) called "fridge warranty"` · `(locker items) called "gym locker"` · `(notes) called "boiler"`

- “what's the code for the gym locker?” → `answer (locker items called "gym locker")`
- “find the note I made about the old boiler” → `answer (notes called "boiler")`
- “where's my passport scan?” → `answer (things called "passport")`
- “have I got anything on the vet?” → `answer (things called "vet")`

### `copy.title` · dev 8

Write a create's title / description / content from the message: drop the command words ('add a task to', 'remind me to', 'make a note to'), capitalise the first word, keep the person's own words and details.

Calls: `schedule.add_task{title: "Renew the car insurance"}` · `knowledge.create_note{title: "…"}` · `locker.add_item{type: "note", title: "…", content: "…"}`

- “remind me to renew the car insurance” → `schedule.add_task{title: "Renew the car insurance"}`
- “jot down a note: ask Lena about the lease” → `knowledge.create_note{title: "Ask Lena about the lease"}`
- “keep the bike lock combination 2291 in my locker” → `locker.add_item{type: "note", title: "Bike lock combination", content: "2291"}`
- “add a task to email the landlord about the heating” → `schedule.add_task{title: "Email the landlord about the heating"}`

### `copy.number` · dev 4

Turn numbers said in words into digits: money into minor units (sixty dollars → 6000, twelve fifty → 1250), plain counts and minutes as they are (half an hour → 30, three photos → 3).

Calls: `amount_minor: 6000` · `owed_to_me_minor > 3000` · `effort_min = 20` · `count of photos = 3`

- “log sixty dollars for the plumber in House Bills, I paid” → `search "House Bills"` · `tally.add_expense{description: "Plumber", amount_minor: 6000, paid_by: me, group_id: (#1)}`
- “who owes me more than thirty bucks?” → `answer (parties that (owed_to_me_minor > 3000))`
- “which task is roughly a twenty minute job?” → `answer (tasks) that (effort_min = 20 and status != "completed")`
- “where have I taken exactly three pictures?” → `answer (places that (count of photos = 3))`

### `copy.date` · dev 9

Copy a day or time into a write the way it was said ('thursday', 'the 3rd', 'next monday'), spoken times as 24h ('at two' → 14:00, 'half nine' → 09:30); leave the date out when none was said.

Calls: `due_at: thursday` · `dtstart: saturday at 10:00` · `reschedule{to: the 3rd} on #2`

- “monday I need to call the bank — add that as a task” → `schedule.add_task{title: "Call the bank", due_at: monday}`
- “put yoga on saturday at ten” → `schedule.propose_event{summary: "Yoga", dtstart: saturday at 10:00}`
- “coffee with Kofi tomorrow at 3pm” → `schedule.propose_event{summary: "Coffee with Kofi", dtstart: tomorrow at 15:00}`
- “add a task to sort out the garage” → `schedule.add_task{title: "Sort out the garage"}`

## route

Kind routing: the question's form decides which kind of row answers it.

### `route.people` · dev 9

'Who …', a person to find, a surname, 'my <role>' (my plumber, the Lena from choir) → people rows (`parties`), never the events or debts that mention them.

Calls: `answer (parties called "…")` · `search "…" then answer #n` · `answer parties of (#n)`

- “find Sofia Marin” → `answer (parties called "Sofia Marin")`
- “what's Kofi's surname?” → `answer (parties called "Kofi")`
- “the Lena from choir — who is she exactly?” → `search "Lena"` · `answer #2`
- “which contact is my plumber?” → `search "plumber"` · `answer #1`

### `route.day` · dev 6

'What's on X', 'what have I got that day', 'anything happening on …' → everything dated that day: `things during X` (calendar, open to-dos, birthdays), listed `ordered by dtstart asc`.

Calls: `answer (things during saturday) ordered by dtstart asc`

- “saturday — what's planned?” → `answer (things during saturday) ordered by dtstart asc`
- “anything going on the 9th?” → `answer (things during the 9th) ordered by dtstart asc`
- “what have I got tomorrow?” → `answer (things during tomorrow) ordered by dtstart asc`
- “how does my thursday look?” → `answer (things during thursday) ordered by dtstart asc`

### `route.schedule` · dev 25

Pick the schedule kind the words name: calendar / appointment / 'what time is' / 'when do I' → `events`; list / to-do / due / tasks → `tasks`; birthday / anniversary → `important dates`.

Calls: `answer (events) during next week` · `answer (events called "vet")` · `answer (tasks called "car")` · `answer (important dates called "Kofi")`

- “which appointments do I have next week?” → `answer (events) during next week`
- “when's Kofi's birthday?” → `answer (important dates called "Kofi")`
- “what time's my vet visit?” → `answer (events called "vet")`
- “what car tasks have I got?” → `answer (tasks) called "car"`

### `route.locker` · dev 8

Wifi, logins, passwords, PINs, codes, 'in my locker' → `locker items` (search does not reach the locker); the row, not the secret, unless the secret itself is asked for.

Calls: `answer (locker items called "router")` · `answer count of (locker items)`

- “what's the router login?” → `answer (locker items called "router")`
- “how many things have I got saved in the locker?” → `answer count of (locker items)`
- “any gym entries in my locker?” → `answer (locker items called "gym")`
- “what's the alarm code at the lake house?” → `answer (locker items called "lake house alarm")`

### `route.library` · dev 20

Notes vs journal vs documents: notes / 'I wrote down' / notebook → `notes`; my journal / diary → `journal notes`; document / paperwork / agreement / policy / scan / folder → `documents`.

Calls: `answer (notes called "…")` · `answer (journal notes) during yesterday` · `answer (documents called "…")`

- “find my notes on the lease” → `answer (notes called "lease")`
- “what did I put in my journal yesterday?” → `answer (journal notes) during yesterday`
- “do I have a copy of the tenancy agreement?” → `answer (documents called "tenancy agreement")`
- “any paperwork for the boiler?” → `answer (documents called "boiler")`

### `route.media` · dev 10

Photos / pictures / shots → `photos`; album → `albums`; 'where was it taken', 'places in my photos' → `places`.

Calls: `answer (photos called "…")` · `answer albums` · `answer places` · `answer photos of (#n)`

- “find the photo of the red door” → `answer (photos called "red door")`
- “what albums have I got?” → `answer albums`
- “which places show up in my photos?” → `answer places`
- “show me pictures from the lake house” → `search "lake house"` · `answer photos of (#1)`

### `route.money` · dev 12

Spending → `expenses` (rows for 'what did we spend on …', a sum for 'how much'); 'do I owe / does she owe me' → the debts `obligations of (party)`; a shared-expense group → `groups` and its expenses/members.

Calls: `answer expenses of (#n)` · `answer obligations of (#n)` · `answer (expenses called "…")`

- “list the grocery expenses in House Bills” → `search "House Bills"` · `answer (expenses of (#1)) called "groceries"`
- “is there money I owe Omar?” → `answer obligations of (parties called "Omar")`
- “show me the House Bills expenses” → `search "House Bills"` · `answer expenses of (#1)`
- “which expenses are in the Lisbon group?” → `search "Lisbon"` · `answer expenses of (#1)`

### `route.everything` · dev 5

No kind named: 'what do I have about X' → every kind (`things called "X"`); 'find X' / 'where's my X' where X names one thing → that one row only (look, then `answer #n`).

Calls: `answer (things called "…")` · `search "…" then answer #n`

- “what have I got on the Lisbon trip?” → `answer (things called "Lisbon")`
- “find the fridge warranty” → `answer (things called "fridge warranty")`
- “where's the lease?” → `search "lease"` · `answer #1`
- “anything about Kofi's wedding?” → `answer (things called "Kofi wedding")`

## filter

Field filters on a set: open/overdue, field values, numeric comparisons, the trash.

### `filter.open` · dev 5

'Left', 'still', 'to do', 'due', 'open', 'haven't done' → `status != "completed"`; 'overdue' → `due_at during before now and status != "completed"`.

Calls: `(tasks) that (status != "completed")` · `(tasks) that (due_at during before now and status != "completed")`

- “what haven't I done yet?” → `answer (tasks) that (status != "completed")`
- “am I late on any tasks?” → `answer (tasks) that (due_at during before now and status != "completed")`
- “which steps of the move plan are still open?” → `search "move"` · `answer (tasks of (#1)) that (status != "completed")`
- “which car jobs haven't I done yet?” → `answer (tasks called "car") that (status != "completed")`

### `filter.field` · dev 16

A field equals a value: flags (`favorite = true`, `starred = true`), filing (`folder = "Tax"`, `notebooks = "Garden"`), kind/type (`kind = "phone"`), empty fields (`due_at is null`), and 'not me' (`party_id is not me`).

Calls: `(photos) that (favorite = true)` · `(documents) that (folder = "Tax")` · `(notes) that (notebooks = "Garden")` · `(tasks) that (due_at is null)` · `(members of (#1)) that (party_id is not me)`

- “which photos are favourites?” → `answer (photos) that (favorite = true)`
- “list the documents filed in Tax” → `answer (documents) that (folder = "Tax")`
- “show me the Garden notebook's notes” → `answer (notes) that (notebooks = "Garden")`
- “which to-dos are undated?” → `answer (tasks) that (due_at is null and status != "completed")`
- “who else is in the House Bills group?” → `search "House Bills"` · `answer (members of (#1)) that (party_id is not me)`

### `filter.numeric` · dev 3

Compare a number field (`amount_minor > 10000`, `owed_to_me_minor > 3000`, `effort_min = 20`) or count a link (`count of photos = 3`).

Calls: `(expenses of (#1)) that (amount_minor > 10000)` · `(tasks) that (effort_min = 20)` · `(places that (count of photos = 1))`

- “which House Bills expenses were over a hundred dollars?” → `search "House Bills"` · `answer (expenses of (#1)) that (amount_minor > 10000)`
- “which task is about an hour's work?” → `answer (tasks) that (effort_min = 60 and status != "completed")`
- “places I've only got one photo from” → `answer (places that (count of photos = 1))`
- “only those above twenty bucks” → `answer (them) that (amount_minor > 2000)`

### `filter.trashed` · dev 3

'Did I delete / bin X', 'is X in the trash' → trashed rows are hidden unless asked for: `(<kind> called "X") that (deleted_at is not null)`.

Calls: `show (tasks called "gutter") that (deleted_at is not null)` · `answer (notes) that (deleted_at is not null)`

- “is the gutter task in the bin?” → `show (tasks called "gutter") that (deleted_at is not null)` · `answer #1`
- “is the old lease in the trash?” → `answer (documents called "lease") that (deleted_at is not null)`
- “has the kitchen picture been deleted?” → `answer (photos called "kitchen") that (deleted_at is not null)`
- “which notes have I thrown away?” → `answer (notes) that (deleted_at is not null)`

## link

Link walks from one row to its related rows.

### `link.parties_of` · dev 8

Who is at an event, who a debt or a photo is with → `parties of (#n)`; 'who's coming' leaves me out: `(parties of (#n)) that (party_id is not me)`.

Calls: `answer (parties of (#1)) that (party_id is not me)` · `answer parties of (#3)`

- “who's invited to the barbecue?” → `show (events called "barbecue")` · `answer (parties of (#1)) that (party_id is not me)`
- “who is that debt with?” → `answer parties of (#3)`
- “who's in this photo?” → `answer parties of (#2)`
- “which person is my accountant?” → `search "accountant"` · `answer parties of (#1)`

### `link.of_person` · dev 9

A person's own rows: `obligations of`, `contact channels of` (number, email), `important dates of`, `activities of` (calls, coffees), `events of`.

Calls: `answer (contact channels of (#1)) that (kind = "email")` · `answer events of (#2)` · `answer obligations of (#4)` · `answer activities of (#1)`

- “what's Omar's email?” → `answer (contact channels of (parties called "Omar")) that (kind = "email")`
- “when's my next meeting with her?” → `answer events of (#2)`
- “what was my most recent contact with Kofi?” → `show (parties called "Kofi")` · `answer first 1 of ((activities of (#1)) ordered by started_at desc)`
- “is Sofia in debt to me?” → `answer obligations of (parties called "Sofia")`

### `link.of_group` · dev 6

A shared-expense group's `expenses of`, `members of`, `settlements of`; an expense's `groups of`.

Calls: `answer expenses of (#1)` · `answer (members of (#1)) that (party_id is not me)` · `answer groups of (#3)`

- “what's gone into House Bills?” → `search "House Bills"` · `answer expenses of (#1)`
- “list the people in the Lisbon group” → `search "Lisbon"` · `answer (members of (#1)) that (party_id is not me)`
- “which group is the ferry ticket in?” → `search "ferry"` · `answer groups of (#1)`
- “has anyone settled up in House Bills?” → `answer settlements of (#1)`

### `link.media` · dev 16

Photos ↔ places ↔ albums ↔ people: `photos of` a place / album / person, `places of` / `albums of` a photo; `(albums) that (member of (#n))`.

Calls: `answer places of (#2)` · `answer albums of (#2)` · `answer photos of (#1)` · `answer photos of (places called "…")`

- “where did I shoot that one?” → `answer places of (#2)`
- “which album is it in?” → `answer albums of (#2)`
- “have I got photos of Lena?” → `show (parties called "Lena")` · `answer photos of (#1)`
- “pictures from Alfama” → `answer photos of (places called "Alfama")`
- “open the Garden 2026 album” → `search "Garden 2026"` · `answer photos of (#1)`

### `link.subtasks` · dev 1

The steps of a task: `tasks of (#n)`; 'what's left on the X plan' → `(tasks of (#n)) that (status != "completed")`.

Calls: `answer tasks of (#1)` · `answer (tasks of (#1)) that (status != "completed")`

- “what are the steps for the move?” → `search "move"` · `answer tasks of (#1)`
- “which garden project steps remain?” → `search "garden project"` · `answer (tasks of (#1)) that (status != "completed")`
- “which bits of the wedding prep are done?” → `search "wedding prep"` · `answer (tasks of (#1)) that (status = "completed")`

## time

Time windows, relative shifts, which date field a window applies to, ordering by time.

### `time.window` · dev 20

Named days and periods as said: `today`, `tomorrow`, `friday`, `the 9th`, `this week`, `this weekend`, `last month`, `next 2 months`, `recently`; a named month → its date range.

Calls: `(events) during this week` · `(things during the 9th)` · `that (captured_at during 2026-04-01..2026-04-30)`

- “which events do I have this weekend?” → `answer (events) during this weekend`
- “what's scheduled for the 9th?” → `answer (things during the 9th) ordered by dtstart asc`
- “photos from april” → `answer (photos) that (captured_at during 2026-04-01..2026-04-30)`
- “whose birthdays fall in the next two weeks?” → `answer (important dates) during next 2 weeks`

### `time.shift` · dev 1

Relative moves: 'an hour later' → `by: +1h`, 'half an hour earlier' → `by: -30m`, 'a day later' → `by: +1d`; 'in three days', 'next friday' as windows.

Calls: `reschedule{by: +1h} on #3` · `reschedule{by: -30m} on #2` · `(things during in 3 days)`

- “bump the call back by an hour” → `reschedule{by: +1h} on #2`
- “make yoga half an hour earlier” → `reschedule{by: -30m} on #1`
- “push it back a day” → `reschedule{by: +1d} on #1`
- “what's on in three days?” → `answer (things during in 3 days) ordered by dtstart asc`

### `time.field` · dev 6

Which date a window applies to: the row's own date `(set) during W`, or a named field — `due_at` (due), `completed_at` (ticked off / finished), `spent_on` (money), `captured_at` (photos, journal).

Calls: `(tasks) that (due_at during monday)` · `tasks that (completed_at during last week)` · `(expenses that (spent_on during last month))` · `(photos) that (captured_at during last weekend)`

- “what did I finish yesterday?” → `answer tasks that (completed_at during yesterday)`
- “which tasks fall due on monday?” → `answer (tasks) that (due_at during monday)`
- “what was my spending last week?” → `answer sum amount_minor of (expenses that (spent_on during last week))`
- “photos I took last weekend” → `answer (photos) that (captured_at during last weekend)`

### `time.derived` · dev 3

A window the person doesn't name but the vault dates ('while we're away', 'on the trip', 'during the conference'): read the dates of the rows that define it, then use an absolute range `2026-07-02..2026-07-06`.

Calls: `search "Lisbon"` · `(things during 2026-07-02..2026-07-06)` · `count of (photos during 2026-07-02..2026-07-06)`

- “what else is going on during my Lisbon stay?” → `search "Lisbon"` · `answer (things during 2026-07-02..2026-07-06) ordered by dtstart asc`
- “count the pictures from the Lisbon trip” → `search "Lisbon"` · `answer count of (photos during 2026-07-02..2026-07-06)`
- “anything else on while the conference is on?” → `show (events called "conference")` · `answer (things during 2026-09-14..2026-09-16) ordered by dtstart asc`

### `time.order` · dev 3

'Last', 'latest', 'most recent', 'next', 'earliest' → order and take: `first 1 of ((…) ordered by captured_at desc)`; a day's schedule `ordered by dtstart asc`.

Calls: `first 1 of ((journal notes) ordered by captured_at desc)` · `first 1 of ((activities of (#1)) ordered by started_at desc)`

- “show my most recent journal entry” → `answer first 1 of ((journal notes) ordered by captured_at desc)`
- “what's the latest activity logged with Omar?” → `show (parties called "Omar")` · `answer first 1 of ((activities of (#1)) ordered by started_at desc)`
- “what's my earliest thing tomorrow?” → `answer first 1 of ((things during tomorrow) ordered by dtstart asc)`
- “my newest photo?” → `answer first 1 of ((photos) ordered by captured_at desc)`

## num

Number answers: count, sum, one row's amount, dtstart of, group balance, owed_*.

### `num.count` · dev 2

'How many' → `answer count of (<set>)`.

Calls: `answer count of (…)`

- “how many notes are in the Garden notebook?” → `answer count of ((notes) that (notebooks = "Garden"))`
- “how many pictures are from last weekend?” → `answer count of ((photos) that (captured_at during last weekend))`
- “how many tasks are overdue?” → `answer count of ((tasks) that (due_at during before now and status != "completed"))`
- “how many of them are still open?” → `answer count of ((them) that (status != "completed"))`

### `num.sum` · dev 7

'How much did we spend', 'total', 'what does that come to', 'altogether' → `answer sum amount_minor of (<set>)`; over people `sum owed_to_me_minor of (them)`.

Calls: `answer sum amount_minor of (expenses of (#1))` · `answer sum amount_minor of (them)` · `answer sum owed_to_me_minor of (them)`

- “what's the House Bills total so far?” → `search "House Bills"` · `answer sum amount_minor of (expenses of (#1))`
- “add those up for me” → `answer sum amount_minor of (them)`
- “total spending for this month?” → `answer sum amount_minor of (expenses that (spent_on during this month))`
- “how much is that altogether?” → `answer sum owed_to_me_minor of (them)`

### `num.value_of` · dev 4

One row's number: 'what did X cost / come to', 'how much is the balance' → `answer amount_minor of (#n)`.

Calls: `answer amount_minor of (#1)`

- “how much were the ferry tickets?” → `search "ferry tickets"` · `answer amount_minor of (#1)`
- “how much is the vet bill?” → `search "vet"` · `answer amount_minor of (#3)`
- “how much was that one?” → `answer amount_minor of (#2)`
- “how much is left to pay on the garage bill?” → `search "garage"` · `answer amount_minor of (#4)`

### `num.dtstart_of` · **J** · dev 1

'When's my X thing' with no kind given, where X matches rows of several kinds → `answer dtstart of (things called "X")` so the runtime asks back; never pick one candidate yourself.

Calls: `answer dtstart of (things called "…")`

- “the vet thing — when is it?” → `answer dtstart of (things called "vet")`
- “when's the bank business?” → `answer dtstart of (things called "bank")`
- “when's the passport thing again?” → `answer dtstart of (things called "passport")`

### `num.balance` · dev 2

'How much does X owe me in the group / for the trip' → `answer balance of (#member) in (#group)`; 'and Y?' asks the same number for Y.

Calls: `answer balance of (#2) in (#1)`

- “what's Kofi's Lisbon balance with me?” → `search "Lisbon"` · `show (members of (#1))` · `answer balance of (#3) in (#1)`
- “where do I stand with Omar in House Bills?” → `search "House Bills"` · `show (members of (#1))` · `answer balance of (#2) in (#1)`
- “and Lena?” → `answer balance of (#4) in (#1)`

### `num.owed` · dev 4

Personal debts on people: 'who owes me' → `(parties that (owed_to_me_minor > 0))`; 'who do I owe' → `owed_to_them_minor > 0`; 'how much do I owe her' → `owed_to_them_minor of (#n)`; 'how much does he owe me' → `owed_to_me_minor of (#n)`.

Calls: `answer (parties that (owed_to_me_minor > 0))` · `answer (parties that (owed_to_them_minor > 0))` · `answer owed_to_them_minor of (#1)` · `answer owed_to_me_minor of (#4)`

- “anyone owe me cash?” → `answer (parties that (owed_to_me_minor > 0))`
- “who am I in debt to?” → `answer (parties that (owed_to_them_minor > 0))`
- “what's my debt to Sofia?” → `show (parties called "Sofia")` · `answer owed_to_them_minor of (#1)`
- _(after “who am I in debt to?”)_ “and the amount?” → `answer owed_to_them_minor of (#1)`

## follow

Follow-ups that refine, extend, switch or resume the conversation's current set.

### `follow.narrow` · dev 8

Refine the previous answer: 'just the weekend ones' → `answer (them during this weekend)`; 'only the open ones' → `answer (them) that (…)`; 'of those, the X ones' → `answer (them) called "X"`.

Calls: `answer (them during this weekend)` · `answer (them) that (status != "completed")` · `answer (them) called "…"`

- _(after “which events do I have next week?”)_ “just the ones on monday” → `answer (them during monday)`
- _(after “what haven't I done yet?”)_ “narrow that to anything about the car” → `answer (them) called "car"`
- _(after “anyone owe me cash?”)_ “only the ones over fifty” → `answer (them that (owed_to_me_minor > 5000))`
- _(after “which tasks fall due this week?”)_ “which of those are still open?” → `answer (them) that (status != "completed")`

### `follow.except` · dev 5

'What else' = the set the conversation is on minus the row just discussed: `answer (<set>) except (#n)`; 'what else have I got that day' still lists the whole day.

Calls: `answer (photos of (#1)) except (#3)` · `answer ((documents) that (folder = "Tax")) except (#2)`

- _(after “which album holds it?”)_ “what other shots are in there?” → `answer (photos of (#4)) except (#2)`
- _(after “find the tax return”)_ “what sits alongside it in that folder?” → `answer ((documents) that (folder = "Tax")) except (#1)`
- _(after “which locker entries mention the flat?”)_ “anything else on that shelf?” → `answer (locker items called "flat") except (#1)`
- _(after “who's joining yoga on thursday?”)_ “anything besides that on thursday?” → `answer (things during thursday) ordered by dtstart asc`

### `follow.switch_kind` · dev 14

Same subject, another kind: 'is there a document for it too?', 'and on my task list?', 'photos of any of them' → the new kind over the same name (`documents called "X"`) or over `them` (`photos of (them)`).

Calls: `answer (documents called "…")` · `answer (tasks called "…")` · `answer photos of (them)`

- _(after “open my notes on the lease”)_ “any documents on it?” → `answer (documents called "lease")`
- _(after “is the gym renewal on my calendar?”)_ “is it a task as well?” → `answer (tasks called "gym renewal")`
- _(after “who's invited to the barbecue?”)_ “any photos with them in?” → `answer photos of (them)`
- _(after “list the Garden folder”)_ “sorry, the Garden notebook, not the folder” → `answer (notes) that (notebooks = "Garden")`

### `follow.swap_subject` · dev 4

Same question, new subject: 'what about Alfama?', 'and Kofi?', 'and last month?' → repeat the previous call shape with the new name or window.

Calls: `(same shape as the previous turn, new name/window)`

- _(after “open my notes on Lisbon”)_ “what about Porto?” → `answer (notes) called "Porto"`
- _(after “what's Kofi's Lisbon balance with me?”)_ “and Lena?” → `answer balance of (#4) in (#1)`
- _(after “total spending for this month?”)_ “and last month?” → `answer sum amount_minor of (expenses that (spent_on during last month))`
- _(after “the harbour picture — where's that from?”)_ “same for the sunset picture?” → `search "sunset"` · `answer places of (#6)`

### `follow.back_to` · dev 7

'Back to X —' resumes an earlier thread: reuse the #n and sets from those turns, not the detour's.

Calls: `(the earlier turn's #n / set)`

- _(after a detour about the calendar)_ “ok, returning to those pictures: put the second in Garden 2026” → `media.add_to_album{album_id: (#9)} on #2`
- _(after a detour)_ “returning to the debts — which of those two is at saturday's barbecue?” → `show (events during saturday)` · `show parties of (#7)` · `answer #3`
- _(after starring and a detour)_ “back to the folder — bin the old lease” → `core.trash_document{} on #2`
- _(after a detour)_ “going back to the locker: reveal the router password as well” → `locker.reveal_receipt{columns: "password"} on #2`

## handle

Row handles: reading the #n shown, ordinals, rows from several turns back, `them` and multi-row.

### `handle.pick` · dev 31

Point at the row the words describe in what was just shown ('the wifi one', 'the one with Lena', 'that', 'it', 'her') by its `#n`; never retype a title you can point at.

Calls: `core.star_document{} on #2` · `answer parties of (#2)` · `reschedule{to: monday} on #1`

- “star the lease one” → `core.star_document{} on #2`
- “the picture with Lena — put it in the album” → `media.add_to_album{album_id: (#9)} on #4`
- “which person does that involve?” → `answer parties of (#1)`
- “make it monday instead” → `reschedule{to: monday} on #1`

### `handle.ordinal` · dev 4

'The first / second / last one' → the #n at that position in the last list as printed.

Calls: `complete{} on #2` · `reschedule{to: thursday} on #1`

- “the second — mark it complete” → `complete{} on #2`
- “shift the top one to thursday” → `reschedule{to: thursday} on #1`
- “delete the last one” → `delete{} on #3`
- “what's the third one?” → `answer #3`

### `handle.far` · dev 12

A row from several turns back ('her', 'that balance', 'the note from earlier') keeps its `#n` for the whole conversation: use it, don't search again.

Calls: `people.settle_debt{} on #3` · `answer (contact channels of (#2)) that (kind = "phone")`

- _(four turns after the debt #3 was shown)_ “clear that debt now” → `people.settle_debt{} on #3`
- _(after a detour)_ “her phone number, again?” → `answer (contact channels of (#2)) that (kind = "phone")`
- _(the parking note was #1, three turns ago)_ “put printing that parking note on my list” → `schedule.add_task{title: "Print the parking note"}`
- _(Ray was #4 two turns ago)_ “put down that I phoned him” → `people.log_interaction{kind: "call"} on #4`

### `handle.them` · dev 7

`them` = every row of the last result (also when more were found than printed); several named rows → `#2, #5`.

Calls: `answer sum amount_minor of (them)` · `reschedule{to: friday} on #2, #5` · `answer albums of (them)`

- “what do those add up to?” → `answer sum amount_minor of (them)`
- “both of those can go on friday” → `reschedule{to: friday} on #2, #5`
- “which albums are they in?” → `answer albums of (them)`
- “photos with any of those people?” → `answer photos of (them)`

## write

One skill per write verb (verbs of one call shape share a skill).

### `write.add_task` · dev 4

'Remind me to', 'add a task', 'put X on my list' → `schedule.add_task{title: "…", due_at: …}` (due_at only when a day was said).

Calls: `schedule.add_task{title: "…", due_at: friday}`

- “remind me to water the plants tomorrow” → `schedule.add_task{title: "Water the plants", due_at: tomorrow}`
- “new task: call Omar back” → `schedule.add_task{title: "Call Omar back"}`
- “put renewing my passport on the list for the 30th” → `schedule.add_task{title: "Renew my passport", due_at: the 30th}`
- “ok then, put it on my to-do list instead” → `schedule.add_task{title: "Order the ink"}`

### `write.event` · dev 1

Something at a time on a day → a calendar event: `schedule.propose_event{summary: "…", dtstart: <day> at HH:MM}`.

Calls: `schedule.propose_event{summary: "…", dtstart: friday at 14:00}`

- “put a vet appointment on tuesday at four” → `schedule.propose_event{summary: "Vet appointment", dtstart: tuesday at 16:00}`
- “lunch with Sofia friday at 1” → `schedule.propose_event{summary: "Lunch with Sofia", dtstart: friday at 13:00}`
- “book in a call with the bank monday at 9:30” → `schedule.propose_event{summary: "Call with the bank", dtstart: monday at 09:30}`

### `write.note` · dev 2

'Make a note to / note down' → `knowledge.create_note{title}`; 'save / keep X in my locker' → `locker.add_item{type: "note"|"login"|"card", title, content}`.

Calls: `knowledge.create_note{title: "…"}` · `locker.add_item{type: "note", title: "…", content: "…"}`

- “note to self: check the gutters” → `knowledge.create_note{title: "Check the gutters"}`
- “note down that the plumber prefers texts” → `knowledge.create_note{title: "The plumber prefers texts"}`
- “the garage code is 8812 — keep it in my locker” → `locker.add_item{type: "note", title: "Garage code", content: "8812"}`

### `write.reschedule` · dev 7

Move a task or event: `reschedule{to: <day or day at HH:MM>} on #n`, or by an offset `reschedule{by: +1h} on #n`.

Calls: `reschedule{to: friday} on #4` · `reschedule{to: monday at 10:00} on #2` · `reschedule{by: +1h} on #3`

- “can it go to thursday instead?” → `reschedule{to: thursday} on #1`
- “move the call to monday at 10” → `reschedule{to: monday at 10:00} on #2`
- “yoga should start an hour later” → `reschedule{by: +1h} on #3`
- “both of them can move to next monday” → `reschedule{to: next monday} on #1, #2`

### `write.mark` · dev 3

Mark done or star: `complete{} on #n` (a task), `core.star_document{} on #n` (a document).

Calls: `complete{} on #4` · `core.star_document{} on #2`

- “mark it done” → `complete{} on #1`
- “first one's done” → `complete{} on #1`
- “star that document” → `core.star_document{} on #2`
- “I've done the tax return task” → `show (tasks called "tax return")` · `complete{} on #1`

### `write.trash` · dev 5

Delete by kind: `delete{}` (task, event, note), `cancel{}` (an event call-off), `core.trash_document{}`, `tally.delete_expense{}`, `people.trash_person{}`, `locker.trash_item{}`, `media.delete_asset{}` — each `on #n`.

Calls: `delete{} on #4` · `core.trash_document{} on #4` · `tally.delete_expense{} on #1` · `people.trash_person{} on #1` · `media.delete_asset{} on #2`

- “get rid of my old car note” → `show (notes called "old car")` · `delete{} on #1`
- “bin the parking expense” → `search "parking"` · `tally.delete_expense{} on #1`
- “remove Kofi Mensah from my contacts” → `search "Kofi Mensah"` · `people.trash_person{} on #1`
- “trash the blurry photo” → `search "blurry"` · `media.delete_asset{} on #1`
- “call off the vet appointment” → `show (events called "vet")` · `cancel{} on #1`

### `write.restore` · dev 4

Put a trashed row back: `restore{} on #n` (task, note, photo, person), `core.restore_document{}`, `media.restore_asset{}`; an expense comes back with `tally.undo_expense{} on #n`.

Calls: `restore{} on #1` · `tally.undo_expense{} on #1` · `core.restore_document{} on #2`

- “undelete it” → `restore{} on #1`
- “restore the gutter task” → `show (tasks called "gutter") that (deleted_at is not null)` · `restore{} on #1`
- “bring the lease back” → `core.restore_document{} on #1`
- “undo that expense” → `tally.undo_expense{} on #1`

### `write.reveal` · dev 3

Only when the secret itself is asked for ('show me the password', 'what's the PIN') → `locker.reveal_receipt{columns: "password"} on #n`.

Calls: `locker.reveal_receipt{columns: "password"} on #1`

- “what's the password on it?” → `locker.reveal_receipt{columns: "password"} on #1`
- “what's the actual password for the router one?” → `locker.reveal_receipt{columns: "password"} on #2`
- “reveal the gym one too” → `locker.reveal_receipt{columns: "password"} on #3`

### `write.album_add` · dev 2

`media.add_to_album{album_id: (#album)} on #photo` — the album is a `#n` too (find it first if unseen).

Calls: `media.add_to_album{album_id: (#9)} on #4`

- “add it to the Garden 2026 album” → `search "Garden 2026"` · `media.add_to_album{album_id: (#5)} on #2`
- “put the sunset one in Lisbon highlights” → `search "Lisbon highlights"` · `media.add_to_album{album_id: (#7)} on #3`
- “add both to that album” → `media.add_to_album{album_id: (#1)} on #3, #4`

### `write.log_interaction` · dev 4

'Log that I called / had coffee with / visited / messaged X' → `people.log_interaction{kind: "call"|"coffee"|"visit"|"message"} on #party`.

Calls: `people.log_interaction{kind: "call"} on #4`

- “I phoned Omar, log it” → `show (parties called "Omar")` · `people.log_interaction{kind: "call"} on #1`
- “I had coffee with Lena — log it” → `show (parties called "Lena")` · `people.log_interaction{kind: "coffee"} on #1`
- “note that I messaged Kofi” → `show (parties called "Kofi")` · `people.log_interaction{kind: "message"} on #1`

### `write.settle` · dev 5

Pay off a personal debt → `people.settle_debt{} on #debt-or-party`; settle a group balance → `tally.settle_up{to_party: me, group_id: (#g), amount_minor: balance of (#m) in (#g)} on #m`.

Calls: `people.settle_debt{} on #2` · `tally.settle_up{to_party: me, group_id: (#1), amount_minor: balance of (#3) in (#1)} on #3`

- “mark that debt paid” → `people.settle_debt{} on #2`
- “pay Sofia back” → `show (parties called "Sofia")` · `people.settle_debt{} on #1`
- “square my Lisbon balance with Kofi” → `search "Lisbon"` · `show (members of (#1))` · `tally.settle_up{to_party: me, group_id: (#1), amount_minor: balance of (#3) in (#1)} on #3`

### `write.tally` · dev 2

Add a shared expense `tally.add_expense{description, amount_minor, paid_by: me, group_id: (#g)}`, or add a person to a group `tally.add_group_member{group_id: (#g)} on #p`.

Calls: `tally.add_expense{description: "…", amount_minor: 4200, paid_by: me, group_id: (#5)}` · `tally.add_group_member{group_id: (#1)} on #5`

- “add thirty dollars for the taxi to the Lisbon group, I paid” → `search "Lisbon"` · `tally.add_expense{description: "Taxi", amount_minor: 3000, paid_by: me, group_id: (#1)}`
- “add Lena Novak to House Bills” → `search "House Bills"` · `show (parties called "Lena Novak")` · `tally.add_group_member{group_id: (#1)} on #2`
- “put a 120 dollar electricity bill in House Bills” → `search "House Bills"` · `tally.add_expense{description: "Electricity bill", amount_minor: 12000, paid_by: me, group_id: (#1)}`

## compose

Composing writes: look-then-write, bulk, `A then B`, corrections, undo.

### `compose.lookup_write` · dev 8

When a write's target hasn't been shown, find it first (`search "…"` / `show (<kind>) called "…"`), then write on its `#n`; a group or album argument is a `#n` too.

Calls: `search "…" → <write> on #1` · `show (parties called "…") → <write> on #1`

- “trash the old lease” → `search "old lease"` · `core.trash_document{} on #1`
- “record that I rang Omar Haddad” → `show (parties called "Omar Haddad")` · `people.log_interaction{kind: "call"} on #1`
- “I paid twenty dollars for snacks — put it in the Lisbon group” → `search "Lisbon"` · `tally.add_expense{description: "Snacks", amount_minor: 2000, paid_by: me, group_id: (#1)}`

### `compose.bulk` · dev 4

One write names everything it applies to: `delete{} on #1, #4, #7`; 'settle up with everyone' → ONE `tally.settle_up{…, amount_minor: balance of (it) in (#g)} on #2, #3, #4`; never piecemeal across calls or turns.

Calls: `delete{} on #1, #4, #7` · `reschedule{to: friday} on #2, #5` · `tally.settle_up{to_party: me, group_id: (#1), amount_minor: balance of (it) in (#1)} on #2, #3, #4`

- “clear out everything gym-related” → `search "gym"` · `delete{} on #1, #2, #3`
- “square up with all the House Bills members” → `search "House Bills"` · `show (members of (#1)) that (party_id is not me)` · `tally.settle_up{to_party: me, group_id: (#1), amount_minor: balance of (it) in (#1)} on #2, #3, #4`
- “move the renewal to monday, task and calendar entry alike” → `search "renewal"` · `reschedule{to: monday} on #1, #3`

### `compose.then` · dev 1

Two different changes in one message → `A then B`.

Calls: `<write A> then <write B>`

- “move the call to thursday and the booking to friday” → `reschedule{to: thursday} on #2 then reschedule{to: friday} on #3`
- “tick off the first and delete the second” → `complete{} on #1 then delete{} on #2`
- “star it, and put printing it on my list” → `core.star_document{} on #1 then schedule.add_task{title: "Print the lease"}`

### `compose.correction` · dev 2

'Sorry, it was the other X' / 'no — that one's thursday' → the same write aimed at the right row (plus any new change it names); the first write stands — this is not an undo.

Calls: `<same write> on #<right row>`

- _(after “I rang Lena Novak — log it”)_ “wrong Lena — I meant the other one” → `show (parties called "Lena")` · `people.log_interaction{kind: "call"} on #2`
- _(after “put the second task on friday”)_ “no, that one belongs on tuesday — friday is for the booking” → `reschedule{to: tuesday} on #4 then reschedule{to: friday} on #3`
- _(after “add the harbour one to the album”)_ “wrong photo — the sunset one” → `media.add_to_album{album_id: (#9)} on #5`

### `compose.undo` · dev 2

'Scratch that', 'put it back', 'I didn't mean to' right after a write → undo it on the same row: `restore{} on #n`, `tally.undo_expense{} on #n`.

Calls: `restore{} on #1` · `tally.undo_expense{} on #1`

- _(after “bin the taxi expense”)_ “hmm, no — undo that” → `tally.undo_expense{} on #1`
- _(after “remove Kofi Mensah as a contact”)_ “no, bring him back” → `restore{} on #1`
- _(after “delete the gutter task”)_ “oops, I didn't mean that” → `restore{} on #1`

## judge

Judgement: ask on real ambiguity, say nothing, refuse by reason.

### `judge.ambiguous` · **J** · dev 5

A vague target (several Omars, 'the group' when there are two, 'all my X stuff' spanning many kinds): make the call over the set exactly as said and let the runtime ask; after `ambiguous: …`, name the `#n` if the message decides, else `done`.

Calls: `<write> on (parties called "Omar")` · `answer sum amount_minor of (expenses of (groups))` · `done`

- “pay Omar what I owe him” → `people.settle_debt{} on (parties called "Omar")`
- “is that Lena from work or the other one?” → `done`
- “put Kofi in the group” → `tally.add_group_member{group_id: (groups)} on (parties called "Kofi")`
- “how much have I paid into the group?” → `answer sum amount_minor of ((expenses of (groups)) that (paid_by = me))`

### `judge.no_link` · **J** · dev 3

A walk over a link the vault doesn't hold ('is there an event at that place?') comes back `ambiguous: no link …` → `done` (the runtime asks); when a who/what link is ambiguous but the starting row already answers, `answer #n` with that row.

Calls: `answer events of (#7)` · `done` · `answer #1`

- “any calendar event at that spot?” → `answer events of (#4)`
- “is the photo's Omar the same person?” → `answer parties of (#2)`
- “saturday's lunch — who's it with?” → `show (events called "lunch") that (dtstart during saturday)` · `answer parties of (#1)` · `answer #1`

### `judge.nothing_there` · dev 4

The target is only in the trash, or nowhere: a write → `nothing`; a read → the honest empty set or 0, never a near-miss row of another name or kind.

Calls: `nothing` · `answer (documents called "…")  (empty)` · `answer sum amount_minor of (…)  (0)`

- “trash my note on the old van” → `show (notes called "van")` · `show (notes called "van") that (deleted_at is not null)` · `nothing`
- “any document for Alfama?” → `answer (documents called "Alfama")`
- “total spent back in march?” → `answer sum amount_minor of (expenses that (spent_on during 2026-03-01..2026-03-31))`

### `judge.never_mind` · dev 3

'Never mind', 'forget it', 'actually no', 'leave it' before anything was done → `nothing`.

Calls: `nothing`

- “actually, don't bother” → `nothing`
- “forget it” → `nothing`
- “scrap that, I'll check later myself” → `nothing`
- “nah, leave it” → `nothing`

### `judge.refuse_outside` · dev 3

Anything the vault doesn't hold or can't do — weather, the web, booking or buying online, sending a text or email — → `refuse: out_of_ontology`.

Calls: `refuse: out_of_ontology`

- “will it rain in Lisbon tomorrow?” → `refuse: out_of_ontology`
- “order more printer ink” → `refuse: out_of_ontology`
- “send Omar a message saying happy birthday” → `refuse: out_of_ontology`
- “reserve a table at the Italian place for friday” → `refuse: out_of_ontology`

### `judge.refuse_guard` · dev 2

Protect the vault: sending a secret out of it → `refuse: sealed_egress`; inventing a password or code → `refuse: fabricated_secret`; 'delete everything' → `refuse: unbounded_destruction`.

Calls: `refuse: sealed_egress` · `refuse: fabricated_secret` · `refuse: unbounded_destruction`

- “message Kofi the garage code” → `refuse: sealed_egress`
- “dump all my passwords into a spreadsheet” → `refuse: sealed_egress`
- “make up a new router password for me” → `refuse: fabricated_secret`
- “wipe everything in my vault” → `refuse: unbounded_destruction`
