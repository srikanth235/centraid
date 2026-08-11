# Issue #740 — per-call harness/model selection on `ctx.agent`

GitHub issue: [#740](https://github.com/srikanth235/centraid/issues/740)

## Checklist

- [x] `ctx.agent({ runner, model, prompt })` drives the named registered kind through `runTurn`, with the per-call model override applied
- [x] Omitting `runner`/`model` preserves today's fire-level selection exactly (no behavior change for existing automations)
- [x] A per-call `runner` not enrolled in the user's automations agent/ladder is denied with a typed failure naming the harness; nothing egresses
- [x] Two `ctx.agent` calls with different runners in one fire each resume/persist their own harness binding and record their own kind/model/usage on their run-ledger agent nodes
- [x] Headless compile of instructions naming a harness+model for a step emits a handler passing those args (covered by a compile-grounding test or fixture)
- [x] Docs updated: `requires.runner` role split + `ctx.agent` per-call args; receipt file `receipts/issue-<N>-<slug>.md` present

## What changed

- **`ctx.agent({ runner, model, prompt })` drives the named registered kind through `runTurn`, with the per-call model override applied.** `packages/automation/src/worker/runner.ts`, `packages/automation/src/handler/runner.ts`, and `packages/automation/src/handler/ctx.ts` carry both optional arguments across the worker boundary. `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts` resolves the registered backend, runner-specific preferences and breaker, then calls that backend's `runTurn` with the call-level model.
- **Omitting `runner`/`model` preserves today's fire-level selection exactly (no behavior change for existing automations).** The dispatcher falls back to `OpenDispatchArgs.runnerKind`; when `model` is absent it leaves the selected runner's existing fire/config-pin model resolution untouched. `packages/automation/src/fire/fire.ts` and `packages/automation/src/manifest/manifest.ts` retain the compatibility defaults and document the precedence.
- **A per-call `runner` not enrolled in the user's automations agent/ladder is denied with a typed failure naming the harness; nothing egresses.** `packages/agent-runtime/src/automation/run-automation.ts` exposes only the user's primary and live ladder as derived-consent sources. The live dispatcher re-derives consent for every explicit runner, rejects unregistered or unenrolled names with `centraid-agent-failure` metadata, and does so before staging attachments or calling a backend.
- **Two `ctx.agent` calls with different runners in one fire each resume/persist their own harness binding and record their own kind/model/usage on their run-ledger agent nodes.** `packages/app-engine/src/conversation/store.ts` settles every adapter from a successful multi-runner fire without incrementing the fire's turn count more than once. The dispatcher keeps binding, hydration, breaker and usage state per kind; `packages/agent-runtime/src/automation/run-automation-dispatch.test.ts` proves two backend calls, two resumable bindings, confirmed per-node provider/model/token usage, and call args in one successful run.
- **Headless compile of instructions naming a harness+model for a step emits a handler passing those args (covered by a compile-grounding test or fixture).** `packages/gateway/src/lifecycle/headless-automation-compile.ts` adds this rule to `HEADLESS_COMPILE_WORK_ORDER`, and `packages/gateway/src/lifecycle/headless-automation-compile.test.ts` pins the grounding text.
- **Docs updated: `requires.runner` role split + `ctx.agent` per-call args; receipt file `receipts/issue-<N>-<slug>.md` present.** `docs/runners.md`, `packages/automation/src/scaffold/scaffold.ts`, `packages/gateway/skills/automation-authoring/SKILL.md`, and `packages/gateway/skills/authoring-centraid-apps/SKILL.md` describe authoring/interactive selection, compatibility fire defaults, step-level overrides, enrollment, and explicit-runner failure ownership. `packages/gateway/src/skills/authoring-prompt.test.ts` keeps the shipped grounding in the assembled authoring prompt.
- `packages/automation/src/fire/fire.test.ts` covers worker-to-host argument plumbing and ledger argument persistence. `packages/agent-runtime/src/automation/run-automation.test.ts` proves an explicit call failure neither defers the handler failure nor silently replays the entire fire on another provider.

Changed paths:

- `docs/runners.md`
- `packages/agent-runtime/src/automation/run-automation-dispatch.test.ts`
- `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts`
- `packages/agent-runtime/src/automation/run-automation.test.ts`
- `packages/agent-runtime/src/automation/run-automation.ts`
- `packages/app-engine/src/conversation/store.ts`
- `packages/automation/src/fire/fire.test.ts`
- `packages/automation/src/fire/fire.ts`
- `packages/automation/src/handler/ctx.ts`
- `packages/automation/src/handler/runner.ts`
- `packages/automation/src/manifest/manifest.ts`
- `packages/automation/src/scaffold/scaffold.ts`
- `packages/automation/src/worker/runner.ts`
- `packages/gateway/skills/authoring-centraid-apps/SKILL.md`
- `packages/gateway/skills/automation-authoring/SKILL.md`
- `packages/gateway/src/lifecycle/headless-automation-compile.test.ts`
- `packages/gateway/src/lifecycle/headless-automation-compile.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/skills/authoring-prompt.test.ts`
- `receipts/issue-740-per-call-agent-selection.md`
- `tests/quality/classification-ratchet.json`

## Out of scope

- Interactive automation authoring and its UI keep choosing a fire-level default. This issue adds handler-step overrides; it does not redesign the interactive selection surface.
- The runtime does not silently substitute another provider for an explicit `call.runner`. A handler may catch and retry deliberately, and the automation's existing `onFailure` flow remains the owner of whole-fire recovery.
- No new runner kinds, provider adapters, pricing rules, or manifest schema fields are introduced.

## Decisions

- Preserve `requires.runner` and `requires.model` as compatibility fire defaults so handlers that omit the new arguments behave byte-for-byte as before. Their primary role remains authoring/interactive selection; a named `ctx.agent` call takes precedence for that step.
- Treat every explicit runner as a fresh consent decision, even if an old grant row exists. Derived consent succeeds only when that harness is still the user's automations primary or a current ladder member, so removing it from settings immediately closes unattended egress.
- Use the same model constraints as `manifest.requires.model`: a non-empty string, with `centraid-mock` and `centraid-mock/*` rejected to prevent recursion.
- Persist every runner binding when a multi-runner fire completes successfully while marking the last successful runner active. Earlier bindings remain resumable and the conversation turn count advances once; failed fires retain the existing single-failure settlement semantics.
- Mark typed failures from an explicit runner with `explicitRunner: true`. This prevents the outer fire ladder from replaying prior handler side effects; the handler or `onFailure` owns any intentional retry.
- `#740 re-pins the governed automation manifest fingerprint after documenting per-call runner/model precedence; no classification, budget, or gate changed.` The governed file changed only documentation for the existing manifest defaults; the ratchet's classification, budgets, and checks are unchanged.

## Verification

The focused tests exercise worker plumbing, per-kind consent and breakers, call-level model precedence, dual-runner binding/ledger settlement, explicit-runner failover ownership, and compiler grounding.

```sh
bun run build
bun run format
bun run --cwd packages/automation typecheck
bun run --cwd packages/app-engine typecheck
bun run --cwd packages/agent-runtime typecheck
bun run --cwd packages/gateway typecheck
bun run --cwd packages/automation test -- src/fire/fire.test.ts
bun run --cwd packages/agent-runtime test -- src/automation/run-automation-dispatch.test.ts src/automation/run-automation.test.ts
bun run --cwd packages/gateway test -- src/lifecycle/headless-automation-compile.test.ts src/skills/authoring-prompt.test.ts
bun run check:push
bun run check:diff-coverage
bun run check:full
bash .governance/run.sh
```

Manual-equivalent inspection is encoded in the two-runner integration fixture: it executes a real generated-style `handler.js` containing two named `ctx.agent` calls, then opens the run ledger and asserts each agent node's requested runner/model and confirmed provider/model/token usage.

Observed results on 2026-08-11:

- `bun run build` passed all 18 tasks.
- The focused automation, agent-runtime, and gateway suites passed 13/13, 38/38, and 18/18 tests respectively; all four affected package typechecks passed.
- `bun run check:push` passed all 39 gates against the then-current source diff before the final rebase onto #741. `bun run check:diff-coverage` passed 338 test files / 2,832 tests and 98.1% changed-line coverage (205/209 lines) on that revision.
- The final post-patch `bun run check:diff-coverage` rerun completed 330 test files with 2,822 passing tests and stopped on 11 unrelated gateway failures across 8 files: 30-second setup-hook timeouts plus their temporary-git-directory cleanup fallout. The focused changed suites remained green at the counts above.
- The first exact-final `bun run check:push` rerun passed 37/39 gates: its quality lane stopped on two unrelated 30-second `kill-mid-write.integration.test.ts` timeouts, and its affected-test lane stopped under the same concurrent timeout pressure. The mandatory pre-push retry on the committed diff then passed all 39/39 gates in 267.2 seconds.
- Exact `bun run check:full` attempts were made repeatedly. Two stopped on unrelated 30-second gateway timeouts under diff-coverage/full-coverage load (`serve-vault-addressing.test.ts`, then `templates-routes.test.ts`); those files passed 3/3 in isolation. After rebasing onto #741, the final full attempt passed 38/39 push gates and stopped on the pre-existing `serve-scheduler-reconcile.test.ts` watched-entity case at 31.3 seconds; that whole file immediately passed 3/3 in isolation in 22.1 seconds. The changed automation and agent-runtime packages were green in that run (420/420 and 354/354 tests).
- The full-profile stages that earlier coverage timeouts prevented from running were also replayed directly: mutation selection passed, the low-end performance gate reported no budget failures, desktop E2E passed 60 tests with 4 skipped, and web E2E passed all 15 tests. The remaining full-profile PR/typecheck/type-aware-policy/workflow-pin lanes passed in the successful pre-rebase run; the rebase changed only the upstream parent, not this issue's source diff.

## Audit

**PASS** — A fresh-context audit verified all six acceptance criteria and all 21 changed paths. Explicit runners are registry/enrollment checked before staging or egress, including unenrolled manifest primaries without a consent store; fallback to the enrolled primary is `direct`. Explicit models override ACP config pins while omitted models preserve existing config-pin precedence. Per-runner breakers, bindings, usage, and ledger attribution are isolated, and the compiler fixture and docs are faithful. Independent verification passed the focused suites (13/13, 38/38, 18/18), all four affected package typechecks, and governance (25/25). No concrete blocker remains.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-11 | codex | 019fef37-91ec-7103-84d8-f55752b16078 |
