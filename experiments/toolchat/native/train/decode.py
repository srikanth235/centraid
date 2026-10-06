"""Decoding for one assistant step: constrained (hard / soft) or free (SPEC §6.6, §9).

The grammar is the runtime's exported `call.lark` (`nativetools export`), specialised per step:

- the think, then exactly one call: `start: think </think> "\\n\\n" <tool_call> "\\n" call </tool_call>`.
  The think is the slot lines of the v4 trace (CONTRACT_V3.md section 8; `THINK4_LINES`): fewer slots, one-row
  pick, no `refer:` line. With NATIVE_TRACE=v3.1 it is the v3.1 trace (`THINK3_LINES`), with the `refer:` line
  demanded on the first step of a turn that has a previous result (`fmt.requires_refer`). Qwen's `</think>`,
  `<tool_call>`, `</tool_call>` are single added tokens that llguidance treats as special, so they are
  referenced by id; as quoted strings the grammar would force them spelled out byte by byte, a
  tokenization the model never trained on.
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
grammar acceptance of every assistant message in a data file, and that every call is the one its
think states.

Modes: `hard` applies the mask at every token; `soft` applies it unless the model's own greedy
token is outside the mask AND the best allowed token has probability < --soft-threshold — then
the rest of the message is decoded free (the runtime's error explains the mistake; counted as
`override`); `free` never masks. All modes share the think guard (after `think_limit` think
tokens `</think>` is forced, counted as `think_cut`) and the stop after the first
`</tool_call>`. Greedy by default.

Once the think is closed the call is not sampled: it is written by `fmt.call_of_think`, the very function the
data builder checks against every authored call, token by token (the grammar still reads every token). A think
that does not state a whole call leaves the call to the grammar (hard, soft) or to the model (free).
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

import torch

import fmt

# llguidance's %json emits object keys in the schema's `properties` order, and the exported
# schema lists them alphabetically (serde's map order), so `{"unit":"week","rel":1}`, the order
# the authored sessions write (SPEC §4.4), would be rejected. The date grammar's properties are
# re-ordered to the authored order. A month's `name` follows its `rel`, like every other key that
# qualifies a unit (`{"unit":"month","rel":0,"name":3}`, `{"unit":"week","rel":1,"weekday":5}`).
DATE_KEY_ORDER = ("from", "to", "date", "unit", "rel", "name", "weekday", "time", "anchor")

# The exported where grammar is stricter than the runtime. The runtime reads `status = "open"` as well as `status = open`
# (the exported form: bare after `=`/`!=`, quoted only inside `in (...)`), and `effort > 60 minutes` / `cadence >= 14 days` (a
# number field's own unit word) as well as `effort > 60`. The authored sessions write the quoted and the unit form (1,676
# quoted enum values against 87 bare ones), so the grammar takes both spellings.
_ENUM_EQ = re.compile(r'EQ " " \(("[^"]+"(?: \| "[^"]+")*)\)')
_NUMBER_UNIT = 'NUMBER (" " CURRENCY)?'


def relax_where(lark: str) -> str:
    """The exported where grammar plus the spellings the runtime reads: a quoted enum value after `=`/`!=`, and the unit word
    after a number (UNIT_WORD). Raises when the export has none of either (the grammar changed shape)."""
    lark, n_enum = _ENUM_EQ.subn(lambda m: 'EQ " " (%s | "\\"" (%s) "\\"")' % (m.group(1), m.group(1)), lark)
    n_num = lark.count(_NUMBER_UNIT)
    if not n_enum or not n_num:
        raise ValueError("call.lark changed shape: no enum comparison / number condition to relax")
    lark = lark.replace(_NUMBER_UNIT, 'NUMBER (" " (CURRENCY | UNIT_WORD))?')
    return lark + '\nUNIT_WORD: "min" | "mins" | "minute" | "minutes" | "day" | "days"\n'


def order_date_keys(lark: str, key_order=DATE_KEY_ORDER) -> str:
    def fix(node):
        if isinstance(node, dict):
            node = {k: fix(v) for k, v in node.items()}
            if isinstance(node.get("properties"), dict):
                props = node["properties"]
                rank = {k: i for i, k in enumerate(key_order)}
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

# ---- the think (authored/trace.py, CONTRACT_V3.md): one line per slot, in the trace's fixed order. A line is a
# regex terminal that ends in its newline; the think is the optional lines in order, the intent line mandatory. The
# refer rule makes the `refer:` line mandatory too, on the first step of a turn with a previous result (fmt.requires_refer). A raw slot (`kind: task`, `where: ...`) takes
# the rest of its line: the call grammar below checks what a value may be, and the compiled call is rendered, not typed.
# Bounded, so a rambling value cannot run the think into `think_limit` (the forced `</think>` would not be legal mid-line):
# the longest quote of the train data is 57 characters, the longest raw line 158.
_Q = r'"[^"\n]{0,120}"'
_RAW = r"[^\n]{1,300}\n"
_PICK = r"#[0-9]+ (?:ok|no \((?:kind|name|position|date|status|other)\))"
# v3.1 (CONTRACT_V3.md section 7): `where` is typed segments, `when` is a quote with the date as `dates[i]` (the entry of the
# prompt's dates line, its reading when it gives two) or in the compact form, `retry:` names the slot the runtime refused.
_V = r'"[^"\n]{0,80}"'
_COND = (r"[a-z_]+ (?:count (?:=|!=|<=|>=|<|>) -?[0-9]{1,6}|is empty|is set|in \(%s(?:, %s){0,9}\)|contains %s"
         r"|(?:=|!=|<=|>=|<|>) (?:%s|-?[0-9]+(?:\.[0-9]+)?(?: [A-Za-z]{1,12})?|[A-Za-z_][A-Za-z0-9_]{0,40}))" % (_V, _V, _V, _V))
_DTOK = r"(?:(?:minute|hour|day|week|month|year)(?:[+-][0-9]{1,4})?|[+-][0-9]{1,4}|wd[0-9]|m[0-9]{1,2}|row|today|t|[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?)"
_DPT = r"%s(?: %s){0,5}" % (_DTOK, _DTOK)
_COMPACT = r"(?:(?:from|to) %s(?: (?:from|to) %s)?|%s)" % (_DPT, _DPT, _DPT)


def _dates_ref(n_dates: int | None) -> str:
    """`dates[i]` for the entries of the dates line (any index when unknown, none when the line is absent) and its reading."""
    if n_dates == 0:
        return ""
    idx = "[0-9]{1,2}" if n_dates is None else "(?:%s)" % "|".join(str(i) for i in range(n_dates))
    return r"dates\[%s\](?: past| upcoming)?|" % idx


THINK3_LINES = (
    ("RETRY", r"retry: (?:rejected|[a-z_]+(?:\[[0-9]{1,2}\])?)\n"),
    ("INTENT", r"intent: (?:read|count|write|ask|decline)(?: %s)?\n" % _Q),
    ("VIA", r"via: (?:find|search|open|compute)\n"),
    ("VERB", r"verb: [a-z_]+\n"),
    ("SCOPE", r"scope: (?:one|some|all)(?: %s)?\n" % _Q),
    ("REFER", r"refer: (?:none|(?:it|both|that|nth)(?: %s)? -> [#@][0-9]+(?:, [#@][0-9]+){0,11})\n" % _Q),
    ("TARGET", r"target: %s(?: · %s){0,5}\n" % (_Q, _Q)),
    ("KIND", r"kind: " + _RAW), ("OP", r"op: " + _RAW), ("FIELD", r"field: " + _RAW), ("GROUP", r"group: " + _RAW),
    ("TRASHED", r"trashed: " + _RAW), ("NAME", r"name: " + _RAW), ("TEXTL", r"text: " + _RAW), ("WHERE", r"where: %s(?: · %s){0,5}\n" % (_COND, _COND)),
    ("WHEN", r"when: (?:%s|now|earlier(?: %s)?)(?: = (?:@DATES@%s))?\n" % (_Q, _Q, _COMPACT)),
    ("LINKED", r"linked_to: " + _RAW), ("WITHIN", r"within: " + _RAW), ("EXCLUDE", r"exclude: " + _RAW),
    ("ORDER", r"order: " + _RAW), ("LIMIT", r"limit: " + _RAW), ("MORE", r"more: " + _RAW),
    ("SET", r"set: " + _RAW), ("TIME", r"time: " + _RAW),
    ("PICK", r"pick: %s(?: · %s){0,11}\n" % (_PICK, _PICK)),
    ("ROWS", r"rows: " + _RAW), ("ROW", r"row: " + _RAW), ("VALUE", r"value: " + _RAW), ("OPTIONS", r"options: " + _RAW),
    ("QUESTION", r"question: " + _RAW), ("REASON", r"reason: " + _RAW),
)


# v4 (CONTRACT_V3.md section 8): no SCOPE, REFER or TARGET line, `via` is search, open or compute (a lookup is the compile step's),
# and `pick` is one row with the reason it is the one, placed right after the verb with the rows slots. The refer rule is gone.
_PICK4 = r"#[0-9]+ \((?:name|kind|date|focus|created|asked|nick)\)"
_V3 = dict(THINK3_LINES)
THINK4_LINES = (
    ("RETRY", _V3["RETRY"]), ("INTENT", _V3["INTENT"]), ("VIA", r"via: (?:search|open|compute)\n"), ("VERB", _V3["VERB"]),
    ("PICK", r"pick: %s\n" % _PICK4), ("ROWS", _V3["ROWS"]), ("ROW", _V3["ROW"]),
    *((n, _V3[n]) for n in ("KIND", "OP", "FIELD", "GROUP", "TRASHED", "NAME", "TEXTL", "WHERE", "WHEN", "LINKED", "WITHIN", "EXCLUDE",
                            "ORDER", "LIMIT", "MORE", "SET", "TIME", "VALUE", "OPTIONS", "QUESTION", "REASON")),
)


def _think_rules(slot_lines, require_refer: bool, n_dates: int | None) -> str:
    parts = []
    for name, _rx in slot_lines:
        t = "T3_" + name
        parts.append(t if name == "INTENT" or (name == "REFER" and require_refer) else t + "?")
    lines = ["think: " + " ".join(parts)]
    for name, rx in slot_lines:
        lines.append("T3_%s: /%s/" % (name, rx.replace("@DATES@", _dates_ref(n_dates)).replace("/", "\\/")))
    return "\n".join(lines)


def think3_rules(require_refer: bool, n_dates: int | None = None) -> str:
    """The lark block of the think. Every line terminal is spelled `T3_<NAME>`; the rule `think` sequences them.
    `n_dates`: the entries of the prompt's dates line (a `dates[i]` names one of them), None when not known."""
    return _think_rules(THINK3_LINES, require_refer, n_dates)


