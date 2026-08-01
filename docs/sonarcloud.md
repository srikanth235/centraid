# SonarCloud (Centraid)

How SonarQube Cloud is wired for this monorepo, what we deliberately silence, and how to re-apply config.

## Project

| Field | Value |
| --- | --- |
| Organization | `centraid` |
| Project key | `srikanth235_centraid` |
| Dashboard | https://sonarcloud.io/project/overview?id=srikanth235_centraid |
| Analysis method | **Automatic analysis (Autoscan)** on GitHub push / PR |
| CI scanner | **Not used** (do not add a second scanner while Autoscan is on) |

Autoscan limitations that shape this config:

- No coverage upload (Vitest/`bun run coverage` remains the coverage source of truth — see [TESTING.md](../TESTING.md)).
- No monorepo multi-project strategy (one Sonar project for the whole repo).
- `sonar-project.properties` is **ignored**; only `.sonarcloud.properties` is read for Autoscan path settings, and Autoscan **rejects wildcard** globs in that file. Scope globs therefore live in the SonarCloud API / UI (and in the apply script below).

## Tool ownership

Sonar is a **second opinion for security + reliability + high-signal smells**, not a replacement for the local toolchain:

| Concern | Owner |
| --- | --- |
| Format | Oxfmt (`bun run format`) |
| Lint / style | Oxlint (`bun run lint`) |
| Types | TypeScript (`bun run typecheck`) |
| Dead code | Knip |
| Coverage / mutation | Vitest + floors in `tests/` |
| Secrets / supply chain (PR) | Gitleaks + OSV + dependency-review + GHAS — see [SECURITY.md](../SECURITY.md#automated-security-gates-671) |

Do **not** “fix” a Sonar style finding by weakening oxlint/TS policy. Prefer silencing the Sonar rule (profile / multicriteria) when oxlint already owns it. Sonar is **not** one of the three PR hygiene gates from #671; it remains Autoscan-only.

## What we configure

### 1. Analysis scope (exclusions)

Applied to project settings:

- **Source exclusions** — build outputs (`**/dist/**`), `node_modules`, generated web bindings, blueprint visual harness, Rust `packages/tunnel/**`, docs/receipts/assets, governance hooks, design-sync trees, wasm/map noise.
- **Test inclusions** — `**/*.{test,spec}.*`, `**/tests/**`.
- **CPD exclusions** — harness, kit, blueprint apps (high template similarity), fixtures.
- **Coverage exclusions** — tests/scripts/kit (only matters if we ever switch to CI analysis).

Re-apply with:

```bash
# Token: SonarCloud user token with Administer permission on the project
# (macOS keychain service used by agents: sonarqube-cli)
export SONAR_TOKEN=$(security find-generic-password -s sonarqube-cli -w)
bun run scripts/ci/configure-sonarcloud.mjs
```

### 2. Issue ignore multicriteria (noise rules)

Project-wide ignore for rules that flood the monorepo without matching our defect model. Full list is the `NOISE_RULES` constant in [`scripts/ci/configure-sonarcloud.mjs`](../scripts/ci/configure-sonarcloud.mjs). Summary:

| Family | Examples | Why silenced |
| --- | --- | --- |
| Style owned elsewhere | nested ternary `S3358`, optional-chain prefer `S6582`, `replaceAll` `S7781` | Oxlint / review norms |
| React pedantry | `Readonly` props `S6759`, unused prop types `S6767`, index keys `S6479` | Low defect correlation |
| Intentional runtime patterns | PATH inheritance `S4036`, loopback `http://` `S5332`, `Math.random` IDs `S2245` | Product/spawn/local URLs |
| Inflated “bugs” | sort without compare `S2871` | Locale sort on strings is intentional |
| Nested templates | `S4624` | Readability preference, not a defect |

**Kept active (do not bulk-silence):** ReDoS `S5852`, `postMessage` origin `S2819`, download-then-exec `S8482`, cognitive complexity `S3776`, empty tests `S2187`, real promise/control-flow bugs, CI pin/lifecycle rules, CSP review, etc.

### 3. Quality profiles & gate named “Centraid”

On Free plan SonarCloud **allows creating** custom profiles/gates but **blocks assigning** them to the project (`not allowed to modify Quality gates` / associate profile). We still keep:

- Quality profiles **Centraid** for TypeScript and JavaScript (Sonar way copy with the noise rules deactivated) — ready if the org upgrades or assignment becomes available.
- Quality gate **Centraid** — new-code security / reliability / maintainability rating A, ≤3% new duplication, 100% new hotspots reviewed; **no coverage condition** (Autoscan cannot satisfy Sonar way’s 80% coverage check).

Until assignment works, **multicriteria + exclusions** are the effective control plane; the default **Sonar way** gate still applies to PRs (without coverage data that condition is typically skipped).

## What to do after a config change

1. Push to `main` or open a PR so Autoscan re-runs (exclusions/multicriteria take effect on the next analysis).
2. Optionally re-run `bun run scripts/ci/configure-sonarcloud.mjs --resolve-noise` to WONTFIX any residual open issues on silenced rules (idempotent).
3. Do not resolve real security findings as WONTFIX without a threat-model note.

## Switching to CI-based analysis (optional later)

Only if we need coverage in Sonar, analysis logs, or monorepo project split:

1. Turn **off** Automatic Analysis (Administration → Analysis Method).
2. Add a GitHub Action using the SonarScanner **after** `bun run coverage`, uploading LCOV.
3. Use `sonar-project.properties` (wildcards allowed under CI analysis).
4. Keep a single analysis path — never Autoscan + CI together.

Until then, leave Autoscan on; our coverage contract stays in Vitest floors and `check:full`.

## Related

- [docs/toolchain.md](toolchain.md) — local quality-tool ownership
- [TESTING.md](../TESTING.md) — coverage / mutation floors
- [SECURITY.md](../SECURITY.md) — threat model
