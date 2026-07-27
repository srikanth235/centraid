# Issue #573 — adopt the dev-toolchain opinions deferred by #565, in one go

The umbrella issue proposed a child issue per family. The maintainer overrode
that: no child issues, the whole umbrella lands as focused commits on the #565
branch, v0 rules — no legacy, no compat shims, no workarounds, tools adopted to
their full power. This receipt is the single record for all of it and grows
with each family commit.

## Checklist

- [ ] jsx-a11y (A): rules on and all violations fixed with real semantics
- [ ] react/react-compiler (B): adopted and all findings fixed
- [ ] ultracite vitest preset (C): adopted wholesale, prefer-strict-equal rewrites hand-reviewed, decision recorded in TESTING.md
- [ ] typescript/method-signature-style (D): adopted, zero findings
- [ ] bulk style rules (E): adopted; no-await-in-loop audited site-by-site, never blind-fixed
- [ ] long-tail rules (F): adopted; react/iframe-missing-sandbox read rather than autofixed
- [ ] ultracite oxfmt style (G): adopted repo-wide as its own formatting-only commit
- [x] Expo Next API migration (H): every /legacy import removed from apps/mobile
- [ ] Every adopted rule removed from the pinned-off block in oxlint.config.mjs, zero findings each

## What changed

### H — Expo SDK 57 Next APIs (this commit)

**Expo Next API migration (H): every /legacy import removed from apps/mobile.**
`grep -rn "expo-media-library/legacy\|expo-file-system/legacy" apps/mobile/src`
is empty. Seven files migrated; one new module.

- `apps/mobile/src/apps/photos/device-media.ts` (new) — the one place a
  camera-roll original resolves to bytes. `openDeviceOriginal(localId)` probes
  `getIsInCloud()` **before** the fetch (afterwards a failed asset and an
  undownloaded one look alike) and throws a typed `InCloudOriginalError` that
  no caller may swallow. Also owns the two unit conversions the Next API
  changed under us: durations are now **milliseconds** (legacy: seconds), and
  `creationTime` is now nullable (falls back to `modificationTime` before the
  epoch, so nothing files under 1970).
- `apps/mobile/src/apps/photos/timeline-engine.ts` — `getAssetsAsync` cursor paging → `Query`
  builder with `limit`/`offset` + `exeForMetadata()`. Still **one native
  round-trip per page**; `.exe()` would be ~7 crossings per photo (~350k for a
  50k library). Display URI is `metadata.id`, which *is* the addressable URI
  (`ph://` iOS, `content://` Android) exactly as legacy `asset.uri` was.
  `favorite` now reflects the real camera-roll heart (legacy never supplied
  it); the previously-swallowed catch now records the error on the engine.
- `apps/mobile/src/apps/photos/PhotosHome.tsx` /
  `apps/mobile/src/apps/photos/BackupHealth.tsx` — backup flows use
  `openDeviceOriginal`; iCloud-only originals are counted, named to the user
  (alert with retained selection on Home; persistent `cloud-off` banner on
  BackupHealth), and never silently skipped. Live Photo companions via
  `getLivePhotoVideoUri()`. Album list via `Album.getAll()`; the legacy
  `assetCount` label suffix has no Next equivalent and is dropped.
- `apps/mobile/src/apps/photos/PhotosLibrary.tsx` +
  `apps/mobile/src/apps/photos/free-up-space.ts` — delete via `Asset.delete`;
  the delete-time byte probe gained a third outcome `'in-cloud'` so an
  undownloaded original is no longer mislabeled "already gone" — it is kept
  and reported apart. New test in
  `apps/mobile/src/apps/photos/free-up-space.test.ts` covers exactly that
  separation.
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx` — save via `Asset.create(uri)`. Fixed a latent bug:
  device-only originals are `ph://`/`content://`, which the old code fed to
  `File.downloadFileAsync` as if HTTP; export now resolves them through
  `openDeviceOriginal`, and export failures alert instead of vanishing as
  unhandled rejections.
- `apps/mobile/src/lib/bridge/dispatch.ts` /
  `apps/mobile/src/lib/upload/expo-native.ts` — `expo-file-system`
  legacy calls → `File`/`Paths` classes; uploads still stream from the spool
  file through the native background session (`sessionType: 'background'`),
  no JS re-materialization. The cleanup swallow
  (`deleteAsync(...).catch(() => undefined)`) became `if (spool.exists)
  spool.delete()` — idempotent by inspection, nothing masked. The spool is
  created with `{ overwrite: true }` so a retried transfer id truncates its
  own leftovers, preserving the legacy write-truncates semantics.
