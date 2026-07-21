// Pure, dependency-free translation of the blueprint kit's `tokens.css`
// (a flat set of CSS custom properties) into React-Native-shaped values.
//
// tokens.css is authored for the browser: colors are `hsl(var(--app-hue) …)`
// with `calc()` and `color-mix()`, radii are `px`/`rem`, and fonts are system
// stacks. RN needs concrete `#rrggbb`/`rgba()` colors, unit-less numbers, and
// the loaded @expo-google-fonts family names. This module does that lowering:
//
//   • resolves `var()` (with fallbacks) and simple `calc(a ± b%)`,
//   • converts `hsl()` (space syntax, optional `/ alpha`) → hex / rgba,
//   • keeps hex/rgba as-is,
//   • skips anything that can't map cleanly (color-mix, gradients, box
//     shadows, font shorthands, tracking) rather than emitting garbage.
//
// It is intentionally NOT a general CSS engine — tokens.css is flat custom
// properties, so a handful of regexes cover it. `scripts/generate-theme.ts`
// wraps these functions with file I/O; `generate.test.ts` exercises them.

/** The three font roles the kit exposes, mapped to the loaded native families.
 *  tokens.css uses system stacks for these (it renders in a sandboxed iframe
 *  with no font loading); the native app DOES load Geist / Space Grotesk /
 *  JetBrains Mono, so we map the same three roles onto those families. Keep
 *  in sync with the `useFonts(...)` call in App.tsx. */
const FONT_ROLES = {
  sans: { regular: 'Geist_400Regular', medium: 'Geist_500Medium', semibold: 'Geist_600SemiBold' },
  title: { medium: 'SpaceGrotesk_500Medium', semibold: 'SpaceGrotesk_600SemiBold' },
  mono: {
    regular: 'JetBrainsMono_400Regular',
    medium: 'JetBrainsMono_500Medium',
    semibold: 'JetBrainsMono_600SemiBold',
  },
} as const;

// tokens.css has no spacing scale — spacing is a mobile concern the kit never
// defined. Use the design system's regular density scale (see
// packages/design-tokens/src/density.ts) so mobile matches everything else.
const SPACING = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48 } as const;

// Dark `--bg` is `var(--bg-wall)`, which the browser host supplies at runtime
// and tokens.css never defines. Substitute a concrete dark wall derived from
// the same hue/lightness knobs so the native theme has a real background.
const BG_WALL_FALLBACK = 'hsl(var(--app-hue) 12% var(--bg-l))';

export interface TokenBlocks {
  /** `:root { … }` — the light defaults. */
  light: Record<string, string>;
  /** `:root[data-theme='dark'] { … }` — dark overrides only. */
  darkOverride: Record<string, string>;
}

export interface GeneratedTheme {
  light: Record<string, string>;
  dark: Record<string, string>;
  radii: Record<string, number>;
  spacing: typeof SPACING;
  fonts: typeof FONT_ROLES;
}

/** Extract the `--name: value;` pairs from a single `{ … }` block body. */
function parseDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of body.split(';')) {
    const m = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(decl);
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Pull the light `:root` and dark `:root[data-theme='dark']` blocks. The
 *  `prefers-color-scheme` media block is ignored — it duplicates the dark
 *  overrides, which we already read from the attribute selector. */
export function parseTokensCss(css: string): TokenBlocks {
  // `[^}]*` is safe: these blocks contain no nested braces.
  const light = /:root\s*\{([^}]*)\}/.exec(css);
  const dark = /:root\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(css);
  return {
    light: light?.[1] !== undefined ? parseDeclarations(light[1]) : {},
    darkOverride: dark?.[1] !== undefined ? parseDeclarations(dark[1]) : {},
  };
}

/** Index of the first top-level (paren-depth 0) comma, or -1. */
function topLevelComma(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) return i;
  }
  return -1;
}

/** Recursively replace `var(--x[, fallback])` using `scope`, honoring the
 *  fallback (which may itself contain `var()`). Unresolved refs become ''. */
