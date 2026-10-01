You are writing TRAINING DATA for a tiny on-device assistant that answers a person's messages about their personal vault (calendar, to-dos, notes, documents, contacts, photos, shared expenses, a password locker). You are given chat SESSIONS as a list of turns; each turn says what the person wants (`hint`) and which words they must say (`say`). Write the PERSON'S messages.

# The job

Each task is one session: `today` (the weekday and date the chat happens), then `turns` in order. Each turn has:

- `hint` — what the person asks or asks for, in plain words. Follow it exactly: every thing, person, day, amount and condition in the hint must be recoverable from the message, and nothing may be added (no extra date, person, filter, amount or detail).
- `say` — words or phrases that must appear in the message VERBATIM (any letter case, the words in that order, nothing inserted between them). They are what the assistant will copy (a name to search, a title to create, a day, an amount). Do not respell, pluralise, abbreviate, split or translate them; do not put a typo in them.
- `shown` (from the second turn on) — what the assistant showed the person at the end of the previous turn. It is context only, so a follow-up can lean on it naturally ("move it", "the other one", "and her number?", "the second one"). Do not re-name rows from `shown` unless the hint or `say` names them.

Write `versions` different versions of the WHOLE session, each in the register at the same position of `registers`. A person keeps one register through a version:

- `terse`: clipped fragments, 2–7 words ("pottery stuff?", "move the 2nd one to friday", "Kofi's number");
- `texting`: lowercase, little punctuation, casual shorthand ("pls", "u", "rn", "thx", "wanna"); at most ONE small typo per message and never inside a `say` phrase;
- `spoken`: how people talk to a voice assistant — hesitant, filler, self-interruption ("umm can you…", "ok so what's… what've I got on friday"), up to ~25 words;
- `polite`: complete and courteous ("Would you mind…", "Could you tell me…", "please");
- `rambling`: a little backstory or a reason before or after the request ("I'm trying to sort the house stuff out before the weekend, so…"), up to ~35 words, still ONE request — the backstory must not add a name, day, amount or condition the hint lacks. Versions must differ in vocabulary and sentence shape, not only by a word swap. Vary synonyms freely OUTSIDE the `say` phrases (calendar/diary/schedule; delete/bin/get rid of; photos/pics/shots; task/to-do/reminder; contacts/people).

# Rules

1. **Plain English.** Never write tool syntax, field names, `#` numbers, or quote marks around words just because they are in `say`.
2. **Follow-ups sound like follow-ups.** A turn that acts on what the assistant just showed ("the second one", "those", "her", "that group", "it") uses a pronoun, ordinal or fragment and does not re-name the rows — unless the hint names someone, in which case use the name as given in `say`. Pronouns must fit `shown` (a person is "her"/"him"/"them", a group of rows "those"/"them", one row "it"/"that one").
3. **Days.** A day in `say` is said exactly that way ("friday", "next friday", "tomorrow", "this weekend"); a time "at 14:00" may be said "at 2pm", "at two" or "at 14:00" but the day word stays as given. Never add a date the hint does not have, and never replace a weekday by a calendar date.
4. **Money** in a hint ("42 (money)") is said as money with the digits from `say` ("42 quid", "$42", "42 dollars", "€42") — any currency style, but the digits stay digits.
5. A hint "takes it back: never mind" is a withdrawal ("actually forget it", "never mind", "scratch that, leave it"). A hint "corrects: no, make it X" is a correction of the previous request ("no wait, X instead"). A hint "undo" is "put it back", "undo that", "I didn't mean to".
6. A request the vault cannot do (weather, booking a table, the web, sending a message) is simply asked for, naturally.
7. **Hint prefixes** are for you; never write them out:
   - `follow-up: …` acts on what was just shown: lean on it ("those", "it", "that one", "the second one", "and her?") and name nothing the `say` list does not have. With an empty `say` it names nothing new at all.
   - `(new topic) …` changes the subject: ask it as a fresh question (you may open with "also", "different thing", "oh and", or nothing).
   - `(detour) hang on — …` breaks off the current thread for a quick aside: open with an interruption ("hang on", "wait, quick one", "before I forget", "sorry, random question").
   - `back to <topic> — …` returns to an earlier thread after a detour: signal the return and point at that thread loosely ("ok back to the …", "going back to what we were doing", "right, where were we — the …"), then ask the rest of the hint.
8. A hint "about the first one, asks …" refers to a row by its position in what was shown: say the position ("the first one", "number two") — never its name unless `say` has it.
9. Words in parentheses inside a hint are for you, not for the person ("(the one person just shown)", "(this week)", "(two contacts are called Roisin; the message doesn't say which)"): say what they mean naturally, but never add what the parenthesis says the message lacks, and a `say` phrase must still appear.

# Output

One JSON object per line per task, nothing else — no markdown fence, no commentary:

{"id": "<task id>", "v": [["msg for turn 1", "msg for turn 2", ...], ["version 2 msg 1", ...]]}

Exactly `versions` versions, each a LIST with exactly one message per turn, in order — also when the session has one turn (`[["msg"], ["msg"]]`). Reply with these lines directly as your answer text: do not use any tool and do not write any file.

# The tasks
