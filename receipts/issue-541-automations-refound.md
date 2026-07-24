# Receipt — Issue #541: Re-found automations

<!-- governance: allow-receipt-per-issue implementation is being delivered in explicit waves; the complete issue crosswalk and final independent audit replace this WIP waiver before the PR is opened -->

Issue: https://github.com/srikanth235/centraid/issues/541

## Checklist

- [x] When multiple Gmail/GitHub/etc. accounts exist, I can choose the exact one and only that account’s scopes are used
- [x] Per-automation runner/model choices persist and override subsystem defaults for fire and compile
- [ ] Interactive automation replies use the same per-automation runner/model override
- [ ] Remaining issue scope is in progress

## What changed

When multiple Gmail/GitHub/etc. accounts exist, I can choose the exact one and only that account’s scopes are used:

- `packages/client/src/react/screen-contracts.ts` exposes every exact provider-and-kind connection, including principal and health.
- `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx` preserves every exact match instead of collapsing an ambiguous set.
- `packages/client/src/react/shell/routes/automationEditorConnections.test.ts` covers exact, absent, and multiple-match catalog behavior.
- `packages/client/src/react/screens/AutomationEditorConnectorsPicker.tsx` renders an inline account chooser and binds the selected durable connection id.
- `packages/client/src/react/screens/AutomationEditorScreen.tsx` preserves an explicit account choice across catalog refreshes.
- `packages/client/src/react/screens/AutomationEditorScreen.module.css` styles the compact inline account controls with existing design tokens.
- `packages/client/src/react/screens/AutomationEditorScreen.test.tsx` proves account selection is saved and cannot be clobbered by a later refresh.
- `packages/client/src/react/screens/AutomationEditorAccountChoice.test.tsx` isolates the multi-account interaction regression test below the repository file-size ceiling.
- `receipts/issue-498-mobile-springboard-v0.md` gains a narrow receipt-index waiver for the duplicate #498 follow-up receipt already present on `origin/main`, which otherwise blocks every new issue receipt.

Per-automation runner/model choices persist and override subsystem defaults for fire and compile:

- `packages/automation/src/manifest/manifest.ts` and `packages/automation/src/manifest/manifest.test.ts` add the open, non-empty `requires.runner` manifest key.
- `packages/automation/src/scaffold/scaffold.ts` and `packages/automation/src/scaffold/scaffold-files.test.ts` persist initial runner/model pins.
- `packages/client/src/centraid-api.d.ts`, `packages/client/src/gateway-client-automation-editing.ts`, and `packages/client/src/react/screen-contracts.ts` carry runner/model pins and dynamic catalog/default data over the client boundary.
- `packages/client/src/react/screens/AutomationEditorAgentPicker.tsx`, `packages/client/src/react/screens/AutomationEditorScreen.tsx`, and `packages/client/src/react/screens/AutomationEditorScreen.module.css` add the compact Agent control next to Connectors.
- `packages/client/src/react/screens/AutomationEditorAccountChoice.test.tsx` proves a gateway-listed harness and model are saved without a duplicated client-side runner list.
- `packages/client/src/react/shell/routes/automationEditorAgentData.ts`, `packages/client/src/react/shell/routes/automationEditorCreateData.ts`, `packages/client/src/react/shell/routes/automationEditorData.ts`, and `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx` derive effective defaults, load explicit pins, and persist create/edit selections.
- `packages/client/src/react/shell/routes/automationEditorPrefill.test.ts` covers runner-scoped effective model defaults.
- `packages/gateway/src/routes/lifecycle-automation-routes.ts` and `packages/gateway/src/routes/lifecycle-automation-routes.test.ts` round-trip create/update pins and make `null` clear them.
- `packages/gateway/src/lifecycle/automation-agent-selection.ts` and `packages/gateway/src/lifecycle/automation-agent-selection.test.ts` validate a manifest runner against the runtime registry, fall back to automations prefs, and resolve model precedence against the selected runner.
- `packages/app-engine/src/conversation/runner.ts`, `packages/app-engine/src/conversation/runner-core.ts`, and `packages/app-engine/src/conversation/runner-core.test.ts` add a validated one-turn runner override without weakening subsystem defaults.
- `packages/agent-runtime/src/conversation-adapter.ts`, `packages/gateway/src/runs/assistant-conversation-runner.ts`, and `packages/gateway/src/runs/unified-conversation-runner.ts` thread the requested runner into preference loading; a different runner never inherits the configured default runner’s binary or arguments.
- `packages/gateway/src/serve/runner-prefs.ts` and `packages/gateway/src/serve/runner-prefs.test.ts` isolate the host preference rule and regress the exact custom-runner-A versus pinned-runner-B launch-settings bug found by the independent audit.
- `packages/gateway/src/lifecycle/headless-automation-compile.ts` and `packages/gateway/src/lifecycle/headless-automation-compile.test.ts` apply runner/model pins to headless compilation.
- `packages/gateway/src/serve/build-gateway.ts` applies the same selection to compile, manual/scheduled fire, and webhook fire.
- `docs/runners.md` records the per-automation precedence and forward-compatible fallback contract.

