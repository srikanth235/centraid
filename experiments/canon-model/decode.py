"""Ways to make a seq2seq model emit only legal canonicals.

  * `generate_canonicals` -- THE ENTRY POINT.  model + tokenizer + inputs,
    a list of strings back.  Grammar-constrained greedy decoding through
    the COMPILED mask (`llg_mask`, an llguidance Earley recognizer over
    `canon_lark`).  Every admitted prefix is completable, so what comes
    back parses; measured in MASK.md.
  * `nbest_valid`      -- beam search, then filter the N-best by the parser.
    Cheap to build, but the guarantee is only "if any beam parses".
  * `constrained_generate` -- the same as `generate_canonicals` for one
    input.  `engine="legacy"` selects the OLD mask below instead.

  * `GrammarConstraint` -- THE OLD MASK, kept for comparison only.  A
    `prefix_allowed_tokens_fn` built from `canon_grammar`'s character
    automaton, which calls back into `check.Parser` once per candidate
    character per step.

    ITS GUARANTEE IS NOT TOTAL, and the docstring used to claim it was.
    `canon_grammar.viable` is conservative, so that mask is a SUPERSET of
    the legal prefixes and admits heads that no legal turn extends.
    Measured: a randomly initialised model under it parses 61 of 200 times
    (VERIFY.md).  The compiled mask replaces it; MASK.md has both numbers.

T5's SentencePiece vocabulary has no `{`, `}`, `<` or `\\`, all of which the
canonical grammar needs, so `load_model` adds them and resizes the
embeddings.  ANY TRAINING RUN MUST USE THE SAME LOADER -- a model trained
without them can only spell a `Cmd` as `<unk>`.
"""

from __future__ import annotations

import argparse
import functools
import json
import random
import time

import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

import canon_grammar as G

MISSING_CHARS = ["{", "}", "<", "\\", "~", "^", "`"]


def load_model(name: str, model_cls=AutoModelForSeq2SeqLM):
    tok = AutoTokenizer.from_pretrained(name)
    added = [c for c in MISSING_CHARS
             if tok.unk_token_id in tok(c, add_special_tokens=False).input_ids]
    if added:
        tok.add_tokens(added)
    model = model_cls.from_pretrained(name)
    if added:
        model.resize_token_embeddings(len(tok))
    model.eval()
    return tok, model, added


# ---------------------------------------------------------------------------
# Vocabulary trie over the DECODED text of each piece
# ---------------------------------------------------------------------------

STR_KEY = "#str"


def piece_text(piece: str) -> str:
    return piece.replace("▁", " ")


def string_safe(text: str) -> bool:
    """No character that could END or escape inside a quoted literal."""
    return not ('"' in text or "\\" in text or "\n" in text)


@functools.lru_cache(maxsize=8)
def vocab_index(tok):
    specials = set(tok.all_special_ids)
    pieces = tok.convert_ids_to_tokens(list(range(len(tok))))
    root: dict = {}
    texts = {}
    safe_ids = []
    quote_ids = []
    for index, piece in enumerate(pieces):
        if index in specials or piece is None:
            continue
        text = piece_text(piece)
        if not text or "▁" in text or "<extra_id_" in piece:
            continue
        texts[index] = text
        node = root
        for position, char in enumerate(text):
            # Every id whose REMAINING text is free of quotes and escapes is
            # recorded here, so a walk that has just opened a literal can
            # take the whole subtree in one go instead of exploring it.
            if string_safe(text[position:]):
                node.setdefault(STR_KEY, []).append(index)
            node = node.setdefault(char, {})
        node.setdefault(STR_KEY, []).append(index)
        node.setdefault(None, []).append(index)
        if '"' in text or "\\" in text:
            quote_ids.append(index)
        elif "\n" not in text:
            safe_ids.append(index)
    return root, texts, safe_ids, quote_ids


