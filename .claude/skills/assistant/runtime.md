# Runtime: a turn end to end

The rules that never bend are in [safety.md](./safety.md). This file follows one question from the composer to the cards.

## Who owns what

- [`crates/assist`](../../../crates/assist/README.md) is the plane: the tool runtime (`native/`), the turn loop (`native_turn/`), the attached and free replies, the `Model` trait. It holds no vault and no engine. Every read and write goes through the `Door` trait ([`native/door.rs`](../../../crates/assist/src/native/door.rs)); it never writes SQL.
- [`crates/assist-llama`](../../../crates/assist-llama/src/lib.rs) is the one engine: llama.cpp behind `Model` and `ModelLoader`. Nothing else links llama.cpp.
- [`crates/core/src/assist/mod.rs`](../../../crates/core/src/assist/mod.rs) joins the plane to an open vault: sessions in memory, the event queue, the saved turn.
- [`crates/screens/src/chat`](../../../crates/screens/src/chat/mod.rs) is the screen. It decides what each phase shows and never re-decides what the assistant decided.

## The screen

- The phases are `CHECKING`, `NEEDS_MODEL`, `DOWNLOADING`, `LOADING`, `READY`, plus `UNAVAILABLE` for a build that cannot run a model. A thread exists only in `READY`.
- The shell owns the download. What it fetches (URL at a commit, SHA-256, size) is read from the model record by [`asset.rs`](../../../crates/screens/src/chat/asset.rs). Pin changes are in [model.md](./model.md).
- Status, start, cancel, confirm and dismiss are inline calls. Loading the model and sending a turn run off the runtime lock on the core's pool and come back as `OffThreadDone`.
- A turn ends twice on the wire: a terminal event, then the answer to `send`. The event only draws words. The answer comes after the save and settles the turn once, by the turn id the screen minted.
- A message over `MESSAGE_MAX` (800 characters) is refused in the screen before it is sent.

## The turn

1. The core takes the `Request::Assist` arm. A second send on a running session answers `BUSY`. Stop is its own call from another thread and sets a flag the engine polls.
2. A turn with an attachment takes the attached path: one streamed answer over the photo or document, no tools. Every other question takes the native plane.
3. `NativeChat::open` builds a `Session` over the core's door with `Writes::Park` and the tools mode named in the model record. The session lives in memory. A new chat, a reopened thread, a retry and a turn that did not end each start a fresh one.
4. `NativePlane::run_turn` ([`native_turn/mod.rs`](../../../crates/assist/src/native_turn/mod.rs)) first moves the session clock to the request and reads the world again.
5. A retraction ends the turn in the runtime before any call. An exact-title "find X" runs its two read calls with no generation. Everything else loops, at most `STEP_CAP` (6) calls; the loop's own bound is two more.
6. Each step: fit the log to the context, run `decode_step` ([`native/step.rs`](../../../crates/assist/src/native/step.rs)), keep the first call only, unescape the model's own words, report an `Activity` event ("Looking in Agenda"), run `Session::call_text`, log the call and its observation.
7. `decode_step` writes one message. The think is decoded under a grammar (`GrammarMode::Full`, limit 200 tokens), the call is rendered from the think by the compiler the data builder also uses, and the message stops at `</tool_call>`. The whole message is capped at 512 tokens, greedy.
8. The context is 8,192 tokens. The log is fitted inside three quarters of it, less the message cap. If the engine still reports the prompt too big, the oldest turn is dropped and the step is asked again.
9. The turn ends in cards (the first `CARD_CAP`, 6) and one line composed from the final effect out of [`copy/chat.json`](../../../copy/chat.json) (the `SAID_` keys). The model writes no answer text.
10. One exception: the model's own `decline out_of_scope` gets one free generation (256 tokens, no tools, no grammar, told it can do nothing). It falls back to the sentence if that fails or says nothing.
11. The core saves the turn through `thread.save_turn`. A stored thread reopens into a fresh session. The tool calls are never stored.

## Writes and sealed values

- A write is planned against a patched copy of the world. The turn ends in one `PendingWrite`, put on the wire as `AssistPending`. The card is built from structured row changes in [`native_turn/pending.rs`](../../../crates/assist/src/native_turn/pending.rs), not from the text the model saw.
- Confirm runs the steps through the door, one key per step, and refuses a stale card. Dismiss, or any new message, drops it.
- A reveal never parks. It ends the turn in a member action card, and the value is shown on that card, not by the model: the member taps Reveal, the phone asks its owner check, and the core reads the value through Locker's reveal into the screen ([`chat/reveal.rs`](../../../crates/screens/src/chat/reveal.rs), driving the same controller as Locker's item page). It is in memory only: dropped on a relock, when the app leaves the foreground, the tab or page is left or the thread changes, and never saved, so a reopened thread shows Reveal again. Why: [safety.md](./safety.md).

## The engine

- A generation opens a fresh context and a grammar plus greedy sampler chain. Sampling with `temperature > 0` exists for rollouts only ([eval.md](./eval.md)).
- [`generate.rs`](../../../crates/assist-llama/src/generate.rs) polls cancel before every prefill chunk (128 tokens by default) and every token. Stop strings are held back until they cannot complete.
- The `engine` feature builds llama.cpp. A plain workspace build compiles this crate without it. The `engine` job in `.github/workflows/gate.yml` builds and tests the rest.
- One `ModelHost` per process ([`host.rs`](../../../crates/assist/src/host.rs)). The adapter switch is per turn: [model.md](./model.md).
