# Traps — one doc per known footgun

Read the matching trap before working near its area; each one was paid for once.

| Doc | Topic |
| --- | --- |
| [design-tokens.md](design-tokens.md) | Token source of truth vs hardcoded CSS; the two layers of `packages/design` |
| [worktrees.md](worktrees.md) | Install/build/data isolation in worktrees |
| [wal-checkpoint.md](wal-checkpoint.md) | Unsafe SQLite/WAL copies |
| [electron-screenshot.md](electron-screenshot.md) | Electron `capturePage` / Playwright screenshots |
| [manifest-regeneration.md](manifest-regeneration.md) | `manifest.json` / vendor rebuilds |
| [mobile-native-state.md](mobile-native-state.md) | Mobile recipe completeness vs fingerprint ratchet (L1–L4) |
| [coverage-run-filters.md](coverage-run-filters.md) | Filtering a vitest coverage run without over-measuring |
| [device-only-runtime-gaps.md](device-only-runtime-gaps.md) | APIs Hermes and Android's libcore lack that Node and the desktop JVM have |
| [emulator-snapshot-settings.md](emulator-snapshot-settings.md) | `settings put global` on a lane that restores a cached AVD RAM snapshot |
| [list-anchoring.md](list-anchoring.md) | Virtualized lists that hide rows arriving from another device |
| [unreachable-vault.md](unreachable-vault.md) | A gateway that stops answering while the phone stays online |
