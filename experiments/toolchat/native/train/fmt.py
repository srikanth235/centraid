"""Rendering and loss masking for one training example: one whole session (SPEC §6.4, §11.3, §11.7).

The text is produced by the one shared renderer, `experiments/toolchat/native/render.py`
(Qwen3.5's token format with every assistant message keeping its thinking); nothing here
re-implements it. Its records:

  {"role": "system", "content": str, "tools": [...]}      # tools may instead come from the example
  {"role": "user", "content": str}                        # vault block already prepended
  {"role": "assistant", "think": str, "tool": str, "args": {...}}
  {"role": "tool", "content": str}                        # compacted as the harness shows it

The loss mask comes from render()'s char spans and is checked against an independent reading
of the text: every `<|im_start|>assistant\\n<think>\\n` header opens one trained region that runs
to its `<|im_end|>` (inclusive), and nothing else is trained — no system, user or tool token.
When the example carries the Data agent's `loss_tokens`, they must equal the mask exactly.

Decision tokens (for the decision-weighted loss, train.py --decision-weight): the few label
tokens that decide whether a session passes. They are a subset of the trained tokens, found
STRUCTURALLY, never by position or by a fixed trace wording, so a new think format needs a new
label list, not new code (see `DecisionConfig`, `decision_char_spans`):

  think  a slot is `label: value`; a slot starts at the start of the think, after a newline or
         after ` · ` (SLOT_SEP), and its value runs to the start of the next slot or the end of the
         think. The value (not `label: `, not the separator) is a decision when `label` is in
         `DecisionConfig.labels`. Regex: `(?:^|\n| · )([a-z_][a-z0-9_]*): ?`. For the labels in
         `ref_labels` (`saw`, `last`: evidence copied out of the context, mostly row names) only the
         row refs in the value are decisions: `[#@][0-9]+`.
  call   `<parameter=NAME>\nVALUE\n</parameter>` blocks. VALUE is a decision (every parameter, or
         only `DecisionConfig.params`; never `skip_params`, the free text of `ask`). A VALUE that parses as a JSON object or array (the `when`
         date expression) contributes its scalar leaves (string content without quotes, numbers,
         true/false/null) and, with `json_keys`, its keys; braces, quotes, commas and colons stay
         weight 1. With `param_names`, the NAME of a parameter that is present is a decision too
         (which selector fields the call sets).
  never  the tool name (`<function=...>`), `<tool_call>` / `</think>` / `<|im_end|>` scaffolding,
         the `label: ` text and separators.

A token is a decision when it is a trained token and overlaps a decision character span.

Hard tier (`HardConfig`, `DecisionConfig.hard`): a NARROW subset of the decision tokens, the ones
where a failed session usually went wrong: which rows, which date, which verb, direction or op, and the
closed words of the think slots that state them. In the think only CLOSED words count, never the quoted
phrase copied from the message: the first word of `intent` / `scope` / `refer` (the verb word is counted in the call's `verb`), `when` only if
it is `now` or `earlier`, the row numbers of `refer` (`-> @1` counts `1`) and `last`, the row numbers and
`ok` / `no` of `pick` (not its parenthesised reasons); `target` is a quote and counts nothing. In the call:
`rows`, `row`, `where`, `within`, `exclude`, `linked_to`, `limit`, `order`, the date expression (`when`, its
leaves; its keys only with `json_keys`), `verb`, `direction`, `op`, and of `args` only the row refs and date
leaves. Kind names, free text (`name`, `text`, `field`, `question`, ...) and names copied from the context
are left out. Every choice is a named constant (HARD_*) or a HardConfig flag. A hard token
is a decision token that also overlaps a hard character span, so the tier is always inside the decision
set. `encode()["decision"][i]` carries it as the bit `PART_HARD` on top of PART_THINK / PART_CALL (the
value is still truthy exactly for decision tokens, so every `> 0` reading of it is unchanged); it is
weighted by the same W as any decision token, the tier exists to be measured, not to get its own weight.
"""
from __future__ import annotations