class GrammarConstraint:
    """`prefix_allowed_tokens_fn` for HF `generate`."""

    # Settle boundaries up to this many terminals deep would be checked
    # EXACTLY (`canon_grammar.shortest_completion`), because `viable` is
    # conservative and admits heads that no legal turn extends.  MEASURED AND
    # TURNED OFF: at 3 it did not finish 25 generations in eight minutes,
    # against 97 s for all 200 without it.  Raise it only behind a cheaper
    # completability oracle.  See VERIFY.md.
    LOOKAHEAD = 0

    def __init__(self, tok):
        self.tok = tok
        self.root, self.texts, self.string_safe, self.quote_ids = vocab_index(tok)
        self.eos = tok.eos_token_id
        self.states = {(): G.START}
        self.blocked = 0
        # Pieces that decode to whitespace only (`▁`).  Taking one while the
        # current terminal is EMPTY settles nothing and advances nothing, so
        # the automaton returns the same state: an unmasked model will sit on
        # it until `max_new_tokens` runs out and emit nothing at all.  Legal
        # spellings never need it there -- a separator is only meaningful
        # after a partial terminal -- so it is excluded in that case.
        self.blank_ids = frozenset(i for i, t in self.texts.items()
                                   if not t.strip())

    # -- the automaton, cached along the beam's own history ------------------
    def state_for(self, ids: tuple):
        known = self.states.get(ids)
        if known is not None:
            return known
        if not ids:
            return G.START
        parent = self.state_for(ids[:-1])
        if parent is None:
            self.states[ids] = None
            return None
        text = self.texts.get(ids[-1])
        state = parent if text is None else G.step_text(parent, text)
        self.states[ids] = state
        return state

    def text_for(self, ids: tuple) -> str:
        return "".join(self.texts.get(i, "") for i in ids).strip()

    def _walk(self, node, state, out, memo):
        key = (id(node), state)
        if key in memo:
            return
        memo.add(key)
        for char, child in node.items():
            if char is None:
                out.extend(child)
                continue
            if char == STR_KEY:
                continue
            nxt = G.step_char(state, char)
            if nxt is None:
                continue
            if (len(nxt[0]) > len(state[0])
                    and len(nxt[0]) <= self.LOOKAHEAD
                    and not self.completable(nxt)):
                continue
            if G.string_is_open(nxt[1]):
                # Free text: every string-safe id below here is legal.
                out.extend(child.get(STR_KEY, ()))
                for quote in ('"', "\\"):
                    deeper = child.get(quote)
                    if deeper is not None:
                        after = G.step_char(nxt, quote)
                        if after is not None:
                            self._walk(deeper, after, out, memo)
                continue
            self._walk(child, nxt, out, memo)

    # Beyond `LOOKAHEAD` the mask is a SUPERSET of the legal prefixes -- an
    # unbounded check is the correct fix and costs a completion search per
    # new head, tens of seconds each.  See VERIFY.md.
    @staticmethod
    @functools.lru_cache(maxsize=200_000)
    def completable(state) -> bool:
        return G.shortest_completion(state) is not None

    def allowed(self, ids: tuple):
        state = self.state_for(ids)
        if state is None:                       # cannot happen under the mask
            self.blocked += 1
            return [self.eos]
        out = []
        if G.string_is_open(state[1]):          # free text: fast path
            out.extend(self.string_safe)
            for index in self.quote_ids:
                if G.step_text(state, self.texts[index]) is not None:
                    out.append(index)
        else:
            self._walk(self.root, state, out, set())
            if not state[1] and ids and ids[-1] in self.blank_ids:
                # A blank piece settles nothing when the current terminal is
                # empty, so two in a row advance nothing at all and the model
                # will sit there until `max_new_tokens` runs out.  Only the
                # REPEAT is blocked: 31 of the 434 gold canonicals -- every
                # one that opens with a `Cmd` -- are spelled with a leading
                # blank piece, so blocking the first would block gold.
                out = [i for i in out if i not in self.blank_ids]
        if G.complete(self.text_for(ids)):
            out.append(self.eos)
        if not out:
            self.blocked += 1
            out = [self.eos]
        return out

    def __call__(self, batch_id, input_ids):
        ids = tuple(int(i) for i in input_ids.tolist())
        while ids and ids[0] in (self.tok.pad_token_id, self.eos):
            ids = ids[1:]                       # decoder_start_token
        return self.allowed(ids)


# ---------------------------------------------------------------------------
# The two decoders
# ---------------------------------------------------------------------------

UNPARSED = "Unparsed"


