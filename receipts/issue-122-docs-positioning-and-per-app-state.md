# issue-122 — Docs: reposition Centraid as OpenClaw's rich-UI complement + correct per-app state

GitHub issue: [#122](https://github.com/srikanth235/centraid/issues/122)

## Checklist

- [x] Homepage and getting-started lead now position Centraid as OpenClaw's rich-UI complement
- [x] Homepage frames the OpenClaw relationship by interaction modality, not deployment topology
- [x] Two AI helpers framed in non-technical language
- [x] "What you get" rewritten for non-technical readers
- [x] `concepts/apps.mdx` split into source vs mounted trees, fixing a structural diagram bug
- [x] `build/app-anatomy.mdx` clarifies source-vs-mounted, expands reserved-names
- [x] `concepts/architecture.mdx` App concept bullet names both per-app SQLites
- [x] `deploy/sqlite-layout.mdx` corrected at the top and expanded throughout
- [x] `build/migrations.mdx` precision fix
- [x] Per-app state inventory verified against runtime-core sources
- [x] `bun run docs:build` builds all 37 pages clean; Pagefind indexes 36 pages, 2782 words

## What changed

**Homepage and getting-started lead now position Centraid as OpenClaw's rich-UI complement.** `docs/index.mdx` and `docs/getting-started.mdx` open with "Centraid turns your OpenClaw into a personal app store. Tiny, single-purpose apps that live on your own server and show up on your devices." The "personal app store" metaphor only lands when there's an OpenClaw hosting the apps persistently across devices, so it's tied to OpenClaw from the first sentence rather than presented as a standalone product claim.

**Homepage frames the OpenClaw relationship by interaction modality, not deployment topology.** Following the lead, three paragraphs cover: (1) OpenClaw is messaging-first — you talk to it from WhatsApp / Telegram / Slack with one-line jobs like "log my weight" or "what's on my calendar?"; (2) some things don't fit in a sentence — a month of expenses, a habit grid, last week's runs on a map, photos from the trip — those want a screen; (3) Centraid is the rich-UI layer for those, same OpenClaw underneath (your connections, your agents, your data) with a screen wrapped around the apps that need one. The earlier "complements OpenClaw" header was dropped because the new opening already establishes the relationship. Getting-started mirrors this in shorter form.

**Two AI helpers framed in non-technical language.** "One uses your apps for you" — chat AI ask in plain language; "One makes apps just for you" — builder AI describes a new app or a change to an existing one. Examples mix creation ("track my reading") with customization ("add a notes field", "show me a weekly chart") so the reader sees that the builder also updates, not just creates.

**"What you get" rewritten for non-technical readers.** Opens with a Notion analogy ("think of it like Notion — but for whole apps, not pages. A workspace of your own, stocked with small purpose-built apps you can use, change, or have an AI build for you"), then five bullets in plain language: automations (apps that work on their own), AI built in not bolted on, nothing to connect inside Centraid (OpenClaw owns the integrations), apps that remember you (per-app chat history + automation log stay local), your data your devices, one app everywhere. Technical bullets moved into a separate "Under the hood" section, and the request-flow mermaid diagram moved into that section as a subsection. The "Apps as folders" bullet in "Under the hood" now distinguishes the source tree from the mounted tree, names both sqlites, and includes the `versions/` snapshot directory.

**`concepts/apps.mdx` split into source vs mounted trees, fixing a structural diagram bug.** The old single diagram showed source files (`index.html`, `queries/`, `actions/`, `migrations/`, `automations/`, `app.json`) directly under `<appsDir>/<id>/` — but in reality those source files live one level deeper, inside `versions/v_*/`. Now two diagrams: the source tree (what the author uploads, no SQLite files) and the mounted tree (`<appsDir>/<id>/` contains `data.sqlite`, `runtime.sqlite`, `current.json`, and `versions/v_<ts>_<sha>/` snapshots). The "A unit of data isolation" bullet names both SQLite files and what each holds. The "Versions and `current.json`" section's inline diagram now shows both sqlites persisting across flips; "Why this split" rationale notes that chat history and automation runs stick around too, and the pruning-safety bullet covers both sqlites. The version-retention `(default 5, minimum 2)` clarification was added.

**`build/app-anatomy.mdx` clarifies source-vs-mounted, expands reserved-names.** Intro now states explicitly that the diagram is the *source tree* (what the author uploads) and links to the mounted layout in `concepts/apps`. The reserved-names list (files that are never served as static even if shipped, and that the publisher excludes on upload) now covers `data.sqlite`, `runtime.sqlite`, `current.json`, `versions/`, `_registry.json`, `_uploads/`, `_trash/`, `app.json`, and the `queries/` / `actions/` directories.

**`concepts/architecture.mdx` App concept bullet names both per-app SQLites.** Bullet now reads "a versioned folder of HTML/CSS/JS + handlers, paired with two persistent SQLite files (`data.sqlite` for app data, `runtime.sqlite` for chat sessions + agent run ledger + automation state)." The dispatcher mermaid diagram is unchanged — it's scoped to handler dispatch flow, where only `data.sqlite` participates.

**`deploy/sqlite-layout.mdx` corrected at the top and expanded throughout.** Opener no longer claims "There's no central database" — verified against `packages/openclaw-plugin/src/index.ts:93-96` (`dbDir = path.dirname(appsDir)`; `centraid-gateway.sqlite` and `centraid-analytics.sqlite` are instantiated there). Top-level layout starts at `<gatewayRoot>/`, shows the two gateway-level files as siblings to `<appsDir>/`, and adds `runtime.sqlite` next to `data.sqlite` in each per-app subdir. New section `<id>/runtime.sqlite` lists `chat_sessions`, `runs` / `run_nodes`, `automation_state`. New section "Gateway-level SQLites" describes what each centraid-*.sqlite holds (users + prefs; one summary row per run, every kind, denormalized rollup from per-app runtime.sqlite). Version-directory section explicitly notes "no `runtime.sqlite`" alongside "no `data.sqlite`." "What's NOT here" rewritten — "no central database" claim removed; replaced with accurate "no per-app user table" and "no cross-app handler database" framings. "Backing up" expanded to `<gatewayRoot>/`; "Resetting an app" includes removing `runtime.sqlite`.

**`build/migrations.mdx` precision fix.** Migration files apply to `data.sqlite` specifically (with a parenthetical note that `runtime.sqlite` is gateway-managed and authors don't write migrations for it).

**Per-app state inventory verified against runtime-core sources.** Cross-checked against `packages/runtime-core/src/{chat-history,gateway-db,version-store,manifest,automation-project,app-paths}.ts` and `packages/openclaw-plugin/src/index.ts`; specifics cited in the Verification section below.

## Out of scope

- Mermaid diagram width / fullscreen fixes — separate commit in this PR; non-content infra in `scripts/docs-site/assets.mjs`.
- The ~46 inline `> **TODO(#120)** —` callouts seeded throughout the docs. Some of the verifications done for this issue (e.g., the gateway-level SQLite layout) implicitly resolve adjacent TODOs in `deploy/sqlite-layout.mdx`, but the TODO callouts themselves are left for the dedicated [#120](https://github.com/srikanth235/centraid/issues/120) sweep.
- The `_chat/w<windowId>.jsonl` per-window transcript files described in `deploy/sqlite-layout.mdx` — both they and the new `runtime.sqlite#chat_sessions` table appear to coexist today (per-window JSONL transcripts referenced in `openclaw-plugin/README.md`; `chat_sessions` table verified in `runtime-core/src/chat-history.ts`). Documenting the relationship between the two stores is left as follow-up.

## Verification

- `bun run docs:build` builds all 37 pages clean; Pagefind indexes 36 pages, 2782 words.
- Live preview at `http://127.0.0.1:4173/` confirms the homepage frontmatter summary updated to "Centraid turns your OpenClaw into a personal app store — tiny apps that live on your own server and show up on your devices, with AI to use them and AI to build new ones."
- Per-app state claims cross-checked against:
  - `packages/runtime-core/src/chat-history.ts:147-155` — `runtime.sqlite` location and contents
  - `packages/runtime-core/src/gateway-db.ts:5-33, 105-219` — three migration ladders (gateway, runtime, analytics) and what tables each carries
  - `packages/openclaw-plugin/src/index.ts:86-96` — `dbDir = path.dirname(appsDir)` confirms gateway-level dbs as siblings to appsDir
  - `packages/builder-harness/src/publish.ts` (EXCLUDE set) — confirms the publisher excludes `data.sqlite`, `runtime.sqlite`, `current.json`, `versions/`, `_registry.json`, `_uploads`, `_trash` from uploads
- `concepts/apps.mdx` diagram bug: confirmed source files only ever land in `versions/v_<ts>_<sha>/` via `packages/runtime-core/src/version-store.ts` `commit()`, never at the app root.
