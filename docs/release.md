# Release playbook (D1–D6 + three-number versioning)

How Centraid ships. One home for the ritual; skills are thin shims that point here.

## Three numbers (issue #512)

| Number | Job | Who owns it |
| --- | --- | --- |
| **Product version** | What users see (`0.4.0`) — changelog, installers, npm, about screens | Root `package.json`; stamped on **every** workspace package via `sync-versions` |
| **Build number** | What stores demand (iOS `buildNumber`, Android `versionCode`) | Script-derived: `major*1e6 + minor*1e3 + patch` (`apps/mobile/src/version-core.cjs`). Never hand-set. Resubmit = cut a new **patch** product version |
| **Protocol version** | What correctness depends on | `GATEWAY_PROTOCOL_VERSION` / `GATEWAY_MIN_PROTOCOL_VERSION` in `@centraid/protocol`. **Only** number runtime connect may compare |

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
| `desktop` | tag | yes | `release-desktop.yml` |
| `gateway-image` | tag | yes | `release-gateway-image.yml` |
| `gateway-npm` | tag | yes (dry-run without `NPM_TOKEN`) | `npm-gateway-publish.yml` |
| `mobile` | store | **no** — dispatch | `release-mobile.yml` |
| `web` | continuous | n/a | `web.yml` |
| `docs` | continuous | n/a | `docs.yml` |
| `companion` | sideline | no | `extension-release.yml` |

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

1. `bun run release:prepare` — asserts green (`check:pr` unless `--skip-check`), classifies D4, writes `artifacts/release-prepare.json` (includes surface matrix + secret groups).
2. Maintainer "go ahead" **including ship set** (default: desktop, gateway-image, gateway-npm).
3. `bun run release:publish -- --version X.Y.Z --issue N --surfaces desktop,gateway-image,gateway-npm` — requires real issue number (no `#0`); bumps monorepo + mobile native numbers via `scripts/release/sync-versions.mjs`; folds CHANGELOG; writes `artifacts/release-ship.json`; annotated tag.
4. `git push origin HEAD && git push origin vX.Y.Z` (or `publish` with `--push`) → tag workflows fan out.
5. If ship set includes `mobile`: `gh workflow run release-mobile.yml …` (never implied by tag alone).

Supporting scripts:

| Script | Role |
| --- | --- |
| `bun run release:matrix` | Print surface catalog / ship set |
| `bun run release:sync-versions` | Re-stamp workspace + mobile natives to root version |
| `bun run release:verify-secrets` | Report secret *names* present/absent (never values) |
| `bun run release:restamp` | I8 rewrite `releaseDate` / rollout on `latest*.yml` |
| `bun run boot:smoke` | Structural desktop package surface |
| `bun run web:build` / `web:smoke` | Public PWA artifact + smoke |

## D3 — Changelog → GitHub release + what's-new

- `CHANGELOG.md` is the reviewed source of truth ([Keep a Changelog](https://keepachangelog.com/) skeleton).
- GitHub Release body is **generated from** the matching changelog section — not hand-written in parallel.
- **I12 (closed #501):** in-app What's new loads GitHub Releases (desktop main `changelog.ts`), sidebar entry + once-per-version auto-open via `changelogSeenVersion`.

### Prepare checklist

- [ ] Classification is patch or minor per D4 (rationale written)
- [ ] `CHANGELOG.md` `[Unreleased]` moved to the new version section
- [ ] Ship set chosen (`bun run release:matrix`); continuous surfaces not falsely listed as tag ships
- [ ] No non-release code in the bump commit
- [ ] CI green on the release commit / tag base
- [ ] Maintainer "go ahead" recorded (PR comment or chat)
- [ ] Optional: `bun run release:verify-secrets` (enrollment status)

### Publish checklist (maintainer)

- [ ] `publish.mjs --version … --issue N --surfaces …` (real issue)
- [ ] Tag pushed
- [ ] GitHub Release body matches changelog
- [ ] **Desktop** (if shipped): multi-OS package jobs green; installers attached **only when signing enrolled**
- [ ] **Gateway image** (if shipped): GHCR job green; `latest` only if non-beta
- [ ] **Gateway npm** (if shipped): pack/publish when `NPM_TOKEN` enrolled
- [ ] **Mobile** (if shipped): `release-mobile` dispatched; store tracks checked
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
- **Gateway npm:** `@centraid/gateway` (+ publish-set) when `NPM_TOKEN` set; multi-OS natives on pack (#511).
- **Mobile beta:** TestFlight / Play internal track (workflow `release-mobile`, EAS profiles `preview` / `production`). **No** `eas update` in CI (J7).
- **Web:** continuously deployed public origin **`https://app.centraid.dev`** (scaffold; CF secrets required). Gateway-embedded PWA remains LAN / always-on fallback. No beta tag ritual.

## D6 — Skills as shims

| Skill | Role |
| --- | --- |
| `.claude/skills/release-prepare/SKILL.md` | Read this doc; run prepare checklist only |
| `.claude/skills/release-publish/SKILL.md` | Read this doc; run publish only after maintainer go-ahead |

Do not fork process text into skills.

## Workflows (fan-out)

| Workflow | Trigger | Notes |
| --- | --- | --- |
| `release-desktop.yml` | `v*` tags | macOS + Windows + Linux; Environment `release` |
| `release-mobile.yml` | `workflow_dispatch` | Environment `mobile-release`; EAS when `EXPO_TOKEN` |
| `web.yml` | path-filtered main/PR | build+smoke; CF deploy when token present |
| `release-gateway-image.yml` | `v*` tags | GHCR optional image |
| `npm-gateway-publish.yml` | `v*` tags / dispatch | multi-OS native + pack; publish when token |
| `docs.yml` | docs paths | build+smoke; CF Git deploys marketing+docs |
| `extension-release.yml` | dispatch / rebuild tags | companion packages |

## Enrollment / signing secrets

Signing identities and enrollment steps live in [enrollment.md](enrollment.md). Secrets stay in platform stores / GitHub Actions — never in the repo. Prepare may verify "secrets present" without printing them (`bun run release:verify-secrets`). Groups include desktop Apple/Azure, mobile, web CF, `NPM_TOKEN`, and GHCR readiness.

## Recovery

Mid-flight stranding: [recovery/release.md](recovery/release.md).

## Related

- [decisions.md](decisions.md) — D4, D5, R1–R5, I12, F1, J1, J7
- [protocol.md](protocol.md) — C1 + protocol floor
- [CHANGELOG.md](../CHANGELOG.md)
- [enrollment.md](enrollment.md)
