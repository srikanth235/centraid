// Ambient types for co-located CSS Modules in the blueprint apps (the
// TS + CSS-modules conversion). Mirrors packages/client/src/react/css-modules.d.ts.
// The serve pipeline resolves a `*.module.css` import to a map of authored
// class name → local export (esbuild local-css, no localsConvention transform —
// authored names ARE the keys). tsc needs this declaration to typecheck the
// `import styles from './X.module.css'` sites. A broad `Record<string, string>`
// keeps the declaration shared across every component module without generating
// a per-file `.d.ts`.
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
