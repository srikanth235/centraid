# Release playbook (D1–D6)

How Centraid ships. One home for the ritual; skills are thin shims that point here.

## D1 — Authorization boundary

| Role | May | May not |
| --- | --- | --- |
| **Agent (prepare)** | Run green checks, classify version with D4 rationale, draft changelog, sanity-check artifacts, open a PR or leave a prepare report | Publish, tag `v*`, push release tags, upload store binaries, or treat "run the release flow" as permission to publish |
| **Maintainer (publish)** | Explicit "go ahead" / approval after review | — |

**Rules:**

1. Invoking the release flow is **intent to prepare**, not authorization to publish.
2. Agents **never** pick a **major** version (none before 1.0; agents never propose major after either without maintainer direction).
3. **No feature code** bundled into release commits — version bump, changelog, tag only.
4. Any last-minute code change **invalidates** prepare; re-run prepare and re-approve.

## D2 — One-command chain

Happy path:

1. `bun run release:prepare` — asserts green (`check:pr` unless `--skip-check`), classifies D4, writes `artifacts/release-prepare.json`.
2. Maintainer "go ahead".
3. `bun run release:publish -- --version X.Y.Z --issue N` — requires real issue number (no `#0`); bumps monorepo + mobile native numbers via `scripts/release/sync-versions.mjs`; folds CHANGELOG; annotated tag.
4. `git push origin HEAD && git push origin vX.Y.Z` (or `publish` with `--push`) → workflows fan out.

Supporting scripts:

| Script | Role |
| --- | --- |
| `bun run release:sync-versions` | Re-stamp workspace + mobile natives to root version |
| `bun run release:verify-secrets` | Report secret *names* present/absent (never values) |
| `bun run release:restamp` | I8 rewrite `releaseDate` on `latest*.yml` |
| `bun run boot:smoke` | Structural desktop package surface |
| `bun run web:build` / `web:smoke` | Public PWA artifact + smoke |

## D3 — Changelog → GitHub release + what's-new

- `CHANGELOG.md` is the reviewed source of truth ([Keep a Changelog](https://keepachangelog.com/) skeleton).
- GitHub Release body is **generated from** the matching changelog section — not hand-written in parallel.
- **I12 (closed #501):** in-app What's new loads GitHub Releases (desktop main `changelog.ts`), sidebar entry + once-per-version auto-open via `changelogSeenVersion`.

### Prepare checklist

- [ ] Classification is patch or minor per D4 (rationale written)
- [ ] `CHANGELOG.md` `[Unreleased]` moved to the new version section
- [ ] No non-release code in the bump commit
- [ ] CI green on the release commit / tag base
- [ ] Maintainer "go ahead" recorded (PR comment or chat)
- [ ] Optional: `bun run release:verify-secrets` (enrollment status)

### Publish checklist (maintainer)

- [ ] `publish.mjs --version … --issue N` (real issue)
- [ ] Tag pushed
- [ ] GitHub Release body matches changelog
- [ ] Desktop: multi-OS package jobs green; installers attached **only when signing enrolled** (unsigned = prerelease note + artifacts only)
- [ ] Mobile: run `release-mobile` workflow when this release includes mobile (TestFlight / Play internal)
- [ ] Web continuous host deploys from `main` when CF secrets present (`app.centraid.dev`)
- [ ] Optional gateway image on tag (`release-gateway-image` → GHCR; `latest` only if non-beta)
- [ ] Optional gateway **npm** graph on tag (`npm-gateway-publish` → pack always; publish when `NPM_TOKEN` enrolled). Install: `scripts/install-gateway.sh` (see README). Does **not** replace H5 `service install`.

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
- **Gateway npm:** `@centraid/gateway` (+ publish-set deps) on npm when `NPM_TOKEN` is set; curl|bash via `scripts/install-gateway.sh`.
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
| `release-desktop.yml` | `v*` tags | macOS + Windows + Linux; Environment `release`; hard-fail missing artifacts; GH attach when signed |
| `release-mobile.yml` | `workflow_dispatch` | Environment `mobile-release`; EAS when `EXPO_TOKEN`; else assembleDebug scaffold |
| `web.yml` | path-filtered main/PR | build+smoke; CF deploy when token present |
| `release-gateway-image.yml` | `v*` tags | GHCR optional image |
| `docs.yml` | docs paths | build+smoke; CF Git deploys marketing+docs |

## Enrollment / signing secrets

Signing identities and enrollment steps live in [enrollment.md](enrollment.md). Secrets stay in platform stores / GitHub Actions — never in the repo. Prepare may verify "secrets present" without printing them (`bun run release:verify-secrets`).

## Recovery

Mid-flight stranding: [recovery/release.md](recovery/release.md).

## Related

- [decisions.md](decisions.md) — D4, D5, I12, F1, J1, J7
- [CHANGELOG.md](../CHANGELOG.md)
- [enrollment.md](enrollment.md)
