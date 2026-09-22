You are writing TRAINING DATA for a tiny model that turns what a person says to a personal-assistant app into a formal "canonical" sentence. This batch is the DECLINATIONS: the sentences whose only correct answer is a refusal or a withdrawal. Your job is to invent the sentences.

The app owns a personal vault: a diary, a task board, notes, documents, photos and albums, people and their contact details, shared expenses and who owes whom, and an encrypted locker of passwords and codes. It can list, count and edit those, and nothing else.

You are given a batch of tasks. Each task has a `target` (the canonical answer), a `reason` (why), and a `prev` (the previous turn's canonical, or NONE).

# What each reason means

- **refuse : out_of_ontology** — the person asked for an ACTION THE APP CANNOT TAKE, or a fact the vault does not hold. Sending a text or an email, phoning somebody, paying by bank, ordering something from a shop, booking a taxi, setting a phone alarm, playing music, checking the weather or the news or a train time, translating something, doing arithmetic that has nothing to do with the vault, buying tickets, printing, posting to social media.
- **refuse : sealed_egress** — the effect would move SECRET material out of the locker: read me a password, copy a door code out, email a login to somebody, export the whole locker, screenshot the credentials, put a password in a note, dictate the card number.
- **refuse : fabricated_secret** — the person asked for a secret to be STORED that they did not supply: add a locker entry and let the assistant choose the password, rotate a password to "anything", make up a PIN, invent a code.
- **refuse : unbounded_destruction** — a destructive request over EVERYTHING, with no name, filter or window at all: delete every note, wipe all photos, empty the vault, bin the lot, clear out all my tasks.
- **nothing** — the person TOOK THE REQUEST BACK, right after asking for something. A withdrawal, an apology, a change of mind, a "leave it".

# Rules

1. Write REQUESTED_COUNT sentences per task, all genuinely different — not one sentence with words swapped. Different verbs, different objects, different sentence shapes, different lengths.
2. Vary the register: terse, a question, a blunt imperative, verbose and polite, spoken with hesitation ("umm", "so like"), one or two with realistic typos, colloquial slang.
3. Invent the names and places you need. Use plain everyday names — and do NOT reuse the same name more than twice across the whole batch.
4. A `nothing` sentence must read as a withdrawal of the request `prev` describes, and must not say anything new: "no, forget it", "actually leave it", "cancel that", "scrap that, sorry", "nah, don't bother", "on second thoughts no", "undo", "wait — don't", "my mistake, ignore that".
5. Never write the canonical dialect. No braces, no `that (`, no command names.

# Output

One JSON object per line, nothing else. No markdown fence, no commentary.

{"id": "<the task's id>", "u": ["sentence one", "sentence two", ...]}

Exactly one line per task, in the order given, each with REQUESTED_COUNT sentences.

# The tasks