import gzip
import hashlib
import bisect
import json
import re
import sys
from dataclasses import dataclass, replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import render  # noqa: E402  (experiments/toolchat/native/render.py)

IGNORE = -100
ASSISTANT_OPEN = "<|im_start|>assistant\n<think>\n"
IM_END = "<|im_end|>"


def read_examples(path: str | Path, partial_ok: bool = False):
    """Yield examples from a (gzipped) JSONL file, one object per line. `partial_ok` reads a
    file still being written up to its last complete line (for checks, never for training)."""
    path = Path(path)
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as fh:
        try:
            for line in fh:
                if line.strip():
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        if not partial_ok:
                            raise
                        return
        except (EOFError, OSError):
            if not partial_ok:
                raise


def tools_hash(tools) -> str:
    """The Data agent's id for a tool list (data/gen.py): sha256 of the sorted-key JSON, 12 hex."""
    return hashlib.sha256(json.dumps(tools, sort_keys=True).encode()).hexdigest()[:12]


def records(ex: dict, default_tools=None) -> list[dict]:
    """The example's messages as render.py records, the system record carrying its tools.

    Tools: on the system record, else the example's `tools`, else `default_tools`; an example's
    `tools_hash` must match the tools used."""
    msgs = [dict(m) for m in ex["messages"]]
    if not msgs or msgs[0]["role"] != "system":
        raise ValueError("example does not start with a system message")
    tools = msgs[0].get("tools") or ex.get("tools") or default_tools
    if not tools:
        raise ValueError("example carries no tools and no default tools were given")
    if ex.get("tools_hash") and ex["tools_hash"] != tools_hash(tools):
        raise ValueError("example tools_hash %s != the tools in use (%s)" % (ex["tools_hash"], tools_hash(tools)))
    msgs[0]["tools"] = tools
    for m in msgs:
        m.pop("obs", None)
    return msgs


def assistant_ranges(text: str) -> list[tuple[int, int]]:
    """Independent reading of a render: [after `<think>\\n`, through `<|im_end|>`] per assistant."""
    out = []
    for m in re.finditer(re.escape(ASSISTANT_OPEN), text):
        s = m.end()
        e = text.index(IM_END, s) + len(IM_END)
        out.append((s, e))
    return out


# ---- decision spans (which label tokens decide pass or fail)

THINK_LABELS_V1 = ("intent", "kind", "cond", "plan", "saw", "last", "rule", "today")  # authored/build.py derive_think
THINK_LABELS_V2 = ("intent", "verb", "scope", "refer", "target", "when", "pick")      # CONTRACT_V2.md section 2
DEFAULT_LABELS = tuple(dict.fromkeys(THINK_LABELS_V1 + THINK_LABELS_V2))
SLOT_SEP = r"(?:^|\n| · )"  # what may precede a slot label in a think
SLOT = re.compile(SLOT_SEP + r"([a-z_][a-z0-9_]*): ?")
PARAM = re.compile(r"<parameter=([^>\n]+)>\n(.*?)\n</parameter>", re.S)
JSON_ATOM = re.compile(r'"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null')
PART_THINK, PART_CALL = 1, 2  # values of `encode()["decision"]`: 0 = not a decision token
PART_HARD = 4                 # bit added to PART_THINK / PART_CALL on a hard-tier decision token
PART_MASK = PART_THINK | PART_CALL

