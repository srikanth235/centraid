# Issue #432 — Agents settings: per-subsystem agent routing, Operations split, and a settings design audit

## Checklist

- [x] Resolve the agent runner per subsystem, not globally
- [x] Rebuild the Agents screen around routing rather than an active-agent switch
- [x] Unify empty states, buttons, tabs and the select chevron across settings
- [x] Fix the Alerts tab layout
- [x] Split Gateway into an Operations section with Gateway and Backups
- [x] Gate dead classNames with a repo check

## What changed

### Checklist evidence

**Resolve the agent runner per subsystem, not globally.** `resolveSubsystemRunner(prefs, subsystem)` lands in `packages/app-engine/src/stores/prefs-store.ts` (exported via `packages/app-engine/src/index.ts`), reading `runner.<subsystem>` and falling back to `agent.runner.kind` then `'codex'`. `resolveSubsystemModel` is untouched — its signature already took `runnerKind` as an argument, which was exactly the seam needed. The core fix is in `packages/gateway/src/serve/build-gateway.ts`: `resolveModel` now resolves the runner **first**, for that subsystem, and that kind scopes the model key. Model prefs are per runner (`model.<kind>.<sub>`), so reading them against the global kind while a subsystem runs on a different agent handed the turn a model its backend had never heard of. `askModelPrefs` read one key and wrote another once `runner.ask` was pinned; both halves now go through `prefsLoader('ask')`. The `prefsLoader` seam widened to accept an optional subsystem across `packages/app-engine/src/conversation/runner-core.ts`, `packages/agent-runtime/src/conversation-adapter.ts`, `packages/gateway/src/runs/assistant-conversation-runner.ts` and `packages/gateway/src/runs/unified-conversation-runner.ts`; each runner carries a `subsystem` tag rather than a resolved kind. The `runner.` prefix is deliberate — the daemon config seeder owns `agent.runner.*` and nulls every key it knows on boot.

**Rebuild the Agents screen around routing rather than an active-agent switch.** `packages/client/src/react/screens/SettingsProvidersScreen.tsx` and `SettingsProvidersScreen.module.css` are rewritten around two sections: Routing (every decision) and Agents (inventory). The screen splits along that same seam to stay under the hygiene cap: `packages/client/src/react/screens/SettingsProvidersSelects.tsx` holds the shared select primitives and `packages/client/src/react/screens/SettingsProvidersAgents.tsx` the inventory entry. The exclusive Codex/Claude-Code radio is gone — it encoded a dead premise. The default agent is now the first lane of the routing table; the "Active" pill is replaced by used-by chips; inheriting lanes name what they resolve to. Contract surface (`subsystemRunnerByKey`, `setSubsystemRunner`) added to `packages/client/src/react/screen-contracts.ts` and wired in `packages/client/src/react/shell/routes/settingsProvidersData.ts` and `packages/client/src/react/shell/routes/SettingsRoute.tsx`.

**Unify empty states, buttons, tabs and the select chevron across settings.** New shared `packages/client/src/react/styles/inlineEmpty.module.css` (adopted by Connections, Storage and the automation editor; italic dropped) and `packages/client/src/react/styles/select.module.css` — one masked, theme-following chevron replacing four hardcoded `#8a8f98` data-URI copies. A data-URI SVG is a separate document, so `var()`/`currentColor` cannot reach inside it; only a mask can be tinted by a token. Touched: `AppSettingsPanel.tsx`/`.module.css`, `AutomationEditorScreen.tsx`/`.module.css`, `SettingsConnectionsScreen.tsx`/`.module.css`, `SettingsStorageScreen.tsx`/`.module.css`, `packages/client/src/react/styles/controls.module.css`, `packages/client/src/react/screens/BackupCard.module.css`, `packages/client/src/react/screens/BackupPolicyPanel.tsx`. Real bug fixed: `--c-red` is not emitted by any token (the palette has no `red` key), so automation-editor validation errors rendered in inherited body ink — now `var(--danger)`. Tests updated in `AppSettingsPanel.test.tsx` and `SettingsConnectionsScreen.test.tsx`. Conventions documented in `packages/client/src/react/CSS-CONVENTIONS.md`.

