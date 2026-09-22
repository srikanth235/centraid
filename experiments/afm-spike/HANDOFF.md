# Hand-off: running the Apple Foundation Models spike

You are running an on-device model against Centraid's offline chat evaluation. Every turn of all three corpora goes through Apple's `FoundationModels` framework under **guided generation** into a frame; **code** renders the frame to the existing canonical grammar; the repository's own `run-model` scores it. The model never writes SQL and never emits a canonical character.

Nothing below needs a decision from you. If a command prints something this file does not describe, stop and send it back rather than working around it.

---

## 1. Prerequisites

|  |  |
| --- | --- |
| macOS | **26** or newer, Apple silicon |
| Xcode | **26**, plus `xcode-select --install` for the command-line tools |
| Apple Intelligence | **ON**, and the model downloaded — System Settings → Apple Intelligence & Siri. The first download is a few GB and happens once. |
| Python | 3.11 or newer (`python3 --version`) |
| Rust | the repository's pinned toolchain (`rust-toolchain.toml`); `cargo` on `PATH` |
| disk | ~2 GB for `.build` and the cargo target dir |

Check the two that actually block:

```sh
xcodebuild -version          # Xcode 26.x
sw_vers                      # ProductVersion 26.x
```

The harness itself checks Apple Intelligence: `SystemLanguageModel.default.availability`. If the model is unavailable it prints the reason and exits non-zero before writing a single row, and the reason string is the thing to send back.

## 2. The command sequence

Run these in order, from `experiments/afm-spike/`.

```sh
git pull
cd experiments/afm-spike

python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt          # there are no dependencies; this is a no-op

# (a) the ceiling, and the whole Python side, with no model anywhere
make coverage                            # expect 434/434, 434/434, 7287/7287
make selftest                            # expect 434/434 tree-equal, then
                                         # run-model 120/120 · 60/60 · 78/78

# (b) build
make build                               # swift build -c release

# (c) the two runs, each rendered, scored and summarised
make teacher
make free
```

`make selftest` is the gate. **Do not run (b) or (c) until it is green**: it proves the frame, the renderer, the verbatim rule, the output schema and the scorer wiring with gold frames standing in for the model's, so anything red afterwards is a finding about the model and not about the harness.

`make teacher` and `make free` each do four things: run the model over all 434 turns, render the frames to canonical, score with `run-model`, and write a summary. To try a handful of turns first:

```sh
.build/release/afm-spike --map ../../crates/evalsuite/grammar/map.json \
    --mode teacher --corpus suite --limit 10 --out out/smoke.raw.jsonl
python3 render_frames.py --in out/smoke.raw.jsonl --out out/smoke.jsonl
```

## 3. Expected runtime

| step                     | estimate                |
| ------------------------ | ----------------------- |
| `make coverage`          | ~10 s                   |
| `make selftest`          | ~20 s, plus `run-model` |
| `run-model --corpus all` | **8–15 min**            |
| `make build`             | 1–3 min cold            |
| `make teacher`           | **25–60 min**           |
| `make free`              | **25–60 min**           |

How the model estimate was reached, so you can tell early whether it is wrong: 434 turns × 2 guided generations each; Apple's on-device model is quoted around 30 tokens/s decode on Apple silicon; Stage A emits ~20 tokens and Stage B ~60–120 under a constrained schema, so ~1 s and ~3 s respectively, plus prompt processing. That is ~4 s a turn, ~30 min a run, and the range is doubled at the top for schema compilation on the first turn of each kind. The harness prints `N/434 <seconds>` every 25 turns — **if the first 25 turns take more than four minutes, stop and send the log**, because something is falling back to a slow path rather than being slow.

`run-model` is the repository's executor over a real vault and is slow by nature; that time is not the model's.

## 4. What success looks like

The floor is Tier D — the hand-written rule parser with no model at all:

| corpus  | floor (strict sessions) |
| ------- | ----------------------- |
| suite   | **53/120**              |
| blind   | **34/60**               |
| holdout | **31/78**               |

`run-model` prints `SESSIONS PASSED (strict, the headline)` per corpus. The spike **clears** if the `free` run beats all three. `teacher` is the diagnostic run — it is handed the gold previous canonical, so it separates "the model cannot read the sentence" from "the model's own context drifted".

Two numbers to read alongside it, both in `out/summary.*.md`:

- **Parse rate.** How many turns produced any canonical at all. Guided generation should make this very high; a low one means frames are arriving that the ladder cannot build, and the reasons table says which.
- **Tree-exact vs gold.** This is a **leakage detector, not a score**. The model has never seen this corpus. A high exact-match number would be the finding, not the result.

## 5. Files to send back

