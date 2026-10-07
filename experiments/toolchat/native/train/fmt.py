"""Rendering and loss masking for one training example: one whole session (SPEC §6.4, §11.3, §11.7).

The text is produced by the one shared renderer, `experiments/toolchat/native/render.py`
(Qwen3.5's token format with every assistant message keeping its thinking); nothing here
re-implements it. Its records:

  {"role": "system", "content": str, "tools": [...]}      # tools may instead come from the example
  {"role": "user", "content": str}                        # vault block already prepended
  {"role": "assistant", "think": str, "tool": str, "args": {...}}
  {"role": "tool", "content": str}                        # compacted as the harness shows it

Trace version: v4 by default (`NATIVE_TRACE=v3.1` keeps v3.1) renders the thinks of the records as v4 (CONTRACT_V3.md section 8: fewer slots, one-row pick, the
compile step infers the rest); the records on disk stay v3.1 until the data is regenerated, and `records()` converts each think
as it is read (`trace_mode`, `v4_records`). `call_of_think` follows the same switch.

The loss mask comes from render()'s char spans and is checked against an independent reading
of the text: every `<|im_start|>assistant\\n<think>\\n` header opens one trained region that runs
to its `<|im_end|>` (inclusive), and nothing else is trained — no system, user or tool token.
When the example carries `loss_tokens`, they must equal the mask exactly.

Decision tokens (for the decision-weighted loss, train.py --decision-weight): the few label
tokens that decide whether a session passes. They are a subset of the trained tokens, found
STRUCTURALLY, never by position or by a fixed trace wording, so a new think format needs a new
label list, not new code (see `DecisionConfig`, `decision_char_spans`):

  think  a slot is `label: value`; a slot starts at the start of the think, after a newline or
         after ` · ` (SLOT_SEP), and its value runs to the start of the next slot or the end of the
         think. The value (not `label: `, not the separator) is a decision when `label` is in
         `DecisionConfig.labels`. Regex: `(?:^|\n| · )([a-z_][a-z0-9_]*): ?`. For the labels in
         `ref_labels` (none by default: a slot whose value is evidence copied out of the context, mostly row
         names) only the row refs in the value are decisions: `[#@][0-9]+`.
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
it is `now` or `earlier`, the row numbers of `refer` (`-> @1` counts `1`), the row numbers and
`ok` / `no` of `pick` (not its parenthesised reasons); `target` is a quote and counts nothing. In the call:
`rows`, `row`, `where`, `within`, `exclude`, `linked_to`, `limit`, `order`, the date expression (`when`, its
leaves; its keys only with `json_keys`), `verb`, `direction`, `op`, and of `args` only the row refs and date
leaves. Kind names, free text (`name`, `text`, `field`, `question`, ...) and names copied from the context
are left out. Every choice is a named constant (HARD_*) or a HardConfig flag. A hard token
is a decision token that also overlaps a hard character span, so the tier is always inside the decision
set. `encode()["decision"][i]` carries it as the bit `PART_HARD` on top of PART_THINK / PART_CALL (the
value is still truthy exactly for decision tokens, so every `> 0` reading of it is unchanged); it is
weighted by the same W as any decision token, the tier exists to be measured, not to get its own weight.

Copy tier (`CopyConfig`, `DecisionConfig.copy`, `copy_char_spans`): the model can read the user's message, so a think value that is a
verbatim copy of it carries no rule, only an instance, and its gradient teaches the instance. In the think, the quoted phrase of
`intent: ... "<phrase>"`, the value of every entry of `set:` (`key = value`; a `~date` is not a copy), and the whole value of `text:`
(a search) and `question:` (an ask) are copies when the value appears in the user's message of that turn: the person's own words, not the
block of `vault:` / `focus:` / `dates:` lines in front of them (`user_message`), compared case-insensitively with whitespace folded and
on whole words (`open` is not a copy of `reopen`). A value that does not appear keeps its loss. `encode()["decision"][i]` carries the bit
`PART_COPY` ALONE on a trained token wholly inside a copy span (blanks at the ends of the token aside: ` Dentist` is the word): never
beside PART_THINK / PART_CALL / PART_HARD, so a decision or hard token is never a copy token (a token that straddles the edge of a copy
span, or that overlaps a hard span, keeps its decision mark). Copy spans lie inside the decision spans of `intent`, `set` and `text`,
so a copy token is a decision token carved out: train.py gives it `--copy-weight` (default 0: no loss) instead of the decision weight and
reports it apart ("copy"), outside the decision and hard counts; it stays a label token for the all-token numbers. Every choice is a
named constant (COPY_*) or a CopyConfig field; `CopyConfig(labels=())` marks nothing. Only the think is marked: a call's values keep
their weights.
"""
from __future__ import annotations

