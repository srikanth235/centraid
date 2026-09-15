# Release playbook (D1–D6 + three-number versioning)

How Centraid ships. One home for the ritual; skills are thin shims that point here.

## Three numbers (issue #512)

| Number | Job | Who owns it |
| --- | --- | --- |
| **Product version** | What users see (`0.4.0`) — changelog, installers, npm, about screens | Root `package.json`; stamped on **every** workspace package via `sync-versions` |
| **Build number** | What stores demand (iOS `buildNumber`, Android `versionCode`) | Script-derived: `major*1e6 + minor*1e3 + patch` (`apps/mobile/src/version-core.cjs`). Never hand-set. Resubmit = cut a new **patch** product version |
| **Protocol version** | What correctness depends on | `GATEWAY_PROTOCOL_VERSION` / `GATEWAY_MIN_PROTOCOL_VERSION` in `@centraid/core/protocol`. **Only** number runtime connect may compare |

**Rules:**

1. Release = pick next product version, stamp all packages, tag once (`v0.6.0`).
2. A surface **ships** a version or **skips** ship — monorepo stamps never diverge. Gaps in store history are fine; forks are not.
3. Build numbers are script-derived, monotonic, meaningless.
4. Protocol bumps are explicit, reviewed, and rare; support window is CI-tested.
5. Runtime compatibility logic reads **protocol** (+ capability flags for features). Branching on product version for connect is a bug.
6. **Never bump product version only to fix a failed build.** Rebuild the same tag / surface retry path, or cut a real patch with a product change.

Feature gates remain **capability flags** (C1) — not “bump protocol for every feature.”

## Surfaces

Machine catalog: `scripts/release/surfaces.mjs`. Print: `bun run release:matrix`.

| Id | Cadence | Default on product `v*`? | Workflow |
| --- | --- | --- | --- |
| `desktop` | tag | yes | `release.yml` → `lane-release-desktop.yml` |
| `gateway-image` | tag | yes | `release.yml` → `lane-release-gateway-image.yml` |
| `gateway-npm` | tag | yes (dry-run without `NPM_TOKEN`) | `release.yml` → `lane-release-gateway-npm.yml` |
| `mobile` | store | **no** — dispatch with `surfaces: mobile` (never `all`) | `release.yml` → `lane-release-mobile.yml` |
| `web` | continuous | n/a | `web.yml` |
| `oauth-worker` | continuous, gated | n/a | `oauth-worker.yml` |
| `docs` | continuous | n/a | `ci.yml` (`docs` lane) |
| `companion` | sideline | no | `release.yml` → `lane-release-companion.yml` |

Since #557 a tag produces **one** run. `release.yml` is the only workflow that listens on `push: tags`; it fans out to the lanes above and `release-check` aggregates them into a single verdict, so a partial release (npm published, desktop packaging red) is one red check rather than three greens and a red scattered across four workflow runs.

**Stamp vs ship:** every package.json gets the product version. Which artifacts leave the building is the **ship set** (`--surfaces` on publish). Continuous surfaces deploy from `main`, not from the tag ritual.

**Surface rebuilds (not new product versions):** prefer workflow re-run or force-moved rebuild tags (`desktop-vX.Y.Z` when supported) — do not invent `companion-v*` as a second product line. Prefer packaging the companion at the same product version.

## D1 — Authorization boundary

| Role | May | May not |
| --- | --- | --- |
| **Agent (prepare)** | Run green checks, classify version with D4 rationale, draft changelog, print surface matrix + secret readiness, open a PR or leave a prepare report | Publish, tag `v*`, push release tags, upload store binaries, or treat "run the release flow" as permission to publish |
| **Maintainer (publish)** | Explicit "go ahead" / approval after review | — |

**Rules:**

1. Invoking the release flow is **intent to prepare**, not authorization to publish.
2. Agents **never** pick a **major** version (none before 1.0; agents never propose major after either without maintainer direction).
3. **No feature code** bundled into release commits — version bump, changelog, tag only.
4. Any last-minute code change **invalidates** prepare; re-run prepare and re-approve.

## D2 — One-command chain

Happy path:

0. **HEAD must be a promoted candidate.** `release:prepare` refuses otherwise, before anything else runs ([#915](https://github.com/srikanth235/centraid/issues/915)).
1. `bun run release:prepare` — asserts green (`check:pr` unless `--skip-check`), classifies D4, writes `artifacts/release-prepare.json` (includes surface matrix + secret groups).
2. Maintainer "go ahead" **including ship set** (default: desktop, gateway-image, gateway-npm).
3. `bun run release:publish -- --version X.Y.Z --issue N --surfaces desktop,gateway-image,gateway-npm` — requires real issue number (no `#0`); bumps monorepo + mobile native numbers via `scripts/release/sync-versions.mjs`; folds CHANGELOG; writes `artifacts/release-ship.json`; annotated tag.
4. `git push origin HEAD && git push origin vX.Y.Z` (or `publish` with `--push`) → tag workflows fan out.
5. If ship set includes `mobile`: `gh workflow run release.yml -f surfaces=mobile -f mobile_profile=preview …` (never implied by tag alone).

Supporting scripts:

| Script | Role |
| --- | --- |
| `bun run release:matrix` | Print surface catalog / ship set |
| `bun run release:sync-versions` | Re-stamp every workspace package to the root version (mobile native numbers derive from it at prebuild) |
| `bun run release:verify-secrets` | Report secret _names_ present/absent (never values) |
| `bun run release:restamp` | I8 rewrite `releaseDate` / rollout on `latest*.yml` |
| `bun run boot:smoke` | Structural desktop package surface |
| `bun run web:build` / `web:smoke` | Public PWA artifact + smoke |

### The candidate precondition (#915)

We ship builds somebody promoted. Rung 3 (`candidate.yml`) moves the git ref `refs/candidates/latest` on every green push to `main` and appends `{sha, promotedAt}` to `test-report/candidates.json` on gh-pages (kept 200 deep); rungs 4 and 5 then test that SHA. Before this, the release SHA was implicitly "whatever `HEAD` is when `publish.mjs` runs" — nothing in the chain resolved or checked one, and a tag could be cut on a commit no deep rung had ever exercised. The release would still be green, because every release lane **builds** the tree rather than testing it.

Enforced in three places, earliest first:

| Where | What it checks |
| --- | --- |
| `bun run release:prepare` | `git rev-parse HEAD` equals `git ls-remote origin refs/candidates/latest`. Runs first, before the clean-tree and `check:pr` gates, because its remedy (wait for a promotion) takes the longest |
| `bun run release:classify -- --require-candidate [--sha <40hex>]` | the same rule, for a caller that only classifies. Classification is a pure read of `CHANGELOG.md` and has no SHA of its own, so here it is opt-in |
| `release.yml` job `require-candidate` | the backstop, after the tag exists: the tagged SHA is the current pointer **or** appears in the gh-pages promotion history. Both are accepted because cutting a release takes minutes while `main` keeps moving — a tag on yesterday's promoted candidate is exactly right |

The escape is `--allow-uncandidated`, which passes and **prints the reason it was used** (or `(none given — say why in the receipt)`). A hatch that leaves no trace is a hatch nobody can audit. Never widen the rule to make a release green; promote the build instead.

## D3 — Changelog → GitHub release + what's-new

- `CHANGELOG.md` is the reviewed source of truth ([Keep a Changelog](https://keepachangelog.com/) skeleton).
- GitHub Release body is **generated from** the matching changelog section — not hand-written in parallel.
- **I12 (closed #501):** in-app What's new loads GitHub Releases (desktop main `changelog.ts`), sidebar entry + once-per-version auto-open via `changelogSeenVersion`.

### Prepare checklist

- [ ] Classification is patch or minor per D4 (rationale written)
- [ ] `CHANGELOG.md` `[Unreleased]` moved to the new version section
- [ ] Ship set chosen (`bun run release:matrix`); continuous surfaces not falsely listed as tag ships
- [ ] No non-release code in the bump commit
- [ ] **HEAD is the promoted candidate** (`refs/candidates/latest`) — `release:prepare` refuses otherwise
- [ ] CI green on the release commit / tag base
- [ ] Maintainer "go ahead" recorded (PR comment or chat)
- [ ] Optional: `bun run release:verify-secrets` (enrollment status)

### Publish checklist (maintainer)

- [ ] `publish.mjs --version … --issue N --surfaces …` (real issue)
- [ ] Tag pushed
- [ ] GitHub Release body matches changelog
- [ ] **Desktop** (if shipped): multi-OS package jobs green; installers attached **only when signing enrolled**
- [ ] **Gateway image** (if shipped): GHCR job green; `latest` only if non-beta
- [ ] **Gateway npm** (if shipped): `gateway-npm` lane multi-OS native matrix + pack; publish when `NPM_TOKEN` enrolled. Required natives: linux-x64, darwin-arm64, win32-x64 (#511). Install: `scripts/install-gateway.sh` (Unix) or `npm i -g @centraid/server` (Windows). Does **not** replace H5 `service install`.
- [ ] **Mobile** (if shipped): `release.yml` dispatched with `surfaces: mobile`; store tracks checked
- [ ] **Web** continuous host deploys from `main` when CF secrets present (not a tag checklist item)

## D4 — Patch vs minor

| Classification | When |
| --- | --- |
| **patch** | Every changelog entry under **Fixed** only |
| **minor** | Anything **Added**, **Changed**, or **Removed** (or security that is not pure fix framing) |
| **major** | **Not before 1.0.** Agents never propose one. |

The release agent **asserts** classification from the changelog headings; it does not debate product marketing.

## D5 — Channels

- **Desktop beta:** tags `v0.x.y-beta.n` → GitHub **pre-release**, electron-updater channel `beta`. Never move the stable download target.
- **Gateway image:** `ghcr.io/<owner>/centraid-gateway:<tag>`; **`latest` only for non-beta tags**.
- **Gateway npm:** `@centraid/server` (+ publish-set) when `NPM_TOKEN` set; curl|bash via `scripts/install-gateway.sh` (Unix). Multi-platform tunnel NAPI matrix: `scripts/gateway-npm/native-platforms.mjs` + `lane-release-gateway-npm.yml` job `build-native` (#511).
- **Mobile beta:** TestFlight / Play internal track (`release.yml` → `lane-release-mobile.yml`, EAS profiles `preview` / `production`). **No** `eas update` in CI (J7).
- **Web:** continuously deployed public origin **`https://app.centraid.dev`** (scaffold; CF secrets required). The gateway-served PWA remains the LAN / always-on fallback. No beta tag ritual.

## D6 — Skills as shims

| Skill | Role |
| --- | --- |
| `.claude/skills/release-prepare/SKILL.md` | Read this doc; run prepare checklist only |
| `.claude/skills/release-publish/SKILL.md` | Read this doc; run publish only after maintainer go-ahead |

Do not fork process text into skills.

## Workflows (fan-out)

| Workflow | Trigger | Notes |
| --- | --- | --- |
| `release.yml` | `v*` / `companion-v*` tags, dispatch | **the only tag listener**; fans out to the lanes below, `release-check` is the one verdict |
| `lane-release-desktop.yml` | `workflow_call` | macOS + Windows + Linux; Environment `release` |
| `lane-release-mobile.yml` | `workflow_call` (dispatch only, never a tag) | Environment `mobile-release`; EAS when `EXPO_TOKEN` |
| `lane-release-gateway-image.yml` | `workflow_call` | GHCR optional image, built from [`deploy/docker/gateway-v0.Dockerfile`](../deploy/docker/gateway-v0.Dockerfile) |
| `lane-prebuilt-core.yml` | `workflow_call` | **the v1 prebuilt core** ([#1020](https://github.com/srikanth235/centraid/issues/1020)): six binary triples, the four Android ABIs, the iOS XCFramework, a symbol file beside each, and `prebuilt-core-required` as the one verdict. Also invoked by `gate.yml` on pushes to `main` with `binary-only: true` |
| `lane-release-gateway-npm.yml` | `workflow_call` | multi-OS native + pack; publish when token |
| `lane-release-companion.yml` | `workflow_call` (`companion-v*`) | companion packages |
| `ci.yml` | PR / main push / dispatch | rung 2 — **the only `pull_request` listener**; `docs`, `web-build` and every other PR gate roll up into the required `check` |
| `candidate.yml` | main push / dispatch | rung 3 — the promotion lanes; on green its `promote` job moves `refs/candidates/latest`, publishes `test-report/candidate.json` and appends to `test-report/candidates.json`. `release.yml`'s `require-candidate` reads both |
| `web.yml` | path-filtered main push | CF deploy when token present (PR gate is ci.yml's `web-build`) |
| `oauth-worker.yml` | path-filtered main push | protected deploy only when explicit flag + production evidence gates pass (PR gate is ci.yml's `oauth-worker`) |

Each lane declares the secrets it accepts via `on.workflow_call.secrets`, so the desktop signing identity, `NPM_TOKEN` and GHCR push never reach a lane that has no business with them.

## The v1 prebuilt core: triples, keys, identity, symbols

[#1020](https://github.com/srikanth235/centraid/issues/1020) ships a **prebuilt core**: every shell links a binary artifact rather than compiling Rust. Two separate mechanisms make that safe, and they answer different questions.

**The key** — `cargo xtask artifact-key --triple <triple> [--features …] [--profile …]` — answers _is the artifact in the cache the one this tree would produce?_ It is `sha256` over `crates/`, `contracts/` **minus `contracts/ledgers/`**, the `rust-toolchain.toml` channel, the triple, the features, the profile, and the resolved dependency graph (every `[[package]]`'s name, version and checksum out of `Cargo.lock`, and nothing else from that file). Two consequences are the rule rather than an accident: a `Cargo.lock` edit that changes no name, version or checksum does **not** move the key, and one that bumps a version or a checksum does. A ledger is excluded because a ledger is evidence _about_ an artifact — hashing `library-size.json` would make every measurement invalidate the artifact it measured. `--explain` prints the five inputs separately so a moved key can be attributed instead of guessed at.

**The identity stamp** answers _is the artifact a shell just loaded the one this tree produced?_ Every build bakes in `{gitSha, digest, schemaVersion}` (`crates/centraid/build.rs`; the digest is the key above). `centraid --version --json` prints it, the release publishes the same document as `centraid-<triple>.identity.json`, and three places check it: `deploy/vps/install.sh` at install, `CENTRAID_EXPECTED_CORE_DIGEST` at gateway start, and `crates/core-ffi`'s `open` handshake once that crate lands. A mismatch is a refusal, never a warning — a stale core starts, answers, and answers from a schema the shell stopped speaking. A local build with no release stamp is marked `dev` and says so.

**Required targets gate the publish**, the rest are reported: `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin` and `x86_64-pc-windows-msvc` are required (the same three v0's native matrix requires); `aarch64-unknown-linux-gnu`, `x86_64-apple-darwin` and `aarch64-pc-windows-msvc` are optional. `prebuilt-core-required` also asserts that every published artifact reports **one** digest, because they were all built from one tree.

**A symbol file beside every artifact.** There was no precedent for this in the repository — nothing in v0 publishes a dSYM or an NDK `symbols.zip` — so `[profile.release]` keeps line-table debuginfo with `split-debuginfo = "packed"` and the lane publishes `centraid.dwp` (Linux), `centraid.dSYM` (macOS) or `centraid.pdb` (Windows) beside a **stripped** binary. Stripping happens at packaging, after the symbols have been lifted out; a profile that stripped would have thrown them away before anything could keep them.

## Installing a gateway on a host, and the release smoke

[`deploy/README.md`](../deploy/README.md) is the one home for the image, the units and the installer. Three rules an operator can rely on:

1. `deploy/vps/install.sh` verifies **before** it unpacks (`SHA256SUMS`), then checks the installed binary's identity stamp against the release's `identity.json`.
2. It **never installs an OS service silently**. `--with-service` prints the commands; only `--yes` writes a unit, and enabling is always left to the operator.
3. `centraid gateway install --dry-run` writes nothing at all.

`cargo xtask gate --profile release`'s `vps-smoke` step exercises all three inside a clean, digest-pinned Docker container: install, `--dry-run` writes nothing (checked by listing `/etc/systemd/system` before and after), the gateway founds a vault, a seat pairs over iroh, a WAL capture tick seals a segment, `centraid backup now` ships a generation with a non-empty tail, `centraid doctor` is clean, the container restarts over the same data directory and opens the existing vault rather than founding a second one — and finally the same artifact with a tampered `identity.json` is refused. The transcript lands at `target/xtask/release/vps-smoke/transcript.txt`.

### OWNER HAND-OFF — the real VPS run

The container proves the device-less half. The commands for a real host, and the transcript to expect:

```bash
# On a fresh VPS, as a user with sudo:
curl --proto '=https' --tlsv1.2 -sSfL \
  https://raw.githubusercontent.com/srikanth235/centraid/main/deploy/vps/install.sh -o install.sh
sha256sum install.sh                      # compare against the release notes
bash install.sh --version vX.Y.Z --with-service --system --instance home
# reads: "checksum ok", "identity ok", "installed /usr/local/bin/centraid",
#        then the two commands it did NOT run
sudo systemd-creds encrypt --name=centraid-keystore - /etc/centraid/credentials/centraid-gateway@home.keystore.cred
bash install.sh --version vX.Y.Z --with-service --system --instance home --yes
sudo systemctl enable --now centraid-gateway@home
systemctl status centraid-gateway@home    # active (running), Restart=on-failure
sudo -u '#'"$(systemctl show -p UID --value centraid-gateway@home)" \
  centraid doctor --data-dir /var/lib/centraid/home   # exit 0, "clean"
sudo systemctl restart centraid-gateway@home          # comes back, no second vault founded
```

What the container cannot prove and this run must: that `DynamicUser` + `StateDirectory` actually start (the unit has never been loaded by a real systemd), that `systemd-creds` hands the secret over, that the service survives a reboot, and that a seat on another machine pairs across a real network rather than over loopback. Record the transcript in the issue.

## What a release workflow owes the egress ratchet

A release lane is where the interesting secrets live — `NPM_TOKEN`, GHCR push, Apple and Azure signing, Cloudflare deploy — and a build step, a test, a codegen plugin or a dependency the installer decided to trust can all open a socket. Identity gates cannot see any of that. `node scripts/security/lint-ci-egress.mjs` (`bun run lint:ci-egress`, and the `ci-policy` step of `cargo xtask gate --profile pr`) is the control, and it is a **tighten-only ratchet**:

- **A workflow that ever executes third-party code carries `step-security/harden-runner` as the FIRST step of the job**, with `egress-policy: block`, or `audit` while an allowlist is being learned — and an `audit` policy must carry a ledger note saying so. A workflow that only calls other workflows, or runs a vendored shell script, executes nothing it did not already have and needs no step.
- **Every workflow that has no harden-runner today is pinned in `scripts/security/egress-ledger.json` with a reason.** The ledger is the historical allowance, not a place to put new work: a **new** workflow, or a new job in an unledgered one, must carry the step.
- **A stale ledger entry fails.** An entry for a workflow that has since been hardened, or that no longer exists, is a failure — which is what stops the allowlist growing back.

The failure mode this buys: an exfiltration attempt becomes a failed DNS lookup with a named destination in the run log, instead of a successful upload nobody sees.

**Currently red, and named rather than allowlisted:** `lane-release-extension.yml` installs and runs dependency code with no harden-runner step and no ledger entry. It is a **release** lane, which is the worst place for the gap, and it is recorded in [`receipts/issue-1020-v1-platform.md`](../receipts/issue-1020-v1-platform.md)'s close section. The remedy is the step, not a ledger row.

## Enrollment / signing secrets

Signing identities and enrollment steps live in [enrollment.md](enrollment.md). Secrets stay in platform stores / GitHub Actions — never in the repo. Prepare may verify "secrets present" without printing them (`bun run release:verify-secrets`). Groups include desktop Apple/Azure, mobile, web/Assist CF deploy, `NPM_TOKEN`, and GHCR readiness. Assist additionally has an external evidence gate in [release/oauth-assist-google.md](release/oauth-assist-google.md).

## Recovery

Mid-flight stranding: [recovery/release.md](recovery/release.md).

## Related

- [decisions.md](decisions.md) — D4, D5, R1–R5, I12, F1, J1, J7
- [protocol.md](protocol.md) — C1 + protocol floor
- [CHANGELOG.md](../CHANGELOG.md)
- [enrollment.md](enrollment.md)