def nbest_valid(tok, model, text, num_beams=8, max_new_tokens=48):
    """Beam search, then the parser picks the first beam that is legal."""
    batch = tok(text, return_tensors="pt")
    out = model.generate(**batch, num_beams=num_beams,
                         num_return_sequences=num_beams,
                         max_new_tokens=max_new_tokens, do_sample=False)
    for row in tok.batch_decode(out, skip_special_tokens=True):
        row = row.strip()
        if G.complete(row):
            return row
    return UNPARSED


def generate_canonicals(model, tok, inputs, max_new_tokens=48,
                        constraint=None, progress=None):
    """THE DROP-IN.  Constrained greedy decode of every input.

    This is the interface a training run scores its checkpoints through:
    hand it a model, its tokenizer and the input strings, get one canonical
    per input back.  `UNPARSED` appears only when the decode ran out of
    budget in a state the close-out search could not finish -- it is never
    silently replaced with something that parses.

    Swapping the mask underneath (old -> compiled) changes nothing here, so
    checkpoints trained before the swap re-score without a code change.
    """
    import llg_mask                                # local: optional at import
    constraint = constraint or llg_mask.LLGConstraint(tok)
    out = []
    for index, text in enumerate(inputs):
        final, _emitted, _closed = llg_mask.generate_one(
            tok, model, text, constraint=constraint,
            max_new_tokens=max_new_tokens)
        out.append(final)
        if progress is not None:
            progress(index + 1, len(inputs))
    return out


def constrained_generate(tok, model, text, num_beams=1, max_new_tokens=48,
                         constraint=None, engine="compiled"):
    """Grammar-constrained decoding: every step is masked to legal tokens."""
    # A caller that hands over an OLD-mask constraint means the old mask:
    # `verify_all.py` is Lane E's harness for it and must keep running, so
    # the two numbers in MASK.md stay comparable.
    if isinstance(constraint, GrammarConstraint):
        engine = "legacy"
    if engine == "compiled":
        import llg_mask
        final, _emitted, _closed = llg_mask.generate_one(
            tok, model, text, constraint=constraint,
            max_new_tokens=max_new_tokens, num_beams=num_beams)
        return final
    constraint = constraint or GrammarConstraint(tok)
    batch = tok(text, return_tensors="pt")
    out = model.generate(**batch, num_beams=num_beams,
                         max_new_tokens=max_new_tokens, do_sample=False,
                         prefix_allowed_tokens_fn=constraint)
    ids = tuple(int(i) for i in out[0].tolist())
    while ids and ids[0] in (tok.pad_token_id, tok.eos_token_id):
        ids = ids[1:]
    ids = tuple(i for i in ids if i not in (tok.pad_token_id, tok.eos_token_id))
    row = constraint.text_for(ids)
    if G.complete(row):
        return row
    # Ran out of budget mid-string: finish it along the shortest legal path.
    state = constraint.state_for(ids)
    tail = G.shortest_completion(state) if state is not None else None
    if tail is not None and G.complete(row + tail):
        return row + tail
    return UNPARSED


# ---------------------------------------------------------------------------
# Verification (task 4)
# ---------------------------------------------------------------------------

def gold_canonicals():
    rows = json.load(open(G.GRAMMAR_DIR + "/map.json"))["turns"]
    return [r["canonical"] for r in rows if r["covered"]]


def verify_gold(tok, sample=200, seed=0):
    """Teacher-forced: the constraint must never block a GOLD next token."""
    constraint = GrammarConstraint(tok)
    golds = gold_canonicals()
    random.Random(seed).shuffle(golds)
    golds = golds[:sample]
    blocks, checked, unreachable = [], 0, []
    for gold in golds:
        ids = tok(gold, add_special_tokens=False).input_ids
        if tok.unk_token_id in ids:
            unreachable.append(gold)
            continue
        if not G.same_meaning(tok.decode(ids, skip_special_tokens=True), gold):
            unreachable.append(gold)
            continue
        prefix = ()
        for step in ids:
            allowed = set(constraint.allowed(prefix))
            checked += 1
            if step not in allowed:
                blocks.append((gold, len(prefix), tok.convert_ids_to_tokens(step)))
                break
            prefix = prefix + (step,)
        else:
            if constraint.eos not in set(constraint.allowed(prefix)):
                blocks.append((gold, len(prefix), "</s>"))
    return {"canonicals": len(golds), "token_steps": checked,
            "blocked": blocks, "not_tokenizable": unreachable}


