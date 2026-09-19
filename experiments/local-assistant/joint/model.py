"""The joint model: one small encoder, three kinds of head (JointBERT shape).

Encoder: ``sentence-transformers/all-MiniLM-L6-v2`` — 6 layers, hidden 384,
22.7M parameters, ~90 MB on disk — the same encoder the selector lane used, so
the only moving part between lanes is what sits on top of it.

Input, as a sentence pair so the tagger can be masked to the request half::

    segment A:  [PREVOP_tasks_due] what's due today
    segment B:  mark the first one done

The previous operation is a *learned special token* (48 of them, one per
operation plus ``[PREVOP_NONE]``), never prose. The selector lane's finding was
that folding the previous operation into prose hurts and a discrete feature
helps; a dedicated token is the encoder-native form of that discrete feature.

Heads, all on the same forward pass:

- **operation** — linear over the CLS vector, 47 labels (45 operations,
  ``none``, ``clarify``).
- **slots** — a BIO tagger over the request tokens, with labels per *slot
  name* rather than per (operation, slot): slot names are shared across
  operations (``people``, ``event``, ``task``, ``window``, ``title``,
  ``body`` …), so a shared tagger sees far more examples per label and the
  operation head decides which slots are meaningful.
- **enums** — one classifier per enum slot name over the CLS vector, with an
  extra ``<absent>`` class.

Loss is the plain sum of the three cross-entropies, unweighted: an early run
that discounted the enum heads by 0.2 collapsed every enum to ``<absent>``,
because most rows carry no enum at all.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

import torch
from torch import nn
from transformers import AutoModel, AutoTokenizer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import annotate as A  # noqa: E402

ENCODER = "sentence-transformers/all-MiniLM-L6-v2"
MAX_LENGTH = 64

LABELS: list[str] = list(A.LABELS)
SPAN_SLOTS: list[str] = list(A.SPAN_SLOTS)
ENUM_SLOTS: list[str] = sorted(A.ENUM_SLOTS)
ENUM_VALUES: dict[str, list[str]] = {slot: list(A.ENUM_VALUES[slot]) for slot in ENUM_SLOTS}

BIO: list[str] = ["O"] + [f"{prefix}-{slot}" for slot in SPAN_SLOTS for prefix in ("B", "I")]
BIO_INDEX = {tag: i for i, tag in enumerate(BIO)}
LABEL_INDEX = {name: i for i, name in enumerate(LABELS)}

PREVOP_TOKENS: list[str] = ["[PREVOP_NONE]"] + [f"[PREVOP_{name}]" for name in A.OPERATIONS]


def previous_token(previous_operation: str | None) -> str:
    """The special token that stands for the previous operation."""
    if previous_operation and f"[PREVOP_{previous_operation}]" in PREVOP_TOKENS:
        return f"[PREVOP_{previous_operation}]"
    return "[PREVOP_NONE]"


def build_tokenizer():  # noqa: ANN201
    tokenizer = AutoTokenizer.from_pretrained(ENCODER)
    tokenizer.add_special_tokens({"additional_special_tokens": PREVOP_TOKENS})
    return tokenizer


@dataclass
class Batch:
    """A tokenized batch plus its three targets."""

    encoded: dict
    operation: torch.Tensor
    tags: torch.Tensor
    enums: dict[str, torch.Tensor]


class JointModel(nn.Module):
    """Encoder + operation head + BIO slot tagger + one head per enum slot."""

    def __init__(self, vocab_size: int | None = None) -> None:
        super().__init__()
        self.encoder = AutoModel.from_pretrained(ENCODER)
        if vocab_size is not None:
            self.encoder.resize_token_embeddings(vocab_size)
        hidden = self.encoder.config.hidden_size
        self.dropout = nn.Dropout(0.1)
        self.operation_head = nn.Linear(hidden, len(LABELS))
        self.tag_head = nn.Linear(hidden, len(BIO))
        self.enum_heads = nn.ModuleDict(
            {slot: nn.Linear(hidden, len(values) + 1) for slot, values in ENUM_VALUES.items()}
        )

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor, token_type_ids: torch.Tensor | None = None):  # noqa: ANN201
        kwargs = {"input_ids": input_ids, "attention_mask": attention_mask}
        if token_type_ids is not None:
            kwargs["token_type_ids"] = token_type_ids
        hidden = self.encoder(**kwargs).last_hidden_state
        pooled = self.dropout(hidden[:, 0])
        operation = self.operation_head(pooled)
        tags = self.tag_head(self.dropout(hidden))
        enums = torch.cat([self.enum_heads[slot](pooled) for slot in ENUM_SLOTS], dim=-1)
        return operation, tags, enums


ENUM_OFFSETS: dict[str, tuple[int, int]] = {}
_cursor = 0
for _slot in ENUM_SLOTS:
    _width = len(ENUM_VALUES[_slot]) + 1
    ENUM_OFFSETS[_slot] = (_cursor, _cursor + _width)
    _cursor += _width
ENUM_WIDTH = _cursor


def encode_rows(rows: list[dict], tokenizer, with_targets: bool = True):  # noqa: ANN001, ANN201
    """Tokenize a batch of rows and, when asked, build the three targets."""
    first = [f"{previous_token(row.get('previous_operation'))} {row.get('previous_request') or ''}".strip() for row in rows]
    second = [str(row["request"]) for row in rows]
    encoded = tokenizer(
        first,
        second,
        padding=True,
        truncation=True,
        max_length=MAX_LENGTH,
        return_tensors="pt",
        return_offsets_mapping=True,
    )
    offsets = encoded.pop("offset_mapping")
    request_mask = torch.zeros_like(encoded["input_ids"], dtype=torch.bool)
    for position in range(len(rows)):
        sequence = encoded.sequence_ids(position)
        for token_index, which in enumerate(sequence):
            if which == 1:
                request_mask[position, token_index] = True
    if not with_targets:
        return encoded, offsets, request_mask

    operation = torch.tensor([LABEL_INDEX[str(row["label"])] for row in rows])
    tags = torch.full(encoded["input_ids"].shape, -100, dtype=torch.long)
    for position, row in enumerate(rows):
        for token_index in range(tags.shape[1]):
            if request_mask[position, token_index]:
                tags[position, token_index] = BIO_INDEX["O"]
        for span in row.get("spans", []):
            if span["slot"] not in SPAN_SLOTS:
                continue
            started = False
            for token_index in range(tags.shape[1]):
                if not request_mask[position, token_index]:
                    continue
                start, end = int(offsets[position, token_index, 0]), int(offsets[position, token_index, 1])
                if end <= start:
                    continue
                if start >= span["start"] and end <= span["end"]:
                    prefix = "I" if started else "B"
                    tags[position, token_index] = BIO_INDEX[f"{prefix}-{span['slot']}"]
                    started = True
    enums = {}
    for slot in ENUM_SLOTS:
        values = ENUM_VALUES[slot]
        enums[slot] = torch.tensor(
            [
                values.index(row.get("enums", {}).get(slot)) if row.get("enums", {}).get(slot) in values else len(values)
                for row in rows
            ]
        )
    return Batch(encoded=encoded, operation=operation, tags=tags, enums=enums), offsets, request_mask


def loss_of(outputs, batch: Batch) -> torch.Tensor:  # noqa: ANN001
    """Sum of the operation, tagging and enum cross-entropies."""
    operation_logits, tag_logits, enum_logits = outputs
    cross_entropy = nn.CrossEntropyLoss()
    tag_loss_fn = nn.CrossEntropyLoss(ignore_index=-100)
    loss = cross_entropy(operation_logits, batch.operation)
    loss = loss + tag_loss_fn(tag_logits.reshape(-1, len(BIO)), batch.tags.reshape(-1))
    for slot in ENUM_SLOTS:
        start, end = ENUM_OFFSETS[slot]
        loss = loss + cross_entropy(enum_logits[:, start:end], batch.enums[slot])
    return loss


def decode_spans(request: str, tag_ids: list[int], offsets, request_positions: list[int]) -> dict[str, str]:
    """BIO tags back to slot values, as substrings of the original request."""
    slots: dict[str, str] = {}
    current: tuple[str, int, int] | None = None
    for token_index in request_positions:
        tag = BIO[tag_ids[token_index]]
        start, end = int(offsets[token_index][0]), int(offsets[token_index][1])
        if tag == "O" or end <= start:
            if current and tag == "O":
                slot, begin, finish = current
                slots.setdefault(slot, request[begin:finish])
                current = None
            continue
        prefix, slot = tag.split("-", 1)
        if prefix == "B" or current is None or current[0] != slot:
            if current:
                done_slot, begin, finish = current
                slots.setdefault(done_slot, request[begin:finish])
            current = (slot, start, end)
        else:
            current = (slot, current[1], end)
    if current:
        slot, begin, finish = current
        slots.setdefault(slot, request[begin:finish])
    return slots


def config_blob() -> dict:
    """Everything a runtime needs to interpret the heads."""
    return {
        "encoder": ENCODER,
        "labels": LABELS,
        "bio": BIO,
        "enum_slots": ENUM_SLOTS,
        "enum_values": ENUM_VALUES,
        "enum_offsets": {k: list(v) for k, v in ENUM_OFFSETS.items()},
        "prevop_tokens": PREVOP_TOKENS,
        "max_length": MAX_LENGTH,
    }


if __name__ == "__main__":
    print(json.dumps({"labels": len(LABELS), "bio_tags": len(BIO), "enum_slots": ENUM_SLOTS}, indent=1))
