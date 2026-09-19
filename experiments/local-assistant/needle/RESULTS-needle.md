# Needle lane — results

Stage [2] of the pipeline: Cactus Needle 3 (~121M) as the slot filler, scored **by outcome** on the frozen 74-case suite through the real executor, resolvers and `scoring.score_turn` — never by string match on the call.

**Outcome: base Needle, driven end to end by the trained selector, gets 34 of 74 suite cases (45.9%). Its oracle ceiling — shown the reference operation and nothing else — is 36/74 (48.6%). Showing it the operation plus its catalogue siblings collapses it to 21/74 (28.4%).** The deployed pipeline is therefore already within 2 cases of the ceiling Needle can reach even when told the answer, and the remaining gap is not selection.

Scope note: per the owner's ruling of 2026-09-19 this lane is now the **comparison bar**, not the target. LoRA work (a first `r16/1 epoch/400 sample` adapter, which hurt: dev op-accuracy .930 → .837 single-op, malformed outputs 3 → 7) was stopped and is not carried further. The model facts that bear on that ruling are at the end.

## Suite accuracy by shape

74 cases, outcome-scored, seeded world reset per case. A case fails at its first failing turn.

| shape | selection | total | single_read | single_write | cross_app_one_call | chain | follow_up | reference_into_result | refusal_none |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| oracle, single op | reference | **36/74 (.486)** | 13/18 .72 | 7/14 .50 | 2/10 .20 | 3/8 .38 | 4/8 .50 | 0/8 .00 | 7/8 .88 |
| oracle, op + catalogue siblings | reference | 21/74 (.284) | 8/18 .44 | 6/14 .43 | 1/10 .10 | 1/8 .12 | 0/8 .00 | 0/8 .00 | 5/8 .62 |
| selector, top-1 only (margin 0.0) | trained | 34/74 (.459) | 11/18 .61 | 6/14 .43 | 2/10 .20 | 3/8 .38 | 3/8 .38 | 1/8 .12 | 8/8 1.00 |
| **selector, top-1 else top-3 (margin 0.3)** | trained | **34/74 (.459)** | 11/18 .61 | 6/14 .43 | 2/10 .20 | 3/8 .38 | 3/8 .38 | 1/8 .12 | 8/8 1.00 |
| selector, always top-3 | trained | 31/74 (.419) | 10/18 .56 | 8/14 .57 | 2/10 .20 | 2/8 .25 | 1/8 .12 | 1/8 .12 | 7/8 .88 |

Run labels: `needle-base-suite-single`, `needle-base-suite-siblings`, `needle-base-suite-selector-top1`, `needle-base-suite-selector-m03`, `needle-base-suite-selector-top3` (append-only under `runs/`).

Selector policy: `selector.predict.select` at artifact `lr-3b`, with `previous_operation` fed from the selector's **own** previous prediction, not the reference one — nothing here is oracle. Threshold 0.3 from RESULTS-selector.md's calibration sweep. It fired the top-3 fallback on 24 of 91 turns and changed the case total by zero.

### The two results that decide the lane

1. **More tools is strictly worse for Needle, even when they contain the answer.** The selector's gold-in-set coverage rises from .837 (top-1) to .908 (top-3), yet the end-to-end suite score _falls_ from 34 to 31 cases. Wrong-operation turns go 14 → 24 when the extra two tools are shown. The oracle pair is the same effect at full strength: adding declared siblings to the single correct tool costs 15 cases. Needle does not use a small tool list as a menu to choose from; extra entries actively pull it off.
2. **Selection is no longer the bottleneck.** Oracle-single (.486) and selector-driven (.459) differ by two cases. Fixing the selector further buys at most that. Every remaining point has to come from slot filling, multi-turn handling, or a different filler.

## Error buckets (base model)

Every failed _turn_, bucketed against the reference call for that turn. These are outcome failures, not string mismatches: `slot_exact` is dropped as a headline metric precisely because the scorer already tolerates any slot value the resolvers can resolve to the right rows.

| bucket | oracle single | oracle siblings | selector m0.3 |
| --- | --- | --- | --- |
| wrong operation chosen | 6 | 38 | 14 |
| (f) empty `function_calls` — "no tool available" | 6 | 0 | 7 |
| (a) phrase slot not verbatim | 9 | 7 | 6 |
| (e) extra hallucinated slot | 6 | 1 | 4 |
| (d) missing required/optional slot | 5 | 3 | 3 |
| (b) date / relative-time slot | 3 | 1 | 3 |
| (c) enum or scalar slot wrong | 3 | 3 | 3 |
| selector returned no tool at all | — | — | 2 |
| **failed turns** | **38** | **53** | **40** |

Bucket (g), "value differs but the outcome would be identical after resolvers", is **empty by construction**: the harness scores the world after the turn, so a tolerable rewrite never appears as a failure. That is why the old dev-set `slot_exact` numbers (.651 single, .465 siblings) overstate the problem and are not repeated here.

Notable contents:

- **(f) is not malformed output, and the parser's label is wrong.** All seven envelopes are `{"type": "call", "success": true, "function_calls": []}` with a `reasoning` string that denies the tool exists — _while that exact tool is the only one shown_: `agenda_create_event` shown, "schedule a budget review tomorrow at 3 pm", reasoning "No calendar or scheduling tool available"; `tasks_add` shown, "remind me to call the landlord on Friday", "No reminder or calendar tool available". So the grammar is not breaking and nothing is truncating — the engine emits a well-formed empty call. `filler.parse_envelope` calls this `malformed` because `type != "respond"`; it is an abstention. Six single-op cases die here with the answer handed to the model.
- **(a) is dominated by the result-feedback turn.** 7 of 91 selector turns put a raw row id or a JSON key from the replayed tool result into a slot whose reference value is a phrase: `task: "ids"`, `docs: "kind"`, `task: "t08"`, `people: "p01"`, `photos/album: "ph03"`. This is exactly the unverified caveat in MODEL.md — the harness feeds results as an ordinary user turn of JSON, and the model treats that JSON as text to quote. It is why `reference_into_result` is 0–1 out of 8 in every shape.
- **(e) is invented filters**: `status: "open"` on "what's on my list", `direction: "owed_to_me"` on a neutral balance question, `calendar: "personal"` from nowhere. Each one narrows the id set and fails the outcome.
- **cross_app_one_call is 2/10 in every shape.** The catalogue's answer is one operation with a phrase argument ("attendees of the Initech offsite"), and Needle truncates the phrase to a head noun ("everyone", "retro", "I owe"), which no resolver can match.

No prompt-side variants were run: the owner's ruling cut step 2's tuning rounds to a single measurement pass.

## Model facts that bear on the decision

From `MODEL.md` (full detail there):

- **Bespoke C engine, not `transformers`.** `model_type: needle`, `NeedleForToolCalling`, no modelling code on the hub, no chat template. `AutoModel.from_pretrained` cannot load it and **peft is unusable**. Both inference and tuning go through `cactus-needle`'s own JAX trainer. Any runtime that ships this ships `libneedle.so` per platform over ctypes.
- **Tuned weights are re-quantised to 2.125 bit.** The shipped `.cact` is Cactus-Quant 2.125 bit (embedding 4, mhc 4, default 2); the fine-tunable float checkpoint is 242 MB safetensors. A tuned adapter is merged and re-quantised at the same 2.125 bit before it can be served, so tuning loss and quantisation loss are not separable without a float eval path.
- **The confidence head dies on tuning.** `confidence` is a calibrated head that is not fine-tuned; it returns `None` once tuned weights are loaded. A pipeline that routes on Needle's confidence cannot also carry a LoRA.
- **The training renderer is single-turn.** `needle.model.finetune.render_example` emits one system / user / assistant block with loss masked to the assistant span; it never emits the `<tool_result>` markers the tokenizer defines (ids 12, 13). Training the shape Centraid deploys — multi-turn with result feedback — means writing those markers into the `query` field and hoping the C engine's real wire format for a result turn matches. It was never verified, and the (a)-bucket leaks above are evidence that it does not.
- **The retriever is inside the engine and is not trained by `needle finetune`.** With 1–4 tools there is no retrieval step at all, so the pipeline's selector-in-front design does bypass it — that part works.

## Recommendation

Keep Needle as the bar, not the filler. **45.9% of the suite end to end, with a 48.6% ceiling that no amount of selector work can exceed**, against a runtime cost of a bespoke C engine per platform, a 2-bit requantisation step on every tune, a confidence head that tuning destroys, and a single-turn training renderer that does not match the deployed shape.

The single biggest remaining lever is **not the selector and not slot filling in isolation — it is the result-feedback turn**. `follow_up`, `reference_into_result` and `chain` together are 44 of the 74 cases minus the single-turn ones, and they run at .12–.38 in every shape, because the model quotes the JSON it is fed instead of referring into it. Either the engine's real multi-turn wire format has to be established and matched, or the resolvers have to own ordinal/referential slots entirely and the model must never be shown the previous result. The second is cheap, deterministic and testable, and should be measured before any further model work in this lane.

## Reproduce

```sh
cd experiments/local-assistant
# selector artifact (needs sentence-transformers + scikit-learn in .venv)
VIRTUAL_ENV=$PWD/.venv uv pip install sentence-transformers==5.1.0 scikit-learn==1.7.1
OMP_NUM_THREADS=3 ./.venv/bin/python selector/run_trained.py --label lr-3b --save-artifact

# the three shapes (each 80-150 s on 3 cores)
./.venv/bin/python needle/suite_run.py --shape single   --label needle-base-suite-single-r2
./.venv/bin/python needle/suite_run.py --shape siblings --label needle-base-suite-siblings-r2
./.venv/bin/python needle/suite_run_selector.py --label needle-base-suite-selector-m03-r2 --margin 0.3
./.venv/bin/python needle/suite_run_selector.py --label needle-base-suite-selector-top3-r2 --margin 1.1
```

Run labels are append-only; `runs/<label>.json` is refused if it exists. Traces land in `needle/runs/<label>.trace.jsonl`.

## Wall clock

| step | cost |
| --- | --- |
| selector artifact rebuild (`lr-3b`) | ~7 min, 3 cores |
| suite, oracle single | 74 cases / 94 turns, ~2 min |
| suite, oracle siblings | 74 cases / 83 turns, ~2 min |
| suite, selector-driven (fresh Needle session per turn, history replayed) | 74 cases / 91 turns, 82 s |
| suite, selector always-top-3 | 147 s |
