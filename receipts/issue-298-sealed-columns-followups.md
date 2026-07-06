# issue-298 — sealed columns follow-ups: key custody, reveal afterlife, error scrub, ext-band sealing

GitHub issue: [#298](https://github.com/srikanth235/centraid/issues/298)

The post-ship audit of #293 (landed in #297) surfaced nine gaps. This branch
closes all nine. The spine of the work is **key custody as a lifecycle, not a
file**: the DEK was load-or-created by directory basename, so renaming,
cloning, or moving a vault directory silently minted a fresh key and turned
every sealed cell into GCM-authentication garbage — discovered only at reveal
time. Now the key's fingerprint is stamped into `core_vault` at first seal, a
missing or regenerated key is a **loud, distinguishable failure at open**, and
there is a receipted export/restore/rotate story. The remaining items extend
the same sealed-class discipline to the ext band, the durable transcript, the
error surface, the clipboard, and connector bindings.

## Checklist (the nine audit items)

- [x] **1 — Key lifecycle** silently coupled to the directory basename → fingerprint stamp + loud open-time `SealKeyError`, load/create split, crash-safe rotation sidecar.
- [x] **2 — Backup asymmetry** → the decided recovery story: receipted `key export`/`restore` admin gestures; a directory copy carries ciphertext only, honestly.
- [x] **3 — Source CSV outlives its rows** → shred the sealed payload from `sync_import_row` after publish (raw dropped bytes are memory-only).
- [x] **4 — Credential rotation bricks connectors** → stable `locker:@<alias>:<column>` bindings resolved at fire time; delete+recreate re-heals.
- [x] **5 — Reveal afterlife** → timed clipboard clear for secret copies in Locker; reveal-route logging audit (clean).
- [x] **6 — Derivative outputs in the transcript** → `transcriptSensitive` flag redacts the vault journal receipt; LLM-transcript residual documented (accept-and-document).
- [x] **7 — Error paths have no scrub** → declared sealed inputs pass the hash-token scrub before any error text reaches journal/receipt/HTTP.
- [x] **8 — No rotation/reseal machinery** → owner-only receipted `reseal`; structural sealed-value predicate closes the prefix-collision edge.
- [x] **9 — Ext band can't seal** → `ext.tables` carry `sealed: [columns]`, enforced by the same six chokepoints.

## What changed

**Commit 1 — vault key-custody core (items 1, 7, 8):**
- `packages/vault/src/schema/sealed.ts` — split `loadOrCreateSealKey` into
  `loadSealKey` (null on ENOENT, throws on corruption) + `createSealKey`
  (deliberate mint). `resolveSealKey` verifies the loaded key against a
  `sealKeyFingerprint` stamped in `core_vault.settings_json`: stamp present +
  key missing → `SealKeyError('missing')`; stamp + wrong key →
  `SealKeyError('mismatch')`; no stamp → mint freely (nothing sealed yet).
  Before failing a mismatch, a `<file>.next` rotation sidecar is promoted if
  it matches (crash-safe rotation). `isSealedValue` now requires the base64
  shape, so a password literally starting with `sealed:v1:` no longer
  satisfies the predicate. `scrubSealedText` (item 7) replaces declared secret
  values with hash tokens in free text.
- `packages/vault/src/db.ts` — key resolution moves AFTER `migrate` so the
  stamped fingerprint is readable; on-disk vaults call `resolveSealKey`.
- `packages/vault/src/gateway/reseal.ts` (new) — `resealVaultKey`:
  decrypt-with-old/encrypt-with-new across live sealed columns AND staged
  draft payloads in one transaction, receipted `key.rotate`, sidecar-then-
  commit-then-rename; refuses while `blob_store.encrypt` binds remote
  envelopes to the key.
- `packages/vault/src/gateway/execution.ts` — `sealWrites`, the error scrub,
  and journal redaction stamp the fingerprint the moment a vault first seals;
  handler-error and schema-error text pass through the scrub.
- `packages/vault/src/gateway/gateway.ts` + `ingest/staging.ts` — every seal
  chokepoint (command sweep, staging seal, spine-publish sweep, reveal) stamps
  the fingerprint in-transaction.

**Commit 2 — receipted key custody CLI (item 2):**
- `packages/gateway/src/cli/key-admin.ts` (new) — `centraid-gateway key
  status|export|restore|rotate --vault <name-or-id>`. Registry-free by design
  (restore operates on exactly the vault the registry refuses to open):
  raw-sqlite reads for identity + fingerprint. Export writes a fingerprinted
  0600 envelope and receipts `key.export`; restore verifies against the stamp
  and refuses to overwrite different key material, receipts `key.restore`.
- `packages/gateway/src/cli/cli.ts` — `key` subcommand + usage.
- `packages/gateway/src/serve/vault-registry.ts` — documents the deliberate
  key-file retention on delete and the move-the-key invariant for any future
  dir-moving gesture.

**Commit 3 — ext-band sealed columns (item 9):**
- `packages/vault/src/schema/ext.ts` — `ExtTableSpec.sealed`, validated
  (text-only, not PK/FK, sealed ∩ searchable / sealed ∩ indexed are hard
  errors), folded into `canonicalSpecJson` so a sealed change is diffable.
- `packages/vault/src/schema/sealed.ts` — `sealedColumnsOf(entity, vault?)`
  resolves ext sealed columns from `consent_app_ext`; `redactCommandInput` +
  `sealedValuesForCommand` dive into the ext trio's nested `values`/`set`
  payload for journal + scrub coverage.
- `packages/vault/src/gateway/ext.ts` — `alterExtTable` retro-seals rows
  already present when a column is newly declared sealed.
- `packages/vault/src/gateway/{gateway,execution,reseal}.ts` — every consumer
  passes the vault handle; reseal walks live ext sealed tables too.

**Commit 4 — shred sealed import payloads (item 3):**
- `packages/vault/src/ingest/staging.ts` — `shredPublishedSecretPayloads`
  drops the sealed payload FIELDS from a published batch's rows (keeps the row
  + plain fields for provenance), in the publish transaction.

