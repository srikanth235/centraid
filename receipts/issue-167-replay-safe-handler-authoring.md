# issue-167 — Safe handler scripts conformant with the automation runtime

GitHub issue: [#167](https://github.com/srikanth235/centraid/issues/167)

Updates the **builder's code-generation contract** so the handlers it authors
are safe under the automation runtime. Two properties: every outside effect goes
through the **audited `ctx.*` rails** (recorded in the run ledger, gated by
`requires.tools`), and the handler stays **deterministic** (a crashed fire
re-runs from the top — there is no resume journal — so a wall-clock read or a
random value makes the re-run diverge and re-fire effects under fresh ids). This
issue teaches that contract (grounding + scaffold), enforces it (a static lint
at the publish gate), and frames the two cost rails (`ctx.tool` free /
`ctx.agent` billed).

**Reconciled with [#172](https://github.com/srikanth235/centraid/issues/171):**
#167 was written against #166's journal/replay runtime. While this branch was in
review, #172 **retired the crash-resume journal and dropped `ctx.invoke`**. The
determinism rules survive — they were re-anchored from "keep the replay journal
in sync" to "all effects through the audited `ctx.*` rails + deterministic,
idempotent re-runs (a crashed fire re-runs from the top)". The lint only ever
matches *raw globals*, so anything on the `ctx.*` surface passes untouched.

**`ctx.now`/`random`/`uuid`:** there are none — get those needs deterministically
via `ctx.runs.last()` / `ctx.state`, ids derived from the run inputs, or a
timestamp off a `ctx.tool` result.

**Canonical handler signature:** `export default async ({ ctx, log }) => {}` —
what the worker actually invokes (`automation-runner.ts` calls
`mod.default({ ...args, log, ctx })`). The scaffold + SKILL emit this shape.

## Checklist

- [x] SKILL.md: audited-rails + determinism rules + two-rails cost model + requires.model tier guidance
- [x] DEFAULT_HANDLER: ctx.tool + deterministic transform + justified ctx.agent
- [x] starterManifest emits requires.tools + requires.model
- [x] Static handler lint wired into the publish gate (validate-manifest.ts)
- [x] host-tools enumeration matches the persistent-mock tool surface (no change)

## What changed

### SKILL.md: audited-rails + determinism rules + two-rails cost model + requires.model tier guidance

`automation-authoring/SKILL.md` gains an **Audited rails + determinism** section
(all effects through `ctx.*` — recorded in the run ledger + gated by
`requires.tools`; the forbidden list — no `Date.now`/`new Date()`/`Math.random`/
`randomUUID`/raw `fetch`/`fs`/`process.*`; the no-`ctx.now`/`random`/`uuid` note +
deterministic alternatives; "pure JS between `ctx.*` calls is free"; it mentions
the publish-time lint) and a **Two cost rails** section (`ctx.tool` ~0 tokens /
`ctx.agent` billed; pick the cheapest sufficient `requires.model` tier; batch,
don't loop `ctx.agent`). The `requires.model` manifest rule now frames tier
selection.

### DEFAULT_HANDLER: ctx.tool + deterministic transform + justified ctx.agent

`scaffold-automation.ts`'s `DEFAULT_HANDLER` is rewritten as a clean worked
example: a watermark via `ctx.runs.last`, a `ctx.tool` fetch, a deterministic JS
filter, and a justified `ctx.agent` call with a `json` schema — under a comment
block stating the audited-rails + determinism contract + two cost rails, with the
canonical `({ ctx, log }) => {}` signature and the `AutomationHandler` JSDoc type.
A scaffold-files test asserts the emitted handler passes the lint.

### starterManifest emits requires.tools + requires.model

`starterManifest` now seeds `requires.tools: []` (the allowlist slot the builder
grows as it adds `ctx.tool` calls) and keeps `requires.model` only when a tier
is chosen — never a misleading default.

### Static handler lint wired into the publish gate (validate-manifest.ts)

New `automation-handler-lint.ts` (in `@centraid/conversation-engine`, under
`src/automation/`) exports `lintAutomationHandlerSource(source) →
HandlerLintFinding[]` and `formatHandlerLintError(findings, file)`. A
dependency-free lexical scanner masks comments and string/template literals (to a
NUL sentinel, so `new Date('x')` stays distinguishable from the argless
`new Date()`) while keeping real code — including interpolated `${…}`
expressions — then runs prescriptive rules: `no-date-now`, `no-new-date`,
`no-math-random`, `no-random-uuid`, `no-random-bytes`, `no-performance-now`,
`no-raw-fetch`, `no-node-io-import` (fs/child_process/net/http/…),
`no-process-ambient`. It is wired into the publish gate: `validateManifestAt`
(extracted out of `apps-store-routes.ts` into a dedicated `validate-manifest.ts`
to keep the hub file under the 500-line cap; re-exported so importers are
unchanged) lints every `automations/<id>/handler.js` for `kind: 'automation'`
apps and returns the formatted authoring error — so an unsafe handler is rejected
at publish time, not surfaced at fire time.

### host-tools enumeration matches the persistent-mock tool surface (no change)

Verified, no code change: `host-tools.ts` snapshots the tool surface off the same
`startMockLlmServer` first-request that `persistent-mock-session.ts` drives, so
the enumerated `ctx.tool` names are exactly what a deployed handler reaches (the
file header already documents this).

## Out of scope

- **Re-adding crash-resume / journaled `ctx.now()` / `ctx.random()` /
  `ctx.uuid()` primitives** — the journal was retired in #172; this issue keeps
  the deterministic-by-default contract, and the lint is forward-compatible if
  such `ctx.*` primitives are ever added.
- **Enforcing `requires.tools` / `requires.mcps` as a runtime allowlist** — they
  remain declarative metadata today (no code consumes them); unchanged here.
- **End-to-end three-host parity run** (codex/claude/OpenClaw firing a real
  sample) — needs live agent CLIs/credentials. The runtime is unchanged by this
  issue; the conversation-engine fire/persistent-mock suites cover parity, and a
  unit test asserts the scaffolded default handler passes the lint.

## Verification

- `turbo run typecheck` green (19/19). `oxlint .` (0/0) + `oxfmt --check .`
  clean.
- New tests: `automation-handler-lint.test.ts` (12) covers clean handlers,
  every rule, comment/string masking, template-interpolation scanning, nested
  braces, and line/column accuracy; `validate-automation-handler.test.ts` (4)
  covers the gateway gate accepting a safe handler and rejecting
  `Date.now`/`fetch`+`Math.random`, and *not* linting non-automation apps;
  `scaffold-automation-files.test.ts` asserts the emitted default handler is
  lint-clean and that `requires.tools` is seeded.
- Full suites green after merging #172: `conversation-engine` 95, `gateway` 87.
- host-tools enumeration matches the persistent-mock tool surface (task 5):
  `host-tools.ts` snapshots the tool surface off the same `startMockLlmServer`
  first-request that `persistent-mock-session.ts` drives, so the enumerated
  `ctx.tool` names are exactly what a handler reaches — no change needed
  (documented in the file header).
