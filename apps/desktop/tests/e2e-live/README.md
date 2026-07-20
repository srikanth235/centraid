# e2e-live (exploratory / manual)

**Canonical desktop e2e is `apps/desktop/tests/e2e/*.spec.ts`** (Playwright
`_electron`), owned by the nightly suite and path-filtered PR job — see
[TESTING.md](../../../../TESTING.md). That is the source of truth (issue #468 L3).

This directory is a **manual / exploratory** harness against the real app
(real gateway, real vault). It is not wired into CI. The former ~76 unreferenced
flow/verify scripts were deleted under L4; git history retains them.

## Keep

| Script | Role |
| --- | --- |
| `driver.mjs` | Launch helpers for manual probes |
| `smoke.mjs` | Golden path: Home → Discover → Home |
| `iframe-probe.mjs` | Drive an app iframe after install |

## Build + run

```sh
bun run build --filter=@centraid/desktop
node apps/desktop/tests/e2e-live/smoke.mjs
```

Screenshots land in `out/` (gitignored).
