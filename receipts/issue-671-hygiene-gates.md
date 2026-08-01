# Issue #671 — High-signal hygiene gates (secrets, OSV lockfile, Trivy image)

## Checklist

- [x] Secret scanning on the PR path (Gitleaks + documented GHAS) with fixture allowlist
- [x] OSV-Scanner on `bun.lock` in `ci.yml`, fail on CRITICAL, rolled into required `check`
- [x] Trivy CRITICAL/HIGH on gateway image lane after build/push
- [x] SECURITY.md documents the three gates and roles vs dependency-review/CodeQL
- [x] Structural + unit tests for wiring and OSV severity classification
- [x] Clear CRITICAL inventory blockers (`shell-quote`, `tar`) via package overrides

## What changed

- **Secret scanning on the PR path (Gitleaks + documented GHAS) with fixture allowlist** — `.github/workflows/ci.yml` adds job `gitleaks` (pinned binary 8.30.1, tree scan with `.gitleaks.toml` fixture allowlist) on every PR/push; rolls into required `check`. GitHub secret scanning + push protection remain the hosted primary control (documented in SECURITY.md).
- **OSV-Scanner on `bun.lock` in `ci.yml`, fail on CRITICAL, rolled into required `check`** — `.github/workflows/ci.yml` job `osv-scanner` installs osv-scanner 2.4.0 and runs `scripts/ci/osv-lockfile-scan.mjs` (full table + fail closed on CRITICAL only); listed under `check.needs`. Config: `osv-scanner.toml`.
- **Trivy CRITICAL/HIGH on gateway image lane after build/push** — `.github/workflows/lane-release-gateway-image.yml` runs SHA-pinned `aquasecurity/trivy-action` after Build and push with severity CRITICAL,HIGH, `exit-code: 1`, and `.trivyignore`.
- **SECURITY.md documents the three gates and roles vs dependency-review/CodeQL** — new “Automated security gates (#671)” table in `SECURITY.md` describing GHAS, Gitleaks, dependency-review, OSV, CodeQL, and Trivy roles.
- **Structural + unit tests for wiring and OSV severity classification** — `scripts/ci/hygiene-gates.mjs` + `.test.mjs` assert workflow wiring; `scripts/ci/osv-lockfile-scan.mjs` + `.test.mjs` classify CRITICAL/HIGH and invoke the real scanner when present; both hooked into `package.json` `scripts:test`.
- **Clear CRITICAL inventory blockers (`shell-quote`, `tar`) via package overrides** — root `package.json` `overrides` force `shell-quote@1.8.4` and `tar@7.5.22` so nested copies no longer report CRITICAL in the OSV inventory; `bun.lock` updated accordingly.

## Decisions

- Tree scan for Gitleaks (not full history) so historical fixture noise is not a permanent red merge gate; GHAS push protection still covers pushes.
- Fail OSV on CRITICAL only so latent HIGH inventory does not block unrelated PRs while still forcing real critical inventory debt to clear (this PR cleared two CRITICALs).
- Trivy stays on the image release lane (`.github/workflows/lane-release-gateway-image.yml`), not every PR docker build (CI budget).
- No Socket / Semgrep / second SAST — high-signal only.

## Out of scope

- Sonar high-signal code burn-down (ReDoS, postMessage, complexity).
- Commercial Socket SCA without API key.
- Scanning every app image beyond monorepo-root gateway Dockerfile.
- Auto-remediating all HIGH lockfile advisories in this PR.

## Verification

```
# Structural + unit tests for wiring and OSV severity classification
node --test scripts/ci/hygiene-gates.test.mjs scripts/ci/osv-lockfile-scan.test.mjs
# → 7 pass

# Secret scanning on the PR path (Gitleaks + documented GHAS) with fixture allowlist
gitleaks detect --source . --no-git --config .gitleaks.toml
# → no leaks found

# OSV-Scanner on bun.lock in ci.yml, fail on CRITICAL, rolled into required check
node scripts/ci/osv-lockfile-scan.mjs
# → critical=0, exit 0

# workflow pin policy (ci.yml + lane-release-gateway-image.yml)
node scripts/lint-workflow-pins.mjs
# → clean

# Trivy CRITICAL/HIGH on gateway image lane after build/push — local docker
# unavailable; proved scanner executes via `trivy config Dockerfile` and
# .github/workflows/lane-release-gateway-image.yml invokes trivy-action after build
```

## Audit

Fresh-context audit of the working tree for #671 hygiene gates (`.github/workflows/ci.yml`, `.github/workflows/lane-release-gateway-image.yml`, configs, scripts, SECURITY.md, lockfile overrides) against this receipt. Default REFUTED if uncertain.

- **(1) `## What changed` faithfully describes the diff** — PASS  
  - `ci.yml` defines `gitleaks` and `osv-scanner` jobs and lists both under `check.needs`.  
  - `lane-release-gateway-image.yml` runs SHA-pinned `trivy-action` after Build and push with CRITICAL,HIGH and `.trivyignore`.  
  - `.gitleaks.toml`, `osv-scanner.toml`, `.trivyignore`, `scripts/ci/osv-lockfile-scan.mjs`, `scripts/ci/hygiene-gates.mjs` and tests exist; SECURITY.md documents the gate table.  
  - `package.json` overrides pin `shell-quote` and `tar`; no accidental direct dependencies on those packages.

- **(2) Each `- [x]` item is realized in the diff** — PASS  
  - Secret scan, OSV, Trivy wiring, docs, tests, and CRITICAL clear are all present as described.

- **(3) `## Checklist` mirrors the issue acceptance criteria** — PASS  
  - Issue #671 acceptance matches the six checklist rows (secrets, OSV, Trivy, docs, tests, CRITICAL clear).

Verdict: PASS / PASS / PASS.

## Steering

PASS — no human steering mid-implementation; goal fixed by plan (three gates + issue + PR).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->
