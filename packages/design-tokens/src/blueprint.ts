// Centraid — blueprint-app token layer.
//
// Blueprint apps (packages/blueprints/apps/*) are sandboxed iframe apps with
// their OWN design language — a "field notebook" look: per-app hue-tinted
// neutrals parameterized by a single `--app-hue` knob, rather than the
// desktop shell's fixed palette. This is deliberately NOT `toCss()` (the
// desktop's token generator): the desktop's `fontStacks` (Geist / Space
// Grotesk) can't load inside a sandboxed app iframe with no font-loading
// affordance, so this module hand-rolls system font stacks instead, and the
// color system is built around a hue variable the apps retune rather than
// the desktop's fixed theme presets.
//
// `toBlueprintCss()` is consumed as the generated `packages/blueprints/
// kit/tokens.css` (see packages/blueprints/scripts/vendor-tokens.mjs). Each
// blueprint app's own `app.css` loads AFTER this file in the served
// cascade and sets `--app-hue` + `--accent` (and may override individual
// tokens) to retune the whole surface — this file only supplies defaults.
//
// Ground truth for the concrete values below: the 8 apps' own app.css
// :root/dark blocks converged on near-identical formulas by hand (see
// packages/blueprints/apps/docs/app.css and .../photos/app.css); this module
// generalizes that convergence into one hue-parameterized source so future
// apps (and a future re-vendor) don't have to re-derive it per app.

import { palette } from './palette';
import { radii } from './radii';

