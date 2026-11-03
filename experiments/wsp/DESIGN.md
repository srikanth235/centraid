# Weight-space programming harness: design

A harness in which a frontier model (Astra, driven from Codex) reads and edits the weights of
Qwen3.5-0.8B and measures each edit on one fixed task: turning a member's message into one
call on the Centraid catalog. No gradients are used anywhere in this harness.

Principle: **the model says what the member said; the runtime resolves it.** Names stay
mentions, dates stay phrases, secrets go to a card.

## 1. The model-facing catalog (`catalog.py` -> `catalog/schemas.json`)

Source: `crates/apps/*/manifest.json` (`actions`, `queries`). The output is generated, committed,
and carries the sha256 of every manifest it read. Sorted by id; byte-stable across runs.

One entry per action and per query:

```json
{"id": "agenda.propose", "type": "action", "app": "agenda", "kind": "event", "verb": "create",
 "card": false, "summary": "<first sentence of description>",
 "phrasings": ["..."],
 "params": {"title": {"type": "text", "required": true},
            "starts": {"type": "when", "required": true},
            "calendar": {"type": "mention", "of": "calendar", "required": false},
            "status": {"type": "enum", "values": ["confirmed", "tentative", "cancelled"], "required": false},
            "attendees": {"type": "list", "items": "mention", "required": false}}}
```

Param types: `text`, `mention` (a name as the member says it; `of` names the kind when known),
`when` (a date/time phrase as the member says it: "next friday 7pm"), `amount` (as said: "$40"),
`number`, `bool`, `enum` (with `values`), `list` (with `items`). Queries are `"type": "view"`.

Derivation rules (the generator applies them and lists every dropped field per entry under
`"dropped": {"field": "reason"}`):

1. `id` on a `create` action is minted by the vault: dropped. `id` on any other action is the
   row acted on: renamed `target`, type `mention`, `of` = the action's kind, required.
2. `<x>_id` -> `<x>`, type `mention`, `of` = `<x>`. Arrays of ids -> `list` of `mention`.
3. Fields named in the action's `sealed` list: dropped; the action gets `"card": true`.
   An action whose manifest `confirmation` is not `none`, or that is `bulk`, is also `card`.
4. Date and time fields (`starts`, `ends`, `due`, `from`, `to`, `since`, `through`, `date`,
   `month`, `day`, `original_start*`, and any field whose description says instant/ISO/RFC 3339
   date) -> `when`. An RFC 5545 `rule` -> `repeat`, type `when` ("every monday").
5. Minor-unit money (`*_minor`, `amount*`) -> `amount`, type `amount`.
6. Plumbing a member never says -> dropped: blobs, sequence numbers, cursors (`after`), paging
   `limit` on views stays a `number`, invoke keys, `typing_*`, `instance_key`, `media_type`,
   `size`, `origin`, `records`, `zone`, `timing`. The list is in `catalog.py`, one reason each.
7. Everything else keeps its manifest name; JSON-schema `enum` -> `enum`, `boolean` -> `bool`,
   `integer`/`number` -> `number`, `string` -> `text`.

## 2. Tools the model sees (`prompt.py`)

Four tools, Qwen's native tool format, thinking off by default (`enable_thinking=False`):

| tool | parameters |
| --- | --- |
| `act` | `action` (an action id), `input` (JSON object of its params) |
| `load` | `view` (a view id), `params` (JSON object) |
| `ask` | `question` (text) |
| `decline` | `reason`: `out_of_scope` · `never_mind` · `fabricated_secret` · `unbounded_destruction` |

The system message holds: one-paragraph role, `today: <Weekday YYYY-MM-DD>`, `me: <name>`, and a
`candidates:` block with the top-k entries from retrieval, one compact line each:
`agenda.propose (act, event, create) — <summary> — title*: text, starts*: when, calendar: mention<calendar>, ...`
(`*` = required; `[card]` suffix when the action is a card).

Retrieval (`retrieve.py`): BM25 over id, kind, verb, summary and phrasings; k = 8; ties by id;
deterministic. The probe report records whether the gold id was among the candidates.

Interfaces:

```python
catalog.load(path="catalog/schemas.json") -> dict[str, dict]           # id -> entry
retrieve.candidates(text: str, catalog: dict, k: int = 8) -> list[str]  # ids
prompt.messages(item: dict, catalog: dict, k: int = 8) -> tuple[list[dict], list[dict], list[str]]
    # (chat messages, tool definitions, candidate ids) for tokenizer.apply_chat_template
prompt.render(item, catalog, tokenizer, k=8) -> tuple[str, list[str]]    # (prompt text, candidates)
```

## 3. Probe items (`probe/dev.jsonl`, `probe/hold.jsonl`)

