# issue-814 — Settings from the member's seat

GitHub issue: [#814](https://github.com/srikanth235/centraid/issues/814)

Single newly-added receipt for PR #815. #807 shipped the enrichment policy
model and its Settings page; reading that page back from a member's seat found
it was the schema wearing a UI. This change set also carries the #707 binding
layer v11 integration (Notifications, Vault, Settings chrome) that landed on
the same PR. One issue, one receipt — the duplicate
`receipts/issue-707-binding-layer-v11.md` is deleted.

## Checklist

Issue #814 has no GitHub checkbox list. These items are the Decision/Scope of
`gh issue view 814`, checked because the diff realizes them.

- [x] Enrichment page reshaped to one row per capability
- [x] Refusal made visible where a ceiling stops a capability
- [x] Engine picker limited to the delegate-capable capabilities
- [x] Scoped-rule authoring form replaced by a read-only exceptions list
- [x] Profile and Appearance merged into one page, You
- [x] This device page retired, offline copy relocated to Vault
- [x] Auto-save on You and Vault, Save buttons dropped
- [x] Settings nav icons de-duplicated
- [x] Quick capture retired from the web and desktop seats
- [x] Docs that named the retired surfaces updated

## What changed

### Enrichment page reshaped to one row per capability

`packages/client/src/react/screens/SettingsEnrichmentScreen.tsx` was four groups
named after four stores — domain tiers, engine profiles, scoped rules, egress
answers. It is now one group per domain: the domain's ceiling ("How far your
photos may go") immediately above the list of what that ceiling governs.
`packages/client/src/react/screens/SettingsEnrichmentCapabilities.tsx` (new) is
the row list. `packages/client/src/enrich-policy.ts` gained
`ENRICH_CAPABILITY_BLURBS`, `ENRICH_CAPABILITY_NOTES`, and `capabilityLabel`.
`packages/client/src/react/shell/routes/settingsEnrichmentData.ts` reads
`getEffectiveEnrichPolicy` per capability. CSS lives in
`packages/client/src/react/screens/SettingsEnrichmentScreen.module.css`.

### Refusal made visible where a ceiling stops a capability

`refusalNote` in SettingsEnrichmentCapabilities states it at the row.
`enrich-policy.ts` carries `egressWithinCeiling` and `EGRESS_RANK` as a DISPLAY
mirror of the gateway's gate.

### Engine picker limited to the delegate-capable capabilities

Only `ocr` and `doc-text` ship a delegate variant. The other seven render
"Built in"; faces carries its reassurance.
`packages/client/src/react/screens/SettingsEnrichmentProfiles.tsx` is deleted.

### Scoped-rule authoring form replaced by a read-only exceptions list

`packages/client/src/react/screens/SettingsEnrichmentRules.tsx` keeps the list
and Remove; the free-text authoring half is gone.

### Profile and Appearance merged into one page, You

`packages/client/src/react/shell/routes/SettingsRoute.tsx` renders
`SettingsProfileScreen` and `SettingsAppearanceScreen` on one page labelled
**You**, keeping the `appearance` id. Appearance lost its card-surface picker
(`packages/client/src/react/screens/SettingsAppearanceScreen.tsx`,
`packages/client/src/react/screens/SettingsAppearanceScreen.test.tsx`,
`packages/client/src/react/screen-contracts.ts`). Cron timezone is gated on
automations (`settingsCronTimezoneData.ts`, `settingsCronTimezoneData.test.ts`).

### This device page retired, offline copy relocated to Vault

`SettingsDeviceScreen.tsx` / `.test.tsx` deleted; module CSS renamed to
`SettingsVaultScreen.module.css`. Offline copy sits in
`SettingsVaultScreen.tsx` under **On this device**.
`settingsAccountData.ts` / `.test.ts` and `SettingsRoute.test.ts` follow.

### Auto-save on You and Vault, Save buttons dropped

Profile and Vault write on pick / blur / Enter. The Auto-saved badge is only
for pages in `AUTO_SAVE`.

### Settings nav icons de-duplicated

Sparkle stays with Enrichment; Agents takes Cpu; Vault takes Database. Nav
rows now carry a subtitle (`SettingsRoute.module.css`).

### Quick capture retired from the web and desktop seats

Deleted: `CaptureOverlay.tsx`, `CaptureOverlay.module.css`,
`CaptureScanPanel.tsx`, `gateway-client-capture.ts`,
`gateway-client-capture.contract.test.ts`. `App.tsx` drops the launcher, `C`
shortcut, `?capture=` branch, and `centraid:open-capture`.
`gateway-client.ts` and `gateway-client-seam-fixtures.ts` drop the re-export /
routes. `apps/web/public/manifest.webmanifest` drops the share target and
shortcut; `apps/web/tests/e2e/web-pwa.spec.ts` asserts their absence.
`packages/client/src/capture.ts` keeps mobile helpers.

### Docs that named the retired surfaces updated

`docs/design-divergences.md`, `QUALITY.md`, `docs/dev-environment.md`,
`docs/blueprint-seats.md`, `docs/decisions.md`, `docs/harnesses.md`,
`packages/client/src/react/boot.tsx`,
`packages/client/src/react/screens/OnboardingScreen.tsx`,
`apps/desktop/tests/e2e/onboarding-home.spec.ts`,
`packages/client/src/shell-var-resolution.test.ts`.

### Binding layer v11 (this PR also closes the #707 surface work)

Shared blocks: `packages/design/src/blocks/contracts.ts`,
`packages/design/src/blocks/fixtures.ts`, `packages/design/src/blocks/index.ts`,
`packages/client/src/react/ui/SectionBlock.tsx` (+ `.module.css`, `.test.tsx`)
Show/Hide, `packages/client/src/react/ui/RowsBlock.tsx` (+ `.module.css`,
`.test.tsx`) struck rows and stacked groups, `packages/client/src/react/ui/Button.tsx`,
`packages/client/src/react/ui/blockParity.test.tsx`,
`apps/mobile/src/kit/components/RowsBlock.tsx`,
`apps/mobile/src/kit/components/RowsBlock.styles.ts`,
`apps/mobile/src/kit/components/blockParity.test.tsx`,
`packages/client/src/react/styles/drawerGroup.module.css`.

Notifications: `packages/client/src/react/ui/DecideBlock.tsx` (+ `.module.css`,
`.test.tsx`), `packages/client/src/react/screens/ApprovalsScreen.tsx` (+
`.module.css`, `.test.tsx`), `packages/client/src/react/shell/routes/ApprovalsRoute.tsx`,
`packages/client/src/react/shell/routes/ApprovalsRoute.test.tsx`,
`packages/client/src/react/shell/routes/ApprovalsRoute.held.test.tsx` (split so
the suite stays under the 625-line cap),
`packages/client/src/react/shell/routes/approvalsData.ts` (DTO builders),
`packages/client/src/react/shell/routes/approvalsPhrasing.ts` (how Notifications
says things — split from approvalsData for the same cap),
`packages/client/src/approvals-copy.ts`,
`packages/client/src/react/screens/privacyStores.ts`.

Vault: `packages/client/src/react/shell/routes/VaultRoute.tsx` (+ `.module.css`)
is one custody surface for atlas + household. `AtlasRoute.tsx`,
`AtlasScreen.tsx` (+ `.test.tsx`), `AtlasKindsSection.tsx`,
`AtlasMeterRows.tsx` (+ `.module.css`), `atlasScreenModel.ts` (+ `.test.ts`),
`HouseholdRoute.tsx`, `HouseholdScreen.tsx` (+ `.module.css`, `.test.tsx`),
`DeviceRow.tsx`, `VaultReachSection.tsx` (+ `.test.tsx`),
`vault-custody.ts` (+ `.test.ts`), `vault-sections.ts` (+ `.test.ts`),
`packages/client/src/data-copy.ts`, `packages/client/src/devices-copy.ts`.
`launcherModel.ts` (+ `.test.ts`) labels both atlas and household **Vault**,
retires the Household destination, and routes household pins to atlas.
`opsBar.ts` / `opsBar.test.ts`, `Stem.test.tsx`.

Settings v11 chrome: ceiling control removed (`settingsEnrichmentData.test.ts`),
reasoning bound to the model (`SettingsHarnessesScreen.tsx`,
`SettingsHarnessesScreen.test.tsx`, `SettingsHarnessesScreen.module.css`,
`SettingsHarnessesSelects.tsx`, `SettingsHarnessLanes.tsx`,
`settingsHarnessesData.ts`), pref writes surface the gateway's own text.

### Desktop e2e + lint CI (PR #815)

`apps/desktop/tests/e2e/fixtures.ts` aliases Household/Devices to **Vault**.
`apps/desktop/tests/e2e/household.spec.ts` 2.12/2.13 assert the merged Vault
surface (title Vault, custody line, Where it lives).
`apps/desktop/tests/e2e/settings-enrichment.spec.ts` 12.9 matches Enrichment
nav by `/Enrichment/` because the row's accessible name is now
"Enrichment What is read, and where".
`apps/desktop/tests/e2e/settings-gateways.spec.ts` 12.5 persists Appearance
Light across reload — Cards was removed from You.
`packages/client/src/react/shell/routes/AssistantRoute.tsx` fire-and-forgets
`setSubsystemModel` / `setSubsystemConfigPin` with `void`.
`tests/hygiene-budgets.json` ratchet, `packages/client/src/react/screens/settings-controls.tsx`.

### Files (every ACMR path vs origin/main, compact)

QUALITY.md, apps/desktop/tests/e2e/fixtures.ts,
apps/desktop/tests/e2e/household.spec.ts,
apps/desktop/tests/e2e/onboarding-home.spec.ts,
apps/desktop/tests/e2e/settings-enrichment.spec.ts,
apps/desktop/tests/e2e/settings-gateways.spec.ts,
apps/mobile/src/kit/components/RowsBlock.styles.ts,
apps/mobile/src/kit/components/RowsBlock.tsx,
apps/mobile/src/kit/components/blockParity.test.tsx,
apps/web/public/manifest.webmanifest, apps/web/tests/e2e/web-pwa.spec.ts,
docs/blueprint-seats.md, docs/decisions.md, docs/design-divergences.md,
docs/dev-environment.md, docs/harnesses.md,
packages/client/src/approvals-copy.ts, packages/client/src/capture.ts,
packages/client/src/data-copy.ts, packages/client/src/devices-copy.ts,
packages/client/src/enrich-policy.ts,
packages/client/src/gateway-client-seam-fixtures.ts,
packages/client/src/gateway-client.ts, packages/client/src/react/boot.tsx,
packages/client/src/react/screen-contracts.ts,
packages/client/src/react/screens/ApprovalsScreen.module.css,
packages/client/src/react/screens/ApprovalsScreen.test.tsx,
packages/client/src/react/screens/ApprovalsScreen.tsx,
packages/client/src/react/screens/AtlasKindsSection.tsx,
packages/client/src/react/screens/AtlasMeterRows.module.css,
packages/client/src/react/screens/AtlasMeterRows.tsx,
packages/client/src/react/screens/AtlasScreen.test.tsx,
packages/client/src/react/screens/AtlasScreen.tsx,
packages/client/src/react/screens/atlasScreenModel.test.ts,
packages/client/src/react/screens/atlasScreenModel.ts,
packages/client/src/react/screens/DeviceRow.tsx,
packages/client/src/react/screens/HouseholdScreen.module.css,
packages/client/src/react/screens/HouseholdScreen.test.tsx,
packages/client/src/react/screens/HouseholdScreen.tsx,
packages/client/src/react/screens/OnboardingScreen.tsx,
packages/client/src/react/screens/privacyStores.ts,
packages/client/src/react/screens/settings-controls.tsx,
packages/client/src/react/screens/SettingsAppearanceScreen.test.tsx,
packages/client/src/react/screens/SettingsAppearanceScreen.tsx,
packages/client/src/react/screens/SettingsEnrichmentCapabilities.tsx,
packages/client/src/react/screens/SettingsEnrichmentRules.tsx,
packages/client/src/react/screens/SettingsEnrichmentScreen.module.css,
packages/client/src/react/screens/SettingsEnrichmentScreen.test.tsx,
packages/client/src/react/screens/SettingsEnrichmentScreen.tsx,
packages/client/src/react/screens/SettingsHarnessesScreen.module.css,
packages/client/src/react/screens/SettingsHarnessesScreen.test.tsx,
packages/client/src/react/screens/SettingsHarnessesScreen.tsx,
packages/client/src/react/screens/SettingsHarnessesSelects.tsx,
packages/client/src/react/screens/SettingsHarnessLanes.tsx,
packages/client/src/react/screens/SettingsProfileScreen.tsx,
packages/client/src/react/screens/SettingsVaultScreen.module.css,
packages/client/src/react/screens/SettingsVaultScreen.test.tsx,
packages/client/src/react/screens/SettingsVaultScreen.tsx,
packages/client/src/react/screens/vault-custody.test.ts,
packages/client/src/react/screens/vault-custody.ts,
packages/client/src/react/screens/vault-sections.test.ts,
packages/client/src/react/screens/vault-sections.ts,
packages/client/src/react/screens/VaultReachSection.test.tsx,
packages/client/src/react/screens/VaultReachSection.tsx,
packages/client/src/react/shell/App.tsx,
packages/client/src/react/shell/launcherModel.test.ts,
packages/client/src/react/shell/launcherModel.ts,
packages/client/src/react/shell/opsBar.test.ts,
packages/client/src/react/shell/opsBar.ts,
packages/client/src/react/shell/routes/ApprovalsRoute.held.test.tsx,
packages/client/src/react/shell/routes/ApprovalsRoute.test.tsx,
packages/client/src/react/shell/routes/ApprovalsRoute.tsx,
packages/client/src/react/shell/routes/approvalsData.ts,
packages/client/src/react/shell/routes/approvalsPhrasing.ts,
packages/client/src/react/shell/routes/AssistantRoute.tsx,
packages/client/src/react/shell/routes/AtlasRoute.tsx,
packages/client/src/react/shell/routes/HouseholdRoute.tsx,
packages/client/src/react/shell/routes/settingsAccountData.test.ts,
packages/client/src/react/shell/routes/settingsAccountData.ts,
packages/client/src/react/shell/routes/settingsCronTimezoneData.test.ts,
packages/client/src/react/shell/routes/settingsCronTimezoneData.ts,
packages/client/src/react/shell/routes/settingsEnrichmentData.test.ts,
packages/client/src/react/shell/routes/settingsEnrichmentData.ts,
packages/client/src/react/shell/routes/settingsHarnessesData.ts,
packages/client/src/react/shell/routes/SettingsRoute.module.css,
packages/client/src/react/shell/routes/SettingsRoute.test.ts,
packages/client/src/react/shell/routes/SettingsRoute.tsx,
packages/client/src/react/shell/routes/VaultRoute.module.css,
packages/client/src/react/shell/routes/VaultRoute.tsx,
packages/client/src/react/shell/Stem.test.tsx,
packages/client/src/react/styles/drawerGroup.module.css,
packages/client/src/react/ui/blockParity.test.tsx,
packages/client/src/react/ui/Button.tsx,
packages/client/src/react/ui/DecideBlock.module.css,
packages/client/src/react/ui/DecideBlock.test.tsx,
packages/client/src/react/ui/DecideBlock.tsx,
packages/client/src/react/ui/RowsBlock.module.css,
packages/client/src/react/ui/RowsBlock.test.tsx,
packages/client/src/react/ui/RowsBlock.tsx,
packages/client/src/react/ui/SectionBlock.module.css,
packages/client/src/react/ui/SectionBlock.test.tsx,
packages/client/src/react/ui/SectionBlock.tsx,
packages/client/src/shell-var-resolution.test.ts,
packages/design/src/blocks/contracts.ts,
packages/design/src/blocks/fixtures.ts,
packages/design/src/blocks/index.ts,
tests/hygiene-budgets.json.

## Decisions

- **Egress is stated, never set.** A control letting a member call a provider
  engine "on-device" would be a lie the runtime would then honour.
- **No second fold of the policy cascade.** The screen asks the gateway's one
  resolver once per capability.
- **The refusal is measured against the enricher's declared lane.**
- **Model and effort pins are not offered on Enrichment.** Settings → Agents
  is where a harness's model is chosen.
- **No profile deletion.** Derived ids bound the set.
- **Exceptions are shown, not authored.** Left as a `TODO(#814)`.
- **Household stays retired.** Desktop e2e 2.12/2.13 follow Vault rather than
  restoring a Copies/Household launcher entry.
- **Cards stays without a control.** 12.5 persists theme Light across reload.
- **One receipt for the combined PR.** v11 audit is here, not a second #707 file.

## User impact

First-run: Settings → Enrichment now lists what Centraid reads for you one
capability at a time — a plain name, a line of what it gets you, a switch, and
where that work goes — under each domain's ceiling. Settings → You merges
Profile and Appearance; This device is gone; quick capture is gone from
desktop and web. Notifications is a card surface with a held tray. Vault is
one page: What it holds, Who can reach it, Where it lives.

Evidence: `artifacts/e2e/ui-impact/issue-814-enrichment-capabilities.png`,
emitted by `apps/desktop/tests/e2e/settings-enrichment.spec.ts` (§12.9).

## Out of scope

- The enrichment policy model itself — the four stores, the resolver, and the
  runtime gate stay as #807 shipped them.
- Offering an enrichment exception in situ on an album or collection.
- Mobile capture (`apps/mobile` Capture and Scan) and the server-side capture
  routes; only the web/desktop client surface retires.
- SharingCard regrouping into Gateways / Edges / Commons (declared follow-on
  on the #707 receipt).
- Unifying the `atlas`/`household` pin keys (a pin-set migration).
- Per-model reasoning-level metadata on the wire.

## Verification

```sh
bash .governance/run.sh
bun run lint:types
bun run --cwd packages/client test -- src/react/shell/routes/ApprovalsRoute.test.tsx src/react/shell/routes/ApprovalsRoute.held.test.tsx src/react/screens/SettingsAppearanceScreen.test.tsx src/react/screens/HouseholdScreen.test.tsx src/react/shell/launcherModel.test.ts
```

Targeted client tests after the splits: ApprovalsRoute 6 + held 3 +
ApprovalsScreen 49 + approvalsData 29 + Appearance 8 + Household 19 +
launcherModel 18 — 132 passed.

`SettingsEnrichmentScreen.test.tsx` pins the capability row, refusal note,
faces reassurance, and no second fold. Desktop e2e 12.9 photographs
`artifacts/e2e/ui-impact/issue-814-enrichment-capabilities.png`.

## Audit

Fresh worktree agent (CI-fix pass on PR #815), handed `git diff origin/main`,
this receipt, and `gh issue view 814`. Default REFUTED if uncertain.

1. **What changed vs diff — PASS.** The Files list was built from
   `git diff --name-only origin/main` (ACMR) after the splits. Every
   remaining path appears as a substring above. Deletions (Capture*,
   SettingsDeviceScreen*, SettingsEnrichmentProfiles, gateway-client-capture,
   the extra 707 receipt) are narrated in What changed and are exempt from
   file coverage (diff-filter ACMR).
2. **Each [x] realized in the diff — PASS.**
   - One row per capability: SettingsEnrichmentCapabilities + Screen rewrite.
   - Refusal visible: `refusalNote` + SettingsEnrichmentScreen.test.tsx.
   - Engine picker gated on `delegateCapable`; Profiles form deleted.
   - Rules file is a read-only exceptions list.
   - SettingsRoute You page keeps `appearance` id.
   - Device page gone; offline copy on SettingsVaultScreen.
   - AUTO_SAVE, no Save buttons on You/Vault.
   - Cpu/Database/Sparkle split in SettingsRoute.
   - Capture overlay/scan/manifest share target removed.
   - Docs (design-divergences, QUALITY, dev-environment, onboarding) updated.
3. **Checklist mirrors the issue — REFUTED.** `gh issue view 814` has no
   `- [ ]` / `- [x]` checklist. The receipt Checklist is synthesized from
   the issue's Decision/Scope, not copied from GitHub checkboxes. The ten
   items correspond to that Decision, but they are not a literal mirror of
   an issue checklist that does not exist.

Overall: **REFUTED** on check 3 only.
