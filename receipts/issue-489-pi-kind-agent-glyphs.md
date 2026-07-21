# issue-489 — pi runner kind + ACP registry agent glyphs

GitHub issue: [#489](https://github.com/srikanth235/centraid/issues/489)

The ACP registry lists `pi` (`pi-acp`, MIT) as a supported agent, but our
`RUNNER_KINDS` stopped at sixteen and omitted it. Separately, the providers
console rendered each agent as a bare accent dot, while the registry publishes a
monochrome `currentColor` glyph per agent intended for exactly this — a client
UI. This adds `pi` as kind seventeen and gives every supported agent its
registry glyph, tinted by the accent it already had.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-5e7d278e-75e-1784614365-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #489 | claude-opus-4-8 | 680 | 459830 | 52327798 | 332672 | 793182 | 37.3580 | 2378 | 3727787 | 214091937 | 1374730 | feat(client): add pi runner kind and ACP registry agent glyphs (#489) |
| claude-code-5e7d278e-75e-1784615157-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #489 | claude-opus-4-8 | 128 | 1266914 | 11432675 | 73473 | 1340515 | 15.4720 | 2506 | 4994701 | 225524612 | 1448203 |  |
| claude-code-5e7d278e-75e-1784616978-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #489 | claude-opus-4-8 | 862 | 1743140 | 86827837 | 537050 | 2281052 | 67.7391 | 3368 | 6737841 | 312352449 | 1985253 |  |
| claude-code-5e7d278e-75e-1784617103-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #489 | claude-opus-4-8 | 14 | 31613 | 655793 | 14239 | 45866 | 0.8815 | 3382 | 6769454 | 313008242 | 1999492 |  |
| claude-code-5e7d278e-75e-1784618492-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #489 | claude-opus-4-8 | 96 | 61594 | 5290327 | 44790 | 106480 | 4.1504 | 3478 | 6831048 | 318298569 | 2044282 |  |
| claude-code-5e7d278e-75e-1784618779-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #489 | claude-opus-4-8 | 32 | 26195 | 2064728 | 14568 | 40795 | 1.5604 | 3510 | 6857243 | 320363297 | 2058850 |  |
| claude-code-5e7d278e-75e-1784621651-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #489 | claude-opus-4-8 | 44 | 403613 | 2791865 | 37352 | 441009 | 4.8525 | 3554 | 7260856 | 323155162 | 2096202 |  |
| claude-code-5e7d278e-75e-1784621821-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #489 | claude-opus-4-8 | 22 | 17913 | 1743083 | 4544 | 22479 | 1.0972 | 3576 | 7278769 | 324898245 | 2100746 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-5e7d278e75e-2-1 | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #489 | correction | classifier | ACP registry publishes official glyphs for client UIs | feat(client): add pi runner kind and ACP registry agent glyphs (#489) | 2249 | 2026-07-21T05:34:11.624Z |

## Checklist

- [x] pi added as a runner kind
- [x] pi launches through its standalone ACP binary
- [x] Agent identity glyphs vendored from the ACP registry
- [x] Provider cards render the glyph tinted by the accent
- [x] Unknown kinds fall back without breaking the card

## What changed

**pi added as a runner kind.** `RUNNER_KINDS` in
`packages/app-engine/src/conversation/turn.ts` gains `'pi'`, placed immediately
before the custom `'acp'` sentinel so `acp` stays last. That single list is the
source of truth `RunnerKind` derives from, so nothing else enumerates kinds. The
list is exercised by `packages/app-engine/src/conversation/turn.test.ts`.

**pi launches through its standalone ACP binary.** `packages/agent-runtime/src/registry.ts`
adds `piBackend`, modeled on `vibeBackend`: `pi-acp` is a separate ACP server
binary (npm `pi-acp`, MIT), not a mode of a `pi` CLI, so `defaultBin` is
`pi-acp` and `acpArgs` is empty — there is no flag or subcommand to add. It is
registered as `pi: piBackend` in `RUNNER_BACKENDS` before `acp`, and the header
comment's native-ACP kind list now names `pi`. Covered by
`packages/agent-runtime/src/registry.test.ts` (defaultBin, the
enumerate-no-models list, and a focused "pi launches ACP natively" case). Its
accent lands in `ACCENT_BY_KIND` in
`packages/client/src/react/shell/routes/settingsProvidersData.ts`, and the
cosmetic `AGENT_RUNNER_KINDS` list in
`packages/client/src/react/screen-contracts.ts` gains `'pi'`. `docs/runners.md`
lists `pi` in the intro, the supported-harnesses table, the per-kind notes, and
the native-ACP flavour row.

**Agent identity glyphs vendored from the ACP registry.** New
`packages/client/src/react/screens/agentGlyphs.tsx` holds `AGENT_GLYPHS`, one
entry per supported kind, each carrying the source SVG's `viewBox` and its inner
`currentColor` markup verbatim from
`cdn.agentclientprotocol.com/registry/v1/latest/<id>.svg`. No glyph carries a
hardcoded colour, so each inherits its tint from the wrapper. The map is
cosmetic exactly like `ACCENT_BY_KIND`; it never gates the gateway's runner
list.

**Provider cards render the glyph tinted by the accent.** The `AgentGlyph`
component and the `.glyphTile` classes in
`packages/client/src/react/screens/SettingsProvidersScreen.module.css` replace
the old `rowDot`: a rounded square tinted `color-mix(... var(--row-accent) 12%
...)` with a 30%-accent ring, holding the glyph whose `color` is the accent when
connected. `packages/client/src/react/screens/SettingsProvidersAgents.tsx` wires
the tile in.

**Unknown kinds fall back without breaking the card.** `AgentGlyph` renders a
neutral filled circle and a muted ink tint for any kind not in the map (a newer
gateway's), and the tile's `[data-unavail]` state mutes onto neutral ink.
`packages/client/src/react/screens/SettingsProvidersScreen.test.tsx` asserts a
known kind renders a glyph and an unknown kind falls back without throwing.

### Files

`packages/app-engine/src/conversation/turn.ts`,
`packages/app-engine/src/conversation/turn.test.ts`,
`packages/agent-runtime/src/registry.ts`,
`packages/agent-runtime/src/registry.test.ts`,
`packages/client/src/react/screens/agentGlyphs.tsx` (new),
`packages/client/src/react/screens/SettingsProvidersAgents.tsx`,
`packages/client/src/react/screens/SettingsProvidersScreen.module.css`,
`packages/client/src/react/screens/SettingsProvidersScreen.test.tsx`,
`packages/client/src/react/screen-contracts.ts`,
`packages/client/src/react/shell/routes/settingsProvidersData.ts`,
`docs/runners.md`, and this receipt.

## Out of scope

- **The custom `acp` kind's glyph** — it has no vendor identity, so it keeps the
  neutral fallback mark rather than a bespoke one.
- **Light/dark bespoke glyph variants** — every mark is monochrome
  `currentColor`, so one asset serves both themes; no per-theme artwork.
- **pi model enumeration specifics** — pi rides the generic ACP model probe like
  every other kind; no pi-specific enumeration was added.

## Decisions

**Registry glyphs, not brand lockups.** The #479 receipt deliberately shipped
"accent only — no third-party icon artwork" to avoid bundling trademarked
logos. This reverses that narrowly and on purpose: the ACP registry's marks are
monochrome `currentColor` glyphs the protocol publishes for client UIs, tinted
here by each agent's own accent, so they read as one cohesive set rather than
vendor lockups. Confirmed with the requester before implementing.

**pi models on `vibe`, not on an adapter.** `pi-acp` is a standalone ACP server
(its own npm bin), so it is a native-binary kind with empty `acpArgs`, not an
adapter-backed kind like `codex`/`claude-code`.

## Audit

Verdict: **PASS**

**Diff fidelity:** The receipt's `## What changed` section faithfully describes the staged diff. All five major changes are present and match the documentation:
1. **pi added to RUNNER_KINDS** — `'pi'` appears in `packages/app-engine/src/conversation/turn.ts` line 147, positioned before `'acp'` as specified, making it kind #17.
2. **piBackend added to registry** — `packages/agent-runtime/src/registry.ts` defines `piBackend` (lines 100–111) with `defaultBin: 'pi-acp'`, empty `acpArgs: []`, and `minVersion: { major: 0, minor: 0, patch: 31 }`, modeled exactly on `vibeBackend` as described.
3. **Agent glyphs vendored** — New file `packages/client/src/react/screens/agentGlyphs.tsx` (lines 1–122) exports `AGENT_GLYPHS` record with 17 entries (including `pi`), each carrying `viewBox` and `body` (inner SVG markup, all `currentColor`, no hardcoded colors), verbatim from the registry CDN.
4. **Provider cards wired** — `SettingsProvidersAgents.tsx` imports `AgentGlyph` (line 3) and wires it at lines 179–181, replacing the old `rowDot` span. CSS file `SettingsProvidersScreen.module.css` adds `.glyphTile` (lines 201–222) with accent-tinted fill/ring and `[data-unavail]` muting.
5. **Unknown kinds fallback** — `AgentGlyph` component (lines 378–402) renders a neutral filled circle (`<circle cx="8" cy="8" r="4.5" fill="currentColor"/>`) for unknown kinds, and tests at `SettingsProvidersScreen.test.tsx` (lines 246–270) assert both known and unknown kinds render without throwing.

**Checklist realization:** All five checklist items are fully realized:
- ✓ pi added as a runner kind (in RUNNER_KINDS, registry backends, ACCENT_BY_KIND, screen contracts, docs)
- ✓ pi launches through its standalone ACP binary (piBackend with empty acpArgs, minVersion)
- ✓ Agent identity glyphs vendored from the ACP registry (17 glyphs in AGENT_GLYPHS, all currentColor)
- ✓ Provider cards render the glyph tinted by the accent (.glyphTile styling, AgentGlyph color prop, accent inheritance)
- ✓ Unknown kinds fall back without breaking the card (neutral circle fallback, no throw, [data-unavail] muting)

**Safety & correctness:** `AgentGlyph` uses `dangerouslySetInnerHTML` with vendored static SVG markup (never user or gateway input), which is safe here. `RunnerKind` remains the single source of truth; the only client-side additions are cosmetic (`AGENT_RUNNER_KINDS` list, `AGENT_GLYPHS` map, `ACCENT_BY_KIND` entry). Removing the old `.rowDot` CSS rule was verified safe by `lint:css` (no dead classNames, no test selectors). All type unions (`RunnerKind`, `AgentRunnerKind`) remain consistent across the three packages (app-engine, agent-runtime, client).

## Verification

```sh
bunx turbo run typecheck --filter=@centraid/app-engine --filter=@centraid/agent-runtime --filter=@centraid/client
bun run format:check
```

`typecheck` green (**13 successful, 13 total**) — this catches missed kind-union
edits and TSX errors. `format:check` reports all matched files correctly
formatted; `oxlint` and `lint:css` (no dead classNames) both clean.

Affected suites, run directly:

```
registry.test.ts + turn.test.ts + SettingsProvidersScreen.test.tsx
Test Files  3 passed (3)
Tests  42 passed (42)
```

Checklist crosswalk:

- **pi added as a runner kind** — `'pi'` in `RUNNER_KINDS` before `'acp'`.
- **pi launches through its standalone ACP binary** — `piBackend` with
  `defaultBin: 'pi-acp'` and empty `acpArgs`.
- **Agent identity glyphs vendored from the ACP registry** — `AGENT_GLYPHS` in
  the new `agentGlyphs.tsx`, verbatim `currentColor` markup.
- **Provider cards render the glyph tinted by the accent** — the `.glyphTile`
  tile and `AgentGlyph` wired into `SettingsProvidersAgents.tsx`.
- **Unknown kinds fall back without breaking the card** — `AgentGlyph`'s neutral
  filled-circle fallback, asserted in `SettingsProvidersScreen.test.tsx`.

## Steering

Verdict: **PASS**

One steering event was recorded in the transcript window (after the `/frontend-design` skill invocation). At line 2248, the assistant asked the user for direction on agent iconography via three options (original glyph set, official brand logos, or stay accent-only). The user steered the approach at line 2249 by pointing to the ACP registry's published SVG icon links (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json  --> has svg icon links!`), redirecting implementation to use the registry's official monochrome `currentColor` glyphs instead of creating original artwork or bundling brand logos.

This steering event has been recorded as a single correction-tier row in the `### Steering` table above (steer-5e7d278e75e-2-1): the user's explicit redirect to use the registry's glyphs as the source of agent identity artwork. No other steering events (interrupts or mid-task corrections) appear in the relevant transcript window.