```
experiments/afm-spike/out/afm.teacher.raw.jsonl
experiments/afm-spike/out/afm.teacher.jsonl
experiments/afm-spike/out/afm.teacher.jsonl.reasons.jsonl
experiments/afm-spike/out/afm.free.raw.jsonl
experiments/afm-spike/out/afm.free.jsonl
experiments/afm-spike/out/afm.free.jsonl.reasons.jsonl
experiments/afm-spike/out/summary.teacher.md
experiments/afm-spike/out/summary.free.md
```

plus the terminal output of the two `run-model` runs. The `.raw.jsonl` files are the important ones: they hold every model output exactly as it came back, written before anything rendered or parsed it, so every other file in the list can be regenerated from them on any machine.

## 6. Known API-uncertainty spots

This harness was written on Linux, with no macOS 26 SDK to check against. Every `FoundationModels` symbol is in **one file**, `Sources/afm-spike/AFMClient.swift`, each uncertain spot marked `// API?` with the alternative spelling. Everything else in `Sources/` is plain Swift and Foundation.

| what | spelled here as | if wrong, try |
| --- | --- | --- |
| greedy sampling | `GenerationOptions(sampling: .greedy)` | `GenerationOptions(sampling: .greedy, temperature: 0)` |
| instructions | `LanguageModelSession(instructions: { Doctrine.text })` | `LanguageModelSession(instructions: Instructions(Doctrine.text))`, or the plain `LanguageModelSession(instructions: Doctrine.text)` |
| raw JSON of a dynamic result | `response.content.jsonString` | check `GeneratedContent` for a `jsonString`/`json` property; do **not** substitute `String(describing:)`, which is not JSON |
| a string enum schema | `DynamicGenerationSchema(name:anyOf:)` | `DynamicGenerationSchema(name:description:anyOf:)` |
| a reference to another schema | `DynamicGenerationSchema(referenceTo:)` | `DynamicGenerationSchema(name:)` |
| assembling the schema | `try GenerationSchema(root:dependencies:)` | argument labels may differ; the call is throwing either way |
| unavailability reasons | matched by `"\(reason)"`, not by case | nothing — this was written to survive a renamed case |
| `GenerationError` cases | the eight in `describe(_:stage:)` | delete a case the SDK does not have; `@unknown default` catches the rest |

## 7. If it fails to compile

In likelihood order.

1. **`no such module 'FoundationModels'`** — the SDK is not macOS 26's. Run `sudo xcode-select -s /Applications/Xcode.app` and `swift build -c release --sdk $(xcrun --sdk macosx --show-sdk-path)`.
2. **`'macOS 26.0' is not a valid version`** — an older Swift driver is on `PATH`. `swift --version` must report the Xcode 26 toolchain.
3. **An argument label or property name in `AFMClient.swift`** — use the table in §6. Fix it in place; nothing else in the package refers to those symbols.
4. **`@Generable` / `@Guide` not found** — they come from `FoundationModels` itself; if the macro fails to expand, Xcode's macro plugin validation has not been accepted. Open the package once in Xcode and trust the macro.
5. **`Intent` conflicts with something** — rename the struct in `AFMClient.swift`; it is referenced nowhere else. (`Doctrine` is already named that way to avoid colliding with `FoundationModels.Instructions`.)
6. **A concurrency error about `AFMClient` not being `Sendable`** — the harness is single-threaded on purpose. Mark the class `@MainActor` or drop `.swiftLanguageMode(.v6)` from `Package.swift`; neither changes a result.

If a fix changes behaviour rather than a spelling — a retry, a default, a repair of a model string — **do not make it**. Send the error back instead. Every failure in this harness is meant to be counted, not survived.

## 8. What is where

| file | what it is |
| --- | --- |
| `frame.py` | the frame, both directions, and the coverage proof (`make coverage`) |
| `gen_vocab.py` | generates `Vocab.swift` and `Doctrine.swift` from `lexicon.py` + `derive/derived.json`. Nothing is hand-copied; `--check` fails when stale |
| `Sources/afm-spike/AFMClient.swift` | every `FoundationModels` symbol in the spike |
| `Sources/afm-spike/Frame.swift` | the Stage-B schema described in pure Swift |
| `render_frames.py` | frames → canonical, the verbatim rule, the scored JSONL; also `--serve` (free mode's renderer) and `--selftest` |
| `summarise.py` | parse rate, leakage, latency, failures by kind, twenty wrong outputs |
| `COVERAGE.md` | the coverage proof, written out |

Read [COVERAGE.md](COVERAGE.md) before reading a result: it says what the frame can express (everything in the corpus) and therefore what a low score would mean (the model, not the design).
