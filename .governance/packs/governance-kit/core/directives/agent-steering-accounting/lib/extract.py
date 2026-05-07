#!/usr/bin/env python3
"""Steering-event extractor for Claude Code session JSONL.

Two-tier detection — both run by default. The directive itself is opt-in
at install time; no additional internal gates.

    Tier 1 — structural (runtime sentinels)
        interrupt — user message with text matching
            ``[Request interrupted by user`` (with or without ``for tool use``).
            No reason text by construction.

    Tier 2 — semantic correction
        correction — a user message immediately following an assistant turn,
            classified as a redirect. Primary classifier: shells out to the
            coding-agent CLI (``claude -p`` for Claude Code; future Codex
            adapter takes the same shape). The CLI is by definition installed
            in any session that wrote this transcript, so it's a free
            dependency. Fallback when the CLI is unreachable or returns a
            malformed response: a regex pre-filter (high-precision,
            high-FN — covers the obvious cases). Tier label on the emitted
            row reflects which classifier actually ran (``classifier`` or
            ``lexical``).

Tool denials were dropped: a user clicking "deny" on a tool call is most
often "I'll do that myself" / "wrong tool" rather than a redirect of intent,
and the original substring-match heuristic produced false positives any time
a tool result contained the canonical denial phrase (e.g. when an agent read
this file's source). Interrupts and classifier-confirmed corrections are the
real steering signal.

Output: one TSV row per detected event on stdout. Columns:

    timestamp_iso \\t type \\t tier \\t user_reason

Empty cells are emitted as the literal string ``-``. The bash caller
splits on TAB and reads cells.

Determinism: tier-2 verdicts are cached by message-pair hash in
``$GIT_DIR/agent-steering-classify-cache.json`` so re-runs (amend, retry)
return the same result and the count-based dedup in the pre-commit hook
stays exact.

CLI:

    python3 extract.py <session_jsonl> [--no-tier2] [--cache <path>]

Stdlib-only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# classifier.py sits next to this file; the relative import works under
# `python3 extract.py …` because the parent dir is on sys.path.
try:
    from classifier import Candidate, classify_candidates  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from classifier import Candidate, classify_candidates  # type: ignore


INTERRUPT_PHRASE_RE = re.compile(r"^\[Request interrupted by user\b")

# Heuristic guards on tier-2 candidate messages. We only ask the classifier
# about user messages that *could* be redirects — skip empty bodies and
# obvious tool-result wrappers. Long messages are clipped before classification.
CANDIDATE_MIN_LEN = 2
CANDIDATE_MAX_LEN = 2000


@dataclass
class Event:
    timestamp: str
    type: str
    tier: str
    user_reason: str


def _extract_text(content) -> str:
    """Pull the canonical text out of a message.content block.

    Claude Code stores content as either a plain string or a list of typed
    parts; we only care about ``text`` and ``tool_result`` payloads here.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                chunks.append(part["text"])
            elif part.get("type") == "tool_result":
                inner = part.get("content")
                if isinstance(inner, str):
                    chunks.append(inner)
                elif isinstance(inner, list):
                    for sub in inner:
                        if isinstance(sub, dict) and isinstance(sub.get("text"), str):
                            chunks.append(sub["text"])
        return "\n".join(chunks)
    return ""


# ── Main extractor ───────────────────────────────────────────────────────


