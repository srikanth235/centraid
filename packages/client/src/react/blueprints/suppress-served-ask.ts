// Side-effect module: neutralise kit.js's auto-mounting "Ask" IIFE before the
// kit module is evaluated inline.
//
// packages/blueprints/kit/kit.js ends in an IIFE that, at module-eval time,
// calls `init()` — which appends an "Ask" button + panel to `[data-ask-mount]`
// or, failing that, to `document.body`, and drives itself with relative
// `<app>/_turn` fetches that only resolve on the served (same-origin) path.
// Inline in the shell that would inject a stray button into the shell document
// and issue broken requests. `init()` early-returns when `window.kitAsk` is
// already set, so setting a sentinel here — evaluated BEFORE the kit module
// because kit-inline.ts imports this first — suppresses the served ask entirely.
// The real inline ask panel is installed separately by kit-ask-inline.ts.
if (typeof window !== 'undefined') {
  const w = window as unknown as { kitAsk?: unknown };
  if (!w.kitAsk) w.kitAsk = { inlineSuppressed: true };
}
