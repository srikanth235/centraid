# Hand-off — the `release.yml` fan-out row for the v1 Companion

`#1020` wave 4, lane extension. `.github/workflows/release.yml` is lane G's file (census §Cross-lane), so this lane ships the workflow and hands over the one row that calls it.

## The patch

`release.yml` already has a `companion` lane that calls `lane-release-companion.yml`, which packages **`apps/extension`** — v0's Companion, with WASM iroh in the service worker. `lane-release-extension.yml` packages `extension/`, the v1 one. Add a second row rather than editing the first, because the two ship on different cadences and v0's is still the one a member has installed:

```yaml
companion-v1:
  needs: plan
  if: >
    needs.plan.outputs.companion == 'true' && (needs.plan.outputs.surfaces == 'all' || needs.plan.outputs.surfaces == 'companion')
  permissions:
    contents: read
  uses: ./.github/workflows/lane-release-extension.yml
```

and add `companion-v1` to `release-check`'s `needs` list, which is the whole point of that job: _a partial release — npm shipped, desktop broken — looked like three greens and one red in four different places, with nothing naming the release itself as bad_.

## The decision that is NOT this lane's

**When `companion` stops calling `lane-release-companion.yml`.** That is the day v0's Companion stops being published, and a member whose browser has the v0 extension installed needs the v1 one to have an enrolled store id first — otherwise the update path is "uninstall and install a different extension". The order is: enrol the ids (owner hand-off 1), ship both for one cycle, then retire v0's row.
