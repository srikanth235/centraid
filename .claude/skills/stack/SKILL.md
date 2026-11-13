---
name: stack
description: >-
  How do I write this language here? Use for Rust, Swift and SwiftUI, Kotlin and Compose, TypeScript, SQLite and SQL, or Python in Centraid: the repo's own constraints, the check command and general style references.
---

# Stack

Read `centraid.md` first for each language: it holds this repo's constraints and check. `general/` holds style references; `licenses/` sits beside what it covers.

| File type | Read | Check |
| --- | --- | --- |
| `.rs`, Cargo | [rust/centraid.md](rust/centraid.md) | `cargo xtask gate --profile local` |
| `.swift`, `mobile/iosApp` | [swift/centraid.md](swift/centraid.md) | `xcodebuild … test` (macOS) |
| `.kt`, Compose, Gradle | [kotlin/centraid.md](kotlin/centraid.md) | `cargo xtask gate --profile mobile-jvm` |
| `.ts`, `.mjs`, scripts | [typescript/centraid.md](typescript/centraid.md) | `bun run check` |
| SQL, schema, queries | [sqlite/centraid.md](sqlite/centraid.md) | `cargo test -p centraid-vault` |
| `.py` (the trainer) | [python/centraid.md](python/centraid.md) | `python3 experiments/adapter-train/run_tests.py` |

Which gate profile to run, and how to report it: [land](../land/SKILL.md).
