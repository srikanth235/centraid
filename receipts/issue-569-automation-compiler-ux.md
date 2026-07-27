# issue-569 — Finish the automation compiler UX (compile screen authors, run screen reads)

GitHub issue: [#569](https://github.com/srikanth235/centraid/issues/569)

## Checklist

- [x] Compiling happens on the compile screen without navigating away; the failure text is readable verbatim
- [x] A compile already running when the rail mounts is joined live, shows an elapsed clock, and disables Compile
- [x] Test run is gated behind a successful compile
- [x] The run screen lists executions only and cannot modify the automation
- [x] The rail offers no text input of any kind
- [x] Cron previews match the scheduler's local-time basis; cron tests pass in any TZ
- [x] The overview fetches the automation list once per visit
- [x] `bun run check:pr` gates green

## What changed

### Compile screen — the authoring half

- **New** `packages/client/src/react/screens/AutomationCompilePane.tsx` (+ `.module.css`, `.test.tsx`) — the compiler rail: verdict band (state, raw failure, the one button), live step list on a hairline spine, artifacts band. Compiles **in place**; never navigates. Joins an already-running compile on mount, so a reload mid-compile shows the real state instead of a finished-looking empty list.
- **New** `packages/client/src/react/screens/AutomationCompileArtifacts.tsx` — the compiled-plan viewer (`handler.js` / `automation.json` tabs, copy). Extracted rather than inlined so `AutomationCompilePane.tsx` stays under the 500-line `file-size-limit` without a waiver.
- `useElapsedLabel` — live `m:ss` while a turn is open, no timer once settled. A coding-agent compile routinely runs minutes; without a clock "Compiling…" is indistinguishable from a hang.
- Busy state reads `latest?.status === 'running'`, not just this mount's `phase` — keying off `phase` alone left Compile clickable during a compile started elsewhere, which starts a **second concurrent compile of the same automation**.
- **New** `packages/client/src/react/shell/routes/automationCompileData.ts` (+ test) and `automationTurnWatch.ts` — compile attempts, per-turn steps, and the `{settled, ok}` turn-watch contract. `settled: false` (stream dropped, turn still open) falls back to a cold read rather than leaving the rail spinning.

### Run screen — the reading half

- `AutomationThreadScreen.tsx` / `.module.css` / fixtures / tests — executions only; compile turns filtered out of the feed. Composer disclaimer states it answers questions and changes nothing.
- `automationThreadData.ts` (+ test) — separates compile turns from executions at the data layer.

### One writer

- The compiler assistant was **removed**, not hidden: the instructions field is the only editable surface for what an automation does. A failure offers `Edit the instructions` (focuses that field) instead of a second editor. `screen-contracts.ts` comment on `error` corrected — it no longer seeds a fix-it assistant.

### Correctness fixes found while driving the real app

- `packages/client/src/cron.ts` — `cronNextRuns` matched fields in **UTC** while its only consumer formatted with `toLocaleTimeString` and the scheduler (`packages/automation/src/fire/cron-match.ts`) fires on the **local** calendar: `0 19 * * 1-5` advertised "12:30 AM" on IST for a 7 PM job. Now matches locally and steps by wall clock (correct across DST). `describeCron` no longer labels every gloss "UTC".
- `packages/client/src/cron.test.ts` — rewritten TZ-independent (local components in, local fields asserted); an ISO literal only passed on a UTC runner.
- `automationsData.ts` / `automationsOverviewLoad.ts` / `HomeRoute.tsx` / `StarredRoute.tsx` — `collectAutomationRuns` now returns the rows it already fetched, so the overview stops paying for `listAutomations()` twice per visit (it was called directly *and* inside the collector, both in one `Promise.all`).
- `AutomationEditorScreen.module.css` — dropped `align-items: flex-start` from the header identity column. On a *column* flex container that sizes children shrink-to-fit on the cross axis, so `.headName` took its max-content width and its ellipsis never fired — a long name ran under the close button. The status pill, the one child that must hug its text, now opts out on its own.

### Checklist crosswalk

- **Compiling happens on the compile screen without navigating away; the failure text is readable verbatim** — `AutomationCompilePane` compiles in place; the `.failure` band renders the ledger's error text in a mono block (`compile-failure` test id).
- **A compile already running when the rail mounts is joined live, shows an elapsed clock, and disables Compile** — mount-time `follow()` on a `running` attempt, `useElapsedLabel`, and the `attemptRunning` busy gate.
- **Test run is gated behind a successful compile** — the `compile-test-run` button is disabled unless `latest.status === 'ok'`.
- **The run screen lists executions only and cannot modify the automation** — `automationThreadData` splits compile turns out; the composer disclaimer states it changes nothing.
- **The rail offers no text input of any kind** — structurally asserted in `AutomationCompilePane.test.tsx` (no `input`, `textarea`, or `form`).
- **Cron previews match the scheduler's local-time basis; cron tests pass in any TZ** — `cronNextRuns` matches local fields and steps by wall clock; `cron.test.ts` builds and asserts on local components.
- **The overview fetches the automation list once per visit** — `collectAutomationRuns` returns the rows it already fetched; `automationsOverviewLoad.test.ts` asserts `listAutomations` is never called directly.
- **`bun run check:pr` gates green** — see Verification below.

Full paths touched: `packages/client/src/cron.ts`, `packages/client/src/cron.test.ts`,
`packages/client/src/gateway-client-automation-compile.ts`,
`packages/client/src/react/screen-contracts.ts`,
`packages/client/src/react/screens/AutomationCompilePane.tsx`,
`packages/client/src/react/screens/AutomationCompilePane.module.css`,
`packages/client/src/react/screens/AutomationCompilePane.test.tsx`,
`packages/client/src/react/screens/AutomationCompileArtifacts.tsx`,
`packages/client/src/react/screens/AutomationEditorScreen.tsx`,
`packages/client/src/react/screens/AutomationEditorScreen.module.css`,
`packages/client/src/react/screens/AutomationEditorScreen.test.tsx`,
`packages/client/src/react/screens/AutomationEditorAccountChoice.test.tsx`,
`packages/client/src/react/screens/AutomationEditorAnchorMention.test.tsx`,
`packages/client/src/react/screens/AutomationEditorTriggers.test.tsx`,
`packages/client/src/react/screens/AutomationThreadScreen.tsx`,
`packages/client/src/react/screens/AutomationThreadScreen.module.css`,
`packages/client/src/react/screens/AutomationThreadScreen.test.tsx`,
`packages/client/src/react/screens/AutomationThreadScreen.test-fixtures.tsx`,
`packages/client/src/react/shell/routes/AutomationEditorRoute.tsx`,
`packages/client/src/react/shell/routes/AutomationEditorRoute.test.tsx`,
`packages/client/src/react/shell/routes/AutomationViewRoute.tsx`,
`packages/client/src/react/shell/routes/AutomationViewRoute.test.tsx`,
`packages/client/src/react/shell/routes/automationCompileData.ts`,
`packages/client/src/react/shell/routes/automationCompileData.test.ts`,
`packages/client/src/react/shell/routes/automationTurnWatch.ts`,
`packages/client/src/react/shell/routes/automationThreadData.ts`,
`packages/client/src/react/shell/routes/automationThreadData.test.ts`,
`packages/client/src/react/shell/routes/automationsData.ts`,
`packages/client/src/react/shell/routes/automationsData.test.ts`,
`packages/client/src/react/shell/routes/automationsOverviewLoad.ts`,
`packages/client/src/react/shell/routes/automationsOverviewLoad.test.ts`,
`packages/client/src/react/shell/routes/HomeRoute.tsx`,
`packages/client/src/react/shell/routes/HomeRoute.test.tsx`,
`packages/client/src/react/shell/routes/StarredRoute.tsx`,
`receipts/issue-569-automation-compiler-ux.md`

## Out of scope

Observed and deliberately left; each is real and unfixed here:

- The automations overview leaks a raw Node stack trace with absolute local file paths into a card subtitle (`Error: deny (receipt …) … at MessagePort.<anonymous> (file:///Users/…/packages/automation/dist/worker/runner.js:71:25)`).
- A card can show a `COMPILING…` chip while its own activity row reads `Compile · failed`.
- The overview is all-or-nothing: a full-page "Loading automations…" until all five requests settle.
- The app shell's 260px sidebar has no collapse breakpoint (`chrome.module.css`, shell-wide).
- A multi-minute coding-agent compile renders as a **single** step row (`Model · <model> · 11m 24s`) carrying the whole narration. Whether the ledger emits one item for a Codex turn or the rail collapses them is unestablished; it belongs with the ACP adapter's item mapping ([#567](https://github.com/srikanth235/centraid/issues/567)).
- The compiler assistant is removed by decision, not deferred — the instructions field is the single writer.
- Cron triggers persist no timezone at all; the scheduler resolves "local" from ambient host config on every tick. This PR only made the *preview* agree with that existing basis. Storing an explicit IANA zone (and defining DST-gap behavior) is filed as [#570](https://github.com/srikanth235/centraid/issues/570).

## Decisions

- **The compiler assistant was removed, not hidden.** An earlier revision of this work put a chat composer in the compiler rail so the agent could be asked to fix a failing compile. That makes two writers for one field — the instructions and the assistant — and nobody can tell which text is live. The instructions field is now the single writer, and the rail is structurally read-only. This is a deliberate deviation from "more help is better": the cure for a failed compile is upstream, so the failure block sends the owner back to the one authored field.
- **`AutomationCompileArtifacts` was extracted rather than waived.** `AutomationCompilePane.tsx` landed at 527 lines, over the `file-size-limit` of 500. The sibling screens in this directory all carry file-level waivers, so a waiver was available and precedented. Extracted the artifacts viewer instead — it is a genuinely self-contained band (props in, no shared state with the compile loop), so the split improves the structure rather than merely satisfying the gate.
- **Elapsed clock is seconds-resolution and only exists while a turn is open.** A finer tick would re-render the rail more often to answer the same question ("is it moving or wedged?"). A settled rail holds no timer at all.
- **Busy state is keyed off the latest attempt, not this mount's phase.** Discovered live: `phase` only knows about compiles the current mount started, so a reload mid-compile left Compile clickable and would start a second concurrent compile of the same automation. The fix widens "busy" to include a running attempt the rail merely observed.
- **Cron preview follows the scheduler, not UTC.** Both bases are defensible in isolation; they must agree. The scheduler's matcher reads `getHours()`/`getDay()` off the host clock, so the preview was made to match it rather than the reverse — changing the engine would alter when existing automations fire.
- **The single-step rendering of a long compile was left unfixed.** An 11m24s Codex compile renders as one `Model · …` row. Establishing whether the ledger emits one item or the rail collapses them is ACP-adapter work, filed under #567 rather than guessed at here.

## Verification

```sh
bun run check:pr                       # full pre-push gate (superset of CI `static`)
bun run typecheck                      # 32/32 packages, includes test files
cd packages/client && bun run test     # 178 files / 1332 tests
```

- `bun run format` — clean.
- `bun run lint` — 2/2 tasks pass.
- `bun run typecheck` — 32/32 packages pass (includes test files).
- `packages/client` vitest — **178 files / 1332 tests pass**, including:
  - 10 `AutomationCompilePane` tests: streams a new attempt without navigating; cold-read fallback when the stream drops mid-turn; failure hands back to the instructions and offers no second editor; Test run gated on a successful compile; stale-plan verdict; create mode offers no compile controls; elapsed clock counts up under fake timers and disappears once settled; a foreign running compile marks the rail busy; nonce-driven compile does not fire on initial render.
  - 21 rewritten cron tests, TZ-independent, including a weekday-range case and one asserting the hour field is read as local time.
- Driven end-to-end against a real gateway (rebuilt web bundle + `embed-web.mjs`, restarted daemon): created an automation, watched an 11m24s Codex compile land, then confirmed the settled state in the live DOM — verdict "Plan ready", elapsed clock absent, Test run un-gated, no failure block — and the run screen's empty state flipping to "No runs yet — Run now, or wait for the trigger."

## Audit

**Verdict 1: "What changed" faithfully describes the diff** — `PASS`

Checked against `git diff --cached`:
- `AutomationCompilePane.tsx` (472 lines) and `AutomationCompileArtifacts.tsx` (78 lines) are new, matching the "New" callouts and the 500-line `file-size-limit` extraction story (472 < 500, so no waiver comment is needed on the new file — confirmed absent).
- `packages/client/src/cron.ts`: the diff replaces every `getUTCFullYear`/`getUTCMonth`/`getUTCDate`/`getUTCHours`/`getUTCMinutes`/`getUTCDay` call in `cronNextRuns` with the local (`getFullYear`/…/`getDay`) equivalents, and the new doc comment states the same UTC-vs-local rationale the receipt gives. `describeCron`'s known-cron table and generated glosses drop the trailing "UTC" suffix, matching the claim.
- `automationsOverviewLoad.ts`: `listAutomations` import is removed and the `Promise.all` now destructures `{ rows, entries }` from `collectAutomationRuns()` alone — the duplicate-fetch fix is real, not just described.
- `AutomationEditorScreen.module.css`: `.headIdentity > div` no longer carries `align-items: flex-start`, and a new `.headStatus { align-self: flex-start; }` plus an explanatory comment ("Deliberately NOT `align-items: flex-start` on the column above…") land exactly as the receipt describes.
- `AutomationThreadScreen.tsx` carries the "changes nothing" / "answers exactly two questions" header comment and filters `triggerKind === 'compile'` out of `threadTurns` in `automationThreadData.ts`.
- "Full paths touched" (34 files + the receipt) is an exact match, file-for-file, against `git diff --cached --name-only`.

No misrepresentation or omission found.

**Verdict 2: Each `[x]` checklist item is realized in the diff** — `PASS`

Spot-verified rather than taken on faith:
- Compile-in-place / gated Test run: `AutomationCompilePane.tsx:371` — `disabled={busy || !latest || latest.status !== 'ok'}` on the `compile-test-run` button; `AutomationCompilePane.test.tsx:167-190` exercises both the disabled and enabled paths.
- Read-only rail: `AutomationCompilePane.test.tsx:167-169` asserts `querySelector('input')`, `('textarea')`, `('form')` are all `null`.
- Run screen executions-only: `automationThreadData.ts` splits `compiles`/`threadTurns` by `triggerKind`.
- Cron TZ-independent / local basis: confirmed above; `bunx vitest run src/cron.test.ts src/react/screens/AutomationCompilePane.test.tsx` was run directly in this audit — **21 + 10 = 31 tests, all pass** (`Test Files 2 passed (2)`, `Tests 31 passed (31)`), matching the receipt's per-file counts exactly.
- Overview fetch-once: `automationsOverviewLoad.test.ts:79` — `expect(listAutomationsMock).not.toHaveBeenCalled()`.
- `bun run check:pr` gates green: not independently re-run in full (would rebuild/typecheck 32 packages); the two most novel/highest-risk suites (compile-pane, cron) were re-run directly above and both pass, and the diff is typecheck-shaped (no `any`, consistent signatures) on inspection.

One imprecision, not a failure: checklist items 2 and 5 abbreviate the issue's acceptance criteria by dropping trailing parentheticals ("(no second concurrent compile of the same automation)", "(structurally asserted)") — the substance still holds (verified above), so this does not change the verdict.

**Verdict 3: The checklist mirrors the issue's acceptance criteria** — `PASS`

Fetched via `gh issue view 569`. All eight `- [x]` items in the receipt correspond 1:1, in the same order, to the eight `- [x]` acceptance criteria in the issue body. Two receipt items are shortened by dropping a parenthetical from the issue's wording (see Verdict 2's caveat); the other six are verbatim. No criterion is added, dropped, or reworded in a way that changes its meaning.

## Steering

**Verdict 1: Every genuine steering event in the transcript has a row** — `PASS`

The transcript (`27820b68-4072-40b8-8c99-6c935c72aad4.jsonl`, 6870 lines) was compacted repeatedly; each compaction re-embeds the prior conversation's user turns at new line numbers, so a single real message shows up at several ordinals sharing one timestamp. Deduping by timestamp and independently reading the surrounding context (tool calls before/after, presence or absence of the `[Request interrupted by user...]` sentinel) for every non-tool-result user message in the file surfaces exactly three genuine steering events:

1. **L525 sentinel → L528 (lowest of 528/1830/3497/4750), `2026-07-26T16:10:56.539Z`** — `[Request interrupted by user for tool use]` cuts off a `bun run format && bun run lint` call mid-flight, immediately followed by *"shoe me the privew please using your browser tool"*. A live interrupt with content → `interrupt` / `structural`.
2. **L556 sentinel → L559 (lowest of 559/1857/3524/4777), `2026-07-26T16:12:53.472Z`** — `[Request interrupted by user]` cuts off the agent building a static HTML preview harness (`Write` to `scratchpad/preview/index.html`), immediately followed by *"why preiew harness...just show me the centraid preview!"*. Another live interrupt → `interrupt` / `structural`.
3. **L779 (lowest of 779/3696/4949), `2026-07-26T16:22:02.976Z`** — the first message after a `/compact`, no interrupt sentinel, but its content is an explicit correction of standing work: *"yout got this wrong.....the only place user tweaks is instrucionts filed "there should be no option of aks the compiler".."* plus a UX-audit redirect. → `correction` / `classifier`.

All three now have rows (`steer-27820b68-1785124034-1/2/3`), using each event's lowest ordinal as required for dedup. Two other candidate messages were checked and are addressed under Verdict 2. No other `[Request interrupted by user...]` sentinel or corrective message exists anywhere else in the 6870-line file — messages after `2026-07-27T02:47:38Z` (an unrelated ACP-router/LiteLLM design conversation) belong to a different task entirely and contain no automation-compiler-UX steering.

**Verdict 2: No non-steering message is recorded as a steering event** — `PASS`, after removing 9 rows

The prior table held 12 rows collapsing to only 4 distinct `(timestamp)` values — the extra 9 were the same 3 genuine events re-embedded at later ordinals by successive compactions, mechanically over-counted as if each re-embedding were a new event. Those duplicates are removed; only one row per genuine event survives, renumbered `-1`/`-2`/`-3` contiguously.

The 4th distinct timestamp from the old table, *"can you restart centraid gateway and open UI in your browser"* (`2026-07-27T02:23:46.212Z`, was row 9), is **not** re-added. Read in context (L4203-4229): it is the first message after a fresh `/compact`, with no interrupt sentinel before it, no "you got this wrong" framing, and no redirection of standing work — it is a plain, well-defined instruction to continue the already-agreed verification workflow ("Driven end-to-end against a real gateway" in this same receipt's Verification section). That is a task request, not steering, so it correctly has no row.

A second candidate found independently during this audit — *"try creating a sample automation and see how the flow is happening"* (`2026-07-26T18:25:59.652Z`, appears at L2031 and L5469) — was checked the same way: also the first message after a `/compact`, no interrupt sentinel, an ordinary ask rather than a correction. Also correctly has no row.

`"continue"` (L915/L3806/L5059, following an interruption at L912) carries no redirect content of its own and is not recorded, consistent with the directive's exclusion of contentless resumptions. The initial task kickoff (`/frontend-design:frontend-design`, L3, `2026-07-26T15:42:24.212Z`) is the session's opening task request, not steering, and is correctly absent.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-27820b68-407-1785124034-1 | claude-code | 27820b68-4072-40b8-8c99-6c935c72aad4 | #569 | claude-opus-5 | 6816 | 6411224 | 701052900 | 1612128 | 8030168 | 430.9339 | 6816 | 6411224 | 701052900 | 1612128 |  |
| claude-code-27820b68-407-1785125648-1 | claude-code | 27820b68-4072-40b8-8c99-6c935c72aad4 | #569 | claude-opus-5 | 122 | 822185 | 15527067 | 56931 | 879238 | 14.3261 | 6938 | 7233409 | 716579967 | 1669059 |  |
| claude-code-27820b68-407-1785125754-1 | claude-code | 27820b68-4072-40b8-8c99-6c935c72aad4 | #569 | claude-opus-5 | 20 | 25494 | 2970025 | 9786 | 35300 | 1.8891 | 6958 | 7258903 | 719549992 | 1678845 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-27820b68-1785124034-1 | 27820b68-4072-40b8-8c99-6c935c72aad4 | #569 | interrupt | structural | shoe me the privew please using your browser tool | pending | 528 | 2026-07-26T16:10:56.539Z |
| steer-27820b68-1785124034-2 | 27820b68-4072-40b8-8c99-6c935c72aad4 | #569 | interrupt | structural | why preiew harness...just show me the centraid preview! | pending | 559 | 2026-07-26T16:12:53.472Z |
| steer-27820b68-1785124034-3 | 27820b68-4072-40b8-8c99-6c935c72aad4 | #569 | correction | classifier | yout got this wrong.....the only place user tweaks is instrucionts filed "there should be no option of aks the compiler".. please fix the UI/UX also the screenshot is noe mobile responsive...not sure why there are are extra lines in trigge… | pending | 779 | 2026-07-26T16:22:02.976Z |
