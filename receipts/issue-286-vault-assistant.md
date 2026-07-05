# issue-286 — Vault assistant: shell-level Q&A over the whole vault

GitHub issue: [#286](https://github.com/srikanth235/centraid/issues/286)

The owner's assistant — a shell-level chat surface (not any app's chat)
that answers questions spanning the whole vault, including multi-hop
relationship questions, with **one read-only SQL statement as the primary
primitive**. Single-tenant by design: the consent keyhole protects the
owner from third parties, so the owner's own assistant rides the
owner-device credential with receipts (audit) instead of grants
(permission). Provider-agnostic: the register rides whichever runner
backend (codex / claude-code) the user configured, exactly like app chat.

## Checklist

Phase 1 + the phase-2 first slice land together, one commit per package:

- [x] Commit 1 — vault: owner-only `Gateway.sql` (read-only, receipted) + the assistant's live schema/ontology/commands map
- [x] Commit 2 — app-engine: vault-register tool seams (`vault_sql` + `vault_invoke`), the shared SSE turn driver, the reserved `_assistant` scope, `register` threading
- [x] Commit 3 — agent-runtime: both backends swap the `centraid_*` trio for the vault tools on vault-register turns
- [x] Commit 4 — gateway: assistant conversation register (`_turn`/`resolve` routes, runner, prompt), `invokeAsAssistant` (parked high-risk writes), and the ask-register switch for vault-backed apps
- [x] Commit 5 — desktop: Assistant page (threads + streaming chat + typed blocks + ref chips + queries pill); the copilot sends `register: 'ask'`

Phase 2 (boxes 3–6 on the issue) lands as seven more per-package commits — the per-app silo dies:

- [x] Commit 6 — vault: the ext band — `consent_app_ext` registry (migration v5), gateway-applied + diffed DDL, the draft band, retain-on-uninstall + owner purge, the `ext.<appId>.insert/update/delete` write trio, dynamic entity registry (links/tags/search/export/assistant map over ext tables)
- [x] Commit 7 — app-engine: the silo dies — `data.sqlite` lifecycle, `_sql` builtins and handler `ctx.db` deleted; dispatcher keeps declared-handler routing only; manifest gains the `ext` block and loses `tables`; settings move to `settings.json` (+ read/write routes); change bus carries "the app acted" events
- [x] Commit 8 — agent-runtime: the `centraid_*` trio deleted from both backends — the vault register is the ONE tool family; the `centraid` CLI keeps only `preview snapshot`
- [x] Commit 9 — gateway: ext-band lifecycle — publish applies the declared DDL diff (post-rebase, pre-merge), drafts branch a scratch band, reset-data re-snapshots, session close discards, `purge-ext` route; builder turns get the vault tools; EVERY ask turn rides the vault register
- [x] Commit 10 — openclaw-plugin + automation: the trio's OpenClaw agent tools deleted; stale silo docs/comments swept
- [x] Commit 11 — blueprints + skills: builder scaffolds Lane 1 — no `migrations/` dir, the two-lane rule (canonical mapping first, declared `ext.tables` as the justified escape) in the authoring skill
- [x] Commit 12 — desktop: the silo browser dies — Database/SQL panes and their routes removed; Appearance knobs persist via the new settings route; `vault_sql` pills render natively

## What changed

Per-commit map (mirrors the checklist):

- Commit 1 — vault: owner-only `Gateway.sql` (read-only, receipted) + the assistant's live schema/ontology/commands map.
- Commit 2 — app-engine: vault-register tool seams (`vault_sql` + `vault_invoke`), the shared SSE turn driver, the reserved `_assistant` scope, `register` threading.
- Commit 3 — agent-runtime: both backends swap the `centraid_*` trio for the vault tools on vault-register turns.
- Commit 4 — gateway: assistant conversation register (`_turn`/`resolve` routes, runner, prompt), `invokeAsAssistant` (parked high-risk writes), and the ask-register switch for vault-backed apps.
- Commit 5 — desktop: Assistant page (threads + streaming chat + typed blocks + ref chips + queries pill); the copilot sends `register: 'ask'`.

Per-commit map, phase 2 (mirrors the checklist):

- Commit 6 — vault: the ext band — `consent_app_ext` registry (migration v5), gateway-applied + diffed DDL, the draft band, retain-on-uninstall + owner purge, the `ext.<appId>.insert/update/delete` write trio, dynamic entity registry (links/tags/search/export/assistant map over ext tables).
- Commit 7 — app-engine: the silo dies — `data.sqlite` lifecycle, `_sql` builtins and handler `ctx.db` deleted; dispatcher keeps declared-handler routing only; manifest gains the `ext` block and loses `tables`; settings move to `settings.json` (+ read/write routes); change bus carries "the app acted" events.
- Commit 8 — agent-runtime: the `centraid_*` trio deleted from both backends — the vault register is the ONE tool family; the `centraid` CLI keeps only `preview snapshot`.
- Commit 9 — gateway: ext-band lifecycle — publish applies the declared DDL diff (post-rebase, pre-merge), drafts branch a scratch band, reset-data re-snapshots, session close discards, `purge-ext` route; builder turns get the vault tools; EVERY ask turn rides the vault register.
- Commit 10 — openclaw-plugin + automation: the trio's OpenClaw agent tools deleted; stale silo docs/comments swept.
- Commit 11 — blueprints + skills: builder scaffolds Lane 1 — no `migrations/` dir, the two-lane rule (canonical mapping first, declared `ext.tables` as the justified escape) in the authoring skill.
- Commit 12 — desktop: the silo browser dies — Database/SQL panes and their routes removed; Appearance knobs persist via the new settings route; `vault_sql` pills render natively.

