### handler-uses-ctx-primitives

- **Directive**: centraid handlers (`**/queries/*.js`, `**/actions/*.js`) must not import provider SDKs directly (`@anthropic-ai/sdk`, `openai`, `groq-sdk`, `@google/generative-ai`, `cohere-ai`, `@mistralai/mistralai`, `replicate`, `together-ai`). Inference and other gateway-managed capabilities flow through `ctx.infer.*` and related primitives supplied by the handler-runner.
- **Rationale**: handler-as-source-of-truth. Extending `ctx.*` is the supported way to grow capabilities. Reaching past it (a) defeats per-profile model routing, (b) bypasses run-ledger cost accounting in `runtime.sqlite`, and (c) couples the handler to a specific provider — breaking the gateway portability that the architecture's "same code, three hosts" property depends on.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/handler-uses-ctx-primitives/check.sh`
- **Exceptions**: per-line waiver `// governance: allow-handler-uses-ctx-primitives <reason>` for the rare opt-in case (e.g. an action that legitimately needs to call a provider directly during a controlled experiment).