import gzip
import hashlib
import bisect
import json
import re
import sys
import threading
from dataclasses import dataclass, field, replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import render  # noqa: E402  (experiments/toolchat/native/render.py)

IGNORE = -100
ASSISTANT_OPEN = render.ASSISTANT_OPEN
IM_END = render.IM_END


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
    """The id of a tool list: sha256 of the sorted-key JSON, 12 hex."""
    return hashlib.sha256(json.dumps(tools, sort_keys=True).encode()).hexdigest()[:12]


def trace_mode() -> str:
    """The trace version of the think: `v4`, or `v3.1` when NATIVE_TRACE says so (CONTRACT_V3.md sections 7 and 8)."""
    return trace3().default_mode()


def v4_records(msgs: list[dict]) -> list[dict]:
    """The records with every think rewritten as v4 (`trace.v4_think`, which checks that it compiles to the same call). A
    step v4 cannot say (a lookup, `via: find`) keeps its v3.1 think: both versions are readable (`trace.parse_any`)."""
    t = trace3()
    out = []
    for i, m in enumerate(msgs):
        if m["role"] == "assistant" and m.get("think"):
            try:
                m = dict(m, think=t.v4_think(m["think"], msgs[:i]))
            except t.V4Skip:
                pass
        out.append(m)
    return out


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
    return v4_records(msgs) if trace_mode() == "v4" else msgs


def assistant_ranges(text: str) -> list[tuple[int, int]]:
    """Independent reading of a render: [after `<think>\\n`, through `<|im_end|>`] per assistant."""
    out = []
    for m in re.finditer(re.escape(ASSISTANT_OPEN), text):
        s = m.end()
        e = text.index(IM_END, s) + len(IM_END)
        out.append((s, e))
    return out


# ---- decision spans (which label tokens decide pass or fail)

THINK_LABELS = ("intent", "verb", "scope", "refer", "target", "when", "pick",             # CONTRACT_V3.md: the base slots,
                "via", "kind", "op", "field", "group", "trashed", "name", "text", "where", "linked_to", "within", "exclude",
                "order", "limit", "more", "set", "time", "rows", "row", "value", "options", "reason")  # one slot per call argument
DEFAULT_LABELS = THINK_LABELS
SLOT_SEP = r"(?:^|\n| · )"  # what may precede a slot label in a think
SLOT = re.compile(SLOT_SEP + r"([a-z_][a-z0-9_]*): ?")
PARAM = re.compile(re.escape(render.PARAMETER_OPEN) + r"([^>\n]+)>\n(.*?)\n" + re.escape(render.PARAMETER_CLOSE), re.S)
JSON_ATOM = re.compile(r'"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null')
PART_THINK, PART_CALL = 1, 2  # values of `encode()["decision"]`: 0 = not a decision token
PART_HARD = 4                 # bit added to PART_THINK / PART_CALL on a hard-tier decision token
PART_COPY = 8                 # a token inside a verbatim copy of the user's message: carried ALONE, never beside the bits above
PART_MASK = PART_THINK | PART_CALL