## Out of scope

- None for issue #541. Waves 2–10 are still in progress and will be recorded here before the PR is opened.

## Decisions

- The account chooser stays inside the existing Connectors popover so account identity is visible at the point of binding without adding another editor dialog.
- Preserve both immutable #498 narratives and waive only the later follow-up from the one-receipt index; this repairs a pre-existing governance contradiction without deleting history.

## Verification

```sh
bun run --cwd packages/client test -- AutomationEditorScreen.test.tsx AutomationEditorAccountChoice.test.tsx automationEditorConnections.test.ts
bun run --cwd packages/client typecheck
bun run build
bun run --cwd packages/automation test -- src/manifest/manifest.test.ts src/scaffold/scaffold-files.test.ts
bun run --cwd packages/app-engine test -- src/conversation/runner-core.test.ts
bun run --cwd packages/client test -- AutomationEditorAccountChoice.test.tsx AutomationEditorScreen.test.tsx automationEditorPrefill.test.ts automationEditorConnections.test.ts
bun run --cwd packages/gateway test -- src/lifecycle/automation-agent-selection.test.ts src/lifecycle/headless-automation-compile.test.ts src/serve/runner-prefs.test.ts src/routes/lifecycle-automation-routes.test.ts
bun run --cwd packages/automation typecheck
bun run --cwd packages/app-engine typecheck
bun run --cwd packages/gateway typecheck
```

## Audit

**Interim Waves 1–2 audit**

PASS — the final fresh-context Waves 1–2 auditor verified exact account binding and refresh preservation; open runner validation; dynamic editor choices; persistence and null clearing; manifest precedence across compile and all fire paths; unknown-runner fallback; and both generic plus gateway-host regressions preventing runner A’s binary/arguments from leaking into pinned runner B. The full-scope audit will be re-run after Waves 3–10.

## Accounting

### Steering

(no rows — no interrupt/correction events recorded for this change set)

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f9495-7c0-1784905227-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 334821 | 0 | 10015744 | 23188 | 358009 | 3.6888 | 334821 | 0 | 10015744 | 23188 | feat(automations): choose exact connector account (#541) |
| codex-019f9495-7c0-1784905470-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 28664 | 0 | 1103360 | 7060 | 35724 | 0.4534 | 363485 | 0 | 11119104 | 30248 | feat(automations): choose exact connector account (#541) -m governance: allow-do |
| codex-019f9495-7c0-1784911283-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 312159 | 0 | 16580096 | 37209 | 349368 | 5.4836 | 675644 | 0 | 27699200 | 67457 | feat(automations): pin runner and model per automation (#541) |
| codex-019f9495-7c0-1784911338-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 3047 | 0 | 440832 | 163 | 3210 | 0.1203 | 678691 | 0 | 28140032 | 67620 | feat(automations): pin runner and model per automation (#541) -m governance: all |

## Steering

PASS — the final fresh-context Waves 1–2 auditor found no interrupt or correction events.
