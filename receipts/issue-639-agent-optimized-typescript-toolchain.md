# Issue #639 — Agent-optimized TypeScript toolchain

## Checklist

- [x] The ownership table is implemented: Ultracite presets, Oxfmt formatting, Oxlint lint policy, TypeScript compiler diagnostics, Knip hygiene, Vitest/e2e behavior
- [x] `oxlint.config.ts` and `oxfmt.config.ts` are the only root configs for their tools, and every invocation passes `-c` explicitly
- [x] `ultracite`, `oxlint`, `oxlint-tsgolint`, `oxfmt`, `typescript`, `knip`, and `vitest` are exact-pinned
- [x] Ultracite is used through reviewed modular presets plus non-mutating `toolchain:doctor`; routine format/lint scripts invoke Oxfmt/Oxlint directly
- [x] Oxfmt is the sole style owner, import sorting leaves side-effect imports ordered, and every ignore has a concrete ownership reason
- [x] Oxlint denies warnings, errors on unused disable directives, avoids formatter overlap, and uses explicit file/runtime profiles
- [x] Optional JS-plugin presets remain declined as bundles and the rule-adoption rubric is documented
- [x] Normal automation uses only Oxfmt writes and Oxlint safe `--fix`; suggestions/dangerous fixes are absent from scripts, hooks, and CI
- [x] Type-aware linting is either compiler-aligned or constrained by a documented compatibility allowlist; TypeScript remains authoritative
- [x] `no-unnecessary-type-assertion` is enabled only if compiler alignment and clean build/typecheck prove it safe; otherwise it is explicitly disabled
- [x] The four formerly hollow type-aware rules each fire on a live fixture and are enforced in exactly one pass
- [x] A mechanical guard prevents type-aware-only rules from being declared in a pass where they cannot execute
- [x] Source, tests, scripts, e2e, workers, and executable blueprint handlers are linted; only generated/vendor/negative-fixture exclusions remain
- [x] Sequential blueprint pagination has a narrow handler-profile decision without disabling other lint rules
- [x] `format`, `format:check`, `lint`, `lint:fix`, `lint:types`, `typecheck`, `test:affected`, `check:fast`, `check:pr`, `check:full`, and `toolchain:doctor` form a documented stable command API
- [x] Pre-commit and pre-push are deterministic and check-only; local and CI gates call the same scripts
- [x] `AGENTS.md` documents tool ownership and workflow without duplicating the generated rule catalog
- [x] Mechanical formatting, safe lint fixes, and behavioral corrections are isolated in separate commits
- [x] One issue receipt mirrors this checklist and records the chosen type-aware state plus all intentional profile exceptions

## What changed

- Established the command and ownership contract in `package.json`, `docs/toolchain.md`, `AGENTS.md`, `README.md`, `TESTING.md`, `docs/dev-environment.md`, and `docs/coding-standards.md`.
- Migrated the single root configurations to `oxlint.config.ts` and `oxfmt.config.ts`, removed `oxlint.config.mjs`, `oxfmt.config.mjs`, and `packages/blueprints/.oxlintrc.json`, and pinned editor behavior in `.vscode/settings.json` and `.vscode/extensions.json`.
- Made `scripts/lint-staged.sh`, `scripts/lint-types.sh`, `.governance/packs/srikanth235/centraid/directives/format-check/check.sh`, and `.governance/packs/srikanth235/centraid/directives/lint-check/check.sh` name the root configuration explicitly; `.github/workflows/ci.yml` now invokes the same `package.json` lint script as local gates.
- Updated `packages/blueprints/README.md` to point at the root-owned lint profile.
- Added this durable record at `receipts/issue-639-agent-optimized-typescript-toolchain.md`.
- Removed the stale `react/no-array-index-key` suppression from
  `packages/client/src/react/screens/SettingsConnectionsScreen.tsx` in a
  dedicated safe-lint commit before the formatting sweep, because the new
  check-only staged hook correctly rejects unused directives.
- Applied the repository-wide Oxfmt migration as a formatting-only commit,
  including deterministic `@centraid/*` import grouping and alphabetical
  package scripts. Legal header comments keep the existing file-size waivers
  stable in `apps/mobile/src/apps/notes/NotesHome.tsx`,
  `apps/mobile/src/apps/tally/TallyHome.tsx`,
  `apps/mobile/src/apps/tasks/TasksHome.tsx`, and
  `packages/gateway/src/cli/admin.test.ts`.
- Applied Oxlint's safe fixer in a dedicated commit to remove redundant empty
  object fallbacks from nine connector-handler object spreads:
  `packages/blueprints/automations/dropbox-pull/automations/dropbox-pull/handler.js`,
  `packages/blueprints/automations/gitlab-pull/automations/gitlab-pull/handler.js`,
  `packages/blueprints/automations/google-drive-pull/automations/google-drive-pull/handler.js`,
  `packages/blueprints/automations/microsoft-calendar-pull/automations/microsoft-calendar-pull/handler.js`,
  `packages/blueprints/automations/microsoft-contacts-pull/automations/microsoft-contacts-pull/handler.js`,
  `packages/blueprints/automations/microsoft-onedrive-pull/automations/microsoft-onedrive-pull/handler.js`,
  `packages/blueprints/automations/microsoft-outlook-pull/automations/microsoft-outlook-pull/handler.js`,
  `packages/blueprints/automations/slack-pull/automations/slack-pull/handler.js`,
  and
  `packages/blueprints/automations/todoist-pull/automations/todoist-pull/handler.js`.
- Removed stale or partially stale lint directives, without changing runtime
  behavior, from `packages/blueprints/apps/locker/app-root.tsx`,
  `packages/blueprints/apps/docs/app-root.tsx`,
  `packages/app-engine/src/registry/manifest.ts`,
  `packages/client/src/react/screens/PaletteScreen.tsx`,
  `packages/client/src/react/screens/AssistantMessage.tsx`,
  `packages/client/src/react/shell/ErrorBoundary.tsx`,
  `packages/client/src/react/screens/AppSettingsPanel.tsx`,
  `packages/client/src/react/screens/AtlasKindsTab.tsx`,
  `packages/client/src/react/screens/AutomationEditorConnectorsPicker.tsx`,
  and `packages/client/src/react/screens/WhatsNewModal.tsx`.
