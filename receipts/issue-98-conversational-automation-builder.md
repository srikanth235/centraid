# issue-98 — Conversational automation builder + app-owned automations

GitHub issue: [#98](https://github.com/srikanth235/centraid/issues/98)

Supersedes #95. Replaces the form-based automation creation flow with a
chat-driven builder, and widens the definition of "app" from a UI bundle
to a **capability bundle** the builder can fill with automations as well
as UI.

## Checklist

- [x] Commit 1 — conversational automation builder + app-owned automations

Follow-up (tracked on #98, not in this commit):

- [ ] Schedule/execute app-owned automations — OS scheduler host + the
      `centraid run-automation` CLI resolving under `appsDir`,
      `runAutomationLocal` resolution, cloud `openclaw-plugin` host.
- [ ] Sibling resolution (`onFailure` / `ctx.invoke`) scoped per app.
- [ ] OS scheduler job labels namespaced by `ownerApp` to stay unique
      across apps.

## What changed

### Commit 1 — conversational automation builder + app-owned automations

#### builder-harness — automation-aware system prompts

- New `AUTOMATION_APPEND_PROMPT` describes the first-class automation
  project layout (`automation.json` + `handler.js`), the manifest
  schema, and the guardrails — never self-enable, never mint webhook
  secrets. `createCentraidAgentSession` takes a `projectKind`
  (`'app' | 'automation'`) that selects the prompt and skips the app
  UI-grounding blocks for automations.
- `CENTRAID_APPEND_PROMPT`'s stale automations section (the pre-#91
  `automations/<name>.json` + `actions/<name>.js` model) is rewritten:
  an app is a capability bundle, the app builder recognizes trigger
  intent ("every morning", "remind me", "weekly"…) and authors
  `automations/<id>/automation.json` + `handler.js` *inside the app*,
  alongside the UI. An app may own several automations — distinct slug
  per automation; reuse a slug to revise, new slug to add.
- `scaffoldAutomationProject` takes an `enabled` option so the builder
  can scaffold a disabled draft.

#### runtime-core — discovery foundation for app-owned automations

- `AutomationRow` gains `ownerApp?` — set when an automation lives at
  `<appsDir>/<appId>/automations/<id>/` rather than as a standalone
  project under `automationsDir`. `dir` stays the authoritative path.
- `readAutomationProjectAt(dir, ownerApp?)` reads from an explicit
  directory; `readAutomationProject` delegates to it.
- `listAppOwnedAutomations(appsDir)` scans every app's `automations/`
  subdir; `listAllAutomationProjects` returns the standalone + app-owned
  union. `APP_AUTOMATIONS_SUBDIR` names the subdirectory.

#### desktop — automation builder mode

- `builder.ts` gains an automation mode (`projectKind: 'automation'`):
  the right pane becomes a read-only **Config** view rendered from
  `automation.json` (intent, schedule with a plain-English gloss +
  next-3 fire times computed by a small in-renderer cron evaluator,
  behavior, connected apps) plus a **Runs** test-fire pane. The publish
  button becomes a draft Enable/Disable gate. The manifest is the
  source of truth; the form is a rendered view, re-read after each
  agent turn — not an editor.
- The `agent:start` IPC threads `projectKind`, routing automation
  sessions to `automationsDir` and skipping the app-only live-schema /
  preview-snapshot steps. `createAutomation` accepts `enabled`.
- The Automations page "New automation" button scaffolds a disabled
  draft and opens the builder; the old `openNewAutomationSheet` form
  (and its `CRON_PRESETS` / `RETENTION_PRESETS` helpers) is removed.

## Out of scope

- Scheduling and execution of app-owned automations — the OS scheduler
  host + `centraid run-automation` CLI + cloud gateway. This commit
  lands only the *discovery* foundation; the runtime wiring is the
  tracked follow-up on the checklist above.
- Webhook triggers in the chat builder — they need server-side secret
  minting the agent cannot do, so the prompts steer the agent to cron /
  manual automations.
- Bidirectional form editing — the config pane is a read-only rendered
  view of the manifest; chat is the only input.

## Verification

- Full monorepo `typecheck` — 16/16 turbo tasks green. `build` for the
  desktop chain green. Lint (`oxlint`) + format (`oxfmt`) clean across
  all changed files.
- The worktree had no `node_modules`; a worktree-local `bun install`
  was run so cross-package imports resolve to the worktree's own
  sources rather than the parent checkout's stale builds.
- The Electron builder UI was not interactively click-tested — the
  automation builder mode, chat→config-pane sync, test-fire, and the
  Enable gate are type/build-verified only.
