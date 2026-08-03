# Centraid City

An explorable 3D model of how the Centraid gateway works, in the spirit of [PGSimCity](https://nikolays.github.io/PGSimCity/). Eleven districts map the real architecture — Client Approach → Gateway Plaza → Agent Runtime Row → Consent Gate → Vault Excavation + WAL Works → App Blueprint Quarter, Automation Yard, Blob CAS Warehouse, Sync Harbor (with a detached replica island), Backup Vaults — with animated particle flows, a live simulated HUD, a clickable inspector (with real `codeRef` pointers into `packages/`), a 10-chapter guided tour following one user message end-to-end, 7 scenarios, and a day/night toggle.

## Run

```bash
bun install --cwd centraid-city
bun run --cwd centraid-city dev
```

Then open the Vite URL (normally http://127.0.0.1:5173/). For a production-like static bundle, run `bun run --cwd centraid-city build` and serve `dist/`. The browser app makes no runtime network requests; three.js and its typings are installed from `centraid-city/package.json` and bundled by Vite.

## Camera

Map conventions, not model-viewer ones: **left-drag pans** (grab the ground and move it), **Shift/Ctrl/Cmd + left-drag orbits**, right-drag orbits, middle-drag pans, wheel zooms. Click a building or plate to open the inspector; "Reset view" returns home.

## Layout

The package follows the same boundary that makes [PGSimCity](https://github.com/NikolayS/PGSimCity) easy to extend: shared contracts in `src/core`, a renderer-independent `src/sim`, Three.js geometry and geography in `src/world`, browser controls in `src/ui`, and one thin `src/main.ts` entrypoint.

- `src/core/content.ts` — single source of truth for the city plan, copy, tour, and scenarios
- `src/core/types.ts` — contracts shared by content, simulation, world, and UI
- `src/sim/sim.ts` — 10 Hz seeded simulation; it does not import Three.js
- `src/world/` — geometry, districts, buildings, roads, sky, particle flows, and landmark kit
- `src/ui/ui.ts` / `index.html` — HUD, inspector, contents + chapter card, minimap, loading screen
- `package.json` — owns the `three` runtime dependency; Vite bundles it into the static output

Centraid City is an illustrative model; details simplified.