# ---- the hard tier: the ONE place its defaults live. Only slot labels and call parameter names
# matter (never the exact trace format), so the same lists serve today's think (THINK_LABELS_V1) and
# the v2 slots (THINK_LABELS_V2). Everything is overridable from the CLI (HardConfig.parse).
HARD_LABELS = ()
"""Think slots whose WHOLE value is hard. Empty by default: every slot of the v2 think is a closed word
plus a quoted phrase copied from the message, and the phrase is not the decision (the whole-value tier
was 25% of the label tokens; the `intent` phrase alone 8 points). Kept as a knob (`--hard-labels`)."""
HARD_WORD_LABELS = ("intent", "scope", "refer", "when")
"""Think slots of which only the CLOSED WORD counts, the first word of the value (`read` of
`read "what's left"`, `both` of `both "those" -> @1`, `one`, `now`). The quoted phrase after it is
copied from the message and never counts. `verb` is deliberately NOT here by default: its word is
counted again by the call's `verb` parameter, and with the think copy the tier is 10.15% of the label
tokens (over the 10% gate); `--hard-word-labels` is not a CLI flag, use `HardConfig(word_labels=...)`."""
HARD_WHEN_WORDS = ("now", "earlier")
"""`when` is a closed word only when it is one of these; a bare quoted phrase (`when: "next friday"`)
is the message's own words and counts nothing in the slot (the date expression in the call carries it)."""
HARD_REF_LABELS = ("last", "refer")
"""Think slots of which only the row numbers of the refs count (`#12` -> `12`, `@3` -> `3`, quoted
phrases ignored): `refer` (the referent of `it`/`that`/`both`: `-> @1` counts the `1`; the arrow, sigil and
the quote do not) and `last` (the rows of the previous result). `saw` is left out: it lists every row
the model was shown (about a third of the hard tokens on the v1 data). `--hard-ref-labels saw,last`."""
HARD_PICK_LABELS = ("pick",)
"""Think slots of per-row verdicts (`#37 ok · #44 no (name)`): the row numbers and the `ok` / `no` word
count; the reason in parentheses (`(name)`, `(other)`) does not, unless `HardConfig.pick_reasons`."""
HARD_PARAMS = ("rows", "row", "where", "within", "exclude", "linked_to", "limit", "order", "when",
               "verb", "direction", "op")
"""Call parameters whose value (and, with `param_names`, whose presence) is hard: the row refs and `@k`
handles (`rows`, `row`, `within`, `exclude`, `linked_to`), the selector that picks rows (`where`, `limit`,
`order`), the date expression (`when`: its leaves, the unit / rel / weekday / time / anchor keys only with `json_keys`) and the
closed-set choices `verb`, `direction`, `op`. Not hard: `kind` names, free text (`name`, `text`, `field`,
`group`, `question`, `options`, `reason`) and names copied from the context."""
HARD_REF_PARAMS = ("args",)
"""Call parameters that mix free text with row refs and dates (`args` = `field: value` lines, `to: #36`,
`to: {"unit":"hour","rel":1}`): only their row refs and JSON date leaves are hard, the free text is not."""


def _lst(x):
    return tuple(y.strip() for y in x.split(",") if y.strip())


@dataclass(frozen=True)
class HardConfig:
    """The hard tier (see the module docstring and the HARD_* constants): labels and parameter names,
    nothing positional. An all-empty config is an empty tier."""
    labels: tuple = HARD_LABELS
    ref_labels: tuple = HARD_REF_LABELS
    word_labels: tuple = HARD_WORD_LABELS
    pick_labels: tuple = HARD_PICK_LABELS
    when_words: tuple = HARD_WHEN_WORDS
    params: tuple = HARD_PARAMS
    ref_params: tuple = HARD_REF_PARAMS
    json_keys: bool = False     # keys of a date expression (unit, rel, weekday, time, anchor) count too (off: the leaves carry the date; with keys the tier is 11.2%, over the 10% gate; the decision tier keeps its keys)
    param_names: bool = False   # the NAME of a hard parameter that is set counts (off: ~1.3% of the label tokens, the tier stays under 10%)
    ref_sigil: bool = False     # in a ref label (`last`, `refer`) the `#` / `@` counts too, not only the number (off: the sigil is derivable there)
    pick_reasons: bool = False  # the `(reason)` of a `no` in a pick slot counts too (off: a label of the trace, not a decision)
    quotes: bool = False        # the quoted phrase of a word label counts too (off: copied from the message)

    @property
    def empty(self) -> bool:
        return not (self.labels or self.ref_labels or self.word_labels or self.pick_labels or self.params or self.ref_params)

    @staticmethod
    def parse(labels=None, ref_labels=None, params=None, ref_params=None, word_labels=None, pick_labels=None,
              when_words=None, **kw) -> "HardConfig":
        """From comma lists (CLI). None = the default; the empty string = none of that kind. `kw` takes
        the booleans (json_keys, param_names, ref_sigil); None values are left at their default."""
        kw = {k: bool(v) for k, v in kw.items() if v is not None}
        d = HardConfig()
        pick = lambda x, dflt: dflt if x is None else _lst(x)  # noqa: E731
        return HardConfig(pick(labels, d.labels), pick(ref_labels, d.ref_labels), pick(word_labels, d.word_labels),
                          pick(pick_labels, d.pick_labels), pick(when_words, d.when_words), pick(params, d.params),
                          pick(ref_params, d.ref_params), **kw)


