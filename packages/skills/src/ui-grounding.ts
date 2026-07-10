/**
 * UI/UX grounding blocks appended to the agent system prompt.
 *
 * These spliced sections give the model the same visual contract the
 * desktop and mobile shells follow: the design-tokens CSS variables, a
 * curated icon set, copy-pasteable component primitives, and a short
 * checklist for the states/a11y floor every app should hit.
 *
 * Built dynamically per turn (from `@centraid/design-tokens`) so a future
 * tokens change propagates without regenerating anything. This is the
 * design-contract grounding that can't be a static `SKILL.md` — it is
 * composed into the turn alongside the static authoring skills. Promoting it
 * to a generated `centraid-ui-design/SKILL.md` snapshot is the natural next
 * step once native skill discovery is wired on both backends.
 */

import { icons, toBlueprintCss } from '@centraid/design-tokens';

/**
 * Returns the ordered list of prompt blocks to splice in below the
 * `authoring-centraid-apps` skill. Each block is a single string starting with
 * its `###` heading so it renders cleanly in the system prompt.
 */
export function buildUiGroundingBlocks(): string[] {
  return [
    renderDesignTokensBlock(),
    renderIconSetBlock(),
    renderComponentPrimitivesBlock(),
    renderUxRulesBlock(),
    renderExemplarsBlock(),
  ];
}

/**
 * `### Design tokens` — the live CSS-variable contract emitted by
 * `@centraid/design-tokens`. The agent should consume these via
 * `var(--accent)`, `var(--ink)`, etc. — never hardcode colors, radii,
 * font sizes, or spacing values.
 *
 * The scaffolded `index.html` links the shared `tokens.css` (served from the
 * kit dir next to `kit.css`), so this block is for the *agent* (so it knows
 * what's available); the runtime contract comes from the shared sheet and the
 * theme bridge.
 */
function renderDesignTokensBlock(): string {
  const css = toBlueprintCss();
  return [
    '### Design tokens (use these — do not invent colors or sizes)',
    '',
    'Every centraid app inherits the blueprint design system via CSS variables',
    'from the shared `tokens.css` linked in `index.html` (served next to',
    '`kit.css` — no local copy). Your styles must reference them, never hardcode.',
    '',
    '**Rules:**',
    '',
    '- App identity: set `--app-hue` (drives the whole neutral ramp — ink, lines, surfaces, shadows) and `--accent` (one of the palette vars `--c-amber`/`--c-forest`/`--c-indigo`/`--c-ochre`/`--c-rose`/`--c-slate`/`--c-teal`/`--c-violet`) in your app.css `:root`. Everything else derives.',
    '- Colors: `var(--accent)`, `var(--accent-soft)`, `var(--accent-deep)`, `var(--ink)`, `var(--ink-2)`, `var(--ink-3)`, `var(--ink-inv)`, `var(--bg)`, `var(--surface)`, `var(--surface-2)`, `var(--line)`, `var(--line-strong)`, `var(--danger)`. **Never** write `#hexcodes` or `rgb()` literals for foreground/background/border.',
    '- Accent indirection: paint with `var(--_accent)` (resolves the appColor knob over `--accent`) wherever the accent shows; `--sel`/`--selb` for selection tint/border.',
    '- Radii: `var(--r-sm)`, `var(--r-md)`, `var(--r-card)`, `var(--r-pill)` — do not pick px values by feel.',
    '- Type: `font: var(--t-title|--t-body|--t-body-strong|--t-small|--t-tiny|--t-mono)` shorthands; mono (`var(--mono)`) for counts, dates, metadata.',
    '- Theme: light/dark flips by `data-theme` on `<html>` — `tokens.css` handles BOTH the explicit attribute and the `prefers-color-scheme` fallback; never write your own dark-theme token blocks. The inline live-settings bridge in the scaffolded `index.html` keeps theme in sync with the shell — do not delete it or move it after the stylesheets.',
    "- Fonts: inherit from `<body>` (`var(--font-sans)` system stack). Don't load web fonts.",
    '',
    'Verbatim token CSS (light + dark) — this is what the shared `tokens.css` resolves to at runtime:',
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
  const inAppIcons = [
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
  ] as const;

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
    '**Card / surface** — wrap in `<div class="surface">` for an elevated panel; the scaffold styles it with `background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--r-card);`.',
  ].join('\n');
}