# ---- the hard tier: the ONE place its defaults live. Only slot labels and call parameter names
# matter (never the exact trace format). Everything is overridable from the CLI (HardConfig.parse).
HARD_LABELS = ()
"""Think slots whose WHOLE value is hard. Empty by default: the base slots are a closed word plus a quoted
phrase copied from the message, and the phrase is not the decision (whole values would make the tier far too
wide). Kept as a knob (`--hard-labels`)."""
HARD_WORD_LABELS = ("intent", "scope", "refer", "when")
"""Think slots of which only the CLOSED WORD counts, the first word of the value (`read` of
`read "what's left"`, `both` of `both "those" -> @1`, `one`, `now`). The quoted phrase after it is
copied from the message and never counts. `verb` is deliberately NOT here by default: its word is
counted again by the call's `verb` parameter; `--hard-word-labels` is not a CLI flag, use
`HardConfig(word_labels=...)`."""
HARD_WHEN_WORDS = ("now", "earlier")
"""`when` is a closed word only when it is one of these; a bare quoted phrase (`when: "next friday"`)
is the message's own words and counts nothing in the slot (the date expression in the call carries it)."""
HARD_REF_LABELS = ("refer",)
"""Think slots of which only the row numbers of the refs count (`#12` -> `12`, `@3` -> `3`, quoted
phrases ignored): `refer` (the referent of `it`/`that`/`both`: `-> @1` counts the `1`; the arrow, sigil and
the quote do not)."""
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
    json_keys: bool = False     # keys of a date expression (unit, rel, weekday, time, anchor) count too (off: the leaves carry the date; the decision tier keeps its keys)
    param_names: bool = False   # the NAME of a hard parameter that is set counts (off: the tier stays under 10% of the label tokens; train.py --dry-run prints its share)
    ref_sigil: bool = False     # in a ref label (`refer`) the `#` / `@` counts too, not only the number (off: the sigil is derivable there)
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


# ---- the copy tier: the ONE place its defaults live (slot labels only, never the exact trace format)
COPY_LABELS = ("intent", "set", "text", "question")
"""Think slots whose value may be a copy of the user's message: the quoted phrase of `intent`, the value of each `set` entry, the whole value
of `text` (a search) and of `question` (an ask). `name`, `where` and the rest are decisions about rows or fields and are never copy
candidates by default."""
COPY_QUOTE_LABELS = ("intent",)   # the candidate is the first "quoted phrase" of the value (the closed word before it is not)
COPY_ENTRY_LABELS = ("set",)      # the candidates are the values of the ` · `-separated `key = value` entries (not a `~date`)
QUOTED_PHRASE = re.compile(r'"([^"\n]*)"')


@dataclass(frozen=True)
class CopyConfig:
    """Which think values may be marked as verbatim copies of the user's message (module docstring). `labels` are slot labels: how a
    label's value is cut into candidates is the slot's grammar (COPY_QUOTE_LABELS, COPY_ENTRY_LABELS, else the whole value). No labels is
    an empty tier."""
    labels: tuple = COPY_LABELS
    whole_words: bool = True     # a copy must match whole words of the message (`open` is not a copy of `reopen`)

    @property
    def empty(self) -> bool:
        return not self.labels

    @staticmethod
    def parse(labels=None, **kw) -> "CopyConfig":
        """From a comma list (CLI). None = the default; the empty string = none. `kw` takes `whole_words`; None is left at its default."""
        kw = {k: bool(v) for k, v in kw.items() if v is not None}
        return CopyConfig(COPY_LABELS if labels is None else _lst(labels), **kw)


@dataclass(frozen=True)
class DecisionConfig:
    labels: tuple = DEFAULT_LABELS   # think slot labels whose values are decisions
    ref_labels: tuple = ()           # labels of `labels` whose value counts only by its row refs
    params: tuple | None = None      # call parameter names whose values are decisions; None = all
    skip_params: tuple = ("question",)  # never decisions: the free text of `ask`, read by the person, not the runtime
    json_keys: bool = True           # keys of a JSON-valued parameter (`when`: unit, rel, to, weekday...)
    param_names: bool = True         # the parameter NAMES a call sets (which selector fields)
    hard: HardConfig | None = HardConfig()  # the narrow hard tier inside the decision tokens; None = no tier
    copy: CopyConfig = field(default_factory=CopyConfig, repr=False)  # verbatim copies of the message, carved out of the decision tokens;
    # not in repr(): the resume fingerprint of a run made before this tier existed stays valid (train.py fingerprints it when it matters)

    @staticmethod
    def parse(labels=None, ref_labels=None, params=None, skip_params=None, **kw) -> "DecisionConfig":
        """From comma lists (CLI). None = the default; for `labels` and `params` an empty string or
        `*` also means the default (all labels of DEFAULT_LABELS, all parameters); `ref_labels` and
        `skip_params` accept the empty string for none. `hard=` takes a HardConfig, `copy=` a CopyConfig."""
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
    cut = body.index(render.THINK_CLOSE)
    c0 = body.index(render.TOOL_CALL_OPEN, cut)
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
    cut = body.index(render.THINK_CLOSE)
    c0 = body.index(render.TOOL_CALL_OPEN, cut)
    return sorted(hard_think_spans(body[:cut], hard) + [(c0 + a, c0 + b) for a, b in hard_call_spans(body[c0:], hard)])