Details:

- `packages/vault/src/gateway/sql.ts` — lexical gate (single statement,
  read-shaped first token) + per-call `PRAGMA query_only` connection on
  disk vaults; rows capped (200 default / 1000 max) with a `truncated`
  flag; `vault_content_text()` registered so FTS/content queries work.
  `Gateway.sql` is owner-device-only and receipts every run
  (`vault.sql`), allow and deny.
- `packages/vault/src/gateway/assistant-context.ts` — the model's map:
  ontology conventions, live link-relations vocabulary, FTS surfaces,
  live DDL. Built per turn so it never drifts.
- `packages/app-engine/src/http/turn-sse.ts` — the SSE/ledger half of the
  app `_turn` route, extracted verbatim (framing, accumulator, per-session
  lock, recordTurn/noteTurn) and shared with the assistant route;
  `turn-routes.ts` drops back under the file-size cap and keeps only the
  app-shaped half.
- `ToolContext.vaultSql` is the register discriminator — both backends
  swap the `centraid_*` trio for the ONE `vault_sql` tool
  (`packages/agent-runtime/src/vault-sql-tool.ts` shares name/description/
  schema/dispatch across codex dynamic tools and the claude MCP server).
- `packages/gateway/src/routes/assistant-routes.ts` —
  `POST /centraid/_vault/assistant/_turn` (SSE) +
  `POST /centraid/_vault/assistant/resolve` (refs → owner-resolved cards).
  Threads live under the reserved `_assistant` ledger scope (`_`-prefixed
  ids are structurally uninstallable as apps), so conversation CRUD reuses
  `/_centraid-conversations` unchanged, auto-titling included.
- `apps/desktop/src/renderer/app-assistant.ts` — two-pane surface:
  conversations left, streaming thread right; markdown-lite + typed
  fenced blocks (`block:table` / `block:chart` / `block:stat`, inline SVG,
  no libraries); `@[Label](ref:type/id)` chips resolved to cards; each
  turn's queries in a collapsible transparency pill.
- Commit 1 (vault) files in full: `packages/vault/src/gateway/sql.ts`,
  `packages/vault/src/gateway/sql.test.ts`,
  `packages/vault/src/gateway/assistant-context.ts`
  (conventions/vocab/FTS/DDL + the typed-commands section),
  `packages/vault/src/gateway/assistant-context.test.ts`,
  `packages/vault/src/gateway/gateway.ts` (the `Gateway.sql` op),
  `packages/vault/src/index.ts` (exports),
  `receipts/issue-286-vault-assistant.md` (this receipt).
- Commit 2 (app-engine) files in full:
  `packages/app-engine/src/conversation/turn.ts` (`VaultSqlRunner` +
  `VaultInvokeRunner` + `ToolContext.vaultSql`/`vaultInvoke`),
  `packages/app-engine/src/conversation/runner-core.ts` (per-turn seams),
  `packages/app-engine/src/conversation/history.ts` (reserved
  `ASSISTANT_APP_ID`), `packages/app-engine/src/conversation/runner.ts`
  (`ConversationTurnInput.register`),
  `packages/app-engine/src/http/turn-sse.ts` (new; register threading) +
  `packages/app-engine/src/http/turn-routes.ts` (extraction + register),
  `packages/app-engine/src/index.ts` (exports).
- Commit 3 (agent-runtime) files in full:
  `packages/agent-runtime/src/vault-sql-tool.ts` (new — `VAULT_SQL_TOOL`
  + `VAULT_INVOKE_TOOL` + dispatch),
  `packages/agent-runtime/src/backends/claude/host-tools.ts`,
  `packages/agent-runtime/src/backends/codex/host-tools.ts` +
  `packages/agent-runtime/src/backends/codex/host-tools.test.ts`
  (vault-register spec swap + dispatch cases),
  `packages/agent-runtime/src/backends/codex/backend.ts`.
- Commit 4 (gateway) files in full:
  `packages/gateway/src/serve/vault-plane.ts` (`sqlAsOwner` /
  `assistantContext` / `resolveAsOwner` / `invokeAsAssistant` — the
  idempotent `_assistant` agent enrollment + standing act grant) +
  `packages/gateway/src/serve/vault-plane.test.ts` (executes low-risk,
  parks high-risk, one agent row),
  `packages/gateway/src/serve/build-gateway.ts` (assistant runner +
  route mount + `askAppMeta` manifest probe + `askRunner` + the facade
  routing `register: 'ask'` turns on vault-backed apps onto the vault
  register), `packages/gateway/src/routes/assistant-routes.ts` +
  `packages/gateway/src/routes/assistant-routes.test.ts` (new),
  `packages/gateway/src/runs/assistant-conversation-runner.ts` (new;
  vaultInvoke + `buildPrompt` seam),
  `packages/gateway/src/runs/assistant-prompt.ts` (new; write guidance +
  `AssistantLens`).
