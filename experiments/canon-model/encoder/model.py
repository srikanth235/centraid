"""A small pretrained encoder with one skeleton head, N slot heads, one tagger."""
from __future__ import annotations

import json
import os

import torch
from torch import nn
from transformers import AutoModel, AutoTokenizer

from task import CLOSED_SLOTS, NONE, bio_labels, slot_names


class Vocabs:
    def __init__(self, templates, slots, bio):
        self.templates = templates
        self.t2i = {t: i for i, t in enumerate(templates)}
        self.slots = slots                     # {"KIND0": [NONE, "events", ...]}
        self.s2i = {k: {v: i for i, v in enumerate(vs)} for k, vs in slots.items()}
        self.bio = bio
        self.b2i = {b: i for i, b in enumerate(bio)}

    def save(self, path):
        json.dump({"templates": self.templates, "slots": self.slots,
                   "bio": self.bio}, open(path, "w", encoding="utf-8"))

    @staticmethod
    def load(path):
        d = json.load(open(path, encoding="utf-8"))
        return Vocabs(d["templates"], d["slots"], d["bio"])

    @staticmethod
    def build(labels):
        templates = sorted({l.template for l in labels})
        slots = {}
        for name in slot_names():
            seen = sorted({l.closed[name] for l in labels if name in l.closed})
            slots[name] = [NONE] + seen
        return Vocabs(templates, slots, bio_labels())


class CanonEncoder(nn.Module):
    def __init__(self, base, vocabs, dropout=0.1):
        super().__init__()
        self.encoder = AutoModel.from_pretrained(base)
        hidden = self.encoder.config.hidden_size
        self.drop = nn.Dropout(dropout)
        self.template = nn.Linear(hidden, len(vocabs.templates))
        self.slots = nn.ModuleDict(
            {k: nn.Linear(hidden, len(v)) for k, v in vocabs.slots.items()})
        self.tagger = nn.Linear(hidden, len(vocabs.bio))
        self.vocabs = vocabs

    def forward(self, input_ids, attention_mask):
        out = self.encoder(input_ids=input_ids,
                           attention_mask=attention_mask).last_hidden_state
        mask = attention_mask.unsqueeze(-1).float()
        pooled = self.drop((out * mask).sum(1) / mask.sum(1).clamp(min=1e-6))
        return (self.template(pooled),
                {k: h(pooled) for k, h in self.slots.items()},
                self.tagger(self.drop(out)))


def load_tokenizer(base):
    return AutoTokenizer.from_pretrained(base, use_fast=True)
