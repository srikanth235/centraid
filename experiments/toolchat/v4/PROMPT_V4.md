You are writing TRAINING DATA for a tiny on-device model that reads a person's chat with a personal-assistant app and turns each message into a formal "canonical" line. You are given the canonical lines of whole chat SESSIONS. Your job is the other direction: write the USER messages of each session, in order, that mean exactly those canonicals.

# The dialect (read it so you understand the canonicals; never output it)

`show <set>` lists rows. `count of <set>`, `sum|min|max <field> of <set>`, `<field> of <set>` are values (`dtstart of` = when something starts). `balance of <member> in <group>` is what that person owes me / I owe them inside a shared-expenses group. `<verb>{ arg: value } on <set>` is a write. `same? A B` asks whether two things are the same one. `nothing` means the person took the request back ("actually never mind"). `refuse: <reason>` means the request is outside the app (weather, web, booking, shopping...) — the user simply ASKS for that thing. `<set> called "X"` is a name match, `that (<condition>)` a filter, `during <window>` a time filter, `ordered by <field> asc|desc` a sort, `first N of` a limit, `A except B` a difference, `<kind> of (<set>)` follows a link. Kinds: events (diary), tasks (to-dos), notes, journal notes, documents, parties (people/contacts), members (people in shared-expense groups), important dates (birthdays...), contact channels (phone numbers, emails), activities (calls/visits/coffees logged with people), obligations (debts between me and someone), photos, albums, places, expenses, groups (shared-expense groups/trips), locker items (password-manager entries), things (anything: diary + to-dos + birthdays). `due_at during before now and status != "completed"` = overdue; `status != "completed"` = still open / due / left to do. `amount_minor` is in pence/cents (4200 = 42.00). `social.send_message{ body }` = text/message someone. `people.log_interaction{ kind, since }` = log that I had a call/coffee/visit/message with someone on that day. `people.settle_debt` = pay off / settle up. `reschedule{ to: X }` = move/push to X; `reschedule{ by: +1h }` = an hour later. `locker.reveal_receipt{ columns: "password" }` = show me the password.

Pointers: `it`, `them`, `the 2nd one`, `the other one` = the rows the conversation just answered; `the earlier one` = the answer from two turns back; `the last thing I added` = what I just created.

Relative days in a canonical are said EXACTLY that way by the user: `thursday` -> "thursday" / "on thursday" / "this thursday"; `next friday` -> "next friday"; `last tuesday` -> "last tuesday"; `tomorrow`, `today`, `yesterday` as is; `the 21st` -> "the 21st"; `in 3 days` -> "in 3 days" / "in three days"; `at 14:00` -> "at 2pm" / "at 14:00", `at 09:30` -> "at 9.30" / "half nine". An ISO date like `2027-04-14` is an explicit date the user states ("april 14th", "14 april"). Never add a different weekday or date word.

# The job

Each task is one session: `today`, then `turns` in order, each with the `canonical`, a `gloss` (stilted English reading, may be empty) and a `hint` (what the person is doing, with the reasoning for pronouns). `move` tells you how a turn relates to the one before: `first` (opens the chat), `new` (a fresh request in the same chat), `act` (does something to / asks about what was just answered), `refine` (narrows what was just answered), `substitute` (same question, one thing swapped — "and Imogen?", "what about next week?"), `switch` (a sudden topic change — "hang on, ..."), `backtrack` (returning to the earlier topic — "anyway, back to ...", "ok going back to those tasks, ..."), `undo` (withdraws: "actually never mind").

Write **2 different versions of the whole session**: version 1 in register `registers[0]`, version 2 in `registers[1]`:

- `terse`: short fragments, 2–7 words per message ("overdue stuff?", "and Imogen?", "bin the 2nd one");
- `question`: plain everyday questions/requests, 5–14 words;
- `spoken`: chatty, hesitant or verbose ("umm could you...", "right so I was wondering..."), up to ~25 words. The two versions must use different wording, not a word swap.

## Rules

1. **English, not the dialect.** Never write `that (`, `ordered by`, `of (`, braces, field names (`due_at`, `amount_minor`, `dtstart`...), command names, or quote marks around words just because the canonical quoted them.
2. **Exact meaning, per message.** Each user message must mean exactly its canonical, given the conversation so far. Every filter, window, sort, argument must be recoverable; add nothing.
3. **Follow-ups sound like follow-ups.** Where the canonical uses a pointer (`it`, `them`, `the 2nd one`, `the earlier one`...), the message uses a pronoun, ordinal or fragment ("move it to friday", "tick off the second one", "how much?", "what else is in there?") and does NOT re-name the rows. Where the canonical names something again (a backtrack that repeats an earlier line, or a name resolved from a pronoun), the message may use a pronoun only if the hint says so, otherwise it names it.
4. **Literals.** Words of a `called "X"` literal must appear in the message verbatim (any case) — say "the yoga one", "Wendell's number", "the trip group" for `called "trip"`; never add other title words. A created title/summary/description/body (`title: "Renew passport"`) appears word for word (case may differ). Filter values (`folder = "Travel"`, `role = "Dentist"`, `notebooks contains "Recipes"`) appear as the word. Money (`amount_minor: 4200`) is said as money ("42 quid", "£42", "forty two dollars", "42.00").
5. **Dates**: exactly as in "Relative days" above, consistent with `today`. Window words (`this week`, `last month`, `before now`, `this weekend`, `last weekend` = "over the weekend" past tense) are said naturally.
6. Lower case, missing apostrophes and an occasional small typo are fine now and then (never inside a name or literal).

# Output

One JSON object per line per task, nothing else — no markdown fence, no commentary:

{"id": "<task id>", "v": [["msg for turn 1", "msg for turn 2", ...], ["version 2 msg 1", "version 2 msg 2", ...]]}

Each version has exactly one message per turn. One line per task, in the order given. Reply with these lines directly as your answer text: do not use any tool and do not write any file.

# The tasks
