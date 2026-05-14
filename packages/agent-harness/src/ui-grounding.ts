/**
 * UI/UX grounding blocks appended to the agent system prompt.
 *
 * These spliced sections give the model the same visual contract the
 * desktop and mobile shells follow: the design-tokens CSS variables, a
 * curated icon set, copy-pasteable component primitives, and a short
 * checklist for the states/a11y floor every app should hit.
 *
 * Built dynamically at session start (see agent-session.ts) so a future
 * tokens change propagates without rebuilding the harness.
 */

import { icons, toCss } from '@centraid/design-tokens';

/**
 * Returns the ordered list of prompt blocks to splice in below
 * `CENTRAID_APPEND_PROMPT`. Each block is a single string starting with
 * its `###` heading so it renders cleanly in the system prompt.
 *
 * Pass `withScreenshotTool: true` to include guidance for the
 * `previewScreenshot` custom tool (the desktop wires it up; CLI/test
 * callers that don't provide the tool should leave this false so the
 * agent isn't told to call something that isn't there).
 */
export function buildUiGroundingBlocks(opts: { withScreenshotTool?: boolean } = {}): string[] {
  return [
    renderDesignTokensBlock(),
    renderIconSetBlock(),
    renderComponentPrimitivesBlock(),
    renderUxRulesBlock(opts.withScreenshotTool === true),
    renderExemplarsBlock(),
  ];
}

/**
 * `### Design tokens` — the live CSS-variable contract emitted by
 * `@centraid/design-tokens`. The agent should consume these via
 * `var(--accent)`, `var(--ink)`, etc. — never hardcode colors, radii,
 * font sizes, or spacing values.
 *
 * The starter `app.css` written by `scaffoldProject()` already links
 * the same vars from a local snapshot, so this block is for the *agent*
 * (so it knows what's available); the runtime contract comes from the
 * scaffold and the theme bridge.
 */
function renderDesignTokensBlock(): string {
  const css = toCss();
  return [
    '### Design tokens (use these — do not invent colors or sizes)',
    '',
    "Every centraid app inherits the shell's visual contract via CSS variables.",
    'A snapshot of these tokens ships with the scaffold (`tokens.css`) and is',
    'linked from `index.html` — your styles must reference them, never hardcode.',
    '',
    '**Rules:**',
    '',
    '- Colors: `var(--accent)`, `var(--ink)`, `var(--ink-2)`, `var(--ink-3)`, `var(--ink-4)`, `var(--bg)`, `var(--bg-elev)`, `var(--bg-sunken)`, `var(--line)`, `var(--line-strong)`, `var(--danger)`, `var(--success)`. **Never** write `#hexcodes` or `rgb()` literals for foreground/background/border.',
    '- Radii: `var(--r-sm)`, `var(--r-md)`, `var(--r-lg)`, `var(--r-xl)` — do not pick px values by feel.',
    '- Spacing (regular density): `var(--d-1)` through `var(--d-12)` — favor these over raw rem/px where it fits.',
    '- Theme: light/dark flips by `data-theme` on `<html>`. The bundled `theme-bridge.js` keeps this in sync with the shell. Always include it.',
    "- Fonts: inherit from `<body>` (the scaffold sets the system stack). Don't load web fonts or override `font-family`.",
    '',
    'Verbatim token CSS (light + dark + density overrides) — this is what `tokens.css` resolves to at runtime:',
    '',
    '```css',
    css.trimEnd(),
    '```',
  ].join('\n');
}

/**
 * `### Icon set` — the curated Lucide-style icon paths from
 * `@centraid/design-tokens/icons.ts`. Tells the agent: pick from this
 * set, inline the path data into an `<svg viewBox="0 0 24 24">`, and
 * use `currentColor` so colors flow from the parent `color` rule. No
 * emoji, no remote SVG fetches, no extra icon libraries.
 */
