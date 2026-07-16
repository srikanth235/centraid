import { describe, expect, it } from 'vitest';
import {
  buildTheme,
  cssColorToRn,
  cssLengthToPx,
  parseTokensCss,
  renderTokensModule,
} from './generate';

// A trimmed stand-in for packages/blueprints/kit/tokens.css that exercises
// every translation path: hsl+var, alpha, calc, var-with-fallback, aliases,
// color-mix (skip), swatch (skip), internal var (skip), radii, and a dark
// override that references the undefined --bg-wall.
const FIXTURE = `
:root {
  --app-hue: 222;
  --accent: #4E68DD;
  --c-teal: #2EA098;
  --_accent: var(--app-color, var(--accent));
  --ink: hsl(var(--app-hue) 22% 13%);
  --ink-2: hsl(var(--app-hue) 9% 41%);
  --bg: hsl(var(--app-hue) 20% 98%);
  --surface: #ffffff;
  --bg-elev: var(--surface);
  --line: hsl(var(--app-hue) 19% 13% / 0.095);
  --accent-soft: color-mix(in oklab, var(--_accent) 12%, transparent);
  --r-card: 14px;
  --r-sm: 6px;
  --radius: 0.75rem;
  --shadow-sm: 0 0 0 0.5px var(--line-strong);
  --t-title: 600 1.15rem/1.2 var(--font-title);
}

:root[data-theme='dark'] {
  --bg-l: 10%;
  --ink: hsl(var(--app-hue) 16% 94%);
  --surface: hsl(var(--app-hue) 12% calc(var(--bg-l) + 5%));
  --bg: var(--bg-wall);
}
`;

describe('cssColorToRn', () => {
  it('resolves hsl space syntax to hex', () => {
    expect(cssColorToRn('hsl(0 0% 100%)')).toBe('#ffffff');
    expect(cssColorToRn('hsl(0 0% 0%)')).toBe('#000000');
    expect(cssColorToRn('hsl(0 100% 50%)')).toBe('#ff0000');
    expect(cssColorToRn('hsl(120 100% 50%)')).toBe('#00ff00');
    expect(cssColorToRn('hsl(240 100% 50%)')).toBe('#0000ff');
  });

  it('resolves hsl with an alpha channel to rgba', () => {
    expect(cssColorToRn('hsl(0 0% 0% / 0.5)')).toBe('rgba(0, 0, 0, 0.5)');
    expect(cssColorToRn('hsl(0 0% 100% / 1)')).toBe('#ffffff');
  });

  it('normalizes hex and passes rgba through', () => {
    expect(cssColorToRn('#4E68DD')).toBe('#4e68dd');
    expect(cssColorToRn('#abc')).toBe('#aabbcc');
    expect(cssColorToRn('rgba(1, 2, 3, 0.4)')).toBe('rgba(1, 2, 3, 0.4)');
  });

  it('skips values RN cannot consume', () => {
    expect(cssColorToRn('color-mix(in oklab, red 12%, transparent)')).toBeNull();
    expect(cssColorToRn('linear-gradient(180deg, #000, #fff)')).toBeNull();
    expect(cssColorToRn('var(--nope)')).toBeNull();
    expect(cssColorToRn('')).toBeNull();
  });
});

describe('cssLengthToPx', () => {
  it('reads px directly and converts rem at 16px', () => {
    expect(cssLengthToPx('14px')).toBe(14);
    expect(cssLengthToPx('0.75rem')).toBe(12);
    expect(cssLengthToPx('0.5rem')).toBe(8);
    expect(cssLengthToPx('nope')).toBeNull();
  });
});

describe('parseTokensCss', () => {
  it('splits the light root and dark override blocks', () => {
    const { light, darkOverride } = parseTokensCss(FIXTURE);
    expect(light['--accent']).toBe('#4E68DD');
    expect(light['--app-hue']).toBe('222');
    expect(darkOverride['--bg-l']).toBe('10%');
    // Dark override only carries what it changes.
    expect(darkOverride['--accent']).toBeUndefined();
  });
});

describe('buildTheme', () => {
  const theme = buildTheme(FIXTURE);

  it('extracts resolved light colors', () => {
    expect(theme.light.accent).toBe('#4e68dd');
    expect(theme.light.ink).toMatch(/^#[0-9a-f]{6}$/);
    expect(theme.light.bgElev).toBe('#ffffff'); // var(--surface)
    expect(theme.light.line).toMatch(/^rgba\(/); // alpha → rgba
  });

  it('skips color-mix, swatch, and internal vars', () => {
    expect(theme.light.accentSoft).toBeUndefined();
    expect(theme.light.cTeal).toBeUndefined();
    expect(theme.light.Accent).toBeUndefined();
    // Non-color declarations never appear.
    expect(theme.light.shadowSm).toBeUndefined();
    expect(theme.light.tTitle).toBeUndefined();
  });

  it('resolves dark overrides, including calc and the --bg-wall fallback', () => {
    expect(theme.dark.ink).not.toBe(theme.light.ink);
    expect(theme.dark.surface).toMatch(/^#[0-9a-f]{6}$/); // calc(10% + 5%)
    expect(theme.dark.bg).toBe('#16181d'); // var(--bg-wall) fallback → hsl(222 12% 10%)
  });

  it('keeps light and dark key sets identical', () => {
    expect(Object.keys(theme.dark).sort()).toEqual(Object.keys(theme.light).sort());
  });

  it('lowers radii, dropping the r- prefix', () => {
    expect(theme.radii.card).toBe(14);
    expect(theme.radii.sm).toBe(6);
    expect(theme.radii.radius).toBe(12);
  });

  it('exposes the spacing scale and font role mapping', () => {
    expect(theme.spacing[4]).toBe(16);
    expect(theme.fonts.sans.regular).toBe('Geist_400Regular');
    expect(theme.fonts.title.semibold).toBe('SpaceGrotesk_600SemiBold');
    expect(theme.fonts.mono.medium).toBe('JetBrainsMono_500Medium');
  });
});

describe('renderTokensModule', () => {
  const theme = buildTheme(FIXTURE);

  it('is deterministic across runs', () => {
    const a = renderTokensModule(theme, 'src.css');
    const b = renderTokensModule(theme, 'src.css');
    expect(a).toBe(b);
  });

  it('sorts palette keys alphabetically', () => {
    const out = renderTokensModule(theme, 'src.css');
    const block = /export const lightPalette = \{([\s\S]*?)\} as const;/.exec(out)?.[1] ?? '';
    const keys = [...block.matchAll(/^\s*([A-Za-z0-9_$]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual([...keys].sort());
    expect(keys.length).toBeGreaterThan(0);
  });

  // The generator writes a checked-in file that `bun run format` also touches;
  // emitting formatter-shaped source keeps regeneration from churning quotes.
  it('emits formatter-shaped literals (bare keys, single quotes)', () => {
    const out = renderTokensModule(theme, 'src.css');
    expect(out).toContain("accent: '#4e68dd',");
    expect(out).toContain("'1': 4,"); // numeric keys need quoting
    expect(out).not.toContain('"accent"');
  });

  it('emits the generated header and font families', () => {
    const out = renderTokensModule(theme, 'packages/blueprints/kit/tokens.css');
    expect(out).toContain('GENERATED — do not edit');
    expect(out).toContain('packages/blueprints/kit/tokens.css');
    expect(out).toContain('export const lightPalette');
    expect(out).toContain('Geist_400Regular');
  });
});