def verify_finisher(sample=200, seed=0):
    """Every gold PREFIX must have a shortest legal completion."""
    golds = gold_canonicals()
    random.Random(seed).shuffle(golds)
    stuck, tried = [], 0
    for gold in golds[:sample]:
        for cut in range(1, len(gold), 7):
            state = G.step_text(G.START, gold[:cut])
            if state is None:
                stuck.append((gold, cut, "not viable"))
                break
            tried += 1
            tail = G.shortest_completion(state)
            if tail is None or not G.complete(gold[:cut] + tail):
                stuck.append((gold, cut, repr(tail)))
                break
    return tried, stuck


def verify_random_model(tok, model, inputs, max_new_tokens=48):
    """A RANDOMLY INITIALISED model under the constraint must still parse."""
    constraint = GrammarConstraint(tok)
    ok, rows = 0, []
    for text in inputs:
        out = constrained_generate(tok, model, text, max_new_tokens=max_new_tokens,
                                   constraint=constraint)
        rows.append(out)
        if out != UNPARSED:
            ok += 1
    return ok, rows


SYNTHETIC = [
    "what am I doing this weekend",
    "show me the photos from Tahoe",
    "how much do I owe Neha",
    "push the cabin booking to friday",
    "which tasks are overdue",
    "who have I not spoken to in a while",
    "add a note about the Emerald Bay hike",
    "star that document",
    "what did I spend on food last month",
    "any birthdays this month",
]


def synthetic_inputs(count):
    return [SYNTHETIC[i % len(SYNTHETIC)] + (" " + "again" * (i // len(SYNTHETIC)))
            for i in range(count)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="google/flan-t5-small")
    ap.add_argument("--sample", type=int, default=200)
    ap.add_argument("--random-init", type=int, default=20)
    args = ap.parse_args()

    tok, model, added = load_model(args.model)
    print("model %s  added tokens %s  vocab %d" % (args.model, added, len(tok)))

    started = time.perf_counter()
    report = verify_gold(tok, sample=args.sample)
    print("gold prefixes : %d canonicals, %d token steps, %d blocked, "
          "%d not tokenizable (%.1fs)"
          % (report["canonicals"], report["token_steps"], len(report["blocked"]),
             len(report["not_tokenizable"]), time.perf_counter() - started))
    for row in report["blocked"][:10]:
        print("   BLOCKED %r at step %d on %r" % row)
    for row in report["not_tokenizable"][:5]:
        print("   NOT TOKENIZABLE %r" % row)

    started = time.perf_counter()
    tried, stuck = verify_finisher(sample=min(args.sample, 60))
    print("finisher      : %d gold prefixes, %d without a completion (%.1fs)"
          % (tried, len(stuck), time.perf_counter() - started))
    for row in stuck[:5]:
        print("   STUCK %r" % (row,))

    from transformers import AutoConfig, T5ForConditionalGeneration
    config = AutoConfig.from_pretrained(args.model)
    rand = T5ForConditionalGeneration(config)
    rand.resize_token_embeddings(len(tok))
    rand.eval()
    inputs = synthetic_inputs(args.random_init)
    started = time.perf_counter()
    ok, rows = verify_random_model(tok, rand, inputs)
    print("random init   : %d/%d parseable (%.1fs)"
          % (ok, len(inputs), time.perf_counter() - started))
    for row in rows[:3]:
        print("   %r" % row)

    started = time.perf_counter()
    for text in inputs[:10]:
        nbest_valid(tok, model, text)
    nbest = (time.perf_counter() - started) / 10
    constraint = GrammarConstraint(tok)
    started = time.perf_counter()
    for text in inputs[:10]:
        constrained_generate(tok, model, text, constraint=constraint)
    cons = (time.perf_counter() - started) / 10
    print("latency       : n-best(beam 8) %.3f s/turn   constrained(greedy) "
          "%.3f s/turn" % (nbest, cons))


if __name__ == "__main__":
    main()