@dataclass(frozen=True)
class DecisionConfig:
    labels: tuple = DEFAULT_LABELS   # think slot labels whose values are decisions
    ref_labels: tuple = ("saw", "last")  # labels of `labels` whose value counts only by its row refs
    params: tuple | None = None      # call parameter names whose values are decisions; None = all
    skip_params: tuple = ("question",)  # never decisions: the free text of `ask`, read by the person, not the runtime
    json_keys: bool = True           # keys of a JSON-valued parameter (`when`: unit, rel, to, weekday...)
    param_names: bool = True         # the parameter NAMES a call sets (which selector fields)
    hard: HardConfig | None = HardConfig()  # the narrow hard tier inside the decision tokens; None = no tier

    @staticmethod
    def parse(labels=None, ref_labels=None, params=None, skip_params=None, **kw) -> "DecisionConfig":
        """From comma lists (CLI). None = the default; for `labels` and `params` an empty string or
        `*` also means the default (all labels of DEFAULT_LABELS, all parameters); `ref_labels` and
        `skip_params` accept the empty string for none. `hard=` takes a HardConfig."""
        lst = _lst
        d = DecisionConfig()
        return DecisionConfig(
            lst(labels) if labels and labels.strip() != "*" else d.labels,
            d.ref_labels if ref_labels is None else lst(ref_labels),
            None if not params or params.strip() == "*" else lst(params),
            d.skip_params if skip_params is None else lst(skip_params), **kw)


REF = re.compile(r"[#@][0-9]+")


REF_NUM = re.compile(r"(?<=[#@])[0-9]+")


def think_spans(think: str, cfg: DecisionConfig, ref=REF) -> list[tuple[int, int]]:
    """Char spans (relative to `think`) of the values of the slots named in `cfg.labels`; for a label in
    `cfg.ref_labels` the matches of `ref` (a row ref, or only its number)."""
    ms = list(SLOT.finditer(think))
    out = []
    for i, m in enumerate(ms):
        if m.group(1) not in cfg.labels:
            continue
        a = m.end()
        b = ms[i + 1].start() if i + 1 < len(ms) else len(think)
        while b > a and think[b - 1].isspace():
            b -= 1
        if m.group(1) in cfg.ref_labels:
            out.extend((a + r.start(), a + r.end()) for r in ref.finditer(think[a:b]))
        elif b > a:
            out.append((a, b))
    return out


def json_leaf_spans(text: str, keys: bool) -> list[tuple[int, int]]:
    """Char spans of the scalar leaves (and optionally keys) of one JSON text; string spans
    exclude their quotes, so braces, quotes, commas and colons stay out."""
    out = []
    for m in JSON_ATOM.finditer(text):
        a, b = m.span()
        is_key = text[a] == '"' and text[b:].lstrip()[:1] == ":"
        if is_key and not keys:
            continue
        if text[a] == '"':
            a, b = a + 1, b - 1
        if b > a:
            out.append((a, b))
    return out