**Fix the Alerts tab layout.** In `packages/client/src/react/screens/GatewayScreen.module.css` and `GatewayScreen.tsx`: `.tabPane` had no gap, so the three cards sat flush and their 0.5px borders doubled into a seam; `align-items: center` floated the dot, timestamp and badge to the vertical middle of any row whose message wrapped; a bare `1fr` floored at min-content so an unbroken vault path pushed the row past the panel, where `.panel { overflow: hidden }` silently clipped the badge off the right edge. Now a flex column with gap, `align-items: start` over a shared `--outage-line`, `minmax(0, 1fr)` + `overflow-wrap: anywhere`, and a 780px measure for the single-column alerts pane.

**Split Gateway into an Operations section with Gateway and Backups.** New `packages/client/src/react/screens/BackupsScreen.tsx`, `BackupsScreen.module.css`, `BackupsScreen.test.tsx` and `packages/client/src/react/shell/routes/BackupsRoute.tsx`. `BackupCard` and `StorageCard` move unchanged out of `GatewayScreen.tsx`, whose props and imports shrink accordingly; `GatewayRoute.tsx` sheds the backup props. The `backups` page id is registered across `packages/client/src/app-shell-context.ts`, `packages/client/src/react/shell/router.ts`, `packages/client/src/react/shell/Sidebar.tsx`, `packages/client/src/react/shell/App.tsx` and the ⌘K palette (`packages/client/src/react/shell/routes/paletteData.ts`). Tests updated in `GatewayScreen.test.tsx` and `Sidebar.test.tsx`.

**Gate dead classNames with a repo check.** New `scripts/lint-css-classes.mjs`, wired as `lint:css` into the root `ci` script in `package.json`. A `className={styles.foo}` with no `.foo` rule resolves to `undefined` and renders unstyled — and passes typecheck (module locals are a permissive index signature), tests (`classNameStrategy: 'non-scoped'` makes `styles.foo === 'foo'`, so a test selecting `.foo` matches with no rule behind it) and build. Ten were found and fixed: `packages/client/src/react/screens/StorageCard.tsx`, `AssistantMessage.tsx`, `DiscoverScreen.tsx`, `HomeScreen.tsx`, `RunViewScreen.tsx` (six) and `AppSettingsPanel.tsx`. `RunViewScreen.test.tsx` moves off `.tlItemFinal` — a rule-less class that was load-bearing as a *test selector* — onto `data-testid="timeline-final"`.

### Changed paths

Modified:

