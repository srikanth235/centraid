# Sources

Everything under [references/](references/) that is not listed under "Written for this repository" was copied from the two packs below, at the pinned commits. Those three files, [SKILL.md](SKILL.md) and [CENTRAID.md](CENTRAID.md) are written for this repository. Nothing executable was copied: only markdown and the license texts. Every copied file was reformatted by oxfmt, and links were adapted (see each pack). The license texts are in [licenses/](licenses/).

## leonardomso/rust-skills

|  |  |
| --- | --- |
| URL | https://github.com/leonardomso/rust-skills |
| Commit | `fd2a861ab0406a4ac536a55274d14ea6fd1ca9c9` |
| License | MIT, "Copyright (c) 2025 Leonardo Maldonado": [licenses/leonardomso-rust-skills-LICENSE](licenses/leonardomso-rust-skills-LICENSE) |
| Pack NOTICE | none |

**Copied:** all 265 rule files to [references/rules/](references/rules/). 228 are unchanged. The 37 listed below contradict this repository, so each opens with a one-line "Repository override" banner pointing at [CENTRAID.md](CENTRAID.md); the rest of the file is unchanged. The pack's `SKILL.md` category index became [references/rules-index.md](references/rules-index.md): the quick-reference lists and the priority table were kept, the "Recommended Cargo.toml Settings", "How to Use" and attribution sections and the lint category were removed, and a header pointing at [CENTRAID.md](CENTRAID.md) was added; the 37 overridden rules are marked in it.

**Link edits:** a few links inside rule files point at the pack's page for an overridden rule at the pinned commit.

**Overridden (37, copied with a banner), and why:**

| Files | Reason |
| --- | --- |
| `lint-*` (13) | This repository has no lint table and the gate's clippy is the policy; adding lint configuration is out of scope of [#1160](https://github.com/srikanth235/centraid/issues/1160) |
| `opt-lto-release`, `opt-codegen-units`, `opt-pgo-profile`, `opt-target-cpu`, `perf-release-profile` | Profiles are the root `Cargo.toml`'s; `panic = "unwind"` is required by the FFI |
| `perf-black-box-bench`, `test-criterion-bench`, `test-loom-concurrency`, `test-mockall-mocking`, `test-snapshot-testing` | `criterion`, `loom`, `mockall`, `insta` are not in the dependency graph |
| `conc-rayon-par-iter` | `rayon` is deliberately out of the graph |
| `mem-smallvec`, `mem-arrayvec`, `mem-thinvec`, `mem-compact-string`, `mem-arena-allocator`, `perf-ahash` | They recommend adding dependencies for micro-optimisation |
| `api-serde-optional`, `doc-cargo-metadata`, `doc-crate-readme`, `proj-prelude-module` | Not applicable (hard serde dependency, `publish = false`) or contrary to the repository's seams |
| `macro-proc-two-crate`, `macro-proc-syn-quote`, `macro-proc-error-spans` | No proc-macro crate |

The pack's `checks/` directory (scripts, a Cargo project), `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CHANGELOG.md` and `README.md` were not copied.

## morganlinton/BeautifulRust

|  |  |
| --- | --- |
| URL | https://github.com/morganlinton/BeautifulRust |
| Commit | `a9cdcfa94d1330c0d41c7f67764c5f7786fbb71d` |
| License | MIT, "Copyright (c) 2026 Morgan Linton": [licenses/morganlinton-BeautifulRust-LICENSE](licenses/morganlinton-BeautifulRust-LICENSE) |
| Pack NOTICE | none |

**Copied, with edits:**

| Source | Copy | Edits |
| --- | --- | --- |
| `skills/rust-best-practices/SKILL.md` | [references/best-practices.md](references/best-practices.md) | Front matter removed; a note about this repository added at the top; the advice to adopt the pack's lint files removed; the `bevy.md` reference and the workspace-lints phrase removed; reference paths pointed at `guides/` |
| `skills/rust-review/SKILL.md` | [references/review-checklist.md](references/review-checklist.md) | Front matter removed; a note added; the Bevy framework and ECS bullets and the closing "offer the lints" section removed; the pointer to the other skill re-pointed at the local files |
| `skills/rust-port/SKILL.md` | [references/porting.md](references/porting.md) | Front matter removed; a note added |
| `lints/lints.toml`, `lints/clippy.toml` | [references/lint-rationale.md](references/lint-rationale.md) | Wrapped in fenced blocks under a "reference only, not adopted" header; not usable as config files |
| `skills/rust-best-practices/references/{google-rust-style-guide,effective-rust,rust-design-patterns,rust-api-guidelines,microsoft-rust-guidelines}.md` | [references/guides/](references/guides/) | None beyond oxfmt |

**Left out:** `skills/rust-best-practices/references/bevy.md` (the repository does not use Bevy), all `evals/` directories, `lints/check` (a Cargo project), `scripts/`, `benchmarks/`, `examples/`, `tests/`, `plugin.json`, `assets/`, `.gitattributes` and the repository-level docs.

## Written for this repository

| File | Basis |
| --- | --- |
| [SKILL.md](SKILL.md), [CENTRAID.md](CENTRAID.md) | `AGENTS.md`, `docs/coding-standards.md`, `docs/traps/`, `crates/core-ffi/CONTRACT.md`, `crates/xtask/README.md`, `TESTING.md` and a read of `crates/{core,vault,gateway,core-ffi,screens,api-proto}`; the shape follows `skills/code/swift-swiftui` of [daveebbelaar/bama](https://github.com/daveebbelaar/bama) (MIT, commit `639893c397278256f1ae204dd8f837eb82bd6527`), which is a model for structure only and no text was copied |
| [references/threads-and-locks.md](references/threads-and-locks.md), [testing.md](references/testing.md), [protobuf-prost.md](references/protobuf-prost.md), [async-and-cancellation.md](references/async-and-cancellation.md), [error-design.md](references/error-design.md), [api-and-traits.md](references/api-and-traits.md), [unsafe-ffi.md](references/unsafe-ffi.md), [observability.md](references/observability.md), [serde.md](references/serde.md), [performance.md](references/performance.md) | The same, and `crates/api-proto/README.md`; no pack covers prost or the repository's seams. External works are linked, not copied: the [Tokio tutorial](https://tokio.rs/tokio/tutorial) and [Async book](https://rust-lang.github.io/async-book/) (MIT), the [Rustonomicon](https://doc.rust-lang.org/nomicon/) and [Performance Book](https://nnethercote.github.io/perf-book/) (MIT/Apache-2.0); the Rust API Guidelines are carried by the BeautifulRust digest |
