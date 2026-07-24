# Receipt — Issue #541: Re-found automations

<!-- governance: allow-receipt-per-issue implementation is being delivered in explicit waves; the complete issue crosswalk and final independent audit replace this WIP waiver before the PR is opened -->

Issue: https://github.com/srikanth235/centraid/issues/541

## Checklist

- [x] When multiple Gmail/GitHub/etc. accounts exist, I can choose the exact one and only that account’s scopes are used
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
```

## Audit

**Interim Wave 1 audit**

PASS — a fresh-context agent inspected the diff and found that it returns every exact provider-and-kind account, renders an inline chooser, saves only the selected `connectionId`, preserves that explicit binding across refreshes, and covers the behavior with focused tests. The full-scope audit will be re-run after Waves 2–10.

## Accounting

### Steering

(no rows — no interrupt/correction events recorded for this change set)

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f9495-7c0-1784905227-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 334821 | 0 | 10015744 | 23188 | 358009 | 3.6888 | 334821 | 0 | 10015744 | 23188 | feat(automations): choose exact connector account (#541) |
| codex-019f9495-7c0-1784905470-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 28664 | 0 | 1103360 | 7060 | 35724 | 0.4534 | 363485 | 0 | 11119104 | 30248 | feat(automations): choose exact connector account (#541) -m governance: allow-do |

## Steering

PASS — the fresh-context Wave 1 auditor found no interrupt or correction events.