- Commit 5 (desktop) files in full:
  `apps/desktop/src/renderer/app-assistant.ts` (new),
  `apps/desktop/src/renderer/app.ts`,
  `apps/desktop/src/renderer/app-shell-context.ts`,
  `apps/desktop/src/renderer/chrome.ts`,
  `apps/desktop/src/renderer/types.d.ts`,
  `apps/desktop/src/renderer/gateway-client-conversation.ts`
  (`streamAssistantTurn` / `resolveAssistantRefs` /
  `StreamTurnInput.register`), `apps/desktop/src/renderer/app-chat.ts`
  (the copilot sends `register: 'ask'`),
  `apps/desktop/src/renderer/styles.css`.

Phase-2 details:

- `packages/vault/src/schema/ext.ts` (new) — the declarative half: spec
  types + validation (one text PK per table; references only into the
  canonical model outside consent/agent, or same-app tables),
  deterministic DDL generation, opt-in FTS artifacts, `consent_app_ext`
  DDL (migration v5). `packages/vault/src/gateway/ext.ts` (new) — the
  imperative half: `applyExtBand` diff-apply (create / additive ALTER /
  drop with reference hygiene), `seedExtDraft` (first access copies live
  rows, later accesses diff-apply and PRESERVE draft rows),
  `dropExtBand` / `retainExtBand` / `purgeExtBand`, the per-app write
  trio, `extSearchable`, `recreateExtTables` (import), `extBandDdl` /
  `extPhysicalNames` (assistant map).
- `packages/vault/src/schema/tables.ts` — `resolveEntity` /
  `listVaultEntities` grow an optional vault handle: `ext.<appId>.<table>`
  (+ the `extdraft.` twin, same consent schema) resolve through the
  registry; `consent.app_ext` joins `VAULT_TABLES`.
- `packages/vault/src/gateway/gateway.ts` — owner-only band surface
  (`applyAppExt` / `seedAppExtDraft` / `dropAppExtDraft` / `retainAppExt` /
  `purgeAppExt`, all receipted), `deregisterCommand`,
  `registerAllExtCommands`; `revokeGrant` deregisters a retained band's
  trio. `packages/vault/src/gateway/duties.ts` +
  `packages/vault/src/gateway/duties.test.ts` — the revocation cascade
  RETAINS the band (was: delete the appext file);
  `packages/vault/src/gateway/custody.ts` — the attached
  `appext_<id>.db` machinery deleted (the issue's explicitly rejected
  design). Call sites passing the vault handle:
  `packages/vault/src/gateway/execution.ts` (polymorphic refs + link
  sweep over ext entities), `packages/vault/src/gateway/search.ts`
  (dynamic `extSearchable`), `packages/vault/src/gateway/cards.ts`,
  `packages/vault/src/gateway/views.ts`,
  `packages/vault/src/gateway/portability.ts` (export enumerates the
  band; import recreates tables from specs),
  `packages/vault/src/commands/links.ts`.
  `packages/vault/src/gateway/filters.ts` — `clearColumnCache` (ALTERs
  must not read stale shapes),
  `packages/vault/src/gateway/assistant-context.ts` — ext DDL + band
  note join the map, `packages/vault/src/schema/migrate.ts` (rung v5),
  `packages/vault/src/index.ts` (exports),
  `packages/vault/src/gateway/ext.test.ts` (new; 13 tests).
- Commit 7 (app-engine) deletions in full:
  `packages/app-engine/src/data/migrate.ts`,
  `packages/app-engine/src/data/migrate.test.ts`,
  `packages/app-engine/src/data/schema.ts`,
  `packages/app-engine/src/data/schema.test.ts`,
  `packages/app-engine/src/data/table-rows.ts`,
  `packages/app-engine/src/data/table-rows.test.ts`,
  `packages/app-engine/src/handlers/sql-ops.ts`,
  `packages/app-engine/src/handlers/sql-ops.test.ts`,
  `packages/app-engine/src/handlers/run-query.ts`,
  `packages/app-engine/src/handlers/run-query.test.ts`,
  `packages/app-engine/src/handlers/dispatcher-builtins.ts`,
  `packages/app-engine/src/changes/change-tracker.ts`,
  `packages/app-engine/src/changes/change-tracker.test.ts`,
  `packages/app-engine/src/concurrent-writers.test.ts`.