# ---- copy spans (think values that are verbatim copies of the user's message)

def user_message(content) -> str:
    """The person's own words in a user record: what follows the blank line of the block (`render.user_content`: the runtime's
    `vault:` / `focus:` / `dates:` lines, a blank line, the message; the split `authored/trace.py` reads). The block is context, never the
    user's words, so a value found only there is not a copy."""
    if not isinstance(content, str):  # content blocks
        content = " ".join(x.get("text", "") for x in (content or ()) if isinstance(x, dict))
    return content.rpartition("\n\n")[2]


def answered_users(msgs: list[dict]) -> list[str]:
    """For each assistant record, the person's message of its turn (`user_message` of the latest user record before it; "" before any)."""
    out, cur = [], ""
    for m in msgs:
        if m["role"] == "user":
            cur = user_message(m.get("content"))
        elif m["role"] == "assistant":
            out.append(cur)
    return out


def fold_text(s: str) -> str:
    """The form in which a think value meets the message: case-insensitive, runs of whitespace one space, ends trimmed."""
    return " ".join(s.casefold().split())


def _wordc(c: str) -> bool:
    return c.isalnum() or c == "_"


def appears(value: str, hay: str, whole_words: bool = True) -> bool:
    """Is `value` verbatim in `hay`? Both are folded here (`fold_text`). With `whole_words` a match must not begin or end inside a word
    of `hay` (a value that starts or ends with a non-word character, `#5`, has no boundary to keep on that side)."""
    v, h = fold_text(value), fold_text(hay)
    if not v:
        return False
    i = h.find(v)
    while i >= 0:
        j = i + len(v)
        if not whole_words or (not (_wordc(v[0]) and i > 0 and _wordc(h[i - 1]))
                               and not (_wordc(v[-1]) and j < len(h) and _wordc(h[j]))):
            return True
        i = h.find(v, i + 1)
    return False


def copy_candidates(label: str, value: str, copy: CopyConfig) -> list[tuple[int, int]]:
    """Char spans (relative to `value`, one slot's value) of the parts of it that may be copies: the first quoted phrase (COPY_QUOTE_LABELS),
    the value of each `key = value` entry that is not a `~date` (COPY_ENTRY_LABELS), else the whole value."""
    if label in COPY_QUOTE_LABELS:
        m = QUOTED_PHRASE.search(value)
        return [m.span(1)] if m and m.end(1) > m.start(1) else []
    if label in COPY_ENTRY_LABELS:
        out, pos = [], 0
        for part in value.split(" · "):
            key, sep, val = part.partition(" = ")
            if sep and key and val and not val.startswith("~"):
                out.append((pos + len(key) + len(sep), pos + len(part)))
            pos += len(part) + len(" · ")
        return out
    return [(0, len(value))] if value else []


def copy_char_spans(body: str, user: str | None, cfg: DecisionConfig) -> list[tuple[int, int]]:
    """Char spans (relative to `body`, one trained region in the frame of `decision_char_spans`) of the think values that are verbatim copies of
    `user`, the person's message of the turn (`user_message`): see the module docstring. Sorted and disjoint; a value that is not in `user`
    is not here. Slots are found as `think_spans` finds them."""
    copy = cfg.copy
    if copy is None or copy.empty or not user:
        return []
    think = body[:body.index(render.THINK_CLOSE)]
    ms = list(SLOT.finditer(think))
    out = []
    for i, m in enumerate(ms):
        if m.group(1) not in copy.labels:
            continue
        a = m.end()
        b = ms[i + 1].start() if i + 1 < len(ms) else len(think)
        while b > a and think[b - 1].isspace():
            b -= 1
        for x, y in copy_candidates(m.group(1), think[a:b], copy):
            if appears(think[a + x:a + y], user, copy.whole_words):
                out.append((a + x, a + y))
    return sorted(out)