def extract(
    path: str | Path,
    *,
    tier2: bool = True,
    cache_path: Path | None = None,
) -> list[Event]:
    """Walk a Claude Code JSONL transcript, return detected events in order."""
    p = Path(path)
    if not p.is_file():
        return []

    # Buffer the parsed lines so we can scan once for assistant context and
    # once for user events without re-reading the file.
    lines: list[dict] = []
    with p.open() as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue
            lines.append(d)

    # Walk in chronological order. tier-2 events are queued via `candidates`
    # and resolved in a single batched call after the walk completes; their
    # original line index is preserved so the final ordering matches the
    # transcript's chronology.
    #
    # A tier-2 candidate is any non-tool-result user message that follows at
    # least one assistant turn. We pair it with the *most recent* assistant
    # text/tool_use turn for the classifier's context — there is no literal
    # JSONL-line-adjacency requirement, because real Claude Code transcripts
    # interleave tool_use (assistant) and tool_result (user) entries between
    # an assistant text turn and the next user redirect. An earlier strict-
    # adjacency check (`last_assistant_idx == idx - 1`) silently dropped
    # *every* real redirect in real sessions.
    timeline: list[tuple[int, Event]] = []
    candidates: list[Candidate] = []
    candidate_origin: list[int] = []  # insertion index per candidate
    last_assistant_text = ""
    saw_assistant = False

    for idx, d in enumerate(lines):
        ts = d.get("timestamp", "") or ""
        msg = d.get("message") if isinstance(d.get("message"), dict) else None
        if not msg:
            continue
        role = msg.get("role")
        content = msg.get("content")

        if role == "assistant":
            # Track the most recent assistant turn. Use text content if
            # present; otherwise fall back to a tool_use summary so the
            # classifier still gets context for tool-driven turns.
            text_chunk = _extract_text(content)
            if text_chunk.strip():
                last_assistant_text = text_chunk
            elif isinstance(content, list):
                tool_chunks = []
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "tool_use":
                        name = part.get("name", "") or ""
                        tool_chunks.append(f"[tool_use {name}]")
                if tool_chunks:
                    last_assistant_text = "\n".join(tool_chunks)
            saw_assistant = True
            continue

        if role != "user":
            continue

        text = _extract_text(content)

        # tool_result blocks aren't candidates for interrupt or correction —
        # they're the agent's tool plumbing, not a user redirect.
        is_tool_result = (
            isinstance(content, list)
            and any(
                isinstance(p, dict) and p.get("type") == "tool_result"
                for p in content
            )
        )

        # Interrupt: user message containing `[Request interrupted by user`.
        if not is_tool_result and INTERRUPT_PHRASE_RE.search(text):
            timeline.append((
                idx,
                Event(
                    timestamp=ts,
                    type="interrupt",
                    tier="structural",
                    user_reason="",
                ),
            ))

        # Tier-2 candidate: a non-tool-result user message that follows at
        # least one assistant turn and clears the length floor. Classification
        # happens in a single batched call after the walk completes.
        if (
            tier2
            and not is_tool_result
            and saw_assistant
        ):
            stripped = text.strip()
            if (
                CANDIDATE_MIN_LEN <= len(stripped) <= CANDIDATE_MAX_LEN
                and not INTERRUPT_PHRASE_RE.search(stripped)
            ):
                candidates.append(
                    Candidate(
                        timestamp=ts,
                        assistant_text=last_assistant_text,
                        user_text=stripped,
                    )
                )
                candidate_origin.append(idx)

    # Run the tier-2 classifier on candidates (CLI primary, regex fallback).
    if candidates:
        verdicts = classify_candidates(candidates, cache_path=cache_path)
        for cand_idx, (tier, reason) in verdicts.items():
            c = candidates[cand_idx]
            timeline.append((
                candidate_origin[cand_idx],
                Event(
                    timestamp=c.timestamp,
                    type="correction",
                    tier=tier,
                    user_reason=reason or c.user_text[:240],
                ),
            ))

    # Sort by JSONL line index so tier-2 events slot back into chronological
    # order alongside tier-1 events.
    timeline.sort(key=lambda x: x[0])
    return [ev for _, ev in timeline]


# ── CLI ───────────────────────────────────────────────────────────────────


def _emit(field: str) -> str:
    # Emit empty cells as `-` so naive `read -r` in bash doesn't collapse
    # adjacent tabs.
    if not field:
        return "-"
    # Guard against literal tabs in the source destroying the TSV.
    return field.replace("\t", " ").replace("\n", " ")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("transcript")
    parser.add_argument(
        "--no-tier2",
        action="store_true",
        help="Skip tier-2 (correction) detection. Tier-1 still runs.",
    )
    parser.add_argument(
        "--cache",
        type=Path,
        default=None,
        help="Path to a JSON cache for tier-2 classifier verdicts.",
    )
    args = parser.parse_args(argv)
    events = extract(
        args.transcript,
        tier2=not args.no_tier2,
        cache_path=args.cache,
    )
    for ev in events:
        print(
            "\t".join(
                _emit(x)
                for x in (
                    ev.timestamp,
                    ev.type,
                    ev.tier,
                    ev.user_reason,
                )
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
