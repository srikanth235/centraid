"""The compiled mask: an Earley recognizer over the canonical grammar.

`canon_grammar.py` answered "is this prefix viable?" by running
`check.Parser` in prefix mode, once per candidate CHARACTER per decoding
step.  That is the defect Lane E measured from both ends: ~1.5 s/turn, and a
30.5% parse rate from a random-init model, because a recursive-descent
parser with finite lookahead has to answer "viable" whenever it cannot yet
decide, so the mask admits heads that no legal turn extends.

Here the grammar is stated declaratively (`canon_lark.py`) and compiled once
by llguidance -- a Rust Earley recognizer with a token-level lexer.  Two
consequences, and they are the whole point:

  * NO LEAK.  Earley keeps the set of live items.  A token is in the mask
    only if some item survives it, and an item survives only if the input
    read so far can still be completed to a whole `start`.  So every
    admitted prefix is completable: there is no head to walk into.
  * O(1)-ish STEP.  One `compute_mask` over the whole vocabulary, in Rust,
    off a cached lexer/parser row -- not 32k calls into a Python parser.

What is NOT claimed: that the mask is exactly `check.py`'s language.  The
productions in `canon_lark.py` are a transcription, and a transcription can
be wrong.  It is checked both ways (`llg_verify.py`), and a string that this
mask admits and `check.parse` rejects is a bug in `canon_lark.py`, to be
fixed there.
"""

from __future__ import annotations

import functools
import time

import numpy as np
import torch
from transformers import LogitsProcessor, LogitsProcessorList

import canon_lark

try:
    import llguidance
    from llguidance import LLMatcher, LLTokenizer, TokenizerWrapper
    from llguidance.torch import allocate_token_bitmask, fill_next_token_bitmask
except ImportError as error:                       # pragma: no cover
    raise SystemExit(
        "llguidance is not installed in this venv: %s\n"
        "    experiments/canon-model/.venv/bin/pip install llguidance" % error
    )


# ---------------------------------------------------------------------------
# Tokenizer bridge
# ---------------------------------------------------------------------------
# llguidance.hf.from_tokenizer refuses T5: it cannot read a Metaspace decoder
# ("can't determine decoder type"). So the vocabulary is handed over
# directly, one byte string per id, with SentencePiece's `_` spelled as the
# space it stands for -- the same mapping `decode.piece_text` uses, so the
# mask and the text the decoder assembles cannot disagree.

class _Vocab:
    def __init__(self, tok):
        self._tok = tok
        specials = set(tok.all_special_ids)
        pieces = tok.convert_ids_to_tokens(list(range(len(tok))))
        tokens = []
        for index, piece in enumerate(pieces):
            if piece is None:
                piece = "<unused_%d>" % index
            if index in specials or piece.startswith("<extra_id_"):
                # A byte string no grammar can match, so a special token is
                # never in the mask.  EOS is handled by llguidance itself.
                tokens.append(b"\x00" + piece.encode("utf-8"))
            else:
                tokens.append(piece.replace("▁", " ").encode("utf-8"))
        self.tokens = tokens
        self.eos_token_id = tok.eos_token_id
        self.bos_token_id = None
        self.special_token_ids = sorted(specials)

    def __call__(self, text):
        if isinstance(text, bytes):
            text = text.decode("utf-8", "replace")
        return self._tok(text, add_special_tokens=False).input_ids


@functools.lru_cache(maxsize=4)
def ll_tokenizer(tok):
    return LLTokenizer(TokenizerWrapper(_Vocab(tok)))


@functools.lru_cache(maxsize=4)
def compiled_grammar():
    """The grammar, compiled once."""
    return LLMatcher.grammar_from_lark(canon_lark.LARK)


def piece_texts(tok):
    """id -> the text the id contributes, for the ids a mask can contain."""
    specials = set(tok.all_special_ids)
    out = {}
    for index, piece in enumerate(tok.convert_ids_to_tokens(list(range(len(tok))))):
        if piece is None or index in specials or piece.startswith("<extra_id_"):
            continue
        out[index] = piece.replace("▁", " ")
    return out