def check_decisions(enc: dict, cfg: DecisionConfig | None = None) -> None:
    """Assert the decision marks against the records, independently of the span finder: every
    decision token is a trained token; each trained assistant message has a decision token in its
    call (a call with arguments) and its think slots named in the config (ref-only labels aside); and the decision text of
    a call contains every argument value (JSON leaves for a JSON-valued one)."""
    cfg = cfg or DecisionConfig()
    dec, labels, offs, text = enc["decision"], enc["labels"], enc["offsets"], enc["text"]
    if any(d and y == IGNORE for d, y in zip(dec, labels)):
        raise AssertionError("a decision token is not a trained token")
    a_all = [m for m in enc["records"] if m["role"] == "assistant"]
    users = answered_users(enc["records"])
    a_msgs = [m for m in a_all if m.get("loss", True)]
    trained = [sp for sp, m in zip(enc["ranges"], a_all) if m.get("loss", True)]
    t_users = [u for u, m in zip(users, a_all) if m.get("loss", True)]
    for (s, e), m, user in zip(trained, a_msgs, t_users):
        toks = [i for i, (a, b) in enumerate(offs) if s <= a and b <= e and b > a]
        parts = {dec[i] & PART_MASK for i in toks}
        if any(dec[i] & PART_HARD and not dec[i] & PART_MASK for i in toks):
            raise AssertionError("a hard token is not a decision token")
        if any(dec[i] & PART_COPY and dec[i] & ~PART_COPY for i in toks):
            raise AssertionError("a copy token is also a decision or hard token")
        run = []  # the copy tokens of this message, in runs of neighbours: each run must read as text of the user's message
        for i in toks + [None]:
            if i is not None and dec[i] & PART_COPY:
                run.append(i)
            elif run:
                got = text[offs[run[0]][0]:offs[run[-1]][1]]
                if fold_text(got) not in fold_text(user):
                    raise AssertionError("copy tokens %r are not in the user's message %r" % (got, user[:120]))
                run = []
        args = m.get("args") or {}
        body = text[s:e]
        if any(k not in cfg.skip_params for k in args) and PART_CALL not in parts:
            raise AssertionError("call with arguments has no decision token: %r" % body[-200:])
        slots = {x.group(1) for x in SLOT.finditer(body[:body.index(render.THINK_CLOSE)])} & (set(cfg.labels) - set(cfg.ref_labels))
        copied = cfg.copy is not None and not cfg.copy.empty and any(dec[i] & PART_COPY for i in toks)
        if slots and PART_THINK not in parts and not copied:  # a slot whose whole value is a copy has no decision token left
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
                c0 = body.index(render.TOOL_CALL_OPEN)
                got = "".join(body[c0 + a:c0 + b] for a, b in hard_call_spans(body[c0:], only))
                want = "".join(render._arg_value(v) for v in hargs.values())
                if not hard.json_keys:  # a date expression counts by its leaves: drop its `"key":`
                    want = re.sub(r'"[A-Za-z_][A-Za-z0-9_]*"\s*:', "", want)
                if re.sub(r"\W|_", "", got) != re.sub(r"\W|_", "", want):
                    raise AssertionError("hard text of the call %r != its hard arguments %r" % (got[:120], want[:120]))


