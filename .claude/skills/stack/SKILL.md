---
name: stack
description: >-
  How do I write this language here? Use for Rust, Swift and SwiftUI, Kotlin and Compose, TypeScript, SQLite and SQL, or Python in Centraid: the repo's own constraints, the check command and general style references.
---

# Stack

Read `centraid.md` first for each language: it holds this repo's constraints and check. `general/` holds style references; `licenses/` sits beside what it covers.

**The repo page wins over `general/`.** If a digest says one thing and `centraid.md` says another, follow `centraid.md`. A digest is advice from outside; the repo page is a decision.

| File type | Read | Check |
| --- | --- | --- |
| `.rs`, Cargo | [rust/centraid.md](rust/centraid.md) | `cargo xtask gate --profile local` |
| `.swift`, `mobile/iosApp` | [swift/centraid.md](swift/centraid.md) | `xcodebuild … test` (macOS) |
| `.kt`, Compose, Gradle | [kotlin/centraid.md](kotlin/centraid.md) | `cargo xtask gate --profile mobile-jvm` |
| `.ts`, `.mjs`, sites | [typescript/centraid.md](typescript/centraid.md) | `bun run docs:build && bun run docs:smoke` |
| SQL, schema, queries | [sqlite/centraid.md](sqlite/centraid.md) | `cargo test -p centraid-vault` |
| `.py` (the trainer) | [python/centraid.md](python/centraid.md) | `python3 experiments/adapter-train/run_tests.py` |
| Chosen libraries and pinned versions | [libraries.md](libraries.md) | `cargo xtask gate --profile pr` |
| Tooling choices and what was removed | [toolchain.md](toolchain.md) | `cargo xtask gate --profile pr` |
| A security review: a Rust change at the trust boundary, a new dependency, an API or wire design, `.github/workflows/`, a property test | [security/centraid.md](security/centraid.md), then the skill for the job in [security/general/INDEX.md](security/general/INDEX.md) | the check of the language; `python3 .claude/skills/stack/security/sync.py --check` after a sync |

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

## Every language

- **APIs hide complexity from their callers, agents first.** Most callers are the assistant and lanes, which read a signature and a one-line description and act. Give each module, read, action and tool a small surface that does a whole job: one call that takes intent and returns a result, or an error that says what to do next, not a sequence of low-level steps the caller must order, retry or clean up. Defaults that are right, no flag the caller must know to set, invariants enforced inside rather than documented for the caller. When a caller would need to read the implementation to use it safely, the API is wrong. This is the design rule for the app plane's reads and actions.
