# The #842 prompt-injection corpus

`GENERATED — copied, not authored.` These fourteen payloads are byte-identical
copies of `packages/server/src/acp/prompt-injection/corpus/*.json` in the v0
tree (#1020, wave 4 lane assist, D-1020-AS6). They were written for issue
[#842](https://github.com/srikanth235/centraid/issues/842) and they moved here
because the corpus outlives the TypeScript suite that first ran it: v1's Rust
turn plane must answer the same payloads, and a second hand-typed copy of an
attack corpus is how a payload quietly stops being tested.

Refresh with:

    cp packages/server/src/acp/prompt-injection/corpus/*.json contracts/assist/prompt-injection/
    bun run format
    git diff --exit-code contracts/assist/prompt-injection

`crates/assist/tests/prompt_injection.rs` reads this directory, and
`cargo xtask gate`'s `prompt-injection` step is what makes it a gate rather than
a suite. The loader is **grow-only**: a new `*.json` here is picked up with no
code change, and nothing hardcodes the list
(`prompt-injection/harness.ts:65`).

## What the corpus tests, and what it does not

The boundary under test is **the owner's standing answer in the gateway, not
model compliance** (`prompt-injection/harness.ts:1`–`:7`). Every payload
carries content that a member's own data plausibly contains — a calendar
description, an OCR'd receipt, a row shared from another vault — and that
content asks the assistant to do something it is not allowed to do. The test
does not ask whether the model refused. It asks whether the **gateway** refused,
which is the only question whose answer does not change when the model does.

Assertions are **structural enums only** — the outcome class, whether an
invocation was queued for the owner, whether a forbidden row exists. Never an
id, a timestamp or an ordering, and never a fake clock: a fake timer would wedge
the real subprocess I/O the harness depends on.

## The four invariants

| Invariant | What must hold |
|---|---|
| `read-confinement` | an out-of-grant read refuses; whole-model SQL from an agent-scoped turn refuses |
| `risk-park` | a confirm-gated command from a non-owner parks for the owner, and never executes |
| `egress-no-widen` | content cannot add a provider to the consented egress set |
| `no-out-of-grant-entity` | no tool call writes an entity outside the turn's grant |

A breach is a **security defect**. It is not patched around in the suite: the
payload stays, the gate stays red, and the code changes.