- `package.json`
- `packages/agent-runtime/src/conversation-adapter.ts`
- `packages/app-engine/src/conversation/runner-core.ts`
- `packages/app-engine/src/index.ts`
- `packages/app-engine/src/stores/prefs-store.test.ts`
- `packages/app-engine/src/stores/prefs-store.ts`
- `packages/client/src/app-shell-context.ts`
- `packages/client/src/react/CSS-CONVENTIONS.md`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AppSettingsPanel.module.css`
- `packages/client/src/react/screens/AppSettingsPanel.test.tsx`
- `packages/client/src/react/screens/AppSettingsPanel.tsx`
- `packages/client/src/react/screens/AssistantMessage.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.module.css`
- `packages/client/src/react/screens/AutomationEditorScreen.tsx`
- `packages/client/src/react/screens/BackupCard.module.css`
- `packages/client/src/react/screens/BackupPolicyPanel.tsx`
- `packages/client/src/react/screens/DiscoverScreen.tsx`
- `packages/client/src/react/screens/GatewayScreen.module.css`
- `packages/client/src/react/screens/GatewayScreen.test.tsx`
- `packages/client/src/react/screens/GatewayScreen.tsx`
- `packages/client/src/react/screens/HomeScreen.tsx`
- `packages/client/src/react/screens/RunViewScreen.test.tsx`
- `packages/client/src/react/screens/RunViewScreen.tsx`
- `packages/client/src/react/screens/SettingsConnectionsScreen.module.css`
- `packages/client/src/react/screens/SettingsConnectionsScreen.test.tsx`
- `packages/client/src/react/screens/SettingsConnectionsScreen.tsx`
- `packages/client/src/react/screens/SettingsProvidersScreen.module.css`
- `packages/client/src/react/screens/SettingsProvidersScreen.test.tsx`
- `packages/client/src/react/screens/SettingsProvidersScreen.tsx`
- `packages/client/src/react/screens/SettingsStorageScreen.module.css`
- `packages/client/src/react/screens/SettingsStorageScreen.tsx`
- `packages/client/src/react/screens/StorageCard.tsx`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/Sidebar.test.tsx`
- `packages/client/src/react/shell/Sidebar.tsx`
- `packages/client/src/react/shell/router.ts`
- `packages/client/src/react/shell/routes/GatewayRoute.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/paletteData.ts`
- `packages/client/src/react/shell/routes/settingsProvidersData.ts`
- `packages/client/src/react/styles/controls.module.css`
- `packages/gateway/src/runs/assistant-conversation-runner.ts`
- `packages/gateway/src/runs/unified-conversation-runner.ts`
- `packages/gateway/src/serve/build-gateway.test.ts`
- `packages/gateway/src/serve/build-gateway.ts`

Added:

- `packages/app-engine/src/conversation/runner-core.test.ts`
- `packages/client/src/react/screens/BackupsScreen.module.css`
- `packages/client/src/react/screens/BackupsScreen.test.tsx`
- `packages/client/src/react/screens/BackupsScreen.tsx`
- `packages/client/src/react/screens/SettingsProvidersAgents.tsx`
- `packages/client/src/react/screens/SettingsProvidersSelects.tsx`
- `packages/client/src/react/shell/routes/BackupsRoute.tsx`
- `packages/client/src/react/styles/inlineEmpty.module.css`
- `packages/client/src/react/styles/select.module.css`
- `receipts/issue-432-agent-routing-settings-audit.md`
- `scripts/lint-css-classes.mjs`

## Out of scope

- **The `--t-*` type scale is unfit for purpose, not merely under-adopted.** The tokens are CSS `font` shorthands (`css.ts:88-95`) carrying family + weight + line-height, so `font-size: var(--t-small)` is an invalid value and the declaration is silently dropped. The scale cannot express "13px, keep the mono family" — the majority case — so authors writing raw px are making the correct call. Fixing it means paired `--t-*-size` / `--t-*-line` vars in `@centraid/design-tokens`, a tokens-package change deliberately not smuggled in here.
- **`RunViewScreen`'s log rows.** `label`, `sub` and `response` never had CSS rules, so `sub` renders identically to `label`. The dead references are dropped (a no-op) with a docblock recording it; making them visually distinct is a design change, not a cleanup.
- **Dead CSS left in place:** the unreferenced `.trigCard*` family and `.warnBanner` in `AutomationEditorScreen.module.css`, and `.settingsSectionLabel` (which is `display: none` at both use sites).
- **No live visual verification.** There is no Electron rig in this environment, so every visual claim rests on code reading and tests, not screenshots.
- Pre-existing local artifacts (`packages/blueprints/manifest.json`, three generated `queries/*.d.ts`, `.dockerignore`, `Dockerfile.gateway-test`) are untouched and unstaged.

## Decisions

