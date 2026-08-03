# Centraid City

An explorable 3D model of how the Centraid gateway works, in the spirit of [PGSimCity](https://nikolays.github.io/PGSimCity/). Eleven districts map the real architecture — Client Approach → Gateway Plaza → Agent Runtime Row → Consent Gate → Vault Excavation + WAL Works → App Blueprint Quarter, Automation Yard, Blob CAS Warehouse, Sync Harbor (with a detached replica island), Backup Vaults — with animated particle flows, a live simulated HUD, a clickable inspector (with real `codeRef` pointers into `packages/`), a 10-chapter guided tour following one user message end-to-end, 7 scenarios, and a day/night toggle.

## Run

```bash
python3 -m http.server 8799 --directory centraid-city
```

then open http://localhost:8799/. Static bundle, no build step, no network (three.js r180 vendored in `vendor/`).

## Camera

Map conventions, not model-viewer ones: **left-drag pans** (grab the ground and move it), **Shift/Ctrl/Cmd + left-drag orbits**, right-drag orbits, middle-drag pans, wheel zooms. Click a building or plate to open the inspector; "Reset view" returns home.

## Layout

- `content.js` — single source of truth for the city plan, all copy, tour, scenarios
- `world.js` — geometry, districts, buildings, roads, sky, particle flows
- `sim.js` — 10 Hz seeded simulation driving stats, flow rates, and scenario effects
- `ui.js` / `index.html` — HUD, inspector, contents + chapter card, minimap, loading screen

Centraid City is an illustrative model; details simplified.
