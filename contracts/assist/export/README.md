# `contracts/assist/export/`

What the model sees and how its tokens are written, as the Rust runtime states it: the committed output of `nativetools export`. The runtime (`crates/nativetools`) is the only writer; nothing here is edited by hand.

| File | What it is | Who reads it |
| --- | --- | --- |
| `identity.json` | The model's identity: the tokenizer id and the chat and tool-call markers (`<\|im_start\|>`, `<\|im_end\|>`, `<think>`, `<tool_call>`, `<function=`, `<parameter=`, `<tool_response>`, `<tools>`). One Rust constant, `identity::MODEL`. | The runtime (`crates/assist`) and `crates/datagen`, which render with it |
| `tools.json` | The eight tools (`find`, `compute`, `create`, `edit`, `do`, `answer`, `ask`, `decline`) in Qwen's function form, compact schemas. | The runtime (`crates/assist`), `crates/datagen` |
| `tools.full.json` | The same tools with the long descriptions. | No script today; the runtime's `full` tools mode and review |
| `kind_card.txt` | One line per kind: its fields, links, verbs and balance. | The runtime; review |
| `date_expr.schema.json` | The JSON Schema of a date expression. | No script today; review |
| `phrases.json` | The date-phrase table and each phrase's expression. | No script today; review |
| `metadata.json` | The metadata table as JSON: kinds, fields, enums, verbs, links, constants, plus the whole app catalog (`catalog`: every action's verb, kind, inverse, sealed fields, chat surface and phrasings, every query's kind and figures) and what the runtime does not run yet (`declared_kinds`, `declared_verbs`, `unbacked_verbs`). | The runtime; review |
| `errors.json` | The error table: every observation a bad call earns, with its example. | No script today; review |
| `prompt.sig.txt` | The system turn over the fixture world in the default (`sig`) tools mode. | The runtime; review |
| `prompt.compact.txt`, `prompt.full.txt` | The same turn in the other two tools modes. | No script today; review |
| `prompt.s2.txt` | The same turn with the tools block the model S2 was trained on (`search`, `find`, `open`, `compute`, `act`, `answer`, `ask`, `decline`), frozen text (`--tools s2`). | No script today; review |

## Regenerate

```sh
cargo run -p centraid-nativetools --bin nativetools -- export contracts/assist/export
```

`crates/nativetools/tests/export_fixture.rs` renders the export to a scratch directory on every run and diffs every file against this directory, printing the command above and the first differing line. The test is what proves the fresh export equals this copy.