- Resolved the remaining executable-blueprint correctness findings by naming
  default handlers, retaining positional call contracts while marking one
  unused logger, adding Unicode regex semantics and Gmail address capture
  names, removing an unused Linear kind, and normalizing catch naming in:
  `packages/blueprints/automations/screenshot-extractor/automations/screenshot-extractor/handler.js`,
  `packages/blueprints/automations/release-notes-drafter/automations/release-notes-drafter/handler.js`,
  `packages/blueprints/automations/google-gmail-send/automations/google-gmail-send/handler.js`,
  `packages/blueprints/automations/google-gmail-pull/automations/google-gmail-pull/handler.js`,
  `packages/blueprints/automations/renewal-reminders/automations/renewal-reminders/handler.js`,
  `packages/blueprints/automations/face-proposer/automations/face-proposer/handler.js`,
  `packages/blueprints/automations/google-calendar-invite-send/automations/google-calendar-invite-send/handler.js`,
  `packages/blueprints/automations/linear-pull/automations/linear-pull/handler.js`,
  `packages/blueprints/automations/obligation-extractor/automations/obligation-extractor/handler.js`,
  `packages/blueprints/automations/photo-captioner/automations/photo-captioner/handler.js`,
  `packages/blueprints/automations/trip-albums/automations/trip-albums/handler.js`,
  `packages/blueprints/automations/doc-text-extractor/automations/doc-text-extractor/handler.js`,
  `packages/blueprints/automations/doc-entity-linker/automations/doc-entity-linker/handler.js`,
  `packages/blueprints/automations/notion-pull/automations/notion-pull/handler.js`,
  and
  `packages/blueprints/automations/doc-filer/automations/doc-filer/handler.js`.
- Established the compatibility-state type-aware topology in
  `oxlint.config.ts`, `scripts/lint-types.sh`,
  `scripts/lint-types-rules.mjs`, and `scripts/lint-types-policy.mjs`:
  TypeScript 5.9 stays authoritative, all 59 pinned type-aware-only engine
  rules are mechanically forced off in the ordinary pass, and exactly the
  eight reviewed compatibility rules are enabled once in the dedicated pass.
- Added `scripts/fixtures/lint-types/invalid.ts` and
  `scripts/fixtures/lint-types/tsconfig.json`; the four formerly hollow rules
  must each emit against that live negative fixture. Its root override disables
  only the two ordinary equivalents whose intentional violations would
  otherwise duplicate the type-aware fixture signal.
- Resolved the compatibility allowlist's concrete findings in a separate
  correctness commit: explicit deterministic comparators in
  `packages/agent-runtime/src/matrix-contracts.test.ts`,
  `packages/gateway/src/routes/agents-routes.test.ts`,
  `packages/gateway/src/backup/wal.integration.test.ts`,
  `packages/vault/src/gateway/search.test.ts`,
  `packages/vault/src/wal-shipper-detectors.test.ts`,
  `packages/vault/src/enrich/clusters.test.ts`,
  `apps/desktop/src/main/embedded-gateway-layout.test.ts`,
  `apps/mobile/src/kit/theme/generate.test.ts`, and
  `apps/mobile/src/lib/replica/multi-vault-reader.test.ts`; native `Error`
  rejection and abort normalization in
  `packages/backup/src/interop-clawgnition.test.ts`,
  `packages/cli/src/cli.integration.test.ts`,
  `packages/cli/src/client.test.ts`,
  `packages/client/src/gateway-client-device-work-source.test.ts`,
  `packages/client/src/replica/multi-writer.contract.test.ts`,
  `packages/client/src/replica/coordinator.ts`,
  `packages/gateway/src/serve/power-context.ts`, and
  `packages/gateway/src/backup/backup-conflict-provider.ts`.
- Preserved the leading `@ts-nocheck` contract in
  `packages/blueprints/src/query-handlers.test.ts` with an Oxfmt-stable legal
  header, after the authoritative compiler gate proved that import sorting had
  displaced the original directive.
- Stabilized the destructive-confirmation keyboard contract in
  `apps/desktop/tests/e2e/delete-app.spec.ts` by waiting for the dialog's
  documented delayed focus before sending Enter; the full gate exposed and the
  isolated rerun reproduced the former race.
- Closed the final explicit-invocation audit gaps in
  `apps/web/scripts/build-iroh-wasm.sh`,
  `.governance/packs/srikanth235/centraid/directives/lint-check/directive.yaml`,
  and
  `.governance/packs/srikanth235/centraid/directives/lint-check/constitution.md`:
  generated WASM bindings now use the root Oxfmt config with nested discovery
  disabled, and governance guidance matches the pinned explicit-config,
  deny-warnings Oxlint policy. `ARCHITECTURE.md` now names the root command API
  instead of a discovery-dependent bare invocation.
- Corrected the last stale bare lint instruction in
  `packages/client/src/react/CSS-CONVENTIONS.md`; it now names the root
  `bun run lint` command instead of an obsolete desktop-relative path.

### Acceptance evidence