def think4_rules(n_dates: int | None = None) -> str:
    """The lark block of a v4 think: the same terminals in the v4 order, the `refer:` line never demanded."""
    return _think_rules(THINK4_LINES, False, n_dates)


def think_rules(require_refer: bool, n_dates: int | None = None, trace: str | None = None) -> str:
    """The lark block of the think of the trace version in use (`trace`, default `fmt.trace_mode()`, NATIVE_TRACE)."""
    return think4_rules(n_dates) if (trace or fmt.trace_mode()) == "v4" else think3_rules(require_refer, n_dates)


class Grammar:
    """The exported call grammar, specialised per step to the addressable handles, with the think rules of the trace."""

    def __init__(self, lark_path: str | Path, tok):
        src = Path(lark_path).read_text()
        ids = {t: tok.convert_tokens_to_ids(t) for t in ("</think>", "<tool_call>", "</tool_call>")}
        head = 'start: "<tool_call>\\n" call "</tool_call>"'
        if head not in src:
            raise ValueError("call.lark changed shape: no %r" % head)
        start = ('start: think <[%d]> "\\n\\n" <[%d]> "\\n" call <[%d]>\n%s'
                 % (ids["</think>"], ids["<tool_call>"], ids["</tool_call>"], self.FREE_THINK))
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
        src = relax_where(src)
        self.src = order_date_keys(src.replace(head, start), DATE_KEY_ORDER)
        for name in ("HANDLE", "ROW", "RESULT"):
            if not re.search(r"^%s: " % name, self.src, re.M):
                raise ValueError("call.lark has no %s terminal" % name)

    @staticmethod
    def _alts(values):
        return " | ".join('"%s"' % v for v in values)

    # the think rule `start` is built with: any text up to `</think>`. `with_think` replaces it by the slot lines of the trace
    # (`think3_rules`); llama_backend uses it as the loose stop of a think request.
    FREE_THINK = "think: THINK\nTHINK: /(.|\\n)*/"

    def with_think(self, g: str, require_refer: bool, n_dates: int | None = None, trace: str | None = None) -> str:
        """`trace`: `v3.1` or `v4` (default `fmt.trace_mode()`, NATIVE_TRACE); a v4 think has no `refer:` line to demand."""
        if self.FREE_THINK not in g:
            raise ValueError("the grammar has no free think rule to replace")
        return g.replace(self.FREE_THINK, think_rules(require_refer, n_dates, trace))

    def specialise(self, rows, results, restrict=True, require_refer=False, n_dates=None, trace=None) -> str:
        g = self.with_think(self.src, require_refer, n_dates, trace)
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
        """The think is the slot lines of the trace and the refer rule applies (the grammar demands a `refer:` line on the first
        step of every turn that has a previous result). Once the think is closed the call is not sampled but written by
        `fmt.call_of_think`, the very function the data builder checks against every authored call (a think that does not
        state a whole call leaves the call to the grammar)."""
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

    def matcher(self, rows, results, require_refer=False, n_dates=None):
        """An llguidance matcher over the step's grammar. `require_refer`: the think must carry a `refer:` line;
        `n_dates`: the entries of the prompt's dates line (a `dates[i]` of the think names one of them)."""
        g = self.grammar.specialise(rows, results, self.restrict, require_refer, n_dates)
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

    def step(self, msgs, mode="hard", sample=False, seed=0, prefix=""):
        """One assistant message for render.py records (the shared renderer builds the prompt)."""
        prompt = fmt.render.render_prompt_for_generation(msgs)
        return self.generate(prompt, *fmt.addressable(msgs), mode=mode, sample=sample, seed=seed,
                             require_refer=fmt.requires_refer(msgs), dates=fmt.trace3().dates_line_of(msgs), prefix=prefix)

    def complete(self, prompt, mode="hard", sample=False, seed=0, prefix=""):
        """One assistant message for an already rendered prompt (ending `<|im_start|>assistant\\n`,
        with or without the `<think>\\n` the template's generation prompt adds). `prefix`: the start of the think, given
        (`retry: <slot>\\n` after the runtime refused a slot); the message returned includes it."""
        if prompt.endswith("<|im_start|>assistant\n"):
            prompt += "<think>\n"
        return self.generate(prompt, *fmt.addressable_in_prompt(prompt), mode=mode, sample=sample, seed=seed,
                             require_refer=fmt.requires_refer_in_prompt(prompt), dates=fmt.dates_line_in_prompt(prompt), prefix=prefix)

    @torch.no_grad()
    def generate(self, prompt, rows, results, mode="hard", sample=False, seed=0, require_refer=False, dates=None, prefix=""):
        """Greedy (or sampled) HF `generate` under the step's processor. Returns (text, info);
        text is the whole assistant message and starts with `<think>\\n`. `dates`: the `dates:` line of the turn's message
        (the entries a `dates[i]` of the think may name, and what the call the think states is read against);
        `prefix`: the first lines of the think, consumed by the grammar before the model writes."""
        from transformers import LogitsProcessorList
        assert mode in ("hard", "soft", "free")
        assert prompt.endswith("<|im_start|>assistant\n<think>\n"), prompt[-60:]
        dev = next(self.model.parameters()).device
        pre = self.tok(prefix, add_special_tokens=False)["input_ids"] if prefix else []
        ids = torch.tensor([self.tok(prompt, add_special_tokens=False)["input_ids"] + pre], device=dev)
        n_dates = len(fmt.trace3().dates_entries(dates))
        matcher = self.matcher(rows, results, require_refer, n_dates) if mode != "free" else None
        for t_ in pre:
            if matcher is not None and not matcher.consume_token(t_):
                matcher = None  # a prefix the grammar does not take: decode free of it
        proc = _Step(self, matcher, mode, ids.shape[1], dates, prefix)
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
        return "<think>\n" + prefix + body, info


