"""Generate selector training data: template x paraphrase x slot value.

Output rows are exactly the selector's runtime input plus its label:

    {"request", "previous_request", "previous_operation", "label",
     "template_id", "kind"}

Split rule: **whole templates** are held out, per label, into ``val.jsonl``.
Sharing a template between train and val would make validation measure
memorisation of the frame rather than transfer, which the brief forbids.

Three row kinds:

- ``single``       --- one turn, ``previous_*`` null.
- ``with_context`` --- a single-turn request preceded by an unrelated previous
  turn; the label is unchanged. Teaches the model to ignore stale context.
- ``continuation`` --- the label is the previous operation (a slot change).
- ``dependent``    --- the label is a function of the previous operation
  (``"only the ones with X"`` is ``people_profile`` after ``people_at`` but
  ``photos_of_people`` after ``photos_in_album``). No lexical cue exists; the
  previous operation is the whole signal.

Typos, filler openers and casing wobble are applied mechanically to a share of
rows so the classifier never sees only clean text.

    python3 selector/gen_selector_data.py --write
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

import world_synthetic as W  # noqa: E402
from overlap_check import THRESHOLD, jaccard, reference_corpus, tokens  # noqa: E402
from templates import CONTINUATION_TEMPLATES, DEPENDENT_TEMPLATES, TEMPLATES  # noqa: E402

# Every generated utterance is filtered against the frozen suite and the
# catalogue's documentation utterances at generation time, so a colliding
# sample is never written rather than merely reported afterwards.
_REFERENCE = [tokens(text) for _source, text in reference_corpus()]


def too_close(text: str) -> bool:
    bag = tokens(text)
    return any(jaccard(bag, ref) > THRESHOLD for ref in _REFERENCE)

SEED = 20260919
SLOTS: dict[str, list[str]] = {
    "person": W.PEOPLE + W.FIRST_NAMES,
    "people": W.PEOPLE,
    "company": W.COMPANIES,
    "event": W.EVENTS,
    "project": W.PROJECTS,
    "album": W.ALBUMS,
    "notebook": W.NOTEBOOKS,
    "folder": W.FOLDERS,
    "group": W.GROUPS,
    "place": W.PLACES,
    "topic": W.TOPICS,
    "task": W.TASK_TITLES,
    "service": W.SERVICES,
    "window": W.WINDOWS,
    "due": W.DUE_WINDOWS,
    "date": W.DATES,
    "time": W.TIMES,
    "note": W.NOTE_TITLES,
    "doc": W.DOC_TOPICS,
    "amount": W.AMOUNTS,
    "expense": W.EXPENSES,
    "channel": W.CHANNELS,
    "calendar": ["personal", "work", "family"],
}

OPENERS = ["hey ", "ok so ", "quick one — ", "please ", "can you ", "sorry, "]
TYPO_TARGETS = "aeioustrn"


def fill(template: str, rng: random.Random) -> str:
    out = template
    while "{" in out:
        start = out.index("{")
        end = out.index("}", start)
        name = out[start + 1 : end]
        out = out[:start] + rng.choice(SLOTS[name]) + out[end + 1 :]
    return out


def rough(text: str, rng: random.Random) -> str:
    """Mechanical register noise: opener, casing, a dropped apostrophe, a typo."""
    roll = rng.random()
    if roll < 0.12:
        text = rng.choice(OPENERS) + text
    if rng.random() < 0.10:
        text = text.replace("'", "")
    if rng.random() < 0.10:
        text = text.capitalize()
    if rng.random() < 0.10 and len(text) > 12:
        index = rng.randrange(4, len(text) - 1)
        if text[index] in TYPO_TARGETS:
            text = text[:index] + text[index] + text[index:]
        else:
            text = text[:index] + text[index + 1 :]
    return text


def split_templates(rng: random.Random) -> tuple[dict[str, list[tuple[int, str]]], dict[str, list[tuple[int, str]]]]:
    train: dict[str, list[tuple[int, str]]] = {}
    val: dict[str, list[tuple[int, str]]] = {}
    for label, templates in TEMPLATES.items():
        indexed = list(enumerate(templates))
        rng.shuffle(indexed)
        hold = max(2, round(0.25 * len(indexed)))
        val[label] = sorted(indexed[:hold])
        train[label] = sorted(indexed[hold:])
    return train, val


def row(label: str, request: str, previous: tuple[str, str] | None, template_id: str, kind: str) -> dict[str, object]:
    return {
        "request": request,
        "previous_request": previous[0] if previous else None,
        "previous_operation": previous[1] if previous else None,
        "label": label,
        "template_id": template_id,
        "kind": kind,
    }


def generate(
    pools: dict[str, list[tuple[int, str]]],
    per_template: int,
    rng: random.Random,
    context_share: float,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    # Previous-turn text is drawn from read operations of the same pool, so a
    # context row's history is as synthetic as its request.
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
            seen: set[str] = set()
            made = 0
            for _ in range(per_template * 6):
                if made >= per_template:
                    break
                request = rough(fill(body, rng), rng)
                if request in seen or too_close(request):
                    continue
                seen.add(request)
                previous = None
                if rng.random() < context_share:
                    prev_label, prev_template = rng.choice(read_pool)
                    prev_text = fill(prev_template.lstrip("!"), rng)
                    if too_close(prev_text):
                        continue
                    previous = (prev_text, prev_label)
                entry = row(label, request, previous, f"{label}#{index}", "single" if previous is None else "with_context")
                entry["hard_negative"] = hard_negative
                rows.append(entry)
                made += 1

    # Continuations: label == previous operation.
    continuable = [
        label
        for label in pools
        if label
        in {
            "agenda_upcoming",
            "agenda_search",
            "tasks_due",
            "tasks_about",
            "tasks_by_project",
            "people_at_company",
            "photos_of_people",
            "photos_by_date",
            "photos_in_album",
            "notes_search",
            "notes_in_notebook",
            "docs_search",
            "docs_in_folder",
            "tally_who_owes_me",
            "tally_group_balance",
            "tally_balance_with",
            "tally_expenses_with",
        }
        and pools[label]
    ]
    for template_index, template in enumerate(CONTINUATION_TEMPLATES):
        for _ in range(per_template * 2):
            label = rng.choice(continuable)
            prev_template = rng.choice(pools[label])[1].lstrip("!")
            prev_text = fill(prev_template, rng)
            request = rough(fill(template, rng), rng)
            if too_close(prev_text) or too_close(request):
                continue
            rows.append(row(label, request, (prev_text, label), f"continuation#{template_index}", "continuation"))

    # Dependent follow-ups: label is a function of the previous operation.
    for template_index, (template, mapping) in enumerate(DEPENDENT_TEMPLATES):
        for prev_label, label in mapping.items():
            if prev_label not in pools or not pools[prev_label]:
                continue
            for _ in range(max(2, per_template // 3)):
                prev_template = rng.choice(pools[prev_label])[1].lstrip("!")
                prev_text = fill(prev_template, rng)
                request = rough(fill(template, rng), rng)
                if too_close(prev_text) or too_close(request):
                    continue
                rows.append(row(label, request, (prev_text, prev_label), f"dependent#{template_index}", "dependent"))
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--per-template", type=int, default=14)
    parser.add_argument("--context-share", type=float, default=0.30)
    args = parser.parse_args()

    rng = random.Random(SEED)
    train_pool, val_pool = split_templates(rng)
    train = generate(train_pool, args.per_template, rng, args.context_share)
    val = generate(val_pool, max(4, args.per_template // 2), random.Random(SEED + 1), args.context_share)

    train_ids = {r["template_id"] for r in train if not str(r["template_id"]).startswith(("continuation", "dependent"))}
    val_ids = {r["template_id"] for r in val if not str(r["template_id"]).startswith(("continuation", "dependent"))}
    leak = train_ids & val_ids
    if leak:
        raise SystemExit(f"template leak between train and val: {sorted(leak)[:5]}")

    print(f"train {len(train)} rows, {len({r['label'] for r in train})} labels, {len(train_ids)} templates")
    print(f"val   {len(val)} rows, {len({r['label'] for r in val})} labels, {len(val_ids)} templates")
    from collections import Counter

    print("kinds:", Counter(str(r["kind"]) for r in train).most_common())
    counts = Counter(str(r["label"]) for r in train)
    print("label counts: min", min(counts.values()), "max", max(counts.values()))

    if args.write:
        for name, rows in (("train.jsonl", train), ("val.jsonl", val)):
            with (HERE / name).open("w") as handle:
                for entry in rows:
                    handle.write(json.dumps(entry) + "\n")
            print(f"wrote {HERE / name}")


if __name__ == "__main__":
    main()
