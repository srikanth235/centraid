"""Generate joint (operation + slot span) training data.

Reuses the selector lane's synthetic world, templates, whole-template holdout
and lexical-overlap guard, and adds what the joint model needs: the character
span of every span-typed slot inside the request, and the value of every enum
slot. Spans are recorded while the template is instantiated (``annotate.py``
says which part of a template is which slot), never re-found afterwards: the
mechanical register noise edits the text, and a post-hoc string search would
silently mis-locate a span the moment a value occurs twice.

Row shape::

    {"request", "previous_request", "previous_operation", "label",
     "spans": [{"slot", "start", "end", "text"}],
     "enums": {"slot": "value"},
     "template_id", "kind", "hard_negative"}

Row kinds are the selector's four (``single``, ``with_context``,
``continuation``, ``dependent``), so the same follow-up and hard-negative
pressure is present, now with slot supervision.

    .venv-joint/bin/python joint/gen_joint_data.py --write
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "selector"))
sys.path.insert(0, str(HERE))

import annotate as A  # noqa: E402
from gen_selector_data import OPENERS, SEED, SLOTS, TYPO_TARGETS  # noqa: E402
from overlap_check import THRESHOLD, jaccard, reference_corpus, tokens  # noqa: E402
from templates import CONTINUATION_TEMPLATES, DEPENDENT_TEMPLATES, TEMPLATES  # noqa: E402

_REFERENCE = [tokens(text) for _source, text in reference_corpus()]

_MARKER = re.compile(r"\[(\w+):|<(\w+)=([a-z_]+)>|\{(\w+)\}|\]")


def too_close(text: str) -> bool:
    bag = tokens(text)
    return any(jaccard(bag, ref) > THRESHOLD for ref in _REFERENCE)


# --------------------------------------------------------------- unseen names
#
# The suite's proper nouns (Initech, Goa, Priya Raman, Contracts) are, by the
# overlap rule, words the model has never seen: the synthetic world is
# deliberately disjoint. The first joint run showed what that costs — the
# tagger clipped an unseen name to a stray word piece ("ch" out of "Initech").
# So a share of slot values is replaced by an *invented* name built from random
# syllables, which forces the tagger onto the syntactic frame rather than onto
# a memorised vocabulary.

SYLLABLES = ("ka", "ro", "min", "tel", "sor", "va", "dun", "lex", "bri", "quo", "nar", "vel", "ash", "pim", "gor", "thu")
COMMON = ("blue", "north", "stone", "river", "paper", "glass", "iron", "amber", "quiet", "hollow", "spring", "ridge")
UNSEEN_SHARE = 0.35
# Placeholders whose value is a proper noun the model must copy rather than
# recognise. Date pools are left alone: those really are closed sets.
NAMEY = {
    "person", "people", "company", "event", "project", "album", "notebook",
    "folder", "group", "place", "service", "note", "doc", "task", "topic", "expense",
}


def invented(placeholder: str, rng: random.Random) -> str:
    """A proper noun no training template has ever produced."""

    def word() -> str:
        return "".join(rng.choice(SYLLABLES) for _ in range(rng.randint(2, 3))).capitalize()

    if placeholder in {"person", "people"}:
        return f"{word()} {word()}" if rng.random() < 0.5 else word()
    if placeholder in {"task", "topic", "expense", "doc", "note"}:
        if rng.random() < 0.5:
            return f"the {rng.choice(COMMON)} {rng.choice(COMMON)}"
        return f"the {word().lower()} {rng.choice(COMMON)}"
    if rng.random() < 0.5:
        return f"{rng.choice(COMMON).capitalize()} {word().lower()}"
    return word()


def value_for(placeholder: str, rng: random.Random) -> str:
    """A slot value: usually the synthetic world's, sometimes an invented one."""
    if placeholder in NAMEY and rng.random() < UNSEEN_SHARE:
        return invented(placeholder, rng)
    return rng.choice(SLOTS[placeholder])


def split_templates(rng: random.Random) -> tuple[dict[str, list[tuple[int, str]]], dict[str, list[tuple[int, str]]]]:
    """Hold out whole templates per label, over the joint lane's merged set.

    Same rule as the selector lane — a template is in train or in val, never
    both — but over ``annotate.ALL_TEMPLATES``, which adds this lane's
    group-phrase templates.
    """
    train: dict[str, list[tuple[int, str]]] = {}
    val: dict[str, list[tuple[int, str]]] = {}
    for label, templates in A.ALL_TEMPLATES.items():
        indexed = list(enumerate(templates))
        rng.shuffle(indexed)
        hold = max(2, round(0.25 * len(indexed)))
        val[label] = sorted(indexed[:hold])
        train[label] = sorted(indexed[hold:])
    return train, val