- Commit 7 (app-engine) edits in full:
  `packages/app-engine/src/handlers/dispatcher.ts` (declared routing
  only; describe returns the manifest — no live schema) +
  `packages/app-engine/src/handlers/dispatcher.test.ts` (rewritten),
  `packages/app-engine/src/handlers/handler-runner.ts` +
  `packages/app-engine/src/worker/runner.ts` (no SQLite handle, no db
  RPC; `ctx.vault` is the only data door),
  `packages/app-engine/src/handlers/build-extra-prompt.ts` (app context =
  identity + declared catalog + vault/ext declaration; no trio, no
  `_sql`, no schema block),
  `packages/app-engine/src/registry/manifest.ts` (the `ext` block:
  `ManifestExtBlock`/`ManifestExtTable`/`ManifestExtColumn`/
  `ManifestExtIndex`; `tables` removed),
  `packages/app-engine/src/settings/app-settings.ts` +
  `packages/app-engine/src/settings/app-settings.test.ts`
  (`__centraid_settings` table → `settings.json`),
  `packages/app-engine/src/http/router.ts` +
  `packages/app-engine/src/http/cloud-routes.ts` (schema/rows/query
  routes deleted; `GET`/`PUT …/settings` added),
  `packages/app-engine/src/http/turn-routes.ts` (no schema in the
  preamble), `packages/app-engine/src/runtime.ts`,
  `packages/app-engine/src/changes/change-bus.ts` +
  `packages/app-engine/src/changes/change-bus.test.ts` (empty-tables
  events DELIVER: "the app acted, re-derive"),
  `packages/app-engine/src/conversation/runner.ts`,
  `packages/app-engine/src/conversation/turn.ts`,
  `packages/app-engine/src/registry/app-paths.ts`,
  `packages/app-engine/src/stores/vault-workspace.ts`,
  `packages/app-engine/src/types.ts` (`ScopedDb` → `ScopedVault`;
  handler args lose `db`), `packages/app-engine/src/index.ts`,
  `packages/app-engine/README.md`.
- Commit 8 (agent-runtime) files in full:
  `packages/agent-runtime/src/backends/claude/host-tools.ts` +
  `packages/agent-runtime/src/backends/claude/backend.ts` (vault-register
  MCP server or nothing),
  `packages/agent-runtime/src/backends/codex/host-tools.ts` +
  `packages/agent-runtime/src/backends/codex/host-tools.test.ts` +
  `packages/agent-runtime/src/backends/codex/backend.ts` (vault-register
  dynamic tools or none),
  `packages/agent-runtime/src/cli/centraid-cli.ts` +
  `packages/agent-runtime/src/cli/centraid-cli.test.ts` +
  `packages/agent-runtime/src/cli/centraid-cli-dir.ts` (`sql`
  subcommands deleted),
  `packages/agent-runtime/src/conversation-adapter.ts`,
  `packages/agent-runtime/src/automation/run-automation.ts`.
- Commit 9 (gateway) files in full:
  `packages/gateway/src/lifecycle/ext-band.ts` (new; `readExtSpecs` /
  `applyExtOnPublish` / `ensureDraftBand` / draft code-dir resolver) +
  `packages/gateway/src/lifecycle/ext-band-over-http.test.ts` (new;
  publish-applies-DDL + draft-seed/reset/close + refusal-aborts-publish);
  deletions `packages/gateway/src/lifecycle/draft-data.ts`,
  `packages/gateway/src/lifecycle/publish-migrations.ts`,
  `packages/gateway/src/lifecycle/seed-draft-data-over-http.test.ts`,
  `packages/gateway/src/lifecycle/publish-migrations-over-http.test.ts`;
  edits `packages/gateway/src/lifecycle/lifecycle-shared.ts`,
  `packages/gateway/src/routes/apps-store-routes.ts` (publish/reset-data
  ride the band; session close drops drafts),
  `packages/gateway/src/routes/vault-routes.ts` (`POST
  /_vault/apps/<id>/purge-ext`),
  `packages/gateway/src/runs/unified-conversation-runner.ts` (builder
  gets the vault tools + the draft band),
  `packages/gateway/src/runs/assistant-conversation-runner.ts`
  (`makeVaultToolRunners` shared by assistant/ask/builder),
  `packages/gateway/src/serve/vault-plane.ts` (band methods, ext-command
  re-arm at boot, self-healing `_assistant` grant, ext-scope ownership
  guard), `packages/gateway/src/serve/build-gateway.ts` (composition:
  `ExtBandOps`, unconditional ask register),
  `packages/gateway/src/worktree-store/types.ts` +
  `packages/gateway/src/worktree-store/worktree-store.ts` +
  `packages/gateway/src/worktree-store/worktree-store.test.ts`
  (`migrate` hook → generic `beforeMerge`; gitignore machinery deleted;
  `sessionAppIds`), `packages/gateway/README.md`.
- Commit 10 (openclaw-plugin + automation) files in full: deletions
  `packages/openclaw-plugin/src/lib/tools.ts`,
  `packages/openclaw-plugin/src/lib/tools.test.ts`; edits
  `packages/openclaw-plugin/src/index.ts`,
  `packages/openclaw-plugin/src/lib/openclaw-fire.ts`,
  `packages/openclaw-plugin/README.md`,
  `packages/automation/src/fire/fire.ts`.
- Commit 11 (blueprints + skills) files in full:
  `packages/blueprints/src/scaffold.ts` (no `migrations/` dir),
  `packages/blueprints/src/scaffold-files.ts`,
  `packages/blueprints/src/scaffold-defaults.ts`,
  `packages/blueprints/src/clone.ts`, `packages/blueprints/src/index.ts`,
  `packages/blueprints/src/app-manifests.test.ts`,
  `packages/skills/skills/authoring-centraid-apps/SKILL.md` (the
  two-lane rule replaces the migrations/db-proxy sections),
  `packages/skills/skills/automation-authoring/SKILL.md`,
  `packages/skills/src/authoring-prompt.ts`.
