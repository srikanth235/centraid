# Receipt — issue #539: Automations as chat (live thread + steering composer)

Centraid stores an automation as one long-lived conversation and every fire as a
turn under it (`conversation ⊃ turn ⊃ item`). The UI projected those turns back
out as a compact one-line run register that you clicked to *leave* the thread.
This change presents the data the way it is already stored: the automation thread
reads as a chat, each run is a message, and the owner can steer it by replying.

Direction approved from an interactive prototype (owner). Client-only — reuses
`ThreadRunDTO.summary` as the message body and the already-scaffolded (but never
rendered) composer + `onSendMessage` path; no new gateway endpoints.

## Checklist

- [x] Thread renders each run as a chat turn
- [x] Thread surfaces the steering composer with an Apply to future runs toggle
- [x] Overview restyled as an automation tile gallery
- [x] Run-view simplified to a single calm view
- [x] Tests updated for thread, overview, and run-view

## What changed

- **Thread renders each run as a chat turn.**
  `packages/client/src/react/screens/AutomationThreadScreen.tsx` replaces the
  compact one-line `RunEntry` with a `RunTurn`: an origin-aware node on the
  spine, an origin label + time header, the run `summary` as the message body, a
  quiet telemetry footer (duration / cost / tokens), a **Details** affordance
  that still opens the full run-view, and — for a failed run — an inline error
  card with **Try again** / **View details**. A running run shows a spinner
  turn. `packages/client/src/react/screens/AutomationThreadScreen.module.css`
  swaps the `.entry*` register styles for chat-turn styles (`.turn` / `.node` /
  `.turnHead` / `.turnBody` / `.turnFoot` / `.turnError` / `.turnGenerating`)
  centred on the existing 8px spine.
- **Thread surfaces the steering composer with an Apply to future runs toggle.**
  Same screen adds a `Composer` (surfacing the previously-scaffolded
  `onSendMessage` path) rebuilt in CSS into `.composerWrap` + `.steerRow` +
  `.composer`; the toggle frames standing-instruction vs one-off intent and
  routes to the existing conversational-revision surface.
- **Overview restyled as an automation tile gallery.**
  `packages/client/src/react/screens/AutomationsOverviewScreen.tsx` replaces the
  one-line `FleetRow` register with an `AutoTile` **gallery grid** that mirrors
  the Home shelf (reuses the `AppCard` family — `HomeScreen.module.css` `appsGrid`,
  `AppCard.module.css` `wrap`/`card`/`small`, and `KindBadge`): each tile shows the
  automation's glyph plate, name, the most-recent-run blurb (`lastRunSummary`,
  falling back to the trigger so a card is never blank), a status + trigger meta
  strip, and a last-run foot; an attention or failed-last-run tile gets a
  restrained danger accent + badge and sorts first.
  `packages/client/src/react/screens/AutomationsOverviewScreen.module.css` adds the
  tile styles (`.tile` / `.tileText` / `.tileBlurb` / `.cardMeta` / `.cardTrig` /
  `.attentionBadge` / `.failedBadge` / `.activitySection`).
  `packages/client/src/react/screen-contracts.ts` adds `lastRunSummary` to
  `AuOverviewRowDTO` and `hasUsage` to `RunViewSnapshot`;
  `packages/client/src/react/shell/routes/automationsData.ts` derives
  `lastRunSummary` from the latest run's `summary` (or `error`).
- **Run-view simplified to a single calm view.**
  `packages/client/src/react/screens/RunViewScreen.tsx` drops the in-view
  Timeline/Log toggle, the details-collapse button, the breadcrumb, and **Run
  again** — re-running now lives on the thread's steering — leaving one calm
  detail view that still honours `initialMode` for deep links.
  `packages/client/src/react/screens/RunViewScreen.module.css` sheds the now-dead
  header-action styles, and `packages/client/src/react/shell/routes/runViewData.ts`
  computes `hasUsage` so the Usage card shows a caption for deterministic
  zero-usage runs instead of empty rows.
- **Tests updated for thread, overview, and run-view.**
  `packages/client/src/react/screens/AutomationThreadScreen.test.tsx`,
  `packages/client/src/react/screens/AutomationsOverviewScreen.test.tsx`,
  `packages/client/src/react/screens/RunViewScreen.test.tsx`, and
  `packages/client/src/react/shell/routes/runViewData.test.ts` cover the chat
  turns, the Details affordance, the steering composer, the new preview field, the
  simplified run-view header, and the `hasUsage` caption.
- **Dev doc.** `docs/dev-environment.md` documents previewing the web app in a
  browser against an existing vault (pair-a-device flow) — the sanctioned way to
  live-verify this client-only work without a second SQLite writer.

## Out of scope

- A true in-thread interactive turn that stays on the thread and streams live
  (needs an interactive-run endpoint on the gateway) — this is issue #541 Wave 6.
- Rewriting the manifest `prompt` in place from a steering reply — steering still
  flows through the conversational builder/compile surface for now (issue #541
  Wave 7).
- Editor connector-account picking and per-automation harness/model — the
  connector-label multi-account groundwork ships alongside under #524; the editor
  picker itself is issue #541 Wave 1–2.

