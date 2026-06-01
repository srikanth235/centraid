# issue-151 — land app-engine on its charter

GitHub issue: [#151](https://github.com/srikanth235/centraid/issues/151)

`app-engine` had drifted into a grab-bag. Its charter — restated in #149 —
is narrow: *the per-app engine + the shared agent-run ledger*. But it still
hosted app creation (`scaffold*` / `clone`), gateway-wide reporting
(`analytics-store` / `insights-store`), and identity (`user-store`) — none
of which are per-app engine or the run ledger. This relocates them so the
package boundary matches the charter, in two moves: one rename-and-fold and
one new package.

v0 pre-release: no backward compatibility, no migrations.

## Checklist

- [x] Move A — fold scaffold/clone into renamed `@centraid/app-blueprints`
- [ ] Move B — extract `@centraid/stores` (analytics + insights + identity)

## What changed

### Move A — fold scaffold/clone into renamed `@centraid/app-blueprints`

App creation is *how a new app comes into being*, not *how an app runs*. It
only landed in app-engine as an `agent-harness` refugee (#145) and has zero
coupling to engine core — the six files import only each other, node, and
`@centraid/design-tokens`. Meanwhile the two halves of "instantiate an app"
were split across packages and stitched together by hand in the gateway:
`app-templates` produced the source (`templateSourceDir` / `resolveTemplates`)
and `clone.ts` consumed it. Both depended on only `design-tokens`, so they
fold into one home.

- Renamed `@centraid/app-templates` → `@centraid/app-blueprints` (a blank
  scaffold and a cloned template are both blueprints you instantiate). The
  bundled template gallery + remote-fetch resolver stay; the package now also
  owns blank-app scaffolding.
- Moved `scaffold{,-files,-defaults,-types}.ts`, `clone.ts`, `app-rewrites.ts`
  (+ the `scaffold-files` / `clone` / `update-app-meta` tests) from app-engine
  into app-blueprints and exported them from its barrel. Dropped the
  scaffold/clone re-exports and the now-unused `@centraid/design-tokens`
  dependency from app-engine.
- Repointed consumers: gateway lifecycle routes (merged the templates +
  scaffold imports into a single `@centraid/app-blueprints` import) and
  `automation/scaffold-automation` (split: `isValidAppId` stays on app-engine,
  `AppScaffoldError` / `ScaffoldFile` / `AppInfo` → app-blueprints). Added the
  workspace dependency to gateway + automation.
- Updated `.oxlintrc` ignore paths, the docs, and prose/grounding references
  (skills `ui-grounding`, desktop comments) to the new package name; fixed the
  broken relative links in the issue-64 receipt that pointed at the old path.

Acyclic by construction: app-blueprints depends only on `design-tokens`, and
no app-engine module references the moved files.

## Out of scope

- **Chat** (`chat-history*`, `chat-routes`, `chat-runner`, `chat-transcript`)
  stays in app-engine. A chat turn *is* a `runs` row in the same
  `runtime.sqlite` as the ledger, discriminated by `RunKind` — the
  persistence genuinely is the ledger, which does not move.
- The **runtime** migration ladder in `gateway-db.ts` stays — it is the
  genuine agent-run ledger.
- `deregister-cleanup.ts` stays — registry lifecycle, no DB.
- `model-pricing.ts` stays — frozen into `run_nodes.cost_usd` at write time,
  so it is ledger-internal.

## Verification

- `turbo typecheck` — clean across the graph.
- `turbo test` — app-blueprints 37, automation 59, app-engine 319, gateway 62.
- `oxlint` + `oxfmt --check` — clean.
