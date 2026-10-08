"""Shared pieces of the eval: the runtime process, transcript rendering, turn effects.

The scorer (`score.py`) and the driver (`run.py`) both import this, so a turn's effect is
computed one way everywhere: from the runtime's own `effect` records, never from call text.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
NT = os.environ.get("NATIVETOOLS", str(REPO / "target" / "debug" / "nativetools"))
VAULTS = Path(os.environ.get("EVAL_VAULTS", "/tmp/nativetools-eval/vaults"))
STEP_CAP = 6


# EVAL_WORLDS: another worlds directory (the authored training worlds live outside eval/)
WORLDS = Path(os.environ.get("EVAL_WORLDS", HERE / "worlds"))


# The authored worlds (T01..T28) live beside their sessions; the val worlds among them are scored
# through this rig, so a name missing from WORLDS is looked up here.
AUTHORED_WORLDS = HERE.parent / "authored" / "worlds"


def world_dir(name: str) -> Path:
    """The directory holding <name>.json and <name>.keys.json."""
    return WORLDS if (WORLDS / f"{name}.json").exists() or not (AUTHORED_WORLDS / f"{name}.json").exists() else AUTHORED_WORLDS


def load_world(name: str) -> dict:
    return json.loads((world_dir(name) / f"{name}.json").read_text())


def keys_file(name: str, worlds_dir: Path | None = None) -> Path:
    """Where <name>.keys.json is read and written. A keys file is a by-product of seeding the world (world key -> vault id
    and kind) and no keys file is kept in the tree (R-1088-16), so it lives where the seeding was told to put it:
    $EVAL_KEYS when that is set (the tests point it at a temporary directory, and no test writes a tracked file), else
    beside the world file (`worlds_dir`, else `world_dir`)."""
    override = os.environ.get("EVAL_KEYS")
    if override:
        return Path(override) / f"{name}.keys.json"
    return (worlds_dir or world_dir(name)) / f"{name}.keys.json"


def load_keys(name: str) -> dict[str, dict]:
    return json.loads(keys_file(name).read_text())


def read_jsonl(path: str | Path) -> list[dict]:
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


# ---------------------------------------------------------------------------------------------
# The runtime process
# ---------------------------------------------------------------------------------------------


class Runtime:
    """One `nativetools session` over a private copy of a world's vault; deleted on close."""

    def __init__(self, world: str, today: str, me: str, tmp_root: str | None = None, flags: list[str] | None = None):
        src = VAULTS / world / "vault"
        if not src.exists():
            raise SystemExit(f"no seeded vault at {src}; run seed_worlds.py (EVAL_VAULTS={VAULTS})")
        self.dir = tempfile.mkdtemp(prefix="sess-", dir=tmp_root)
        self.vault = os.path.join(self.dir, "vault")
        subprocess.run([NT, "copy", str(src), self.vault], check=True, capture_output=True)
        self.proc = subprocess.Popen(
            [NT, "session", self.vault, "--today", today, "--me", me, *(flags or [])],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
        )

    def req(self, obj: dict) -> dict:
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"runtime died: {err}")
        return json.loads(line)

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            self.proc.kill()
        shutil.rmtree(self.dir, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# ---------------------------------------------------------------------------------------------
# Transcript rendering (Qwen3.5 native chat format)
# ---------------------------------------------------------------------------------------------

THINK_RE = re.compile(r"<think>.*?</think>\s*", re.S)


def first_call(text: str) -> str:
    """Keep the message up to its first </tool_call>: one call per step (the HF stop sequence)."""
    end = text.find("</tool_call>")
    return text if end < 0 else text[: end + len("</tool_call>")]


def _qwen_user(m: dict) -> str:
    """A user turn as a Qwen model sees it: render.user_content (vault block first)."""
    if "text" not in m:
        return m["content"]
    import sys as _sys

    _sys.path.insert(0, str(HERE.parent))
    from render import user_content

    return user_content(m["text"], m.get("preground"))


class Transcript:
    """Messages of one session. Tool responses are keyed by the runtime's `obs` index so a
    later `compacted` notice can replace them in place (SPEC §6.4)."""

    def __init__(self, system_rendered: str):
        self.system_rendered = system_rendered  # "<|im_start|>system ... <|im_end|>\n"
        self.messages: list[dict] = []

    def user(self, text: str, preground: str | None) -> None:
        body = text if not preground else f"{text}\n\n{preground}"
        # `text` / `preground` kept apart: a Qwen prompt is built with render.user_content (block
        # first, as the training data has it); `content` stays as the Sonnet backend has seen it
        self.messages.append({"role": "user", "content": body, "turn_start": True, "text": text,
                              "preground": preground})

    def assistant(self, text: str) -> None:
        self.messages.append({"role": "assistant", "content": text})

    def tool(self, obs: int | None, text: str) -> None:
        self.messages.append({"role": "tool", "content": text, "obs": obs})

    def compact(self, notices: list[dict]) -> None:
        by_obs = {n["obs"]: n["text"] for n in notices or []}
        for message in self.messages:
            if message["role"] == "tool" and message.get("obs") in by_obs:
                message["content"] = by_obs[message["obs"]]

    def history(self) -> list[dict]:
        """The session so far as chat messages ({role, content}; role user | assistant | tool),
        tool responses already compacted, assistant messages in full (think + call). The hf
        backend renders this with experiments/toolchat/native/render.py (the Data agent's
        renderer, so train and eval see one format)."""
        return [{"role": m["role"], "content": m["content"]} for m in self.messages]

    def render_qwen(self) -> str:
        """A plain Qwen chat rendering for debugging; the history keeps earlier turns' thinking
        (SPEC §6.4 as decided). The hf backend uses render.py, not this."""
        out = [self.system_rendered.rstrip("\n") + "\n"]
        i = 0
        while i < len(self.messages):
            m = self.messages[i]
            if m["role"] == "user":
                body = _qwen_user(m)
                out.append(f"<|im_start|>user\n{body}<|im_end|>\n")
            elif m["role"] == "assistant":
                out.append(f"<|im_start|>assistant\n{m['content']}<|im_end|>\n")
            else:
                parts = []
                while i < len(self.messages) and self.messages[i]["role"] == "tool":
                    parts.append(f"<tool_response>\n{self.messages[i]['content']}\n</tool_response>")
                    i += 1
                out.append("<|im_start|>user\n" + "\n".join(parts) + "<|im_end|>\n")
                continue
            i += 1
        out.append("<|im_start|>assistant\n")
        return "".join(out)

    def render_plain(self) -> str:
        """The same conversation for a chat model that is not Qwen (Sonnet)."""
        out = []
        last_user = max((i for i, m in enumerate(self.messages) if m.get("turn_start")), default=-1)
        for i, m in enumerate(self.messages):
            if m["role"] == "user":
                tag = "USER (current message)" if i == last_user else "USER"
                out.append(f"[{tag}]\n{m['content']}")
            elif m["role"] == "assistant":
                content = m["content"] if i > last_user else THINK_RE.sub("", m["content"])
                out.append(f"[ASSISTANT]\n{content}")
            else:
                out.append(f"[TOOL RESPONSE]\n<tool_response>\n{m['content']}\n</tool_response>")
        return "\n\n".join(out)


# ---------------------------------------------------------------------------------------------
# Row numbering (for the reference backend) and qwen call formatting
# ---------------------------------------------------------------------------------------------

ROW_TEXT_RE = re.compile(r"#(\d+)(?: \[\d+\])? ([a-z ]+?) \"([^\"]+)\"")
DIR_RE = re.compile(r"([^,:\n]+?) \(#(\d+)\)")
DIR_KIND = {"groups": "group", "albums": "album", "notebooks": "notebook", "folders": "folder", "lists": "list"}


SECTION_KIND = {"people": "person", "groups": "group", "events": "event", "tasks": "task", "notes": "note",
                "documents": "document", "photos": "photo", "albums": "album", "debts": "debt",
                "locker": "locker item", "notebooks": "notebook", "folders": "folder", "lists": "list"}


class NameIndex:
    """(kind, name) -> vault id for names unique within their kind; lets the reference backend
    number rows the runtime shows only as text (the vault directory, the pre-grounding line)."""

    def __init__(self, world: dict, keys: dict):
        seen: dict[tuple, list[str]] = {}
        for section, kind in SECTION_KIND.items():
            for row in world.get(section, []):
                if row.get("key") in keys:
                    seen.setdefault((kind, row["name"]), []).append(keys[row["key"]]["id"])
        seen[("person", world["me"])] = [keys["me"]["id"]]
        self.ids = {k: v[0] for k, v in seen.items() if len(v) == 1}

    def scan(self, text: str, n_of: dict, directory: bool = False) -> None:
        if not text:
            return
        if directory and "vault directory:" in text:
            for line in text.split("vault directory:", 1)[1].splitlines():
                head, _, rest = line.partition(":")
                kind = DIR_KIND.get(head.strip())
                if not kind:
                    continue
                for name, n in DIR_RE.findall(rest):
                    vid = self.ids.get((kind, name.strip()))
                    if vid and vid not in n_of:
                        n_of[vid] = int(n)
        for n, kind, name in ROW_TEXT_RE.findall(text):
            vid = self.ids.get((kind.strip(), name))
            if vid and vid not in n_of:
                n_of[vid] = int(n)


def effect_rows(effect: dict) -> list[dict]:
    """Every {id, kind, n} an effect names."""
    out: list[dict] = []
    if not isinstance(effect, dict):
        return out
    for key in ("rows", "created", "ambiguous", "already"):
        for row in effect.get(key) or []:
            if isinstance(row, dict) and "id" in row and "n" in row:
                out.append(row)
    answer = effect.get("answer") or {}
    out += [r for r in answer.get("rows") or [] if "n" in r]
    ask = effect.get("ask") or {}
    out += [r for r in ask.get("options") or [] if "n" in r]
    diff = effect.get("diff") or {}
    out += [r for r in diff.get("rows") or [] if "n" in r]
    return out


def format_call(tool: str, args: dict) -> str:
    """A call as Qwen3.5 XML (what a model emits)."""
    lines = ["<tool_call>", f"<function={tool}>"]
    for name, value in args.items():
        if isinstance(value, bool):
            text = "true" if value else "false"
        elif isinstance(value, (dict, list)):
            text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        else:
            text = str(value)
        lines += [f"<parameter={name}>", text, "</parameter>"]
    lines += ["</function>", "</tool_call>"]
    return "\n".join(lines)


# ---------------------------------------------------------------------------------------------
# Turn effects
# ---------------------------------------------------------------------------------------------


def merge_diffs(diffs: list[dict]) -> dict:
    """Net vault change of a turn: fields that end where they started drop out; a link added
    and removed in the same turn cancels."""
    rows: dict[str, dict] = {}
    for diff in diffs:
        for row in diff.get("rows") or []:
            cur = rows.setdefault(row["id"], {"id": row["id"], "kind": row["kind"], "created": False,
                                              "removed": False, "fields": {}})
            if row.get("change") == "created":
                cur["created"] = True
            if row.get("change") == "removed":  # a container deleted for good (no trash)
                cur["removed"] = True
            for field, (old, new) in (row.get("fields") or {}).items():
                if field in cur["fields"]:
                    cur["fields"][field][1] = new
                else:
                    cur["fields"][field] = [old, new]
    out_rows = []
    for cur in rows.values():
        # a sealed field (locker notes) reports sealed -> sealed when it changed: keep it
        fields = {f: v for f, v in cur["fields"].items() if cur["created"] or v[0] != v[1] or v[1] == "sealed"}
        if cur["created"] and cur["removed"]:
            continue
        if not fields and not cur["created"] and not cur["removed"]:
            continue
        if cur["removed"]:
            change = "removed"
        elif cur["created"]:
            change = "created"
        elif "trashed" in fields:
            change = "trashed" if fields["trashed"][1] else "restored"
        else:
            change = "updated"
        out_rows.append({"id": cur["id"], "kind": cur["kind"], "change": change, "fields": fields})
    links: dict[tuple, int] = {}
    for diff in diffs:
        for link in diff.get("links") or []:
            key = (link["from"]["id"], link["to"]["id"])
            links[key] = links.get(key, 0) + (1 if link["change"] == "added" else -1)
    out_links = [{"change": "added" if v > 0 else "removed", "from": a, "to": b}
                 for (a, b), v in links.items() if v != 0]
    return {"rows": out_rows, "links": out_links}


def turn_effect(steps: list[dict]) -> dict:
    """Summarise one turn from its runtime responses.

    kind: rows | value | act | ask | decline | none | cap | loop | error

    A turn the runtime ended itself (a retraction: `run.py` records a step with no model message, the
    runtime's own `decline never_mind`) reads as any decline does.
    """
    diffs, already, revealed, settles, verbs = [], [], [], [], []
    final: dict = {}
    for step in steps:
        resp = step.get("response") or {}
        eff = resp.get("effect") or {}
        if eff.get("tool") == "act":
            if eff.get("diff"):
                diffs.append(eff["diff"])
            already += [r["id"] for r in eff.get("already") or []]
            if eff.get("revealed"):
                revealed.append(eff["revealed"])
            if eff.get("verb"):
                verbs.append(eff["verb"])
            if eff.get("verb") == "settle_up" and "error" not in eff:
                settles.append(resp.get("text", ""))
        if resp.get("ends_turn"):
            final = resp
            break
    eff = final.get("effect") or {}
    tool = eff.get("tool")
    out: dict[str, Any] = {"diff": merge_diffs(diffs), "already": already, "revealed": revealed,
                           "settle_texts": settles, "verbs": verbs, "steps": len(steps)}
    if not final:
        out["kind"] = "cap"  # the driver stopped without the runtime ending the turn
    elif eff.get("loop"):
        out["kind"] = "loop"
    elif eff.get("cap"):
        out["kind"] = "cap"
    elif tool in ("answer", "act") and "answer" in eff:
        # an `act log` that ends the turn also answers the row it logged (rows + diff)
        out["kind"] = "rows"
        out["rows"] = [r["id"] for r in eff["answer"].get("rows") or []]
        out["ordered"] = bool(eff["answer"].get("ordered"))
    elif tool == "answer" and "value" in eff:
        out["kind"] = "value"
        out["value"] = eff["value"]
    elif tool == "ask":
        out["kind"] = "ask"
        out["options"] = [r["id"] for r in (eff.get("ask") or {}).get("options") or []]
    elif tool == "decline":
        out["kind"] = "decline"
        out["reason"] = (eff.get("decline") or {}).get("reason")
    elif tool == "act" and "error" not in eff:
        out["kind"] = "act"
    elif eff.get("error"):
        out["kind"] = "error"
        out["error"] = eff.get("error")
    else:
        out["kind"] = "none"
    return out
