You are writing TRAINING DATA for a tiny on-device model that reads a person's chat with a personal-assistant app and turns each message into a formal "canonical" line. You are given the canonical lines of chat SESSIONS (often a single message). Your job is the other direction: write the USER messages of each session, in order, that mean exactly those canonicals.

# The dialect (read it so you understand the canonicals; never output it)

`show <set>` lists rows. `count of <set>`, `sum|min|max <field> of <set>`, `<field> of <set>` are values (`dtstart of` = when something starts). `balance of <member> in <group>` is what that person owes me / I owe them inside a shared-expenses group. `<verb>{ arg: value } on <set>` is a write. `same? A B` asks whether two things are the same one. `nothing` means the person took the request back ("actually never mind"). `refuse: <reason>` means the request is outside the app (weather, web, booking, shopping...) — the user simply ASKS for that thing. `<set> called "X"` is a name match, `that (<condition>)` a filter, `during <window>` a time filter, `ordered by <field> asc|desc` a sort, `first N of` a limit, `A except B` a difference, `<kind> of (<set>)` follows a link. Kinds: events (diary), tasks (to-dos), notes, journal notes, documents, parties (people/contacts), members (people in shared-expense groups), important dates (birthdays...), contact channels (phone numbers, emails), activities (calls/visits/coffees logged with people), obligations (debts between me and someone), photos, albums, places, expenses, groups (shared-expense groups/trips), locker items (password-manager entries), things (anything: diary + to-dos + birthdays). `due_at during before now and status != "completed"` = overdue; `status != "completed"` = still open / due / left to do. `amount_minor` is in pence/cents (4200 = 42.00). `social.send_message{ body }` = text/message someone. `people.log_interaction{ kind, since }` = log that I had a call/coffee/visit/message with someone on that day. `people.settle_debt` = pay off / settle up. `reschedule{ to: X }` = move/push to X; `reschedule{ by: +1h }` = an hour later. `locker.reveal_receipt{ columns: "password" }` = show me the password.

Pointers: `it`, `them`, `the 2nd one`, `the other one` = the rows the conversation just answered; `the earlier one` = the answer from two turns back; `the last thing I added` = what I just created.

Relative days in a canonical are said EXACTLY that way by the user: `thursday` -> "thursday" / "on thursday" / "this thursday"; `next friday` -> "next friday"; `last tuesday` -> "last tuesday"; `tomorrow`, `today`, `yesterday` as is; `the 21st` -> "the 21st"; `in 3 days` -> "in 3 days" / "in three days"; `at 14:00` -> "at 2pm" / "at 14:00", `at 09:30` -> "at 9.30" / "half nine". An ISO date like `2027-04-14` is an explicit date the user states ("april 14th", "14 april"). Never add a different weekday or date word.

# The job

Each task is one session: `today`, then `turns` in order, each with the `canonical` and a `hint` (what the person is doing). `move` tells you how a turn relates to the one before: `first` (opens the chat), `act` (does something to / asks about what was just answered), `refine` (narrows what was just answered), `undo` (withdraws or reverses: "actually never mind", "oh no put it back").

Write `versions` different versions of the WHOLE session, each in the register at the same position of `registers`:

- `terse`: short fragments, 2-7 words per message ("fav photos?", "bin the 2nd one");
- `question`: plain everyday questions/requests, 5-14 words;
- `spoken`: chatty, hesitant or verbose ("umm could you...", "right so I was wondering..."), up to ~25 words;
- `texting`: lowercase, no punctuation, casual shorthand ("pls", "u", "rn", "thx"), ONE small typo in an ordinary word (never in a name, a stored-title word, a number, or a day/date/time word);
- `polite`: complete, courteous, indirect ("Would you mind...", "I'd like to...", "Could you tell me..."). Every version must use genuinely different vocabulary and sentence shape, not a word swap. Vary synonyms (e.g. photos/pics/pictures/snaps; delete/bin/remove/get rid of; calendar/diary/schedule; notes/jottings; locker/password vault/password manager).

## Stored rows (`refer`)

Some tasks list `refer`: rows the canonical names by their FULL STORED TITLE (e.g. `tasks called "Reserve the lakeside cabin"`). The person has not memorised that title. For each refer entry, in the message of turn `turn` (1-based), follow `say` exactly:

- `exact: W` — name the row with exactly the words W (verbatim, any case, in this order) and NO other word of the stored title ("the cabin one", "my cabin task");
- `loose: W` — use the word W and describe the row in your own words that are NOT in the stored title ("the cabin booking", "that cabin thing", "the cabin trip stuff"); never the full title;
- `full` — say the full stored title (any case). Rule 4 below does NOT apply to refer literals; it applies to every other quoted literal.

## Rules

1. **English, not the dialect.** Never write `that (`, `ordered by`, `of (`, braces, field names (`due_at`, `amount_minor`, `dtstart`, `favorite`, `starred`...), command names, or quote marks around words just because the canonical quoted them.
2. **Exact meaning, per message.** Each user message must mean exactly its canonical, given the conversation so far. Every filter, window, sort, limit, argument must be recoverable; add nothing (no extra date, person or condition).
3. **Follow-ups sound like follow-ups.** Where the canonical uses a pointer (`it`, `them`, `the 2nd one`...), the message uses a pronoun, ordinal or fragment ("move it to friday", "tick off the second one", "how much?") and does NOT re-name the rows.
4. **Literals.** Words of a quoted literal appear in the message verbatim (any case): a `called "X"` name, a filter value (`label = "work"` -> "work"), a created title/content (`title: "Garage code"`, `content: "4417"` -> "save the garage code 4417"). Money (`amount_minor: 4200`) is said as money ("42 quid", "£42", "forty two dollars", "42.00"). Enum values may be said naturally: `kind = "org"` -> companies/organisations, `kind = "animal"` -> pets, `type = "card"` -> cards, `category = "food"` -> food.
5. **Dates**: exactly as in "Relative days" above, consistent with `today`. Window words (`this week`, `last month`, `this weekend`, `last weekend` = "over the weekend" past tense) are said naturally.
6. `nothing` = the person takes back the previous request ("actually forget it", "never mind, leave it", "scratch that"). `tally.undo_expense` / `people.undo_person` / `restore` on `it` right after a delete = "oh no, put it back", "undo that", "bring them back".

# Output

One JSON object per line per task, nothing else — no markdown fence, no commentary:

{"id": "<task id>", "v": [["msg for turn 1", "msg for turn 2", ...], ["version 2 msg 1", ...], ...]}

Exactly `versions` versions, each with exactly one message per turn. One line per task, in the order given. Reply with these lines directly as your answer text: do not use any tool and do not write any file.

# The tasks
