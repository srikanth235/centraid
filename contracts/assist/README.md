# `contracts/assist/`

The conversation surface's contracts, all derived from or checked against the declarations in [`crates/domain`](../../crates/domain): the model's kinds (`chat.rs`) and the action catalogue (`catalogue.rs`), which are the one catalog ([#1135](https://github.com/srikanth235/centraid/issues/1135), [app-plane](../../.claude/skills/change/app-plane.md)).

| File | What it is | Written by |
| --- | --- | --- |
| `verbs.json` | The chat verb vocabulary: each verb's argument line, its past tense, an optional `kindOrder` (the order its kinds are named to the model), an optional `flag` (the flag word `star`/`archive` set) and `builtin` for the one verb the runtime owns (`undo`). **A verb is live when a direct action of a writable kind says it, or it is `builtin`; nothing is flagged live by hand.** Each action says at most one of these verbs. | By hand. |
| `catalog-census.csv` | One row per action: its name (`kind.verb`, or `kind.verb/qualifier`), the command it wraps, whether it takes one id or a set, the scopes it fills from, its inverse, its confirm class and how chat reaches it (`direct:<verb>[:<qualifier>]` or `handoff:<reason>`). A test (`crates/domain/tests/census.rs`) fails when it is not what `ACTIONS` says, and when an action is reached neither way. | `cargo run -p centraid-domain --bin export-census > contracts/assist/catalog-census.csv` |
| `export/` | What `nativetools export` writes: the model-facing facts, including the catalog. See its README. | `nativetools export` |
