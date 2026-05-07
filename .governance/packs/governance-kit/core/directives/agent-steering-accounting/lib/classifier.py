#!/usr/bin/env python3
"""Tier-2 classifier for agent-steering-accounting.

Primary path shells out to the active runtime's headless CLI (``claude -p``
or ``codex exec``); when the CLI isn't on ``$PATH`` or returns a malformed
response, falls back silently to a regex pre-filter. The directive's
install step is the only gate; there is no env-var toggle.

Verdicts are cached on disk by SHA-256 of (assistant_text, user_text) so
re-runs are deterministic — important because the pre-commit hook's
count-based dedup relies on the extractor returning the same set of events
on every walk.

The cached `tier` cell records which classifier path produced the verdict
(``classifier`` or ``lexical``) — that's the value that ends up in the
ledger row's `tier` column.

Stdlib-only.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import re

CANDIDATE_MAX_LEN = 2000

# High-precision regex used as a silent fallback when the CLI is unreachable.
# The classifier path subsumes this under normal operation.
LEXICAL_FALLBACK_RE = re.compile(
    r"^(no|stop|wait|actually|instead|don't|hold on|back up|undo|revert|"
    r"that's wrong|you're wrong)\b",
    re.IGNORECASE,
)


@dataclass
class Candidate:
    """A user message that follows an assistant turn — input to tier-2."""
    timestamp: str
    assistant_text: str
    user_text: str

CLASSIFIER_PROMPT = """\
You classify steering events in an agent session. A "redirect" is when the \
user asked the agent to stop, change direction, undo, reconsider, take a \
different approach, or pointed out the agent went the wrong way. NOT a \
redirect: a fresh task, a clarification question, a new requirement, an \
acknowledgement, or a follow-up that builds on the agent's last turn.

For each item below, reply with one JSON object per line, in the same order, \
no surrounding text. Each line must match exactly:

  {"i": <int>, "redirect": true|false, "reason": "<≤80-char one-liner or null>"}

The "reason" field, when redirect is true, summarises *what* the user pushed \
against — not the user's verbatim text. When redirect is false, set reason to null.

Items:
"""


def _candidate_hash(assistant_text: str, user_text: str) -> str:
    h = hashlib.sha256()
    h.update(assistant_text.encode("utf-8", errors="replace"))
    h.update(b"\x00")
    h.update(user_text.encode("utf-8", errors="replace"))
    return h.hexdigest()[:16]


def _load_cache(cache_path: Path | None) -> dict[str, dict]:
    if cache_path is None or not cache_path.is_file():
        return {}
    try:
        return json.loads(cache_path.read_text())
    except Exception:
        return {}


def _save_cache(cache_path: Path | None, cache: dict[str, dict]) -> None:
    if cache_path is None:
        return
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, sort_keys=True))
    except Exception:
        pass  # Best-effort cache; never fail the extractor on a write error.


def _detect_cli() -> list[str] | None:
    """Locate the runtime's headless CLI. Returns argv prefix or None."""
    if shutil.which("claude"):
        return ["claude", "-p", "--output-format", "text"]
    if shutil.which("codex"):
        return ["codex", "exec", "--quiet"]
    return None


def _classify_with_cli(
    candidates: list[Candidate],
    *,
    cli: list[str],
    timeout_s: float,
) -> dict[int, dict] | None:
    """Run the coding-agent CLI on uncached candidates, return verdicts.

    Returns ``None`` when the CLI is missing, errors out, or emits a
    malformed response — caller falls back to the regex layer.
    """
    if not candidates:
        return {}

    items = []
    for i, c in enumerate(candidates):
        a = c.assistant_text[-1200:]
        u = c.user_text[:CANDIDATE_MAX_LEN]
        items.append(f"--- item {i} ---\nassistant: {a}\nuser: {u}\n")

    prompt = CLASSIFIER_PROMPT + "\n".join(items)

    try:
        result = subprocess.run(
            cli,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None

    if result.returncode != 0:
        return None

    out = result.stdout.strip()
    if not out:
        return None

    verdicts: dict[int, dict] = {}
    for line in out.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        i = obj.get("i")
        if not isinstance(i, int) or i < 0 or i >= len(candidates):
            continue
        verdicts[i] = {
            "redirect": bool(obj.get("redirect")),
            "reason": obj.get("reason") or "",
        }

    # Require a verdict for every requested candidate. Partial coverage
    # (e.g. the model truncated mid-output) is treated as malformed so the
    # caller falls the entire batch back to the regex path. Caching a
    # silent ``redirect: False`` for a candidate the model never actually
    # ruled on would permanently bury that signal.
    if len(verdicts) != len(candidates):
        return None
    return verdicts


def _classify_with_regex(
    candidates: list[Candidate],
) -> dict[int, dict]:
    """Regex pre-filter — silent fallback when the CLI is unreachable."""
    out: dict[int, dict] = {}
    for i, c in enumerate(candidates):
        stripped = c.user_text.lstrip()
        redirect = bool(stripped and LEXICAL_FALLBACK_RE.match(stripped))
        out[i] = {
            "redirect": redirect,
            "reason": stripped[:240] if redirect else "",
        }
    return out


def classify_candidates(
    candidates: list[Candidate],
    *,
    cache_path: Path | None,
    timeout_s: float = 60.0,
) -> dict[int, tuple[str, str]]:
    """Return ``{candidate_idx: (tier, reason)}`` for every redirect verdict.

    ``tier`` is ``"classifier"`` for CLI-derived verdicts and ``"lexical"``
    for regex-fallback verdicts. Non-redirects don't appear in the result.
    """
    cache = _load_cache(cache_path)
    verdicts: dict[int, tuple[str, str]] = {}
    uncached: list[Candidate] = []
    uncached_indices: list[int] = []

    for i, c in enumerate(candidates):
        key = _candidate_hash(c.assistant_text, c.user_text)
        if key in cache:
            v = cache[key]
            if v.get("redirect"):
                verdicts[i] = (
                    v.get("tier", "classifier"),
                    v.get("reason", ""),
                )
            continue
        uncached.append(c)
        uncached_indices.append(i)

    if uncached:
        cli = _detect_cli()
        cli_verdicts: dict[int, dict] | None = None
        if cli is not None:
            cli_verdicts = _classify_with_cli(
                uncached, cli=cli, timeout_s=timeout_s
            )

        if cli_verdicts is not None:
            tier_label = "classifier"
            new_verdicts = cli_verdicts
        else:
            tier_label = "lexical"
            new_verdicts = _classify_with_regex(uncached)

        # Both _classify_with_cli (post all-or-nothing fix) and
        # _classify_with_regex guarantee a verdict per candidate, so direct
        # indexing is safe. A KeyError here would be an upstream bug.
        for j, c in enumerate(uncached):
            v = new_verdicts[j]
            key = _candidate_hash(c.assistant_text, c.user_text)
            cache[key] = {
                "redirect": v["redirect"],
                "tier": tier_label,
                "reason": v["reason"],
            }
            if v["redirect"]:
                verdicts[uncached_indices[j]] = (tier_label, v["reason"])

    _save_cache(cache_path, cache)
    return verdicts