**Commit 5 — Locker clipboard mitigation (item 5):**
- `packages/blueprints/apps/locker/app.js` — the single `copy()` chokepoint
  arms a 30s clipboard clear for secret copies (password, OTP, generated),
  guarded by a read-back so it never clobbers a later copy. Non-secret copies
  (links, usernames) untouched.

**Commit 6 — transcript-sensitive outputs (item 6):**
- `packages/vault/src/gateway/types.ts` + `execution.ts` + `commands/locker.ts`
  — `transcriptSensitive` flag; `locker.totp_code` marked. The journal receipt
  redacts the output while the live caller still receives the real value.

**Commit 7 — connector secret aliases (item 4):**
- `packages/vault/src/schema/domains-locker.ts` — v11 sidecar
  `locker_item_alias` (re-runnable migration — no `ADD COLUMN`, no
  `locker_item` rebuild across the tag CASCADE; uniqueness among live items
  enforced in the handler).
- `packages/vault/src/commands/locker.ts` — add/edit accept `alias` →
  `setAlias`.
- `packages/vault/src/gateway/gateway.ts` — `reveal({ entity, alias })`
  resolves the live item under the same reveal grant.
- `packages/automation/src/fire/fire.ts` + `manifest/manifest.ts` — connectors
  bind `locker:@<alias>:<column>`; fire-time resolution + validation accept
  both forms.
- `packages/blueprints/apps/locker/app.js` — the edit form exposes the alias
  (write-safe: a blank field never clobbers an existing binding).

## Out-of-scope

- **The app-engine LLM transcript (item 6)** is accept-and-document, not
  redacted. The model's live tool-result and the durable transcript entry are
  byte-identical across the SDK boundary, and app-engine has no `@centraid/vault`
  dependency, so `transcriptSensitive` metadata cannot cross to the durable
  writer without embedding a sentinel in model-visible content. The 30s TOTP
  code is low-stakes (the issue's own read); the durable store the vault OWNS
  (journal.db) is closed here. A future decoupled fix would inject the sensitive-
  command set into the app-engine conversation layer at composition.
- **`org.nspasteboard.ConcealedType` (item 5)** cannot be set from the sandboxed
  Locker iframe (`navigator.clipboard` speaks only text/html/png). It needs a
  desktop pasteboard bridge in the Electron preload — noted as a follow-up; the
  portable timed-clear is what ships.
- **Item 3's raw-CSV / browser-Downloads copy** is not ours to shred (the issue
  says so); the dropped bytes are memory-only and GC'd. Only the durable
  residue we own (the sealed `sync_import_row` payload) is shredded.
- **Clearing/reassigning an alias from the Locker UI** — the field is write-safe
  (set/change only); clearing is an assistant/CLI gesture. Reassigning to a new
  live item auto-steals the alias.
- **An `oxfmt` sweep wanted to re-wrap five #296-era files this branch never
  edited** (blob.test, flow.test, promote, s3, stage-file) — reverted, not
  folded in (out-of-scope-work rule; same drift #299 already flagged).

## Verification

- `packages/vault`: **357 tests green** (`npx vitest run`) — includes two new
  suites: `src/gateway/seal-custody.test.ts` (20 tests: fingerprint stamping,
  loud missing/mismatch open-time errors, directory-move with/without key,
  reseal rotation + receipt + blob-encrypt refusal + interrupted-rotation heal,
  structural predicate, transcript-sensitive redaction, alias reveal +
  delete/recreate heal) and `src/gateway/ext-sealed.test.ts` (10 tests: the six
  chokepoints for a declared ext secret, retro-seal, reseal, draft-band, and
  sealed∩searchable refusal). The #293 sealed suite gains a shred-after-publish
  assertion.
- `packages/gateway`: 169 green + 1 skipped — includes new
  `src/cli/key-admin.test.ts` (6 tests: status/export/restore/rotate, refuse-
  overwrite, name-or-id resolution). `packages/automation`: connector fire suite
  gains an aliased-ref resolution test.
- Full monorepo battery **21/21 turbo tasks green** (`bun run test`); repo-wide
  `typecheck` green; `oxfmt` clean on this branch's files; `oxlint` — no new
  errors introduced (the 8 pre-existing #296 errors remain, untouched).
