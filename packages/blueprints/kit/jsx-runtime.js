// Hand-authored — NOT generated, do not run vendor-react.mjs over this file.
//
// The gateway's serve-time JSX transform runs esbuild with
// `jsx: 'automatic', jsxImportSource: '.'`. For any app source file that
// contains JSX, esbuild's automatic runtime emits an import of the form
// `import { jsx, jsxs } from "./jsx-runtime"` (plus `Fragment` when the file
// uses `<>...</>`), resolved relative to the importing file's directory. The
// gateway then rewrites that bare `./jsx-runtime` specifier to the concrete
// same-origin asset `./jsx-runtime.js` (same trick as `import './kit.js'`),
// and this is the file that request lands on.
//
// This file must *re-export*, never re-bundle, from `react-core.min.js`:
// `react-core.min.js` already contains the one vendored copy of React (and
// ReactDOM) that `kit.js` / app code imports directly. If this file bundled
// its own copy of `react/jsx-runtime` instead of pointing at that same
// module, the page would load two independent React instances — jsx() calls
// from one would build elements that createRoot() from the other doesn't
// recognize as its own, and the smoke test's `jsx === bundle.jsx` referential
// check pins exactly this.
export { Fragment, jsx, jsxs } from './react-core.min.js';
