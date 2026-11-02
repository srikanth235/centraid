# Sources

## claude-mods `sqlite-ops`

- URL: https://github.com/0xDarkMatter/claude-mods (`skills/sqlite-ops/references/`)
- Commit: `82f5d0a34618bb4228d7e6662579a88d6fe5297c`
- License: MIT, copyright 2025-2026 0xDarkMatter. Text in [licenses/claude-mods-LICENSE](licenses/claude-mods-LICENSE).
- Copied (4 files, read in full): `schema-design.md`, `query-performance.md`, `concurrency-durability.md`, `migration-patterns.md` into [references/](references).
- Modified: reformatted by oxfmt; a pointer note added under each title; relative links to pack files not copied replaced by the pack's GitHub URLs at the pinned commit; the "named-migration runner" and "runners per host" sections and the D1 lines removed from `migration-patterns.md`.
- Left out: the pack's `SKILL.md`, `d1-edge.md`, `d1-production-patterns.md`, `hosts.md`, `async-patterns.md`, `testing.md`, `operations.md`, `feature-modules.md`, `schema-patterns.md`, the eqp triage files, and all `scripts/` and `tests/` (executable, or for Cloudflare D1, Turso and non-Rust drivers).
- Where the copied text disagrees with the repo, [CENTRAID.md](CENTRAID.md) names the winner.

Other candidates seen and not used: `erayack/sqlite-best-practices` and `tstapler/sqlite-optimizer` (licenses not confirmed), `u1pns/skill-dba` (multi-engine), `borghei/Claude-Skills` (MIT with Commons Clause), `planetscale/database-skills` (Postgres).

## Written here

`SKILL.md` and `CENTRAID.md` are written for this repo; every repo fact in them was read from the tree.