def value_spans(text: str, keys: bool, refs_only: bool = False) -> list[tuple[int, int]]:
    """Decision char spans of one parameter value. Plain text (a row ref, a name, a `where`
    expression, the `field: value` lines of `args`) is a decision as a whole; a JSON object or array
    inside it (a `when` date expression, alone or after `to: `) contributes only its leaves and keys.
    `refs_only`: the plain text contributes only its row refs (`#12`, `@3`), the JSON its leaves as before."""
    out, pos, dec = [], 0, json.JSONDecoder()

    def plain(a, b):
        if refs_only:
            out.extend((a + r.start(), a + r.end()) for r in REF.finditer(text[a:b]))
            return
        while a < b and text[a].isspace():
            a += 1
        while b > a and text[b - 1].isspace():
            b -= 1
        if b > a:
            out.append((a, b))
    i = 0
    while True:
        i = min((j for j in (text.find("{", i), text.find("[", i)) if j >= 0), default=-1)
        if i < 0:
            break
        try:
            _, end = dec.raw_decode(text, i)
        except ValueError:
            i += 1
            continue
        plain(pos, i)
        out.extend((i + a, i + b) for a, b in json_leaf_spans(text[i:end], keys))
        pos = i = end
    plain(pos, len(text))
    return out


def call_spans(call: str, cfg: DecisionConfig) -> list[tuple[int, int]]:
    """Char spans (relative to `call`, the text from `<tool_call>`) of the decision argument values."""
    out = []
    for m in PARAM.finditer(call):
        name = m.group(1)
        if (cfg.params is not None and name not in cfg.params) or name in cfg.skip_params:
            continue
        if cfg.param_names:
            out.append(m.span(1))
        v0 = m.start(2)
        out.extend((v0 + a, v0 + b) for a, b in value_spans(m.group(2), cfg.json_keys))
    return out


def decision_char_spans(body: str, cfg: DecisionConfig) -> list[tuple[int, int, int]]:
    """(start, end, part) char spans over one trained region `body` (think + `</think>` + call +
    `<|im_end|>`, as render.render's spans cover it), sorted; part is PART_THINK or PART_CALL."""
    cut = body.index("</think>")
    c0 = body.index("<tool_call>", cut)
    out = [(a, b, PART_THINK) for a, b in think_spans(body[:cut], cfg)]
    out += [(c0 + a, c0 + b, PART_CALL) for a, b in call_spans(body[c0:], cfg)]
    return sorted(out)


def hard_call_spans(call: str, hard: HardConfig) -> list[tuple[int, int]]:
    """Char spans (relative to `call`) of the hard argument values: the whole value of a `hard.params`
    parameter (date JSON by its leaves and keys), only the row refs and date leaves of a `hard.ref_params` one."""
    out = []
    for m in PARAM.finditer(call):
        name, v0 = m.group(1), m.start(2)
        if name in hard.params:
            if hard.param_names:
                out.append(m.span(1))
            out.extend((v0 + a, v0 + b) for a, b in value_spans(m.group(2), hard.json_keys))
        elif name in hard.ref_params:
            out.extend((v0 + a, v0 + b) for a, b in value_spans(m.group(2), hard.json_keys, refs_only=True))
    return out


QUOTED = re.compile(r'"(?:[^"\\]|\\.)*"')
PAREN = re.compile(r"\([^)]*\)")
WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
PICK_WORD = re.compile(r"(?<![\w#@])(?:ok|no)(?![\w])")


def _blank(text: str, rx) -> str:
    """`text` with every match of `rx` replaced by spaces (same length, offsets stay valid)."""
    return rx.sub(lambda m: " " * len(m.group(0)), text)


