# Visual verification harness (dev-only)

Serves `docs`/`photos` through the real `serveStatic` (esbuild JSX transform,
kit shared-asset fallback, CSP+nonce) with a mocked `window.centraid` — zero
gateway/vault. Never wired into the shipped runtime.

Run:

```
bun packages/blueprints/visual-harness/server.mjs
```

or via the `visual-harness` launch.json config (port 4173).

URLs:

- http://localhost:4173/centraid/docs/
- http://localhost:4173/centraid/photos/

Knobs (combine freely):

- `?empty=1` — every collection empty (empty-state verification)
- `?denied=1` — every read returns `{ vaultDenied: { message: 'Grant revoked.' } }` (consent-banner verification)
- `#theme=dark&bgL=10` — read by the app's own inline settings bridge already baked into `index.html`, not by this harness

Devtools escape hatch: `window.__fixtures.state` (current store), `.reset()`, `.fireChange()`.
