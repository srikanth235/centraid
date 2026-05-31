# Plan: replace `@centraid/agent-harness` with a `skills/` model

**Issue anchor:** #145 (extends the code-store/gateway rename receipt)
**Status:** proposal — no code changed yet
**Decisions locked in:** new `@centraid/skills` package · whole-builder scope ·
plan-first. **Key correction since first draft:** both Claude *and* codex
support model-invoked skills over the protocols centraid already uses — the
design is symmetric, not Claude-only (see §2).

---

## 1. Why

`@centraid/agent-harness` mixes three unrelated concerns under a misleading
name (there's no in-process "agent" or "session" anymore since #141):

| Group | Files | Verdict |
| --- | --- | --- |
| **A. Agent grounding** (the real "harness essence") | `system-prompt.ts`, `ui-grounding.ts`, `tools-grounding.ts` | → becomes **`@centraid/skills`** |
| **B. App file generators** | `scaffold-files.ts`, `scaffold.ts`, `scaffold-automation.ts`, `scaffold-defaults.ts`, `clone.ts`, `app-rewrites.ts` | → move into **`@centraid/app-engine`** |
| **C. Gateway HTTP client (dead)** | `gateway-client.ts`, `publish.ts`, `app-files.ts`, `config.ts` | → **delete** (no consumers) |

Only `@centraid/gateway` imports agent-harness today; desktop/mobile have their
own clients. After this plan, **agent-harness is deleted entirely.**

The new idea: model group A not as TypeScript string-builders but as a
**skills directory** — markdown `SKILL.md` units that are editable without
touching TS and, on the Claude backend, loaded on demand (progressive
disclosure) instead of always concatenated into the prompt.

---

## 2. Both backends support skills natively (corrected)

> **Earlier draft assumed codex had no skills concept. That was wrong.** Both
> backends do model-invoked progressive disclosure, and — critically — both
> discover `SKILL.md` from disk **relative to the agent's cwd**, which is
> already the app draft worktree. This makes a genuinely symmetric design
> possible.

Verified:

- **Claude** (`@anthropic-ai/claude-agent-sdk@0.3.143`, `claude-sdk.ts`):
  `skills: string[]|'all'`, `settingSources: ['skills', …]`,
  `plugins: [{type:'local', path}]`. Discovers skills under
  `<cwd>/.claude/skills` (via `settingSources`) or an explicit plugin path.
- **Codex** (`codex-app-server.ts`, JSON-RPC — the protocol centraid already
  speaks, NOT the codex TS SDK): supports skills via
  - `skills/list` request — params `{ cwds, forceReload, perCwdExtraUserRoots }`;
    returns `{name, description, enabled}` metadata (progressive disclosure).
  - `skills/changed` notification — cache-invalidation signal.
  - skill reference in `turn/start` input:
    `{ "type": "skill", "name": "...", "path": ".../SKILL.md" }`, and/or a
    `$<skill-name>` text marker.
  - Discovery scopes (CWD → repo root): `$CWD/.agents/skills`,
    `$CWD/../.agents/skills`, `$REPO_ROOT/.agents/skills`, then
    `$HOME/.agents/skills`, `/etc/codex/skills`, bundled. **OR** add an external
    root via `perCwdExtraUserRoots` on `skills/list` — no worktree pollution.
  - SKILL.md format is the same as Claude's: YAML frontmatter `name` +
    `description`, then the body. **One content format serves both.**

**Conclusion / advice:** one `skills/` content source; both backends get real
progressive disclosure. The remaining difference is *integration effort and
discovery wiring*, not capability — see §2b. This fully honors the
provider-agnostic principle (identical behavior, not just identical content).

### 2b. Discovery wiring — the real decision

Two viable ways to make the on-disk skills discoverable, each with a tradeoff:

- **Option D1 — write skills into the draft worktree.** Drop the skill dirs at
  `<cwd>/.agents/skills/*` (codex auto-discovers) and `<cwd>/.claude/skills/*`
  (claude via `settingSources:['skills']`). Zero protocol work — both backends
  just find them. **Cost:** pollutes the app's git store / draft unless excluded
  (the publish allowlist + scaffold ignore-set would need to skip these dirs).
- **Option D2 — external skills dir, explicit registration.** Keep skills in the
  `@centraid/skills` package dir; register without copying:
  - Claude: `plugins: [{type:'local', path: skillsDir()}]` (or `settingSources`
    pointed at it).
  - Codex: pass `perCwdExtraUserRoots` → the skills dir on the `skills/list`
    call, and inject skill refs into `turn/start`.
  **Cost:** more adapter wiring (centraid's codex adapter must add a
  `skills/list` round-trip + skill-ref injection; today it does neither).

**Recommendation: D2.** It keeps the app worktree clean (no governance/publish
fallout) and keeps skills versioned with the package. The codex adapter gains a
`skills/list` call — moderate, well-scoped work. D1 is the fast path if we want
to ship before doing codex protocol work; it could even be a phase-1 stepping
stone (D1 first, migrate to D2).

> The fallback "concatenate SKILL.md into the instruction string" path is no
> longer the codex story — it's only a last-resort degradation if D2's codex
> wiring slips. Keep `composeSkills()` in the loader for that safety valve, but
> it's not the primary delivery anymore.

### 2c. The dynamic-content wrinkle (applies to BOTH backends)

Three grounding inputs are computed at runtime and **cannot** be static
`SKILL.md` files:

1. **Live design-token CSS** — `toCss()` from `@centraid/design-tokens`.
2. **Host-tool list** — `enumerateHostTools(prefs.kind)`, per-runner.
3. **Live app schema** — already injected by the chat route as `baseExtra`.

Plan: tokens/icons change rarely → **generate** their `SKILL.md` at build time
from `@centraid/design-tokens` (a snapshot, like the scaffold's `tokens.css`).
Host-tools + live-schema stay as a small **appended block** via
`systemPrompt.append` / `developerInstructions` on every turn — they are not
skills on either backend. So even Claude is a hybrid: static skills discovered
from disk **+** a per-turn dynamic appendage.

---

## 3. Target shape of `@centraid/skills`

```
packages/skills/
  package.json            # deps: @centraid/design-tokens (build-time gen only)
  scripts/build-skills.mjs # regenerates the design-tokens SKILL.md snapshot
  skills/
    authoring-centraid-apps/SKILL.md   # ← system-prompt.ts CENTRAID_APPEND_PROMPT
    automation-authoring/SKILL.md      # ← system-prompt.ts AUTOMATION_APPEND_PROMPT
    centraid-ui-design/SKILL.md        # ← ui-grounding.ts (GENERATED: tokens+icons)
  src/
    index.ts              # loader API (below)
    compose.ts            # SKILL.md → string concatenation (codex path)
    dynamic.ts            # host-tools block builder (was tools-grounding.ts)
```

Each `SKILL.md` has YAML frontmatter (`name`, `description`) + markdown body —
the Anthropic skill format, so the Claude SDK discovers them natively.

### Loader API (`src/index.ts`)

```ts
// Static skill catalog on disk — absolute path for SDK registration.
export function skillsDir(): string

// List skill {name, description} for logging / selection.
export function listSkills(): SkillMeta[]

// CODEX PATH: concatenate the bodies of the named skills into one string.
export function composeSkills(names: string[]): string

// DYNAMIC (both paths): host-tools block; undefined when no tools.
export function buildToolsGroundingBlock(tools: readonly HostTool[]): string | undefined
```

Which skills apply is decided by `appKind` (today's branch in
`unified-chat-runner.ts`):
- `app`     → `['authoring-centraid-apps', 'centraid-ui-design']`
- `automation` → `['automation-authoring']`

---

## 4. Backend wiring changes

### `packages/agent-runtime/src/runtime.ts` (`AgentTurnInput`)

Add an optional skills descriptor alongside the existing `extraSystemPrompt`:

```ts
skills?: { dir: string; names: string[] | 'all' }   // claude uses it; codex ignores
```

`extraSystemPrompt` stays — it carries the dynamic appendage (host-tools +
live-schema) on both backends, and the full composed string on codex.

### `packages/agent-runtime/src/claude-sdk.ts`

In the `options` object (currently lines 99–126), when `input.skills` present:

```ts
options.settingSources = ['skills']            // or plugins:[{type:'local',path:dir}]
options.skills = input.skills.names            // 'all' | string[]
// extraSystemPrompt.append still carries dynamic host-tools + schema block
```

> ⚠️ **Spike needed:** confirm the exact discovery wiring — whether the dir is
> registered via `settingSources:['skills']` (expects `<cwd>/.claude/skills`) or
> via `plugins:[{type:'local', path: skillsDir()}]`. ~30-min experiment against
> the installed SDK before committing to one. This is the only real unknown.

### `packages/agent-runtime/src/codex-app-server.ts`

**Changed from earlier draft.** Under D2 (recommended), the codex adapter:
1. After `thread/start`, issue a `skills/list` with
   `{ cwds:[cwd], perCwdExtraUserRoots:[skillsDir()] }` (or rely on
   `<cwd>/.agents/skills` under D1).
2. Inject the selected skills as `{type:'skill', name, path}` items in the
   `turn/start` input (alongside the user text), letting codex progressively
   disclose them.
3. Keep `developerInstructions` for the **dynamic** appendage only (host-tools +
   live schema), same as Claude.

If codex skill wiring is deferred, fall back to `composeSkills()` into
`developerInstructions` (the safety valve) — behavior identical to today.

### `packages/gateway/src/unified-chat-runner.ts`

`buildUnifiedExtraPrompt()` becomes backend-uniform under D2 — both get the
skills descriptor + the dynamic appendage; only the dynamic block ever goes into
the instruction string:

```ts
const names = appKind === 'automation'
  ? ['automation-authoring']
  : ['authoring-centraid-apps', 'centraid-ui-design']
const toolsBlock = buildToolsGroundingBlock(await groundingToolsFor(...))
const dynamic = [baseExtra, toolsBlock].filter(Boolean).join('\n\n')

return {
  extraSystemPrompt: dynamic,             // host-tools + live schema, both backends
  skills: { dir: skillsDir(), names },    // claude + codex both consume this
}
// runAgentTurn forwards `skills` to whichever adapter runs;
// composeSkills(names) stays available as the codex fallback if its
// skills/list wiring is deferred.
```

Imports change from `@centraid/agent-harness` →
`@centraid/skills` (grounding) and stay on `@centraid/app-engine` for the rest.

---

## 5. Group B move (scaffolders → app-engine)

Mechanical relocation; app-engine already owns parse/validate of the app format,
so it gains generate too. The disk-based wrappers in `scaffold.ts`
(`scaffoldApp`, `listAppsOnDisk`, `deleteApp`, `updateAppMeta`) and the disk
clone wrapper are **dead** (no callers) — strip them while moving; keep only the
`*Files` generators the gateway uses.

- `scaffold-files.ts`, `scaffold-automation.ts` (Files variants only),
  `clone.ts` (`cloneTemplateFiles` + `suggest*` only), `app-rewrites.ts`,
  `scaffold-defaults.ts` → `packages/app-engine/src/`.
- `HarnessError`, `AppInfo`, `ScaffoldFile` types → app-engine (rename
  `HarnessError`? see open question Q1).
- app-engine `index.ts`: export `scaffoldAppFiles`, `updateAppMetaFiles`,
  `appPackageJson`, `scaffoldAutomationAppFiles`, `setAutomationEnabledInFiles`,
  `deleteAutomationFromFiles`, `cloneTemplateFiles`, `suggestCloneIdentityFrom`,
  `validateAppId`, `ScaffoldFile`, etc.
- app-engine already depends on `@centraid/design-tokens`? **No** — add it
  (scaffold-files uses `toCss()`). Actually `toCss()` only used by the scaffold
  snapshot; keep that dependency local to app-engine.

`@centraid/app-engine` already has no `@centraid/*` runtime deps; adding
`design-tokens` is fine (design-tokens is a leaf).

## 6. Group C delete

Remove `gateway-client.ts`, `publish.ts`, `app-files.ts`, `config.ts` + their
tests. Drop the `tar` dependency from the package (only publish.ts used it).
Confirmed zero external importers.

---

## 7. Execution order (each step compiles + typechecks green)

1. **Create `@centraid/skills`** with the loader + the three `SKILL.md` files
   (port the prose verbatim from `system-prompt.ts` / `ui-grounding.ts`), plus
   the build-time tokens generator and `dynamic.ts` (host-tools). Unit-test
   `composeSkills` / `listSkills`.
2. **Spike both backends' discovery wiring** (§2b / §4 ⚠️):
   - Claude: confirm `settingSources:['skills']` vs `plugins:[{type:'local'}]`.
   - Codex: confirm `skills/list` + `perCwdExtraUserRoots` + skill-ref injection
     in `turn/start` against the installed `codex app-server`.
   Decide D1 vs D2. ~1–2h experiment; this is the only real risk.
3. **agent-runtime**: extend `AgentTurnInput.skills`; wire `claude-sdk.ts` and
   `codex-app-server.ts` (skills/list + turn/start refs).
4. **Move Group B → app-engine**; update app-engine `index.ts`; delete the dead
   disk wrappers.
5. **Rewire gateway** (`unified-chat-runner.ts` + the 5 lifecycle/test import
   sites): grounding from `@centraid/skills`, scaffolders from
   `@centraid/app-engine`, `HarnessError` from app-engine.
6. **Delete Group C** and then the whole `packages/agent-harness/` dir +
   workspace ref.
7. `turbo run typecheck && turbo run test`; update receipt #145; commit.

Suggested commit slices (per your commit-division preference):
- `feat(skills): add @centraid/skills package (grounding as SKILL.md) (#145)`
- `refactor(app-engine): absorb app scaffolders from agent-harness (#145)`
- `refactor: delete agent-harness; rewire gateway to skills + app-engine (#145)`

---

## 8. Open questions for you (deferred — plan review only)

- **Q1 — `HarnessError` name.** It moves to app-engine. Rename to
  `AppFormatError` / `ScaffoldError`, or keep the name? (Touches the 3 gateway
  catch sites.)
- **Q2 — discovery wiring D1 vs D2 (§2b).** D2 (external dir, explicit
  registration, no worktree pollution) recommended; D1 (write into worktree) is
  the faster stepping stone. Pick one, or D1→D2 phased.
- **Q3 — skill granularity.** `centraid-ui-design` is one big skill (tokens +
  icons + primitives + UX rules + exemplars). Split into smaller skills
  (`ui-tokens`, `ui-components`, `ui-a11y`) for finer progressive disclosure, or
  keep as one? Finer = better disclosure on *both* backends now, more files to
  maintain.
- **Q4 — package name.** `@centraid/skills` vs `@centraid/agent-skills` vs
  `@centraid/builder-skills`.
- **Q5 — codex skill triggering.** Codex picks skills from the `skills/list`
  metadata (name+description) progressively. Confirm whether our authoring
  skills should be *always-selected* (inject the refs every builder turn) or
  *model-chosen* (list them and let codex decide). Always-selected matches
  today's always-appended behavior; model-chosen is the true-progressive bet but
  risks codex skipping the authoring contract on a turn. **Leaning
  always-inject the core authoring skill, let UI/automation be model-chosen.**
```