- **The radio group had to go, not be restyled.** "Active agent" encodes exclusivity; per-subsystem routing retires that premise. Keeping the control while adding per-lane agents would have left the page asserting something false.
- **Two instructions to sub-agents were wrong and were correctly refused.** (1) Converting `#fff` → `--ink-inv` in three places would have been a real dark-theme bug: `--ink-inv` is *inverse* ink (`#141820` in dark), and those glyphs sit on saturated chroma plates where white is theme-independent by design, as `Button .primary` and `AppCard .icon` already do. (2) `.trigCardSelected` was assumed live; it is dead code.
- **The ask/builder boot-time dispatch problem did not exist.** The premise handed to the runner work — that `askRunner`/`host.runner` bound a resolved kind at gateway construction — was false. Construction binds only the loader closure; `prefsLoader()` is invoked per turn inside `run()`. So each runner took a `subsystem` tag instead of being restructured.
- **The per-agent default-model select stays in the inventory, not routing.** An agent needs a default model even when it is not the routing default (Codex serving Builder while Claude Code is default); moving it to routing would leave `model.codex.default` unreachable.
- **Dead classNames were dropped, not given rules.** `git log -S` proves none of the ten rules ever existed. Dropping is a visual no-op — React omits `className={undefined}`, so the current render *is* the no-class render — whereas inventing a rule changes the render. A dead reference is a lie about intent, not a broken pixel.
- **`.tlItemFinal` was rule-less but load-bearing as a test selector**, passing only because `classNameStrategy: 'non-scoped'` resolves a local to its own name regardless of any rule. Replaced with `data-testid`, the hook the conventions prefer.
- **`lint:css` checks referenced-but-undefined only.** The reverse direction is legitimately noisy: descendant-only rules, `[data-*]` hooks and sanctioned `:global` contracts all look unused to a grep.
- **`inlineEmpty` is not `pageEmpty`.** `pageEmpty` is a page-level 64px centred dashed card; these sit inside a bordered panel that already has its own frame and heading. Two jobs, two modules.
- **`appSettings`' divider direction was left inverted vs `drawerGroup`** — one is a section separator, the other a label underline; different jobs, and it has three consumers outside this change set.
- **The alerts diagnosis was partly wrong and not acted on.** A prior analysis claimed the per-row grid made columns misalign; it does not — the timestamps are mono and fixed-format, so those tracks already agree. Subgrid was not reached for.

## Verification

```sh
bun run ci          # format:check + oxlint + turbo lint + typecheck + lint:types + lint:css
bun run typecheck   # 28/28 successful
cd packages/client && bunx vitest run          # 119 files / 901 tests passed
bunx vitest run packages/app-engine/src/stores/prefs-store.test.ts \
                packages/app-engine/src/conversation/runner-core.test.ts \
                packages/gateway/src/serve/build-gateway.test.ts       # 62 passed
node scripts/lint-css-classes.mjs   # ok — 179 module imports across 255 files
bash .governance/run.sh
```

Back-compat is test-enforced rather than asserted: with no `runner.*` keys set, every subsystem resolves to `agent.runner.kind` and an untagged register calls the loader bare — the exact prior behaviour (`prefs-store.test.ts`, `runner-core.test.ts`, `build-gateway.test.ts`). `SettingsProvidersScreen.test.tsx` pins the new capability directly: a lane routed to a non-default agent saves its model against the lane's *resolved* kind (`claude-code`), not the default (`codex`) — writing it against the default would strand the override. `lint:css` was itself verified to fail correctly: its silent-no-op guard trips when it scans zero files, and an injected fake className was caught and the tree restored clean.

## Audit

PASS

- **"What changed" faithfully describes the diff.** Receipt lists 48 modified + 9 added files. Verified against `git diff HEAD --name-only`: all listed paths exist in diff, no omissions, no misrepresentations. `@centraid/blueprints manifest.json` and three generated `.d.ts` files are correctly noted as out-of-scope pre-existing artifacts.

