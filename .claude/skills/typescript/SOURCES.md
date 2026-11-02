# Sources

Selected after a web search of agent-skill packs for TypeScript. Candidates evaluated: ofershap/typescript-best-practices (MIT, one focused type-design skill), antfu/skills (MIT, Vitest reference set), AutanaSoft/skills (MIT, `ts-general-practices` sits among NestJS/Next/Drizzle skills this repo does not use), HoangNguyen0403/agent-skills-standard (MIT, a sync tool and hundreds of framework skills), and joabgonzalez/ai-agents-skills and Gentleman-Programming/Gentleman-Skills (Apache-2.0, strict-typing SKILL.md files with framework bundling). Two were taken. SKILL.md, CENTRAID.md and the repo-specific content are written for this repo; no pack covers Bun tooling, emitters or the lint profile.

## ofershap/typescript-best-practices

- URL: https://github.com/ofershap/typescript-best-practices
- Commit: `2b0ac4025116f7677cda34bc03827505885c0268` (main)
- License: MIT, Copyright (c) 2026 Ofer Shapira: [licenses/ofershap-typescript-best-practices-LICENSE](licenses/ofershap-typescript-best-practices-LICENSE)
- Copied (1 file): `skills/typescript-best-practices/SKILL.md` body, from "When to use" on, as [references/type-patterns.md](references/type-patterns.md) (front matter dropped, one intro paragraph added).
- Left out: `commands/audit.md`, `rules/best-practices.mdc`, `scripts/`, `package.json` (executable or editor config, not guidance).

## antfu/skills (vitest skill)

- URL: https://github.com/antfu/skills
- Commit: `7de210b51c8d48cc405a4eac3e17cbb1396c653b` (main)
- License: MIT, Copyright (c) 2025-PRESENT Anthony Fu: [licenses/antfu-skills-LICENSE](licenses/antfu-skills-LICENSE)
- Copied (2 files) from `skills/vitest/references/`: `features-context.md` as [references/vitest-fixtures.md](references/vitest-fixtures.md) and `advanced-type-testing.md` as [references/vitest-type-testing.md](references/vitest-type-testing.md). Front matter dropped; the `bench` (v5) context line removed.
- Left out: the other 17 vitest references (mocking, snapshots, coverage, projects, benchmarking, CLI, reporters, concurrency, filtering, tags, describe/expect/hooks, environments, vi) because the repo's test conventions are owned by the kit and the lint seams, the pack is written for Vitest 5 while the repo pins 4.1.10, and mocking examples use the timers and randomness the repo bans in tests. Also left out: every non-vitest skill (Vue, Nuxt, UnoCSS, Vite, pnpm, ...), `scripts/`, `sources/`, `meta.ts`.

## Reformatting

Copied files were reformatted by oxfmt and their links adapted. Nothing executable was copied.
