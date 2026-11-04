"""Datagen records as the trainer reads them (M6 of #1171): the rendered token ids and per-token loss weights, taken as they are.

A data version (crates/datagen, M4) holds `train.jsonl.zst`, `val.jsonl.zst`, `test.jsonl.zst` and `noise.jsonl.zst`. Each line is an
assist-eval session (`id, world, today, me, tags, turns[...]`) plus

    "render": {"input_ids": [int, ...], "weights": [float, ...], "text": str}      # len(input_ids) == len(weights)

rendered by the Rust runtime with the Qwen/Qwen3.5-0.8B tokenizer. The trainer does not render and has no chat template: it reads
`render.input_ids` and `render.weights`. A weight of 0 is no loss (system / catalog block, user text, tool results), 1 is an assistant think
or tool call, and more than 1 is a deciding token (op, filters, dates, handles, numbers).

THE LOSS of a batch of records is

    sum over tokens t of  weight[t] * CE(logits[t - 1], input_ids[t])  /  sum over tokens t of  weight[t]

(the first token is never a target). It is a weighted mean, so the step's gradient scale is that of a mean, as in train.py. The sums run over
the whole batch (`--bs` records), not per record. Weight 0 tokens contribute nothing to either sum.

No third-party import here except `zstandard`, imported when a `.zst` file is opened, so the module loads without torch.
"""
from __future__ import annotations

import gzip
import io
import json
import math
from pathlib import Path

IGNORE = -100  # train.py asserts this equals fmt.IGNORE: a position with weight 0 carries this label


class TokenWeights(list):
    """The per-token loss weights of one record (floats, aligned with input_ids, index 0 included). A list, but a distinct type: it tells
    the loss code that the weights are given and not derived from the decision bits of the legacy format."""


class RecordError(ValueError):
    """A record that breaks the contract (never skipped: the data version is wrong, not the trainer)."""


def read_jsonl(path):
    """Yield the objects of a JSONL file, `.zst` (zstandard), `.gz` or plain, one per non-empty line."""
    path = Path(path)
    if path.suffix == ".zst":
        import zstandard

        with open(path, "rb") as raw, zstandard.ZstdDecompressor().stream_reader(raw) as reader:
            for line in io.TextIOWrapper(reader, encoding="utf-8"):
                if line.strip():
                    yield json.loads(line)
        return
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def pair_of(rec: dict) -> str:
    """The minimal-pair id of a record ('' = none): its `pair` field, else the first tag `pair:<id>`."""
    p = rec.get("pair")
    if isinstance(p, (str, int)) and not isinstance(p, bool) and str(p).strip():
        return str(p).strip()
    tags = rec.get("tags") or ()
    for t in tags.split() if isinstance(tags, str) else tags:
        if isinstance(t, str) and t.startswith("pair:") and t[5:].strip():
            return t[5:].strip()
    return ""


def encode(rec: dict) -> dict:
    """One record to {id, input_ids, labels, weights, pair}; RecordError when it breaks the contract."""
    rid = rec.get("id", "?")
    render = rec.get("render")
    if not isinstance(render, dict):
        raise RecordError("%s: no render object" % rid)
    ids, w = render.get("input_ids"), render.get("weights")
    if not isinstance(ids, list) or not isinstance(w, list):
        raise RecordError("%s: render.input_ids and render.weights must be lists" % rid)
    if len(ids) != len(w):
        raise RecordError("%s: %d input_ids but %d weights" % (rid, len(ids), len(w)))
    if len(ids) < 2:
        raise RecordError("%s: fewer than two tokens" % rid)
    if not all(isinstance(t, int) and not isinstance(t, bool) and t >= 0 for t in ids):
        raise RecordError("%s: input_ids must be non-negative integers" % rid)
    weights = TokenWeights(float(x) for x in w)
    if not all(math.isfinite(x) and x >= 0.0 for x in weights):
        raise RecordError("%s: weights must be finite and not negative" % rid)
    if not any(x > 0.0 for x in weights[1:]):
        raise RecordError("%s: no token carries loss (every weight after the first is 0)" % rid)
    labels = [t if x > 0.0 else IGNORE for t, x in zip(ids, weights)]
    return {"id": rid, "input_ids": ids, "labels": labels, "weights": weights, "pair": pair_of(rec)}


def load(path, max_len: int, limit: int = 0) -> tuple[list[dict], dict]:
    """The encoded records of `path` and their counts {read, kept, dropped_too_long, tokens, label_tokens, weight_mass}.

    A record longer than `max_len` tokens is dropped and counted, never cut: a truncated session would train on a call without its
    result. `limit` keeps the first N records that fit (0 = all)."""
    kept, stats = [], {"read": 0, "kept": 0, "dropped_too_long": 0, "tokens": 0, "label_tokens": 0, "weight_mass": 0.0}
    for rec in read_jsonl(path):
        if limit and len(kept) >= limit:
            break
        stats["read"] += 1
        enc = encode(rec)
        if len(enc["input_ids"]) > max_len:
            stats["dropped_too_long"] += 1
            continue
        kept.append(enc)
        stats["tokens"] += len(enc["input_ids"])
        stats["label_tokens"] += sum(1 for y in enc["labels"][1:] if y != IGNORE)
        stats["weight_mass"] += sum(enc["weights"][1:])
    stats["kept"] = len(kept)
    return kept, stats


def check_text(tok, path, n: int = 8) -> int:
    """Tokenise `render.text` of the first `n` records and count those whose ids differ from `render.input_ids`. The trainer trains on the
    ids anyway; a difference means the Rust renderer and the tokenizer in use disagree (a wrong tokenizer, a changed template)."""
    bad = 0
    for i, rec in enumerate(read_jsonl(path)):
        if i >= n:
            break
        render = rec.get("render") or {}
        text = render.get("text")
        if text is not None and tok(text, add_special_tokens=False)["input_ids"] != render.get("input_ids"):
            bad += 1
    return bad
