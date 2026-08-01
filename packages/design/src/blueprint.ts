// Centraid — blueprint-app token layer.
//
// Blueprint surfaces use their OWN design language — a "field notebook" look:
// per-app hue-tinted
// neutrals parameterized by a single `--app-hue` knob, rather than the
// shell's fixed palette. This is deliberately NOT `toCss()` (the shell token
// generator): the portable scaffold and Expo theme need system font stacks,
// and the color system is built around a hue variable rather than the shell's
// fixed theme presets.
//
// `toBlueprintCss()` is consumed directly by the main client, the
// framework-free scaffold generator, and Expo's native-theme generator. Inline
// system apps set their identity overrides in scoped Chrome modules.
//
// Ground truth for the concrete values below: the 8 apps' former app.css
// :root/dark blocks converged on near-identical formulas by hand. Their live
// identity overrides now sit in Chrome.module.css; this module generalizes the
// shared formulas so portable surfaces don't re-derive them per app.

import { paletteText, semanticShade } from "./color";
import { spacing } from "./density";
import { palette } from "./palette";
import { radii } from "./radii";
import { EASE } from "./themes/shared";

function block(selector: string, props: Record<string, string>): string {
  const lines: string[] = [`${selector} {`];
  for (const [k, v] of Object.entries(props)) {
    lines.push(`  ${k}: ${v};`);
  }
  lines.push("}");
  return lines.join("\n");
}

function indentBlockBody(
  props: Record<string, string>,
  indent: string
): string {
  return Object.entries(props)
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join("\n");
}