function resolveVars(input: string, scope: Record<string, string>, seen: Set<string>): string {
  let s = input;
  for (;;) {
    const idx = s.indexOf('var(');
    if (idx === -1) break;
    // Match the paren that opens right after `var`.
    let depth = 0;
    let end = -1;
    for (let k = idx + 3; k < s.length; k++) {
      if (s[k] === '(') depth++;
      else if (s[k] === ')') {
        depth--;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    if (end === -1) break; // malformed — leave as-is so it fails color parsing
    const inner = s.slice(idx + 4, end);
    const comma = topLevelComma(inner);
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();

    let replacement = '';
    if (scope[name] !== undefined && !seen.has(name)) {
      replacement = resolveVars(scope[name], scope, new Set([...seen, name]));
    } else if (fallback !== undefined) {
      replacement = resolveVars(fallback, scope, seen);
    }
    s = s.slice(0, idx) + replacement + s.slice(end + 1);
  }
  return s;
}

/** Evaluate simple `calc(a ± b)` where a/b are numbers with a shared unit
 *  (only `%` appears in tokens.css). Repeats until no `calc(` remains. */
function evalCalc(input: string): string {
  let s = input;
  const re = /calc\(\s*(-?[\d.]+)(%?)\s*([+-])\s*(-?[\d.]+)(%?)\s*\)/;
  for (;;) {
    const m = re.exec(s);
    if (!m) break;
    const a = parseFloat(m[1] ?? '0');
    const b = parseFloat(m[4] ?? '0');
    const unit = m[2] || m[5] || '';
    const val = m[3] === '+' ? a + b : a - b;
    s = s.slice(0, m.index) + `${val}${unit}` + s.slice(m.index + m[0].length);
  }
  return s;
}

/** Fully resolve a raw token value against a scope (vars then calc). */
function resolveValue(raw: string, scope: Record<string, string>): string {
  return evalCalc(resolveVars(raw, scope, new Set())).trim();
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g] = [c, x];
  else if (hp < 2) [r, g] = [x, c];
  else if (hp < 3) [g, b] = [c, x];
  else if (hp < 4) [g, b] = [x, c];
  else if (hp < 5) [r, b] = [x, c];
  else [r, b] = [c, x];
  const m = l - c / 2;
  return [clampByte((r + m) * 255), clampByte((g + m) * 255), clampByte((b + m) * 255)];
}

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function roundAlpha(a: number): number {
  return Math.round(a * 1000) / 1000;
}

/** A resolved value → an RN color string, or null if it isn't a plain color
 *  RN can consume (color-mix, gradients, unresolved vars, etc. → null). */
export function cssColorToRn(resolved: string): string | null {
  const v = resolved.trim();
  if (!v) return null;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return (
      '#' +
      v
        .slice(1)
        .replace(/./g, (c) => c + c)
        .toLowerCase()
    );
  }
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^rgba?\([^)]*\)$/.test(v)) return v;

  const hsl = /^hsla?\(\s*([^)]*)\)$/.exec(v);
  if (hsl?.[1] !== undefined) {
    const segments = hsl[1].split('/').map((p) => p.trim());
    const parts = (segments[0] ?? '').split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0] ?? '');
    const s = parseFloat(parts[1] ?? '') / 100;
    const l = parseFloat(parts[2] ?? '') / 100;
    if ([h, s, l].some((n) => Number.isNaN(n))) return null;
    const alphaPart = segments[1];
    const alpha = alphaPart !== undefined && alphaPart !== '' ? parseFloat(alphaPart) : 1;
    const [r, g, b] = hslToRgb(h, s, l);
    if (Number.isNaN(alpha) || alpha >= 1) return toHex(r, g, b);
    return `rgba(${r}, ${g}, ${b}, ${roundAlpha(alpha)})`;
  }
  return null;
}

/** A resolved length (`14px`, `0.75rem`) → pixels, or null. rem = 16px. */
export function cssLengthToPx(resolved: string): number | null {
  const px = /^(-?[\d.]+)px$/.exec(resolved.trim());
  if (px?.[1] !== undefined) return parseFloat(px[1]);
  const rem = /^(-?[\d.]+)rem$/.exec(resolved.trim());
  if (rem?.[1] !== undefined) return parseFloat(rem[1]) * 16;
  return null;
}