function block(selector: string, props: Record<string, string>): string {
  const lines: string[] = [`${selector} {`];
  for (const [k, v] of Object.entries(props)) {
    lines.push(`  ${k}: ${v};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function indentBlockBody(props: Record<string, string>, indent: string): string {
  return Object.entries(props)
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join('\n');
}

/** Light (default) tokens — see the file header for how these are grounded. */
function lightProps(): Record<string, string> {
  const props: Record<string, string> = {
    // Apps override this — it drives every neutral below via hsl(var(--app-hue) …).
    '--app-hue': '222',

    // Faces — system stacks only; see file header for why (sandboxed iframe,
    // no font loading). Deliberately NOT the desktop's `fontStacks`.
    '--font-sans': "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    '--font-title': 'var(--font-sans)',
    '--mono':
      "ui-monospace, 'SF Mono', 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace",

    // Identity accent — apps override with one of the --c-* palette values below.
    '--accent': palette.indigo,
  };

  // The 8 app-icon palette hexes, as --c-<name> (no --icon-* alias here —
  // that's a desktop-only bridge name; blueprint apps never consumed it).
  for (const [name, hex] of Object.entries(palette)) {
    props[`--c-${name}`] = hex;
  }

  Object.assign(props, {
    '--on-accent': '#ffffff',
    '--_accent': 'var(--app-color, var(--accent))',
    '--accent-soft': 'color-mix(in oklab, var(--_accent) 12%, transparent)',
    '--accent-deep': 'color-mix(in oklab, var(--_accent) 80%, hsl(var(--app-hue) 45% 7%))',
    '--sel': 'var(--accent-soft)',
    '--selb': 'color-mix(in oklab, var(--_accent) 34%, var(--line-strong))',

    // Ink.
    '--ink': 'hsl(var(--app-hue) 22% 13%)',
    '--ink-2': 'hsl(var(--app-hue) 9% 41%)',
    '--ink-3': 'hsl(var(--app-hue) 8% 58%)',
    '--ink-inv': '#ffffff',
    // Permanent bridge aliases — 4 of the 8 apps use this family (agenda,
    // people, photos, tally) instead of --ink-2/--ink-3 directly.
    '--ink-soft': 'var(--ink-2)',
    '--ink-faint': 'var(--ink-3)',

    // Surfaces — warm-neutral paper base, elevated card, recessed track.
    '--bg': 'hsl(var(--app-hue) 20% 98%)',
    '--surface': '#ffffff',
    '--surface-2': 'hsl(var(--app-hue) 20% 95.5%)',
    // Bridge aliases — the docs-family apps read --bg-elev/--bg-sunken.
    '--bg-elev': 'var(--surface)',
    '--bg-sunken': 'var(--surface-2)',

    '--line': 'hsl(var(--app-hue) 19% 13% / 0.095)',
    '--line-strong': 'hsl(var(--app-hue) 19% 13% / 0.165)',

    '--danger': '#c8382f',

    // Radii — hard-edged cards; buttons/chips are kit pills (kit.css).
    '--r-card': `${radii.xl}px`,
    '--r-md': `${radii.lg}px`,
    '--r-sm': `${radii.md}px`,
    '--r-pill': '999px',
    // Kit contract bridge (toast / skeleton / ask render on-brand).
    '--radius': '0.75rem',
    '--radius-sm': '0.5rem',

    '--ease': 'cubic-bezier(0.2, 0.7, 0.3, 1)',
    '--shadow-sm': '0 0 0 0.5px var(--line-strong)',
    '--shadow-md':
      '0 10px 26px -14px hsl(var(--app-hue) 30% 9% / 0.27), 0 2px 6px -3px hsl(var(--app-hue) 30% 9% / 0.11)',
    '--shadow-lg': '0 26px 60px -24px hsl(var(--app-hue) 30% 9% / 0.39)',

    '--tracking-body': '0',
    '--tracking-h': '-0.01em',
    '--tracking-eyebrow': '0.09em',

    // Type shorthands (font: style weight size/line family) — copied
    // verbatim from packages/blueprints/apps/docs/app.css :root.
    '--t-title': '600 1.15rem/1.2 var(--font-title)',
    '--t-body': '400 0.855rem/1.5 var(--font-sans)',
    '--t-body-strong': '600 0.855rem/1.4 var(--font-sans)',
    '--t-small': '400 0.8rem/1.45 var(--font-sans)',
    '--t-tiny': '600 0.6rem/1.4 var(--mono)',
    '--t-mono': '500 0.72rem/1.4 var(--mono)',

    '--text': 'var(--ink)',
    '--muted': 'var(--ink-2)',
  });

  return props;
}

/**
 * Dark-theme recipe — the ONE map shared verbatim by both the
 * `:root[data-theme='dark']` selector and the `prefers-color-scheme: dark`
 * media-query fallback (see `toBlueprintCss`). Grounded in
 * packages/blueprints/apps/docs/app.css (~L87-129) and .../photos/app.css
 * (~L37-67), generalized by `--app-hue`.
 *
 * Only tokens that actually change between light/dark are listed here;
 * everything else (radii, tracking, type shorthands, --accent itself…)
 * carries over unchanged from the light `:root` block. `--surface`/
 * `--surface-2` are redefined directly (not `--bg-elev`/`--bg-sunken`) to
 * match the alias direction the light block established
 * (`--bg-elev: var(--surface)`); because that alias is a `var()` reference
 * rather than a literal, it re-resolves against the dark `--surface` value
 * automatically without needing its own dark-block entry — same for
 * `--ink-soft`/`--ink-faint` riding `--ink-2`/`--ink-3`, and `--text`/
 * `--muted` riding `--ink`/`--ink-2`.
 */
function darkProps(): Record<string, string> {
  return {
    // Default so a standalone dark app (no host wiring a real value) still
    // resolves every calc() below — docs/photos both set this same default.
    '--bg-l': '10%',

    '--ink': 'hsl(var(--app-hue) 16% 94%)',
    '--ink-2': 'hsl(var(--app-hue) 9% 66%)',
    '--ink-3': 'hsl(var(--app-hue) 9% 50%)',
    '--ink-inv': 'hsl(var(--app-hue) 12% calc(var(--bg-l) + 4%))',

    '--bg': 'var(--bg-wall)',
    '--surface': 'hsl(var(--app-hue) 12% calc(var(--bg-l) + 5%))',
    '--surface-2': 'hsl(var(--app-hue) 11% calc(var(--bg-l) + 9%))',

    '--line': 'hsl(var(--app-hue) 26% 74% / 0.11)',
    '--line-strong': 'hsl(var(--app-hue) 26% 76% / 0.2)',

    '--danger': '#f0645b',

    '--accent-deep': 'color-mix(in oklab, var(--_accent) 82%, hsl(var(--app-hue) 60% 96%))',

    // Shadows are hue-agnostic (pure black in both source apps) — no hue
    // substitution needed, just deeper/darker than the light-mode values.
    '--shadow-md': '0 12px 30px -14px rgba(0, 0, 0, 0.6), 0 2px 8px -3px rgba(0, 0, 0, 0.5)',
    '--shadow-lg': '0 30px 70px -24px rgba(0, 0, 0, 0.7)',
  };
}

/**
 * Returns the full blueprint-app token CSS string: light `:root` defaults,
 * then dark tokens emitted into TWO selector blocks with IDENTICAL bodies
 * (`:root[data-theme='dark']` and the `prefers-color-scheme: dark` media
 * fallback for a standalone app with no explicit theme attribute), built
 * from one shared `darkProps()` map. Emitting both from the same map fixes a
 * latent bug repeated across the hand-written per-app app.css files today:
 * their media-query fallback block hardcoded stale literals (e.g.
 * `--bg-elev: hsl(222 12% 15%)`) instead of the `calc(var(--bg-l) + …)`
 * forms the `[data-theme='dark']` block used, so the two blocks could drift
 * out of sync whenever one was hand-edited and the other wasn't.
 */
export function toBlueprintCss(): string {
  const dark = darkProps();
  const blocks = [
    "/* Generated by @centraid/design-tokens's toBlueprintCss() — do not edit by hand. */",
    block(':root', lightProps()),
    block(":root[data-theme='dark']", dark),
    [
      '@media (prefers-color-scheme: dark) {',
      '  :root:not([data-theme]) {',
      indentBlockBody(dark, '    '),
      '  }',
      '}',
    ].join('\n'),
  ];
  return blocks.join('\n\n') + '\n';
}