def hard_think_spans(think: str, hard: HardConfig) -> list[tuple[int, int]]:
    """Char spans (relative to `think`) of the hard think tokens: whole values of `hard.labels`; the closed
    word of `hard.word_labels` (a `when` only if in `hard.when_words`); the row numbers of `hard.ref_labels`;
    the row numbers and ok/no words of `hard.pick_labels`. Quoted phrases are blanked first (unless
    `hard.quotes`), pick reasons too (unless `hard.pick_reasons`)."""
    ms = list(SLOT.finditer(think))
    out = []
    ref = REF if hard.ref_sigil else REF_NUM
    for i, m in enumerate(ms):
        lab = m.group(1)
        a = m.end()
        b = ms[i + 1].start() if i + 1 < len(ms) else len(think)
        while b > a and think[b - 1].isspace():
            b -= 1
        if b <= a:
            continue
        val = think[a:b]
        if lab in hard.labels:
            out.append((a, b))
            continue
        if not hard.quotes:
            val = _blank(val, QUOTED)
        if lab in hard.word_labels:
            w = WORD.match(val.lstrip())
            if w:
                off = len(val) - len(val.lstrip())
                if lab != "when" or w.group(0) in hard.when_words:
                    out.append((a + off, a + off + w.end()))
        if lab in hard.ref_labels:
            out.extend((a + r.start(), a + r.end()) for r in ref.finditer(val))
        if lab in hard.pick_labels:
            pv = val if hard.pick_reasons else _blank(val, PAREN)
            out.extend((a + r.start(), a + r.end()) for r in ref.finditer(pv))
            out.extend((a + r.start(), a + r.end()) for r in PICK_WORD.finditer(pv))
    return sorted(out)


def hard_char_spans(body: str, cfg: DecisionConfig) -> list[tuple[int, int]]:
    """Hard-tier char spans over one trained region `body` (same frame as `decision_char_spans`), sorted.
    They may reach beyond the decision spans (a narrower `cfg.params`); `encode` keeps the intersection."""
    hard = cfg.hard
    if hard is None or hard.empty:
        return []
    cut = body.index("</think>")
    c0 = body.index("<tool_call>", cut)
    return sorted(hard_think_spans(body[:cut], hard) + [(c0 + a, c0 + b) for a, b in hard_call_spans(body[c0:], hard)])


