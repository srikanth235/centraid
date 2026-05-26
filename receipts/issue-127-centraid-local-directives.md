# issue-127 — Add 6 centraid-specific governance directives to local pack

GitHub issue: [#127](https://github.com/srikanth235/centraid/issues/127)

## Checklist

- [x] D1: `handler-uses-ctx-primitives` — block direct provider-SDK imports in handler files
- [ ] D2: `no-hardcoded-model-ids` — strict scope; grandfather model-pricing.ts and tests
- [ ] D3: `actions-declare-table-writes` — every `app.json#actions[]` entry has non-empty `writes:[]`
- [ ] D4: `gateway-core-mode-agnostic` — no gateway-mode branches in `packages/runtime-core/`
- [ ] D5: `no-pre-release-migrations` — block migration scaffolds and back-compat shims
- [ ] D6: `data-runtime-sqlite-separation` — handlers can't open `runtime.sqlite`, gateway core can't open `data.sqlite` outside the handler-runner

## What changed

This issue is the umbrella tracker for six centraid-specific governance directives added to the repo-local `srikanth235/centraid` pack. Each directive lands as its own atomic-triple commit (directive folder + `CONSTITUTION.md` Directives subsection + Evolution Log entry + `packs.lock` sync) anchored to `(#127)`, per the `directive add` flow.

The local pack already contains one directive — `query-handlers-read-only`. These six extend that pattern to other architectural invariants that are easy to silently violate.

### D1: `handler-uses-ctx-primitives`

Forbids imports of provider SDKs (`@anthropic-ai/sdk`, `openai`, `groq-sdk`, `@google/generative-ai`, `cohere-ai`, `@mistralai/mistralai`, `replicate`, `together-ai`) inside any tracked `**/queries/*.js` or `**/actions/*.js`. Inference and other gateway-managed capabilities must flow through `ctx.infer.*` and related primitives supplied by the handler-runner.

**Why:** handler-as-source-of-truth. Extending `ctx.*` is the supported way to grow capabilities. Reaching past it defeats per-profile model routing, bypasses run-ledger cost accounting in `runtime.sqlite`, and couples the handler to a specific provider — breaking the embedded vs OpenClaw gateway portability that the architecture's "same code, two modes" property depends on.

**Smoke test:** passes on the current tree. No handler files currently import any forbidden SDK.

## Verification

- **D1 smoke test passes locally.** `bash .governance/run.sh handler-uses-ctx-primitives` returns exit 0 against the tree at HEAD.
- **D1 fixture would fail.** A hypothetical `import { Anthropic } from '@anthropic-ai/sdk'` line added to any `**/queries/*.js` file triggers a violation pointing to the file and line, with the SDK name surfaced in the message.

## Out of scope

- **Three other directive candidates from the design discussion** (`no-knob-side-files`, `three-tool-dispatcher-exclusive`, `atomic-current-json-writes`). Useful but lower leverage than these six; track separately if/when needed.
- **Upstream bug in `agent-steering-accounting` (governance-kit/core 0.3.1):** the steering hook mangles non-ASCII UTF-8 bytes (em-dash, arrow) when writing STEERING.md rows but compares them to the un-mangled pending subject, blocking any commit whose subject contains those characters. Tracked separately; D1 (and the rest of this issue's commits) work around it with ASCII-only subjects.
