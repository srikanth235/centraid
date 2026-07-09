// Ambient types for co-located CSS Modules (issue #325, Phase 4 CSS refactor).
// Vite resolves a `*.module.css` import to a map of local class name → scoped
// hash (see vite.config.ts `css.modules`); tsc needs this declaration to
// typecheck the `import styles from './X.module.css'` sites. A broad
// `Record<string, string>` keeps the declaration shared across every component
// module without generating a per-file `.d.ts`.
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