- The ownership table is implemented: Ultracite presets, Oxfmt formatting, Oxlint lint policy, TypeScript compiler diagnostics, Knip hygiene, Vitest/e2e behavior — `docs/toolchain.md` assigns each concern and the stable commands exercise each owner.
- `oxlint.config.ts` and `oxfmt.config.ts` are the only root configs for their tools, and every invocation passes `-c` explicitly — repository config discovery returns only those files, while root scripts, staged hooks, governance checks, and the type-aware pass name them explicitly and disable nested discovery.
- `ultracite`, `oxlint`, `oxlint-tsgolint`, `oxfmt`, `typescript`, `knip`, and `vitest` are exact-pinned — six are direct exact root pins and TypeScript resolves through the exact `workspaces.catalog.typescript` pin.
- Ultracite is used through reviewed modular presets plus non-mutating `toolchain:doctor`; routine format/lint scripts invoke Oxfmt/Oxlint directly — the root configs import reviewed Ultracite modules, while the command API calls the owner binaries.
- Oxfmt is the sole style owner, import sorting leaves side-effect imports ordered, and every ignore has a concrete ownership reason — `oxfmt.config.ts` owns formatting and import organization, disables side-effect import sorting, and documents each generated/vendor exclusion.
- Oxlint denies warnings, errors on unused disable directives, avoids formatter overlap, and uses explicit file/runtime profiles — `package.json` and `oxlint.config.ts` encode those policies.
- Optional JS-plugin presets remain declined as bundles and the rule-adoption rubric is documented — `docs/toolchain.md` records both the declined bundles and evidence rubric.
- Normal automation uses only Oxfmt writes and Oxlint safe `--fix`; suggestions/dangerous fixes are absent from scripts, hooks, and CI — static search found neither forbidden fix mode in those surfaces.
- Type-aware linting is either compiler-aligned or constrained by a documented compatibility allowlist; TypeScript remains authoritative — `scripts/lint-types.sh` implements the documented eight-rule compatibility state after the compiler gate.
- `no-unnecessary-type-assertion` is enabled only if compiler alignment and clean build/typecheck prove it safe; otherwise it is explicitly disabled — the compatibility policy explicitly verifies the disabled state.
- The four formerly hollow type-aware rules each fire on a live fixture and are enforced in exactly one pass — `scripts/fixtures/lint-types/invalid.ts` and `scripts/lint-types-policy.mjs` require one diagnostic apiece and exactly one registration.
- A mechanical guard prevents type-aware-only rules from being declared in a pass where they cannot execute — `scripts/lint-types-rules.mjs` catalogs all 59 pinned rules and the policy rejects any active ordinary-pass declaration.
- Source, tests, scripts, e2e, workers, and executable blueprint handlers are linted; only generated/vendor/negative-fixture exclusions remain — the root target is the repository, with narrowly documented overrides and ignores.
- Sequential blueprint pagination has a narrow handler-profile decision without disabling other lint rules — the executable-handler override disables only `no-await-in-loop` for dependency-ordered pagination.
- `format`, `format:check`, `lint`, `lint:fix`, `lint:types`, `typecheck`, `test:affected`, `check:fast`, `check:pr`, `check:full`, and `toolchain:doctor` form a documented stable command API — all commands exist in root `package.json` and are documented in `docs/toolchain.md`.
- Pre-commit and pre-push are deterministic and check-only; local and CI gates call the same scripts — hooks use explicit local binaries/configs without mutation, and CI delegates to the root command API.
- `AGENTS.md` documents tool ownership and workflow without duplicating the generated rule catalog — it links to the detailed toolchain contract and states the stable workflow.
- Mechanical formatting, safe lint fixes, and behavioral corrections are isolated in separate commits — the branch history contains dedicated style, safe-fix, suppression, and correctness commits.
- One issue receipt mirrors this checklist and records the chosen type-aware state plus all intentional profile exceptions — this receipt records compatibility state, pagination, visual-fixture, and negative-fixture decisions.

### Formatter sweep paths

