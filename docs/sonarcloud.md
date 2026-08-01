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
| PR quality gate | **Sonar way** (Free plan cannot assign a custom gate) |

Autoscan limitations that shape this config:

- No coverage upload (Vitest/`bun run coverage` remains the coverage source of truth — see [TESTING.md](../TESTING.md)).
- No monorepo multi-project strategy (one Sonar project for the whole repo).
- `sonar-project.properties` is **ignored**; scope globs live in the SonarCloud API / UI (and in the apply script below). Wildcards work in API settings.
- **Sonar way fails a PR when new-code reliability or security rating leaves A** — i.e. **any new BUG or VULNERABILITY** in _scanned_ new code. Maintainability/duplication/hotspots are additional conditions.

## Tool ownership

Sonar is a **second opinion on product code**, not a replacement for the local toolchain or the #671 hygiene gates:

| Concern | Owner |
| --- | --- |
| Format | Oxfmt |
| Lint / style | Oxlint |
| Types | TypeScript |
| Dead code | Knip |
| Coverage / mutation | Vitest + floors |
| Secrets / lockfile / image | Gitleaks + OSV + Trivy + GHAS — [SECURITY.md](../SECURITY.md#automated-security-gates-671) |
| Workflow YAML | actionlint + CodeQL `actions` |
| Product TS/JS security & reliability | **Sonar Autoscan** (this doc) + CodeQL |

Do **not** “fix” a Sonar style finding by weakening oxlint/TS policy.

## What we configure

### 1. Analysis scope (exclusions) — primary lever against trivial PR fails

Applied to project settings by [`scripts/ci/configure-sonarcloud.mjs`](../scripts/ci/configure-sonarcloud.mjs):

**Product in scope:** `packages/**` and `apps/**` (minus generated/harness/tests).

**Out of scope (other tools own them):**

| Path | Why excluded |
| --- | --- |
| `scripts/**` | CI/tooling CLIs; oxlint + unit tests |
| `.github/**` | Workflows; actionlint + CodeQL Actions |
| `tests/**`, `**/*.{test,spec}.*`, `**/e2e/**`, `**/fixtures/**` | Test/fixture surface |
| `docs/**`, `receipts/**`, `assets/**` | Non-runtime |
| `**/dist/**`, `**/generated/**`, visual-harness, tunnel native, wasm | Generated / non-TS product |

If a PR only touches excluded paths, Sonar should not invent new-code BUG/VULN ratings from that diff.

### 2. Issue ignore multicriteria (noise rules on _product_ code)

Even inside `packages/` / `apps/`, some rules flood the monorepo without matching our defect model. Full list: `NOISE_RULES` in the configure script. Includes:

| Family | Examples | Why silenced |
| --- | --- | --- |
| Style owned elsewhere | nested ternary, optional-chain prefer, `replaceAll`, cognitive complexity | Oxlint / review |
| React pedantry | `Readonly` props, unused prop types, index keys | Low defect correlation |
| Intentional patterns | PATH inheritance, loopback `http://`, `Math.random` IDs | Product/spawn/local URLs |
| Inflated “bugs” | sort without compare | Locale sort intentional |
| Workflow FPs | Actions “enforce HTTPS” on already-`https://` curls | CodeQL/actionlint own workflows |
| CLI log FPs | “log user-controlled data” | Tooling CLIs |

**Kept active (do not bulk-silence):** ReDoS `S5852`, `postMessage` origin `S2819`, download-then-exec `S8482`, empty tests `S2187`, real control-flow bugs, CSP review on product HTML, vault/gateway security sinks.

### 3. Quality profiles & gate named “Centraid”

On Free plan SonarCloud **allows creating** custom profiles/gates but **blocks assigning** them. We still maintain **Centraid** copies (no coverage condition) for a future paid assignment. Until then, **exclusions + multicriteria** keep Sonar way from failing hygiene/tooling PRs; product PRs still fail closed on real new bugs/vulns Sonar reports in `packages/` / `apps/`.

## Re-apply after policy changes

```bash
export SONAR_TOKEN=$(security find-generic-password -s sonarqube-cli -w)
bun run scripts/ci/configure-sonarcloud.mjs
# optional: clear residual open noise issues on main
bun run scripts/ci/configure-sonarcloud.mjs --resolve-noise
```

Then push so Autoscan re-runs (settings apply on the **next** analysis).

## Related

- [docs/toolchain.md](toolchain.md)
- [TESTING.md](../TESTING.md)
- [SECURITY.md](../SECURITY.md)
