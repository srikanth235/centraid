"""The one renderer for native sessions (SPEC §6.4, §11.7): data, trainer and eval driver import it.

Qwen3.5's token format, except that EVERY assistant message keeps its thinking (Qwen's default
chat template drops the thinking of turns before the last user message; the harness keeps it so
a follow-up sees how the earlier turn was read).

Message records (plain dicts):
  {"role": "system", "content": str, "tools": [<tool dicts, as `nativetools session` returns them>]}
  {"role": "user", "content": str}                       # user_content(text, preground): block first
  {"role": "assistant", "think": str, "tool": str, "args": {name: value}}
  {"role": "tool", "content": str}                      # the runtime's text, compacted as the harness shows it

  render(messages) -> (text, loss_char_spans)
      loss spans cover each assistant message from just after "<think>\\n" through "<|im_end|>";
      nothing of system, user or tool text carries loss.
  render_prompt_for_generation(messages) -> text
      the history (thinking kept) followed by "<|im_start|>assistant\\n<think>\\n".
"""
from __future__ import annotations

import functools
import json

TOKENIZER = "Qwen/Qwen3.5-0.8B"
IM_START, IM_END = "<|im_start|>", "<|im_end|>"
THINK_OPEN = "<think>\n"


@functools.lru_cache(maxsize=1)
def tokenizer():
    from transformers import AutoTokenizer
    return AutoTokenizer.from_pretrained(TOKENIZER)


@functools.lru_cache(maxsize=16)
def _system_block(content: str, tools_json: str) -> str:
    """Qwen's own system block (the <tools> preamble + the system text), taken from its chat template."""
    tools = json.loads(tools_json) or None
    probe = "⁣probe⁣"
    text = tokenizer().apply_chat_template(
        [{"role": "system", "content": content}, {"role": "user", "content": probe}],
        tools=tools, tokenize=False)
    cut = text.index(f"{IM_START}user\n{probe}")
    return text[:cut]


def _arg_value(v) -> str:
    # the chat template: mappings and sequences as JSON (tojson), everything else as a string
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def call_text(tool: str, args: dict) -> str:
    """One native tool call, exactly as the template writes it (the runtime's `call_text` parses it)."""
    out = f"<tool_call>\n<function={tool}>\n"
    for k, v in args.items():
        out += f"<parameter={k}>\n{_arg_value(v)}\n</parameter>\n"
    return out + "</function>\n</tool_call>"


def _assistant_body(m: dict) -> str:
    think = (m.get("think") or "").strip()
    return f"{think}\n</think>\n\n{call_text(m['tool'], m['args'])}{IM_END}"


def render(messages: list[dict]) -> tuple[str, list[tuple[int, int]]]:
    parts: list[str] = []
    spans: list[tuple[int, int]] = []
    pos = 0

    def put(s: str) -> None:
        nonlocal pos
        parts.append(s)
        pos += len(s)

    prev = None
    for i, m in enumerate(messages):
        role = m["role"]
        if role == "system":
            if i != 0:
                raise ValueError("system message must come first")
            put(_system_block(m["content"].strip(), json.dumps(m.get("tools") or [], sort_keys=False)))
        elif role == "user":
            put(f"{IM_START}user\n{m['content'].strip()}{IM_END}\n")
        elif role == "assistant":
            put(f"{IM_START}assistant\n{THINK_OPEN}")
            body = _assistant_body(m)
            spans.append((pos, pos + len(body)))
            put(body + "\n")
        elif role == "tool":
            if prev != "tool":
                put(f"{IM_START}user")
            put(f"\n<tool_response>\n{m['content'].strip()}\n</tool_response>")
            nxt = messages[i + 1]["role"] if i + 1 < len(messages) else None
            if nxt != "tool":
                put(f"{IM_END}\n")
        else:
            raise ValueError(f"unknown role {role}")
        prev = role
    return "".join(parts), spans


def user_content(text: str, preground: str | None) -> str:
    """A user turn's content as the harness writes it (SPEC §6.1): the runtime's vault block,
    a blank line, then the message — byte for byte what data/gen.py `user_content` produces.
    Every path that feeds a Qwen model (training data, the eval driver's hf backend) uses this."""
    return f"{preground}\n\n{text}" if preground else text


def render_prompt_for_generation(messages: list[dict]) -> str:
    text, _ = render(messages)
    return text + f"{IM_START}assistant\n{THINK_OPEN}"


def tokens_with_loss(text: str, spans: list[tuple[int, int]]) -> tuple[list[int], list[tuple[int, int]]]:
    """-> (input ids, token spans [start, end) carrying loss); spans must fall on token boundaries."""
    enc = tokenizer()(text, return_offsets_mapping=True, add_special_tokens=False)
    ids, offs = enc["input_ids"], enc["offset_mapping"]
    starts = {s: i for i, (s, e) in enumerate(offs)}
    ends = {e: i for i, (s, e) in enumerate(offs)}
    out = []
    for s, e in spans:
        if s not in starts or e not in ends:
            raise ValueError(f"loss span {s}:{e} not on token boundaries")
        out.append((starts[s], ends[e] + 1))
    return ids, out


def self_test() -> None:
    """A single-turn case matches Qwen's apply_chat_template byte for byte."""
    tools = [{"type": "function", "function": {"name": "find", "description": "d",
                                                "parameters": {"type": "object", "properties": {}}}}]
    msgs = [{"role": "system", "content": "today: x", "tools": tools},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "think": "intent: t", "tool": "find",
             "args": {"kind": "task", "when": {"unit": "day", "rel": 1}, "limit": 3, "trashed": "true"}},
            {"role": "tool", "content": "@1 · 0 tasks"},
            {"role": "assistant", "think": "plan: answer", "tool": "answer", "args": {"rows": "#1, #2"}}]
    q = [{"role": "system", "content": "today: x"}, {"role": "user", "content": "hi"}]
    for m in msgs[2:]:
        if m["role"] == "assistant":
            q.append({"role": "assistant", "content": "", "reasoning_content": m["think"],
                      "tool_calls": [{"type": "function", "function": {"name": m["tool"], "arguments": m["args"]}}]})
        else:
            q.append({"role": "tool", "content": m["content"]})
    want = tokenizer().apply_chat_template(q, tools=tools, tokenize=False)
    got, spans = render(msgs)
    assert got == want, (got, want)
    gen = render_prompt_for_generation(msgs[:2])
    assert gen == tokenizer().apply_chat_template(q[:2], tools=tools, tokenize=False, add_generation_prompt=True,
                                                  enable_thinking=True)
    ids, tsp = tokens_with_loss(got, spans)
    for a, b in tsp:
        piece = tokenizer().decode(ids[a:b])
        assert piece.endswith(IM_END) and "<tool_response>" not in piece and "user\n" not in piece


if __name__ == "__main__":
    self_test()
    print("render self-test: matches Qwen3.5's chat template on a single turn")