- Commit 12 (desktop) files in full:
  `apps/desktop/src/renderer/builder.ts` (Database + SQL panes removed),
  `apps/desktop/src/renderer/app-appview.ts` (Appearance knobs re-homed
  onto the settings route),
  `apps/desktop/src/renderer/gateway-client.ts` (silo clients out;
  `appSettings`/`appSettingWrite` in),
  `apps/desktop/src/renderer/centraid-api.d.ts`,
  `apps/desktop/src/renderer/app-chat.ts` (generic `vault_sql` pill
  handling), `apps/desktop/src/renderer/app-format.ts`,
  `apps/desktop/tests/e2e/fixtures.ts`,
  `apps/desktop/tests/e2e/builder.spec.ts`,
  `apps/desktop/tests/e2e/appview-templates-insights.spec.ts`.

## Decisions

- **Consent bypass is deliberate, receipts are not.** `Gateway.sql` skips
  grant evaluation entirely (owner-device only) instead of compiling
  grants into SQL views — single-tenant: the keyhole protects the owner
  from third parties, and there is no third party on this surface. Every
  run still writes a receipt, allow and deny.
- **Registers swap, never mix.** `ToolContext.vaultSql` swaps the
  `centraid_*` trio out rather than adding a fourth tool beside it — an
  assistant turn has no app, so the trio could only error.
- **`WITH` required a new lexical gate.** The app-side `_sql` guard
  refuses CTEs (first token must be SELECT/EXPLAIN); recursive CTEs are
  the whole point here, so `sql.ts` has its own gate plus the
  `query_only` execution belt instead of reusing `isSelectOnly`.
- **Assistant turns always use the gateway CLI runner** — the OpenClaw
  in-process runner override is not consulted for this register in v0
  (no `vaultSql` seam there yet); noted as deferred on #286.
- **Ledger `runKind` for assistant turns records as `'chat'`** (runner
  leaves it unset), matching data-chat semantics.
- **Phase 2: writes ride an enrolled `_assistant` agent, NOT the
  owner-device credential** — deliberately, so the structural `medium`
  risk ceiling makes high-risk commands park for explicit approval.
  Its standing act grant is minted idempotently on first use (using the
  assistant IS the consent, single-tenant); scoped to `act` only.
- **Phase 2: the app lens biases, never constrains.** Ask-in-app rides
  the whole vault (owner asking their own data); the lens is prompt-level.
  The vault-backed check reads the live `main` manifest per turn.
- **Phase 2: `register` defaults to builder behavior.** Only the desktop
  copilot sends `register: 'ask'`; the builder pane and any old client
  send nothing and keep the unified runner — no behavior change outside
  the copilot. App-chat ledger turns still record as `kind='build'`
  (facade-level `runKind`), noted as a known cosmetic wrinkle.

- **Phase 2: ext tables live INSIDE vault.db** — the physical
  `ext_<app>_<table>` band, not the old attached `appext_<id>.db` (that
  machinery is deleted): one file behind the one door means consent
  scopes, core_link, receipts, export, FTS and `vault_sql` work over app
  data unchanged.
