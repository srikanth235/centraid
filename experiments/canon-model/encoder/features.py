"""Tokenise `<prev canonical or NONE> ||| <utterance>` and align the BIO tags.

The input string is exactly `data/build.py`'s, so the previous canonical is
available both as context AND as a source of literal spans: a `refine` turn's
literal is usually in the PREV half and not in the member's new words, and a
tagger over the whole string can copy it from there.
"""
from __future__ import annotations

import torch

MAXLEN = 128


def find_span(text, needle):
    """Case-insensitive occurrence; prefers the utterance half (after '|||')."""
    if not needle:
        return None
    low, n = text.lower(), needle.lower()
    bar = text.find("|||")
    at = low.find(n, bar + 3 if bar >= 0 else 0)
    if at < 0:
        at = low.find(n)
    if at < 0:
        return None
    return at, at + len(needle)


def encode(tok, texts, labels, vocabs, with_labels=True):
    batch = tok(texts, return_tensors="pt", padding=True, truncation=True,
                max_length=MAXLEN, return_offsets_mapping=True)
    offsets = batch.pop("offset_mapping")
    out = {"input_ids": batch["input_ids"],
           "attention_mask": batch["attention_mask"]}
    if not with_labels:
        return out, offsets
    n, L = batch["input_ids"].shape
    out["template"] = torch.tensor(
        [vocabs.t2i.get(l.template, 0) for l in labels], dtype=torch.long)
    out["template_ok"] = torch.tensor(
        [1 if l.template in vocabs.t2i else 0 for l in labels], dtype=torch.long)
    for name, vs in vocabs.slots.items():
        out["slot_" + name] = torch.tensor(
            [vocabs.s2i[name].get(l.closed.get(name, "<none>"), 0)
             for l in labels], dtype=torch.long)
    tags = torch.zeros((n, L), dtype=torch.long)
    tags[batch["attention_mask"] == 0] = -100
    for i, lab in enumerate(labels):
        for key, value in lab.lits.items():
            span = find_span(texts[i], value)
            if span is None:
                continue
            s, e = span
            first = True
            for j in range(L):
                a, b = offsets[i, j].tolist()
                if a == b:
                    continue
                if a >= s and b <= e:
                    tags[i, j] = vocabs.b2i["%s-%s" % ("B" if first else "I", key)]
                    first = False
    out["tags"] = tags
    return out, offsets


def decode_tags(tok_ids, offsets, tag_ids, text, vocabs):
    """BIO -> {"LIT0": "Tahoe Trip", ...} using the INPUT's own characters."""
    spans = {}
    cur_key, cur_s, cur_e = None, None, None
    for j, t in enumerate(tag_ids):
        lab = vocabs.bio[t]
        a, b = offsets[j]
        if a == b:
            continue
        if lab == "O":
            if cur_key and cur_key not in spans:
                spans[cur_key] = text[cur_s:cur_e]
            cur_key = None
            continue
        pos, key = lab.split("-", 1)
        if pos == "B" or key != cur_key:
            if cur_key and cur_key not in spans:
                spans[cur_key] = text[cur_s:cur_e]
            cur_key, cur_s, cur_e = key, a, b
        else:
            cur_e = b
    if cur_key and cur_key not in spans:
        spans[cur_key] = text[cur_s:cur_e]
    return spans
