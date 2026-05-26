# issue-127 - Add 6 centraid-specific governance directives to local pack

GitHub issue: [#127](https://github.com/srikanth235/centraid/issues/127)

## Checklist

- [x] D1: `handler-uses-ctx-primitives` - block direct provider-SDK imports in handler files
- [x] D2: `no-hardcoded-model-ids` - strict scope; grandfather model-pricing.ts and tests
- [x] D3: `actions-declare-table-writes` - every `app.json#actions[]` entry has non-empty `writes:[]`
- [ ] D4: `gateway-core-mode-agnostic` - no gateway-mode branches in `packages/runtime-core/`
- [ ] D5: `no-pre-release-migrations` - block migration scaffolds and back-compat shims
- [ ] D6: `data-runtime-sqlite-separation` - handlers cannot open `runtime.sqlite`, gateway core cannot open `data.sqlite` outside the handler-runner

## What changed

This issue is the umbrella tracker for six centraid-specific governance directives added to the repo-local `srikanth235/centraid` pack. Each directive lands as its own atomic-triple commit (directive folder + `CONSTITUTION.md` Directives subsection + Evolution Log entry + `packs.lock` sync) anchored to `(#127)`, per the `directive add` flow.

The local pack already contains one directive - `query-handlers-read-only`. These six extend that pattern to other architectural invariants that are easy to silently violate.

**D1: `handler-uses-ctx-primitives` - block direct provider-SDK imports in handler files.** Forbids imports of provider SDKs (`@anthropic-ai/sdk`, `openai`, `groq-sdk`, `@google/generative-ai`, `cohere-ai`, `@mistralai/mistralai`, `replicate`, `together-ai`) inside any tracked `**/queries/*.js` or `**/actions/*.js`. Inference and other gateway-managed capabilities must flow through `ctx.infer.*` and related primitives supplied by the handler-runner. Rationale: extending `ctx.*` is the supported way to grow capabilities (handler-as-source-of-truth). Reaching past it defeats per-profile model routing, bypasses run-ledger cost accounting in `runtime.sqlite`, and couples the handler to a specific provider - breaking the embedded vs OpenClaw gateway portability that the "same code, two modes" property depends on.

**D2: `no-hardcoded-model-ids` - strict scope; grandfather model-pricing.ts and tests.** Production source under `packages/` and `apps/` may not reference concrete provider model ids (`claude-opus-4-7`, `claude-sonnet-4-6`, `gpt-5`, `o1-mini`, `gemini-2.0-flash`, `mistral-large`, `llama-3`, etc.) inside string literals. The single allowlisted file is `packages/runtime-core/src/model-pricing.ts` (the price table is by definition a model-id-to-price map). Test files (`**/*.test.{ts,tsx}`, `**/*.spec.{ts,tsx}`) are excluded since they exercise the pricing and storage layers with real ids. Rationale: provider-agnostic inference. The model lineup churns - new flagship models every few months, retirements on a similar cadence. Capability tiers (`tier:fast`, `tier:smart`) abstract that churn behind a runtime resolver and let model selection move with operator preferences and per-profile routing without code edits.

**D3: `actions-declare-table-writes` - every `app.json#actions[]` entry has non-empty `writes:[]`.** Every entry in a centraid `app.json#actions[]` array must include a `writes:` field whose value is an array of table names. Empty arrays are allowed (signals "no DB writes", e.g. a webhook-only action); missing or non-array values are rejected. The check filters to manifests with `manifestVersion` set, so Expo's `apps/mobile/app.json` (same filename, no manifestVersion) is correctly skipped. Rationale: same foot-gun shape as `query-handlers-read-only` - the change-stream SSE feed at `/centraid/<id>/_changes` uses each action's declared `writes:` tables to invalidate per-table query subscriptions. A missing field silently breaks invalidation, subscribed iframes never re-fetch, UI goes stale with no error.

## Verification

- **D1 smoke test passes locally.** `bash .governance/run.sh handler-uses-ctx-primitives` returns exit 0 against the tree at HEAD - no handler files currently import any forbidden SDK. The directive locks the property in before it is lost.
- **D1 fixture would fail.** A hypothetical `import { Anthropic } from '@anthropic-ai/sdk'` line added to any `**/queries/*.js` file triggers a violation pointing to the file and line, with the SDK name surfaced in the message.
- **D2 smoke test passes locally.** `bash .governance/run.sh no-hardcoded-model-ids` returns exit 0 - the exclusion list (test files + `model-pricing.ts`) cleanly covers all legitimate uses today. The strict allowlist means any new production file referencing a hardcoded id fails the directive.
- **D2 fixture would fail.** Adding `const model = 'claude-opus-4-7';` to any non-test file under `packages/` or `apps/` (other than `model-pricing.ts`) triggers a violation pointing to the file and line, with the model id surfaced in the message.
- **D3 smoke test passes locally.** All 13 Centraid app manifests with non-empty `actions[]` arrays already declare `writes:` correctly: `hydrate` (1 action), `journal` (2 actions), `todos` (3 actions); the 10 `auto.*` apps have empty `actions[]` (automation-only).
- **D3 fixture would fail.** Removing `writes:` from any action entry in a Centraid `app.json` triggers a violation citing the file and the action name.

## Out of scope

- **Three other directive candidates from the design discussion** (`no-knob-side-files`, `three-tool-dispatcher-exclusive`, `atomic-current-json-writes`). Useful but lower leverage than these six; track separately if/when needed.
- **Upstream bug in `agent-steering-accounting` (governance-kit/core 0.3.1):** the steering hook mangles non-ASCII UTF-8 bytes (em-dash, arrow) when writing STEERING.md rows but compares them to the un-mangled pending subject, blocking any commit whose subject contains those characters. Worked around in this issue by using ASCII-only subjects; should be filed upstream against Duaility/governance-kit.
