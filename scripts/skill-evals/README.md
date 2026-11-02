# Manual skill selection and behavior evaluations

These cases are a small human/model review set for whether the assistant selects the right skill and follows its guidance. They are not run by `check:skills`, and passing a static frontmatter or link check does not establish that a model behaves correctly.

`check:skills` runs the Bun YAML frontmatter validator and its fixtures. Relative Markdown links are covered separately by the existing `cargo xtask doc-links` repository gate; this check does not add a Rust toolchain prerequisite to the TypeScript check.

For each case, provide the prompt to the model with the repository available. Record the selected skill(s), the material constraints it applies, and whether the response follows the expected behavior. Evaluate the skill choice and the resulting answer separately. No model invocation or external service is part of the repository checks.

## Cases

1. **No-subscriber Flow behavior**

   Prompt: “In this Kotlin screen, `events` is a `SharedFlow` and the producer calls `events.emit(value)`. Change it so values keep being collected even while the screen has no collectors. What should I change?”

   Expected: select `kotlin-compose`; explain that a `SharedFlow` with no subscribers does not retain replay-zero events for later collection. Inspect the actual flow configuration and choose behavior consistent with it. Do not claim that `emit` blocks indefinitely without subscribers or add an arbitrary buffering/replay policy. Fail if it proposes dropping the shared-flow semantics without explaining the consequence.

2. **Vault change across Linux JVM and exporter outputs**

   Prompt: “I added a field to the vault schema. Update the generated contract outputs and run the Android Linux JVM check. Which files and checks are involved?”

   Expected: select `vault-change`, `sqlite`, and `mobile-verify`; identify the baseline and schema digest, generated DDL and command exports as applicable, ontology output when table docs change, and commitment coverage. Name `cargo xtask gate --profile mobile-jvm` as the Linux JVM gate and state what it does not verify. Fail if the answer edits exported files by hand, omits the digest, or calls the Linux JVM check a full Android device build.

3. **Swift Binding preserving effects**

   Prompt: “This SwiftUI `Binding` setter calls `model.updateSelection(newValue)`, which writes to the model and emits an analytics event. Refactor the binding to be simpler. Can I use `.constant(model.selection)`?”

   Expected: select `swift-swiftui`; preserve the live getter and setter effects. Explain that `.constant` discards writes and the model/analytics side effects. Also preserve any required setter effects when the incoming value equals the current value; do not silently add an equality guard unless the existing contract permits it. Fail if the answer recommends a snapshot binding that drops the setter.

4. **Current schema policy**

   Prompt: “For a new vault field today, should I add a numbered migration, or edit the baseline? What else must stay in sync?”

   Expected: consult current repo artifacts and select `vault-change` plus `sqlite`; explain the current single-baseline policy, schema digest, generated outputs, and affected tests. Fail if it relies on a historical migration policy, suggests adding a numbered migration, or answers without checking current repository guidance.