# ---------------------------------------------------------------------------
# The mask
# ---------------------------------------------------------------------------

class LLGConstraint:
    """One decode's worth of grammar state.

    `reset()` before each generation; `step(ids)` brings the matcher up to a
    decoder history and returns the allowed-token bitmask.
    """

    def __init__(self, tok):
        self.tok = tok
        self.lt = ll_tokenizer(tok)
        self.grammar = compiled_grammar()
        self.texts = piece_texts(tok)
        self.vocab = len(tok)
        self.eos = tok.eos_token_id
        self.pad = tok.pad_token_id
        self._bitmask = allocate_token_bitmask(1, self.lt.vocab_size)
        self.matcher = None
        self.consumed = 0
        self.blocked = 0
        self.mask_calls = 0
        self.reset()

    # -- lifecycle ----------------------------------------------------------
    def reset(self):
        self.matcher = LLMatcher(self.lt, self.grammar)
        self.consumed = 0

    def strip(self, ids):
        """Drop the decoder-start pad and any trailing eos/pad."""
        ids = list(int(i) for i in ids)
        while ids and ids[0] in (self.pad, self.eos):
            ids = ids[1:]
        return [i for i in ids if i not in (self.pad, self.eos)]

    def text_for(self, ids) -> str:
        return "".join(self.texts.get(int(i), "") for i in ids).strip()

    # -- the mask -----------------------------------------------------------
    _history: list = []

    def mask_for(self, ids) -> torch.Tensor:
        """The int32 bitmask of allowed next tokens after `ids`."""
        ids = list(ids)
        if ids[:self.consumed] != self._history[:self.consumed] or \
                len(ids) < self.consumed:
            self.reset()
        # llguidance's contract is ALTERNATING: compute the mask, then consume
        # the sampled token.  Consuming several in a row without a mask
        # between leaves the lexer a step behind and the next mask is wrong.
        for token in ids[self.consumed:]:
            fill_next_token_bitmask(self.matcher, self._bitmask, 0)
            if not self.matcher.consume_token(int(token)):
                self.blocked += 1
                break
            self.consumed += 1
        self._history = ids
        self.mask_calls += 1
        fill_next_token_bitmask(self.matcher, self._bitmask, 0)
        return self._bitmask

    def is_accepting(self) -> bool:
        return self.matcher.is_accepting()

    # -- closing an unfinished generation -----------------------------------
    # A budget that runs out mid-string leaves a legal PREFIX, not a turn.
    # The matcher itself says which tokens are legal, so the close-out is a
    # small best-first search over matcher copies: prefer a closing
    # character, then the shortest piece.  Unlike the old character-BFS
    # finisher it cannot report "no completion" for a state that has one --
    # the recognizer guarantees one exists.
    CLOSERS = ')}"],:'
    OPENERS = '({['

    def _rank(self, text):
        """Order candidates by how much closer they bring the turn to whole.

        Three things the search gets wrong without this, each seen:

          * a token that CONTINUES the lexeme under the cursor (`4` after
            `first 904.11`) makes no progress, and a shortest-first order
            is nothing but those, so it counts digits forever;
          * a token that OPENS a bracket adds an obligation.  Every
            candidate costing the same, a stable sort kept `(` at the head
            of the beam and the search spent its whole depth on
            `( ( ( ( ( (` -- so an opener is the most expensive move;
          * a CLOSER discharges one, so it is the cheapest.
        """
        head = text.strip()[0]
        if head in self.CLOSERS:
            return 0
        if head in self.OPENERS:
            return 3
        return 1 if text.startswith(" ") else 2

    def _candidates(self, matcher, width):
        fill_next_token_bitmask(matcher, self._bitmask, 0)
        bits = np.unpackbits(
            self._bitmask.numpy().view(np.uint8), bitorder="little")
        allowed = np.nonzero(bits[:self.vocab])[0]
        scored = []
        for index in allowed:
            text = self.texts.get(int(index))
            if text is None or not text.strip():
                continue
            scored.append((self._rank(text), len(text), int(index)))
        scored.sort()
        return [index for _r, _l, index in scored[:width]]

    # `depth` is in TOKENS and has to be generous: a generation that spent
    # its budget opening brackets (`notes of ( ( ( ( ...`, 44 of them) needs
    # one closer per bracket, and a short bound reports "no completion" for
    # a state whose completion is 44 characters of `)`.
    # Widths to try in order.  The narrow beam closes almost everything in
    # ~0.2 s; a generation stranded deep inside a quoted literal needs the
    # wide one, which is why the escalation exists rather than one setting.
    # A wide beam over a deep search is unbounded work -- 64 parents x 40
    # candidates x 192 levels is half a million mask computations, and one
    # generation sat in it for minutes.  Each rung gets a wall-clock budget
    # and gives up; giving up is REPORTED as no completion, never papered
    # over with something that merely parses.
    LADDER = ((6, 4, 10.0), (16, 32, 20.0), (40, 64, 30.0))

    def complete(self, ids, depth=192):
        for width, beam, budget in self.LADDER:
            tail = self._complete(ids, depth, width, beam, budget)
            if tail is not None:
                return tail
        return None

    def _complete(self, ids, depth=192, width=6, beam=4, budget=10.0):
        """Token ids that turn `ids` into a whole turn, or None.

        The recognizer guarantees a completion EXISTS from any state it
        admitted; this searches for a short one.  A `None` here is this
        search giving up, not the grammar saying there is no way out, and
        it is reported as such rather than counted as a parse.
        """
        self.mask_for(ids)
        if self.matcher.is_accepting():
            return []
        frontier = [(0, self.matcher.deep_copy(), [])]
        deadline = time.perf_counter() + budget
        for _step in range(depth):
            if time.perf_counter() > deadline:
                return None
            nxt = []
            for cost, matcher, path in frontier:
                for index in self._candidates(matcher, width):
                    child = matcher.deep_copy()
                    if not child.consume_token(index):
                        continue
                    if child.is_accepting():
                        return path + [index]
                    nxt.append((cost + self._rank(self.texts[index]),
                                child, path + [index]))
            if not nxt:
                return None
            nxt.sort(key=lambda row: row[0])
            frontier = nxt[:beam]
        return None


