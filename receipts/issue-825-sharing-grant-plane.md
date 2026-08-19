# issue-825 — sharing v1: the grant plane

GitHub issue: [#825](https://github.com/srikanth235/centraid/issues/825)

One umbrella, one receipt, nine waves (0–8). Wave 0 records the rulings in the durable docs before any code moves, per the issue's execution plan.

## Checklist

- [ ] `grant` + `fulfillment` tables exist with the live-grant uniqueness and lifecycle above; migration lands existing commons grants and bindings with zero semantic loss (proven by pre/post fixture tests).
- [ ] Sharing an album/folder covers later additions: an item added to a granted container reaches the audience without a new grant.
- [ ] An origin edit on a `view`-granted subject follows to the audience replica (test: caption/body edit visible after sync).
- [ ] Revoking a grant stops sync and drives fulfillment to `remove_sent`/`removed`; a compliant peer removes the replica (integration test), and the UI copy states the best-effort nature verbatim.
- [ ] A grant to an unlinked person parks at `awaiting_channel` and mints the channel invitation as its first step — no separate link ceremony required of the member.
- [ ] `edit`-capability writes route back via the command routing table; a subject type without a routing answer cannot be offered (mechanical test, #750).
- [ ] Docs and Photos share/unshare through the one shared kit on web **and** mobile; no app-private share plumbing remains.
- [ ] People's person screen lists every live grant for that party and offers `Share` and `Revoke`; the three #821 withholding rows in `docs/design-divergences.md` are closed or rewritten with this issue as the cause.
- [ ] `peer-edge-give-route` and the give/edge-answer verbs are gone from the public surface; `readShareClosure`/`projectShareClosure` remain internal-only fulfillment transport.
- [ ] Absent-never-empty holds everywhere grants are read (`null` vs `[]` distinguished on every surface).
- [ ] `docs/decisions.md` records the eight rulings + supersessions; glossary, `ARCHITECTURE.md`, protocol docs updated in the same waves that change the facts.
- [ ] One receipt (`receipts/issue--sharing-grant-plane.md`) with per-wave crosswalk and a fresh-context adversarial audit.

## What changed

### Wave 0 — rulings first (docs only)

- `docs/decisions.md` gains `## Sharing v1 — the grant plane (#825)`: the eight `G-` rulings (G-membership, G-view, G-edit, G-revoke, G-channel, G-copy, G-audience, G-subject) as an Id table, the `share_grant` / `share_fulfillment` shapes, the v1 defaults (hard-delete removal, `tally.group`-only edit co-contribution, per-grant size ceilings carried unchanged). Two rows added to `## Superseded decision pointers`: the #726 "Give is a receiver-owned snapshot" half, and the link-ceremony-as-prerequisite (#726 / #821 L-write), each pointing at #825. The #726 "Ownership, sharing, and peer transport" paragraph and the #821 **L-write** row are amended in place to the new current answer, per that file's stated convention.
- `docs/glossary.md`: the sharing section is retitled to `## Sharing: the grant plane, commons, links, and the peer plane (#726, #731, #825)` (no inbound anchors existed) and gains **grant**, **fulfillment**, **channel**, **subject** rows. The **give** row is retired into the section's closing retired-vocabulary paragraph beside **lend**. The Owners section's "Sharing is residency" bullet now states grants and the `edit` strategy. Forbidden-synonym rows added: "copy-as-share" / "give a copy" → **grant**; "link ceremony" as a member prerequisite → **channel**; the lend row stops pointing at give.

The `docs/decisions.md records the eight rulings + supersessions` checklist item stays unchecked: its decisions/glossary half is realized here, but the item also binds `ARCHITECTURE.md` and the protocol docs to the waves that change those facts, so it closes when the last of them lands. Two sentence-level pointer rewrites ride along: the #821 section's closing sentence now points at the grant plane, and the glossary sharing-section intro now leads with what a member shares rather than how bytes cross.

## Decisions

The judgment calls the diff cannot show.

**Rulings land ahead of code, deliberately.** Wave 0 records the #825 decisions as current answers while the grant tables do not exist yet; the issue's execution plan orders it so ("docs coherent before any code moves"), and the G-section says so in one line. Glossary Code cells name the table names the schema wave ships (`share_grant`, `share_fulfillment`), not file paths that do not exist yet.

**Edge/closure vocabulary stays put until the code dies.** The glossary's `edge`, `closure`, `projection` rows and the `placement_intents` synonym row still describe live code; they are wave-8 retirement-sweep work, not wave-0 work.

**Give row deleted, not annotated.** Following the file's own precedent for **lend**, the retired vocabulary moved to the closing paragraph rather than surviving as a struck-through table row.

## Out of scope

Named so the omissions are not read as oversights.

- **All code.** Waves 1–8 own schema, engine, routes, kits, app integrations, and retirement.
- **`ARCHITECTURE.md`, `SECURITY.md`, `docs/protocol.md`, `docs/blueprint-seats.md`, `docs/design-divergences.md`** — updated in the waves that change those facts, per the docs-describe-current-state rule.
- Contact-card sharing, a "give a copy" verb, `comment` capability, federation beyond linkable vaults, CRDT conflict resolution — out of the issue's scope entirely.

## User impact

Wave 0 changes no running surface; it is docs only. User-facing impact begins with the UI kit and app waves.

## Verification

```sh
bun run format:check   # all matched files use oxfmt code style (4407 files)
node scripts/ci/run-gates.mjs format:check lint   # both green on the wave-0 tree
```

Link integrity: every relative link added resolves (`decisions.md#sharing-v1--the-grant-plane-825` anchor matches the file's em-dash slug convention; `../packages/vault/src/share/{commons-routing,read-closure,project-closure}.ts` all exist).

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-19 | claude-code | 0fabaf8f-2be9-5a2b-bb49-7c33fe55c22a |

## Audit

Fresh-context sub-agent attestation (governance directive `receipt-per-issue` rule 7). The auditor is handed only the diff, this receipt, and issue #825, instructed to default to REFUTED when uncertain.

### Wave 0 — one pass after three findings, each fixed

- (1) `## What changed` faithfully describes the diff — PASS. Two benign pointer-sentence rewrites were initially unmentioned; both are now named in `## What changed`.
- (2) Every `- [x]` item is realized in the diff — PASS after fix. The auditor refuted the initially-checked docs item: the glossary's give paragraph asserted a completed retirement ("left the product surface") while the give/edge code still exists, and `ARCHITECTURE.md` / `docs/blueprint-seats.md` still state the old semantic. Fixes applied: the give paragraph is re-tensed to the ruling ("retires under #825 … leave the product surface in that issue's retirement wave"), and the checklist item is unchecked until the last doc wave lands. No `- [x]` items remain in the wave-0 change set.
- (3) The `## Checklist` mirrors the issue's checklist — PASS. All 12 items verbatim, in order, including the issue's own `receipts/issue--sharing-grant-plane.md` path in item 12 (faithful mirroring).

Verdict: PASS
