# Issue #696 — fix stale chat harness selection and switching lag

Issue: #696

## Checklist

- [x] Ignore stale conversation, provider, and runner-switch responses.
- [x] Keep the selected runner explicit through the streaming request.
- [x] Gate the first send on persisted runner and picker readiness.
- [x] Recover picker failures and aborted switches without leaving the composer stuck.
- [x] Prevent compact-layout controls from intercepting Send.
- [x] Add focused regression coverage and a live opencode smoke test.

## What changed

The assistant route now keeps bridge callbacks stable while forwarding current state through an event ref, so streamed tokens and ordinary route updates do not recreate the picker loader or transcript callback graph. Runner switches and transcript loads carry independent request epochs; stale provider responses, duplicate StrictMode loads, and an old conversation's adapter binding can no longer repaint the active picker. Persisted runner resolution gates the first send, picker failures recover controls in `finally`, and the latest overlapping switch wins. Pending attachment preview URLs are revoked on switch, send, removal, and unmount.

The screen now ignores stale model-picker responses, handles rejected picker loads, waits for picker readiness before sending, and keeps the selected runner/model/effort controls synchronized with the active capability revision. The compact-shell quick-capture launcher moves above the composer at narrow widths so its hit target cannot overlap Send.

Checklist evidence:

- Ignore stale conversation, provider, and runner-switch responses.
- Keep the selected runner explicit through the streaming request.
- Gate the first send on persisted runner and picker readiness.
- Recover picker failures and aborted switches without leaving the composer stuck.
- Prevent compact-layout controls from intercepting Send.
- Add focused regression coverage and a live opencode smoke test.

Changed files:

- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AssistantScreen.test.tsx`
- `packages/client/src/react/screens/AssistantScreen.tsx`
- `packages/client/src/react/shell/CaptureOverlay.module.css`
- `packages/client/src/react/shell/routes/AssistantRoute.test.tsx`
- `packages/client/src/react/shell/routes/AssistantRoute.tsx`

## Out of scope

- Changes to provider implementations or harness protocol behavior.
- Changes to the desktop/electron chat surface beyond the shared client route and screen.

## Decisions

- Use request epochs and stable event callbacks at the route boundary rather than changing provider protocols; this keeps the fix local to stale UI state and avoids breaking existing harness adapters.
- Keep the selected runner explicit in the stream input and gate the composer on readiness; silently falling back to a default harness would hide the reported bug.
- Move the compact quick-capture launcher only at narrow widths; wider layouts retain their existing placement.

## Verification

- Focused assistant route and screen suites: 49 tests passed.
- Full client suite: 215 files and 1,756 tests passed.
- `bun run check:fast`, client typecheck, repository lint, format check, and `git diff --check` passed.
- Live isolated web app smoke test selected `opencode` and completed four turns, including keyboard-send and mouse-send checks, with `opencode/big-pickle` still selected after each response.

```sh
bun run check:fast
bun run --cwd packages/client test -- src/react/shell/routes/AssistantRoute.test.tsx src/react/screens/AssistantScreen.test.tsx
bun run --cwd packages/client typecheck
bun run lint
bun run format:check
git diff --check
```

## Audit

- What changed faithfully describes the diff: REFUTED — the diff supports the route/screen race fixes, tests, and compact-layout adjustment, but the receipt also asserts a live isolated opencode smoke test that is not present in the diff.
- each checked checklist item is realized in the diff: REFUTED — five checklist items are directly evidenced, but the sixth item’s live opencode smoke test is not shown in the diff.
- the receipt checklist mirrors the linked issue's checklist: PASS — the receipt’s six checklist bullets match the issue’s scope and validation bullets in content and order.

## Steering

**PASS**

Session transcript reviewed in full: the user requested publishing the completed harness fix as a new issue-linked pull request and obtaining green checks. No mid-course user correction or interruption occurred; the receipt and branch adjustments were required by repository governance.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fc3bb-b65-1785699225-1 | codex | 019fc3bb-b655-7c73-88ea-09f1dc344dce | #696 | gpt-5.6-luna | 1047139 | 0 | 38516992 | 120944 | 1168083 | 14.0613 | 1047139 | 0 | 38516992 | 120944 | fix(chat): prevent stale harness selection (#696) |
| codex-019fc3bb-b65-1785699423-1 | codex | 019fc3bb-b655-7c73-88ea-09f1dc344dce | #696 | gpt-5.6-luna | 27384 | 0 | 849152 | 4680 | 32064 | 0.3509 | 1074523 | 0 | 39366144 | 125624 | fix(chat): prevent stale harness selection (#696) |
| codex-019fc3bb-b65-1785699482-1 | codex | 019fc3bb-b655-7c73-88ea-09f1dc344dce | #696 | gpt-5.6-luna | 4823 | 0 | 343808 | 881 | 5704 | 0.1112 | 1079346 | 0 | 39709952 | 126505 | fix(chat): prevent stale harness selection (#696) |
| codex-019fc3bb-b65-1785699719-1 | codex | 019fc3bb-b655-7c73-88ea-09f1dc344dce | #696 | gpt-5.6-luna | 13805 | 0 | 803072 | 3848 | 17653 | 0.2930 | 1093151 | 0 | 40513024 | 130353 | fix(chat): prevent stale harness selection (#696) |
| codex-019fc3bb-b65-1785699916-1 | codex | 019fc3bb-b655-7c73-88ea-09f1dc344dce | #696 | gpt-5.6-luna | 10717 | 0 | 809472 | 2692 | 13409 | 0.2695 | 1103868 | 0 | 41322496 | 133045 | fix(chat): prevent stale harness selection (#696) |