class LLGLogitsProcessor(LogitsProcessor):
    """Applies the grammar mask to the logits of a greedy/beam-1 decode."""

    def __init__(self, constraint: LLGConstraint):
        self.constraint = constraint
        # A piece that decodes to whitespace only settles nothing; the
        # grammar takes any number of them in a row, so an opinionless model
        # spends its whole budget on spaces (Lane E's first defect, in the
        # new grammar's terms).  Only the REPEAT is blocked -- every wordy
        # lexeme needs its one separator, and 31 golds open with one.
        self.blank = np.zeros(constraint.vocab, dtype=bool)
        for index, text in constraint.texts.items():
            if not text.strip():
                self.blank[index] = True

    def __call__(self, input_ids, scores):
        ids = self.constraint.strip(input_ids[0].tolist())
        mask = self.constraint.mask_for(ids)
        bits = np.unpackbits(mask.numpy().view(np.uint8),
                             bitorder="little")[:self.constraint.vocab]
        allow = bits.astype(bool)
        if ids and self.blank[ids[-1]]:
            allow = allow & ~self.blank
            if not allow.any():                 # never strand the decode
                allow = bits.astype(bool)
        allow = torch.from_numpy(allow[:scores.shape[-1]].copy())
        return scores.masked_fill(~allow.unsqueeze(0), float("-inf"))


UNPARSED = "Unparsed"


def generate_one(tok, model, text, constraint=None, max_new_tokens=48,
                 num_beams=1, close_out=True):
    """One constrained greedy decode.  Returns (final, emitted, finished)."""
    constraint = constraint or LLGConstraint(tok)
    constraint.reset()
    batch = tok(text, return_tensors="pt")
    out = model.generate(
        **batch, num_beams=num_beams, max_new_tokens=max_new_tokens,
        do_sample=False,
        logits_processor=LogitsProcessorList([LLGLogitsProcessor(constraint)]))
    ids = constraint.strip(out[0].tolist())
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