class _Step:
    """HF logits processor: think guard, then the llguidance mask (hard) or its soft variant."""

    def __init__(self, dec: Decoder, matcher, mode: str, prompt_len: int, dates: str | None = None, prefix: str = ""):
        self.d, self.m, self.mode, self.prompt_len = dec, matcher, mode, prompt_len
        self.dates, self.prefix = dates, prefix  # the dates line a `dates[i]` is read against; the think's given first lines
        self.constrained = matcher is not None
        self.seen, self.in_think, self.n_think = 0, True, 0
        self.forced, self.forced_from = [], 0  # the call the think states, as token ids, and where it starts in the output
        self.info = {"mode": mode, "think_cut": False, "override": False, "grammar_error": None, "rendered_call": False}

    def _render_call(self, think_ids, start):
        """The think is closed: when it states a whole call, queue the call's tokens (a blank line, then the call)."""
        call = fmt.call_of_think(self.prefix + self.d.tok.decode(think_ids, skip_special_tokens=False), self.dates)
        if call is None:
            return
        self.forced = self.d.tok("\n\n" + call, add_special_tokens=False)["input_ids"]
        self.forced_from = start
        self.info["rendered_call"] = True

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
                    k = new.index(t)
                    self._render_call(new[:k], k + 1)
                else:
                    self.n_think += 1
        self.seen = len(new)
        row = scores[0]
        if self.forced and len(new) - self.forced_from < len(self.forced):
            # the call the think states: one token at a time (the grammar still reads every one)
            want = self.forced[len(new) - self.forced_from]
            row.fill_(float("-inf"))
            row[want] = 0.0
            return scores
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


