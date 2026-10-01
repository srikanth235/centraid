"""Decoding for one assistant step: constrained (hard / soft) or free (SPEC §6.6, §9).

The grammar is the runtime's exported `call.lark` (`nativetools export`), specialised per step:

- a free `<think>` block, then exactly one call: `start: THINK </think> "\\n\\n" <tool_call> "\\n"
  call </tool_call>`. Qwen's `</think>`, `<tool_call>`, `</tool_call>` are single added tokens
  that llguidance treats as special, so they are referenced by id; as quoted strings the grammar
  would force them spelled out byte by byte, a tokenization the model never trained on.
- `HANDLE` / `ROW` / `RESULT` are narrowed to the `#n` shown and not compacted and the `@n`
  issued, derived from the conversation (`fmt.addressable`); when a set is empty, every
  alternative that needs it is pruned (a parameter the model could open but never close would
  be a dead end, not a constraint).
- Three repairs of the exported grammar, each asserted against its exact exported form so a
  runtime change fails loudly (they belong upstream in the export): free text followed by
  `\n</parameter>` is folded into one terminal (llguidance lexes greedily and cannot split
  `Benedikt\n</parameter>`); the date schema's keys follow the generator's order, not serde's
  alphabetical one (llguidance's %json fixes key order); list separators accept `#1,#2` and
  `task, event` as the runtime does.

Usage: `python decode.py check <data.jsonl.gz> --lark call.lark [--tools tools.json]` reports
grammar acceptance of every assistant message in a data file.

Modes: `hard` applies the mask at every token; `soft` applies it unless the model's own greedy
token is outside the mask AND the best allowed token has probability < --soft-threshold — then
the rest of the message is decoded free (the runtime's error explains the mistake; counted as
`override`); `free` never masks. All modes share the think guard (after `think_limit` think
tokens `</think>` is forced, counted as `think_cut`) and the stop after the first
`</tool_call>`. Greedy by default.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

import torch

import fmt

# llguidance's %json emits object keys in the schema's `properties` order, and the exported
# schema lists them alphabetically (serde's map order), so `{"unit":"week","rel":1}` — the order
# the generator writes (data/policy.py canon_expr, SPEC §4.4) — would be rejected. The date
# grammar's properties are re-ordered to the generator's canonical order.
DATE_KEY_ORDER = ("from", "to", "date", "unit", "name", "rel", "weekday", "time", "anchor")


def order_date_keys(lark: str) -> str:
    def fix(node):
        if isinstance(node, dict):
            node = {k: fix(v) for k, v in node.items()}
            if isinstance(node.get("properties"), dict):
                props = node["properties"]
                rank = {k: i for i, k in enumerate(DATE_KEY_ORDER)}
                node["properties"] = {k: props[k] for k in sorted(props, key=lambda k: (rank.get(k, 99), k))}
            return node
        if isinstance(node, list):
            return [fix(v) for v in node]
        return node

    out = []
    for line in lark.splitlines():
        head, sep, body = line.partition("%json ")
        if sep:
            line = head + sep + json.dumps(fix(json.loads(body)), separators=(",", ":"), ensure_ascii=False)
        out.append(line)
    return "\n".join(out) + "\n"


TEXT_MAX, ARGS_MAX = 200, 400


class Grammar:
    """The exported call grammar, specialised per step to the addressable handles."""

    def __init__(self, lark_path: str | Path, tok):
        src = Path(lark_path).read_text()
        ids = {t: tok.convert_tokens_to_ids(t) for t in ("</think>", "<tool_call>", "</tool_call>")}
        head = 'start: "<tool_call>\\n" call "</tool_call>"'
        if head not in src:
            raise ValueError("call.lark changed shape: no %r" % head)
        start = ('start: think <[%d]> "\\n\\n" <[%d]> "\\n" call <[%d]>\nthink: THINK\nTHINK: /(.|\\n)*/'
                 % (ids["</think>"], ids["<tool_call>"], ids["</tool_call>"]))
        # A free-text terminal followed by the literal "\n</parameter>\n" cannot be lexed: the
        # text may itself contain "\n", llguidance lexes greedily and never backs off, so
        # `Benedikt\n</parameter>` dies at "<". Folding the closing tag into the terminal (the
        # text cannot contain "<", so the first "<" starts the tag) makes it unambiguous.
        close = ' "\\n</parameter>\\n"'
        # Bounded (TEXT_MAX / ARGS_MAX chars) so a rambling value cannot run a constrained
        # message past max_new_tokens unclosed; real names, questions and args are far shorter.
        for name, rx in (("TEXT", r"/[^<\n][^<]{0,%d}\n<\/parameter>\n/" % TEXT_MAX),
                         ("ARGS", r"/[^<]{1,%d}\n<\/parameter>\n/" % ARGS_MAX)):
            if name + close not in src:
                raise ValueError("call.lark changed shape: no %s%s" % (name, close))
            src = src.replace(name + close, " %s_P" % name) + "\n%s_P: %s\n" % (name, rx)
        # List separators: the runtime reads "#1,#2" and "task, event" as well as the exported
        # forms ("#1, #2", "task,event"); the eval gold writes the former. Accept both spellings.
        for rule, relaxed in (('handles: HANDLE (", " HANDLE)*', 'handles: HANDLE ("," " "? HANDLE)*'),
                              ('kinds: kind ("," kind)*', 'kinds: kind ("," " "? kind)*')):
            if rule not in src:
                raise ValueError("call.lark changed shape: no %r" % rule)
            src = src.replace(rule, relaxed)
        self.src = order_date_keys(src.replace(head, start))
        for name in ("HANDLE", "ROW", "RESULT"):
            if not re.search(r"^%s: " % name, self.src, re.M):
                raise ValueError("call.lark has no %s terminal" % name)

    @staticmethod
    def _alts(values):
        return " | ".join('"%s"' % v for v in values)

    def specialise(self, rows, results, restrict=True) -> str:
        g = self.src
        if not restrict:
            return g
        hs = ["#%d" % n for n in rows] + ["@%d" % n for n in results]
        empty = set()
        for name, vals in (("HANDLE", hs), ("ROW", ["#%d" % n for n in rows]),
                           ("RESULT", ["@%d" % n for n in results])):
            if vals:
                line = "%s: %s" % (name, self._alts(vals))
                g = re.sub(r"^%s: .*$" % name, lambda _m, line=line: line, g, flags=re.M)
            else:
                empty.add(name)
        return prune(g, empty) if empty else g


def prune(lark: str, empty: set[str]) -> str:
    """Remove every alternative that needs a symbol with no possible value (e.g. `value=@n`
    before any @n was issued). A terminal that matches nothing is not enough: llguidance would
    still let the model open `<parameter=value>\\n` and then find no continuation. Rules left
    with no alternative become empty in turn; `(rule)*` of an empty rule is dropped."""
    rules, order = {}, []  # name -> [alternative text]; the rest of the grammar kept verbatim
    other, cur = [], None
    for line in lark.splitlines():
        m = re.match(r"^([a-z_][a-z_0-9]*|[A-Z_][A-Z_0-9]*): (.*)$", line)
        if m and not line.startswith(("//",)) and "%json" not in line:
            cur = m.group(1)
            rules[cur] = [m.group(2)]
            order.append(("rule", cur))
        elif cur and re.match(r"^\s+\| ", line):
            rules[cur].append(re.sub(r"^\s+\| ", "", line))
        else:
            cur = None
            order.append(("line", line))
    changed = True
    while changed:
        changed = False
        for name, alts in rules.items():
            if name in empty:
                continue
            keep = []
            for alt in alts:
                for e in empty:
                    alt = alt.replace("(%s)*" % e, "")
                if any(re.search(r"(?<![\w\"])%s(?![\w\"])" % re.escape(e), alt) for e in empty):
                    continue
                keep.append(alt)
            if keep != alts:
                rules[name] = keep
                changed = True
            if not keep:
                empty.add(name)
                changed = True
    out = []
    for kind, x in order:
        if kind == "line":
            out.append(x)
        elif x not in empty:
            alts = rules[x]
            out.append("%s: %s" % (x, alts[0]))
            out += ["    | " + a for a in alts[1:]]
    return "\n".join(out) + "\n"


class Decoder:
    def __init__(self, model, tok, lark_path, think_limit=200, soft_threshold=0.05,
                 max_new_tokens=512, restrict_handles=True):
        import llguidance
        import llguidance.hf
        self.llg = llguidance
        self.model, self.tok = model, tok
        self.im_end = tok.convert_tokens_to_ids("<|im_end|>")
        self.think_end = tok.convert_tokens_to_ids("</think>")
        self.call_end = tok.convert_tokens_to_ids("</tool_call>")
        self.lltok = llguidance.hf.from_tokenizer(tok, eos_token=self.im_end)
        self.grammar = Grammar(lark_path, tok)
        self.think_limit = think_limit
        self.soft_threshold = soft_threshold
        self.max_new_tokens = max_new_tokens
        self.restrict = restrict_handles
        self.vocab = model.get_output_embeddings().weight.shape[0]

    def matcher(self, rows, results):
        g = self.grammar.specialise(rows, results, self.restrict)
        m = self.llg.LLMatcher(self.lltok, self.llg.LLMatcher.grammar_from_lark(g), log_level=0)
        if m.is_error():
            raise ValueError("grammar error: " + m.get_error())
        return m

    def mask_of(self, m) -> torch.Tensor:
        bits = torch.frombuffer(bytearray(m.compute_bitmask()), dtype=torch.uint8)
        allowed = ((bits.unsqueeze(1) >> torch.arange(8, dtype=torch.uint8)) & 1).flatten().bool()
        out = torch.zeros(self.vocab, dtype=torch.bool)
        n = min(self.vocab, allowed.numel())
        out[:n] = allowed[:n]
        return out

    def step(self, msgs, mode="hard", sample=False, seed=0):
        """One assistant message for render.py records (the shared renderer builds the prompt)."""
        prompt = fmt.render.render_prompt_for_generation(msgs)
        return self.generate(prompt, *fmt.addressable(msgs), mode=mode, sample=sample, seed=seed)

    def complete(self, prompt, mode="hard", sample=False, seed=0):
        """One assistant message for an already rendered prompt (ending `<|im_start|>assistant\\n`,
        with or without the `<think>\\n` the template's generation prompt adds)."""
        if prompt.endswith("<|im_start|>assistant\n"):
            prompt += "<think>\n"
        return self.generate(prompt, *fmt.addressable_in_prompt(prompt), mode=mode, sample=sample, seed=seed)

    @torch.no_grad()
    def generate(self, prompt, rows, results, mode="hard", sample=False, seed=0):
        """Greedy (or sampled) HF `generate` under the step's processor. Returns (text, info);
        text is the whole assistant message and starts with `<think>\\n`."""
        from transformers import LogitsProcessorList
        assert mode in ("hard", "soft", "free")
        assert prompt.endswith("<|im_start|>assistant\n<think>\n"), prompt[-60:]
        dev = next(self.model.parameters()).device
        ids = torch.tensor([self.tok(prompt, add_special_tokens=False)["input_ids"]], device=dev)
        proc = _Step(self, self.matcher(rows, results) if mode != "free" else None, mode, ids.shape[1])
        kw = dict(do_sample=True, temperature=0.6, top_p=0.95, top_k=0) if sample else dict(do_sample=False)
        if sample:
            torch.manual_seed(seed)
        t0 = time.time()
        gen = self.model.generate(input_ids=ids, attention_mask=torch.ones_like(ids),
                                  max_new_tokens=self.max_new_tokens, logits_processor=LogitsProcessorList([proc]),
                                  eos_token_id=self.im_end, pad_token_id=self.im_end, **kw)
        out = gen[0, ids.shape[1]:].tolist()
        info = dict(proc.info, prompt_tokens=ids.shape[1], new_tokens=len(out), think_tokens=proc.n_think,
                    seconds=time.time() - t0, stopped=bool(out and out[-1] == self.im_end))
        body = self.tok.decode([t for t in out if t != self.im_end], skip_special_tokens=False)
        return "<think>\n" + body, info


class _Step:
    """HF logits processor: think guard, then the llguidance mask (hard) or its soft variant."""

    def __init__(self, dec: Decoder, matcher, mode: str, prompt_len: int):
        self.d, self.m, self.mode, self.prompt_len = dec, matcher, mode, prompt_len
        self.constrained = matcher is not None
        self.seen, self.in_think, self.n_think = 0, True, 0
        self.info = {"mode": mode, "think_cut": False, "override": False, "grammar_error": None}

    def __call__(self, input_ids, scores):
        assert input_ids.shape[0] == 1, "one sequence per step"
        new = input_ids[0, self.prompt_len:].tolist()
        for t in new[self.seen:]:
            if self.constrained and not self.m.consume_token(t):
                self.info["grammar_error"] = self.m.get_error()
                self.constrained = False
            if self.in_think:
                if t == self.d.think_end:
                    self.in_think = False
                else:
                    self.n_think += 1
        self.seen = len(new)
        row = scores[0]
        if new and new[-1] == self.d.call_end:
            # one call per message: after `</tool_call>` only `<|im_end|>` (the eval driver cuts
            # there anyway; free decoding would otherwise run on to max_new_tokens)
            row.fill_(float("-inf"))
            row[self.d.im_end] = 0.0
            return scores
        if self.in_think and self.n_think >= self.d.think_limit:
            self.info["think_cut"] = True
            keep = row[self.d.think_end].clone()
            row.fill_(float("-inf"))
            row[self.d.think_end] = keep if torch.isfinite(keep) else 0.0
            return scores
        if not self.constrained:
            return scores
        allowed = self.d.mask_of(self.m).to(row.device)
        if self.mode == "soft":
            best = int(row.argmax())
            if not allowed[best]:
                pick = int(row.masked_fill(~allowed, float("-inf")).argmax())
                if torch.softmax(row.float(), -1)[pick].item() < self.d.soft_threshold:
                    self.constrained = False
                    self.info["override"] = True
                    self.info["override_at"] = len(new)
                    return scores
        row.masked_fill_(~allowed, float("-inf"))
        return scores


# ---- grammar acceptance of reference calls (step 6)

def accepts(lltok, llg, grammar_text: str, tok, text: str) -> tuple[bool, str]:
    m = llg.LLMatcher(lltok, llg.LLMatcher.grammar_from_lark(grammar_text), log_level=0)
    ids = tok(text, add_special_tokens=False)["input_ids"]
    for i, t in enumerate(ids):
        if not m.consume_token(t):
            return False, "rejected at %r after %r" % (tok.decode([t]), tok.decode(ids[max(0, i - 12):i]))
    if not m.is_accepting():
        return False, "incomplete"
    return True, ""


def check_data(path, lark, model="Qwen/Qwen3.5-0.8B", limit=0, show=5, tools=None):
    """Grammar acceptance over every assistant message of a data file: the exact generated span
    (think + call, as render.py writes it, without `<|im_end|>`) through the full grammar, with
    handles both unrestricted and restricted to what the session had made addressable then."""
    import collections
    import llguidance
    import llguidance.hf
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(model)
    lltok = llguidance.hf.from_tokenizer(tok, eos_token=tok.convert_tokens_to_ids("<|im_end|>"))
    gram = Grammar(lark, tok)
    free_g = gram.specialise([], [], restrict=False)
    default_tools = json.loads(Path(tools).read_text()) if tools else None
    n = ok_free = ok_restr = sessions = 0
    fails = collections.Counter()
    shown = 0
    for i, ex in enumerate(fmt.read_examples(path, partial_ok=True)):
        if limit and i >= limit:
            break
        sessions += 1
        enc = fmt.encode(tok, ex, default_tools)
        msgs = enc["records"]
        a_idx = [j for j, m in enumerate(msgs) if m["role"] == "assistant"]
        for j, (s, e) in zip(a_idx, enc["ranges"]):
            body = enc["text"][s:e - len(fmt.IM_END)]
            n += 1
            a, why = accepts(lltok, llguidance, free_g, tok, body)
            ok_free += a
            rows, results = fmt.addressable(msgs[:j])
            b, why2 = accepts(lltok, llguidance, gram.specialise(rows, results), tok, body)
            ok_restr += b
            if not (a and b):
                fails[("grammar" if not a else "handles") + ": " + (why if not a else why2)[:90]] += 1
                if shown < show:
                    shown += 1
                    print("--- example %d message %d (%s)\n%s\n%s" % (i, j, ex.get("id", ""), (why or why2),
                                                                      body[-400:]))
    print("sessions %d  steps %d  grammar-accepted %d (%.2f%%)  with handle restriction %d (%.2f%%)"
          % (sessions, n, ok_free, 100 * ok_free / max(n, 1), ok_restr, 100 * ok_restr / max(n, 1)))
    for k, v in fails.most_common(15):
        print("  %5d  %s" % (v, k))
    return n, ok_free, ok_restr


if __name__ == "__main__":
    import argparse
    import json
    ap = argparse.ArgumentParser(description="grammar acceptance of a data file's target steps")
    ap.add_argument("cmd", choices=["check"])
    ap.add_argument("data")
    ap.add_argument("--lark", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--model", default="Qwen/Qwen3.5-0.8B")
    ap.add_argument("--tools", help="tools JSON for examples whose system record carries none")
    a = ap.parse_args()
    check_data(a.data, a.lark, a.model, a.limit, tools=a.tools)
