"""Parse Qwen3.5 output into a think and one call.

    parse_output(raw) -> {"think": str | None, "think_closed": bool, "call": {tool, name, args, error}}

The chat template may already have opened `<think>` in the prompt, so `raw` may start inside the think:
the think is the text before the first `</think>` (a leading `<think>` is dropped when present). With no
`</think>` the whole text up to a `<tool_call>` is an unclosed think (`think_closed` False).

Call formats (Qwen3.5 XML, and the Hermes JSON form):

    <tool_call>
    <function=act>
    <parameter=action>
    agenda.propose
    </parameter>
    <parameter=input>
    {"title": "dentist"}
    </parameter>
    </function>
    </tool_call>

    <tool_call>{"name": "act", "arguments": {"action": "agenda.propose", "input": {...}}}</tool_call>

Normalised call: act -> name=action, args=input; load -> name=view, args=params; ask -> name None,
args {question}; decline -> name None, args {reason}. `error` is None or a short code
(`no_tool_call`, `unknown_tool`, `bad_json`, `bad_xml`, `missing_param:<p>`, `bad_input_json: ...`,
`input_not_object`); on an error `tool`/`name`/`args` hold what could be recovered. `repaired` is True
when the JSON needed the trailing-comma / single-quote fix.
"""

from __future__ import annotations

import json
import re
from typing import Any

TOOLS = ("act", "load", "ask", "decline")
# tool -> (name parameter, json-object parameter) ; ask/decline have one text parameter.
_OBJECT_TOOLS = {"act": ("action", "input"), "load": ("view", "params")}
_TEXT_TOOLS = {"ask": "question", "decline": "reason"}

_FUNC_RE = re.compile(r"<function=([^>\s]+)\s*>(.*?)(?:</function>|\Z)", re.S)
_PARAM_RE = re.compile(r"<parameter=([^>\s]+)\s*>(.*?)(?:</parameter>|(?=<parameter=)|\Z)", re.S)


def split_think(raw: str) -> tuple[str | None, bool, str]:
    """(think, closed, rest). `rest` is what follows `</think>` (or the text from `<tool_call>` when unclosed)."""
    text = raw
    if "</think>" in text:
        head, rest = text.split("</think>", 1)
        head = head.split("<think>", 1)[1] if "<think>" in head else head
        return head.strip(), True, rest
    cut = text.find("<tool_call>")
    head, rest = (text, "") if cut < 0 else (text[:cut], text[cut:])
    if "<think>" in head:
        head = head.split("<think>", 1)[1]
    return head.strip(), False, rest


def _loads_lenient(text: str) -> tuple[Any, bool]:
    """json.loads, then once more after removing trailing commas and turning single quotes into double. (value, repaired)."""
    text = text.strip()
    try:
        return json.loads(text), False
    except json.JSONDecodeError:
        pass
    fixed = re.sub(r",\s*([}\]])", r"\1", text)
    if "'" in fixed and '"' not in fixed:
        fixed = fixed.replace("'", '"')
    return json.loads(fixed), True  # raises JSONDecodeError if still broken


def _strip_value(value: str) -> str:
    if value.startswith("\n"):
        value = value[1:]
    if value.endswith("\n"):
        value = value[:-1]
    return value


def _empty(error: str | None, tool: str | None = None) -> dict[str, Any]:
    return {"tool": tool, "name": None, "args": None, "error": error}


def _normalise(tool: str, params: dict[str, Any]) -> dict[str, Any]:
    """Build the normalised call from raw parameters (values are str, or already-decoded JSON for Hermes)."""
    repaired = False
    if tool in _OBJECT_TOOLS:
        name_key, obj_key = _OBJECT_TOOLS[tool]
        for key in (name_key, obj_key):
            if key not in params:
                return {**_empty(f"missing_param:{key}", tool), "name": _str(params.get(name_key))}
        name = _str(params[name_key])
        value = params[obj_key]
        if isinstance(value, str):
            try:
                value, repaired = _loads_lenient(value)
            except json.JSONDecodeError as why:
                return {**_empty(f"bad_input_json: {why.msg}", tool), "name": name}
        if not isinstance(value, dict):
            return {**_empty("input_not_object", tool), "name": name}
        out = {"tool": tool, "name": name, "args": value, "error": None}
        if repaired:
            out["repaired"] = True
        return out
    key = _TEXT_TOOLS[tool]
    if key not in params:
        return _empty(f"missing_param:{key}", tool)
    return {"tool": tool, "name": None, "args": {key: _str(params[key])}, "error": None}


def _str(value: Any) -> str | None:
    if value is None:
        return None
    return value.strip() if isinstance(value, str) else str(value)


def parse_call(text: str) -> dict[str, Any]:
    """Parse the first `<tool_call>` in `text` (the closing tag may be missing)."""
    start = text.find("<tool_call>")
    if start < 0:
        return _empty("no_tool_call")
    body = text[start + len("<tool_call>"):]
    end = body.find("</tool_call>")
    if end >= 0:
        body = body[:end]
    stripped = body.strip()
    if stripped.startswith("{"):
        try:
            obj, repaired = _loads_lenient(stripped)
        except json.JSONDecodeError as why:
            return _empty(f"bad_json: {why.msg}")
        if not isinstance(obj, dict):
            return _empty("bad_json: not an object")
        tool = obj.get("name")
        arguments = obj.get("arguments", obj.get("parameters", {}))
        if isinstance(arguments, str):
            try:
                arguments, _ = _loads_lenient(arguments)
            except json.JSONDecodeError as why:
                return _empty(f"bad_json: arguments: {why.msg}", tool if isinstance(tool, str) else None)
        if tool not in TOOLS:
            return _empty("unknown_tool", tool if isinstance(tool, str) else None)
        if not isinstance(arguments, dict):
            return _empty("bad_json: arguments not an object", tool)
        out = _normalise(tool, arguments)
        if repaired and out["error"] is None:
            out["repaired"] = True
        return out
    func = _FUNC_RE.search(body)
    if not func:
        return _empty("bad_xml")
    tool = func.group(1)
    if tool not in TOOLS:
        return _empty("unknown_tool", tool)
    params = {m.group(1): _strip_value(m.group(2)) for m in _PARAM_RE.finditer(func.group(2))}
    return _normalise(tool, params)


def parse_output(raw: str) -> dict[str, Any]:
    think, closed, rest = split_think(raw)
    return {"think": think, "think_closed": closed, "call": parse_call(rest)}