def accepts_think(lltok, llg, grammar_text: str, tok, text: str) -> bool:
    """Does the grammar take the think and its `</think>` (the call after it left unread)? Isolates the think rules from
    a call grammar that moved on from the data (the exported grammar follows the runtime's current where language)."""
    m = llg.LLMatcher(lltok, llg.LLMatcher.grammar_from_lark(grammar_text), log_level=0)
    ids = tok(text, add_special_tokens=False)["input_ids"]
    end = tok.convert_tokens_to_ids("</think>")
    for t in ids[:ids.index(end) + 1]:
        if not m.consume_token(t):
            return False
    return True


def check_data(path, lark, model="Qwen/Qwen3.5-0.8B", limit=0, show=5, tools=None):
    """Grammar acceptance over every assistant message of a data file: the exact generated span
    (think + call, as render.py writes it, without `<|im_end|>`) through the full grammar, with
    handles both unrestricted and restricted to what the session had made addressable then. The `refer:` line is
    demanded exactly where the refer rule demands it, and every call must be the one its think states
    (`fmt.call_of_think`)."""
    import collections
    import llguidance
    import llguidance.hf
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(model)
    lltok = llguidance.hf.from_tokenizer(tok, eos_token=tok.convert_tokens_to_ids("<|im_end|>"))
    gram = Grammar(lark, tok)
    free_g = gram.specialise([], [], restrict=False)
    n_req = n_call = n_think = 0
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
            req = fmt.requires_refer(msgs[:j])
            n_req += req
            dates = fmt.trace3().dates_line_of(msgs[:j])
            g_step = gram.specialise(rows, results, require_refer=req, n_dates=len(fmt.trace3().dates_entries(dates)))
            b, why2 = accepts(lltok, llguidance, g_step, tok, body)
            ok_restr += b
            n_think += accepts_think(lltok, llguidance, g_step, tok, body)
            want = fmt.call_of_think(msgs[j]["think"], dates)
            if want == fmt.render.call_text(msgs[j]["tool"], msgs[j]["args"]):
                n_call += 1
            else:
                fails["call != compile(think): " + msgs[j]["think"][:60].replace("\n", " | ")] += 1
            if not (a and b):
                fails[("grammar" if not a else "handles") + ": " + (why if not a else why2)[:90]] += 1
                if shown < show:
                    shown += 1
                    print("--- example %d message %d (%s)\n%s\n%s" % (i, j, ex.get("id", ""), (why or why2),
                                                                      body[-400:]))
    print("sessions %d  steps %d  grammar-accepted %d (%.2f%%)  with handle restriction %d (%.2f%%)"
          % (sessions, n, ok_free, 100 * ok_free / max(n, 1), ok_restr, 100 * ok_restr / max(n, 1)))
    print("think (through </think>) accepted with the step's refer rule: %d (%.2f%%)" % (n_think, 100 * n_think / max(n, 1)))
    print("refer demanded on %d steps; call == compile(think) on %d (%.2f%%)" % (n_req, n_call, 100 * n_call / max(n, 1)))
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