def check_decisions(enc: dict, cfg: DecisionConfig | None = None) -> None:
    """Assert the decision marks against the records, independently of the span finder: every
    decision token is a trained token; each trained assistant message has a decision token in its
    call (a call with arguments) and its think slots named in the config (ref-only labels aside); and the decision text of
    a call contains every argument value (JSON leaves for a JSON-valued one)."""
    cfg = cfg or DecisionConfig()
    dec, labels, offs, text = enc["decision"], enc["labels"], enc["offsets"], enc["text"]
    if any(d and y == IGNORE for d, y in zip(dec, labels)):
        raise AssertionError("a decision token is not a trained token")
    a_msgs = [m for m in enc["records"] if m["role"] == "assistant" and m.get("loss", True)]
    trained = [sp for sp, m in zip(enc["ranges"], [m for m in enc["records"] if m["role"] == "assistant"])
               if m.get("loss", True)]
    for (s, e), m in zip(trained, a_msgs):
        toks = [i for i, (a, b) in enumerate(offs) if s <= a and b <= e and b > a]
        parts = {dec[i] & PART_MASK for i in toks}
        if any(dec[i] & PART_HARD and not dec[i] & PART_MASK for i in toks):
            raise AssertionError("a hard token is not a decision token")
        args = m.get("args") or {}
        body = text[s:e]
        if any(k not in cfg.skip_params for k in args) and PART_CALL not in parts:
            raise AssertionError("call with arguments has no decision token: %r" % body[-200:])
        slots = {x.group(1) for x in SLOT.finditer(body[:body.index("</think>")])} & (set(cfg.labels) - set(cfg.ref_labels))
        if slots and PART_THINK not in parts:
            raise AssertionError("think slots %s have no decision token: %r" % (sorted(slots), body[:200]))
        if cfg.params is None and cfg.json_keys:
            # the decision text of the values, names aside, holds every letter and digit of the
            # arguments as the renderer wrote them, in order (only punctuation may be left out)
            vals = replace(cfg, param_names=False)
            got = "".join(text[s + a:s + b] for a, b, p in decision_char_spans(body, vals) if p == PART_CALL)
            want = "".join(render._arg_value(v) for k, v in args.items() if k not in cfg.skip_params)
            if re.sub(r"\W|_", "", got) != re.sub(r"\W|_", "", want):
                raise AssertionError("decision text of the call %r != its arguments %r" % (got[:120], want[:120]))
        hard = cfg.hard
        if hard is not None and not hard.empty and cfg.params is None and cfg.json_keys:
            hargs = {k: v for k, v in args.items() if k in hard.params and k not in cfg.skip_params}
            if hargs and not any(dec[i] & PART_HARD and dec[i] & PART_CALL for i in toks):
                raise AssertionError("call with hard arguments %s has no hard token: %r" % (sorted(hargs), body[-200:]))
            if hargs:  # the hard text of the call holds every letter and digit of the hard values, in order
                only = replace(hard, ref_params=(), param_names=False)
                c0 = body.index("<tool_call>")
                got = "".join(body[c0 + a:c0 + b] for a, b in hard_call_spans(body[c0:], only))
                want = "".join(render._arg_value(v) for v in hargs.values())
                if not hard.json_keys:  # a date expression counts by its leaves: drop its `"key":`
                    want = re.sub(r'"[A-Za-z_][A-Za-z0-9_]*"\s*:', "", want)
                if re.sub(r"\W|_", "", got) != re.sub(r"\W|_", "", want):
                    raise AssertionError("hard text of the call %r != its hard arguments %r" % (got[:120], want[:120]))


def encode(tok, ex: dict, default_tools=None, cfg: DecisionConfig | None = None) -> dict:
    """Render + tokenize one session; labels are IGNORE outside the assistant think+call spans.
    `decision[i]` is 0, or PART_THINK / PART_CALL for a trained token that overlaps a decision span,
    plus the bit PART_HARD when that token also overlaps a hard-tier span (`cfg.hard`)."""
    cfg = cfg or DecisionConfig()
    msgs = records(ex, default_tools)
    text, spans = render.render(msgs)
    spans = [tuple(s) for s in spans]
    n_assistant = sum(1 for m in msgs if m["role"] == "assistant")
    if n_assistant == 0:
        raise ValueError("session has no assistant message")
    if spans != assistant_ranges(text) or len(spans) != n_assistant:
        raise AssertionError("render spans %s != the assistant regions of the text %s (%d assistant messages)"
                             % (spans[:3], assistant_ranges(text)[:3], n_assistant))
    for s, e in spans:
        body = text[s:e]
        if body.count("</think>") != 1 or body.count("<tool_call>") != 1 or "<|im_start|>" in body:
            raise AssertionError("trained region is not one think + one call: %r" % body[:200])
    enc = tok(text, add_special_tokens=False, return_offsets_mapping=True)
    ids, offs = enc["input_ids"], enc["offset_mapping"]
    labels = [IGNORE] * len(ids)
    # an assistant record with `loss: False` (a repair trajectory's rejected call) stays in the
    # text the later steps see but is not trained on
    a_msgs = [m for m in msgs if m["role"] == "assistant"]
    trained = [sp for sp, m in zip(spans, a_msgs) if m.get("loss", True)]
    dspans = sorted((s + a, s + b, p) for s, e in trained for a, b, p in decision_char_spans(text[s:e], cfg))
    dstarts = [d[0] for d in dspans]
    hspans = sorted((s + a, s + b) for s, e in trained for a, b in hard_char_spans(text[s:e], cfg))
    hstarts = [h[0] for h in hspans]
    decision = [0] * len(ids)
    for i, (a, b) in enumerate(offs):
        for s, e in spans:
            if a < s < b or a < e < b:
                raise ValueError("token %d %r straddles a loss boundary" % (i, text[a:b]))
        for s, e in trained:
            if s <= a and b <= e and b > a:
                labels[i] = ids[i]
        if labels[i] != IGNORE:
            # spans are disjoint and sorted: the last span starting before `b` is the only candidate
            j = bisect.bisect_left(dstarts, b) - 1
            if j >= 0 and dspans[j][1] > a:
                decision[i] = dspans[j][2]
                k = bisect.bisect_left(hstarts, b) - 1
                if k >= 0 and hspans[k][1] > a:
                    decision[i] |= PART_HARD
    return {"input_ids": ids, "labels": labels, "decision": decision, "text": text, "ranges": spans,
            "offsets": offs, "records": msgs, "dspans": dspans, "hspans": hspans}


