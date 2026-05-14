# issue-43 — Ground UI/UX of agent-built apps in shared design tokens

GitHub issue: [#43](https://github.com/srikanth235/centraid/issues/43)

## Checklist

- [x] Design tokens spliced into the agent system prompt at session start (live `toCss()`)
- [x] Curated icon set surfaced as copy-pasteable SVG snippets
- [x] Component primitives block (header, button, input, list row, state triad)
- [x] UI/UX rules block (viewport contract, state triad, a11y floor, motion, CSS discipline)
- [x] Reference exemplars (points the agent at bundled todos/journal templates)
- [x] Scaffold writes `tokens.css` + `theme-bridge.js`
- [x] Scaffold writes a real `app.css` with utility classes, no hardcoded hex, 44px hit targets, focus-visible rings, prefers-reduced-motion
- [x] `previewScreenshot` custom-tool factory exported from the harness
- [x] Desktop wires the tool via `webContents.capturePage()` clipped to the preview iframe
- [x] Tool-presence detection turns the matching prompt guidance on/off so headless callers aren't misled
- [x] README documents the new public surface
- [x] Typecheck and tests green across the workspace

## What changed

**Design tokens spliced into the agent system prompt at session start (live `toCss()`).** New module `packages/agent-harness/src/ui-grounding.ts` exports `buildUiGroundingBlocks({ withScreenshotTool? })`, which `createCentraidAgentSession` calls and splices into `appendSystemPromptOverride` after `CENTRAID_APPEND_PROMPT`. The first block — `### Design tokens` — inlines the full `toCss()` output verbatim (light + dark + density overrides) and lists the CSS variable contract: `var(--accent)`, `var(--ink)`, `var(--ink-2..4)`, `var(--bg)`, `var(--bg-elev)`, `var(--bg-sunken)`, `var(--line)`, `var(--line-strong)`, `var(--danger)`, `var(--success)`, plus `var(--r-sm..xl)` for radii and `var(--d-1..12)` for spacing. Rules forbid hardcoded `#hexcodes`, `rgb()` literals, raw-px radii, and `font-family` overrides. Pattern matches the existing dynamic `### Live schema` block — built fresh per session so a future tokens change propagates without rebuilding the harness.

**Curated icon set surfaced as copy-pasteable SVG snippets.** The `### Icon set` block walks the 20 in-app Lucide-style glyphs from `@centraid/design-tokens/icons.ts` (Check, Plus, X, ArrowLeft, Search, Trash, Pencil, Play, Pause, Skip, Reset, Send, Share, Eye, Code, History, Sparkle, MoreHoriz, Save, Settings) and emits a fully-formed `<svg viewBox="0 0 24 24" stroke="currentColor" …>` snippet per icon. Tells the agent to inline the SVG, rely on `currentColor` for theming, and never fetch remote SVGs or use emoji-as-icon. App-tile glyphs (Todo, Habit, etc.) are intentionally excluded — those are shell-level, not useful inside an authored app.

**Component primitives block (header, button, input, list row, state triad).** The `### Component primitives` block is copy-pasteable HTML for the recurring shapes: page shell (`<main><header class="head">…</header></main>`), primary button paired with text input in `.add-bar`, list row with `.circle` toggle and `.del` icon button, the empty/loading/error triad as `<p class="empty/loading/error" hidden>`, plus secondary `.ghost` button and `.surface` card. Models follow examples vastly better than rules, so this is intentionally concrete; the matching utility classes are present in the scaffold's `app.css`.

**UI/UX rules block (viewport contract, state triad, a11y floor, motion, CSS discipline).** The `### UI/UX rules` block enforces the non-negotiables. Viewport contract: theme-bridge required, mobile-first, safe-area-inset, `main` capped at ~36rem mobile / ~56rem desktop. State triad: every async surface renders empty/loading/error, toggled via `hidden` so screen readers don't announce all three. A11y floor: 44×44px hit targets, `:focus-visible` outline preserved, semantic landmarks (`<main>`/`<header>`/`<section aria-label>`), `aria-live="polite"` for async updates, color never the only signal. Motion: `@media (prefers-reduced-motion: reduce)` honored, transitions ≤ 150ms. CSS discipline: no `!important`, no deep selectors, no inline styles, no `font-family` overrides.

**Reference exemplars (points the agent at bundled todos/journal templates).** The `### Reference exemplars` block names `@centraid/app-templates/todos` and `journal` as canonical "this is what good looks like" references the agent can read directly via the bash tool. Notes the load-bearing pieces (theme-bridge wire-up, `.head/.add-bar/.list/.row/.empty` classes, var-only color references) so even an agent that can't reach the file paths gets the gist.

**Scaffold writes `tokens.css` + `theme-bridge.js`.** `scaffoldProject` in `packages/agent-harness/src/scaffold.ts` now drops `tokens.css` (a frozen `toCss()` snapshot, ~4.5kB of generated CSS — light theme + dark theme + density overrides) and `theme-bridge.js` (synchronous pre-paint bridge that reads `data-theme` + `--bg-l` from the URL hash and stays in sync with the shell via `centraid:theme` postMessages). The new `index.html` loads `theme-bridge.js` (plain `<script>`, no defer) before `tokens.css` before `app.css`, sets `viewport-fit=cover`, and lays down the canonical `<main><header class="head">…</header><section class="surface">…</section></main>` shell.

**Scaffold writes a real `app.css` with utility classes, no hardcoded hex, 44px hit targets, focus-visible rings, prefers-reduced-motion.** The replacement `app.css` ships utility classes (`.head`, `.muted`, `.surface`, `.add-bar`, `.primary`, `.ghost`, `.link`, `.list`, `.row`, `.row-text`, `.circle`, `.del`, `.empty`, `.loading`, `.error`) styled entirely against `var(--…)` tokens — a smoke test confirmed every CSS color reference is a token, no hex literals outside one `var(--ink-inv, #fff)` fallback. Mobile-first with one breakpoint at 720px. Inputs/buttons/circle have `min-height` ≥ 44px / 2.75rem. `:focus-visible` outlines use `var(--accent)`. `@media (prefers-reduced-motion: reduce)` collapses animations. New apps inherit the visual baseline as a starting condition, not a hope.

**`previewScreenshot` custom-tool factory exported from the harness.** New module `packages/agent-harness/src/preview-screenshot-tool.ts` exports `createPreviewScreenshotTool({ capture })` which returns a pi `ToolDefinition` named `previewScreenshot` with empty params (TypeBox `Type.Object({})`) and a `description` instructing the agent to call it after meaningful visual changes — one screenshot per coherent change, do not spam. The tool returns `AgentToolResult` containing both a `TextContent` ("Preview screenshot captured.") and an `ImageContent` carrying the base64 PNG, so the model sees the screenshot in its next turn. Public surface (`packages/agent-harness/src/index.ts`) exports the factory plus `CreatePreviewScreenshotToolOptions` and `PreviewScreenshotImage`.

**Desktop wires the tool via `webContents.capturePage()` clipped to the preview iframe.** The `AGENT_START` IPC handler in `apps/desktop/src/main/ipc.ts` builds the tool with a `capture` callback that calls `capturePreviewIframe(win)`. That helper first runs `win.webContents.executeJavaScript` with a one-liner that grabs the bounding rect of `iframe[data-centraid-app="1"]` (the tag set by `makePreviewFrame` in `builder.ts`); if no iframe is visible or its rect is empty, it throws a useful error ("Preview iframe not visible. Switch the right pane to the Preview tab and try again.") that surfaces to the agent as a tool failure. Otherwise `win.webContents.capturePage({ x, y, width, height })` clips capture to the iframe region, `.toPNG().toString('base64')` yields the base64 payload, and the helper returns `{ mimeType: 'image/png', base64 }`.

**Tool-presence detection turns the matching prompt guidance on/off so headless callers aren't misled.** `createCentraidAgentSession` in `agent-session.ts` runs a `hasPreviewScreenshotTool(customTools)` helper that scans the array by tool name (`'previewScreenshot'`). The result is passed to `buildUiGroundingBlocks({ withScreenshotTool })`; only when true does the UX rules block include the "After any meaningful CSS or layout change, call the `previewScreenshot` tool to verify the result" paragraph. Headless/CLI callers that omit the tool simply don't see the guidance, so the agent isn't told to call something that doesn't exist.

**README documents the new public surface.** `packages/agent-harness/README.md` gains two new sections: "UI/UX grounding" (table of the five blocks and what each contributes) and "Visual feedback loop" (two-step wiring of the screenshot tool). A "What the scaffold writes" section enumerates the new files (`tokens.css`, `theme-bridge.js`, the grounded `app.css`) and the contract each upholds.

**Typecheck and tests green across the workspace.** `bun run turbo run typecheck` — 12 successful, 12 total. `bun run turbo run test` — 8 successful, 8 total. The existing `publish.test.ts` regression test still passes; harness scaffold output was exercised by a one-off smoke script that confirmed shape and contents (top-level files present, `tokens.css` ~4.5kB, `app.css` has `var(--accent)`, `theme-bridge.js` precedes `tokens.css` in HTML head, all 5 prompt blocks render, screenshot guidance toggles correctly).

## Out of scope

- **Token sync command.** `tokens.css` is a frozen snapshot at scaffold time, so an authored app does not see token updates that ship after scaffold. A future `centraid tokens sync` (or a desktop "update tokens" affordance) would re-emit `tokens.css` in place; left for a follow-up issue.
- **Gateway-served tokens stylesheet.** An alternative architecture would have the gateway serve `/centraid/_tokens.css` so every app `<link>`s to a single source of truth. Chose the per-app snapshot for v1 because it keeps apps self-contained and doesn't add a runtime dependency on the shell's stylesheet. Either approach can be layered on later.
- **Mobile renderer integration.** The grounding flows through the agent (which the desktop hosts) and the scaffold (which the desktop calls). Mobile is a consumer of the same harness package; no mobile-specific work needed in this PR.
- **System-prompt visual-coverage tests.** The blocks are dynamically generated and the smoke test confirms shape; a richer prompt-snapshot suite (e.g. golden-file comparison) is out of scope for v1.

## Verification

Manual: launched the desktop with the new scaffold and confirmed the Electron process tree comes up cleanly — `bun run --filter @centraid/desktop dev` reached the running-window state with no main-process errors.