- `.design-sync/NOTES.md`
- `.design-sync/conventions.md`
- `.design-sync/desktop.NOTES.md`
- `.design-sync/desktop.conventions.md`
- `.design-sync/ds-src/README.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `SECURITY.md`
- `apps/desktop/package.json`
- `apps/desktop/src/main/embedded-gateway-layout.test.ts`
- `apps/desktop/src/main/gateway-paths.ts`
- `apps/desktop/src/main/gateway-secrets.test.ts`
- `apps/desktop/src/main/gateway-secrets.ts`
- `apps/desktop/src/main/gateway-store.test.ts`
- `apps/desktop/src/main/phone-link.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/tests/e2e-live/README.md`
- `apps/desktop/tests/e2e/COVERAGE_REPORT.md`
- `apps/desktop/tests/e2e/README.md`
- `apps/desktop/tests/e2e/SCENARIOS.md`
- `apps/desktop/tests/e2e/fixtures.ts`
- `apps/extension/package.json`
- `apps/mobile/NATIVE_V0.md`
- `apps/mobile/modules/centraid-tunnel/README.md`
- `apps/mobile/package.json`
- `apps/mobile/src/apps/agenda/AgendaCreateModal.tsx`
- `apps/mobile/src/apps/agenda/AgendaEventEditor.tsx`
- `apps/mobile/src/apps/agenda/useAgenda.ts`
- `apps/mobile/src/apps/docs/DocsHome.tsx`
- `apps/mobile/src/apps/docs/DocsItemActions.tsx`
- `apps/mobile/src/apps/insights/Insights.tsx`
- `apps/mobile/src/apps/notes/NotesHome.tsx`
- `apps/mobile/src/apps/people/PeopleHome.tsx`
- `apps/mobile/src/apps/photos/PhotosSearch.tsx`
- `apps/mobile/src/apps/photos/timeline-engine.ts`
- `apps/mobile/src/apps/tally/TallyHome.tsx`
- `apps/mobile/src/apps/tasks/TasksHome.tsx`
- `apps/mobile/src/kit/components/AppHeader.tsx`
- `apps/mobile/src/kit/components/AppIcon.tsx`
- `apps/mobile/src/kit/components/Button.tsx`
- `apps/mobile/src/kit/components/Icon.tsx`
- `apps/mobile/src/kit/hooks/useReplicaQuery.ts`
- `apps/mobile/src/kit/replica/ReplicaProvider.tsx`
- `apps/mobile/src/kit/theme/index.ts`
- `apps/mobile/src/lib/daily-brief.ts`
- `apps/mobile/src/lib/replica/background-sync.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.test.ts`
- `apps/mobile/src/lib/replica/native-change-feed.ts`
- `apps/mobile/src/lib/replica/native-hash.ts`
- `apps/mobile/src/lib/replica/native-multiplex-change-feed.ts`
- `apps/mobile/src/lib/replica/native-replica-store.test.ts`
- `apps/mobile/src/lib/replica/native-session.test.ts`
- `apps/mobile/src/lib/replica/op-sqlite-driver.ts`
- `apps/mobile/src/lib/replica/sqlite-intent-store.test.ts`
- `apps/mobile/src/lib/upload/crash.test.ts`
- `apps/mobile/src/lib/upload/enqueue.test.ts`
- `apps/mobile/src/lib/upload/store.test.ts`
- `apps/mobile/src/lib/upload/uploader.test.ts`
- `apps/mobile/src/screens/Capture.tsx`
- `apps/mobile/src/screens/Home.tsx`
- `apps/mobile/src/screens/Onboarding.test.tsx`
- `apps/mobile/src/screens/Scan.tsx`
- `apps/mobile/src/screens/home/AttentionLine.tsx`
- `apps/mobile/src/screens/home/GlassDock.tsx`
- `apps/mobile/src/screens/home/SpacesSwitcher.tsx`
- `apps/mobile/src/screens/home/blueprint-search.test.ts`
- `apps/mobile/src/screens/home/catalog.test.ts`
- `apps/mobile/src/screens/settings/SpaceSection.tsx`
- `apps/mobile/store/release-checklist.md`
- `apps/web/iroh-wasm/OFFICIAL-BINDING-EVALUATION.md`
- `apps/web/package.json`
- `docs/client-keying.md`
- `docs/config-ownership.md`
- `docs/cron-timezone.md`
- `docs/decisions.md`
- `docs/enrollment.md`
- `docs/glossary.md`
- `docs/logs.md`
- `docs/mobile-offline.md`
- `docs/multi-agent.md`
- `docs/oauth-assist.md`
- `docs/plans/gateway-low-end-and-rust-plane.md`
- `docs/plans/skills-package-plan.md`
- `docs/plans/test-gap-closure-2026-07.md`
- `docs/plans/test-report-zero-grey-587.md`
- `docs/protocol.md`
- `docs/recovery/backup-restore.md`
- `docs/recovery/oauth-assist.md`
- `docs/recovery/pairing.md`
- `docs/recovery/vault-erase.md`
- `docs/refactors/README.md`
- `docs/refactors/inline-system-apps.md`
- `docs/release.md`
- `docs/release/oauth-assist-google.md`
- `docs/runners.md`
- `docs/traps/wal-checkpoint.md`
- `docs/traps/worktrees.md`
- `packages/agent-runtime/package.json`
- `packages/agent-runtime/src/automation/live-automation-failover.test.ts`
- `packages/agent-runtime/src/automation/run-automation-dispatch.test.ts`
- `packages/agent-runtime/src/backends/acp/backend.attachments.test.ts`
- `packages/agent-runtime/src/backends/acp/backend.model-usage.test.ts`
- `packages/agent-runtime/src/backends/acp/backend.test.ts`
- `packages/agent-runtime/src/backends/acp/backend.vault-tools.test.ts`
- `packages/agent-runtime/src/backends/acp/blueprint-agent-parity.integration.test.ts`
- `packages/agent-runtime/src/backends/acp/capabilities-cache.test.ts`
- `packages/agent-runtime/src/backends/acp/enumerate-models.test.ts`
- `packages/agent-runtime/src/backends/acp/journey.integration.test.ts`
- `packages/agent-runtime/src/backends/acp/launch.test.ts`
- `packages/agent-runtime/src/backends/acp/stream-events.test.ts`
- `packages/agent-runtime/src/backends/acp/turn-vault-tools.test.ts`
- `packages/agent-runtime/src/backends/acp/vault-mcp-server.test.ts`
- `packages/agent-runtime/src/cli/centraid-cli.test.ts`
- `packages/agent-runtime/src/low-priority-properties.test.ts`
- `packages/agent-runtime/src/matrix-contracts.test.ts`
- `packages/agent-runtime/src/models/catalog-warmer.test.ts`
- `packages/agent-runtime/src/models/catalog.test.ts`
- `packages/agent-runtime/src/models/enumerators.test.ts`
- `packages/agent-runtime/src/multimodal.test.ts`
- `packages/agent-runtime/src/preflight.test.ts`
- `packages/agent-runtime/src/registry.test.ts`
- `packages/agent-runtime/src/runtime.invalid-kind.test.ts`
- `packages/app-engine/README.md`
- `packages/app-engine/package.json`
- `packages/app-engine/src/conversation/archive/digest-parity.test.ts`
- `packages/app-engine/src/conversation/history.test.ts`
- `packages/app-engine/src/conversation/hydration.test.ts`
- `packages/app-engine/src/conversation/provider-egress-consent.test.ts`
- `packages/app-engine/src/conversation/rehydrate.test.ts`
- `packages/app-engine/src/conversation/reprice.test.ts`
- `packages/app-engine/src/conversation/store-prune.test.ts`
- `packages/app-engine/src/conversation/store-sql.test.ts`
- `packages/app-engine/src/conversation/trigger-store.test.ts`
- `packages/app-engine/src/data/blob-store.test.ts`
- `packages/app-engine/src/data/log-store.test.ts`
- `packages/app-engine/src/handlers/dispatcher.test.ts`
- `packages/app-engine/src/handlers/handler-pool.test.ts`
- `packages/app-engine/src/handlers/handler-runner.contract.test.ts`
- `packages/app-engine/src/handlers/vault-bridge.test.ts`
- `packages/app-engine/src/http/app-bundle.test.ts`
- `packages/app-engine/src/http/changes-sse.test.ts`
- `packages/app-engine/src/http/http-server.test.ts`
- `packages/app-engine/src/http/query-bundle.test.ts`
- `packages/app-engine/src/http/static-server.test.ts`
- `packages/app-engine/src/http/turn-routes.test.ts`
- `packages/app-engine/src/http/turn-sse-support.test.ts`
- `packages/app-engine/src/http/turn-sse.test.ts`
- `packages/app-engine/src/insights/README.md`
- `packages/app-engine/src/insights/analytics-store.test.ts`
- `packages/app-engine/src/insights/insights-store.test.ts`
- `packages/app-engine/src/pricing/cost-properties.test.ts`
- `packages/app-engine/src/registry/deregister-cleanup.test.ts`
- `packages/app-engine/src/settings/app-settings.test.ts`
- `packages/app-engine/src/stores/gateway-db.test.ts`
- `packages/app-engine/src/stores/prefs-store.test.ts`
- `packages/app-engine/src/worker/runner.test.ts`
- `packages/app-engine/src/worker/ts-loader-hooks.test.ts`
- `packages/automation/README.md`
- `packages/automation/package.json`
- `packages/automation/src/fire/condition.test.ts`
- `packages/automation/src/fire/connector.test.ts`
- `packages/automation/src/fire/cron-cursor.test.ts`
- `packages/automation/src/fire/cursor-engine.test.ts`
- `packages/automation/src/fire/cursor-invariants.test.ts`
- `packages/automation/src/fire/fire-vault.test.ts`
- `packages/automation/src/fire/fire.test.ts`
- `packages/automation/src/fire/scheduler-ledger.contract.test.ts`
- `packages/automation/src/handler/audit.test.ts`
- `packages/automation/src/scaffold/app.test.ts`
- `packages/automation/src/scaffold/scaffold-files.test.ts`
- `packages/automation/src/scaffold/scaffold.test.ts`
- `packages/automation/src/scaffold/webhook.test.ts`
- `packages/automation/src/worker/runner.test.ts`
- `packages/backup/FORMAT.md`
- `packages/backup/PROTOCOL.md`
- `packages/backup/README.md`
- `packages/backup/package.json`
- `packages/backup/src/conformance-derived.test.ts`
- `packages/backup/src/conformance-observability.test.ts`
- `packages/backup/src/crypto-properties.test.ts`
- `packages/backup/src/crypto.test.ts`
- `packages/backup/src/engine.test.ts`
- `packages/backup/src/interop-clawgnition.test.ts`
- `packages/backup/src/local-provider.test.ts`
- `packages/backup/src/manifest.test.ts`
- `packages/backup/src/materialize.test.ts`
- `packages/backup/src/object-store.test.ts`
- `packages/backup/src/recovery-kit.test.ts`
- `packages/backup/src/remote-provider.test.ts`
- `packages/backup/src/wal-address-properties.test.ts`
- `packages/backup/src/wal-format.test.ts`
- `packages/backup/src/wal-restore.test.ts`
- `packages/blob-format/package.json`
- `packages/blob-format/src/cbsf-properties.test.ts`
- `packages/blueprints/package.json`
- `packages/blueprints/src/app-manifests.test.ts`
- `packages/blueprints/src/app-rewrites.test.ts`
- `packages/blueprints/src/clone.test.ts`
- `packages/blueprints/src/query-handlers.test.ts`
- `packages/blueprints/src/update-app-meta.test.ts`
- `packages/blueprints/visual-harness/README.md`
- `packages/cli/package.json`
- `packages/cli/src/cli.integration.test.ts`
- `packages/cli/src/client.test.ts`
- `packages/client/package.json`
- `packages/client/src/react/CSS-CONVENTIONS.md`
- `packages/client/src/react/blueprints/centraid-inline-scopes.test.ts`
- `packages/client/src/react/blueprints/centraid-inline.test.ts`
- `packages/client/src/react/blueprints/inline-blob-images.test.ts`
- `packages/client/src/react/blueprints/inlineQueryCtx.test.ts`
- `packages/client/src/react/blueprints/kit-inline.test.ts`
- `packages/client/src/react/screens/AtlasBrowseTab.test.tsx`
- `packages/client/src/react/screens/AtlasScreen.test.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.tsx`
- `packages/client/src/react/screens/AutomationTemplatesScreen.tsx`
- `packages/client/src/react/screens/AutomationThreadScreen.tsx`
- `packages/client/src/react/screens/AutomationThreadScreenTurnWatch.test.tsx`
- `packages/client/src/react/screens/AutomationsOverviewScreen.tsx`
- `packages/client/src/react/screens/DeviceRow.tsx`
- `packages/client/src/react/screens/DiscoverScreen.tsx`
- `packages/client/src/react/screens/FirstRunGate.test.tsx`
- `packages/client/src/react/screens/HomeScreen.tsx`
- `packages/client/src/react/screens/HouseholdScreen.tsx`
- `packages/client/src/react/screens/OnboardingScreen.test.tsx`
- `packages/client/src/react/screens/RunViewScreen.tsx`
- `packages/client/src/react/screens/SettingsAppearanceScreen.test.tsx`
- `packages/client/src/react/screens/SettingsAppearanceScreen.tsx`
- `packages/client/src/react/screens/SettingsConnectionsScreen.tsx`
- `packages/client/src/react/screens/SettingsSpaceScreen.tsx`
- `packages/client/src/react/shell/IdentityHead.tsx`
- `packages/client/src/react/shell/Sidebar.tsx`
- `packages/client/src/react/shell/routes/AppFrame.tsx`
- `packages/client/src/react/shell/routes/ConnectFlow.test.tsx`
- `packages/client/src/react/shell/routes/ConnectFlow.tsx`
- `packages/client/src/react/shell/routes/InlineAppRoute.test.tsx`
- `packages/client/src/react/shell/routes/InlineAppRoute.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/SpaceModal.tsx`
- `packages/client/src/react/ui/AppCard.test.tsx`
- `packages/client/src/react/ui/AppCard.tsx`
- `packages/client/src/react/ui/Button.tsx`
- `packages/client/src/react/ui/Gallery.tsx`
- `packages/client/src/react/ui/Icon.test.tsx`
- `packages/client/src/react/ui/Icon.tsx`
- `packages/client/src/react/ui/tile-visual.test.ts`
- `packages/client/src/replica/coordinator.test.ts`
- `packages/client/src/replica/intent-idempotency-properties.test.ts`
- `packages/client/src/replica/payload-hash-properties.test.ts`
- `packages/client/src/vault-change-feed.test.ts`
- `packages/design-tokens/package.json`
- `packages/gateway/README.md`
- `packages/gateway/benchmarks/README.md`
- `packages/gateway/package.json`
- `packages/gateway/skills/authoring-centraid-apps/SKILL.md`
- `packages/gateway/skills/automation-authoring/SKILL.md`
- `packages/gateway/src/backup/backup-backend.test.ts`
- `packages/gateway/src/backup/backup-cas-inventory.test.ts`
- `packages/gateway/src/backup/backup-cas-reconciliation.test.ts`
- `packages/gateway/src/backup/backup-provider-observability.test.ts`
- `packages/gateway/src/backup/backup-reconciliation.test.ts`
- `packages/gateway/src/backup/backup-recovery-kit-lifecycle.test.ts`
- `packages/gateway/src/backup/backup-service-restore.test.ts`
- `packages/gateway/src/backup/backup-service.contract.test.ts`
- `packages/gateway/src/backup/backup-sources.test.ts`
- `packages/gateway/src/backup/backup-state.test.ts`
- `packages/gateway/src/backup/backup.integration.test.ts`
- `packages/gateway/src/backup/recover-internals.test.ts`
- `packages/gateway/src/backup/recover-reconcile.test.ts`
- `packages/gateway/src/backup/recover.integration.test.ts`
- `packages/gateway/src/backup/recovery-kit-state.test.ts`
- `packages/gateway/src/backup/restore-lazy.integration.test.ts`
- `packages/gateway/src/backup/restore-verify-sealkey.test.ts`
- `packages/gateway/src/backup/snapshot-blob-roots.test.ts`
- `packages/gateway/src/backup/storage-credentials.test.ts`
- `packages/gateway/src/backup/storage-usage.test.ts`
- `packages/gateway/src/backup/storage.integration.test.ts`
- `packages/gateway/src/backup/wal.integration.test.ts`
- `packages/gateway/src/brief/daily-brief.test.ts`
- `packages/gateway/src/cli/admin-custody.test.ts`
- `packages/gateway/src/cli/admin.test.ts`
- `packages/gateway/src/cli/allowed-hosts-properties.test.ts`
- `packages/gateway/src/cli/backup-admin.test.ts`
- `packages/gateway/src/cli/cli.test.ts`
- `packages/gateway/src/cli/key-admin.test.ts`
- `packages/gateway/src/cli/key-store.test.ts`
- `packages/gateway/src/cli/landlord-auth.test.ts`
- `packages/gateway/src/cli/lock-admin.test.ts`
- `packages/gateway/src/cli/recover-admin.test.ts`
- `packages/gateway/src/cli/service-admin.test.ts`
- `packages/gateway/src/cli/service-credential.test.ts`
- `packages/gateway/src/cli/service-install.integration.test.ts`
- `packages/gateway/src/cli/status-admin.test.ts`
- `packages/gateway/src/cli/vault-admin.test.ts`
- `packages/gateway/src/journal-stores.test.ts`
- `packages/gateway/src/lifecycle/automation-anchor-scopes.test.ts`
- `packages/gateway/src/lifecycle/automation-lifecycle-over-http.test.ts`
- `packages/gateway/src/lifecycle/automation-revision.test.ts`
- `packages/gateway/src/lifecycle/automation-turn-context.test.ts`
- `packages/gateway/src/lifecycle/byte-plane-over-http.test.ts`
- `packages/gateway/src/lifecycle/clone-over-http.test.ts`
- `packages/gateway/src/lifecycle/draft-preview-over-http.test.ts`
- `packages/gateway/src/lifecycle/ext-band-over-http.test.ts`
- `packages/gateway/src/lifecycle/headless-automation-compile.test.ts`
- `packages/gateway/src/lifecycle/install-over-http.test.ts`
- `packages/gateway/src/lifecycle/interactive-automation-turn.test.ts`
- `packages/gateway/src/lifecycle/lifecycle-over-http.test.ts`
- `packages/gateway/src/lifecycle/lifecycle-shared.test.ts`
- `packages/gateway/src/lifecycle/rewrite-automation-instructions.test.ts`
- `packages/gateway/src/lifecycle/webhook-route-over-http.test.ts`
- `packages/gateway/src/preview/codec.ts`
- `packages/gateway/src/preview/native-codec.ts`
- `packages/gateway/src/push/web-push.test.ts`
- `packages/gateway/src/reminders/due-reminders.test.ts`
- `packages/gateway/src/routes/agents-routes.test.ts`
- `packages/gateway/src/routes/apps-store-routes.test.ts`
- `packages/gateway/src/routes/assistant-routes.test.ts`
- `packages/gateway/src/routes/automations-routes.test.ts`
- `packages/gateway/src/routes/backup-observability-routes.test.ts`
- `packages/gateway/src/routes/backup-routes.test.ts`
- `packages/gateway/src/routes/blob-route-errors.test.ts`
- `packages/gateway/src/routes/blob-routes-hardening.test.ts`
- `packages/gateway/src/routes/blob-routes.test.ts`
- `packages/gateway/src/routes/connections-routes.test.ts`
- `packages/gateway/src/routes/demo-routes.test.ts`
- `packages/gateway/src/routes/device-work-routes.test.ts`
- `packages/gateway/src/routes/devices-routes.test-fixtures.ts`
- `packages/gateway/src/routes/devices-routes.test.ts`
- `packages/gateway/src/routes/import-routes.test.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.test.ts`
- `packages/gateway/src/routes/members-routes.test.ts`
- `packages/gateway/src/routes/multiplex-replica-routes.test.ts`
- `packages/gateway/src/routes/placement-routes.test.ts`
- `packages/gateway/src/routes/push-wake-routes.test.ts`
- `packages/gateway/src/routes/replica-intent-attribution.test.ts`
- `packages/gateway/src/routes/replica-intent-route.test.ts`
- `packages/gateway/src/routes/replica-routes.test.ts`
- `packages/gateway/src/routes/replica-shape.test.ts`
- `packages/gateway/src/routes/route-helpers.test.ts`
- `packages/gateway/src/routes/scopes-routes.test.ts`
- `packages/gateway/src/routes/share-routes.test.ts`
- `packages/gateway/src/routes/storage-local-routes.test.ts`
- `packages/gateway/src/routes/storage-routes.test.ts`
- `packages/gateway/src/routes/templates-routes.test.ts`
- `packages/gateway/src/routes/vault-erase.test.ts`
- `packages/gateway/src/routes/vault-routes.atlas.test.ts`
- `packages/gateway/src/routes/vault-routes.browse.test.ts`
- `packages/gateway/src/routes/vault-routes.test.ts`
- `packages/gateway/src/runs/run-event-bus.test.ts`
- `packages/gateway/src/runs/run-events-sse.test.ts`
- `packages/gateway/src/runs/unified-conversation-runner.test.ts`
- `packages/gateway/src/serve/agent-member-cap.test.ts`
- `packages/gateway/src/serve/authz-matrix.smoke.test.ts`
- `packages/gateway/src/serve/build-gateway.test.ts`
- `packages/gateway/src/serve/connection-broker.test.ts`
- `packages/gateway/src/serve/demo-seed.test.ts`
- `packages/gateway/src/serve/device-plane.test.ts`
- `packages/gateway/src/serve/disk-health.test.ts`
- `packages/gateway/src/serve/gateway-db-lock.integration.test.ts`
- `packages/gateway/src/serve/gateway-db.test.ts`
- `packages/gateway/src/serve/gateway-diagnostics.test.ts`
- `packages/gateway/src/serve/gateway-log-store.test.ts`
- `packages/gateway/src/serve/health-registry.test.ts`
- `packages/gateway/src/serve/local-usage.test.ts`
- `packages/gateway/src/serve/outbox-executor.test.ts`
- `packages/gateway/src/serve/pairing-ticket-host-custody.test.ts`
- `packages/gateway/src/serve/pricing-warmer.test.ts`
- `packages/gateway/src/serve/revocation-severs-planes.test.ts`
- `packages/gateway/src/serve/scheduler-health.test.ts`
- `packages/gateway/src/serve/secret-log.smoke.test.ts`
- `packages/gateway/src/serve/serve-git-store.test.ts`
- `packages/gateway/src/serve/serve-multiclient.test.ts`
- `packages/gateway/src/serve/serve-scheduler-reconcile.test.ts`
- `packages/gateway/src/serve/serve-vault-addressing.test.ts`
- `packages/gateway/src/serve/serve.test.ts`
- `packages/gateway/src/serve/storage-latency.test.ts`
- `packages/gateway/src/serve/storage-limits.test.ts`
- `packages/gateway/src/serve/storage-quota-health.test.ts`
- `packages/gateway/src/serve/trigger-ingress-cursor.test.ts`
- `packages/gateway/src/serve/vault-plane-blob-sweep.test.ts`
- `packages/gateway/src/serve/vault-plane-conversation-archival.test.ts`
- `packages/gateway/src/serve/vault-plane.test.ts`
- `packages/gateway/src/serve/vault-quarantine.test.ts`
- `packages/gateway/src/serve/vault-registry.test.ts`
- `packages/gateway/src/serve/web-app-sessions.contract.test.ts`
- `packages/gateway/src/serve/web-session-store.test.ts`
- `packages/gateway/src/serve/web-ui-server.test.ts`
- `packages/gateway/src/validate-automation-handler.test.ts`
- `packages/gateway/src/validate-manifest.test.ts`
- `packages/gateway/src/worktree-store/remote.test.ts`
- `packages/gateway/src/worktree-store/worktree-store.test.ts`
- `packages/protocol/package.json`
- `packages/protocol/src/handshake-properties.test.ts`
- `packages/test-kit/package.json`
- `packages/time-engine/README.md`
- `packages/time-engine/package.json`
- `packages/tunnel/README.md`
- `packages/tunnel/data-plane/README.md`
- `packages/tunnel/package.json`
- `packages/tunnel/src/native-fallback.test.ts`
- `packages/tunnel/src/native-relay.test.ts`
- `packages/tunnel/src/tunnel.integration.test.ts`
- `packages/tunnel/src/wire-properties.test.ts`
- `packages/vault/README.md`
- `packages/vault/package.json`
- `packages/vault/src/blob/blob.test.ts`
- `packages/vault/src/blob/custody-properties.test.ts`
- `packages/vault/src/blob/custody-remote-stream.test.ts`
- `packages/vault/src/blob/direct-cold-doors.test.ts`
- `packages/vault/src/blob/direct-cold-originals.test.ts`
- `packages/vault/src/blob/disk-full.integration.test.ts`
- `packages/vault/src/blob/enospc-custody.integration.test.ts`
- `packages/vault/src/blob/outbox-drain.test.ts`
- `packages/vault/src/blob/stream-ingress.test.ts`
- `packages/vault/src/blob/transfers.test.ts`
- `packages/vault/src/db.test.ts`
- `packages/vault/src/errors.test.ts`
- `packages/vault/src/gateway/acting-member.test.ts`
- `packages/vault/src/gateway/custody.test.ts`
- `packages/vault/src/gateway/duties.test.ts`
- `packages/vault/src/gateway/json-schema-properties.test.ts`
- `packages/vault/src/gateway/seal-custody.test.ts`
- `packages/vault/src/gateway/sql.test.ts`
- `packages/vault/src/host.test.ts`
- `packages/vault/src/replica/invocation-commits.test.ts`
- `packages/vault/src/schema/migrate.test.ts`
- `packages/vault/src/share/placement-fixture.ts`
- `packages/vault/src/share/placement-lifecycle.test.ts`
- `packages/vault/src/share/placement.test.ts`
- `packages/vault/src/wal-shipper-clone.test.ts`
- `packages/vault/src/wal-shipper-detectors.test.ts`
- `packages/vault/src/wal-shipper.test.ts`
- `scripts/docs-site/README.md`
- `scripts/perf/README.md`
- `tests/agent-e2e-mobile/AGENTS.md`
- `tests/agent-e2e-mobile/README.md`
- `tests/agent-e2e-mobile/flows/home-loads.md`
- `tests/agent-e2e-mobile/flows/native-v0-resilience.md`
- `tests/agent-e2e-mobile/flows/template-gate.md`
- `tests/agent-e2e-pairing/AGENTS.md`
- `tests/agent-e2e-pairing/README.md`
- `tests/agent-e2e-pairing/flows/cross-network-relay.md`
- `tests/agent-e2e-pairing/flows/device-pairing-lifecycle.md`
- `tests/agent-e2e-pairing/flows/pairing-ticket-hygiene.md`
- `tests/helpers/factories.ts`
- `tests/onboarding-scenarios.md`
- `tests/perf/agent-turn.perf.test.ts`
- `tests/perf/app-engine-handler.perf.test.ts`
- `tests/perf/automation-fire.perf.test.ts`
- `tests/perf/backup-throughput.perf.test.ts`
- `tests/perf/blob-egress.perf.test.ts`
- `tests/perf/desktop-cold.perf.test.ts`
- `tests/perf/gateway-request.perf.test.ts`
- `tests/perf/pwa-waterfall.perf.test.ts`
- `tests/perf/replica-sync-io.perf.test.ts`
- `tests/perf/tunnel-native.perf.test.ts`
- `tests/perf/tunnel-throughput.perf.test.ts`
- `tests/perf/vault-write.perf.test.ts`
- `tests/scale/agent-sessions.scale.test.ts`
- `tests/scale/automations-fire.scale.test.ts`
- `tests/scale/backup-restore.scale.test.ts`
- `tests/scale/blob-gc.scale.test.ts`
- `tests/scale/blueprint-clones.scale.test.ts`
- `tests/scale/conversation-ledger.scale.test.ts`
- `tests/scale/desktop-windows.scale.test.ts`
- `tests/scale/gateway-sessions.scale.test.ts`
- `tests/scale/large-vault.scale.test.ts`
- `tests/scale/ontology.scale.test.ts`
- `tests/scale/replica-bootstrap.scale.test.ts`
- `tests/scale/tunnel-pairs.scale.test.ts`
- `tests/scale/web-tabs.scale.test.ts`

## Out of scope

- Optional GitHub, Sonar, and react-doctor JavaScript-plugin presets.
- Oxlint `--type-check` and replacement of TypeScript compiler diagnostics.
- Unrelated product refactors.

## Decisions

- Chose the compatibility state: TypeScript 5.9.3 remains authoritative and type-aware linting is restricted to a proven allowlist.
- Blueprint connector pagination keeps a narrow `no-await-in-loop` exception because each page token depends on the prior response.
- The visual-harness mock retains a fixture-specific legacy-JavaScript profile; it is linted for runtime correctness without a risky style rewrite of fixture data.
- Removed one already-stale lint suppression before the formatter sweep so the
  change could remain isolated while satisfying the newly strict staged gate.

## Verification

```sh
bun install --frozen-lockfile
bun run toolchain:doctor
bun run format:check
bun run lint
bun run lint:types
bun run typecheck
bun run test:affected
bun run knip
bun run check:fast
bun run check:pr
bun run check:full
```

Results:

- PASS — frozen install, toolchain doctor, formatting, ordinary lint, the 19-workspace type-aware pass and its four live fixtures, TypeScript, Knip, affected tests, and the fast/PR gates.
- PASS — `bun run check:pr`: 689 test files passed, one skipped; 5,515 tests passed and seven skipped, with the approved diff-coverage deviation unchanged.
- PASS — the full-gate coverage segment: 811 files passed and four skipped; 6,805 tests passed and 36 skipped; every measured mutation floor and every low-end performance budget passed.
- PASS after correction — the first `bun run check:full` exposed the desktop destructive-confirmation focus race. The isolated regression passed, then the complete desktop suite passed (54 passed, four skipped) and the web suite passed (14 passed).
- PASS — config discovery found only `oxlint.config.ts` and `oxfmt.config.ts`; static search found no `--fix-suggestions` or `--fix-dangerously`; all seven requested tools resolve to exact pins.
- PASS — the formatter commit was rewritten before publication so the legal-header `@ts-nocheck` preservation ships inside the mechanical migration itself; the later correctness commit now contains only comparator/type corrections.

## Audit

PASS — fresh-context audit confirmed all 19 acceptance criteria, the exact
19/19 checklist mirror, complete 539/539 non-exempt changed-path coverage, and
fresh formatting, ordinary lint, and type-aware lint gates.

## Steering

PASS — fresh-context audit found no interrupt or correction after the initial task instruction.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fb2ae-33d-1785410230-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 260545 | 0 | 10923264 | 23528 | 284073 | 3.7351 | 260545 | 0 | 10923264 | 23528 | build(toolchain): establish agent command contract (#639) -m governance: allow-t |
| codex-019fb2ae-33d-1785410282-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 3318 | 0 | 849920 | 488 | 3806 | 0.2281 | 263863 | 0 | 11773184 | 24016 | build(toolchain): establish agent command contract (#639) -m governance: allow-t |
| codex-019fb2ae-33d-1785410329-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 4054 | 0 | 643328 | 487 | 4541 | 0.1783 | 267917 | 0 | 12416512 | 24503 | build(toolchain): establish agent command contract (#639) -m governance: allow-t |
| codex-019fb2ae-33d-1785410642-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 15914 | 0 | 3290368 | 3162 | 19076 | 0.9098 | 283831 | 0 | 15706880 | 27665 | build(toolchain): establish agent command contract (#639) -m governance: allow-t |
| codex-019fb2ae-33d-1785411162-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 37575 | 0 | 4226304 | 6155 | 43730 | 1.2428 | 321406 | 0 | 19933184 | 33820 | chore(lint): remove stale suppression (#639) |
| codex-019fb2ae-33d-1785411328-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 9221 | 0 | 394752 | 1161 | 10382 | 0.1392 | 330627 | 0 | 20327936 | 34981 | style: apply repository oxfmt migration (#639) -m governance: allow-toolchain-co |
| codex-019fb2ae-33d-1785411474-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 9079 | 0 | 260608 | 884 | 9963 | 0.1011 | 339706 | 0 | 20588544 | 35865 | style: apply repository oxfmt migration (#639) -m governance: allow-toolchain-co |
| codex-019fb2ae-33d-1785411683-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 16771 | 0 | 651008 | 1498 | 18269 | 0.2271 | 356477 | 0 | 21239552 | 37363 | chore(lint): apply safe connector fixes (#639) |
| codex-019fb2ae-33d-1785411767-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 5054 | 0 | 223232 | 570 | 5624 | 0.0770 | 361531 | 0 | 21462784 | 37933 | chore(lint): apply safe connector fixes (#639) |
| codex-019fb2ae-33d-1785411915-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 11061 | 0 | 474112 | 2286 | 13347 | 0.1805 | 372592 | 0 | 21936896 | 40219 | chore(lint): remove stale suppressions (#639) |
| codex-019fb2ae-33d-1785412101-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 26182 | 0 | 864000 | 3728 | 29910 | 0.3374 | 398774 | 0 | 22800896 | 43947 | fix(blueprints): satisfy executable handler lint (#639) |
| codex-019fb2ae-33d-1785412814-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 99172 | 0 | 6229760 | 20535 | 119707 | 2.1134 | 497946 | 0 | 29030656 | 64482 | build(lint): enforce type-aware compatibility policy (#639) -m governance: allow |
| codex-019fb2ae-33d-1785412888-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 3810 | 0 | 573440 | 697 | 4507 | 0.1633 | 501756 | 0 | 29604096 | 65179 | fix(lint): satisfy type-aware compatibility rules (#639) |
| codex-019fb2ae-33d-1785413333-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 53497 | 0 | 3828736 | 4973 | 58470 | 1.1655 | 555253 | 0 | 33432832 | 70152 | fix(toolchain): preserve compiler fixture contract (#639) |
| codex-019fb2ae-33d-1785415280-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 268884 | 0 | 9742592 | 5758 | 274642 | 3.1942 | 824137 | 0 | 43175424 | 75910 | test(desktop): stabilize delete confirmation focus (#639) |
| codex-019fb2ae-33d-1785415351-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 5591 | 0 | 980736 | 688 | 6279 | 0.2695 | 829728 | 0 | 44156160 | 76598 | test(desktop): stabilize delete confirmation focus (#639) |
| codex-019fb2ae-33d-1785417546-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 237851 | 0 | 16182784 | 22828 | 260679 | 4.9827 | 1067579 | 0 | 60338944 | 99426 | build(toolchain): close explicit invocation audit (#639) -m governance: allow-to |