/** Light (default) tokens — see the file header for how these are grounded. */
function lightProps(): Record<string, string> {
  const props: Record<string, string> = {
    // Apps override this — it drives every neutral below via hsl(var(--app-hue) …).
    "--app-hue": "171",

    // Faces — system stacks only; see file header for why (sandboxed iframe,
    // no font loading). Deliberately NOT the desktop's `fontStacks`.
    "--font-sans":
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    "--font-serif":
      "'New York', 'Iowan Old Style', Georgia, Cambria, ui-serif, serif",
    "--font-title": "var(--font-sans)",
    "--mono":
      "ui-monospace, 'SF Mono', 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace",

    // Identity accent — apps override with one of the --c-* palette values below.
    "--accent": palette.teal,
  };

  // The 8 app-icon palette hexes, as --c-<name> — the one spelling, matching
  // what the shell emits (the old --icon-* alias is gone, #672).
  for (const [name, hex] of Object.entries(palette)) {
    props[`--c-${name}`] = hex;
  }

  // …and the same eight as TEXT. The hexes above are FILLS — `--c-amber` is
  // 2.3:1 as `color:` on this surface — so an app that wants a hue on type
  // reads `--c-<name>-text`, the rung `color.ts` solves per theme. Before this
  // existed, `docs` hand-picked six darker literals for its file-kind labels
  // and #686 replaced them with the raw fills, dropping five of six below AA.
  for (const [name, hex] of Object.entries(paletteText.light)) {
    props[`--c-${name}-text`] = hex;
  }

  Object.assign(props, {
    // Ink for a SATURATED accent or a scrim — the photo lightbox chrome, an
    // `--accent`-filled badge. White in both themes, because those surfaces
    // are dark in both. The ink for `--accent-deep` is `--text-inv`, which
    // flips per theme; the two are different roles (#686 F3).
    "--on-accent": "#ffffff",
    "--_accent": "var(--app-color, var(--accent))",
    "--accent-soft": "color-mix(in oklab, var(--_accent) 12%, transparent)",
    // The accent as a FILLED surface — the one place the accent carries text.
    // 80% measured 3.49:1 under white for `--c-amber` and 3.16:1 for the brand
    // teal: a WCAG 1.4.3 failure at every retuned hue, not just the default.
    // An app moves `--accent`/`--app-color` to any of the eight palette hues,
    // and CSS still has no shipped way to pick ink from a background
    // (`color-contrast()` is unimplemented), so the FILL is the only lever
    // that can be correct for all of them at once. 62% is the largest accent
    // share at which all eight hues plus both teals clear 4.5:1 — the binding
    // hue is the brand teal at 4.86:1, and the deepest, `--c-slate`, still
    // lands at 10.1:1 rather than black. `contrast.test.ts` measures the whole
    // hue × theme grid off this emit.
    "--accent-deep":
      "color-mix(in oklab, var(--_accent) 62%, hsl(var(--app-hue) 45% 6%))",
    "--accent-text": "var(--accent-deep)",
    "--sel": "var(--accent-soft)",
    "--selb": "color-mix(in oklab, var(--_accent) 34%, var(--line-strong))",

    // Text. `--text-faint` is `color:` on captions and metadata in every app,
    // so it has to clear AA against the DARKEST surface it can land on — the
    // `--bg-sunken` recessed track, not just white. 50% lightness put it at
    // 3.35:1 there, below the floor for body text at these sizes; 42% puts it
    // at 4.51:1 on the track and 4.93:1 on white, with `--text-soft` at
    // 5.70/6.22:1, so the three rungs stay visibly distinct from each other
    // and from `--text`. `contrast.test.ts` pins these against the emitted CSS.
    "--text": "hsl(var(--app-hue) 22% 12%)",
    "--text-soft": "hsl(var(--app-hue) 9% 36%)",
    "--text-faint": "hsl(var(--app-hue) 8% 42%)",
    "--text-inv": "#ffffff",
    // Surfaces — warm-neutral paper base, elevated card, recessed track.
    "--bg": "hsl(var(--app-hue) 20% 98%)",
    "--bg-elev": "#ffffff",
    "--bg-sunken": "hsl(var(--app-hue) 20% 95.5%)",
    "--line": "hsl(var(--app-hue) 19% 13% / 0.095)",
    "--line-strong": "hsl(var(--app-hue) 19% 13% / 0.165)",
    "--scrim": "hsl(var(--app-hue) 22% 8% / 0.48)",

    // Semantic states, SOLVED as text rather than hand-picked — see the block
    // comment on `semanticShade()` in color.ts. Apps paint these as `color:`
    // on 10–13px prose (`tasks` flags, `agenda` guest stats, `docs` custody
    // chips, `tally`'s `--pos`/`--neg` aliases), usually on a 12% self-tint,
    // and the hand-picked literals missed AA there: `#9a6b1f` measured 4.13:1
    // on the light track and `#c8382f` 3.86:1 on its own tint. The blueprint
    // bases are solved against the BLUEPRINT surfaces, not the shell's — this
    // ramp's `--bg-l` is 10%, so its darkest surface is much lighter than the
    // shell's 5% one and the two need different answers.
    "--danger": semanticShade("#c8382f", "blueprintLight"),
    "--warning": semanticShade("#9a6b1f", "blueprintLight"),
    "--success": semanticShade("#2f7d4f", "blueprintLight"),

    // Radii — hard-edged cards; buttons/chips are kit pills (kit.css).
    "--r-card": `${radii.xl}px`,
    "--r-md": `${radii.lg}px`,
    "--r-sm": `${radii.md}px`,
    "--r-pill": "999px",
    // Kit contract bridge (toast / skeleton / ask render on-brand).
    "--radius": "0.75rem",
    "--radius-sm": "0.5rem",

    "--ease": EASE,
    "--focus-ring": "0 0 0 3px var(--accent-soft)",
    "--shadow-sm": "0 0 0 0.5px var(--line-strong)",
    "--shadow-md":
      "0 10px 26px -14px hsl(var(--app-hue) 30% 9% / 0.27), 0 2px 6px -3px hsl(var(--app-hue) 30% 9% / 0.11)",
    "--shadow-lg": "0 26px 60px -24px hsl(var(--app-hue) 30% 9% / 0.39)",

    "--tracking-body": "0",
    "--tracking-h": "-0.01em",
    "--tracking-eyebrow": "0.09em",

    // Type shorthands (font: style weight size/line family) retained from the
    // original Docs identity layer.
    "--t-title": "600 1.15rem/1.2 var(--font-title)",
    "--t-body": "400 0.855rem/1.5 var(--font-sans)",
    "--t-body-strong": "600 0.855rem/1.4 var(--font-sans)",
    "--t-small": "400 0.8rem/1.45 var(--font-sans)",
    "--t-tiny": "600 0.6rem/1.4 var(--mono)",
    "--t-mono": "500 0.72rem/1.4 var(--mono)",
  });

  // Fixed spacing scale (density.ts) — apps had no spacing token at all, so
  // every gutter was a hardcoded px literal. Same rungs the shell emits.
  for (const [step, px] of Object.entries(spacing)) {
    props[`--sp-${step}`] = `${px}px`;
  }

  return props;
}

