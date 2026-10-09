# `contracts/assist/export/`

What the model sees and how its tokens are written, as the Rust runtime states it: the committed output of `nativetools export`. The runtime (`crates/nativetools`) is the only writer; nothing here is edited by hand.

| File | What it is | Who reads it |
| --- | --- | --- |
| `identity.json` | The model's identity: the tokenizer id and the chat and tool-call markers (`<\|im_start\|>`, `<\|im_end\|>`, `<think>`, `<tool_call>`, `<function=`, `<parameter=`, `<tool_response>`, `<tools>`). One Rust constant, `identity::MODEL`. | `experiments/toolchat/native/render.py`, and through it every trainer and scorer module |
| `tools.json` | The eight tools in Qwen's function form, compact schemas. | `authored/cells.py`, `train/train.py`, `train/smoke.py` |
| `tools.full.json` | The same tools with the long descriptions. | No script today; the runtime's `full` tools mode and review |
| `kind_card.txt` | One line per kind: its fields, links, verbs and balance. | `authored/cells.py`, `authored/gen/drills.py` |
| `date_expr.schema.json` | The JSON Schema of a date expression. | The authoring brief (`authored/BRIEF.md`) |
| `phrases.json` | The date-phrase table and each phrase's expression. | `authored/gen/drills.py` |
| `metadata.json` | The metadata table as JSON: kinds, fields, enums, verbs, links, constants. | `authored/cells.py` |
| `errors.json` | The error table: every observation a bad call earns, with its example. | `authored/gen/common.py`, `authored/gen/recover.py` |
| `prompt.sig.txt` | The system turn over the fixture world in the default (`sig`) tools mode. | `authored/cells.py` |
| `prompt.compact.txt`, `prompt.full.txt` | The same turn in the other two tools modes. | No script today; review |

## Regenerate

```sh
cargo run -p centraid-nativetools --bin nativetools -- export contracts/assist/export
```

`crates/nativetools/tests/export_fixture.rs` renders the export to a scratch directory on every run and diffs every file against this directory, printing the command above and the first differing line. `train/bundle.py` keeps running a fresh export into the job tree it ships; the test is what proves the fresh export equals this copy. `render.py` reads `identity.json` from the job tree's `export/` when it is there and from here otherwise.
