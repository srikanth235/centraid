# issue-186 — Agents settings: show Claude Code version + switch the active agent

GitHub issue: [#186](https://github.com/srikanth235/centraid/issues/186)

The desktop **Settings → Agents** panel was read-only detection with two
gaps. Claude Code's CLI version was dropped whenever Codex was also
present, and there was no UI to choose which agent the gateway drives —
the `agent.runner.kind` pref was only writable by the daemon config
seeder, and the "Preferred / Standby" badges were cosmetic (hardcoded
codex-first rather than the real selection).

## Checklist

- [x] Show the Claude Code version uniformly for both agents
- [x] Read `agent.runner.kind` and reflect the active selection in the badges
- [x] Add a clickable agent switcher that writes the pref
- [x] Refresh the chat model picker after switching

## What changed

Single file: `apps/desktop/src/renderer/app.ts` (Agents settings panel).
No gateway/API changes — the `claudeVersion` field and the
`agent.runner.kind` pref already existed; this surfaces and writes them.

**Show the Claude Code version uniformly for both agents.** Both Codex
and Claude Code now render through one row builder that emits a generic
`<bin> CLI detected · <version>` subtitle. The old code only
interpolated `claudeVersion` in the branch where Codex was absent, so
Claude's version vanished whenever both CLIs were detected.

**Read `agent.runner.kind` and reflect the active selection in the
badges.** The panel now loads the gateway pref on mount (defaulting to
`codex`) and renders **Active / Standby / Not found** badges keyed off
the real selection instead of a hardcoded codex-first ordering. The
active row is outlined in the agent's accent color.

**Add a clickable agent switcher that writes the pref.** An available,
non-active row is keyboard-accessible (`role=button`, Enter/Space) and,
on activation, writes `agent.runner.kind` via `saveUserPrefs`
optimistically (reverting on failure) and toasts.

**Refresh the chat model picker after switching.** Because the model
picker lists the active runner's catalog/tiers, a successful switch
re-runs `loadChatModels({ refresh: true })`.

## Out of scope

- No changes to the gateway runner-selection logic or the codex/claude
  adapters — only the desktop UI that reads/writes the existing pref.
- Incidental: normalized the adjacent `SettingsPageId` union to a single
  line, which `oxfmt --check` requires (it flags the pre-existing
  multi-line form). Not part of the feature, but needed for format:check.

## Verification

- `apps/desktop` typecheck passes (`tsc -p tsconfig.json --noEmit`).
- `oxlint` reports 0 warnings / 0 errors on the touched file.
- `oxfmt` clean on the added block.
- Not exercised in a live UI: the Agents panel is Electron renderer code
  that needs a running gateway + preload bridge, which the
  browser-preview harness can't drive. Recommend a manual click-through
  (switch agents, confirm the chat model picker repopulates and the
  version shows on the standby row).