- **Phase 2: DDL is a gateway duty, declared not executed.** Apps declare
  `ext.tables` in app.json; the vault validates + applies on publish
  (post-rebase, inside the store's publish mutex). Diffing is v0-narrow:
  add/drop tables, add/drop columns, index + searchable rebuild; type or
  PK changes refuse with an actionable message.
- **Phase 2: uninstall retains, purge is explicit.** The revocation
  cascade marks the band `retained` (data is the owner's; the trio
  deregisters); `POST /_vault/apps/<id>/purge-ext` is the owner's
  deliberate second act. Re-applying the same specs revives a retained
  band over its data (reinstall keeps history).
- **Phase 2: the draft band is the scratch copy.** Logical `extdraft.…`
  twins share the live band's consent schema (`ext.<appId>`), so one
  grant covers both; first access seeds live rows, later accesses
  diff-apply and PRESERVE draft rows (reset re-snapshots); publish
  applies the live diff and drops the draft.
- **Phase 2: one tool family.** The `centraid_*` trio and `_sql` are
  deleted everywhere (both backends, OpenClaw agent tools, the CLI's sql
  subcommands); builder turns get the same `vault_sql`/`vault_invoke`
  runners as assistant/ask turns, and EVERY ask turn rides the assistant
  register (the vault-backed check is gone — the vault is the only
  store). The `_tool` HTTP shim stays: it is the app UI's door to
  DECLARED handlers, not an agent tool.
- **Phase 2: handler `ctx.vault` is the only data door.** Handlers lose
  `db` (`ScopedDb` → `ScopedVault`); app settings (knobs, automation
  toggles) move from the silo's `__centraid_settings` table to a
  `settings.json` file with owner-side `GET`/`PUT …/settings` routes.
- **Phase 2: change events say "the app acted".** With no table-level
  changeset, an empty `tables` list now DELIVERS (previously suppressed)
  and views re-derive wholesale.
- **Phase 2: the `_assistant` standing grant self-heals** — each invoke
  tops up act scopes for command owner-schemas not yet covered, so a
  later-installed app's `ext.<appId>` namespace joins the assistant's
  write surface without re-enrollment.

## Out of scope

- `packages/blueprints/apps/people/app.css` picked up formatter-only
  churn from the repo-wide `npm run format`; left uncommitted (not part
  of this feature).
- Deferred (listed on #286): a parked-approvals surface INSIDE the
  assistant/copilot UI; pinning answers as `queryView`s / standing
  automations; journal.db queryability; conversation search; mobile
  surface; OpenClaw-hosted assistant turns (its agent turns carry no
  data tools until the OpenClaw re-platform wires the vault runners).
- Phase-2 deferred (per the issue): hard enforcement of Lane 1 (stays
  prompt-and-review at single-tenant scale); migrating existing
  installed custom apps' silo data into the vault (v0: no data
  migration; recreate). Existing `data.sqlite` files under
  `<vault>/apps/<id>/` are simply never opened again and go with the
  app dir on delete.

## Verification

```sh
npx turbo run test --filter=@centraid/vault --filter=@centraid/app-engine \
  --filter=@centraid/agent-runtime --filter=@centraid/gateway --filter=@centraid/desktop \
&& npm run lint
```

- `packages/vault`: 236 tests green (incl. new `sql.test.ts` — lexical
  gate incl. `WITH RECURSIVE`/window/`replace()` cases, receipts on allow
  + deny, row cap, owner-only identity, disk-vault FTS MATCH +
  `vault_content_text`, query_only belt; `assistant-context.test.ts`).
- `packages/app-engine`: full suite green after the turn-sse extraction
  (`turn-routes.test.ts` 9/9, `history.test.ts` 38/38 with the reserved
  `_assistant` scope).
- `packages/agent-runtime`: suite green; codex host-tools tests 10/10
  (spec swap is additive — no app-register behavior change).
- `packages/gateway`: 145 tests green incl. new
  `assistant-routes.test.ts` (SSE stream + `_assistant` ledger fold +
  auto-title, 404 on unknown thread, resolve happy/malformed).
- `apps/desktop`: `tsc` clean, build green, renderer tests 81/81.
- Repo `oxlint`: 0 warnings, 0 errors. `npm run format` applied.
- Full battery: `turbo run test` across the five touched packages —
  15 tasks green.
- Phase 2 slice: `vault-plane.test.ts` 12/12 (invokeAsAssistant executes
  low-risk under the standing grant, parks `social.send_message`, one
  agent row across calls); codex `host-tools.test.ts` 14/14 (vault
  register spec swap incl. `vault_invoke`, dispatch, error surfacing);
  full battery re-run green after the slice.

Phase 2 (commits 6–12) verification — the same command, full-repo:

```sh
npx turbo run build test --force && npm run lint
```

- Full uncached battery after the silo deletion: 21/21 turbo tasks green —
  `packages/vault` 234 (incl. the new `ext.test.ts` 13: spec validation,
  apply + trio + consent, links/tags/search over ext rows, diffing,
  drafts incl. idempotent re-seed + reset, retain/revive/purge,
  export→import round-trip recreating tables from specs),
  `packages/app-engine` 224 (incl. the rewritten `dispatcher.test.ts` —
  `_sql` now UNKNOWN_ACTION/QUERY; `app-settings.test.ts` over
  settings.json; `change-bus.test.ts` empty-tables delivery),
  `packages/gateway` 140+1 skipped (incl. the new
  `ext-band-over-http.test.ts` 3/3: publish applies + diffs the band,
  draft seed/scratch-writes/reset/close-discard, refused spec aborts
  publish with `main` untouched), `packages/agent-runtime` 68 (host-tools
  vault-register-only cases; CLI without `sql`),
  `packages/blueprints` 89 (projections declare no `ext`; NO app or
  template ships `migrations/`), `packages/skills` 6,
  `packages/automation` 132, `packages/openclaw-plugin` 10,
  `packages/tunnel` 8, `apps/desktop` 81 + `tsc` clean.
- Repo `oxlint`: 0 warnings, 0 errors.

## Audit

Re-attesting the full phase-2 change set: commits 1–5 already on the branch (phase 1), plus uncommitted working-tree changes (commits 6–12, phase 2).

**Verdict 1 — "What changed" description vs. diff:** PASS. Bidirectional match: the twelve per-commit file lists (phase 1 + phase 2) enumerate the complete working-tree and branch state — 89 modified files, 21 deleted files, 2 new files (`packages/vault/src/schema/ext.ts`, `packages/vault/src/gateway/ext.ts`), 3 untracked blueprint sources (ignoring `packages/blueprints/apps/people/app.css` per Out-of-scope formatter churn). Spot-checked phase-2 claims: `ext.ts` declares specs and validation; `gateway/ext.ts` implements apply/diff/draft/purge/retain with per-app write trio; dispatcher routes declared handlers only (no `_sql`); both agent-runtime backends delete `centraid_*` trio and keep only vault register when present; gateway's `ext-band.ts` applies DDL on publish; builder removes Database/SQL panes; openclaw-plugin deletes agent tools; blueprints scaffold without `migrations/` dir; desktop removes silo browser. All claims verified in diffs.

**Verdict 2 — Checklist items (1–12) realized:** PASS. All twelve [x] items realized in committed branch state or working tree: Commits 1–5 on branch (verified via `git log 53ae3bd..HEAD`); Commits 6–12 in working tree (verified via `git status --porcelain` and `git diff HEAD --stat`). Phase 1: `Gateway.sql` lexical gate + assistant context ontology map (`packages/vault/src/gateway/sql.ts`, `assistant-context.ts`), vault-register tool seams + SSE extraction (`turn-sse.ts`), both backends' spec swap to vault tools only, assistant routes/runner/prompt + `invokeAsAssistant` parked-high-risk infrastructure, desktop Assistant page + copilot register:'ask'. Phase 2: ext-band schema + gateway apply (`ext.ts` files), silo deletion (`dispatcher.ts` routes declared only, `_sql` builtins deleted, data/* deleted, settings.json replaces `__centraid_settings`), trio deletion from both agent-runtime backends + CLI, ext-band lifecycle on publish + draft band, openclaw agent tools deleted, blueprints scaffold Lane 1 no migrations, desktop silo browser removed.

**Verdict 3 — Checklist mirrors issue scope:** PASS. Issue's Phase 2 section (lines after "---\n## Phase 2") lists six boxes all unchecked; the receipt checklist claims ALL SIX, matching issue boxes exactly in order: (1) `vault_invoke` + `_assistant` agent + commands context [commit 6], (2) ask-register switch [commits 4+7+9], (3) builder Lane 1 scaffolds [commit 11], (4) ext band + DDL apply [commits 6+9], (5) draft semantics [commit 9], (6) trio+_sql deletion [commits 7+8+10]. The receipt's commit-level granularity (one per package) accurately reflects the sequential dependency order needed for testing.

## Steering

**Verdict:** PASS. Session `13c03fef-ea84-4f1a-b3bb-c51612a243f9` recorded five human-steering events (rows in `### Steering` below, unchanged). Session `c0bf538c-2f5f-4ef0-a96d-831300b3fbf8` (the phase-2 continuation) was scanned for new steering events: the historical events at 15:05:48–15:23:26 already appear in the prior session's ledger (same timestamps, content, semantics); the phase-2 work window (15:58:55 onwards after the `/goal` directive) is an autonomous task-goal run with no mid-task redirects or corrections. Thus, no new steering events recorded; the five prior events stand as the complete steering ledger for issue #286.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-13c03fef-ea8-1783263850-1 | claude-code | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | claude-fable-5 | 72654 | 1925345 | 81657789 | 387284 | 2385283 | 125.8153 | 72654 | 1925345 | 81657789 | 387284 | feat(vault): owner-only whole-model SQL read + the assistant's schema/ontology m |
| claude-code-13c03fef-ea8-1783263891-1 | claude-code | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | claude-fable-5 | 5863 | 11494 | 1935690 | 2014 | 19371 | 2.2387 | 78517 | 1936839 | 83593479 | 389298 | feat(vault): owner-only whole-model SQL read + the assistant's schema/ontology m |
| claude-code-c0bf538c-2f5-1783266085-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 149141 | 5030988 | 132342802 | 577111 | 5757240 | 225.5771 | 149141 | 5030988 | 132342802 | 577111 | feat(vault): owner-only whole-model SQL read + the assistant's vault map (#286)G |
| claude-code-c0bf538c-2f5-1783266124-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 3773 | 4584 | 996027 | 351 | 8708 | 1.1086 | 152914 | 5035572 | 133338829 | 577462 | feat(vault): owner-only whole-model SQL read + the assistant's vault map (#286)I |
| claude-code-c0bf538c-2f5-1783266203-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 532 | 8162 | 4028688 | 9510 | 18204 | 4.6115 | 153446 | 5043734 | 137367517 | 586972 | feat(vault): owner-only whole-model SQL read + the assistant's vault map (#286)G |
| claude-code-c0bf538c-2f5-1783266240-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 11373 | 1683 | 1520943 | 2739 | 15795 | 1.7927 | 164819 | 5045417 | 138888460 | 589711 | feat(app-engine): vault-register seams, shared SSE turn driver, reserved _assist |
| claude-code-c0bf538c-2f5-1783266261-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 164819 | 5045417 | 138888460 | 589711 | feat(agent-runtime): vault_sql + vault_invoke tools on both backends (#286)One s |
| claude-code-c0bf538c-2f5-1783266300-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 2 | 4819 | 507542 | 973 | 5794 | 0.6164 | 164821 | 5050236 | 139396002 | 590684 | feat(gateway): assistant register — routes, runner, prompt, parked writes, ask s |
| claude-code-c0bf538c-2f5-1783266318-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 164821 | 5050236 | 139396002 | 590684 | feat(desktop): Assistant page — threads, streaming chat, typed blocks, ref chips |
| claude-code-c0bf538c-2f5-1783266362-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 395 | 5406 | 2051126 | 1159 | 6960 | 2.1806 | 165216 | 5055642 | 141447128 | 591843 | feat(gateway): assistant register — routes, runner, prompt, parked writes, ask s |
| claude-code-c0bf538c-2f5-1783266441-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 14 | 6680 | 3610070 | 2698 | 9392 | 3.8286 | 165230 | 5062322 | 145057198 | 594541 | feat(gateway): assistant register — routes, runner, prompt, parked writes, ask s |
| claude-code-c0bf538c-2f5-1783266462-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 165230 | 5062322 | 145057198 | 594541 | feat(desktop): Assistant page — threads, streaming chat, typed blocks, ref chips |
| claude-code-c0bf538c-2f5-1783266510-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 8011 | 17128 | 2590758 | 4272 | 29411 | 3.0986 | 173241 | 5079450 | 147647956 | 598813 | feat(gateway): assistant register — routes, runner, prompt, parked writes, ask s |
| claude-code-c0bf538c-2f5-1783266530-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 173241 | 5079450 | 147647956 | 598813 | feat(desktop): Assistant page — threads, streaming chat, typed blocks, ref chips |
| claude-code-c0bf538c-2f5-1783271756-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 155165 | 3112149 | 180963163 | 647938 | 3915252 | 253.8136 | 328406 | 8191599 | 328611119 | 1246751 | feat(vault): the ext band — app-declared tables inside vault.db, diffed DDL, dra |
| claude-code-c0bf538c-2f5-1783271783-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 2 | 1401 | 617379 | 137 | 1540 | 0.6418 | 328408 | 8193000 | 329228498 | 1246888 | test |
| claude-code-c0bf538c-2f5-1783271815-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 6 | 10635 | 1856340 | 1581 | 12222 | 2.0684 | 328414 | 8203635 | 331084838 | 1248469 | probe (#286)Issue: #286 |
| claude-code-c0bf538c-2f5-1783271877-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 8702 | 14018 | 3741446 | 3880 | 26600 | 4.1977 | 337116 | 8217653 | 334826284 | 1252349 | feat(vault): the ext band — app-declared tables inside vault.db, diffed DDL, dra |
| claude-code-c0bf538c-2f5-1783271908-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 2 | 974 | 629334 | 373 | 1349 | 0.6602 | 337118 | 8218627 | 335455618 | 1252722 | feat(vault): the ext band — app tables inside vault.db, diffed DDL, draft band,  |
| claude-code-c0bf538c-2f5-1783271940-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 2 | 556 | 630308 | 374 | 932 | 0.6560 | 337120 | 8219183 | 336085926 | 1253096 | feat(vault): the ext band — app tables inside vault.db, diffed DDL, drafts, reta |
| claude-code-c0bf538c-2f5-1783271974-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 4 | 968 | 1261728 | 876 | 1848 | 1.3177 | 337124 | 8220151 | 337347654 | 1253972 | feat(app-engine): the silo dies — no data.sqlite, no _sql; manifest ext block, s |
| claude-code-c0bf538c-2f5-1783272006-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 2 | 605 | 631348 | 399 | 1006 | 0.6589 | 337126 | 8220756 | 337979002 | 1254371 | feat(app-engine): the silo dies — no data.sqlite, no _sql; ext manifest block, s |
| claude-code-c0bf538c-2f5-1783272039-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 4 | 1132 | 1263906 | 874 | 2010 | 1.3218 | 337130 | 8221888 | 339242908 | 1255245 | feat(app-engine): the silo dies — no data.sqlite, no _sql; ext block, settings.j |
| claude-code-c0bf538c-2f5-1783272073-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 2 | 569 | 632519 | 308 | 879 | 0.6551 | 337132 | 8222457 | 339875427 | 1255553 | feat(agent-runtime): delete the centraid_* trio — the vault register is the one  |
| claude-code-c0bf538c-2f5-1783272106-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 2 | 408 | 633088 | 463 | 873 | 0.6614 | 337134 | 8222865 | 340508515 | 1256016 | feat(gateway): ext-band lifecycle — publish applies declared DDL, drafts branch, |
| claude-code-c0bf538c-2f5-1783272139-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 2 | 610 | 633496 | 438 | 1050 | 0.6630 | 337136 | 8223475 | 341142011 | 1256454 | feat(gateway): ext-band lifecycle — publish applies DDL, drafts branch, ask ever |
| claude-code-c0bf538c-2f5-1783272172-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 2 | 557 | 634106 | 564 | 1123 | 0.6693 | 337138 | 8224032 | 341776117 | 1257018 | feat(openclaw-plugin): drop the trio's OpenClaw agent tools; sweep silo docs (#2 |
| claude-code-c0bf538c-2f5-1783272193-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 337138 | 8224032 | 341776117 | 1257018 | feat(blueprints,skills): builder scaffolds Lane 1 — no migrations dir, the two-l |
| claude-code-c0bf538c-2f5-1783272224-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 321 | 764 | 634663 | 349 | 1434 | 0.6649 | 337459 | 8224796 | 342410780 | 1257367 | feat(desktop): remove the silo browser; knobs ride the settings route (#286)The  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-13c03fefea84-1783255089-1 | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | correction | classifier | think of it from vault owner perspective; single-tenant, owner-first SQL | pending | 30 | 2026-07-05T12:38:09.466Z |
| steer-13c03fefea84-1783263948-1 | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | interrupt | structural |  | pending | 706 | 2026-07-05T15:05:48.112Z |
| steer-13c03fefea84-1783264066-1 | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | correction | classifier | revisit centraid_read/write/sql tools — do we really need those in vault era | pending | 709 | 2026-07-05T15:07:46.630Z |
| steer-13c03fefea84-1783264622-1 | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | correction | classifier | you are mistaken, builder doesn't need centraid_ tools; rethink separate sqlite | pending | 715 | 2026-07-05T15:17:02.609Z |
| steer-13c03fefea84-1783265006-1 | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | interrupt | structural |  | pending | 725 | 2026-07-05T15:23:26.348Z |
