You are writing TRAINING DATA for a tiny on-device model that turns what a person says to a personal-assistant app into a formal "canonical" sentence. You are given the canonicals. Your job is the other direction: for each one, write what a real person might have SAID to mean exactly that.

# The dialect (read it so you understand the canonicals; never output it)

`show <set>` lists rows. `count of <set>`, `sum|min|max <field> of <set>`, `<field> of <set>` are values. `balance of <set> in <set>` is who owes what inside a shared-expenses group. `<verb>{ arg: value, ... } on <set>` is a write; `A then B` is two writes in that order. `same? A B` asks whether two things are the same one. `nothing` means the person took the request back. `refuse: <reason>` is a hard no; `clarify: <reason>` means the assistant has to ask which one. `<set> called "X"` is a name match, `<set> that (<condition>)` a filter, `<set> during <window>` a time filter, `ordered by <field> asc|desc` a sort, `first N of (<set>)` a limit, `A and B` both sets, `A except B` a difference. `<kind> of (<set>)` follows a link ("the photos in that album", "the people at that event"). Kinds are boards: events (diary), tasks (to-dos), notes, journal notes (notes about people), documents, parties (people/contacts), members (people in shared-expense groups), profiles, important dates (birthdays, anniversaries), contact channels (phone numbers, emails), activities (calls/visits/coffees logged with people), obligations (debts between me and someone), photos, albums, notebooks, places, expenses, groups (shared-expense groups/trips), circles, settlements, accounts, transactions, projects, locker items (password-manager entries), things (anything). `it`, `them`, `that one`, `the 2nd one`, `the other one`, `the earlier one`, `the last thing I added` point back at what the previous turn answered. `before now` on a due date means overdue. `status != "completed"` on tasks means still open / not done. `amount_minor` is in pence (1250 = £12.50). `me` is the person talking.

Each task also carries a `gloss`: a stilted but exact English reading of the target. Use it to understand the target; never copy its wording.

# The job

Each task gives you `today` (weekday and date), `prev` (the canonical of the PREVIOUS turn, or `NONE` for a fresh start) with its `prev_gloss`, the `target` canonical of THIS turn with its `gloss`, sometimes a `hint`, and `registers`: the three styles to write in, in that order. Write exactly **3** genuinely different things a person might have said, in this turn, to mean exactly `target`.

## Rules

1. **Write English, not the dialect.** Never write `that (`, `ordered by`, `of (`, braces, quotes around command names, or raw field names such as `due_at`, `amount_minor`, `dtstart`, `display_name`. Say it the way a person says it ("when it's due", "how much", "when it starts", "their name").
2. **Cover the meaning exactly.** Every filter, time window, sort, limit, link and argument in `target` must be recoverable from the sentence; add nothing that is not there. A condition like `status != "completed"` next to a due window is what "due"/"still to do"/"open" means — say it that way ("what's still due this week"), not as a separate clause about status.
3. **Registers.** Write the three sentences in the three `registers` given, in order:
   - `terse`: 2–6 words, a fragment is fine ("overdue tasks?", "bin the Porto trip album");
   - `question`: a plain everyday question or request, about 5–12 words;
   - `spoken`: verbose or spoken — polite, hesitant, rambling or chatty ("umm could you…", "right, so I was wondering…"), up to ~25 words. Real users type lower case, skip full stops and apostrophes, and sometimes make a small typo; do that now and then. Vary vocabulary: a task is a to-do / job / thing on my list; an event is an appointment / what's on / thing in my diary; a photo is a picture / shot / snap; an expense is a spend / what I paid; delete is bin / get rid of / scrap; reschedule is move / push / shift / bump.
4. **Follow-ups sound like follow-ups.** When `prev` is not NONE the person is continuing a conversation: "and…", "what about…", "just the ones from last week", "ok bin it", "how much?", "no, the other one", "undo that". When `target` contains a pointer (`it`, `them`, `that one`, `the 2nd one`, `the other one`, `the earlier one`, `the last thing I added`), the sentence must use a pronoun, an ordinal or a fragment ("delete it", "the second one", "those", "the other one", "go back to the one before", "the thing I just added") and must NOT re-name the rows. When `target` names something, the sentence must name it (unless the `hint` says a pronoun is used).
5. **Literals.** Any quoted string in `target` must be recoverable:
   - a WRITE value (`title:`, `description:`, `summary:`, `content:`) appears in the sentence WORD FOR WORD, unshortened (quote marks optional);
   - a READ name (`called "X"`) may be the full X or its distinctive words ("the gutters task" for "clean the gutters") — never invent words not in X; a person's full name may be said as the full name, a first name only if X is a first name;
   - a filter value (`contains "EUR"`, `= "birthday"`) is said naturally but recognisably. Numbers: amounts in pence are said as money ("£12.50", "twelve fifty", "12.50"); durations like `+1d` / `-2h` as "a day later", "two hours earlier".
6. **Dates are relative to `today`.** Say a date either relatively ("Thursday", "this Thursday", "tomorrow", "next Monday", "the 12th", "a week on Friday") or explicitly ("12 March", "March 12th 2027", "12/03"), mixing both across the three sentences, and always consistent with `today`. Times on the half hour are said naturally ("at 2.30", "half nine", "18:00"). Window words in `target` (`this week`, `last month`, `before now`, `next 3 days`, `recently`) are said naturally ("overdue", "in the next few days", "lately").
7. **`refuse`, `clarify`, `nothing`, `same?`.** Follow the `hint` for the situation: a refusal is the person ASKING for the thing that must be refused (never mention the refusal); a clarify is the person saying the ambiguous thing; `nothing` is the person withdrawing ("actually never mind", "leave it", "scratch that"). `same?` is a yes/no question about identity ("is that the same Wren as…", "is the picnic photo in the Wedding album?").
8. **Three different sentences**, not one sentence with a word swapped.

# Output

One JSON object per line, nothing else — no markdown fence, no commentary:

{"id": "<the task's id>", "u": ["sentence one", "sentence two", "sentence three"]}

Exactly one line per task, in the order given, each with exactly 3 sentences. Reply with these lines directly as your answer text: do not use any tool and do not write any file.

# The tasks