function renderIconSetBlock(): string {
  // Surface the in-app icon set (not the app-tile glyphs — those are
  // shell-level and not useful inside an app's UI).
  const inAppIcons: Array<keyof typeof icons> = [
    'Check',
    'Plus',
    'X',
    'ArrowLeft',
    'Search',
    'Trash',
    'Pencil',
    'Play',
    'Pause',
    'Skip',
    'Reset',
    'Send',
    'Share',
    'Eye',
    'Code',
    'History',
    'Sparkle',
    'MoreHoriz',
    'Save',
    'Settings',
  ];

  const entries = inAppIcons
    .filter((n) => icons[n])
    .map((name) => {
      const paths = icons[name]
        .map((p) => `    <path d="${p.d}"${p.fill ? ` fill="${p.fill}"` : ''} />`)
        .join('\n');
      return `- **${name}**\n\`\`\`html\n<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\n${paths}\n</svg>\n\`\`\``;
    });

  return [
    '### Icon set',
    '',
    'Inline these SVG paths when you need an icon. **Never** use emoji as icons,',
    'fetch SVGs from CDNs, or pull in icon libraries. The path data below is the',
    'canonical Lucide-style set the shell itself uses.',
    '',
    'Usage: copy the `<svg>` snippet verbatim. `currentColor` + `stroke="currentColor"`',
    'mean the icon inherits color from its parent — set `color: var(--ink-3)` on',
    'the container, never hardcode a fill.',
    '',
    ...entries,
  ].join('\n');
}

/**
 * `### Component primitives` — copy-pasteable HTML/CSS for the
 * recurring patterns (header, primary button, input, list row, empty
 * state, loading, error). Models follow examples vastly better than
 * rules, so this is intentionally concrete; the matching utility
 * classes are present in the scaffold's `app.css`.
 */
function renderComponentPrimitivesBlock(): string {
  return [
    '### Component primitives',
    '',
    "Reuse these shapes verbatim. The scaffold's `app.css` already styles every",
    'class below — when you add new UI, prefer composing these over inventing',
    'new visual primitives.',
    '',
    '**Page shell**',
    '',
    '```html',
    '<main>',
    '  <header class="head">',
    '    <h1>Your app</h1>',
    '    <p class="muted">Short tagline or count</p>',
    '  </header>',
    '  <!-- content -->',
    '</main>',
    '```',
    '',
    '**Primary button + text input (paired in a form)**',
    '',
    '```html',
    '<form class="add-bar" autocomplete="off">',
    '  <input type="text" name="title" placeholder="Add something…" enterkeyhint="done" />',
    '  <button type="submit" class="primary">Add</button>',
    '</form>',
    '```',
    '',
    '**List row**',
    '',
    '```html',
    '<section class="list" aria-label="Items">',
    '  <div class="row" data-done="false">',
    '    <button class="circle" aria-pressed="false" aria-label="Toggle">',
    '      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12l2 2 4-4M14 6l4 4-8 8-3-3" /></svg>',
    '    </button>',
    '    <span class="row-text">Row label</span>',
    '    <button class="del" aria-label="Delete">',
    '      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14" /></svg>',
    '    </button>',
    '  </div>',
    '</section>',
    '```',
    '',
    '**Empty / loading / error states (the triad — see UX rules below)**',
    '',
    '```html',
    '<p class="empty" hidden>Nothing here yet. Add one above.</p>',
    '<p class="loading" hidden>Loading…</p>',
    '<p class="error" role="alert" hidden>Something went wrong. <button class="link" type="button">Retry</button></p>',
    '```',
    '',
    '**Secondary / quiet button** — same shape as `.primary`, swap to `class="ghost"` (transparent bg, `var(--ink-2)` text).',
    '',
    '**Card / surface** — wrap in `<div class="surface">` for an elevated panel; the scaffold styles it with `background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--r-lg);`.',
  ].join('\n');
}

/**
 * `### UI/UX rules` — the non-negotiables: state triad, a11y floor,
 * viewport contract, and (optionally) when to call the visual-feedback
 * screenshot tool.
 */
