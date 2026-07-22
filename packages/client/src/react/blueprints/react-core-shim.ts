// One React runtime for inline blueprint apps.
//
// Blueprint app source imports `./react-core.min.js` — the vendored, self-
// contained React+ReactDOM bundle the served (iframe/WebView) path loads so
// generated apps run with no build step (see
// packages/blueprints/scripts/vendor-react.mjs). Inline in the shell there must
// be exactly ONE React instance, or hooks throw "invalid hook call" / context
// silently mismatches. The client build rewrites every `react-core.min.js`
// specifier to this shim (see inline-vite-aliases.ts), which re-exports the
// SAME `react` / `react-dom` the shell itself uses — so hook identity is
// preserved (asserted in react-core-shim.test.ts).
//
// The export surface mirrors vendor-react.mjs's entry exactly: everything from
// `react`, `createRoot`/`hydrateRoot` from `react-dom/client`, `flushSync`/
// `createPortal` from `react-dom`, and the automatic-JSX-transform runtime.
// @ts-expect-error (#505) — @types/react is `export =`, which TS forbids re-exporting
// with `export *`. This shim is runtime-only (consumers are blueprint apps whose
// TYPES come from the `react-core.min.js` ambient, not this file), so the wildcard
// re-export is exactly what's wanted at run time.
export * from 'react';
export { createRoot, hydrateRoot } from 'react-dom/client';
export { flushSync, createPortal } from 'react-dom';
export { jsx, jsxs } from 'react/jsx-runtime';
