You are writing TRAINING DATA for a tiny model that turns what a person says to a personal-assistant app into a formal "canonical" sentence. You are given the canonical sentences. Your job is the other direction: for each one, invent the things a real person might have SAID to get that meaning.

# The dialect (read it so you understand the canonicals; never output it)

`show <set>` lists rows. `count of <set>`, `sum|min|max <field> of <set>`, `<field> of <set>` are values. `balance of <set> in <set>` is who owes what. `<verb>{ arg: value, ... } on <set>` is a write; `A then B` is two writes in order. `same? A B` asks whether two rows are the same one. `nothing` means the person took the request back. `refuse : <reason>` is a hard no. `<set> called "X"` is a name match, `<set> that (<pred>)` a filter, `<set> during <window>` a time filter, `ordered by <field> asc|desc` a sort, `first N of (<set>)` a limit, `A and B` a union, `A except B` a difference. `<kind> of (<set>)` walks a link ("the photos of that album"). Kinds are boards: events, tasks, notes, journal notes, documents, parties, members, profiles, important dates, contact channels, activities, obligations, photos, albums, notebooks, places, expenses, groups, circles, settlements, accounts, transactions, projects, locker items, things. `it`, `them`, `that one`, `the 2nd one`, `the other one`, `the earlier one`, `the last thing I added` point back at what the previous turn answered.

# The job

Each task gives you `prev` (the canonical of the PREVIOUS turn, or `NONE` for a fresh start) and `target` (the canonical of THIS turn). Write REQUESTED_COUNT different things a person might have said, in this turn, to mean exactly `target`.

## Rules

1. **Write English, not the dialect.** Never use the canonical's operator words as syntax (`that (`, `ordered by`, `of (`), never quote a command name, never write braces. Say it the way a person says it.
2. **Cover the meaning exactly.** Every filter, window, sort, limit and argument in `target` must be recoverable from the sentence. Don't add conditions that aren't there, and don't drop one.
3. **When `prev` is not NONE, this is a FOLLOW-UP.** It should sound like one: "and what about…", "same for Tuesday", "no, the other one", "undo that", "actually make it Friday", "just the ones from last week", "scrap that", "ok do it", elliptical fragments. When `target` reuses `it`/`them`/`the other one`, the sentence must use a pronoun or a fragment, not re-name the rows. When `target` names a row the previous turn did not answer, the sentence must name it.
4. **Copy literals verbatim.** Any quoted string in `target` — especially a write's `title`, `description`, `summary`, `name`, `label`, `reason` — must appear in the sentence WORD FOR WORD (quote marks optional). Never paraphrase a title. Numbers and amounts may be said naturally (`amount_minor: 1450` → "fourteen fifty" or "£14.50"). Dates may be said naturally ("the 9th of February", "next Tuesday", "09/02/2027", "2027-02-09") as long as they mean that date. 4b. **Put the literal in a different PLACE and a different DRESS each time.** The tiny model has to learn to copy a name out of a sentence, so the same name must turn up at the start, in the middle and at the end across the REQUESTED_COUNT sentences, sometimes in quotes, sometimes bare, sometimes wrapped in a natural phrase — `notes called "Window sealing method"` can be "the Window sealing method note", "that note, Window sealing method", "my jotting called Window sealing method", "Window sealing method — the note". For a READ filter (`called "X"`) you may also shorten to the distinctive part of X, keeping those words exactly ("the Window sealing one", "the sealing method note"); never invent words that are not in X. For a WRITE argument the whole value stays word for word, unshortened.
5. **Vary the register across the REQUESTED_COUNT sentences.** Use each of these at least once, in a mixed order:
   - terse (3–6 words, no politeness)
   - a plain question
   - a blunt imperative
   - verbose and polite ("could you possibly…", "I was wondering whether…")
   - spoken, with hesitation ("umm", "so like", "right, so", trailing "?")
   - one with a realistic typo or two (missing letter, doubled letter, "teh", no apostrophe) — one or two typos, still readable
   - colloquial / slangy ("chuck", "bin it", "ping", "how much am I down") Vary the vocabulary too: a task is also a job, a to-do, an errand, a thing on my list; an event is a thing in my diary, an appointment, what's on; a photo is a picture, a shot, a snap, a frame; an expense is a spend, a charge, what I paid; a note is a jotting, something I wrote down; delete is bin, chuck, get rid of, scrub; reschedule is move, push, shift, bump.
6. **Never repeat yourself.** The REQUESTED_COUNT sentences for one task must be genuinely different sentences, not the same one with a word swapped.
7. Lower case starts, missing full stops and one-word fragments are all fine and welcome — people type like that.

# Output

One JSON object per line, nothing else. No markdown fence, no commentary.

{"id": "<the task's id>", "u": ["sentence one", "sentence two", ...]}

Exactly one line per task, in the order given, each with REQUESTED_COUNT sentences.

# The tasks