- Two more silent catches surfaced in passing (flagged by the audit as
  under-described): BackupHealth's album load previously ended in
  `.catch(() => undefined)` and now reports a visible `albumError` line, and
  the timeline engine's catch now records the error instead of dropping it.

## Decisions

- **One-shot under #573.** The umbrella's "child issue per family" plan was
  explicitly overridden by the maintainer; four child issues opened before the
  override (#577–#580) were closed as consolidated.
- **The iCloud gap is surfaced, not shimmed.** The Next API has no
  `shouldDownloadFromNetwork` equivalent. On iOS `getUri()` still requests
  with network access allowed, so the download is *attempted*; what is missing
  is the signal of whether it happened. We probe `getIsInCloud()` first and
  raise a typed error the UI must show. No `/legacy` fallback anywhere.
- **`fileSize` is `undefined` for device rows** — it is not in the cheap
  metadata batch and was already effectively absent under legacy
  (`getAssetsAsync` never returned it); a per-photo round-trip to fetch it
  would break the 50k-library budget.
- **No fabricated mock-everything test for timeline-engine.** It statically
  imports op-sqlite and the native replica client, which the vitest rig
  forbids; the genuinely testable new behaviour (the `'in-cloud'` probe
  outcome) got a real test in `free-up-space.test.ts` instead.

## Out of scope

- Simulator/device confirmation of the migrated flows (`ph://` grid renders,
  offset paging over a mutating library, the iCloud banner under "Optimize
  iPhone Storage", `Asset.create` save, background-session continuity). All
  verification below is API-contract-level; on-device passes are tracked as
  follow-up verification on this branch before release.
- The 45 `no-await-in-loop` findings inside
  `packages/blueprints/automations/**/handler.js` templates, which
  `oxlint.config.mjs` deliberately ignores — surfaced during the E audit,
  decision pending.
- Everything the umbrella's own Out-of-scope lists (the #210 repo profile,
  knip, coverage floors, the test-report threshold re-seed).

## Verification

Per family, on this branch after each commit. For H:

```
grep -rn "expo-media-library/legacy\|expo-file-system/legacy" apps/mobile/src
```

(empty, exit 1)

```
bunx turbo run typecheck --filter=@centraid/mobile
```

```
bunx turbo run test --filter=@centraid/mobile --concurrency=2
```

(36 files / 232 tests green, `timeline-50k.test.ts` budgets included)

```
bunx oxlint -c oxlint.config.mjs apps/mobile
```

```
bun run format:check
```

## Steering

**Check (a): Every human-steering event in the session transcript is recorded as a row in `### Steering`** — PASS. Three steering events identified and recorded via ledger script:
- Event 1 (ordinal 335, 2026-07-27T07:56:18.644Z): Maintainer goal directive to tackle #573 in one go, v0 style
- Event 2 (ordinal 402, 2026-07-27T08:22:59.571Z): User report of merge conflicts and CI failure blocking progress
- Event 3 (ordinal 436, 2026-07-27T08:31:14.173Z): Correction redirecting agent from creating child issues #577–#580 to one-commit-sequence approach

**Check (b): No non-steering message got recorded as steering** — PASS. All three recorded events are genuine mid-task redirections or corrections; no tool denials, permission prompts, or ordinary task progress messages were recorded.

### Context

- 2026-07-27 — maintainer set the goal: tackle everything in #573 in one go,
  no child issues, v0 — no legacy/compat/workarounds, adopt the tools to
  their maximum power, source/config tweaks allowed, orchestrate with Opus
  subagents. This receipt exists because of that instruction.

## Audit

**Check (1): '## What changed' faithfully describes the staged diff** — PASS. The H section accurately maps all 10 modified/new files in the diff to their claimed changes:
- device-media.ts (new): `openDeviceOriginal` + `InCloudOriginalError` + duration/timestamp helpers ✓
- timeline-engine.ts: getAssetsAsync→Query builder migration ✓
- free-up-space.ts/test.ts: in-cloud third outcome + test ✓
- PhotosHome.tsx/BackupHealth.tsx: openDeviceOriginal integration ✓
- PhotoLightbox.tsx: export error handling fix ✓
- dispatch.ts/expo-native.ts: legacy file-system→File/Paths migration ✓

**Check (2): Each '- [x]' Checklist item is realized in the diff** — PASS. Single checked item "Expo Next API migration (H): every /legacy import removed from apps/mobile" is fully realized:
- No `/legacy` imports in apps/mobile/src (verified: `grep -rn "/legacy" apps/mobile/src` → exit 1)
- All seven files migrated to Next APIs
- New device-media.ts module created as the hub for original resolution

**Check (3): '## Checklist' mirrors the issue's acceptance criteria** — PASS. Receipt's checklist structure (items A–H) directly corresponds to issue #573's scope (jsx-a11y, react/react-compiler, vitest preset, typescript/method-signature-style, bulk style rules, long-tail rules, oxfmt, Expo migration). Only H is presently checked, matching the current commit scope. Umbrella issues A–G are tracked as unchecked items for future commits per the one-shot strategy.

### Detailed evidence

- No `/legacy` imports remain: `grep -rn "/legacy" apps/mobile/src` → exit 1,
  zero hits; the only `expo-*/legacy` strings left repo-wide are receipt prose.
- getIsInCloud before the fetch: `device-media.ts:53` awaits the probe, `:55`
  awaits `getUri()`, `:57` throws `InCloudOriginalError` only when the
  pre-probe said in-cloud, else rethrows raw.
- ms → s duration conversion: `device-media.ts:85-87` divides by 1_000,
  `null → undefined`; upstream corroborates (legacy "in seconds" vs Next
  "in milliseconds" in the package sources).
- One native call per page: `timeline-engine.ts:226` is the sole native await
  in the page loop; every field reads a plain `AssetMetadata` property;
  `.exe()` appears nowhere in apps/mobile/src.
- `'in-cloud'` third outcome + new test: probe type widened
  (`free-up-space.ts:69`), counted at `:106-109`, surfaced at
  `PhotosLibrary.tsx:153-158`; `free-up-space.test.ts:71-79` asserts the
  exact claimed separation.
- PhotoLightbox unhandled-rejection fix: `runExport` wraps `exportAsset`
  with `.catch → Alert.alert` at `PhotoLightbox.tsx:233-240`; both
  Pressables rewired; no bare `void exportAsset(...)` remains.
- dispatch.ts idempotent delete without swallow: `if (spool.exists)
  spool.delete()` in the `finally`; upload still streams via `spool.upload`
  with `sessionType: 'background'`.
- No workaround, fallback, or suppression introduced: zero added lines
  matching disable/ignore/any/empty-catch patterns across the diff; two
  previously-swallowed catches converted to surfaced errors.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-5686fd74-b3c-1785143031-1 | claude-code | 5686fd74-b3c6-4897-a826-6a9406700ae9 | #573 | claude-fable-5 | 62 | 111902 | 6715689 | 39093 | 151057 | 10.0697 | 1720 | 2579576 | 179607258 | 621391 |  |
| claude-code-5686fd74-b3c-1785143592-1 | claude-code | 5686fd74-b3c6-4897-a826-6a9406700ae9 | #573 | claude-fable-5 | 36 | 87943 | 4524572 | 28649 | 116628 | 7.0567 | 1756 | 2667519 | 184131830 | 650040 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-5686fd74b3c64897a8266a9406700ae9-1-1 | 5686fd74-b3c6-4897-a826-6a9406700ae9 | #573 | correction | classifier | Maintainer goal: tackle #573 in one go, v0 — no legacy/compat/workarounds | bbb48269 | 335 | 2026-07-27T07:56:18.644Z |
| steer-5686fd74b3c64897a8266a9406700ae9-2-1 | 5686fd74-b3c6-4897-a826-6a9406700ae9 | #573 | correction | classifier | Merge conflicts and CI blocked — pause work until resolved | bbb48269 | 402 | 2026-07-27T08:22:59.571Z |
| steer-5686fd74b3c64897a8266a9406700ae9-3-1 | 5686fd74-b3c6-4897-a826-6a9406700ae9 | #573 | correction | classifier | Don't create child issues #577–#580; tackle everything in one commit sequence | bbb48269 | 436 | 2026-07-27T08:31:14.173Z |
