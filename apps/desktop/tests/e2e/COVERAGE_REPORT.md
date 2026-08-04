# Desktop E2E coverage

_Updated: 2026-08-01. Scope: `apps/desktop` (Electron)._

The canonical Playwright suite launches the real Electron app and uses an isolated `userData` directory plus a configurable gateway fixture. It currently contains **55 tests across seven spec files**. The exact scenario matrix is [SCENARIOS.md](./SCENARIOS.md).

| Spec | Area | Tests |
| --- | --- | --: |
| `launch-time.spec.ts` | cold launch budget | 1 |
| `onboarding-home.spec.ts` | onboarding and home | 10 |
| `delete-app.spec.ts` | app deletion | 8 |
| `builder.spec.ts` | builder create, preview, edit, code, logs | 6 |
| `appview-templates-insights.spec.ts` | inline app route, automation templates, Analytics | 4 |
| `automations.spec.ts` | automation list, lifecycle, and run viewer | 12 |
| `settings-gateways.spec.ts` | appearance, agents, gateway switching, errors, shortcuts | 12 |

The suite exercises the current post-#599/#603/#608/#667 shell: bundled system apps render inline; builder previews remain iframes; gateway enrollment is pairing-only; and the sidebar is vault-first.

## Harness and CI

- The renderer talks to the active gateway through the same client surface used by the product.
- Specs use a mock gateway where deterministic route/SSE behavior is needed; onboarding and launch-time tests exercise the real local gateway path.
- Run locally with `bun run --cwd apps/desktop test:e2e`.
- The suite runs nightly and in the path-filtered client E2E lane. See [TESTING.md](../../../../TESTING.md).

Known gaps and not-applicable scenarios live in [SCENARIOS.md](./SCENARIOS.md), not in this summary.