def encode(tok, ex: dict, default_tools=None, cfg: DecisionConfig | None = None) -> dict:
    """Render + tokenize one session; labels are IGNORE outside the assistant think+call spans.
    `decision[i]` is 0, or PART_THINK / PART_CALL for a trained token that overlaps a decision span,
    plus the bit PART_HARD when that token also overlaps a hard-tier span (`cfg.hard`); or PART_COPY alone for a trained token wholly
    inside a verbatim copy of the user's message (`cfg.copy`, `copy_char_spans`), which a hard token never is."""
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
        if body.count(render.THINK_CLOSE) != 1 or body.count(render.TOOL_CALL_OPEN) != 1 or render.IM_START in body:
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
    t_users = [u for u, m in zip(answered_users(msgs), a_msgs) if m.get("loss", True)]
    cspans = sorted((s + a, s + b) for (s, e), u in zip(trained, t_users) for a, b in copy_char_spans(text[s:e], u, cfg))
    cstarts = [c[0] for c in cspans]
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
            if cspans and not decision[i] & PART_HARD:  # a hard token is never a copy token
                ua, ub = a, b  # the token without the blanks at its ends: ` Dentist` is the word, its space the separator
                while ua < ub and text[ua].isspace():
                    ua += 1
                while ub > ua and text[ub - 1].isspace():
                    ub -= 1
                if ua == ub:
                    ua, ub = a, b
                j = bisect.bisect_right(cstarts, ua) - 1
                if j >= 0 and ub <= cspans[j][1]:  # wholly inside a copy span (the span starts at or before it)
                    decision[i] = PART_COPY
    return {"input_ids": ids, "labels": labels, "decision": decision, "text": text, "ranges": spans,
            "offsets": offs, "records": msgs, "dspans": dspans, "hspans": hspans, "cspans": cspans}


def check_spans(ex: dict, enc: dict) -> None:
    """Assert the stored loss spans of an example agree with the render's mask.

    `loss_tokens` are token spans [a, b) and must equal the mask exactly;
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


# ---- the slot trace (authored/trace.py, CONTRACT_V3.md): the call a think states

_TRACE3_LOCK = threading.RLock()


def trace3():
    """authored/trace.py by path (the name `trace` is also a standard-library module), loaded once. The one place the
    trace's functions live: the data builder and the decoder both call these."""
    with _TRACE3_LOCK:  # batched scoring calls this from many threads: a half-executed module must never be visible
        if "authored_trace" not in sys.modules:
            import importlib.util
            path = Path(__file__).resolve().parents[1] / "authored" / "trace.py"
            spec = importlib.util.spec_from_file_location("authored_trace", path)
            mod = importlib.util.module_from_spec(spec)
            sys.modules["authored_trace"] = mod  # trace.py's own dataclasses look itself up here while it executes
            try:
                spec.loader.exec_module(mod)
            except BaseException:
                sys.modules.pop("authored_trace", None)
                raise
        return sys.modules["authored_trace"]


def msgs_in_prompt(prompt: str) -> list[dict]:
    """The records a rendered prompt shows (system, user, tool; assistant turns skipped), enough for `dates_line_in_prompt`."""
    msgs = []
    for seg in prompt.split(render.IM_START)[1:]:
        role, _, body = seg.partition("\n")
        body = body.split(IM_END)[0]
        if role == "system":
            msgs.append({"role": "system", "content": body.split("</IMPORTANT>")[-1]})
        elif role == "user":
            msgs.append({"role": "tool" if render.TOOL_RESPONSE_OPEN in body else "user", "content": body})
    return msgs


def dates_line_in_prompt(prompt: str) -> str | None:
    """The `dates:` line of the turn's user message in a rendered prompt (what a `dates[i]` of the think is read against)."""
    return trace3().dates_line_of(msgs_in_prompt(prompt))


def call_of_think(think: str, dates: str | None = None, mode: str | None = None):
    """The call a think states (render.py's call text), or None when the think does not state a whole call. The decoder
    writes exactly this text after `</think>`; the data builder checks the same function against every authored call.
    `dates`: the `dates:` line of the prompt, which a `dates[i]` of the think is read against (without it such a think
    states no whole call). `mode`: `v3.1` or `v4` (default `trace_mode()`); the data builders pass `v3.1` for the v3.1 thinks they
    write. The runtime's `compile` op is the authority; this is the render path it falls back to."""
    t = trace3()
    try:
        c = t.compile_call(think.strip(), dates, mode)
    except t.CompileError:
        return None
    return render.call_text(c["tool"], c["args"])
