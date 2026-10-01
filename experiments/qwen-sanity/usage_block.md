# RULES OF USE — draft block

Derived from `crates/evalsuite/grammar/GRAMMAR.md`, the document that already specifies every one of these. The existing prompt is built from `frame.py`'s enums, which are the grammar's TERMINALS; this is the grammar's SEMANTICS, which has never been sent to any model. Each rule cites its source so it is auditable as spec-derived rather than tuned against observed failures.

Two rules at the bottom are marked UNSOURCED. They are inferred from gold canonicals, not from the spec, and should not ship until either the spec is found to state them or the spec is amended to state them.

---

    TODAY IS MONDAY 2026-06-15.
    Every relative date resolves against that: "friday", "tomorrow", "today",
    "the 21st", "last week". It is not the date of any other calendar.

    WHICH DOOR  [GRAMMAR.md:143-144, 172, 174]
    The same table reached through two doors is two different Kinds, and their
    rows do not correspond. Choose by the app the sentence is about.
      parties       people, through People      members    people, through Tally
      events        the diary                   activities logged interactions
      documents     filed paperwork             locker items  stored secrets
      notes         the Notes library           journal notes People's journal
    Naming a person with no money context is `parties`. Locker is not a search
    domain: `locker items` never reaches the text-search plane.

    NAMING A ROW  [GRAMMAR.md:198, 283, C6]
    Match a row by its label with `called "X"`. Do not write an explicit
    `title contains` or `description contains` filter to do the same job:
    `called` is a ranked retrieval against the search plane and is the only
    form that resolves a collision between two rows of the same name.
    Use the words the person used.

    WHAT THE WORDS ALREADY CARRY  [GRAMMAR.md C1, :223]
    "due", "overdue", "still to do" carry `status != "completed"` beside their
    window. A completed task is not due; it is done.
    "outstanding", "owes", "owed", "unsettled" carry `settled_at is null`.
    `before now` is the overdue comparison.
    A named period is a calendar period; a vague one is a rolling window.

    WHAT A REF MEANS  [GRAMMAR.md:261, 265, 267, C4, C13, C14]
    `it` / `them` are the rows the last LIST answered.
    A value question does not replace them: after "who do I owe?" / "how
    much?" / "pay it off", `it` is still the party from the first turn.
    `the last thing I added` is the row the last command created.
    `the earlier one` is the answer TWO turns back.
    An ordinal indexes the answer in the order it was delivered.
    When the PERSON named the antecedent a turn or two back, write the name,
    not a ref: after "and Ray?", "log that I called him" is
    `on (parties called "Ray Alvarez")`.

    WHEN TO REFUSE  [GRAMMAR.md R-R3, R-R4]
    `fabricated_secret` — only when a WRITE requires a secret value the person
    did not supply. Reading a secret the locker already holds is the locker's
    purpose and is not a refusal.
    `unbounded_destruction` — a destructive verb over a set with no `called`,
    no `that` and no window.
    `out_of_ontology` — only for what the vault does not hold at all.

---

## UNSOURCED — do not ship without grounding

    "when did I last …" asks for the ROW, not the maximum:
    `show (first 1 of (… ordered by <time field> desc))`, not
    `max <time field> of (…)`.

    `them` where the previous answer was several rows, `it` where it was one.

`GRAMMAR.md:261` lists `it` and `them` together without distinguishing them, and states no idiom for "last". Both rules above are read off gold canonicals (s117 t0, s95 t1 for the first; s65 t1 vs s117 t2 for the second), which makes them sample-derived. Either find the rule in the spec, or amend the spec.

## What this block cannot fix

Three of the observed failures are not promptable at any length, because the answer is a value only the vault holds:

    "the trip group"        -> groups called "Tahoe Trip"
    "the library books task"-> tasks called "Return the library books"
    "the other Neha"        -> parties called "Neha Rao"
    "the one in the workshop" -> parties called "Marco"

The person's words and the stored label differ. No model can bridge that without reading the vault, and the project's own design says it should not try: the model emits the words, code resolves the handle.
