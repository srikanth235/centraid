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

## D2 — One-command chain (target shape)

When automation lands, the happy path is a single prepare entrypoint that:

1. Asserts green (CI / `bun run check:pr` + agreed smoke),
2. Bumps the **single shared monorepo version** across packages,
3. Updates [CHANGELOG.md](../CHANGELOG.md),
4. Creates annotated tag `vX.Y.Z` (or `vX.Y.Z-beta.N`),
5. Pushes tag → workflows fan out to build/sign/publish.

Until that script exists, perform the same steps manually in order; do not invent a second version scheme.

## D3 — Changelog → GitHub release + what's-new

- `CHANGELOG.md` is the reviewed source of truth ([Keep a Changelog](https://keepachangelog.com/) skeleton).
- GitHub Release body is **generated from** the matching changelog section — not hand-written in parallel.
- **I12:** the in-app "what's new" placeholder is removed; re-wiring what's-new to the real release feed is an **explicit checklist item** when D3 automation lands (do not forget).

### Prepare checklist

- [ ] Classification is patch or minor per D4 (rationale written)
- [ ] `CHANGELOG.md` `[Unreleased]` moved to the new version section
- [ ] No non-release code in the bump commit
- [ ] CI green on the release commit / tag base
- [ ] Maintainer "go ahead" recorded (PR comment or chat)

### Publish checklist (maintainer)

- [ ] Tag pushed
- [ ] GitHub Release body matches changelog
- [ ] Desktop artifacts signed (when pipeline exists)
- [ ] Mobile store tracks updated only if this release includes mobile
- [ ] What's-new re-wire item closed or still tracked (I12)

## D4 — Patch vs minor

| Classification | When |
| --- | --- |
| **patch** | Every changelog entry under **Fixed** only |
| **minor** | Anything **Added**, **Changed**, or **Removed** (or security that is not pure fix framing) |
| **major** | **Not before 1.0.** Agents never propose one. |

The release agent **asserts** classification from the changelog headings; it does not debate product marketing.

## D5 — Desktop-only beta

- Tags: `v0.x.y-beta.n` → GitHub **pre-release**, separate updater channel.
- Never move the stable download target or `latest` image tag.
- Mobile beta = TestFlight / Play internal track (no separate Centraid beta channel required).
- Web = continuously deployed; no beta tag ritual.

## D6 — Skills as shims

| Skill | Role |
| --- | --- |
| `.claude/skills/release-prepare/SKILL.md` | Read this doc; run prepare checklist only |
| `.claude/skills/release-publish/SKILL.md` | Read this doc; run publish only after maintainer go-ahead |

Do not fork process text into skills.

## Enrollment / signing secrets

Signing identities and enrollment steps live in [enrollment.md](enrollment.md). Secrets stay in platform stores / GitHub Actions — never in the repo. Prepare may verify "secrets present" without printing them.

## Recovery

Mid-flight stranding: [recovery/release.md](recovery/release.md).

## Related

- [decisions.md](decisions.md) — D4, D5, I12, F1
- [CHANGELOG.md](../CHANGELOG.md)
- [enrollment.md](enrollment.md)
