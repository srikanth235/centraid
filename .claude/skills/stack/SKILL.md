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

## Comments: only when absolutely necessary

This holds in every language here (Rust, Swift, Kotlin, TypeScript, SQL, Python), and in doc comments (`///`, `//!`, KDoc, DocC) as much as in line comments.

- **Write none by default.** Names, types, tests and the check say what code does. If code needs a comment to be understood, rename, split or retype it first.
- **A comment stays only for a *why* the code cannot show:**
  - a non-obvious invariant or safety reason (why this lock, this order, this `unsafe`);
  - a security reason ("never log this: it is a sealed value");
  - a workaround for a platform, library or SQLite behaviour, with a link to the bug;
  - a product ruling the code enforces that a reader would otherwise "fix", with a link to the ruling or issue.
- **Never:**
  - what the next line does;
  - history ("was X, now Y"; that is git's and the issue's);
  - restated names or types;
  - section banners or module essays;
  - commented-out code;
  - a TODO without an issue link.
- **One line where one line will do.** A comment that needs a paragraph is usually a doc that belongs in a skill.
- **Touching a file:** delete the comments in what you change that fail this rule. Don't add new ones to match the file's old style.