/**
 * `### UI/UX rules` — the non-negotiables: state triad, a11y floor,
 * viewport contract, plus the snapshot-file convention the desktop
 * uses to feed the live preview back to the agent.
 */
function renderUxRulesBlock(): string {
  const lines = [
    '### UI/UX rules (non-negotiable)',
    '',
    '**Viewport / iframe contract.** Apps render inside a sandboxed iframe at any',
    'of three sizes (mobile ≈ 390px, tablet ≈ 820px, desktop ≈ 1280px). Author',
    "mobile-first; the scaffold's `app.css` already has the breakpoints. Always:",
    '',
    '- Keep the inline live-settings `<script>` block at the top of `<head>` (no `type=module`, no `defer`), **before** the stylesheet — the runtime bakes the initial `data-theme` / `--bg-l` into `<html>`, and this script keeps the iframe in sync with the shell on live pref changes. The scaffold puts this in for you — do not remove it.',
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
    '**Phone-readiness.** The mobile shell is a thin viewer — on the phone the blueprint *is* the UI, so every app must stay fully usable at ~390px:',
    '',
    '- Keep the blueprint kit when the app ships one (`kit.js` / `kit.css` — template clones do): its toasts, confirm-to-act, states, and charts are the shared UX substrate on desktop *and* phone (including native haptics where the bridge exists). Never delete, fork, or stop importing these files.',
    '- Keep the scaffold\'s responsive conventions intact and build on them, never strip them: `viewport-fit=cover` in the `<meta name="viewport">`, the `env(safe-area-inset-*)` body padding, the single 720px breakpoint, the ≥ 44px hit targets, and the `prefers-reduced-motion` guard.',
    '',
    '**Forms.** Always `<label for="...">` (or `aria-label`); `autocomplete=`, `enterkeyhint=`, and `inputmode=` set appropriately. Disabled submit until the input has content.',
    '',
    '**CSS discipline.** No `!important`. No deep selectors (`> > >`). No inline styles unless dynamic. No `font-family` overrides — the system stack from the scaffold is the contract.',
  ];

  lines.push(
    '',
    '**Visual feedback (preview snapshot).** The desktop shell keeps a fresh PNG',
    'of the live preview iframe at `./.preview/snapshot.png` (cwd-relative — it',
    'lives at the app root). After any meaningful CSS or layout change,',
    'open the snapshot with your native file-reading tool and treat it like a code',
    'review comment — fix what looks wrong before moving on. Use `centraid preview',
    "snapshot` to check freshness (size + age in JSON) when you're unsure whether",
    'the file has caught up to your last write. One look per coherent visual change',
    "is the right cadence; don't spam it.",
  );

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
    'When unsure about a pattern, read the bundled blueprint apps — they are the',
    'canonical references for what a well-grounded centraid app looks like.',
    'They are written in the **Lit dialect** (`app.js` + `./lit-core.min.js`):',
    '',
    '- `@centraid/blueprints/apps/tasks/` — the tightest list/board example. Use this as the visual baseline for list-style apps. Notice the inline live-settings `<script>` at the top of `<head>`, the kit.css primitives (`.kit-btn`, `.kit-chip`, `.kit-banner`), the `#consentBanner` denied-state pattern, and how it never hardcodes a color.',
    '- `@centraid/blueprints/apps/notes/` — a richer "compose + browse" surface (editor, list, autosave). Use for any app with that rhythm.',
    '',
    'For a **React** app (`app.jsx`, the default for new apps), the scaffolded `app.jsx` you start from is the canonical shape: createRoot at the bottom, one App component owning the loading/error/denied triad, `window.centraid.onChange(refresh)` in an effect, kit.css classes via `className=`.',
    '',
    "You can read the blueprints directly via the bash tool, e.g. `cat ../../packages/blueprints/apps/tasks/app.css` from an app root that lives under the same workspace. If you can't reach them (paths vary by environment), the component primitives block above captures the load-bearing pieces.",
  ].join('\n');
}
