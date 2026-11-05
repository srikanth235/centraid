# data-v7, fetched

Everything under `v7/` is a fetched artefact of **data-v7**, the version S2 was trained and judged on. It is gitignored (`artefacts.json` is the manifest, `python3 ../artefacts.py fetch` the way back, `check` the verification), held out, and **no longer rebuilt**: the Python data tooling that made it (`authored/`, `eval/`, `render.py`) is retired (#1171). A new data version is made only by `cargo run -p centraid-datagen -- build --version vN` (`crates/datagen/README.md`); this directory is where the Rust eval looks for the old val set, not where new data goes.

| path | what |
| --- | --- |
| `v7/val.jsonl`, `v7/test.jsonl`, `v7/split.json` | the frozen eval sets and their split (`v7/FROZEN.md`: counts, hashes, lineage). `crates/assist-eval` reads `val.jsonl` by default |
| `v7/worlds/*.json` | the worlds the sets run in (A to G, T03, T12, T23). `crates/assist-eval` reads them by default |
| `v7/roll-screen.jsonl` | the RFT screen set of data-v7 |
| `v7/train.jsonl.gz`, `v7/train-val.jsonl.gz` | the training build S2 was trained on, and the trainer's validation slice (below) |

## The training build

| file | records | turns | worlds |
| --- | --- | --- | --- |
| `train.jsonl.gz` | 30,597 sessions (4,491 natural, 26,106 drills) | 42,705 (14,235 natural, 28,470 drills) | 35 train worlds |
| `train-val.jsonl.gz` | 402 sessions | 1,303 | 7 (A B C D T03 T12 T23) |

```
51dfbe27e7fcb82af5fe054598ef073b17ed414f742ad084ee50d121e4b4f7bf  v7/train.jsonl.gz
8e03a8b4a8b90fe81b1221de57baed8321616ca026b4fd53fc021dbba5574eb1  v7/train-val.jsonl.gz
```

Each file is one gzip member. A record is one session, one JSON object per line: `id`, `split`, `world`, `today`, `me`, `tools_mode` (`sig`), `messages` (the conversation as the model saw it; an assistant message holds the v3.1 slot trace of `CONTRACT_V3.md` as `think` and the call as `tool` and `args`), `n_turns`, `tags` (a drill also carries `drill`, its cell and `pair:<id>`), `source`. This is the legacy record. **The trainer (`train/train.py`) no longer reads it**: it reads datagen's records, which carry their rendered token ids and loss weights (`train/datagen.py`). The file is kept for reference.

`train.jsonl.gz` is 4,491 natural sessions of the 35 train worlds (no session of a val world, none of `val.jsonl` or `test.jsonl`) and 26,106 decision drills (13,053 minimal pairs) that weigh twice the natural turns. `train-val.jsonl.gz` is 402 sessions of `val.jsonl`, 180 from the authored val worlds and the rest from A to D, used only to draw the held-out loss curve; it is never trained on.