```json
{"id": "agenda-007", "app": "agenda", "today": "2026-11-03", "me": "Sam Park",
 "history": [], "user": "push the dentist to thursday 4pm",
 "gold": {"tool": "act", "name": "agenda.edit-event",
          "args": {"target": "the dentist", "starts": ["thursday 4pm", "thursday at 4pm"]},
          "optional": {}},
 "tags": ["write", "when"]}
```

- `history`: earlier turns as `{"user": ..., "call": {"tool", "name", "args"}}`; most items have none.
- `gold.args`: every arg the call must carry. A list value means any-of. `optional`: args the call
  may carry or leave out (with their accepted values). For `ask`, `args` is `{}`; for `decline`,
  `{"reason": "..."}`. `alts` (rare): other complete `{args, optional}` sets that are equally right,
  e.g. the two sides of a symmetric pair (`money.link-transfer`).
- Split: stratified by app and gold tool, and decided by `sha256(id)` after authoring (`split.py`).
  Astra sees dev only.
- Size: 992 items, about 124 per app, 496 dev and 496 hold. Every action and view appears at least
  twice. Each batch was authored and then independently reviewed (Sonnet agents).

## 4. Generation (`run.py`)

The starting model is `RikiyaT/Qwen3.5-0.8B-weight-space-programming`: Qwen3.5-0.8B with the
thinking-loop direction removed, which is what makes thinking usable at 0.8B. Two modes, seeded
(`--greedy` for greedy decoding):

| mode | flag | sampling |
| --- | --- | --- |
| thinking on (the regime) | `--think-cap 32768` (default) | the post's: temperature 0.6, top-p 0.95, top-k 20, presence penalty 1.5 |
| thinking off (reference) | `--think-cap 0` | the model card's: temperature 1.0, top-p 1.0, top-k 20, presence penalty 2.0 |

When the cap is hit without `</think>`, the harness appends `\n</think>\n\n` and continues for up to
512 more tokens. transformers has no presence penalty, so it applies on the gguf backend only.
Backends: `hf` (transformers, batched, left padding) and `gguf` (llama-cpp-python, the same prompt
text and cap logic). Output: one JSON line per item with the raw text, the think, the parsed call,
think token count, `capped`, candidates, and wall time. Astra chooses the regime an edit runs in
and declares it in `regime.json`.

## 5. Scoring (`score.py`)

Per item: `parse_ok`, `valid` (tool known, name in catalog and of the right type, args are params
of that entry, required present, enum values legal), `tool_ok`, `name_ok`, `args_ok`, `correct`.
Strings compare after casefold, whitespace fold, and stripping punctuation and a leading
"the/a/an/my". Extra args not in `gold.args` or `gold.optional` fail `args_ok`.

Report (JSON + a markdown table, overall and per app): n, correct, valid, retrieval recall,
(with thinking on: think capped rate, mean think tokens, repeat-loop rate), **wrong write** (an `act` where gold is not that act on that target: the guardrail),
over-ask (asked where gold did not), under-ask (gold asked, the model did not).
A paired comparison of two runs: items won, lost, z = (w - l) / sqrt(w + l).

## 6. The lab Astra works in (`lab.py`, `budget.py`)

```python
lab = Lab(model_dir, run="name", budget=0)    # loads weights; 0 passes = pure weights (the brief); opens runs/<name>/ledger.jsonl
lab.dev()                                     # dev items only; there is no hold accessor
lab.generate(items)                           # 1 pass = up to 512 items; scored output
lab.forward(texts, capture=["model.layers.15.mlp"], attn_layers=[...])
                                              # 1 pass = up to 1,024 texts; activations / attention
lab.tensors                                   # name -> tensor, read and write in memory
lab.passes_left
```

Every pass is appended to the ledger (kind, item count, pass number). A pass over budget raises.
Reading weights is free; running the model is not.

## 7. Edits (`apply_edit.py`)

An edit is a directory `edits/<name>/` with `edit.py` defining
`apply(tensors: dict[str, torch.Tensor]) -> None` (in place, deterministic, no data files, no
randomness) and `NOTES.md` (Astra's mechanism and evidence).
`python apply_edit.py --base DIR --edit edits/<name> --out DIR` writes the edited safetensors and
`edit.json`: sha256 of base and output files, changed elements per tensor, total, fraction.

## 8. Flow

1. Baseline: `run.py` + `score.py` on the starting model (thinking on), with the base model and thinking
   off as reference rows; dev and hold, bf16; then Q4_0 GGUF.
2. Astra in the lab on dev, 50 passes, proposes one edit.
3. `apply_edit.py`, then dev and hold on bf16 and Q4_0. Keep an edit only if hold improves outside
   noise and wrong writes do not rise.
