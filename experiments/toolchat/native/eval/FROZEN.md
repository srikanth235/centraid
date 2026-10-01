# Frozen eval set

Two sets are scored: **test** (frozen, below) and **val** (whole authored worlds held out of training, `authored/split.json`). Test is scored only at milestones; every fix and decision is derived on val.

Frozen 2026-09-27 at the close of step 2 (Eval). Any change to test is a new version: re-run the ref check, record the new hash here, and say why.

## test

450 hand-written sessions (worlds A to D, 1,309 turns), one file, set `test` on every row. Session ids keep the names they were written under (`dev-A-001`, `test-B-001`, ...); the prefix is history, not a split.

Ref check: 450/450 sessions, 1309/1309 turns (`run.py --model ref`, `nativetools session`). The original 150 + 300 sets scored 150/150 and 300/300 at the first freeze (fix rounds through #23). Sonnet on the original 150 (smoke test): 137/150 sessions = 91.3%. Every miss is Sonnet's own; none is caused by gold or the runtime.

```
0b555641d97183647d9728274c5ab60facd345efdbf3ecbcc9b5b481392f373a  sets/test.jsonl
```

Version 2, 2026-09-29: the old `dev.jsonl` (150), `test.jsonl` (300) and their union `heldout_test.jsonl` (450) became one `test.jsonl`, the union (id set checked equal to the old union before the old files were deleted; rows unchanged except `set`, which is `test` throughout), because the name `dev` implied a set to tune on while it was part of the scored 450. The old hashes, for the record:

```
cebda57becadaa8d362a33831fb863add03aa96ab3db00bc440d5d6f9f5fbe84  old sets/dev.jsonl
b99ee9819c64e762ffddc246c6738ba2074a8449ad6a50757de57348c7a398c4  old sets/test.jsonl
67f02827d22177a854334ed6e884ae23e0048ec1d14224623fa4161be7d1d158  old sets/heldout_test.jsonl
```

## val

Not frozen: `sets/val.jsonl` is compiled by `build_sets.py` from the authored sessions of the val worlds and changes when they do. It is a training-side set: no training example may come from a val world (`authored/split.py` `drop_val`). Scored like test: `seed_worlds.py` seeds the val worlds, then `run.py --set sets/val.jsonl`. At compile: T03, T12, T23; 391 sessions, 1,308 turns; ref check 391/391; sha256 `835c12ecb5c95b12bca041180567af566f4ea6b1442a285a393a79df9ee5f263` (informational).