def check_spans(ex: dict, enc: dict) -> None:
    """Assert the Data agent's stored loss spans agree with the render's mask.

    `loss_tokens` (data/gen.py) are token spans [a, b) and must equal the mask exactly;
    `n_tokens`, when present, must equal our token count; a stored `text` must equal ours."""
    if ex.get("text") is not None and ex["text"] != enc["text"]:
        raise AssertionError("example text differs from render.py's")
    if ex.get("loss_tokens") is not None:
        theirs = {i for a, b in ex["loss_tokens"] for i in range(a, b)}
        ours = {i for i, y in enumerate(enc["labels"]) if y != IGNORE}
        if theirs != ours:
            raise AssertionError("loss_tokens differ from the mask: %d only theirs, %d only ours"
                                 % (len(theirs - ours), len(ours - theirs)))
    if ex.get("n_tokens") is not None and ex["n_tokens"] != len(enc["input_ids"]):
        raise AssertionError("n_tokens %d != %d" % (ex["n_tokens"], len(enc["input_ids"])))


# ---- session state visible to the model: which #n / @n it may name (SPEC §3, §6.5, §9)

HASH = re.compile(r"(?<![\w#])#([1-9][0-9]*)\b")
AT = re.compile(r"(?<![\w@])@([1-9][0-9]*)\b")


def addressable(msgs: list[dict]) -> tuple[list[int], list[int]]:
    """(#n shown and not compacted, @n issued), read from what the model sees.

    `#n`: every number in the system prompt (vault directory), user messages (pre-grounding
    block) and tool results — earlier turns' results are already compacted in the messages, so
    only kept rows survive there. `@n`: every handle a tool result issued (compaction keeps the
    header, so handles persist). Assistant messages are never a source: a number the model wrote
    (in a call or in its thinking) does not become addressable by being written.
    """
    rows, results = set(), set()
    for m in msgs:
        if m["role"] == "assistant":
            continue
        c = m.get("content") or ""
        if not isinstance(c, str):
            c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
        rows.update(int(x) for x in HASH.findall(c))
        if m["role"] == "tool" or (m["role"] == "user" and "<tool_response>" in c):
            results.update(int(x) for x in AT.findall(c))
    return sorted(rows), sorted(results)


def addressable_in_prompt(prompt: str) -> tuple[list[int], list[int]]:
    """`addressable` over an already rendered prompt: the system block's own content (after
    the template's tool preamble), user turns and tool responses; assistant turns skipped."""
    msgs = []
    for seg in prompt.split("<|im_start|>")[1:]:
        role, _, body = seg.partition("\n")
        body = body.split(IM_END)[0]
        if role == "system":
            msgs.append({"role": "system", "content": body.split("</IMPORTANT>")[-1]})
        elif role == "user":
            msgs.append({"role": "tool" if "<tool_response>" in body else "user", "content": body})
    return addressable(msgs)
