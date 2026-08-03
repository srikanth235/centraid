// Centraid — the kit layer's one seam into the rest of the repo.
//
// `packages/design` is the design system in two layers:
//
//   • the TOKEN layer (`src/*`, the package root export) — the typed values
//     and the emitters that turn them into CSS for each surface;
//   • the KIT layer (`kit/*`) — the component substrate every blueprint app
//     loads verbatim: `kit.css`, `kit.ts`, the chart elements, the status
//     line and Ask controllers.
//
// The kit used to live under the blueprints package, which read as "part of
// the app templates" when it is really the shared UI layer the templates sit
// on top of. Since #672 it also holds no design decisions of its own — every
// colour, hairline, radius and face in `kit.css` is a contract token — so the
// two layers belong in one package with one owner.
//
// The kit is SERVED, not imported: the app-engine hands these files to app
// surfaces over HTTP (see `sharedAssetsDir` in app-engine's static server), so
// what the rest of the repo needs from this layer is a path, not a module.

import path from "node:path";

// `__dirname`, not `import.meta.dirname`: this package emits CommonJS (it has
// no `"type": "module"`), and the token layer is consumed by Electron preload
// and the Expo bundler as well as by Node.
const PACKAGE_ROOT = path.resolve(__dirname, "..");

/**
 * Absolute path to the canonical shared kit dir (`kit.ts` / `kit.css`).
 * Apps carry no per-app copies; the app-engine runtime serves these as the
 * fallback for `/centraid/<id>/kit.{js,css}`. Hosts pass this as the
 * runtime's `sharedAssetsDir`.
 */
export const KIT_DIR: string = path.join(PACKAGE_ROOT, "kit");