- **Each checklist item is realized in the code.** `resolveSubsystemRunner(prefs, subsystem)` exists at `packages/app-engine/src/stores/prefs-store.ts:105` and is exported. `resolveModel` at `packages/gateway/src/serve/build-gateway.ts:848` resolves the runner **first** via `prefsLoader(subsystem)` at line 852, then uses `runnerPrefs.kind` to scope the model key at line 854 — the core fix. `SettingsProvidersScreen.tsx` is rewritten; exclusive Codex/Claude-Code radio is gone, replaced by routing table. Shared `styles/select.module.css` and `styles/inlineEmpty.module.css` created and adopted. `GatewayScreen.module.css` and `.tsx` fixed with gap + align-items + minmax. `BackupsScreen.tsx/css/test` and `BackupsRoute.tsx` created; backups page id registered in `router.ts`, `Sidebar.tsx`, `App.tsx`, `paletteData.ts`. `scripts/lint-css-classes.mjs` exists, executable, reports "179 module imports across 255 files"; wired into `package.json` ci script at line 30 as `"lint:css"`.

- **Receipt's checklist mirrors the issue's checklist.** Six items, identical wording and state (`[x]` all checked) in both `issue-432-agent-routing-settings-audit.md` and `gh issue view 432`.

## Steering

PASS

- **Every human-steering event is recorded.** Session contains one mid-task correction at 11:30:35.344Z: user answered multi-choice picker questions with "take a step back...rethink the design of the entire page...every subsystem can have it's own agent" and "rethink the entire design as i said before," redirecting the agent's design approach. This is a genuine **correction** — the agent was iterating on a design, and the user redirected it to reconsider the premise. Added to `### Steering` table below.

- **No non-steering message is recorded as steering.** Session's other human turns are: initial screenshot, `/frontend-design` skill invocation (new task request), StorageCard pre-existing bug report (agent-identified, auto-task), "just fix those lint issues and enable bun run lint:css ?" (new task request), `<create-pr-command>` (command). Task-notification blocks are system-generated, not user input. None are mid-task corrections or interrupts.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-511a3fdd-1784201435-1 | 511a3fdd-8184-4c7f-8479-8bc256940da9 | #432 | correction | classifier | take a step back and rethink the design of the entire page — every subsystem can have its own agent | pending | 1 | 2026-07-16T11:30:35.344Z |

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-511a3fdd-818-1784211901-1 | claude-code | 511a3fdd-8184-4c7f-8479-8bc256940da9 | #432 | claude-opus-4-8 | 751 | 3602021 | 103815113 | 462657 | 4065429 | 85.9904 | 751 | 3602021 | 103815113 | 462657 |  |
| claude-code-511a3fdd-818-1784212372-1 | claude-code | 511a3fdd-8184-4c7f-8479-8bc256940da9 | #432 | claude-opus-4-8 | 23 | 35459 | 5323020 | 15982 | 51464 | 3.2828 | 774 | 3637480 | 109138133 | 478639 |  |
| claude-code-511a3fdd-818-1784212431-1 | claude-code | 511a3fdd-8184-4c7f-8479-8bc256940da9 | #432 | claude-opus-4-8 | 2 | 463 | 416130 | 168 | 633 | 0.2152 | 776 | 3637943 | 109554263 | 478807 |  |
| claude-code-511a3fdd-818-1784212687-1 | claude-code | 511a3fdd-8184-4c7f-8479-8bc256940da9 | #432 | claude-opus-4-8 | 64 | 35415 | 14481372 | 25047 | 60526 | 8.0885 | 840 | 3673358 | 124035635 | 503854 |  |
| claude-code-511a3fdd-818-1784212779-1 | claude-code | 511a3fdd-8184-4c7f-8479-8bc256940da9 | #432 | claude-opus-4-8 | 12 | 34824 | 2638047 | 8226 | 43062 | 1.7424 | 852 | 3708182 | 126673682 | 512080 |  |
| claude-code-511a3fdd-818-1784212839-1 | claude-code | 511a3fdd-8184-4c7f-8479-8bc256940da9 | #432 | claude-opus-4-8 | 2 | 5028 | 892422 | 2826 | 7856 | 0.5483 | 854 | 3713210 | 127566104 | 514906 |  |