def fill_annotated(annotated: str, rng: random.Random) -> tuple[str, list[dict], dict[str, str]]:
    """Render an annotated template, recording every slot span as it is built."""
    out: list[str] = []
    spans: list[dict] = []
    enums: dict[str, str] = {}
    stack: list[tuple[str, int]] = []
    position = 0
    index = 0
    while index < len(annotated):
        match = _MARKER.search(annotated, index)
        if match is None:
            out.append(annotated[index:])
            position += len(annotated) - index
            break
        literal = annotated[index : match.start()]
        out.append(literal)
        position += len(literal)
        index = match.end()
        if match.group(1):  # "[slot:"
            stack.append((match.group(1), position))
        elif match.group(2):  # "<slot=value>"
            enums[match.group(2)] = match.group(3)
        elif match.group(4):  # "{placeholder}"
            value = value_for(match.group(4), rng)
            out.append(value)
            position += len(value)
        elif match.group(0) == "]":
            slot, start = stack.pop()
            text = "".join(out)[start:position]
            if slot in A.ENUM_SLOTS:
                enums[slot] = A.ENUM_SURFACE.get(text.lower(), text.lower())
            else:
                spans.append({"slot": slot, "start": start, "end": position, "text": text})
    if stack:
        raise ValueError(f"unclosed slot marker in {annotated!r}")
    return "".join(out), spans, enums


def _shift(spans: list[dict], at: int, delta: int) -> None:
    for span in spans:
        if span["start"] >= at:
            span["start"] += delta
            span["end"] += delta
        elif span["end"] > at:
            span["end"] += delta


def _inside(spans: list[dict], at: int) -> bool:
    return any(span["start"] <= at < span["end"] for span in spans)


def rough(text: str, spans: list[dict], rng: random.Random) -> tuple[str, list[dict]]:
    """Register noise that keeps the recorded spans exact.

    An edit that would land inside a slot span is skipped rather than applied,
    so a span is never silently corrupted; every other edit shifts the spans
    that follow it.
    """
    if rng.random() < 0.12:
        opener = rng.choice(OPENERS)
        text = opener + text
        _shift(spans, 0, len(opener))
    if rng.random() < 0.10 and "'" in text:
        at = text.index("'")
        if not _inside(spans, at):
            text = text[:at] + text[at + 1 :]
            _shift(spans, at, -1)
    if rng.random() < 0.10 and text and not _inside(spans, 0):
        text = text[0].upper() + text[1:]
    if rng.random() < 0.10 and len(text) > 12:
        at = rng.randrange(4, len(text) - 1)
        if not _inside(spans, at):
            if text[at] in TYPO_TARGETS:  # doubled letter
                text = text[:at] + text[at] + text[at:]
                _shift(spans, at, 1)
            else:  # dropped letter
                text = text[:at] + text[at + 1 :]
                _shift(spans, at, -1)
    for span in spans:
        span["text"] = text[span["start"] : span["end"]]
    return text, spans


def make(
    label: str,
    annotated: str,
    previous: tuple[str, str] | None,
    template_id: str,
    kind: str,
    rng: random.Random,
) -> dict | None:
    request, spans, enums = fill_annotated(annotated, rng)
    request, spans = rough(request, spans, rng)
    if too_close(request):
        return None
    return {
        "request": request,
        "previous_request": previous[0] if previous else None,
        "previous_operation": previous[1] if previous else None,
        "label": label,
        "spans": spans,
        "enums": enums,
        "template_id": template_id,
        "kind": kind,
    }


def plain(template: str, rng: random.Random) -> str:
    """Render a template with no annotation (previous-turn text)."""
    text, _spans, _enums = fill_annotated(template.lstrip("!@"), rng)
    return text