/** `--ink-2` → `ink2`, `--bg-elev` → `bgElev`, `--on-accent` → `onAccent`. */
function camelKey(name: string): string {
  return name.replace(/^--/, '').replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** `--r-card` → `card`, `--radius-sm` → `radiusSm` (drop the `r-` prefix). */
function radiusKey(name: string): string {
  return camelKey(name.replace(/^--r-/, '--'));
}

// Internal (`--_accent`) and swatch (`--c-amber`) vars are excluded from the
// neutral/semantic palette: the former is a plumbing alias, the latter are the
// app-icon hues already owned by @centraid/design-tokens' `palette`.
function isPaletteCandidate(name: string): boolean {
  return !name.startsWith('--_') && !name.startsWith('--c-');
}

function isRadiusName(name: string): boolean {
  return name.startsWith('--r-') || name === '--radius' || name.startsWith('--radius-');
}

export function buildTheme(css: string): GeneratedTheme {
  const { light, darkOverride } = parseTokensCss(css);
  const lightScope = light;
  const darkScope: Record<string, string> = {
    '--bg-wall': BG_WALL_FALLBACK,
    ...light,
    ...darkOverride,
  };

  const lightColors: Record<string, string> = {};
  const radii: Record<string, number> = {};
  // Preserve the source→key mapping so dark can re-resolve the same tokens.
  const colorTokens: { name: string; key: string; lightValue: string }[] = [];

  for (const name of Object.keys(light)) {
    const raw = light[name];
    if (raw === undefined) continue;
    if (isRadiusName(name)) {
      const px = cssLengthToPx(resolveValue(raw, lightScope));
      if (px !== null) radii[radiusKey(name)] = px;
      continue;
    }
    if (!isPaletteCandidate(name)) continue;
    const color = cssColorToRn(resolveValue(raw, lightScope));
    if (color !== null) {
      const key = camelKey(name);
      lightColors[key] = color;
      colorTokens.push({ name, key, lightValue: color });
    }
  }

  const darkColors: Record<string, string> = {};
  for (const { name, key, lightValue } of colorTokens) {
    const raw = darkScope[name] ?? light[name];
    const color = raw === undefined ? null : cssColorToRn(resolveValue(raw, darkScope));
    // Fall back to the light value if a dark token resolves to something
    // non-color (keeps light/dark key sets identical).
    darkColors[key] = color ?? lightValue;
  }

  return { light: lightColors, dark: darkColors, radii, spacing: SPACING, fonts: FONT_ROLES };
}

// ---- Rendering ----

function sortedEntries<T>(obj: Record<string, T>): [string, T][] {
  return Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// Emit in the repo's formatter style (bare identifier keys, single-quoted
// strings) so `bun run generate:theme` followed by `bun run format` is a
// no-op — otherwise every regeneration would show a spurious quoting diff.
function keyLiteral(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : `'${k}'`;
}

function stringLiteral(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function renderRecord(obj: Record<string, string | number>, indent: string): string {
  return sortedEntries(obj)
    .map(([k, v]) => `${indent}${keyLiteral(k)}: ${typeof v === 'number' ? v : stringLiteral(v)},`)
    .join('\n');
}

function renderFonts(indent: string): string {
  const lines: string[] = [];
  for (const [role, weights] of sortedEntries(
    FONT_ROLES as unknown as Record<string, Record<string, string>>,
  )) {
    lines.push(`${indent}${role}: {`);
    lines.push(renderRecord(weights, indent + '  '));
    lines.push(`${indent}},`);
  }
  return lines.join('\n');
}

/** Render the checked-in `tokens.generated.ts` source. Deterministic:
 *  every object has alphabetically sorted keys, so regeneration is diff-clean. */
export function renderTokensModule(theme: GeneratedTheme, sourcePath: string): string {
  return `// GENERATED — do not edit by hand.
// Source: ${sourcePath}
// Regenerate: bun run generate:theme
//
// React-Native theme tokens lowered from the blueprint kit's tokens.css.
// See src/theme/generate.ts for the translation rules.

export const lightPalette = {
${renderRecord(theme.light, '  ')}
} as const;

export const darkPalette = {
${renderRecord(theme.dark, '  ')}
} as const;

export const radii = {
${renderRecord(theme.radii, '  ')}
} as const;

export const spacing = {
${renderRecord(theme.spacing as unknown as Record<string, number>, '  ')}
} as const;

export const fonts = {
${renderFonts('  ')}
} as const;

`;
}
