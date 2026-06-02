# issue-167 — Replay-safe handler scripts conformant with the new automation runtime

GitHub issue: [#167](https://github.com/srikanth235/centraid/issues/167)

Updates the **builder's code-generation contract** so the handlers it authors
conform to the #166 journal/replay runtime. A fire re-runs `handler.js` from the
top on every step, fast-forwarding past journaled `ctx.*` calls; replay is sound
only if the handler is **deterministic between syscalls**. This issue teaches
that contract (grounding + scaffold), enforces it (a static lint at the publish
gate), and frames the two cost rails (`ctx.tool` free / `ctx.agent` billed).

**Decision vs the original issue (the `ctx.now`/`random`/`uuid` question):**
#166 Phase 3 landed the journal/replay model **without** journaled
`ctx.now()`/`ctx.random()`/`ctx.uuid()` primitives. So this issue takes the
**forbid-nondeterminism** branch: the grounding + lint forbid raw wall-clock /
randomness / ambient I/O and teach the deterministic alternatives (watermarks
via `ctx.runs.last()` / `ctx.state`, ids derived from journaled inputs,
timestamps off a `ctx.tool` result). The lint only ever matches *raw globals*,
so it is forward-compatible — if such `ctx.*` primitives are added later they
pass untouched.

**Canonical handler signature:** `export default async ({ ctx, log }) => {}` —
what the worker actually invokes (`automation-runner.ts` calls
`mod.default({ ...args, log, ctx })`). The #166 `poc/` `handler(ctx, input)`
sketch is *not* the landed shape; the destructured-object form is canonical and
is what the scaffold + SKILL emit.

## Checklist

- [x] SKILL.md: replay-determinism rules + two-rails cost model + requires.model tier guidance
- [x] DEFAULT_HANDLER: ctx.tool + deterministic transform + justified ctx.agent
- [x] starterManifest emits requires.tools + requires.model
- [x] Static replay-safety lint wired into the publish gate (validate-manifest.ts)
- [x] host-tools enumeration matches the persistent-mock tool surface (no change)

## What changed

### SKILL.md: replay-determinism rules + two-rails cost model + requires.model tier guidance

`automation-authoring/SKILL.md` gains a **Replay-determinism contract** section
(why replay needs determinism; the forbidden list — no `Date.now`/`new Date()`/
`Math.random`/`randomUUID`/raw `fetch`/`fs`/`process.*`; the no-`ctx.now`/
`random`/`uuid` note + deterministic alternatives; "pure JS between syscalls is
the point"; it mentions the publish-time lint) and a **Two cost rails** section
(`ctx.tool` ~0 tokens / `ctx.agent` billed; pick the cheapest sufficient
`requires.model` tier; batch, don't loop `ctx.agent`). The `requires.model`
manifest rule now frames tier selection.

### DEFAULT_HANDLER: ctx.tool + deterministic transform + justified ctx.agent

`scaffold-automation.ts`'s `DEFAULT_HANDLER` is rewritten as a replay-safe worked
example: a watermark via `ctx.runs.last`, a `ctx.tool` fetch, a deterministic JS
filter, and a justified `ctx.agent` call with a `json` schema — under a comment
block stating the determinism contract + two cost rails, with the canonical
`({ ctx, log }) => {}` signature and the `AutomationHandler` JSDoc type. A
scaffold-files test asserts the emitted handler passes the lint.

### starterManifest emits requires.tools + requires.model

`starterManifest` now seeds `requires.tools: []` (the allowlist slot the builder
grows as it adds `ctx.tool` calls) and keeps `requires.model` only when a tier
is chosen — never a misleading default.

### Static replay-safety lint wired into the publish gate (validate-manifest.ts)

New `automation-handler-lint.ts` exports
`lintAutomationHandlerSource(source) → HandlerLintFinding[]` and
`formatHandlerLintError(findings, file)`. A dependency-free lexical scanner masks
comments and string/template literals (to a NUL sentinel, so `new Date('x')`
stays distinguishable from the argless `new Date()`) while keeping real code —
including interpolated `${…}` expressions — then runs prescriptive rules:
`no-date-now`, `no-new-date`, `no-math-random`, `no-random-uuid`,
`no-random-bytes`, `no-performance-now`, `no-raw-fetch`, `no-node-io-import`
(fs/child_process/net/http/…), `no-process-ambient`. It is wired into the publish
gate: `validateManifestAt` (extracted out of `apps-store-routes.ts` into a
dedicated `validate-manifest.ts` to keep the hub file under the 500-line cap;
re-exported so importers are unchanged) lints every `automations/<id>/handler.js`
for `kind: 'automation'` apps and returns the formatted authoring error — so a
replay-unsafe handler is rejected at publish time, not mis-resumed at fire time.

### host-tools enumeration matches the persistent-mock tool surface (no change)

Verified, no code change: `host-tools.ts` snapshots the tool surface off the same
`startMockLlmServer` first-request that `persistent-mock-session.ts` drives, so
the enumerated `ctx.tool` names are exactly what a deployed handler reaches (the
file header already documents this).

## Out of scope

- **Adding journaled `ctx.now()` / `ctx.random()` / `ctx.uuid()` primitives** —
  that is a runtime change (worker + ctx + journal), #166's surface, not the
  builder's. This issue takes the forbid branch; the lint is forward-compatible
  if they are added later.
- **Enforcing `requires.tools` / `requires.mcps` as a runtime allowlist** — they
  remain declarative metadata today (no code consumes them); unchanged here.
- **End-to-end three-host parity run** (codex/claude/OpenClaw firing a real
  sample) — needs live agent CLIs/credentials. The runtime is unchanged by this
  issue; #166's fire/persistent-mock/journal suites cover parity, and a unit
  test asserts the scaffolded default handler passes the lint.

## Verification

- `bunx turbo run typecheck` green (19/19). `oxlint .` (0/0) + `oxfmt --check .`
  clean (450 files).
- New tests: `automation-handler-lint.test.ts` (12) covers clean handlers,
  every rule, comment/string masking, template-interpolation scanning, nested
  braces, and line/column accuracy; `validate-automation-handler.test.ts` (4)
  covers the gateway gate accepting a safe handler and rejecting
  `Date.now`/`fetch`+`Math.random`, and *not* linting non-automation apps;
  `scaffold-automation-files.test.ts` asserts the emitted default handler is
  lint-clean and that `requires.tools` is seeded.
- Full suites green: `automation-engine` 99, `gateway` 87 (the prior counts plus
  the new cases).
- host-tools enumeration matches the persistent-mock tool surface (task 5):
  `host-tools.ts` snapshots the tool surface off the same `startMockLlmServer`
  first-request that `persistent-mock-session.ts` drives, so the enumerated
  `ctx.tool` names are exactly what a handler reaches — no change needed
  (documented in the file header).