## Decisions

- **Run-view simplification folded in.** #539's issue scope was thread + composer
  + overview and named run-view only as the escape hatch that "still opens". Once
  the thread owns re-running and steering, the run-view's Run-again / mode-toggle
  / hide-details controls became redundant noise, so this change also strips them
  (`RunViewScreen.tsx/.module.css`, `runViewData.ts` + tests). Disclosed here as
  an adjacent, in-spirit consequence rather than a separate issue.
- **Connector multi-account label UX split to #524.** The distinct-label
  groundwork in Settings + the automation editor picker belongs to the connector
  platform (#524), not this thread redesign, and lands as its own commit against
  the existing #524 receipt — one PR, honest per-issue attribution. Those files —
  `packages/client/src/react/screens/SettingsConnectionsScreen.tsx`,
  `packages/client/src/react/screens/SettingsConnectionsScreen.module.css`,
  `packages/client/src/react/screens/SettingsConnectionsScreen.test.tsx`,
  `packages/client/src/react/screens/AutomationEditorConnectorsPicker.tsx`,
  `packages/client/src/react/screens/AutomationEditorScreen.module.css` — are named
  here only so this branch's added receipt covers every changed path (governance
  rule 6 anchors coverage on added receipts, and #524's receipt is pre-existing);
  their narrative lives in `receipts/issue-524-connectors-platform.md`.
- **Overview: tile gallery over inbox rows.** #539's issue text described the
  overview as "conversation inbox" *rows*; the implementation instead reuses the
  Home shelf's `AppCard`/`appsGrid` tile family so automations read as a gallery
  consistent with the rest of the app, keeping the same information (glyph, name,
  last-run preview/blurb, status, trigger, attention-first). Same intent, different
  layout primitive — chosen for visual consistency with Home.
- **Dev-environment doc included** because it is the verification tooling for this
  client-only work (browser preview against a real vault); no product surface.

## Verification

```sh
# Client screen suites touched by this change
bun run --filter '@centraid/client' test -- AutomationThreadScreen AutomationsOverviewScreen RunViewScreen runViewData
# Full pre-push gate (typecheck, oxlint, knip, lint:css, matrix, ratchets)
bun run check:pr
```

## Audit

**Audit verdict: PASS**

- **What changed faithfully describes the diff** — PASS — Overview bullet correctly describes the `AutoTile` "gallery grid" reusing `AppCard` family (`cardCss.wrap/card/small`, `homeCss.appsGrid`, `KindBadge`), matching the diff's `FleetRow`→`AutoTile` rewrite; thread/run-view/contracts/data bullets all match.
- **Each [x] item realized in the diff** — PASS — `RunTurn`+`turnGenerating`+Try again/Details, `Composer`/`onSendMessage`/Apply-to-future, `AutoTile` grid, run-view stripped (`mode = initialMode`, removed toggle/Run again/breadcrumb, `hasUsage`), and all four test files staged.
- **Checklist mirrors the issue scope** — PASS — Thread, Steering composer, Overview map to issue Scope bullets; the tile-gallery-vs-inbox choice and run-view/dev-doc extras are disclosed in `## Decisions`.

_Audited by fresh-context sub-agent against `git diff --cached`, the receipt, and `gh issue view 539`._

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

(no rows — no interrupt/correction events recorded for this change set)

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-263295d3-064-1784885837-1 | claude-code | 263295d3-064b-4825-bea6-e509974fdfc6 | #539 | claude-opus-4-8 | 448 | 1625453 | 49943282 | 361497 | 1987398 | 44.1704 | 448 | 1625453 | 49943282 | 361497 | feat(client): render automations as a chat thread + steering composer (#539)The  |
| claude-code-9bc5e3aa-00b-1784903126-1 | claude-code | 9bc5e3aa-00b6-4796-bdfc-d88220157baa | #539 | claude-opus-4-8 | 5865 | 13343527 | 567708161 | 2448415 | 15797807 | 428.4908 | 5865 | 13343527 | 567708161 | 2448415 | feat(client): render automations as a chat thread + steering composer (#539)Pres |
| claude-code-9bc5e3aa-00b-1784903471-1 | claude-code | 9bc5e3aa-00b6-4796-bdfc-d88220157baa | #539 | claude-opus-4-8 | 28 | 47429 | 2501912 | 24100 | 71557 | 2.1500 | 5893 | 13390956 | 570210073 | 2472515 | feat(client): render automations as a chat thread + steering composer (#539)Pres |
| claude-code-9bc5e3aa-00b-1784903692-1 | claude-code | 9bc5e3aa-00b6-4796-bdfc-d88220157baa | #539 | claude-opus-4-8 | 14 | 25750 | 1383665 | 16391 | 42155 | 1.2626 | 5921 | 13424115 | 572919620 | 2494124 | feat(client): render automations as a chat thread + steering composer (#539)Pres |

## Steering

**Check 1 — every human-steering event is recorded in ### Steering under ## Accounting**
PASS – No interrupt or mid-task correction of the #539 code work in this session; empty steering table is correct.

**Check 2 — no non-steering message is recorded as a steering event**
PASS – No false-positive steering rows recorded.
