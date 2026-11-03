"""Chat messages and tool definitions for one probe item (DESIGN section 2)."""
from __future__ import annotations

import datetime
import json
from typing import Any

import retrieve

ROLE = (
    "You serve the member's personal vault. Answer every message with exactly one tool call. "
    "Say names and dates exactly as the member said them; the runtime resolves them. "
    "Never invent secrets such as passwords or card numbers. "
    "When the message does not decide the call, ask. "
    "Decline what is out of scope."
)
DECLINE_REASONS = ["out_of_scope", "never_mind", "fabricated_secret", "unbounded_destruction"]


def _fn(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
    }


def tools() -> list[dict]:
    return [
        _fn("act", "Run one action from the candidates.", {
            "action": {"type": "string", "description": "An action id from the candidates."},
            "input": {"type": "object", "description": "The action's params, as the member said them."},
        }, ["action", "input"]),
        _fn("load", "Read one view from the candidates.", {
            "view": {"type": "string", "description": "A view id from the candidates."},
            "params": {"type": "object", "description": "The view's params."},
        }, ["view", "params"]),
        _fn("ask", "Ask the member one question when the message does not decide the call.", {
            "question": {"type": "string"},
        }, ["question"]),
        _fn("decline", "Decline the message.", {
            "reason": {"type": "string", "enum": DECLINE_REASONS},
        }, ["reason"]),
    ]


def param_type(spec: dict) -> str:
    t = spec["type"]
    if t == "mention":
        return f"mention<{spec['of']}>" if spec.get("of") else "mention"
    if t == "enum":
        return "enum(" + "|".join(spec["values"]) + ")"
    if t == "list":
        inner = spec["items"]
        if inner == "mention" and spec.get("of"):
            inner = f"mention<{spec['of']}>"
        return f"list<{inner}>"
    return t


def entry_line(entry: dict) -> str:
    params = ", ".join(
        f"{name}{'*' if spec['required'] else ''}: {param_type(spec)}"
        for name, spec in sorted(entry["params"].items(), key=lambda kv: (not kv[1]["required"], kv[0]))
    ) or "no params"
    mode = "act" if entry["type"] == "action" else "view"
    line = f"{entry['id']} ({mode}, {entry['kind']}, {entry['verb']}) — {entry['summary']} — {params}"
    return line + " [card]" if entry.get("card") else line


def system_text(item: dict, catalog: dict[str, dict], ids: list[str]) -> str:
    day = datetime.date.fromisoformat(item["today"]).strftime("%A")
    lines = [ROLE, "", f"today: {day} {item['today']}", f"me: {item['me']}", "", "candidates:"]
    lines.extend(entry_line(catalog[i]) for i in ids)
    return "\n".join(lines)


def call_arguments(call: dict) -> dict:
    tool, name, args = call["tool"], call.get("name"), call.get("args", {})
    if tool == "act":
        return {"action": name, "input": args}
    if tool == "load":
        return {"view": name, "params": args}
    if tool == "ask":
        return {"question": args.get("question", "")}
    return {"reason": args.get("reason", "out_of_scope")}


def history_messages(history: list[dict]) -> list[dict]:
    out: list[dict] = []
    for turn in history:
        call = turn["call"]
        out.append({"role": "user", "content": turn["user"]})
        out.append({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "type": "function",
                "function": {"name": call["tool"], "arguments": call_arguments(call)},
            }],
        })
        out.append({"role": "tool", "content": "ok"})
    return out


def query_text(item: dict) -> str:
    history = item.get("history") or []
    return (history[-1]["user"] + "\n" if history else "") + item["user"]


def messages(item: dict, catalog: dict[str, dict], k: int = 8) -> tuple[list[dict], list[dict], list[str]]:
    ids = retrieve.candidates(query_text(item), catalog, k)
    msgs = [{"role": "system", "content": system_text(item, catalog, ids)}]
    msgs.extend(history_messages(item.get("history") or []))
    msgs.append({"role": "user", "content": item["user"]})
    return msgs, tools(), ids


def render(item: dict, catalog: dict[str, dict], tokenizer: Any, k: int = 8, thinking: bool = False) -> tuple[str, list[str]]:
    msgs, tool_defs, ids = messages(item, catalog, k)
    text = tokenizer.apply_chat_template(
        msgs, tools=tool_defs, add_generation_prompt=True, enable_thinking=thinking, tokenize=False
    )
    return text, ids


if __name__ == "__main__":
    import catalog as _catalog

    demo = {"id": "demo", "today": "2026-11-03", "me": "Sam Park", "history": [],
            "user": "put lunch with Sam on friday at noon"}
    m, _, c = messages(demo, _catalog.load())
    print(m[0]["content"])
    print(json.dumps(c))
