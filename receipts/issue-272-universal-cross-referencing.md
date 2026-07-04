# Issue #272 — vault: universal cross-referencing (core.link, card resolver, shell picker)

## Checklist

The issue is written as a phased plan rather than a checkbox list; this checklist mirrors its four phases plus the acceptance test.

- [x] Phase 1 command pair + vocabulary
- [x] Phase 2 `core.attach` `content_id` alternative
- [x] Phase 3 card resolver
- [x] Phase 4 shell picker + first consuming app
- [x] Acceptance test
- [ ] Adoption sweep across the other 13 apps (follow-up, the #264 pattern — deliberately not in this change)

## What changed

**Phase 1 — the command pair + vocabulary (vault engine).**

- `packages/vault/src/commands/links.ts` (new): `core.link_entities` / `core.unlink_entities`, vault-layer tests in `packages/vault/src/commands/links.test.ts` (new). Preconditions: the relation must be a notation in the seeded relations scheme (never caller-invented), and an identical live link is refused. The handler enforces the both-endpoints-readable consent rule — a caller may only assert a relationship between rows its grant lets it READ (`evaluateConsent` per endpoint, under the invocation's own purpose). Unlink is temporal: `valid_to = now`, the row survives (ontology rule R3). `asserted_by` derives from caller identity (owner/app/agent).
- `packages/vault/src/gateway/types.ts`: `HandlerCtx` gains `purpose` so handlers can make further consent checks; `packages/vault/src/gateway/execution.ts` passes it through and adds `sweepDanglingLinks` — after any command commits a hard delete, every live link touching the deleted row is end-dated centrally (one place, not per delete command), with provenance stamped for each swept link.
- `packages/vault/src/gateway/duties.ts`: the lifecycle purge (the one hard delete outside the command pipeline) also end-dates links touching purged content items and media assets.
- `packages/vault/src/bootstrap.ts`: seeds `references` and `attachment-of` into the relations scheme; `packages/vault/src/schema/migrate.ts` adds a v3 migration backfilling the same two notations into pre-existing vaults (no vault recreation needed).

**Phase 2 — attach an existing content item (GC audit included).**

- `packages/vault/src/commands/attachments.ts`: `core.attach` accepts exactly one of `data_uri` (mint/dedupe new bytes, as before) or `content_id` (pin an EXISTING live content item — no re-upload). New preconditions: `exactly_one_source`, `content_exists`; the data-uri checks became conditional. Tests in `packages/vault/src/commands/attachments.test.ts`. GC audit result: `CONTENT_REFERENCES` in media.ts already counts `core_attachment.content_id`, so an embedded photo survives the photo being trashed — no change needed there.

**Phase 3 — the card resolver.**

- `packages/vault/src/gateway/cards.ts` (new): engine-side card registry (14 curated entity types; uncurated ones resolve to existence + status) and `resolveRefCards` — (type, id) refs → `{status: live|trashed|missing|denied|unknown, title, subtitle, thumbnail_content_id}` cards, receipts per batch. Consent is **resolvable-if-linked**: a ref resolves when the caller reads the entity outright OR a live `core.link` ties it to something the caller reads. Deletion leaves a `missing` tombstone card — dangling-reference handling lives in the resolver, not in apps. Tests in `packages/vault/src/gateway/cards.test.ts` (new), including link → resolve → unlink → denied.
- `packages/vault/src/gateway/gateway.ts`: `Gateway.resolveRefs` (identity → resolver); `packages/vault/src/index.ts` exports the link commands, card types, `CARDED_ENTITIES`, `CARD_PK`.
- `packages/app-engine/src/handlers/vault-bridge.ts` + `packages/app-engine/src/worker/runner.ts`: `resolve` joins the `VaultOp` union and `ctx.vault.resolve(...)` reaches handlers; `packages/automation/src/worker/runner.ts` mirrors it on the agent plane.

**Phase 4 — shell picker + owner link routes + notes as first consumer.**

- `packages/gateway/src/serve/vault-picker.ts` (new): the shell picker's read+write helpers as free functions — `pickEntities` (owner-trust search over FTS-indexed kinds / recent-first browse over carded kinds, results carded through the resolver) and `linkAsOwner` / `unlinkAsOwner` (the pick is the consent — the shell asserts the link with the owner-device credential, `asserted_by='owner'`). Split out of vault-plane.ts to keep that surface under the file-size cap.
- `packages/gateway/src/serve/vault-plane.ts`: registers the link commands on every plane; thin `pickEntities` / `linkAsOwner` / `unlinkAsOwner` methods delegating to vault-picker.ts; both bridges answer the `resolve` op.
- `packages/gateway/src/routes/vault-routes.ts`: `GET /centraid/_vault/picker`, `POST /centraid/_vault/links`, `DELETE /centraid/_vault/links/<linkId>`.
- `packages/blueprints/kit/kit.js` + `packages/blueprints/kit/kit.css`: `openEntityPicker` (shell-owned modal: debounced search, kind chips, snippet sublines, "picking shares only the picked item" note), `createReference` / `removeReference`, `entityKindLabel`; `.kit-pick-*` styles in the kit's design language.
- Notes app (`packages/blueprints/apps/notes/app.json`, `packages/blueprints/apps/notes/app.js`, `packages/blueprints/apps/notes/app.css`, `packages/blueprints/apps/notes/index.html`, `packages/blueprints/apps/notes/queries/library.js`): one added read scope (`core.link` — deliberately NO media/finance/etc. scopes), the library query joins live outbound links `in`-bounded by the note window and resolves their cards via `ctx.vault.resolve`, and the note view renders a reference-chip strip with add ("＋ Link from vault" → picker) and remove, including trashed/tombstone treatments. Version bumped to 0.6.0.
- `packages/gateway/src/serve/vault-plane.test.ts`: two end-to-end tests — shell pick → owner link → app resolves the far end without a scope → unlink goes dark; and the HTTP routes (picker search across kinds, POST links asserts as owner, malformed body 400, DELETE end-dates).

## Out of scope

- Adoption sweep across the other 13 blueprint apps (issue names notes as the first consumer; the rest follow the #264 pattern in a follow-up).
- Backlinks panes ("referenced by") — the reverse read is free and tested at the vault layer, but no app renders it yet.
- Inline `vault:` URI mentions inside markdown bodies (issue non-goal).
- Cross-vault references and link attributes (issue non-goals). This includes the issue's "optional `note`" input on `core.link_entities` — dropped, see Decisions.
- Retention-policy hard deletes (`enforceRetention`) do not yet end-date links — bulk `DELETE` without per-row ids; no retention policies are seeded by default. Noted as a seam.
- Row-level re-evaluation of the far endpoint in resolvable-if-linked (v0 is entity-level; every resolution is receipted).
- The `manifest.json` regeneration was reverted — this change adds no template files and the manifest embeds neither versions nor scopes (a concurrent Docs session's uncommitted knob was the only diff).

## Decisions

- **Central dangling-link sweep instead of per-delete-command sweeps.** The issue sketched "delete commands gain a sweep"; implementing it in `runContractAndExecute` (after polymorphic validation) covers every hard delete in one place and no delete command needs to know links exist. The lifecycle purge in duties.ts is the one out-of-pipeline hard delete and got its own end-dating.
- **The shell (owner credential) asserts picked links, not the app.** The issue's both-endpoints-readable rule would otherwise force apps to hold read scopes on foreign domains — exactly the grant inflation the picker exists to avoid. The app-side `core.link_entities` command still enforces the rule for apps/agents that do read both sides.
- **`HandlerCtx` gains `purpose`** — smallest ctx extension that lets the link handler run real consent checks (per the handler-is-source-of-truth principle) instead of inventing a parallel checking path.
- **Relations scheme URI in condition SQL via `char(58)`** — the issue-258 colon-literal trap: `:duaility`/`:relations` inside a SQL string literal would bind as named parameters.
- **v3 migration backfills the two new relation notations** so existing dev vaults keep working without recreation; ids are `randomblob` hex (migrations are static SQL; ids are meaningless per the ontology).
- **Picker term-search covers FTS-indexed kinds only**; un-indexed kinds (e.g. photos) appear in the no-term browse. Honest limit of the text index, logged per skipped kind.
- **The issue's optional `note` input on `core.link_entities` was dropped.** `core_link` carries no note column in the ontology DDL, and adding one is a link-attribute decision the issue itself defers ("add when a real projection needs them"). Flagged here rather than silently narrowed.

## Verification

All quoted counts were observed on this change set.

```sh
cd packages/vault && npx vitest run          # 195 passed — includes links.test.ts (9), cards.test.ts (4), attachments.test.ts (10)
cd packages/gateway && npx vitest run src/serve/vault-plane.test.ts   # 11 passed — incl. the two #272 end-to-end tests
npm run test        # turbo: 21/21 tasks green (repo-wide)
npm run typecheck   # 21/21 green
npm run lint && npm run format               # 0 errors
```

Key behaviors a reviewer can replay from the tests:

- Phase 1 command pair + vocabulary: `links.test.ts` — typed relation asserted between two canonical rows; unknown relation refused by precondition; duplicate live link refused, relinkable after unlink; app with read on only one endpoint refused with `grant does not cover read of …`, allowed after the second grant (both-endpoints-readable consent precondition); `knowledge.delete_note` end-dates the note's links with provenance stamped (delete-sweep); backlinks readable in reverse; v3 migration backfills notations (relations scheme seeding covered by vault-layer tests).
- Phase 2 `core.attach` `content_id` alternative: `attachments.test.ts` — existing item attached with zero new content rows and role derived from its media type; neither/both sources refused; unknown and trashed content refused (GC audit: attachment edges already count as references).
- Phase 3 card resolver / `resolve_refs` gateway read: `cards.test.ts` — owner resolves live/trashed/missing/unknown cards (tombstone reporting); an app without a media scope resolves a photo card only while a live link ties it to a readable note, receipts written per batch (engine-side card registry).
- Phase 4 shell picker + first consuming app: `vault-plane.test.ts` — pick (term + browse) → owner link (pick-is-consent) → app-bridge resolve → unlink goes dark, and the three HTTP routes end to end (link chip rendering in notes rides these surfaces).
- Acceptance test, both halves: revoke the app's grant → resolve degrades to denied cards and reads deny with `VAULT_CONSENT`, while the note, the photo and the live link survive in the vault (`vault-plane.test.ts`); delete a linked endpoint → tombstone card + end-dated link with provenance (`cards.test.ts`, `links.test.ts`).

Not machine-verified: the notes UI DOM wiring and the kit picker modal (no blueprint UI harness exists; they ride the exact routes and ops the plane tests cover). Manual check: publish notes, open a note, "＋ Link from vault", pick a photo, see the chip; trash the photo in Photos and see "(in trash)".

## Audit

Verdict: **PASS** — fresh-context sub-agent, adversarial review of the full diff vs. this receipt vs. `gh issue view 272` (2026-07-04). It re-ran the load-bearing verification claims and reproduced them exactly (vault 195, links 9, cards 4, attachments 10, plane 11, typecheck 21/21) and confirmed every What-changed claim exists in the diff. Its findings and their dispositions:

1. The receipt pre-recorded this verdict before the audit ran — corrected: this section now records the actual result.
2. The checklist's fifth item conflated the issue's acceptance test with the adoption sweep, and the revoke-grant half of the acceptance test was untested — fixed: they are separate items, and the revoke half is now machine-verified in `vault-plane.test.ts` (grant revoked → denied cards + `VAULT_CONSENT` reads, entities and link survive).
3. Claimed `same-as` is seeded nowhere — refuted: `same-as` has been in the bootstrap seed since before this change (`packages/vault/src/bootstrap.ts` relations scheme); this change adds `references` and `attachment-of` on top, completing the issue's vocabulary list.
4. The issue's optional `note` input on `core.link_entities` was silently dropped — fixed: now an explicit Decisions entry and Out-of-scope line.
5. A links test named a link-to-link refusal it never exercised — fixed: the test now asserts `links do not link links`.

## Steering

**Verdict: PASS**

One human-steering event in this session: at message 2 (ordinal 2, 2026-07-04T10:44:36.605Z), the user redirected the agent mid-discussion to focus on the generic cross-referencing capability rather than getting bogged down in the specific notes/photo example. This correction is recorded in the Steering table below.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-12ffc63d-824-1783165064-1 | claude-code | 12ffc63d-8243-4899-9075-f80012669762 | #272 | claude-fable-5 | 86782 | 2091311 | 81870664 | 378804 | 2556897 | 127.8201 | 86782 | 2091311 | 81870664 | 378804 | feat(vault): activate core.link — typed link commands, card resolver, attach by  |
| claude-code-12ffc63d-824-1783168437-1 | claude-code | 12ffc63d-8243-4899-9075-f80012669762 | #272 | claude-opus-4-8 | 12098 | 636799 | 7369277 | 12160 | 661057 | 8.0291 | 98880 | 2728110 | 89239941 | 390964 | feat(vault): activate core.link — typed link commands, card resolver, attach by  |
| claude-code-12ffc63d-824-1783168744-1 | claude-code | 12ffc63d-8243-4899-9075-f80012669762 | #272 | claude-opus-4-8 | 3127 | 40987 | 13864249 | 29647 | 73761 | 7.9451 | 102007 | 2769097 | 103104190 | 420611 | feat(vault): universal cross-referencing — core.link, card resolver, shell picke |
| claude-code-12ffc63d-824-1783168774-1 | claude-code | 12ffc63d-8243-4899-9075-f80012669762 | #272 | claude-opus-4-8 | 6660 | 2296 | 700832 | 1826 | 10782 | 0.4437 | 108667 | 2771393 | 103805022 | 422437 | feat(vault): universal cross-referencing — core.link, card resolver, shell picke |
| claude-code-12ffc63d-824-1783168854-1 | claude-code | 12ffc63d-8243-4899-9075-f80012669762 | #272 | claude-opus-4-8 | 851 | 23819 | 3574266 | 9416 | 34086 | 2.1757 | 109518 | 2795212 | 107379288 | 431853 | feat(vault): universal cross-referencing — core.link, card resolver, shell picke |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-12ffc63d8243-1783165193-1 | 12ffc63d-8243-4899-9075-f80012669762 | #272 | correction | classifier | refocus on generic cross-referencing capability, not the specific notes/photo example | feat(vault): activate core.link — typed link commands, card resolver, attach by… | 2 | 2026-07-04T10:44:36.605Z |