def generate(
    pools: dict[str, list[tuple[int, str]]],
    per_template: int,
    rng: random.Random,
    context_share: float,
) -> list[dict]:
    rows: list[dict] = []
    read_pool = [
        (label, template)
        for label, templates in pools.items()
        for _, template in templates
        if label not in {"none", "clarify"}
    ]

    for label, templates in pools.items():
        for index, template in templates:
            hard_negative = template.startswith("!")
            body = template[1:] if hard_negative else template
            annotated = A.annotate(label, template)
            annotated = annotated[1:] if annotated.startswith("!") else annotated
            _ = body
            seen: set[str] = set()
            made = 0
            for _attempt in range(per_template * 6):
                if made >= per_template:
                    break
                previous = None
                if rng.random() < context_share:
                    prev_label, prev_template = rng.choice(read_pool)
                    prev_text = plain(prev_template, rng)
                    if too_close(prev_text):
                        continue
                    previous = (prev_text, prev_label)
                row = make(
                    label,
                    annotated,
                    previous,
                    f"{label}#{index}",
                    "single" if previous is None else "with_context",
                    rng,
                )
                if row is None or row["request"] in seen:
                    continue
                seen.add(row["request"])
                row["hard_negative"] = hard_negative
                rows.append(row)
                made += 1

    continuable = [
        label
        for label in pools
        if label
        in {
            "agenda_upcoming", "agenda_search", "tasks_due", "tasks_about", "tasks_by_project",
            "people_at_company", "photos_of_people", "photos_by_date", "photos_in_album",
            "notes_search", "notes_in_notebook", "docs_search", "docs_in_folder",
            "tally_who_owes_me", "tally_group_balance", "tally_balance_with", "tally_expenses_with",
        }
        and pools[label]
    ]
    for template_index, template in enumerate(CONTINUATION_TEMPLATES):
        for _ in range(per_template * 2):
            label = rng.choice(continuable)
            prev_text = plain(rng.choice(pools[label])[1], rng)
            if too_close(prev_text):
                continue
            row = make(
                label,
                A.annotate_continuation(label, template),
                (prev_text, label),
                f"continuation#{template_index}",
                "continuation",
                rng,
            )
            if row is not None:
                rows.append(row)

    for template_index, (template, mapping) in enumerate(DEPENDENT_TEMPLATES):
        for prev_label, label in mapping.items():
            if prev_label not in pools or not pools[prev_label]:
                continue
            for _ in range(max(2, per_template // 3)):
                prev_text = plain(rng.choice(pools[prev_label])[1], rng)
                if too_close(prev_text):
                    continue
                row = make(
                    label,
                    A.annotate_dependent(label, template),
                    (prev_text, prev_label),
                    f"dependent#{template_index}",
                    "dependent",
                    rng,
                )
                if row is not None:
                    rows.append(row)
    return rows


def audit(rows: list[dict]) -> dict[str, object]:
    """Sanity: every span is a real substring, and required slots are covered."""
    bad = [r for r in rows for s in r["spans"] if r["request"][s["start"] : s["end"]] != s["text"]]
    missing_required = Counter()
    for row in rows:
        label = str(row["label"])
        if label in ("none", "clarify"):
            continue
        present = {s["slot"] for s in row["spans"]} | set(row["enums"])
        for name, spec in A.PARAMS[label].items():
            if spec.get("required") and name not in present:
                missing_required[f"{label}.{name}"] += 1
    return {
        "rows": len(rows),
        "span_mismatches": len(bad),
        "rows_with_spans": sum(1 for r in rows if r["spans"]),
        "missing_required_slot": missing_required.most_common(12),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--per-template", type=int, default=24)
    parser.add_argument("--context-share", type=float, default=0.30)
    parser.add_argument(
        "--unseen-share",
        type=float,
        default=UNSEEN_SHARE,
        help="Share of proper-noun slot values replaced by an invented name (0 reproduces run j-02's data).",
    )
    args = parser.parse_args()
    globals()["UNSEEN_SHARE"] = args.unseen_share

    rng = random.Random(SEED)
    train_pool, val_pool = split_templates(rng)
    train = generate(train_pool, args.per_template, rng, args.context_share)
    val = generate(val_pool, max(4, args.per_template // 3), random.Random(SEED + 1), args.context_share)

    def template_ids(rows: list[dict]) -> set[str]:
        return {
            str(r["template_id"])
            for r in rows
            if not str(r["template_id"]).startswith(("continuation", "dependent"))
        }

    leak = template_ids(train) & template_ids(val)
    if leak:
        raise SystemExit(f"template leak between train and val: {sorted(leak)[:5]}")

    print(f"train {len(train)} rows / {len({r['label'] for r in train})} labels")
    print(f"val   {len(val)} rows / {len({r['label'] for r in val})} labels")
    print("kinds:", Counter(str(r["kind"]) for r in train).most_common())
    print("train audit:", json.dumps(audit(train), indent=1))
    counts = Counter(str(r["label"]) for r in train)
    print("label counts: min", min(counts.values()), "max", max(counts.values()))

    if args.write:
        for name, rows in (("train.jsonl", train), ("val.jsonl", val)):
            with (HERE / name).open("w") as handle:
                for row in rows:
                    handle.write(json.dumps(row) + "\n")
            print(f"wrote {HERE / name}")


if __name__ == "__main__":
    main()
