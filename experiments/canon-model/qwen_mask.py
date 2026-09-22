"""The compiled mask, bridged to a DECODER-ONLY tokenizer (Qwen2.5).

`llg_mask.py` bridges T5: SentencePiece/Metaspace, where a piece's text is
the piece with `_` respelled as a space.  Qwen2.5 is byte-level BPE, so the
same trick is wrong in two ways (`G` is the space marker, and a piece can be
a partial UTF-8 sequence).  llguidance's own HF bridge reads a byte-level
tokenizer fine, so that is the route taken here; `piece_texts` is rebuilt
from the tokenizer's own byte decoder rather than by string surgery, so the
mask and the text the decoder assembles cannot disagree -- the same property
MASK.md's T5 bridge argues for.

The second difference is structural: a decoder-only model's `input_ids`
holds the PROMPT.  The grammar governs the completion only, so the
LogitsProcessor slices the prompt off before it reaches the matcher.
"""

from __future__ import annotations

import numpy as np
import torch
from transformers import LogitsProcessor, LogitsProcessorList

import llg_mask
from llg_mask import UNPARSED  # noqa: F401  (re-exported)

try:
    from llguidance.hf import from_tokenizer as _ll_from_tokenizer
except ImportError:  # pragma: no cover
    _ll_from_tokenizer = None


def byte_texts(tok):
    """id -> the text the id contributes, for ids a mask can contain.

    Built with the tokenizer's own byte decoder.  A piece that is not valid
    UTF-8 on its own is DROPPED from the map, never guessed at: the mask may
    still admit it, but the close-out search will not choose it and the
    assembled text comes from `tok.decode` over the whole id list.
    """
    specials = set(tok.all_special_ids)
    out = {}
    for index in range(len(tok)):
        if index in specials:
            continue
        piece = tok.convert_ids_to_tokens(index)
        if piece is None:
            continue
        try:
            text = tok.convert_tokens_to_string([piece])
        except Exception:
            continue
        if "�" in text:
            continue
        out[index] = text
    return out


class QwenConstraint(llg_mask.LLGConstraint):
    """`LLGConstraint` with a byte-level tokenizer bridge."""

    def __init__(self, tok):
        if _ll_from_tokenizer is None:
            raise SystemExit("llguidance.hf is unavailable in this venv")
        self.tok = tok
        self.lt = _ll_from_tokenizer(tok)
        self.grammar = llg_mask.compiled_grammar()
        self.texts = byte_texts(tok)
        self.vocab = len(tok)
        self.eos = tok.eos_token_id
        self.pad = tok.pad_token_id
        from llguidance.torch import allocate_token_bitmask
        self._bitmask = allocate_token_bitmask(1, self.lt.vocab_size)
        self.matcher = None
        self.consumed = 0
        self.blocked = 0
        self.mask_calls = 0
        self.reset()

    def text_for(self, ids):
        return self.tok.decode([int(i) for i in ids],
                               skip_special_tokens=True).strip()


class PromptSlicingProcessor(LogitsProcessor):
    """`LLGLogitsProcessor`, minus the prompt."""

    def __init__(self, constraint, prompt_len):
        self.constraint = constraint
        self.prompt_len = prompt_len
        self.blank = np.zeros(constraint.vocab, dtype=bool)
        for index, text in constraint.texts.items():
            if not text.strip():
                self.blank[index] = True

    def __call__(self, input_ids, scores):
        ids = [int(i) for i in input_ids[0][self.prompt_len:].tolist()]
        ids = [i for i in ids if i not in (self.constraint.pad, self.constraint.eos)]
        mask = self.constraint.mask_for(ids)
        bits = np.unpackbits(mask.numpy().view(np.uint8),
                             bitorder="little")[:self.constraint.vocab]
        allow = bits.astype(bool)
        if ids and ids[-1] < len(self.blank) and self.blank[ids[-1]]:
            narrowed = allow & ~self.blank
            if narrowed.any():
                allow = narrowed
        # The lm_head is padded past the tokenizer's vocabulary (248,320 vs
        # 248,077).  Those ids stand for no text, so they are never allowed;
        # widening with False is the only safe fill.
        width = scores.shape[-1]
        if width > allow.shape[0]:
            allow = np.concatenate(
                [allow, np.zeros(width - allow.shape[0], dtype=bool)])
        allow = torch.from_numpy(allow[:width].copy())
        return scores.masked_fill(~allow.unsqueeze(0), float("-inf"))


def generate_one(tok, model, prompt_ids, constraint, max_new_tokens=64,
                 close_out=True):
    """One masked greedy decode from a decoder-only model.

    Returns `(final, emitted, used_finisher)`.  `emitted` is the model's own
    string, written before anything parses it; `final` differs from it only
    where the close-out search completed a legal but unfinished prefix, and
    is `UNPARSED` where that search gave up.
    """
    constraint.reset()
    prompt_len = prompt_ids.shape[-1]
    processor = PromptSlicingProcessor(constraint, prompt_len)
    with torch.no_grad():
        out = model.generate(
            input_ids=prompt_ids,
            attention_mask=torch.ones_like(prompt_ids),
            max_new_tokens=max_new_tokens, do_sample=False, num_beams=1,
            pad_token_id=tok.pad_token_id or tok.eos_token_id,
            logits_processor=LogitsProcessorList([processor]))
    ids = [int(i) for i in out[0][prompt_len:].tolist()]
    ids = [i for i in ids if i not in (constraint.pad, constraint.eos)]
    emitted = constraint.text_for(ids)
    constraint.mask_for(ids)
    if constraint.is_accepting():
        return emitted, emitted, False
    if not close_out:
        return UNPARSED, emitted, False
    tail = constraint.complete(ids)
    if tail is None:
        return UNPARSED, emitted, False
    return constraint.text_for(list(ids) + list(tail)), emitted, True
