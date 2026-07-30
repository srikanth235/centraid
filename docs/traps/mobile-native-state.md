# Trap: mobile native recipe vs fingerprint ratchet

## What goes wrong

Main can be green on `ci:native-state` while the **native recipe is incomplete** — local modules exist under `apps/mobile/modules/` but never appear in `ios/Podfile.lock`. Fingerprints still match that incomplete world (files are hashed; CocoaPods is never run on Linux CI). The next PR that regenerates the lock or touches hashed non-native noise is the first hard failure, and it looks like a main regression.

Historical shape:

| Change | Modules on disk | `Podfile.lock` | Fingerprints |
| --- | --- | --- | --- |
| #631 (storage) | +storage | regenerated | ratcheted |
| #638 (network-status, ocr) | +two modules | **unchanged** | ratcheted to incomplete world |
| Follow-on #644 | same | expanded lock | identity moves → red |

## The invariant

> Fingerprints may only ratchet when the native **recipe** is complete and coherent. Incomplete worlds cannot be blessed by updating only `native-fingerprints.json`.

`bun run --cwd apps/mobile ci:native-state` enforces four layers:

| Layer | What |
| --- | --- |
| **L1** | Every local `modules/*/ios/*.podspec` is in `Podfile.lock` DEPENDENCIES + EXTERNAL SOURCES. Android: each module's `expo-module.config.json` declares the platforms its directories imply (no Android lockfile — `ci:android-native` compiles modules). |
| **L2** | Pod versions (Expo / React-Core / Hermes) match `node_modules` |
| **L3** | `REACT_NATIVE_PATH` is relative and resolves to this repo's RN |
| **L4** | Committed `native-fingerprints.json` matches `@expo/fingerprint` |

## Correct remediation

```sh
# See which layer is red
bun run --cwd apps/mobile ci:native-state --status

# Incomplete lock / missing pods — repair on macOS only
cd apps/mobile/ios && pod install
# Linux CI and many sandboxes can *verify* the lock but never *repair* it.

# After L1–L3 are green and you have reviewed the native diff:
bun run --cwd apps/mobile ci:native-state --write
# Commit Podfile.lock + native-fingerprints.json together (same PR as the module).
```

`--write` **refuses** when L1–L3 fail. Do not hand-edit hashes to silence CI.

Script-key reorders in `apps/mobile/package.json` no longer move identity (`sourceSkips: PackageJsonScriptsAll`). A script that truly changed prebuild output would not bust the cache either — nothing in current mobile scripts does that.

## How agents get it wrong

1. **Shipping a new module + fingerprint without regenerating `Podfile.lock`** — the #638 hole; L1 now fails closed.
2. **Running `--write` to "make CI green" without a complete recipe** — refused; fix lock/modules first.
3. **Expecting Linux `mobile-smoke` to repair the lock** — it only verifies; `pod install` needs a Mac.
4. **Blaming oxfmt script sorting for identity churn** — deafened in the fingerprint options; do not carve the formatter.
5. **Duplicating lock regeneration across parallel PRs** — coordinate; one PR owns complete lock + `--write`.

## Checklist

- [ ] New/changed local modules listed in `Podfile.lock` (DEPENDENCIES + EXTERNAL SOURCES)
- [ ] `expo-module.config.json` platforms match on-disk `ios/` / `android/` dirs
- [ ] `bun run --cwd apps/mobile ci:native-state` green (or `--status` explains L1 vs L4)
- [ ] If L4 only: deliberate `--write` with module↔lock delta in the issue receipt
- [ ] No second CLI name — flags on `ci:native-state` only

## Related

- Issue #646 (completeness loop), #587 E23 (fingerprint ratchet), #631 vs #638
- `apps/mobile/scripts/verify-native-state.mjs`
- `apps/mobile/scripts/native-fingerprint.mjs`
- `apps/mobile/native-fingerprints.json`
