# issue-293 — sealed columns: secrets as a first-class data class across the consent pipeline

GitHub issue: [#293](https://github.com/srikanth235/centraid/issues/293)

First principle: **sealing is a pipeline property, not a storage feature.** A
sealed column is ciphertext at rest, a placeholder in every default read
(including the owner's SQL surface), revealable only under the new `reveal`
scope verb with a per-item receipt, hash-not-value in the append-only
journal, structurally excluded from FTS, and sealed at stage time in the
import draft band. One declaration in the schema registry, enforced at every
chokepoint the gateway owns.

## Checklist

- [x] Commit 1 — vault sealed class
- [x] Commit 2 — reveal across the bridges
- [x] Commit 3 — Locker over the sealed class
- [x] Commit 4 — connector secrets
- [x] Commit 5 — format sweep

## What changed

Commit 1 — vault sealed class:

- `packages/vault/src/schema/sealed.ts` (new) — the registry
  (`SEALED_COLUMNS`: locker.item password/otp_seed/card_number/cvv/content;
  `SEALED_PAYLOAD_FIELDS` for the staging band), AES-256-GCM seal/unseal
  with per-cell AAD (`table.column:rowid` — a ciphertext cannot be swapped
  between cells), the `sealed:v1:` wire prefix + `«sealed»` placeholder,
  key custody (`sealKeyFileFor`: the `keys/` sibling of the vault dir,
  load-or-create 0600; ephemeral for in-memory vaults), and the journal
  redaction helpers (`sealedHashToken` keyed by the DEK,
  `redactSealedInput`).
- `packages/vault/src/db.ts` — `VaultDb.sealKey`: on-disk vaults
  load-or-create the DEK in the `keys/` sibling (outside anything
  export/backup/copy moves); `OpenVaultOptions.sealKey` override.
- `packages/vault/src/schema/consent.ts` — the grant-scope verbs CHECK
  gains `'reveal'`; `GRANT_SCOPE_REVEAL_DDL` (v8) rebuilds the table in
  place for existing vaults (SQLite cannot ALTER a CHECK).
- `packages/vault/src/schema/migrate.ts` — v8 migration rung.
- `packages/vault/src/schema/fts.ts` — `assertNoSealedFtsColumns`: a
  sealed column can never feed a text index; the throw happens at
  DDL-build time. `FtsEntitySpec` exported for the gate's test.
- `packages/vault/src/gateway/consent.ts` — `evaluateConsent` grows the
  `reveal` verb: explicit `'reveal'` scopes only (reveal never rides read
  or read+act, and a reveal scope covers nothing else); readonly devices
  are denied (reveal is read-shaped but act-graded).
- `packages/vault/src/bootstrap.ts` — `ScopeSpec.verbs` gains `'reveal'`.
- `packages/vault/src/gateway/types.ts` — `HandlerCtx.unseal`,
  `CommandDefinition.sealedInput`/`unseals`, `RevealRequest`/`RevealResult`.
- `packages/vault/src/gateway/execution.ts` — `RegisteredCommand` (handler
  + sealed declarations, process-memory only); the SEAL SWEEP (`sealWrites`
  inside the command transaction: plaintext in a sealed column becomes
  ciphertext before COMMIT, however careless the handler); `ctx.unseal`
  gated by declared `unseals` with the cells receipted (names, never
  values); `insertInvocation` journals declared secret inputs as keyed
  hash tokens.
- `packages/vault/src/gateway/gateway.ts` — `reveal()` (consent-checked
  under the reveal verb, row-filter clamped — how a grant names specific
  items — receipted per item with column names only); default reads swap
  sealed cells for the placeholder; parked summaries redact sealed inputs;
  the handlers map becomes the `commands` registry.
- `packages/vault/src/gateway/sql.ts` — sealed wire values in any result
  cell (aliased, CONCAT'd, anything) show as the placeholder; nothing CAN
  leak — cells are ciphertext — this keeps assistant transcripts readable.
- `packages/vault/src/gateway/assistant-context.ts` — the SQL assistant's
  conventions name the sealed columns and point derivative questions at
  `locker.watchtower` / `locker.totp_code`.
- `packages/vault/src/commands/locker.ts` — `sealedInput` on
  add_item/edit_item; a round-tripped `«sealed»` placeholder on edit is
  "unchanged", never a value; `locker.totp_code` (RFC 6238 vault-side,
  unseals the seed internally, only the 6 digits emerge) and
  `locker.watchtower` (weak/reused/card-last4 derived inside the sealed
  boundary) — the `unseals:` exemplars.
- `packages/vault/src/commands/sync.ts` — `sync.stage_rows` refuses sealed
  entity types (secret material stages only through the owner surface);
  `sync.set_connection_status` gains `needs-auth` (the fire path's flip
  when a declared secret item is missing).
- `packages/vault/src/ingest/staging.ts` — the draft band seals:
  `stageBatchTx` seals declared payload fields at stage time (plaintext
  hash first — dedup is about content, sealing is nonce-randomized);
  `applyBatchTx` unseals just-in-time for the publisher and re-seals the
  written row's columns with the live row's AAD; key-less staging/publish
  of sealed rows refuses, never plaintexts.
- `packages/vault/src/ingest/passwords-csv.ts` (new) — password-manager
  CSV parsing (Chrome/1Password/Bitwarden header aliases, otpauth:// seed
  extraction); `isPasswordsCsvHeader` for content-based routing.
- `packages/vault/src/ingest/stage-file.ts` — CSVs route by CONTENT: a
  password column means a password-manager export → locker candidates;
  otherwise bank transactions as before.
- `packages/vault/src/ingest/publishers.ts` — the `locker.item` publisher
  (probe by title+username; create login rows; update fills gaps only —
  vault wins); it never sees the key (the spine seals around it).
- `packages/vault/src/index.ts` — sealed-module + reveal-type exports.
- `packages/vault/src/gateway/sealed.test.ts` (new) — 15 tests: crypto
  roundtrip + AAD swap refusal, ciphertext at rest + placeholder reads +
  SQL masking, journal never holds plaintext (hash token verified), reveal
  receipts / scope semantics / row-filter clamp / readonly denial, parked
  redaction, FTS gate, TOTP (RFC 6238 vector) + receipted unseal,
  watchtower derivatives, placeholder-edit guard, undeclared-unseal
  refusal, password-CSV staged-sealed → published-sealed → revealed, bank
  CSV still routes to transactions.
- `packages/vault/src/commands/locker.test.ts` — at-rest assertions now
  unseal-verify (rows hold ciphertext by design).
- `packages/vault/src/commands/sync.test.ts` — the sealed-type staging
  refusal; the no-publisher case moved to a genuinely unpublishable type.
- `receipts/issue-293-sealed-columns.md` (new) — this receipt.

Commit 2 — reveal across the bridges:

- `packages/app-engine/src/handlers/vault-bridge.ts` — `VaultOp` gains
  `'reveal'`.
- `packages/app-engine/src/worker/runner.ts` — `ctx.vault.reveal` on the
  app-handler surface.
- `packages/app-engine/src/registry/manifest.ts` — app-manifest scope
  verbs accept `'reveal'`.
- `packages/gateway/src/serve/vault-plane.ts` — both bridge planes (app +
  agent) dispatch `reveal` to `gateway.reveal` under the caller's own
  credential.
- `packages/gateway/src/routes/vault-routes.ts` — the owner grant surface
  accepts `'reveal'` scopes.
- `packages/gateway/src/serve/demo-seed.test.ts` — merged a duplicate
  `node:fs` import the lint sweep flagged (drive-by, no behavior).

Commit 3 — Locker over the sealed class:

- `packages/blueprints/apps/locker/app.json` — the app requests
  `locker.item reveal` plus act on `locker.watchtower`/`locker.totp_code`;
  description tells the sealed story.
- `packages/blueprints/apps/locker/queries/item.js` — the single-item
  query is the reveal boundary: it swaps the placeholders for plaintext
  under the app's reveal scope — one receipted reveal per open, the "item
  usage" audit trail; without the grant the pane renders placeholders.
- `packages/blueprints/apps/locker/queries/items.js` — weak/reused and a
  card's last-four now come from `locker.watchtower` (reads return
  placeholders, so list-side derivation is impossible by design);
  `readWatchtower` fails soft.
- `packages/blueprints/apps/locker/queries/search.js` — same watchtower
  decoration for search results.
- `packages/blueprints/apps/locker/queries/watchtower.js` — counts ride
  the command's derivatives instead of reading passwords.

Commit 4 — connector secrets:

- `packages/automation/src/manifest/manifest.ts` —
  `requires.secrets: ["locker:<item_id>:<column>"]` (format-validated,
  connector-only — a non-connector declaring secrets is a manifest bug).
- `packages/automation/src/worker/runner.ts` — `ctx.fetch(spec)`: url /
  headers / body may carry `{{secret:…}}` placeholders; the message leaves
  the worker WITH placeholders — plaintext never enters handler memory.
- `packages/automation/src/handler/runner.ts` — the parent side:
  connector-only gate, allowlist enforcement per placeholder, host-side
  substitution + fetch, and the backstop scrub — every resolved value is
  erased from everything the run records (logs, summary, output, errors;
  raw and JSON-escaped forms).
- `packages/automation/src/fire/fire.ts` — secrets preflight: every
  declared ref reveals through the agent bridge before the handler runs
  (receipted by the vault); a missing/trashed item flips the connection to
  `needs-auth` via `sync.set_connection_status` and the run skips — the
  same honest-liveness state a principal mismatch shows. The
  paused/needs-auth skip path now closes its dispatch surface (pre-existing
  leak).
- `packages/automation/src/fire/connector.test.ts` — 5 new tests: manifest
  secrets contract, transport-level injection with a live HTTP server
  (wire carries the real value; the recorded run holds only `«secret»`),
  out-of-allowlist placeholder refusal, ctx.fetch connector-only,
  missing-item → needs-auth flip with the handler never executing.

Commit 5 — format sweep (out-of-scope cleanup, separate commit per the
standing rule; whitespace only, no behavior):

- `packages/app-engine/src/index.ts`,
  `packages/blueprints/apps/people/seed.js`,
  `packages/blueprints/apps/tally/seed.js`,
  `packages/blueprints/apps/tasks/seed.js`,
  `packages/vault/src/commands/merge.ts`,
  `packages/vault/src/commands/merge.test.ts`,
  `packages/vault/src/gateway/demo.ts`,
  `packages/vault/src/gateway/demo.test.ts`,
  `packages/vault/src/ingest/csv.ts`,
  `packages/vault/src/ingest/staging.test.ts` — oxfmt re-wraps of
  #290-era lines `bun run format` normalized while making `check` green;
  no code change.

## Decisions

- **Ciphertext at rest is the load-bearing wall.** `vault_sql` masking is
  cosmetic on top: any raw SELECT already returns opaque `sealed:v1:` wire
  values, so the assistant hole closes structurally, not by query
  inspection.
- **The seal sweep is enforcement, not convention.** Handlers keep writing
  plain SQL; the pipeline seals declared columns inside the same
  transaction before COMMIT. A careless handler cannot commit a clear
  secret.
- **Reveal is explicit-only and covers nothing else.** It never rides
  `read`/`read+act`, and a `reveal` scope grants no read — two scopes for
  the Locker app, each auditable on its own. Readonly devices browse
  placeholders and never reveal.
- **Key custody v0 = the `keys/` sibling of the vault directory**, not the
  OS keychain (deferred) and not inside the vault dir: deterministic for
  every opener (registry, admin CLI, tests) and outside anything
  export/backup/copy gestures move — a copied vault carries ciphertext
  only. Honest scope: protects files at rest and in backups, not against
  an attacker owning the running gateway.
- **Sealed entity types never stage through agents.** The password-CSV
  lane is owner-file-drop only; `sync.stage_rows` refuses locker.item
  outright — the command path stays key-free and an agent never carries
  secret material, even staged. Key-less publish of sealed rows fails
  per-row rather than plaintexting.
- **The app's reveal boundary is the single-item open.** `queries/item.js`
  was already documented as "the ONLY query that returns secrets"; it now
  exercises the reveal scope, one receipt per open. The client-side TOTP
  keeps working over the revealed seed; `locker.totp_code` exists for
  surfaces that should never see the seed (assistant, agents).
- **Transport-level injection with a scrub net.** `ctx.fetch` placeholders
  resolve on the parent side of the worker boundary, so a connector
  handler cannot log what it never holds; the backstop scrub erases
  resolved values (raw + JSON-escaped) from logs, summary, output and
  errors — proven by a test whose HTTP response deliberately echoes the
  secret.
- Deferred, per the issue: per-enrolled-device key wrapping (#289 custody),
  SQLCipher/full-file encryption, cross-vault secret sharing, OS-keychain
  wrap.

## Verification

- vault: 33 files / 290 tests green (15 new sealed-class tests; locker +
  sync suites updated for ciphertext-at-rest and the sealed staging
  refusal). v8 migration exercised by every fresh-vault test run.
- automation: 16 files / 144 tests green (5 new connector-secrets tests,
  incl. a live-HTTP transport-injection + scrub proof).
- gateway 30/161, app-engine 21/224, blueprints 5/95, desktop 7/91 green.
- Full battery: 21/21 turbo tasks green; `bun run typecheck` 21/21;
  `bun run check` (format + lint) clean.

```sh
bun run build && bun run typecheck && bun run test && bun run check
```

- The Locker app UI was not interactively click-tested; its query layer is
  covered by the blueprint suite and the vault-side behavior by the sealed
  tests.
- Live dev vaults created before v8 migrate in place (grant-scope rebuild);
  pre-existing plaintext locker rows seal lazily on their next command
  write (the sweep), or on re-import.

## Audit

Attested by a fresh-context sub-agent (claude-haiku) over the working tree,
issue #293 and this receipt; its first pass REFUTED the file coverage
(pre-Commit-5 receipt), which was fixed and re-attested.

- "## What changed" faithfully describes the full change set (Commits 1–5, no misrepresentation or omission): PASS
  Evidence: Commits 1–4 list 39 files and Commit 5 lists 10 files = 49, exactly matching the 49 entries in `git status --short` (45 modified + 4 new) with every file in exactly one commit section, and full-diff inspection of all 10 Commit-5 files (e.g. `demo.ts`, `app-engine/src/index.ts`, `tally/seed.js`, `merge.ts`) confirms they are oxfmt re-wraps only (line breaks + trailing commas, no token or behavior change) as the receipt states.

- Each '- [x]' checklist item (Commits 1–5) is realized in the working tree: PASS
  Evidence: Read-verified sealed.ts (AES-256-GCM, per-cell `table.column:rowid` AAD, `keys/` sibling custody, `sealed:v1:`/`«sealed»`), execution.ts (`sealWrites` seal sweep before COMMIT, `ctx.unseal` gated by declared `unseals`, `insertInvocation` hash-token redaction via `redactSealedInput`), gateway.ts (`commands` registry + reveal), consent.ts (`reveal` explicit-only, readonly-device deny), fts.ts (`assertNoSealedFtsColumns` throw at DDL-build), staging.ts (`stageBatchTx` seals payload fields with plaintext-hash-first dedup, key-less refusal), passwords-csv.ts (Chrome/1Password/Bitwarden aliases + otpauth seed extraction), fire.ts (secrets preflight → `needs-auth` flip + skip), handler/runner.ts + connector.test.ts (connector-only ctx.fetch, allowlist, scrub), and locker/queries/item.js (one receipted reveal per open, placeholder fallback without grant).

- The receipt's scope and Verification claims match issue #293 and the actual test counts: PASS
  Evidence: All four issue phases (registry+crypto+verb, evidence redaction, Locker re-cut, connector secrets) and all seven acceptance boxes map to verified code and tests; the auditor's fresh runs produced vault 33 files/290 tests and automation 16 files/144 tests exactly as claimed (gateway 30/161 with 1 skipped also confirmed, full battery 21/21 green), and the issue's deferred items (device-key wrapping, SQLCipher, cross-vault sharing, OS-keychain wrap) are honestly listed in Decisions.

## Steering

- Every human-steering event in the transcript is recorded as a ledger row for this receipt: PASS
  Evidence: Scanning all 2100 transcript entries, exactly one user-role non-tool-result message exists after the /goal directive at index 1158, and it is the harness's Stop-hook activation notice (restating the goal verbatim), so zero steering events occurred and zero ledger rows are owed — consistent with the receipt's empty steering ledger.

- No non-steering message is recorded as a steering event: PASS
  Evidence: The receipt's Steering section contains no ledger rows at all, so neither the /goal itself, the Stop-hook notification, nor any pre-goal design discussion is misrecorded as steering.
