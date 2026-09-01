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
| [list-anchoring.md](list-anchoring.md) | Virtualized lists that hide rows arriving from another device |