/**
 * Dark-theme recipe — the ONE map shared verbatim by both the
 * `:root[data-theme='dark']` selector and the `prefers-color-scheme: dark`
 * media-query fallback (see `toBlueprintCss`). Grounded in the original Docs
 * and Photos identity layers, generalized by `--app-hue`.
 *
 * Only tokens that actually change between light/dark are listed here;
 * everything else (radii, tracking, type shorthands, --accent itself…)
 * carries over unchanged from the light `:root` block. The semantic surface
 * and text tokens below are direct declarations, so neither emitter carries
 * the old compatibility aliases.
 */
function darkProps(): Record<string, string> {
  const paletteTextDark: Record<string, string> = {};
  // The palette-text rung flips direction per theme: it DEEPENS the hue on a
  // near-white surface and LIFTS it on a near-black one. The fills themselves
  // (`--c-*`) are the same eight hexes in both themes, so only this rung is
  // re-emitted here.
  for (const [name, hex] of Object.entries(paletteText.dark)) {
    paletteTextDark[`--c-${name}-text`] = hex;
  }
  return {
    ...paletteTextDark,
    // Default so a standalone dark app (no host wiring a real value) still
    // resolves every calc() below — docs/photos both set this same default.
    "--bg-l": "10%",

    "--text": "hsl(var(--app-hue) 16% 94%)",
    "--text-soft": "hsl(var(--app-hue) 9% 66%)",
    // 55% cleared AA on the card but only reached 4.05:1 on the `--bg-sunken`
    // track, which carries the same captions. 59% clears both (4.55 / 5.29).
    "--text-faint": "hsl(var(--app-hue) 9% 59%)",
    "--text-inv": "hsl(var(--app-hue) 12% calc(var(--bg-l) + 4%))",

    "--bg": "var(--bg-wall)",
    "--bg-elev": "hsl(var(--app-hue) 12% calc(var(--bg-l) + 5%))",
    "--bg-sunken": "hsl(var(--app-hue) 11% calc(var(--bg-l) + 9%))",

    "--line": "hsl(var(--app-hue) 26% 74% / 0.11)",
    "--line-strong": "hsl(var(--app-hue) 26% 76% / 0.2)",
    "--scrim": "hsl(0 0% 0% / 0.68)",

    // The dark half of the same solve. `#f0645b` was 3.98:1 on the `--bg-sunken`
    // track and 3.44:1 on its own 12% tint — the `agenda` declined-guest chip
    // paints exactly that pairing.
    "--danger": semanticShade("#f0645b", "blueprintDark"),
    "--warning": semanticShade("#e0a94a", "blueprintDark"),
    "--success": semanticShade("#5cc98a", "blueprintDark"),

    // Same role as the light rung — the accent as a FILLED surface — but
    // `--text-inv` is near-black here, so the fill is the LIGHT half of the
    // pair. 82% left the ink at 3.96:1 on `--c-slate`; 70% clears 4.5:1 for
    // every hue (slate is the binding one at 4.89:1) and keeps the fill 4.7:1
    // clear of the card behind it. There is no percentage that would let this
    // ramp carry white ink instead: a fill dark enough for white cannot also
    // separate from a 15%-lightness surface.
    "--accent-deep":
      "color-mix(in oklab, var(--_accent) 70%, hsl(var(--app-hue) 60% 96%))",

    // Shadows are hue-agnostic (pure black in both source apps) — no hue
    // substitution needed, just deeper/darker than the light-mode values.
    "--shadow-md":
      "0 12px 30px -14px rgba(0, 0, 0, 0.6), 0 2px 8px -3px rgba(0, 0, 0, 0.5)",
    "--shadow-lg": "0 30px 70px -24px rgba(0, 0, 0, 0.7)",
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
    "/* Generated by @centraid/design's toBlueprintCss() — do not edit by hand. */",
    block(":root", lightProps()),
    block(":root[data-theme='dark']", dark),
    [
      "@media (prefers-color-scheme: dark) {",
      "  :root:not([data-theme]) {",
      indentBlockBody(dark, "    "),
      "  }",
      "}",
    ].join("\n"),
  ];
  return blocks.join("\n\n") + "\n";
}
