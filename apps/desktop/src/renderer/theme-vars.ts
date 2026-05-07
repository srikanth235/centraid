// Writes CSS custom properties from @centraid/design-tokens onto :root.
// Loaded before any other renderer script, so by the time styles.css is
// resolved against actual elements, every var() lookup has a value.
//
// What lives here vs in styles.css:
// - HERE: anything that is also a token consumed by mobile (palette, accent,
//   surfaces, ink, lines, radii, spacing). One source of truth.
// - styles.css: font-family stacks (Electron-only fallback chain) and
//   compound presentational values (shadows, --device-wall gradient).

(function () {
  const tokens = window.CentraidTokens;
  if (!tokens) {
    console.error('CentraidTokens missing — theme-vars cannot apply.');
    return;
  }
  const root = document.documentElement;
  const set = (name: string, value: string): void => {
    root.style.setProperty(name, value);
  };

  set('--accent', String(tokens.colors.accent));

  for (const [k, v] of Object.entries(tokens.palette)) {
    set(`--c-${k}`, String(v));
  }
  for (const [k, v] of Object.entries(tokens.radii)) {
    set(`--r-${k}`, `${v}px`);
  }
  for (const [k, v] of Object.entries(tokens.spacing)) {
    set(`--d-${k}`, `${v}px`);
  }

  const c = tokens.colors as Record<string, string>;
  set('--bg', c.bg);
  set('--bg-elev', c.bgElev);
  set('--bg-sunken', c.bgSunken);
  set('--bg-app', c.bgApp);
  set('--ink', c.ink);
  set('--ink-2', c.ink2);
  set('--ink-3', c.ink3);
  set('--ink-4', c.ink4);
  set('--ink-inv', c.inkInv);
  set('--line', c.line);
  set('--line-strong', c.lineStrong);
})();
