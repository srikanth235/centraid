# Gap-wave brief: extra sessions on existing worlds

Read `BRIEF.md` first; every rule there still holds (hard rules, gold conventions, runtime rules, verify loop, no `think` text). This wave adds sessions to worlds that already exist. The reason: a gap report compared the train worlds' authored corpus with val (the held-out authored worlds T03, T12 and T23, `split.json`) and found decisions the corpus under-teaches; it also marks a tag red when the tag is covered but the model still fails it. You fill those, and only those. Train worlds only: never touch a val world. Do not rebuild or edit any world file: use the rows the world already has.

## What to write

Per world: **30 new sessions**, ids `<W>-101` to `<W>-130`, in two files `authored/sessions/<W>_g1.py` (101–115) and `<W>_g2.py` (116–130). Each starts with `from gold import *`; the first also calls `world("<W>", "<today>", "<me>", "train")` exactly as `<W>.py` does (copy its line). Read `<W>.py` and its part files first so you do not repeat their messages or situations.

Sessions are 1–4 turns, most 2–3. Several quota turns may sit in one session; a turn may count toward more than one quota. Do not pad: every turn must be a request a person would make in that household.

## Quotas per world (checked by `gapcheck.py`)

| Tag | Uses | What it is, and how to write it |
| --- | --- | --- |
| `ask:options` | 14 | A turn ending in `ask` **with options**: the request fits several rows or readings and nothing in the message or earlier turns decides ("move the dentist" with two dentists, "call sam" with two Sams, a delete whose target is one of several near-duplicates). Options name the candidates. Follow-up turn picks one and acts. Vary kinds (people, events, tasks, documents, locker items) and verbs. |
| contrast with `ask:options` | 10 of the 14 | Write a sibling turn elsewhere in the world with the same verb and shape that **acts** because the message or an earlier turn decides it ("move the dentist" when only one dentist is shown, or after the earlier turn named which). A model must learn when _not_ to ask. |
| `value:balance` | 11 | `answer op=balance` or `compute op=balance`: what someone owes, what I owe, a group total. |
| `convention:balance` | 9 | Balance turns whose amount is non-zero and has a fixed sign (positive: they owe me, negative: I owe them; SPEC §8.13). Use **both signs** across the nine (at least 3 negative). Amounts in the default currency. |
| `write:star` | 15 | `act verb=star` on documents, people and locker items ("star the passport scan", "favourite raj"), including a few `unstar` and a few already-so stars followed by `answer`. Keep them short. |
| `decline:out_of_scope` | 4 | Things outside the vault (weather, sending an email, booking, general knowledge, doing something on the web). Gold `decline` reason out_of_scope. |
| `context:never_mind` | 4 | After an ask or a proposed change, the person backs out: "never mind", "forget it", "scratch that", "cancel that", "don't bother". The reference is `decline` reason never_mind (SPEC §8) unless the request already changed something, in which case it is an `undo`. |
| `convention:weekend` | 2 | Message contains "this weekend", "next weekend", "the weekend" or "coming weekend" as a date (SPEC §14: coming Sat–Sun). Reads and writes. |
| `convention:wifi` | 2 | Message contains "wifi password", "wifi pw" or "wifi code" as a bare noun phrase: a read (`answer rows`), not a `reveal` (SPEC §8.13). Also write one turn per world where a verb-like phrase ("show me the wifi password") asks for the reveal instead. |
| `decline:fabricated_secret` | 2 | The person asks the assistant to make up or guess a secret (invent a password, guess a PIN, recall a card number the vault does not hold). Gold decline reason fabricated_secret. |
| `decline:sealed_egress` | 1 | The person asks to send, forward, post or paste a sealed secret outside the vault (email my card number to X). Reason sealed_egress. |
| `decline:unbounded_destruction` | 2 | "delete everything", "wipe all my tasks", "clear the vault", "delete all of them" with no bound (users say "delete" for the action; "trash" is only the place). Reason unbounded_destruction. |
| `write:reopen` | 1 | Reopen a completed task. |

Also, across the 30 sessions (soft targets, printed by `gapcheck.py`):

- **At least half of the new turns are `diff` outcomes** (writes that change something), at least 14% `value` answers, at most 22% `rows` answers. Do not write filler read turns.
- **Near-miss rows on half of the write turns**: choose target rows that share a name word (3+ letters) with another row in the world, so the write has to pick the right one ("push the dentist" where "dentist checkup" and "dentist cleaning" both exist and the earlier turn made it clear).
- Include, spread over the sessions: `reschedule` with a bare weekday ("monday", "friday night") and with "at N" times (SPEC §14 readings), `decline` reason not_found (a write on a name that only exists trashed or not at all after `search` finds nothing), turns of 12 or more words (long messages that mix a request with context), and turns that make two writes in one message.
- Difficulty is counted, not only coverage: `gapcheck.py` prints how many new turns fall in each date subtype (`date:*`), call depth (`depth:*`), fitting-row bucket (`fit:*`), typo, order/limit and act-then-read (`flow:*`) tag. A turn is _hard_ when two or more rows fit its message, it has 12+ words, it takes three or more calls, or it shares no whole word with the row it acts on; every tag needs at least 30% hard turns corpus-wide, so do not write only the easy form of a request.
- 8–16% of the 30 sessions carry one `bad(...)` repair, as in BRIEF.md.
- Messages: short, phone-typed, as in BRIEF.md. About a quarter at 4 words or fewer.

## Verify

Same loop as BRIEF.md, on your own world only:

    PY=/tmp/claude-0/-home-user-centraid/f31227f9-ca10-5f19-9c12-db2b239388c1/scratchpad/ft/bin/python
    cd experiments/toolchat/native
    HF_HUB_OFFLINE=1 $PY authored/build.py <W> --out /tmp/authored-<W>
    python3 authored/gapcheck.py /tmp/authored-<W>/<W>.gold.jsonl
    python3 authored/coverage.py /tmp/authored-<W>/<W>.gold.jsonl --assign 28 --world <index> --md /tmp/authored-<W>/coverage.md

All 130 sessions of the world (old and new) must verify. Do not touch sessions `<W>-001`–`<W>-100`. The overlap list in coverage.md must stay empty. Every quota above reads `ok` in `gapcheck.py` before you stop. A session the runtime cannot serve correctly is removed and reported, never forced.

## Report back

New sessions verified, any quota still low and why, tooling or runtime issues (session and message).