function renderUxRulesBlock(withScreenshotTool: boolean): string {
  const lines = [
    '### UI/UX rules (non-negotiable)',
    '',
    '**Viewport / iframe contract.** Apps render inside a sandboxed iframe at any',
    'of three sizes (mobile ≈ 390px, tablet ≈ 820px, desktop ≈ 1280px). Author',
    "mobile-first; the scaffold's `app.css` already has the breakpoints. Always:",
    '',
    '- Include `theme-bridge.js` via a plain `<script>` (no `type=module`, no `defer`) **before** the stylesheet, so theme paints before first content. The scaffold does this for you — do not remove it.',
    '- Use `padding: max(1rem, env(safe-area-inset-top)) ...` for the top/bottom edges so notched phones work.',
    '- Cap `main` width at ~36rem mobile / ~56rem desktop; the scaffold sets this.',
    '',
    '**State triad.** Every async list or fetch view must render *all three*:',
    '',
    '- **Empty** — the natural zero state ("Nothing here yet. Add one above."), styled with `.empty`.',
    '- **Loading** — a short `Loading…` or skeleton; show within 150ms, never silence.',
    '- **Error** — `role="alert"` with a retry affordance; render with `.error`.',
    '',
    "Toggle these via `hidden` so a screen reader doesn't announce all three at once.",
    '',
    '**Accessibility floor.**',
    '',
    '- Interactive elements ≥ 44×44px hit target. Buttons styled to look smaller still need this hit area.',
    '- `:focus-visible` outline must remain — never set `outline: none` without replacing it.',
    '- Use semantic landmarks: `<main>`, `<header>`, `<section aria-label="...">`, `<nav>` only when there really is navigation.',
    '- Async results that update in place: wrap in `aria-live="polite"` (or `role="status"`).',
    '- Color is never the only signal — always pair with text, icon, or shape.',
    '',
    '**Motion.** Honor `@media (prefers-reduced-motion: reduce)`. Default transitions ≤ 150ms; no auto-playing animations that loop.',
    '',
    '**Forms.** Always `<label for="...">` (or `aria-label`); `autocomplete=`, `enterkeyhint=`, and `inputmode=` set appropriately. Disabled submit until the input has content.',
    '',
    '**CSS discipline.** No `!important`. No deep selectors (`> > >`). No inline styles unless dynamic. No `font-family` overrides — the system stack from the scaffold is the contract.',
  ];

  if (withScreenshotTool) {
    lines.push(
      '',
      '**Visual feedback.** After any meaningful CSS or layout change, call the',
      '`previewScreenshot` tool to verify the result. The screenshot of the live',
      'preview iframe will be returned as an image — read it like a code review',
      "comment and fix what looks wrong before moving on. Don't spam the tool;",
      'one screenshot per coherent visual change is the right cadence.',
    );
  }

  return lines.join('\n');
}

/**
 * `### Reference exemplars` — points the agent at the bundled
 * templates as canonical "this is what good looks like" examples.
 */
function renderExemplarsBlock(): string {
  return [
    '### Reference exemplars',
    '',
    'When unsure about a pattern, read the bundled templates — they are the',
    'canonical references for what a well-grounded centraid app looks like:',
    '',
    '- `@centraid/app-templates/todos/` — the tightest single-list example. Use this as the visual baseline for list-style apps. Notice the `theme-bridge.js` wire-up, the `.head/.add-bar/.list/.row/.empty` class shapes, and how it never hardcodes a color.',
    '- `@centraid/app-templates/journal/` — a slightly richer surface (cards, editing, dated entries). Use for any app that has a "compose + browse" rhythm.',
    '',
    "You can read these directly via the bash tool, e.g. `cat ../../packages/app-templates/todos/app.css` from a project root that lives under the same workspace. If you can't reach them (paths vary by environment), the component primitives block above captures the load-bearing pieces.",
  ].join('\n');
}
